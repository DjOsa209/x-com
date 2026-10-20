import "../server/env.ts";
import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { hashToken } from "../server/auth.ts";
import { pool } from "../server/db.ts";
const args = process.argv.slice(2),
  email = args[args.indexOf("--email") + 1],
  out = args[args.indexOf("--out") + 1];
if (!args.includes("--email") || !args.includes("--out") || !email || !out) {
  console.error(
    "Usage: npm run admin:recovery -- --email admin@example.com --out /secure/recovery-link.txt",
  );
  process.exit(1);
}
const c = await pool.getConnection();
let written = false;
try {
  const [users]: any = await c.execute(
    "SELECT id FROM users WHERE email=? AND global_role='admin' AND disabled=0",
    [email.toLowerCase()],
  );
  if (users.length !== 1)
    throw new Error("Active platform administrator not found");
  const token = randomBytes(32).toString("hex"),
    url = new URL(
      "/account",
      process.env.APP_PUBLIC_URL || "http://localhost:4317",
    );
  url.searchParams.set("reset", token);
  await writeFile(resolve(out), url.toString() + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  written = true;
  await c.beginTransaction();
  await c.execute(
    "UPDATE password_resets SET used_at=UTC_TIMESTAMP(3) WHERE user_id=? AND used_at IS NULL",
    [users[0].id],
  );
  await c.execute(
    "INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",
    [hashToken(token), users[0].id],
  );
  await c.execute(
    "INSERT INTO audit_log(user_id,action,details) VALUES(NULL,'admin.recovery_cli',?)",
    [JSON.stringify({ userId: users[0].id })],
  );
  await c.commit();
  console.log(
    `One-hour recovery link saved to ${resolve(out)} (owner-readable only).`,
  );
} catch (e: any) {
  await c.rollback();
  if (written) await unlink(resolve(out)).catch(() => {});
  console.error("Recovery failed:", e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
