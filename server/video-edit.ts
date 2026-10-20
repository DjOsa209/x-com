import {
  prepareSubtitleFont,
  subtitleFont,
  subtitleAss,
} from "./subtitle-font.ts";
import { Router } from "express";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assetFile, saveMedia } from "./media.ts";
import { rows, type Doc } from "./db.ts";
import { workspace } from "./context.ts";
import { createJob } from "./jobs.ts";
import { ffmpegPath, probe, mediaToolsReady } from "./video-compose.ts";
import { AppError } from "./errors.ts";
const run = promisify(execFile);
export const cueSchema = z
  .object({
    start: z.number().finite().min(0),
    end: z.number().finite().positive(),
    text: z.string().trim().min(1).max(2000),
  })
  .refine((c) => c.end > c.start, "字幕结束时间必须晚于开始时间");
export type Cue = z.infer<typeof cueSchema>;
export const videoEditSchema = z.object({
  assetId: z.string().min(1).max(64),
  name: z.string().max(200).default("后期成片"),
  captions: z.array(cueSchema).max(500).default([]),
  burnCaptions: z.boolean().default(false),
  voiceAssetId: z.string().max(64).optional(),
  musicAssetId: z.string().max(64).optional(),
  originalVolume: z.number().finite().min(0).max(2).default(1),
  voiceVolume: z.number().finite().min(0).max(2).default(1),
  musicVolume: z.number().finite().min(0).max(1).default(0.15),
  coverTime: z.number().finite().min(0).optional(),
  captionSize: z.number().int().min(16).max(72).default(32),
});
function time(s: number, separator: string) {
  const ms = Math.round(s * 1000),
    hours = Math.floor(ms / 3600000),
    minutes = Math.floor(ms / 60000) % 60,
    seconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(ms % 1000).padStart(3, "0")}`;
}
export function validateCues(cues: Cue[], duration = 7200) {
  let end = 0;
  for (const cue of cues) {
    cueSchema.parse(cue);
    if (cue.start < end - 0.001 || cue.end > duration + 0.05)
      throw new AppError(400, "字幕须按时间排序、不重叠且不超过成片时长");
    end = cue.end;
  }
  return cues;
}
export function serializeSubtitles(cues: Cue[], format: "srt" | "vtt" = "srt") {
  validateCues(cues);
  return (
    (format === "vtt" ? "WEBVTT\n\n" : "") +
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${time(c.start, format === "srt" ? "," : ".")} --> ${time(c.end, format === "srt" ? "," : ".")}\n${c.text.replace(/\r/g, "").replace(/\n{2,}/g, "\n")}\n`,
      )
      .join("\n")
  );
}
export function parseSubtitles(value: string): Cue[] {
  if (value.length > 1000000) throw new AppError(413, "字幕文件过大");
  const normalized = value
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .replace(/^WEBVTT[^\n]*\n+/, "")
    .trim();
  if (!normalized) return [];
  const stamp = (s: string) => {
    const [h, m, sec] = s.replace(",", ".").split(":").map(Number);
    if (m > 59 || sec >= 60) throw new AppError(400, "字幕时间格式无效");
    return h * 3600 + m * 60 + sec;
  };
  const cues = normalized.split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    const match =
      at >= 0 &&
      lines[at].match(
        /^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*$/,
      );
    if (!match) throw new AppError(400, "只支持标准 SRT/VTT 时间码字幕");
    return cueSchema.parse({
      start: stamp(match[1]),
      end: stamp(match[2]),
      text: lines.slice(at + 1).join("\n"),
    });
  });
  if (cues.length > 500) throw new AppError(400, "最多 500 条字幕");
  return validateCues(cues);
}
export async function checkVideoEdit(input: Doc) {
  const b = videoEditSchema.parse(input);
  const source = await assetFile(b.assetId);
  if (source.asset.type !== "video")
    throw new AppError(400, "后期处理需要视频素材");
  for (const id of [b.voiceAssetId, b.musicAssetId].filter(Boolean)) {
    const audio = await assetFile(id!);
    if (audio.asset.type !== "audio")
      throw new AppError(400, "配音和背景音乐需要音频素材");
  }
  if (b.burnCaptions && b.captions.length)
    await subtitleFont(b.captions.map((c) => c.text).join("\n"));
  await mediaToolsReady();
}
// Kept separate from the model pipeline: edits only read owned assets and run local FFmpeg.
export async function runVideoEdit(input: Doc, jobId: string) {
  const b = videoEditSchema.parse(input);
  await checkVideoEdit(b);
  const signature = createHash("sha256")
    .update(JSON.stringify(b))
    .digest("hex");
  const prior = await rows(
    "SELECT id FROM records WHERE workspace_id=? AND kind='asset' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.jobId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.editSignature'))=?",
    [workspace(), jobId, signature],
  );
  let asset: Doc | undefined, coverAsset: Doc | undefined;
  for (const p of prior) {
    const a = (await assetFile(p.id)).asset;
    if (a.type === "video") asset = a;
    else coverAsset = a;
  }
  if (asset && (b.coverTime === undefined || coverAsset))
    return {
      asset,
      coverAsset,
      subtitles: b.captions,
      subtitleSrt: serializeSubtitles(b.captions),
      subtitleVtt: serializeSubtitles(b.captions, "vtt"),
      sourceAssetId: b.assetId,
    };
  const source = await assetFile(b.assetId),
    info = await probe(source.path);
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7200)
    throw new AppError(400, "源视频时长无效或超过两小时");
  validateCues(b.captions, duration);
  if (b.coverTime !== undefined && b.coverTime >= duration)
    throw new AppError(400, "封面时间必须位于视频内");
  const folder = await mkdtemp(join(tmpdir(), "x-ecom-edit-"));
  try {
    if (!asset) {
      const args = [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        source.path,
      ];
      const filters: string[] = [],
        tracks: string[] = [];
      let inputIndex = 1;
      if (info.streams.some((s: Doc) => s.codec_type === "audio")) {
        filters.push(
          `[0:a]volume=${b.originalVolume},apad,atrim=duration=${duration}[a0]`,
        );
        tracks.push("[a0]");
      }
      for (const [id, vol, loop] of [
        [b.voiceAssetId, b.voiceVolume, false],
        [b.musicAssetId, b.musicVolume, true],
      ] as const) {
        if (!id) continue;
        const audio = await assetFile(id),
          ai = await probe(audio.path);
        if (!ai.streams?.some((s: Doc) => s.codec_type === "audio"))
          throw new AppError(400, "音频素材没有有效音轨");
        if (loop) args.push("-stream_loop", "-1");
        args.push("-i", audio.path);
        filters.push(
          `[${inputIndex}:a]volume=${vol},apad,atrim=duration=${duration}[a${inputIndex}]`,
        );
        tracks.push(`[a${inputIndex}]`);
        inputIndex++;
      }
      if (!tracks.length) {
        filters.push(
          `anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[silent]`,
        );
        tracks.push("[silent]");
      }
      filters.push(
        `${tracks.join("")}amix=inputs=${tracks.length}:duration=longest:normalize=0,alimiter=limit=0.95,aresample=48000[aout]`,
      );
      if (b.burnCaptions && b.captions.length) {
        // SRT is generated from validated plain text; file name and ASS style are fixed by the server.
        const clean = b.captions.map((c) => ({
          ...c,
          text: c.text.replace(/<[^>]*>/g, "").replace(/[{}\\]/g, ""),
        }));
        await writeFile(
          join(folder, "captions.srt"),
          serializeSubtitles(clean),
        );
        const fontFamily = await prepareSubtitleFont(
          folder,
          clean.map((c) => c.text).join("\n"),
        );
        const stream = info.streams.find((s: Doc) => s.codec_type === "video");
        await writeFile(
          join(folder, "captions.ass"),
          subtitleAss(
            clean,
            fontFamily,
            b.captionSize,
            Number(stream.width),
            Number(stream.height),
          ),
        );
        filters.push(
          "[0:v]subtitles=filename=captions.ass:fontsdir=fonts[vout]",
        );
      }
      args.push(
        "-filter_complex",
        filters.join(";"),
        "-map",
        b.burnCaptions && b.captions.length ? "[vout]" : "0:v:0",
        "-map",
        "[aout]",
        "-t",
        String(duration),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "21",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-threads",
        "2",
        "-movflags",
        "+faststart",
        join(folder, "edited.mp4"),
      );
      await run(ffmpegPath(), args, {
        cwd: folder,
        timeout: 900000,
        maxBuffer: 1000000,
      });
      const output = join(folder, "edited.mp4"),
        result = await probe(output);
      if ((await stat(output)).size > 100 * 1024 * 1024)
        throw new AppError(413, "后期成片超过 100MB");
      if (Math.abs(Number(result.format?.duration) - duration) > 0.25)
        throw new AppError(502, "后期成片时长校验失败");
      asset = await saveMedia(await readFile(output), "video/mp4", b.name, {
        jobId,
        editSignature: signature,
        sourceAssetId: b.assetId,
        voiceAssetId: b.voiceAssetId,
        musicAssetId: b.musicAssetId,
        duration,
        edited: true,
      });
    }
    if (b.coverTime !== undefined && !coverAsset) {
      const media = await assetFile(asset!.id);
      await run(
        ffmpegPath(),
        [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-ss",
          String(b.coverTime),
          "-i",
          media.path,
          "-frames:v",
          "1",
          "-q:v",
          "2",
          join(folder, "cover.jpg"),
        ],
        { timeout: 60000, maxBuffer: 1000000 },
      );
      coverAsset = await saveMedia(
        await readFile(join(folder, "cover.jpg")),
        "image/jpeg",
        `${b.name} · 封面`,
        {
          jobId,
          editSignature: signature,
          sourceAssetId: asset!.id,
          coverTime: b.coverTime,
        },
      );
    }
    return {
      asset,
      coverAsset,
      subtitles: b.captions,
      subtitleSrt: serializeSubtitles(b.captions),
      subtitleVtt: serializeSubtitles(b.captions, "vtt"),
      sourceAssetId: b.assetId,
    };
  } catch (e: any) {
    if (e instanceof AppError || e instanceof z.ZodError) throw e;
    console.error(
      "Video edit",
      e.code || e.name,
      String(e.stderr || "").slice(-600),
    );
    throw new AppError(
      502,
      "本地后期处理失败，请检查素材格式及 FFmpeg 字幕支持；原片已保留",
      "VIDEO_EDIT_FAILED",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
export const videoEditRoutes = Router();
videoEditRoutes.post("/video/subtitles/convert", async (req, res) => {
  const b = z
    .object({
      text: z.string().max(1000000).optional(),
      cues: z.array(cueSchema).max(500).optional(),
    })
    .refine((x) => x.text !== undefined || x.cues !== undefined)
    .parse(req.body);
  const cues =
    b.text !== undefined ? parseSubtitles(b.text) : validateCues(b.cues!);
  res.json({
    cues,
    srt: serializeSubtitles(cues),
    vtt: serializeSubtitles(cues, "vtt"),
  });
});
videoEditRoutes.post("/video/edits", async (req, res) => {
  const b = z
    .object({
      input: videoEditSchema,
      dedupeKey: z
        .string()
        .min(1)
        .max(128)
        .default(() => randomUUID()),
    })
    .parse(req.body);
  res.status(201).json(await createJob("video_edit", b.input, b.dedupeKey));
});
