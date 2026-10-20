import "../server/env.ts";
import { rows, pool, parse } from "../server/db.ts";
try {
  const [worker] = await rows(
    "SELECT payload FROM system_state WHERE id='worker'",
  );
  const last = worker && Date.parse(parse(worker.payload)?.lastHeartbeat);
  // Video analysis and local rendering may legitimately occupy a cycle for several minutes.
  if (
    !Number.isFinite(last) ||
    Date.now() - last >
      Number(process.env.WORKER_HEALTH_MAX_AGE_SECONDS || 1200) * 1000
  )
    process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
