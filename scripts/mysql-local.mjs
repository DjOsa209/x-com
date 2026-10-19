import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  openSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const root = resolve(".local/mysql");
const binary =
  process.env.MYSQLD_BIN ||
  (existsSync("/usr/local/mysql/bin/mysqld")
    ? "/usr/local/mysql/bin/mysqld"
    : "mysqld");
const client =
  process.env.MYSQL_BIN ||
  (existsSync("/usr/local/mysql/bin/mysql")
    ? "/usr/local/mysql/bin/mysql"
    : "mysql");
const port = Number(process.env.X_MYSQL_PORT || 3308);
mkdirSync(root, { recursive: true, mode: 0o700 });
const pidFile = resolve(root, "mysql.pid");
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      console.log(`本项目的 MySQL 实例已在运行（PID ${pid}），无需重复启动。`);
      process.exit(0);
    } catch {}
  }
}
const data = resolve(root, "data");
const socket = resolve(root, "mysql.sock");
const fresh = !existsSync(resolve(data, "mysql"));
const base = binary.startsWith("/")
  ? ["--basedir=" + dirname(dirname(binary))]
  : [];
if (fresh) {
  if (existsSync(".env.local"))
    throw new Error(
      "已有 .env.local，请先配置现有 MySQL，或使用新的工作区初始化本地实例。",
    );
  const init = spawnSync(
    binary,
    ["--no-defaults", ...base, "--initialize-insecure", "--datadir=" + data],
    { encoding: "utf8" },
  );
  if (init.status !== 0) throw new Error(init.stderr || "MySQL 初始化失败");
}
const log = openSync(resolve(root, "process.log"), "a");
const child = spawn(
  binary,
  [
    "--no-defaults",
    ...base,
    "--datadir=" + data,
    "--port=" + port,
    "--bind-address=127.0.0.1",
    "--mysqlx=OFF",
    "--socket=" + socket,
    "--pid-file=" + resolve(root, "mysql.pid"),
    "--log-error=" + resolve(root, "mysql.log"),
  ],
  { stdio: ["ignore", log, log] },
);
child.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
for (let i = 0; i < 120; i++) {
  if (child.exitCode !== null)
    throw new Error(
      "MySQL 未能启动，查看 .local/mysql/mysql.log；可能端口已占用。",
    );
  if (existsSync(socket)) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (fresh) {
  const password = randomBytes(24).toString("hex");
  const rootPassword = randomBytes(32).toString("hex");
  const sql = `CREATE DATABASE IF NOT EXISTS x_ecommerce CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'x_ecommerce'@'127.0.0.1' IDENTIFIED BY '${password}';
CREATE USER 'x_ecommerce'@'localhost' IDENTIFIED BY '${password}';
GRANT ALL ON x_ecommerce.* TO 'x_ecommerce'@'127.0.0.1';
GRANT ALL ON x_ecommerce.* TO 'x_ecommerce'@'localhost';
ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}';`;
  const result = spawnSync(
    client,
    ["--no-defaults", "--socket=" + socket, "-u", "root"],
    { input: sql, encoding: "utf8" },
  );
  if (result.status !== 0) {
    child.kill("SIGTERM");
    throw new Error("本地账户初始化失败，检查 MySQL 日志。");
  }
  writeFileSync(
    ".env.local",
    `HOST=127.0.0.1\nPORT=4317\nMYSQL_HOST=127.0.0.1\nMYSQL_PORT=${port}\nMYSQL_USER=x_ecommerce\nMYSQL_PASSWORD=${password}\nMYSQL_DATABASE=x_ecommerce\n`,
    { mode: 0o600 },
  );
  writeFileSync(resolve(root, "root-password"), rootPassword, { mode: 0o600 });
}
console.log(
  `独立 MySQL 已启动：127.0.0.1:${port}（数据位于 .local/mysql，未修改系统 MySQL）`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill("SIGTERM"));
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
