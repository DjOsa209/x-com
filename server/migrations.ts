import { pool, execute, rows } from "./db.ts";
import { migrateFoundation } from "./core-schema.ts";

/** Additive, retryable migrations. Versions are recorded only after success. */
export async function migrateTeamEdition() {
  const c = await pool.getConnection();
  try {
    const [lock]: any = await c.query(
      "SELECT GET_LOCK('x_ecommerce_migrations',60) acquired",
    );
    if (!Number(lock[0].acquired))
      throw new Error("Database migration is busy");
    await execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations(version VARCHAR(80) PRIMARY KEY,applied_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3))`,
    );
    const steps = [
      { id: "030-foundation", run: migrateFoundation },
      {
        id: "031-commerce",
        run: async () =>
          (await import("./research-schema.ts")).migrateCommerce(),
      },
      {
        id: "032-studio",
        run: async () => (await import("./projects.ts")).migrateVideoStudio(),
      },
      {
        id: "033-operations",
        run: async () =>
          (await import("./operations-schema.ts")).migrateOperations(),
      },
      {
        id: "035-legacy-commerce",
        run: async () =>
          (await import("./research-domain.ts")).migrateLegacyCommerce(),
      },
    ];
    for (const step of steps) {
      if (
        (
          await rows("SELECT version FROM schema_migrations WHERE version=?", [
            step.id,
          ])
        ).length
      )
        continue;
      await step.run();
      await execute("INSERT IGNORE INTO schema_migrations(version) VALUES(?)", [
        step.id,
      ]);
    }
  } finally {
    await c.query("SELECT RELEASE_LOCK('x_ecommerce_migrations')");
    c.release();
  }
}
