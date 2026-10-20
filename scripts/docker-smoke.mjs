import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const base = process.env.DOCKER_TEST_URL || "http://127.0.0.1:4399";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("Docker smoke requires a local disposable validation stack");
const project = "x-ecommerce-validation",
  args = [
    "compose",
    "--env-file",
    ".local/deploy-check.env",
    "-f",
    "docker-compose.yml",
    "-p",
    project,
  ];
const cookies = new Map();
let checks = 0;
const check = (v, label) => {
  assert.ok(v, label);
  console.log("PASS " + label);
  checks++;
};
async function request(path, method = "GET", body) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  for (const c of r.headers.getSetCookie()) {
    const [k, ...v] = c.split(";")[0].split("=");
    cookies.set(k, v.join("="));
  }
  const data = r.headers.get("Content-Type")?.includes("application/json")
    ? await r.json()
    : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data };
}
async function waitReady() {
  let last;
  for (let i = 0; i < 40; i++) {
    try {
      last = await request("/health");
      if (last.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Validation stack did not become ready");
}
await waitReady();
check(
  (await request("/auth/status")).data.bootstrapNeeded,
  "fresh container database awaits initialization",
);
const password = randomBytes(24).toString("hex");
check(
  (
    await request("/auth/bootstrap", "POST", {
      email: "docker-smoke@example.invalid",
      name: "Docker smoke fixture",
      password,
      workspaceName: "Disposable Docker validation",
    })
  ).status === 201,
  "container authentication bootstrap works",
);
const form = new FormData();
form.append(
  "file",
  new Blob(
    [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWQAAAABJRU5ErkJggg==",
        "base64",
      ),
    ],
    { type: "image/png" },
  ),
  "docker-smoke.png",
);
const upload = await request("/uploads", "POST", form);
check(upload.status === 201, "container stores media on the shared volume");
const asset = upload.data;
check(
  (
    await request("/settings", "PUT", {
      KIE_API_KEY: "offline-docker-smoke-fixture",
    })
  ).status === 200,
  "container encrypts a workspace credential",
);
const draft = await request("/records/draft", "POST", {
  name: "Docker restart fixture",
  assetIds: [asset.id],
});
check(draft.status === 201, "container persists business record");
await run("docker", [...args, "restart", "app", "worker"], { timeout: 120000 });
await waitReady();
check(
  (await request("/auth/status")).data.user?.email ===
    "docker-smoke@example.invalid",
  "database session survives application restart",
);
check(
  (await request("/records/draft/" + draft.data.id)).data.name ===
    "Docker restart fixture",
  "business data survive restart",
);
check(
  (await request("/assets/" + asset.id + "/download")).data.equals(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWQAAAABJRU5ErkJggg==",
      "base64",
    ),
  ),
  "shared media bytes survive restart",
);
check(
  (await request("/settings")).data.connections.kie,
  "encrypted configuration decrypts after restart",
);
const media = await run(
  "docker",
  [
    ...args,
    "exec",
    "-T",
    "app",
    "sh",
    "-c",
    "ffmpeg -hide_banner -filters 2>/dev/null | grep subtitles && fc-match 'Noto Sans CJK SC'",
  ],
  { timeout: 30000 },
);
check(
  media.stdout.includes("subtitles") && media.stdout.includes("Noto"),
  "container includes subtitles filter and CJK fonts",
);
await run(
  "docker",
  [
    ...args,
    "exec",
    "-T",
    "worker",
    "node_modules/.bin/tsx",
    "scripts/worker-health.ts",
  ],
  { timeout: 30000 },
);
check(true, "independent worker heartbeat is healthy after restart");
console.log(
  `Docker smoke passed: ${checks} checks. Only the disposable ${project} stack was changed; no provider requests.`,
);
