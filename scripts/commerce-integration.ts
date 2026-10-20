import "../server/env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { commerceRoutes } from "../server/commerce.ts";
import { migrate, execute, rows, pool, put } from "../server/db.ts";
import { migrateCommerce } from "../server/research-schema.ts";
import { scopes, inWorkspace, localScope } from "../server/context.ts";
import {
  syncWatch,
  watchSnapshots,
  ingestCase,
  ingestOpportunity,
  migrateLegacyCommerce,
  importLegacyCommerce,
} from "../server/research-domain.ts";
await migrate();
await migrateCommerce();
const prefix = "commerce-qa-" + randomUUID().slice(0, 8),
  a = prefix + "-a",
  b = prefix + "-b",
  assetId = randomUUID(),
  foreignAsset = randomUUID();
const app = express();
app.use(express.json());
app.use((req, _res, next) =>
  scopes.run(
    { ...localScope, workspaceId: req.headers["x-workspace"] === b ? b : a },
    () => next(),
  ),
);
app.use("/api", commerceRoutes);
app.use(
  (
    e: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) =>
    res
      .status(e.status || (e.name === "ZodError" ? 400 : 500))
      .json({ error: e.message, code: e.code }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as any).port;
let count = 0;
function check(v: unknown, label: string) {
  assert.ok(v, label);
  count++;
  console.log("PASS " + label);
}
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  tenant = a,
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: { "content-type": "application/json", "x-workspace": tenant },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
try {
  await execute("INSERT INTO workspaces(id,name) VALUES(?,?),(?,?)", [
    a,
    "Commerce fixture A",
    b,
    "Commerce fixture B",
  ]);
  await execute(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,'operator')",
    [a, "fixture-member"],
  );
  await inWorkspace(a, () =>
    put(
      "asset",
      {
        name: "Fixture image",
        type: "image",
        mime: "image/png",
        bytes: 10,
        url: "/fixture.png",
      },
      assetId,
    ),
  );
  await inWorkspace(b, () =>
    put(
      "asset",
      {
        name: "Other tenant image",
        type: "image",
        mime: "image/png",
        bytes: 10,
        url: "/other.png",
      },
      foreignAsset,
    ),
  );
  let r = await request("/commerce/products", "POST", {
    name: "Mug",
    sku: "MUG-1",
    assetIds: [assetId],
    sellingPoints: ["Reusable"],
    markets: ["US"],
    price: 30,
    cost: 10,
    shipping: 2,
    platformFeePercent: 10,
  });
  check(r.status === 201, "create product with owned asset");
  const product = r.data;
  check(
    (await request("/commerce/products")).data[0].estimate.profit === 15,
    "real API computes explicit cost estimate",
  );
  check(
    (
      await request("/commerce/products", "POST", {
        name: "Bad",
        assetIds: [foreignAsset],
      })
    ).status === 400,
    "reject foreign workspace asset",
  );
  check(
    (await request("/commerce/products", "POST", { name: "Bad", cost: -1 }))
      .status === 400,
    "reject negative product costs",
  );
  check(
    (await request("/commerce/products/" + product.id, "GET", undefined, b))
      .status === 404,
    "other workspace cannot read product",
  );
  check(
    (await request("/commerce/products", "GET", undefined, b)).data.length ===
      0,
    "other workspace list is isolated",
  );
  await request("/commerce/products", "POST", {
    name: "Tea kettle",
    status: "active",
  });
  const paged = await request("/commerce/products?page=1&pageSize=1");
  check(
    paged.data.items.length === 1 && paged.data.total === 2,
    "server paginates product lists with accurate totals",
  );
  const pageTwo = await request("/commerce/products?page=2&pageSize=1");
  check(
    pageTwo.data.items.length === 1 &&
      pageTwo.data.items[0].id !== paged.data.items[0].id,
    "stable ordering gives distinct pages",
  );
  check(
    (await request("/commerce/products?page=1&q=kettle&status=active")).data
      .total === 1,
    "server applies search and status before pagination",
  );
  check(
    (await request("/commerce/products?page=-1")).status === 400,
    "validate pagination boundaries",
  );
  r = await request("/commerce/products/" + product.id, "PATCH", {
    revision: product.revision,
    name: "Updated mug",
  });
  check(
    r.status === 200 && r.data.revision === 2,
    "product update increments revision",
  );
  check(
    (
      await request("/commerce/products/" + product.id, "PATCH", {
        revision: 1,
        name: "Stale",
      })
    ).status === 409,
    "reject stale update to avoid lost edits",
  );
  const [ref] = await rows(
    "SELECT owner_id FROM asset_references WHERE workspace_id=? AND asset_id=?",
    [a, assetId],
  );
  check(ref?.owner_id === product.id, "persist product asset usage references");
  r = await request("/commerce/opportunities", "POST", {
    title: "Portable coffee opportunity",
    ownerId: "fixture-member",
    productId: product.id,
    evidence: [{ product: { id: "external-1", gmv: null } }],
  });
  check(r.status === 201, "create opportunity with member and owned product");
  const opportunity = r.data;
  check(
    (
      await request("/commerce/opportunities", "POST", {
        title: "Invalid owner",
        ownerId: "foreign-member",
      })
    ).status === 400,
    "validate opportunity owner membership",
  );
  check(
    (
      await request(
        "/commerce/opportunities",
        "POST",
        { title: "Foreign product", productId: product.id },
        b,
      )
    ).status === 404,
    "prevent cross-workspace product linkage",
  );
  check(
    (await request("/commerce/products/" + product.id, "DELETE")).status ===
      409,
    "protect product linked by opportunity",
  );
  r = await request("/commerce/opportunities/" + opportunity.id, "PATCH", {
    status: "testing",
    notes: "Test a new opening hook",
  });
  check(
    r.status === 200 && r.data.notes.includes("opening"),
    "save opportunity status and notes",
  );
  r = await request("/commerce/cases", "POST", {
    title: "Source case",
    prompt: "Show the lid",
    sourceUrl: "https://www.tiktok.com/@fixture/video/123456?share=1",
  });
  check(r.status === 201, "create sourced draft case");
  const videoCase = r.data;
  check(
    (
      await request("/commerce/cases", "POST", {
        title: "Duplicate",
        prompt: "Another",
        sourceUrl: "https://www.tiktok.com/@fixture/video/123456",
      })
    ).status === 409,
    "deduplicate source across tracking links",
  );
  check(
    (
      await request("/commerce/cases/" + videoCase.id, "PATCH", {
        status: "published",
      })
    ).status === 400,
    "require review before publication",
  );
  r = await request("/commerce/cases/" + videoCase.id, "PATCH", {
    status: "published",
    reviewNote: "Observed demonstration; no sales guarantee",
  });
  check(
    r.status === 200 && r.data.status === "published",
    "publish reviewed case",
  );
  const same = await inWorkspace(a, () =>
    ingestCase(
      {
        title: "New automatic title",
        shootingPrompt: "Replace manually reviewed prompt",
      },
      {
        sourceUrl: "https://www.tiktok.com/@fixture/video/123456",
        jobId: "fixture-job",
      },
    ),
  );
  check(
    same.id === videoCase.id &&
      same.prompt === "Show the lid" &&
      same.status === "published",
    "automated ingestion preserves reviewed source",
  );
  const collected = await inWorkspace(a, () =>
    ingestCase(
      { title: "Collected video", prompt: "Pending analysis" },
      {
        sourceUrl: "https://www.tiktok.com/@fixture/video/789012",
        sourceMetrics: { gmv: 50 },
        provenance: "EchoTik 视频采集（尚未分析）",
      },
    ),
  );
  check(
    collected.analysisStatus === "pending",
    "collection remains explicitly unanalyzed",
  );
  check(
    (
      await request("/commerce/cases/" + collected.id, "PATCH", {
        status: "published",
        reviewNote: "Review",
      })
    ).status === 400,
    "pending analysis cannot be published as finished case",
  );
  const enriched = await inWorkspace(a, () =>
    ingestCase(
      {
        title: "Observed video",
        shootingPrompt: "Show real product usage",
        scenes: [{ time: "0-3s", visual: "Show mug" }],
      },
      { sourceUrl: "https://www.tiktok.com/@fixture/video/789012" },
    ),
  );
  check(
    enriched.id === collected.id &&
      enriched.analysisStatus === "ready" &&
      enriched.sourceMetrics.gmv === 50,
    "actual analysis fills existing collected draft and preserves observed metrics",
  );
  const op1 = await inWorkspace(a, () =>
      ingestOpportunity(
        { title: "AI hypothesis", evidence: [] },
        { jobId: "fixture-op-job" },
      ),
    ),
    op2 = await inWorkspace(a, () =>
      ingestOpportunity(
        { title: "Repeated delivery", evidence: [] },
        { jobId: "fixture-op-job" },
      ),
    );
  check(op1.id === op2.id, "same source job does not duplicate opportunity");
  r = await request("/commerce/watches", "POST", {
    name: "Observed video",
    entity: "video",
    externalId: "video-1",
  });
  check(r.status === 201, "create four-domain watch entry");
  const watch = r.data;
  let currentGmv = 0;
  const calls: any[] = [];
  const fixtureQuery = async (path: string, params: any) => {
    calls.push({ path, params });
    return {
      source: "offline fixture",
      fetchedAt: new Date().toISOString(),
      data: path.endsWith("/detail")
        ? [
            {
              video_id: "video-1",
              video_desc: "Real fixture",
              total_sale_gmv_amt: currentGmv,
            },
          ]
        : { list: [{ product_id: "product-1", product_name: "Related mug" }] },
    };
  };
  const first = await inWorkspace(a, () => syncWatch(watch.id, fixtureQuery));
  check(
    first.snapshot.diff.baseline === true,
    "first watch snapshot is a baseline",
  );
  currentGmv = 10;
  const second = await inWorkspace(a, () => syncWatch(watch.id, fixtureQuery));
  check(
    second.snapshot.diff.metrics.find((m: any) => m.key === "gmv")?.delta ===
      10,
    "persist and compare real snapshot metrics",
  );
  check(
    calls.some(
      (c) =>
        c.path === "/echotik/video/product/list" &&
        c.params.video_ids === "video-1",
    ),
    "watch relation uses documented plural key",
  );
  check(
    (await inWorkspace(a, () => watchSnapshots(watch.id))).length === 2,
    "retain watch snapshot history",
  );
  check(
    (
      await request(
        "/commerce/watches/" + watch.id + "/snapshots",
        "GET",
        undefined,
        b,
      )
    ).status === 404,
    "watch evidence is tenant isolated",
  );
  r = await request("/commerce/searches", "POST", {
    name: "US mugs",
    query: { entity: "product", view: "search", region: "US", keyword: "mug" },
  });
  check(r.status === 201, "persist saved search with query filters");
  check(
    (
      await request("/research/query", "POST", {
        entity: "live",
        action: "related",
        id: "1",
        relation: "video",
      })
    ).status === 400,
    "reject nonexistent live-video relationship before external request",
  );
  check(
    (
      await request("/research/image-keywords", "POST", {
        assetId: foreignAsset,
      })
    ).status === 400,
    "image discovery rejects foreign asset before provider request",
  );
  check(
    (
      await request(
        "/research/photo-search",
        "POST",
        { searchId: randomUUID(), cursor: "0" },
        b,
      )
    ).status === 404,
    "native image-search continuation requires tenant-owned session",
  );
  check(
    (await request("/commerce/watches/" + watch.id, "DELETE")).status === 200,
    "delete watch",
  );
  check(
    !(
      await rows(
        "SELECT id FROM commerce_watch_snapshots WHERE workspace_id=? AND watch_id=?",
        [a, watch.id],
      )
    ).length,
    "delete watch history alongside watch",
  );
  await inWorkspace(a, async () => {
    await put("prompt", {
      title: "Legacy already reviewed",
      prompt: "Must not overwrite",
      sourceUrl: "https://www.tiktok.com/@fixture/video/123456",
    });
    await put("prompt", {
      title: "Legacy source-free draft",
      prompt: "Keep my old prompt",
    });
    await put("opportunity", {
      title: "Legacy pain point",
      summary: "Keep evidence",
      status: "adopted",
      notes: "My notes",
      evidence: [{ comment: "Needs a lid" }],
    });
    await put("competitor", {
      name: "Legacy handle",
      entity: "creator",
      externalId: "@fixture.handle",
      snapshot: {
        data: { list: [{ video_id: "old-video", title: "Old evidence" }] },
      },
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
    });
  });
  await inWorkspace(b, () =>
    put("opportunity", { title: "Tenant B legacy opportunity", evidence: [] }),
  );
  await migrateLegacyCommerce();
  const migratedCases = (await request("/commerce/cases")).data;
  const retained = migratedCases.find((c: any) => c.id === videoCase.id);
  check(
    retained.status === "published" && retained.prompt === "Show the lid",
    "migration never overwrites a reviewed source case",
  );
  check(
    migratedCases.some(
      (c: any) =>
        c.title === "Legacy source-free draft" && c.status === "draft",
    ),
    "source-free legacy prompts remain visible as review drafts",
  );
  const migratedOpportunity = (
    await request("/commerce/opportunities")
  ).data.find((o: any) => o.title === "Legacy pain point");
  check(
    migratedOpportunity.status === "adopted" &&
      migratedOpportunity.notes === "My notes" &&
      migratedOpportunity.evidence[0].comment === "Needs a lid",
    "legacy opportunity retains lifecycle notes and evidence",
  );
  const migratedWatch = (await request("/commerce/watches")).data.find(
    (w: any) => w.name === "Legacy handle",
  );
  check(
    migratedWatch.externalId === "fixture.handle",
    "legacy handle watch remains available",
  );
  check(
    (await inWorkspace(a, () => watchSnapshots(migratedWatch.id)))[0]?.items[0]
      ?.id === "old-video",
    "legacy watch snapshot is visible in history",
  );
  check(
    (await request("/commerce/opportunities", "GET", undefined, b)).data.every(
      (o: any) => o.title === "Tenant B legacy opportunity",
    ),
    "migration retains workspace ownership",
  );
  const repeated = await inWorkspace(a, () => importLegacyCommerce());
  check(
    repeated.imported === 0 &&
      (await inWorkspace(a, () => watchSnapshots(migratedWatch.id))).length ===
        1,
    "repeat migration creates no duplicate records or snapshots",
  );
  console.log(
    `Commerce integration passed: ${count} checks, no paid APIs called.`,
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  for (const table of [
    "asset_references",
    "commerce_watch_snapshots",
    "commerce_entries",
    "records",
    "memberships",
    "projects",
  ])
    await execute(`DELETE FROM ${table} WHERE workspace_id IN (?,?)`, [a, b]);
  await execute("DELETE FROM workspaces WHERE id IN (?,?)", [a, b]);
  await pool.end();
}
