import dotenv from "dotenv";
import mysql from "mysql2";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
export const identifier = (name) => {
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(name || ""))
    throw new Error(
      "Database name must contain 1–64 letters, digits or underscores",
    );
  return name;
};
export function connection(
  database = process.env.MYSQL_DATABASE || "x_ecommerce",
  withoutDatabase = false,
) {
  return mysql.createConnection({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3308),
    user: process.env.MYSQL_USER || "x_ecommerce",
    password: process.env.MYSQL_PASSWORD,
    ...(!withoutDatabase ? { database: identifier(database) } : {}),
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: true,
    jsonStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}
export function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}
export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function emptyDirectory(path) {
  try {
    return (await readdir(path)).length === 0;
  } catch (e) {
    if (e.code === "ENOENT") return true;
    throw e;
  }
}
export const safeFilename = (name) => {
  if (
    typeof name !== "string" ||
    basename(name) !== name ||
    !name ||
    name.includes("\\")
  )
    throw new Error("Unsafe media filename in backup");
  return name;
};
export const encode = (value) =>
  Buffer.isBuffer(value) ? { binary: value.toString("base64") } : value;
export const decode = (value) =>
  value && typeof value === "object" && typeof value.binary === "string"
    ? Buffer.from(value.binary, "base64")
    : value;
export { mysql, resolve };
