import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { readAsset } from "./media.ts";
import { AppError } from "./errors.ts";
import type { Doc } from "./db.ts";
import type { VideoPolicy } from "./video-plan.ts";

const api = "https://api.kie.ai/api/v1/jobs";
const uploadApi = "https://kieai.redpandaai.co/api/file-stream-upload";
function httpsUrl(value: unknown) {
  if (typeof value !== "string")
    throw new AppError(502, "Kie 未返回有效的素材地址");
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) throw new Error();
    return value;
  } catch {
    throw new AppError(502, "Kie 返回的素材地址无效");
  }
}
export function kieVideoInput(
  policy: VideoPolicy,
  prompt: string,
  duration: number,
  frameUrl: string,
): Doc {
  if (!policy.model.durations.includes(duration))
    throw new AppError(400, "Kie 片段时长无效");
  const common = {
    prompt,
    duration,
    aspect_ratio: policy.aspect,
    resolution: policy.resolution,
  };
  if (policy.model.adapter === "kie-veo-fast")
    return {
      model: "veo-3-1",
      input: {
        ...common,
        model: "veo3_fast",
        image_urls: [httpsUrl(frameUrl)],
        generation_type: "FIRST_AND_LAST_FRAMES_2_VIDEO",
        enable_fallback: false,
      },
    };
  if (policy.model.adapter !== "kie-seedance-mini")
    throw new AppError(400, "未知 Kie 视频适配器");
  return {
    model: "bytedance/seedance-2-mini",
    input: {
      ...common,
      first_frame_url: httpsUrl(frameUrl),
      generate_audio: policy.generateAudio,
    },
  };
}

// No automatic retries on task submission: a lost response may still have incurred a charge.
export function createKieClient(key: string, transport: typeof fetch = fetch) {
  if (!key)
    throw new AppError(
      409,
      "请在设置中配置 Kie.ai API Key",
      "PROVIDER_NOT_CONFIGURED",
    );
  async function request(
    url: string,
    method: string,
    body?: BodyInit,
    submission = false,
  ) {
    let response: Response;
    try {
      response = await transport(url, {
        method,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(60000),
        headers: {
          Authorization: `Bearer ${key}`,
          ...(typeof body === "string"
            ? { "Content-Type": "application/json" }
            : {}),
        },
      });
    } catch {
      throw new AppError(
        502,
        submission
          ? "Kie 提交响应不明确，请核对供应商任务记录；系统不会自动重发"
          : "Kie 请求暂时失败，请稍后查询原任务",
        submission ? "KIE_SUBMIT_UNCERTAIN" : "KIE_REQUEST_FAILED",
      );
    }
    const rejected = (status: number) =>
      [400, 401, 402, 403, 404, 422].includes(status);
    if (!response.ok)
      throw new AppError(
        response.status,
        `Kie 请求失败（${response.status}），请核对密钥、余额或任务记录`,
        submission && rejected(response.status)
          ? "KIE_SUBMIT_REJECTED"
          : "KIE_REQUEST_FAILED",
      );
    let result: Doc;
    try {
      result = await response.json();
    } catch {
      throw new AppError(
        502,
        "Kie 响应格式无效，请核对原任务",
        submission ? "KIE_SUBMIT_UNCERTAIN" : "KIE_RESPONSE_INVALID",
      );
    }
    if (result.code !== 200 || result.success === false) {
      const code = Number(result.code);
      throw new AppError(
        rejected(code) ? code : 502,
        `Kie 未接受请求（${Number.isFinite(code) ? code : "未知状态"}），请核对供应商记录`,
        submission && rejected(code)
          ? "KIE_SUBMIT_REJECTED"
          : "KIE_RESPONSE_INVALID",
      );
    }
    return result.data;
  }
  async function record(requestId: string) {
    const data = await request(
      `${api}/recordInfo?taskId=${encodeURIComponent(requestId)}`,
      "GET",
    );
    if (!data || (data.taskId && data.taskId !== requestId))
      throw new AppError(502, "Kie 未返回对应任务记录");
    if (data.state === "fail")
      throw new AppError(
        422,
        "Kie 已确认视频生成失败，请在供应商任务记录查看原因",
        "PROVIDER_TASK_FAILED",
      );
    if (!["waiting", "queuing", "generating", "success"].includes(data.state))
      throw new AppError(502, "Kie 任务状态无法识别，请继续核对原任务");
    return data;
  }
  return {
    async upload(bytes: Buffer, mime: string) {
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(mime) ||
        bytes.length > 30 * 1024 * 1024
      )
        throw new AppError(
          400,
          "Kie 商品首帧需为 30MB 以内的 JPG、PNG 或 WebP 图片",
        );
      const form = new FormData();
      const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
      const filename = `${randomUUID()}.${ext}`;
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: mime }),
        filename,
      );
      form.append("uploadPath", "images/x-ecommerce");
      form.append("fileName", filename);
      const data = await request(uploadApi, "POST", form);
      if (data?.success === false) throw new AppError(502, "Kie 素材上传失败");
      return httpsUrl(data?.downloadUrl);
    },
    queue: {
      async submit(_model: string, options: { input: Doc; headers?: Doc }) {
        const data = await request(
          `${api}/createTask`,
          "POST",
          JSON.stringify(options.input),
          true,
        );
        if (typeof data?.taskId !== "string" || !data.taskId)
          throw new AppError(
            502,
            "Kie 提交未返回任务 ID，请核对供应商记录；系统不会自动重发",
            "KIE_SUBMIT_UNCERTAIN",
          );
        return { request_id: data.taskId };
      },
      async status(_model: string, options: { requestId: string }) {
        return {
          status:
            (await record(options.requestId)).state === "success"
              ? "COMPLETED"
              : "IN_PROGRESS",
        };
      },
      async result(model: string, options: { requestId: string }) {
        const task = await record(options.requestId);
        if (task.state !== "success")
          throw new AppError(409, "Kie 视频尚未完成");
        let result: Doc;
        try {
          result = task.response || JSON.parse(task.resultJson);
        } catch {
          throw new AppError(502, "Kie 成功任务的结果格式无效，请核对原任务");
        }
        // Veo's upgraded result is nested; never silently substitute origin_urls (720p).
        const urls =
          model === "veo-3-1"
            ? result?.data?.result_urls || result?.resultUrls
            : result?.resultUrls;
        return { data: { video: { url: httpsUrl(urls?.[0]) } } };
      },
    },
  };
}
export async function kieClient() {
  return createKieClient((await config()).KIE_API_KEY);
}
export async function kieAsset(id: string) {
  const { asset, bytes } = await readAsset(id);
  return (await kieClient()).upload(bytes, asset.mime);
}
