import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Search,
  Filter,
  ChevronDown,
  ArrowUpRight,
  ArrowRight,
  Heart,
  RefreshCw,
  Plus,
  Trash2,
  Play,
  Copy,
  Code2,
  Download,
  Compass,
  Link2,
  MessageSquare,
  ShoppingBag,
  BarChart3,
  Check,
  Sparkles,
  Eye,
  Bookmark,
  CalendarDays,
} from "lucide-react";
import { api, post, newJob, save, del, number, date, type Doc } from "../api";
import {
  PageHead,
  Button,
  Empty,
  ErrorBox,
  Connection,
  Tabs,
  Modal,
  JsonView,
  ResultView,
  useApp,
  useData,
  copyText,
  FilePicker,
} from "../ui";
import { markets, entities, recipes } from "../templates";
import { nextParams } from "../pagination";
import { LaunchProject, useCommercePage, CommercePagination } from "./Commerce";
import "../research.css";
export type Endpoint = {
  path: string;
  title: string;
  description: string;
  group: string;
  source: string;
  parameters: {
    name: string;
    required: boolean;
    description: string;
    type: string;
    enum?: any[];
    default?: any;
  }[];
};
const domain = (entity: string) =>
  ({ creator: "influencer", shop: "seller" })[entity] || entity;
