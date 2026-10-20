import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
vi.mock("../server/db.ts", () => ({
  rows: vi.fn(async (sql: string) =>
    sql.includes("COUNT(*)") ? [{ used: 0 }] : [],
  ),
  execute: vi.fn(async () => ({ affectedRows: 1 })),
  parse: (x: any) => (typeof x === "string" ? JSON.parse(x) : x),
  get: vi.fn(),
  put: vi.fn(),
}));
vi.mock("../server/research-budget.ts", () => ({
  withResearchBudgetRequest: async (
    _provider: string,
    _endpoint: string,
    send: () => Promise<any>,
  ) => send(),
  recordResearchEvidence: vi.fn(async () => {}),
}));
vi.mock("../server/config.ts", () => ({
  config: vi.fn(async () => ({
    ECHOTIK_USERNAME: "test-user",
    ECHOTIK_PASSWORD: "test-password",
    ECHOTIK_BASE_URL: "https://open.echotik.live/api/v3",
    ECHOTIK_MONTHLY_LIMIT: 100,
    ECHOTIK_CACHE_SECONDS: 0,
  })),
}));
import {
  catalog,
  validateQuery,
  extractItems,
  normalizeItem,
  echoQuery,
} from "../server/echotik.ts";
import {
  privateIp,
  validatePublicUrl,
  findVideoUrl,
  resolveVideo,
} from "../server/media.ts";
import { rows, execute } from "../server/db.ts";
import { config } from "../server/config.ts";
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
describe("official EchoTik catalog and schemas", () => {
  it("keeps only official allowlisted v3 GET routes and required parameter information", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(78);
    expect(new Set(catalog.map((e) => e.path)).size).toBe(catalog.length);
    for (const e of catalog) {
      expect(e.path).toMatch(/^\/(echotik|realtime)\//);
      expect(e.source).toMatch(/^https:\/\/opendocs\.echotik\.live\//);
      expect(e.parameters.every((p) => p.name && p.type)).toBe(true);
    }
  });
  it("uses sk for products and keyword for videos", () => {
    expect(
      catalog
        .find((e) => e.path === "/realtime/product/search")!
        .parameters.some((p) => p.name === "sk" && p.required),
    ).toBe(true);
    expect(
      catalog
        .find((e) => e.path === "/realtime/video/search")!
        .parameters.some((p) => p.name === "keyword" && p.required),
    ).toBe(true);
  });
  it("rejects missing required parameters before network access", () => {
    const e = catalog.find((e) => e.path === "/realtime/product/search")!;
    expect(() => validateQuery(e, { keyword: "coffee", region: "US" })).toThrow(
      "sk",
    );
  });
  it("does not forward unknown or credential query parameters", () => {
    const e = catalog.find((e) => e.path === "/realtime/product/search")!;
    expect(
      validateQuery(e, {
        sk: "coffee",
        region: "US",
        password: "secret",
        junk: "x",
      }),
    ).toEqual({ sk: "coffee", region: "US" });
  });
  it("validates integer fields and history page size", () => {
    const e = catalog.find((e) => e.path === "/echotik/product/ranklist")!;
    const p = {
      date: "2026-10-18",
      region: "US",
      product_rank_field: 1,
      rank_type: 1,
      page_num: 1,
      page_size: 10,
    };
    expect(validateQuery(e, p).page_size).toBe("10");
    expect(() => validateQuery(e, { ...p, page_num: "1;DROP TABLE" })).toThrow(
      "整数",
    );
    expect(() => validateQuery(e, { ...p, page_size: 11 })).toThrow("最多 10");
  });
  it("preserves cursor strings instead of incrementing them", () => {
    const e = catalog.find((e) => e.path === "/realtime/video/comments")!;
    expect(
      validateQuery(e, { video_id: "123", offset: "1760000000999", count: 20 })
        .offset,
    ).toBe("1760000000999");
  });
});
describe("response normalization", () => {
  it("extracts product search sections and nested comment lists", () => {
    expect(
      extractItems({
        body: {
          sections: [
            { items: [{ product_id: "1" }] },
            { items: [{ product_id: "2" }] },
          ],
        },
      }),
    ).toHaveLength(2);
    expect(
      extractItems({ data: { comments: [{ text: "too small" }] } }),
    ).toEqual([{ text: "too small" }]);
  });
  it("keeps absent GMV null and actual zero distinct", () => {
    expect(
      normalizeItem(
        { product_id: "1729413266549936259", product_name: "Coffee" },
        "product",
      ).gmv,
    ).toBeNull();
    expect(
      normalizeItem({ video_id: "1", total_video_sale_gmv_amt: 0 }, "video")
        .gmv,
    ).toBe(0);
  });
  it("preserves long string IDs and source currency", () => {
    const r = normalizeItem(
      {
        product_id: "1729413266549936259",
        product_name: "Coffee",
        currency: "PHP",
        total_sale_gmv_amt: 123,
      },
      "product",
    );
    expect(r.id).toBe("1729413266549936259");
    expect(r.currency).toBe("PHP");
    expect(r.gmv).toBe(123);
  });
  it("finds download URLs in real documented response shape", () => {
    expect(
      findVideoUrl({
        play_url: "https://example.com/play.mp4",
        download_url: "https://example.com/download.mp4",
      }),
    ).toBe("https://example.com/download.mp4");
  });
});
describe("credentialed requests and billing guards", () => {
  it("sends Basic credentials only to the official origin", async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: 0, data: [{ product_id: "123" }] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", f);
    const r = await echoQuery("/realtime/product/search", {
      sk: "coffee",
      region: "US",
    });
    const [url, options] = f.mock.calls[0] as any;
    expect(url.origin).toBe("https://open.echotik.live");
    expect(url.pathname).toBe("/api/v3/realtime/product/search");
    expect(options.headers.Authorization).toBe(
      "Basic " + Buffer.from("test-user:test-password").toString("base64"),
    );
    expect(r.source).toBe("EchoTik");
    expect(r.currency).toBeNull();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("api_usage"),
      expect.arrayContaining([true]),
    );
  });
  it("deduplicates simultaneous identical queries", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => {
      await wait;
      return new Response(JSON.stringify({ code: 0, data: [] }));
    });
    vi.stubGlobal("fetch", f);
    const a = echoQuery(
      "/realtime/video/comments",
      { video_id: "dedupe-test" },
      true,
    );
    const b = echoQuery(
      "/realtime/video/comments",
      { video_id: "dedupe-test" },
      true,
    );
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([a, b]);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("does not treat nonzero business status as success or retry automatically", async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: 500, message: "temporarily unavailable" }),
        ),
    );
    vi.stubGlobal("fetch", f);
    await expect(
      echoQuery("/realtime/video/comments", { video_id: "failed-test" }, true),
    ).rejects.toThrow("EchoTik 请求失败");
    expect(f).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("api_usage"),
      expect.arrayContaining([false]),
    );
  });
  it("blocks out-of-budget requests before calling upstream", async () => {
    vi.mocked(rows).mockResolvedValueOnce([{ used: 100 }] as any);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(
      echoQuery("/realtime/video/comments", { video_id: "budget-test" }, true),
    ).rejects.toThrow("预算");
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects arbitrary paths before fetching", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(echoQuery("//attacker.example/path", {})).rejects.toThrow(
      "白名单",
    );
    expect(f).not.toHaveBeenCalled();
  });
});
describe("media boundaries", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.1",
    "172.16.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ])("rejects internal IP %s", (ip) => expect(privateIp(ip)).toBe(true));
  it("allows public IPs but requires HTTPS and denies embedded credentials", async () => {
    expect(privateIp("8.8.8.8")).toBe(false);
    expect(privateIp("2606:4700:4700::1111")).toBe(false);
    await expect(
      validatePublicUrl("http://example.com/video.mp4"),
    ).rejects.toThrow("HTTPS");
    await expect(
      validatePublicUrl("https://u:p@example.com/video.mp4"),
    ).rejects.toThrow("HTTPS");
    await expect(
      validatePublicUrl("https://127.0.0.1/video.mp4"),
    ).rejects.toThrow("内部网络");
  });
  it("does not claim EchoTik supports Douyin resolution", async () => {
    await expect(
      resolveVideo("https://www.douyin.com/video/123"),
    ).rejects.toThrow("抖音");
  });
});
