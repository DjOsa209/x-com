import { afterEach, describe, expect, it, vi } from "vitest";
import { createKieClient, kieVideoInput } from "../server/kie.ts";
import { videoPolicy } from "../server/video-plan.ts";

const cfg = { FAL_IMAGE_EDIT_MODEL: "frame" };
const reply = (data: unknown, code = 200) =>
  new Response(JSON.stringify({ code, data }), { status: 200 });
afterEach(() => vi.restoreAllMocks());
describe("Kie API contract", () => {
  it("explicitly selects Fast, preserves seconds/resolution and uses the frames mode", () => {
    const policy = videoPolicy(cfg, {
      videoModelId: "kie-veo-fast",
      resolution: "1080p",
    });
    expect(
      kieVideoInput(
        policy,
        "sell our product",
        6,
        "https://images.example/product.png",
      ),
    ).toEqual({
      model: "veo-3-1",
      input: {
        model: "veo3_fast",
        prompt: "sell our product",
        duration: 6,
        resolution: "1080p",
        aspect_ratio: "9:16",
        image_urls: ["https://images.example/product.png"],
        generation_type: "FIRST_AND_LAST_FRAMES_2_VIDEO",
        enable_fallback: false,
      },
    });
  });
  it("uses Mini first_frame_url and native audio without adding billable video references", () => {
    const policy = videoPolicy(cfg, {
      videoModelId: "kie-seedance-mini",
      resolution: "480p",
      generateAudio: false,
    });
    expect(
      kieVideoInput(policy, "sell", 15, "https://images.example/p.png"),
    ).toEqual({
      model: "bytedance/seedance-2-mini",
      input: {
        prompt: "sell",
        duration: 15,
        resolution: "480p",
        aspect_ratio: "9:16",
        first_frame_url: "https://images.example/p.png",
        generate_audio: false,
      },
    });
  });
  it("submits exactly once and authenticates only against the fixed Kie endpoint", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ taskId: "task-1" }));
    const client = createKieClient("test-secret", transport);
    const body = kieVideoInput(
      videoPolicy(cfg, { videoModelId: "kie-veo-fast" }),
      "sell",
      8,
      "https://images.example/p.png",
    );
    expect(await client.queue.submit("veo-3-1", { input: body })).toEqual({
      request_id: "task-1",
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe("https://api.kie.ai/api/v1/jobs/createTask");
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer test-secret",
    });
    expect(JSON.parse(String(options?.body))).toEqual(body);
  });
  it.each(["timeout", "missing-id", "invalid-json", "server-error"])(
    "does not retry an ambiguous %s submission",
    async (mode) => {
      const transport = vi.fn<typeof fetch>();
      if (mode === "timeout")
        transport.mockRejectedValue(new Error("test-secret"));
      else if (mode === "missing-id") transport.mockResolvedValue(reply({}));
      else if (mode === "invalid-json")
        transport.mockResolvedValue(new Response("bad"));
      else transport.mockResolvedValue(new Response("bad", { status: 503 }));
      try {
        await createKieClient("test-secret", transport).queue.submit(
          "veo-3-1",
          { input: {} },
        );
        throw new Error("should fail");
      } catch (e: any) {
        expect(e.status).toBeGreaterThanOrEqual(500);
        expect(e.message).not.toContain("test-secret");
      }
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("distinguishes an explicit account rejection from an unknown submission", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(reply(null, 402));
    await expect(
      createKieClient("key", transport).queue.submit("model", { input: {} }),
    ).rejects.toMatchObject({ code: "KIE_SUBMIT_REJECTED", status: 402 });
  });
  it.each(["waiting", "queuing", "generating", "success"])(
    "normalizes %s without creating a new job",
    async (state) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(reply({ taskId: "a/b", state }));
      const client = createKieClient("key", transport);
      expect(
        (await client.queue.status("model", { requestId: "a/b" })).status,
      ).toBe(state === "success" ? "COMPLETED" : "IN_PROGRESS");
      expect(transport.mock.calls[0][0]).toBe(
        "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=a%2Fb",
      );
      expect(transport.mock.calls[0][1]?.method).toBe("GET");
    },
  );
  it("treats explicit model failure as failed and unknown states as uncertain", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        reply({ state: "fail", failMsg: "private provider detail" }),
      )
      .mockResolvedValueOnce(reply({ state: "new-state" }));
    const client = createKieClient("key", transport);
    await expect(
      client.queue.status("model", { requestId: "id" }),
    ).rejects.toMatchObject({ code: "PROVIDER_TASK_FAILED" });
    await expect(
      client.queue.status("model", { requestId: "id" }),
    ).rejects.toMatchObject({ status: 502 });
  });
  it("reads Mini results and Veo upgraded output without taking the lower-resolution origin", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        reply({
          state: "success",
          resultJson: JSON.stringify({
            resultUrls: ["https://out.example/mini.mp4"],
          }),
        }),
      )
      .mockResolvedValueOnce(
        reply({
          state: "success",
          resultJson: JSON.stringify({
            data: {
              result_urls: ["https://out.example/1080.mp4"],
              origin_urls: ["https://out.example/720.mp4"],
            },
          }),
        }),
      );
    const client = createKieClient("key", transport);
    expect(
      (
        await client.queue.result("bytedance/seedance-2-mini", {
          requestId: "one",
        })
      ).data.video.url,
    ).toBe("https://out.example/mini.mp4");
    expect(
      (await client.queue.result("veo-3-1", { requestId: "two" })).data.video
        .url,
    ).toBe("https://out.example/1080.mp4");
  });
  it("uploads local images using multipart without exposing a localhost URL", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        reply({ downloadUrl: "https://tempfile.example/p.png", success: true }),
      );
    expect(
      await createKieClient("key", transport).upload(
        Buffer.from("image"),
        "image/png",
      ),
    ).toBe("https://tempfile.example/p.png");
    expect(transport.mock.calls[0][0]).toBe(
      "https://kieai.redpandaai.co/api/file-stream-upload",
    );
    const body = transport.mock.calls[0][1]?.body as FormData;
    expect(body.get("file")).toBeInstanceOf(Blob);
    expect(body.get("uploadPath")).toBe("images/x-ecommerce");
  });
  it("rejects unsupported uploads before sending credentials", async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(
      createKieClient("key", transport).upload(
        Buffer.from("video"),
        "video/mp4",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(transport).not.toHaveBeenCalled();
    expect(() => createKieClient("")).toThrow("API Key");
  });
});
