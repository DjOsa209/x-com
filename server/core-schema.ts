import { execute } from "./db.ts";
export async function migrateFoundation() {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS asset_references(workspace_id VARCHAR(64) NOT NULL,owner_type VARCHAR(48) NOT NULL,owner_id VARCHAR(64) NOT NULL,asset_id VARCHAR(64) NOT NULL,PRIMARY KEY(workspace_id,owner_type,owner_id,asset_id),INDEX by_asset(workspace_id,asset_id))`,
    `CREATE TABLE IF NOT EXISTS password_resets(token_hash CHAR(64) PRIMARY KEY,user_id VARCHAR(64) NOT NULL,expires_at DATETIME(3) NOT NULL,used_at DATETIME(3) NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS auth_attempts(attempt_key CHAR(64) PRIMARY KEY,attempts INT NOT NULL DEFAULT 0,window_start DATETIME(3) NOT NULL)`,
  ])
    await execute(sql);
}
