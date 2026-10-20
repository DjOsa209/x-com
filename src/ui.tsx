import {
  useState,
  useEffect,
  useCallback,
  createContext,
  useContext,
  useRef,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  X,
  Loader2,
  ArrowRight,
  Settings2,
  Inbox,
  Upload,
  CheckCircle2,
  AlertCircle,
  Download,
  Copy,
  Clapperboard,
} from "lucide-react";
import { api, upload, number, type Doc } from "./api";
export const AppContext = createContext<{
  auth?: Doc | null;
  status: Doc | null;
  refresh: () => void;
  toast: (message: string, error?: boolean) => void;
}>({ status: null, refresh: () => {}, toast: () => {} });
export const useApp = () => useContext(AppContext);
export function useData<T = Doc[]>(path: string, interval = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const r = await api<T>(path);
      if (id !== request.current) return;
      setData(r);
      setError("");
    } catch (e: any) {
      if (id === request.current) setError(e.message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(true);
    void load();
    if (interval) {
      const id = setInterval(() => {
        if (!document.hidden) void load();
      }, interval);
      return () => clearInterval(id);
    }
  }, [load, interval]);
  return { data, error, loading, reload: load };
}
export function Button({
  children,
  busy = false,
  variant = "",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: string;
}) {
  const { auth } = useApp();
  return (
    <button
      {...props}
      disabled={
        props.disabled ||
        busy ||
        (variant === "primary" && auth?.role === "viewer")
      }
      className={`button ${variant} ${className}`}
    >
      {busy ? <Loader2 size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
export function PageHead({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </div>
  );
}
export function Empty({
  title,
  description,
  children,
  icon: Icon = Inbox,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  icon?: any;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <Icon size={27} strokeWidth={1.4} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {retry && <button onClick={retry}>重试</button>}
    </div>
  );
}
export function Connection({
  provider,
  label,
}: {
  provider: string;
  label: string;
}) {
  const { status } = useApp();
  return status && !status.connections?.[provider] ? (
    <div className="connection-note">
      <span className="status-dot amber" />
      <span>{label}尚未连接</span>
      <Link to="/settings">
        配置连接 <ArrowRight size={13} />
      </Link>
    </div>
  ) : null;
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button
          role="tab"
          aria-selected={value === t.id}
          key={t.id}
          className={value === t.id ? "active" : ""}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement;
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab" && ref.current) {
        const nodes = Array.from(
          ref.current.querySelectorAll<HTMLElement>(
            'button,input,select,textarea,a[href],[tabindex="0"]',
          ),
        ).filter((n) => !(n as HTMLButtonElement).disabled);
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = overflow;
      prev?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function JsonView({ value }: { value: any }) {
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}
export function FilePicker({
  onPick,
  accept = "image/png,image/jpeg,image/webp",
  children,
  className = "",
}: {
  onPick: (a: Doc) => void;
  accept?: string;
  children?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const { toast, refresh } = useApp();
  return (
    <>
      <input
        ref={ref}
        type="file"
        className="sr-only"
        accept={accept}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > 100 * 1024 * 1024) {
            toast("文件最大 100MB", true);
            return;
          }
          setBusy(true);
          try {
            const a = await upload(file);
            onPick(a);
            refresh();
          } catch (e: any) {
            toast(e.message, true);
          } finally {
            setBusy(false);
            e.target.value = "";
          }
        }}
      />
      <Button
        className={className}
        busy={busy}
        onClick={() => ref.current?.click()}
      >
        {children || (
          <>
            <Upload size={16} />
            上传素材
          </>
        )}
      </Button>
    </>
  );
}
export function AssetPicker({
  type,
  onPick,
  onClose,
}: {
  type?: string;
  onPick: (a: Doc) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState(""),
    [page, setPage] = useState(1);
  const { data, error, loading } = useData<Doc>(
    `/library/asset?page=${page}&pageSize=24&q=${encodeURIComponent(q)}${type ? "&type=" + type : ""}`,
  );
  return (
    <Modal title="选择素材" onClose={onClose} wide>
      <input
        aria-label="搜索可选素材"
        placeholder="搜索名称或标签"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
      />
      {error && <ErrorBox message={error} />}{" "}
      {loading && <p role="status">正在读取素材…</p>}
      <div className="asset-picker-grid">
        {data?.items?.map((a: Doc) => (
          <button
            key={a.id}
            onClick={() => {
              onPick(a);
              onClose();
            }}
            className="asset-pick"
          >
            {a.type === "image" ? (
              <img src={a.url} alt={a.name} />
            ) : a.type === "video" ? (
              <video src={a.url} preload="metadata" />
            ) : (
              <span>音频素材</span>
            )}
            <span>{a.name}</span>
          </button>
        ))}
      </div>
      {!!data?.total && (
        <div className="page-navigation">
          <Button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </Button>
          <span>
            第 {page} 页 · 共 {data.total} 条
          </span>
          <Button
            disabled={page * 24 >= data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      {!loading && !data?.items?.length && (
        <Empty title="没有可用素材" description="上传素材后即可在这里选择。">
          <FilePicker
            accept={
              type === "video"
                ? "video/mp4,video/quicktime,video/webm"
                : type === "audio"
                  ? "audio/mpeg,audio/wav,audio/mp4,.m4a"
                  : undefined
            }
            onPick={(a) => {
              onPick(a);
              onClose();
            }}
          />
        </Empty>
      )}
    </Modal>
  );
}

export async function copyText(
  value: string,
  toast: (s: string, e?: boolean) => void,
) {
  try {
    await navigator.clipboard.writeText(value);
    toast("已复制");
  } catch {
    toast("复制失败，可选中文本手动复制", true);
  }
}
export function ResultView({ result }: { result: Doc }) {
  const { toast } = useApp();
  const player = useRef<HTMLVideoElement>(null);
  const [savingCase, setSavingCase] = useState(false);
  const [sourceAsset, setSourceAsset] = useState<Doc | null>(null);
  useEffect(() => {
    setSourceAsset(null);
    if (result?.videoAssetId)
      void api<Doc>(`/records/asset/${result.videoAssetId}`)
        .then(setSourceAsset)
        .catch(() => {});
  }, [result?.videoAssetId]);
  const seek = (scene: Doc) => {
    const start =
      scene.start ??
      Number(
        String(scene.time || scene.timestamp || "0").match(/[\d.]+/)?.[0] || 0,
      );
    if (player.current) {
      player.current.currentTime = start;
      player.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };
  if (!result) return null;
  return (
    <div className="result-content">
      {sourceAsset && (
        <section>
          <h4>参考视频 · 点击分镜时间定位</h4>
          <video
            ref={player}
            className="result-media"
            src={sourceAsset.url}
            controls
            playsInline
          />
        </section>
      )}
      {result.videoAssetId && result.scenes?.length > 0 && (
        <div className="inline-actions">
          <Button
            busy={savingCase}
            onClick={async () => {
              setSavingCase(true);
              try {
                await api("/commerce/cases", {
                  method: "POST",
                  body: JSON.stringify({
                    title: result.title || "视频分析案例",
                    prompt:
                      result.shootingPrompt ||
                      result.script ||
                      result.scenes.map((s: Doc) => s.visual).join("\n"),
                    analysis: result,
                    sourceUrl: result.sourceUrl || "",
                    sourceVideoAssetId: result.videoAssetId,
                    status: "review",
                    provenance: "视频分析",
                  }),
                });
                toast("已保存到案例库，等待审阅");
              } catch (e: any) {
                toast(e.message, true);
              } finally {
                setSavingCase(false);
              }
            }}
          >
            保存到案例库待审阅
          </Button>
          <Link className="button" to="/prompts">
            打开案例库
          </Link>
          <Link
            className="button"
            to="/"
            state={{ videoAsset: sourceAsset, mode: "replicate" }}
          >
            改编此视频
          </Link>
        </div>
      )}
      {result.asset &&
        (result.asset.type === "image" ? (
          <img
            className="result-media"
            src={result.asset.url}
            alt={result.asset.name}
          />
        ) : (
          <video
            className="result-media"
            src={result.asset.url}
            controls
            playsInline
          />
        ))}
      {result.asset && (
        <a className="button" href={`/api/assets/${result.asset.id}/download`}>
          <Download size={16} />
          下载文件
        </a>
      )}
      {result.asset?.type === "video" && (
        <div className="inline-actions">
          <Link
            className="button"
            to={`/studio/edit?assetId=${result.asset.id}`}
          >
            字幕与音频后期
          </Link>
          <Link className="button" to={`/publish?assetId=${result.asset.id}`}>
            审核与发布
          </Link>
        </div>
      )}
      {result.opportunityId && (
        <Link className="button" to="/opportunities">
          查看选品机会
        </Link>
      )}
      {result.title && <h3>{result.title}</h3>}
      {result.summary && <p>{result.summary}</p>}
      {result.hook && (
        <section>
          <h4>开场钩子</h4>
          <p>{result.hook}</p>
        </section>
      )}
      {result.script && (
        <section>
          <h4>销售脚本</h4>
          <p className="preserve">
            {typeof result.script === "string"
              ? result.script
              : JSON.stringify(result.script, null, 2)}
          </p>
        </section>
      )}
      {Array.isArray(result.scenes) && (
        <section>
          <h4>分镜脚本</h4>
          <div className="scene-list">
            {result.scenes.map((s: Doc, i: number) => (
              <div key={i} className="scene">
                <span>
                  {sourceAsset ? (
                    <button className="timecode" onClick={() => seek(s)}>
                      {s.time || s.timestamp || `${s.start ?? 0}s`}
                    </button>
                  ) : (
                    s.time || `镜头 ${i + 1}`
                  )}
                </span>
                <div>
                  <strong>{s.shot}</strong>
                  <p>{s.visual}</p>
                  <p className="muted">{s.voiceover}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {result.shootingPrompt && (
        <section>
          <div className="section-heading">
            <h4>可拍摄 / 生成提示词</h4>
            <Button onClick={() => copyText(result.shootingPrompt, toast)}>
              <Copy size={14} />
              复制
            </Button>
          </div>
          <p className="prompt-text">{result.shootingPrompt}</p>
        </section>
      )}
      {Array.isArray(result.painPoints) && (
        <section>
          <h4>评论痛点 · 样本内观察</h4>
          {result.painPoints.map((point: Doc, i: number) => (
            <div className="insight-point" key={i}>
              <h3>{point.problem}</h3>
              <p>
                {typeof point.evidence === "string"
                  ? point.evidence
                  : JSON.stringify(point.evidence)}
              </p>
              <small className="muted">
                样本出现次数：{point.frequencyInSample ?? "未标注"} · 评论 ID：
                {(point.commentIds || []).join(", ")}
              </small>
            </div>
          ))}
        </section>
      )}
      {Array.isArray(result.opportunities) && (
        <section>
          <h4>机会假设</h4>
          <ul>
            {result.opportunities.map((p: any, i: number) => (
              <li key={i}>{typeof p === "string" ? p : JSON.stringify(p)}</li>
            ))}
          </ul>
        </section>
      )}
      {Array.isArray(result.successHypotheses) && (
        <section>
          <h4>销售原因推断</h4>
          <ul>
            {result.successHypotheses.map((p: any, i: number) => (
              <li key={i}>{typeof p === "string" ? p : JSON.stringify(p)}</li>
            ))}
          </ul>
        </section>
      )}
      {Array.isArray(result.limitations) && result.limitations.length > 0 && (
        <section>
          <h4>待验证的信息</h4>
          <ul>
            {result.limitations.map((p: any, i: number) => (
              <li key={i}>{typeof p === "string" ? p : JSON.stringify(p)}</li>
            ))}
          </ul>
        </section>
      )}
      {result.sourceUrl && (
        <a
          className="text-link"
          href={result.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          查看来源视频 <ArrowRight size={14} />
        </a>
      )}
      <details>
        <summary>完整结果与证据</summary>
        <JsonView value={result} />
      </details>
    </div>
  );
}
