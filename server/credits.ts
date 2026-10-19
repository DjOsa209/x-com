import { pool, rows, execute, type Doc } from "./db.ts";
import { workspace, inWorkspace } from "./context.ts";
import { config } from "./config.ts";
import { AppError } from "./errors.ts";
export async function wallet(): Promise<Doc> {
  await execute("INSERT IGNORE INTO credit_wallets(workspace_id) VALUES(?)", [
    workspace(),
  ]);
  const [w] = await rows("SELECT * FROM credit_wallets WHERE workspace_id=?", [
    workspace(),
  ]);
  return {
    ...w,
    balance: Number(w.balance),
    reserved: Number(w.reserved),
    enabled: !!w.enabled,
    remainingCredits: Number(w.balance) - Number(w.reserved),
    frozenCredits: Number(w.reserved),
  };
}
export async function setMetered(enabled: boolean) {
  await wallet();
  await execute("UPDATE credit_wallets SET enabled=? WHERE workspace_id=?", [
    enabled,
    workspace(),
  ]);
  return wallet();
}
export async function grantCredits(
  units: number,
  reference: string,
  note = "管理员发放",
  workspaceId = workspace(),
) {
  if (!Number.isSafeInteger(units) || units < 1 || units > 100000000)
    throw new AppError(400, "额度必须为 1–100000000 的整数");
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    await c.execute(
      "INSERT IGNORE INTO credit_wallets(workspace_id) VALUES(?)",
      [workspaceId],
    );
    const [existing]: any = await c.execute(
      "SELECT id FROM credit_ledger WHERE reference=?",
      [reference],
    );
    if (existing.length) {
      await c.commit();
      return { duplicate: true };
    }
    const [ws]: any = await c.execute(
      "SELECT balance FROM credit_wallets WHERE workspace_id=? FOR UPDATE",
      [workspaceId],
    );
    const balance = Number(ws[0].balance) + units;
    await c.execute(
      "UPDATE credit_wallets SET balance=? WHERE workspace_id=?",
      [balance, workspaceId],
    );
    await c.execute(
      "INSERT INTO credit_ledger(workspace_id,reference,kind,units,balance_after,note) VALUES(?,?,?,?,?,?)",
      [workspaceId, reference, "grant", units, balance, note],
    );
    await c.commit();
    return { duplicate: false };
  } catch (e: any) {
    await c.rollback();
    if (e.code === "ER_DUP_ENTRY") return { duplicate: true };
    throw e;
  } finally {
    c.release();
  }
}
export async function reserveCredits(jobId: string, kind: string) {
  const w = await wallet();
  if (!w.enabled) return;
  const cfg = await config();
  let costs: Doc;
  try {
    costs = JSON.parse(cfg.CREDIT_COSTS_JSON);
  } catch {
    throw new AppError(400, "任务额度配置无效");
  }
  const units = Number(costs[kind] ?? 1);
  if (!Number.isSafeInteger(units) || units < 0)
    throw new AppError(400, "任务额度必须为非负整数");
  if (!units) return;
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [existing]: any = await c.execute(
      "SELECT job_id FROM credit_reservations WHERE job_id=?",
      [jobId],
    );
    if (existing.length) {
      await c.commit();
      return;
    }
    const [ws]: any = await c.execute(
      "SELECT * FROM credit_wallets WHERE workspace_id=? FOR UPDATE",
      [workspace()],
    );
    if (Number(ws[0].balance) - Number(ws[0].reserved) < units)
      throw new AppError(402, "工作空间可用额度不足", "INSUFFICIENT_CREDITS");
    await c.execute(
      "UPDATE credit_wallets SET reserved=reserved+? WHERE workspace_id=?",
      [units, workspace()],
    );
    await c.execute(
      "INSERT INTO credit_reservations(job_id,workspace_id,units,status) VALUES(?,?,?,'reserved')",
      [jobId, workspace(), units],
    );
    await c.execute(
      "INSERT INTO credit_ledger(workspace_id,reference,kind,units,balance_after,note) VALUES(?,?,?,?,?,?)",
      [workspace(), "reserve:" + jobId, "reserve", units, ws[0].balance, kind],
    );
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
export async function finalizeCredits(jobId: string, charge: boolean) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [rs]: any = await c.execute(
      "SELECT * FROM credit_reservations WHERE job_id=? AND workspace_id=? AND status='reserved' FOR UPDATE",
      [jobId, workspace()],
    );
    if (!rs.length) {
      await c.commit();
      return;
    }
    const r = rs[0],
      units = Number(r.units);
    const [ws]: any = await c.execute(
      "SELECT * FROM credit_wallets WHERE workspace_id=? FOR UPDATE",
      [workspace()],
    );
    const balance = Number(ws[0].balance) - (charge ? units : 0);
    await c.execute(
      "UPDATE credit_wallets SET balance=?,reserved=reserved-? WHERE workspace_id=?",
      [balance, units, workspace()],
    );
    await c.execute("UPDATE credit_reservations SET status=? WHERE job_id=?", [
      charge ? "consumed" : "released",
      jobId,
    ]);
    await c.execute(
      "INSERT INTO credit_ledger(workspace_id,reference,kind,units,balance_after,note) VALUES(?,?,?,?,?,?)",
      [
        workspace(),
        "final:" + jobId,
        charge ? "consume" : "release",
        units,
        balance,
        "任务终态",
      ],
    );
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
export const ledger = () =>
  rows(
    "SELECT * FROM credit_ledger WHERE workspace_id=? ORDER BY id DESC LIMIT 200",
    [workspace()],
  );

// Settlement is separate from provider execution: a ledger outage must never
// relabel an already generated result as a provider failure.
export async function reconcileCredits() {
  await execute(
    "UPDATE jobs SET status='cancelled',error='未提交的确认事务已过期，额度将退回' WHERE status='held' AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR)",
  );
  const pending = await rows(
    `SELECT r.job_id,r.workspace_id,j.status FROM credit_reservations r LEFT JOIN jobs j ON j.id=r.job_id AND j.workspace_id=r.workspace_id WHERE r.status='reserved' AND (j.status IN ('completed','inbox','failed','cancelled') OR (j.id IS NULL AND r.created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 MINUTE))) ORDER BY r.created_at LIMIT 100`,
  );
  for (const r of pending)
    await inWorkspace(r.workspace_id, () =>
      finalizeCredits(r.job_id, ["completed", "inbox"].includes(r.status)),
    );
}
