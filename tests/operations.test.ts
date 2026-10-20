import { describe, it, expect } from "vitest";
import {
  publicationInput,
  approvalFingerprint,
  parseTikTokLink,
  compareContent,
} from "../server/operations.ts";
import { verifiedVideoUrl, validateCreatorVideo } from "../server/tiktok.ts";
import { automationInput } from "../server/automations.ts";

const video = {
  format: { duration: "30" },
  streams: [
    { codec_type: "video", width: 720, height: 1280, avg_frame_rate: "30/1" },
  ],
};
const creator = {
  max_video_post_duration_sec: 60,
  privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
};
describe("publication review and export defaults", () => {
  it("defaults to local export, no default privacy and interactions off", () => {
    const p = publicationInput.parse({ title: "A", assetId: "asset" });
    expect(p.mode).toBe("export");
    expect(p.privacy).toBe("");
    expect(p.disableComment && p.disableDuet && p.disableStitch).toBe(true);
  });
  it("invalidates approval when reviewed content changes", () => {
    const p = { title: "A", assetId: "asset", caption: "first" };
    expect(approvalFingerprint(p)).not.toBe(
      approvalFingerprint({ ...p, caption: "second" }),
    );
    expect(approvalFingerprint(p)).toBe(
      approvalFingerprint({ ...p, status: "approved", approval: {} }),
    );
  });
  it("only accepts a concrete TikTok video permalink", () => {
    expect(
      parseTikTokLink("https://www.tiktok.com/@store/video/123456?lang=en"),
    ).toEqual({
      url: "https://www.tiktok.com/@store/video/123456",
      externalId: "123456",
    });
    expect(() =>
      parseTikTokLink("https://tiktok.com.evil.test/@store/video/123"),
    ).toThrow();
    expect(() => parseTikTokLink("https://www.tiktok.com/@store")).toThrow();
  });
  it("constrains hosted media by exact HTTPS origin and path boundary", () => {
    expect(
      verifiedVideoUrl(
        "https://media.example.com/videos/a.mp4?sig=x",
        "https://media.example.com/videos/",
      ),
    ).toContain("a.mp4");
    for (const u of [
      "http://media.example.com/videos/a.mp4",
      "https://media.example.com.evil.test/videos/a.mp4",
      "https://media.example.com/videos-other/a.mp4",
      "https://user:pass@media.example.com/videos/a.mp4",
    ])
      expect(() =>
        verifiedVideoUrl(u, "https://media.example.com/videos/"),
      ).toThrow();
  });
  it("validates actual duration and creator privacy options", () => {
    expect(
      validateCreatorVideo({ privacy: "SELF_ONLY" }, creator, video).duration,
    ).toBe(30);
    expect(() =>
      validateCreatorVideo(
        { privacy: "SELF_ONLY" },
        { ...creator, max_video_post_duration_sec: 15 },
        video,
      ),
    ).toThrow(/超过/);
    expect(() => validateCreatorVideo({ privacy: "" }, creator, video)).toThrow(
      /明确选择/,
    );
  });
  it("checks actual dimensions and frame rate", () => {
    expect(() =>
      validateCreatorVideo({ privacy: "SELF_ONLY" }, creator, {
        ...video,
        streams: [{ ...video.streams[0], width: 240 }],
      }),
    ).toThrow(/宽高/);
    expect(() =>
      validateCreatorVideo({ privacy: "SELF_ONLY" }, creator, {
        ...video,
        streams: [{ ...video.streams[0], avg_frame_rate: "12/1" }],
      }),
    ).toThrow(/帧率/);
  });
  it("prevents private branded content and permits inbox duration without privacy", () => {
    expect(() =>
      validateCreatorVideo(
        { privacy: "SELF_ONLY", brandContent: true },
        creator,
        video,
      ),
    ).toThrow(/品牌合作/);
    expect(validateCreatorVideo({ mode: "inbox" }, {}, video).maxDuration).toBe(
      600,
    );
  });
});
describe("research automation boundaries", () => {
  it("only permits the five research templates", () => {
    for (const kind of [
      "collect",
      "opportunity_scan",
      "watch_sync",
      "case_collect",
      "metrics_sync",
    ])
      expect(
        automationInput.parse({ name: "A", kind, intervalMinutes: 60 }).kind,
      ).toBe(kind);
    for (const kind of ["video", "enhance", "publish", "raw", "image"])
      expect(() =>
        automationInput.parse({ name: "A", kind, intervalMinutes: 60 }),
      ).toThrow();
  });
  it("rejects invalid intervals and budget bounds", () => {
    expect(() =>
      automationInput.parse({ name: "A", kind: "collect", intervalMinutes: 1 }),
    ).toThrow();
    expect(() =>
      automationInput.parse({
        name: "A",
        kind: "collect",
        intervalMinutes: 60,
        budget: { maxRequests: 0, dailyRequestLimit: 100 },
      }),
    ).toThrow();
  });
});

describe("content effect comparison", () => {
  it("deduplicates production estimate for reused assets and keeps missing metrics unknown", () => {
    const items = [
      {
        id: "a",
        productId: "p",
        assetId: "source",
        metrics: { views: 10, likes: 2 },
        attribution: {
          sourceAssetId: "source",
          estimate: { amount: 2, currency: "USD" },
        },
      },
      {
        id: "b",
        productId: "p",
        assetId: "source",
        metrics: { views: 20 },
        attribution: {
          sourceAssetId: "source",
          estimate: { amount: 2, currency: "USD" },
        },
      },
      {
        id: "c",
        productId: "p",
        assetId: "unknown",
        metrics: null,
        attribution: { estimate: { amount: null } },
      },
    ];
    const [g] = compareContent(items, "product");
    expect(g.views).toBe(30);
    expect(g.comments).toBeNull();
    expect(g.estimatedByCurrency).toEqual({ USD: 2 });
    expect(g.unknownCostCount).toBe(1);
    expect(g.actualCost).toBeNull();
    expect(g.withMetrics).toBe(2);
  });
  it("keeps currencies separate and groups exact script version", () => {
    const items = [
      {
        id: "a",
        assetId: "a",
        attribution: {
          projectId: "project",
          scriptVersion: 1,
          estimate: { amount: 2, currency: "USD" },
        },
      },
      {
        id: "b",
        assetId: "b",
        attribution: {
          projectId: "project",
          scriptVersion: 2,
          estimate: { amount: 3, currency: "CNY" },
        },
      },
    ];
    expect(compareContent(items, "script").map((g) => g.key)).toEqual([
      "project:v1",
      "project:v2",
    ]);
    const [g] = compareContent(items, "project");
    expect(g.estimatedByCurrency).toEqual({ USD: 2, CNY: 3 });
  });
});
