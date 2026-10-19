import "./env.ts";
import mysql, {
  type RowDataPacket,
  type ResultSetHeader,
} from "mysql2/promise";
import { randomUUID } from "node:crypto";

export const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3308),
  user: process.env.MYSQL_USER || "x_ecommerce",
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "x_ecommerce",
  connectionLimit: 8,
  charset: "utf8mb4",
  timezone: "Z",
  supportBigNumbers: true,
  bigNumberStrings: true,
  connectTimeout: 5000,
});
pool.on("connection", (connection) => {
  connection.query("SET time_zone='+00:00'");
});
export type Doc = Record<string, any>;
export const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
export async function rows(sql: string, values: any[] = []) {
  const [r] = await pool.execute<RowDataPacket[]>(sql, values);
  return r;
}
export async function execute(sql: string, values: any[] = []) {
  const [r] = await pool.execute<ResultSetHeader>(sql, values);
  return r;
}
export async function migrate() {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS records (id VARCHAR(64) PRIMARY KEY, kind VARCHAR(32) NOT NULL, body JSON NOT NULL, created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX by_kind (kind, created_at))`,
    `CREATE TABLE IF NOT EXISTS jobs (id VARCHAR(64) PRIMARY KEY, kind VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'queued', input JSON NOT NULL, result JSON NULL, provider JSON NULL, error TEXT NULL, run_at DATETIME(3) NULL, dedupe_key VARCHAR(128) UNIQUE, created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX pending (status, run_at))`,
    `CREATE TABLE IF NOT EXISTS cache_entries (cache_key CHAR(64) PRIMARY KEY, payload JSON NOT NULL, expires_at DATETIME(3) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS api_usage (id BIGINT AUTO_INCREMENT PRIMARY KEY, provider VARCHAR(32) NOT NULL, endpoint VARCHAR(256) NOT NULL, success BOOLEAN NOT NULL, cached BOOLEAN DEFAULT FALSE, created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), INDEX by_date (created_at))`,
    `CREATE TABLE IF NOT EXISTS settings (id VARCHAR(32) PRIMARY KEY, payload LONGTEXT NOT NULL)`,
  ])
    await execute(sql);
}
export function record(r: Doc): Doc {
  return {
    ...parse(r.body),
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export async function list(kind: string) {
  return (
    await rows(
      "SELECT * FROM records WHERE kind=? ORDER BY created_at DESC LIMIT 1000",
      [kind],
    )
  ).map(record);
}
export async function get(id: string, kind?: string) {
  const [r] = await rows(
    "SELECT * FROM records WHERE id=?" + (kind ? " AND kind=?" : ""),
    kind ? [id, kind] : [id],
  );
  return r ? record(r) : undefined;
}
export async function put(kind: string, body: Doc, id: string = randomUUID()) {
  const clean = { ...body };
  delete clean.id;
  delete clean.createdAt;
  delete clean.updatedAt;
  await execute(
    "INSERT INTO records (id,kind,body) VALUES (?,?,?) ON DUPLICATE KEY UPDATE body=VALUES(body)",
    [id, kind, JSON.stringify(clean)],
  );
  return get(id, kind);
}
export async function remove(id: string, kind: string) {
  return execute("DELETE FROM records WHERE id=? AND kind=?", [id, kind]);
}
export function job(r: Doc): Doc {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    input: parse(r.input),
    result: parse(r.result),
    error: r.error,
    runAt: r.run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export async function jobList() {
  return (
    await rows("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200")
  ).map(job);
}
export async function jobGet(id: string) {
  const [r] = await rows("SELECT * FROM jobs WHERE id=?", [id]);
  return r;
}
export async function updateJob(id: string, fields: Doc) {
  const keys = Object.keys(fields).filter((k) =>
    ["status", "result", "provider", "error", "run_at"].includes(k),
  );
  if (!keys.length) return;
  await execute(
    `UPDATE jobs SET ${keys.map((k) => "`" + k + "`=?").join(",")} WHERE id=?`,
    [
      ...keys.map((k) =>
        ["result", "provider"].includes(k) && fields[k] !== null
          ? JSON.stringify(fields[k])
          : fields[k],
      ),
      id,
    ],
  );
}
