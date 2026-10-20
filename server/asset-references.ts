import { pool, rows, get } from "./db.ts";
import { workspace } from "./context.ts";
import { AppError } from "./errors.ts";

function candidates(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(value))
    result.add(value);
  else if (Array.isArray(value))
    for (const item of value) candidates(item, result);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) candidates(item, result);
  return result;
}
export async function replaceAssetReferences(
  ownerType: string,
  ownerId: string,
  object: unknown,
) {
  const ids = [...candidates(object)].slice(0, 1000);
  const assets = ids.length
    ? await rows(
        `SELECT id FROM records WHERE kind='asset' AND workspace_id=? AND id IN (${ids.map(() => "?").join(",")})`,
        [workspace(), ...ids],
      )
    : [];
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    await c.execute(
      "DELETE FROM asset_references WHERE workspace_id=? AND owner_type=? AND owner_id=?",
      [workspace(), ownerType, ownerId],
    );
    for (const a of assets)
      await c.execute("INSERT IGNORE INTO asset_references VALUES(?,?,?,?)", [
        workspace(),
        ownerType,
        ownerId,
        a.id,
      ]);
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
export async function clearAssetReferences(ownerType: string, ownerId: string) {
  await pool.execute(
    "DELETE FROM asset_references WHERE workspace_id=? AND owner_type=? AND owner_id=?",
    [workspace(), ownerType, ownerId],
  );
}
export async function assetReferences(id: string) {
  if (!(await get(id, "asset"))) throw new AppError(404, "素材不存在");
  const refs: { kind: string; id: string }[] = (
    await rows(
      "SELECT owner_type AS kind,owner_id AS id FROM asset_references WHERE workspace_id=? AND asset_id=?",
      [workspace(), id],
    )
  ).map((r) => ({ kind: String(r.kind), id: String(r.id) }));
  // Scan legacy records too: historical tasks must remain protected after upgrade.
  for (const [table, fields, label] of [
    ["records", ["body"], "记录"],
    ["jobs", ["input", "provider", "result"], "任务"],
    ["projects", ["input", "script"], "项目"],
    ["project_confirmations", ["snapshot"], "已确认分镜"],
  ] as const) {
    const found = await rows(
      `SELECT id FROM ${table} WHERE workspace_id=? AND id<>? ${table === "records" ? "AND kind <> 'upload'" : ""} AND (${fields.map((f) => `JSON_SEARCH(${f},'one',?) IS NOT NULL`).join(" OR ")}) LIMIT 100`,
      [workspace(), id, ...fields.map(() => id)],
    );
    for (const r of found) refs.push({ kind: label, id: r.id });
  }
  return refs.filter(
    (r, i, all) =>
      all.findIndex((a) => a.kind === r.kind && a.id === r.id) === i,
  );
}
export async function assertAssetUnused(id: string) {
  const refs = await assetReferences(id);
  if (refs.length)
    throw new AppError(
      409,
      `素材被 ${refs.length} 个项目、任务或记录引用，请归档素材以保留这些流程`,
      "ASSET_IN_USE",
    );
}
