import { randomUUID, createHash } from "node:crypto";
import { config } from "./config.ts";
import { readAsset } from "./media.ts";
import { workspace } from "./context.ts";
import { rows, execute, parse, type Doc } from "./db.ts";
import { echoQuery, normalizeItem } from "./echotik.ts";
import { withResearchBudgetRequest } from "./research-budget.ts";
import { AppError } from "./errors.ts";

// Contract: https://opendocs.echotik.live/realtime/product/photo-search.md
// Pagination: https://opendocs.echotik.live/realtime/product/photo-search/page.md
export function photoItems(data: Doc, region: string) {
  return (Array.isArray(data.e_com_items) ? data.e_com_items : [])
    .filter((r: Doc) => r.shop_view_data?.init_state || r.product_info)
    .map((r: Doc) => {
      const p = r.shop_view_data?.init_state || r.product_info;
      return normalizeItem(
        {
          ...p,
          product_id: p.product_id || r.search_result_id,
          product_name: p.product_title || p.title,
          product_cover: p.main_image || p.cover,
          region,
          total_sale_cnt:
            p.volume_type === "sold_online" && /^\d+$/.test(p.volume)
              ? Number(p.volume)
              : null,
          price: p.sale_price_value,
        },
        "product",
      );
    });
}
export function photoPageTokens(data: Doc) {
  const photo = data.photo_search;
  const box = Array.isArray(photo?.box_detection)
    ? photo.box_detection[0]
    : photo?.box_detection;
  if (!photo?.image_uri || typeof box !== "string") return null;
  return { imageUri: String(photo.image_uri), boxDetection: box };
}
export async function submitPhoto(
  bytes: Buffer,
  mime: string,
  region: string,
  keyword: string,
  credentials: { username: string; password: string },
  transport: typeof fetch = fetch,
) {
  if (bytes.length > 2 * 1024 * 1024)
    throw new AppError(
      400,
      "EchoTik 图片搜索仅支持不超过 2MB 的图片，请压缩后上传",
    );
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
    throw new AppError(400, "图片搜索只支持 JPG、PNG、WebP");
  const url = new URL(
    "https://open.echotik.live/api/v3/realtime/product/photo-search",
  );
  url.searchParams.set("region", region);
  if (keyword) url.searchParams.set("sk", keyword);
  const response = await transport(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Basic " +
        Buffer.from(credentials.username + ":" + credentials.password).toString(
          "base64",
        ),
    },
    body: JSON.stringify({ image_base64: bytes.toString("base64") }),
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  let body: Doc;
  try {
    body = await response.json();
  } catch {
    throw new AppError(502, "EchoTik 图片搜索响应格式无效");
  }
  if (
    !response.ok ||
    body.code !== 0 ||
    !body.data ||
    Number(body.data.status_code || 0) !== 0
  )
    throw new AppError(
      502,
      "EchoTik 图片搜索失败，请检查账号额度、市场及图片",
      "UPSTREAM_FAILED",
    );
  return body.data;
}
const cacheKey = (id: string) =>
  createHash("sha256").update(`photo:${workspace()}:${id}`).digest("hex");
export async function photoSearch(input: {
  assetId?: string;
  searchId?: string;
  cursor?: string;
  region: string;
  keyword: string;
}) {
  let data: Doc,
    searchId = input.searchId || randomUUID(),
    region = input.region,
    meta: Doc | null = null;
  if (input.searchId) {
    const [row] = await rows(
      "SELECT payload FROM cache_entries WHERE cache_key=? AND expires_at>UTC_TIMESTAMP(3)",
      [cacheKey(input.searchId)],
    );
    if (!row) throw new AppError(404, "图片搜索会话已过期，请重新选择图片查询");
    meta = parse(row.payload);
    region = meta!.region;
    const response = await echoQuery("/realtime/product/photo-search/page", {
      region,
      photo_search_image_uri: meta!.imageUri,
      photo_search_box_detection: meta!.boxDetection,
      offset: input.cursor || "0",
      count: 10,
      sk: meta!.keyword,
    });
    data = response.data;
  } else {
    if (!input.assetId) throw new AppError(400, "请选择商品图片");
    const { asset, bytes } = await readAsset(input.assetId),
      c = await config();
    if (!c.ECHOTIK_USERNAME || !c.ECHOTIK_PASSWORD)
      throw new AppError(409, "请先连接 EchoTik", "PROVIDER_NOT_CONFIGURED");
    if (asset.type !== "image") throw new AppError(400, "请选择图片素材");
    // Validate before reserving an external request budget.
    if (
      bytes.length > 2 * 1024 * 1024 ||
      !["image/jpeg", "image/png", "image/webp"].includes(asset.mime)
    )
      throw new AppError(400, "请上传不超过 2MB 的 JPG、PNG 或 WebP 图片");
    let success = false;
    try {
      data = await withResearchBudgetRequest(
        "echotik",
        "/realtime/product/photo-search",
        () =>
          submitPhoto(bytes, asset.mime, region, input.keyword, {
            username: c.ECHOTIK_USERNAME,
            password: c.ECHOTIK_PASSWORD,
          }),
      );
      success = true;
    } finally {
      await execute(
        "INSERT INTO api_usage(provider,endpoint,success,workspace_id) VALUES('echotik','/realtime/product/photo-search',?,?)",
        [success, workspace()],
      );
    }
    const tokens = photoPageTokens(data);
    if (tokens) {
      meta = { ...tokens, region, keyword: input.keyword };
      await execute(
        "REPLACE INTO cache_entries(cache_key,payload,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE))",
        [cacheKey(searchId), JSON.stringify(meta)],
      );
    }
  }
  const cursor = data.cursor ?? data.next_offset;
  const hasMore = [true, 1, "1"].includes(data.has_more);
  return {
    searchId,
    source: "EchoTik 图片搜索",
    fetchedAt: new Date().toISOString(),
    entity: "product",
    items: photoItems(data, region),
    nextCursor:
      meta &&
      hasMore &&
      cursor !== undefined &&
      String(cursor) !== String(input.cursor ?? "")
        ? String(cursor)
        : null,
    isEstimated: false,
    endpoint: input.searchId
      ? "/realtime/product/photo-search/page"
      : "/realtime/product/photo-search",
    coverage: "图片相似度结果；销量为来源展示值，GMV未提供",
    data: { cursor, has_more: data.has_more },
  };
}
