import { withJobLock } from "./locks.ts";
import { acknowledgePipelineFailure } from "./video-pipeline.ts";
import {
  parseModels,
  videoPolicy,
  buildRenderPlan,
  planFingerprint,
} from "./video-plan.ts";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { resolve, basename } from "node:path";
import {
  rows,
  execute,
  list,
  get,
  put,
  remove,
  jobList,
  jobGet,
  job,
  parse,
  updateJob,
  type Doc,
} from "./db.ts";
import { publicConfig, saveConfig, config } from "./config.ts";
import { catalog, echoQuery, extractItems, normalizeItem } from "./echotik.ts";
import { AppError, required } from "./errors.ts";
import { mediaRoot, saveMedia, assetFile } from "./media.ts";
import { createJob, cancelJob, refreshJob } from "./jobs.ts";
import * as tiktok from "./tiktok.ts";
import { aiJson } from "./providers.ts";
import {
  access,
  authRoutes,
  requireOwner,
  requirePlatformAdmin,
  audit,
} from "./auth.ts";
import { workspace } from "./context.ts";
import { projectRoutes } from "./projects.ts";
import { billingRoutes, stripeWebhook } from "./billing.ts";
import { storageRoutes } from "./storage-routes.ts";
import { objectDelete } from "./storage.ts";
import { automationRoutes } from "./automations.ts";
import { retryJob } from "./jobs.ts";
import { finalizeCredits } from "./credits.ts";

