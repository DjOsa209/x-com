import { z } from "zod";
import { AppError } from "./errors.ts";
const scene = z
  .object({
    time: z.string().max(80).optional(),
    timestamp: z.string().max(80).optional(),
    start: z.number().finite().min(0).optional(),
    end: z.number().finite().positive().optional(),
    visual: z.string().min(1).max(12000),
    voiceover: z.string().max(12000).default(""),
    shot: z.string().max(4000).optional(),
  })
  .passthrough();
const creative = z
  .object({
    title: z.string().max(1000).optional(),
    summary: z.string().max(30000).optional(),
    script: z.string().max(100000).optional(),
    shootingPrompt: z.string().max(100000).optional(),
    scenes: z.array(scene).min(1).max(100),
    sellingPoints: z.array(z.string()).optional(),
    limitations: z.array(z.string()).optional(),
  })
  .passthrough();
const insights = z
  .object({
    title: z.string().max(1000).optional(),
    summary: z.string().max(30000),
    painPoints: z
      .array(
        z
          .object({
            problem: z.string().min(1),
            evidence: z.unknown(),
            commentIds: z.array(z.union([z.string(), z.number()])).optional(),
            frequencyInSample: z
              .union([z.number().nonnegative(), z.string()])
              .optional(),
          })
          .passthrough(),
      )
      .max(100),
    opportunities: z.array(z.unknown()).optional(),
    risks: z.array(z.unknown()).optional(),
  })
  .passthrough();
export function validateAiResult(kind: string, result: unknown) {
  const parsed = (
    kind === "insights" || kind === "opportunity_scan" ? insights : creative
  ).safeParse(result);
  if (!parsed.success)
    throw new AppError(
      502,
      "AI 返回的分镜或分析字段不完整，请调整输入后重试；该结果未记为成功",
      "AI_RESULT_INVALID",
    );
  return parsed.data;
}
