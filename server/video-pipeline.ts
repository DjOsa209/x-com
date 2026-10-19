import { createHash } from "node:crypto";
import { rows, updateJob, parse, type Doc } from "./db.ts";
import { workspace } from "./context.ts";
import { config } from "./config.ts";
import { falClient, falInput } from "./providers.ts";
import { assetFile, fetchMedia, saveMedia } from "./media.ts";
import { buildRenderPlan, videoPolicy, type RenderPlan } from "./video-plan.ts";
import { composeVideo } from "./video-compose.ts";
import { AppError } from "./errors.ts";
const live = {
  falClient,
  falInput,
  fetchMedia,
  saveMedia,
  assetFile,
  composeVideo,
};
export type PipelineDependencies = typeof live;
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
export async function initializePipeline(
  id: string,
  input: Doc,
  storyboard: Doc,
) {
  const policy = input._videoPolicy || videoPolicy(await config(), input);
  const plan: RenderPlan =
    input._renderPlan || buildRenderPlan(input, storyboard, policy);
  const provider = {
    name: "video-pipeline",
    version: 1,
    stage: "generating",
    plan,
    concatStatus: "pending",
    segments: plan.segments.map((s) => ({ ...s, status: "queued" })),
  };
  await updateJob(id, {
    status: "processing",
    provider,
    result: {
      storyboard,
      shootingPrompt: storyboard.shootingPrompt,
      renderPlan: plan,
    },
  });
}
function rejected(e: any) {
  const code = Number(e.status || e.statusCode);
  return code >= 400 && code < 500 && ![408, 409, 429].includes(code);
}
export async function advancePipeline(
  row: Doc,
  deps: PipelineDependencies = live,
) {
  const p = clone(parse(row.provider)),
    input = parse(row.input),
    prior = parse(row.result) || {};
  const save = () => updateJob(row.id, { provider: p });
  if (p.cancelRequested) {
    for (const s of p.segments)
      if (["queued", "preparing", "ready_video"].includes(s.status))
        s.status = "cancelled";
    if (
      p.segments.every((s: Doc) =>
        ["completed", "failed", "cancelled"].includes(s.status),
      )
    ) {
      await updateJob(row.id, {
        status: "cancelled",
        provider: p,
        error: "已停止后续片段；已提交给供应商的请求可能产生费用",
      });
      return;
    }
  }
  const uncertain = p.segments.find((s: Doc) => s.status === "review");
  if (uncertain) {
    if (!uncertain.resumeStage || !uncertain.requestId)
      throw new AppError(
        409,
        "片段提交结果不明确且没有请求 ID，请先在供应商核对，系统不会重复提交",
        "PIPELINE_REVIEW",
      );
    uncertain.status = uncertain.resumeStage;
    delete uncertain.resumeStage;
    await updateJob(row.id, { status: "processing", error: null });
  }
  if (row.status === "review" && !uncertain)
    await updateJob(row.id, { status: "processing", error: null });
  if (p.segments.some((s: Doc) => s.status === "failed")) {
    await updateJob(row.id, {
      status: "failed",
      provider: p,
      error: "部分片段明确失败，重试将复用已成功片段",
    });
    return;
  }
  const segment = p.segments.find(
    (s: Doc) => !["completed", "failed", "cancelled"].includes(s.status),
  );
  if (segment) {
    const fal = await deps.falClient();
    let operation = "prepare";
    try {
      if (segment.status === "queued" || segment.status === "preparing") {
        segment.status = "preparing";
        await save();
        const built = await deps.falInput(
          "video",
          {
            ...input,
            prompt: segment.prompt,
            duration: segment.nativeDuration,
            aspect: p.plan.policy.aspect,
            resolution: p.plan.policy.resolution,
            generateAudio: p.plan.policy.generateAudio,
          },
          p.plan.policy.model,
          p.plan.policy.imageModel,
        );
        if (!built.frame) throw new AppError(400, "分镜模型缺少首帧适配");
        segment.model = built.model;
        segment.videoPayload = built.payload;
        segment.frameModel = built.frame.model;
        segment.status = "submitting_frame";
        segment.requestId = null;
        await save();
        const started = await fal.queue.submit(segment.frameModel, {
          input: built.frame.payload,
          headers: { "X-Fal-No-Retry": "1" },
        });
        segment.requestId = started.request_id;
        segment.status = "frame";
        await save();
        return;
      }
      if (["submitting_frame", "submitting_video"].includes(segment.status))
        throw new AppError(
          409,
          "服务曾在提交阶段中断，请先核对供应商请求，系统不会重新提交",
          "AMBIGUOUS_SUBMISSION",
        );
      if (segment.status === "ready_video") {
        if (p.cancelRequested) {
          segment.status = "cancelled";
          await save();
          return;
        }
        segment.status = "submitting_video";
        segment.requestId = null;
        await save();
        const payload = { ...segment.videoPayload };
        payload[
          p.plan.policy.model.adapter === "veo31"
            ? "image_url"
            : "start_image_url"
        ] = segment.frameUrl;
        const started = await fal.queue.submit(segment.model, {
          input: payload,
          headers: { "X-Fal-No-Retry": "1" },
        });
        segment.requestId = started.request_id;
        segment.status = "video";
        await save();
        return;
      }
      if (!segment.requestId)
        throw new AppError(
          409,
          "缺少供应商请求 ID，请核对",
          "AMBIGUOUS_SUBMISSION",
        );
      const model =
        segment.status === "frame" ? segment.frameModel : segment.model;
      operation = "poll";
      const status: any = await fal.queue.status(model, {
        requestId: segment.requestId,
      });
      if (status.status === "FAILED")
        throw new AppError(
          422,
          "供应商已确认此片段失败",
          "PROVIDER_TASK_FAILED",
        );
      if (status.status !== "COMPLETED") return;
      operation = "result";
      const result: any = await fal.queue.result(model, {
        requestId: segment.requestId,
      });
      if (segment.status === "frame") {
        const url = result.data.images?.[0]?.url;
        if (!url) throw new AppError(502, "首帧服务未返回图片");
        segment.frameUrl = url;
        segment.frameRequestId = segment.requestId;
        segment.requestId = null;
        segment.status = p.cancelRequested ? "cancelled" : "ready_video";
        await save();
        return;
      }
      const url = result.data.video?.url;
      if (!url) throw new AppError(502, "视频服务未返回片段");
      operation = "download";
      const media = await deps.fetchMedia(url);
      if (!media.mime.startsWith("video/"))
        throw new AppError(502, "供应商结果不是视频");
      segment.asset = await deps.saveMedia(
        media.bytes,
        media.mime,
        `${input.name || "分镜视频"} · 片段 ${segment.index + 1}`,
        {
          jobId: row.id,
          segmentIndex: segment.index,
          pipelineSegment: true,
          generated: true,
        },
      );
      segment.status = "completed";
      segment.error = null;
      await save();
      return;
    } catch (e: any) {
      const beforeSubmission = segment.status === "preparing";
      const definitive =
        beforeSubmission ||
        e.code === "PROVIDER_TASK_FAILED" ||
        (operation === "result" && Number(e.status || e.statusCode) === 422) ||
        (["submitting_frame", "submitting_video"].includes(segment.status) &&
          rejected(e));
      segment.error = String(e.message || "片段处理失败").slice(0, 1000);
      if (definitive) segment.status = "failed";
      else {
        if (["frame", "video"].includes(segment.status))
          segment.resumeStage = segment.status;
        segment.status = "review";
      }
      await updateJob(row.id, {
        status: definitive ? "failed" : "review",
        provider: p,
        error: segment.error,
      });
      return;
    }
  }
  if (p.cancelRequested) {
    await updateJob(row.id, { status: "cancelled", provider: p });
    return;
  }
  if (
    !p.segments.length ||
    !p.segments.every((s: Doc) => s.status === "completed")
  )
    throw new AppError(409, "片段尚未全部完成");
  p.stage = "concatenating";
  p.concatStatus = "processing";
  await updateJob(row.id, { status: "processing", provider: p, error: null });
  try {
    const signature = createHash("sha256")
      .update(
        JSON.stringify({
          plan: p.plan,
          assets: p.segments.map((s: Doc) => s.asset.id),
        }),
      )
      .digest("hex");
    const [existing] = await rows(
      "SELECT id FROM records WHERE workspace_id=? AND kind='asset' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.jobId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.compositionSignature'))=? LIMIT 1",
      [workspace(), row.id, signature],
    );
    let asset;
    if (existing) asset = (await deps.assetFile(existing.id)).asset;
    else {
      const files = await Promise.all(
        p.segments.map(async (s: Doc) => ({
          path: (await deps.assetFile(s.asset.id)).path,
          duration: s.duration,
        })),
      );
      const composed = await deps.composeVideo(
        files,
        p.plan.policy.aspect,
        p.plan.policy.resolution,
      );
      asset = await deps.saveMedia(
        composed.bytes,
        "video/mp4",
        input.name || "分镜拼接成片",
        {
          jobId: row.id,
          compositionSignature: signature,
          generated: true,
          duration: composed.duration,
          width: composed.width,
          height: composed.height,
          pipelineFinal: true,
        },
      );
    }
    p.stage = "completed";
    p.concatStatus = "completed";
    await updateJob(row.id, {
      status: "completed",
      provider: p,
      error: null,
      result: {
        ...prior,
        asset,
        renderPlan: p.plan,
        segments: p.segments.map((s: Doc) => ({
          index: s.index,
          asset: s.asset,
          start: s.start,
          end: s.end,
        })),
        concatStatus: "completed",
      },
    });
  } catch (e: any) {
    if (
      ["SEGMENT_INVALID", "SEGMENT_TOO_SHORT"].includes(e.code) &&
      Number.isInteger(e.details?.segmentIndex)
    ) {
      const invalid = p.segments[e.details.segmentIndex];
      if (invalid) {
        invalid.status = "failed";
        invalid.error = e.message;
      }
    }
    p.stage = "concat_failed";
    p.concatStatus = "failed";
    await updateJob(row.id, {
      status: "failed",
      provider: p,
      error: e.message || "拼接失败，可仅重试拼接",
    });
  }
}
export function retryPipelineState(provider: Doc) {
  const p = clone(provider);
  p.cancelRequested = false;
  p.stage = "generating";
  p.concatStatus = "pending";
  for (const s of p.segments) {
    if (s.status === "completed") continue;
    if (!["failed", "cancelled", "queued"].includes(s.status))
      throw new AppError(409, "仍有结果不明确的片段，请先核对供应商");
    s.status = s.frameUrl && s.videoPayload ? "ready_video" : "queued";
    s.error = null;
    s.requestId = null;
    delete s.resumeStage;
  }
  return p;
}
export async function cancelPipeline(row: Doc) {
  const p = clone(parse(row.provider)),
    fal = await falClient();
  p.cancelRequested = true;
  for (const s of p.segments) {
    if (["queued", "preparing", "ready_video"].includes(s.status))
      s.status = "cancelled";
    else if (["frame", "video"].includes(s.status) && s.requestId) {
      try {
        await fal.queue.cancel(s.status === "frame" ? s.frameModel : s.model, {
          requestId: s.requestId,
        });
      } catch {
        /* Poll the existing request; cancellation is not proof of non-execution. */
      }
    }
  }
  await updateJob(row.id, {
    provider: p,
    status: p.segments.every((s: Doc) =>
      ["completed", "failed", "cancelled"].includes(s.status),
    )
      ? "cancelled"
      : "processing",
    error: "已请求停止，供应商已开始的片段需要继续核对状态",
  });
}

// Only an audited platform-admin resolution may make an uncertain request retryable.
export function acknowledgePipelineFailure(provider: Doc, note: string) {
  const p = clone(provider);
  for (const s of p.segments)
    if (["review", "submitting_frame", "submitting_video"].includes(s.status)) {
      s.status = "failed";
      s.error = "人工核对：" + note;
      delete s.resumeStage;
    }
  return p;
}
