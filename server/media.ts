import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { basename, resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { get, put, type Doc } from "./db.ts";
import { AppError } from "./errors.ts";
import { validateAudioBytes } from "./audio-validation.ts";
import { mediaExtensions } from "./media-types.ts";
import { echoQuery } from "./echotik.ts";
import { config } from "./config.ts";
import {
  withStorageLock,
  assertStorage,
  objectPut,
  objectDelete,
  materialize,
} from "./storage.ts";

export const mediaRoot = resolve(".local/uploads");
await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
export function privateIp(ip: string) {
  const v = ip.toLowerCase().replace(/^::ffff:/, "");
  return (
    !isIP(v) ||
    /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|19[28]\.0\.|198\.(1[89])\.|22[4-9]\.|2[3-5]\d\.)/.test(
      v,
    ) ||
    v === "::" ||
    v === "::1" ||
    /^(fc|fd|fe[89ab]|ff)/.test(v) ||
    v.includes("::ffff:")
  );
}
export async function validatePublicUrl(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError(400, "请输入有效链接", "INVALID_URL");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw new AppError(400, "仅接受公开 HTTPS 媒体链接", "INVALID_URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (!ips.length || ips.some((i) => privateIp(i.address)))
    throw new AppError(400, "不能访问本地或内部网络地址", "INVALID_URL");
  return u;
}
export async function fetchMedia(
  value: string,
  max = 100 * 1024 * 1024,
): Promise<{ bytes: Buffer; mime: string }> {
  let url = value;
  for (let hop = 0; hop < 5; hop++) {
    await validatePublicUrl(url);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(90000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get("location");
      if (!target) break;
      url = new URL(target, url).toString();
      continue;
    }
    if (!response.ok)
      throw new AppError(
        502,
        `媒体下载失败（${response.status}）`,
        "MEDIA_FAILED",
      );
    const mime = (response.headers.get("content-type") || "").split(";")[0];
    if (
      !/^(image\/(png|jpeg|webp)|video\/(mp4|webm|quicktime)|application\/octet-stream)$/.test(
        mime,
      )
    )
      throw new AppError(
        400,
        "链接未返回支持的图片或视频文件，请使用分享链接解析或上传文件",
        "INVALID_MEDIA",
      );
    if (Number(response.headers.get("content-length")) > max)
      throw new AppError(413, "媒体超过 100MB 上限", "FILE_TOO_LARGE");
    const parts: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new AppError(502, "媒体内容为空", "MEDIA_FAILED");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > max)
          throw new AppError(413, "媒体超过大小上限", "FILE_TOO_LARGE");
        parts.push(chunk);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return {
      bytes: Buffer.concat(parts),
      mime: mime === "application/octet-stream" ? "video/mp4" : mime,
    };
  }
  throw new AppError(400, "媒体重定向次数过多", "MEDIA_FAILED");
}
export async function saveMedia(
  bytes: Buffer,
  mime: string,
  name: string,
  extra: Doc = {},
) {
  const audioInfo = mime.startsWith("audio/")
    ? await validateAudioBytes(bytes)
    : {};
  return withStorageLock(async () => {
    await assertStorage(bytes.length);
    const ext = mediaExtensions[mime];
    if (!ext) throw new AppError(400, "不支持的媒体类型", "INVALID_MEDIA");
    const filename = randomUUID() + ext;
    const storageKey = await objectPut(filename, bytes, mime);
    if (!storageKey)
      await writeFile(resolve(mediaRoot, filename), bytes, { mode: 0o600 });
    try {
      return await put("asset", {
        name: name.slice(0, 200),
        type: mime.startsWith("image/")
          ? "image"
          : mime.startsWith("audio/")
            ? "audio"
            : "video",
        mime,
        bytes: bytes.length,
        filename,
        storageKey,
        url: "/media/" + filename,
        tags: [],
        ...extra,
        ...audioInfo,
      });
    } catch (e) {
      const { unlink } = await import("node:fs/promises");
      if (storageKey) await objectDelete(storageKey).catch(() => {});
      else await unlink(resolve(mediaRoot, filename)).catch(() => {});
      throw e;
    }
  });
}
export async function assetFile(id: string) {
  const a = await get(id, "asset");
  if (!a || !a.filename || basename(a.filename) !== a.filename)
    throw new AppError(404, "素材不存在", "NOT_FOUND");
  const path = a.storageKey
    ? await materialize(a)
    : resolve(mediaRoot, a.filename);
  await stat(path);
  return { asset: a, path };
}
export async function readAsset(id: string) {
  const { asset, path } = await assetFile(id);
  return { asset, path, bytes: await readFile(path) };
}
export function findVideoUrl(data: any): string | undefined {
  if (!data || typeof data !== "object") return;
  for (const k of [
    "download_addr",
    "download_url",
    "downloadUrl",
    "play_addr",
    "play_url",
    "video_url",
    "url_list",
  ]) {
    const v = data[k];
    if (typeof v === "string" && v.startsWith("https://")) return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    if (v && typeof v === "object") {
      const nested = findVideoUrl(v);
      if (nested) return nested;
    }
  }
  for (const k of ["video", "data", "aweme_detail", "playAddr", "downloadAddr"])
    if (data[k]) {
      const nested =
        typeof data[k] === "string" ? data[k] : findVideoUrl(data[k]);
      if (nested?.startsWith("https://")) return nested;
    }
}
export async function resolveVideo(value: string) {
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    if (!/^\d{10,25}$/.test(value))
      throw new AppError(400, "请输入有效视频链接或 TikTok 视频 ID");
  }
  if (
    /^\d{10,25}$/.test(value) ||
    /(^|\.)tiktok\.com$/i.test(parsed!.hostname)
  ) {
    const response = await echoQuery(
      "/realtime/video/download-url",
      { url: value },
      true,
    );
    const url = findVideoUrl(response.data);
    if (!url)
      throw new AppError(502, "EchoTik 未返回可用视频地址", "MEDIA_FAILED");
    return { url, source: value, metadata: response };
  }
  const u = parsed!;
  if (/(^|\.)douyin\.com$/i.test(u.hostname)) {
    const c = await config();
    if (!c.DOWNLOAD_RESOLVER_URL)
      throw new AppError(
        409,
        "EchoTik 未提供抖音解析。请先下载后上传文件，或在设置中连接独立解析服务。",
        "DOUYIN_PROVIDER_REQUIRED",
      );
    await validatePublicUrl(c.DOWNLOAD_RESOLVER_URL);
    const response = await fetch(c.DOWNLOAD_RESOLVER_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(c.DOWNLOAD_RESOLVER_KEY
          ? { Authorization: "Bearer " + c.DOWNLOAD_RESOLVER_KEY }
          : {}),
      },
      body: JSON.stringify({ url: value }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new AppError(502, `独立视频解析服务失败（${response.status}）`);
    const data = await response.json();
    const url = findVideoUrl(data);
    if (!url) throw new AppError(502, "解析服务未返回 video_url");
    await validatePublicUrl(url);
    return { url, source: value };
  }
  await validatePublicUrl(value);
  return { url: value, source: value };
}
