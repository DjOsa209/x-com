import "../server/env.ts";
import express from "express";
import { chromium, expect } from "@playwright/test";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
process.env.AUTH_REQUIRED = "true";
process.env.COOKIE_SECURE = "false";
const { app, apiErrors } = await import("../server/app.ts");
const { pool, rows, execute, migrate, updateJob } =
  await import("../server/db.ts");
const { passwordHash } = await import("../server/auth.ts");
const { inWorkspace } = await import("../server/context.ts");
const { saveMedia, mediaRoot } = await import("../server/media.ts");
const { ffmpegPath } = await import("../server/video-compose.ts");
const { runVideoEdit } = await import("../server/video-edit.ts");
await migrate();
apiErrors();
app.use(express.static(resolve("dist")));
app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as any).port;
const ws = "e2e-" + randomUUID().slice(0, 8),
  user = ws + "-owner",
  password = randomBytes(20).toString("hex"),
  email = user + "@example.invalid";
const shots = resolve("docs/qa/screenshots");
await mkdir(shots, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "x-ecommerce-e2e-"));
const lock = await pool.getConnection();
await lock.query("SELECT GET_LOCK('x_ecommerce_worker',30)");
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "zh-CN",
});
await context.route("https://**", (route) => route.abort());
const page = await context.newPage();
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
let checks = 0;
const check = (label: string) => {
  checks++;
  console.log("PASS " + label);
};
const screenshot = async (name: string) => {
  await page.screenshot({ path: join(shots, name + ".png"), fullPage: true });
};
try {
  await execute("INSERT INTO workspaces(id,name) VALUES(?,?)", [
    ws,
    "浏览器验收 · 测试空间",
  ]);
  await execute(
    "INSERT INTO users(id,email,name,password_hash,global_role) VALUES(?,?,?,?,?)",
    [user, email, "验收成员", await passwordHash(password), "admin"],
  );
  await execute("INSERT INTO memberships VALUES(?,?,'owner')", [ws, user]);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWQAAAABJRU5ErkJggg==",
    "base64",
  );
  await inWorkspace(ws, () => saveMedia(png, "image/png", "QA 商品图"));
  const videoPath = join(temp, "fixture.mp4");
  await promisify(execFile)(ffmpegPath(), [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x595f98:s=360x640:r=24:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    videoPath,
  ]);
  const source = await inWorkspace(ws, async () =>
    saveMedia(await readFile(videoPath), "video/mp4", "QA 本地测试视频"),
  );
  await page.goto(base + "/products");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的商品", exact: true }),
  ).toBeVisible();
  check("login and real workspace navigation");
  await page.getByRole("button", { name: "添加商品", exact: true }).click();
  await page.getByLabel("商品名称", { exact: true }).fill("QA 便携收纳盒");
  await page.getByLabel("SKU", { exact: true }).fill("QA-BOX-1");
  await page
    .getByLabel("产品说明", { exact: true })
    .fill("浏览器验收样本，可折叠收纳盒");
  await page.getByLabel("卖点（每行一条）").fill("折叠收纳\n容易携带");
  await page.getByRole("button", { name: "从素材库选择", exact: true }).click();
  await page.getByRole("button", { name: "QA 商品图" }).click();
  await page.getByRole("button", { name: "保存商品", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "QA 便携收纳盒", exact: true }),
  ).toBeVisible();
  check("product form selects owned image and persists");
  await screenshot("desktop-products");
  await page.goto(base + "/opportunities");
  await page.getByRole("button", { name: "记录机会", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("QA 户外收纳机会");
  await page
    .getByLabel("机会假设", { exact: true })
    .fill("验证折叠体积是否便于露营携带");
  await page
    .getByLabel("关联自有商品")
    .selectOption({ label: "QA 便携收纳盒" });
  await page
    .getByLabel("研究笔记与测试结论")
    .fill("测试数据，仅用于验收，不代表真实市场需求");
  await page.getByRole("button", { name: "保存跟进", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "QA 户外收纳机会", exact: true }),
  ).toBeVisible();
  check("opportunity links to product and stores evidence notes");
  await page.getByRole("button", { name: "创建测试视频", exact: true }).click();
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "分镜时间轴", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "添加镜头", exact: true }).click();
  await page.getByLabel("画面与商品动作").fill("手持真实收纳盒，展示折叠步骤");
  await page.getByLabel("口播 / 字幕").fill("出门时把收纳盒折叠放进包中");
  await page.getByRole("button", { name: "保存分镜", exact: true }).click();
  await expect(
    page.getByText("待确认分镜 · v2", { exact: true }),
  ).toBeVisible();
  check("opportunity to project with editable storyboard");
  await screenshot("desktop-storyboard");
  await page.getByRole("tab", { name: "版本记录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "版本与确认记录", exact: true }),
  ).toBeVisible();
  check("project history available");
  await page.goto(base + "/studio/edit?assetId=" + source!.id);
  await expect(
    page.getByText("QA 本地测试视频", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "添加字幕", exact: true }).click();
  await page.getByLabel("字幕 1 文本").fill("中文烧录验收");
  await page.getByLabel("将字幕烧录进视频画面").check();
  await page.getByRole("button", { name: "导出新的成片", exact: true }).click();
  await expect(
    page.getByText("本地后期任务已提交", { exact: true }),
  ).toBeVisible();
  const [edit] = await rows(
    "SELECT * FROM jobs WHERE workspace_id=? AND kind='video_edit' ORDER BY created_at DESC LIMIT 1",
    [ws],
  );
  await inWorkspace(ws, async () => {
    await updateJob(edit.id, { status: "running" });
    const result = await runVideoEdit(
      typeof edit.input === "string" ? JSON.parse(edit.input) : edit.input,
      edit.id,
    );
    await updateJob(edit.id, { status: "completed", result });
  });
  await expect(
    page.getByRole("heading", { name: /后期任务 · 已完成/ }),
  ).toBeVisible({ timeout: 15000 });
  check("postproduction UI submits and displays real FFmpeg output");
  await screenshot("desktop-postproduction");
  await page.getByRole("link", { name: "发布此成片", exact: true }).click();
  await page.getByLabel("记录名称", { exact: true }).fill("QA 收纳盒成片");
  await page
    .getByLabel("发布文案", { exact: false })
    .fill("本地验收视频 #收纳");
  await page
    .getByLabel("关联商品", { exact: false })
    .selectOption({ label: "QA 便携收纳盒" });
  await page.getByRole("button", { name: "保存为待审核", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "QA 收纳盒成片", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看与审核", exact: true }).click();
  await page.getByLabel("我已检查视频、文案、品牌信息及 AI 标记").check();
  await page.getByRole("button", { name: "审核此版本", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "下载完整发布包", exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载完整发布包", exact: true })
    .click();
  const download = await downloadPromise;
  const archivePath = await download.path();
  const archive = await readFile(archivePath!);
  expect(archive.readUInt32LE(0)).toBe(0x04034b50);
  check("reviewed publication ZIP downloads without TikTok credentials");
  await screenshot("desktop-publishing");
  await page
    .getByLabel("登记已发布作品")
    .fill("https://www.tiktok.com/@qa_fixture/video/1234567890123456789");
  await page
    .getByRole("button", { name: "登记真实作品链接", exact: true })
    .click();
  await expect(page.getByText("作品链接已登记", { exact: true })).toBeVisible();
  await page.getByLabel("播放", { exact: true }).fill("0");
  await page.getByLabel("点赞", { exact: true }).fill("0");
  await page.getByLabel("数据来源/备注").fill("离线浏览器验收样本，非真实业绩");
  await page
    .getByRole("button", { name: "保存手工指标快照", exact: true })
    .click();
  await expect(page.getByText("指标快照已保存", { exact: true })).toBeVisible();
  check("manual publication links and explicit zero metrics persist");
  await page.goto(base + "/analytics");
  await expect(
    page.getByRole("button", { name: "QA 收纳盒成片", exact: true }),
  ).toBeVisible();
  check("published result appears in content analytics");
  await page.goto(base + "/automations");
  await page.getByRole("button", { name: "新建自动化", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("QA 预算受限扫描");
  await page.getByLabel("单次请求上限").fill("2");
  await page.getByLabel("此自动化每日上限").fill("3");
  await page.getByLabel("启用定时研究").uncheck();
  await page.getByRole("button", { name: "保存自动化", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "QA 预算受限扫描", exact: true }),
  ).toBeVisible();
  check("automation template and request budget persist through UI");
  await page.goto(base + "/assets");
  await page.getByLabel("搜索素材").fill("QA 本地测试视频");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  check("asset library server filtering");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, title] of [
    ["overview", "经营概览"],
    ["products", "我的商品"],
    ["projects", "创作项目"],
    ["publish", "发布中心"],
    ["automations", "自动化研究"],
    ["assets", "素材库"],
  ]) {
    await page.goto(base + "/" + route);
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    if (["overview", "products", "publish"].includes(route))
      await screenshot("mobile-" + route);
    check("mobile " + route + " no horizontal overflow");
  }
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "项目与分镜", exact: true }),
  ).toBeVisible();
  check("mobile drawer navigation");
  expect(errors).toEqual([]);
  check("no browser runtime errors");
  console.log(
    `Browser E2E passed: ${checks} checks. All data are disposable local fixtures; no external APIs called.`,
  );
} catch (e) {
  await screenshot("failure");
  throw e;
} finally {
  await browser.close();
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  const assets = await rows(
    "SELECT JSON_UNQUOTE(JSON_EXTRACT(body,'$.filename')) filename FROM records WHERE workspace_id=? AND kind='asset'",
    [ws],
  );
  for (const a of assets)
    if (a.filename) await rm(resolve(mediaRoot, a.filename), { force: true });
  const tables = await rows(
    "SELECT TABLE_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='workspace_id'",
  );
  for (const t of tables)
    await execute(`DELETE FROM \`${t.name}\` WHERE workspace_id=?`, [ws]);
  await execute("DELETE FROM sessions WHERE user_id=?", [user]);
  await execute("DELETE FROM users WHERE id=?", [user]);
  await execute("DELETE FROM workspaces WHERE id=?", [ws]);
  await lock.query("SELECT RELEASE_LOCK('x_ecommerce_worker')");
  lock.release();
  await pool.end();
  await rm(temp, { recursive: true, force: true });
}
