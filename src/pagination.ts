import type { Doc } from "./api";
export function nextParams(
  path: string,
  params: Doc,
  response: Doc,
): Doc | null {
  if (path.startsWith("/echotik/") && params.page_num !== undefined) {
    return response.items?.length >= Number(params.page_size || 10)
      ? { ...params, page_num: Number(params.page_num) + 1 }
      : null;
  }
  function cursor(data: any): Doc | null {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (
      data.has_more === true ||
      data.has_more === 1 ||
      data.has_more === "1"
    ) {
      const next =
        data.next_cursor ?? data.cursor ?? data.max_cursor ?? data.next_offset;
      if (next !== undefined && String(next) !== String(params.offset ?? "0"))
        return { ...params, offset: String(next) };
    }
    for (const k of ["data", "body", "pagination", "result"]) {
      const n = cursor(data[k]);
      if (n) return n;
    }
    return null;
  }
  return cursor(response.data);
}
