import "../server/env.ts";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
process.env.AUTH_REQUIRED = "true";
process.env.COOKIE_SECURE = "false";
const { app, apiErrors } = await import("../server/app.ts");
const { rows, execute, migrate, pool, put } = await import("../server/db.ts");
const { passwordHash } = await import("../server/auth.ts");
const { inWorkspace } = await import("../server/context.ts");
const { saveMedia, mediaRoot } = await import("../server/media.ts");
const { replaceAssetReferences } =
  await import("../server/asset-references.ts");
await migrate();
apiErrors();
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as any).port;
const prefix = "foundation-" + randomUUID().slice(0, 8),
  wa = prefix + "a",
  wb = prefix + "b";
const users = [prefix + "owner", prefix + "viewer", prefix + "other"];
const password = randomBytes(20).toString("hex");
let count = 0;
const files: string[] = [];
function check(v: unknown, label: string) {
  assert.ok(v, label);
  count++;
  console.log("PASS " + label);
}
class Client {
  cookies = new Map<string, string>();
  async req(path: string, method = "GET", body?: any) {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        cookie: [...this.cookies].map(([k, v]) => k + "=" + v).join("; "),
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    for (const c of r.headers.getSetCookie()) {
      const [name, ...value] = c.split(";")[0].split("=");
      this.cookies.set(name, value.join("="));
    }
    const data = r.headers.get("Content-Type")?.includes("application/json")
      ? await r.json()
      : Buffer.from(await r.arrayBuffer());
    return { status: r.status, data };
  }
}
const owner = new Client(),
  viewer = new Client(),
  other = new Client(),
  extra = new Client(),
  guest = new Client();
