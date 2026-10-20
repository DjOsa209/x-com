import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Plus,
  ShoppingBag,
  Trash2,
  ArrowUpRight,
  Search,
  X,
  Save,
  ClipboardList,
} from "lucide-react";
import { api, post, date, number, type Doc } from "../api";
import {
  PageHead,
  Button,
  Empty,
  ErrorBox,
  Modal,
  FilePicker,
  AssetPicker,
  ResultView,
  useApp,
  useData,
} from "../ui";
import { markets } from "../templates";
import "../research.css";
const lines = (s: string) =>
  s
    .split(/\n/)
    .map((v) => v.trim())
    .filter(Boolean);
export const opportunityStates: Doc = {
  new: "待评估",
  researching: "跟进中",
  testing: "跟进中（测试）",
  adopted: "采用",
  rejected: "放弃",
  archived: "已归档",
};
export function useCommercePage(kind: string, filters: Doc = {}) {
  const [page, setPage] = useState(1),
    serialized = JSON.stringify(filters);
  useEffect(() => setPage(1), [serialized]);
  const params = new URLSearchParams({ page: String(page), pageSize: "24" });
  for (const [k, v] of Object.entries(filters))
    if (v !== undefined && v !== null && v !== "all") params.set(k, String(v));
  const response = useData<Doc>("/commerce/" + kind + "?" + params.toString());
  return {
    ...response,
    page,
    setPage,
    items: (response.loading ? [] : response.data?.items || []) as Doc[],
  };
}
export function CommercePagination({
  data,
  page,
  onPage,
  loading,
}: {
  data: Doc | null;
  page: number;
  onPage: (n: number) => void;
  loading: boolean;
}) {
  if (!data) return null;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <div className="pagination-controls">
      <span className="muted">
        共 {data.total} 条 · 第 {page} / {pages} 页
      </span>
      <Button disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>
        上一页
      </Button>
      <Button
        disabled={loading || page >= pages}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
}
export function LaunchProject({
  source,
  prompt,
  onClose,
}: {
  source?: Doc;
  prompt?: string;
  onClose: () => void;
}) {
  const { data: products } = useData("/commerce/products");
  const { toast } = useApp();
  const navigate = useNavigate();
  const [productId, setProductId] = useState(source?.productId || ""),
    [busy, setBusy] = useState(false),
    [instructions, setInstructions] = useState(prompt || "");
  const product = products?.find((p) => p.id === productId);
  return (
    <Modal title="用自己的商品创建项目" onClose={onClose}>
      <div className="form-stack">
        <label className="field">
          商品
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">请选择商品</option>
            {products
              ?.filter((p) => p.status !== "archived")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.sku || "未填 SKU"}
                </option>
              ))}
          </select>
        </label>
        {!products?.length && (
          <p>
            先在 <Link to="/products">我的商品</Link> 保存商品图片与卖点。
          </p>
        )}
        <label className="field">
          补充创作要求
          <textarea
            rows={5}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
        {(source?.sourceUrl ||
          source?.sourceVideoAssetId ||
          source?.sourceVideoId) && (
          <p className="muted">将保留参考视频来源，进入分镜确认流程。</p>
        )}
        <Button
          variant="primary"
          busy={busy}
          disabled={!product?.assetIds?.length}
          onClick={async () => {
            setBusy(true);
            try {
              const p = await post("/projects", {
                name: product!.name + " · " + (source?.title || "销售视频"),
                input: {
                  productId,
                  assetIds: product!.assetIds,
                  prompt: [
                    product!.description,
                    ...product!.sellingPoints,
                    "限制与注意：" + product!.restrictions,
                    instructions,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  sourceUrl: source?.sourceUrl || source?.sourceVideoId || "",
                  videoAssetId: source?.sourceVideoAssetId || undefined,
                  mode:
                    source?.sourceUrl ||
                    source?.sourceVideoAssetId ||
                    source?.sourceVideoId
                      ? "replicate"
                      : "video",
                  duration: 30,
                  aspect: "9:16",
                  language: "English",
                  style: "UGC",
                  sourceCaseId: source?.caseId,
                  sourceOpportunityId: source?.opportunityId,
                },
              });
              if (source?.opportunityId)
                await api("/commerce/opportunities/" + source.opportunityId, {
                  method: "PATCH",
                  body: JSON.stringify({
                    projectId: p.id,
                    productId,
                    status: "testing",
                  }),
                });
              navigate("/projects?id=" + p.id);
              onClose();
              toast("项目已创建，继续审阅分镜");
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          创建项目 <ArrowUpRight size={14} />
        </Button>
      </div>
    </Modal>
  );
}
const blankProduct = {
  name: "",
  sku: "",
  description: "",
  assetIds: [],
  sellingPoints: [],
  markets: ["US"],
  restrictions: "",
  status: "draft",
  currency: "USD",
  price: null,
  cost: null,
  shipping: null,
  platformFeePercent: null,
  notes: "",
  externalId: "",
};
function ProductEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: Doc;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Doc>({ ...blankProduct, ...initial }),
    [picker, setPicker] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { data: assets } = useData("/records/asset");
  const { toast } = useApp();
  const set = (key: string, value: any) => setForm({ ...form, [key]: value });
  const attach = (a: Doc) =>
    setForm((f) => ({
      ...f,
      assetIds: [...new Set([...f.assetIds, a.id])].slice(0, 10),
    }));
  return (
    <Modal
      title={initial.id ? "编辑商品" : "添加自己的商品"}
      wide
      onClose={onClose}
    >
      <div className="form-stack">
        <div className="config-fields">
          <label className="field">
            商品名称
            <input
              maxLength={200}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          <label className="field">
            SKU
            <input
              value={form.sku}
              onChange={(e) => set("sku", e.target.value)}
            />
          </label>
          <label className="field">
            状态
            <select
              value={form.status}
              onChange={(e) => set("status", e.target.value)}
            >
              <option value="draft">草稿</option>
              <option value="active">使用中</option>
              <option value="archived">归档</option>
            </select>
          </label>
          <label className="field">
            币种
            <select
              value={form.currency}
              onChange={(e) => set("currency", e.target.value)}
            >
              {["USD", "CNY", "GBP", "EUR", "JPY", "SGD", "THB"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          产品说明
          <textarea
            rows={3}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>
        <label className="field">
          卖点（每行一条）
          <textarea
            rows={4}
            value={form.sellingPoints.join("\n")}
            onChange={(e) => set("sellingPoints", e.target.value.split("\n"))}
          />
        </label>
        <div className="field">
          <span>商品图片 · 首图会用于直接生成</span>
          <div className="commerce-assets">
            {form.assetIds.map((id: string) => {
              const a = assets?.find((x) => x.id === id);
              return (
                <div key={id}>
                  {a && <img src={a.url} alt={a.name} />}
                  <button
                    aria-label="移除图片"
                    onClick={() =>
                      set(
                        "assetIds",
                        form.assetIds.filter((v: string) => v !== id),
                      )
                    }
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="inline-actions">
            <FilePicker onPick={attach} />
            <Button onClick={() => setPicker(true)}>从素材库选择</Button>
          </div>
        </div>
        <fieldset className="commerce-fieldset">
          <legend>销售市场</legend>
          <div className="checkbox-grid">
            {markets.map(([v, label]) => (
              <label key={v}>
                <input
                  type="checkbox"
                  checked={form.markets.includes(v)}
                  onChange={(e) =>
                    set(
                      "markets",
                      e.target.checked
                        ? [...form.markets, v]
                        : form.markets.filter((m: string) => m !== v),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          不可承诺的功效 / 内容限制
          <textarea
            rows={3}
            value={form.restrictions}
            onChange={(e) => set("restrictions", e.target.value)}
          />
        </label>
        <fieldset className="commerce-fieldset">
          <legend>单件成本估算（统一币种，缺失请留空）</legend>
          <div className="config-fields">
            {[
              ["price", "售价"],
              ["cost", "采购成本"],
              ["shipping", "物流成本"],
              ["platformFeePercent", "平台费率 %"],
            ].map(([key, label]) => (
              <label className="field" key={key}>
                {label}
                <input
                  type="number"
                  min={0}
                  max={key === "platformFeePercent" ? 100 : 1e9}
                  step="0.01"
                  value={form[key] ?? ""}
                  onChange={(e) =>
                    set(
                      key,
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                />
              </label>
            ))}
          </div>
          <p className="muted">
            只用于人工估算，不计广告、税费、退货及汇率变动，不替代经营利润。
          </p>
        </fieldset>
        <label className="field">
          内部备注
          <textarea
            rows={3}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </label>
        {error && <ErrorBox message={error} />}
        <Button
          variant="primary"
          busy={busy}
          disabled={!form.name.trim()}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api("/commerce/products" + (form.id ? "/" + form.id : ""), {
                method: form.id ? "PATCH" : "POST",
                body: JSON.stringify({
                  ...form,
                  sellingPoints: lines(form.sellingPoints.join("\n")),
                }),
              });
              toast("商品已保存");
              onSaved();
              onClose();
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Save size={15} />
          保存商品
        </Button>
      </div>
      {picker && (
        <AssetPicker
          type="image"
          onClose={() => setPicker(false)}
          onPick={attach}
        />
      )}
    </Modal>
  );
}
export function Products() {
  const { toast } = useApp();
  const [q, setQ] = useState(""),
    [status, setStatus] = useState("all"),
    [editing, setEditing] = useState<Doc | null>(null),
    [launch, setLaunch] = useState<Doc | null>(null);
  const { data, items, reload, error, loading, page, setPage } =
    useCommercePage("products", { q, status });
  return (
    <div className="page">
      <PageHead
        title="我的商品"
        description="整理商品、图片与真实卖点，让选品研究和内容创作使用同一份资料。"
      >
        <Button variant="primary" onClick={() => setEditing({})}>
          <Plus size={15} />
          添加商品
        </Button>
      </PageHead>
      <div className="list-toolbar">
        <div className="input-icon">
          <Search size={16} />
          <input
            aria-label="搜索商品"
            placeholder="商品名称或 SKU"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select
          aria-label="商品状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部状态</option>
          <option value="draft">草稿</option>
          <option value="active">使用中</option>
          <option value="archived">已归档</option>
        </select>
      </div>
      {error && <ErrorBox message={error} />}
      {loading && <div className="loading-line">正在加载商品…</div>}
      <div className="commerce-product-grid">
        {items?.map((p) => (
          <article className="commerce-product" key={p.id}>
            {p.assets[0] ? (
              <img src={p.assets[0].url} alt={p.name} />
            ) : (
              <div className="commerce-placeholder">
                <ShoppingBag size={32} />
              </div>
            )}
            <div>
              <span className="source-tag">
                {p.status === "active"
                  ? "使用中"
                  : p.status === "archived"
                    ? "已归档"
                    : "草稿"}{" "}
                · {p.sku || "未填写 SKU"}
              </span>
              <h3>{p.name}</h3>
              <p>{p.description || "补充商品说明以生成更准确的内容"}</p>
              <small>{p.markets.join(" / ") || "未选择市场"}</small>
              <p>
                {p.estimate
                  ? `单件贡献估算 ${p.currency} ${p.estimate.profit} · ${p.estimate.margin ?? "—"}%`
                  : "成本信息不完整，暂不估算利润"}
              </p>
              <div className="inline-actions">
                <Button onClick={() => setEditing(p)}>编辑</Button>
                <Button variant="primary" onClick={() => setLaunch(p)}>
                  创建视频
                </Button>
                <Button
                  aria-label="删除商品"
                  onClick={async () => {
                    try {
                      await api("/commerce/products/" + p.id, {
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
            </div>
          </article>
        ))}
      </div>
      <CommercePagination
        data={data}
        page={page}
        onPage={setPage}
        loading={loading}
      />
      {data && !loading && !items?.length && (
        <Empty
          title="保存第一个商品"
          description="商品图、卖点和市场会自动带入创作项目；空白成本不会被当作零成本。"
          icon={ShoppingBag}
        />
      )}{" "}
      {editing && (
        <ProductEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => reload()}
        />
      )}{" "}
      {launch && (
        <LaunchProject
          source={{ productId: launch.id }}
          onClose={() => setLaunch(null)}
        />
      )}
    </div>
  );
}
export function EvidenceCards({ evidence }: { evidence: Doc[] }) {
  return (
    <div className="evidence-list">
      {evidence.map((e, i) => {
        const p = e.product || e;
        const comments = e.comments?.data;
        const list = Array.isArray(comments)
          ? comments
          : comments?.comments || comments?.list || [];
        return (
          <article key={i}>
            <strong>
              {p.title || p.product_name || e.title || "研究样本 " + (i + 1)}
            </strong>
            <div className="metric-strip">
              <span>商品 ID {p.id || p.product_id || "—"}</span>
              <span>
                GMV {p.currency || ""} {number(p.gmv ?? p.total_sale_gmv_amt)}
              </span>
            </div>
            <p className="muted">
              {e.detail?.source || e.source || "采集来源"} ·{" "}
              {date(e.detail?.fetchedAt || e.fetchedAt)}
            </p>
            {list.slice(0, 5).map((c: Doc, j: number) => (
              <blockquote key={j}>
                {c.text || c.review_text || c.display_text || "非文本评价"}
                <small> · {c.cid || c.review_id || "评论样本"}</small>
              </blockquote>
            ))}
            {!list.length && (
              <p className="muted">此证据未包含可展示的评论文本。</p>
            )}
          </article>
        );
      })}
    </div>
  );
}
export function Opportunities() {
  const { data: products } = useData("/commerce/products"),
    { data: members } = useData("/commerce/members");
  const { toast } = useApp();
  const [status, setStatus] = useState("all"),
    [owner, setOwner] = useState("all"),
    [selected, setSelected] = useState<Doc | null>(null),
    [launch, setLaunch] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false);
  const { data, items, reload, error, loading, page, setPage } =
    useCommercePage("opportunities", { status, ownerId: owner });
  return (
    <div className="page">
      <PageHead
        title="选品机会"
        description="把真实数据与待验证假设分开记录，跟进研究、商品和视频测试。"
      >
        <Link className="button" to="/automations">
          自动发现机会
        </Link>
        <Button
          variant="primary"
          onClick={() =>
            setSelected({
              title: "",
              summary: "",
              status: "new",
              ownerId: "",
              productId: "",
              notes: "",
              evidence: [],
              analysis: {},
            })
          }
        >
          <Plus size={15} />
          记录机会
        </Button>
      </PageHead>
      <div className="list-toolbar">
        <select
          aria-label="机会状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部状态</option>
          {Object.entries(opportunityStates).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          aria-label="负责人筛选"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        >
          <option value="all">全部负责人</option>
          <option value="">未分配</option>
          {members?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="opportunity-grid">
        {items?.map((o) => (
          <article className="opportunity-card" key={o.id}>
            <div className="section-heading">
              <span className="source-tag">{opportunityStates[o.status]}</span>
              <small>{o.region || "市场未标注"}</small>
            </div>
            <h3>{o.title}</h3>
            <p>{o.summary}</p>
            <div className="metric-strip">
              <span>{o.evidence.length} 组证据</span>
              <span>
                {members?.find((m) => m.id === o.ownerId)?.name || "未分配"}
              </span>
            </div>
            <small>{date(o.updatedAt)}</small>
            <div className="inline-actions">
              <Button onClick={() => setSelected(o)}>研究与跟进</Button>
              <Button onClick={() => setLaunch(o)}>创建测试视频</Button>
              {o.projectId && (
                <Link className="button" to={"/projects?id=" + o.projectId}>
                  关联项目
                </Link>
              )}
            </div>
          </article>
        ))}
      </div>
      <CommercePagination
        data={data}
        page={page}
        onPage={setPage}
        loading={loading}
      />
      {loading && <div className="loading-line">正在加载机会…</div>}
      {data && !loading && !items?.length && (
        <Empty
          title="还没有匹配的机会"
          description="运行一次商品机会扫描，或手动记录有证据的选品假设。"
          icon={ClipboardList}
        />
      )}{" "}
      {selected && (
        <Modal
          title={selected.id ? "机会研究与跟进" : "记录选品机会"}
          wide
          onClose={() => setSelected(null)}
        >
          <div className="form-stack">
            <label className="field">
              标题
              <input
                value={selected.title}
                onChange={(e) =>
                  setSelected({ ...selected, title: e.target.value })
                }
              />
            </label>
            <label className="field">
              机会假设
              <textarea
                rows={3}
                value={selected.summary}
                onChange={(e) =>
                  setSelected({ ...selected, summary: e.target.value })
                }
              />
            </label>
            <div className="config-fields">
              <label className="field">
                状态
                <select
                  value={selected.status}
                  onChange={(e) =>
                    setSelected({ ...selected, status: e.target.value })
                  }
                >
                  {Object.entries(opportunityStates).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                负责人
                <select
                  value={selected.ownerId}
                  onChange={(e) =>
                    setSelected({ ...selected, ownerId: e.target.value })
                  }
                >
                  <option value="">未分配</option>
                  {members?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                关联自有商品
                <select
                  value={selected.productId}
                  onChange={(e) =>
                    setSelected({ ...selected, productId: e.target.value })
                  }
                >
                  <option value="">尚未关联</option>
                  {products?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              研究笔记与测试结论
              <textarea
                rows={5}
                value={selected.notes}
                onChange={(e) =>
                  setSelected({ ...selected, notes: e.target.value })
                }
              />
            </label>
            <Button
              variant="primary"
              busy={busy}
              disabled={!selected.title.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(
                    "/commerce/opportunities" +
                      (selected.id ? "/" + selected.id : ""),
                    {
                      method: selected.id ? "PATCH" : "POST",
                      body: JSON.stringify(selected),
                    },
                  );
                  void reload();
                  setSelected(null);
                  toast("机会跟进已保存");
                } catch (e: any) {
                  toast(e.message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              保存跟进
            </Button>
            {selected.analysis && <ResultView result={selected.analysis} />}
            <h3>来源证据</h3>
            {selected.evidence?.length ? (
              <EvidenceCards evidence={selected.evidence} />
            ) : (
              <p className="muted">
                暂未附带采集证据，请补充研究笔记后再判断。
              </p>
            )}
          </div>
        </Modal>
      )}
      {launch && (
        <LaunchProject
          source={{
            productId: launch.productId,
            opportunityId: launch.id,
            title: launch.title,
          }}
          prompt={launch.summary}
          onClose={() => setLaunch(null)}
        />
      )}
    </div>
  );
}
