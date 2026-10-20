import { describe, it, expect } from "vitest";
import {
  calculateQuote,
  quoteRuleSchema,
  type QuoteRule,
} from "../server/quotes.ts";
import {
  parseSubtitles,
  serializeSubtitles,
  validateCues,
  videoEditSchema,
} from "../server/video-edit.ts";
import { videoPolicy, buildRenderPlan } from "../server/video-plan.ts";
import { expandBatch } from "../server/projects.ts";
const mini = () =>
  buildRenderPlan(
    { duration: 5, prompt: "product" },
    {
      scenes: [
        { time: "0-2s", visual: "a" },
        { time: "2-5s", visual: "b" },
      ],
    },
    videoPolicy(
      { FAL_IMAGE_EDIT_MODEL: "frame" },
      {
        videoModelId: "kie-seedance-mini",
        resolution: "480p",
        segmentStrategy: "shots",
      },
    ),
  );
const rate: QuoteRule = {
  modelId: "kie-seedance-mini",
  resolution: "480p",
  unit: "second",
  amount: 0.02,
  currency: "USD",
  source: "Test contract fixture",
  priceCheckedAt: "2026-10-19T00:00:00.000Z",
};
describe("provider quotes", () => {
  it("charges native rounded seconds and variant count, not kept duration", () => {
    const p = mini();
    expect(p.segments.map((s) => s.nativeDuration)).toEqual([4, 4]);
    const q = calculateQuote(p, [rate], 3);
    expect(q.amount).toBe(0.48);
    expect(q.components[0].seconds).toBe(24);
    expect(q.components[0].requests).toBe(6);
  });
  it("never converts unknown rates into zero or sums different currencies", () => {
    expect(calculateQuote(mini(), []).amount).toBeNull();
    const p = mini();
    p.policy.frameSource = "generated";
    const q = calculateQuote(p, [
      rate,
      {
        ...rate,
        modelId: "frame",
        resolution: "*",
        unit: "request",
        currency: "CNY",
        amount: 0.1,
      },
    ]);
    expect(q.status).toBe("multiple_currencies");
    expect(q.amount).toBeNull();
    expect(q.components).toHaveLength(2);
  });
  it("prefers exact resolution over wildcard and requires provenance", () => {
    expect(
      calculateQuote(mini(), [{ ...rate, resolution: "*", amount: 1 }, rate])
        .amount,
    ).toBe(0.16);
    expect(() => quoteRuleSchema.parse({ ...rate, source: "" })).toThrow();
    expect(() => quoteRuleSchema.parse({ ...rate, amount: -1 })).toThrow();
  });
});
describe("caption contracts", () => {
  it("roundtrips multiline Unicode captions and BOM/CRLF SRT", () => {
    const cues = [
      { start: 0, end: 1.125, text: "你好\nProduct demo" },
      { start: 1.2, end: 2, text: "第二镜" },
    ];
    expect(
      parseSubtitles(
        "\uFEFF" + serializeSubtitles(cues).replace(/\n/g, "\r\n"),
      ),
    ).toEqual(cues);
    expect(parseSubtitles(serializeSubtitles(cues, "vtt"))).toEqual(cues);
  });
  it("rejects overlaps, bad timecodes, over-duration cues, and injected timeline text", () => {
    expect(() =>
      parseSubtitles("1\n00:62:00,000 --> 00:62:01,000\na"),
    ).toThrow();
    expect(() =>
      validateCues([
        { start: 0, end: 2, text: "a" },
        { start: 1, end: 3, text: "b" },
      ]),
    ).toThrow();
    expect(() => validateCues([{ start: 0, end: 4, text: "a" }], 3)).toThrow();
    expect(() =>
      parseSubtitles("1\n00:00:00,000 --> 00:00:01,000 evil\na"),
    ).toThrow();
  });
  it("applies local audio defaults and rejects unsafe range/empty cue", () => {
    expect(videoEditSchema.parse({ assetId: "a" }).musicVolume).toBe(0.15);
    expect(() =>
      videoEditSchema.parse({ assetId: "a", musicVolume: 5 }),
    ).toThrow();
    expect(() =>
      videoEditSchema.parse({
        assetId: "a",
        captions: [{ start: 0, end: 1, text: " " }],
      }),
    ).toThrow();
  });
});
describe("explicit batch planning", () => {
  const batch = {
    name: "Batch",
    products: [
      { name: "A", prompt: "Product A", assetIds: ["a"] },
      { name: "B", prompt: "Product B", assetIds: ["b"] },
    ],
    languages: ["English", "Español"],
    variants: 3,
    defaults: { duration: 30 },
    dedupeKey: "test",
  };
  it("expands product-language pairs without silently multiplying variants", () => {
    const items = expandBatch(batch);
    expect(items).toHaveLength(4);
    expect(items.map((x) => x.input.requestedVariants)).toEqual([3, 3, 3, 3]);
    expect(items[0].input.assetIds).toEqual(["a"]);
  });
  it("rejects duplicate language, internal field injection and oversized batches", () => {
    expect(() =>
      expandBatch({ ...batch, languages: ["English", "English"] }),
    ).toThrow();
    expect(() =>
      expandBatch({ ...batch, defaults: { _localComposeOnly: true } }),
    ).toThrow();
    expect(() =>
      expandBatch({ ...batch, products: Array(21).fill(batch.products[0]) }),
    ).toThrow();
  });
});