try {
  for (const ws of [wa, wb])
    await execute("INSERT INTO workspaces(id,name) VALUES(?,?)", [ws, ws]);
  const hash = await passwordHash(password);
  for (const [i, id] of users.entries()) {
    await execute(
      "INSERT INTO users(id,email,name,password_hash,global_role) VALUES(?,?,?,?,?)",
      [id, id + "@example.invalid", id, hash, i === 0 ? "admin" : "member"],
    );
    await execute("INSERT INTO memberships VALUES(?,?,?)", [
      i === 2 ? wb : wa,
      id,
      i === 1 ? "viewer" : "owner",
    ]);
  }
  for (const [i, c] of [owner, viewer, other].entries())
    check(
      (
        await c.req("/auth/login", "POST", {
          email: users[i] + "@example.invalid",
          password,
        })
      ).status === 200,
      "fixture authenticated " + i,
    );
  await extra.req("/auth/login", "POST", {
    email: users[0] + "@example.invalid",
    password,
  });
  let r = await owner.req("/auth/sessions");
  check(
    r.data.length === 2 && r.data.filter((s: any) => s.current).length === 1,
    "session list identifies current and other login",
  );
  const session = r.data.find((s: any) => !s.current);
  check(
    (await other.req("/auth/sessions/" + session.id, "DELETE")).status === 200,
    "foreign session revocation has no access",
  );
  check(
    (await extra.req("/auth/status")).data.user?.id === users[0],
    "foreign revocation cannot remove another users session",
  );
  await owner.req("/auth/sessions/" + session.id, "DELETE");
  check(
    (await extra.req("/library/asset")).status === 401,
    "own session revocation takes effect",
  );
  for (const kind of ["video", "replicate", "publish"])
    check(
      (
        await owner.req("/jobs", "POST", {
          kind,
          input: {},
          dedupeKey: prefix + "-deny-" + kind,
        })
      ).data.code === "CONFIRMATION_REQUIRED",
      "generic job endpoint requires confirmed " + kind + " workflow",
    );
  check(
    (
      await owner.req("/jobs", "POST", {
        kind: "raw",
        input: {
          modelId: "fal-ai/kling-video/v3/standard/image-to-video",
          payload: {},
        },
        dedupeKey: prefix + "-raw-denied",
      })
    ).data.code === "CONFIRMATION_REQUIRED",
    "raw model cannot bypass video confirmation",
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWQAAAABJRU5ErkJggg==",
    "base64",
  );
  const asset = await inWorkspace(wa, () =>
    saveMedia(png, "image/png", "证据.png"),
  );
  files.push(asset!.filename);
  const badAudio = new FormData();
  badAudio.append(
    "file",
    new Blob([Buffer.from("RIFFxxxxWAVEtruncated")], { type: "audio/wav" }),
    "bad.wav",
  );
  check(
    (await owner.req("/uploads", "POST", badAudio)).status === 400,
    "malformed audio rejected by media probe",
  );
  await inWorkspace(wa, () =>
    replaceAssetReferences("product", "product-fixture", {
      assetIds: [asset!.id],
    }),
  );
  check(
    (await owner.req("/records/asset/" + asset!.id, "DELETE")).status === 409,
    "asset referenced by product cannot be deleted",
  );
  check(
    (
      await owner.req("/records/asset/" + asset!.id, "PATCH", {
        archived: true,
        tags: ["证据"],
      })
    ).status === 200,
    "referenced asset can be archived safely",
  );
  check(
    (await owner.req("/library/asset")).data.total === 0,
    "archived assets excluded by default",
  );
  check(
    (await owner.req("/library/asset?archived=true&q=证据")).data.total === 1,
    "archive and tag search work on server",
  );
  check(
    (await other.req("/assets/" + asset!.id + "/references")).status === 404,
    "asset reference list is tenant isolated",
  );
  check(
    (
      await viewer.req("/records/asset/" + asset!.id, "PATCH", {
        name: "tamper",
      })
    ).status === 403,
    "viewer cannot mutate assets",
  );
  check(
    (await owner.req("/records/asset/" + asset!.id, "PATCH", { name: "" }))
      .status === 400,
    "asset metadata schema rejects empty name",
  );
  check(
    (
      await owner.req("/records/asset/" + asset!.id, "PATCH", {
        projectId: "foreign-project",
      })
    ).status === 400,
    "asset project links must be owned",
  );
  r = await viewer.req("/assets/archive-download", "POST", {
    ids: [asset!.id],
  });
  check(
    r.status === 200 && r.data.readUInt32LE(0) === 0x04034b50,
    "viewer may download legitimate asset ZIP",
  );
  check(
    (await other.req("/assets/archive-download", "POST", { ids: [asset!.id] }))
      .status === 404,
    "bulk download cannot access foreign files",
  );
  // More than the old 1,000 record and 200 job caps; metadata-only fixtures.
  const recordRows = Array.from({ length: 1005 }, (_, i) => [
    prefix + "asset" + i,
    "asset",
    JSON.stringify({ name: "page-fixture " + i, type: "image", tags: [] }),
    wa,
  ]);
  await pool.query("INSERT INTO records(id,kind,body,workspace_id) VALUES ?", [
    recordRows,
  ]);
  r = await owner.req("/library/asset?page=11&pageSize=100&q=page-fixture");
  check(
    r.data.total === 1005 && r.data.items.length === 5,
    "asset paging reaches records beyond legacy 1000 cap",
  );
  const jobRows = Array.from({ length: 205 }, (_, i) => [
    prefix + "job" + i,
    "script",
    "completed",
    "{}",
    wa,
  ]);
  await pool.query(
    "INSERT INTO jobs(id,kind,status,input,workspace_id) VALUES ?",
    [jobRows],
  );
  r = await owner.req("/job-history?page=3&pageSize=100");
  check(
    r.data.total === 205 && r.data.items.length === 5,
    "job paging reaches records beyond legacy 200 cap",
  );
  check(
    (await other.req("/jobs/" + prefix + "job0")).status === 404,
    "individual job detail is isolated",
  );
  check(
    (await viewer.req("/audit")).status === 403,
    "audit access restricted to managers",
  );
  check(
    (await owner.req("/diagnostics")).data.mediaReady === true,
    "diagnostics verifies installed media tools",
  );
  check(
    (await viewer.req("/admin/users/" + users[0] + "/recovery", "POST"))
      .status === 403,
    "recovery issuance requires platform admin",
  );
  r = await owner.req("/admin/users/" + users[1] + "/recovery", "POST");
  const token = new URL(r.data.path, base).searchParams.get("reset");
  check(
    r.status === 200 && token?.length === 64,
    "admin issues expiring recovery token",
  );
  const next = randomBytes(20).toString("hex");
  check(
    (await guest.req("/auth/reset-password", "POST", { token, password: next }))
      .status === 200,
    "unauthenticated token owner resets password",
  );
  check(
    (await viewer.req("/library/asset")).status === 401,
    "password recovery revokes existing sessions",
  );
  check(
    (await guest.req("/auth/reset-password", "POST", { token, password: next }))
      .status === 410,
    "recovery token cannot be replayed",
  );
  check(
    (
      await guest.req("/auth/login", "POST", {
        email: users[1] + "@example.invalid",
        password: next,
      })
    ).status === 200,
    "new password login works",
  );
  console.log(
    `Foundation integration passed: ${count} checks; no paid APIs called.`,
  );
} finally {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  for (const file of files) await rm(resolve(mediaRoot, file), { force: true });
  for (const table of ["password_resets", "sessions"])
    await execute(`DELETE FROM ${table} WHERE user_id IN (?,?,?)`, users);
  for (const table of [
    "asset_references",
    "records",
    "jobs",
    "audit_log",
    "memberships",
    "credit_wallets",
    "credit_ledger",
  ])
    await execute(`DELETE FROM ${table} WHERE workspace_id IN (?,?)`, [wa, wb]);
  await execute("DELETE FROM users WHERE id IN (?,?,?)", users);
  await execute("DELETE FROM workspaces WHERE id IN (?,?)", [wa, wb]);
  await pool.end();
}
