import "../server/env.ts";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import Stripe from "stripe";
process.env.AUTH_REQUIRED = "true";
process.env.STRIPE_SECRET_KEY = "sk_test_local_contract_fixture";
process.env.STRIPE_WEBHOOK_SECRET = randomBytes(24).toString("hex");
const { app, apiErrors } = await import("../server/app.ts");
const { pool, rows, execute, migrate, parse, jobGet } =
  await import("../server/db.ts");
const { passwordHash } = await import("../server/auth.ts");
const { inWorkspace } = await import("../server/context.ts");
const { reserveCredits, finalizeCredits, reconcileCredits } =
  await import("../server/credits.ts");
const { reconcileProjects } = await import("../server/projects.ts");
const { scheduleAutomations } = await import("../server/automations.ts");
await migrate();
apiErrors();
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as any).port;
const prefix = "qa-" + randomUUID().slice(0, 8),
  wa = prefix + "-a",
  wb = prefix + "-b";
const password = randomBytes(24).toString("hex");
const lock = await pool.getConnection();
const [locks]: any = await lock.query(
  "SELECT GET_LOCK('x_ecommerce_worker',20) acquired",
);
assert.equal(Number(locks[0].acquired), 1, "obtain exclusive worker test lock");
const assets: string[] = [];
let count = 0;
function check(value: any, message: string) {
  assert.ok(value, message);
  console.log("PASS " + message);
  count++;
}
class Client {
  cookies = new Map<string, string>();
  async req(
    path: string,
    method = "GET",
    body?: any,
    extra: Record<string, string> = {},
  ) {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(body instanceof FormData
          ? {}
          : { "content-type": "application/json" }),
        cookie: [...this.cookies].map(([k, v]) => k + "=" + v).join("; "),
        ...extra,
      },
      ...(body === undefined
        ? {}
        : {
            body:
              body instanceof FormData
                ? body
                : typeof body === "string"
                  ? body
                  : JSON.stringify(body),
          }),
    });
    for (const item of r.headers.getSetCookie()) {
      const p = item.split(";")[0],
        n = p.indexOf("=");
      this.cookies.set(p.slice(0, n), p.slice(n + 1));
    }
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: r.status, data };
  }
}
const guest = new Client(),
  owner = new Client(),
  outsider = new Client(),
  viewer = new Client(),
  operator = new Client();
