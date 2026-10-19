import { afterEach, describe, it, expect, vi } from "vitest";
vi.mock("../server/config.ts", () => ({
  config: async () => ({ FAL_KEY: "offline-test-fixture" }),
}));
vi.mock("../server/db.ts", () => ({
  get: vi.fn(),
  rows: vi.fn(),
  execute: vi.fn(),
  put: vi.fn(),
}));
vi.mock("../server/media.ts", () => ({
  readAsset: vi.fn(),
  fetchMedia: vi.fn(),
  resolveVideo: vi.fn(),
}));
import { falClient } from "../server/providers.ts";
afterEach(() => vi.unstubAllGlobals());
describe("actual fal SDK submission transport", () => {
  it("sends exactly one request even when the SDK would retry HTTP 503", async () => {
    const transport = vi.fn(
      async () =>
        new Response('{"detail":"unavailable"}', {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", transport);
    const client = await falClient();
    await expect(
      client.queue.submit("fal-ai/flux/schnell", {
        input: { prompt: "fixture" },
      }),
    ).rejects.toThrow("503");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not resend after an ambiguous connection reset", async () => {
    const transport = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      });
    });
    vi.stubGlobal("fetch", transport);
    const client = await falClient();
    await expect(
      client.queue.submit("fal-ai/flux/schnell", {
        input: { prompt: "fixture" },
      }),
    ).rejects.toThrow("不会重复提交");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("keeps normal status reads compatible with the real SDK", async () => {
    const transport = vi.fn(
      async () =>
        new Response('{"status":"COMPLETED","request_id":"fixture"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", transport);
    const client = await falClient();
    const status = await client.queue.status("fal-ai/flux/schnell", {
      requestId: "fixture",
    });
    expect(status.status).toBe("COMPLETED");
    expect(transport.mock.calls).toHaveLength(1);
  });
});
