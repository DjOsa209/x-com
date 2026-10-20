import { retryQuote } from "./quotes.ts";
import { randomUUID, createHash } from "node:crypto";
import { workspace, inWorkspace } from "./context.ts";
import { reserveCredits, finalizeCredits } from "./credits.ts";
import {
  rows,
  execute,
  jobGet,
  updateJob,
  job,
  parse,
  put,
  type Doc,
} from "./db.ts";
import { config } from "./config.ts";
import { aiJson, falClient, falInput } from "./providers.ts";
import { fetchMedia, resolveVideo, saveMedia } from "./media.ts";
import { echoQuery, extractItems, normalizeItem } from "./echotik.ts";
import {
  creatorInfo,
  initializePost,
  transferPost,
  postStatus,
} from "./tiktok.ts";
import { withJobLock } from "./locks.ts";
import { AppError } from "./errors.ts";
import { videoPolicy, buildRenderPlan } from "./video-plan.ts";
import { mediaToolsReady } from "./video-compose.ts";
import {
  initializePipeline,
  advancePipeline,
  cancelPipeline,
  retryPipelineState,
} from "./video-pipeline.ts";

import { checkVideoEdit, runVideoEdit } from "./video-edit.ts";
import { runOperationsJob } from "./operations.ts";
import { withResearchRun, researchKinds } from "./research-budget.ts";
import { ingestCase, ingestOpportunity } from "./research-domain.ts";
import { replaceAssetReferences } from "./asset-references.ts";
import { validateAiResult } from "./ai-results.ts";

