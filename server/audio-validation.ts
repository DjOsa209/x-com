import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe } from "./video-compose.ts";
import { AppError } from "./errors.ts";
export async function validateAudioPath(path: string) {
  try {
    const info = await probe(path),
      duration = Number(info.format?.duration);
    if (
      !info.streams?.some((s: any) => s.codec_type === "audio") ||
      info.streams.some((s: any) => s.codec_type === "video") ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 7200
    )
      throw new Error();
    return { duration };
  } catch {
    throw new AppError(
      400,
      "音频文件无法读取、含视频轨道或时长超过两小时",
      "INVALID_AUDIO",
    );
  }
}
export async function validateAudioBytes(bytes: Buffer) {
  const folder = await mkdtemp(join(tmpdir(), "x-audio-check-"));
  try {
    const path = join(folder, "input");
    await writeFile(path, bytes);
    return await validateAudioPath(path);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
