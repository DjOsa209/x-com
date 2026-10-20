import {
  mkdir,
  writeFile,
  readFile,
  copyFile,
  chmod,
  stat,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import {
  connection,
  arg,
  hashFile,
  safeFilename,
  encode,
  mysql,
  resolve,
} from "./backup-common.mjs";
const out = arg("--out");
if (!out) {
  console.error("Usage: npm run backup -- --out /secure/new-backup-directory");
  process.exit(1);
}
const folder = resolve(out),
  c = connection(),
  db = c.promise();
let lock = false;
try {
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "media"), { mode: 0o700 });
  await db.query("SET time_zone='+00:00'");
  const [locked] = await db.query(
    "SELECT GET_LOCK('x_ecommerce_worker',0) acquired",
  );
  if (!Number(locked[0].acquired))
    throw new Error(
      "Worker is active. Stop app/worker for a consistent backup and retry.",
    );
  lock = true;
  const [all] = await db.query("SHOW FULL TABLES");
  if (all.some((r) => Object.values(r)[1] !== "BASE TABLE"))
    throw new Error(
      "Custom views are present; this application backup supports its base tables only.",
    );
  const [triggers] = await db.query("SHOW TRIGGERS");
  if (triggers.length)
    throw new Error("Custom triggers require a DBA-native backup.");
  const tables = all.map((r) => String(Object.values(r)[0]));
  await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await db.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  const [mediaRows] = await db.query(
    "SELECT body FROM records WHERE kind='asset'",
  );
  const gzip = createGzip(),
    output = createWriteStream(join(folder, "database.ndjson.gz"), {
      flags: "wx",
      mode: 0o600,
    });
  gzip.pipe(output);
  const outputDone = finished(output);
  const write = async (value) => {
    if (!gzip.write(JSON.stringify(value) + "\n")) await once(gzip, "drain");
  };
  await write({
    format: "x-ecommerce-backup",
    version: 1,
    database: process.env.MYSQL_DATABASE || "x_ecommerce",
    createdAt: new Date().toISOString(),
  });
  const counts = {};
  for (const table of tables) {
    const [ddl] = await db.query("SHOW CREATE TABLE " + mysql.escapeId(table));
    const [columns] = await db.query(
      "SHOW COLUMNS FROM " + mysql.escapeId(table),
    );
    const names = columns
      .filter((c) => !/(VIRTUAL|STORED) GENERATED/.test(String(c.Extra)))
      .map((c) => c.Field);
    await write({ table, ddl: ddl[0]["Create Table"], columns: names });
    let count = 0;
    const stream = c
      .query({
        sql:
          "SELECT " +
          names.map(mysql.escapeId).join(",") +
          " FROM " +
          mysql.escapeId(table),
        rowsAsArray: true,
      })
      .stream({ highWaterMark: 100 });
    for await (const row of stream) {
      await write({ row: row.map(encode) });
      count++;
    }
    counts[table] = count;
  }
  gzip.end();
  await outputDone;
  await db.commit();
  let s3;
  const assets = [];
  for (const r of mediaRows) {
    const a = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
    if (!a.filename) continue;
    const name = safeFilename(a.filename),
      target = join(folder, "media", name);
    if (a.storageKey) {
      if (!process.env.S3_BUCKET)
        throw new Error(
          "S3 asset found but source bucket credentials are not configured.",
        );
      const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
      s3 ||= new S3Client({
        region: process.env.S3_REGION || "auto",
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
        credentials: process.env.S3_ACCESS_KEY_ID
          ? {
              accessKeyId: process.env.S3_ACCESS_KEY_ID,
              secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
            }
          : undefined,
      });
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: a.storageKey,
        }),
      );
      await writeFile(target, await object.Body.transformToByteArray(), {
        mode: 0o600,
        flag: "wx",
      });
    } else {
      await copyFile(resolve(".local/uploads", name), target);
      await chmod(target, 0o600);
    }
    assets.push({
      filename: name,
      sha256: await hashFile(target),
      bytes: (await stat(target)).size,
    });
  }
  const key = process.env.X_ENCRYPTION_KEY
    ? Buffer.from(process.env.X_ENCRYPTION_KEY, "hex")
    : await readFile(resolve(".local/master.key"));
  if (key.length !== 32)
    throw new Error("Encryption key must be exactly 32 bytes");
  await writeFile(join(folder, "encryption.key"), key, {
    flag: "wx",
    mode: 0o600,
  });
  const manifest = {
    format: "x-ecommerce-backup",
    version: 1,
    complete: true,
    sourceDatabase: process.env.MYSQL_DATABASE || "x_ecommerce",
    createdAt: new Date().toISOString(),
    databaseSha256: await hashFile(join(folder, "database.ndjson.gz")),
    keySha256: await hashFile(join(folder, "encryption.key")),
    counts,
    assets,
    mediaRestoreMode: "local",
  };
  await writeFile(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      ok: true,
      directory: folder,
      tables: tables.length,
      assets: assets.length,
    }),
  );
} catch (e) {
  await db.rollback().catch(() => {});
  console.error(
    "Backup incomplete:",
    e.message,
    "The directory is not restorable unless manifest.json marks it complete.",
  );
  process.exitCode = 1;
} finally {
  if (lock)
    await db.query("SELECT RELEASE_LOCK('x_ecommerce_worker')").catch(() => {});
  await db.end();
}
