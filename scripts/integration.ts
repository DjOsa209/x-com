import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "mysql2/promise";
import "../server/env.ts";
const base = process.env.TEST_BASE_URL || "http://localhost:4317";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Integration checks only run against a local app.");
const records: { kind: string; id: string }[] = [];
let checks = 0;
async function request(
  path: string,
  method = "GET",
  body?: any,
  headers: Record<string, string> = {},
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body !== undefined
      ? { body: body instanceof FormData ? body : JSON.stringify(body) }
      : {}),
  });
  return { status: r.status, body: await r.json() };
}
function check(value: any, message: string) {
  assert.ok(value, message);
  checks++;
  console.log("PASS " + message);
}
const marker = "qa-" + randomUUID();
try {
  const health = await request("/health");
  check(
    health.status === 200 && health.body.database === "mysql",
    "actual MySQL health",
  );
  const catalog = await request("/catalog");
  check(catalog.body.length >= 78, "official endpoint catalog served");
  const settings = await request("/settings");
  check(
    !("ECHOTIK_PASSWORD" in settings.body.values) &&
      typeof settings.body.secrets.ECHOTIK_PASSWORD === "boolean",
    "secret values are not returned",
  );
  const record = await request("/records/draft", "POST", {
    name: marker,
    prompt: "UGC 咖啡机",
    mode: "video",
  });
  records.push({ kind: "draft", id: record.body.id });
  check(record.status === 201, "create persistent draft");
  const db = await createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });
  const [r]: any = await db.execute("SELECT body FROM records WHERE id=?", [
    record.body.id,
  ]);
  check(
    r.length === 1 && r[0].body.name === marker,
    "independent MySQL connection verifies persistence",
  );
  await db.end();
  const patch = await request("/records/draft/" + record.body.id, "PATCH", {
    name: marker + "-updated",
  });
  check(patch.body.name.endsWith("-updated"), "update draft");
  const invalid = await request("/echotik/query", "POST", {
    path: "/realtime/product/search",
    params: { keyword: "coffee", region: "US" },
  });
  check(invalid.status === 400, "missing sk rejected without upstream call");
  const badpath = await request("/echotik/query", "POST", {
    path: "https://attacker.example",
    params: {},
  });
  check(badpath.status === 400, "unlisted provider origin rejected");
  const csrf = await request(
    "/records/draft",
    "POST",
    { name: "should-not-save" },
    { Origin: "https://other.example" },
  );
  check(csrf.status === 403, "cross-origin mutation blocked");
  const hidden = await request("/records/token");
  check(hidden.status === 404, "OAuth token collection is not accessible");
  const account = await request("/records/account", "POST", { name: "fake" });
  check(account.status === 400, "accounts require real OAuth authorization");
  const nofake = await request("/records/asset", "POST", {
    filename: "../../.env.local",
  });
  check(nofake.status === 400, "arbitrary asset paths cannot be created");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
    "base64",
  );
  const form = new FormData();
  form.append("file", new File([png], marker + ".png", { type: "image/png" }));
  const uploaded = await request("/uploads", "POST", form);
  records.push({ kind: "asset", id: uploaded.body.id });
  check(
    uploaded.status === 201 && uploaded.body.bytes === png.length,
    "real image upload and MySQL metadata",
  );
  const media = await fetch(base + uploaded.body.url);
  check(
    media.status === 200 && Buffer.from(await media.arrayBuffer()).equals(png),
    "uploaded file bytes served intact",
  );
  const badform = new FormData();
  badform.append(
    "file",
    new File(["not-an-image"], "invalid.png", { type: "image/png" }),
  );
  const invalidUpload = await request("/uploads", "POST", badform);
  check(invalidUpload.status === 400, "spoofed upload MIME rejected");
  const character = await request("/records/character", "POST", {
    name: marker,
    assetId: uploaded.body.id,
    imageUrl: uploaded.body.url,
  });
  records.unshift({ kind: "character", id: character.body.id });
  check(character.status === 201, "character references real image asset");
  const inuse = await request("/records/asset/" + uploaded.body.id, "DELETE");
  check(inuse.status === 409, "referenced character image protected");
  if (!settings.body.secrets.GEMINI_API_KEY) {
    const countBefore = (await request("/jobs")).body.length;
    const j = await request("/jobs", "POST", {
      kind: "script",
      input: { prompt: "test" },
      dedupeKey: marker,
    });
    check(j.status === 409, "missing provider is explicit");
    check(
      (await request("/jobs")).body.length === countBefore,
      "missing provider does not create fake completed jobs",
    );
  }
  const traversal = await fetch(base + "/media/not-a-valid-file");
  check(traversal.status === 404, "invalid media paths rejected");
  const analytics = await request("/analytics");
  check(
    analytics.status === 200 && analytics.body.storage.count >= 1,
    "analytics reflect real persisted records",
  );
  console.log(
    `Integration complete: ${checks} checks. No paid provider calls were made.`,
  );
} finally {
  for (const r of records) {
    await request("/records/" + r.kind + "/" + r.id, "DELETE").catch(() => {});
  }
}
