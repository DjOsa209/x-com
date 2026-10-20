import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mysql } from "./backup-common.mjs";
const run = promisify(execFile),
  rootPassword =
    process.env.MYSQL_ADMIN_PASSWORD ||
    (await readFile(".local/mysql/root-password", "utf8")).trim();
const prefix = "x_deploy_check_" + randomBytes(4).toString("hex"),
  clean = prefix + "_clean",
  legacy = prefix + "_legacy",
  restored = prefix + "_restored";
const env = {
  ...process.env,
  MYSQL_USER: process.env.MYSQL_ADMIN_USER || "root",
  MYSQL_PASSWORD: rootPassword,
  MYSQL_DATABASE: legacy,
  X_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};
const c = mysql
  .createConnection({
    host: env.MYSQL_HOST || "127.0.0.1",
    port: Number(env.MYSQL_PORT || 3308),
    user: env.MYSQL_USER,
    password: rootPassword,
    dateStrings: true,
    jsonStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  })
  .promise();
const folder = await mkdtemp(join(tmpdir(), "x-ecom-backup-check-")),
  filename = randomUUID() + ".png",
  file = resolve(".local/uploads", filename),
  assetId = randomUUID();
let checks = 0;
const ok = (condition, label) => {
  assert.ok(condition, label);
  console.log("PASS " + label);
  checks++;
};
try {
  for (const db of [clean, legacy])
    await c.query(
      "CREATE DATABASE " + mysql.escapeId(db) + " CHARACTER SET utf8mb4",
    );
  await run(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/migrate.ts"],
    { env: { ...env, MYSQL_DATABASE: clean }, timeout: 120000 },
  );
  const [cleanTables] = await c.query(
    "SHOW TABLES FROM " + mysql.escapeId(clean),
  );
  ok(
    cleanTables.length >= 20,
    "clean database migrations create the complete application schema",
  );
  await c.query("USE " + mysql.escapeId(legacy));
  await c.query(
    "CREATE TABLE records(id VARCHAR(64) PRIMARY KEY,kind VARCHAR(32) NOT NULL,body JSON NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3))",
  );
  await mkdir(resolve(".local/uploads"), { recursive: true });
  await writeFile(
    file,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6K2AAAAAASUVORK5CYII=",
      "base64",
    ),
    { mode: 0o600 },
  );
  await c.execute("INSERT INTO records(id,kind,body) VALUES(?,'asset',?)", [
    assetId,
    JSON.stringify({
      name: "备份测试商品",
      filename,
      type: "image",
      mime: "image/png",
      url: "/media/" + filename,
      bytes: 65,
    }),
  ]);
  await run(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/migrate.ts"],
    { env, timeout: 120000 },
  );
  await run(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/migrate.ts"],
    { env, timeout: 120000 },
  );
  const [legacyRows] = await c.query(
    "SELECT workspace_id,body FROM records WHERE id=?",
    [assetId],
  );
  ok(
    legacyRows[0].workspace_id === "local" &&
      JSON.parse(legacyRows[0].body).name === "备份测试商品",
    "legacy table/data survives upgrade and repeated migrations",
  );
  await c.query(
    "CREATE TABLE backup_fixture(id BIGINT PRIMARY KEY,money DECIMAL(20,6),body JSON,bytes VARBINARY(100),created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),note TEXT)",
  );
  const bigint = "9223372036854775806",
    money = "12345678901234.123456",
    body = '{"externalId":"9999999999999999999","value":null}',
    bytes = Buffer.from([0, 1, 254, 255]);
  await c.execute("INSERT INTO backup_fixture VALUES(?,?,?,?,?,?)", [
    bigint,
    money,
    body,
    bytes,
    "2020-01-02 03:04:05.123",
    "中文\\nline\nreal newline",
  ]);
  const key = Buffer.from(env.X_ENCRYPTION_KEY, "hex"),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([
    iv,
    cipher.update('{"KIE_API_KEY":"offline-backup-fixture"}'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  await c.execute("INSERT INTO settings(id,payload) VALUES('providers',?)", [
    sealed,
  ]);
  const backup = join(folder, "snapshot"),
    local = join(folder, "restored-local");
  await run(process.execPath, ["scripts/backup.mjs", "--out", backup], {
    env,
    timeout: 120000,
  });
  const manifest = JSON.parse(
    await readFile(join(backup, "manifest.json"), "utf8"),
  );
  ok(
    manifest.complete && manifest.assets.length === 1,
    "backup completes with database checksums, media and encryption key",
  );
  await run(
    process.execPath,
    [
      "scripts/restore.mjs",
      "--from",
      backup,
      "--database",
      restored,
      "--local-dir",
      local,
    ],
    { env, timeout: 120000 },
  );
  await c.query("USE " + mysql.escapeId(restored));
  const [rows] = await c.query("SELECT * FROM backup_fixture");
  ok(
    rows[0].id === bigint &&
      rows[0].money === money &&
      JSON.parse(rows[0].body).externalId === "9999999999999999999" &&
      rows[0].bytes.equals(bytes) &&
      rows[0].created_at === "2020-01-02 03:04:05.123",
    "restore preserves BIGINT, decimals, JSON, binary data and timestamps exactly",
  );
  ok(
    (await readFile(join(local, "uploads", filename))).equals(
      await readFile(file),
    ),
    "restored local media has identical bytes",
  );
  const [settings] = await c.query(
    "SELECT payload FROM settings WHERE id='providers'",
  );
  const restoredKey = await readFile(join(local, "master.key")),
    b = Buffer.from(settings[0].payload, "base64"),
    decipher = createDecipheriv("aes-256-gcm", restoredKey, b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(-16));
  const secret = Buffer.concat([
    decipher.update(b.subarray(12, -16)),
    decipher.final(),
  ]).toString();
  ok(
    JSON.parse(secret).KIE_API_KEY === "offline-backup-fixture",
    "restored encryption key decrypts saved provider settings",
  );
  let rejected = false;
  try {
    await run(
      process.execPath,
      [
        "scripts/restore.mjs",
        "--from",
        backup,
        "--database",
        restored,
        "--local-dir",
        join(folder, "second-local"),
      ],
      { env, timeout: 120000 },
    );
  } catch {
    rejected = true;
  }
  ok(rejected, "restore refuses to overwrite a populated target database");
  console.log(
    `Deployment data checks complete: ${checks}. Temporary databases only; production data untouched.`,
  );
} finally {
  for (const db of [clean, legacy, restored]) {
    assert.ok(db.startsWith(prefix));
    await c.query("DROP DATABASE IF EXISTS " + mysql.escapeId(db));
  }
  await c.end();
  await unlink(file).catch(() => {});
  await rm(folder, { recursive: true, force: true });
}
