import "../server/env.ts";
import assert from "node:assert/strict";
import express from "express";
import { projectRoutes, reconcileProjects } from "../server/projects.ts";
import { videoEditRoutes, runVideoEdit } from "../server/video-edit.ts";
import { quoteRoutes } from "../server/quotes.ts";
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
import { createJob, retryJob, refreshJob, tick } from "../server/jobs.ts";
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
const testApp = express();
testApp.use(express.json());
testApp.use((req, _res, next) =>
  inWorkspace(String(req.headers["x-test-workspace"] || ws), () => next()),
);
testApp.use("/api", projectRoutes, videoEditRoutes, quoteRoutes);
testApp.use((e: any, _req: any, res: any, _next: any) =>
  res.status(e.status || 400).json({ error: e.message }),
);
const testServer = testApp.listen(0, "127.0.0.1");
await new Promise<void>((r) => testServer.once("listening", r));
const base = "http://127.0.0.1:" + (testServer.address() as any).port;
async function request(path: string, body?: Doc, method = "POST", tenant = ws) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: { "Content-Type": "application/json", "x-test-workspace": tenant },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
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
    // Exercise the real eight-connection pool with a worker lock plus six
    // completed provider tasks simultaneously producing local media.
    const concurrentIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = randomUUID(),
        provider = {
          ...parse(r.provider),
          concatStatus: "pending",
          stage: "generating",
        };
      concurrentIds.push(id);
      await execute(
        "INSERT INTO jobs(id,workspace_id,kind,status,input,provider,result) VALUES(?,?, 'video','processing',?,?,?)",
        [
          id,
          ws,
          JSON.stringify({ ...parse(r.input), _localComposeOnly: true }),
          JSON.stringify(provider),
          JSON.stringify(parse(r.result)),
        ],
      );
    }
    let deadline: ReturnType<typeof setTimeout>;
    await Promise.race([
      tick(ws),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("polling exhausted the connection pool")),
          30000,
        );
      }),
    ]).finally(() => clearTimeout(deadline!));
    check(
      (
        await rows(
          "SELECT id FROM jobs WHERE workspace_id=? AND status='completed' AND id IN (" +
            concurrentIds.map(() => "?").join(",") +
            ")",
          [ws, ...concurrentIds],
        )
      ).length === 6,
      "six simultaneous completions do not exhaust the eight-connection pool",
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
    const audioPath = join(folder, "voice.wav");
    await run(ffmpegPath(), [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=700:duration=1",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ]);
    const audio = await saveMedia(
      await readFile(audioPath),
      "audio/wav",
      "Offline voice",
    );
    const editInput = {
      assetId: final.asset.id,
      name: "Offline captioned video",
      captions: [
        { start: 0, end: 1, text: "商品演示 Product" },
        { start: 1, end: 2, text: "Second shot" },
      ],
      burnCaptions: true,
      voiceAssetId: audio!.id,
      musicAssetId: audio!.id,
      originalVolume: 0,
      voiceVolume: 0.8,
      musicVolume: 0.1,
      coverTime: 0.5,
    };
    const editRequest = await request("/video/edits", {
      input: editInput,
      dedupeKey: "local-edit",
    });
    check(
      editRequest.status === 201,
      "local post-production queues through HTTP without any model keys",
    );
    const edited = await runVideoEdit(editInput, editRequest.data.id);
    const editedFile = await assetFile(edited.asset!.id),
      editedInfo = await probe(editedFile.path);
    check(
      Math.abs(Number(editedInfo.format.duration) - 2) < 0.25 &&
        editedInfo.streams.some((s: Doc) => s.codec_type === "audio"),
      "caption burn-in and uploaded voice/music produce a real MP4 with the expected duration/audio",
    );
    check(
      edited.subtitleSrt.includes("商品演示") &&
        edited.subtitleVtt.startsWith("WEBVTT") &&
        !!edited.coverAsset?.id,
      "post-production returns SRT, VTT and a separately downloadable cover asset",
    );
    const twice = await runVideoEdit(editInput, editRequest.data.id);
    check(
      twice.asset!.id === edited.asset!.id &&
        twice.coverAsset!.id === edited.coverAsset!.id,
      "recovered local edits reuse already saved video and cover",
    );
    await assert.rejects(
      () =>
        runVideoEdit(
          { ...editInput, captions: [{ start: 0, end: 5, text: "too long" }] },
          randomUUID(),
        ),
      /超过成片/,
    );
    count++;
    console.log("PASS captions outside actual video duration are rejected");
    const image = await saveMedia(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6K2AAAAAASUVORK5CYII=",
        "base64",
      ),
      "image/png",
      "Studio product",
    );
    const project = await request("/projects", {
      name: "Studio revision fixture",
      input: { prompt: "product", assetIds: [image!.id], duration: 2 },
    });
    check(project.status === 201, "studio project created through HTTP");
    const foreignProject = await request(
      "/projects",
      {
        name: "foreign asset",
        input: { prompt: "product", assetIds: [image!.id] },
      },
      "POST",
      ws + "-outsider",
    );
    check(
      foreignProject.status === 404,
      "project save rejects foreign workspace product images before task submission",
    );
    const invalidProject = await request("/projects", {
      name: "invalid input",
      input: { prompt: "x".repeat(17000), assetIds: [image!.id] },
    });
    check(
      invalidProject.status === 400,
      "project creation validates bounded prompt/schema instead of storing arbitrary task input",
    );
    const foreignCase = randomUUID();
    await execute(
      "INSERT INTO commerce_entries(id,workspace_id,kind,body) VALUES(?,?,?,?)",
      [
        foreignCase,
        ws + "-outsider",
        "cases",
        JSON.stringify({ title: "private" }),
      ],
    );
    const linkedForeign = await request(
      `/projects/${project.data.id}`,
      {
        version: 1,
        input: { ...project.data.input, sourceCaseId: foreignCase },
      },
      "PATCH",
    );
    check(
      linkedForeign.status === 404,
      "project patch rejects foreign case lineage before persisting it",
    );
    const manual = await request(
      `/projects/${project.data.id}`,
      { version: 1, modifiedData: board },
      "PATCH",
    );
    check(
      manual.status === 200 && manual.data.status === "waiting_confirmation",
      "manual storyboard moves a draft to confirmation without Gemini",
    );
    const copy = await request(`/projects/${project.data.id}/duplicate`, {});
    check(
      copy.status === 201 &&
        copy.data.parent_id === project.data.id &&
        copy.data.script.scenes.length === 2,
      "project duplication retains editable storyboard and source lineage",
    );
    await execute(
      "UPDATE projects SET status='completed',render_job_ids=? WHERE id=? AND workspace_id=?",
      [JSON.stringify([retry.id]), project.data.id, ws],
    );
    const replaceBody = {
      segmentIndex: 0,
      action: "replace",
      assetId: parse(r.provider).segments[1].asset.id,
      dedupeKey: "replace-once",
    };
    const revision = await request(
      `/projects/${project.data.id}/renders/${retry.id}/revise`,
      replaceBody,
    );
    check(
      revision.status === 201,
      "successful segment can be replaced without model credentials",
    );
    const revised = (await jobGet(revision.data.id))!,
      rp = parse(revised.provider);
    check(
      rp.segments[1].asset.id === oldAssets[1] &&
        rp.segments[0].asset.id === replaceBody.assetId,
      "replacement preserves all other segments",
    );
    const beforeSubmit = submits;
    await advancePipeline(revised, deps);
    check(
      (await jobGet(revision.data.id))!.status === "completed" &&
        submits === beforeSubmit,
      "replacement composes locally without another provider submission",
    );
    check(
      (await assetFile(final.asset.id)).asset.id === final.asset.id,
      "original completed video remains downloadable after revision",
    );
    const duplicateRevision = await request(
      `/projects/${project.data.id}/renders/${retry.id}/revise`,
      replaceBody,
    );
    check(
      duplicateRevision.data.id === revision.data.id,
      "repeated segment revision returns the same job",
    );
    const conflict = await request(
      `/projects/${project.data.id}/renders/${retry.id}/revise`,
      { ...replaceBody, segmentIndex: 1 },
    );
    check(
      conflict.status === 409,
      "same revision request key cannot mutate a different segment",
    );
    const foreign = await request(
      `/projects/${project.data.id}/history`,
      undefined,
      "GET",
      ws + "-outsider",
    );
    check(foreign.status === 404, "project history is isolated by workspace");
    const batchBody = {
      name: "Batch fixture",
      products: [
        { name: "Product", prompt: "Own product", assetIds: [image!.id] },
      ],
      languages: ["English", "Español"],
      variants: 2,
      defaults: { duration: 8, videoModelId: "kie-seedance-mini" },
      dedupeKey: "batch-once",
    };
    const batch = await request("/projects/batch", batchBody),
      again = await request("/projects/batch", batchBody);
    check(
      batch.status === 201 &&
        batch.data.projectCount === 2 &&
        batch.data.videoCount === 4 &&
        again.data.id === batch.data.id,
      "batch expansion and duplicate requests create exactly one explicit product-language batch",
    );
    const ruleBody = {
      modelId: "kie-seedance-mini",
      resolution: "480p",
      unit: "second",
      amount: 0.02,
      currency: "USD",
      source: "Offline fixture contract",
      priceCheckedAt: "2026-10-19T00:00:00.000Z",
    };
    const rule = await request("/quotes/rules", ruleBody, "PUT");
    const foreignQuote = await request(
      "/quotes/rules",
      { ...ruleBody, id: rule.data[0].id, amount: 999 },
      "PUT",
      ws + "-outsider",
    );
    const rulesAgain = await request("/quotes/rules", undefined, "GET");
    check(
      foreignQuote.status === 200 && rulesAgain.data[0].amount === 0.02,
      "quote rule ids cannot overwrite another workspace's prices",
    );
    await reconcileProjects();
    const history = await request(
      `/projects/${project.data.id}/history`,
      undefined,
      "GET",
    );
    check(
      history.data.revisions.length === 1 &&
        history.data.tasks.some((t: Doc) => t.id === retry.id),
      "revision history retains original and revised render attempts",
    );
    await saveConfig({ FAL_KEY: "offline-test-fixture" });
    const replacementJob = (await jobGet(revision.data.id))!;
    const regenBody = {
      segmentIndex: 0,
      action: "regenerate",
      prompt: "New scene prompt",
      dedupeKey: "regenerate-once",
    };
    const regenPreview = await request(
      `/projects/${project.data.id}/renders/${revision.data.id}/revision-preview`,
      regenBody,
    );
    const regenerated = await request(
      `/projects/${project.data.id}/renders/${revision.data.id}/revise`,
      { ...regenBody, quoteFingerprint: regenPreview.data.quote.fingerprint },
    );
    check(
      regenerated.status === 201,
      "successful segment regeneration creates a new billed attempt with quote snapshot",
    );
    const regenBefore = submits;
    for (let step = 0; step < 10; step++) {
      const current = (await jobGet(regenerated.data.id))!;
      if (current.status === "completed") break;
      await advancePipeline(current, deps);
    }
    const regenRow = (await jobGet(regenerated.data.id))!;
    check(
      regenRow.status === "completed" &&
        submits - regenBefore === 2 &&
        parse(regenRow.provider).segments[1].asset.id ===
          parse(replacementJob.provider).segments[1].asset.id,
      "regeneration only submits the changed segment's frame/video and reuses the other segment",
    );
    const previewInput = {
      ...copy.data.input,
      prompt: copy.data.script.shootingPrompt,
    };
    const initialQuote = (
      await request("/quotes/preview", {
        input: previewInput,
        storyboard: copy.data.script,
        count: 2,
      })
    ).data;
    await request(
      "/quotes/rules",
      {
        ...ruleBody,
        modelId: "kling-standard",
        resolution: "720p",
        unit: "request",
        amount: 0.5,
      },
      "PUT",
    );
    const staleConfirm = await request(`/projects/${copy.data.id}/confirm`, {
      version: copy.data.version,
      modifiedData: copy.data.script,
      videoGenerationCount: 2,
      quoteFingerprint: initialQuote.fingerprint,
    });
    check(
      staleConfirm.status === 409,
      "confirmation rejects a changed provider price snapshot before queuing",
    );
    const freshQuote = (
      await request("/quotes/preview", {
        input: previewInput,
        storyboard: copy.data.script,
        count: 2,
      })
    ).data;
    const confirmed = await request(`/projects/${copy.data.id}/confirm`, {
      version: copy.data.version,
      modifiedData: copy.data.script,
      videoGenerationCount: 2,
      quoteFingerprint: freshQuote.fingerprint,
    });
    check(
      confirmed.status === 200 && confirmed.data.jobIds.length === 2,
      "confirmation queues requested variant count with a current quote",
    );
    const confirmedJob = (await jobGet(confirmed.data.jobIds[0]))!;
    const [snapshot] = await rows(
      "SELECT quote_snapshot FROM project_confirmations WHERE project_id=?",
      [copy.data.id],
    );
    check(
      parse(snapshot.quote_snapshot).fingerprint === freshQuote.fingerprint &&
        parse(confirmedJob.input)._quoteSnapshot.fingerprint ===
          freshQuote.fingerprint,
      "quote snapshot is frozen in confirmation and every render job",
    );
    await execute("UPDATE jobs SET status='completed' WHERE id=?", [
      confirmed.data.jobIds[0],
    ]);
    await execute("UPDATE jobs SET status='failed' WHERE id=?", [
      confirmed.data.jobIds[1],
    ]);
    await reconcileProjects();
    const partial = await request(
      `/projects/${copy.data.id}`,
      undefined,
      "GET",
    );
    check(
      partial.data.status === "partially_completed",
      "mixed completed/failed variants have an explicit partial success state",
    );
    const retryPreview = await request(
      `/projects/${copy.data.id}/retry-quote`,
      undefined,
      "GET",
    );
    check(
      (await request(`/projects/${copy.data.id}/retry`, {})).status === 400,
      "video retry requires explicit quote confirmation",
    );
    check(
      (
        await request(`/projects/${copy.data.id}/retry`, {
          confirm: true,
          fingerprint: "0".repeat(64),
        })
      ).status === 409,
      "stale retry quote cannot submit provider requests",
    );
    const partialRetry = await request(`/projects/${copy.data.id}/retry`, {
      confirm: true,
      fingerprint: retryPreview.data.fingerprint,
    });
    check(
      partialRetry.status === 200 &&
        partialRetry.data.render_job_ids[0] === confirmed.data.jobIds[0] &&
        partialRetry.data.render_job_ids[1] !== confirmed.data.jobIds[1],
      "partial success retry preserves successful variant and creates only a failed-variant attempt",
    );
    console.log(
      `Video integration complete: ${count} checks. Real MySQL and FFmpeg, injected offline provider fixtures; no paid generation.`,
    );
  });
} finally {
  await new Promise<void>((r) => testServer.close(() => r()));
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
    "projects",
    "project_confirmations",
    "project_batches",
    "project_render_revisions",
    "project_script_versions",
    "video_quote_rules",
    "asset_references",
    "audit_log",
  ])
    await execute(`DELETE FROM ${table} WHERE workspace_id=?`, [ws]);
  await execute("DELETE FROM commerce_entries WHERE workspace_id=?", [
    ws + "-outsider",
  ]);
  await execute("DELETE FROM video_quote_rules WHERE workspace_id=?", [
    ws + "-outsider",
  ]);
  await execute("DELETE FROM audit_log WHERE workspace_id=?", [
    ws + "-outsider",
  ]);
  await execute("DELETE FROM settings WHERE id=?", [
    "p-" + createHash("sha256").update(ws).digest("hex").slice(0, 30),
  ]);
  await rm(folder, { recursive: true, force: true });
  await lock.query("SELECT RELEASE_LOCK('x_ecommerce_worker')");
  lock.release();
  await pool.end();
}
