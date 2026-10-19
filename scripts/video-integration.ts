import "../server/env.ts";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  pool,
  migrate,
  execute,
  rows,
  jobGet,
  parse,
  job,
  type Doc,
} from "../server/db.ts";
import { inWorkspace } from "../server/context.ts";
import { saveConfig, config, publicConfig } from "../server/config.ts";
import { createKieClient } from "../server/kie.ts";
import { createJob, retryJob, refreshJob } from "../server/jobs.ts";
import {
  initializePipeline,
  advancePipeline,
  type PipelineDependencies,
} from "../server/video-pipeline.ts";
import {
  composeVideo,
  ffmpegPath,
  probe,
  mediaToolsReady,
} from "../server/video-compose.ts";
import { assetFile, saveMedia } from "../server/media.ts";
const run = promisify(execFile),
  ws = "video-qa-" + randomUUID().slice(0, 8),
  folder = await mkdtemp(join(tmpdir(), "x-ecom-video-qa-"));
let count = 0;
function check(value: any, message: string) {
  assert.ok(value, message);
  console.log("PASS " + message);
  count++;
}
await migrate();
await mediaToolsReady();
const lock = await pool.getConnection();
const [locked]: any = await lock.query(
  "SELECT GET_LOCK('x_ecommerce_worker',20) acquired",
);
assert.equal(Number(locked[0].acquired), 1);
try {
  await inWorkspace(ws, async () => {
    await saveConfig({
      FAL_KEY: "offline-test-fixture",
      GEMINI_API_KEY: "offline-test-fixture",
    });
    const a = join(folder, "red.mp4"),
      b = join(folder, "blue.mp4");
    await run(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:r=30:d=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      a,
    ]);
    await run(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=180x320:r=25:d=3",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      b,
    ]);
    const board = {
      shootingPrompt: "offline storyboard",
      scenes: [
        { time: "0-1s", visual: "red" },
        { time: "1-2s", visual: "blue" },
      ],
    };
    const input = {
      prompt: "offline product",
      assetIds: ["fixture"],
      duration: 2,
      segmentStrategy: "shots",
      segmentSeconds: 3,
      storyboard: board,
    };
    const created = await createJob(
      "video",
      input,
      "offline-" + randomUUID(),
      undefined,
      true,
    );
    await initializePipeline(
      created.id,
      parse((await jobGet(created.id))!.input),
      board,
    );
    // DB JSON is returned as a string by some drivers; use the same decoder as workers.
    const initial = await jobGet(created.id);
    if (!parse(initial!.provider)?.plan)
      throw new Error("missing durable plan");
    let submits = 0,
      composeCalls = 0,
      failConcat = true;
    const requests = new Map<string, string>();
    const deps: PipelineDependencies = {
      falClient: async () =>
        ({
          queue: {
            submit: async (model: string) => {
              const id = String(++submits);
              requests.set(id, model);
              return { request_id: id };
            },
            status: async () => ({ status: "COMPLETED" }),
            result: async (model: string) => ({
              data:
                model === "frame"
                  ? { images: [{ url: "https://fixture.invalid/frame.png" }] }
                  : {
                      video: {
                        url:
                          submits <= 2
                            ? "https://fixture.invalid/red.mp4"
                            : "https://fixture.invalid/blue.mp4",
                      },
                    },
            }),
          },
        }) as any,
      falInput: async () => ({
        model: "video",
        payload: {},
        frame: { model: "frame", payload: {} },
      }),
      fetchMedia: async (url: string) => ({
        bytes: await readFile(url.includes("red") ? a : b),
        mime: "video/mp4",
      }),
      saveMedia,
      assetFile,
      composeVideo: async (...args) => {
        composeCalls++;
        if (failConcat) throw new Error("intentional offline concat failure");
        return composeVideo(...args);
      },
    };
    for (let i = 0; i < 12; i++) {
      const r = await jobGet(created.id);
      if (r!.status === "failed") break;
      await advancePipeline(r!, deps);
    }
    let r = (await jobGet(created.id))!;
    check(
      r.status === "failed" && parse(r.provider).concatStatus === "failed",
      "concat failure cannot mark the job complete",
    );
    check(
      submits === 4 &&
        parse(r.provider).segments.every((s: Doc) => s.status === "completed"),
      "two saved segments require exactly four fixture submissions",
    );
    const oldAssets = parse(r.provider).segments.map((s: Doc) => s.asset.id);
    await saveConfig({ clearSecrets: ["FAL_KEY", "GEMINI_API_KEY"] });
    const retry = await retryJob(created.id);
    const duplicateRetry = await retryJob(created.id);
    check(
      duplicateRetry.id === retry.id,
      "repeated retry requests reuse one task even after provider credentials are removed",
    );
    r = (await jobGet(retry.id))!;
    check(
      r.status === "processing" &&
        parse(r.provider)
          .segments.map((s: Doc) => s.asset.id)
          .join() === oldAssets.join(),
      "retry persists successful segment references without regenerating",
    );
    failConcat = false;
    await advancePipeline(r, deps);
    r = (await jobGet(retry.id))!;
    check(
      r.status === "completed" &&
        parse(r.provider).concatStatus === "completed",
      "only a saved composed MP4 completes the pipeline",
    );
    check(
      submits === 4 && composeCalls === 2,
      "concat retry performs no provider calls",
    );
    const final = await assetFile(parse(r.result).asset.id),
      info = await probe(final.path);
    check(
      Math.abs(Number(info.format.duration) - 2) < 0.2,
      "final duration matches the two one-second segments",
    );
    const stream = info.streams.find((s: Doc) => s.codec_type === "video");
    check(
      stream.width === 720 &&
        stream.height === 1280 &&
        stream.r_frame_rate === "24/1",
      "mixed source sizes and frame rates normalize to 720 × 1280 at 24fps",
    );
    check(
      info.streams.some(
        (s: Doc) =>
          s.codec_type === "audio" &&
          s.sample_rate === "48000" &&
          s.channels === 2,
      ),
      "missing audio is padded and all clips have stereo 48kHz audio",
    );
    async function pixel(at: string) {
      const { stdout } = await run(
        ffmpegPath(),
        [
          "-v",
          "error",
          "-ss",
          at,
          "-i",
          final.path,
          "-frames:v",
          "1",
          "-vf",
          "crop=2:2:359:639,format=rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { encoding: "buffer", maxBuffer: 100000 },
      );
      return stdout;
    }
    const first = await pixel("0.3"),
      second = await pixel("1.4");
    check(
      first[0] > first[2] + 100 && second[2] > second[0] + 100,
      "composed frames preserve red-then-blue storyboard order",
    );
    check(
      job(r).pipeline?.segments.length === 2 &&
        job(r).pipeline?.concatStatus === "completed",
      "public job detail exposes safe segment and concat progress",
    );
    await refreshJob(retry.id);
    check(
      submits === 4,
      "refreshing a terminal job does not start more requests",
    );
    await assert.rejects(
      () => composeVideo([{ path: a, duration: 4 }], "9:16", "360p"),
      /短于计划/,
    );
    count++;
    console.log("PASS short source clips are rejected before concatenation");
    const fractional = await composeVideo(
      Array.from({ length: 12 }, (_, i) => ({
        path: i % 2 ? a : b,
        duration: 0.3,
      })),
      "16:9",
      "360p",
    );
    check(
      Math.abs(fractional.duration - 3.6) < 0.2,
      "twelve short clips do not accumulate material timing drift",
    );
    await assert.rejects(
      () =>
        createJob(
          "video",
          { ...input, _videoPolicy: {} },
          "untrusted-" + randomUUID(),
        ),
      /内部任务字段/,
    );
    count++;
    console.log("PASS client-supplied execution snapshots are rejected");
    // The real adapter and durable pipeline run against offline HTTP fixtures,
    // with only a Kie credential configured and actual 480p FFmpeg composition.
    await saveConfig({
      KIE_API_KEY: "offline-kie-fixture",
      clearSecrets: ["FAL_KEY", "GEMINI_API_KEY"],
    });
    const settings = await publicConfig();
    check(
      settings.secrets.KIE_API_KEY &&
        settings.connections.kie &&
        !JSON.stringify(settings).includes("offline-kie-fixture"),
      "Kie secret is encrypted and masked in public settings",
    );
    await saveConfig({ KIE_API_KEY: "" });
    check(
      (await config()).KIE_API_KEY === "offline-kie-fixture",
      "blank Kie key preserves the configured credential",
    );
    for (const videoModelId of ["kie-seedance-mini", "kie-veo-fast"]) {
      const calls: Doc[] = [];
      const http: typeof fetch = async (url, options) => {
        if (options?.method === "POST") {
          const body = JSON.parse(String(options.body));
          calls.push(body);
          return new Response(
            JSON.stringify({
              code: 200,
              data: { taskId: `kie-${calls.length}` },
            }),
          );
        }
        const id = new URL(String(url)).searchParams.get("taskId");
        return new Response(
          JSON.stringify({
            code: 200,
            data: {
              taskId: id,
              state: "success",
              resultJson: JSON.stringify({
                resultUrls: [`https://fixture.example/${id}.mp4`],
              }),
            },
          }),
        );
      };
      const kieJob = await createJob(
        "video",
        {
          ...input,
          videoModelId,
          resolution: videoModelId === "kie-seedance-mini" ? "480p" : "720p",
        },
        "kie-" + randomUUID(),
        undefined,
        true,
      );
      let row = (await jobGet(kieJob.id))!;
      await initializePipeline(kieJob.id, parse(row.input), board);
      const kieDeps: PipelineDependencies = {
        ...deps,
        falClient: async () => {
          throw new Error("Kie product mode must not need fal");
        },
        kieAsset: async () => "https://fixture.example/product.png",
        kieClient: async () => createKieClient("offline-kie-fixture", http),
        fetchMedia: async () => ({
          bytes: await readFile(a),
          mime: "video/mp4",
        }),
        composeVideo,
      };
      for (let step = 0; step < 15; step++) {
        row = (await jobGet(kieJob.id))!;
        if (["failed", "completed", "review"].includes(row.status)) break;
        await advancePipeline(row, kieDeps);
      }
      row = (await jobGet(kieJob.id))!;
      check(
        row.status === "completed",
        `${videoModelId} completes from persisted requests to real composition without fal/Gemini credentials`,
      );
      check(
        calls.length === 2 &&
          calls.every(
            (c) =>
              c.model ===
              (videoModelId === "kie-seedance-mini"
                ? "bytedance/seedance-2-mini"
                : "veo-3-1"),
          ),
        `${videoModelId} submits one Kie call per segment without AI-frame calls`,
      );
      const file = await assetFile(parse(row.result).asset.id);
      const info = await probe(file.path);
      const video = info.streams.find((s: Doc) => s.codec_type === "video");
      check(
        video.width === (videoModelId === "kie-seedance-mini" ? 480 : 720) &&
          Math.abs(Number(info.format.duration) - 2) < 0.2,
        `${videoModelId} retains selected output resolution and storyboard duration`,
      );
    }
    await saveConfig({ clearSecrets: ["KIE_API_KEY"] });
    check(
      !(await publicConfig()).secrets.KIE_API_KEY,
      "Kie credential can be explicitly cleared",
    );
    console.log(
      `Video integration complete: ${count} checks. Real MySQL and FFmpeg, injected offline provider fixtures; no paid generation.`,
    );
  });
} finally {
  const assets = await rows(
    "SELECT body FROM records WHERE workspace_id=? AND kind='asset'",
    [ws],
  );
  for (const asset of assets) {
    const v = parse(asset.body);
    if (v.filename)
      await unlink(resolve(".local/uploads", v.filename)).catch(() => {});
  }
  for (const table of [
    "records",
    "jobs",
    "credit_reservations",
    "credit_ledger",
    "credit_wallets",
    "api_usage",
  ])
    await execute(`DELETE FROM ${table} WHERE workspace_id=?`, [ws]);
  await execute("DELETE FROM settings WHERE id=?", [
    "p-" + createHash("sha256").update(ws).digest("hex").slice(0, 30),
  ]);
  await rm(folder, { recursive: true, force: true });
  await lock.query("SELECT RELEASE_LOCK('x_ecommerce_worker')");
  lock.release();
  await pool.end();
}
