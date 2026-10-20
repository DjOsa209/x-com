import { AppError } from "./errors.ts";
import { Router } from "express";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { rows, execute, parse, type Doc } from "./db.ts";
import { workspace } from "./context.ts";
import { requireOwner, audit } from "./auth.ts";
import { config } from "./config.ts";
import { buildRenderPlan, videoPolicy, type RenderPlan } from "./video-plan.ts";

export const quoteRuleSchema = z.object({
  id: z.string().max(64).optional(),
  modelId: z.string().min(1).max(200),
  resolution: z.string().max(20).default("*"),
  unit: z.enum(["second", "request"]),
  amount: z.number().finite().nonnegative().max(100000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  source: z.string().min(1).max(1000),
  priceCheckedAt: z.iso.datetime(),
});
export type QuoteRule = z.infer<typeof quoteRuleSchema>;
export async function migrateQuotes() {
  await execute(
    `CREATE TABLE IF NOT EXISTS video_quote_rules(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,model_id VARCHAR(200) NOT NULL,resolution VARCHAR(20) NOT NULL,body JSON NOT NULL,updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),UNIQUE quote_model(workspace_id,model_id,resolution))`,
  );
}
export async function quoteRules(): Promise<QuoteRule[]> {
  return (
    await rows(
      "SELECT body FROM video_quote_rules WHERE workspace_id=? ORDER BY model_id,resolution",
      [workspace()],
    )
  ).map((r) => parse(r.body));
}
export function calculateQuote(
  plan: RenderPlan,
  rules: QuoteRule[],
  count = 1,
) {
  const components: Doc[] = [];
  const add = (
    modelId: string,
    resolution: string,
    seconds: number,
    requests: number,
    label: string,
  ) => {
    const rule =
      rules.find((r) => r.modelId === modelId && r.resolution === resolution) ||
      rules.find((r) => r.modelId === modelId && r.resolution === "*");
    components.push({
      modelId,
      resolution,
      label,
      seconds,
      requests,
      amount:
        rule?.amount == null
          ? null
          : Math.round(
              rule.amount *
                (rule.unit === "second" ? seconds : requests) *
                1000000,
            ) / 1000000,
      currency: rule?.currency || null,
      unit: rule?.unit || null,
      unitPrice: rule?.amount ?? null,
      source: rule?.source || null,
      priceCheckedAt: rule?.priceCheckedAt || null,
    });
  };
  add(
    plan.policy.model.id,
    plan.policy.resolution,
    plan.segments.reduce((n, s) => n + s.nativeDuration, 0) * count,
    plan.segments.length * count,
    "视频生成",
  );
  if (plan.policy.frameSource !== "product")
    add(
      plan.policy.imageModel,
      "*",
      0,
      plan.segments.length * count,
      "AI 首帧",
    );
  const known = components.every((c) => c.amount !== null);
  const currencies = [
    ...new Set(components.map((c) => c.currency).filter(Boolean)),
  ];
  return {
    version: 1,
    count,
    components,
    amount:
      known && currencies.length === 1
        ? Math.round(components.reduce((n, c) => n + c.amount, 0) * 1000000) /
          1000000
        : null,
    currency: currencies.length === 1 ? currencies[0] : null,
    status: known
      ? currencies.length === 1
        ? "estimated"
        : "multiple_currencies"
      : "unknown",
    createdAt: new Date().toISOString(),
    notice:
      "仅估算已列出的生成请求；不含脚本分析、税费、重试、存储和后期服务。内部额度单独计量。",
  };
}
export async function quoteForPlan(plan: RenderPlan, count = 1) {
  const quote = calculateQuote(plan, await quoteRules(), count);
  return {
    ...quote,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ ...quote, createdAt: undefined }))
      .digest("hex"),
  };
}
export const quoteRoutes = Router();
quoteRoutes.get("/quotes/rules", async (_req, res) =>
  res.json(await quoteRules()),
);
quoteRoutes.put("/quotes/rules", async (req, res) => {
  requireOwner();
  const rule = quoteRuleSchema.parse(req.body);
  const [existing] = await rows(
    "SELECT id FROM video_quote_rules WHERE workspace_id=? AND model_id=? AND resolution=?",
    [workspace(), rule.modelId, rule.resolution],
  );
  const id = existing?.id || randomUUID();
  await execute(
    "INSERT INTO video_quote_rules(id,workspace_id,model_id,resolution,body) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE body=VALUES(body),updated_at=CURRENT_TIMESTAMP(3)",
    [
      id,
      workspace(),
      rule.modelId,
      rule.resolution,
      JSON.stringify({ ...rule, id }),
    ],
  );
  await audit("quote.rule.saved", {
    modelId: rule.modelId,
    resolution: rule.resolution,
  });
  res.json(await quoteRules());
});
quoteRoutes.post("/quotes/preview", async (req, res) => {
  const b = z
    .object({
      input: z.record(z.string(), z.any()),
      storyboard: z.record(z.string(), z.any()),
      count: z.number().int().min(1).max(4).default(1),
    })
    .parse(req.body);
  const plan = buildRenderPlan(
    b.input,
    b.storyboard,
    videoPolicy(await config(), b.input),
  );
  res.json(await quoteForPlan(plan, b.count));
});

