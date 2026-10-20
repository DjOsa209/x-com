import { execute } from "./db.ts";

export async function migrateOperations() {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS operation_settings(workspace_id VARCHAR(64) PRIMARY KEY,body JSON NOT NULL,updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3))`,
    `CREATE TABLE IF NOT EXISTS publications(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,title VARCHAR(200) NOT NULL,status VARCHAR(32) NOT NULL DEFAULT 'draft',body JSON NOT NULL,job_id VARCHAR(64),scheduled_at DATETIME(3),created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),INDEX publication_list(workspace_id,status,created_at))`,
    `CREATE TABLE IF NOT EXISTS content_metrics(id BIGINT AUTO_INCREMENT PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,publication_id VARCHAR(64) NOT NULL,external_id VARCHAR(128),source VARCHAR(32) NOT NULL,metrics JSON NOT NULL,observed_at DATETIME(3) NOT NULL,created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),INDEX metric_content(workspace_id,publication_id,observed_at))`,
    `CREATE TABLE IF NOT EXISTS research_runs(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,automation_id VARCHAR(64),job_id VARCHAR(64) UNIQUE,kind VARCHAR(32) NOT NULL,status VARCHAR(32) NOT NULL DEFAULT 'queued',input JSON NOT NULL,evidence JSON NOT NULL,request_count INT NOT NULL DEFAULT 0,max_requests INT NOT NULL DEFAULT 30,daily_limit INT NOT NULL DEFAULT 100,result JSON,error TEXT,started_at DATETIME(3),finished_at DATETIME(3),created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),INDEX research_history(workspace_id,created_at))`,
    `CREATE TABLE IF NOT EXISTS research_budget_buckets(workspace_id VARCHAR(64) NOT NULL,bucket_key VARCHAR(191) NOT NULL,used INT NOT NULL DEFAULT 0,PRIMARY KEY(workspace_id,bucket_key))`,
    `CREATE TABLE IF NOT EXISTS research_requests(id BIGINT AUTO_INCREMENT PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,run_id VARCHAR(64),provider VARCHAR(32) NOT NULL,endpoint VARCHAR(256) NOT NULL,status VARCHAR(16) NOT NULL DEFAULT 'sent',created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),INDEX research_requests_run(workspace_id,run_id))`,
    `CREATE TABLE IF NOT EXISTS operation_notifications(id VARCHAR(64) PRIMARY KEY,workspace_id VARCHAR(64) NOT NULL,dedupe_key VARCHAR(191) NOT NULL,title VARCHAR(200) NOT NULL,message TEXT NOT NULL,href VARCHAR(512),read_at DATETIME(3),created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),UNIQUE notification_dedupe(workspace_id,dedupe_key),INDEX notification_list(workspace_id,created_at))`,
  ])
    await execute(sql);
}
