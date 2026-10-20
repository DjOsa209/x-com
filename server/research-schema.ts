import { z } from "zod";
import { execute } from "./db.ts";

const short = z.string().trim().max(200);
const note = z.string().trim().max(10000);
const id = z.string().max(64);
const strings = z.array(z.string().trim().min(1).max(1000)).max(40);
export const productSchema = z.object({
  name: short.min(1),
  sku: short.default(""),
  description: note.default(""),
  assetIds: z.array(id).max(10).default([]),
  sellingPoints: strings.default([]),
  markets: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .max(30)
    .default([]),
  restrictions: note.default(""),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
  price: z.number().nonnegative().max(1e9).nullable().default(null),
  cost: z.number().nonnegative().max(1e9).nullable().default(null),
  shipping: z.number().nonnegative().max(1e9).nullable().default(null),
  platformFeePercent: z.number().min(0).max(100).nullable().default(null),
  notes: note.default(""),
  externalId: short.default(""),
});
export const opportunitySchema = z.object({
  title: short.min(1),
  summary: note.default(""),
  status: z
    .enum(["new", "researching", "testing", "adopted", "rejected", "archived"])
    .default("new"),
  ownerId: id.default(""),
  productId: id.default(""),
  projectId: id.default(""),
  region: z.string().max(10).default(""),
  notes: note.default(""),
  evidence: z.array(z.record(z.string(), z.any())).max(200).default([]),
  analysis: z.record(z.string(), z.any()).default({}),
  source: short.default("手动研究"),
  sourceJobId: id.default(""),
  externalId: short.default(""),
});
export const caseSchema = z.object({
  title: short.min(1),
  prompt: note.min(1),
  category: short.default(""),
  region: z.string().max(10).default(""),
  tags: strings.default([]),
  status: z.enum(["draft", "review", "published", "archived"]).default("draft"),
  reviewNote: note.default(""),
  sourceUrl: z.string().max(2000).default(""),
  sourceVideoId: z.string().max(200).default(""),
  sourceVideoAssetId: id.default(""),
  sourceMetrics: z.record(z.string(), z.any()).default({}),
  analysis: z.record(z.string(), z.any()).default({}),
  analysisStatus: z.enum(["pending", "ready"]).default("ready"),
  sourceJobId: id.default(""),
  provenance: short.default("自有案例"),
});
export const watchSchema = z.object({
  name: short.min(1),
  entity: z.enum(["product", "video", "creator", "shop"]),
  externalId: short.min(1),
  region: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default("US"),
  enabled: z.boolean().default(true),
  notes: note.default(""),
});
export const searchSchema = z.object({
  name: short.min(1),
  query: z.object({
    view: z.enum(["rank", "discover", "search"]).default("search"),
    entity: z
      .enum(["product", "video", "creator", "shop", "live"])
      .default("product"),
    region: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .default("US"),
    keyword: z.string().max(300).default(""),
    params: z
      .record(
        z.string().max(100),
        z.union([z.string().max(4000), z.number().finite(), z.boolean()]),
      )
      .default({}),
  }),
});
export const commerceSchemas = {
  products: productSchema,
  opportunities: opportunitySchema,
  cases: caseSchema,
  watches: watchSchema,
  searches: searchSchema,
};
export type CommerceKind = keyof typeof commerceSchemas;
export async function migrateCommerce() {
  await execute(`CREATE TABLE IF NOT EXISTS commerce_entries (
    id VARCHAR(64) PRIMARY KEY, workspace_id VARCHAR(64) NOT NULL, kind VARCHAR(32) NOT NULL,
    dedupe_key VARCHAR(191) NULL, body JSON NOT NULL, revision INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE tenant_commerce_key(workspace_id,kind,dedupe_key), INDEX commerce_workspace(workspace_id,kind,created_at))`);
  await execute(`CREATE TABLE IF NOT EXISTS commerce_watch_snapshots (
    id VARCHAR(64) PRIMARY KEY, workspace_id VARCHAR(64) NOT NULL, watch_id VARCHAR(64) NOT NULL,
    body JSON NOT NULL, created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    INDEX watch_history(workspace_id,watch_id,created_at))`);
}
