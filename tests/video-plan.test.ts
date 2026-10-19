import { describe, it, expect } from "vitest";
import {
  buildRenderPlan,
  videoPolicy,
  parseModels,
  defaultVideoModels,
  planFingerprint,
} from "../server/video-plan.ts";
const cfg = {
  VIDEO_MODELS_JSON: JSON.stringify(defaultVideoModels),
  FAL_IMAGE_EDIT_MODEL: "frame-endpoint",
};
const board = {
  shootingPrompt: "demo",
  scenes: [
    { time: "0-3s", visual: "hook", voiceover: "hello" },
    { time: "3-7s", visual: "demo" },
    { time: "7-12s", visual: "offer" },
  ],
};
const plan = (strategy: string, seconds = 8) =>
  buildRenderPlan(
    { duration: 12, prompt: "own product" },
    board,
    videoPolicy(cfg, { segmentStrategy: strategy, segmentSeconds: seconds }),
  );
describe("video segment planning", () => {
  it("packs complete shots and rounds native durations up", () => {
    const p = plan("balanced");
    expect(p.segments.map((s) => [s.start, s.end])).toEqual([
      [0, 7],
      [7, 12],
    ]);
    expect(p.providerCalls).toBe(4);
  });
  it("keeps shots separate and only splits oversized shots", () => {
    expect(plan("shots", 4).segments.map((s) => s.duration)).toEqual([
      3, 4, 4, 1,
    ]);
    expect(plan("shots", 4).segments.at(-1)?.nativeDuration).toBe(3);
  });
  it("uses fixed boundaries and warns about crossed shots", () => {
    const p = plan("fixed", 5);
    expect(p.segments.map((s) => s.duration)).toEqual([5, 5, 2]);
    expect(p.warnings.some((w) => w.includes("口播"))).toBe(true);
  });
  it("supports a single native request and rejects excessive duration", () => {
    expect(plan("single").segments).toHaveLength(1);
    expect(() =>
      buildRenderPlan(
        { duration: 20 },
        { script: "demo" },
        videoPolicy(cfg, { segmentStrategy: "single" }),
      ),
    ).toThrow("15 秒上限");
  });
  it("rejects gaps, overlaps and invalid total duration", () => {
    for (const times of [
      ["0-3s", "4-7s", "7-12s"],
      ["0-4s", "3-7s", "7-12s"],
      ["0-3s", "3-7s", "7-11s"],
    ])
      expect(() =>
        buildRenderPlan(
          { duration: 12 },
          { scenes: board.scenes.map((s, i) => ({ ...s, time: times[i] })) },
          videoPolicy(cfg),
        ),
      ).toThrow();
  });
  it("handles colon timestamps and untimed shots explicitly", () => {
    expect(
      buildRenderPlan(
        { duration: 12 },
        { scenes: [{ time: "00:00–00:12", visual: "demo" }] },
        videoPolicy(cfg),
      ).duration,
    ).toBe(12);
    const p = buildRenderPlan(
      { duration: 10 },
      { scenes: [{ visual: "a" }, { visual: "b" }] },
      videoPolicy(cfg),
    );
    expect(p.shots[0].end).toBe(5);
    expect(p.warnings[0]).toContain("等分");
  });
  it("rejects partial timing and segment overflow before any calls", () => {
    expect(() =>
      buildRenderPlan(
        { duration: 10 },
        { scenes: [{ time: "0-5s", visual: "a" }, { visual: "b" }] },
        videoPolicy(cfg),
      ),
    ).toThrow("每个镜头");
    expect(() =>
      buildRenderPlan({ duration: 12 }, board, {
        ...videoPolicy(cfg),
        maxSegments: 1,
      }),
    ).toThrow("超过上限");
  });
  it("rejects unknown models and incompatible adapter capabilities", () => {
    expect(() => videoPolicy(cfg, { videoModelId: "missing" })).toThrow(
      "已配置",
    );
    expect(() =>
      parseModels(
        JSON.stringify([{ ...defaultVideoModels[0], durations: [20] }]),
      ),
    ).toThrow("不兼容");
    expect(() => videoPolicy(cfg, { resolution: "4k" })).toThrow("分辨率");
  });
  it("pins independent model and policy snapshots and fingerprints edits", () => {
    const p = plan("balanced");
    const before = planFingerprint(p);
    const updated = plan("fixed");
    expect(updated.policy.strategy).toBe("fixed");
    expect(p.policy.strategy).toBe("balanced");
    expect(planFingerprint(updated)).not.toBe(before);
    expect(p.policy.imageModel).toBe("frame-endpoint");
  });
});
