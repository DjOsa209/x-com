import { describe, it, expect } from "vitest";
import { nextParams } from "../src/pagination";
describe("endpoint-specific pagination", () => {
  it("advances history by page, not cursor", () => {
    expect(
      nextParams(
        "/echotik/product/ranklist",
        { page_num: 1, page_size: 10 },
        { items: Array(10) },
      ),
    ).toEqual({ page_num: 2, page_size: 10 });
    expect(
      nextParams(
        "/echotik/product/ranklist",
        { page_num: 1, page_size: 10 },
        { items: Array(2) },
      ),
    ).toBeNull();
  });
  it("uses video comments opaque cursor", () => {
    expect(
      nextParams(
        "/realtime/video/comments",
        { offset: "0" },
        { data: { has_more: 1, cursor: "1760000123456" } },
      ),
    ).toEqual({ offset: "1760000123456" });
  });
  it("uses product reviews next_cursor, preserving offset from one", () => {
    expect(
      nextParams(
        "/realtime/product/comment",
        { offset: "1" },
        { data: { has_more: true, next_cursor: "encoded-next" } },
      ),
    ).toEqual({ offset: "encoded-next" });
  });
  it("stops when the cursor repeats or has_more is false", () => {
    expect(
      nextParams(
        "/realtime/video/comments",
        { offset: "123" },
        { data: { has_more: 1, cursor: "123" } },
      ),
    ).toBeNull();
    expect(
      nextParams(
        "/realtime/video/comments",
        { offset: "123" },
        { data: { has_more: 0, cursor: "456" } },
      ),
    ).toBeNull();
  });
});
