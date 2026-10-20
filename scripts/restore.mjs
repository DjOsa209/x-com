import { mkdir, readFile, copyFile, chmod, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import {
  connection,
  arg,
  hashFile,
  safeFilename,
  decode,
  identifier,
  emptyDirectory,
  mysql,
  resolve,
} from "./backup-common.mjs";
const from = arg("--from"),
  target = arg("--database"),
  media = arg("--local-dir");
if (!from || !target || !media) {
  console.error(
    "Usage: npm run restore -- --from /secure/backup --database NEW_EMPTY_DATABASE --local-dir /new/local-directory",
  );
  process.exit(1);
}
const folder = resolve(from),
  local = resolve(media),
  name = identifier(target),
  c = connection(undefined, true),
  db = c.promise();
try {
  const manifest = JSON.parse(
    await readFile(join(folder, "manifest.json"), "utf8"),
  );
  if (
    manifest.format !== "x-ecommerce-backup" ||
    manifest.version !== 1 ||
    !manifest.complete
  )
    throw new Error("Backup manifest is incomplete or unsupported");
  if (name === manifest.sourceDatabase)
    throw new Error(
      "Restore requires a different database name; switch application configuration after verifying the new database.",
    );
  if (!(await emptyDirectory(local)))
    throw new Error("Restore local directory must be new or empty");
  if (
    (await hashFile(join(folder, "database.ndjson.gz"))) !==
      manifest.databaseSha256 ||
    (await hashFile(join(folder, "encryption.key"))) !== manifest.keySha256
  )
    throw new Error("Backup database/key checksum mismatch");
  for (const a of manifest.assets) {
    const filename = safeFilename(a.filename);
    if ((await hashFile(join(folder, "media", filename))) !== a.sha256)
      throw new Error("Backup media checksum mismatch: " + filename);
  }
  const [databases] = await db.query("SHOW DATABASES LIKE ?", [name]);
  if (databases.length) {
    await db.query("USE " + mysql.escapeId(name));
    const [tables] = await db.query("SHOW TABLES");
    if (tables.length)
      throw new Error(
        "Target database contains tables; no existing data will be overwritten",
      );
  } else
    await db.query(
      "CREATE DATABASE " +
        mysql.escapeId(name) +
        " CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
    );
  await db.query("USE " + mysql.escapeId(name));
  await db.query("SET time_zone='+00:00'");
  await db.query("SET FOREIGN_KEY_CHECKS=0");
  let current = null,
    columns = [];
  const counts = {};
  let header = false;
  const lines = createInterface({
    input: createReadStream(join(folder, "database.ndjson.gz")).pipe(
      createGunzip(),
    ),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const data = JSON.parse(line);
    if (!header) {
      if (data.format !== "x-ecommerce-backup" || data.version !== 1)
        throw new Error("Invalid snapshot header");
      header = true;
      continue;
    }
    if (data.table) {
      current = identifier(data.table);
      columns = data.columns;
      if (!Array.isArray(columns) || !columns.length)
        throw new Error("Invalid backup column list");
      if (
        typeof data.ddl !== "string" ||
        !data.ddl.startsWith("CREATE TABLE " + mysql.escapeId(current) + " ")
      )
        throw new Error("Invalid backup table declaration");
      await db.query(data.ddl);
      counts[current] = 0;
    } else if (data.row) {
      if (!current || data.row.length !== columns.length)
        throw new Error("Invalid backup row");
      await db.execute(
        "INSERT INTO " +
          mysql.escapeId(current) +
          " (" +
          columns.map(mysql.escapeId).join(",") +
          ") VALUES (" +
          columns.map(() => "?").join(",") +
          ")",
        data.row.map(decode),
      );
      counts[current]++;
    } else throw new Error("Unknown backup record");
  }
  if (!header || JSON.stringify(counts) !== JSON.stringify(manifest.counts))
    throw new Error("Restored row counts differ from manifest");
  // All media bytes are included even for S3 sources; a restore is deliberately local until verified.
  await db.query(
    "UPDATE records SET body=JSON_SET(body,'$.storageKey',NULL) WHERE kind='asset' AND JSON_EXTRACT(body,'$.storageKey') IS NOT NULL",
  );
  await mkdir(join(local, "uploads"), { recursive: true, mode: 0o700 });
  for (const a of manifest.assets) {
    const filename = safeFilename(a.filename);
    await copyFile(
      join(folder, "media", filename),
      join(local, "uploads", filename),
    );
    await chmod(join(local, "uploads", filename), 0o600);
  }
  await copyFile(join(folder, "encryption.key"), join(local, "master.key"));
  await chmod(join(local, "master.key"), 0o600);
  await writeFile(
    join(local, "restore-manifest.json"),
    JSON.stringify(
      {
        source: folder,
        database: name,
        restoredAt: new Date().toISOString(),
        counts,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await db.query("SET FOREIGN_KEY_CHECKS=1");
  console.log(
    JSON.stringify({
      ok: true,
      database: name,
      localDirectory: local,
      tables: Object.keys(counts).length,
      assets: manifest.assets.length,
      next: "Use the restored key, MYSQL_DATABASE and STORAGE_DRIVER=local; run migrations and verify before starting workers.",
    }),
  );
} catch (e) {
  console.error(
    "Restore stopped:",
    e.message,
    "No existing database was dropped. An interrupted target must be inspected or restored again to a new empty database.",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
