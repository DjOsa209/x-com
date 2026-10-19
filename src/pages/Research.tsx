import { useState, useEffect } from "react";
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
} from "../ui";
import { markets, entities, recipes } from "../templates";
import { nextParams } from "../pagination";
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
export function Detail({ item, onClose }: { item: Doc; onClose: () => void }) {
  const [tab, setTab] = useState("raw"),
    [result, setResult] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { toast } = useApp();
  const navigate = useNavigate();
  const run = async (type: string) => {
    setTab(type);
    setError("");
    setBusy(true);
    try {
      const d = domain(item.entity),
        id = item.id;
      let path = `/echotik/${d}/detail`,
        params: Doc =
          d === "product"
            ? { product_ids: id }
            : d === "video"
              ? { video_ids: id }
              : d === "influencer"
                ? { user_ids: id }
                : d === "live"
                  ? { room_ids: id }
                  : { seller_id: id };
      if (type === "comments") {
        path =
          item.entity === "product"
            ? "/realtime/product/comment"
            : "/realtime/video/comments";
        params =
          item.entity === "product"
            ? { product_id: id, region: item.region || "US", offset: "1" }
            : { video_id: id, offset: "0", count: 20 };
      }
      if (type === "related") {
        path = `/echotik/${d}/${item.entity === "video" ? "product" : "video"}/list`;
        params = {
          ...(
            {
              product: { product_id: id },
              video: { video_id: id },
              creator: { user_id: id },
              shop: { seller_id: id },
              live: { room_id: id },
            } as Doc
          )[item.entity],
          page_num: 1,
          page_size: 10,
        };
      }
      if (type === "trend") {
        const start = new Date();
        start.setDate(start.getDate() - 14);
        const end = new Date();
        end.setDate(end.getDate() - 1);
        path = `/echotik/${d}/trend`;
        params = {
          [d + "_id"]: id,
          start_date: start.toISOString().slice(0, 10),
          end_date: end.toISOString().slice(0, 10),
          page_num: 1,
          page_size: 10,
        };
      }
      setResult(
        await post("/echotik/query", { path, params, entity: item.entity }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={item.title} onClose={onClose} wide>
      <div className="detail-identity">
        {item.image && <img src={item.image} alt="" />}
        <div>
          <span className="muted">
            {entities.find((e) => e.id === item.entity)?.label} ·{" "}
            {item.region || "市场未标注"}
          </span>
          <p className="id-label">ID {item.id}</p>
          <div className="inline-actions">
            {item.entity === "video" && (
              <Button
                variant="primary"
                onClick={() => {
                  onClose();
                  navigate("/", {
                    state: {
                      sourceUrl: item.sourceUrl || item.id,
                      mode: "replicate",
                    },
                  });
                }}
              >
                用我的商品复刻
                <ArrowUpRight size={14} />
              </Button>
            )}
            {item.entity === "video" && (
              <Button
                onClick={async () => {
                  try {
                    await newJob("prompt", {
                      sourceUrl: item.sourceUrl || item.id,
                      prompt: "提取可复用销售结构，保留视频来源",
                      sourceMetrics: item.raw,
                      region: item.region,
                    });
                    toast("提示词提取任务已提交");
                    onClose();
                  } catch (e: any) {
                    toast(e.message, true);
                  }
                }}
              >
                <Sparkles size={14} />
                提取销售提示词
              </Button>
            )}
            {item.entity === "product" && (
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await newJob("research", {
                      productId: item.id,
                      region: item.region || "US",
                    });
                    toast("商品研究已提交到任务管理");
                  } catch (e: any) {
                    toast(e.message, true);
                  }
                }}
              >
                研究商品与评论
                <ArrowRight size={14} />
              </Button>
            )}
          </div>
        </div>
      </div>
      <Tabs
        items={[
          { id: "detail", label: "经营详情" },
          ...(["product", "video"].includes(item.entity)
            ? [
                { id: "trend", label: "趋势" },
                { id: "comments", label: "评论" },
              ]
            : []),
          { id: "related", label: "关联内容" },
          { id: "raw", label: "发现数据" },
        ]}
        value={tab}
        onChange={(t) => {
          if (t === "raw") {
            setTab(t);
            setResult(null);
          } else void run(t);
        }}
      />
      {error && <ErrorBox message={error} />}
      {busy ? (
        <div className="loading-line">正在查询 EchoTik…</div>
      ) : result ? (
        <>
          <div className="detail-toolbar">
            <span className="muted">
              来源：{result.endpoint} · {date(result.fetchedAt)}
            </span>
            {tab === "comments" && (
              <Button
                onClick={async () => {
                  try {
                    await newJob("insights", { evidence: result });
                    toast("评论痛点分析已提交");
                  } catch (e: any) {
                    toast(e.message, true);
                  }
                }}
              >
                <MessageSquare size={14} />
                分析评论痛点
              </Button>
            )}
          </div>
          {tab === "comments" && result.items?.length > 0 && (
            <div className="comment-list">
              {result.items.map((i: Doc, index: number) => {
                const c = i.raw;
                return (
                  <article key={c.cid || c.review_id || index}>
                    <strong>
                      {c.user?.nickname || c.nickname || "评论用户"}
                    </strong>
                    <p>
                      {c.text ||
                        c.display_text ||
                        c.review_text ||
                        "此条评价没有文本"}
                    </p>
                    <small>
                      {c.rating != null ? `评分 ${c.rating} · ` : ""}点赞{" "}
                      {number(c.digg_count ?? c.likes ?? 0)}
                    </small>
                  </article>
                );
              })}
            </div>
          )}
          <JsonView value={result.data} />
        </>
      ) : (
        <>
          <p className="muted detail-hint">
            点击经营详情、趋势或评论，查询对应数据；每次查询可能消耗 API 额度。
          </p>
          <JsonView value={item.raw || item} />
        </>
      )}
    </Modal>
  );
}
export function Inspiration() {
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
      : `/echotik/${domain(entity)}/${entity === "live" ? "list" : "ranklist"}`;
  const ep = catalog?.find((e) => e.path === path);
  useEffect(() => {
    setResult(null);
    setError("");
    if (ep) setParams({ ...defaults(ep), region });
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
      <Tabs
        items={[
          { id: "rank", label: "TikTok 排行榜" },
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
              {view === "rank" ? (
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
              {view === "rank" && (
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
  const { data: prompts, reload, error } = useData("/records/prompt");
  const [query, setQuery] = useState(""),
    [region, setRegion] = useState(""),
    [selected, setSelected] = useState<Doc | null>(null),
    [source, setSource] = useState(""),
    [busy, setBusy] = useState(false);
  const [semantic, setSemantic] = useState<Doc[] | null>(null),
    [searching, setSearching] = useState(false);
  const { toast } = useApp(),
    navigate = useNavigate();
  return (
    <div className="page">
      <PageHead
        title="爆款销售提示词库"
        description="把真实视频拆成可复用的销售结构，让每一次创作有据可循。"
      >
        <Link to="/inspiration" className="button">
          <Compass size={15} />
          寻找参考视频
        </Link>
      </PageHead>
      <div className="library-intro">
        <div>
          <h2>从参考视频，到你的销售提示词。</h2>
          <p>保存来源、分镜与创作思路。只有实际采集的数据才会显示 GMV。</p>
        </div>
        <div className="library-graphic">
          <FilmGlyph />
        </div>
      </div>
      <Connection provider="gemini" label="视频分析服务" />
      <div className="search-bar">
        <Link2 size={18} />
        <input
          aria-label="提取提示词的视频链接"
          placeholder="粘贴 TikTok 视频链接或视频直链，提取可拍摄提示词"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <Button
          busy={busy}
          variant="primary"
          disabled={!source.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await newJob("prompt", {
                sourceUrl: source,
                prompt: "提取视频的销售结构和可拍摄提示词",
              });
              toast("已提交提取任务，完成后会自动入库");
              setSource("");
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Sparkles size={15} />
          提取并入库
        </Button>
      </div>
      <div className="library-toolbar">
        <div className="input-icon">
          <Search size={16} />
          <input
            aria-label="搜索提示词库"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSemantic(null);
            }}
            placeholder="搜索已保存的提示词"
          />
        </div>
        <select
          aria-label="提示词市场"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        >
          <option value="">所有市场</option>
          {markets.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <Button
          busy={searching}
          disabled={query.trim().length < 2 || !prompts?.length}
          onClick={async () => {
            setSearching(true);
            try {
              setSemantic(await post("/prompts/search", { query }));
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setSearching(false);
            }
          }}
        >
          <Sparkles size={14} />
          语义检索
        </Button>
        <Button onClick={() => reload()}>
          <RefreshCw size={15} />
          刷新
        </Button>
      </div>
      {error && <ErrorBox message={error} />}
      {prompts?.length ? (
        <div className="prompt-grid">
          {(semantic || prompts)
            .filter(
              (p) =>
                (semantic !== null ||
                  (p.title + " " + p.prompt)
                    .toLowerCase()
                    .includes(query.toLowerCase())) &&
                (!region || p.region === region),
            )
            .map((p) => (
              <article className="prompt-card" key={p.id}>
                <span className="source-tag">
                  {p.provenance || "自有提示词"}
                </span>
                <h3>{p.title}</h3>
                <p>{p.prompt}</p>
                {p.matchReason && (
                  <small className="muted">匹配原因：{p.matchReason}</small>
                )}
                {(p.sourceMetrics?.total_video_sale_gmv_amt ??
                  p.sourceMetrics?.total_sale_gmv_amt) != null && (
                  <p>
                    来源 GMV（预估，币种按原始数据）：
                    {number(
                      p.sourceMetrics.total_video_sale_gmv_amt ??
                        p.sourceMetrics.total_sale_gmv_amt,
                    )}
                  </p>
                )}
                <div className="inline-actions">
                  <Button onClick={() => setSelected(p)}>查看分镜</Button>
                  <Button
                    onClick={() =>
                      navigate("/", {
                        state: {
                          prompt: p.prompt,
                          sourceUrl: p.sourceUrl || undefined,
                          mode: p.sourceUrl ? "replicate" : "video",
                        },
                      })
                    }
                  >
                    复刻
                    <ArrowUpRight size={14} />
                  </Button>
                  <button
                    aria-label="删除提示词"
                    className="icon-button"
                    onClick={async () => {
                      await del("prompt", p.id);
                      void reload();
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))}
        </div>
      ) : (
        <Empty
          title="你的案例库，等待第一条真实视频"
          description="从选品中心找到参考视频，再提取分镜和销售提示词。这里不会预置虚构的爆款或 GMV。"
          icon={Play}
        />
      )}
      <div className="section-heading">
        <h2>也可以从创作模板开始</h2>
        <span className="muted">原创模板 · 无销售业绩背书</span>
      </div>
      <div className="recipe-grid">
        {recipes.map((r) => (
          <button
            className={`recipe ${r.color}`}
            key={r.id}
            onClick={() =>
              navigate("/", { state: { prompt: r.prompt, mode: "script" } })
            }
          >
            <div>
              <h3>{r.title}</h3>
              <p>{r.label}</p>
            </div>
            <ArrowUpRight size={16} />
          </button>
        ))}
      </div>
      {selected && (
        <Modal title={selected.title} wide onClose={() => setSelected(null)}>
          <ResultView
            result={
              selected.analysis || {
                shootingPrompt: selected.prompt,
                sourceUrl: selected.sourceUrl,
              }
            }
          />
        </Modal>
      )}
    </div>
  );
}
function FilmGlyph() {
  return (
    <svg viewBox="0 0 120 100" fill="none" aria-hidden="true">
      <rect
        x="25"
        y="12"
        width="60"
        height="76"
        rx="10"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="m50 39 19 12-19 12V39Z" fill="currentColor" opacity=".8" />
      <path
        d="M35 23h40M35 77h40M92 30h10M97 25v10M13 65h10M18 60v10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function Competitors() {
  const { data, reload, error } = useData("/records/competitor");
  const { toast } = useApp();
  const [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [id, setId] = useState(""),
    [entity, setEntity] = useState("creator"),
    [busy, setBusy] = useState(""),
    [selected, setSelected] = useState<Doc | null>(null);
  return (
    <div className="page">
      <PageHead
        title="竞品跟踪"
        description="建立自己的观察清单，同步达人与店铺的带货内容。"
      >
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus size={16} />
          添加竞品
        </Button>
      </PageHead>
      <Connection provider="echotik" label="EchoTik" />
      {error && <ErrorBox message={error} />}
      {data?.length ? (
        <div className="competitor-list">
          {data.map((c) => (
            <div key={c.id} className="competitor-row">
              <span className="competitor-avatar">{c.name.slice(0, 1)}</span>
              <div>
                <h3>{c.name}</h3>
                <p>
                  {c.entity === "creator" ? "达人账号" : "店铺 ID"} ·{" "}
                  {c.externalId}
                </p>
                <small>上次同步：{date(c.lastSyncedAt)}</small>
              </div>
              <div className="inline-actions">
                <Button
                  busy={busy === c.id}
                  onClick={async () => {
                    setBusy(c.id);
                    try {
                      const r = await post(`/competitors/${c.id}/sync`);
                      setSelected(r);
                      void reload();
                      toast("已同步最新一页带货视频");
                    } catch (e: any) {
                      toast(e.message, true);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  <RefreshCw size={15} />
                  同步
                </Button>
                {c.snapshot && (
                  <Button onClick={() => setSelected(c)}>查看内容</Button>
                )}
                <button
                  aria-label="删除竞品"
                  className="icon-button"
                  onClick={async () => {
                    await del("competitor", c.id);
                    void reload();
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          title="关注值得学习的同行"
          description="添加 TikTok 达人账号或店铺 ID，手动同步其最新带货内容。"
          icon={Eye}
        >
          <Button onClick={() => setAdding(true)}>
            <Plus size={15} />
            添加第一个竞品
          </Button>
        </Empty>
      )}
      {adding && (
        <Modal title="添加竞品" onClose={() => setAdding(false)}>
          <div className="form-stack">
            <label className="field">
              名称
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              类型
              <select
                value={entity}
                onChange={(e) => setEntity(e.target.value)}
              >
                <option value="creator">达人账号</option>
                <option value="shop">店铺</option>
              </select>
            </label>
            <label className="field">
              {entity === "creator"
                ? "达人 unique_id（不带 @）"
                : "店铺 seller_id"}
              <input value={id} onChange={(e) => setId(e.target.value)} />
            </label>
            <Button
              variant="primary"
              disabled={!name.trim() || !id.trim()}
              onClick={async () => {
                try {
                  await save("competitor", {
                    name,
                    entity,
                    externalId: id.replace(/^@/, ""),
                  });
                  setAdding(false);
                  setName("");
                  setId("");
                  void reload();
                } catch (e: any) {
                  toast(e.message, true);
                }
              }}
            >
              保存到观察清单
            </Button>
          </div>
        </Modal>
      )}
      {selected && (
        <Modal
          title={selected.name + " · 同步数据"}
          wide
          onClose={() => setSelected(null)}
        >
          <JsonView value={selected.snapshot} />
        </Modal>
      )}
    </div>
  );
}
