import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { pool, rows, execute, type Doc } from "./db.ts";
import { scopes, scope, type Scope, localScope } from "./context.ts";
import { AppError } from "./errors.ts";
const scrypt = promisify(scryptCb);
export const hashToken = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export async function passwordHash(value: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(value, salt, 64)) as Buffer;
  return salt + ":" + key.toString("hex");
}
export async function passwordMatches(value: string, hash: string) {
  const [salt, encoded] = hash.split(":");
  if (!salt || !encoded) return false;
  const key = (await scrypt(value, salt, 64)) as Buffer;
  const expected = Buffer.from(encoded, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
const cookie = (req: Request, name: string) =>
  (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1) || "";
export const authRequired = () =>
  process.env.AUTH_REQUIRED === undefined
    ? process.env.NODE_ENV === "production"
    : process.env.AUTH_REQUIRED === "true";
export async function audit(action: string, details: Doc = {}) {
  await execute(
    "INSERT INTO audit_log(workspace_id,user_id,action,details) VALUES(?,?,?,?)",
    [scope().workspaceId, scope().userId, action, JSON.stringify(details)],
  );
}
export function requireOwner() {
  if (!["owner", "admin"].includes(scope().role))
    throw new AppError(403, "此操作需要工作空间管理员权限", "FORBIDDEN");
}
export function requirePlatformAdmin() {
  if (!scope().admin)
    throw new AppError(403, "此操作需要平台管理员权限", "FORBIDDEN");
}
export async function access(req: Request, res: Response, next: NextFunction) {
  try {
    const token = cookie(req, "x_session");
    let selected: Scope | undefined;
    if (token) {
      const [user] = await rows(
        "SELECT u.id,u.email,u.name,u.global_role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.disabled=0",
        [hashToken(token)],
      );
      if (user) {
        const memberships = await rows(
          "SELECT workspace_id,role FROM memberships WHERE user_id=? ORDER BY workspace_id",
          [user.id],
        );
        const member =
          memberships.find(
            (m) => m.workspace_id === cookie(req, "x_workspace"),
          ) || memberships[0];
        if (member)
          selected = {
            workspaceId: member.workspace_id,
            userId: user.id,
            role: member.role,
            admin: user.global_role === "admin",
          };
        if (!member)
          selected = {
            workspaceId: "",
            userId: user.id,
            role: "viewer",
            admin: user.global_role === "admin",
          };
        res.locals.user = user;
      }
    }
    const publicRoute = [
      "/api/health",
      "/api/auth/status",
      "/api/auth/login",
      "/api/auth/bootstrap",
      "/api/auth/register",
      "/api/auth/invite-preview",
      "/api/billing/webhook",
    ].includes(req.path);
    if (
      !selected &&
      authRequired() &&
      !publicRoute &&
      (req.path.startsWith("/api/") || req.path.startsWith("/media/"))
    )
      throw new AppError(401, "请先登录 X-Ecommerce", "AUTH_REQUIRED");
    if (
      selected &&
      !selected.workspaceId &&
      (req.path.startsWith("/api/") || req.path.startsWith("/media/")) &&
      !publicRoute &&
      !req.path.startsWith("/api/auth/") &&
      ![
        "/api/workspaces",
        "/api/workspaces/select",
        "/api/workspaces/invites/accept",
      ].includes(req.path)
    )
      throw new AppError(
        403,
        "请先创建工作空间或接受邀请",
        "WORKSPACE_REQUIRED",
      );
    selected = selected || localScope;
    if (
      selected.role === "viewer" &&
      !["GET", "HEAD"].includes(req.method) &&
      !req.path.startsWith("/api/auth/") &&
      ![
        "/api/workspaces/select",
        "/api/workspaces",
        "/api/workspaces/invites/accept",
      ].includes(req.path)
    )
      throw new AppError(403, "当前角色为只读，不能执行此操作", "FORBIDDEN");
    scopes.run(selected, () => next());
  } catch (e) {
    next(e);
  }
}
async function session(res: Response, userId: string, workspaceId: string) {
  const token = randomBytes(32).toString("hex");
  await execute(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY))",
    [hashToken(token), userId],
  );
  const options = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 86400000,
  };
  res.cookie("x_session", token, options);
  res.cookie("x_workspace", workspaceId, options);
}
const signup = z.object({
  email: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  name: z.string().min(1).max(100),
  password: z.string().min(12).max(200),
});
const attempts = new Map<string, { count: number; until: number }>();
export const authRoutes = Router();
authRoutes.get("/auth/status", async (_req, res) => {
  const [{ count }] = await rows("SELECT COUNT(*) count FROM users");
  res.json({
    required: authRequired(),
    bootstrapNeeded: Number(count) === 0,
    user: res.locals.user || null,
    workspace: scope().workspaceId,
    role: scope().role,
    platformAdmin: scope().admin,
  });
});
authRoutes.post("/auth/bootstrap", async (req, res) => {
  const input = signup
    .extend({
      workspaceName: z.string().min(1).max(120).default("我的工作空间"),
    })
    .parse(req.body);
  const c = await pool.getConnection();
  const userId = randomUUID();
  try {
    const [locked]: any = await c.query(
      "SELECT GET_LOCK('x_ecommerce_bootstrap',10) acquired",
    );
    if (Number(locked[0].acquired) !== 1)
      throw new AppError(409, "管理员初始化繁忙，请稍后重试");
    const [existing]: any = await c.query("SELECT COUNT(*) count FROM users");
    if (Number(existing[0].count))
      throw new AppError(409, "管理员已初始化，请使用登录或邀请注册");
    await c.beginTransaction();
    await c.execute(
      "INSERT INTO users(id,email,name,password_hash,global_role) VALUES(?,?,?,?,?)",
      [
        userId,
        input.email,
        input.name,
        await passwordHash(input.password),
        "admin",
      ],
    );
    await c.execute("UPDATE workspaces SET name=? WHERE id='local'", [
      input.workspaceName,
    ]);
    await c.execute(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES('local',?,'owner')",
      [userId],
    );
    await c.commit();
    await session(res, userId, "local");
    res.status(201).json({ ok: true });
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    await c.query("SELECT RELEASE_LOCK('x_ecommerce_bootstrap')");
    c.release();
  }
});
authRoutes.post("/auth/login", async (req, res) => {
  const input = z
    .object({
      email: z.email().transform((s) => s.toLowerCase()),
      password: z.string().max(200),
    })
    .parse(req.body);
  const key = (req.ip || "local") + ":" + input.email;
  const entry = attempts.get(key);
  if (entry && entry.until > Date.now() && entry.count >= 5)
    throw new AppError(429, "登录尝试过多，请 15 分钟后再试");
  const [u] = await rows("SELECT * FROM users WHERE email=? AND disabled=0", [
    input.email,
  ]);
  if (!u || !(await passwordMatches(input.password, u.password_hash))) {
    attempts.set(key, {
      count: (entry && entry.until > Date.now() ? entry.count : 0) + 1,
      until: Date.now() + 900000,
    });
    throw new AppError(401, "邮箱或密码不正确");
  }
  attempts.delete(key);
  const [m] = await rows(
    "SELECT workspace_id FROM memberships WHERE user_id=? ORDER BY workspace_id LIMIT 1",
    [u.id],
  );
  await session(res, u.id, m?.workspace_id || "");
  res.json({ ok: true });
});
authRoutes.post("/auth/logout", async (req, res) => {
  await execute("DELETE FROM sessions WHERE token_hash=?", [
    hashToken(cookie(req, "x_session")),
  ]);
  res.clearCookie("x_session", { path: "/" });
  res.clearCookie("x_workspace", { path: "/" });
  res.json({ ok: true });
});
authRoutes.post("/auth/password", async (req, res) => {
  if (scope().userId === "local") throw new AppError(401, "请先登录");
  const b = z
    .object({
      oldPassword: z.string(),
      newPassword: z.string().min(12).max(200),
    })
    .parse(req.body);
  const [u] = await rows("SELECT password_hash FROM users WHERE id=?", [
    scope().userId,
  ]);
  if (!u || !(await passwordMatches(b.oldPassword, u.password_hash)))
    throw new AppError(401, "原密码不正确");
  await execute("UPDATE users SET password_hash=? WHERE id=?", [
    await passwordHash(b.newPassword),
    scope().userId,
  ]);
  await execute("DELETE FROM sessions WHERE user_id=?", [scope().userId]);
  await session(res, scope().userId, scope().workspaceId);
  await audit("password.changed");
  res.json({ ok: true });
});
authRoutes.get("/workspaces", async (_req, res) => {
  if (scope().userId === "local")
    return res.json([{ id: "local", name: "我的工作空间", role: "owner" }]);
  res.json(
    await rows(
      "SELECT w.*,m.role FROM workspaces w JOIN memberships m ON w.id=m.workspace_id WHERE m.user_id=?",
      [scope().userId],
    ),
  );
});
authRoutes.post("/workspaces", async (req, res) => {
  if (scope().userId === "local")
    throw new AppError(401, "请先初始化账号并登录");
  const { name } = z
    .object({ name: z.string().min(1).max(120) })
    .parse(req.body);
  const id = randomUUID();
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    await c.execute("INSERT INTO workspaces(id,name) VALUES(?,?)", [id, name]);
    await c.execute(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,'owner')",
      [id, scope().userId],
    );
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
  res.status(201).json({ id, name, role: "owner" });
});
authRoutes.post("/workspaces/select", async (req, res) => {
  const id = z.string().parse(req.body.workspaceId);
  const [m] = await rows(
    "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
    [id, scope().userId],
  );
  if (!m) throw new AppError(403, "你不是该空间成员");
  res.cookie("x_workspace", id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 86400000,
  });
  res.json({ ok: true });
});
authRoutes.patch("/workspaces/current", async (req, res) => {
  requireOwner();
  const name = z.string().min(1).max(120).parse(req.body.name);
  await execute("UPDATE workspaces SET name=? WHERE id=?", [
    name,
    scope().workspaceId,
  ]);
  await audit("workspace.updated");
  res.json({ ok: true });
});
authRoutes.get("/workspaces/members", async (_req, res) =>
  res.json(
    await rows(
      "SELECT u.id,u.email,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?",
      [scope().workspaceId],
    ),
  ),
);
authRoutes.patch("/workspaces/members/:id", async (req, res) => {
  requireOwner();
  const role = z.enum(["admin", "operator", "viewer"]).parse(req.body.role);
  const [m] = await rows(
    "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
    [scope().workspaceId, req.params.id],
  );
  if (!m) throw new AppError(404, "成员不存在");
  if (m.role === "owner") throw new AppError(409, "不能修改所有者角色");
  if (scope().role === "admin" && m.role === "admin")
    throw new AppError(403, "管理员不能修改同级管理员");
  await execute(
    "UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?",
    [role, scope().workspaceId, req.params.id],
  );
  await audit("member.role_changed", { userId: req.params.id, role });
  res.json({ ok: true });
});
authRoutes.delete("/workspaces/members/:id", async (req, res) => {
  requireOwner();
  const [m] = await rows(
    "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
    [scope().workspaceId, req.params.id],
  );
  if (m?.role === "owner" || (scope().role === "admin" && m?.role === "admin"))
    throw new AppError(403, "不能移除此成员");
  await execute("DELETE FROM memberships WHERE workspace_id=? AND user_id=?", [
    scope().workspaceId,
    req.params.id,
  ]);
  await audit("member.removed", { userId: req.params.id });
  res.json({ ok: true });
});
authRoutes.post("/workspaces/leave", async (_req, res) => {
  if (scope().role === "owner")
    throw new AppError(409, "所有者不能直接退出空间");
  await execute("DELETE FROM memberships WHERE workspace_id=? AND user_id=?", [
    scope().workspaceId,
    scope().userId,
  ]);
  res.clearCookie("x_workspace", { path: "/" });
  res.json({ ok: true });
});
authRoutes.get("/workspaces/invites", async (_req, res) => {
  requireOwner();
  res.json(
    await rows(
      "SELECT id,email,role,expires_at,accepted_at FROM invites WHERE workspace_id=? ORDER BY created_at DESC",
      [scope().workspaceId],
    ),
  );
});
authRoutes.post("/workspaces/invites", async (req, res) => {
  requireOwner();
  if (scope().userId === "local") throw new AppError(401, "请先初始化账号");
  const b = z
    .object({
      email: z.email().transform((s) => s.toLowerCase()),
      role: z.enum(["admin", "operator", "viewer"]).default("operator"),
    })
    .parse(req.body);
  const token = randomBytes(32).toString("hex"),
    id = randomUUID();
  await execute(
    "INSERT INTO invites(id,workspace_id,email,role,token_hash,expires_at) VALUES(?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY))",
    [id, scope().workspaceId, b.email, b.role, hashToken(token)],
  );
  await audit("invite.created", { email: b.email, role: b.role });
  res.status(201).json({ id, token, expiresInDays: 7 });
});
authRoutes.delete("/workspaces/invites/:id", async (req, res) => {
  requireOwner();
  await execute("DELETE FROM invites WHERE id=? AND workspace_id=?", [
    req.params.id,
    scope().workspaceId,
  ]);
  res.json({ ok: true });
});
authRoutes.get("/auth/invite-preview", async (req, res) => {
  const token = z.string().max(128).parse(req.query.token);
  const [i] = await rows(
    "SELECT i.email,i.role,w.name workspaceName FROM invites i JOIN workspaces w ON w.id=i.workspace_id WHERE token_hash=? AND expires_at>UTC_TIMESTAMP() AND accepted_at IS NULL",
    [hashToken(token)],
  );
  if (!i) throw new AppError(404, "邀请已过期或失效");
  res.json(i);
});
async function acceptInvite(
  token: string,
  userId: string,
  email: string,
  c: any,
) {
  const [invites] = await c.execute(
    "SELECT * FROM invites WHERE token_hash=? AND expires_at>UTC_TIMESTAMP() AND accepted_at IS NULL FOR UPDATE",
    [hashToken(token)],
  );
  const i = invites[0];
  if (!i || i.email !== email)
    throw new AppError(400, "邀请与当前邮箱不匹配，或已失效");
  await c.execute(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,?) ON DUPLICATE KEY UPDATE role=role",
    [i.workspace_id, userId, i.role],
  );
  await c.execute("UPDATE invites SET accepted_at=UTC_TIMESTAMP() WHERE id=?", [
    i.id,
  ]);
  return i.workspace_id;
}
authRoutes.post("/auth/register", async (req, res) => {
  const b = signup
    .extend({ inviteToken: z.string().min(20).max(128) })
    .parse(req.body);
  const id = randomUUID(),
    c = await pool.getConnection();
  let ws = "";
  try {
    await c.beginTransaction();
    await c.execute(
      "INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)",
      [id, b.email, b.name, await passwordHash(b.password)],
    );
    ws = await acceptInvite(b.inviteToken, id, b.email, c);
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
  await session(res, id, ws);
  res.status(201).json({ ok: true });
});
authRoutes.post("/workspaces/invites/accept", async (req, res) => {
  if (!res.locals.user) throw new AppError(401, "请先登录");
  const token = z.string().parse(req.body.token),
    c = await pool.getConnection();
  let ws = "";
  try {
    await c.beginTransaction();
    ws = await acceptInvite(token, scope().userId, res.locals.user.email, c);
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
  res.json({ workspaceId: ws });
});
authRoutes.get("/admin/audit", async (_req, res) => {
  requireOwner();
  res.json(
    await rows(
      "SELECT * FROM audit_log WHERE workspace_id=? ORDER BY id DESC LIMIT 200",
      [scope().workspaceId],
    ),
  );
});
authRoutes.get("/admin/users", async (_req, res) => {
  requirePlatformAdmin();
  res.json(
    await rows(
      "SELECT id,email,name,global_role,disabled,created_at FROM users ORDER BY created_at DESC",
    ),
  );
});
authRoutes.patch("/admin/users/:id", async (req, res) => {
  requirePlatformAdmin();
  const disabled = z.boolean().parse(req.body.disabled);
  if (req.params.id === scope().userId)
    throw new AppError(409, "不能停用自己的账号");
  await execute("UPDATE users SET disabled=? WHERE id=?", [
    disabled,
    req.params.id,
  ]);
  if (disabled)
    await execute("DELETE FROM sessions WHERE user_id=?", [req.params.id]);
  await audit("user.status_changed", { userId: req.params.id, disabled });
  res.json({ ok: true });
});
