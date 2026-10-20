import { pool, execute, rows } from "./db.ts";
import { cleanExpiredUploads } from "./storage.ts";
import { reconcileCredits } from "./credits.ts";
import { tick, recoverJobs } from "./jobs.ts";
import { scheduleAutomations } from "./automations.ts";
import { reconcileOperations } from "./operations.ts";
import { reconcileProjects } from "./projects.ts";
let recovered = false,
  active = false;
export async function workerCycle() {
  if (active) return;
  active = true;
  let c;
  let acquired = false;
  try {
    c = await pool.getConnection();
    const [r]: any = await c.query(
      "SELECT GET_LOCK('x_ecommerce_worker',0) acquired",
    );
    acquired = Number(r[0].acquired) === 1;
    if (!acquired) return;
    if (!recovered) {
      await recoverJobs();
      recovered = true;
    }
    await scheduleAutomations();
    await tick();
    await reconcileProjects();
    await reconcileOperations();
    await reconcileCredits();
    await cleanExpiredUploads();
    await execute(
      "INSERT INTO system_state(id,payload) VALUES('worker',?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),updated_at=CURRENT_TIMESTAMP(3)",
      [
        JSON.stringify({
          pid: process.pid,
          lastHeartbeat: new Date().toISOString(),
        }),
      ],
    );
  } finally {
    if (acquired && c)
      await c.query("SELECT RELEASE_LOCK('x_ecommerce_worker')");
    c?.release();
    active = false;
  }
}
