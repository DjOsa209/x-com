import "./env.ts";
import express from "express";
import { resolve } from "node:path";
import { app, apiErrors } from "./app.ts";
import { migrate, pool } from "./db.ts";
import { tick, recoverJobs } from "./jobs.ts";
const port = Number(process.env.PORT || 4317),
  host = process.env.HOST || "127.0.0.1";
let ready = false;
try {
  await migrate();
  await recoverJobs();
  ready = true;
} catch (e: any) {
  console.error(
    "MySQL 未连接。请运行 npm run db:local，或配置 .env.local。",
    e.code || "",
  );
}
apiErrors();
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(port, host, () =>
  console.log(`X-Ecommerce ready at http://localhost:${port}`),
);
const worker = setInterval(async () => {
  try {
    if (!ready) {
      await migrate();
      await recoverJobs();
      ready = true;
    }
    await tick();
  } catch (e: any) {
    if (["ECONNREFUSED", "PROTOCOL_CONNECTION_LOST"].includes(e.code))
      ready = false;
    console.error("Worker:", e.code || e.name);
  }
}, 4000);
worker.unref();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(worker);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
