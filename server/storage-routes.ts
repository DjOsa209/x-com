import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { get, put, type Doc } from "./db.ts";
import { workspace } from "./context.ts";
import {
  storageUsage,
  s3Enabled,
  assertStorage,
  withStorageLock,
  signedPut,
  objectHead,
  firstBytes,
  objectPromote,
} from "./storage.ts";
import { AppError } from "./errors.ts";
export const storageRoutes = Router();
const mimes: Doc = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};
storageRoutes.get("/storage", async (_req, res) =>
  res.json(await storageUsage()),
);
storageRoutes.post("/storage/presign", async (req, res) => {
  if (!s3Enabled())
    throw new AppError(409, "当前使用本地存储，请使用普通上传接口");
  const b = z
    .object({
      name: z.string().min(1).max(200),
      mime: z.enum([
        "image/png",
        "image/jpeg",
        "image/webp",
        "video/mp4",
        "video/quicktime",
        "video/webm",
      ]),
      bytes: z
        .number()
        .int()
        .positive()
        .max(100 * 1024 * 1024),
    })
    .parse(req.body);
  return withStorageLock(async () => {
    await assertStorage(b.bytes);
    const id = randomUUID(),
      filename = randomUUID() + mimes[b.mime],
      key = workspace() + "/pending/" + id + "/" + filename;
    await put(
      "upload",
      {
        ...b,
        filename,
        key,
        assetId: randomUUID(),
        expiresAt: Date.now() + 600000,
      },
      id,
    );
    res.json({
      uploadId: id,
      uploadUrl: await signedPut(key, b.mime, b.bytes),
      headers: { "Content-Type": b.mime },
      expiresIn: 600,
    });
  });
});
storageRoutes.post("/storage/confirm", async (req, res) => {
  const id = z.string().max(64).parse(req.body.uploadId);
  const pending = await get(id, "upload");
  if (!pending) throw new AppError(404, "上传申请不存在");
  if (pending.completed) return res.json(await get(pending.assetId, "asset"));
  if (pending.expiresAt < Date.now()) throw new AppError(410, "上传申请已过期");
  const head = await objectHead(pending.key);
  if (
    Number(head.ContentLength) !== pending.bytes ||
    head.ContentType?.split(";")[0] !== pending.mime
  )
    throw new AppError(400, "远端文件大小或类型与申请不一致");
  const b = await firstBytes(pending.key, head.ETag),
    m = pending.mime;
  const valid =
    (m === "image/png" &&
      b
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (m === "image/jpeg" && b[0] === 255 && b[1] === 216 && b[2] === 255) ||
    (m === "image/webp" &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP") ||
    (["video/mp4", "video/quicktime"].includes(m) &&
      b.toString("ascii", 4, 8) === "ftyp") ||
    (m === "video/webm" &&
      b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])));
  if (!valid) throw new AppError(400, "上传文件内容与媒体类型不匹配");
  const asset = await withStorageLock(async () => {
    const existing = await get(pending.assetId, "asset");
    if (existing) return existing;
    await assertStorage(pending.bytes, id);
    const finalKey = await objectPromote(
      pending.key,
      pending.filename,
      head.ETag,
    );
    return put(
      "asset",
      {
        name: pending.name,
        type: m.startsWith("image/") ? "image" : "video",
        mime: m,
        bytes: pending.bytes,
        filename: pending.filename,
        storageKey: finalKey,
        url: "/media/" + pending.filename,
        tags: [],
      },
      pending.assetId,
    );
  });
  await put("upload", { ...pending, completed: true }, id);
  res.json(asset);
});
