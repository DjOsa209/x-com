// A local S3 protocol fixture validates our adapter without a cloud account.
import "../server/env.ts";
import { createServer } from "node:http";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const objects = new Map<
  string,
  { bytes: Buffer; mime: string; etag: string }
>();
let cloudCalls = 0;
const s3Server = createServer(async (req, res) => {
  cloudCalls++;
  const key = decodeURIComponent(
    new URL(req.url!, "http://localhost").pathname.slice(1),
  );
  const obj = objects.get(key);
  if (req.method === "PUT") {
    const source = req.headers["x-amz-copy-source"];
    if (source) {
      const from = objects.get(
        decodeURIComponent(String(source)).replace(/^\//, ""),
      );
      if (!from) {
        res.writeHead(404).end();
        return;
      }
      if (
        req.headers["x-amz-copy-source-if-match"] &&
        req.headers["x-amz-copy-source-if-match"] !== from.etag
      ) {
        res.writeHead(412).end();
        return;
      }
      objects.set(key, { ...from, bytes: Buffer.from(from.bytes) });
      res
        .writeHead(200, { "content-type": "application/xml" })
        .end(
          `<CopyObjectResult><LastModified>${new Date().toISOString()}</LastModified><ETag>${from.etag}</ETag></CopyObjectResult>`,
        );
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const bytes = Buffer.concat(parts),
      etag = '"' + createHash("md5").update(bytes).digest("hex") + '"';
    objects.set(key, {
      bytes,
      mime: String(req.headers["content-type"]),
      etag,
    });
    res.writeHead(200, { etag }).end();
    return;
  }
  if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204).end();
    return;
  }
  if (!obj) {
    res.writeHead(404).end();
    return;
  }
  if (req.headers["if-match"] && req.headers["if-match"] !== obj.etag) {
    res.writeHead(412).end();
    return;
  }
  if (req.method === "HEAD") {
    res
      .writeHead(200, {
        "content-length": obj.bytes.length,
        "content-type": obj.mime,
        etag: obj.etag,
      })
      .end();
    return;
  }
  if (req.method === "GET") {
    const bytes = req.headers.range ? obj.bytes.subarray(0, 64) : obj.bytes;
    res
      .writeHead(req.headers.range ? 206 : 200, {
        "content-length": bytes.length,
        "content-type": obj.mime,
        etag: obj.etag,
      })
      .end(bytes);
    return;
  }
  res.writeHead(405).end();
});
s3Server.listen(0, "127.0.0.1");
await new Promise<void>((r) => s3Server.once("listening", r));
process.env.STORAGE_DRIVER = "s3";
process.env.S3_ENDPOINT =
  "http://127.0.0.1:" + (s3Server.address() as any).port;
process.env.S3_BUCKET = "fixture";
process.env.S3_REGION = "us-east-1";
process.env.S3_FORCE_PATH_STYLE = "true";
process.env.S3_ACCESS_KEY_ID = "fixture";
process.env.S3_SECRET_ACCESS_KEY = "fixture";
process.env.AUTH_REQUIRED = "true";
const { app, apiErrors } = await import("../server/app.ts");
const { pool, rows, execute, migrate } = await import("../server/db.ts");
const { passwordHash } = await import("../server/auth.ts");
const { cleanExpiredUploads } = await import("../server/storage.ts");
await migrate();
apiErrors();
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as any).port,
  ws = "qa-s3-" + randomUUID().slice(0, 8),
  uid = ws + "-user";
let cookies = "",
  checks = 0;
