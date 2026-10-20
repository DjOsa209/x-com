import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.ts";
import type { Doc } from "./db.ts";
export const strategies = ["balanced", "shots", "fixed", "single"] as const;
export const modelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,50}$/),
  name: z.string().min(1).max(100),
  provider: z.enum(["fal", "kie"]).default("fal"),
  endpoint: z.string().min(1).max(150),
  adapter: z.enum(["kling-v3", "veo31", "kie-veo-fast", "kie-seedance-mini"]),
  durations: z.array(z.number().int().min(1).max(30)).min(1).max(30),
  aspects: z.array(z.enum(["9:16", "16:9", "1:1"])).min(1),
  resolutions: z
    .array(z.enum(["480p", "720p", "1080p", "4k"]))
    .min(1)
    .default(["720p"]),
  characters: z.boolean().default(false),
});
export type VideoModel = z.infer<typeof modelSchema>;
const legacyVideoModels = [
  {
    id: "kling-standard",
    name: "Kling v3 Standard",
    endpoint: "fal-ai/kling-video/v3/standard/image-to-video",
    adapter: "kling-v3",
    durations: Array.from({ length: 13 }, (_, i) => i + 3),
    aspects: ["9:16", "16:9", "1:1"],
    resolutions: ["720p"],
    characters: true,
  },
  {
    id: "kling-pro",
    name: "Kling v3 Pro",
    endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    adapter: "kling-v3",
    durations: Array.from({ length: 13 }, (_, i) => i + 3),
    aspects: ["9:16", "16:9", "1:1"],
    resolutions: ["1080p"],
    characters: true,
  },
];
export const kieVideoModels: VideoModel[] = [
  {
    id: "kie-veo-fast",
    name: "Veo 3.1 Fast",
    provider: "kie",
    endpoint: "veo-3-1",
    adapter: "kie-veo-fast",
    durations: [4, 6, 8],
    aspects: ["9:16", "16:9"],
    resolutions: ["720p", "1080p"],
    characters: false,
  },
  {
    id: "kie-seedance-mini",
    name: "Seedance 2 Mini",
    provider: "kie",
    endpoint: "bytedance/seedance-2-mini",
    adapter: "kie-seedance-mini",
    durations: Array.from({ length: 12 }, (_, i) => i + 4),
    aspects: ["9:16", "16:9", "1:1"],
    resolutions: ["480p", "720p"],
    characters: false,
  },
];
export const defaultVideoModels: VideoModel[] = [
  ...legacyVideoModels.map((m) => modelSchema.parse(m)),
  ...kieVideoModels,
];
export function parseModels(
  raw: string,
  legacyEndpoint?: string,
): VideoModel[] {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError(400, "视频模型目录必须为合法 JSON");
  }
  // Upgrade untouched pre-Kie catalogs; customized catalogs remain authoritative.
  if (raw === JSON.stringify(legacyVideoModels))
    value = [...value, ...kieVideoModels];
  const models = z.array(modelSchema).min(1).max(20).parse(value);
  if (new Set(models.map((m) => m.id)).size !== models.length)
    throw new AppError(400, "视频模型 ID 不能重复");
  for (const m of models) {
    if (
      m.provider === "fal"
        ? !/^fal-ai\/[a-zA-Z0-9_/-]+$/.test(m.endpoint) ||
          !["kling-v3", "veo31"].includes(m.adapter)
        : !kieVideoModels.some(
            (k) => k.endpoint === m.endpoint && k.adapter === m.adapter,
          )
    )
      throw new AppError(400, `${m.name} 的渠道、端点与适配器不兼容`);
    const allowed =
      m.adapter === "kling-v3"
        ? Array.from({ length: 13 }, (_, i) => i + 3)
        : m.adapter === "kie-seedance-mini"
          ? Array.from({ length: 12 }, (_, i) => i + 4)
          : [4, 6, 8];
    if (m.durations.some((d) => !allowed.includes(d)))
      throw new AppError(400, `${m.name} 的时长与适配器不兼容`);
    m.durations = [...new Set(m.durations)].sort((a, b) => a - b);
    if (m.provider === "kie") {
      const supported = kieVideoModels.find((k) => k.adapter === m.adapter)!;
      if (
        m.resolutions.some((r) => !supported.resolutions.includes(r)) ||
        m.aspects.some((a) => !supported.aspects.includes(a)) ||
        m.characters
      )
        throw new AppError(400, `${m.name} 的分辨率、画幅或角色能力不兼容`);
    }
  }
  // Retain the existing configurable standard endpoint for default installations.
  if (
    legacyEndpoint &&
    [
      JSON.stringify(defaultVideoModels),
      JSON.stringify(legacyVideoModels),
    ].includes(raw)
  )
    models[0].endpoint = legacyEndpoint;
  return models;
}
export type VideoPolicy = {
  model: VideoModel;
  strategy: (typeof strategies)[number];
  segmentSeconds: number;
  maxSegments: number;
  imageModel: string;
  aspect: string;
  resolution: string;
  generateAudio: boolean;
  frameSource?: "generated" | "product";
};
export function videoPolicy(cfg: Doc, input: Doc = {}): VideoPolicy {
  const models = parseModels(
    cfg.VIDEO_MODELS_JSON || JSON.stringify(defaultVideoModels),
    cfg.FAL_VIDEO_MODEL,
  );
  const model = models.find(
    (m) =>
      m.id ===
      (input.videoModelId || cfg.VIDEO_DEFAULT_MODEL || "kling-standard"),
  );
  if (!model) throw new AppError(400, "请选择已配置的视频模型");
  const strategy = z
    .enum(strategies)
    .parse(input.segmentStrategy || cfg.VIDEO_SEGMENT_STRATEGY || "balanced");
  const segmentSeconds = z.coerce
    .number()
    .int()
    .min(1)
    .max(30)
    .parse(input.segmentSeconds ?? cfg.VIDEO_SEGMENT_SECONDS ?? 8);
  const aspect = input.aspect || "9:16",
    resolution = input.resolution || model.resolutions[0];
  if (!model.aspects.includes(aspect))
    throw new AppError(400, `${model.name} 不支持此画幅`);
  if (!model.resolutions.includes(resolution))
    throw new AppError(400, `${model.name} 不支持此分辨率`);
  if (input.characterId && !model.characters)
    throw new AppError(400, "所选模型尚未适配独立角色元素，请更换模型");
  const frameSource = z
    .enum(["generated", "product"])
    .parse(
      input.frameSource || (model.provider === "kie" ? "product" : "generated"),
    );
  if (model.provider !== "kie" && frameSource === "product")
    throw new AppError(400, "直接商品图首帧目前仅支持 Kie 渠道");
  if (model.adapter === "kie-veo-fast" && input.generateAudio === false)
    throw new AppError(400, "Kie Veo Fast 默认生成音频，尚不支持关闭音频");
  return {
    model,
    strategy,
    segmentSeconds,
    maxSegments: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .parse(cfg.VIDEO_MAX_SEGMENTS || 12),
    imageModel: cfg.FAL_IMAGE_EDIT_MODEL,
    aspect,
    resolution,
    generateAudio: input.generateAudio !== false,
    frameSource,
  };
}
export type Shot = {
  id: string;
  start: number;
  end: number;
  visual: string;
  voiceover: string;
  shot?: string;
};
export type Segment = {
  index: number;
  start: number;
  end: number;
  duration: number;
  nativeDuration: number;
  shots: Shot[];
  prompt: string;
};
export type RenderPlan = {
  version: 1;
  policy: VideoPolicy;
  duration: number;
  shots: Shot[];
  segments: Segment[];
  warnings: string[];
  providerCalls: number;
};
const round = (n: number) => Math.round(n * 1000) / 1000;
function seconds(s: string) {
  const a = s.trim().replace(/秒|s$/gi, "").split(":").map(Number);
  return a.length && a.every(Number.isFinite)
    ? a.reduce((x, n) => x * 60 + n, 0)
    : NaN;
}
function timing(row: Doc): [number, number] | null {
  if (row.start !== undefined || row.end !== undefined)
    return [Number(row.start), Number(row.end)];
  const text = String(row.timestamp || row.time || "").replace(
    /[–—~～至]/g,
    "-",
  );
  if (!text) return null;
  const a = text.split(/\s*-\s*/);
  return a.length === 2 ? [seconds(a[0]), seconds(a[1])] : [NaN, NaN];
}
export function normalizeShots(
  storyboard: Doc,
  duration: number,
): { shots: Shot[]; warnings: string[] } {
  const warnings: string[] = [];
  let source = storyboard.scenes ?? storyboard.shots;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      throw new AppError(400, "分镜 shots JSON 无效");
    }
  }
  if (!Array.isArray(source) || !source.length) {
    const visual = storyboard.shootingPrompt || storyboard.script;
    if (typeof visual !== "string" || !visual.trim())
      throw new AppError(400, "请先生成或填写分镜");
    source = [{ start: 0, end: duration, visual }];
    warnings.push("脚本未提供逐镜时间轴，按一个完整镜头规划。");
  }
  if (source.length > 100) throw new AppError(400, "每份脚本最多 100 个镜头");
  const times = source.map(timing),
    untimed = times.every((t: [number, number] | null) => t === null);
  if (!untimed && times.some((t: [number, number] | null) => t === null))
    throw new AppError(400, "请为每个镜头填写起止时间，或全部留空以等分时长");
  if (untimed)
    warnings.push("分镜未提供时间，已按镜头数量等分总时长，请确认。");
  const shots: Shot[] = source.map((r: Doc, i: number) => {
    const [start, end] = times[i] || [
      round((i * duration) / source.length),
      round(((i + 1) * duration) / source.length),
    ];
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > duration + 0.02
    )
      throw new AppError(400, `镜头 ${i + 1} 起止时间无效或超出总时长`);
    const visual = String(r.visual || r.description || "").trim();
    if (!visual) throw new AppError(400, `镜头 ${i + 1} 缺少画面描述`);
    return {
      id: String(r.id || i + 1),
      start: round(start),
      end: round(end),
      visual,
      voiceover: String(r.voiceover || r.narration || ""),
      shot: String(r.shot || ""),
    };
  });
  let cursor = 0;
  for (const s of shots) {
    if (Math.abs(s.start - cursor) > 0.02)
      throw new AppError(400, "分镜时间轴需要从 0 开始，连续且不重叠");
    cursor = s.end;
  }
  if (Math.abs(cursor - duration) > 0.02)
    throw new AppError(
      400,
      `分镜总时长 ${cursor} 秒与目标 ${duration} 秒不一致，请编辑后确认`,
    );
  return { shots, warnings };
}
export function buildRenderPlan(
  input: Doc,
  storyboard: Doc,
  policy: VideoPolicy,
): RenderPlan {
  const duration = z.coerce
    .number()
    .min(1)
    .max(120)
    .parse(input.duration || 10);
  const { shots, warnings } = normalizeShots(storyboard, duration);
  const max = Math.max(...policy.model.durations),
    limit = Math.min(max, policy.segmentSeconds);
  const ranges: [number, number][] = [];
  const split = (start: number, end: number, step: number) => {
    for (let t = start; t < end - 0.001; t = round(Math.min(end, t + step)))
      ranges.push([t, round(Math.min(end, t + step))]);
  };
  if (policy.strategy === "single") {
    if (duration > max)
      throw new AppError(
        400,
        `单段策略超过 ${policy.model.name} 的 ${max} 秒上限`,
      );
    ranges.push([0, duration]);
  } else if (policy.strategy === "fixed") split(0, duration, limit);
  else if (policy.strategy === "shots")
    for (const shot of shots) split(shot.start, shot.end, limit);
  else {
    let start = 0,
      end = 0;
    for (const shot of shots) {
      if (shot.end - shot.start > limit) {
        if (end > start) ranges.push([start, end]);
        split(shot.start, shot.end, limit);
        start = end = shot.end;
      } else if (shot.end - start > limit + 0.001) {
        if (end > start) ranges.push([start, end]);
        start = shot.start;
        end = shot.end;
      } else end = shot.end;
    }
    if (end > start) ranges.push([start, end]);
  }
  if (ranges.length > policy.maxSegments)
    throw new AppError(
      400,
      `计划需要 ${ranges.length} 段，超过上限 ${policy.maxSegments}，请加长分段或合并镜头`,
    );
  const segments = ranges.map(([start, end], index) => {
    const actual = round(end - start),
      nativeDuration = policy.model.durations.find((d) => d + 0.001 >= actual);
    if (!nativeDuration) throw new AppError(400, "模型原生时长不足以容纳片段");
    const selected = shots.filter(
      (s) => s.end > start + 0.001 && s.start < end - 0.001,
    );
    if (selected.some((s) => s.start < start - 0.001 || s.end > end + 0.001))
      warnings.push(`片段 ${index + 1} 跨越长镜头，口播需人工检查接续。`);
    if (nativeDuration > actual + 0.01)
      warnings.push(
        `片段 ${index + 1} 原生生成 ${nativeDuration} 秒，成片保留前 ${actual} 秒。`,
      );
    const prompt = [
      `Create segment ${index + 1}/${ranges.length} of the same ecommerce video. Preserve product, presenter, wardrobe, environment and lighting across all segments.`,
      `Language: ${input.language || "English"}. Style: ${input.style || "UGC"}. Global brief: ${input.prompt || storyboard.shootingPrompt || ""}`,
      `This segment covers global ${start}-${end}s. Deliver these shots in order within the first ${actual}s; any remaining model duration must only hold the last shot. Do not repeat dialogue from other intervals.`,
      ...selected.map(
        (s) =>
          `Local ${round(Math.max(s.start, start) - start)}-${round(Math.min(s.end, end) - start)}s: ${s.visual}. Camera: ${s.shot || "natural"}. Dialogue for this interval: ${s.voiceover || "none"}.`,
      ),
    ].join("\n");
    return {
      index,
      start,
      end,
      duration: actual,
      nativeDuration,
      shots: selected,
      prompt,
    };
  });
  return {
    version: 1,
    policy,
    duration,
    shots,
    segments,
    warnings: [...new Set(warnings)],
    providerCalls: segments.length * (policy.frameSource === "product" ? 1 : 2),
  };
}

export function pipelineView(provider: Doc) {
  if (provider?.name !== "video-pipeline") return undefined;
  return {
    stage: provider.stage,
    strategy: provider.plan.policy.strategy,
    model: provider.plan.policy.model.name,
    duration: provider.plan.duration,
    concatStatus: provider.concatStatus,
    cancelRequested: !!provider.cancelRequested,
    warnings: provider.plan.warnings,
    segments: provider.segments.map((s: Doc) => ({
      index: s.index,
      start: s.start,
      end: s.end,
      duration: s.duration,
      nativeDuration: s.nativeDuration,
      status: s.status,
      asset: s.asset,
      error: s.error,
      prompt: s.prompt,
      replaced: !!s.replaced,
    })),
  };
}

export const planFingerprint = (plan: RenderPlan) =>
  createHash("sha256").update(JSON.stringify(plan)).digest("hex");
