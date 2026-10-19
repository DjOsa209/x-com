import { parse } from "yaml";
import { mkdir, writeFile } from "node:fs/promises";
const index = await (
  await fetch("https://opendocs.echotik.live/llms.txt")
).text();
const urls = [
  ...new Set(
    [
      ...index.matchAll(
        /https:\/\/opendocs\.echotik\.live\/(?:echotik|realtime)\/[^)\s]+\.md/g,
      ),
    ].map((m) => m[0]),
  ),
];
const catalog: any[] = [];
const failures: string[] = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (!r.ok) throw new Error(String(r.status));
        const source = await r.text();
        const yaml = source.match(/```yaml\s*([\s\S]*?)```/)?.[1];
        if (!yaml) continue;
        const spec = parse(yaml);
        for (const [path, methods] of Object.entries<any>(spec.paths || {})) {
          for (const [method, op] of Object.entries<any>(methods)) {
            if (method !== "get") continue;
            catalog.push({
              path: path.replace(/^\/api\/v3/, ""),
              method: "GET",
              title: op.summary,
              description: op.description || "",
              group: op.tags?.[0] || path.split("/")[4],
              source: url.replace(/\.md$/, ""),
              parameters: (op.parameters || [])
                .filter((p: any) => p.in === "query")
                .map((p: any) => ({
                  name: p.name,
                  required: !!p.required,
                  description: p.description || "",
                  type: p.schema?.type || "string",
                  enum: p.schema?.enum,
                  default: p.schema?.default,
                })),
            });
          }
        }
      } catch {
        failures.push(url);
      }
    }
  }),
);
const unique = [...new Map(catalog.map((e) => [e.path, e])).values()].sort(
  (a, b) => a.path.localeCompare(b.path),
);
await mkdir("server/data", { recursive: true });
await writeFile(
  "server/data/echotik-catalog.json",
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      source: "https://opendocs.echotik.live/llms.txt",
      endpoints: unique,
      failures,
    },
    null,
    2,
  ),
);
console.log(
  `Saved ${unique.length} distinct official GET endpoint definitions (${catalog.length} document definitions); ${failures.length} failed.`,
);
if (failures.length) process.exitCode = 1;
