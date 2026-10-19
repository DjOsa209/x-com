import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { rows, execute, parse, type Doc } from "./db.ts";
import { config } from "./config.ts";
import { AppError } from "./errors.ts";

export type Endpoint = {
  path: string;
  title: string;
  description: string;
  group: string;
  source: string;
  parameters: {
    name: string;
    required: boolean;
    description: string;
    type: string;
    enum?: any[];
    default?: any;
  }[];
};
export const catalog: Endpoint[] = JSON.parse(
  readFileSync(new URL("./data/echotik-catalog.json", import.meta.url), "utf8"),
).endpoints;
export function validateQuery(endpoint: Endpoint, params: Doc) {
  const out: Doc = {};
  for (const p of endpoint.parameters) {
    const v = params[p.name] ?? p.default;
    if (v === "" || v === undefined || v === null) {
      if (p.required)
        throw new AppError(400, `缺少参数 ${p.name}`, "VALIDATION");
      continue;
    }
    if (String(v).length > 4000)
      throw new AppError(400, `参数 ${p.name} 过长`, "VALIDATION");
    if (p.type === "integer" && !/^-?\d+$/.test(String(v)))
      throw new AppError(400, `${p.name} 必须为整数`, "VALIDATION");
    if (p.type === "number" && !Number.isFinite(Number(v)))
      throw new AppError(400, `${p.name} 必须为数字`, "VALIDATION");
    if (p.enum && !p.enum.some((e) => String(e) === String(v)))
      throw new AppError(400, `${p.name} 不在允许的选项内`, "VALIDATION");
    out[p.name] = String(v);
  }
  if (
    out.page_size &&
    Number(out.page_size) > 10 &&
    endpoint.path.startsWith("/echotik/")
  )
    throw new AppError(400, "历史接口 page_size 最多 10", "VALIDATION");
  return out;
}
const inflight = new Map<string, Promise<Doc>>();
export async function echoQuery(
  path: string,
  params: Doc,
  refresh = false,
): Promise<Doc> {
  const ep = catalog.find((e) => e.path === path);
  if (!ep) throw new AppError(400, "不在官方接口白名单中", "UNKNOWN_ENDPOINT");
  const query = validateQuery(ep, params);
  const c = await config();
  if (!c.ECHOTIK_USERNAME || !c.ECHOTIK_PASSWORD)
    throw new AppError(
      409,
      "请在设置中连接 EchoTik API",
      "PROVIDER_NOT_CONFIGURED",
    );
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify([path, Object.entries(query).sort(), c.ECHOTIK_USERNAME]),
    )
    .digest("hex");
  if (!refresh) {
    const [cached] = await rows(
      "SELECT payload FROM cache_entries WHERE cache_key=? AND expires_at>UTC_TIMESTAMP(3)",
      [cacheKey],
    );
    if (cached) return { ...parse(cached.payload), cached: true };
  }
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)!;
  const request = (async () => {
    const [{ used }] = await rows(
      "SELECT COUNT(*) used FROM api_usage WHERE provider='echotik' AND success=1 AND endpoint<>'/echotik/batch/cover/download' AND created_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01')",
    );
    if (
      path !== "/echotik/batch/cover/download" &&
      Number(used) >= Number(c.ECHOTIK_MONTHLY_LIMIT)
    )
      throw new AppError(
        429,
        "达到本平台设置的月度请求预算，请在设置中调整",
        "BUDGET_EXCEEDED",
      );
    const base = new URL(c.ECHOTIK_BASE_URL);
    if (
      base.origin !== "https://open.echotik.live" ||
      base.pathname.replace(/\/$/, "") !== "/api/v3"
    )
      throw new AppError(
        400,
        "EchoTik 仅允许官方 HTTPS 地址",
        "INVALID_PROVIDER_URL",
      );
    const url = new URL(base.toString().replace(/\/$/, "") + path);
    url.search = new URLSearchParams(query).toString();
    let success = false;
    try {
      const response = await fetch(url, {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(c.ECHOTIK_USERNAME + ":" + c.ECHOTIK_PASSWORD).toString(
              "base64",
            ),
        },
        signal: AbortSignal.timeout(60000),
      });
      const raw = await response.json();
      success = response.ok && raw.code === 0;
      if (!success)
        throw new AppError(
          502,
          `EchoTik 请求失败：${String(raw.message || response.status).slice(0, 300)}`,
          "UPSTREAM_FAILED",
        );
      const payload = {
        data: raw.data,
        source: "EchoTik",
        endpoint: path,
        fetchedAt: new Date().toISOString(),
        cached: false,
        metricPeriod:
          query.date ||
          (query.start_date ? `${query.start_date} → ${query.end_date}` : null),
        isEstimated: path.startsWith("/echotik/"),
        currency: null,
        coverage:
          raw.data === null || (Array.isArray(raw.data) && !raw.data.length)
            ? "not_collected"
            : "available",
        requestId: raw.requestId,
      };
      const ttl = Math.max(
        0,
        Math.min(Number(c.ECHOTIK_CACHE_SECONDS) || 0, 86400),
      );
      if (ttl > 0)
        await execute(
          "REPLACE INTO cache_entries(cache_key,payload,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND))",
          [cacheKey, JSON.stringify(payload), ttl],
        );
      return payload;
    } finally {
      await execute(
        "INSERT INTO api_usage(provider,endpoint,success) VALUES(?,?,?)",
        ["echotik", path, success],
      );
    }
  })();
  inflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    inflight.delete(cacheKey);
  }
}
export function extractItems(data: any): Doc[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const k of [
    "list",
    "items",
    "comments",
    "aweme_list",
    "user_list",
    "data",
    "videos",
    "products",
    "item_list",
  ])
    if (Array.isArray(data[k])) return data[k];
  if (data.body?.sections)
    return data.body.sections.flatMap((s: any) => s.items || []);
  for (const k of ["body", "result", "data"])
    if (data[k]) {
      const found = extractItems(data[k]);
      if (found.length) return found;
    }
  return [];
}
export function normalizeItem(raw: Doc, entity = "video"): Doc {
  const r =
    raw.aweme_info || raw.product_info || raw.user_info || raw.lives || raw;
  const ids =
    entity === "product"
      ? [r.product_id, r.id]
      : entity === "video"
        ? [r.video_id, r.aweme_id, r.id]
        : entity === "creator"
          ? [r.user_id, r.uid, r.unique_id, r.id]
          : entity === "shop"
            ? [r.seller_id, r.id]
            : [r.room_id_str, r.room_id, r.author?.room_id_str, r.id];
  const id = String(ids.find((v) => v !== undefined && v !== null) || "");
  const image =
    r.original_cover_url ||
    r.cover_url ||
    r.product_cover ||
    r.cover ||
    (typeof r.avatar === "string" ? r.avatar : r.avatar?.url_list?.[0]) ||
    r.avatar_thumb?.url_list?.[0] ||
    r.author?.room_cover?.url_list?.[0] ||
    r.video?.cover?.url_list?.[0];
  const sourceUrl =
    r.video_url ||
    r.share_url ||
    (entity === "video" && id && r.author?.unique_id
      ? `https://www.tiktok.com/@${r.author.unique_id}/video/${id}`
      : null);
  return {
    id,
    entity,
    title: String(
      r.product_name ||
        r.video_desc ||
        r.desc ||
        r.title ||
        r.seller_name ||
        r.nickname ||
        r.nick_name ||
        r.unique_id ||
        id ||
        "未命名记录",
    ),
    image: typeof image === "string" ? image : image?.url_list?.[0],
    gmv:
      r.total_video_sale_gmv_amt ??
      r.total_sale_gmv_amt ??
      r.total_sale_gmv_30d_amt ??
      r.sale_gmv_amt_30d ??
      null,
    sales: r.total_video_sale_cnt ?? r.total_sale_cnt ?? null,
    views:
      r.total_views_cnt ?? r.total_play_cnt ?? r.statistics?.play_count ?? null,
    author: r.author?.nickname || r.nickname || r.nick_name || r.unique_id,
    currency: r.currency || r.currency_name || null,
    region: r.region,
    sourceUrl:
      typeof sourceUrl === "string" && sourceUrl.startsWith("https://")
        ? sourceUrl
        : null,
    raw: r,
  };
}