export const kinds = [
  "script",
  "analysis",
  "replicate",
  "video",
  "image",
  "enhance",
  "download",
  "insights",
  "prompt",
  "publish",
  "research",
  "raw",
  "collect",
  "opportunity_scan",
  "watch_sync",
  "case_collect",
  "metrics_sync",
  "video_edit",
] as const;
const falKinds = ["video", "image", "enhance", "raw"];
export async function checkProviders(kind: string, input: Doc) {
  if (kind === "video_edit") {
    await checkVideoEdit(input);
    return;
  }
  const c = await config();
  const need = ["publish", "metrics_sync"].includes(kind)
    ? "TIKTOK_CLIENT_KEY"
    : [
          "download",
          "research",
          "collect",
          "opportunity_scan",
          "watch_sync",
          "case_collect",
        ].includes(kind)
      ? "ECHOTIK_USERNAME"
      : ["video", "replicate"].includes(kind)
        ? (input._videoPolicy || videoPolicy(c, input)).model.provider === "kie"
          ? "KIE_API_KEY"
          : "FAL_KEY"
        : falKinds.includes(kind)
          ? "FAL_KEY"
          : "GEMINI_API_KEY";
  const directDownload =
    kind === "download" &&
    input.sourceUrl &&
    !/tiktok\.com/.test(input.sourceUrl) &&
    !/^\d+$/.test(input.sourceUrl);
  const localComposeOnly =
    ["video", "replicate"].includes(kind) && input._localComposeOnly === true;
  if (!c[need] && !directDownload && !localComposeOnly)
    throw new AppError(
      409,
      `请先在设置中配置 ${need.startsWith("TIKTOK") ? "TikTok 应用并授权账号" : need.startsWith("ECHOTIK") ? "EchoTik" : need.startsWith("KIE") ? "Kie.ai" : need.startsWith("FAL") ? "fal.ai" : "Gemini"}`,
      "PROVIDER_NOT_CONFIGURED",
    );
  if (
    ["video", "replicate"].includes(kind) &&
    !c.FAL_KEY &&
    !localComposeOnly &&
    (input._videoPolicy || videoPolicy(c, input)).frameSource !== "product"
  )
    throw new AppError(
      409,
      "AI 场景首帧需要配置 fal.ai，或在 Kie 渠道选择直接商品图首帧",
      "PROVIDER_NOT_CONFIGURED",
    );
  if (kind === "opportunity_scan" && !c.GEMINI_API_KEY)
    throw new AppError(
      409,
      "机会扫描还需要 Gemini 评论分析服务",
      "PROVIDER_NOT_CONFIGURED",
    );
  if (
    ["replicate", "video", "image", "script"].includes(kind) &&
    !input.prompt?.trim()
  )
    throw new AppError(400, "请填写创作要求");
  if (["video", "replicate"].includes(kind) && !input.assetIds?.length)
    throw new AppError(400, "请上传商品图片");
  if (kind === "replicate" && !input.sourceUrl && !input.videoAssetId)
    throw new AppError(400, "请提供参考视频");
  if (
    ["analysis", "download"].includes(kind) &&
    !input.sourceUrl &&
    !input.videoAssetId
  )
    throw new AppError(400, "请提供视频链接或上传文件");
  if (kind === "enhance" && !input.assetId && !input.sourceUrl)
    throw new AppError(400, "请选择视频");
  if (
    kind === "publish" &&
    (!input.accountId || !input.assetId || !input.consent)
  )
    throw new AppError(400, "请选择账号、视频并确认发布授权");
  if (["video", "replicate"].includes(kind)) {
    const duration = Number(input.duration || 10);
    if (!Number.isFinite(duration) || duration < 1 || duration > 120)
      throw new AppError(400, "视频时长需在 1–120 秒之间");
    if (!input.storyboard && !c.GEMINI_API_KEY && !localComposeOnly)
      throw new AppError(
        409,
        "请先配置 Gemini 以生成分镜，或使用已确认分镜",
        "PROVIDER_NOT_CONFIGURED",
      );
    if (!input._videoPolicy) videoPolicy(c, input);
    await mediaToolsReady();
  }
  if (input.aspect && !["9:16", "16:9", "1:1"].includes(input.aspect))
    throw new AppError(400, "请选择支持的画幅");
}
export async function createJob(
  kind: string,
  input: Doc,
  dedupe: string,
  runAt?: string,
  hold = false,
  trustedInput = false,
) {
  if (!kinds.includes(kind as any)) throw new AppError(400, "未知任务类型");
  if (dedupe.length > 128) throw new AppError(400, "无效请求标识");
  dedupe = createHash("sha256")
    .update(workspace() + "\0" + dedupe)
    .digest("hex");
  const [existing] = await rows("SELECT * FROM jobs WHERE dedupe_key=?", [
    dedupe,
  ]);
  if (existing) return job(existing);
  if (!trustedInput && Object.keys(input).some((k) => k.startsWith("_")))
    throw new AppError(400, "不能提交内部任务字段");
  input = structuredClone(input);
  await checkProviders(kind, input);
  if (["video", "replicate"].includes(kind)) {
    input._videoPolicy ||= videoPolicy(await config(), input);
    if (input.storyboard)
      input._renderPlan ||= buildRenderPlan(
        input,
        input.storyboard,
        input._videoPolicy,
      );
  }
  let at: Date | null = null;
  if (runAt) {
    at = new Date(runAt);
    if (
      !Number.isFinite(at.getTime()) ||
      at.getTime() < Date.now() + 1000 ||
      at.getTime() > Date.now() + 30 * 86400000
    )
      throw new AppError(400, "定时任务需在未来 30 天内");
  }
  const id = randomUUID();
  await reserveCredits(id, kind);
  try {
    await execute(
      "INSERT INTO jobs(id,kind,input,dedupe_key,run_at,status,workspace_id) VALUES(?,?,?,?,?,?,?)",
      [
        id,
        kind,
        JSON.stringify(input),
        dedupe,
        at,
        hold ? "held" : at ? "scheduled" : "queued",
        workspace(),
      ],
    );
  } catch (e: any) {
    await finalizeCredits(id, false);
    if (e.code === "ER_DUP_ENTRY")
      return job(
        (await rows("SELECT * FROM jobs WHERE dedupe_key=?", [dedupe]))[0],
      );
    throw e;
  }
  await replaceAssetReferences("job", id, input);
  return job((await jobGet(id))!);
}
async function videoAsset(input: Doc): Promise<string> {
  if (input.videoAssetId) return input.videoAssetId;
  const resolved = await resolveVideo(input.sourceUrl);
  const media = await fetchMedia(resolved.url);
  const asset = await saveMedia(media.bytes, media.mime, "参考视频", {
    sourceUrl: input.sourceUrl,
  });
  return asset!.id;
}
async function runLocal(id: string, kind: string, input: Doc) {
  if (kind === "video_edit") return runVideoEdit(input, id);
  if (["watch_sync", "case_collect", "metrics_sync"].includes(kind))
    return runOperationsJob(id, kind, input);
  if (kind === "collect" || kind === "opportunity_scan") {
    const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .slice(0, 10),
      region = input.region || "US";
    const path =
      input.path ||
      (kind === "opportunity_scan"
        ? "/echotik/product/ranklist"
        : "/echotik/video/ranklist");
    let params: Doc = {
      date: yesterday,
      region,
      rank_type: 1,
      page_num: 1,
      page_size: 10,
      ...(kind === "opportunity_scan"
        ? { product_rank_field: 1 }
        : { video_rank_field: 2, created_by_ai: "true" }),
      ...(input.params || {}),
    };
    const samples: Doc[] = [],
      evidence: Doc[] = [];
    const pages = Math.max(1, Math.min(Number(input.maxPages) || 1, 10));
    for (let page = 0; page < pages; page++) {
      const response = await echoQuery(path, params);
      evidence.push(response);
      const items = extractItems(response.data);
      samples.push(...items);
      if (!items.length) break;
      if (path.startsWith("/echotik/")) {
        if (items.length < Number(params.page_size || 10)) break;
        params = { ...params, page_num: Number(params.page_num || 1) + 1 };
      } else {
        const d = response.data?.body || response.data;
        const cursor = d?.next_cursor ?? d?.cursor ?? d?.max_cursor;
        if (
          !d?.has_more ||
          cursor === undefined ||
          String(cursor) === String(params.offset)
        )
          break;
        params = { ...params, offset: String(cursor) };
      }
    }
    if (kind === "collect") {
      const normalized = samples.map((r) =>
        normalizeItem(r, input.entity || "video"),
      );
      const observation = await put("observation", {
        name: input.name || "定时数据采集",
        items: normalized,
        evidence,
      });
      const children: string[] = [];
      if (input.extractPrompts === true) {
        for (const item of normalized
          .filter((i) => i.entity === "video" && i.id)
          .slice(0, Math.min(Number(input.maxVideos) || 2, 10))) {
          const child = await createJob(
            "prompt",
            {
              sourceUrl: item.sourceUrl || item.id,
              prompt: "从实际视频提取销售分镜和提示词",
              sourceMetrics: item.raw,
              region: item.region || region,
            },
            "collect:" + id + ":" + item.id,
          );
          children.push(child.id);
        }
      }
      return {
        observationId: observation!.id,
        count: normalized.length,
        promptJobs: children,
        evidence,
      };
    }
    const enriched: Doc[] = [];
    for (const raw of samples.slice(
      0,
      Math.min(Number(input.maxProducts) || 3, 10),
    )) {
      const product = normalizeItem(raw, "product");
      if (!product.id) continue;
      const detail = await echoQuery("/echotik/product/detail", {
        product_ids: product.id,
      });
      const comments = await echoQuery("/realtime/product/comment", {
        product_id: product.id,
        region,
        offset: "1",
      });
      enriched.push({ product, detail, comments });
    }
    const analysis = await aiJson(
      `根据提供的真实商品与评论样本，输出选品机会 JSON {title,summary,painPoints:[{problem,evidence,commentIds,frequencyInSample}],opportunities:[],risks:[],nextSteps:[],limitations:[]}。区分预估GMV、缺失数据与零值。不得编造成本、利润或需求规模。证据：${JSON.stringify(enriched).slice(0, 90000)}`,
    );
    validateAiResult("opportunity_scan", analysis);
    const savedOpportunity = await ingestOpportunity(
      { ...analysis, evidence: enriched },
      { jobId: id, region },
    );
    const opportunity = await put("opportunity", {
      ...analysis,
      evidence: enriched,
      region,
      source: "EchoTik + Gemini",
      collectedAt: new Date().toISOString(),
    });
    return {
      ...analysis,
      opportunityId: savedOpportunity.id,
      legacyOpportunityId: opportunity!.id,
      evidence: enriched,
    };
  }
  if (kind === "download") {
    const resolved = await resolveVideo(input.sourceUrl);
    const media = await fetchMedia(resolved.url);
    const asset = await saveMedia(media.bytes, media.mime, "下载的视频", {
      sourceUrl: input.sourceUrl,
    });
    return { asset, sourceUrl: input.sourceUrl };
  }
  if (kind === "research") {
    const detail = await echoQuery("/echotik/product/detail", {
      product_ids: input.productId,
    });
    const comments = await echoQuery("/realtime/product/comment", {
      product_id: input.productId,
      region: input.region || "US",
      offset: input.cursor || "1",
    });
    return {
      detail,
      comments,
      productId: input.productId,
      region: input.region,
      note: "GMV 为外部商业情报，评论为当前分页样本。未收录不能解释为零销量。",
    };
  }
  if (kind === "analysis" || kind === "replicate" || kind === "prompt") {
    const vid = await videoAsset(input);
    const result = await aiJson(
      `分析参考视频。任务=${kind}。用户自己的商品要求：${input.prompt || "提取销售结构"}。输出 {title,summary,hook,audience,script,scenes:[{time,visual,voiceover,shot}],sellingPoints:[],music,successHypotheses:[],limitations:[],shootingPrompt,sourceUrl}。${kind === "replicate" || input.mode === "replicate" ? `分镜时间必须从 0 开始、连续且不重叠，结束于目标 ${input.duration || 10} 秒，time 格式为 0-3s；按目标时长改编，口播使用 ${input.language || "English"}。` : "按原视频真实起止时间描述分镜，不将原视频压缩到默认创作时长。"}只对实际观察到的画面和声音作描述；音乐不确定时注明。${kind === "replicate" || input.mode === "replicate" ? "用自己的商品替换产品，不复制原作者身份或承诺原视频销量。" : ""}`,
      input.assetIds || [],
      vid,
    );
    validateAiResult(kind, result);
    if (kind === "prompt") {
      await ingestCase(result, {
        sourceUrl: input.sourceUrl,
        sourceVideoAssetId: vid,
        sourceMetrics: input.sourceMetrics,
        region: input.region,
        category: input.category,
        jobId: id,
      });
      await put("prompt", {
        title: result.title,
        prompt: result.shootingPrompt,
        analysis: result,
        sourceUrl: input.sourceUrl || null,
        sourceVideoAssetId: vid,
        sourceMetrics: input.sourceMetrics || null,
        region: input.region || "",
        category: input.category || "",
        provenance: "AI 从参考视频提取",
        verifiedGmv: false,
      });
    }
    return { ...result, videoAssetId: vid, sourceUrl: input.sourceUrl || null };
  }
  if (kind === "insights")
    return aiJson(
      `根据下列数据分析评论痛点和选品机会，输出 {title,summary,painPoints:[{problem,evidence,commentIds,frequencyInSample}],opportunities:[],risks:[],nextSteps:[],sampleSize}。只统计提供的样本，不把样本频率称为全市场需求。原始数据：${JSON.stringify(input.evidence || {}).slice(0, 90000)}`,
    );
  return aiJson(
    `为电商商品生成可拍摄的销售分镜和视频提示。商品要求：${input.prompt}；风格 ${input.style || "UGC"}；语言 ${input.language || "English"}；时长 ${input.duration || 10}秒；比例 ${input.aspect || "9:16"}。输出 {title,summary,hook,script,scenes:[{time,visual,voiceover,shot}],sellingPoints:[],shootingPrompt,limitations:[]}。分镜时间必须从 0 开始、连续且不重叠，结束于目标时长；time 格式为 0-3s。不要编造商品未提供的功效。`,
    input.assetIds || [],
  );
}
async function startJob(r: Doc) {
  let input = parse(r.input);
  await checkProviders(r.kind, input);
  if (["video", "replicate"].includes(r.kind)) {
    const storyboard =
      input.storyboard ||
      (await runLocal(
        r.id,
        r.kind === "replicate" ? "replicate" : "script",
        input,
      ));
    await initializePipeline(r.id, input, storyboard);
    return;
  }
  if (falKinds.includes(r.kind)) {
    const { model, payload, frame } = await falInput(r.kind, input);
    const fal = await falClient();
    // Persist submission intent before sending a potentially billable request.
    await updateJob(r.id, {
      provider: {
        name: "fal",
        model: frame?.model || model,
        stage: "submitting",
      },
    });
    const result = await fal.queue.submit((frame?.model || model) as any, {
      input: (frame?.payload || payload) as any,
      headers: { "X-Fal-No-Retry": "1" },
    });
    await updateJob(r.id, {
      status: "processing",
      provider: {
        name: "fal",
        model: frame?.model || model,
        requestId: result.request_id,
        stage: frame ? "frame" : "output",
        next: frame ? { model, payload } : undefined,
      },
    });
    return;
  }
  if (r.kind === "publish") {
    const data = await initializePost(input);
    await updateJob(r.id, {
      status: "processing",
      provider: {
        name: "tiktok",
        publishId: data.init.publish_id,
        accountId: input.accountId,
        uploaded: false,
      },
    });
    await transferPost(data);
    await updateJob(r.id, {
      provider: {
        name: "tiktok",
        publishId: data.init.publish_id,
        accountId: input.accountId,
        uploaded: true,
      },
    });
    return;
  }
  const result = await withResearchRun(r, () => runLocal(r.id, r.kind, input));
  if (["script", "insights"].includes(r.kind)) validateAiResult(r.kind, result);
  await updateJob(r.id, { status: "completed", result });
  await replaceAssetReferences("job", r.id, { input, result });
}
async function pollJob(r: Doc) {
  return withJobLock(r.id, async () => {
    const current = await jobGet(r.id);
    if (!current || !["processing", "review"].includes(current.status)) return;
    return pollJobUnlocked(current);
  });
}
async function pollJobUnlocked(r: Doc) {
  const p = parse(r.provider);
  if (p?.name === "video-pipeline") return advancePipeline(r);
  if (p?.name === "fal") {
    if (!p.requestId)
      throw new AppError(
        409,
        "供应商提交结果不明确且没有请求 ID，请在供应商后台核对；系统不会重新提交",
      );
    if (p.stage === "submitting_video")
      throw new AppError(
        409,
        "上一阶段视频提交结果不明确。请到 fal.ai 核对请求，系统不会重新提交。",
      );
    const fal = await falClient();
    const s = await fal.queue.status(p.model, { requestId: p.requestId });
    if (s.status !== "COMPLETED") return;
    const result = await fal.queue.result(p.model, { requestId: p.requestId });
    const data = result.data as Doc;
    const url = data.video?.url || data.images?.[0]?.url;
    if (!url) throw new AppError(502, "生成服务没有返回媒体文件");
    if (p.stage === "frame" && p.next) {
      await updateJob(r.id, {
        status: "running",
        provider: { ...p, stage: "submitting_video" },
      });
      const next = await fal.queue.submit(p.next.model, {
        input: { ...p.next.payload, start_image_url: url } as any,
        headers: { "X-Fal-No-Retry": "1" },
      });
      await updateJob(r.id, {
        status: "processing",
        provider: {
          name: "fal",
          model: p.next.model,
          requestId: next.request_id,
          stage: "output",
          frameRequestId: p.requestId,
        },
      });
      return;
    }
    const media = await fetchMedia(url);
    const asset = await saveMedia(
      media.bytes,
      media.mime,
      parse(r.input).name || (r.kind === "image" ? "电商图片" : "电商视频"),
      { jobId: r.id, generated: true },
    );
    await updateJob(r.id, {
      status: "completed",
      result: { ...parse(r.result), asset, provider: "fal.ai", model: p.model },
    });
  } else if (p?.name === "tiktok") {
    const data = await postStatus(p.accountId, p.publishId);
    if (data.status === "FAILED")
      throw new AppError(
        502,
        "TikTok 发布失败：" + (data.fail_reason || "未知原因"),
      );
    if (data.status === "PUBLISH_COMPLETE")
      await updateJob(r.id, { status: "completed", result: data });
    else if (data.status === "SEND_TO_USER_INBOX")
      await updateJob(r.id, {
        status: "inbox",
        result: {
          ...data,
          note: "已送达 TikTok 草稿箱，需要在 TikTok 中完成发布。",
        },
      });
  }
}
let busy = false;
export async function tick(onlyWorkspace?: string) {
  if (busy) return;
  busy = true;
  try {
    const processing = await rows(
      `SELECT * FROM jobs WHERE status='processing'${onlyWorkspace ? " AND workspace_id=?" : ""} ORDER BY updated_at LIMIT 6`,
      onlyWorkspace ? [onlyWorkspace] : [],
    );
    // Each poll holds a job lock and may also acquire a storage lock. Keep
    // room in the eight-connection pool for the worker lock and nested queries.
    for (let offset = 0; offset < processing.length; offset += 2) {
      await Promise.all(
        processing.slice(offset, offset + 2).map(async (r) => {
          await inWorkspace(r.workspace_id, async () => {
            try {
              await pollJob(r);
            } catch (e: any) {
              if (e.code === "JOB_BUSY") return;
              await updateJob(r.id, {
                status: "review",
                error: e.message || "查询任务失败，请核对供应商状态",
              });
            }
          });
        }),
      );
    }
    const [next] = await rows(
      `SELECT * FROM jobs WHERE status IN ('queued','scheduled') AND (run_at IS NULL OR run_at<=UTC_TIMESTAMP(3))${onlyWorkspace ? " AND workspace_id=?" : ""} ORDER BY created_at LIMIT 1`,
      onlyWorkspace ? [onlyWorkspace] : [],
    );
    if (next) {
      await inWorkspace(next.workspace_id, async () => {
        const claim = await execute(
          "UPDATE jobs SET status='running' WHERE id=? AND status IN ('queued','scheduled')",
          [next.id],
        );
        if (claim.affectedRows)
          try {
            await startJob(next);
          } catch (e: any) {
            const current = await jobGet(next.id);
            const hasProvider = !!current?.provider;
            await updateJob(next.id, {
              status:
                hasProvider || next.kind === "publish" ? "review" : "failed",
              error: e.message || "任务执行失败",
            });
          }
      });
    }
  } finally {
    busy = false;
  }
}
export async function recoverJobs() {
  await execute(
    "UPDATE jobs SET status='review',error='服务重启时任务正在执行。请先核对供应商状态，避免重复计费。' WHERE status='running'",
  );
}
export async function cancelJob(id: string) {
  return withJobLock(id, () => cancelJobUnlocked(id));
}
async function cancelJobUnlocked(id: string) {
  const r = await jobGet(id);
  if (!r) throw new AppError(404, "任务不存在");
  const p = parse(r.provider);
  if (
    p?.name === "video-pipeline" &&
    ["processing", "review"].includes(r.status)
  )
    return cancelPipeline(r);
  if (p?.name === "fal" && ["processing", "review"].includes(r.status)) {
    if (!p.requestId)
      throw new AppError(
        409,
        "没有供应商请求 ID，请先核对实际请求，不能保证取消",
      );
    const fal = await falClient();
    await fal.queue.cancel(p.model, { requestId: p.requestId });
    await updateJob(id, {
      status: "review",
      error: "已请求供应商取消；运行中的任务可能仍然完成，可再次查询。",
    });
    return;
  }
  if (!["queued", "scheduled"].includes(r.status))
    throw new AppError(409, "该任务已提交，不能保证取消；请查看供应商状态");
  const cancelled = await execute(
    "UPDATE jobs SET status='cancelled' WHERE id=? AND workspace_id=? AND status IN ('queued','scheduled')",
    [id, workspace()],
  );
  if (!cancelled.affectedRows)
    throw new AppError(409, "任务已开始执行，请刷新状态后核对");
  await finalizeCredits(id, false);
}
export async function refreshJob(id: string) {
  const r = await jobGet(id);
  if (!r) throw new AppError(404, "任务不存在");
  if (!r.provider) throw new AppError(409, "没有供应商任务标识，无法恢复查询");
  await pollJob(r);
  const current = await jobGet(id);
  if (["completed", "inbox"].includes(current?.status))
    await finalizeCredits(id, true);
}
export async function retryJob(
  id: string,
  dedupe: string = "retry:" + id,
  hold = false,
  quoteFingerprint?: string,
) {
  return withJobLock(id, () =>
    retryJobUnlocked(id, dedupe, hold, quoteFingerprint),
  );
}
async function retryJobUnlocked(
  id: string,
  dedupe: string,
  hold: boolean,
  quoteFingerprint?: string,
) {
  const r = await jobGet(id);
  if (!r) throw new AppError(404, "任务不存在");
  if (!["failed", "cancelled"].includes(r.status))
    throw new AppError(
      409,
      "只有明确失败或未提交已取消的任务可以重试；待核对任务需先核对供应商",
    );
  const quote = quoteFingerprint ? await retryQuote(r) : null;
  if (quote && quote.fingerprint !== quoteFingerprint)
    throw new AppError(409, "重试状态或报价已变化，请重新核对费用");
  const provider = parse(r.provider);
  const state =
    provider?.name === "video-pipeline" ? retryPipelineState(provider) : null;
  const created = await createJob(
    r.kind,
    {
      ...parse(r.input),
      retryOf: id,
      ...(quote ? { _retryQuoteSnapshot: quote } : {}),
      ...(state
        ? {
            storyboard: parse(r.result)?.storyboard,
            _videoPolicy: state.plan.policy,
            _renderPlan: state.plan,
            _localComposeOnly: state.segments.every(
              (s: Doc) => s.status === "completed",
            ),
          }
        : {}),
    },
    dedupe,
    undefined,
    true,
    true,
  );
  if (created.status !== "held") return created;
  if (state)
    await updateJob(created.id, {
      provider: state,
      result: parse(r.result),
      error: null,
    });
  if (!hold)
    await updateJob(created.id, { status: state ? "processing" : "queued" });
  return job((await jobGet(created.id))!);
}
