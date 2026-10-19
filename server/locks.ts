import { pool } from "./db.ts";
import { AppError } from "./errors.ts";
import { createHash } from "node:crypto";
// Cross-process lock: manual refresh and workers must not advance the same
// provider request at once, especially between frame and video submission.
export async function withJobLock<T>(
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  const c = await pool.getConnection(),
    name =
      "x-job-" + createHash("sha256").update(id).digest("hex").slice(0, 48);
  let acquired = false;
  try {
    const [result]: any = await c.query("SELECT GET_LOCK(?,0) acquired", [
      name,
    ]);
    acquired = Number(result[0].acquired) === 1;
    if (!acquired)
      throw new AppError(
        409,
        "任务正在被另一个进程处理，请稍后刷新",
        "JOB_BUSY",
      );
    return await action();
  } finally {
    if (acquired) await c.query("SELECT RELEASE_LOCK(?)", [name]);
    c.release();
  }
}
