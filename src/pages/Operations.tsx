import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Plus,
  Download,
  Check,
  CalendarDays,
  Send,
  Bell,
  RefreshCw,
  Play,
  Pause,
  Trash2,
  ArrowUpRight,
  BarChart3,
  Workflow,
  PackageCheck,
  Video,
  FileSearch,
  Pencil,
} from "lucide-react";
import { api, post, date, number, type Doc } from "../api";
import {
  useData,
  useApp,
  PageHead,
  Button,
  Empty,
  ErrorBox,
  Modal,
  AssetPicker,
  JsonView,
} from "../ui";
import { markets } from "../templates";
import "../operations.css";
const labels: Doc = {
  draft: "待审核",
  approved: "已审核",
  scheduled: "已排期",
  processing: "发布中",
  exported: "已导出",
  published: "已发布",
  inbox: "已送达草稿箱",
  failed: "失败",
  cancelled: "已取消",
  review: "待核对",
  queued: "待执行",
  running: "运行中",
  completed: "完成",
  budget_stopped: "预算已用完",
  interrupted: "已中断",
  collect: "趋势采集",
  opportunity_scan: "机会扫描",
  watch_sync: "监控同步",
  case_collect: "案例采集",
  metrics_sync: "效果回收",
};
function Badge({ value }: { value: string }) {
  return (
    <span className={"ops-badge ops-" + value}>{labels[value] || value}</span>
  );
}
function Pager({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="ops-pager">
      <span>
        共 {total} 条 · 第 {page} 页
      </span>
      <Button disabled={page <= 1} onClick={() => onChange(page - 1)}>
        上一页
      </Button>
      <Button disabled={page * 20 >= total} onClick={() => onChange(page + 1)}>
        下一页
      </Button>
    </div>
  );
}
function useAction(reload: () => unknown) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    act: async (fn: () => Promise<any>, message = "已保存") => {
      setBusy(true);
      try {
        const r = await fn();
        toast(message);
        reload();
        return r;
      } catch (e: any) {
        toast(e.message, true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
  };
}
const initialPublication = {
  title: "",
  assetId: "",
  coverAssetId: "",
  caption: "",
  subtitleSrt: "",
  productId: "",
  projectId: "",
  modelId: "",
  accountId: "",
  privacy: "",
  mode: "export",
  isAigc: true,
  brandContent: false,
  brandOrganic: false,
  disableComment: true,
  disableDuet: true,
  disableStitch: true,
  verifiedVideoUrl: "",
};
function PublicationEditor({
  item,
  onClose,
  onSaved,
}: {
  item: Doc | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Doc>({
      ...initialPublication,
      ...(!item
        ? {
            assetId:
              new URLSearchParams(window.location.search).get("assetId") || "",
          }
        : {}),
      ...item,
    }),
    [pick, setPick] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [creator, setCreator] = useState<Doc | null>(null);
  const { data: accounts } = useData<Doc[]>("/records/account"),
    { data: products } = useData<Doc>("/commerce/products?pageSize=100"),
    { data: projects } = useData<any>("/projects"),
    { data: settings } = useData<Doc>("/operations/settings");
  const field = (key: string, value: any) =>
    setForm((f) => ({ ...f, [key]: value }));
  return (
    <Modal
      title={item ? "编辑发布记录" : "新建发布记录"}
      onClose={onClose}
      wide
    >
      <form
        className="ops-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(item ? "/publications/" + item.id : "/publications", {
              method: item ? "PATCH" : "POST",
              body: JSON.stringify(form),
            });
            onSaved();
            onClose();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          记录名称
          <input
            required
            maxLength={200}
            value={form.title}
            onChange={(e) => field("title", e.target.value)}
            placeholder="例如：收纳盒 · 美国英语 · 开箱版本 A"
          />
        </label>
        <div className="ops-form-grid">
          <div className="field">
            视频素材
            <Button type="button" onClick={() => setPick("video")}>
              <Video size={16} />
              {form.assetId ? "更换已选视频" : "选择成片"}
            </Button>
            {form.assetId && (
              <small>已关联素材 {form.assetId.slice(0, 8)}</small>
            )}
          </div>
          <div className="field">
            封面
            <Button type="button" onClick={() => setPick("image")}>
              {form.coverAssetId ? "更换封面" : "选择封面（可选）"}
            </Button>
            <small>未选择时，导出包自动提取视频首帧。</small>
          </div>
        </div>
        <label className="field">
          发布文案
          <textarea
            rows={4}
            maxLength={2200}
            value={form.caption}
            onChange={(e) => field("caption", e.target.value)}
          />
          <small>{form.caption.length}/2200</small>
        </label>
        <label className="field">
          字幕 SRT（可选）
          <textarea
            rows={3}
            value={form.subtitleSrt}
            onChange={(e) => field("subtitleSrt", e.target.value)}
            placeholder="可留空，优先使用后期工作台生成的字幕。"
          />
        </label>
        <div className="ops-form-grid">
          <label className="field">
            关联商品
            <select
              value={form.productId}
              onChange={(e) => field("productId", e.target.value)}
            >
              <option value="">暂不关联</option>
              {(Array.isArray(products) ? products : products?.items || []).map(
                (p: Doc) => (
                  <option value={p.id} key={p.id}>
                    {p.title || p.name}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="field">
            关联项目
            <select
              value={form.projectId}
              onChange={(e) => field("projectId", e.target.value)}
            >
              <option value="">暂不关联</option>
              {(Array.isArray(projects) ? projects : projects?.items || []).map(
                (p: Doc) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="field">
            模型标识
            <input
              value={form.modelId}
              onChange={(e) => field("modelId", e.target.value)}
              placeholder="例如 kie-seedance-mini"
            />
          </label>
          <label className="field">
            发布方式
            <select
              value={form.mode}
              onChange={(e) => field("mode", e.target.value)}
            >
              <option value="export">导出发布包</option>
              {settings?.settings.tiktokDirectEnabled && (
                <option value="direct">TikTok 官方直发</option>
              )}
              {settings?.settings.tiktokInboxEnabled && (
                <option value="inbox">TikTok 草稿箱</option>
              )}
            </select>
          </label>
        </div>
        <label className="field">
          关联 TikTok 账号
          <select
            value={form.accountId}
            onChange={(e) => {
              field("accountId", e.target.value);
              field("privacy", "");
              setCreator(null);
            }}
          >
            <option value="">暂不关联（导出可用）</option>
            {accounts?.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <small>已授权账号可回收作品播放和互动指标。</small>
        </label>
        {form.mode !== "export" && (
          <>
            <Button
              type="button"
              disabled={!form.accountId}
              onClick={async () => {
                try {
                  setCreator(
                    await post(`/tiktok/${form.accountId}/creator-info`),
                  );
                  field("privacy", "");
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              载入账号发布选项
            </Button>
            {creator && (
              <div className="ops-note">
                发布账号：{creator.creator_nickname} · 最长{" "}
                {creator.max_video_post_duration_sec} 秒
              </div>
            )}
            <div className="ops-form-grid">
              <label className="field">
                可见范围
                <select
                  value={form.privacy}
                  onChange={(e) => field("privacy", e.target.value)}
                >
                  <option value="">请载入账号选项并主动选择</option>
                  {(creator?.privacy_level_options || []).map(
                    (value: string) => (
                      <option key={value} value={value}>
                        {{
                          SELF_ONLY: "仅自己",
                          PUBLIC_TO_EVERYONE: "所有人",
                          MUTUAL_FOLLOW_FRIENDS: "互相关注好友",
                          FOLLOWER_OF_CREATOR: "粉丝",
                        }[value] || value}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="field">
                托管视频 URL（可选）
                <input
                  type="url"
                  value={form.verifiedVideoUrl}
                  onChange={(e) => field("verifiedVideoUrl", e.target.value)}
                  placeholder="已在 TikTok 验证的媒体地址"
                />
              </label>
            </div>
            <div className="ops-checks">
              {[
                ["disableComment", "关闭评论"],
                ["disableDuet", "关闭合拍"],
                ["disableStitch", "关闭拼接"],
                ["brandContent", "品牌合作内容"],
                ["brandOrganic", "推广自有品牌"],
              ].map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={form[key]}
                    disabled={
                      (key === "disableComment" && creator?.comment_disabled) ||
                      (key === "disableDuet" && creator?.duet_disabled) ||
                      (key === "disableStitch" && creator?.stitch_disabled)
                    }
                    onChange={(e) => field(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </>
        )}
        <label className="ops-check">
          <input
            type="checkbox"
            checked={form.isAigc}
            onChange={(e) => field("isAigc", e.target.checked)}
          />
          标记为 AI 生成内容
        </label>
        {error && <ErrorBox message={error} />}
        <div className="ops-actions">
          <Button type="button" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!form.assetId}
          >
            保存为待审核
          </Button>
        </div>
      </form>
      {pick && (
        <AssetPicker
          type={pick}
          onClose={() => setPick("")}
          onPick={(a) => {
            field(pick === "video" ? "assetId" : "coverAssetId", a.id);
            if (!form.title) field("title", a.name);
          }}
        />
      )}
    </Modal>
  );
}
function MetricTrend({ history }: { history: Doc[] }) {
  const [field, setField] = useState("views"),
    points = history
      .filter((h) => h.metrics?.[field] != null)
      .slice()
      .reverse();
  const max = Math.max(1, ...points.map((p) => Number(p.metrics[field]))),
    width = 620,
    height = 160;
  const line = points
    .map(
      (p, i) =>
        `${30 + (points.length < 2 ? 0 : i / (points.length - 1)) * 560},${130 - (Number(p.metrics[field]) / max) * 100}`,
    )
    .join(" ");
  return (
    <div className="ops-trend">
      <div className="ops-section-head">
        <h3>指标趋势</h3>
        <select
          aria-label="趋势指标"
          value={field}
          onChange={(e) => setField(e.target.value)}
        >
          {[
            ["views", "播放"],
            ["likes", "点赞"],
            ["comments", "评论"],
            ["shares", "分享"],
          ].map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {points.length ? (
        <>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${points.length} 个已保存快照的指标变化`}
          >
            <line x1="30" y1="130" x2="590" y2="130" stroke="#e2e5eb" />
            <text x="4" y="35" fill="#7d8491" fontSize="11">
              {number(max)}
            </text>
            <text x="8" y="133" fill="#7d8491" fontSize="11">
              0
            </text>
            <polyline
              points={line}
              fill="none"
              stroke="#7560d3"
              strokeWidth="2.5"
            />
            {points.map((p, i) => (
              <circle
                key={p.id || i}
                cx={
                  30 + (points.length < 2 ? 0 : i / (points.length - 1)) * 560
                }
                cy={130 - (Number(p.metrics[field]) / max) * 100}
                r="3.5"
                fill="#7560d3"
              >
                <title>
                  {date(p.observed_at)} · {number(p.metrics[field])} ·{" "}
                  {p.source === "tiktok" ? "TikTok" : "手工"}
                </title>
              </circle>
            ))}
          </svg>
          <div className="ops-section-head muted">
            <small>{date(points[0].observed_at)}</small>
            <small>{date(points[points.length - 1].observed_at)}</small>
          </div>
        </>
      ) : (
        <p className="muted">此指标尚无快照。同步或登记后展示真实观测点。</p>
      )}
      <small className="muted">
        每个点对应已保存的累计指标，未补造历史数据；按观测顺序展示。
      </small>
    </div>
  );
}
function ContentComparison() {
  const [group, setGroup] = useState("product");
  const { data, error } = useData<Doc>("/content-comparison?groupBy=" + group);
  return (
    <section className="ops-section">
      <div className="ops-section-head">
        <h2>效果与制作估算比较</h2>
        <select
          aria-label="比较维度"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          {[
            ["product", "按商品"],
            ["project", "按项目"],
            ["script", "按脚本版本"],
            ["model", "按模型"],
          ].map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">{data?.note}</p>
      {data?.limited && (
        <p className="ops-note">
          当前比较最近 {data.sampleSize} 条，共 {data.total} 条作品。
        </p>
      )}
      {error && <ErrorBox message={error} />}{" "}
      {data?.groups.length ? (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>分组</th>
                <th>作品 / 有指标</th>
                <th>累计播放</th>
                <th>点赞 / 评论 / 分享</th>
                <th>已知生成估算</th>
                <th>费用未知成片</th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g: Doc) => (
                <tr key={g.key}>
                  <td>{g.label}</td>
                  <td>
                    {g.works} / {g.withMetrics}
                  </td>
                  <td>{number(g.views)}</td>
                  <td>
                    {number(g.likes)} / {number(g.comments)} /{" "}
                    {number(g.shares)}
                  </td>
                  <td>
                    {Object.entries(g.estimatedByCurrency).length
                      ? Object.entries(g.estimatedByCurrency).map(
                          ([currency, amount]) => (
                            <span key={currency}>
                              {Number(amount).toFixed(4)} {currency}
                              <br />
                            </span>
                          ),
                        )
                      : "未知"}
                  </td>
                  <td>
                    {g.unknownCostCount} / {g.distinctProductionCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">
          有发布记录后即可按关联商品、项目、脚本版本和模型比较。
        </p>
      )}
    </section>
  );
}
function PublicationDetails({
  item,
  onClose,
  reload,
}: {
  item: Doc;
  onClose: () => void;
  reload: () => void;
}) {
  const { data: assets } = useData<Doc[]>("/records/asset"),
    [confirm, setConfirm] = useState(false),
    [url, setUrl] = useState(item.externalUrl || ""),
    [runAt, setRunAt] = useState(""),
    [preflight, setPreflight] = useState<Doc | null>(null),
    [metric, setMetric] = useState({
      views: "",
      likes: "",
      comments: "",
      shares: "",
      orders: "",
      gmv: "",
      currency: "USD",
      note: "",
    });
  const { data: history, reload: reloadMetrics } = useData<Doc[]>(
    "/publications/" + item.id + "/metrics",
  );
  const { busy, act } = useAction(reload),
    video = assets?.find((a) => a.id === item.assetId);
  return (
    <Modal title={item.title} onClose={onClose} wide>
      <div className="ops-detail">
        <div>
          {video && (
            <video
              className="ops-video"
              src={video.url}
              controls
              preload="metadata"
            />
          )}
          <p>{item.caption || "未填写文案"}</p>
          <div className="ops-actions">
            <Badge value={item.status} />
            <span className="muted">
              {date(item.scheduledAt || item.createdAt)}
            </span>
          </div>
          {item.lastError && <ErrorBox message={item.lastError} />}
        </div>
        <div className="ops-detail-panel">
          {["draft", "failed", "cancelled", "exported", "approved"].includes(
            item.status,
          ) && (
            <>
              <label className="ops-check">
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(e) => setConfirm(e.target.checked)}
                />
                我已检查视频、文案、品牌信息及 AI 标记
              </label>
              <Button
                variant="primary"
                busy={busy}
                disabled={!confirm}
                onClick={() =>
                  act(
                    () =>
                      post(`/publications/${item.id}/approve`, {
                        confirm: true,
                      }),
                    "当前版本已审核",
                  )
                }
              >
                <Check size={16} />
                审核此版本
              </Button>
            </>
          )}
          {["approved", "exported", "published"].includes(item.status) && (
            <Button
              variant="primary"
              busy={busy}
              onClick={() =>
                act(async () => {
                  const response = await fetch(
                    `/api/publications/${item.id}/export`,
                    { method: "POST" },
                  );
                  if (!response.ok)
                    throw new Error((await response.json()).error);
                  const blob = await response.blob(),
                    url = URL.createObjectURL(blob),
                    a = document.createElement("a");
                  a.href = url;
                  a.download = `x-ecommerce-${item.id}.zip`;
                  a.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                }, "发布包已导出")
              }
            >
              <Download size={16} />
              下载完整发布包
            </Button>
          )}
          {item.mode !== "export" && item.status === "approved" && (
            <>
              <Button
                busy={busy}
                onClick={async () => {
                  const r = await act(
                    () => post(`/publications/${item.id}/preflight`),
                    "发布前检查完成",
                  );
                  if (r) setPreflight(r);
                }}
              >
                检查账号与视频
              </Button>
              {preflight && (
                <div className="ops-note">
                  账号：{preflight.account?.name}
                  <br />
                  最长：{preflight.media?.maxDuration} 秒 · 当前：
                  {preflight.media?.duration?.toFixed(1)} 秒<br />
                  {preflight.note}
                </div>
              )}
              <label className="field">
                排期（留空立即提交）
                <input
                  type="datetime-local"
                  value={runAt}
                  onChange={(e) => setRunAt(e.target.value)}
                />
              </label>
              <Button
                variant="primary"
                busy={busy}
                disabled={!confirm}
                onClick={() =>
                  act(
                    () =>
                      post(`/publications/${item.id}/dispatch`, {
                        confirm: true,
                        ...(runAt
                          ? { runAt: new Date(runAt).toISOString() }
                          : {}),
                      }),
                    "发布任务已创建",
                  )
                }
              >
                <Send size={15} />
                {runAt ? "确认排期" : "确认提交"}
              </Button>
            </>
          )}
          {item.status === "scheduled" && (
            <>
              <label className="field">
                改期
                <input
                  type="datetime-local"
                  value={runAt}
                  onChange={(e) => setRunAt(e.target.value)}
                />
              </label>
              <Button
                disabled={!runAt}
                busy={busy}
                onClick={() =>
                  act(
                    () =>
                      post(`/publications/${item.id}/reschedule`, {
                        confirm: true,
                        runAt: new Date(runAt).toISOString(),
                      }),
                    "排期已更新",
                  )
                }
              >
                保存新排期
              </Button>
            </>
          )}
          {["draft", "approved", "scheduled", "failed", "exported"].includes(
            item.status,
          ) && (
            <Button
              busy={busy}
              onClick={() =>
                act(() => post(`/publications/${item.id}/cancel`), "记录已取消")
              }
            >
              取消记录或待执行排期
            </Button>
          )}
          {!["processing", "review", "scheduled"].includes(item.status) && (
            <>
              <hr />
              <label className="field">
                登记已发布作品
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.tiktok.com/@账号/video/作品ID"
                />
              </label>
              <Button
                disabled={!url}
                busy={busy}
                onClick={() =>
                  act(
                    () => post(`/publications/${item.id}/manual`, { url }),
                    "作品链接已登记",
                  )
                }
              >
                <ArrowUpRight size={15} />
                登记真实作品链接
              </Button>
            </>
          )}
        </div>
      </div>
      <section className="ops-section">
        <h3>作品指标</h3>
        {history && <MetricTrend history={history} />}
        <p className="muted">
          自动同步读取已授权账号的播放互动。订单和 GMV
          需要登记来源；未获取的数值保持未知。
        </p>
        <div className="ops-form-grid">
          {[
            ["views", "播放"],
            ["likes", "点赞"],
            ["comments", "评论"],
            ["shares", "分享"],
            ["orders", "订单"],
            ["gmv", "GMV"],
          ].map(([key, label]) => (
            <label className="field" key={key}>
              {label}
              <input
                type="number"
                min="0"
                step={key === "gmv" ? "0.01" : "1"}
                value={(metric as Doc)[key]}
                placeholder="未知"
                onChange={(e) =>
                  setMetric((m) => ({ ...m, [key]: e.target.value }))
                }
              />
            </label>
          ))}
          <label className="field">
            GMV 币种
            <input
              value={metric.currency}
              onChange={(e) =>
                setMetric((m) => ({ ...m, currency: e.target.value }))
              }
            />
          </label>
          <label className="field">
            数据来源/备注
            <input
              value={metric.note}
              onChange={(e) =>
                setMetric((m) => ({ ...m, note: e.target.value }))
              }
              placeholder="例如店铺后台，统计区间…"
            />
          </label>
        </div>
        <Button
          busy={busy}
          onClick={() =>
            act(async () => {
              const body = Object.fromEntries(
                Object.entries(metric).map(([k, v]) => [
                  k,
                  ["currency", "note"].includes(k)
                    ? v
                    : v === ""
                      ? null
                      : Number(v),
                ]),
              );
              await post(`/publications/${item.id}/metrics`, body);
              reloadMetrics();
            }, "指标快照已保存")
          }
        >
          保存手工指标快照
        </Button>
        {history?.length ? (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>观测时间</th>
                  <th>来源</th>
                  <th>播放</th>
                  <th>点赞</th>
                  <th>订单</th>
                  <th>GMV</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{date(h.observed_at)}</td>
                    <td>{h.source === "tiktok" ? "TikTok" : "手工登记"}</td>
                    <td>{number(h.metrics.views)}</td>
                    <td>{number(h.metrics.likes)}</td>
                    <td>{number(h.metrics.orders)}</td>
                    <td>
                      {h.metrics.gmv == null
                        ? "—"
                        : number(h.metrics.gmv) +
                          " " +
                          (h.metrics.currency || "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">尚无指标快照。</p>
        )}
      </section>
    </Modal>
  );
}
function PublishingSettings({ onClose }: { onClose: () => void }) {
  const { data, reload, error } = useData<Doc>("/operations/settings"),
    [form, setForm] = useState<Doc | null>(null);
  const { busy, act } = useAction(reload);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);
  return (
    <Modal title="发布渠道设置" onClose={onClose}>
      {error && <ErrorBox message={error} />}{" "}
      {form && (
        <div className="ops-form">
          <p className="muted">
            导出包始终可用。官方接口开关仅记录本工作空间配置，不代表 TikTok
            已批准应用。团队内部工具默认关闭。
          </p>
          <label className="ops-check">
            <input
              type="checkbox"
              checked={form.tiktokDirectEnabled}
              onChange={(e) =>
                setForm({ ...form, tiktokDirectEnabled: e.target.checked })
              }
            />
            已确认应用具备官方直发资格
          </label>
          <label className="ops-check">
            <input
              type="checkbox"
              checked={form.tiktokInboxEnabled}
              onChange={(e) =>
                setForm({ ...form, tiktokInboxEnabled: e.target.checked })
              }
            />
            已确认应用具备草稿箱上传资格
          </label>
          <label className="field">
            资格与适用范围
            <textarea
              rows={3}
              value={form.tiktokQualificationNote}
              onChange={(e) =>
                setForm({ ...form, tiktokQualificationNote: e.target.value })
              }
              placeholder="填写实际审核状态、授权范围或测试资格。"
            />
          </label>
          <label className="field">
            已验证托管媒体 URL 前缀
            <input
              value={form.verifiedMediaPrefix}
              onChange={(e) =>
                setForm({ ...form, verifiedMediaPrefix: e.target.value })
              }
              placeholder="https://media.example.com/videos/"
            />
            <small>
              仅填写已在 TikTok 开发者平台验证的地址；未配置时使用文件上传。
            </small>
          </label>
          <Button
            busy={busy}
            variant="primary"
            onClick={() =>
              act(
                () =>
                  api("/operations/settings", {
                    method: "PUT",
                    body: JSON.stringify({
                      tiktokDirectEnabled: form.tiktokDirectEnabled,
                      tiktokInboxEnabled: form.tiktokInboxEnabled,
                      tiktokQualificationNote: form.tiktokQualificationNote,
                      verifiedMediaPrefix: form.verifiedMediaPrefix,
                    }),
                  }),
                "发布渠道设置已保存",
              )
            }
          >
            保存设置
          </Button>
          <a
            href="https://developers.tiktok.com/docs/en/content-sharing-guidelines"
            target="_blank"
            rel="noreferrer"
          >
            查看 TikTok 官方应用与发布要求
          </a>
        </div>
      )}
    </Modal>
  );
}
export function PublishingCenter() {
  const [page, setPage] = useState(1),
    [status, setStatus] = useState(""),
    [q, setQ] = useState(""),
    [editor, setEditor] = useState<Doc | null | undefined>(() =>
      new URLSearchParams(window.location.search).has("assetId")
        ? null
        : undefined,
    ),
    [selected, setSelected] = useState<Doc | null>(null),
    [tab, setTab] = useState("list"),
    [showSettings, setShowSettings] = useState(false);
  const { data, reload, error, loading } = useData<Doc>(
    `/publications?page=${page}&q=${encodeURIComponent(q)}${status ? "&status=" + status : ""}`,
    10000,
  );
  const { busy, act } = useAction(reload);
  useEffect(() => {
    if (selected) {
      const next = data?.items.find((p: Doc) => p.id === selected.id);
      if (next) setSelected(next);
    }
  }, [data]);
  return (
    <div className="page ops-page">
      <PageHead
        title="发布中心"
        description="审核成片，导出发布包，登记作品并持续回收效果。"
      >
        <Button onClick={() => setShowSettings(true)}>发布渠道设置</Button>
        <Button variant="primary" onClick={() => setEditor(null)}>
          <Plus size={16} />
          新建发布记录
        </Button>
      </PageHead>
      <div className="ops-note">
        <PackageCheck size={18} />
        <span>
          团队自用默认导出视频、封面、字幕和文案。官方直发或草稿箱仅在管理员确认应用资格后启用。
          <Link to="/account">管理已连接账号</Link>
        </span>
      </div>
      <div className="ops-toolbar">
        <input
          aria-label="搜索发布记录"
          placeholder="搜索发布名称"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="发布状态"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">所有状态</option>
          {Object.entries(labels)
            .filter(([k]) =>
              [
                "draft",
                "approved",
                "scheduled",
                "processing",
                "exported",
                "published",
                "failed",
                "review",
                "inbox",
                "cancelled",
              ].includes(k),
            )
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v as string}
              </option>
            ))}
        </select>
        <Button onClick={() => setTab(tab === "list" ? "calendar" : "list")}>
          <CalendarDays size={16} />
          {tab === "list" ? "按日期查看" : "列表视图"}
        </Button>
        <Button onClick={reload}>
          <RefreshCw size={16} />
        </Button>
      </div>
      {error && <ErrorBox message={error} retry={reload} />}{" "}
      {loading && !data && <p>正在加载发布记录…</p>}
      {data?.items.length ? (
        <div
          className={tab === "calendar" ? "ops-calendar" : "ops-publications"}
        >
          {data.items.map((p: Doc) => (
            <article key={p.id} className="ops-record">
              {tab === "calendar" && (
                <div className="ops-calendar-date">
                  {date(p.scheduledAt || p.publishedAt || p.createdAt)}
                </div>
              )}
              <div className="ops-record-top">
                <Badge value={p.status} />
                <small>
                  {p.mode === "export"
                    ? "导出发布"
                    : p.mode === "inbox"
                      ? "TikTok 草稿"
                      : "官方直发"}
                </small>
              </div>
              <button
                className="ops-record-title"
                onClick={() => setSelected(p)}
              >
                {p.title}
              </button>
              <p>{p.caption || "尚未填写文案"}</p>
              <div className="ops-actions">
                <Button onClick={() => setSelected(p)}>查看与审核</Button>
                {[
                  "draft",
                  "approved",
                  "cancelled",
                  "failed",
                  "exported",
                ].includes(p.status) && (
                  <Button
                    onClick={() => setEditor(p)}
                    aria-label="编辑发布记录"
                  >
                    <Pencil size={15} />
                  </Button>
                )}
                {!["processing", "review", "scheduled"].includes(p.status) && (
                  <Button
                    busy={busy}
                    onClick={() =>
                      act(
                        () =>
                          api(`/publications/${p.id}`, { method: "DELETE" }),
                        "发布记录已删除",
                      )
                    }
                    aria-label="删除发布记录"
                  >
                    <Trash2 size={15} />
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        data && (
          <Empty
            icon={Send}
            title="让成片进入发布流程"
            description="选择已完成的视频，审核文案后下载完整发布包。"
          >
            <Button variant="primary" onClick={() => setEditor(null)}>
              创建第一条发布记录
            </Button>
          </Empty>
        )
      )}
      {data && <Pager page={page} total={data.total} onChange={setPage} />}
      {editor !== undefined && (
        <PublicationEditor
          item={editor}
          onClose={() => setEditor(undefined)}
          onSaved={reload}
        />
      )}{" "}
      {selected && (
        <PublicationDetails
          item={selected}
          onClose={() => setSelected(null)}
          reload={reload}
        />
      )}{" "}
      {showSettings && (
        <PublishingSettings onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
export function ContentAnalytics() {
  const [page, setPage] = useState(1),
    [q, setQ] = useState(""),
    [model, setModel] = useState(""),
    [account, setAccount] = useState(""),
    [product, setProduct] = useState(""),
    [project, setProject] = useState(""),
    [selected, setSelected] = useState<Doc | null>(null);
  const { data: accounts } = useData<Doc[]>("/records/account"),
    { data: products } = useData<Doc[]>("/commerce/products"),
    { data: projects } = useData<Doc[]>("/projects");
  const { data, error, reload } = useData<Doc>(
    `/content-analytics?page=${page}&q=${encodeURIComponent(q)}&modelId=${encodeURIComponent(model)}&accountId=${encodeURIComponent(account)}&productId=${encodeURIComponent(product)}&projectId=${encodeURIComponent(project)}`,
  );
  return (
    <div className="page ops-page">
      <PageHead
        title="内容效果"
        description="按作品比较播放、互动与手工登记的成交数据。"
      >
        <Link className="button" to="/automations">
          配置效果回收
        </Link>
      </PageHead>
      <div className="ops-toolbar">
        <input
          aria-label="搜索作品"
          placeholder="搜索作品"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <input
          aria-label="模型筛选"
          placeholder="按模型标识筛选"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="筛选账号"
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部账号</option>
          {accounts?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选商品"
          value={product}
          onChange={(e) => {
            setProduct(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部商品</option>
          {products?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选项目"
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部项目</option>
          {projects?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <Button onClick={reload}>
          <RefreshCw size={16} />
          刷新
        </Button>
      </div>
      {error && <ErrorBox message={error} />}
      <p className="muted">{data?.note}</p>
      {data?.items.length ? (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>作品 / 关联</th>
                <th>状态</th>
                <th>播放</th>
                <th>点赞</th>
                <th>评论</th>
                <th>分享</th>
                <th>订单</th>
                <th>GMV</th>
                <th>生成估算</th>
                <th>更新</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p: Doc) => (
                <tr key={p.id}>
                  <td>
                    <button
                      className="ops-text-button"
                      onClick={() => setSelected(p)}
                    >
                      {p.title}
                    </button>
                    <small>
                      {[
                        p.modelId,
                        p.productId ? "商品 " + p.productId.slice(0, 8) : null,
                        p.projectId ? "项目 " + p.projectId.slice(0, 8) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "未关联商品或项目"}
                    </small>
                  </td>
                  <td>
                    <Badge value={p.status} />
                  </td>
                  {["views", "likes", "comments", "shares", "orders"].map(
                    (k) => (
                      <td key={k}>{number(p.metrics?.[k])}</td>
                    ),
                  )}
                  <td>
                    {p.metrics?.gmv == null
                      ? "—"
                      : number(p.metrics.gmv) +
                        " " +
                        (p.metrics.currency || "")}
                  </td>
                  <td>
                    {p.attribution?.estimate?.amount == null
                      ? "未知"
                      : Number(p.attribution.estimate.amount).toFixed(4) +
                        " " +
                        p.attribution.estimate.currency}
                    <small>计划估算，实际账单未知</small>
                  </td>
                  <td>
                    {date(p.observedAt)}
                    <small>
                      {p.metricSource === "tiktok"
                        ? "TikTok"
                        : p.metricSource === "manual"
                          ? "手工登记"
                          : "尚无数据"}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        data && (
          <Empty
            icon={BarChart3}
            title="尚无作品可比较"
            description="先在发布中心登记作品，关联账号后定时同步或手工填写指标。"
          >
            <Link className="button primary" to="/publish">
              前往发布中心
            </Link>
          </Empty>
        )
      )}
      {data && <Pager page={page} total={data.total} onChange={setPage} />}
      <ContentComparison />{" "}
      {selected && (
        <PublicationDetails
          item={selected}
          onClose={() => setSelected(null)}
          reload={reload}
        />
      )}
    </div>
  );
}
const templateNames: Doc = {
  collect: "每日趋势采集",
  opportunity_scan: "评论机会扫描",
  watch_sync: "监控变化",
  case_collect: "销售案例采集",
  metrics_sync: "作品效果回收",
};
function AutomationEditor({
  item,
  onClose,
  onSaved,
}: {
  item: Doc | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Doc>({
      name: "每日趋势采集",
      kind: "collect",
      intervalMinutes: 1440,
      enabled: true,
      ...item,
      input: JSON.stringify(
        item?.input || { region: "US", maxPages: 2 },
        null,
        2,
      ),
      maxRequests: item?.budget?.maxRequests || 30,
      dailyRequestLimit: item?.budget?.dailyRequestLimit || 100,
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const f = (k: string, v: any) => setForm((x) => ({ ...x, [k]: v }));
  let params: Doc = {};
  try {
    params = JSON.parse(form.input);
  } catch {}
  const param = (k: string, v: any) =>
    f("input", JSON.stringify({ ...params, [k]: v }, null, 2));
  const { data: watches } = useData<Doc[]>("/commerce/watches"),
    { data: accounts } = useData<Doc[]>("/records/account");
  return (
    <Modal title={item ? "编辑研究自动化" : "创建研究自动化"} onClose={onClose}>
      <form
        className="ops-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setBusy(true);
          try {
            const body = {
              name: form.name,
              kind: form.kind,
              intervalMinutes: Number(form.intervalMinutes),
              enabled: form.enabled,
              input: JSON.parse(form.input),
              budget: {
                maxRequests: Number(form.maxRequests),
                dailyRequestLimit: Number(form.dailyRequestLimit),
              },
            };
            await api(item ? "/automations/" + item.id : "/automations", {
              method: item ? "PATCH" : "POST",
              body: JSON.stringify(body),
            });
            onSaved();
            onClose();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          模板
          <select
            value={form.kind}
            onChange={(e) => {
              f("kind", e.target.value);
              if (!item) f("name", templateNames[e.target.value]);
              f(
                "input",
                JSON.stringify(
                  e.target.value === "watch_sync"
                    ? { maxWatches: 5 }
                    : e.target.value === "metrics_sync"
                      ? { maxPages: 3 }
                      : e.target.value === "opportunity_scan"
                        ? { region: "US", maxProducts: 3, maxPages: 1 }
                        : { region: "US", maxPages: 2 },
                  null,
                  2,
                ),
              );
            }}
          >
            {Object.entries(templateNames).map(([k, v]) => (
              <option key={k} value={k}>
                {v as string}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          名称
          <input
            required
            value={form.name}
            onChange={(e) => f("name", e.target.value)}
          />
        </label>
        <div className="ops-form-grid">
          <label className="field">
            运行间隔（分钟）
            <input
              type="number"
              min="15"
              max="43200"
              value={form.intervalMinutes}
              onChange={(e) => f("intervalMinutes", e.target.value)}
            />
          </label>
          <label className="field">
            单次请求上限
            <input
              type="number"
              min="1"
              max="500"
              value={form.maxRequests}
              onChange={(e) => f("maxRequests", e.target.value)}
            />
          </label>
          <label className="field">
            此自动化每日上限（UTC）
            <input
              type="number"
              min="1"
              max="10000"
              value={form.dailyRequestLimit}
              onChange={(e) => f("dailyRequestLimit", e.target.value)}
            />
          </label>
        </div>
        <div className="ops-form-grid">
          {["collect", "opportunity_scan", "case_collect"].includes(
            form.kind,
          ) && (
            <label className="field">
              目标市场
              <select
                value={params.region || "US"}
                onChange={(e) => param("region", e.target.value)}
              >
                {markets.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {["collect", "opportunity_scan", "metrics_sync"].includes(
            form.kind,
          ) && (
            <label className="field">
              每个对象最多采集页数
              <input
                type="number"
                min="1"
                max="10"
                value={params.maxPages || 1}
                onChange={(e) => param("maxPages", Number(e.target.value))}
              />
            </label>
          )}
          {form.kind === "opportunity_scan" && (
            <label className="field">
              深入研究商品数
              <input
                type="number"
                min="1"
                max="10"
                value={params.maxProducts || 3}
                onChange={(e) => param("maxProducts", Number(e.target.value))}
              />
            </label>
          )}
          {form.kind === "case_collect" && (
            <label className="field">
              最多保存案例数
              <input
                type="number"
                min="1"
                max="10"
                value={params.maxVideos || 5}
                onChange={(e) => param("maxVideos", Number(e.target.value))}
              />
            </label>
          )}
          {form.kind === "watch_sync" && (
            <>
              <label className="field">
                监控对象
                <select
                  value={params.watchId || ""}
                  onChange={(e) => param("watchId", e.target.value)}
                >
                  <option value="">所有已启用监控（按上限）</option>
                  {watches?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                每次最多同步对象数
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={params.maxWatches || 5}
                  onChange={(e) => param("maxWatches", Number(e.target.value))}
                />
              </label>
            </>
          )}
          {form.kind === "metrics_sync" && (
            <label className="field">
              作品账号
              <select
                value={params.accountId || ""}
                onChange={(e) => param("accountId", e.target.value)}
              >
                <option value="">全部已授权账号</option>
                {accounts?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <details>
          <summary>高级采集筛选</summary>
          <label className="field">
            其他接口筛选参数
            <textarea
              className="ops-code"
              rows={6}
              value={form.input}
              onChange={(e) => f("input", e.target.value)}
            />
            <small>可保留已保存的特定排行榜或筛选条件。</small>
          </label>
        </details>
        <label className="ops-check">
          <input
            type="checkbox"
            checked={!!form.enabled}
            onChange={(e) => f("enabled", e.target.checked)}
          />
          启用定时研究
        </label>
        <div className="ops-note">
          仅运行数据研究和效果同步。视频、超分和发布需要人工确认。
        </div>
        {error && <ErrorBox message={error} />}
        <Button variant="primary" type="submit" busy={busy}>
          保存自动化
        </Button>
      </form>
    </Modal>
  );
}
function RunDetails({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useData<Doc>("/research-runs/" + id);
  return (
    <Modal title="研究运行证据" onClose={onClose} wide>
      {error && <ErrorBox message={error} />}{" "}
      {data && (
        <>
          <div className="ops-actions">
            <Badge value={data.status} />
            <span>
              {data.request_count} / {data.max_requests} 次外发请求
            </span>
            <span>{date(data.created_at)}</span>
          </div>
          {data.error && <ErrorBox message={data.error} />}
          <h3>结果</h3>
          <JsonView
            value={
              data.result || {
                note: "本次未形成完整结果；已获取证据保存在下方。",
              }
            }
          />
          <h3>已取得的证据</h3>
          <JsonView value={data.evidence} />
          <h3>请求记录</h3>
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>服务</th>
                  <th>接口</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map((r: Doc, i: number) => (
                  <tr key={i}>
                    <td>{r.provider}</td>
                    <td>{r.endpoint}</td>
                    <td>{r.status}</td>
                    <td>{date(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
export function AutomationCenter() {
  const [editor, setEditor] = useState<Doc | null | undefined>(undefined),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState(1),
    [tab, setTab] = useState("automations"),
    [monthly, setMonthly] = useState(3000),
    [automationPage, setAutomationPage] = useState(1);
  const {
      data: automationsPage,
      error,
      reload,
    } = useData<Doc>("/automations?page=" + automationPage, 10000),
    { data: runs, reload: reloadRuns } = useData<Doc>(
      "/research-runs?page=" + page,
      10000,
    ),
    { data: notifications, reload: reloadNotifications } = useData<Doc>(
      "/notifications",
      10000,
    ),
    { data: settings, reload: reloadSettings } = useData<Doc>(
      "/operations/settings",
    );
  const automations: Doc[] | undefined = automationsPage?.items;
  const { busy, act } = useAction(() => {
    reload();
    reloadRuns();
    reloadNotifications();
    reloadSettings();
  });
  useEffect(() => {
    if (settings) setMonthly(settings.settings.monthlyRequestLimit);
  }, [settings]);
  return (
    <div className="page ops-page">
      <PageHead
        title="自动化研究"
        description="持续收集证据，发现变化，把值得行动的结果交给团队。"
      >
        <Button variant="primary" onClick={() => setEditor(null)}>
          <Plus size={16} />
          新建自动化
        </Button>
      </PageHead>
      <div className="ops-budget">
        <div>
          <strong>
            {settings?.budget.used ?? 0}{" "}
            <span>/ {settings?.budget.monthlyRequestLimit ?? "—"}</span>
          </strong>
          <p>本月研究请求（UTC）· 失败外发计入，缓存命中不计</p>
        </div>
        <label className="field">
          工作空间月预算
          <input
            aria-label="工作空间月度研究请求预算"
            type="number"
            min="1"
            value={monthly}
            onChange={(e) => setMonthly(Number(e.target.value))}
          />
        </label>
        <Button
          busy={busy}
          onClick={() =>
            act(
              () =>
                api("/operations/settings", {
                  method: "PUT",
                  body: JSON.stringify({ monthlyRequestLimit: monthly }),
                }),
              "月预算已更新",
            )
          }
        >
          保存预算
        </Button>
      </div>
      <div className="ops-tabs">
        {[
          ["automations", "自动化"],
          ["runs", "运行历史"],
          ["notifications", `通知 ${notifications?.unread || ""}`],
        ].map(([k, v]) => (
          <button
            key={k}
            className={tab === k ? "active" : ""}
            onClick={() => setTab(k)}
          >
            {v}
          </button>
        ))}
      </div>
      {error && <ErrorBox message={error} />}{" "}
      {tab === "automations" &&
        (automations?.length ? (
          <div className="ops-automations">
            {automations.map((a) => (
              <article className="ops-record" key={a.id}>
                <div className="ops-record-top">
                  <span
                    className={
                      "ops-badge " + (a.enabled ? "ops-completed" : "")
                    }
                  >
                    {a.enabled ? "运行中" : "已暂停"}
                  </span>
                  <small>{templateNames[a.kind]}</small>
                </div>
                <h3>{a.name}</h3>
                <p>
                  每 {a.interval_minutes} 分钟 · 下次 {date(a.next_run_at)}
                </p>
                <p>
                  单次 {a.budget.maxRequests} 次 · 每日{" "}
                  {a.budget.dailyRequestLimit} 次
                </p>
                {a.last_error && <ErrorBox message={a.last_error} />}
                <div className="ops-actions">
                  <Button
                    busy={busy}
                    onClick={() =>
                      act(
                        () => post(`/automations/${a.id}/run`),
                        "研究任务已加入队列",
                      )
                    }
                  >
                    <Play size={15} />
                    立即运行
                  </Button>
                  <Button onClick={() => setEditor(a)} aria-label="编辑自动化">
                    <Pencil size={15} />
                  </Button>
                  <Button
                    busy={busy}
                    aria-label={a.enabled ? "暂停自动化" : "启用自动化"}
                    onClick={() =>
                      act(() =>
                        api(`/automations/${a.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ enabled: !a.enabled }),
                        }),
                      )
                    }
                  >
                    {a.enabled ? <Pause size={15} /> : <Play size={15} />}
                  </Button>
                  <Button
                    busy={busy}
                    aria-label="删除自动化"
                    onClick={() =>
                      act(
                        () => api(`/automations/${a.id}`, { method: "DELETE" }),
                        "自动化已删除，运行历史保留",
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          automations && (
            <Empty
              icon={Workflow}
              title="从一项每天重复的研究开始"
              description="选择趋势采集、机会扫描、监控变化、案例采集或作品效果回收。"
            >
              <Button onClick={() => setEditor(null)} variant="primary">
                创建研究自动化
              </Button>
            </Empty>
          )
        ))}
      {tab === "automations" && automationsPage && (
        <Pager
          page={automationPage}
          total={automationsPage.total}
          onChange={setAutomationPage}
        />
      )}
      {tab === "runs" &&
        (runs?.items.length ? (
          <>
            <div className="ops-table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>研究类型</th>
                    <th>状态</th>
                    <th>请求</th>
                    <th>时间</th>
                    <th>证据</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.items.map((r: Doc) => (
                    <tr key={r.id}>
                      <td>{labels[r.kind] || r.kind}</td>
                      <td>
                        <Badge value={r.status} />
                        {r.error && <small>{r.error}</small>}
                      </td>
                      <td>
                        {r.request_count}/{r.max_requests}
                      </td>
                      <td>{date(r.created_at)}</td>
                      <td>
                        <Button onClick={() => setSelected(r.id)}>
                          查看结果
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} total={runs.total} onChange={setPage} />
          </>
        ) : (
          <Empty
            icon={FileSearch}
            title="还没有运行记录"
            description="创建自动化后点击立即运行，即可查看完整证据与请求消耗。"
          />
        ))}
      {tab === "notifications" && (
        <>
          <div className="ops-actions">
            <Button
              busy={busy}
              onClick={() =>
                act(() => post("/notifications/read-all"), "通知已读")
              }
            >
              全部标为已读
            </Button>
          </div>
          {notifications?.items.length ? (
            <div className="ops-notifications">
              {notifications.items.map((n: Doc) => (
                <article key={n.id} className={n.read_at ? "" : "unread"}>
                  <Bell size={17} />
                  <div>
                    <strong>{n.title}</strong>
                    <p>{n.message}</p>
                    <small>{date(n.created_at)}</small>
                  </div>
                  {!n.read_at && (
                    <Button
                      onClick={() =>
                        act(
                          () => post(`/notifications/${n.id}/read`),
                          "通知已读",
                        )
                      }
                    >
                      已读
                    </Button>
                  )}
                  {n.href && <Link to={n.href}>打开</Link>}
                </article>
              ))}
            </div>
          ) : (
            <Empty
              icon={Bell}
              title="暂无新通知"
              description="研究完成、预算停止和发布状态变化都会保存在这里。"
            />
          )}
        </>
      )}
      {editor !== undefined && (
        <AutomationEditor
          item={editor}
          onClose={() => setEditor(undefined)}
          onSaved={reload}
        />
      )}{" "}
      {selected && <RunDetails id={selected} onClose={() => setSelected("")} />}
    </div>
  );
}
export function Overview() {
  const { data, error, reload } = useData<Doc>("/overview", 15000);
  return (
    <div className="page ops-page">
      <PageHead
        title="经营概览"
        description="从市场证据到成片发布，查看团队当前的进展。"
      >
        <Link className="button primary" to="/products">
          查看商品工作台
        </Link>
      </PageHead>
      {error && <ErrorBox message={error} retry={reload} />}
      <div className="ops-stats">
        {[
          ["待研究机会", data?.counts?.opportunities || 0, "/opportunities"],
          ["待确认分镜", data?.counts?.storyboards || 0, "/projects"],
          ["正在生成", data?.counts?.generating || 0, "/tasks"],
          ["待发布内容", data?.counts?.publishing || 0, "/publish"],
          ["异常待处理", data?.counts?.attention || 0, "/tasks"],
          ["本月研究请求", data?.budget?.used || 0, "/automations"],
        ].map(([name, value, path]) => (
          <Link key={String(name)} className="ops-stat" to={String(path)}>
            <span>{name}</span>
            <strong>{number(value)}</strong>
            <ArrowUpRight size={17} />
          </Link>
        ))}
      </div>
      <div className="ops-quick-links">
        <Link to="/products">
          <PackageCheck size={18} />
          <span>
            从商品开始<small>维护卖点、图片与约束</small>
          </span>
          <ArrowUpRight size={16} />
        </Link>
        <Link to="/prompts">
          <FileSearch size={18} />
          <span>
            从案例开始<small>参考真实视频和销售结构</small>
          </span>
          <ArrowUpRight size={16} />
        </Link>
        <Link to="/assets">
          <Video size={18} />
          <span>
            从素材开始<small>继续制作或导出已有成片</small>
          </span>
          <ArrowUpRight size={16} />
        </Link>
      </div>
      <div className="ops-overview-grid">
        <section className="ops-section">
          <div className="ops-section-head">
            <h2>最近发布</h2>
            <Link to="/publish">全部发布</Link>
          </div>
          {data?.recentPublications.length ? (
            data.recentPublications.map((p: Doc) => (
              <div className="ops-summary-row" key={p.id}>
                <span>{p.title}</span>
                <Badge value={p.status} />
              </div>
            ))
          ) : (
            <p className="muted">
              暂无发布记录。完成成片后，在发布中心创建记录。
            </p>
          )}
        </section>
        <section className="ops-section">
          <div className="ops-section-head">
            <h2>研究运行</h2>
            <Link to="/automations">自动化与通知</Link>
          </div>
          {data?.recentRuns.length ? (
            data.recentRuns.map((r: Doc) => (
              <div className="ops-summary-row" key={r.id}>
                <span>
                  {labels[r.kind] || r.kind}
                  <small>
                    {date(r.created_at)} · {r.request_count} 次请求
                  </small>
                </span>
                <Badge value={r.status} />
              </div>
            ))
          ) : (
            <p className="muted">
              暂无研究记录。先配置数据渠道，再选择一个采集模板。
            </p>
          )}
        </section>
      </div>
      <div className="ops-note">
        <Workflow size={18} />
        <span>
          本月研究请求 {data?.budget.used || 0} /{" "}
          {data?.budget.monthlyRequestLimit || "—"}
          。研究会按预算自动执行，生成视频和发布仍由团队确认。
        </span>
      </div>
    </div>
  );
}