export const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  const allowedHosts = (
    process.env.X_ALLOWED_HOSTS || "localhost,127.0.0.1,::1,[::1]"
  )
    .split(",")
    .map((s) => s.trim());
  if (!allowedHosts.includes(req.hostname))
    return next(new AppError(403, "此主机名未获允许", "HOST_REJECTED"));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && !["GET", "HEAD"].includes(req.method)) {
      let host = "";
      try {
        host = new URL(origin).host;
      } catch {}
      if (host !== req.headers.host)
        return next(new AppError(403, "拒绝跨站写入请求", "ORIGIN_REJECTED"));
    }
  }
  next();
});
app.use(stripeWebhook);
app.use(express.json({ limit: "2mb" }));
app.use(access);
app.use("/api", authRoutes);
app.use("/api", projectRoutes, billingRoutes, storageRoutes, automationRoutes);
const object = z.record(z.string(), z.any());
const collections = [
  "asset",
  "character",
  "draft",
  "favorite",
  "competitor",
  "prompt",
  "opportunity",
  "account",
  "observation",
];
const checkKind = (kind: string) => {
  if (!collections.includes(kind)) throw new AppError(404, "资源类型不存在");
  return kind;
};
app.get("/api/health", async (_req, res) => {
  try {
    await rows("SELECT 1");
    res.json({ ok: true, database: "mysql", version: "0.2.0" });
  } catch {
    res.status(503).json({
      ok: false,
      database: "mysql",
      message: "MySQL 未连接。启动独立本地实例或检查环境变量。",
    });
  }
});
app.get("/api/status", async (_req, res) => {
  const settings = await publicConfig();
  const [usage] = await rows(
    "SELECT COUNT(*) calls,SUM(success) successful FROM api_usage WHERE workspace_id=? AND provider='echotik' AND endpoint<>'/echotik/batch/cover/download' AND created_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01')",
    [workspace()],
  );
  res.json({ ...settings, usage, endpointCount: catalog.length });
});
app.get("/api/settings", async (_req, res) => res.json(await publicConfig()));
app.put("/api/settings", async (req, res) => {
  requireOwner();
  const patch = object.parse(req.body);
  if (
    patch.CREDIT_COSTS_JSON !== undefined ||
    patch.STORAGE_LIMIT_MB !== undefined
  )
    requirePlatformAdmin();
  await saveConfig(patch);
  await audit("settings.updated", { keys: Object.keys(patch) });
  res.json(await publicConfig());
});
app.get("/api/catalog", (_req, res) => res.json(catalog));
app.get("/api/models", async (_req, res) => {
  const c = await config();
  res.json([
    ...parseModels(c.VIDEO_MODELS_JSON, c.FAL_VIDEO_MODEL).map((m) => ({
      ...m,
      id: m.endpoint,
      modelId: m.id,
      type: "video",
      roles: m.characters,
    })),
    {
      id: c.FAL_IMAGE_MODEL,
      type: "image",
      adapter: "flux-schnell",
      references: 0,
    },
    {
      id: c.FAL_IMAGE_EDIT_MODEL,
      type: "image-edit",
      adapter: "nano-banana-edit",
      references: 5,
    },
    {
      id: c.FAL_ENHANCE_MODEL,
      type: "enhance",
      adapter: "topaz",
      factors: [1, 4],
    },
  ]);
});
app.get("/api/video/models", async (_req, res) => {
  const c = await config();
  res.json({
    models: parseModels(c.VIDEO_MODELS_JSON, c.FAL_VIDEO_MODEL),
    defaults: {
      videoModelId: c.VIDEO_DEFAULT_MODEL,
      segmentStrategy: c.VIDEO_SEGMENT_STRATEGY,
      segmentSeconds: Number(c.VIDEO_SEGMENT_SECONDS),
    },
  });
});
app.post("/api/video/plan", async (req, res) => {
  const b = z
    .object({
      input: z.record(z.string(), z.any()),
      storyboard: z.record(z.string(), z.any()),
    })
    .parse(req.body);
  const plan = buildRenderPlan(
    b.input,
    b.storyboard,
    videoPolicy(await config(), b.input),
  );
  res.json({ ...plan, fingerprint: planFingerprint(plan) });
});
app.get("/api/worker", async (_req, res) => {
  const [w] = await rows(
    "SELECT payload,updated_at FROM system_state WHERE id='worker'",
  );
  res.json(w || { status: "not_started" });
});
app.post("/api/jobs/:id/retry", async (req, res) =>
  res.json(await retryJob(String(req.params.id))),
);
app.post("/api/jobs/:id/resolve", async (req, res) => {
  requireOwner();
  const decision = z.enum(["failed", "completed"]).parse(req.body.decision);
  if (decision === "failed") requirePlatformAdmin();
  const id = String(req.params.id),
    j = await jobGet(id);
  if (!j || j.status !== "review")
    throw new AppError(409, "只有待核对任务可以人工核对");
  const note = z.string().min(10).max(1000).parse(req.body.note);
  if (decision === "completed") {
    // Only a provider response may prove completion; notes are not evidence.
    await refreshJob(id);
    const verified = await jobGet(id);
    if (!["completed", "inbox"].includes(verified?.status))
      throw new AppError(409, "供应商尚未确认完成，不能人工标记成功");
  } else {
    await withJobLock(id, async () => {
      const current = await jobGet(id);
      if (current?.status !== "review")
        throw new AppError(409, "任务状态已更新，请刷新后核对");
      const provider = parse(current.provider);
      await updateJob(id, {
        status: "failed",
        error: "人工核对：" + note,
        ...(provider?.name === "video-pipeline"
          ? { provider: acknowledgePipelineFailure(provider, note) }
          : {}),
      });
    });
    await finalizeCredits(id, false);
  }
  await audit("job.review_resolved", { jobId: id, decision, note });
  res.json({ ok: true });
});
app.get("/api/tiktok/connect/status", async (req, res) => {
  const state = z.string().max(128).parse(req.query.state);
  const { createHash } = await import("node:crypto");
  const [s] = await rows(
    "SELECT status,expires_at FROM oauth_states WHERE state_hash=? AND workspace_id=?",
    [createHash("sha256").update(state).digest("hex"), workspace()],
  );
  res.json({
    status:
      s && new Date(s.expires_at).getTime() > Date.now() ? s.status : "expired",
  });
});
app.post("/api/echotik/query", async (req, res) => {
  const b = z
    .object({
      path: z.string(),
      params: object.default({}),
      refresh: z.boolean().default(false),
      entity: z.string().default("video"),
    })
    .parse(req.body);
  const result = await echoQuery(b.path, b.params, b.refresh);
  const items = extractItems(result.data).map((v) =>
    normalizeItem(v, b.entity),
  );
  const covers = [
    ...new Set(
      items
        .map((i) => i.image)
        .filter(
          (s: any) =>
            typeof s === "string" &&
            s.startsWith(
              "https://echosell-images.tos-ap-southeast-1.volces.com/",
            ),
        ),
    ),
  ].slice(0, 10);
  if (covers.length) {
    try {
      const signed = await echoQuery("/echotik/batch/cover/download", {
        cover_urls: covers.join(","),
      });
      for (const item of items) {
        if (typeof signed.data?.[item.image] === "string")
          item.image = signed.data[item.image];
      }
    } catch {
      /* The data query remains usable when an optional cover is unavailable. */
    }
  }
  res.json({ ...result, items });
});
app.post("/api/prompts/search", async (req, res) => {
  const query = z.string().min(2).max(1000).parse(req.body.query);
  const prompts = await list("prompt");
  if (!prompts.length) return res.json([]);
  const ranked = await aiJson(
    `在以下自有提示词中按语义匹配检索需求：${query}。只返回已有记录的 ID。输出 {matches:[{id,reason}]}，最多 12 条。候选：${JSON.stringify(prompts.map((p) => ({ id: p.id, title: p.title, prompt: p.prompt }))).slice(0, 90000)}`,
  );
  const matches = Array.isArray(ranked.matches) ? ranked.matches : [];
  res.json(
    matches
      .map((m: Doc) => {
        const p = prompts.find((p) => p.id === m.id);
        return p ? { ...p, matchReason: m.reason } : null;
      })
      .filter(Boolean),
  );
});
app.get("/api/records/:kind", async (req, res) =>
  res.json(await list(checkKind(String(req.params.kind)))),
);
app.post("/api/records/:kind", async (req, res) => {
  const kind = checkKind(String(req.params.kind));
  const body = object.parse(req.body);
  if (["asset", "account"].includes(kind))
    throw new AppError(400, "请使用上传或授权入口");
  if (kind === "character") {
    const a = await get(required(body.assetId, "角色图片"), "asset");
    if (a?.type !== "image") throw new AppError(400, "角色需要图片素材");
    required(body.name, "角色名称");
  }
  if (kind === "competitor") {
    required(body.name, "名称");
    required(body.externalId, "账号/店铺标识");
    if (!["creator", "shop"].includes(body.entity))
      throw new AppError(400, "请选择达人或店铺");
  }
  res.status(201).json(await put(kind, body));
});
app.patch("/api/records/:kind/:id", async (req, res) => {
  const kind = checkKind(String(req.params.kind)),
    id = String(req.params.id),
    body = object.parse(req.body);
  const previous = await get(id, kind);
  if (!previous) throw new AppError(404, "记录不存在");
  if (kind === "account") throw new AppError(400, "账号资料通过授权刷新");
  const allowed: Doc =
    kind === "asset"
      ? Object.fromEntries(
          Object.entries(body).filter(([k]) =>
            ["name", "tags", "width", "height", "duration"].includes(k),
          ),
        )
      : body;
  res.json(await put(kind, { ...previous, ...allowed }, id));
});
app.delete("/api/records/:kind/:id", async (req, res) => {
  const kind = checkKind(String(req.params.kind)),
    id = String(req.params.id);
  if (kind === "asset") {
    const characters = await list("character");
    if (characters.some((c) => c.assetId === id))
      throw new AppError(409, "素材正在被角色引用，请先删除对应角色");
    const a = await get(id, "asset");
    if (a?.storageKey) {
      await objectDelete(a.storageKey);
      if (a.filename && basename(a.filename) === a.filename)
        await unlink(resolve(".local/object-cache", a.filename)).catch(
          () => {},
        );
    } else {
      const { path } = await assetFile(id);
      await unlink(path);
    }
  }
  if (kind === "account") await remove(id + "-token", "token");
  await remove(id, kind);
  res.json({ ok: true });
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});
app.post("/api/uploads", upload.single("file"), async (req, res) => {
  if (!req.file) throw new AppError(400, "请选择文件");
  const { buffer: b, mimetype: m, originalname: name } = req.file;
  const valid =
    (m === "image/png" &&
      b
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (m === "image/jpeg" && b[0] === 255 && b[1] === 216 && b[2] === 255) ||
    (m === "image/webp" &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP") ||
    (["video/mp4", "video/quicktime"].includes(m) &&
      b.toString("ascii", 4, 8) === "ftyp") ||
    (m === "video/webm" &&
      b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])));
  if (!valid)
    throw new AppError(
      400,
      "文件内容与类型不匹配，支持 PNG、JPG、WebP、MP4、MOV、WebM",
    );
  res.status(201).json(await saveMedia(b, m, name));
});
app.get("/media/:filename", async (req, res, next) => {
  const name = String(req.params.filename);
  if (!/^[a-f0-9-]+\.(png|jpg|webp|mp4|mov|webm)$/.test(name))
    return next(new AppError(404, "文件不存在"));
  const [a] = await rows(
    "SELECT id FROM records WHERE kind='asset' AND workspace_id=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.filename'))=?",
    [workspace(), name],
  );
  if (!a) throw new AppError(404, "素材不存在");
  const { path } = await assetFile(a.id);
  res.sendFile(path, { dotfiles: "allow" });
});
app.get("/api/assets/:id/download", async (req, res) => {
  const { asset, path } = await assetFile(String(req.params.id));
  res.download(path, basename(asset.name || asset.filename), {
    dotfiles: "allow",
  });
});
app.get("/api/jobs", async (_req, res) => res.json(await jobList()));
app.post("/api/jobs", async (req, res) => {
  const b = z
    .object({
      kind: z.string(),
      input: object,
      dedupeKey: z.string().min(8),
      runAt: z.string().optional(),
    })
    .parse(req.body);
  res.status(201).json(await createJob(b.kind, b.input, b.dedupeKey, b.runAt));
});
app.post("/api/jobs/:id/cancel", async (req, res) => {
  await cancelJob(String(req.params.id));
  res.json({ ok: true });
});
app.post("/api/jobs/:id/refresh", async (req, res) => {
  await refreshJob(String(req.params.id));
  res.json(job((await jobGet(String(req.params.id)))!));
});
app.post("/api/competitors/:id/sync", async (req, res) => {
  const id = String(req.params.id);
  const c = await get(id, "competitor");
  if (!c) throw new AppError(404, "竞品记录不存在");
  const shop = c.entity === "shop";
  const response = await echoQuery(
    shop ? "/echotik/seller/video/list" : "/echotik/influencer/video/list",
    {
      [shop ? "seller_id" : "unique_id"]: c.externalId,
      page_num: 1,
      page_size: 10,
      ...(shop
        ? { seller_video_sort_field: 3 }
        : { influencer_video_sort_field: 3 }),
      sort_type: 1,
    },
    true,
  );
  res.json(
    await put(
      "competitor",
      { ...c, snapshot: response, lastSyncedAt: new Date().toISOString() },
      id,
    ),
  );
});
app.post("/api/tiktok/connect", async (_req, res) => {
  const auth = await tiktok.authUrl();
  res.cookie("x_tt_state", auth.state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600000,
    secure: process.env.NODE_ENV === "production",
    path: "/api/tiktok/callback",
  });
  res.json({ url: auth.url, state: auth.state });
});
app.get("/api/tiktok/callback", async (req, res) => {
  const cookie =
    (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("x_tt_state="))
      ?.slice(11) || "";
  await tiktok.callback(
    required(req.query.code, "授权码"),
    required(req.query.state, "授权状态"),
    cookie,
  );
  res.clearCookie("x_tt_state", { path: "/api/tiktok/callback" });
  res.redirect("/publish?connected=1");
});
app.post("/api/tiktok/:id/creator-info", async (req, res) =>
  res.json(await tiktok.creatorInfo(String(req.params.id))),
);
app.post("/api/tiktok/:id/videos", async (req, res) =>
  res.json(
    await tiktok.tikCall(
      String(req.params.id),
      "/v2/video/list/?fields=id,title,cover_image_url,share_url,view_count,like_count,comment_count,share_count",
      { max_count: 20, cursor: req.body.cursor || 0 },
    ),
  ),
);
app.get("/api/analytics", async (_req, res) => {
  const byStatus = await rows(
    "SELECT status,COUNT(*) count FROM jobs WHERE workspace_id=? GROUP BY status",
    [workspace()],
  );
  const byKind = await rows(
    "SELECT kind,COUNT(*) count FROM jobs WHERE workspace_id=? GROUP BY kind",
    [workspace()],
  );
  const usage = await rows(
    "SELECT DATE_FORMAT(created_at,'%Y-%m-%d') day,COUNT(*) calls,SUM(success) successful FROM api_usage WHERE workspace_id=? GROUP BY day ORDER BY day DESC LIMIT 30",
    [workspace()],
  );
  const storage = await rows(
    "SELECT COUNT(*) count,COALESCE(SUM(JSON_EXTRACT(body,'$.bytes')),0) bytes FROM records WHERE kind='asset' AND workspace_id=?",
    [workspace()],
  );
  res.json({ byStatus, byKind, usage, storage: storage[0] });
});
app.get("/api/help", (_req, res) => res.sendFile(resolve("README.md")));
export function apiErrors() {
  app.use("/api", (_req, _res, next) => next(new AppError(404, "接口不存在")));
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) return next(err);
      if (err instanceof z.ZodError)
        return res.status(400).json({
          error: "请求参数不完整或格式不正确",
          code: "VALIDATION",
          issues: err.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        });
      if (err instanceof multer.MulterError)
        return res.status(400).json({
          error: err.code === "LIMIT_FILE_SIZE" ? "文件最大 100MB" : "上传失败",
          code: err.code,
        });
      const status =
        err.code === "ER_DUP_ENTRY"
          ? 409
          : err instanceof AppError
            ? err.status
            : [400, 404, 413].includes(err.status)
              ? err.status
              : 500;
      res.status(status).json({
        error:
          err.code === "ER_DUP_ENTRY"
            ? "记录已存在，请使用新的标识或登录已有账号"
            : err instanceof AppError
              ? err.message
              : status === 404
                ? "文件或接口不存在"
                : status === 400
                  ? "请求格式无效"
                  : status === 413
                    ? "请求内容超过大小上限"
                    : err.code?.startsWith("ECONN")
                      ? "MySQL 或上游连接失败，请检查设置"
                      : "服务暂时无法处理请求，请查看服务器日志",
        code: err.code || "INTERNAL_ERROR",
      });
      if (status === 500)
        console.error(
          "API error:",
          err.code || err.name,
          err.message?.replace(
            /(password|token|key)=[^\s&]+/gi,
            "$1=[redacted]",
          ),
        );
    },
  );
}
