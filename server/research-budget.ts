import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { pool, rows, execute, parse, type Doc } from "./db.ts";
import { workspace } from "./context.ts";
import { config } from "./config.ts";
import { AppError } from "./errors.ts";

export const researchKinds = [
  "collect",
  "opportunity_scan",
  "watch_sync",
  "case_collect",
  "metrics_sync",
];
type ResearchContext = {
  runId: string;
  automationId?: string;
  maxRequests: number;
  dailyLimit: number;
};
const researchContext = new AsyncLocalStorage<ResearchContext>();
export const currentResearchRun = () => researchContext.getStore();
export const operationDefaults = {
  monthlyRequestLimit: 3000,
  tiktokDirectEnabled: false,
  tiktokInboxEnabled: false,
  tiktokQualificationNote: "",
  verifiedMediaPrefix: "",
};
export async function operationSettings(): Promise<Doc> {
  const [r] = await rows(
    "SELECT body FROM operation_settings WHERE workspace_id=?",
    [workspace()],
  );
  return { ...operationDefaults, ...(r ? parse(r.body) : {}) };
}
export async function notifyOperation(
  dedupe: string,
  title: string,
  message: string,
  href = "/automations",
) {
  await execute(
    "INSERT IGNORE INTO operation_notifications(id,workspace_id,dedupe_key,title,message,href) VALUES(?,?,?,?,?,?)",
    [randomUUID(), workspace(), dedupe, title, message, href],
  );
}
export async function createResearchRun(
  kind: string,
  input: Doc,
  automationId?: string,
  limits: Doc = {},
  stableId?: string,
) {
  if (!researchKinds.includes(kind))
    throw new AppError(400, "自动化仅支持研究和效果同步");
  const id = stableId || randomUUID();
  const maxRequests = Math.max(
    1,
    Math.min(500, Number(limits.maxRequests ?? input.maxRequests ?? 30)),
  );
  const dailyLimit = Math.max(
    1,
    Math.min(
      10000,
      Number(limits.dailyRequestLimit ?? input.dailyRequestLimit ?? 100),
    ),
  );
  if (!Number.isSafeInteger(maxRequests) || !Number.isSafeInteger(dailyLimit))
    throw new AppError(400, "研究预算必须为整数");
  await execute(
    "INSERT IGNORE INTO research_runs(id,workspace_id,automation_id,kind,input,evidence,max_requests,daily_limit) VALUES(?,?,?,?,?,'[]',?,?)",
    [
      id,
      workspace(),
      automationId || null,
      kind,
      JSON.stringify(input),
      maxRequests,
      dailyLimit,
    ],
  );
  return id;
}
export async function attachResearchJob(runId: string, jobId: string) {
  await execute(
    "UPDATE research_runs SET job_id=? WHERE id=? AND workspace_id=? AND job_id IS NULL",
    [jobId, runId, workspace()],
  );
}
export async function recordResearchEvidence(data: unknown) {
  const context = currentResearchRun();
  if (!context) return;
  // Keep individual snapshots bounded; the original observation remains a separate domain record.
  const json = JSON.stringify(data);
  const evidence =
    json.length > 500000
      ? { truncated: true, preview: json.slice(0, 30000) }
      : data;
  await execute(
    "UPDATE research_runs SET evidence=JSON_ARRAY_APPEND(evidence,'$',CAST(? AS JSON)) WHERE id=? AND workspace_id=?",
    [JSON.stringify(evidence), context.runId, workspace()],
  );
}
export async function withResearchRun<T>(
  job: Doc,
  fn: () => Promise<T>,
): Promise<T | Doc> {
  if (!researchKinds.includes(job.kind)) return fn();
  const input = parse(job.input) || {};
  let runId = input.researchRunId as string | undefined;
  let prior: Doc | undefined;
  if (runId)
    [prior] = await rows(
      "SELECT * FROM research_runs WHERE id=? AND workspace_id=?",
      [runId, workspace()],
    );
  if (prior?.job_id && prior.job_id !== job.id) {
    if (input.retryOf !== prior.job_id)
      throw new AppError(409, "研究运行已绑定其他任务");
    const previousId = prior.id;
    runId = await createResearchRun(
      job.kind,
      { ...input, researchRunId: undefined, retryOfRunId: previousId },
      prior.automation_id,
      { maxRequests: prior.max_requests, dailyRequestLimit: prior.daily_limit },
    );
    [prior] = await rows(
      "SELECT * FROM research_runs WHERE id=? AND workspace_id=?",
      [runId, workspace()],
    );
  }
  if (!prior) {
    runId = await createResearchRun(job.kind, input);
    [prior] = await rows("SELECT * FROM research_runs WHERE id=?", [runId]);
  }
  await attachResearchJob(runId!, job.id);
  await execute(
    "UPDATE research_runs SET status='running',started_at=COALESCE(started_at,UTC_TIMESTAMP(3)) WHERE id=? AND workspace_id=?",
    [runId, workspace()],
  );
  return researchContext.run(
    {
      runId: runId!,
      automationId: prior!.automation_id,
      maxRequests: Number(prior!.max_requests),
      dailyLimit: Number(prior!.daily_limit),
    },
    async () => {
      try {
        const result = await fn();
        await execute(
          "UPDATE research_runs SET status='completed',result=?,finished_at=UTC_TIMESTAMP(3),error=NULL WHERE id=?",
          [JSON.stringify(result ?? null), runId],
        );
        await notifyOperation(
          "research:" + runId,
          "研究运行完成",
          "已保存证据与结果，可在自动化运行记录中查看。",
        );
        return result;
      } catch (e: any) {
        const budgetStopped =
          e.code === "RESEARCH_BUDGET_EXCEEDED" || e.code === "BUDGET_EXCEEDED";
        await execute(
          "UPDATE research_runs SET status=?,error=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",
          [
            budgetStopped ? "budget_stopped" : "failed",
            String(e.message).slice(0, 2000),
            runId,
          ],
        );
        await notifyOperation(
          "research:" + runId,
          budgetStopped ? "研究已达到预算" : "研究运行失败",
          String(e.message).slice(0, 1000),
        );
        if (budgetStopped)
          return {
            researchRunId: runId,
            partial: true,
            stopReason: e.message,
            note: "已保留本次已取得的证据；调整预算后可发起新运行。",
          };
        throw e;
      }
    },
  );
}
export async function withResearchBudgetRequest<T>(
  provider: string,
  endpoint: string,
  send: () => Promise<T>,
): Promise<T> {
  const settings = await operationSettings();
  const cfg = provider === "echotik" ? await config() : null;
  const monthlyLimit = Math.min(
    Number(settings.monthlyRequestLimit),
    cfg ? Number(cfg.ECHOTIK_MONTHLY_LIMIT) : Infinity,
  );
  const ctx = currentResearchRun();
  const now = new Date().toISOString();
  const monthlyKey = "month:" + now.slice(0, 7);
  const buckets: Array<[string, number]> = [[monthlyKey, monthlyLimit]];
  if (ctx)
    buckets.push([
      "day:" + (ctx.automationId || "manual") + ":" + now.slice(0, 10),
      ctx.dailyLimit,
    ]);
  const c = await pool.getConnection();
  let requestId: number | undefined;
  try {
    await c.beginTransaction();
    for (const [key, limit] of buckets) {
      await c.execute(
        "INSERT IGNORE INTO research_budget_buckets(workspace_id,bucket_key,used) VALUES(?,?,0)",
        [workspace(), key],
      );
      const [rs]: any = await c.execute(
        "SELECT used FROM research_budget_buckets WHERE workspace_id=? AND bucket_key=? FOR UPDATE",
        [workspace(), key],
      );
      if (Number(rs[0].used) >= limit)
        throw new AppError(
          429,
          key.startsWith("month:")
            ? "已达到工作空间本月研究请求预算"
            : "已达到此自动化今日请求预算",
          "RESEARCH_BUDGET_EXCEEDED",
        );
    }
    if (ctx) {
      const [rs]: any = await c.execute(
        "SELECT request_count,max_requests FROM research_runs WHERE id=? AND workspace_id=? FOR UPDATE",
        [ctx.runId, workspace()],
      );
      if (!rs[0] || Number(rs[0].request_count) >= Number(rs[0].max_requests))
        throw new AppError(
          429,
          "已达到本次研究请求预算",
          "RESEARCH_BUDGET_EXCEEDED",
        );
      await c.execute(
        "UPDATE research_runs SET request_count=request_count+1 WHERE id=?",
        [ctx.runId],
      );
    }
    for (const [key] of buckets)
      await c.execute(
        "UPDATE research_budget_buckets SET used=used+1 WHERE workspace_id=? AND bucket_key=?",
        [workspace(), key],
      );
    const [r]: any = await c.execute(
      "INSERT INTO research_requests(workspace_id,run_id,provider,endpoint) VALUES(?,?,?,?)",
      [workspace(), ctx?.runId || null, provider, endpoint.slice(0, 256)],
    );
    requestId = Number(r.insertId);
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
  try {
    const result = await send();
    await execute(
      "UPDATE research_requests SET status='succeeded' WHERE id=?",
      [requestId],
    );
    return result;
  } catch (e) {
    await execute("UPDATE research_requests SET status='failed' WHERE id=?", [
      requestId,
    ]);
    throw e;
  }
}
export async function researchBudgetSummary() {
  const settings = await operationSettings();
  const [bucket] = await rows(
    "SELECT used FROM research_budget_buckets WHERE workspace_id=? AND bucket_key=?",
    [workspace(), "month:" + new Date().toISOString().slice(0, 7)],
  );
  return {
    monthlyRequestLimit: settings.monthlyRequestLimit,
    used: Number(bucket?.used || 0),
    period: new Date().toISOString().slice(0, 7),
    timezone: "UTC",
    description:
      "实际外发请求计数，失败计入，缓存命中不计；不是供应商账单金额。",
  };
}