/** Additional requests only: successful segments and reusable frames are excluded. */
export async function retryQuote(row: Doc) {
  const input = parse(row.input) || {},
    provider = parse(row.provider);
  const pending =
    provider?.name === "video-pipeline"
      ? provider.segments.filter((s: Doc) => s.status !== "completed")
      : null;
  if (
    pending?.some(
      (s: Doc) => !["failed", "cancelled", "queued"].includes(s.status),
    )
  )
    throw new AppError(409, "仍有结果不明确的片段，请先核对供应商");
  let components: Doc[] = [];
  if (pending?.length) {
    const q = calculateQuote(
      { ...provider.plan, segments: pending },
      await quoteRules(),
    );
    components = q.components;
    const frames = components.find((c) => c.label === "AI 首帧");
    if (frames) {
      frames.requests = pending.filter(
        (s: Doc) => !s.frameUrl || !s.videoPayload,
      ).length;
      frames.amount =
        frames.requests === 0
          ? 0
          : frames.unitPrice == null
            ? null
            : Math.round(frames.unitPrice * frames.requests * 1e6) / 1e6;
    }
  }
  const localOnly = pending?.length === 0 || row.kind === "video_edit";
  const currencies = [
    ...new Set(
      components
        .filter((c) => c.amount !== 0)
        .map((c) => c.currency)
        .filter(Boolean),
    ),
  ];
  const known =
    localOnly ||
    (components.length > 0 && components.every((c) => c.amount != null));
  const quote: Doc = {
    jobId: row.id,
    kind: row.kind,
    pendingSegments: pending?.length ?? null,
    reusedSegments: pending ? provider.segments.length - pending.length : 0,
    pendingFrames: components.find((c) => c.label === "AI 首帧")?.requests ?? 0,
    components,
    amount: localOnly
      ? 0
      : known && currencies.length <= 1
        ? components.reduce((n, c) => n + c.amount, 0)
        : null,
    currency: currencies[0] || null,
    status: localOnly ? "local_only" : known ? "estimated" : "unknown",
    createdAt: new Date().toISOString(),
    notice: localOnly
      ? "仅本地后期，不重新请求视频模型。"
      : "仅本次重试的新增生成估算。已成功片段复用；实际费用以供应商账单为准。",
  };
  quote.fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        id: row.id,
        status: row.status,
        provider,
        input,
        quote: { ...quote, createdAt: undefined },
      }),
    )
    .digest("hex");
  return quote;
}
export function retryGroupQuote(jobs: Doc[], version: number) {
  return {
    jobs,
    version,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({ version, quotes: jobs.map((q) => q.fingerprint) }),
      )
      .digest("hex"),
    notice:
      "仅重试失败项，成功结果保留。分析未完成的项目返回草稿后再准备分镜。",
  };
}
