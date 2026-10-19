import { randomBytes, createHash } from "node:crypto";
import { config, seal, unseal } from "./config.ts";
import { get, put, type Doc } from "./db.ts";
import { readAsset } from "./media.ts";
import { AppError } from "./errors.ts";

const oauth = new Map<string, number>();
export async function authUrl() {
  const c = await config();
  if (!c.TIKTOK_CLIENT_KEY || !c.TIKTOK_CLIENT_SECRET)
    throw new AppError(
      409,
      "请先在设置中配置 TikTok 开发者应用",
      "PROVIDER_NOT_CONFIGURED",
    );
  for (const [key, exp] of oauth) if (exp < Date.now()) oauth.delete(key);
  const state = randomBytes(32).toString("hex");
  oauth.set(state, Date.now() + 600000);
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
  if (!state || state !== cookie || (oauth.get(state) || 0) < Date.now())
    throw new AppError(400, "授权状态失效，请重新连接 TikTok", "OAUTH_STATE");
  oauth.delete(state);
  const c = await config();
  const token = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: c.TIKTOK_REDIRECT_URI,
  });
  const id =
    "tt-" +
    createHash("sha256").update(token.open_id).digest("hex").slice(0, 28);
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
  return id;
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
}
export const creatorInfo = (id: string) =>
  tikCall(id, "/v2/post/publish/creator_info/query/");
export async function initializePost(input: Doc) {
  const { asset, bytes } = await readAsset(input.assetId);
  if (asset.type !== "video") throw new AppError(400, "发布素材必须是视频");
  if (!input.consent) throw new AppError(400, "请确认发布授权");
  if (String(input.caption || "").length > 2200)
    throw new AppError(400, "文案不能超过 2200 字符");
  const info = await creatorInfo(input.accountId);
  if (
    input.mode !== "inbox" &&
    !info.privacy_level_options?.includes(input.privacy)
  )
    throw new AppError(400, "请选择该账号允许的可见范围");
  const chunkSize = Math.min(bytes.length, 50 * 1024 * 1024);
  const count = Math.max(1, Math.floor(bytes.length / chunkSize));
  const source_info = {
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
  if (!init.upload_url || !init.publish_id)
    throw new AppError(502, "TikTok 未返回上传任务");
  return { init, bytes, asset, chunkSize, count };
}
export async function transferPost(
  job: Awaited<ReturnType<typeof initializePost>>,
) {
  const { init, bytes, asset, chunkSize, count } = job;
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
