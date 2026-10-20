import { randomUUID, createHash } from "node:crypto";
import { rows, execute, parse, get, list, type Doc } from "./db.ts";
import { workspace, scope, inWorkspace } from "./context.ts";
import { AppError } from "./errors.ts";
import {
  echoQuery,
  extractItems,
  normalizeItem,
  catalog,
  validateQuery,
} from "./echotik.ts";
import { commerceSchemas, type CommerceKind } from "./research-schema.ts";
import {
  replaceAssetReferences,
  clearAssetReferences,
} from "./asset-references.ts";

const view = (r: Doc): Doc => ({
  ...parse(r.body),
  id: r.id,
  revision: r.revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export async function listCommerce(kind: CommerceKind) {
  return (
    await rows(
      "SELECT * FROM commerce_entries WHERE workspace_id=? AND kind=? ORDER BY updated_at DESC,id LIMIT 1000",
      [workspace(), kind],
    )
  ).map(view);
}
export async function commercePage(
  kind: CommerceKind,
  input: {
    page: number;
    pageSize: number;
    q?: string;
    status?: string;
    region?: string;
    ownerId?: string;
    category?: string;
    minGmv?: number;
  },
) {
  const where = ["workspace_id=?", "kind=?"],
    values: any[] = [workspace(), kind];
  if (input.q) {
    where.push(
      "LOCATE(LOWER(?),LOWER(CONCAT_WS(' ',JSON_UNQUOTE(JSON_EXTRACT(body,'$.name')),JSON_UNQUOTE(JSON_EXTRACT(body,'$.title')),JSON_UNQUOTE(JSON_EXTRACT(body,'$.sku')),JSON_UNQUOTE(JSON_EXTRACT(body,'$.prompt')),JSON_EXTRACT(body,'$.tags'))))>0",
    );
    values.push(input.q);
  }
  for (const key of ["status", "region", "ownerId", "category"] as const)
    if (input[key] !== undefined && input[key] !== "all") {
      where.push(`JSON_UNQUOTE(JSON_EXTRACT(body,'$.${key}'))=?`);
      values.push(input[key]);
    }
  if (input.minGmv !== undefined) {
    where.push(
      "CAST(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(body,'$.sourceMetrics.total_video_sale_gmv_amt')),'null'),NULLIF(JSON_UNQUOTE(JSON_EXTRACT(body,'$.sourceMetrics.total_sale_gmv_amt')),'null'),NULLIF(JSON_UNQUOTE(JSON_EXTRACT(body,'$.sourceMetrics.gmv')),'null')) AS DECIMAL(24,4))>=?",
    );
    values.push(input.minGmv);
  }
  const [{ total }] = await rows(
    `SELECT COUNT(*) total FROM commerce_entries WHERE ${where.join(" AND ")}`,
    values,
  );
  const items = (
    await rows(
      `SELECT * FROM commerce_entries WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id LIMIT ${input.pageSize} OFFSET ${(input.page - 1) * input.pageSize}`,
      values,
    )
  ).map(view);
  return {
    items,
    total: Number(total),
    page: input.page,
    pageSize: input.pageSize,
  };
}
export function rankCasesByRules(
  cases: Doc[],
  query: string,
  product: Doc | null = null,
) {
  const words = [
    ...new Set(
      (
        query +
        " " +
        (product?.name || "") +
        " " +
        (product?.sellingPoints || []).join(" ")
      )
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1),
    ),
  ];
  return cases
    .map((c) => {
      const hay = (
          c.title +
          " " +
          c.prompt +
          " " +
          c.category +
          " " +
          c.tags.join(" ")
        ).toLowerCase(),
        matched = words.filter((w) => hay.includes(w));
      const market = !!product?.markets?.includes(c.region);
      return {
        ...c,
        matchScore: matched.length + (market ? 2 : 0),
        matchMethod: "rules",
        matchReason:
          "规则匹配：" +
          [
            market ? "销售市场相同" : "",
            matched.length
              ? "包含关键词 " + matched.slice(0, 5).join("、")
              : "",
          ]
            .filter(Boolean)
            .join("；"),
      };
    })
    .filter((c) => c.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 12);
}
export async function getCommerce(kind: CommerceKind, id: string) {
  const [r] = await rows(
    "SELECT * FROM commerce_entries WHERE workspace_id=? AND kind=? AND id=?",
    [workspace(), kind, id],
  );
  if (!r) throw new AppError(404, "记录不存在");
  return view(r);
}
export function productEstimate(p: Doc) {
  if (
    [p.price, p.cost, p.shipping, p.platformFeePercent].some(
      (x) => x === null || x === undefined,
    )
  )
    return null;
  const profit =
    p.price - p.cost - p.shipping - (p.price * p.platformFeePercent) / 100;
  return {
    profit: Math.round(profit * 100) / 100,
    margin: p.price ? Math.round((profit / p.price) * 10000) / 100 : null,
    currency: p.currency,
    excludes: "未计广告、税费、退货和汇率变动",
  };
}
export function caseIdentity(b: Doc) {
  const match =
    String(b.sourceUrl || "").match(/(?:video\/|video_id=)(\d+)/) ||
    (b.sourceVideoId ? ["", b.sourceVideoId] : null);
  let url = String(b.sourceUrl || "").trim();
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    url = u.toString().replace(/\/$/, "");
  } catch {}
  const source = match ? "tiktok:" + match[1] : url || b.sourceVideoAssetId;
  return source ? createHash("sha256").update(source).digest("hex") : null;
}
async function references(kind: CommerceKind, b: Doc) {
  for (const assetId of kind === "products"
    ? b.assetIds
    : b.sourceVideoAssetId
      ? [b.sourceVideoAssetId]
      : []) {
    const asset = await get(assetId, "asset");
    if (
      !asset ||
      (kind === "products" ? asset.type !== "image" : asset.type !== "video")
    )
      throw new AppError(400, "素材不存在或类型不匹配");
  }
  if (b.productId) await getCommerce("products", b.productId);
  if (b.projectId) {
    const [p] = await rows(
      "SELECT id FROM projects WHERE workspace_id=? AND id=?",
      [workspace(), b.projectId],
    );
    if (!p) throw new AppError(400, "项目不存在于当前工作空间");
  }
  if (b.ownerId) {
    const [m] = await rows(
      "SELECT user_id FROM memberships WHERE workspace_id=? AND user_id=?",
      [workspace(), b.ownerId],
    );
    if (!m && !(b.ownerId === "local" && workspace() === "local"))
      throw new AppError(400, "负责人不属于当前工作空间");
  }
  if (kind === "cases" && b.status === "published") {
    if (b.analysisStatus === "pending")
      throw new AppError(
        400,
        "此案例尚未完成分析，请先分析视频或人工完善销售提示词",
      );
    if (!b.sourceUrl && !b.sourceVideoAssetId)
      throw new AppError(400, "发布案例前必须保留来源视频或素材");
    if (!b.reviewNote.trim())
      throw new AppError(400, "请填写审阅结论后再发布案例");
  }
  if (kind === "cases" && b.sourceUrl && !/^https:\/\//i.test(b.sourceUrl))
    throw new AppError(400, "来源链接须使用 HTTPS");
}
export async function saveCommerce(kind: CommerceKind, raw: Doc, id?: string) {
  const old = id ? await getCommerce(kind, id) : null;
  if (
    old &&
    raw.revision !== undefined &&
    Number(raw.revision) !== old.revision
  )
    throw new AppError(409, "记录已被更新，请刷新后重试");
  const b = commerceSchemas[kind].parse(old ? { ...old, ...raw } : raw) as Doc;
  await references(kind, b);
  const key =
    kind === "cases"
      ? caseIdentity(b)
      : kind === "watches"
        ? `${b.entity}:${b.externalId}:${b.region}`
        : kind === "opportunities" && b.sourceJobId
          ? "job:" + b.sourceJobId
          : null;
  if (key) {
    const [duplicate] = await rows(
      "SELECT id FROM commerce_entries WHERE workspace_id=? AND kind=? AND dedupe_key=? AND id<>?",
      [workspace(), kind, key, id || ""],
    );
    if (duplicate)
      throw new AppError(
        409,
        "该来源已经在库中，请编辑已有记录",
        "DUPLICATE_RECORD",
        { id: duplicate.id },
      );
  }
  const newId = id || randomUUID();
  try {
    if (old) {
      const r = await execute(
        "UPDATE commerce_entries SET body=?,dedupe_key=?,revision=revision+1 WHERE id=? AND workspace_id=? AND kind=? AND revision=?",
        [JSON.stringify(b), key, newId, workspace(), kind, old.revision],
      );
      if (!r.affectedRows)
        throw new AppError(409, "记录已被更新，请刷新后重试");
    } else
      await execute(
        "INSERT INTO commerce_entries(id,workspace_id,kind,dedupe_key,body) VALUES(?,?,?,?,?)",
        [newId, workspace(), kind, key, JSON.stringify(b)],
      );
  } catch (e: any) {
    if (e.code === "ER_DUP_ENTRY")
      throw new AppError(409, "该来源已经在库中", "DUPLICATE_RECORD");
    throw e;
  }
  await replaceAssetReferences("commerce_" + kind, newId, b);
  return getCommerce(kind, newId);
}
export async function removeCommerce(kind: CommerceKind, id: string) {
  await getCommerce(kind, id);
  if (kind === "products") {
    const [used] = await rows(
      "SELECT id FROM commerce_entries WHERE workspace_id=? AND kind='opportunities' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.productId'))=? LIMIT 1",
      [workspace(), id],
    );
    if (used) throw new AppError(409, "商品已关联机会，请归档商品或先解除关联");
  }
  await execute(
    "DELETE FROM commerce_entries WHERE workspace_id=? AND kind=? AND id=?",
    [workspace(), kind, id],
  );
  await clearAssetReferences("commerce_" + kind, id);
  if (kind === "watches")
    await execute(
      "DELETE FROM commerce_watch_snapshots WHERE workspace_id=? AND watch_id=?",
      [workspace(), id],
    );
}
export type ResearchRequest = {
  entity: string;
  action: string;
  id?: string;
  region?: string;
  relation?: string;
  page?: number;
  cursor?: string;
  commentId?: string;
  keyword?: string;
  startDate?: string;
  endDate?: string;
};
const domains: Doc = {
  product: "product",
  video: "video",
  creator: "influencer",
  shop: "seller",
  live: "live",
};
export function buildResearchQuery(b: ResearchRequest) {
  const d = domains[b.entity],
    id = b.id || "",
    page = b.page || 1,
    region = b.region || "US";
  let path = "",
    params: Doc = {},
    resultEntity = b.entity;
  const keyed: Doc = {
    product: { product_id: id },
    video: { video_id: id },
    creator: /^\d+$/.test(id)
      ? { user_id: id }
      : { unique_id: id.replace(/^@/, "") },
    shop: { seller_id: id },
    live: { room_id: id },
  };
  if (!d && b.entity !== "keyword") throw new AppError(400, "不支持的实体");
  if (!["search", "keywords"].includes(b.action) && !id)
    throw new AppError(400, "缺少实体ID");
  if (b.action === "detail") {
    path = `/echotik/${d}/detail`;
    params =
      b.entity === "product"
        ? { product_ids: id }
        : b.entity === "video"
          ? { video_ids: id }
          : b.entity === "creator"
            ? /^\d+$/.test(id)
              ? { user_ids: id }
              : { unique_ids: id.replace(/^@/, "") }
            : b.entity === "live"
              ? { room_ids: id }
              : { seller_id: id };
  } else if (b.action === "trend") {
    path = `/echotik/${d}/trend`;
    params = {
      ...keyed[b.entity],
      start_date:
        b.startDate ||
        new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10),
      end_date:
        b.endDate || new Date(Date.now() - 864e5).toISOString().slice(0, 10),
      page_num: page,
      page_size: 10,
    };
  } else if (b.action === "related") {
    const allowed: Record<string, string[]> = {
      product: ["video", "creator"],
      video: ["product"],
      creator: ["video", "product"],
      shop: ["video", "product"],
      live: ["product"],
    };
    const rel = b.relation || allowed[b.entity]?.[0];
    if (!rel || !allowed[b.entity]?.includes(rel))
      throw new AppError(400, "此实体不支持该关联关系");
    path = `/echotik/${d}/${domains[rel]}/list`;
    params = {
      ...(b.entity === "video" ? { video_ids: id } : keyed[b.entity]),
      page_num: page,
      page_size: 10,
    };
    resultEntity = rel;
  } else if (b.action === "comments") {
    if (!["product", "video"].includes(b.entity))
      throw new AppError(400, "该实体没有评论接口");
    path =
      b.entity === "product"
        ? "/realtime/product/comment"
        : "/realtime/video/comments";
    params = {
      ...keyed[b.entity],
      region,
      offset: b.cursor || (b.entity === "product" ? "1" : "0"),
      count: 20,
    };
    resultEntity = "comment";
  } else if (b.action === "replies") {
    if (b.entity !== "video" || !b.commentId)
      throw new AppError(400, "视频评论回复需要评论ID");
    path = "/realtime/video/comments/replies";
    params = { video_id: id, comment_id: b.commentId, offset: b.cursor || "0" };
    resultEntity = "comment";
  } else if (b.action === "keywords") {
    path = "/realtime/inspiration/keyword";
    params = { keyword: b.keyword, region, offset: b.cursor || "0", count: 20 };
    resultEntity = "keyword";
  } else if (b.action === "search") {
    path =
      b.entity === "shop" ? "/echotik/search/items" : `/realtime/${d}/search`;
    params =
      b.entity === "shop"
        ? { sk: b.keyword, type: 3, size: 30, region }
        : {
            [b.entity === "product" ? "sk" : "keyword"]: b.keyword,
            region,
            offset: b.cursor || "0",
            count: 20,
          };
  } else throw new AppError(400, "不支持的研究操作");
  const ep = catalog.find((e) => e.path === path);
  if (!ep) throw new AppError(400, "数据服务尚未提供该关系");
  return { path, params: validateQuery(ep, params), resultEntity };
}
export function commentView(r: Doc, index = 0) {
  return {
    id: String(r.cid || r.comment_id || r.review_id || index),
    author: r.user?.nickname || r.nickname || r.user_name || "评论用户",
    text:
      r.text || r.display_text || r.review_text || r.content || "此条没有文本",
    rating: r.rating ?? null,
    likes: r.digg_count ?? r.likes ?? 0,
    replies: r.reply_comment_total ?? r.reply_count ?? 0,
    date: r.create_time || r.review_time || null,
    raw: r,
  };
}
export function trendView(data: any) {
  const items = extractItems(data);
  return items.map((r: Doc, i) => ({
    date: String(
      r.date || r.dt || r.stat_date || r.day || r.timestamp || i + 1,
    ),
    gmv:
      r.sale_gmv_amt ??
      r.total_sale_gmv_amt ??
      r.video_sale_gmv_amt ??
      r.gmv ??
      null,
    sales:
      r.sale_cnt ?? r.total_sale_cnt ?? r.video_sale_cnt ?? r.sales ?? null,
    views: r.views_cnt ?? r.total_views_cnt ?? r.play_count ?? r.views ?? null,
    followers: r.follower_cnt ?? r.total_follower_cnt ?? r.followers ?? null,
    raw: r,
  }));
}
function nextCursor(data: any, current: string): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.has_more === true || data.has_more === 1 || data.has_more === "1") {
    const v =
      data.next_cursor ??
      data.cursor ??
      data.max_cursor ??
      data.next_offset ??
      data.offset;
    if (v !== undefined && String(v) !== current) return String(v);
  }
  for (const key of ["data", "body", "pagination", "result"]) {
    const c = nextCursor(data[key], current);
    if (c !== null) return c;
  }
  return null;
}
export async function researchQuery(
  b: ResearchRequest,
  query = echoQuery,
): Promise<Doc> {
  if (
    b.entity === "creator" &&
    b.id &&
    !/^\d+$/.test(b.id) &&
    (b.action === "trend" ||
      (b.action === "related" && b.relation === "product"))
  ) {
    const resolved = await researchQuery({ ...b, action: "detail" }, query);
    const userId = resolved.items.find((item: Doc) =>
      /^\d+$/.test(String(item.id)),
    )?.id;
    if (!userId)
      throw new AppError(
        404,
        "未能从达人账号解析 user_id，请核对账号或直接填写数字 user_id",
      );
    b = { ...b, id: String(userId) };
  }
  const spec = buildResearchQuery(b),
    result = await query(spec.path, spec.params);
  const raw = extractItems(result.data);
  const candidates = raw.length
    ? raw
    : b.action === "detail" && result.data
      ? [result.data]
      : [];
  const items =
    spec.resultEntity === "comment"
      ? candidates.map(commentView)
      : spec.resultEntity === "keyword"
        ? candidates.map((r, i) => ({
            id: r.id || i,
            title: r.keyword || r.word || r.title || r.name || "关键词",
            volume: r.search_count ?? r.search_volume ?? null,
            raw: r,
          }))
        : candidates.map((r) => normalizeItem(r, spec.resultEntity));
  return {
    ...result,
    entity: spec.resultEntity,
    items,
    trend: b.action === "trend" ? trendView(result.data) : undefined,
    nextPage:
      spec.params.page_num && items.length >= 10
        ? Number(spec.params.page_num) + 1
        : null,
    nextCursor: nextCursor(result.data, String(spec.params.offset || "0")),
  };
}
export function compareSnapshot(previous: Doc | null, current: Doc) {
  const before = new Set((previous?.items || []).map((x: Doc) => x.id));
  return {
    baseline: !previous,
    newItems: previous
      ? (current.items || []).filter((x: Doc) => !before.has(x.id))
      : [],
    metrics: ["gmv", "sales", "views"].map((key) => ({
      key,
      before: previous?.detail?.[key] ?? null,
      after: current.detail?.[key] ?? null,
      delta:
        previous?.detail?.[key] != null && current.detail?.[key] != null
          ? Number(current.detail[key]) - Number(previous.detail[key])
          : null,
    })),
    sampleNotice:
      "比较本次返回的关联内容样本，未出现不表示内容被删除。GMV 为来源预估口径。",
  };
}
export async function watchSnapshots(id: string) {
  await getCommerce("watches", id);
  return (
    await rows(
      "SELECT * FROM commerce_watch_snapshots WHERE workspace_id=? AND watch_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
      [workspace(), id],
    )
  ).map((r) => ({ ...parse(r.body), id: r.id, createdAt: r.created_at }));
}
export async function syncWatch(id: string, query = echoQuery) {
  const watch = await getCommerce("watches", id),
    previous = (await watchSnapshots(id))[0] || null;
  const req = {
    entity: watch.entity,
    id: watch.externalId,
    region: watch.region,
  };
  const detail = await researchQuery({ ...req, action: "detail" }, query);
  const related = await researchQuery({ ...req, action: "related" }, query);
  const current = {
    detail: detail.items[0] || null,
    items: related.items,
    source: detail.source,
    fetchedAt: detail.fetchedAt,
    endpoint: related.endpoint,
  };
  const body = { ...current, diff: compareSnapshot(previous, current) };
  await execute(
    "INSERT INTO commerce_watch_snapshots(id,workspace_id,watch_id,body) VALUES(?,?,?,?)",
    [randomUUID(), workspace(), id, JSON.stringify(body)],
  );
  return { ...watch, snapshot: body };
}
export async function runWatchSync(
  input: { watchId?: string; maxWatches?: number },
  query = echoQuery,
) {
  const watches = input.watchId
    ? [await getCommerce("watches", input.watchId)]
    : (await listCommerce("watches"))
        .filter((w) => w.enabled)
        .slice(0, Math.max(1, Math.min(input.maxWatches || 5, 20)));
  const results = [];
  for (const w of watches) results.push(await syncWatch(w.id, query));
  return { count: results.length, watches: results };
}
export async function ingestCase(result: Doc, meta: Doc = {}) {
  const source = String(meta.sourceUrl || result.sourceUrl || "");
  const raw = {
    title: String(result.title || "视频销售案例").slice(0, 200),
    prompt:
      result.shootingPrompt ||
      result.prompt ||
      result.script ||
      "待补充销售提示词",
    analysis: result,
    analysisStatus:
      result.shootingPrompt || Array.isArray(result.scenes)
        ? "ready"
        : "pending",
    sourceUrl: source.startsWith("https://") ? source : "",
    sourceVideoId: String(
      meta.sourceVideoId ||
        (/^\d+$/.test(source)
          ? source
          : meta.sourceMetrics?.video_id || meta.sourceMetrics?.aweme_id || ""),
    ),
    sourceVideoAssetId: meta.sourceVideoAssetId || "",
    sourceMetrics: meta.sourceMetrics || {},
    region: meta.region || "",
    category: meta.category || "",
    sourceJobId: meta.jobId || "",
    status: "draft",
    provenance: meta.provenance || "AI 从参考视频提取",
  };
  const key = caseIdentity(raw);
  if (key) {
    const [existing] = await rows(
      "SELECT * FROM commerce_entries WHERE workspace_id=? AND kind='cases' AND dedupe_key=?",
      [workspace(), key],
    );
    if (existing) {
      const previous = view(existing);
      if (
        previous.status === "draft" &&
        previous.analysisStatus === "pending" &&
        raw.analysisStatus === "ready"
      )
        return saveCommerce(
          "cases",
          {
            ...previous,
            ...raw,
            revision: previous.revision,
            sourceMetrics: Object.keys(raw.sourceMetrics).length
              ? raw.sourceMetrics
              : previous.sourceMetrics,
            category: raw.category || previous.category,
            region: raw.region || previous.region,
          },
          previous.id,
        );
      return previous;
    }
  }
  try {
    return await saveCommerce("cases", raw);
  } catch (e: any) {
    if (e.code !== "DUPLICATE_RECORD") throw e;
    const [r] = await rows(
      "SELECT * FROM commerce_entries WHERE workspace_id=? AND kind='cases' AND dedupe_key=?",
      [workspace(), key],
    );
    if (r) return view(r);
    throw e;
  }
}
export async function ingestOpportunity(result: Doc, meta: Doc = {}) {
  if (meta.jobId) {
    const [r] = await rows(
      "SELECT * FROM commerce_entries WHERE workspace_id=? AND kind='opportunities' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.sourceJobId'))=? LIMIT 1",
      [workspace(), meta.jobId],
    );
    if (r) return view(r);
  }
  try {
    return await saveCommerce("opportunities", {
      title: String(result.title || "商品研究机会").slice(0, 200),
      summary: result.summary || result.note || "待验证的选品机会",
      region: meta.region || result.region || "",
      evidence: result.evidence || [],
      analysis: result,
      source: "EchoTik + AI 研究",
      sourceJobId: meta.jobId || "",
      productId: meta.productId || "",
      externalId: result.productId || "",
    });
  } catch (e: any) {
    if (e.code !== "DUPLICATE_RECORD" || !meta.jobId) throw e;
    const [r] = await rows(
      "SELECT * FROM commerce_entries WHERE workspace_id=? AND kind='opportunities' AND dedupe_key=?",
      [workspace(), "job:" + meta.jobId],
    );
    if (r) return view(r);
    throw e;
  }
}
function legacyCommerceId(kind: string, id: string) {
  return (
    "legacy_" +
    createHash("sha256")
      .update(`${workspace()}:${kind}:${id}`)
      .digest("hex")
      .slice(0, 48)
  );
}
// Import by stable source ID so a restart between inserts cannot create another row.
// Natural source deduplication also protects newer manually reviewed cases.
export async function importLegacyCommerce() {
  let imported = 0;
  const counts = { cases: 0, opportunities: 0, watches: 0 };
  let cursor = "";
  for (;;) {
    const batch = await rows(
      "SELECT * FROM records WHERE workspace_id=? AND kind IN ('prompt','opportunity','competitor') AND id>? ORDER BY id LIMIT 100",
      [workspace(), cursor],
    );
    if (!batch.length) break;
    for (const r of batch) {
      cursor = r.id;
      const p = parse(r.body);
      const kind =
        r.kind === "prompt"
          ? "cases"
          : r.kind === "opportunity"
            ? "opportunities"
            : "watches";
      const stableId = legacyCommerceId(r.kind, r.id);
      const [already] = await rows(
        "SELECT id FROM commerce_entries WHERE workspace_id=? AND id=?",
        [workspace(), stableId],
      );
      if (already && kind !== "watches") continue;
      const title = String(
        p.title ||
          p.name ||
          (kind === "cases" ? "历史销售案例" : "历史选品机会"),
      ).slice(0, 200);
      let raw: Doc;
      if (kind === "cases") {
        const sourceAsset = p.sourceVideoAssetId
          ? await get(p.sourceVideoAssetId, "asset")
          : null;
        raw = {
          title,
          prompt: String(
            p.prompt ||
              p.analysis?.shootingPrompt ||
              p.analysis?.script ||
              "待补充销售提示词",
          ).slice(0, 10000),
          category: String(p.category || "").slice(0, 200),
          region: String(p.region || "").slice(0, 10),
          sourceUrl: /^https:\/\//i.test(p.sourceUrl || "")
            ? String(p.sourceUrl).slice(0, 2000)
            : "",
          sourceVideoId: String(
            p.sourceVideoId ||
              (/^\d+$/.test(p.sourceUrl || "") ? p.sourceUrl : ""),
          ).slice(0, 200),
          sourceVideoAssetId:
            sourceAsset?.type === "video" ? sourceAsset.id : "",
          sourceMetrics: p.sourceMetrics || {},
          analysis: { ...(p.analysis || {}), legacyRecord: p },
          analysisStatus:
            p.analysis?.shootingPrompt || p.analysis?.scenes?.length
              ? "ready"
              : "pending",
          status: "draft",
          provenance: String(p.provenance || "历史案例迁移，待人工审阅").slice(
            0,
            200,
          ),
        };
      } else if (kind === "opportunities") {
        // Newer workers write both compatibility and domain records. Reuse their explicit link.
        const [linked] = await rows(
          "SELECT JSON_UNQUOTE(JSON_EXTRACT(result,'$.opportunityId')) id FROM jobs WHERE workspace_id=? AND JSON_UNQUOTE(JSON_EXTRACT(result,'$.legacyOpportunityId'))=? LIMIT 1",
          [workspace(), r.id],
        );
        if (
          linked?.id &&
          (
            await rows(
              "SELECT id FROM commerce_entries WHERE workspace_id=? AND kind='opportunities' AND id=?",
              [workspace(), linked.id],
            )
          ).length
        )
          continue;
        raw = {
          title,
          summary: String(p.summary || p.note || "历史选品研究").slice(
            0,
            10000,
          ),
          notes: String(p.notes || "").slice(0, 10000),
          region: String(p.region || "").slice(0, 10),
          status: [
            "new",
            "researching",
            "testing",
            "adopted",
            "rejected",
            "archived",
          ].includes(p.status)
            ? p.status
            : "new",
          evidence: Array.isArray(p.evidence)
            ? p.evidence
                .filter(
                  (e: any) => e && typeof e === "object" && !Array.isArray(e),
                )
                .slice(0, 200)
            : [],
          analysis: p,
          source: String(p.source || "历史机会迁移").slice(0, 200),
          sourceJobId: "legacy:" + r.id,
        };
      } else {
        if (
          !p.externalId ||
          !["product", "video", "creator", "shop"].includes(p.entity)
        )
          continue;
        raw = {
          name: title,
          entity: p.entity,
          externalId: String(p.externalId).replace(/^@/, "").slice(0, 200),
          region: /^[A-Z]{2}$/.test(p.region) ? p.region : "US",
          enabled: p.enabled !== false,
          notes: String(p.notes || "从历史竞品清单迁移").slice(0, 10000),
        };
      }
      const body = commerceSchemas[kind].parse(raw) as Doc;
      const key =
        kind === "cases"
          ? caseIdentity(body)
          : kind === "watches"
            ? `${body.entity}:${body.externalId}:${body.region}`
            : "job:" + body.sourceJobId;
      const [duplicate] = key
        ? await rows(
            "SELECT id FROM commerce_entries WHERE workspace_id=? AND kind=? AND dedupe_key=?",
            [workspace(), kind, key],
          )
        : [];
      let targetId = duplicate?.id || stableId;
      if (!duplicate) {
        const result = await execute(
          "INSERT IGNORE INTO commerce_entries(id,workspace_id,kind,dedupe_key,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
          [
            stableId,
            workspace(),
            kind,
            key,
            JSON.stringify(body),
            r.created_at,
            r.updated_at,
          ],
        );
        if (result.affectedRows) {
          imported++;
          counts[kind]++;
          await replaceAssetReferences("commerce_" + kind, stableId, body);
        } else if (key)
          targetId =
            (
              await rows(
                "SELECT id FROM commerce_entries WHERE workspace_id=? AND kind=? AND dedupe_key=?",
                [workspace(), kind, key],
              )
            )[0]?.id || stableId;
      }
      if (kind === "watches" && p.snapshot) {
        const items = extractItems(p.snapshot.data || p.snapshot).map(
          (item: Doc) => normalizeItem(item, "video"),
        );
        const snapshot = {
          detail: null,
          items,
          source: "历史 EchoTik 竞品快照",
          fetchedAt: p.lastSyncedAt || r.updated_at,
          endpoint: p.snapshot.endpoint || "",
          legacyRaw: p.snapshot,
        };
        await execute(
          "INSERT IGNORE INTO commerce_watch_snapshots(id,workspace_id,watch_id,body,created_at) VALUES(?,?,?,?,?)",
          [
            legacyCommerceId("snapshot", r.id),
            workspace(),
            targetId,
            JSON.stringify({
              ...snapshot,
              diff: compareSnapshot(null, snapshot),
            }),
            r.updated_at,
          ],
        );
      }
    }
  }
  return { imported, ...counts };
}
export async function migrateLegacyCommerce() {
  const result = {
    workspaces: 0,
    imported: 0,
    cases: 0,
    opportunities: 0,
    watches: 0,
  };
  for (const w of await rows(
    "SELECT DISTINCT workspace_id FROM records WHERE kind IN ('prompt','opportunity','competitor') ORDER BY workspace_id",
  )) {
    const count = await inWorkspace(w.workspace_id, () =>
      importLegacyCommerce(),
    );
    result.workspaces++;
    result.imported += count.imported;
    result.cases += count.cases;
    result.opportunities += count.opportunities;
    result.watches += count.watches;
  }
  return result;
}
export function csvContent(items: Doc[]) {
  const columns = [
    "id",
    "entity",
    "title",
    "region",
    "currency",
    "gmv",
    "sales",
    "views",
    "sourceUrl",
  ];
  const cell = (v: any) =>
    '"' +
    String(v ?? "")
      .replace(/^\s*[=+@-]/, "'$&")
      .replace(/"/g, '""') +
    '"';
  return (
    "\uFEFF" +
    [
      columns.join(","),
      ...items.map((r) => columns.map((c) => cell(r[c])).join(",")),
    ].join("\r\n")
  );
}
