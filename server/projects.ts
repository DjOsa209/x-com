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
  job,
  updateJob,
  type Doc,
} from "./db.ts";
import { workspace, inWorkspace } from "./context.ts";
import { createJob, cancelJob, checkProviders, retryJob } from "./jobs.ts";
import { finalizeCredits } from "./credits.ts";
import { AppError } from "./errors.ts";
import { audit } from "./auth.ts";
export const projectRoutes = Router();
const view = (p: Doc): Doc => ({
  ...p,
  input: parse(p.input),
  script: parse(p.script),
  render_job_ids: parse(p.render_job_ids) || [],
});
async function find(id: string) {
  const [p] = await rows(
    "SELECT * FROM projects WHERE id=? AND workspace_id=?",
    [id, workspace()],
  );
  if (!p) throw new AppError(404, "项目不存在");
  return view(p);
}
projectRoutes.get("/projects", async (_req, res) =>
  res.json(
    (
      await rows(
        "SELECT * FROM projects WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200",
        [workspace()],
      )
    ).map(view),
  ),
);
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
  const id = randomUUID();
  await execute(
    "INSERT INTO projects(id,workspace_id,name,status,input) VALUES(?,?,?,'draft',?)",
    [id, workspace(), b.name, JSON.stringify(b.input)],
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
  const r = await execute(
    "UPDATE projects SET name=?,input=?,script=?,version=version+1 WHERE id=? AND workspace_id=? AND version=? AND status IN ('draft','waiting_confirmation','failed')",
    [
      b.name ?? p.name,
      JSON.stringify(b.input ?? p.input),
      JSON.stringify(b.modifiedData ?? p.script),
      p.id,
      workspace(),
      b.version,
    ],
  );
  if (!r.affectedRows) throw new AppError(409, "项目已被更新，请刷新后再编辑");
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
        })
        .optional(),
      planFingerprint: z.string().length(64).optional(),
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
    if (Object.keys(renderInput).some((k) => k.startsWith("_")))
      throw new AppError(400, "项目包含内部任务字段");
    const policy = videoPolicy(await config(), renderInput);
    const plan = buildRenderPlan(renderInput, b.modifiedData, policy);
    if (b.planFingerprint && b.planFingerprint !== planFingerprint(plan))
      throw new AppError(409, "生成计划或配置已变化，请重新预览后确认");
    await checkProviders("video", renderInput);
    for (let i = 0; i < b.videoGenerationCount; i++) {
      const j = await createJob(
        "video",
        {
          ...renderInput,
          _videoPolicy: policy,
          _renderPlan: plan,
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
      "INSERT INTO project_confirmations(id,workspace_id,project_id,version,content_hash,snapshot,job_ids) VALUES(?,?,?,?,?,?,?)",
      [
        randomUUID(),
        workspace(),
        id,
        b.version,
        hash,
        JSON.stringify(b.modifiedData),
        JSON.stringify(held),
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
projectRoutes.post("/projects/:id/retry", async (req, res) => {
  const p = await find(String(req.params.id));
  if (!["failed", "cancelled"].includes(p.status))
    throw new AppError(409, "请先核对项目和子任务状态");
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
          next = "failed";
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
