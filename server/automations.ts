import { Router } from "express";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { rows, execute, parse, type Doc } from "./db.ts";
import { workspace, inWorkspace } from "./context.ts";
import { createJob } from "./jobs.ts";
import { AppError } from "./errors.ts";
import {
  createResearchRun,
  attachResearchJob,
  notifyOperation,
} from "./research-budget.ts";
export const automationRoutes = Router();
export const automationTemplates = [
  {
    kind: "collect",
    name: "每日趋势采集",
    description: "保存排行榜与分页证据，供团队筛选。",
  },
  {
    kind: "opportunity_scan",
    name: "评论机会扫描",
    description: "采集商品与评论，形成带证据的选品机会。",
  },
  {
    kind: "watch_sync",
    name: "监控变化",
    description: "同步已关注商品、店铺、视频或达人，比较变化。",
  },
  {
    kind: "case_collect",
    name: "销售案例采集",
    description: "将真实视频及指标保存到案例库，保留来源。",
  },
  {
    kind: "metrics_sync",
    name: "作品效果回收",
    description: "分页读取已授权账号的作品指标，不自动发布。",
  },
];
const budgetSchema = z.object({
  maxRequests: z.number().int().min(1).max(500).default(30),
  dailyRequestLimit: z.number().int().min(1).max(10000).default(100),
});
export const automationInput = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum([
    "collect",
    "opportunity_scan",
    "watch_sync",
    "case_collect",
    "metrics_sync",
  ]),
  input: z.record(z.string(), z.any()).default({}),
  intervalMinutes: z.number().int().min(15).max(43200),
  enabled: z.boolean().default(true),
  budget: budgetSchema.optional(),
});
function safeInput(input: Doc, budget?: Doc) {
  if (
    Object.keys(input).some((k) => k.startsWith("_") || k === "researchRunId")
  )
    throw new AppError(400, "不能设置内部运行字段");
  if (input.extractPrompts === true)
    throw new AppError(
      400,
      "自动采集只保存案例；视频分析与生成需由团队从案例中确认发起",
    );
  return {
    ...input,
    researchBudget: budgetSchema.parse(budget || input.researchBudget || {}),
  };
}
automationRoutes.get("/automations/templates", (_req, res) =>
  res.json(automationTemplates),
);
automationRoutes.get("/automations", async (req, res) => {
  const p = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    })
    .parse(req.query);
  const paged = req.query.page !== undefined;
  const items = (
    await rows(
      "SELECT * FROM automations WHERE workspace_id=? ORDER BY created_at DESC LIMIT " +
        (paged ? p.pageSize : 200) +
        " OFFSET " +
        (paged ? (p.page - 1) * p.pageSize : 0),
      [workspace()],
    )
  ).map((r) => ({
    ...r,
    input: parse(r.input),
    budget: parse(r.input).researchBudget || {
      maxRequests: 30,
      dailyRequestLimit: 100,
    },
  }));
  if (!paged) return res.json(items);
  const [{ total }] = await rows(
    "SELECT COUNT(*) total FROM automations WHERE workspace_id=?",
    [workspace()],
  );
  res.json({ items, total: Number(total), page: p.page, pageSize: p.pageSize });
});
automationRoutes.post("/automations", async (req, res) => {
  const b = automationInput.parse(req.body),
    id = randomUUID();
  await execute(
    "INSERT INTO automations(id,workspace_id,name,kind,input,interval_minutes,next_run_at,enabled) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP(3),?)",
    [
      id,
      workspace(),
      b.name,
      b.kind,
      JSON.stringify(safeInput(b.input, b.budget)),
      b.intervalMinutes,
      b.enabled,
    ],
  );
  res.status(201).json({ id });
});
automationRoutes.patch("/automations/:id", async (req, res) => {
  const b = automationInput.partial().parse(req.body);
  const [a] = await rows(
    "SELECT * FROM automations WHERE id=? AND workspace_id=?",
    [req.params.id, workspace()],
  );
  if (!a) throw new AppError(404, "自动化不存在");
  const next = safeInput(b.input || parse(a.input), b.budget);
  await execute(
    "UPDATE automations SET name=?,kind=?,input=?,interval_minutes=?,enabled=? WHERE id=? AND workspace_id=?",
    [
      b.name ?? a.name,
      b.kind ?? a.kind,
      JSON.stringify(next),
      b.intervalMinutes ?? a.interval_minutes,
      b.enabled ?? !!a.enabled,
      a.id,
      workspace(),
    ],
  );
  res.json({ ok: true });
});
automationRoutes.delete("/automations/:id", async (req, res) => {
  await execute("DELETE FROM automations WHERE id=? AND workspace_id=?", [
    req.params.id,
    workspace(),
  ]);
  res.json({ ok: true });
});
export async function enqueueAutomation(a: Doc, dedupe: string) {
  const input = parse(a.input);
  const stableId = createHash("sha256")
    .update(workspace() + ":" + dedupe)
    .digest("hex");
  const runId = await createResearchRun(
    a.kind,
    input,
    a.id,
    input.researchBudget || {},
    stableId,
  );
  try {
    const job: Doc = await createJob(
      a.kind,
      { ...input, researchRunId: runId },
      dedupe,
    );
    await attachResearchJob(runId, job.id);
    await execute(
      "UPDATE automations SET last_job_id=?,last_error=NULL WHERE id=? AND workspace_id=?",
      [job.id, a.id, workspace()],
    );
    return { ...job, id: String(job.id), researchRunId: runId };
  } catch (e: any) {
    await execute(
      "UPDATE research_runs SET status='failed',error=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",
      [String(e.message).slice(0, 2000), runId],
    );
    throw e;
  }
}
automationRoutes.post("/automations/:id/run", async (req, res) => {
  const [a] = await rows(
    "SELECT * FROM automations WHERE id=? AND workspace_id=?",
    [req.params.id, workspace()],
  );
  if (!a) throw new AppError(404, "自动化不存在");
  res.json(await enqueueAutomation(a, randomUUID()));
});
export async function scheduleAutomations() {
  const due = await rows(
    "SELECT * FROM automations WHERE enabled=1 AND next_run_at<=UTC_TIMESTAMP(3) ORDER BY next_run_at LIMIT 5",
  );
  for (const a of due)
    await inWorkspace(a.workspace_id, async () => {
      try {
        const job = await enqueueAutomation(
          a,
          "automation:" + a.id + ":" + new Date(a.next_run_at).toISOString(),
        );
        await execute(
          "UPDATE automations SET last_job_id=?,last_error=NULL,next_run_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL interval_minutes MINUTE) WHERE id=?",
          [job.id, a.id],
        );
      } catch (e: any) {
        await execute(
          "UPDATE automations SET last_error=?,next_run_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL interval_minutes MINUTE) WHERE id=?",
          [String(e.message).slice(0, 1000), a.id],
        );
        await notifyOperation(
          "automation-error:" +
            a.id +
            ":" +
            new Date(a.next_run_at).toISOString(),
          "自动化未能启动",
          String(e.message).slice(0, 1000),
        );
      }
    });
}
