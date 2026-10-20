import { config } from "./config.ts";
import { videoPolicy, buildRenderPlan, planFingerprint } from "./video-plan.ts";
import { Router } from "express";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  pool,
  rows,
  execute,
  parse,
  jobGet,
  get,
  job,
  updateJob,
  type Doc,
} from "./db.ts";
import { workspace, inWorkspace } from "./context.ts";
import { createJob, cancelJob, checkProviders, retryJob } from "./jobs.ts";
import { finalizeCredits } from "./credits.ts";
import { AppError } from "./errors.ts";
import { audit } from "./auth.ts";
import {
  quoteForPlan,
  migrateQuotes,
  retryQuote,
  retryGroupQuote,
} from "./quotes.ts";
import { assetFile } from "./media.ts";
import { probe } from "./video-compose.ts";
import { withJobLock } from "./locks.ts";
export const projectRoutes = Router();
export const projectInputSchema = z
  .object({
    prompt: z.string().max(16000).optional(),
    assetIds: z.array(z.string().min(1).max(64)).max(5).optional(),
    videoAssetId: z.string().max(64).optional(),
    characterId: z.string().max(64).optional(),
    productId: z.string().max(64).optional(),
    sourceCaseId: z.string().max(64).optional(),
    sourceOpportunityId: z.string().max(64).optional(),
    sourceUrl: z.string().max(4000).optional(),
    mode: z.enum(["video", "replicate", "script"]).optional(),
    duration: z.number().finite().min(1).max(120).optional(),
    language: z.string().max(80).optional(),
    style: z.string().max(100).optional(),
    aspect: z.enum(["9:16", "16:9", "1:1"]).optional(),
    videoModelId: z.string().max(200).optional(),
    resolution: z.string().max(20).optional(),
    segmentStrategy: z
      .enum(["balanced", "shots", "fixed", "single"])
      .optional(),
    segmentSeconds: z.number().int().min(1).max(30).optional(),
    frameSource: z.enum(["product", "generated"]).optional(),
    generateAudio: z.boolean().optional(),
  })
  .passthrough()
  .refine(
    (x) => !Object.keys(x).some((k) => k.startsWith("_")),
    "不能保存内部执行字段",
  );
export async function validateProjectInput(value: unknown) {
  const input = projectInputSchema.parse(value);
  for (const id of input.assetIds || []) {
    const a = await get(id, "asset");
    if (a?.type !== "image")
      throw new AppError(404, "项目商品图片不存在或不属于当前工作空间");
  }
  if (input.videoAssetId) {
    const a = await get(input.videoAssetId, "asset");
    if (a?.type !== "video")
      throw new AppError(404, "参考视频不存在或不属于当前工作空间");
  }
  if (input.characterId && !(await get(input.characterId, "character")))
    throw new AppError(404, "角色不存在或不属于当前工作空间");
  for (const [field, kind] of [
    ["productId", "products"],
    ["sourceCaseId", "cases"],
    ["sourceOpportunityId", "opportunities"],
  ] as const) {
    const id = input[field];
    if (!id) continue;
    const found = await rows(
      "SELECT id FROM commerce_entries WHERE id=? AND workspace_id=? AND kind=?",
      [id, workspace(), kind],
    );
    if (!found.length)
      throw new AppError(
        404,
        "关联的商品、案例或机会不存在或不属于当前工作空间",
      );
  }
  return input;
}

