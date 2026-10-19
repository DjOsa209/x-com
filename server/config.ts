import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rows, execute, type Doc } from "./db.ts";
import { AppError } from "./errors.ts";

mkdirSync(".local", { recursive: true, mode: 0o700 });
const keyFile = resolve(".local/master.key");
if (!existsSync(keyFile))
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
const key = process.env.X_ENCRYPTION_KEY
  ? Buffer.from(process.env.X_ENCRYPTION_KEY, "hex")
  : readFileSync(keyFile);
if (key.length !== 32)
  throw new Error("X_ENCRYPTION_KEY must be 64 hexadecimal characters");
export function seal(value: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([
    iv,
    c.update(value),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
export function unseal(value: string) {
  const b = Buffer.from(value, "base64");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
}
export const defaults: Doc = {
  ECHOTIK_BASE_URL: "https://open.echotik.live/api/v3",
  ECHOTIK_USERNAME: "",
  ECHOTIK_PASSWORD: "",
  ECHOTIK_MONTHLY_LIMIT: "100000",
  ECHOTIK_CACHE_SECONDS: "900",
  GEMINI_API_KEY: "",
  GEMINI_MODEL: "gemini-2.5-flash",
  FAL_KEY: "",
  FAL_VIDEO_MODEL: "fal-ai/kling-video/v3/standard/image-to-video",
  FAL_IMAGE_MODEL: "fal-ai/flux/schnell",
  FAL_IMAGE_EDIT_MODEL: "fal-ai/nano-banana-2/edit",
  FAL_ENHANCE_MODEL: "fal-ai/topaz/upscale/video",
  TIKTOK_CLIENT_KEY: "",
  TIKTOK_CLIENT_SECRET: "",
  TIKTOK_REDIRECT_URI: "http://localhost:4317/api/tiktok/callback",
  TIKTOK_SCOPES: "user.info.basic,video.publish,video.upload,video.list",
  DOWNLOAD_RESOLVER_URL: "",
  DOWNLOAD_RESOLVER_KEY: "",
};
export const secretKeys = [
  "ECHOTIK_USERNAME",
  "ECHOTIK_PASSWORD",
  "GEMINI_API_KEY",
  "FAL_KEY",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "DOWNLOAD_RESOLVER_KEY",
];
export async function config(): Promise<Doc> {
  const [r] = await rows("SELECT payload FROM settings WHERE id=?", [
    "providers",
  ]);
  const saved = r ? JSON.parse(unseal(r.payload)) : {};
  return Object.fromEntries(
    Object.entries(defaults).map(([k, v]) => [
      k,
      saved[k] ?? process.env[k] ?? v,
    ]),
  );
}
export async function saveConfig(patch: Doc) {
  for (const [k, min, max] of [
    ["ECHOTIK_MONTHLY_LIMIT", 1, 100000000],
    ["ECHOTIK_CACHE_SECONDS", 0, 86400],
  ] as const) {
    if (
      patch[k] !== undefined &&
      (!Number.isInteger(Number(patch[k])) ||
        Number(patch[k]) < min ||
        Number(patch[k]) > max)
    )
      throw new AppError(400, `${k} 必须为 ${min}–${max} 之间的整数`);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (k !== "clearSecrets" && typeof v !== "string" && typeof v !== "number")
      throw new AppError(400, "配置格式无效");
    if (typeof v === "string" && v.length > 4096)
      throw new AppError(400, "配置值过长");
  }
  if (
    patch.clearSecrets !== undefined &&
    (!Array.isArray(patch.clearSecrets) ||
      patch.clearSecrets.some((v: any) => !secretKeys.includes(v)))
  )
    throw new AppError(400, "清除凭证参数无效");
  const old = await config();
  for (const k of Object.keys(defaults))
    if (patch[k] !== undefined && !(secretKeys.includes(k) && patch[k] === ""))
      old[k] = String(patch[k]);
  for (const k of patch.clearSecrets || [])
    if (secretKeys.includes(k)) old[k] = "";
  await execute("REPLACE INTO settings(id,payload) VALUES(?,?)", [
    "providers",
    seal(JSON.stringify(old)),
  ]);
}
export async function publicConfig() {
  const c = await config();
  return {
    values: Object.fromEntries(
      Object.entries(c).filter(([k]) => !secretKeys.includes(k)),
    ),
    secrets: Object.fromEntries(secretKeys.map((k) => [k, Boolean(c[k])])),
    connections: {
      echotik: !!(c.ECHOTIK_USERNAME && c.ECHOTIK_PASSWORD),
      gemini: !!c.GEMINI_API_KEY,
      fal: !!c.FAL_KEY,
      tiktok: !!(c.TIKTOK_CLIENT_KEY && c.TIKTOK_CLIENT_SECRET),
      resolver: !!c.DOWNLOAD_RESOLVER_URL,
    },
  };
}