const check = (condition: any, label: string) => {
  assert.ok(condition, label);
  console.log("PASS " + label);
  checks++;
};
async function req(path: string, method = "GET", body?: any) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", cookie: cookies },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.getSetCookie().length)
    cookies = r.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
  return { status: r.status, data: await r.json().catch(() => null) };
}
try {
  const password = randomBytes(24).toString("hex");
  await execute("INSERT INTO workspaces(id,name) VALUES(?,?)", [ws, ws]);
  await execute(
    "INSERT INTO users(id,email,name,password_hash,global_role) VALUES(?,?,?,?,'admin')",
    [uid, uid + "@example.invalid", uid, await passwordHash(password)],
  );
  await execute(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,'owner')",
    [ws, uid],
  );
  await req("/api/auth/login", "POST", {
    email: uid + "@example.invalid",
    password,
  });
  check(
    (await req("/api/storage")).data.driver === "s3",
    "S3 adapter selected",
  );
  await req("/api/settings", "PUT", { STORAGE_LIMIT_MB: "1" });
  const reservation = await req("/api/storage/presign", "POST", {
    name: "reserved.png",
    mime: "image/png",
    bytes: 800000,
  });
  check(reservation.status === 200, "presigned upload reserves quota");
  check(
    new URL(reservation.data.uploadUrl).searchParams.has("X-Amz-Signature"),
    "upload URL signed by AWS SDK",
  );
  check(
    (
      await req("/api/storage/presign", "POST", {
        name: "too-large.png",
        mime: "image/png",
        bytes: 800000,
      })
    ).status === 413,
    "pending uploads count against quota",
  );
  await execute(
    "UPDATE records SET body=JSON_SET(body,'$.expiresAt',?) WHERE id=?",
    [Date.now() - 1200000, reservation.data.uploadId],
  );
  await cleanExpiredUploads();
  check(
    (
      await rows("SELECT id FROM records WHERE id=?", [
        reservation.data.uploadId,
      ])
    ).length === 0,
    "expired upload reservation cleaned",
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sWQAAAABJRU5ErkJggg==",
    "base64",
  );
  const signed = await req("/api/storage/presign", "POST", {
    name: "actual.png",
    mime: "image/png",
    bytes: png.length,
  });
  check(
    (
      await fetch(signed.data.uploadUrl, {
        method: "PUT",
        headers: signed.data.headers,
        body: png,
      })
    ).ok,
    "presigned PUT accepts actual image bytes",
  );
  const confirmed = await req("/api/storage/confirm", "POST", {
    uploadId: signed.data.uploadId,
  });
  check(
    confirmed.status === 200 && confirmed.data.storageKey.includes("/assets/"),
    "confirm validates HEAD and magic then promotes immutable object",
  );
  check(
    (
      await req("/api/storage/confirm", "POST", {
        uploadId: signed.data.uploadId,
      })
    ).data.id === confirmed.data.id,
    "confirm idempotently returns same asset",
  );
  const usage = (await req("/api/storage")).data;
  check(
    usage.usedBytes === png.length && usage.reservedBytes === 0,
    "confirmed upload accounts quota once",
  );
  const served = await fetch(base + confirmed.data.url, {
    headers: { cookie: cookies },
  });
  check(
    served.ok && Buffer.from(await served.arrayBuffer()).equals(png),
    "S3 object proxied with original bytes",
  );
  await fetch(signed.data.uploadUrl, {
    method: "PUT",
    headers: signed.data.headers,
    body: Buffer.from("altered pending content"),
  });
  const actual = objects.get("fixture/" + confirmed.data.storageKey);
  check(
    actual?.bytes.equals(png),
    "reusing signed PUT cannot overwrite confirmed asset",
  );
  check(
    (await req("/api/records/asset/" + confirmed.data.id, "DELETE")).status ===
      200 && !objects.has("fixture/" + confirmed.data.storageKey),
    "asset deletion removes remote object",
  );
  const invalid = await req("/api/storage/presign", "POST", {
    name: "spoofed.png",
    mime: "image/png",
    bytes: 4,
  });
  await fetch(invalid.data.uploadUrl, {
    method: "PUT",
    headers: invalid.data.headers,
    body: Buffer.from("fake"),
  });
  check(
    (
      await req("/api/storage/confirm", "POST", {
        uploadId: invalid.data.uploadId,
      })
    ).status === 400,
    "remote spoofed MIME rejected",
  );
  console.log(
    `Storage integration complete: ${checks} checks, ${cloudCalls} local fixture requests. No cloud credentials or requests.`,
  );
} finally {
  const files = await rows(
    "SELECT body FROM records WHERE workspace_id=? AND kind='asset'",
    [ws],
  );
  const { unlink } = await import("node:fs/promises");
  for (const r of files) {
    const b = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
    await unlink(".local/object-cache/" + b.filename).catch(() => {});
  }
  await execute("DELETE FROM settings WHERE id=?", [
    "p-" + createHash("sha256").update(ws).digest("hex").slice(0, 30),
  ]);
  for (const table of ["memberships", "records", "audit_log"])
    await execute(`DELETE FROM ${table} WHERE workspace_id=?`, [ws]);
  await execute("DELETE FROM sessions WHERE user_id=?", [uid]);
  await execute("DELETE FROM users WHERE id=?", [uid]);
  await execute("DELETE FROM workspaces WHERE id=?", [ws]);
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => s3Server.close(() => r()));
  await pool.end();
}
