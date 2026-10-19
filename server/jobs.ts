import { randomUUID } from "node:crypto";
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
import { echoQuery, extractItems } from "./echotik.ts";
import {
  creatorInfo,
  initializePost,
  transferPost,
  postStatus,
} from "./tiktok.ts";
import { AppError } from "./errors.ts";

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
] as const;
const falKinds = ["video", "image", "enhance"];
export async function checkProviders(kind: string, input: Doc) {
  const c = await config();
  const need =
    kind === "publish"
      ? "TIKTOK_CLIENT_KEY"
      : kind === "download" || kind === "research"
        ? "ECHOTIK_USERNAME"
        : falKinds.includes(kind)
          ? "FAL_KEY"
          : "GEMINI_API_KEY";
  const directDownload =
    kind === "download" &&
    input.sourceUrl &&
    !/tiktok\.com/.test(input.sourceUrl) &&
    !/^\d+$/.test(input.sourceUrl);
  if (!c[need] && !directDownload)
    throw new AppError(
      409,
      `请先在设置中配置 ${need.startsWith("TIKTOK") ? "TikTok 应用并授权账号" : need.startsWith("ECHOTIK") ? "EchoTik" : need.startsWith("FAL") ? "fal.ai" : "Gemini"}`,
      "PROVIDER_NOT_CONFIGURED",
    );
  if (kind === "replicate" && !c.FAL_KEY)
    throw new AppError(
      409,
      "一键复刻还需要配置 fal.ai 视频生成服务",
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
  if (
    ["video", "replicate"].includes(kind) &&
    ![5, 10, 15].includes(Number(input.duration || 10))
  )
    throw new AppError(400, "视频时长需为 5、10 或 15 秒");
  if (input.aspect && !["9:16", "16:9", "1:1"].includes(input.aspect))
    throw new AppError(400, "请选择支持的画幅");
}
export async function createJob(
  kind: string,
  input: Doc,
  dedupe: string,
  runAt?: string,
) {
  if (!kinds.includes(kind as any)) throw new AppError(400, "未知任务类型");
  if (dedupe.length > 128) throw new AppError(400, "无效请求标识");
  const [existing] = await rows("SELECT * FROM jobs WHERE dedupe_key=?", [
    dedupe,
  ]);
  if (existing) return job(existing);
  await checkProviders(kind, input);
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
  try {
    await execute(
      "INSERT INTO jobs(id,kind,input,dedupe_key,run_at,status) VALUES(?,?,?,?,?,?)",
      [
        id,
        kind,
        JSON.stringify(input),
        dedupe,
        at,
        at ? "scheduled" : "queued",
      ],
    );
  } catch (e: any) {
    if (e.code === "ER_DUP_ENTRY")
      return job(
        (await rows("SELECT * FROM jobs WHERE dedupe_key=?", [dedupe]))[0],
      );
    throw e;
  }
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
      `分析参考视频。任务=${kind}。用户自己的商品要求：${input.prompt || "提取销售结构"}。输出 {title,summary,hook,audience,script,scenes:[{time,visual,voiceover,shot}],sellingPoints:[],music,successHypotheses:[],limitations:[],shootingPrompt,sourceUrl}。只对实际观察到的画面和声音作描述；音乐不确定时注明。${kind === "replicate" ? "用自己的商品替换产品，不复制原作者身份或承诺原视频销量。" : ""}`,
      input.assetIds || [],
      vid,
    );
    if (kind === "prompt")
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
    return { ...result, videoAssetId: vid, sourceUrl: input.sourceUrl || null };
  }
  if (kind === "insights")
    return aiJson(
      `根据下列数据分析评论痛点和选品机会，输出 {title,summary,painPoints:[{problem,evidence,commentIds,frequencyInSample}],opportunities:[],risks:[],nextSteps:[],sampleSize}。只统计提供的样本，不把样本频率称为全市场需求。原始数据：${JSON.stringify(input.evidence || {}).slice(0, 90000)}`,
    );
  return aiJson(
    `为电商商品生成可拍摄的销售分镜和视频提示。商品要求：${input.prompt}；风格 ${input.style || "UGC"}；语言 ${input.language || "English"}；时长 ${input.duration || 10}秒；比例 ${input.aspect || "9:16"}。输出 {title,summary,hook,script,scenes:[{time,visual,voiceover,shot}],sellingPoints:[],shootingPrompt,limitations:[]}。不要编造商品未提供的功效。`,
    input.assetIds || [],
  );
}
async function startJob(r: Doc) {
  let input = parse(r.input);
  await checkProviders(r.kind, input);
  if (r.kind === "replicate") {
    const analysis = await runLocal(r.id, "replicate", input);
    await updateJob(r.id, { result: analysis });
    input = {
      ...input,
      prompt: analysis.shootingPrompt || analysis.script || input.prompt,
    };
  }
  if (falKinds.includes(r.kind) || r.kind === "replicate") {
    const { model, payload, frame } = await falInput(r.kind, input);
    const fal = await falClient();
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
  const result = await runLocal(r.id, r.kind, input);
  await updateJob(r.id, { status: "completed", result });
}
async function pollJob(r: Doc) {
  const p = parse(r.provider);
  if (p?.name === "fal") {
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
export async function tick() {
  if (busy) return;
  busy = true;
  try {
    const processing = await rows(
      "SELECT * FROM jobs WHERE status='processing' ORDER BY updated_at LIMIT 6",
    );
    for (const r of processing) {
      try {
        await pollJob(r);
      } catch (e: any) {
        await updateJob(r.id, {
          status: "review",
          error: e.message || "查询任务失败，请核对供应商状态",
        });
      }
    }
    const [next] = await rows(
      "SELECT * FROM jobs WHERE status IN ('queued','scheduled') AND (run_at IS NULL OR run_at<=UTC_TIMESTAMP(3)) ORDER BY created_at LIMIT 1",
    );
    if (next) {
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
              hasProvider ||
              falKinds.includes(next.kind) ||
              ["publish", "replicate"].includes(next.kind)
                ? "review"
                : "failed",
            error: e.message || "任务执行失败",
          });
        }
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
  const r = await jobGet(id);
  if (!r) throw new AppError(404, "任务不存在");
  const p = parse(r.provider);
  if (p?.name === "fal" && ["processing", "review"].includes(r.status)) {
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
  await updateJob(id, { status: "cancelled" });
}
export async function refreshJob(id: string) {
  const r = await jobGet(id);
  if (!r) throw new AppError(404, "任务不存在");
  if (!r.provider) throw new AppError(409, "没有供应商任务标识，无法恢复查询");
  await pollJob(r);
}
