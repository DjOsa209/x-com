import "./env.ts";
import mysql, {
  type RowDataPacket,
  type ResultSetHeader,
} from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { workspace } from "./context.ts";

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
  for (const table of ["records", "jobs", "api_usage"]) {
    const [column] = await rows(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
      [table, "workspace_id"],
    );
    if (!column)
      await execute(
        `ALTER TABLE ${table} ADD COLUMN workspace_id VARCHAR(64) NOT NULL DEFAULT 'local', ADD INDEX tenant_idx(workspace_id)`,
      );
  }
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS users(id VARCHAR(64) PRIMARY KEY,email VARCHAR(254) UNIQUE NOT NULL,name VARCHAR(100) NOT NULL,password_hash VARCHAR(255) NOT NULL,global_role VARCHAR(16) DEFAULT 'member',disabled BOOLEAN DEFAULT FALSE,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS workspaces(id VARCHAR(64) PRIMARY KEY,name VARCHAR(120) NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS memberships(workspace_id VARCHAR(64) NOT NULL,user_id VARCHAR(64) NOT NULL,role VARCHAR(16) NOT NULL,PRIMARY KEY(workspace_id,user_id))`,
    `CREATE TABLE IF NOT EXISTS sessions(token_hash CHAR(64) PRIMARY KEY,user_id VARCHAR(64) NOT NULL,expires_at DATETIME NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS invites(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,email VARCHAR(254) NOT NULL,role VARCHAR(16) NOT NULL,token_hash CHAR(64) UNIQUE NOT NULL,expires_at DATETIME NOT NULL,accepted_at DATETIME NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS audit_log(id BIGINT AUTO_INCREMENT PRIMARY KEY,workspace_id VARCHAR(64),user_id VARCHAR(64),action VARCHAR(100) NOT NULL,details JSON,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS credit_wallets(workspace_id VARCHAR(64) PRIMARY KEY,balance BIGINT NOT NULL DEFAULT 0,reserved BIGINT NOT NULL DEFAULT 0,enabled BOOLEAN DEFAULT FALSE)`,
    `CREATE TABLE IF NOT EXISTS credit_reservations(job_id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,units BIGINT NOT NULL,status VARCHAR(16) NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS credit_ledger(id BIGINT AUTO_INCREMENT PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,reference VARCHAR(191) UNIQUE NOT NULL,kind VARCHAR(32) NOT NULL,units BIGINT NOT NULL,balance_after BIGINT NOT NULL,note VARCHAR(255),created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS billing_orders(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,session_id VARCHAR(191) UNIQUE,price_id VARCHAR(191) NOT NULL,units BIGINT NOT NULL,status VARCHAR(32) NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS projects(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,name VARCHAR(200) NOT NULL,status VARCHAR(32) NOT NULL,input JSON NOT NULL,script JSON NULL,version INT NOT NULL DEFAULT 1,analysis_job_id VARCHAR(64),render_job_ids JSON,cancel_requested BOOLEAN DEFAULT FALSE,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),INDEX tenant_projects(workspace_id,created_at))`,
    `CREATE TABLE IF NOT EXISTS project_confirmations(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,project_id VARCHAR(64) NOT NULL,version INT NOT NULL,content_hash CHAR(64) NOT NULL,snapshot JSON NOT NULL,job_ids JSON NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),UNIQUE project_version(project_id,version))`,
    `CREATE TABLE IF NOT EXISTS automations(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,name VARCHAR(200) NOT NULL,kind VARCHAR(32) NOT NULL,input JSON NOT NULL,interval_minutes INT NOT NULL,next_run_at DATETIME(3) NOT NULL,enabled BOOLEAN DEFAULT TRUE,last_job_id VARCHAR(64),last_error TEXT,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),INDEX due_automation(enabled,next_run_at))`,
    `CREATE TABLE IF NOT EXISTS system_state(id VARCHAR(64) PRIMARY KEY,payload JSON NOT NULL,updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS oauth_states(state_hash CHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,user_id VARCHAR(64) NOT NULL,status VARCHAR(32) NOT NULL,expires_at DATETIME NOT NULL)`,
  ])
    await execute(sql);
  const [reservationDate] = await rows(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='credit_reservations' AND COLUMN_NAME='created_at'",
  );
  if (!reservationDate)
    await execute(
      "ALTER TABLE credit_reservations ADD COLUMN created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)",
    );
  await execute(
    "INSERT IGNORE INTO workspaces(id,name) VALUES('local','我的工作空间')",
  );
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
      "SELECT * FROM records WHERE kind=? AND workspace_id=? ORDER BY created_at DESC LIMIT 1000",
      [kind, workspace()],
    )
  ).map(record);
}
export async function get(id: string, kind?: string) {
  const [r] = await rows(
    "SELECT * FROM records WHERE id=? AND workspace_id=?" +
      (kind ? " AND kind=?" : ""),
    kind ? [id, workspace(), kind] : [id, workspace()],
  );
  return r ? record(r) : undefined;
}
export async function put(kind: string, body: Doc, id: string = randomUUID()) {
  const clean = { ...body };
  delete clean.id;
  delete clean.createdAt;
  delete clean.updatedAt;
  const [existing] = await rows("SELECT workspace_id FROM records WHERE id=?", [
    id,
  ]);
  if (existing && existing.workspace_id !== workspace())
    throw new Error("Record ownership mismatch");
  await execute(
    "INSERT INTO records (id,kind,body,workspace_id) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE body=VALUES(body)",
    [id, kind, JSON.stringify(clean), workspace()],
  );
  return get(id, kind);
}
export async function remove(id: string, kind: string) {
  return execute(
    "DELETE FROM records WHERE id=? AND kind=? AND workspace_id=?",
    [id, kind, workspace()],
  );
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
    await rows(
      "SELECT * FROM jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200",
      [workspace()],
    )
  ).map(job);
}
export async function jobGet(id: string) {
  const [r] = await rows("SELECT * FROM jobs WHERE id=? AND workspace_id=?", [
    id,
    workspace(),
  ]);
  return r;
}
export async function updateJob(id: string, fields: Doc) {
  const keys = Object.keys(fields).filter((k) =>
    ["status", "result", "provider", "error", "run_at"].includes(k),
  );
  if (!keys.length) return;
  await execute(
    `UPDATE jobs SET ${keys.map((k) => "`" + k + "`=?").join(",")} WHERE id=? AND workspace_id=?`,
    [
      ...keys.map((k) =>
        ["result", "provider"].includes(k) && fields[k] !== null
          ? JSON.stringify(fields[k])
          : fields[k],
      ),
      id,
      workspace(),
    ],
  );
}
