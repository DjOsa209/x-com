import "../server/env.ts";
import { migrate, rows, pool } from "../server/db.ts";
try {
  await migrate();
  const versions = await rows(
    "SELECT version,applied_at FROM schema_migrations ORDER BY version",
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        database: process.env.MYSQL_DATABASE || "x_ecommerce",
        versions,
      },
      null,
      2,
    ),
  );
} catch (e: any) {
  console.error("Migration failed:", e.code || e.name, e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
