import { Router } from "express";
import { z } from "zod";
import { rows, get, type Doc } from "./db.ts";
import { workspace } from "./context.ts";
import { AppError } from "./errors.ts";
import { aiJson } from "./providers.ts";
import { config } from "./config.ts";
import { photoSearch } from "./research-photo.ts";
import { commerceSchemas, type CommerceKind } from "./research-schema.ts";
import {
  listCommerce,
  getCommerce,
  saveCommerce,
  removeCommerce,
  productEstimate,
  researchQuery,
  syncWatch,
  watchSnapshots,
  importLegacyCommerce,
  csvContent,
  commercePage,
  rankCasesByRules,
} from "./research-domain.ts";

export const commerceRoutes = Router();
const kind = (s: string): CommerceKind => {
  if (!Object.hasOwn(commerceSchemas, s))
    throw new AppError(404, "业务模块不存在");
  return s as CommerceKind;
};
const researchSchema = z.object({
  entity: z.enum(["product", "video", "creator", "shop", "live", "keyword"]),
  action: z.enum([
    "detail",
    "trend",
    "comments",
    "replies",
    "related",
    "search",
    "keywords",
  ]),
  id: z.string().max(200).optional(),
  region: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default("US"),
  relation: z.enum(["product", "video", "creator"]).optional(),
  page: z.number().int().min(1).max(1000).default(1),
  cursor: z.string().max(200).optional(),
  commentId: z.string().max(200).optional(),
  keyword: z.string().max(300).optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
commerceRoutes.post("/research/query", async (req, res) =>
  res.json(await researchQuery(researchSchema.parse(req.body))),
);
commerceRoutes.post("/research/photo-search", async (req, res) =>
  res.json(
    await photoSearch(
      z
        .object({
          assetId: z.string().max(64).optional(),
          searchId: z.string().uuid().optional(),
          cursor: z.string().regex(/^\d+$/).max(12).optional(),
          region: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .default("US"),
          keyword: z.string().max(200).default(""),
        })
        .parse(req.body),
    ),
  ),
);
commerceRoutes.post("/research/image-keywords", async (req, res) => {
  const b = z
    .object({
      assetId: z.string().max(64),
      region: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .default("US"),
    })
    .parse(req.body);
  const asset = await get(b.assetId, "asset");
  if (!asset || asset.type !== "image")
    throw new AppError(400, "请选择当前工作空间的商品图片");
  const result = await aiJson(
    "识别这张商品图的可见产品类型、材质和使用场景，为TikTok商品搜索提取3个简短英文关键词。不得猜测品牌、功效。输出 {keywords:[string],description:string,limitations:[string]}。",
    [b.assetId],
  );
  const keywords = z
    .array(z.string().min(1).max(100))
    .max(5)
    .parse(result.keywords);
  res.json({
    keywords,
    description: String(result.description || ""),
    method: "Gemini 图片识别 → EchoTik 关键词搜索",
    limitations: result.limitations || [],
  });
});
commerceRoutes.post("/research/export", async (req, res) => {
  const b = z
    .object({ items: z.array(z.record(z.string(), z.any())).max(1000) })
    .parse(req.body);
  res
    .type("text/csv")
    .setHeader("Content-Disposition", "attachment; filename=research.csv")
    .send(csvContent(b.items));
});
commerceRoutes.get("/commerce/members", async (_req, res) =>
  res.json(
    await rows(
      "SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.disabled=0 ORDER BY u.name",
      [workspace()],
    ),
  ),
);
commerceRoutes.post("/commerce/import-legacy", async (_req, res) =>
  res.json(await importLegacyCommerce()),
);
commerceRoutes.get("/commerce/cases/categories", async (_req, res) =>
  res.json(
    (
      await rows(
        "SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(body,'$.category')) category FROM commerce_entries WHERE workspace_id=? AND kind='cases' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.category'))<>'' ORDER BY category",
        [workspace()],
      )
    ).map((r) => r.category),
  ),
);
commerceRoutes.post("/commerce/cases/match", async (req, res) => {
  const b = z
    .object({
      query: z.string().min(2).max(3000),
      productId: z.string().max(64).optional(),
    })
    .parse(req.body);
  const products = b.productId
    ? await getCommerce("products", b.productId)
    : null;
  const cases = (await listCommerce("cases")).filter(
    (c) => c.status === "published",
  );
  if (!cases.length) {
    res.json([]);
    return;
  }
  const cfg = await config();
  if (!cfg.GEMINI_API_KEY) {
    res.json(rankCasesByRules(cases, b.query, products));
    return;
  }
  const result = await aiJson(
    `从自有已审阅案例中选出匹配商品的案例，最多12条，输出 {matches:[{id,reason}]}。需求：${b.query}。商品：${JSON.stringify(products)}。案例：${JSON.stringify(cases.map((c) => ({ id: c.id, title: c.title, prompt: c.prompt, category: c.category }))).slice(0, 90000)}`,
  );
  res.json(
    (Array.isArray(result.matches) ? result.matches : [])
      .map((m: Doc) => {
        const c = cases.find((c) => c.id === m.id);
        return c ? { ...c, matchReason: String(m.reason || "") } : null;
      })
      .filter(Boolean),
  );
});
commerceRoutes.get("/commerce/watches/:id/snapshots", async (req, res) =>
  res.json(await watchSnapshots(String(req.params.id))),
);
commerceRoutes.post("/commerce/watches/:id/sync", async (req, res) =>
  res.json(await syncWatch(String(req.params.id))),
);
commerceRoutes.get("/commerce/:kind", async (req, res) => {
  const k = kind(String(req.params.kind));
  const paging =
    req.query.page !== undefined
      ? z
          .object({
            page: z.coerce.number().int().min(1).max(100000).default(1),
            pageSize: z.coerce.number().int().min(1).max(100).default(24),
            q: z.string().max(200).optional(),
            status: z.string().max(30).optional(),
            region: z.string().max(10).optional(),
            ownerId: z.string().max(64).optional(),
            category: z.string().max(200).optional(),
            minGmv: z.coerce.number().min(0).optional(),
          })
          .parse(req.query)
      : null;
  const result = paging ? await commercePage(k, paging) : null;
  const list = result ? result.items : await listCommerce(k);
  const items =
    k === "products"
      ? await Promise.all(
          list.map(async (p) => ({
            ...p,
            estimate: productEstimate(p),
            assets: (
              await Promise.all(
                p.assetIds.map((id: string) => get(id, "asset")),
              )
            ).filter(Boolean),
          })),
        )
      : list;
  res.json(result ? { ...result, items } : items);
});
commerceRoutes.get("/commerce/:kind/:id", async (req, res) =>
  res.json(
    await getCommerce(kind(String(req.params.kind)), String(req.params.id)),
  ),
);
commerceRoutes.post("/commerce/:kind", async (req, res) =>
  res
    .status(201)
    .json(await saveCommerce(kind(String(req.params.kind)), req.body)),
);
commerceRoutes.patch("/commerce/:kind/:id", async (req, res) =>
  res.json(
    await saveCommerce(
      kind(String(req.params.kind)),
      req.body,
      String(req.params.id),
    ),
  ),
);
commerceRoutes.delete("/commerce/:kind/:id", async (req, res) => {
  await removeCommerce(kind(String(req.params.kind)), String(req.params.id));
  res.json({ ok: true });
});