export function defaults(ep: Endpoint): Doc {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - 1);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 7);
  const base: Doc = {
    region: "US",
    date: day.toISOString().slice(0, 10),
    page_num: 1,
    page_size: 10,
    rank_type: 1,
    product_rank_field: 1,
    video_rank_field: 2,
    influencer_rank_field: 2,
    seller_rank_field: 1,
    size: 10,
    type: 2,
    offset: "0",
    count: 20,
    sort_type: 1,
    start_date: start.toISOString().slice(0, 10),
    end_date: day.toISOString().slice(0, 10),
  };
  return Object.fromEntries(
    ep.parameters
      .filter((p) => p.required || p.default !== undefined)
      .map((p) => [p.name, p.default ?? base[p.name] ?? ""]),
  );
}
const labels: Doc = {
  region: "市场",
  date: "榜单日期",
  page_num: "页码",
  page_size: "每页条数",
  keyword: "搜索关键词",
  sk: "搜索关键词",
  rank_type: "榜单周期",
  video_rank_field: "视频榜单",
  product_rank_field: "商品榜单",
  seller_rank_field: "店铺榜单",
  influencer_rank_field: "达人榜单",
  offset: "分页游标",
  count: "请求条数",
  product_ids: "商品 ID（逗号分隔）",
  video_ids: "视频 ID（逗号分隔）",
  product_id: "商品 ID",
  video_id: "视频 ID",
  seller_id: "店铺 ID",
  unique_id: "达人账号",
  unique_ids: "达人账号（逗号分隔）",
  room_ids: "直播间 ID",
  room_id: "直播间 ID",
  url: "视频链接 / ID",
  start_date: "开始日期",
  end_date: "结束日期",
  created_by_ai: "AI 视频",
  product_category_id: "商品类目 ID",
  category_id: "商品类目 ID",
};
const choices: Record<string, [string, string][]> = {
  product_rank_field: [
    ["1", "销量榜"],
    ["2", "带货达人数榜"],
  ],
  video_rank_field: [
    ["1", "播放量榜"],
    ["2", "带货销量榜"],
  ],
  seller_rank_field: [
    ["1", "店铺销量榜"],
    ["2", "带货达人数榜"],
  ],
  influencer_rank_field: [
    ["1", "粉丝榜"],
    ["2", "带货销量榜"],
  ],
  created_by_ai: [
    ["true", "仅 AI 视频"],
    ["false", "非 AI 视频"],
  ],
  from_flag: [
    ["1", "本土店"],
    ["2", "跨境店"],
  ],
};
const friendlyHelp: Doc = {
  date: "请选择已结束的统计周期。",
  rank_type: "周榜日期选周一，月榜选每月 1 日。",
  page_num: "从第 1 页开始。",
  page_size: "每页最多 10 条。",
  product_rank_field: "按周期内销量或关联达人数排序。",
  video_rank_field: "按周期内播放量或带货销量排序。",
  seller_rank_field: "按周期内销量或关联达人数排序。",
  influencer_rank_field: "按粉丝数或带货销量排序。",
};
export function ParamsForm({
  ep,
  params,
  onChange,
  friendly = false,
}: {
  ep: Endpoint;
  params: Doc;
  onChange: (v: Doc) => void;
  friendly?: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  return (
    <>
      <div className="param-grid">
        {ep.parameters
          .filter((p) => p.required || advanced)
          .map((p) => (
            <label className="field" key={p.name}>
              <span>
                {labels[p.name] || p.name}
                {p.required && <span className="required"> *</span>}
              </span>
              {p.name === "region" ? (
                <select
                  value={params[p.name] || ""}
                  onChange={(e) =>
                    onChange({ ...params, [p.name]: e.target.value })
                  }
                >
                  {!p.required && <option value="">不限</option>}
                  {markets.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l} · {v}
                    </option>
                  ))}
                </select>
              ) : p.name === "rank_type" ? (
                <select
                  value={params[p.name] || 1}
                  onChange={(e) =>
                    onChange({ ...params, [p.name]: e.target.value })
                  }
                >
                  <option value="1">日榜</option>
                  <option value="2">周榜（日期选周一）</option>
                  <option value="3">月榜（日期选每月 1 日）</option>
                </select>
              ) : choices[p.name] ? (
                <select
                  value={params[p.name] ?? ""}
                  onChange={(e) =>
                    onChange({ ...params, [p.name]: e.target.value })
                  }
                >
                  {!p.required && <option value="">不限</option>}
                  {choices[p.name].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : p.enum ? (
                <select
                  value={params[p.name] || ""}
                  onChange={(e) =>
                    onChange({ ...params, [p.name]: e.target.value })
                  }
                >
                  <option value="">请选择</option>
                  {p.enum.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={
                    /^(date|start_date|end_date)$/.test(p.name)
                      ? "date"
                      : p.type === "integer" || p.type === "number"
                        ? "number"
                        : "text"
                  }
                  value={params[p.name] ?? ""}
                  onChange={(e) =>
                    onChange({ ...params, [p.name]: e.target.value })
                  }
                  placeholder={p.description.slice(0, 60)}
                />
              )}
              <small>
                {friendly
                  ? friendlyHelp[p.name] || p.description
                  : p.description}
              </small>
            </label>
          ))}
      </div>
      {ep.parameters.some((p) => !p.required) && (
        <button
          className="advanced-toggle"
          onClick={() => setAdvanced(!advanced)}
        >
          <Filter size={14} />
          {advanced ? "收起可选参数" : "更多筛选参数"}
          <ChevronDown size={13} />
        </button>
      )}
    </>
  );
}
export function DataResults({
  result,
  entity,
  onInspect,
}: {
  result: Doc;
  entity: string;
  onInspect: (v: Doc) => void;
}) {
  const { toast } = useApp();
  return (
    <>
      <div className="result-meta">
        <span>
          <span className="status-dot green" />
          EchoTik · {result.cached ? "缓存" : "最新请求"}
        </span>
        <span>{date(result.fetchedAt)}</span>
        {result.isEstimated && <span>商业指标含预估 · 离线数据</span>}
        <span>{result.items?.length || 0} 条记录</span>
      </div>
      {result.items?.length ? (
        <div className={entity === "video" ? "video-grid" : "data-grid"}>
          {result.items.map((item: Doc, i: number) => (
            <article
              className={`data-card ${entity === "video" ? "video-card" : ""}`}
              key={item.id || i}
            >
              <button className="data-cover" onClick={() => onInspect(item)}>
                {item.image ? (
                  <img
                    src={item.image}
                    alt={item.title}
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <span className="cover-placeholder">
                    {entity === "video" ? (
                      <Play size={26} />
                    ) : (
                      <ShoppingBag size={26} />
                    )}
                  </span>
                )}
                {entity === "video" && (
                  <span className="play-overlay">
                    <Play size={17} fill="currentColor" />
                  </span>
                )}
                <span className="rank-marker">{i + 1}</span>
              </button>
              <div className="data-card-body">
                <button className="card-title" onClick={() => onInspect(item)}>
                  {item.title}
                </button>
                <div className="card-author">
                  {item.author || item.region || item.id}
                </div>
                <div className="data-metrics">
                  <div>
                    <span>GMV（来源口径）</span>
                    <strong>
                      {item.gmv === null
                        ? "—"
                        : `${item.currency ? item.currency + " " : ""}${number(item.gmv)}`}
                    </strong>
                  </div>
                  <div>
                    <span>{entity === "video" ? "播放量" : "销量"}</span>
                    <strong>
                      {number(entity === "video" ? item.views : item.sales)}
                    </strong>
                  </div>
                </div>
                <div className="card-actions">
                  <button
                    onClick={async () => {
                      try {
                        await save("favorite", {
                          ...item,
                          externalId: item.id,
                          provenance: {
                            source: result.source,
                            endpoint: result.endpoint,
                            fetchedAt: result.fetchedAt,
                            isEstimated: result.isEstimated,
                            metricPeriod: result.metricPeriod,
                          },
                        });
                        toast("已加入我的灵感");
                      } catch (e: any) {
                        toast(e.message, true);
                      }
                    }}
                  >
                    <Heart size={15} />
                    收藏
                  </button>
                  <button onClick={() => onInspect(item)}>
                    研究详情
                    <ArrowUpRight size={14} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="没有可展示的记录"
          description="可能尚未收录，或此接口返回了非列表数据。下方可查看原始响应，空数据不表示销量为零。"
        />
      )}
      <details className="raw-response">
        <summary>原始响应与分页游标</summary>
        <JsonView value={result.data} />
      </details>
    </>
  );
}
function TrendChart({ points }: { points: Doc[] }) {
  const [metric, setMetric] = useState("gmv");
  const names: Doc = {
    gmv: "GMV（来源币种）",
    sales: "销量",
    views: "播放量",
    followers: "粉丝数",
  };
  const available = Object.keys(names).filter((k) =>
    points.some((p) => p[k] != null),
  );
  const key = available.includes(metric) ? metric : available[0];
  const vals = points.map((p) => (p[key] == null ? null : Number(p[key])));
  const finite = vals.filter(
    (x): x is number => x !== null && Number.isFinite(x),
  );
  const min = Math.min(0, ...finite),
    max = Math.max(0, ...finite),
    scale = max - min || 1;
  if (!finite.length)
    return (
      <Empty
        title="此时间段没有可绘制的趋势"
        description="数据缺失不表示零销量，可查看来源信息或调整日期。"
      />
    );
  const segments: string[] = [];
  let part: string[] = [];
  vals.forEach((v, i) => {
    if (v === null) {
      if (part.length) segments.push(part.join(" "));
      part = [];
    } else
      part.push(
        `${20 + (i / Math.max(1, vals.length - 1)) * 660},${160 - ((v - min) / scale) * 140}`,
      );
  });
  if (part.length) segments.push(part.join(" "));
  return (
    <section>
      <div className="research-toolbar">
        <select
          aria-label="趋势指标"
          value={key}
          onChange={(e) => setMetric(e.target.value)}
        >
          {available.map((k) => (
            <option key={k} value={k}>
              {names[k]}
            </option>
          ))}
        </select>
        <span className="muted">按来源口径展示；缺失点断开。</span>
      </div>
      <svg
        className="trend-chart"
        viewBox="0 0 700 180"
        role="img"
        aria-label={names[key] + "趋势"}
      >
        <line x1="20" y1="160" x2="680" y2="160" stroke="#ddd" />
        {segments.map((p, i) => (
          <polyline
            key={i}
            points={p}
            fill="none"
            stroke="#8772d6"
            strokeWidth="2.5"
          />
        ))}
      </svg>
      <div className="trend-labels">
        <span>{points[0]?.date}</span>
        <span>{points.at(-1)?.date}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>统计日期</th>
              <th>{names[key]}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={i}>
                <td>{p.date}</td>
                <td>{number(p[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
export function Detail({ item, onClose }: { item: Doc; onClose: () => void }) {
  const [current, setCurrent] = useState(item),
    [history, setHistory] = useState<Doc[]>([]),
    [tab, setTab] = useState("detail"),
    [relation, setRelation] = useState(""),
    [result, setResult] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [replies, setReplies] = useState<Doc>({}),
    [launch, setLaunch] = useState(false),
    [start, setStart] = useState(
      new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10),
    ),
    [end, setEnd] = useState(
      new Date(Date.now() - 864e5).toISOString().slice(0, 10),
    );
  const sequence = useRef(0);
  const { toast } = useApp();
  const relations: Record<string, string[]> = {
    product: ["video", "creator"],
    video: ["product"],
    creator: ["video", "product"],
    shop: ["video", "product"],
    live: ["product"],
  };
  async function run(action: string, extra: Doc = {}, append = false) {
    const serial = ++sequence.current;
    setTab(action);
    setError("");
    setBusy(true);
    try {
      const r = await post("/research/query", {
        entity: current.entity,
        id: current.id,
        region: current.region || "US",
        action,
        relation: relation || relations[current.entity]?.[0],
        startDate: start,
        endDate: end,
        ...extra,
      });
      if (serial !== sequence.current) return;
      setResult((prev) =>
        append && prev
          ? {
              ...r,
              items: [
                ...prev.items,
                ...r.items.filter(
                  (i: Doc) => !prev.items.some((p: Doc) => p.id === i.id),
                ),
              ],
            }
          : r,
      );
    } catch (e: any) {
      if (serial === sequence.current) setError(e.message);
    } finally {
      if (serial === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    setRelation("");
    setResult(null);
    setReplies({});
    void run("detail", { relation: undefined });
    return () => {
      sequence.current++;
    };
  }, [current.id, current.entity]);
  const detail = tab === "detail" ? result?.items?.[0] || current : current;
  return (
    <Modal title={current.title} onClose={onClose} wide>
      <div className="detail-identity">
        {current.image && <img src={current.image} alt="" />}
        <div>
          {history.length > 0 && (
            <Button
              onClick={() => {
                setCurrent(history.at(-1)!);
                setHistory(history.slice(0, -1));
              }}
            >
              返回上一实体
            </Button>
          )}
          <span className="muted">
            {entities.find((e) => e.id === current.entity)?.label} ·{" "}
            {current.region || "市场未标注"}
          </span>
          <p className="id-label">ID {current.id}</p>
          <div className="inline-actions">
            {current.sourceUrl && (
              <a
                className="button"
                href={current.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                查看原视频
              </a>
            )}
            {current.entity === "video" && (
              <>
                <Button variant="primary" onClick={() => setLaunch(true)}>
                  用我的商品复刻
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await newJob("prompt", {
                        sourceUrl: current.sourceUrl || current.id,
                        sourceMetrics: current.raw,
                        region: current.region,
                      });
                      toast("案例提取已提交，完成后进入待审阅草稿");
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  提取销售案例
                </Button>
              </>
            )}
            {current.entity === "product" && (
              <>
                <Button
                  onClick={async () => {
                    try {
                      await newJob("research", {
                        productId: current.id,
                        region: current.region || "US",
                      });
                      toast("商品研究已提交");
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  研究商品评论
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await post("/commerce/opportunities", {
                        title: current.title,
                        summary: "待验证：评估该商品的需求与内容机会",
                        externalId: current.id,
                        region: current.region || "US",
                        evidence: [
                          {
                            product: current,
                            source: result?.source || "EchoTik",
                            fetchedAt: result?.fetchedAt,
                          },
                        ],
                        source: "EchoTik 发现",
                      });
                      toast("已加入选品机会");
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  加入机会库
                </Button>
              </>
            )}
            {current.entity !== "live" && (
              <Button
                onClick={async () => {
                  try {
                    await post("/commerce/watches", {
                      name: current.title,
                      entity: current.entity,
                      externalId: current.id,
                      region: current.region || "US",
                    });
                    toast("已加入竞品观察");
                  } catch (e: any) {
                    toast(e.message, true);
                  }
                }}
              >
                跟踪变化
              </Button>
            )}
          </div>
        </div>
      </div>
      <Tabs
        items={[
          { id: "detail", label: "经营详情" },
          { id: "trend", label: "趋势" },
          ...(["product", "video"].includes(current.entity)
            ? [{ id: "comments", label: "评论" }]
            : []),
          { id: "related", label: "关联内容" },
        ]}
        value={tab}
        onChange={(t) => {
          setResult(null);
          void run(t);
        }}
      />
      {tab === "trend" && (
        <div className="research-toolbar">
          <input
            aria-label="趋势开始日期"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <input
            aria-label="趋势结束日期"
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
          <Button busy={busy} onClick={() => run("trend")}>
            查询趋势
          </Button>
        </div>
      )}
      {tab === "related" && (
        <div className="research-toolbar">
          {relations[current.entity]?.map((r) => (
            <Button
              key={r}
              variant={
                (relation || relations[current.entity][0]) === r
                  ? "primary"
                  : undefined
              }
              onClick={() => {
                setRelation(r);
                setResult(null);
                void run("related", { relation: r });
              }}
            >
              {entities.find((e) => e.id === r)?.label}
            </Button>
          ))}
        </div>
      )}
      {error && <ErrorBox message={error} />}{" "}
      {busy && !result && <div className="loading-line">正在查询数据…</div>}
      {result && (
        <>
          <p className="snapshot-meta">
            {result.source} · {date(result.fetchedAt)} ·{" "}
            {result.cached ? "缓存" : "本次请求"} ·{" "}
            {result.isEstimated ? "商业情报指标含预估" : "实时接口返回"}
          </p>
          {tab === "detail" && (
            <>
              <div className="research-metrics">
                {[
                  ["gmv", "GMV"],
                  ["sales", "销量"],
                  ["views", "播放量"],
                ].map(([k, label]) => (
                  <div key={k}>
                    <span>
                      {label}
                      {k === "gmv" && detail.currency
                        ? ` (${detail.currency})`
                        : ""}
                    </span>
                    <strong>{number(detail[k])}</strong>
                  </div>
                ))}
              </div>
              <dl className="research-facts">
                {[
                  ["名称", detail.title],
                  ["作者 / 店铺", detail.author],
                  ["市场", detail.region],
                  ["价格", detail.raw?.spu_avg_price ?? detail.raw?.price],
                  ["评分", detail.raw?.product_rating ?? detail.raw?.rating],
                  [
                    "粉丝",
                    detail.raw?.follower_count ??
                      detail.raw?.total_follower_cnt,
                  ],
                  ["商品数", detail.raw?.total_product_cnt],
                  ["视频数", detail.raw?.total_video_cnt],
                ]
                  .filter(([, v]) => v != null)
                  .map(([label, v]) => (
                    <div key={String(label)}>
                      <dt>{label}</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
              </dl>
            </>
          )}
          {tab === "trend" && <TrendChart points={result.trend || []} />}
          {tab === "related" && (
            <DataResults
              result={result}
              entity={result.entity}
              onInspect={(i) => {
                setHistory([...history, current]);
                setCurrent(i);
              }}
            />
          )}
          {tab === "comments" && (
            <>
              <div className="research-toolbar">
                <span>{result.items.length} 条已加载评论</span>
                <Button
                  disabled={!result.items.length}
                  onClick={async () => {
                    try {
                      await newJob("insights", {
                        evidence: {
                          source: result.source,
                          fetchedAt: result.fetchedAt,
                          endpoint: result.endpoint,
                          items: result.items,
                        },
                      });
                      toast("评论痛点分析已提交");
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  分析评论痛点
                </Button>
              </div>
              <div className="research-comments">
                {result.items.map((c: Doc) => (
                  <article key={c.id}>
                    <strong>{c.author}</strong>
                    <p>{c.text}</p>
                    <small>
                      {c.rating != null ? `评分 ${c.rating} · ` : ""}点赞{" "}
                      {number(c.likes)} · 评论 ID {c.id}
                    </small>
                    {current.entity === "video" && (
                      <Button
                        onClick={async () => {
                          try {
                            const cursor = replies[c.id]?.nextCursor || "0",
                              r = await post("/research/query", {
                                entity: "video",
                                id: current.id,
                                action: "replies",
                                commentId: c.id,
                                cursor,
                              });
                            setReplies((prev) => ({
                              ...prev,
                              [c.id]: {
                                ...r,
                                items:
                                  cursor === "0"
                                    ? r.items
                                    : [
                                        ...(prev[c.id]?.items || []),
                                        ...r.items,
                                      ],
                              },
                            }));
                          } catch (e: any) {
                            toast(e.message, true);
                          }
                        }}
                      >
                        {replies[c.id]?.nextCursor
                          ? "加载更多回复"
                          : replies[c.id]
                            ? "刷新回复"
                            : "查看回复"}
                      </Button>
                    )}
                    {replies[c.id] && (
                      <div className="research-replies">
                        {replies[c.id].items.length ? (
                          replies[c.id].items.map((r: Doc, i: number) => (
                            <p key={r.id + ":" + i}>
                              <strong>{r.author}</strong> · {r.text}
                            </p>
                          ))
                        ) : (
                          <p className="muted">暂无可获取的回复</p>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
              {!result.items.length && (
                <Empty
                  title="暂无可获取的评论"
                  description="未收录或样本为空，不等于没有评论。"
                />
              )}
            </>
          )}
          {(result.nextCursor || result.nextPage) && (
            <Button
              busy={busy}
              onClick={() =>
                run(
                  tab,
                  {
                    cursor: result.nextCursor || undefined,
                    page: result.nextPage || undefined,
                  },
                  tab === "comments",
                )
              }
            >
              加载下一页
            </Button>
          )}
          <details className="raw-response">
            <summary>来源响应与核对信息</summary>
            <JsonView value={result.data} />
          </details>
        </>
      )}
      {launch && (
        <LaunchProject source={current} onClose={() => setLaunch(false)} />
      )}
    </Modal>
  );
}

function SearchWorkbench({
  query,
  onRestore,
  result,
  onInspect,
}: {
  query: Doc;
  onRestore: (q: Doc) => void;
  result: Doc | null;
  onInspect: (item: Doc) => void;
}) {
  const { data: saved, reload } = useData("/commerce/searches");
  const { toast } = useApp();
  const [name, setName] = useState(""),
    [tab, setTab] = useState("saved"),
    [keyword, setKeyword] = useState(""),
    [suggestions, setSuggestions] = useState<Doc | null>(null),
    [image, setImage] = useState<Doc | null>(null),
    [photo, setPhoto] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false);
  const choose = (word: string) =>
    onRestore({
      view: "search",
      entity: "product",
      region: query.region,
      keyword: word,
      params: {},
    });
  return (
    <details className="search-workbench">
      <summary>保存搜索、关键词灵感与图片找商品</summary>
      <div className="research-toolbar">
        <Button onClick={() => setTab("saved")}>保存的搜索</Button>
        <Button onClick={() => setTab("keywords")}>关键词灵感</Button>
        <Button onClick={() => setTab("image")}>图片找商品</Button>
        {result?.items?.length > 0 && (
          <Button
            onClick={async () => {
              try {
                const r = await fetch("/api/research/export", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ items: result!.items }),
                });
                if (!r.ok) throw new Error("导出失败");
                const url = URL.createObjectURL(await r.blob()),
                  a = document.createElement("a");
                a.href = url;
                a.download = "research.csv";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
              } catch (e: any) {
                toast(e.message, true);
              }
            }}
          >
            <Download size={14} />
            导出当前页
          </Button>
        )}
      </div>
      {tab === "saved" && (
        <>
          <div className="research-toolbar">
            <input
              aria-label="搜索名称"
              placeholder="给当前筛选起个名字"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              disabled={!name.trim() || query.view === "favorites"}
              onClick={async () => {
                try {
                  await post("/commerce/searches", { name, query });
                  setName("");
                  void reload();
                  toast("搜索条件已保存");
                } catch (e: any) {
                  toast(e.message, true);
                }
              }}
            >
              保存当前筛选
            </Button>
          </div>
          {saved?.length ? (
            <div className="favorite-list">
              {saved.map((s) => (
                <div className="favorite-row" key={s.id}>
                  <Button
                    onClick={() => {
                      onRestore(s.query);
                      toast("筛选已恢复，点击查询获取数据");
                    }}
                  >
                    {s.name}
                  </Button>
                  <small>
                    {s.query.region} · {date(s.updatedAt)}
                  </small>
                  <Button
                    aria-label="删除保存搜索"
                    onClick={async () => {
                      try {
                        await api("/commerce/searches/" + s.id, {
                          method: "DELETE",
                        });
                        void reload();
                      } catch (e: any) {
                        toast(e.message, true);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">保存常用市场、关键词与筛选，方便重复观察。</p>
          )}
        </>
      )}
      {tab === "keywords" && (
        <>
          <div className="research-toolbar">
            <input
              aria-label="灵感关键词"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="例如 coffee maker"
            />
            <Button
              busy={busy}
              disabled={!keyword.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  setSuggestions(
                    await post("/research/query", {
                      entity: "keyword",
                      action: "keywords",
                      keyword,
                      region: query.region,
                    }),
                  );
                } catch (e: any) {
                  toast(e.message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              查找相关搜索词
            </Button>
          </div>
          {suggestions?.items && (
            <div className="discovery-keywords">
              {suggestions.items.map((s: Doc) => (
                <button key={s.id} onClick={() => choose(s.title)}>
                  {s.title}
                  {s.volume != null ? " · " + number(s.volume) : ""}
                </button>
              ))}
            </div>
          )}
          {suggestions?.items?.length === 0 && <p>暂未收录相关关键词。</p>}
        </>
      )}
      {tab === "image" && (
        <>
          <p className="muted">
            上传不超过 2MB 的 JPG、PNG 或 WebP，直接在 EchoTik
            搜索相似商品。也可以选择 Gemini 识别关键词后再搜索。
          </p>
          <div className="research-toolbar">
            <FilePicker
              onPick={(a) => {
                setImage(a);
                setPhoto(null);
              }}
            />
            {image && <span>{image.name}</span>}
            <input
              aria-label="图片搜索限定关键词"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="限定关键词（可选）"
            />
            <Button
              variant="primary"
              busy={busy}
              disabled={!image}
              onClick={async () => {
                setBusy(true);
                try {
                  setPhoto(
                    await post("/research/photo-search", {
                      assetId: image!.id,
                      region: query.region,
                      keyword,
                    }),
                  );
                } catch (e: any) {
                  toast(e.message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              搜索相似商品
            </Button>
            <Button
              busy={busy}
              disabled={!image}
              onClick={async () => {
                setBusy(true);
                try {
                  setSuggestions(
                    await post("/research/image-keywords", {
                      assetId: image!.id,
                      region: query.region,
                    }),
                  );
                } catch (e: any) {
                  toast(e.message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Gemini 识别关键词
            </Button>
          </div>
          {photo && (
            <>
              <DataResults
                result={photo}
                entity="product"
                onInspect={onInspect}
              />
              {photo.nextCursor && (
                <Button
                  busy={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await post("/research/photo-search", {
                        searchId: photo.searchId,
                        cursor: photo.nextCursor,
                        region: query.region,
                        keyword,
                      });
                      setPhoto({
                        ...r,
                        items: [
                          ...photo.items,
                          ...r.items.filter(
                            (v: Doc) =>
                              !photo.items.some((p: Doc) => p.id === v.id),
                          ),
                        ],
                      });
                    } catch (e: any) {
                      toast(e.message, true);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  加载更多相似商品
                </Button>
              )}
            </>
          )}
          {suggestions?.keywords && (
            <>
              <p>{suggestions.description}</p>
              <div className="discovery-keywords">
                {suggestions.keywords.map((word: string) => (
                  <button key={word} onClick={() => choose(word)}>
                    搜索 {word}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </details>
  );
}

export function Inspiration() {
  const restoreRef = useRef<Doc | null>(null);
  const { status, toast } = useApp();
  const navigate = useNavigate();
  const { data: catalog } = useData<Endpoint[]>("/catalog");
  const [view, setView] = useState("rank"),
    [entity, setEntity] = useState("product"),
    [region, setRegion] = useState("US"),
    [keyword, setKeyword] = useState(""),
    [params, setParams] = useState<Doc>({}),
    [result, setResult] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<Doc | null>(null);
  const { data: favorites, reload: reloadFavorites } =
    useData("/records/favorite");
  const path =
    view === "search"
      ? entity === "shop"
        ? "/echotik/search/items"
        : `/realtime/${domain(entity)}/search`
      : `/echotik/${domain(entity)}/${view === "discover" || entity === "live" ? "list" : "ranklist"}`;
  const ep = catalog?.find((e) => e.path === path);
  useEffect(() => {
    setResult(null);
    setError("");
    if (ep) {
      setParams({
        ...defaults(ep),
        region,
        ...(restoreRef.current?.params || {}),
      });
      restoreRef.current = null;
    }
  }, [ep?.path, region]);
  async function query(override?: Doc) {
    if (!ep) return;
    setBusy(true);
    setError("");
    try {
      const p: Doc = { ...(override || params), region };
      if (view === "search") {
        p[entity === "product" || entity === "shop" ? "sk" : "keyword"] =
          keyword;
        if (entity === "shop") {
          p.type = 3;
          p.size = 10;
        }
      }
      setResult(
        await post("/echotik/query", { path: ep.path, params: p, entity }),
      );
      setParams(p);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page research-page">
      <PageHead
        title="灵感与选品"
        description="从市场趋势找到好产品，从真实反馈找到创作角度。"
      >
        <Link className="button" to="/explorer">
          <Code2 size={15} />
          全部数据接口
        </Link>
      </PageHead>
      <Connection provider="echotik" label="EchoTik 数据服务" />
      <SearchWorkbench
        query={{ view, entity, region, keyword, params }}
        result={result}
        onInspect={setSelected}
        onRestore={(q) => {
          restoreRef.current =
            (q.view || "search") === view &&
            (q.entity || "product") === entity &&
            (q.region || "US") === region
              ? null
              : q;
          setView(q.view || "search");
          setEntity(q.entity || "product");
          setRegion(q.region || "US");
          setKeyword(q.keyword || "");
          setParams(q.params || {});
          setResult(null);
        }}
      />
      <Tabs
        items={[
          { id: "rank", label: "TikTok 排行榜" },
          { id: "discover", label: "筛选发现" },
          { id: "search", label: "最新搜索" },
          { id: "favorites", label: "我的灵感" },
        ]}
        value={view}
        onChange={(v) => {
          setView(v);
          if (v === "favorites") void reloadFavorites();
        }}
      />
      {view === "favorites" ? (
        favorites?.length ? (
          <div className="favorite-list">
            {favorites.map((f) => (
              <div className="favorite-row" key={f.id}>
                <button
                  className="favorite-content"
                  onClick={() =>
                    setSelected({
                      ...f,
                      id:
                        f.externalId ||
                        f.raw?.product_id ||
                        f.raw?.video_id ||
                        f.raw?.aweme_id ||
                        f.id,
                    })
                  }
                >
                  <Bookmark size={18} />
                  <div>
                    <strong>{f.title}</strong>
                    <small>
                      {f.entity} · {date(f.createdAt)}
                    </small>
                  </div>
                </button>
                <Button
                  onClick={async () => {
                    await del("favorite", f.id);
                    void reloadFavorites();
                  }}
                  aria-label="删除收藏"
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title="保存值得继续研究的灵感"
            description="在搜索或排行榜中收藏商品与视频，随时回来继续研究。"
            icon={Bookmark}
          />
        )
      ) : (
        <>
          <div className="research-controls">
            <div className="entity-switch">
              {entities.map((e) => (
                <button
                  key={e.id}
                  className={e.id === entity ? "selected" : ""}
                  onClick={() => setEntity(e.id)}
                >
                  {e.label}
                </button>
              ))}
            </div>
            <label className="market-select">
              <span>市场</span>
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                {markets.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l} · {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {view === "search" && (
            <div className="search-bar">
              <Search size={18} />
              <input
                aria-label="搜索关键词"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void query();
                }}
                placeholder={`搜索${entities.find((e) => e.id === entity)?.label}，例如：coffee、skincare、pet supplies`}
              />
              <Button
                variant="primary"
                busy={busy}
                disabled={!keyword.trim()}
                onClick={() => query()}
              >
                搜索
              </Button>
            </div>
          )}
          {ep && (
            <div className="filter-panel">
              {["rank", "discover"].includes(view) ? (
                <ParamsForm
                  friendly
                  ep={{
                    ...ep,
                    parameters: ep.parameters.filter(
                      (p) => p.name !== "region",
                    ),
                  }}
                  params={params}
                  onChange={setParams}
                />
              ) : (
                <details>
                  <summary>高级筛选</summary>
                  <ParamsForm
                    friendly
                    ep={{
                      ...ep,
                      parameters: ep.parameters.filter(
                        (p) =>
                          !["keyword", "sk", "region", "type", "size"].includes(
                            p.name,
                          ),
                      ),
                    }}
                    params={params}
                    onChange={setParams}
                  />
                </details>
              )}
              {["rank", "discover"].includes(view) && (
                <Button variant="primary" busy={busy} onClick={() => query()}>
                  <RefreshCw size={15} />
                  {entity === "live" ? "查询直播记录" : "查询排行榜"}
                </Button>
              )}
            </div>
          )}
          {error && <ErrorBox message={error} />}
          {result ? (
            <>
              <DataResults
                result={result}
                entity={entity}
                onInspect={setSelected}
              />
              <div className="pagination-controls">
                {params.page_num && Number(params.page_num) > 1 && (
                  <Button
                    busy={busy}
                    onClick={() =>
                      query({
                        ...params,
                        page_num: Number(params.page_num) - 1,
                      })
                    }
                  >
                    上一页
                  </Button>
                )}
                {params.page_num && (
                  <span className="muted">第 {params.page_num} 页</span>
                )}
                {nextParams(path, params, result) && (
                  <Button
                    busy={busy}
                    onClick={() => query(nextParams(path, params, result)!)}
                  >
                    下一页 <ArrowRight size={14} />
                  </Button>
                )}
              </div>
            </>
          ) : (
            <Empty
              title={
                view === "rank"
                  ? "下一款值得研究的产品，在数据里"
                  : "从一个关键词，发现新的机会"
              }
              description={
                status?.connections?.echotik
                  ? "选择市场和筛选条件，开始查询真实 TikTok 电商数据。"
                  : "连接 EchoTik 后，可以查看榜单、搜索商品和视频，追踪经营趋势。"
              }
              icon={Compass}
            >
              {!status?.connections?.echotik && (
                <Link to="/settings" className="button primary">
                  连接 EchoTik <ArrowRight size={15} />
                </Link>
              )}
            </Empty>
          )}
        </>
      )}
      {selected && <Detail item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
export function Explorer() {
  const { data: catalog, error: loadError } = useData<Endpoint[]>("/catalog");
  const [path, setPath] = useState("/realtime/video/search"),
    [q, setQ] = useState(""),
    [params, setParams] = useState<Doc>({}),
    [result, setResult] = useState<Doc | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const ep = catalog?.find((e) => e.path === path);
  useEffect(() => {
    if (ep) setParams(defaults(ep));
    setResult(null);
    setError("");
  }, [ep]);
  return (
    <div className="page">
      <PageHead
        title="EchoTik 数据接口"
        description={`${catalog?.length || 78} 个官方接口，按真实参数查询，并保留原始响应。`}
      />
      <Connection provider="echotik" label="EchoTik" />
      {loadError && <ErrorBox message={loadError} />}
      <div className="explorer-layout">
        <aside className="endpoint-list">
          <div className="input-icon">
            <Search size={15} />
            <input
              aria-label="筛选接口"
              placeholder="搜索接口名称或路径"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {catalog
            ?.filter((e) =>
              (e.title + e.path).toLowerCase().includes(q.toLowerCase()),
            )
            .map((e) => (
              <button
                key={e.path}
                className={path === e.path ? "selected" : ""}
                onClick={() => setPath(e.path)}
              >
                <span>{e.title}</span>
                <small>{e.path}</small>
              </button>
            ))}
        </aside>
        <section className="endpoint-form">
          {ep && (
            <>
              <div className="endpoint-heading">
                <span className="http-method">GET</span>
                <code>{ep.path}</code>
                <a
                  href={ep.source}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="打开官方接口文档"
                >
                  <ArrowUpRight size={17} />
                </a>
              </div>
              <p className="endpoint-description">
                {ep.description.replace(/\*\*/g, "")}
              </p>
              <ParamsForm
                key={path}
                ep={ep}
                params={params}
                onChange={setParams}
              />
              <Button
                variant="primary"
                busy={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    setResult(await post("/echotik/query", { path, params }));
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                发送查询 <ArrowRight size={15} />
              </Button>
              {error && <ErrorBox message={error} />}
              {result && (
                <>
                  <div className="result-meta">
                    EchoTik · {date(result.fetchedAt)} ·{" "}
                    {result.cached ? "缓存响应" : "上游响应"}
                  </div>
                  <JsonView value={result} />
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
export function PromptLibrary() {
  const { data: products } = useData("/commerce/products"),
    { data: categoryOptions } = useData<string[]>("/commerce/cases/categories");
  const { toast } = useApp();
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [region, setRegion] = useState(""),
    [category, setCategory] = useState(""),
    [minGmv, setMinGmv] = useState(""),
    [source, setSource] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Doc | null>(null),
    [selected, setSelected] = useState<Doc | null>(null),
    [launch, setLaunch] = useState<Doc | null>(null),
    [matched, setMatched] = useState<Doc[] | null>(null),
    [productId, setProductId] = useState("");
  const {
    data: casesPage,
    items: cases,
    reload,
    error,
    loading,
    page,
    setPage,
  } = useCommercePage("cases", {
    q: query,
    status,
    region: region || undefined,
    category: category || undefined,
    minGmv: minGmv || undefined,
  });
  const names: Doc = {
    draft: "待补充草稿",
    review: "待审阅",
    published: "已发布到本库",
    archived: "已归档",
  };
  const gmv = (p: Doc) =>
    p.sourceMetrics?.total_video_sale_gmv_amt ??
    p.sourceMetrics?.total_sale_gmv_amt ??
    p.sourceMetrics?.gmv;
  const items = matched
    ? matched.filter(
        (p) =>
          (status === "all" || p.status === status) &&
          (!region || p.region === region) &&
          (!category || p.category === category) &&
          (!minGmv || (gmv(p) != null && Number(gmv(p)) >= Number(minGmv))),
      )
    : cases;
  return (
    <div className="page">
      <PageHead
        title="销售案例与提示词"
        description="从真实参考视频建立自己的案例库，审阅来源与销售结构后再复用。"
      >
        <Button
          onClick={async () => {
            try {
              const r = await post("/commerce/import-legacy");
              toast(`已导入 ${r.imported} 条历史记录`);
              void reload();
            } catch (e: any) {
              toast(e.message, true);
            }
          }}
        >
          导入旧提示词
        </Button>
        <Button
          variant="primary"
          onClick={() =>
            setEditing({
              title: "",
              prompt: "",
              sourceUrl: "",
              region: "",
              category: "",
              tags: [],
              status: "draft",
              reviewNote: "",
              sourceMetrics: {},
              analysis: {},
            })
          }
        >
          <Plus size={15} />
          添加案例
        </Button>
      </PageHead>
      <Connection provider="gemini" label="视频分析服务" />
      <div className="search-bar">
        <Link2 size={18} />
        <input
          aria-label="参考视频链接"
          placeholder="粘贴 TikTok 或视频链接，分析后保存为待审阅草稿"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <Button
          variant="primary"
          busy={busy}
          disabled={!source.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await newJob("prompt", {
                sourceUrl: source,
                prompt: "提取可复用销售结构，保留原视频证据",
              });
              setSource("");
              toast("分析任务已提交，完成后进入草稿");
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          分析并入库
        </Button>
      </div>
      <div className="research-toolbar">
        <input
          aria-label="案例搜索"
          placeholder="搜索案例、提示词或标签"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMatched(null);
          }}
        />
        <select
          aria-label="案例状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部状态</option>
          {Object.entries(names).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          aria-label="案例市场"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        >
          <option value="">全部市场</option>
          {markets.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          aria-label="案例类目"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">全部类目</option>
          {categoryOptions?.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input
          aria-label="最低GMV"
          type="number"
          min={0}
          placeholder="最低来源 GMV"
          value={minGmv}
          onChange={(e) => setMinGmv(e.target.value)}
        />
        <Button onClick={() => reload()}>
          <RefreshCw size={14} />
          刷新
        </Button>
      </div>
      <div className="research-toolbar">
        <select
          aria-label="匹配商品"
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
        >
          <option value="">选择自有商品（可选）</option>
          {products?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button
          busy={busy}
          disabled={!productId && query.trim().length < 2}
          onClick={async () => {
            setBusy(true);
            try {
              setMatched(
                await post("/commerce/cases/match", {
                  productId: productId || undefined,
                  query: query || "匹配这个商品的销售场景和目标消费者",
                }),
              );
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Sparkles size={14} />
          匹配已审阅案例
        </Button>
        {matched && (
          <Button onClick={() => setMatched(null)}>恢复全部案例</Button>
        )}
      </div>
      {error && <ErrorBox message={error} />}
      {loading && !matched && <div className="loading-line">正在加载案例…</div>}
      <div className="prompt-grid">
        {items.map((p) => (
          <article className="prompt-card" key={p.id}>
            <span className="source-tag">
              {names[p.status]} · {p.region || "市场未标注"}
            </span>
            <h3>{p.title}</h3>
            <p>{p.prompt}</p>
            {p.matchReason && <p>匹配原因：{p.matchReason}</p>}
            <small>
              {p.provenance} · {p.category || "未分类"}
            </small>
            <p>
              {gmv(p) != null
                ? `来源预估 GMV：${p.sourceMetrics.currency || "币种未提供"} ${number(gmv(p))}`
                : "来源未提供 GMV"}
            </p>
            <div className="inline-actions">
              <Button onClick={() => setSelected(p)}>查看证据</Button>
              {p.analysisStatus === "pending" && (
                <Button
                  disabled={
                    busy ||
                    (!p.sourceUrl && !p.sourceVideoId && !p.sourceVideoAssetId)
                  }
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await newJob("prompt", {
                        sourceUrl: p.sourceUrl || p.sourceVideoId,
                        videoAssetId: p.sourceVideoAssetId || undefined,
                        sourceMetrics: p.sourceMetrics,
                        region: p.region,
                        category: p.category,
                      });
                      toast("已提交视频分析，完成后会补全这条草稿");
                    } catch (e: any) {
                      toast(e.message, true);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  分析视频
                </Button>
              )}
              <Button onClick={() => setEditing(p)}>编辑与审阅</Button>
              <Button
                disabled={p.status !== "published"}
                onClick={() => setLaunch(p)}
              >
                用商品复刻
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!matched && (
        <CommercePagination
          data={casesPage}
          page={page}
          onPage={setPage}
          loading={loading}
        />
      )}
      {casesPage && !loading && !items.length && (
        <Empty
          title={matched ? "没有匹配的已审阅案例" : "没有匹配的案例"}
          description="先分析真实视频，再补充类目与审阅结论。这里不会预置虚构的销量和案例。"
          icon={Play}
        />
      )}
      {selected && (
        <Modal title={selected.title} wide onClose={() => setSelected(null)}>
          <p className="muted">
            来源：{selected.provenance} · {date(selected.createdAt)}
          </p>
          {selected.sourceUrl && (
            <a
              className="button"
              href={selected.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              查看来源视频
            </a>
          )}
          <p>审阅结论：{selected.reviewNote || "尚未审阅"}</p>
          <ResultView
            result={{
              ...selected.analysis,
              shootingPrompt: selected.prompt,
              sourceUrl: selected.sourceUrl,
            }}
          />
        </Modal>
      )}
      {editing && (
        <Modal title="案例编辑与审阅" wide onClose={() => setEditing(null)}>
          <div className="form-stack">
            <label className="field">
              标题
              <input
                value={editing.title}
                onChange={(e) =>
                  setEditing({ ...editing, title: e.target.value })
                }
              />
            </label>
            <label className="field">
              来源视频链接
              <input
                value={editing.sourceUrl}
                onChange={(e) =>
                  setEditing({ ...editing, sourceUrl: e.target.value })
                }
              />
              <small>
                相同来源只保留一个案例，发布前必须保留来源链接或视频素材。
              </small>
            </label>
            <div className="config-fields">
              <label className="field">
                市场
                <select
                  value={editing.region}
                  onChange={(e) =>
                    setEditing({ ...editing, region: e.target.value })
                  }
                >
                  <option value="">未标注</option>
                  {markets.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                类目
                <input
                  value={editing.category}
                  onChange={(e) =>
                    setEditing({ ...editing, category: e.target.value })
                  }
                />
              </label>
              <label className="field">
                状态
                <select
                  value={editing.status}
                  onChange={(e) =>
                    setEditing({ ...editing, status: e.target.value })
                  }
                >
                  {Object.entries(names).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              销售提示词
              <textarea
                rows={8}
                value={editing.prompt}
                onChange={(e) =>
                  setEditing({ ...editing, prompt: e.target.value })
                }
              />
            </label>
            <label className="field">
              标签（逗号分隔）
              <input
                value={editing.tags.join(",")}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    tags: e.target.value.split(/[,，]/),
                  })
                }
              />
            </label>
            <label className="field">
              审阅结论
              <textarea
                rows={4}
                placeholder="记录画面观察、适用商品与限制；已发布仅代表在本工作空间可复用。"
                value={editing.reviewNote}
                onChange={(e) =>
                  setEditing({ ...editing, reviewNote: e.target.value })
                }
              />
            </label>
            <label className="consent">
              <input
                type="checkbox"
                checked={editing.analysisStatus !== "pending"}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    analysisStatus: e.target.checked ? "ready" : "pending",
                  })
                }
              />
              销售提示词已完成分析或人工核对
            </label>
            <div className="inline-actions">
              <Button
                variant="primary"
                busy={busy}
                disabled={!editing.title.trim() || !editing.prompt.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(
                      "/commerce/cases" + (editing.id ? "/" + editing.id : ""),
                      {
                        method: editing.id ? "PATCH" : "POST",
                        body: JSON.stringify({
                          ...editing,
                          tags: editing.tags
                            .map((s: string) => s.trim())
                            .filter(Boolean),
                        }),
                      },
                    );
                    toast("案例已保存");
                    setEditing(null);
                    void reload();
                  } catch (e: any) {
                    toast(e.message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                保存案例
              </Button>
              {editing.id && (
                <Button
                  onClick={async () => {
                    try {
                      await api("/commerce/cases/" + editing.id, {
                        method: "DELETE",
                      });
                      setEditing(null);
                      void reload();
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  删除案例
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {launch && (
        <LaunchProject
          source={{ ...launch, caseId: launch.id, productId }}
          prompt={launch.prompt}
          onClose={() => setLaunch(null)}
        />
      )}
      <div className="section-heading">
        <h2>原创创作模板</h2>
        <span className="muted">无销售业绩背书</span>
      </div>
      <div className="recipe-grid">
        {recipes.map((r) => (
          <Link
            className={`recipe ${r.color}`}
            key={r.id}
            to="/"
            state={{ prompt: r.prompt, mode: "script" }}
          >
            <div>
              <h3>{r.title}</h3>
              <p>{r.label}</p>
            </div>
            <ArrowUpRight size={16} />
          </Link>
        ))}
      </div>
    </div>
  );
}
export function Competitors() {
  const [q, setQ] = useState("");
  const {
    data: pageData,
    items: data,
    reload,
    error,
    loading,
    page,
    setPage,
  } = useCommercePage("watches", { q });
  const { toast } = useApp();
  const [editing, setEditing] = useState<Doc | null>(null),
    [selected, setSelected] = useState<Doc | null>(null),
    [history, setHistory] = useState<Doc[]>([]),
    [snapshot, setSnapshot] = useState<Doc | null>(null),
    [busy, setBusy] = useState(""),
    [inspect, setInspect] = useState<Doc | null>(null),
    [launch, setLaunch] = useState<Doc | null>(null);
  async function open(w: Doc) {
    try {
      setSelected(w);
      const h = await api<Doc[]>("/commerce/watches/" + w.id + "/snapshots");
      setHistory(h);
      setSnapshot(h[0] || null);
    } catch (e: any) {
      toast(e.message, true);
    }
  }
  return (
    <div className="page">
      <PageHead
        title="竞品与市场观察"
        description="跟踪商品、视频、达人与店铺，比较每次真实采集的快照变化。"
      >
        <Link className="button" to="/automations">
          管理自动跟踪
        </Link>
        <Button
          variant="primary"
          onClick={() =>
            setEditing({
              name: "",
              entity: "product",
              externalId: "",
              region: "US",
              enabled: true,
              notes: "",
            })
          }
        >
          <Plus size={15} />
          添加观察对象
        </Button>
      </PageHead>
      <Connection provider="echotik" label="EchoTik" />
      <div className="research-toolbar">
        <input
          aria-label="搜索观察对象"
          placeholder="搜索名称"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {error && <ErrorBox message={error} />}
      {loading && <div className="loading-line">正在加载观察清单…</div>}
      <div className="competitor-list">
        {data?.map((w) => (
          <article className="competitor-row" key={w.id}>
            <span className="competitor-avatar">{w.name.slice(0, 1)}</span>
            <div>
              <h3>{w.name}</h3>
              <p>
                {entities.find((e) => e.id === w.entity)?.label} · {w.region} ·{" "}
                {w.externalId}
              </p>
              <small>{w.enabled ? "参与自动跟踪" : "暂停自动跟踪"}</small>
            </div>
            <div className="inline-actions">
              <Button
                busy={busy === w.id}
                onClick={async () => {
                  setBusy(w.id);
                  try {
                    await post("/commerce/watches/" + w.id + "/sync");
                    await open(w);
                    toast("已保存新的数据快照");
                  } catch (e: any) {
                    toast(e.message, true);
                  } finally {
                    setBusy("");
                  }
                }}
              >
                同步一次
              </Button>
              <Button onClick={() => open(w)}>快照与变化</Button>
              <Button onClick={() => setEditing(w)}>编辑</Button>
            </div>
          </article>
        ))}
      </div>
      <CommercePagination
        data={pageData}
        page={page}
        onPage={setPage}
        loading={loading}
      />
      {pageData && !loading && !data.length && (
        <Empty
          title="建立你的市场观察清单"
          description="添加商品、视频、达人或店铺 ID。首次同步作为基线，之后比较变化。"
          icon={Eye}
        />
      )}
      {editing && (
        <Modal title="观察对象" onClose={() => setEditing(null)}>
          <div className="form-stack">
            <label className="field">
              名称
              <input
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <label className="field">
              实体
              <select
                value={editing.entity}
                onChange={(e) =>
                  setEditing({ ...editing, entity: e.target.value })
                }
              >
                {entities
                  .filter((e) => e.id !== "live")
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              {editing.entity === "creator"
                ? "达人 user_id（数字 ID）"
                : "来源 ID"}
              <input
                value={editing.externalId}
                onChange={(e) =>
                  setEditing({ ...editing, externalId: e.target.value })
                }
              />
            </label>
            <label className="field">
              市场
              <select
                value={editing.region}
                onChange={(e) =>
                  setEditing({ ...editing, region: e.target.value })
                }
              >
                {markets.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="consent">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) =>
                  setEditing({ ...editing, enabled: e.target.checked })
                }
              />
              参与已启用的自动跟踪
            </label>
            <label className="field">
              备注
              <textarea
                rows={3}
                value={editing.notes}
                onChange={(e) =>
                  setEditing({ ...editing, notes: e.target.value })
                }
              />
            </label>
            <div className="inline-actions">
              <Button
                variant="primary"
                disabled={!editing.name.trim() || !editing.externalId.trim()}
                onClick={async () => {
                  try {
                    await api(
                      "/commerce/watches" +
                        (editing.id ? "/" + editing.id : ""),
                      {
                        method: editing.id ? "PATCH" : "POST",
                        body: JSON.stringify(editing),
                      },
                    );
                    setEditing(null);
                    void reload();
                  } catch (e: any) {
                    toast(e.message, true);
                  }
                }}
              >
                保存
              </Button>
              {editing.id && (
                <Button
                  onClick={async () => {
                    try {
                      await api("/commerce/watches/" + editing.id, {
                        method: "DELETE",
                      });
                      setEditing(null);
                      void reload();
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  删除观察对象
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {selected && (
        <Modal
          title={selected.name + " · 历史快照"}
          wide
          onClose={() => setSelected(null)}
        >
          {snapshot ? (
            <div className="watch-history">
              <nav aria-label="快照历史">
                {history.map((h) => (
                  <Button
                    key={h.id}
                    variant={snapshot.id === h.id ? "primary" : undefined}
                    onClick={() => setSnapshot(h)}
                  >
                    {date(h.createdAt)}
                  </Button>
                ))}
              </nav>
              <div>
                <p className="snapshot-meta">
                  {snapshot.source} · {date(snapshot.fetchedAt)} ·
                  关联样本最多一页
                </p>
                <div className="watch-change">
                  {snapshot.diff.baseline ? (
                    <span>首次同步，建立比较基线</span>
                  ) : (
                    <span>
                      本页新出现 {snapshot.diff.newItems.length} 条内容
                    </span>
                  )}
                  {snapshot.diff.metrics.map((m: Doc) => (
                    <span key={m.key}>
                      {
                        ({ gmv: "GMV", sales: "销量", views: "播放量" } as Doc)[
                          m.key
                        ]
                      }
                      ：{number(m.after)}（变化{" "}
                      {m.delta === null
                        ? "待积累"
                        : m.delta >= 0
                          ? "+" + number(m.delta)
                          : number(m.delta)}
                      ）
                    </span>
                  ))}
                </div>
                <p className="muted">{snapshot.diff.sampleNotice}</p>
                {snapshot.detail && (
                  <Button onClick={() => setInspect(snapshot.detail)}>
                    研究主体详情
                  </Button>
                )}
                <div className="research-toolbar">
                  <Button
                    onClick={async () => {
                      try {
                        await post("/automations", {
                          name: selected.name + " · 每日跟踪",
                          kind: "watch_sync",
                          input: { watchId: selected.id, maxWatches: 1 },
                          intervalMinutes: 1440,
                          enabled: true,
                        });
                        toast("每日跟踪已启用，可在自动化中管理");
                      } catch (e: any) {
                        toast(e.message, true);
                      }
                    }}
                  >
                    启用每日跟踪
                  </Button>
                </div>
                <div className="data-grid">
                  {snapshot.items.map((i: Doc) => (
                    <article className="data-card" key={i.id}>
                      {i.image && (
                        <img
                          className="research-card-image"
                          src={i.image}
                          alt={i.title}
                        />
                      )}
                      <div className="data-card-body">
                        <h3>{i.title}</h3>
                        <div className="metric-strip">
                          <span>GMV {number(i.gmv)}</span>
                          <span>播放 {number(i.views)}</span>
                        </div>
                        <div className="inline-actions">
                          <Button onClick={() => setInspect(i)}>
                            研究详情
                          </Button>
                          {i.entity === "video" && (
                            <Button onClick={() => setLaunch(i)}>复刻</Button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <Empty
              title="尚未采集快照"
              description="点击同步一次建立基线，后续同步将显示变化。"
            />
          )}
        </Modal>
      )}
      {inspect && <Detail item={inspect} onClose={() => setInspect(null)} />}{" "}
      {launch && (
        <LaunchProject source={launch} onClose={() => setLaunch(null)} />
      )}
    </div>
  );
}
