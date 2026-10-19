import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { rows, execute, parse } from "./db.ts";
import { workspace, inWorkspace } from "./context.ts";
import { createJob } from "./jobs.ts";
import { AppError } from "./errors.ts";
export const automationRoutes = Router();
const input = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(["collect", "opportunity_scan"]),
  input: z.record(z.string(), z.any()),
  intervalMinutes: z.number().int().min(15).max(43200),
  enabled: z.boolean().default(true),
});
automationRoutes.get("/automations", async (_req, res) =>
  res.json(
    (
      await rows(
        "SELECT * FROM automations WHERE workspace_id=? ORDER BY created_at DESC",
        [workspace()],
      )
    ).map((r) => ({ ...r, input: parse(r.input) })),
  ),
);
automationRoutes.post("/automations", async (req, res) => {
  const b = input.parse(req.body),
    id = randomUUID();
  await execute(
    "INSERT INTO automations(id,workspace_id,name,kind,input,interval_minutes,next_run_at,enabled) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP(3),?)",
    [
      id,
      workspace(),
      b.name,
      b.kind,
      JSON.stringify(b.input),
      b.intervalMinutes,
      b.enabled,
    ],
  );
  res.status(201).json({ id });
});
automationRoutes.patch("/automations/:id", async (req, res) => {
  const b = input.partial().parse(req.body);
  const [a] = await rows(
    "SELECT * FROM automations WHERE id=? AND workspace_id=?",
    [req.params.id, workspace()],
  );
  if (!a) throw new AppError(404, "自动化不存在");
  await execute(
    "UPDATE automations SET name=?,kind=?,input=?,interval_minutes=?,enabled=? WHERE id=? AND workspace_id=?",
    [
      b.name ?? a.name,
      b.kind ?? a.kind,
      JSON.stringify(b.input ?? parse(a.input)),
      b.intervalMinutes ?? a.interval_minutes,
      b.enabled ?? !!a.enabled,
      a.id,
      workspace(),
    ],
  );
  res.json({ ok: true });
});
automationRoutes.delete("/automations/:id", async (req, res) => {
  await execute("DELETE FROM automations WHERE id=? AND workspace_id=?", [
    req.params.id,
    workspace(),
  ]);
  res.json({ ok: true });
});
automationRoutes.post("/automations/:id/run", async (req, res) => {
  const [a] = await rows(
    "SELECT * FROM automations WHERE id=? AND workspace_id=?",
    [req.params.id, workspace()],
  );
  if (!a) throw new AppError(404, "自动化不存在");
  res.json(await createJob(a.kind, parse(a.input), randomUUID()));
});
export async function scheduleAutomations() {
  const due = await rows(
    "SELECT * FROM automations WHERE enabled=1 AND next_run_at<=UTC_TIMESTAMP(3) ORDER BY next_run_at LIMIT 5",
  );
  for (const a of due)
    await inWorkspace(a.workspace_id, async () => {
      try {
        const job = await createJob(
          a.kind,
          parse(a.input),
          "automation:" + a.id + ":" + new Date(a.next_run_at).toISOString(),
        );
        await execute(
          "UPDATE automations SET last_job_id=?,last_error=NULL,next_run_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL interval_minutes MINUTE) WHERE id=?",
          [job.id, a.id],
        );
      } catch (e: any) {
        await execute(
          "UPDATE automations SET last_error=?,next_run_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL interval_minutes MINUTE) WHERE id=?",
          [String(e.message).slice(0, 1000), a.id],
        );
      }
    });
}
