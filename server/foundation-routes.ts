import { Router } from "express";
import { z } from "zod";
import { basename, extname } from "node:path";
import { rows, get, job, record, type Doc } from "./db.ts";
import { workspace, scope } from "./context.ts";
import { requireOwner } from "./auth.ts";
import { assetReferences } from "./asset-references.ts";
import { readAsset } from "./media.ts";
import { zipEntries } from "./archive.ts";
import { AppError } from "./errors.ts";
import { publicConfig } from "./config.ts";
import { storageUsage } from "./storage.ts";
import { mediaToolsReady } from "./video-compose.ts";

export const foundationRoutes = Router();
const paging = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().max(200).default(""),
});
foundationRoutes.get("/library/:kind", async (req, res) => {
  const kind = z
    .enum([
      "asset",
      "character",
      "draft",
      "favorite",
      "prompt",
      "competitor",
      "opportunity",
      "observation",
    ])
    .parse(req.params.kind);
  const { page, pageSize, q } = paging.parse(req.query);
  const values: any[] = [workspace(), kind];
  let where = "workspace_id=? AND kind=?";
  if (q) {
    where +=
      " AND (JSON_UNQUOTE(JSON_EXTRACT(body,'$.name')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(body,'$.title')) LIKE ? OR JSON_EXTRACT(body,'$.tags') LIKE ?)";
    values.push(...Array(3).fill("%" + q + "%"));
  }
  if (req.query.type) {
    where += " AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.type'))=?";
    values.push(z.enum(["image", "video", "audio"]).parse(req.query.type));
  }
  if (req.query.archived !== "all") {
    where +=
      " AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(body,'$.archived')),'false')=?";
    values.push(req.query.archived === "true" ? "true" : "false");
  }
  const [{ total }] = await rows(
    `SELECT COUNT(*) total FROM records WHERE ${where}`,
    values,
  );
  const items = await rows(
    `SELECT * FROM records WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    values,
  );
  res.json({ items: items.map(record), total: Number(total), page, pageSize });
});
foundationRoutes.get("/job-history", async (req, res) => {
  const { page, pageSize, q } = paging.parse(req.query);
  let where = "workspace_id=?";
  const values: any[] = [workspace()];
  if (req.query.status === "active")
    where +=
      " AND status IN ('queued','scheduled','running','processing','held')";
  else if (req.query.status) {
    where += " AND status=?";
    values.push(z.string().max(40).parse(req.query.status));
  }
  if (req.query.kind) {
    where += " AND kind=?";
    values.push(z.string().max(40).parse(req.query.kind));
  }
  if (q) {
    where += " AND (id LIKE ? OR input LIKE ?)";
    values.push("%" + q + "%", "%" + q + "%");
  }
  const [{ total }] = await rows(
    `SELECT COUNT(*) total FROM jobs WHERE ${where}`,
    values,
  );
  res.json({
    items: (
      await rows(
        `SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        values,
      )
    ).map(job),
    page,
    pageSize,
    total: Number(total),
  });
});
foundationRoutes.get("/jobs/:id", async (req, res) => {
  const [r] = await rows("SELECT * FROM jobs WHERE id=? AND workspace_id=?", [
    req.params.id,
    workspace(),
  ]);
  if (!r) throw new AppError(404, "任务不存在");
  res.json(job(r));
});
foundationRoutes.get("/assets/:id/references", async (req, res) =>
  res.json(await assetReferences(String(req.params.id))),
);
foundationRoutes.post("/assets/archive-download", async (req, res) => {
  const ids = z.array(z.string().max(64)).min(1).max(30).parse(req.body.ids);
  const entries: { name: string; data: Buffer }[] = [];
  let size = 0;
  for (const [i, id] of [...new Set(ids)].entries()) {
    const meta = await get(id, "asset");
    if (!meta) throw new AppError(404, "素材不存在");
    size += Number(meta.bytes);
    if (size > 500 * 1024 * 1024)
      throw new AppError(413, "下载包超过500MB，请分批选择");
    const { asset, bytes } = await readAsset(id);
    const original = basename(asset.name || asset.filename).replace(
      /[\\/\x00-\x1f]/g,
      "_",
    );
    entries.push({
      name: `${i + 1}-${original}${extname(original) ? "" : extname(asset.filename)}`,
      data: bytes,
    });
  }
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="x-ecommerce-assets.zip"',
  );
  res.send(zipEntries(entries));
});
foundationRoutes.get("/audit", async (req, res) => {
  requireOwner();
  const { page, pageSize, q } = paging.parse(req.query);
  const values: any[] = [workspace()];
  let where = "workspace_id=?";
  if (q) {
    where += " AND (action LIKE ? OR user_id LIKE ?)";
    values.push("%" + q + "%", "%" + q + "%");
  }
  const [{ total }] = await rows(
    `SELECT COUNT(*) total FROM audit_log WHERE ${where}`,
    values,
  );
  res.json({
    items: await rows(
      `SELECT id,user_id,action,details,created_at FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      values,
    ),
    page,
    pageSize,
    total: Number(total),
  });
});
foundationRoutes.get("/diagnostics", async (_req, res) => {
  requireOwner();
  const c = await publicConfig();
  const [worker] = await rows(
    "SELECT updated_at FROM system_state WHERE id='worker'",
  );
  let mediaReady = true;
  try {
    await mediaToolsReady();
  } catch {
    mediaReady = false;
  }
  res.json({
    database: true,
    mediaReady,
    worker: {
      lastHeartbeat: worker?.updated_at || null,
      healthy:
        !!worker && Date.now() - new Date(worker.updated_at).getTime() < 90000,
    },
    storage: await storageUsage(),
    connections: Object.entries(c.connections).map(
      ([provider, configured]) => ({ provider, configured, verified: false }),
    ),
    role: scope().role,
    migrations: await rows("SELECT * FROM schema_migrations ORDER BY version"),
  });
});
