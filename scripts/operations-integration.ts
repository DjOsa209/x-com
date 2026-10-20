import "../server/env.ts";
import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pool,
  migrate,
  execute,
  rows,
  parse,
  jobGet,
  put,
} from "../server/db.ts";
import { inWorkspace } from "../server/context.ts";
import { operationsRoutes } from "../server/operations.ts";
import { automationRoutes } from "../server/automations.ts";
import { saveMedia, assetFile } from "../server/media.ts";
import { ffmpegPath } from "../server/video-compose.ts";
import { saveConfig, seal } from "../server/config.ts";
import { echoQuery } from "../server/echotik.ts";
import {
  syncContentMetrics,
  reconcileOperations,
} from "../server/operations.ts";
import { assetReferences } from "../server/asset-references.ts";
import {
  withResearchRun,
  withResearchBudgetRequest,
  recordResearchEvidence,
} from "../server/research-budget.ts";
await migrate();
const originalFetch = globalThis.fetch;
const wa = "ops-a-" + randomUUID().slice(0, 8),
  wb = "ops-b-" + randomUUID().slice(0, 8),
  directory = await mkdtemp(join(tmpdir(), "xe-ops-test-"));
let assetPath = "",
  checks = 0;
const lock = await pool.getConnection();
const [locked]: any = await lock.query(
  "SELECT GET_LOCK('x_ecommerce_worker',20) acquired",
);
assert.equal(Number(locked[0].acquired), 1);
const app = express();
app.use(express.json());
app.use((req, _res, next) =>
  inWorkspace(String(req.headers["x-test-workspace"] || wa), next),
);
app.use("/api", operationsRoutes, automationRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res
    .status(error.status || (error.name === "ZodError" ? 400 : 500))
    .json({ error: error.message, code: error.code }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as any).port;
async function request(path: string, method = "GET", body?: any, ws = wa) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: { "Content-Type": "application/json", "x-test-workspace": ws },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
function check(value: any, message: string) {
  assert.ok(value, message);
  checks++;
  console.log("PASS " + message);
}
try {
  for (const id of [wa, wb])
    await execute("INSERT INTO workspaces(id,name) VALUES(?,?)", [
      id,
      "Operations fixture",
    ]);
  const path = join(directory, "video.mp4");
  await promisify(execFile)(ffmpegPath(), [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=360x640:r=30",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  // Generate a real MP4 and test the exact local export path; no provider is used.
  const video = await inWorkspace(wa, async () =>
    saveMedia(await readFile(path), "video/mp4", "Operations fixture video"),
  );
  assetPath = (await inWorkspace(wa, () => assetFile(video!.id))).path;
  let r = await request("/publications", "POST", {
    title: "Test export",
    assetId: video!.id,
    caption: "Product copy",
    subtitleSrt: "1\n00:00:00,000 --> 00:00:01,000\nFixture\n",
  });
  check(
    r.status === 201 && r.body.mode === "export",
    "publication defaults to export",
  );
  const id = r.body.id;
  r = await request("/publications/" + id, "GET", undefined, wb);
  check(r.status === 404, "cross-workspace publication read denied");
  r = await request("/publications/" + id + "/approve", "POST", {
    confirm: false,
  });
  check(r.status === 400, "explicit publication review required");
  r = await request("/publications/" + id + "/approve", "POST", {
    confirm: true,
  });
  check(r.body.status === "approved", "review stores approved version");
  const archive = await fetch(base + "/api/publications/" + id + "/export", {
      headers: { "x-test-workspace": wa },
    }),
    bytes = Buffer.from(await archive.arrayBuffer());
  check(
    archive.status === 200 && bytes.readUInt32LE(0) === 0x04034b50,
    "export returns a real ZIP archive",
  );
  check(
    [
      "video.mp4",
      "cover.jpg",
      "caption.txt",
      "subtitles.srt",
      "publication.json",
    ].every((name) => bytes.includes(Buffer.from(name))),
    "export includes video cover subtitles copy and metadata",
  );
  check(
    (await inWorkspace(wa, () => assetReferences(video!.id))).some(
      (r) => r.kind === "publication",
    ),
    "publication protects referenced media",
  );
  r = await request("/publications/" + id, "PATCH", { caption: "Changed" });
  check(
    r.body.status === "draft" && !r.body.approval,
    "editing invalidates review",
  );
  r = await request("/publications/" + id + "/manual", "POST", {
    url: "https://www.tiktok.com/@fixture/video/1234567890",
  });
  check(
    r.body.status === "published" && r.body.externalId === "1234567890",
    "manual publication records a real permalink",
  );
  r = await request("/publications/" + id + "/metrics", "POST", {
    views: 0,
    likes: 4,
    orders: null,
    gmv: null,
    note: "local fixture",
  });
  check(r.status === 200, "manual metrics snapshot accepted");
  r = await request("/content-analytics");
  check(
    r.body.items[0].metrics.views === 0 && r.body.items[0].metrics.gmv === null,
    "analytics distinguishes zero and unknown",
  );
  r = await request("/content-analytics", "GET", undefined, wb);
  check(r.body.total === 0, "analytics workspace isolation");
  const direct = await request("/publications", "POST", {
    title: "Direct disabled",
    assetId: video!.id,
    mode: "direct",
  });
  await request(`/publications/${direct.body.id}/approve`, "POST", {
    confirm: true,
  });
  r = await request(`/publications/${direct.body.id}/dispatch`, "POST", {
    confirm: true,
  });
  check(
    r.status === 409 && r.body.code === "TIKTOK_MODE_DISABLED",
    "default export mode blocks official posting before network calls",
  );
  r = await request("/automations", "POST", {
    name: "unsafe",
    kind: "publish",
    input: {},
    intervalMinutes: 60,
  });
  check(r.status === 400, "automation rejects posting kind");
  r = await request("/automations", "POST", {
    name: "unsafe",
    kind: "collect",
    input: { extractPrompts: true },
    intervalMinutes: 60,
  });
  check(
    r.status === 400,
    "automatic collection cannot start video analysis children",
  );
  await inWorkspace(wa, () =>
    saveConfig({
      ECHOTIK_USERNAME: "offline-fixture",
      ECHOTIK_PASSWORD: "offline-fixture",
    }),
  );
  r = await request("/automations", "POST", {
    name: "Research",
    kind: "collect",
    input: { region: "US" },
    intervalMinutes: 60,
    budget: { maxRequests: 2, dailyRequestLimit: 5 },
  });
  check(r.status === 201, "research automation created with explicit budget");
  const automationId = r.body.id;
  r = await request(`/automations/${automationId}/run`, "POST", {});
  check(
    r.status === 200 && r.body.researchRunId,
    "manual research run preserves an execution record",
  );
  const jid = r.body.id;
  let sent = 0;
  const result = await inWorkspace(wa, async () =>
    withResearchRun((await jobGet(jid))!, async () => {
      await recordResearchEvidence({ sample: "retained" });
      await withResearchBudgetRequest("fixture", "/success", async () => {
        sent++;
        return true;
      });
      try {
        await withResearchBudgetRequest("fixture", "/failure", async () => {
          sent++;
          throw new Error("network fixture");
        });
      } catch {}
      return withResearchBudgetRequest("fixture", "/blocked", async () => {
        sent++;
        return true;
      });
    }),
  );
  check(
    (result as any).partial && sent === 2,
    "per-run budget prevents extra request and counts failed sends",
  );
  const [research] = await rows("SELECT * FROM research_runs WHERE job_id=?", [
    jid,
  ]);
  check(
    research.status === "budget_stopped" &&
      parse(research.evidence)[0].sample === "retained",
    "budget stop retains acquired evidence",
  );
  await request("/operations/settings", "PUT", { monthlyRequestLimit: 4 });
  const outcomes = await inWorkspace(wa, () =>
    Promise.allSettled(
      [1, 2, 3].map(() =>
        withResearchBudgetRequest("fixture", "/concurrent", async () => true),
      ),
    ),
  );
  check(
    outcomes.filter((o) => o.status === "fulfilled").length === 2,
    "atomic monthly budget prevents concurrent overspend",
  );
  r = await request("/research-runs/" + research.id, "GET", undefined, wb);
  check(r.status === 404, "research evidence is workspace isolated");
  r = await request("/notifications");
  check(r.body.unread >= 1, "budget interruption creates notification");
  await request("/notifications/read-all", "POST", {});
  r = await request("/notifications");
  check(r.body.unread === 0, "notification read state persists");
  await request("/operations/settings", "PUT", { monthlyRequestLimit: 100 });
  let echoSends = 0,
    metricsPages = 0;
  globalThis.fetch = async (value: any, options?: any) => {
    const url = String(value);
    if (url.startsWith("https://open.echotik.live/")) {
      echoSends++;
      return new Response(
        JSON.stringify(
          url.includes("product_ids=bad")
            ? { code: 1, message: "offline rejected" }
            : {
                code: 0,
                data: [{ product_id: "123", product_name: "Offline product" }],
              },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (
      url.startsWith(
        "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
      )
    )
      return new Response(
        JSON.stringify({
          error: { code: "ok" },
          data: {
            creator_nickname: "Offline creator",
            max_video_post_duration_sec: 60,
            privacy_level_options: ["SELF_ONLY"],
            comment_disabled: false,
            duet_disabled: false,
            stitch_disabled: false,
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    if (url.startsWith("https://open.tiktokapis.com/v2/video/list/")) {
      metricsPages++;
      const body = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          error: { code: "ok" },
          data: {
            videos:
              body.cursor === 0
                ? [
                    {
                      id: "7777777777",
                      view_count: 12,
                      like_count: 3,
                      comment_count: 2,
                      share_count: 1,
                    },
                  ]
                : [],
            has_more: body.cursor === 0,
            cursor: body.cursor === 0 ? 20 : 20,
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("https://"))
      throw new Error("Unexpected external request in offline integration");
    return originalFetch(value, options);
  };
  await inWorkspace(wa, async () => {
    const first = await echoQuery("/echotik/product/detail", {
        product_ids: "123",
      }),
      second = await echoQuery("/echotik/product/detail", {
        product_ids: "123",
      });
    check(
      first.cached === false && second.cached === true && echoSends === 1,
      "actual EchoTik adapter cache hit does not send or charge another request",
    );
    await assert.rejects(
      () => echoQuery("/echotik/product/detail", { product_ids: "bad" }),
      /offline rejected/,
    );
    const [request] = await rows(
      "SELECT status FROM research_requests WHERE workspace_id=? AND provider='echotik' ORDER BY id DESC LIMIT 1",
      [wa],
    );
    check(
      echoSends === 2 && request.status === "failed",
      "HTTP success with provider error still consumes budget and logs failed",
    );
  });
  const accountId = "tt-fixture-" + randomUUID().slice(0, 8);
  await inWorkspace(wa, async () => {
    await saveConfig({
      TIKTOK_CLIENT_KEY: "offline-fixture",
      TIKTOK_CLIENT_SECRET: "offline-fixture",
    });
    await put(
      "account",
      {
        name: "Offline creator",
        provider: "tiktok",
        scopes: "video.publish,video.list",
      },
      accountId,
    );
    await put(
      "token",
      {
        encrypted: seal(
          JSON.stringify({
            access_token: "offline_fixture_token",
            expiresAt: Date.now() + 3600000,
          }),
        ),
      },
      accountId + "-token",
    );
  });
  r = await request(
    "/publications",
    "POST",
    { title: "Wrong team relation", assetId: video!.id, accountId },
    wb,
  );
  check(
    r.status === 400,
    "publication cannot bind another workspace's asset or account",
  );
  await request("/operations/settings", "PUT", {
    tiktokDirectEnabled: true,
    tiktokQualificationNote: "Offline contract test only",
  });
  r = await request("/publications", "POST", {
    title: "Idempotent scheduled fixture",
    assetId: video!.id,
    mode: "direct",
    accountId,
    privacy: "SELF_ONLY",
  });
  const scheduledId = r.body.id;
  await request(`/publications/${scheduledId}/approve`, "POST", {
    confirm: true,
  });
  const scheduledAt = new Date(Date.now() + 600000).toISOString();
  const dispatch = await Promise.all(
    [1, 2].map(() =>
      request(`/publications/${scheduledId}/dispatch`, "POST", {
        confirm: true,
        runAt: scheduledAt,
      }),
    ),
  );
  const successful = dispatch.find((x) => x.status === 200);
  check(
    !!successful && dispatch.some((x) => x.status === 409),
    "concurrent publication dispatch submits only one job",
  );
  const [created] = await rows(
    "SELECT COUNT(*) total FROM jobs WHERE workspace_id=? AND kind='publish' AND JSON_UNQUOTE(JSON_EXTRACT(input,'$.publicationId'))=?",
    [wa, scheduledId],
  );
  check(
    Number(created.total) === 1,
    "repeated dispatch has one durable provider job",
  );
  r = await request(`/publications/${scheduledId}/reschedule`, "POST", {
    confirm: true,
    runAt: new Date(Date.now() - 10000).toISOString(),
  });
  check(
    r.status === 400 &&
      (await inWorkspace(wa, () => jobGet(successful!.body.jobId)))?.status ===
        "scheduled",
    "invalid reschedule preserves original scheduled job",
  );
  r = await request(`/publications/${scheduledId}/reschedule`, "POST", {
    confirm: true,
    runAt: new Date(Date.now() + 1200000).toISOString(),
  });
  check(
    r.status === 200 && r.body.jobId !== successful!.body.jobId,
    "valid reschedule cancels old unsubmitted job and persists new schedule",
  );
  r = await request(`/publications/${scheduledId}/cancel`, "POST", {});
  check(
    r.body.status === "cancelled",
    "unsubmitted publication schedule can be cancelled",
  );
  await request(`/publications/${scheduledId}/manual`, "POST", {
    url: "https://www.tiktok.com/@fixture/video/7777777777",
  });
  const metrics = await inWorkspace(wa, () =>
    syncContentMetrics({ accountId, maxPages: 3 }),
  );
  check(
    metrics.updated === 1 && metricsPages === 2,
    "metrics sync follows official cursor pagination and associates the existing work",
  );
  r = await request("/content-analytics?accountId=" + accountId);
  check(
    r.body.total === 1 &&
      r.body.items[0].metrics.views === 12 &&
      r.body.items[0].metrics.gmv == null,
    "account-filtered metrics use real snapshot values without inventing GMV",
  );
  r = await request("/automations?page=1&pageSize=1");
  check(
    r.body.items.length === 1 && r.body.total === 1,
    "automation listing exposes server pagination totals",
  );
  r = await request("/overview");
  check(
    Object.keys(r.body.counts).length === 5 &&
      typeof r.body.budget.used === "number",
    "overview contains all five workflow stages plus research usage",
  );
  const productionId = randomUUID(),
    productionProject = randomUUID();
  await execute(
    "INSERT INTO projects(id,workspace_id,name,status,input,version) VALUES(?,?,?,'completed',?,1)",
    [productionProject, wa, "Quoted fixture project", JSON.stringify({})],
  );
  await execute(
    "INSERT INTO jobs(id,kind,status,input,result,workspace_id) VALUES(?,'video','completed',?,?,?)",
    [
      productionId,
      JSON.stringify({
        projectId: productionProject,
        confirmationVersion: 1,
        videoModelId: "kie-seedance-mini",
        _quoteSnapshot: {
          count: 2,
          amount: 4,
          currency: "USD",
          status: "estimated",
          components: [
            { source: "offline quote fixture", amount: 4, currency: "USD" },
          ],
        },
      }),
      JSON.stringify({ asset: { id: video!.id } }),
      wa,
    ],
  );
  await inWorkspace(wa, () =>
    put("asset", { ...video, jobId: productionId }, video!.id),
  );
  r = await request("/content-analytics?accountId=" + accountId);
  check(
    r.body.items[0].attribution.estimate.amount === 2 &&
      r.body.items[0].attribution.estimate.actualAmount === null,
    "content estimate uses saved batch quotation and never invents actual charge",
  );
  r = await request("/content-comparison?groupBy=model");
  const group = r.body.groups.find((g: any) => g.key === "kie-seedance-mini");
  check(
    group?.estimatedByCurrency.USD === 2 && group.distinctProductionCount === 1,
    "model comparison deduplicates one production reused in multiple publications",
  );
  r = await request("/content-comparison?groupBy=script");
  check(
    r.body.groups.some((g: any) => g.key === productionProject + ":v1"),
    "effect comparison attributes the confirmed script version",
  );
  await execute(
    "UPDATE jobs SET status='review',error='Uncertain offline provider result' WHERE id=?",
    [productionId],
  );
  await reconcileOperations(wa);
  await reconcileOperations(wa);
  const [{ alerts }] = await rows(
    "SELECT COUNT(*) alerts FROM operation_notifications WHERE workspace_id=? AND dedupe_key=?",
    [wa, "job:" + productionId + ":review"],
  );
  check(
    Number(alerts) === 1,
    "uncertain provider job creates one durable review notification",
  );
  console.log(
    `Operations integration: ${checks} checks passed (MySQL + FFmpeg; no external API calls).`,
  );
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  const assets = await rows(
    "SELECT body FROM records WHERE workspace_id IN (?,?) AND kind='asset'",
    [wa, wb],
  );
  for (const a of assets) {
    const body = parse(a.body);
    if (body.filename)
      await unlink(join(process.cwd(), ".local/uploads", body.filename)).catch(
        () => {},
      );
  }
  for (const table of [
    "operation_notifications",
    "research_requests",
    "research_budget_buckets",
    "research_runs",
    "content_metrics",
    "publications",
    "operation_settings",
    "automations",
    "asset_references",
    "credit_ledger",
    "credit_reservations",
    "credit_wallets",
    "projects",
    "jobs",
    "records",
    "api_usage",
    "workspaces",
  ])
    await execute(
      `DELETE FROM ${table} WHERE ${table === "workspaces" ? "id" : "workspace_id"} IN (?,?)`,
      [wa, wb],
    );
  const { createHash } = await import("node:crypto");
  for (const ws of [wa, wb])
    await execute("DELETE FROM settings WHERE id=?", [
      "p-" + createHash("sha256").update(ws).digest("hex").slice(0, 30),
    ]);
  await lock.query("SELECT RELEASE_LOCK('x_ecommerce_worker')");
  lock.release();
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
