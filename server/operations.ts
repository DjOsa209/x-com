import { Router } from "express";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { rows, execute, parse, get, list, jobGet, type Doc } from "./db.ts";
import { workspace, scope, inWorkspace } from "./context.ts";
import { requireOwner, audit } from "./auth.ts";
import { AppError } from "./errors.ts";
import { assetFile, readAsset } from "./media.ts";
import { ffmpegPath, probe } from "./video-compose.ts";
import { withJobLock } from "./locks.ts";
import { createJob, cancelJob } from "./jobs.ts";
import { creatorInfo, tikCall, publicationPreflight } from "./tiktok.ts";
import { zipEntries } from "./archive.ts";
import {
  replaceAssetReferences,
  clearAssetReferences,
} from "./asset-references.ts";
import { echoQuery, extractItems, normalizeItem } from "./echotik.ts";
import {
  operationSettings,
  researchBudgetSummary,
  notifyOperation,
  recordResearchEvidence,
  currentResearchRun,
} from "./research-budget.ts";
export { migrateOperations } from "./operations-schema.ts";
export const operationsRoutes = Router();
const run = promisify(execFile);
const statusValues = [
  "draft",
  "approved",
  "scheduled",
  "processing",
  "exported",
  "published",
  "inbox",
  "failed",
  "cancelled",
  "review",
] as const;
export const publicationInput = z.object({
  title: z.string().trim().min(1).max(200),
  assetId: z.string().min(1).max(64),
  coverAssetId: z.string().max(64).optional(),
  caption: z.string().max(2200).default(""),
  subtitleSrt: z.string().max(100000).default(""),
  productId: z.string().max(64).optional(),
  projectId: z.string().max(64).optional(),
  modelId: z.string().max(128).optional(),
  accountId: z.string().max(64).optional(),
  privacy: z.string().max(80).default(""),
  disableComment: z.boolean().default(true),
  disableDuet: z.boolean().default(true),
  disableStitch: z.boolean().default(true),
  brandContent: z.boolean().default(false),
  brandOrganic: z.boolean().default(false),
  isAigc: z.boolean().default(true),
  mode: z.enum(["export", "direct", "inbox"]).default("export"),
  verifiedVideoUrl: z.string().max(2000).optional(),
});
const pageInput = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(200).default(""),
  status: z.enum(statusValues).optional(),
  productId: z.string().max(64).optional(),
  projectId: z.string().max(64).optional(),
  modelId: z.string().max(128).optional(),
  accountId: z.string().max(64).optional(),
});
function publication(r: Doc) {
  return {
    ...parse(r.body),
    id: r.id,
    title: r.title,
    status: r.status,
    jobId: r.job_id,
    scheduledAt: r.scheduled_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
async function getPublication(id: string) {
  const [r] = await rows(
    "SELECT * FROM publications WHERE id=? AND workspace_id=?",
    [id, workspace()],
  );
  if (!r) throw new AppError(404, "发布记录不存在");
  return publication(r);
}
async function validatePublication(b: Doc) {
  const video = await get(b.assetId, "asset");
  if (video?.type !== "video")
    throw new AppError(400, "请选择此空间的视频素材");
  if (b.coverAssetId && (await get(b.coverAssetId, "asset"))?.type !== "image")
    throw new AppError(400, "封面必须是此空间的图片素材");
  if (b.accountId && !(await get(b.accountId, "account")))
    throw new AppError(400, "账号不存在");
  if (b.projectId) {
    const [p] = await rows(
      "SELECT id FROM projects WHERE id=? AND workspace_id=?",
      [b.projectId, workspace()],
    );
    if (!p) throw new AppError(400, "关联项目不存在");
  }
  if (b.productId) {
    const [p] = await rows(
      "SELECT id FROM commerce_entries WHERE id=? AND workspace_id=? AND kind='products'",
      [b.productId, workspace()],
    );
    if (!p) throw new AppError(400, "关联商品不存在");
  }
}
async function writePublication(
  id: string,
  body: Doc,
  status: string,
  jobId?: string | null,
  scheduledAt?: string | null,
) {
  await execute(
    "UPDATE publications SET title=?,body=?,status=?,job_id=?,scheduled_at=? WHERE id=? AND workspace_id=?",
    [
      body.title,
      JSON.stringify(body),
      status,
      jobId ?? null,
      scheduledAt ? new Date(scheduledAt) : null,
      id,
      workspace(),
    ],
  );
  await replaceAssetReferences("publication", id, body);
  return getPublication(id);
}
export function parseTikTokLink(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError(400, "请输入有效的 TikTok 作品链接");
  }
  if (
    u.protocol !== "https:" ||
    !/(^|\.)tiktok\.com$/.test(u.hostname) ||
    !/\/video\/\d+/.test(u.pathname)
  )
    throw new AppError(400, "请填写包含 /video/作品ID 的 TikTok HTTPS 链接");
  return {
    url: u.origin + u.pathname,
    externalId: u.pathname.match(/\/video\/(\d+)/)![1],
  };
}
export function approvalFingerprint(input: Doc) {
  return createHash("sha256")
    .update(JSON.stringify(publicationInput.parse(input)))
    .digest("hex");
}
operationsRoutes.get("/operations/settings", async (_req, res) =>
  res.json({
    settings: await operationSettings(),
    budget: await researchBudgetSummary(),
  }),
);
operationsRoutes.put("/operations/settings", async (req, res) => {
  requireOwner();
  const b = z
    .object({
      monthlyRequestLimit: z.number().int().min(1).max(10000000).optional(),
      tiktokDirectEnabled: z.boolean().optional(),
      tiktokInboxEnabled: z.boolean().optional(),
      tiktokQualificationNote: z.string().max(2000).optional(),
      verifiedMediaPrefix: z.string().max(1000).optional(),
    })
    .parse(req.body);
  const next: Doc = { ...(await operationSettings()), ...b };
  if (
    (next.tiktokDirectEnabled || next.tiktokInboxEnabled) &&
    !next.tiktokQualificationNote.trim()
  )
    throw new AppError(400, "启用官方接口前，请记录应用资格和可用范围");
  if (next.verifiedMediaPrefix) {
    let u: URL;
    try {
      u = new URL(next.verifiedMediaPrefix);
    } catch {
      throw new AppError(400, "已验证媒体前缀格式无效");
    }
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new AppError(400, "已验证媒体前缀必须是无查询参数的 HTTPS 地址");
  }
  await execute(
    "INSERT INTO operation_settings(workspace_id,body) VALUES(?,?) ON DUPLICATE KEY UPDATE body=VALUES(body)",
    [workspace(), JSON.stringify(next)],
  );
  await audit("operations.settings_updated", { keys: Object.keys(b) });
  res.json(next);
});
operationsRoutes.get("/publications", async (req, res) => {
  const p = pageInput.parse(req.query),
    values: any[] = [workspace()],
    filters = ["workspace_id=?"];
  if (p.status) {
    filters.push("status=?");
    values.push(p.status);
  }
  if (p.q) {
    filters.push("title LIKE ?");
    values.push("%" + p.q + "%");
  }
  for (const key of ["productId", "projectId", "modelId", "accountId"] as const)
    if (p[key]) {
      filters.push("JSON_UNQUOTE(JSON_EXTRACT(body,'$." + key + "'))=?");
      values.push(p[key]);
    }
  const where = filters.join(" AND "),
    [{ total }] = await rows(
      "SELECT COUNT(*) total FROM publications WHERE " + where,
      values,
    );
  const items = await rows(
    "SELECT * FROM publications WHERE " +
      where +
      " ORDER BY created_at DESC LIMIT " +
      p.pageSize +
      " OFFSET " +
      (p.page - 1) * p.pageSize,
    values,
  );
  res.json({
    items: items.map(publication),
    total: Number(total),
    page: p.page,
    pageSize: p.pageSize,
  });
});
operationsRoutes.post("/publications", async (req, res) => {
  const b = publicationInput.parse(req.body);
  const attribution = await contentAttribution(b);
  b.modelId ||= attribution.modelId;
  b.projectId ||= attribution.projectId;
  await validatePublication(b);
  const id = randomUUID();
  await execute(
    "INSERT INTO publications(id,workspace_id,title,status,body) VALUES(?,?,?,'draft',?)",
    [id, workspace(), b.title, JSON.stringify(b)],
  );
  await replaceAssetReferences("publication", id, b);
  res.status(201).json(await getPublication(id));
});
operationsRoutes.get("/publications/:id", async (req, res) =>
  res.json(await getPublication(String(req.params.id))),
);
operationsRoutes.patch("/publications/:id", async (req, res) =>
  withJobLock("publication:" + workspace() + ":" + req.params.id, async () => {
    const old = await getPublication(String(req.params.id));
    if (["processing", "review", "published", "inbox"].includes(old.status))
      throw new AppError(409, "已提交或已发布的记录不能修改，请创建新发布记录");
    const b = publicationInput.parse({
      ...old,
      ...publicationInput.partial().parse(req.body),
    });
    await validatePublication(b);
    if (old.jobId && old.status === "scheduled") await cancelJob(old.jobId);
    res.json(await writePublication(old.id, b, "draft"));
  }),
);
operationsRoutes.delete("/publications/:id", async (req, res) =>
  withJobLock("publication:" + workspace() + ":" + req.params.id, async () => {
    const p = await getPublication(String(req.params.id));
    if (["processing", "review", "scheduled"].includes(p.status))
      throw new AppError(409, "请先取消尚未提交的排期，已提交记录需核对结果");
    await clearAssetReferences("publication", p.id);
    await execute(
      "DELETE FROM content_metrics WHERE workspace_id=? AND publication_id=?",
      [workspace(), p.id],
    );
    await execute("DELETE FROM publications WHERE id=? AND workspace_id=?", [
      p.id,
      workspace(),
    ]);
    res.json({ ok: true });
  }),
);
operationsRoutes.post("/publications/:id/approve", async (req, res) =>
  withJobLock("publication:" + workspace() + ":" + req.params.id, async () => {
    const p = await getPublication(String(req.params.id));
    if (
      !["draft", "failed", "cancelled", "exported", "approved"].includes(
        p.status,
      )
    )
      throw new AppError(409, "当前记录不能重新审核");
    if (req.body.confirm !== true)
      throw new AppError(400, "请确认视频、文案及发布信息");
    await validatePublication(p);
    const b = {
      ...p,
      approval: {
        id: randomUUID(),
        fingerprint: approvalFingerprint(p),
        by: scope().userId,
        at: new Date().toISOString(),
      },
    };
    res.json(await writePublication(p.id, b, "approved"));
  }),
);
operationsRoutes.post("/publications/:id/preflight", async (req, res) => {
  const p = await getPublication(String(req.params.id));
  res.json(await publicationPreflight(p));
});
operationsRoutes.post("/publications/:id/dispatch", async (req, res) =>
  withJobLock("publication:" + workspace() + ":" + req.params.id, async () => {
    const p = await getPublication(String(req.params.id));
    const b = z
      .object({
        confirm: z.literal(true),
        runAt: z.string().datetime().optional(),
      })
      .parse(req.body);
    if (
      p.status !== "approved" ||
      p.approval?.fingerprint !== approvalFingerprint(p)
    )
      throw new AppError(409, "请先审核当前版本再提交");
    if (p.mode === "export")
      throw new AppError(400, "此记录使用导出模式，请下载发布包并登记作品链接");
    await publicationPreflight(p);
    const j = await createJob(
      "publish",
      {
        ...publicationInput.parse(p),
        mode: p.mode === "inbox" ? "inbox" : "direct",
        consent: true,
        publicationId: p.id,
      },
      "publication:" + p.id + ":" + p.approval.id,
      b.runAt,
    );
    res.json(
      await writePublication(
        p.id,
        p,
        b.runAt ? "scheduled" : "processing",
        j.id,
        b.runAt,
      ),
    );
  }),
);
operationsRoutes.post("/publications/:id/reschedule", async (req, res) =>
  withJobLock("publication:" + workspace() + ":" + req.params.id, async () => {
    const p = await getPublication(String(req.params.id)),
      b = z
        .object({ runAt: z.string().datetime(), confirm: z.literal(true) })
        .parse(req.body);
    if (p.status !== "scheduled" || !p.jobId)
      throw new AppError(409, "只有尚未提交的排期可改期");
    const at = new Date(b.runAt).getTime();
    if (at < Date.now() + 1000 || at > Date.now() + 30 * 86400000)
      throw new AppError(400, "排期需在未来30天内");
    await publicationPreflight(p);
    await cancelJob(p.jobId);
    const next = { ...p, approval: { ...p.approval, id: randomUUID() } };
    const j = await createJob(
      "publish",
      {
        ...publicationInput.parse(next),
        mode: next.mode,
        consent: true,
        publicationId: p.id,
      },
      "publication:" + p.id + ":" + next.approval.id,
      b.runAt,
    );
    res.json(await writePublication(p.id, next, "scheduled", j.id, b.runAt));
  }),
);
operationsRoutes.post("/publications/:id/cancel", async (req, res) =>
  withJobLock("publication:" + workspace() + ":" + req.params.id, async () => {
    const p = await getPublication(String(req.params.id));
    if (p.jobId) await cancelJob(p.jobId);
    if (["published", "inbox"].includes(p.status))
      throw new AppError(409, "已发布作品不能通过此操作撤回");
    res.json(await writePublication(p.id, p, "cancelled"));
  }),
);
operationsRoutes.post("/publications/:id/manual", async (req, res) =>
  withJobLock("publication:" + workspace() + ":" + req.params.id, async () => {
    const p = await getPublication(String(req.params.id));
    if (["processing", "review", "scheduled"].includes(p.status))
      throw new AppError(409, "请先核对正在执行的官方发布任务");
    const b = z
        .object({
          url: z.string().max(2000),
          publishedAt: z.string().datetime().optional(),
        })
        .parse(req.body),
      link = parseTikTokLink(b.url);
    res.json(
      await writePublication(
        p.id,
        {
          ...p,
          externalUrl: link.url,
          externalId: link.externalId,
          publishedAt: b.publishedAt || new Date().toISOString(),
          publicationSource: "manual",
        },
        "published",
      ),
    );
  }),
);
export async function publicationExport(p: Doc) {
  const { asset, bytes } = await readAsset(p.assetId),
    entries: Array<{ name: string; data: Buffer }> = [
      { name: "video" + (extname(asset.filename) || ".mp4"), data: bytes },
      { name: "caption.txt", data: Buffer.from(p.caption || "") },
    ];
  let srt = p.subtitleSrt || "",
    cover = p.coverAssetId;
  if (asset.jobId) {
    const j = await jobGet(asset.jobId);
    const result = j ? parse(j.result) : null;
    srt ||= result?.subtitleSrt || "";
    cover ||= result?.coverAsset?.id;
  }
  if (srt) entries.push({ name: "subtitles.srt", data: Buffer.from(srt) });
  if (cover) {
    const image = await readAsset(cover);
    entries.push({
      name: "cover" + (extname(image.asset.filename) || ".jpg"),
      data: image.bytes,
    });
  } else {
    const { path } = await assetFile(p.assetId),
      dir = await mkdtemp(join(tmpdir(), "xe-cover-"));
    try {
      const out = join(dir, "cover.jpg");
      await run(
        ffmpegPath(),
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          path,
          "-frames:v",
          "1",
          "-q:v",
          "2",
          out,
        ],
        { timeout: 30000, maxBuffer: 100000 },
      );
      entries.push({ name: "cover.jpg", data: await readFile(out) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const manifest = {
    publicationId: p.id,
    title: p.title,
    productId: p.productId || null,
    projectId: p.projectId || null,
    modelId: p.modelId || null,
    caption: p.caption,
    isAigc: p.isAigc,
    subtitleIncluded: !!srt,
    exportedAt: new Date().toISOString(),
    note: "导出不代表已经发布。请在 TikTok 自行完成发布后登记实际作品链接。",
  };
  entries.push(
    {
      name: "publication.json",
      data: Buffer.from(JSON.stringify(manifest, null, 2)),
    },
    {
      name: "README.txt",
      data: Buffer.from(
        "X-Ecommerce 发布包\n1. 检查 video、cover 和 caption。\n2. 在 TikTok 上传，检查可见范围、商业内容及 AI 生成标记。\n3. 发布完成后，将真实作品链接登记回 X-Ecommerce。\n" +
          (!srt
            ? "本项目未提供字幕，包内不包含虚构字幕。\n"
            : "subtitles.srt 为独立字幕文件。\n"),
      ),
    },
  );
  return await zipEntries(entries);
}
operationsRoutes.get("/publications/:id/export", async (req, res) => {
  const p = await getPublication(String(req.params.id));
  if (!["approved", "exported", "published"].includes(p.status))
    throw new AppError(409, "请先审核发布内容后导出");
  const zip = await publicationExport(p);
  res
    .type("application/zip")
    .attachment("x-ecommerce-" + p.id + ".zip")
    .send(zip);
});
operationsRoutes.post("/publications/:id/export", async (req, res) =>
  withJobLock("publication:" + workspace() + ":" + req.params.id, async () => {
    const p = await getPublication(String(req.params.id));
    if (!["approved", "exported", "published"].includes(p.status))
      throw new AppError(409, "请先审核发布内容后导出");
    const zip = await publicationExport(p);
    if (p.status !== "published")
      await writePublication(
        p.id,
        { ...p, lastExportedAt: new Date().toISOString() },
        "exported",
      );
    res
      .type("application/zip")
      .attachment("x-ecommerce-" + p.id + ".zip")
      .send(zip);
  }),
);
const metricsInput = z.object({
  views: z.number().int().nonnegative().nullable().optional(),
  likes: z.number().int().nonnegative().nullable().optional(),
  comments: z.number().int().nonnegative().nullable().optional(),
  shares: z.number().int().nonnegative().nullable().optional(),
  orders: z.number().int().nonnegative().nullable().optional(),
  gmv: z.number().nonnegative().nullable().optional(),
  currency: z.string().max(12).nullable().optional(),
  observedAt: z.string().datetime().optional(),
  note: z.string().max(1000).optional(),
});
export async function saveMetric(
  publicationId: string,
  metrics: Doc,
  source = "manual",
) {
  const p = await getPublication(publicationId),
    b = metricsInput.parse(metrics);
  await execute(
    "INSERT INTO content_metrics(workspace_id,publication_id,external_id,source,metrics,observed_at) VALUES(?,?,?,?,?,?)",
    [
      workspace(),
      p.id,
      p.externalId || null,
      source,
      JSON.stringify(b),
      new Date(b.observedAt || Date.now()),
    ],
  );
  return { ok: true };
}
operationsRoutes.post("/publications/:id/metrics", async (req, res) =>
  res.json(await saveMetric(String(req.params.id), req.body)),
);
operationsRoutes.get("/publications/:id/metrics", async (req, res) => {
  const p = await getPublication(String(req.params.id));
  res.json(
    (
      await rows(
        "SELECT * FROM content_metrics WHERE workspace_id=? AND publication_id=? ORDER BY observed_at DESC LIMIT 100",
        [workspace(), p.id],
      )
    ).map((r) => ({ ...r, metrics: parse(r.metrics) })),
  );
});
export async function contentAttribution(p: Doc) {
  let asset = await get(p.assetId, "asset"),
    sourceAssetId = p.assetId;
  const seen = new Set<string>();
  let modelId = p.modelId || "",
    projectId = p.projectId || "",
    scriptVersion: number | null = null,
    scriptProjectId: string | null = null,
    quote: Doc | null = null,
    sourceJobId: string | null = null;
  for (let hop = 0; asset && hop < 8; hop++) {
    if (seen.has(asset.id)) break;
    seen.add(asset.id);
    sourceAssetId = asset.id;
    if (asset.jobId) {
      const job = await jobGet(asset.jobId);
      if (job) {
        const input = parse(job.input) || {};
        projectId ||= input.projectId || "";
        modelId ||= input._videoPolicy?.model?.id || input.videoModelId || "";
        if (input.confirmationVersion) {
          scriptVersion = Number(input.confirmationVersion);
          scriptProjectId = input.projectId || null;
        }
        if (input._quoteSnapshot) {
          quote = input._quoteSnapshot;
          sourceJobId = job.id;
          break;
        }
        if (input.projectId && input.confirmationVersion) {
          const [confirmation] = await rows(
            "SELECT quote_snapshot FROM project_confirmations WHERE workspace_id=? AND project_id=? AND version=?",
            [workspace(), input.projectId, input.confirmationVersion],
          );
          if (confirmation?.quote_snapshot) {
            quote = parse(confirmation.quote_snapshot);
            sourceJobId = job.id;
            break;
          }
        }
      }
    }
    if (!asset.sourceAssetId) break;
    asset = await get(asset.sourceAssetId, "asset");
  }
  const count = Number(quote?.count || 1),
    known =
      quote?.status === "estimated" &&
      quote.amount !== null &&
      Number.isFinite(Number(quote.amount)) &&
      count > 0;
  return {
    modelId,
    projectId,
    scriptProjectId,
    scriptVersion,
    sourceAssetId,
    sourceJobId,
    estimate: {
      amount: known
        ? Math.round((Number(quote!.amount) / count) * 1000000) / 1000000
        : null,
      currency: quote?.currency || null,
      status: known ? "estimated" : "unknown",
      actualAmount: null,
      source: "已确认生成计划报价快照",
      allocationCount: count,
      components: quote?.components || [],
      notice:
        "每份成片按确认批次均分的生成计划估算；不是实际账单，不含脚本、后期、重试或税费。",
    },
  };
}
export function compareContent(items: Doc[], groupBy: string) {
  const groups = new Map<string, Doc>();
  for (const p of items) {
    const a = p.attribution || {},
      key =
        groupBy === "script"
          ? (a.scriptProjectId || a.projectId) && a.scriptVersion
            ? `${a.scriptProjectId || a.projectId}:v${a.scriptVersion}`
            : "unknown"
          : (groupBy === "product"
              ? p.productId
              : groupBy === "project"
                ? p.projectId || a.projectId
                : p.modelId || a.modelId) || "unknown";
    if (!groups.has(key))
      groups.set(key, {
        key,
        label: key === "unknown" ? "未关联 / 未知" : key,
        works: 0,
        withMetrics: 0,
        views: null,
        likes: null,
        comments: null,
        shares: null,
        estimatedByCurrency: {},
        unknownCostCount: 0,
        actualCost: null,
        costSources: new Set<string>(),
      });
    const g = groups.get(key)!;
    g.works++;
    if (p.metrics) g.withMetrics++;
    for (const field of ["views", "likes", "comments", "shares"])
      if (p.metrics?.[field] != null)
        g[field] = (g[field] ?? 0) + Number(p.metrics[field]);
    const source = a.sourceAssetId || p.assetId || p.id;
    if (!g.costSources.has(source)) {
      g.costSources.add(source);
      const estimate = a.estimate;
      if (estimate?.amount != null && estimate.currency)
        g.estimatedByCurrency[estimate.currency] =
          (g.estimatedByCurrency[estimate.currency] || 0) +
          Number(estimate.amount);
      else g.unknownCostCount++;
    }
  }
  return [...groups.values()]
    .map(({ costSources, ...g }): Doc => ({
      ...g,
      distinctProductionCount: costSources.size,
    }))
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
}
operationsRoutes.get("/content-analytics", async (req, res) => {
  const p = pageInput.parse(req.query),
    filters = ["p.workspace_id=?"],
    values: any[] = [workspace()];
  for (const key of ["productId", "projectId", "modelId", "accountId"] as const)
    if (p[key]) {
      filters.push("JSON_UNQUOTE(JSON_EXTRACT(p.body,'$." + key + "'))=?");
      values.push(p[key]);
    }
  if (p.q) {
    filters.push("p.title LIKE ?");
    values.push("%" + p.q + "%");
  }
  const where = filters.join(" AND "),
    [{ total }] = await rows(
      "SELECT COUNT(*) total FROM publications p WHERE " + where,
      values,
    );
  const items = await rows(
    "SELECT p.*,m.metrics,m.source metric_source,m.observed_at FROM publications p LEFT JOIN content_metrics m ON m.id=(SELECT id FROM content_metrics WHERE workspace_id=p.workspace_id AND publication_id=p.id ORDER BY observed_at DESC,id DESC LIMIT 1) WHERE " +
      where +
      " ORDER BY p.created_at DESC LIMIT " +
      p.pageSize +
      " OFFSET " +
      (p.page - 1) * p.pageSize,
    values,
  );
  const enriched = await Promise.all(
    items.map(async (r) => ({
      ...publication(r),
      metrics: r.metrics ? parse(r.metrics) : null,
      metricSource: r.metric_source,
      observedAt: r.observed_at,
      attribution: await contentAttribution(publication(r)),
    })),
  );
  res.json({
    items: enriched,
    total: Number(total),
    page: p.page,
    pageSize: p.pageSize,
    note: "TikTok 视频列表提供播放和互动，不提供成交归因。GMV/订单仅显示带来源的手工登记值；缺失为未知。",
  });
});
operationsRoutes.get("/content-comparison", async (req, res) => {
  const groupBy = z
    .enum(["product", "project", "script", "model"])
    .default("product")
    .parse(req.query.groupBy);
  const records = await rows(
    "SELECT p.*,m.metrics FROM publications p LEFT JOIN content_metrics m ON m.id=(SELECT id FROM content_metrics WHERE workspace_id=p.workspace_id AND publication_id=p.id ORDER BY observed_at DESC,id DESC LIMIT 1) WHERE p.workspace_id=? ORDER BY p.created_at DESC",
    [workspace()],
  );
  const items = [];
  for (const r of records) {
    const p = publication(r);
    items.push({
      ...p,
      metrics: r.metrics ? parse(r.metrics) : null,
      attribution: await contentAttribution(p),
    });
  }
  const groups = compareContent(items, groupBy);
  if (groupBy === "product" || groupBy === "project")
    for (const g of groups) {
      if (g.key === "unknown") continue;
      const [named] = await rows(
        groupBy === "project"
          ? "SELECT name FROM projects WHERE id=? AND workspace_id=?"
          : "SELECT JSON_UNQUOTE(JSON_EXTRACT(body,'$.name')) name FROM commerce_entries WHERE id=? AND workspace_id=? AND kind='products'",
        [g.key, workspace()],
      );
      if (named?.name) g.label = named.name;
    }
  const [{ total }] = await rows(
    "SELECT COUNT(*) total FROM publications WHERE workspace_id=?",
    [workspace()],
  );
  res.json({
    groupBy,
    groups,
    sampleSize: items.length,
    total: Number(total),
    limited: Number(total) > items.length,
    note: "比较每个作品的最新累计快照；观测时间可能不同，不能推断因果。估算按独立源成片去重、按币种分别汇总，实际成本未知，不计算 ROI。",
  });
});
operationsRoutes.get("/research-runs", async (req, res) => {
  const p = pageInput.parse(req.query),
    a =
      typeof req.query.automationId === "string"
        ? req.query.automationId
        : null,
    values: any[] = [workspace()],
    where = "workspace_id=?" + (a ? " AND automation_id=?" : "");
  if (a) values.push(a);
  const [{ total }] = await rows(
    "SELECT COUNT(*) total FROM research_runs WHERE " + where,
    values,
  );
  const items = await rows(
    "SELECT id,automation_id,job_id,kind,status,request_count,max_requests,error,created_at,finished_at FROM research_runs WHERE " +
      where +
      " ORDER BY created_at DESC LIMIT " +
      p.pageSize +
      " OFFSET " +
      (p.page - 1) * p.pageSize,
    values,
  );
  res.json({ items, total: Number(total), page: p.page, pageSize: p.pageSize });
});
operationsRoutes.get("/research-runs/:id", async (req, res) => {
  const [r] = await rows(
    "SELECT * FROM research_runs WHERE id=? AND workspace_id=?",
    [req.params.id, workspace()],
  );
  if (!r) throw new AppError(404, "研究运行不存在");
  const requests = await rows(
    "SELECT provider,endpoint,status,created_at FROM research_requests WHERE run_id=? AND workspace_id=? ORDER BY id LIMIT 1000",
    [r.id, workspace()],
  );
  res.json({
    ...r,
    input: parse(r.input),
    result: parse(r.result),
    evidence: parse(r.evidence),
    requests,
  });
});
operationsRoutes.get("/notifications", async (req, res) => {
  const p = pageInput.parse(req.query);
  const [{ total }] = await rows(
    "SELECT COUNT(*) total FROM operation_notifications WHERE workspace_id=?",
    [workspace()],
  );
  const [{ unread }] = await rows(
    "SELECT COUNT(*) unread FROM operation_notifications WHERE workspace_id=? AND read_at IS NULL",
    [workspace()],
  );
  res.json({
    items: await rows(
      "SELECT * FROM operation_notifications WHERE workspace_id=? ORDER BY created_at DESC LIMIT " +
        p.pageSize +
        " OFFSET " +
        (p.page - 1) * p.pageSize,
      [workspace()],
    ),
    total: Number(total),
    unread: Number(unread),
  });
});
operationsRoutes.post("/notifications/:id/read", async (req, res) => {
  await execute(
    "UPDATE operation_notifications SET read_at=UTC_TIMESTAMP(3) WHERE id=? AND workspace_id=?",
    [req.params.id, workspace()],
  );
  res.json({ ok: true });
});
operationsRoutes.post("/notifications/read-all", async (_req, res) => {
  await execute(
    "UPDATE operation_notifications SET read_at=UTC_TIMESTAMP(3) WHERE workspace_id=? AND read_at IS NULL",
    [workspace()],
  );
  res.json({ ok: true });
});
operationsRoutes.get("/overview", async (_req, res) => {
  const [projects] = await rows(
    "SELECT COUNT(*) total,SUM(status='completed') completed FROM projects WHERE workspace_id=?",
    [workspace()],
  );
  const [publications] = await rows(
    "SELECT COUNT(*) total,SUM(status='published') published,SUM(status='approved') ready FROM publications WHERE workspace_id=?",
    [workspace()],
  );
  const [research] = await rows(
    "SELECT COUNT(*) total,SUM(status='budget_stopped') budgetStopped FROM research_runs WHERE workspace_id=? AND created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)",
    [workspace()],
  );
  const [attention] = await rows(
    "SELECT COUNT(*) total FROM jobs WHERE workspace_id=? AND status IN ('failed','review')",
    [workspace()],
  );
  const [opportunities] = await rows(
    "SELECT COUNT(*) pending FROM commerce_entries WHERE workspace_id=? AND kind='opportunities' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.status')) IN ('new','researching')",
    [workspace()],
  );
  const [storyboards] = await rows(
    "SELECT COUNT(*) pending FROM projects WHERE workspace_id=? AND archived=0 AND status='waiting_confirmation'",
    [workspace()],
  );
  const [generating] = await rows(
    "SELECT COUNT(*) active FROM jobs WHERE workspace_id=? AND kind IN ('video','replicate','image','enhance','video_edit') AND status IN ('queued','running','processing')",
    [workspace()],
  );
  const [publishing] = await rows(
    "SELECT COUNT(*) pending FROM publications WHERE workspace_id=? AND status IN ('draft','approved','scheduled','exported')",
    [workspace()],
  );
  res.json({
    projects,
    publications,
    research,
    attention,
    counts: {
      opportunities: Number(opportunities.pending),
      storyboards: Number(storyboards.pending),
      generating: Number(generating.active),
      publishing: Number(publishing.pending),
      attention: Number(attention.total),
    },
    budget: await researchBudgetSummary(),
    recentPublications: (
      await rows(
        "SELECT * FROM publications WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 5",
        [workspace()],
      )
    ).map(publication),
    recentRuns: await rows(
      "SELECT id,kind,status,request_count,created_at FROM research_runs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 5",
      [workspace()],
    ),
  });
});
export async function syncContentMetrics(input: Doc) {
  const accounts = input.accountId
    ? [await get(input.accountId, "account")]
    : await list("account");
  if (!accounts.filter(Boolean).length)
    throw new AppError(409, "请先连接需要回收效果的 TikTok 账号");
  let updated = 0;
  const evidence: Doc[] = [];
  for (const account of accounts.filter(Boolean).slice(0, 10)) {
    let cursor = 0;
    for (
      let page = 0;
      page < Math.max(1, Math.min(10, Number(input.maxPages) || 3));
      page++
    ) {
      const response = await tikCall(
        account!.id,
        "/v2/video/list/?fields=id,title,cover_image_url,share_url,view_count,like_count,comment_count,share_count",
        { max_count: 20, cursor },
      );
      await recordResearchEvidence({ accountId: account!.id, page, response });
      for (const video of response.videos || []) {
        const publications = await rows(
          "SELECT id FROM publications WHERE workspace_id=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.externalId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.accountId'))=?",
          [workspace(), String(video.id), account!.id],
        );
        for (const p of publications) {
          await saveMetric(
            p.id,
            {
              views: video.view_count ?? null,
              likes: video.like_count ?? null,
              comments: video.comment_count ?? null,
              shares: video.share_count ?? null,
              note: "TikTok 官方视频列表",
            },
            "tiktok",
          );
          updated++;
        }
      }
      evidence.push({
        accountId: account!.id,
        page,
        count: response.videos?.length || 0,
      });
      if (!response.has_more || response.cursor === cursor) break;
      cursor = response.cursor;
    }
  }
  return { updated, evidence };
}
export async function runOperationsJob(
  jobId: string,
  kind: string,
  input: Doc,
) {
  if (kind === "metrics_sync") return syncContentMetrics(input);
  const research = await import("./research-domain.ts");
  if (kind === "watch_sync") {
    const result = await research.runWatchSync(input);
    await recordResearchEvidence(result);
    return result;
  }
  if (kind === "case_collect") {
    const result = await echoQuery(input.path || "/echotik/video/ranklist", {
      date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      region: input.region || "US",
      rank_type: 1,
      video_rank_field: 2,
      page_num: 1,
      page_size: 10,
      ...input.params,
    });
    const videos = extractItems(result.data).slice(
      0,
      Math.max(1, Math.min(10, Number(input.maxVideos) || 5)),
    );
    const imported = [];
    for (const raw of videos) {
      const item = normalizeItem(raw, "video");
      if (!item.id) continue;
      const entry = await research.ingestCase(
        {
          title: item.title,
          sourceUrl: item.sourceUrl,
          summary: "已采集真实视频指标，尚未分析画面",
          prompt: "待人工分析后生成销售提示词",
        },
        {
          sourceUrl: item.sourceUrl,
          sourceVideoId: item.id,
          sourceMetrics: {
            ...item.raw,
            source: "EchoTik",
            fetchedAt: result.fetchedAt,
          },
          region: item.region || input.region || "US",
          jobId,
          provenance: "EchoTik 视频采集（尚未分析）",
        },
      );
      imported.push(entry);
      await recordResearchEvidence({ case: entry });
    }
    return { count: imported.length, cases: imported };
  }
  throw new AppError(400, "未知运营任务类型");
}
export async function reconcileOperations(onlyWorkspace?: string) {
  const active = await rows(
    "SELECT p.*,j.status job_status,j.result job_result,j.error job_error FROM publications p JOIN jobs j ON j.id=p.job_id AND j.workspace_id=p.workspace_id WHERE p.status IN ('processing','scheduled','review')" +
      (onlyWorkspace ? " AND p.workspace_id=?" : "") +
      " LIMIT 100",
    onlyWorkspace ? [onlyWorkspace] : [],
  );
  for (const r of active)
    await inWorkspace(r.workspace_id, async () => {
      const p = publication(r);
      const map: Doc = {
        completed: "published",
        inbox: "inbox",
        failed: "failed",
        cancelled: "cancelled",
        review: "review",
        processing: "processing",
        running: "processing",
      };
      const status = map[r.job_status];
      if (!status || status === p.status) return;
      const result = parse(r.job_result);
      let externalId =
        result?.publicaly_available_post_id?.[0] ||
        result?.publicly_available_post_id?.[0];
      if (externalId) externalId = String(externalId);
      await writePublication(
        p.id,
        {
          ...p,
          externalId: externalId || p.externalId,
          publishResult: result,
          lastError: r.job_error,
          ...(status === "published"
            ? { publishedAt: new Date().toISOString() }
            : {}),
        },
        status,
        p.jobId,
        p.scheduledAt ? new Date(p.scheduledAt).toISOString() : undefined,
      );
      if (["published", "inbox", "failed", "review"].includes(status))
        await notifyOperation(
          "publication:" + p.jobId + ":" + status,
          "发布记录状态更新",
          p.title + " · " + status,
          "/publish",
        );
    });
  const reviews = await rows(
    "SELECT j.id,j.workspace_id,j.kind,j.error FROM jobs j LEFT JOIN operation_notifications n ON n.workspace_id=j.workspace_id AND n.dedupe_key=CONCAT('job:',j.id,':review') WHERE j.status='review' AND n.id IS NULL" +
      (onlyWorkspace ? " AND j.workspace_id=?" : "") +
      " ORDER BY j.updated_at LIMIT 100",
    onlyWorkspace ? [onlyWorkspace] : [],
  );
  for (const job of reviews)
    await inWorkspace(job.workspace_id, () =>
      notifyOperation(
        "job:" + job.id + ":review",
        "任务需要人工核对",
        `${job.kind}：${String(job.error || "供应商提交结果尚不明确，请核对供应商记录后处理，系统不会自动重复提交。").slice(0, 1500)}`,
        "/tasks",
      ),
    );
  // Interrupted non-provider research retains its evidence for review, never silently restarts.
  await execute(
    "UPDATE research_runs r JOIN jobs j ON j.id=r.job_id SET r.status='interrupted',r.error=COALESCE(j.error,'研究已中断，已保留证据'),r.finished_at=UTC_TIMESTAMP(3) WHERE r.status='running' AND j.status IN ('review','failed','cancelled')" +
      (onlyWorkspace ? " AND r.workspace_id=?" : ""),
    onlyWorkspace ? [onlyWorkspace] : [],
  );
}
