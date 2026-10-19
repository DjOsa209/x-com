import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "./errors.ts";
const run = promisify(execFile);
export const ffmpegPath = () =>
  process.env.FFMPEG_PATH || ffmpegStatic || "ffmpeg";
export const ffprobePath = () => process.env.FFPROBE_PATH || ffprobeStatic.path;
export async function mediaToolsReady() {
  try {
    await run(ffmpegPath(), ["-version"], {
      timeout: 10000,
      maxBuffer: 500000,
    });
    await run(ffprobePath(), ["-version"], {
      timeout: 10000,
      maxBuffer: 500000,
    });
  } catch {
    throw new AppError(
      409,
      "视频拼接工具未就绪，请安装 FFmpeg/FFprobe 或设置其路径",
      "MEDIA_TOOLS_UNAVAILABLE",
    );
  }
}
export async function probe(path: string) {
  const { stdout } = await run(
    ffprobePath(),
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path,
    ],
    { timeout: 30000, maxBuffer: 1000000 },
  );
  return JSON.parse(stdout);
}
export type ComposeInput = { path: string; duration: number };
export async function composeVideo(
  inputs: ComposeInput[],
  aspect: string,
  resolution: string,
) {
  if (!inputs.length || inputs.length > 20)
    throw new AppError(400, "拼接片段数量无效");
  const height =
    resolution === "4k"
      ? 2160
      : resolution === "1080p"
        ? 1080
        : resolution === "480p"
          ? 480
          : resolution === "360p"
            ? 360
            : 720;
  const [w, h] =
    aspect === "16:9"
      ? [Math.round((height * 16) / 9 / 2) * 2, height]
      : aspect === "1:1"
        ? [height, height]
        : [height, Math.round((height * 16) / 9 / 2) * 2];
  const folder = await mkdtemp(join(tmpdir(), "x-ecom-concat-"));
  try {
    for (let i = 0; i < inputs.length; i++) {
      const item = inputs[i],
        info = await probe(item.path),
        video = info.streams?.find((s: any) => s.codec_type === "video");
      if (!video)
        throw new AppError(
          400,
          `片段 ${i + 1} 没有可读取的视频轨道`,
          "SEGMENT_INVALID",
          { segmentIndex: i },
        );
      const actual = Number(video.duration || info.format?.duration);
      if (!Number.isFinite(actual) || actual + 0.12 < item.duration)
        throw new AppError(
          409,
          `片段 ${i + 1} 短于计划时长，请重新生成该段`,
          "SEGMENT_TOO_SHORT",
          { segmentIndex: i },
        );
      const audio = info.streams.some((s: any) => s.codec_type === "audio");
      const args = [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        item.path,
      ];
      if (!audio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      args.push(
        "-map",
        "0:v:0",
        "-map",
        audio ? "0:a:0" : "1:a:0",
        "-t",
        String(item.duration),
        "-vf",
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`,
        "-af",
        "apad,aresample=48000",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "21",
        "-threads",
        "2",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        join(folder, `${i}.mp4`),
      );
      await run(ffmpegPath(), args, { timeout: 600000, maxBuffer: 1000000 });
    }
    await writeFile(
      join(folder, "list.txt"),
      inputs.map((_, i) => `file '${i}.mp4'`).join("\n"),
    );
    const output = join(folder, "final.mp4");
    await run(
      ffmpegPath(),
      [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        join(folder, "list.txt"),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        output,
      ],
      { timeout: 300000, maxBuffer: 1000000 },
    );
    const size = (await stat(output)).size;
    if (size > 100 * 1024 * 1024)
      throw new AppError(413, "拼接成片超过 100MB 上限");
    const final = await probe(output),
      duration = Number(final.format?.duration),
      target = inputs.reduce((n, s) => n + s.duration, 0);
    if (!Number.isFinite(duration) || Math.abs(duration - target) > 0.2)
      throw new AppError(502, "拼接结果时长校验失败", "COMPOSE_DURATION");
    return { bytes: await readFile(output), duration, width: w, height: h };
  } catch (e: any) {
    if (e instanceof AppError) throw e;
    console.error(
      "Video composition:",
      e.code || e.name,
      String(e.stderr || "").slice(-600),
    );
    throw new AppError(
      502,
      "视频拼接失败，可重试拼接而无需重新生成成功片段",
      "COMPOSE_FAILED",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
