import { describe, it, expect } from "vitest";
import {
  buildResearchQuery,
  productEstimate,
  caseIdentity,
  compareSnapshot,
  commentView,
  trendView,
  csvContent,
  researchQuery,
  rankCasesByRules,
} from "../server/research-domain.ts";
import { productSchema, caseSchema } from "../server/research-schema.ts";
import {
  photoItems,
  photoPageTokens,
  submitPhoto,
} from "../server/research-photo.ts";
describe("research contracts and business evidence", () => {
  it("uses the documented video_ids key and gives related products their correct entity", () => {
    const q = buildResearchQuery({
      entity: "video",
      action: "related",
      id: "123",
    });
    expect(q.path).toBe("/echotik/video/product/list");
    expect(q.params.video_ids).toBe("123");
    expect(q.params.video_id).toBeUndefined();
    expect(q.resultEntity).toBe("product");
  });
  it("maps every supported relation to a real validated catalog endpoint", () => {
    for (const [entity, relationships] of Object.entries({
      product: ["video", "creator"],
      video: ["product"],
      creator: ["product", "video"],
      shop: ["product", "video"],
      live: ["product"],
    }))
      for (const relation of relationships)
        expect(
          buildResearchQuery({ entity, relation, action: "related", id: "123" })
            .resultEntity,
        ).toBe(relation);
    expect(() =>
      buildResearchQuery({
        entity: "live",
        relation: "video",
        action: "related",
        id: "123",
      }),
    ).toThrow();
  });
  it("uses creator user_id and live room_id rather than guessed entity prefixes", () => {
    expect(
      buildResearchQuery({ entity: "creator", action: "trend", id: "123" })
        .params.user_id,
    ).toBe("123");
    expect(
      buildResearchQuery({ entity: "live", action: "trend", id: "456" }).params
        .room_id,
    ).toBe("456");
  });
  it("keeps migrated creator handles usable and resolves numeric-only endpoints", async () => {
    expect(
      buildResearchQuery({
        entity: "creator",
        action: "detail",
        id: "@fixture.handle",
      }).params.unique_ids,
    ).toBe("fixture.handle");
    expect(
      buildResearchQuery({
        entity: "creator",
        action: "related",
        id: "fixture.handle",
      }).params.unique_id,
    ).toBe("fixture.handle");
    const calls: any[] = [];
    await researchQuery(
      { entity: "creator", action: "trend", id: "fixture.handle" },
      async (path, params) => {
        calls.push({ path, params });
        return {
          data: {
            list: path.endsWith("detail")
              ? [{ user_id: "12345", nickname: "Fixture" }]
              : [],
          },
        };
      },
    );
    expect(calls[0].params.unique_ids).toBe("fixture.handle");
    expect(calls[1].params.user_id).toBe("12345");
  });
  it("validates reply identity and only supports replies for videos", () => {
    expect(() =>
      buildResearchQuery({ entity: "video", action: "replies", id: "v" }),
    ).toThrow();
    expect(() =>
      buildResearchQuery({
        entity: "product",
        action: "replies",
        id: "v",
        commentId: "c",
      }),
    ).toThrow();
    expect(
      buildResearchQuery({
        entity: "video",
        action: "replies",
        id: "v",
        commentId: "c",
        cursor: "20",
      }).params,
    ).toMatchObject({ video_id: "v", comment_id: "c", offset: "20" });
  });
  it("normalizes relation items and preserves supplier pagination", async () => {
    const result = await researchQuery(
      { entity: "video", action: "related", id: "v" },
      async () => ({
        data: { list: [{ product_id: "p", product_name: "Mug" }] },
        source: "fixture",
      }),
    );
    expect(result.items[0]).toMatchObject({
      id: "p",
      entity: "product",
      title: "Mug",
    });
    expect(result.nextPage).toBeNull();
    const comments = await researchQuery(
      { entity: "video", action: "comments", id: "v" },
      async () => ({
        data: {
          comments: [
            { cid: "c", text: "Needs a lid", user: { nickname: "Shopper" } },
          ],
          cursor: 20,
          has_more: 1,
        },
      }),
    );
    expect(comments.nextCursor).toBe("20");
    expect(comments.items[0].text).toBe("Needs a lid");
  });
  it("does not confuse missing metrics and zero", () => {
    expect(
      productEstimate({
        price: 30,
        cost: 10,
        shipping: null,
        platformFeePercent: 10,
      }),
    ).toBeNull();
    expect(
      productEstimate({
        price: 30,
        cost: 10,
        shipping: 0,
        platformFeePercent: 10,
        currency: "USD",
      }),
    ).toMatchObject({ profit: 17, currency: "USD" });
    expect(
      productEstimate({
        price: 0,
        cost: 2,
        shipping: 0,
        platformFeePercent: 0,
      }),
    ).toMatchObject({ profit: -2, margin: null });
    expect(trendView([{ date: "2026-01-01", sale_cnt: 0 }])[0]).toMatchObject({
      sales: 0,
      gmv: null,
    });
    expect(commentView({ rating: 0, likes: 0 })).toMatchObject({
      rating: 0,
      likes: 0,
    });
  });
  it("deduplicates video sources even across tracking queries", () => {
    expect(
      caseIdentity({
        sourceUrl: "https://www.tiktok.com/@a/video/123?source=share",
      }),
    ).toBe(caseIdentity({ sourceUrl: "https://www.tiktok.com/@b/video/123" }));
    expect(
      caseIdentity({ sourceUrl: "https://example.com/a.mp4?token=temporary" }),
    ).toBe(caseIdentity({ sourceUrl: "https://example.com/a.mp4" }));
    expect(caseIdentity({})).toBeNull();
  });
  it("records first snapshot as baseline and compares only observed evidence", () => {
    const snapshot = {
      detail: { gmv: 0, sales: 5 },
      items: [{ id: "1" }, { id: "2" }],
    };
    expect(compareSnapshot(null, snapshot)).toMatchObject({
      baseline: true,
      newItems: [],
    });
    const diff = compareSnapshot(
      { detail: { gmv: null, sales: 3 }, items: [{ id: "1" }] },
      snapshot,
    );
    expect(diff.newItems).toEqual([{ id: "2" }]);
    expect(diff.metrics.find((m) => m.key === "gmv")?.delta).toBeNull();
    expect(diff.metrics.find((m) => m.key === "sales")?.delta).toBe(2);
  });
  it("rejects invalid costs and excessive assets at input boundaries", () => {
    expect(() => productSchema.parse({ name: "Mug", price: -1 })).toThrow();
    expect(() =>
      productSchema.parse({ name: "Mug", platformFeePercent: 101 }),
    ).toThrow();
    expect(() =>
      productSchema.parse({ name: "Mug", assetIds: Array(11).fill("id") }),
    ).toThrow();
    expect(() =>
      caseSchema.parse({ title: "a", prompt: "x", status: "fake" }),
    ).toThrow();
  });
  it("exports CSV with quoted text and neutralized spreadsheet formulas", () => {
    const csv = csvContent([{ id: "1", title: '=HYPERLINK("bad")' }]);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain("gmv,sales,views");
  });
  it("matches the owned case library by observable market and keywords without requiring Gemini", () => {
    const result = rankCasesByRules(
      [
        {
          id: "a",
          title: "Coffee mug",
          prompt: "Show the lid",
          category: "kitchen",
          tags: [],
          region: "US",
        },
        {
          id: "b",
          title: "Lipstick",
          prompt: "Makeup",
          category: "beauty",
          tags: [],
          region: "FR",
        },
      ],
      "coffee",
      { name: "Travel mug", markets: ["US"], sellingPoints: ["lid"] },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "a", matchMethod: "rules" });
    expect(result[0].matchReason).toContain("规则匹配");
  });
});
describe("EchoTik native photo-search contract", () => {
  it("posts raw base64 to the official endpoint without exposing credentials to redirects", async () => {
    let captured: any;
    await submitPhoto(
      Buffer.from("image-bytes"),
      "image/png",
      "US",
      "mug",
      { username: "fixture", password: "not-real" },
      async (url, init) => {
        captured = { url: String(url), ...init };
        return new Response(
          JSON.stringify({
            code: 0,
            data: { status_code: 0, e_com_items: [] },
          }),
          { status: 200 },
        );
      },
    );
    expect(captured.url).toBe(
      "https://open.echotik.live/api/v3/realtime/product/photo-search?region=US&sk=mug",
    );
    expect(captured.method).toBe("POST");
    expect(captured.redirect).toBe("error");
    expect(JSON.parse(captured.body)).toEqual({
      image_base64: Buffer.from("image-bytes").toString("base64"),
    });
  });
  it("extracts product cards and server-supplied continuation tokens", () => {
    const data = {
      photo_search: {
        image_uri: "server-image",
        box_detection: ["0.1,0.1,0.9,0.9"],
      },
      e_com_items: [
        {
          search_result_id: "123",
          shop_view_data: {
            init_state: {
              product_title: "Mug",
              volume: "0",
              volume_type: "sold_online",
              currency: "USD",
              main_image: "https://example.com/p.png",
            },
          },
        },
        { type: 2 },
      ],
    };
    expect(photoPageTokens(data)).toEqual({
      imageUri: "server-image",
      boxDetection: "0.1,0.1,0.9,0.9",
    });
    expect(photoItems(data, "US")).toMatchObject([
      {
        id: "123",
        title: "Mug",
        sales: 0,
        gmv: null,
        entity: "product",
        region: "US",
      },
    ]);
  });
  it("rejects oversized images before transport and handles supplier errors", async () => {
    let called = false;
    const transport: typeof fetch = async () => {
      called = true;
      return new Response(JSON.stringify({ code: 1, message: "rejected" }));
    };
    await expect(
      submitPhoto(
        Buffer.alloc(2 * 1024 * 1024 + 1),
        "image/png",
        "US",
        "",
        { username: "x", password: "x" },
        transport,
      ),
    ).rejects.toThrow("2MB");
    expect(called).toBe(false);
    await expect(
      submitPhoto(
        Buffer.from("a"),
        "image/png",
        "US",
        "",
        { username: "x", password: "x" },
        transport,
      ),
    ).rejects.toThrow("失败");
  });
});
