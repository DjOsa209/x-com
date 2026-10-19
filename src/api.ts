export type Doc = Record<string, any>;
export class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const r = await fetch("/api" + path, {
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const data = await r.json().catch(() => ({ error: "服务返回了无效响应" }));
  if (!r.ok)
    throw new ApiError(
      data.error || data.message || `请求失败 (${r.status})`,
      data.code,
      r.status,
    );
  return data;
}
export const post = (path: string, body: unknown = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
export async function upload(file: File) {
  const form = new FormData();
  form.append("file", file);
  return api<Doc>("/uploads", { method: "POST", body: form });
}
export const newJob = (kind: string, input: Doc, runAt?: string) =>
  post("/jobs", {
    kind,
    input,
    dedupeKey: crypto.randomUUID(),
    ...(runAt ? { runAt } : {}),
  });
export const save = (kind: string, body: Doc) => post("/records/" + kind, body);
export const del = (kind: string, id: string) =>
  api(`/records/${kind}/${id}`, { method: "DELETE" });
export const number = (v: any) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("zh-CN", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(Number(v));
export const date = (v: any) =>
  v
    ? new Date(v).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export const stateNames: Doc = {
  queued: "排队中",
  scheduled: "已定时",
  running: "执行中",
  processing: "生成 / 处理中",
  completed: "已完成",
  failed: "失败",
  review: "待核对",
  cancelled: "已取消",
  inbox: "已送达草稿箱",
};
export const kindNames: Doc = {
  script: "销售脚本",
  analysis: "视频分析",
  replicate: "爆款复刻脚本",
  video: "商品转视频",
  image: "电商图片",
  enhance: "视频超分",
  download: "视频下载",
  insights: "评论洞察",
  prompt: "提示词提取",
  publish: "TikTok 发布",
  research: "商品研究",
};
