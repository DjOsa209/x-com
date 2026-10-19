import { beforeEach, describe, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ row: {} as any }));
vi.mock("../server/db.ts", () => ({
  rows: vi.fn(async () => []),
  updateJob: vi.fn(async (_id: string, p: any) => {
    Object.assign(state.row, JSON.parse(JSON.stringify(p)));
  }),
  parse: (v: any) => (typeof v === "string" ? JSON.parse(v) : v),
}));
vi.mock("../server/config.ts", () => ({ config: vi.fn(async () => ({})) }));
vi.mock("../server/providers.ts", () => ({
  falInput: vi.fn(),
  falClient: vi.fn(),
}));
vi.mock("../server/media.ts", () => ({
  assetFile: vi.fn(),
  fetchMedia: vi.fn(),
  saveMedia: vi.fn(),
}));
import {
  initializePipeline,
  advancePipeline,
  retryPipelineState,
  acknowledgePipelineFailure,
  cancelPipeline,
  type PipelineDependencies,
} from "../server/video-pipeline.ts";
import { videoPolicy } from "../server/video-plan.ts";
import { AppError } from "../server/errors.ts";
let submits: any[],
  mode: string,
  failAt: number,
  concatFail: boolean,
  saved: number,
  deps: PipelineDependencies;
beforeEach(async () => {
  state.row = {
    id: "pipeline",
    input: { prompt: "product", duration: 6, assetIds: ["image"] },
    status: "running",
  };
  submits = [];
  mode = "COMPLETED";
  failAt = 0;
  concatFail = false;
  saved = 0;
  deps = {
    falClient: async () =>
      ({
        queue: {
          submit: async (model: string) => {
            submits.push(model);
            if (failAt === submits.length) throw new Error("timeout");
            return { request_id: String(submits.length) };
          },
          status: async () => ({ status: mode }),
          result: async (model: string) => ({
            data:
              model === "frame"
                ? { images: [{ url: "frame-url" }] }
                : { video: { url: "video-url" } },
          }),
        },
      }) as any,
    falInput: async () => ({
      model: "video",
      payload: {},
      frame: { model: "frame", payload: {} },
    }),
    fetchMedia: async () => ({
      bytes: Buffer.from("fixture"),
      mime: "video/mp4",
    }),
    saveMedia: async () => ({
      id: "asset-" + ++saved,
      url: "/media/fixture.mp4",
    }),
    assetFile: async () => ({ path: "/fixture.mp4", asset: {} }),
    composeVideo: async () => {
      if (concatFail) throw new Error("disk full");
      return {
        bytes: Buffer.from("composed"),
        duration: 6,
        width: 720,
        height: 1280,
      };
    },
  } as PipelineDependencies;
  const policy = videoPolicy(
    { FAL_IMAGE_EDIT_MODEL: "frame" },
    { segmentStrategy: "fixed", segmentSeconds: 3 },
  );
  await initializePipeline(
    "pipeline",
    { ...state.row.input, _videoPolicy: policy },
    {
      scenes: [
        { time: "0-3s", visual: "a" },
        { time: "3-6s", visual: "b" },
      ],
    },
  );
});
const step = () => advancePipeline(state.row, deps);
async function finish() {
  for (let i = 0; i < 20 && state.row.status === "processing"; i++)
    await step();
}
describe("durable segment execution", () => {
  async function useKie(frameSource = "product") {
    const policy = videoPolicy(
      { FAL_IMAGE_EDIT_MODEL: "frame" },
      {
        videoModelId: "kie-seedance-mini",
        segmentStrategy: "fixed",
        segmentSeconds: 3,
        frameSource,
      },
    );
    await initializePipeline(
      "pipeline",
      { ...state.row.input, _videoPolicy: policy },
      { scenes: [{ time: "0-6s", visual: "sell" }] },
    );
    deps.kieAsset = vi.fn(async () => "https://images.example/product.png");
    deps.kieClient = async () =>
      ({
        queue: {
          submit: async (model: string) => {
            submits.push(model);
            if (failAt === submits.length) throw new Error("timeout");
            return { request_id: String(submits.length) };
          },
          status: async () => ({ status: mode }),
          result: async () => ({
            data: { video: { url: "https://video.example/out.mp4" } },
          }),
        },
      }) as any;
  }
  it("runs Kie product frames through composition without touching fal", async () => {
    await useKie();
    deps.falClient = async () => {
      throw new Error("fal must not be used");
    };
    await finish();
    expect(state.row.status).toBe("completed");
    expect(submits).toEqual([
      "bytedance/seedance-2-mini",
      "bytedance/seedance-2-mini",
    ]);
    expect(deps.kieAsset).toHaveBeenCalledTimes(2);
  });
  it("uses fal only for generated frames and Kie for the video stage", async () => {
    await useKie("generated");
    const original = deps.kieClient!;
    deps.kieClient = vi.fn(original);
    const falInput = deps.falInput;
    deps.falInput = async (...args) => ({
      ...(await falInput(...args)),
      frame: { model: "frame", payload: {} },
      model: "bytedance/seedance-2-mini",
    });
    // The fixture's fal frame result must be an HTTPS URL, just like the live storage result.
    const fal = await deps.falClient();
    const result = fal.queue.result;
    fal.queue.result = async (model: any, options: any) => {
      const r: any = await result(model, options);
      if (r.data.images)
        r.data.images[0].url = "https://images.example/generated.png";
      return r;
    };
    deps.falClient = async () => fal;
    await finish();
    expect(state.row.status).toBe("completed");
    expect(submits).toEqual([
      "frame",
      "bytedance/seedance-2-mini",
      "frame",
      "bytedance/seedance-2-mini",
    ]);
    expect(deps.kieAsset).not.toHaveBeenCalled();
  });
  it("never resubmits an ambiguous Kie charge and requires audited resolution", async () => {
    await useKie();
    await step();
    failAt = 1;
    await step();
    expect(state.row.status).toBe("review");
    await expect(step()).rejects.toThrow("不会重复提交");
    expect(submits).toHaveLength(1);
    expect(() => retryPipelineState(state.row.provider)).toThrow();
  });
  it("stops new Kie tasks on cancel and still settles the already submitted task", async () => {
    await useKie();
    await step();
    await step();
    await cancelPipeline(state.row);
    await step();
    await step();
    expect(state.row.status).toBe("cancelled");
    expect(submits).toHaveLength(1);
    expect(state.row.provider.segments[0].status).toBe("completed");
  });
  it("refreshes expired product uploads before a new paid submission", async () => {
    await useKie();
    await step();
    state.row.provider.segments[0].productUploadedAt = 1;
    await step();
    expect(deps.kieAsset).toHaveBeenCalledTimes(2);
    expect(submits).toHaveLength(1);
  });
  it("submits each stage once and only completes after composition", async () => {
    await finish();
    expect(submits).toEqual(["frame", "video", "frame", "video"]);
    expect(state.row.status).toBe("completed");
    expect(state.row.result.asset.id).toBe("asset-3");
    expect(state.row.provider.concatStatus).toBe("completed");
  });
  it("does not resend an ambiguous initial submission after restart", async () => {
    failAt = 1;
    await step();
    expect(state.row.status).toBe("review");
    await expect(step()).rejects.toThrow("不会重复提交");
    expect(submits).toHaveLength(1);
  });
  it("does not resend an ambiguous video submission", async () => {
    await step();
    await step();
    failAt = 2;
    await step();
    expect(state.row.provider.segments[0].status).toBe("review");
    await expect(step()).rejects.toThrow("不会重复提交");
    expect(submits).toHaveLength(2);
  });
  it("keeps a polling 404 uncertain and resumes the same ID", async () => {
    await step();
    const fal = await deps.falClient();
    deps.falClient = async () =>
      ({
        ...fal,
        queue: {
          ...fal.queue,
          status: async () => {
            throw new AppError(404, "not found");
          },
        },
      }) as any;
    await step();
    expect(state.row.status).toBe("review");
    expect(state.row.provider.segments[0].resumeStage).toBe("frame");
    expect(() => retryPipelineState(state.row.provider)).toThrow("不明确");
    deps.falClient = async () => fal;
    await step();
    expect(submits).toHaveLength(1);
    expect(state.row.provider.segments[0].status).toBe("ready_video");
  });
  it("treats a confirmed model result rejection as failed, not a polling error", async () => {
    await step();
    const fal = await deps.falClient();
    deps.falClient = async () =>
      ({
        ...fal,
        queue: {
          ...fal.queue,
          result: async () => {
            throw new AppError(422, "model rejected");
          },
        },
      }) as any;
    await step();
    expect(state.row.status).toBe("failed");
    expect(retryPipelineState(state.row.provider).segments[0].status).toBe(
      "queued",
    );
  });
  it("makes an uncertain segment retryable only after explicit audited resolution", async () => {
    failAt = 1;
    await step();
    expect(() => retryPipelineState(state.row.provider)).toThrow();
    const p = acknowledgePipelineFailure(
      state.row.provider,
      "供应商后台已核对失败，人工处理记录",
    );
    expect(retryPipelineState(p).segments[0].status).toBe("queued");
    expect(state.row.provider.segments[0].status).toBe("review");
  });
  it("only retries composition when all clips are already saved", async () => {
    concatFail = true;
    await finish();
    expect(state.row.status).toBe("failed");
    expect(state.row.provider.concatStatus).toBe("failed");
    state.row.provider = retryPipelineState(state.row.provider);
    state.row.status = "processing";
    concatFail = false;
    await finish();
    expect(state.row.status).toBe("completed");
    expect(submits).toHaveLength(4);
  });
  it("regenerates only the short clip identified during composition", async () => {
    deps.composeVideo = async () => {
      throw new AppError(409, "片段太短", "SEGMENT_TOO_SHORT", {
        segmentIndex: 1,
      });
    };
    await finish();
    expect(state.row.provider.segments.map((s: any) => s.status)).toEqual([
      "completed",
      "failed",
    ]);
    state.row.provider = retryPipelineState(state.row.provider);
    state.row.status = "processing";
    deps.composeVideo = async () => ({
      bytes: Buffer.from("complete"),
      duration: 6,
      width: 720,
      height: 1280,
    });
    await finish();
    expect(state.row.status).toBe("completed");
    expect(submits).toEqual(["frame", "video", "frame", "video", "video"]);
  });
  it("reuses successful clips on a definite later failure", async () => {
    for (let i = 0; i < 5; i++) await step();
    expect(state.row.provider.segments[0].status).toBe("completed");
    mode = "FAILED";
    await step();
    expect(state.row.status).toBe("failed");
    const p = retryPipelineState(state.row.provider);
    expect(p.segments[0].status).toBe("completed");
    expect(p.segments[1].status).toBe("queued");
    mode = "COMPLETED";
    state.row.provider = p;
    state.row.status = "processing";
    await finish();
    expect(state.row.status).toBe("completed");
    expect(submits).toHaveLength(5);
  });
  it("honors cancellation before starting another segment", async () => {
    for (let i = 0; i < 4; i++) await step();
    state.row.provider.cancelRequested = true;
    await step();
    expect(state.row.status).toBe("cancelled");
    expect(submits).toHaveLength(2);
    expect(state.row.provider.segments[1].status).toBe("cancelled");
  });
});