const ids = [
  prefix + "-owner",
  prefix + "-outsider",
  prefix + "-viewer",
  prefix + "-operator",
];
const namedClients = [owner, outsider, viewer, operator];
try {
  for (const ws of [wa, wb])
    await execute("INSERT INTO workspaces(id,name) VALUES(?,?)", [ws, ws]);
  const hash = await passwordHash(password);
  for (let n = 0; n < ids.length; n++) {
    await execute(
      "INSERT INTO users(id,email,name,password_hash,global_role) VALUES(?,?,?,?,?)",
      [
        ids[n],
        ids[n] + "@example.invalid",
        ids[n],
        hash,
        n === 0 ? "admin" : "member",
      ],
    );
    await execute(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,?)",
      [n === 1 ? wb : wa, ids[n], ["owner", "owner", "viewer", "operator"][n]],
    );
  }
  check(
    (await guest.req("/api/projects")).status === 401,
    "authentication required for protected API",
  );
  check(
    (await guest.req("/media/anything.png")).status === 401,
    "authentication required for media",
  );
  check(
    (
      await guest.req("/api/auth/login", "POST", {
        email: ids[0] + "@example.invalid",
        password: "wrong",
      })
    ).status === 401,
    "wrong password rejected",
  );
  for (let n = 0; n < ids.length; n++)
    check(
      (
        await namedClients[n].req("/api/auth/login", "POST", {
          email: ids[n] + "@example.invalid",
          password,
        })
      ).status === 200,
      "real hashed-password login " + n,
    );
  check(
    (await owner.req("/api/auth/status")).data.workspace === wa,
    "session selects a member workspace",
  );
  const { withJobLock } = await import("../server/locks.ts");
  let releaseJob!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  const firstLock = withJobLock(prefix + "-lock", async () => {
    entered();
    await new Promise<void>((r) => {
      releaseJob = r;
    });
  });
  await enteredPromise;
  let duplicateBlocked = false;
  try {
    await withJobLock(prefix + "-lock", async () => {});
  } catch (e: any) {
    duplicateBlocked = e.code === "JOB_BUSY";
  } finally {
    releaseJob();
    await firstLock;
  }
  check(
    duplicateBlocked,
    "job lock prevents concurrent worker and manual advancement",
  );

  const { workerCycle } = await import("../server/worker-runtime.ts");
  const heartbeatBefore = JSON.stringify(
    await rows("SELECT * FROM system_state WHERE id='worker'"),
  );
  await workerCycle();
  check(
    JSON.stringify(
      await rows("SELECT * FROM system_state WHERE id='worker'"),
    ) === heartbeatBefore,
    "second worker cannot run while MySQL lock is held",
  );

  check(
    (await outsider.req("/api/workspaces/select", "POST", { workspaceId: wa }))
      .status === 403,
    "cannot select another team",
  );
  check(
    (await viewer.req("/api/records/draft", "POST", { name: prefix }))
      .status === 403,
    "viewer cannot mutate records",
  );
  check(
    (await operator.req("/api/settings", "PUT", { FAL_KEY: "test" })).status ===
      403,
    "operator cannot readjust provider secrets",
  );
  check(
    (
      await operator.req("/api/billing/grant", "POST", {
        units: 1,
        reference: prefix,
      })
    ).status === 403,
    "operator cannot grant credits",
  );
  check(
    (
      await owner.req("/api/workspaces/members/" + ids[0], "PATCH", {
        role: "operator",
      })
    ).status === 409,
    "owner role protected",
  );
  check(
    (
      await outsider.req("/api/jobs/unknown/resolve", "POST", {
        decision: "failed",
        note: "not a supplier verified failure",
      })
    ).status === 403,
    "customer workspace owner cannot release review charges manually",
  );
  const draft = await owner.req("/api/records/draft", "POST", {
    name: prefix,
    prompt: "test",
  });
  check(draft.status === 201, "tenant record created");
  check(
    !(await outsider.req("/api/records/draft")).data.some(
      (r: any) => r.id === draft.data.id,
    ),
    "tenant list isolation",
  );
  check(
    (
      await outsider.req("/api/records/draft/" + draft.data.id, "PATCH", {
        name: "bad",
      })
    ).status === 404,
    "tenant write isolation",
  );
  check(
    (
      await owner.req("/api/settings", "PUT", {
        FAL_KEY: "fixture-not-a-real-key",
        GEMINI_API_KEY: "fixture-not-a-real-key",
        ECHOTIK_USERNAME: "fixture",
        ECHOTIK_PASSWORD: "fixture",
      })
    ).status === 200,
    "workspace provider settings saved encrypted",
  );
  check(
    (await outsider.req("/api/settings")).data.connections.fal === false,
    "secrets isolated between workspaces",
  );
  check(
    (
      await owner.req("/api/settings", "PUT", {
        CREDIT_COSTS_JSON: '{"video":-1}',
      })
    ).status === 400,
    "invalid credit costs rejected",
  );
  check(
    (await owner.req("/api/settings", "PUT", { STORAGE_LIMIT_MB: "-1" }))
      .status === 400,
    "invalid storage quota rejected",
  );
  check(
    (
      await outsider.req("/api/settings", "PUT", {
        CREDIT_COSTS_JSON: '{\"video\":0}',
      })
    ).status === 403,
    "workspace owner cannot bypass platform credit policy",
  );
  const inv = await owner.req("/api/workspaces/invites", "POST", {
    email: prefix + "-invite@example.invalid",
    role: "operator",
  });
  check(inv.status === 201 && !!inv.data.token, "invite token returned once");
  check(
    !(await owner.req("/api/workspaces/invites")).data.some(
      (r: any) => "token_hash" in r || "token" in r,
    ),
    "invite hashes not exposed",
  );
  check(
    (await guest.req("/api/auth/invite-preview?token=" + inv.data.token)).data
      .role === "operator",
    "public invite preview",
  );
  check(
    (
      await guest.req("/api/auth/register", "POST", {
        email: prefix + "-invite@example.invalid",
        name: "Temporary QA",
        password,
        inviteToken: inv.data.token,
      })
    ).status === 201,
    "invite-only signup joins workspace",
  );
  check(
    (
      await new Client().req("/api/auth/register", "POST", {
        email: prefix + "-again@example.invalid",
        name: "QA",
        password,
        inviteToken: inv.data.token,
      })
    ).status === 400,
    "consumed invite cannot be reused",
  );
  await owner.req("/api/billing/metering", "PUT", { enabled: true });
  const grant = { units: 2, reference: prefix + "-grant" };
  await owner.req("/api/billing/grant", "POST", grant);
  await owner.req("/api/billing/grant", "POST", grant);
  check(
    (await owner.req("/api/billing")).data.wallet.remainingCredits === 2,
    "credit grants idempotent",
  );
  const reserves = await inWorkspace(wa, () =>
    Promise.allSettled(
      [1, 2, 3].map((n) => reserveCredits(prefix + "-reserve-" + n, "video")),
    ),
  );
  check(
    reserves.filter((r) => r.status === "fulfilled").length === 2,
    "concurrent reservations never overspend",
  );
  const [cw] = await rows("SELECT * FROM credit_wallets WHERE workspace_id=?", [
    wa,
  ]);
  check(
    Number(cw.reserved) === 2,
    "frozen balance equals successful reservations",
  );
  for (let n = 0; n < 3; n++)
    await inWorkspace(wa, () =>
      finalizeCredits(prefix + "-reserve-" + (n + 1), n === 0),
    );
  await inWorkspace(wa, () => finalizeCredits(prefix + "-reserve-1", true));
  const wallet = (await owner.req("/api/billing")).data.wallet;
  check(
    wallet.balance === 1 && wallet.frozenCredits === 0,
    "settlement and release are idempotent",
  );
  check(
    (await outsider.req("/api/billing")).data.ledger.length === 0,
    "credit ledgers isolated",
  );
  await inWorkspace(wa, () => reserveCredits(prefix + "-orphan", "video"));
  await execute(
    "UPDATE credit_reservations SET created_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 20 MINUTE) WHERE job_id=?",
    [prefix + "-orphan"],
  );
  await reconcileCredits();
  check(
    (await owner.req("/api/billing")).data.wallet.frozenCredits === 0,
    "crashed pre-insert reservation is automatically released",
  );

  await owner.req("/api/billing/grant", "POST", {
    units: 20,
    reference: prefix + "-more",
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sWQAAAABJRU5ErkJggg==",
    "base64",
  );
  const form = new FormData();
  form.set("file", new Blob([png], { type: "image/png" }), prefix + ".png");
  const uploaded = await owner.req("/api/uploads", "POST", form);
  check(uploaded.status === 201, "authenticated media upload");
  assets.push(uploaded.data.filename);
  check(
    (await outsider.req(uploaded.data.url)).status === 404,
    "media filename does not bypass tenant isolation",
  );
  check(
    (await guest.req(uploaded.data.url)).status === 200,
    "invited member can access own team media",
  );
  const p = await owner.req("/api/projects", "POST", {
    name: prefix,
    input: { prompt: "Product storyboard", assetIds: [uploaded.data.id] },
  });
  check(
    p.status === 201 && p.data.status === "draft",
    "project draft persisted",
  );
  const pid = p.data.id;
  check(
    (await outsider.req("/api/projects/" + pid)).status === 404,
    "project isolation",
  );
  const prepared = await owner.req(
    "/api/projects/" + pid + "/prepare",
    "POST",
    {},
  );
  check(
    prepared.data.status === "processing" && prepared.data.analysis_job_id,
    "project prepare queues one script task",
  );
  const script = {
    shootingPrompt: "Show product",
    scenes: [
      {
        time: "0-10",
        visual: "product close up",
        voiceover: "Actual product",
        shot: "close",
      },
    ],
  };
  await execute("UPDATE jobs SET status='completed',result=? WHERE id=?", [
    JSON.stringify(script),
    prepared.data.analysis_job_id,
  ]);
  await reconcileProjects();
  await reconcileCredits();
  let ready = (await owner.req("/api/projects/" + pid)).data;
  check(
    ready.status === "waiting_confirmation" &&
      ready.script.shootingPrompt === "Show product",
    "script result requires human confirmation",
  );
  check(
    (
      await owner.req("/api/projects/" + pid, "PATCH", {
        version: ready.version - 1,
        modifiedData: script,
      })
    ).status === 409,
    "stale project edits rejected",
  );
  const updated = await owner.req("/api/projects/" + pid, "PATCH", {
    version: ready.version,
    modifiedData: { ...script, shootingPrompt: "Updated storyboard" },
  });
  ready = updated.data;
  const renderOptions = { segmentStrategy: "fixed", segmentSeconds: 4 };
  const preview = await owner.req("/api/video/plan", "POST", {
    input: {
      ...ready.input,
      ...renderOptions,
      prompt: ready.script.shootingPrompt,
    },
    storyboard: ready.script,
  });
  check(
    preview.status === 200 &&
      preview.data.segments.length === 3 &&
      preview.data.providerCalls === 6,
    "plan preview exposes segment counts and native durations without generation",
  );
  check(
    (
      await owner.req("/api/projects/" + pid + "/confirm", "POST", {
        version: ready.version,
        modifiedData: ready.script,
        renderOptions,
        planFingerprint: "0".repeat(64),
      })
    ).status === 409,
    "stale plan fingerprint cannot start paid jobs",
  );
  const confirmation = {
    version: ready.version,
    modifiedData: ready.script,
    videoGenerationCount: 2,
    renderOptions,
    planFingerprint: preview.data.fingerprint,
  };
  const confirmations = await Promise.all(
    [1, 2].map(() =>
      owner.req("/api/projects/" + pid + "/confirm", "POST", confirmation),
    ),
  );
  check(
    confirmations.every((r) => r.status === 200) &&
      new Set(confirmations.flatMap((r) => r.data.jobIds)).size === 2,
    "concurrent confirmations create exactly two jobs",
  );
  check(
    (
      await owner.req("/api/projects/" + pid + "/confirm", "POST", {
        ...confirmation,
        videoGenerationCount: 3,
      })
    ).status === 409,
    "confirmed version cannot be replaced",
  );
  const [snapshot] = await rows(
    "SELECT * FROM project_confirmations WHERE project_id=?",
    [pid],
  );
  check(
    parse(snapshot.snapshot).shootingPrompt === "Updated storyboard",
    "immutable confirmed storyboard persisted",
  );
  const pinned = await inWorkspace(wa, () =>
    jobGet(confirmations[0].data.jobIds[0]),
  );
  check(
    parse(pinned!.input)._renderPlan.segments.length === 3 &&
      parse(pinned!.input).storyboard.shootingPrompt === "Updated storyboard",
    "confirmed jobs retain full storyboard and execution policy snapshots",
  );
  check(
    (
      await owner.req("/api/projects/" + pid, "PATCH", {
        version: ready.version,
        name: "race",
      })
    ).status === 409,
    "processing project cannot be edited",
  );
  check(
    (await owner.req("/api/projects/" + pid + "/cancel", "POST", {})).data
      .status === "cancelled",
    "cancel propagates to unsubmitted project children",
  );
  await reconcileCredits();
  check(
    (await owner.req("/api/projects/" + pid + "/retry", "POST", {})).data
      .status === "processing",
    "cancelled render project resumes through new retry tasks",
  );
  // A partially successful batch retries only failed children.
  const childIds = parse(snapshot.job_ids);
  await execute("UPDATE jobs SET status='completed',result=? WHERE id=?", [
    JSON.stringify({ asset: { id: "test-only-existing-output" } }),
    childIds[0],
  ]);
  await execute("UPDATE jobs SET status='failed' WHERE id=?", [childIds[1]]);
  await execute(
    "UPDATE projects SET status='processing',render_job_ids=? WHERE id=?",
    [JSON.stringify(childIds), pid],
  );
  await reconcileProjects();
  const retried = await owner.req(
    "/api/projects/" + pid + "/retry",
    "POST",
    {},
  );
  check(
    retried.data.status === "processing" &&
      retried.data.render_job_ids[0] === childIds[0] &&
      retried.data.render_job_ids[1] !== childIds[1],
    "partial retry preserves successful video and retries only failed child",
  );
  await owner.req("/api/projects/" + pid + "/cancel", "POST", {});

  const automation = await owner.req("/api/automations", "POST", {
    name: prefix,
    kind: "collect",
    input: { region: "US", maxPages: 1 },
    intervalMinutes: 15,
    enabled: false,
  });
  check(automation.status === 201, "persistent automation created");
  check(
    (
      await outsider.req(
        "/api/automations/" + automation.data.id + "/run",
        "POST",
        {},
      )
    ).status === 404,
    "automation isolation",
  );
  check(
    (
      await owner.req("/api/automations/" + automation.data.id, "PATCH", {
        intervalMinutes: 1,
      })
    ).status === 400,
    "automation interval lower bound",
  );
  await owner.req("/api/automations/" + automation.data.id, "PATCH", {
    enabled: true,
  });
  await scheduleAutomations();
  await scheduleAutomations();
  const [auto] = await rows("SELECT * FROM automations WHERE id=?", [
    automation.data.id,
  ]);
  check(
    !!auto.last_job_id && !auto.last_error,
    "scheduler persists submitted job and next run",
  );
  const [ac] = await rows("SELECT COUNT(*) n FROM jobs WHERE id=?", [
    auto.last_job_id,
  ]);
  check(
    Number(ac.n) === 1,
    "scheduler duplicate cycle does not duplicate jobs",
  );
  await owner.req("/api/automations/" + automation.data.id, "PATCH", {
    enabled: false,
  });
  const session = "cs_test_" + prefix,
    order = prefix + "-order";
  await execute(
    "INSERT INTO billing_orders(id,workspace_id,session_id,price_id,units,status) VALUES(?,?,?,?,?,'pending')",
    [order, wa, session, "price_fixture", 7],
  );
  const event = JSON.stringify({
    id: "evt_" + prefix,
    type: "checkout.session.completed",
    data: { object: { id: session, mode: "payment", payment_status: "paid" } },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: event,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  const before = (await owner.req("/api/billing")).data.wallet.balance;
  check(
    (
      await new Client().req("/api/billing/webhook", "POST", event, {
        "stripe-signature": "invalid",
      })
    ).status === 400,
    "Stripe invalid webhook signature rejected",
  );
  check(
    (
      await new Client().req("/api/billing/webhook", "POST", event, {
        "stripe-signature": signature,
      })
    ).status === 200,
    "verified Stripe webhook processed without checkout call",
  );
  await new Client().req("/api/billing/webhook", "POST", event, {
    "stripe-signature": signature,
  });
  check(
    (await owner.req("/api/billing")).data.wallet.balance === before + 7,
    "webhook retry does not grant duplicate credits",
  );
  check(
    (await owner.req("/api/admin/audit")).data.some(
      (r: any) => r.action === "project.confirmed",
    ),
    "sensitive actions recorded in audit log",
  );
  check(
    (await operator.req("/api/admin/users")).status === 403,
    "platform user administration protected",
  );
  await owner.req("/api/admin/users/" + ids[3], "PATCH", { disabled: true });
  check(
    (await operator.req("/api/projects")).status === 401,
    "disabling user invalidates existing sessions",
  );
  await execute("DELETE FROM memberships WHERE user_id=?", [ids[1]]);
  check(
    (await outsider.req("/api/projects")).status === 403,
    "account without a workspace cannot read local workspace data",
  );
  check(
    (
      await outsider.req("/api/auth/login", "POST", {
        email: ids[1] + "@example.invalid",
        password,
      })
    ).status === 200,
    "removed member can still sign in to accept a new invite",
  );
  const reInvite = await owner.req("/api/workspaces/invites", "POST", {
    email: ids[1] + "@example.invalid",
    role: "operator",
  });
  check(
    (
      await outsider.req("/api/workspaces/invites/accept", "POST", {
        token: reInvite.data.token,
      })
    ).status === 200,
    "existing account without membership can accept an invite",
  );
  await owner.req("/api/auth/logout", "POST", {});
  check(
    (await owner.req("/api/projects")).status === 401,
    "logout revokes database session",
  );
  console.log(
    `Backend integration complete: ${count} checks. No external requests, payments, generation, publication, or emails.`,
  );
} finally {
  for (const ws of [wa, wb]) {
    const settings =
      "p-" + createHash("sha256").update(ws).digest("hex").slice(0, 30);
    await execute("DELETE FROM settings WHERE id=?", [settings]);
    for (const table of [
      "project_confirmations",
      "projects",
      "automations",
      "credit_reservations",
      "credit_ledger",
      "credit_wallets",
      "billing_orders",
      "invites",
      "audit_log",
      "oauth_states",
      "api_usage",
      "records",
      "jobs",
      "memberships",
    ])
      await execute(`DELETE FROM ${table} WHERE workspace_id=?`, [ws]);
    await execute("DELETE FROM workspaces WHERE id=?", [ws]);
  }
  const users = await rows("SELECT id FROM users WHERE email LIKE ?", [
    prefix + "%@example.invalid",
  ]);
  for (const user of users) {
    await execute("DELETE FROM sessions WHERE user_id=?", [user.id]);
    await execute("DELETE FROM memberships WHERE user_id=?", [user.id]);
    await execute("DELETE FROM users WHERE id=?", [user.id]);
  }
  for (const filename of assets)
    await unlink(resolve(".local/uploads", filename)).catch(() => {});
  await lock.query("SELECT RELEASE_LOCK('x_ecommerce_worker')");
  lock.release();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
}
