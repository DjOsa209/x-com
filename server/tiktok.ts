import { randomBytes, createHash } from "node:crypto";
import { config, seal, unseal } from "./config.ts";
import { get, put, type Doc } from "./db.ts";
import { readAsset, assetFile, validatePublicUrl } from "./media.ts";
import { probe } from "./video-compose.ts";
import {
  operationSettings,
  currentResearchRun,
  withResearchBudgetRequest,
} from "./research-budget.ts";
import { AppError } from "./errors.ts";
import { rows, execute } from "./db.ts";
import { workspace, scope } from "./context.ts";

export async function authUrl() {
  const c = await config();
  if (!c.TIKTOK_CLIENT_KEY || !c.TIKTOK_CLIENT_SECRET)
    throw new AppError(
      409,
      "请先在设置中配置 TikTok 开发者应用",
      "PROVIDER_NOT_CONFIGURED",
    );
  const state = randomBytes(32).toString("hex");
  await execute(
    "INSERT INTO oauth_states(state_hash,workspace_id,user_id,status,expires_at) VALUES(?,?,?,'ready',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 10 MINUTE))",
    [
      createHash("sha256").update(state).digest("hex"),
      workspace(),
      scope().userId,
    ],
  );
  const query = new URLSearchParams({
    client_key: c.TIKTOK_CLIENT_KEY,
    response_type: "code",
    scope: c.TIKTOK_SCOPES,
    redirect_uri: c.TIKTOK_REDIRECT_URI,
    state,
  });
  return { url: "https://www.tiktok.com/v2/auth/authorize/?" + query, state };
}
async function tokenRequest(body: Doc) {
  const c = await config();
  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...body,
      client_key: c.TIKTOK_CLIENT_KEY,
      client_secret: c.TIKTOK_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  if (!r.ok || !data.access_token)
    throw new AppError(
      502,
      "TikTok 授权失败，请检查应用权限和回调地址",
      "TIKTOK_AUTH_FAILED",
    );
  return data;
}
export async function callback(code: string, state: string, cookie: string) {
  const hash = createHash("sha256").update(state).digest("hex");
  const [s] = await rows(
    "SELECT status FROM oauth_states WHERE state_hash=? AND workspace_id=? AND user_id=? AND expires_at>UTC_TIMESTAMP()",
    [hash, workspace(), scope().userId],
  );
  if (!state || state !== cookie || s?.status !== "ready")
    throw new AppError(400, "授权状态失效，请重新连接 TikTok", "OAUTH_STATE");
  const claimed = await execute(
    "UPDATE oauth_states SET status='processing' WHERE state_hash=? AND status='ready'",
    [hash],
  );
  if (!claimed.affectedRows) throw new AppError(409, "授权回调已处理");
  try {
    const c = await config();
    const token = await tokenRequest({
      code,
      grant_type: "authorization_code",
      redirect_uri: c.TIKTOK_REDIRECT_URI,
    });
    const id =
      "tt-" +
      createHash("sha256")
        .update(workspace() + ":" + token.open_id)
        .digest("hex")
        .slice(0, 28);
    await put(
      "token",
      {
        encrypted: seal(
          JSON.stringify({
            ...token,
            expiresAt: Date.now() + token.expires_in * 1000,
          }),
        ),
      },
      id + "-token",
    );
    const info = await tikCall(
      id,
      "/v2/user/info/?fields=open_id,display_name,avatar_url",
      undefined,
      "GET",
    );
    await put(
      "account",
      {
        name: info.user?.display_name || "TikTok",
        avatar: info.user?.avatar_url,
        scopes: token.scope,
        provider: "tiktok",
      },
      id,
    );
    await execute(
      "UPDATE oauth_states SET status='connected' WHERE state_hash=?",
      [hash],
    );
    return id;
  } catch (e) {
    await execute(
      "UPDATE oauth_states SET status='failed' WHERE state_hash=?",
      [hash],
    );
    throw e;
  }
}
export async function accountToken(id: string) {
  const stored = await get(id + "-token", "token");
  if (!stored)
    throw new AppError(409, "TikTok 账号尚未授权", "ACCOUNT_NOT_CONNECTED");
  let token = JSON.parse(unseal(stored.encrypted));
  if (token.expiresAt < Date.now() + 60000) {
    token = {
      ...token,
      ...(await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
      })),
    };
    token.expiresAt = Date.now() + token.expires_in * 1000;
    await put(
      "token",
      { encrypted: seal(JSON.stringify(token)) },
      id + "-token",
    );
  }
  return token.access_token;
}
export async function tikCall(
  id: string,
  path: string,
  body?: Doc,
  method = "POST",
) {
  const token = await accountToken(id);
  const send = async () => {
    const response = await fetch("https://open.tiktokapis.com" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json; charset=UTF-8",
      },
      ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok || (result.error?.code && result.error.code !== "ok"))
      throw new AppError(
        502,
        `TikTok：${String(result.error?.message || result.error?.code || response.status).slice(0, 300)}`,
        "TIKTOK_API_FAILED",
      );
    return result.data;
  };
  return currentResearchRun()
    ? withResearchBudgetRequest("tiktok", path, send)
    : send();
}
export const creatorInfo = (id: string) =>
  tikCall(id, "/v2/post/publish/creator_info/query/");
