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
  materialize,
  objectDelete,
} from "./storage.ts";
import { AppError } from "./errors.ts";
import { validateAudioPath } from "./audio-validation.ts";
import { mediaExtensions, validMediaHeader } from "./media-types.ts";
export const storageRoutes = Router();
const mimes = mediaExtensions;
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
        "audio/mpeg",
        "audio/wav",
        "audio/x-wav",
        "audio/mp4",
        "audio/x-m4a",
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
  const valid = validMediaHeader(b, m);
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
    let audioInfo = {};
    if (m.startsWith("audio/")) {
      try {
        audioInfo = await validateAudioPath(
          await materialize({
            filename: pending.filename,
            storageKey: finalKey,
            bytes: pending.bytes,
          }),
        );
      } catch (e) {
        await objectDelete(finalKey).catch(() => {});
        throw e;
      }
    }
    return put(
      "asset",
      {
        ...audioInfo,
        name: pending.name,
        type: m.startsWith("image/")
          ? "image"
          : m.startsWith("audio/")
            ? "audio"
            : "video",
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