const view = (p: Doc): Doc => ({
  ...p,
  input: parse(p.input),
  script: parse(p.script),
  render_job_ids: parse(p.render_job_ids) || [],
  archived: !!p.archived,
});
async function find(id: string) {
  const [p] = await rows(
    "SELECT * FROM projects WHERE id=? AND workspace_id=?",
    [id, workspace()],
  );
  if (!p) throw new AppError(404, "项目不存在");
  return view(p);
}
projectRoutes.get("/projects", async (req, res) => {
  const q = z
    .object({
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      q: z.string().max(200).default(""),
      archived: z.enum(["true", "false"]).default("false"),
    })
    .parse(req.query);
  const result = await rows(
    `SELECT * FROM projects WHERE workspace_id=? AND archived=? AND name LIKE ? ORDER BY created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
    [workspace(), q.archived === "true", `%${q.q}%`],
  );
  res.json(result.map(view));
});
projectRoutes.get("/projects/:id", async (req, res) => {
  const p = await find(String(req.params.id));
  const tasks = await Promise.all(
    [p.analysis_job_id, ...p.render_job_ids].filter(Boolean).map(async (id) => {
      const j = await jobGet(id);
      return j ? job(j) : null;
    }),
  );
  res.json({ ...p, tasks: tasks.filter(Boolean) });
});
projectRoutes.post("/projects", async (req, res) => {
  const b = z
    .object({
      name: z.string().max(200).default("未命名项目"),
      input: z.record(z.string(), z.any()),
    })
    .parse(req.body);
  const input = await validateProjectInput(b.input);
  const id = randomUUID();
  await execute(
    "INSERT INTO projects(id,workspace_id,name,status,input) VALUES(?,?,?,'draft',?)",
    [id, workspace(), b.name, JSON.stringify(input)],
  );
  res.status(201).json(await find(id));
});
projectRoutes.post("/projects/:id/prepare", async (req, res) => {
  const id = String(req.params.id),
    conn = await pool.getConnection();
  let heldId: string | undefined;
  try {
    await conn.beginTransaction();
    const [ps]: any = await conn.execute(
      "SELECT * FROM projects WHERE id=? AND workspace_id=? FOR UPDATE",
      [id, workspace()],
    );
    if (!ps.length) throw new AppError(404, "项目不存在");
    const p = view(ps[0]);
    if (!["draft", "failed", "waiting_confirmation"].includes(p.status))
      throw new AppError(409, "项目正在执行，不能重复准备分镜");
    if (p.render_job_ids.length)
      throw new AppError(409, "请重试失败子任务，或创建新的项目");
    await validateProjectInput(p.input);
    const analysisKind = p.input.mode === "replicate" ? "analysis" : "script";
    const j = await createJob(
      analysisKind,
      { ...p.input, projectId: id },
      `prepare:${id}:${p.version}`,
      undefined,
      true,
    );
    if (j.status === "held") heldId = j.id;
    await conn.execute(
      "UPDATE projects SET status='processing',analysis_job_id=? WHERE id=? AND workspace_id=?",
      [j.id, id, workspace()],
    );
    if (heldId)
      await conn.execute(
        "UPDATE jobs SET status='queued' WHERE id=? AND workspace_id=? AND status='held'",
        [heldId, workspace()],
      );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (heldId) {
      await finalizeCredits(heldId, false);
      await execute(
        "DELETE FROM jobs WHERE id=? AND workspace_id=? AND status='held'",
        [heldId, workspace()],
      );
    }
    throw e;
  } finally {
    conn.release();
  }
  res.json(await find(id));
});

projectRoutes.patch("/projects/:id", async (req, res) => {
  const b = z
    .object({
      version: z.number().int(),
      name: z.string().max(200).optional(),
      input: z.record(z.string(), z.any()).optional(),
      modifiedData: z.record(z.string(), z.any()).optional(),
    })
    .parse(req.body);
  const p = await find(String(req.params.id));
  if (!["draft", "waiting_confirmation", "failed"].includes(p.status))
    throw new AppError(409, "仅草稿或待确认的项目可编辑");
  const nextInput = await validateProjectInput(b.input ?? p.input);
  if (Object.keys(nextInput).some((k) => k.startsWith("_")))
    throw new AppError(400, "项目包含内部字段");
  if (b.modifiedData)
    buildRenderPlan(
      nextInput,
      b.modifiedData,
      videoPolicy(await config(), nextInput),
    );
  const r = await execute(
    "UPDATE projects SET name=?,input=?,script=?,status=?,version=version+1 WHERE id=? AND workspace_id=? AND version=? AND status IN ('draft','waiting_confirmation','failed')",
    [
      b.name ?? p.name,
      JSON.stringify(nextInput),
      JSON.stringify(b.modifiedData ?? p.script),
      b.modifiedData ? "waiting_confirmation" : p.status,
      p.id,
      workspace(),
      b.version,
    ],
  );
  if (!r.affectedRows) throw new AppError(409, "项目已被更新，请刷新后再编辑");
  await execute(
    "INSERT IGNORE INTO project_script_versions(id,workspace_id,project_id,version,snapshot) VALUES(?,?,?,?,?)",
    [
      randomUUID(),
      workspace(),
      p.id,
      p.version,
      JSON.stringify({ input: p.input, script: p.script, name: p.name }),
    ],
  );
  res.json(await find(p.id));
});
projectRoutes.post("/projects/:id/confirm", async (req, res) => {
  const b = z
    .object({
      version: z.number().int(),
      modifiedData: z.record(z.string(), z.any()),
      videoGenerationCount: z.number().int().min(1).max(4).default(1),
      renderOptions: z
        .object({
          videoModelId: z.string().optional(),
          segmentStrategy: z
            .enum(["balanced", "shots", "fixed", "single"])
            .optional(),
          segmentSeconds: z.number().int().min(1).max(30).optional(),
          duration: z.number().min(1).max(120).optional(),
          aspect: z.enum(["9:16", "16:9", "1:1"]).optional(),
          resolution: z.string().optional(),
          generateAudio: z.boolean().optional(),
          frameSource: z.enum(["generated", "product"]).optional(),
        })
        .optional(),
      planFingerprint: z.string().length(64).optional(),
      quoteFingerprint: z.string().length(64).optional(),
    })
    .parse(req.body);
  const id = String(req.params.id),
    hash = createHash("sha256").update(JSON.stringify(b)).digest("hex");
  const conn = await pool.getConnection();
  const held: string[] = [];
  try {
    await conn.beginTransaction();
    const [ps]: any = await conn.execute(
      "SELECT * FROM projects WHERE id=? AND workspace_id=? FOR UPDATE",
      [id, workspace()],
    );
    if (!ps.length) throw new AppError(404, "项目不存在");
    const p = view(ps[0]);
    const [previous]: any = await conn.execute(
      "SELECT * FROM project_confirmations WHERE project_id=? AND version=?",
      [id, b.version],
    );
    if (previous.length) {
      if (previous[0].content_hash !== hash)
        throw new AppError(409, "该版本已确认，不能替换确认内容");
      await conn.commit();
      return res.json({ idempotent: true, jobIds: parse(previous[0].job_ids) });
    }
    if (p.version !== b.version || p.status !== "waiting_confirmation")
      throw new AppError(409, "确认版本过期，或项目尚未完成分镜");
    const mainPrompt = b.modifiedData.shootingPrompt || b.modifiedData.script;
    if (typeof mainPrompt !== "string" || !mainPrompt.trim())
      throw new AppError(400, "确认内容需要 shootingPrompt 或 script");
    const prompt = mainPrompt;
    const renderInput = {
      ...p.input,
      ...b.renderOptions,
      prompt,
      storyboard: b.modifiedData,
    };
    await validateProjectInput(renderInput);
    if (Object.keys(renderInput).some((k) => k.startsWith("_")))
      throw new AppError(400, "项目包含内部任务字段");
    const policy = videoPolicy(await config(), renderInput);
    const plan = buildRenderPlan(renderInput, b.modifiedData, policy);
    if (b.planFingerprint && b.planFingerprint !== planFingerprint(plan))
      throw new AppError(409, "生成计划或配置已变化，请重新预览后确认");
    const quote = await quoteForPlan(plan, b.videoGenerationCount);
    if (b.quoteFingerprint && b.quoteFingerprint !== quote.fingerprint)
      throw new AppError(409, "报价规则已变化，请重新预览后确认");
    await checkProviders("video", renderInput);
    for (let i = 0; i < b.videoGenerationCount; i++) {
      const j = await createJob(
        "video",
        {
          ...renderInput,
          _videoPolicy: policy,
          _renderPlan: plan,
          _quoteSnapshot: quote,
          projectId: id,
          confirmationVersion: b.version,
          variant: i + 1,
        },
        `confirm:${id}:${b.version}:${i}`,
        undefined,
        true,
        true,
      );
      held.push(j.id);
    }
    await conn.execute(
      "INSERT INTO project_confirmations(id,workspace_id,project_id,version,content_hash,snapshot,job_ids,quote_snapshot) VALUES(?,?,?,?,?,?,?,?)",
      [
        randomUUID(),
        workspace(),
        id,
        b.version,
        hash,
        JSON.stringify(b.modifiedData),
        JSON.stringify(held),
        JSON.stringify(quote),
      ],
    );
    await conn.execute(
      "UPDATE projects SET status='processing',script=?,render_job_ids=?,input=? WHERE id=?",
      [
        JSON.stringify(b.modifiedData),
        JSON.stringify(held),
        JSON.stringify(renderInput),
        id,
      ],
    );
    for (const jid of held)
      await conn.execute(
        "UPDATE jobs SET status='queued' WHERE id=? AND workspace_id=? AND status='held'",
        [jid, workspace()],
      );
    await conn.commit();
    // Audit failure cannot roll back a committed render submission.
    await audit("project.confirmed", {
      projectId: id,
      version: b.version,
      count: held.length,
    }).catch((e) => console.error("Project audit:", e.code || e.name));
    res.json({ jobIds: held });
  } catch (e) {
    await conn.rollback();
    for (const jid of held) {
      await finalizeCredits(jid, false);
      await execute(
        "DELETE FROM jobs WHERE id=? AND workspace_id=? AND status='held'",
        [jid, workspace()],
      );
    }
    throw e;
  } finally {
    conn.release();
  }
});
projectRoutes.post("/projects/:id/cancel", async (req, res) => {
  const p = await find(String(req.params.id));
  for (const id of [p.analysis_job_id, ...p.render_job_ids].filter(Boolean)) {
    const j = await jobGet(id);
    if (j && ["queued", "scheduled", "processing"].includes(j.status))
      try {
        await cancelJob(id);
      } catch {}
  }
  await execute(
    "UPDATE projects SET cancel_requested=TRUE WHERE id=? AND workspace_id=?",
    [p.id, workspace()],
  );
  await reconcileProjects();
  res.json(await find(p.id));
});
async function projectRetryQuote(p: Doc) {
  const jobs = [];
  for (const id of p.render_job_ids) {
    const r = await jobGet(id);
    if (!r) throw new AppError(409, "子任务记录缺失");
    if (r.status !== "completed") jobs.push(await retryQuote(r));
  }
  return retryGroupQuote(jobs, p.version);
}
projectRoutes.get("/projects/:id/retry-quote", async (req, res) =>
  res.json(await projectRetryQuote(await find(String(req.params.id)))),
);
projectRoutes.post("/projects/:id/retry", async (req, res) => {
  const p = await find(String(req.params.id));
  if (!["failed", "cancelled", "partially_completed"].includes(p.status))
    throw new AppError(409, "请先核对项目和子任务状态");
  const confirmation = z
    .object({ confirm: z.literal(true), fingerprint: z.string().length(64) })
    .parse(req.body);
  const quote = await projectRetryQuote(p);
  if (confirmation.fingerprint !== quote.fingerprint)
    throw new AppError(409, "项目状态或报价已变化，请重新核对费用");
  if (p.render_job_ids.length) {
    const conn = await pool.getConnection(),
      held: string[] = [];
    try {
      await conn.beginTransaction();
      const [current]: any = await conn.execute(
        "SELECT version,status FROM projects WHERE id=? AND workspace_id=? FOR UPDATE",
        [p.id, workspace()],
      );
      if (current[0]?.version !== p.version || current[0]?.status !== p.status)
        throw new AppError(409, "项目已更新，请刷新");
      const ids: string[] = [];
      for (const oldId of p.render_job_ids) {
        const old = await jobGet(oldId);
        if (!old) throw new AppError(409, "子任务记录缺失，需要核对");
        if (old.status === "completed") {
          ids.push(oldId);
          continue;
        }
        if (!["failed", "cancelled"].includes(old.status))
          throw new AppError(409, "仍有未完成的子任务，请先核对");
        const j = await retryJob(
          oldId,
          `projectretry:${p.id}:${p.version}:${oldId}`,
          true,
          quote.jobs.find((q) => q.jobId === oldId)?.fingerprint,
        );
        held.push(j.id);
        ids.push(j.id);
      }
      await conn.execute(
        "UPDATE projects SET status='processing',version=version+1,render_job_ids=?,cancel_requested=FALSE WHERE id=? AND workspace_id=?",
        [JSON.stringify(ids), p.id, workspace()],
      );
      for (const jid of held)
        await conn.execute(
          "UPDATE jobs SET status=IF(JSON_UNQUOTE(JSON_EXTRACT(provider,'$.name'))='video-pipeline','processing','queued') WHERE id=? AND workspace_id=? AND status='held'",
          [jid, workspace()],
        );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      for (const jid of held) {
        await finalizeCredits(jid, false);
        await execute(
          "DELETE FROM jobs WHERE id=? AND workspace_id=? AND status='held'",
          [jid, workspace()],
        );
      }
      throw e;
    } finally {
      conn.release();
    }
  } else {
    await execute(
      "UPDATE projects SET status='draft',version=version+1,analysis_job_id=NULL,render_job_ids=NULL,cancel_requested=FALSE WHERE id=? AND workspace_id=? AND version=? AND status IN ('failed','cancelled')",
      [p.id, workspace(), p.version],
    );
  }
  res.json(await find(p.id));
});
projectRoutes.delete("/projects/:id", async (req, res) => {
  const p = await find(String(req.params.id));
  if (p.status === "processing") throw new AppError(409, "请先取消项目");
  await execute("DELETE FROM projects WHERE id=? AND workspace_id=?", [
    p.id,
    workspace(),
  ]);
  res.json({ ok: true });
});
export async function reconcileProjects() {
  const ps = await rows(
    "SELECT * FROM projects WHERE status IN ('processing','review','waiting_confirmation','draft')",
  );
  for (const raw of ps)
    await inWorkspace(raw.workspace_id, async () => {
      const p = view(raw);
      const ids = [...p.render_job_ids];
      if (!ids.length && p.analysis_job_id) ids.push(p.analysis_job_id);
      const js = (await Promise.all(ids.map(jobGet))).filter(Boolean) as Doc[];
      let next = p.status;
      let script = p.script;
      if (p.cancel_requested) {
        if (
          !js.length ||
          js.every((j) =>
            ["completed", "failed", "cancelled"].includes(j.status),
          )
        )
          next = "cancelled";
        else if (js.some((j) => j.status === "review")) next = "review";
      } else if (js.length) {
        if (js.some((j) => j.status === "review")) next = "review";
        else if (
          js.some((j) => j.status === "failed") &&
          js.every((j) =>
            ["completed", "failed", "cancelled"].includes(j.status),
          )
        )
          next = js.some((j) => j.status === "completed")
            ? "partially_completed"
            : "failed";
        else if (js.every((j) => j.status === "completed")) {
          if (p.render_job_ids.length) next = "completed";
          else if (p.status === "processing") {
            next = "waiting_confirmation";
            script = parse(js[0].result);
          }
        }
      }
      if (next !== p.status)
        await execute(
          "UPDATE projects SET status=?,script=? WHERE id=? AND workspace_id=?",
          [next, JSON.stringify(script), p.id, workspace()],
        );
    });
}

export async function migrateVideoStudio() {
  for (const [table, name, definition] of [
    ["projects", "archived", "BOOLEAN NOT NULL DEFAULT FALSE"],
    ["projects", "parent_id", "VARCHAR(64) NULL"],
    ["projects", "batch_id", "VARCHAR(64) NULL"],
    ["project_confirmations", "quote_snapshot", "JSON NULL"],
  ]) {
    const found = await rows(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
      [table, name],
    );
    if (!found.length)
      await execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  await execute(
    `CREATE TABLE IF NOT EXISTS project_batches(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,name VARCHAR(200) NOT NULL,dedupe_key VARCHAR(128) NOT NULL,plan JSON NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),UNIQUE batch_request(workspace_id,dedupe_key))`,
  );
  await execute(
    `CREATE TABLE IF NOT EXISTS project_script_versions(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,project_id VARCHAR(64) NOT NULL,version INT NOT NULL,snapshot JSON NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),UNIQUE script_version(project_id,version))`,
  );
  await execute(
    `CREATE TABLE IF NOT EXISTS project_render_revisions(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,project_id VARCHAR(64) NOT NULL,source_job_id VARCHAR(64) NOT NULL,job_id VARCHAR(64) NOT NULL,change_snapshot JSON NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),UNIQUE revised_job(job_id))`,
  );
  await migrateQuotes();
}
const stableJson = (v: any): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const batchSchema = z.object({
  name: z.string().min(1).max(200),
  products: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        prompt: z.string().min(1).max(4000),
        assetIds: z.array(z.string().max(64)).min(1).max(5),
        productId: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(20),
  languages: z.array(z.string().min(1).max(50)).min(1).max(12),
  variants: z.number().int().min(1).max(4).default(1),
  defaults: z.record(z.string(), z.any()).default({}),
  dedupeKey: z.string().min(1).max(128),
});
export function expandBatch(b: z.infer<typeof batchSchema>) {
  if (new Set(b.languages).size !== b.languages.length)
    throw new AppError(400, "语言不可重复");
  if (b.products.length * b.languages.length > 40)
    throw new AppError(400, "每批最多 40 个商品语言项目");
  if (Object.keys(b.defaults).some((k) => k.startsWith("_")))
    throw new AppError(400, "批量默认配置包含内部字段");
  return b.products.flatMap((p) =>
    b.languages.map((language) => ({
      name: `${p.name} · ${language}`,
      input: { ...b.defaults, ...p, language, requestedVariants: b.variants },
    })),
  );
}
projectRoutes.post("/projects/batch/preview", async (req, res) => {
  const b = batchSchema.parse(req.body),
    items = expandBatch(b);
  res.json({
    items,
    projectCount: items.length,
    videoCount: items.length * b.variants,
    notice: "仅创建待确认项目，不自动调用生成或发布。",
  });
});
projectRoutes.post("/projects/batch", async (req, res) => {
  const b = batchSchema.parse(req.body),
    items = expandBatch(b);
  for (const p of b.products)
    for (const id of p.assetIds) {
      const a = await get(id, "asset");
      if (a?.type !== "image")
        throw new AppError(400, "批次商品需要本空间图片素材");
    }
  for (const item of items) {
    await validateProjectInput(item.input);
    videoPolicy(await config(), item.input);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [previous]: any = await conn.execute(
      "SELECT * FROM project_batches WHERE workspace_id=? AND dedupe_key=? FOR UPDATE",
      [workspace(), b.dedupeKey],
    );
    if (previous.length) {
      if (stableJson(parse(previous[0].plan)) !== stableJson(items))
        throw new AppError(409, "请求标识已用于另一批次");
      await conn.commit();
      return res.json({ id: previous[0].id, duplicate: true });
    }
    const id = randomUUID();
    await conn.execute(
      "INSERT INTO project_batches(id,workspace_id,name,dedupe_key,plan) VALUES(?,?,?,?,?)",
      [id, workspace(), b.name, b.dedupeKey, JSON.stringify(items)],
    );
    for (const item of items)
      await conn.execute(
        "INSERT INTO projects(id,workspace_id,name,status,input,batch_id) VALUES(?,?,?,'draft',?,?)",
        [randomUUID(), workspace(), item.name, JSON.stringify(item.input), id],
      );
    await conn.commit();
    res.status(201).json({
      id,
      projectCount: items.length,
      videoCount: items.length * b.variants,
    });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});
projectRoutes.post("/projects/:id/duplicate", async (req, res) => {
  const p = await find(String(req.params.id)),
    b = z
      .object({ name: z.string().min(1).max(200).optional() })
      .parse(req.body),
    id = randomUUID();
  const clean = Object.fromEntries(
    Object.entries(p.input).filter(([k]) => !k.startsWith("_")),
  );
  await validateProjectInput(clean);
  await execute(
    "INSERT INTO projects(id,workspace_id,name,status,input,script,parent_id) VALUES(?,?,?,?,?,?,?)",
    [
      id,
      workspace(),
      b.name || `${p.name} · 副本`,
      p.script ? "waiting_confirmation" : "draft",
      JSON.stringify(clean),
      JSON.stringify(p.script),
      p.id,
    ],
  );
  res.status(201).json(await find(id));
});
projectRoutes.post("/projects/:id/archive", async (req, res) => {
  const p = await find(String(req.params.id)),
    b = z.object({ archived: z.boolean() }).parse(req.body);
  if (["processing", "review"].includes(p.status))
    throw new AppError(409, "请先处理正在执行或待核对的任务");
  await execute(
    "UPDATE projects SET archived=? WHERE id=? AND workspace_id=?",
    [b.archived, p.id, workspace()],
  );
  res.json(await find(p.id));
});
projectRoutes.get("/projects/:id/history", async (req, res) => {
  const p = await find(String(req.params.id));
  const scripts = await rows(
    "SELECT * FROM project_script_versions WHERE project_id=? AND workspace_id=? ORDER BY version DESC",
    [p.id, workspace()],
  );
  const confirmations = await rows(
    "SELECT * FROM project_confirmations WHERE project_id=? AND workspace_id=? ORDER BY version DESC",
    [p.id, workspace()],
  );
  const revisions = await rows(
    "SELECT * FROM project_render_revisions WHERE project_id=? AND workspace_id=? ORDER BY created_at DESC",
    [p.id, workspace()],
  );
  const oldIds = [
    ...new Set([
      ...confirmations.flatMap((x) => parse(x.job_ids) || []),
      ...revisions.flatMap((r) => [r.source_job_id, r.job_id]),
    ]),
  ];
  const tasks = (
    await Promise.all(
      oldIds.map(async (id) => {
        const j = await jobGet(id);
        return j ? job(j) : null;
      }),
    )
  ).filter(Boolean);
  res.json({
    scripts: scripts.map((s) => ({ ...s, snapshot: parse(s.snapshot) })),
    confirmations: confirmations.map((c) => ({
      ...c,
      snapshot: parse(c.snapshot),
      quote: parse(c.quote_snapshot),
      jobIds: parse(c.job_ids),
    })),
    revisions: revisions.map((r) => ({
      ...r,
      change: parse(r.change_snapshot),
    })),
    tasks,
  });
});
const revisionSchema = z.object({
  segmentIndex: z.number().int().min(0).max(19),
  action: z.enum(["regenerate", "replace"]),
  assetId: z.string().max(64).optional(),
  prompt: z.string().trim().min(1).max(12000).optional(),
  dedupeKey: z.string().min(1).max(100),
  quoteFingerprint: z.string().length(64).optional(),
});
async function revisionPlan(
  projectId: string,
  jobId: string,
  b: z.infer<typeof revisionSchema>,
) {
  const project = await find(projectId);
  const old = await jobGet(jobId);
  if (!old || !project.render_job_ids.includes(jobId))
    throw new AppError(404, "项目当前视频任务不存在");
  if (old.status !== "completed")
    throw new AppError(409, "仅能修改已完成视频；失败片段请使用重试");
  const p = structuredClone(parse(old.provider));
  if (
    p?.name !== "video-pipeline" ||
    !p.segments[b.segmentIndex] ||
    !p.segments.every((s: Doc) => s.status === "completed")
  )
    throw new AppError(409, "任务没有可复用的完整片段");
  const segment = p.segments[b.segmentIndex];
  let replacement: Doc | undefined;
  if (b.action === "replace") {
    if (!b.assetId) throw new AppError(400, "请选择替换视频");
    const media = await assetFile(b.assetId);
    if (media.asset.type !== "video")
      throw new AppError(400, "替换素材必须是视频");
    const info = await probe(media.path);
    if (
      !info.streams?.some((s: Doc) => s.codec_type === "video") ||
      Number(info.format?.duration) + 0.1 < segment.duration
    )
      throw new AppError(400, "替换视频没有有效画面或短于该段时长");
    replacement = media.asset;
  }
  const quote =
    b.action === "replace"
      ? {
          amount: 0,
          currency: null,
          status: "local",
          components: [],
          fingerprint: "local",
        }
      : await quoteForPlan({
          ...p.plan,
          segments: [p.plan.segments[b.segmentIndex]],
        });
  return { project, old, p, segment, replacement, quote };
}
projectRoutes.post(
  "/projects/:id/renders/:jobId/revision-preview",
  async (req, res) => {
    const b = revisionSchema.parse(req.body),
      plan = await revisionPlan(
        String(req.params.id),
        String(req.params.jobId),
        b,
      );
    res.json({
      quote: plan.quote,
      segment: plan.segment.index,
      reusedSegments: plan.p.segments.length - 1,
    });
  },
);
projectRoutes.post("/projects/:id/renders/:jobId/revise", async (req, res) => {
  const b = revisionSchema.parse(req.body),
    id = String(req.params.id),
    source = String(req.params.jobId);
  return withJobLock(source, async () => {
    const previous = await rows(
      "SELECT j.*,r.change_snapshot FROM jobs j JOIN project_render_revisions r ON r.job_id=j.id WHERE r.project_id=? AND r.source_job_id=? AND r.workspace_id=? AND JSON_UNQUOTE(JSON_EXTRACT(r.change_snapshot,'$.dedupeKey'))=?",
      [id, source, workspace(), b.dedupeKey],
    );
    if (previous.length) {
      const oldChange = parse(previous[0].change_snapshot);
      delete oldChange.quote;
      if (stableJson(oldChange) !== stableJson(b))
        throw new AppError(409, "该请求标识已用于不同的片段修改");
      return res.json(job(previous[0]));
    }
    const { project, old, p, segment, replacement, quote } = await revisionPlan(
      id,
      source,
      b,
    );
    if (b.quoteFingerprint && quote.fingerprint !== b.quoteFingerprint)
      throw new AppError(409, "报价已更新，请重新预览");
    if (replacement) {
      segment.asset = replacement;
      segment.replaced = true;
    } else {
      segment.prompt = b.prompt || segment.prompt;
      p.plan.segments[b.segmentIndex].prompt = segment.prompt;
      segment.status = "queued";
      delete segment.asset;
      delete segment.frameUrl;
      delete segment.requestId;
      delete segment.frameRequestId;
      delete segment.videoPayload;
      delete segment.resumeStage;
    }
    p.stage = "generating";
    p.concatStatus = "pending";
    p.cancelRequested = false;
    const input = {
      ...parse(old.input),
      _renderPlan: p.plan,
      _localComposeOnly: !!replacement,
      _quoteSnapshot: quote,
      revisionOf: source,
    };
    const created = await createJob(
      "video",
      input,
      `revision:${id}:${source}:${b.dedupeKey}`,
      undefined,
      true,
      true,
    );
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [current]: any = await conn.execute(
        "SELECT render_job_ids FROM projects WHERE id=? AND workspace_id=? FOR UPDATE",
        [id, workspace()],
      );
      const ids = parse(current[0]?.render_job_ids) || [];
      if (!ids.includes(source))
        throw new AppError(409, "项目视频已修改，请刷新");
      await conn.execute(
        "UPDATE jobs SET provider=?,result=?,status='processing' WHERE id=? AND workspace_id=? AND status='held'",
        [
          JSON.stringify(p),
          JSON.stringify({
            storyboard: parse(old.result)?.storyboard,
            sourceJobId: source,
            priorAssetId: parse(old.result)?.asset?.id,
          }),
          created.id,
          workspace(),
        ],
      );
      await conn.execute(
        "INSERT INTO project_render_revisions(id,workspace_id,project_id,source_job_id,job_id,change_snapshot) VALUES(?,?,?,?,?,?)",
        [
          randomUUID(),
          workspace(),
          id,
          source,
          created.id,
          JSON.stringify({ ...b, quote }),
        ],
      );
      await conn.execute(
        "UPDATE projects SET render_job_ids=?,status='processing',version=version+1 WHERE id=? AND workspace_id=?",
        [
          JSON.stringify(
            ids.map((x: string) => (x === source ? created.id : x)),
          ),
          id,
          workspace(),
        ],
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      await finalizeCredits(created.id, false);
      await execute(
        "DELETE FROM jobs WHERE id=? AND workspace_id=? AND status='held'",
        [created.id, workspace()],
      );
      throw e;
    } finally {
      conn.release();
    }
    await audit("project.segment.revised", {
      projectId: project.id,
      sourceJobId: source,
      jobId: created.id,
      segmentIndex: b.segmentIndex,
      action: b.action,
    }).catch(() => {});
    res.status(201).json(job((await jobGet(created.id))!));
  });
});
