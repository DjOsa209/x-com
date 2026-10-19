import "./env.ts";
import { migrate, pool } from "./db.ts";
import { workerCycle } from "./worker-runtime.ts";
await migrate();
console.log("X-Ecommerce durable worker started");
const timer = setInterval(
  () =>
    void workerCycle().catch((e) =>
      console.error("Worker cycle:", e.code || e.name),
    ),
  4000,
);
await workerCycle();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(timer);
    void pool.end().then(() => process.exit(0));
  });