export function verifiedVideoUrl(value: string, prefix: string) {
  let url: URL, allowed: URL;
  try {
    url = new URL(value);
    allowed = new URL(prefix);
  } catch {
    throw new AppError(400, "请设置已在 TikTok 验证的媒体 URL 前缀");
  }
  const path = allowed.pathname.endsWith("/")
    ? allowed.pathname
    : allowed.pathname + "/";
  if (
    url.protocol !== "https:" ||
    allowed.protocol !== "https:" ||
    url.origin !== allowed.origin ||
    !url.pathname.startsWith(path) ||
    url.username ||
    url.password ||
    url.hash ||
    allowed.search ||
    allowed.hash
  )
    throw new AppError(400, "视频 URL 不在管理员配置的已验证 HTTPS 前缀下");
  return url.toString();
}
export function validateCreatorVideo(input: Doc, info: Doc, media: Doc) {
  const duration = Number(media.format?.duration),
    v = media.streams?.find((x: Doc) => x.codec_type === "video");
  if (!v || !Number.isFinite(duration) || duration <= 0)
    throw new AppError(400, "视频媒体信息无效");
  const maximum =
    input.mode === "inbox" ? 600 : Number(info.max_video_post_duration_sec);
  if (!Number.isFinite(maximum) || maximum <= 0)
    throw new AppError(409, "TikTok 未返回此账号可发布的最长时长，请稍后重试");
  if (duration > maximum + 0.05)
    throw new AppError(
      400,
      `视频 ${duration.toFixed(1)} 秒，超过当前账号 ${maximum} 秒上限`,
    );
  if (v.width < 360 || v.height < 360 || v.width > 4096 || v.height > 4096)
    throw new AppError(400, "TikTok 视频宽高需在 360–4096 像素之间");
  const fps = String(v.avg_frame_rate || "0/1")
    .split("/")
    .map(Number);
  const frameRate = fps[0] / (fps[1] || 1);
  if (frameRate < 23 || frameRate > 60)
    throw new AppError(400, "TikTok 视频帧率需在 23–60 FPS 之间");
  if (
    input.mode !== "inbox" &&
    !info.privacy_level_options?.includes(input.privacy)
  )
    throw new AppError(400, "请明确选择该账号允许的可见范围");
  if (input.brandContent && input.privacy === "SELF_ONLY")
    throw new AppError(400, "品牌合作内容不能设为仅自己可见");
  return {
    duration,
    width: v.width,
    height: v.height,
    frameRate,
    maxDuration: maximum,
  };
}
export async function publicationPreflight(input: Doc) {
  const { asset, path } = await assetFile(input.assetId);
  if (asset.type !== "video") throw new AppError(400, "发布素材必须是视频");
  const media = await probe(path),
    settings = await operationSettings();
  if (input.mode === "export")
    return {
      mode: "export",
      ready: true,
      duration: Number(media.format?.duration),
      note: "导出包无需 TikTok 应用资格；上传后登记真实作品链接。",
    };
  const enabled =
    input.mode === "inbox"
      ? settings.tiktokInboxEnabled
      : settings.tiktokDirectEnabled;
  if (!enabled)
    throw new AppError(
      409,
      "当前工作空间使用导出发布；管理员确认应用具备相应资格后才可启用官方接口",
      "TIKTOK_MODE_DISABLED",
    );
  const account = await get(input.accountId, "account");
  if (!account) throw new AppError(409, "请连接 TikTok 账号");
  const required = input.mode === "inbox" ? "video.upload" : "video.publish";
  if (
    !String(account.scopes || "")
      .split(/[, ]+/)
      .includes(required)
  )
    throw new AppError(409, "此账号尚未授权 " + required + "，请重新授权");
  const info =
    input.mode === "inbox"
      ? { max_video_post_duration_sec: 600, creator_nickname: account.name }
      : await creatorInfo(input.accountId);
  const dimensions = validateCreatorVideo(input, info, media);
  if (input.verifiedVideoUrl) {
    const value = verifiedVideoUrl(
      input.verifiedVideoUrl,
      settings.verifiedMediaPrefix,
    );
    await validatePublicUrl(value);
    const response = await fetch(value, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.startsWith("video/")
    )
      throw new AppError(
        400,
        "托管视频地址未直接返回可访问的视频，请检查 URL 和有效期",
      );
    if (Number(response.headers.get("content-length")) !== Number(asset.bytes))
      throw new AppError(
        400,
        "托管视频大小与已审核素材不一致，请使用当前素材的原始文件 URL",
      );
  }
  return {
    mode: input.mode,
    ready: true,
    account: { id: account.id, name: info.creator_nickname || account.name },
    creator: info,
    media: dimensions,
    transfer: input.verifiedVideoUrl ? "PULL_FROM_URL" : "FILE_UPLOAD",
    note: input.verifiedVideoUrl
      ? "媒体 URL 需在后续至少 1 小时保持可访问。"
      : "将上传已审核的本地素材。",
  };
}
export async function initializePost(input: Doc) {
  if (!input.consent) throw new AppError(400, "请确认发布授权");
  if (String(input.caption || "").length > 2200)
    throw new AppError(400, "文案不能超过 2200 字符");
  const preflight = await publicationPreflight(input),
    info = preflight.creator || {};
  const { asset, bytes } = await readAsset(input.assetId);
  const chunkSize = Math.min(bytes.length, 50 * 1024 * 1024);
  const count = Math.max(1, Math.floor(bytes.length / chunkSize));
  const source_info = input.verifiedVideoUrl
    ? { source: "PULL_FROM_URL", video_url: input.verifiedVideoUrl }
    : {
        source: "FILE_UPLOAD",
        video_size: bytes.length,
        chunk_size: chunkSize,
        total_chunk_count: count,
      };
  const endpoint =
    input.mode === "inbox"
      ? "/v2/post/publish/inbox/video/init/"
      : "/v2/post/publish/video/init/";
  const init = await tikCall(
    input.accountId,
    endpoint,
    input.mode === "inbox"
      ? { source_info }
      : {
          source_info,
          post_info: {
            title: input.caption || "",
            privacy_level: input.privacy,
            disable_comment: !!input.disableComment || !!info.comment_disabled,
            disable_duet: !!input.disableDuet || !!info.duet_disabled,
            disable_stitch: !!input.disableStitch || !!info.stitch_disabled,
            brand_content_toggle: !!input.brandContent,
            brand_organic_toggle: !!input.brandOrganic,
            is_aigc: !!input.isAigc,
          },
        },
  );
  if ((!input.verifiedVideoUrl && !init.upload_url) || !init.publish_id)
    throw new AppError(502, "TikTok 未返回上传任务");
  return {
    init,
    bytes,
    asset,
    chunkSize,
    count,
    pullFromUrl: !!input.verifiedVideoUrl,
  };
}
export async function transferPost(
  job: Awaited<ReturnType<typeof initializePost>>,
) {
  const { init, bytes, asset, chunkSize, count } = job;
  if (job.pullFromUrl) return;
  const url = new URL(init.upload_url);
  if (url.protocol !== "https:" || !/(^|\.)tiktokapis\.com$/.test(url.hostname))
    throw new AppError(502, "TikTok 上传地址异常");
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize,
      end = i === count - 1 ? bytes.length : start + chunkSize;
    const r = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": asset.mime,
        "Content-Length": String(end - start),
        "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}`,
      },
      body: new Uint8Array(bytes.subarray(start, end)),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok)
      throw new AppError(
        502,
        `TikTok 视频上传失败（${r.status}），请检查任务状态后再操作`,
      );
  }
}
export const postStatus = (accountId: string, publishId: string) =>
  tikCall(accountId, "/v2/post/publish/status/fetch/", {
    publish_id: publishId,
  });
