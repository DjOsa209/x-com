import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  records: new Map<string, any>(),
  submits: [] as any[],
  next: 0,
  failSubmit: false,
  status: "COMPLETED",
  publishStatus: "PROCESSING_UPLOAD",
}));
vi.mock("../server/db.ts", () => ({
  rows: vi.fn(async (sql: string, values: any[] = []) => {
    if (sql.includes("dedupe_key"))
      return [...state.records.values()].filter(
        (r) => r.dedupe_key === values[0],
      );
    if (sql.includes("status='processing'"))
      return [...state.records.values()].filter(
        (r) => r.status === "processing",
      );
    if (sql.includes("status IN ('queued','scheduled')"))
      return [...state.records.values()]
        .filter((r) => r.status === "queued" || r.status === "scheduled")
        .slice(0, 1);
    return [];
  }),
  execute: vi.fn(async (sql: string, v: any[] = []) => {
    if (sql.startsWith("INSERT INTO jobs")) {
      state.records.set(v[0], {
        id: v[0],
        kind: v[1],
        input: JSON.parse(v[2]),
        dedupe_key: v[3],
        run_at: v[4],
        status: v[5],
      });
      return { affectedRows: 1 };
    }
    if (sql.includes("SET status='cancelled'")) {
      const r = state.records.get(v[0]);
      if (!r || !["queued", "scheduled"].includes(r.status))
        return { affectedRows: 0 };
      r.status = "cancelled";
      return { affectedRows: 1 };
    }
    if (sql.includes("SET status='running'")) {
      const r = state.records.get(v[0]);
      if (r && ["queued", "scheduled"].includes(r.status)) {
        r.status = "running";
        return { affectedRows: 1 };
      }
      return { affectedRows: 0 };
    }
    if (sql.includes("WHERE status='running'")) {
      for (const r of state.records.values())
        if (r.status === "running") {
          r.status = "review";
          r.error = "interrupted";
        }
    }
    return { affectedRows: 1 };
  }),
  jobGet: vi.fn(async (id: string) => state.records.get(id)),
  updateJob: vi.fn(async (id: string, patch: any) =>
    Object.assign(state.records.get(id), patch),
  ),
  job: (r: any) => ({ ...r }),
  parse: (r: any) => (typeof r === "string" ? JSON.parse(r) : r),
  put: vi.fn(async (_kind: string, body: any) => ({
    id: "prompt-record",
    ...body,
  })),
}));
vi.mock("../server/config.ts", () => ({
  config: vi.fn(async () => ({
    GEMINI_API_KEY: "test-only",
    FAL_KEY: "test-only",
    ECHOTIK_USERNAME: "test-only",
    TIKTOK_CLIENT_KEY: "test-only",
  })),
}));
vi.mock("../server/providers.ts", () => ({
  aiJson: vi.fn(async () => ({
    title: "Adapted product video",
    shootingPrompt: "Use our actual product in a new scene",
    scenes: [],
  })),
  falInput: vi.fn(async () => ({
    model: "video-model",
    payload: { prompt: "video", start_image_url: "uploaded-product" },
    frame: {
      model: "frame-model",
      payload: { prompt: "frame", image_urls: ["uploaded-product"] },
    },
  })),
  falClient: vi.fn(async () => ({
    queue: {
      submit: vi.fn(async (model: string, options: any) => {
        state.submits.push({ model, input: options.input });
        if (state.failSubmit) throw new Error("ambiguous network timeout");
        return { request_id: "request-" + ++state.next };
      }),
      status: vi.fn(async () => ({ status: state.status })),
      result: vi.fn(async (_model: string, options: any) => ({
        data:
          options.requestId === "request-1"
            ? { images: [{ url: "https://cdn.example/frame.png" }] }
            : { video: { url: "https://cdn.example/output.mp4" } },
      })),
      cancel: vi.fn(async () => ({ status: "CANCELLATION_REQUESTED" })),
    },
  })),
}));
vi.mock("../server/video-compose.ts", () => ({
  mediaToolsReady: vi.fn(async () => {}),
  composeVideo: vi.fn(async () => ({
    bytes: Buffer.from("composed"),
    duration: 5,
    width: 720,
    height: 1280,
  })),
}));
vi.mock("../server/media.ts", () => ({
  assetFile: vi.fn(async () => ({ path: "/fixture.mp4" })),
  fetchMedia: vi.fn(async () => ({
    bytes: Buffer.from("contract-fixture"),
    mime: "video/mp4",
  })),
  resolveVideo: vi.fn(async () => ({ url: "https://cdn.example/source.mp4" })),
  saveMedia: vi.fn(async () => ({
    id: "generated-asset",
    type: "video",
    url: "/media/output.mp4",
  })),
}));
vi.mock("../server/echotik.ts", () => ({
  echoQuery: vi.fn(),
  extractItems: vi.fn(),
}));
vi.mock("../server/tiktok.ts", () => ({
  creatorInfo: vi.fn(),
  initializePost: vi.fn(async () => ({ init: { publish_id: "publish-1" } })),
  transferPost: vi.fn(async () => {}),
  postStatus: vi.fn(async () => ({ status: state.publishStatus })),
}));
vi.mock("../server/locks.ts", () => ({
  withJobLock: vi.fn(async (_id: string, action: () => Promise<any>) =>
    action(),
  ),
}));
vi.mock("../server/credits.ts", () => ({
  reserveCredits: vi.fn(async () => {}),
  finalizeCredits: vi.fn(async () => {}),
}));
import { falInput } from "../server/providers.ts";
import { AppError } from "../server/errors.ts";
import {
  createJob,
  tick,
  cancelJob,
  refreshJob,
  recoverJobs,
} from "../server/jobs.ts";
beforeEach(() => {
  state.records.clear();
  state.submits = [];
  state.next = 0;
  state.failSubmit = false;
  state.status = "COMPLETED";
  state.publishStatus = "PROCESSING_UPLOAD";
  vi.clearAllMocks();
});
describe("durable generation transitions", () => {
  it("records an ambiguous first submission without automatically resubmitting", async () => {
    state.failSubmit = true;
    const j = await createJob(
      "video",
      { prompt: "coffee", assetIds: ["product-image"], duration: 5 },
      "ambiguous-first",
    );
    await tick();
    await tick();
    expect(state.records.get(j.id).status).toBe("review");
    expect(state.records.get(j.id).provider.segments[0].status).toBe("review");
    await expect(refreshJob(j.id)).rejects.toThrow("没有请求 ID");
    expect(state.submits).toHaveLength(1);
  });
  it("fails local validation before a billable request instead of freezing it for review", async () => {
    vi.mocked(falInput).mockRejectedValueOnce(new AppError(404, "素材不存在"));
    const j = await createJob(
      "image",
      { prompt: "coffee" },
      "missing-local-asset",
    );
    await tick();
    expect(state.records.get(j.id).status).toBe("failed");
    expect(state.submits).toHaveLength(0);
  });

  it("deduplicates a repeated client submission", async () => {
    const a = await createJob(
      "script",
      { prompt: "coffee" },
      "same-client-request",
    );
    const b = await createJob(
      "script",
      { prompt: "coffee" },
      "same-client-request",
    );
    expect(a.id).toBe(b.id);
    expect(state.records.size).toBe(1);
  });
  it("keeps a two-stage product video pending until a video output exists", async () => {
    const j = await createJob(
      "video",
      {
        prompt: "coffee",
        assetIds: ["product-image"],
        duration: 5,
        aspect: "9:16",
      },
      "video-request",
    );
    await tick(); // durable plan
    await tick(); // submit frame
    let r = state.records.get(j.id);
    expect(r.status).toBe("processing");
    expect(r.provider.segments[0].status).toBe("frame");
    expect(r.result.asset).toBeUndefined();
    await tick(); // frame saved
    await tick(); // submit video
    expect(state.submits[1].input.start_image_url).toBe(
      "https://cdn.example/frame.png",
    );
    await tick(); // video clip saved; not yet a completed video
    expect(r.status).toBe("processing");
    expect(r.result.asset).toBeUndefined();
    await tick(); // compose
    expect(r.status).toBe("completed");
    expect(r.result.asset.id).toBe("generated-asset");
    expect(state.submits).toHaveLength(2);
  });
  it("retains source analysis through one-click replication", async () => {
    const j = await createJob(
      "replicate",
      {
        prompt: "our product",
        assetIds: ["product-image"],
        duration: 5,
        videoAssetId: "reference-video",
      },
      "replicate-request",
    );
    await tick();
    expect(state.records.get(j.id).result.shootingPrompt).toContain(
      "actual product",
    );
    for (let i = 0; i < 5; i++) await tick();
    expect(state.records.get(j.id).result.shootingPrompt).toContain(
      "actual product",
    );
    expect(state.records.get(j.id).result.asset.id).toBe("generated-asset");
  });
  it("does not automatically resubmit an ambiguous second-stage request", async () => {
    const j = await createJob(
      "video",
      { prompt: "coffee", assetIds: ["product-image"], duration: 5 },
      "ambiguous-request",
    );
    await tick();
    await tick();
    await tick();
    state.failSubmit = true;
    await tick();
    const r = state.records.get(j.id);
    expect(r.status).toBe("review");
    expect(r.provider.segments[0].status).toBe("review");
    expect(state.submits).toHaveLength(2);
    await expect(refreshJob(j.id)).rejects.toThrow("不会重复提交");
    expect(state.submits).toHaveLength(2);
  });
  it("does not call a running model complete", async () => {
    const j = await createJob("image", { prompt: "coffee" }, "pending-request");
    await tick();
    state.status = "IN_PROGRESS";
    await tick();
    expect(state.records.get(j.id).status).toBe("processing");
  });
  it("cancels a queued task without submitting it", async () => {
    const j = await createJob("image", { prompt: "coffee" }, "cancel-request");
    await cancelJob(j.id);
    await tick();
    expect(state.records.get(j.id).status).toBe("cancelled");
    expect(state.submits).toHaveLength(0);
  });
  it("marks interrupted submissions for review at restart", async () => {
    state.records.set("interrupted", { id: "interrupted", status: "running" });
    await recoverJobs();
    expect(state.records.get("interrupted").status).toBe("review");
    expect(state.submits).toHaveLength(0);
  });
  it("rejects invalid scheduling windows", async () => {
    await expect(
      createJob("script", { prompt: "coffee" }, "past-request", "2020-01-01"),
    ).rejects.toThrow("未来 30 天");
    expect(state.records.size).toBe(0);
  });
});
describe("publishing completion means actual platform status", () => {
  it("does not call a successful upload a completed publication", async () => {
    const j = await createJob(
      "publish",
      { accountId: "account", assetId: "video", consent: true },
      "publish-request",
    );
    await tick();
    expect(state.records.get(j.id).status).toBe("processing");
    await tick();
    expect(state.records.get(j.id).status).toBe("processing");
    state.publishStatus = "PUBLISH_COMPLETE";
    await tick();
    expect(state.records.get(j.id).status).toBe("completed");
  });
  it("keeps inbox delivery distinct from publication", async () => {
    const j = await createJob(
      "publish",
      { accountId: "account", assetId: "video", consent: true, mode: "inbox" },
      "inbox-request",
    );
    await tick();
    state.publishStatus = "SEND_TO_USER_INBOX";
    await tick();
    expect(state.records.get(j.id).status).toBe("inbox");
  });
});
