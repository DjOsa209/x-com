import { describe, it, expect, vi } from "vitest";
import { subtitleFont, subtitleAss } from "../server/subtitle-font.ts";
import { zipEntries, crc32 } from "../server/archive.ts";
import { validateAiResult } from "../server/ai-results.ts";
import { validMediaHeader } from "../server/media-types.ts";
describe("foundation file and AI boundaries", () => {
  it("uses output dimensions and explicit line breaks for long CJK captions", () => {
    const ass = subtitleAss(
      [
        {
          start: 0,
          end: 3,
          text: "这是一段很长的中文产品演示字幕用于验证自动换行且不会超出画面边界",
        },
      ],
      "Heiti SC",
      32,
      360,
      640,
    );
    expect(ass).toContain("PlayResX: 360");
    expect(ass).toContain("PlayResY: 640");
    expect(ass).toContain("Heiti SC,16,");
    expect(ass).toContain("\\N");
  });
  it("fails explicitly instead of burning missing Chinese glyphs", async () => {
    vi.stubEnv(
      "SUBTITLE_FONT_FILE",
      "/nonexistent/x-ecommerce-font-fixture.ttc",
    );
    try {
      await expect(subtitleFont("中文字体检查")).rejects.toMatchObject({
        code: "SUBTITLE_FONT_MISSING",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("builds UTF-8 ZIP entries with verifiable CRC and central directory", () => {
    const data = Buffer.from("商品证据");
    const zip = zipEntries([{ name: "证据.txt", data }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(6) & 0x800).toBe(0x800);
    expect(zip.readUInt32LE(14)).toBe(crc32(data));
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 12)).toBe(1);
  });
  it("rejects unsafe archive paths and duplicate names", () => {
    expect(() =>
      zipEntries([{ name: "../secret", data: Buffer.alloc(0) }]),
    ).toThrow();
    expect(() =>
      zipEntries([
        { name: "same", data: Buffer.alloc(0) },
        { name: "same", data: Buffer.alloc(0) },
      ]),
    ).toThrow();
  });
  it("rejects missing or invalid AI scenes, retains genuine source metadata", () => {
    expect(() =>
      validateAiResult("analysis", { summary: "fluent but no evidence" }),
    ).toThrow();
    expect(() =>
      validateAiResult("analysis", { scenes: [{ visual: "" }] }),
    ).toThrow();
    expect(
      validateAiResult("analysis", {
        scenes: [{ visual: "Lid opens", time: "0-3s" }],
        sourceUrl: "https://example.org",
      }).sourceUrl,
    ).toBe("https://example.org");
  });
  it("requires an explicit insights summary and pain point evidence", () => {
    expect(() => validateAiResult("insights", { painPoints: [] })).toThrow();
    expect(
      validateAiResult("insights", {
        summary: "No repeated issue",
        painPoints: [],
      }).painPoints,
    ).toEqual([]);
  });
  it("rejects mislabeled audio bytes before probing", () => {
    expect(validMediaHeader(Buffer.from("not an mp3"), "audio/mpeg")).toBe(
      false,
    );
    expect(validMediaHeader(Buffer.from("RIFFxxxxWAVEfmt "), "audio/wav")).toBe(
      true,
    );
  });
});
