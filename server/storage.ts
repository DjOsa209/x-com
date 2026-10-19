import {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdir, writeFile, stat, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pool, rows } from "./db.ts";
import { workspace } from "./context.ts";
import { config } from "./config.ts";
import { AppError } from "./errors.ts";
export const s3Enabled = () => process.env.STORAGE_DRIVER === "s3";
export const s3 = () =>
  new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
export const bucket = () => {
  if (!process.env.S3_BUCKET) throw new AppError(409, "尚未配置 S3_BUCKET");
  return process.env.S3_BUCKET;
};
export async function storageUsage(excludeUploadId = "") {
  const [r] = await rows(
    "SELECT COALESCE(SUM(JSON_EXTRACT(body,'$.bytes')),0) usedBytes,COUNT(*) count FROM records WHERE workspace_id=? AND kind='asset'",
    [workspace()],
  );
  const [pending] = await rows(
    "SELECT COALESCE(SUM(JSON_EXTRACT(body,'$.bytes')),0) reservedBytes FROM records WHERE workspace_id=? AND kind='upload' AND id<>? AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(body,'$.completed')),'false')<>'true' AND JSON_EXTRACT(body,'$.expiresAt')>?",
    [workspace(), excludeUploadId, Date.now()],
  );
  const c = await config();
  return {
    driver: s3Enabled() ? "s3" : "local",
    usedBytes: Number(r.usedBytes),
    reservedBytes: Number(pending.reservedBytes),
    limitBytes: Number(c.STORAGE_LIMIT_MB) * 1024 * 1024,
    count: Number(r.count),
  };
}
export async function assertStorage(bytes: number, excludeUploadId = "") {
  const u = await storageUsage(excludeUploadId);
  if (u.usedBytes + u.reservedBytes + bytes > u.limitBytes)
    throw new AppError(413, "工作空间素材存储额度不足", "STORAGE_LIMIT");
}
export async function withStorageLock<T>(fn: () => Promise<T>) {
  const c = await pool.getConnection(),
    name = "x-storage-" + workspace().slice(0, 40);
  try {
    const [r]: any = await c.query("SELECT GET_LOCK(?,10) acquired", [name]);
    if (Number(r[0].acquired) !== 1)
      throw new AppError(409, "存储繁忙，请稍后重试");
    return await fn();
  } finally {
    await c.query("SELECT RELEASE_LOCK(?)", [name]);
    c.release();
  }
}
export async function objectPut(filename: string, bytes: Buffer, mime: string) {
  if (!s3Enabled()) return null;
  const key = workspace() + "/assets/" + filename;
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: bytes,
      ContentType: mime,
    }),
  );
  return key;
}
export async function objectDelete(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
export async function materialize(asset: any) {
  const folder = resolve(".local/object-cache");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = resolve(folder, asset.filename);
  try {
    const s = await stat(path);
    if (s.size === Number(asset.bytes)) return path;
  } catch {}
  const r = await s3().send(
    new GetObjectCommand({ Bucket: bucket(), Key: asset.storageKey }),
  );
  if (Number(r.ContentLength) > 100 * 1024 * 1024)
    throw new AppError(413, "远端文件超过大小上限");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const part of r.Body as any) {
    size += part.length;
    if (size > 100 * 1024 * 1024)
      throw new AppError(413, "远端文件超过大小上限");
    chunks.push(part);
  }
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, Buffer.concat(chunks), { mode: 0o600 });
  await rename(tmp, path);
  return path;
}
export const objectHead = (key: string) =>
  s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
export const signedPut = (key: string, mime: string, bytes: number) =>
  getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: mime,
      ContentLength: bytes,
    }),
    { expiresIn: 600 },
  );
export async function firstBytes(key: string, etag?: string) {
  const r = await s3().send(
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      Range: "bytes=0-63",
      IfMatch: etag,
    }),
  );
  return Buffer.from(await r.Body!.transformToByteArray());
}

export async function objectPromote(
  key: string,
  filename: string,
  etag?: string,
) {
  const finalKey = workspace() + "/assets/" + filename;
  await s3().send(
    new CopyObjectCommand({
      Bucket: bucket(),
      Key: finalKey,
      CopySource: encodeURIComponent(bucket() + "/" + key).replace(/%2F/g, "/"),
      CopySourceIfMatch: etag,
    }),
  );
  // Keep the temporary object until its signed URL has expired. The worker
  // removes it afterwards; the immutable asset uses a different key.
  return finalKey;
}
export async function cleanExpiredUploads() {
  if (!s3Enabled()) return;
  const { inWorkspace } = await import("./context.ts");
  const { parse, remove } = await import("./db.ts");
  const expired = await rows(
    "SELECT * FROM records WHERE kind='upload' AND JSON_EXTRACT(body,'$.expiresAt')<? ORDER BY created_at LIMIT 20",
    [Date.now() - 600000],
  );
  for (const r of expired)
    await inWorkspace(r.workspace_id, async () => {
      await objectDelete(parse(r.body).key);
      await remove(r.id, "upload");
    });
}
