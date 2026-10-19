import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  FolderOpen,
  Plus,
  Search,
  Image,
  Film,
  Download,
  Trash2,
  ArrowUpRight,
  Copy,
  Users,
  Upload,
  Camera,
  Play,
  Check,
  Clapperboard,
  ScanLine,
  RefreshCw,
  Settings2,
  Plug,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  Send,
  CalendarDays,
  ExternalLink,
  ArrowRight,
  Save,
  Clock3,
  Code2,
  BookOpen,
  MoreHorizontal,
} from "lucide-react";
import {
  api,
  post,
  save,
  del,
  newJob,
  upload,
  date,
  number,
  kindNames,
  stateNames,
  type Doc,
} from "../api";
import {
  useApp,
  useData,
  PageHead,
  Button,
  Empty,
  ErrorBox,
  Connection,
  Tabs,
  Modal,
  JsonView,
  ResultView,
  FilePicker,
  AssetPicker,
  copyText,
} from "../ui";

export function Assets() {
  const { data, reload, error } = useData("/records/asset");
  const { toast } = useApp();
  const navigate = useNavigate();
  const [type, setType] = useState("all"),
    [q, setQ] = useState(""),
    [selected, setSelected] = useState<Doc | null>(null),
    [name, setName] = useState(""),
    [tags, setTags] = useState("");
  const items = data?.filter(
    (a) =>
      (type === "all" || a.type === type) &&
      (a.name + " " + (a.tags || []).join(" "))
        .toLowerCase()
        .includes(q.toLowerCase()),
  );
  return (
    <div className="page">
      <PageHead
        title="素材库"
        description="商品图、参考视频和生成作品，都在这里。"
      >
        <FilePicker
          accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm"
          onPick={() => {
            void reload();
            toast("素材已上传");
          }}
        >
          <Upload size={16} />
          上传素材
        </FilePicker>
      </PageHead>
      <div className="list-toolbar">
        <Tabs
          items={[
            { id: "all", label: "全部素材" },
            { id: "image", label: "图片" },
            { id: "video", label: "视频" },
          ]}
          value={type}
          onChange={setType}
        />
        <div className="input-icon">
          <Search size={16} />
          <input
            aria-label="搜索素材"
            placeholder="搜索名称或标签"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {items?.length ? (
        <div className="assets-grid">
          {items.map((a) => (
            <article className="asset-card" key={a.id}>
              <button
                className="asset-preview"
                onClick={() => {
                  setSelected(a);
                  setName(a.name);
                  setTags((a.tags || []).join(", "));
                }}
              >
                {a.type === "image" ? (
                  <img src={a.url} alt={a.name} loading="lazy" />
                ) : (
                  <>
                    <video src={a.url} preload="metadata" />
                    <span className="play-overlay">
                      <Play size={20} />
                    </span>
                  </>
                )}
              </button>
              <div className="asset-caption">
                <strong>{a.name}</strong>
                <small>
                  {a.type === "image" ? "图片" : "视频"} ·{" "}
                  {(a.bytes / 1024 / 1024).toFixed(2)} MB
                </small>
              </div>
              <div className="asset-actions">
                <button
                  onClick={() =>
                    navigate("/", {
                      state: {
                        asset: a,
                        ...(a.type === "video"
                          ? { sourceUrl: undefined, mode: "script" }
                          : {}),
                      },
                    })
                  }
                  disabled={a.type === "video"}
                >
                  用于创作 <ArrowUpRight size={13} />
                </button>
                <a
                  aria-label={`下载 ${a.name}`}
                  href={`/api/assets/${a.id}/download`}
                >
                  <Download size={15} />
                </a>
                <button
                  aria-label={`删除 ${a.name}`}
                  onClick={async () => {
                    try {
                      await del("asset", a.id);
                      void reload();
                      toast("素材已删除");
                    } catch (e: any) {
                      toast(e.message, true);
                    }
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
          title={q ? "没有匹配的素材" : "让产品图片成为创作的起点"}
          description="上传商品图或参考视频。支持 PNG、JPG、WebP、MP4、MOV、WebM，单文件最大 100MB。"
          icon={FolderOpen}
        >
          <FilePicker
            accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm"
            onPick={() => reload()}
          />
        </Empty>
      )}
      {selected && (
        <Modal title="素材详情" onClose={() => setSelected(null)} wide>
          <div className="asset-detail">
            {selected.type === "image" ? (
              <img src={selected.url} alt={selected.name} />
            ) : (
              <video src={selected.url} controls playsInline />
            )}
            <div className="form-stack">
              <label className="field">
                名称
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                标签（逗号分隔）
                <input value={tags} onChange={(e) => setTags(e.target.value)} />
              </label>
              <p className="muted">
                上传于 {date(selected.createdAt)}
                <br />
                {selected.mime} · {(selected.bytes / 1024 / 1024).toFixed(2)} MB
              </p>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await api(`/records/asset/${selected.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({
                        name,
                        tags: tags
                          .split(/[,，]/)
                          .map((t) => t.trim())
                          .filter(Boolean),
                      }),
                    });
                    toast("素材已更新");
                    setSelected(null);
                    void reload();
                  } catch (e: any) {
                    toast(e.message, true);
                  }
                }}
              >
                <Save size={15} />
                保存修改
              </Button>
              <a
                className="button"
                href={`/api/assets/${selected.id}/download`}
              >
                <Download size={15} />
                下载原文件
              </a>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CharacterEditor({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [image, setImage] = useState<Doc | null>(null),
    [video, setVideo] = useState<Doc | null>(null),
    [picker, setPicker] = useState(""),
    [duration, setDuration] = useState(0),
    [time, setTime] = useState(0),
    [busy, setBusy] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <Modal title="创建可复用角色" onClose={onClose} wide>
      <div className="character-editor">
        <div className="character-source">
          {image ? (
            <img src={image.url} alt="角色参考图" />
          ) : video ? (
            <>
              <video
                ref={ref}
                src={video.url}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                controls
                playsInline
              />
              <label className="field">
                选择画面 · {time.toFixed(1)} 秒
                <input
                  type="range"
                  min="0"
                  max={duration || 1}
                  step="0.1"
                  value={time}
                  onChange={(e) => {
                    const t = Number(e.target.value);
                    setTime(t);
                    if (ref.current) ref.current.currentTime = t;
                  }}
                />
              </label>
              <Button
                busy={busy}
                onClick={async () => {
                  const v = ref.current;
                  if (!v || !v.videoWidth) return;
                  setBusy(true);
                  try {
                    const canvas = document.createElement("canvas");
                    canvas.width = v.videoWidth;
                    canvas.height = v.videoHeight;
                    const context = canvas.getContext("2d");
                    if (!context) throw new Error("无法抽取视频画面");
                    context.drawImage(v, 0, 0);
                    const blob = await new Promise<Blob | null>((r) =>
                      canvas.toBlob(r, "image/jpeg", 0.92),
                    );
                    if (!blob) throw new Error("抽帧失败");
                    const result = await upload(
                      new File([blob], "角色参考帧.jpg", {
                        type: "image/jpeg",
                      }),
                    );
                    setImage(result);
                  } catch (e: any) {
                    toast(e.message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Camera size={15} />
                将当前画面作为角色
              </Button>
            </>
          ) : (
            <Empty
              title="添加角色参考图"
              description="上传人物图片，或从已有视频中抽取一帧。"
              icon={Users}
            />
          )}
          <div className="inline-actions">
            <FilePicker
              onPick={(a) => {
                setImage(a);
                setVideo(null);
              }}
            >
              <Upload size={15} />
              上传图片
            </FilePicker>
            <Button onClick={() => setPicker("video")}>
              <Film size={15} />
              从视频抽帧
            </Button>
            <Button onClick={() => setPicker("image")}>素材库</Button>
          </div>
        </div>
        <div className="form-stack">
          <label className="field">
            角色名称
            <input
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：品牌讲解员"
            />
          </label>
          <label className="field">
            角色描述
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="补充服装、气质和出镜方式"
              rows={5}
            />
          </label>
          <p className="muted">
            后续视频任务会复用这张角色参考图。实际一致性取决于所用生成模型。
          </p>
          <Button
            variant="primary"
            disabled={!image || !name.trim()}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await save("character", {
                  name,
                  description,
                  assetId: image!.id,
                  imageUrl: image!.url,
                  sourceVideoAssetId: video?.id,
                  frameTime: video ? time : undefined,
                });
                onSaved();
                toast("角色已保存");
                onClose();
              } catch (e: any) {
                toast(e.message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存角色 <ArrowRight size={15} />
          </Button>
        </div>
      </div>
      {picker && (
        <AssetPicker
          type={picker}
          onPick={(a) => {
            if (picker === "video") {
              setVideo(a);
              setImage(null);
            } else setImage(a);
          }}
          onClose={() => setPicker("")}
        />
      )}
    </Modal>
  );
}
export function Characters() {
  const { data, reload, error } = useData("/records/character");
  const [adding, setAdding] = useState(false);
  const { toast } = useApp();
  return (
    <div className="page">
      <PageHead
        title="我的角色"
        description="保存出镜人物，让每一条产品内容延续熟悉的形象。"
      >
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus size={16} />
          创建角色
        </Button>
      </PageHead>
      {error && <ErrorBox message={error} />}
      {data?.length ? (
        <div className="characters-grid">
          {data.map((c) => (
            <article className="character-card" key={c.id}>
              <img src={c.imageUrl} alt={c.name} />
              <div>
                <h3>{c.name}</h3>
                <p>{c.description || "角色参考图"}</p>
                <div className="inline-actions">
                  <Link className="button" to="/">
                    用于创作 <ArrowUpRight size={14} />
                  </Link>
                  <Button
                    aria-label={`删除角色 ${c.name}`}
                    onClick={async () => {
                      try {
                        await del("character", c.id);
                        void reload();
                      } catch (e: any) {
                        toast(e.message, true);
                      }
                    }}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="打造你的固定出镜角色"
          description="从图片或视频画面创建角色，创作时即可复用。"
          icon={Users}
        >
          <Button onClick={() => setAdding(true)}>
            <Plus size={15} />
            创建第一个角色
          </Button>
        </Empty>
      )}
      {adding && (
        <CharacterEditor
          onClose={() => setAdding(false)}
          onSaved={() => reload()}
        />
      )}
    </div>
  );
}

export function Tasks() {
  const { data, reload, error } = useData("/jobs", 4000);
  const [filter, setFilter] = useState("all"),
    [kind, setKind] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
  const { toast } = useApp();
  const navigate = useNavigate();
  const current = data?.find((j) => j.id === selected);
  const items = data?.filter(
    (j) =>
      (filter === "all" ||
        (filter === "active" &&
          ["queued", "scheduled", "running", "processing"].includes(
            j.status,
          )) ||
        j.status === filter) &&
      (!kind || j.kind === kind),
  );
  return (
    <div className="page">
      <PageHead
        title="任务管理"
        description="每一次创作，都有清晰的进度、结果和来源。"
      >
        <Button onClick={() => reload()}>
          <RefreshCw size={15} />
          刷新
        </Button>
      </PageHead>
      <div className="list-toolbar">
        <Tabs
          items={[
            { id: "all", label: "全部任务" },
            { id: "active", label: "进行中" },
            { id: "completed", label: "已完成" },
            { id: "review", label: "待核对" },
            { id: "failed", label: "失败" },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <select
          aria-label="任务类型"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">所有类型</option>
          {Object.entries(kindNames).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      {error && <ErrorBox message={error} />}
      {items?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>任务</th>
                <th>类型</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((j) => (
                <tr key={j.id}>
                  <td>
                    <button
                      className="table-title"
                      onClick={() => setSelected(j.id)}
                    >
                      {j.input.name ||
                        j.input.prompt?.slice(0, 40) ||
                        kindNames[j.kind]}
                    </button>
                    <small className="id-label">{j.id.slice(0, 8)}</small>
                  </td>
                  <td>{kindNames[j.kind]}</td>
                  <td>
                    <span className={`status-label ${j.status}`}>
                      {stateNames[j.status]}
                    </span>
                    {j.runAt && <small>{date(j.runAt)}</small>}
                  </td>
                  <td>{date(j.createdAt)}</td>
                  <td>
                    <Button onClick={() => setSelected(j.id)}>
                      查看 <ArrowUpRight size={13} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="还没有{filter==='all'?'':filter==='completed'?'已完成的':'匹配的'}任务"
          description="从工作台创建视频、生成图片或分析参考视频，任务会保存在这里。"
          icon={Clapperboard}
        >
          <Link to="/" className="button primary">
            开始创作 <ArrowRight size={15} />
          </Link>
        </Empty>
      )}
      {current && (
        <Modal
          title={kindNames[current.kind]}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="job-detail-header">
            <span className={`status-label ${current.status}`}>
              {stateNames[current.status]}
            </span>
            <span className="muted">{date(current.createdAt)}</span>
            <div className="inline-actions">
              {["queued", "scheduled", "processing"].includes(
                current.status,
              ) && (
                <Button
                  onClick={async () => {
                    try {
                      await post(`/jobs/${current.id}/cancel`);
                      void reload();
                      toast("已处理取消请求");
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  请求取消
                </Button>
              )}
              {current.status === "review" && (
                <Button
                  onClick={async () => {
                    try {
                      await post(`/jobs/${current.id}/refresh`);
                      void reload();
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  查询供应商状态
                </Button>
              )}
              {current.result?.shootingPrompt && (
                <Button
                  onClick={() => {
                    navigate("/", {
                      state: {
                        prompt: current.result.shootingPrompt,
                        mode: "video",
                      },
                    });
                    setSelected(null);
                  }}
                >
                  用此提示词生成视频
                  <ArrowRight size={14} />
                </Button>
              )}
            </div>
          </div>
          {current.error && <ErrorBox message={current.error} />}
          {current.result ? (
            <ResultView result={current.result} />
          ) : (
            <Empty
              title={
                current.status === "review"
                  ? "需要核对供应商状态"
                  : "结果将在任务完成后显示"
              }
              description={
                current.status === "review"
                  ? "任务可能已提交。系统不会自动重复提交，以免重复计费。"
                  : "关闭此窗口不影响后台任务；本地服务需要保持运行。"
              }
              icon={Clock3}
            />
          )}
          <details>
            <summary>任务输入</summary>
            <JsonView value={current.input} />
          </details>
        </Modal>
      )}
    </div>
  );
}

export function Tool({ kind }: { kind: "analysis" | "enhance" }) {
  const { toast } = useApp();
  const navigate = useNavigate();
  const [source, setSource] = useState(""),
    [asset, setAsset] = useState<Doc | null>(null),
    [tab, setTab] = useState("link"),
    [picker, setPicker] = useState(false),
    [target, setTarget] = useState("1080"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [current, setCurrent] = useState(""),
    [width, setWidth] = useState(0),
    [height, setHeight] = useState(0);
  const { data: jobs } = useData("/jobs", 4000);
  const job = jobs?.find((j) => j.id === current);
  useEffect(() => {
    setError("");
    setCurrent("");
    setSource("");
    setAsset(null);
    setTab(kind === "enhance" ? "upload" : "link");
  }, [kind]);
  const minDim = Math.min(width, height);
  const factor = minDim ? Number(target) / minDim : 2;
  return (
    <div className="page tool-page">
      <PageHead
        title={kind === "analysis" ? "视频分析" : "视频超分"}
        description={
          kind === "analysis"
            ? "拆解口播、分镜、销售钩子与音乐，让下一条创作更有方向。"
            : "提升已有视频的清晰度，完成创作的最后一步。"
        }
      />
      <Connection
        provider={kind === "analysis" ? "gemini" : "fal"}
        label={
          kind === "analysis" ? "Gemini 视频理解服务" : "fal.ai 视频超分服务"
        }
      />
      <div className="tool-layout">
        <section className="tool-input">
          <h2>{kind === "analysis" ? "参考视频" : "选择视频"}</h2>
          {kind === "analysis" && (
            <Tabs
              items={[
                { id: "link", label: "视频链接" },
                { id: "upload", label: "本地素材" },
              ]}
              value={tab}
              onChange={setTab}
            />
          )}
          {tab === "link" ? (
            <label className="field">
              TikTok 链接或视频直链
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="https://www.tiktok.com/@…/video/…"
              />
              <small>
                TikTok 分享链接由 EchoTik 解析；抖音可先下载后上传。
              </small>
            </label>
          ) : (
            <>
              {asset ? (
                <div className="tool-video">
                  <video
                    src={asset.url}
                    controls
                    playsInline
                    onLoadedMetadata={(e) => {
                      setWidth(e.currentTarget.videoWidth);
                      setHeight(e.currentTarget.videoHeight);
                    }}
                  />
                  <p>{asset.name}</p>
                  <Button onClick={() => setAsset(null)}>重新选择</Button>
                </div>
              ) : (
                <div className="tool-upload">
                  <Film size={30} />
                  <strong>选择一个参考视频</strong>
                  <p>MP4、MOV、WebM · 最大 100MB</p>
                  <FilePicker
                    accept="video/mp4,video/quicktime,video/webm"
                    onPick={setAsset}
                  />
                  <Button onClick={() => setPicker(true)}>
                    <FolderOpen size={15} />
                    从素材库选择
                  </Button>
                </div>
              )}
            </>
          )}
          {kind === "enhance" && (
            <>
              <h3>输出分辨率（短边）</h3>
              <div className="segment">
                {[
                  ["720", "720p"],
                  ["1080", "1080p"],
                  ["1440", "2K"],
                ].map(([v, l]) => (
                  <button
                    key={v}
                    className={target === v ? "selected" : ""}
                    onClick={() => setTarget(v)}
                    disabled={!!minDim && Number(v) < minDim}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <p className="muted">
                {minDim
                  ? `原始尺寸 ${width} × ${height}，放大 ${factor.toFixed(2)} 倍。`
                  : "选择视频后读取原始尺寸。"}
                由 Topaz 进行增强，最终规格以返回文件为准。
              </p>
            </>
          )}
          {error && <ErrorBox message={error} />}
          <Button
            variant="primary"
            busy={busy}
            disabled={
              !(tab === "link" ? source.trim() : asset) ||
              (kind === "enhance" && (!minDim || factor < 1 || factor > 4))
            }
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const j = await newJob(kind, {
                  sourceUrl: tab === "link" ? source : undefined,
                  videoAssetId: kind === "analysis" ? asset?.id : undefined,
                  assetId: kind === "enhance" ? asset?.id : undefined,
                  upscaleFactor: factor,
                  targetResolution: target,
                });
                setCurrent(j.id);
                toast("任务已提交");
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {kind === "analysis" ? (
              <ScanLine size={16} />
            ) : (
              <Clapperboard size={16} />
            )}
            {kind === "analysis" ? "开始分析" : "增强视频"}
            <ArrowRight size={15} />
          </Button>
        </section>
        <section className="tool-output">
          <div className="section-heading">
            <h2>{kind === "analysis" ? "分析结果" : "增强结果"}</h2>
            <Link to="/tasks" className="text-link">
              全部任务 <ArrowUpRight size={13} />
            </Link>
          </div>
          {job ? (
            <>
              <span className={`status-label ${job.status}`}>
                {stateNames[job.status]}
              </span>
              {job.error && <ErrorBox message={job.error} />}
              {job.result && <ResultView result={job.result} />}
            </>
          ) : (
            <Empty
              title={
                kind === "analysis"
                  ? "看懂一条视频的销售逻辑"
                  : "更清晰的作品，从这里开始"
              }
              description={
                kind === "analysis"
                  ? "实际分析视频内容，提取脚本与分镜；销售原因会标为推断。"
                  : "选择已完成的视频或上传本地文件。"
              }
              icon={kind === "analysis" ? ScanLine : Clapperboard}
            />
          )}
        </section>
      </div>
      {picker && (
        <AssetPicker
          type="video"
          onPick={setAsset}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

export function Analytics() {
  const { data, error, reload } = useData<Doc>("/analytics");
  const { data: accounts } = useData("/records/account");
  const [account, setAccount] = useState(""),
    [remote, setRemote] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false);
  const { toast } = useApp();
  const completed =
    data?.byStatus.find((s: Doc) => s.status === "completed")?.count || 0;
  const pending =
    data?.byStatus
      .filter((s: Doc) =>
        ["queued", "scheduled", "running", "processing"].includes(s.status),
      )
      .reduce((n: number, s: Doc) => n + Number(s.count), 0) || 0;
  return (
    <div className="page">
      <PageHead
        title="数据分析"
        description="查看真实创作任务、接口使用情况与已授权账号内容。"
      >
        <Button onClick={() => reload()}>
          <RefreshCw size={15} />
          刷新数据
        </Button>
      </PageHead>
      {error && <ErrorBox message={error} />}
      <div className="analytics-summary">
        <div>
          <span>已完成任务</span>
          <strong>{number(completed)}</strong>
        </div>
        <div>
          <span>进行中任务</span>
          <strong>{number(pending)}</strong>
        </div>
        <div>
          <span>素材数量</span>
          <strong>{number(data?.storage.count ?? 0)}</strong>
        </div>
        <div>
          <span>素材占用</span>
          <strong>
            {((Number(data?.storage.bytes) || 0) / 1024 / 1024).toFixed(1)}
            <small> MB</small>
          </strong>
        </div>
      </div>
      <section className="analytics-section">
        <div className="section-heading">
          <h2>EchoTik 接口调用</h2>
          <span className="muted">本工作区统计 · UTC 日期</span>
        </div>
        {data?.usage.length ? (
          <div className="usage-chart">
            {data.usage
              .slice()
              .reverse()
              .map((d: Doc) => (
                <div key={d.day}>
                  <div
                    className="usage-bar"
                    style={{
                      height: `${Math.max(3, (Number(d.calls) / Math.max(...data.usage.map((v: Doc) => Number(v.calls)))) * 120)}px`,
                    }}
                    title={`${d.day}: ${d.calls} 次请求 / ${d.successful} 次成功`}
                  />
                  <strong>{d.calls}</strong>
                  <span>{d.day.slice(5)}</span>
                </div>
              ))}
          </div>
        ) : (
          <Empty
            title="还没有接口调用记录"
            description="连接 EchoTik 并查询数据后，这里会显示实际请求量。"
            icon={Code2}
          />
        )}
      </section>
      <section className="analytics-section">
        <div className="section-heading">
          <h2>TikTok 账号内容</h2>
          <Link to="/publish" className="text-link">
            管理账号 <ArrowUpRight size={13} />
          </Link>
        </div>
        <div className="inline-actions">
          <select
            aria-label="分析账号"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">选择已授权账号</option>
            {accounts?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <Button
            busy={busy}
            disabled={!account}
            onClick={async () => {
              setBusy(true);
              try {
                setRemote(await post(`/tiktok/${account}/videos`));
              } catch (e: any) {
                toast(e.message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            读取内容表现
          </Button>
        </div>
        {remote ? (
          <JsonView value={remote} />
        ) : (
          <p className="muted">
            需要 TikTok 的 video.list
            授权。这里不会展示演示账号的虚构播放量或收入。
          </p>
        )}
      </section>
    </div>
  );
}

const configGroups = [
  {
    name: "视频解析",
    provider: "resolver",
    description: "抖音解析适配器（可选独立服务）",
    link: "https://opendocs.echotik.live/realtime/video/downloadurl",
    fields: [
      ["DOWNLOAD_RESOLVER_URL", "解析服务 HTTPS 地址", false],
      ["DOWNLOAD_RESOLVER_KEY", "解析服务 Bearer Key", true],
    ],
  },
  {
    name: "EchoTik",
    provider: "echotik",
    description: "商品、视频、达人、店铺、直播与评论数据",
    link: "https://echotik.live/platform/api-keys",
    fields: [
      ["ECHOTIK_USERNAME", "API 用户名", true],
      ["ECHOTIK_PASSWORD", "API 密码", true],
      ["ECHOTIK_MONTHLY_LIMIT", "本平台月度成功请求上限", false],
      ["ECHOTIK_CACHE_SECONDS", "缓存秒数（0–86400）", false],
    ],
  },
  {
    name: "Gemini",
    provider: "gemini",
    description: "视频理解、销售脚本、评论洞察与提示词提取",
    link: "https://aistudio.google.com/apikey",
    fields: [
      ["GEMINI_API_KEY", "API Key", true],
      ["GEMINI_MODEL", "分析模型", false],
    ],
  },
  {
    name: "fal.ai",
    provider: "fal",
    description: "图片生成、商品转视频、参考角色与视频超分",
    link: "https://fal.ai/dashboard/keys",
    fields: [
      ["FAL_KEY", "API Key", true],
      ["FAL_VIDEO_MODEL", "图生视频模型", false],
      ["FAL_IMAGE_MODEL", "文生图模型", false],
      ["FAL_IMAGE_EDIT_MODEL", "参考图生成模型", false],
      ["FAL_ENHANCE_MODEL", "超分模型", false],
    ],
  },
  {
    name: "TikTok",
    provider: "tiktok",
    description: "账号授权、直接发布、定时发送与草稿箱",
    link: "https://developers.tiktok.com/",
    fields: [
      ["TIKTOK_CLIENT_KEY", "Client Key", true],
      ["TIKTOK_CLIENT_SECRET", "Client Secret", true],
      ["TIKTOK_REDIRECT_URI", "授权回调地址", false],
      ["TIKTOK_SCOPES", "授权 scopes（逗号分隔）", false],
    ],
  },
];
configGroups.sort(
  (a, b) =>
    Number(a.provider === "resolver") - Number(b.provider === "resolver"),
);
export function Settings() {
  const { status, refresh, toast } = useApp();
  const { data, reload, error } = useData<Doc>("/settings");
  const [values, setValues] = useState<Doc>({}),
    [busy, setBusy] = useState(false),
    [revealed, setRevealed] = useState(false),
    [clear, setClear] = useState<string[]>([]);
  useEffect(() => {
    if (data) setValues(data.values);
  }, [data]);
  async function submit() {
    setBusy(true);
    try {
      await api("/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...Object.fromEntries(
            Object.entries(values).filter(
              ([key]) =>
                !["CREDIT_COSTS_JSON", "STORAGE_LIMIT_MB"].includes(key),
            ),
          ),
          clearSecrets: clear,
        }),
      });
      setValues((v) =>
        Object.fromEntries(
          Object.entries(v).filter(
            ([k]) =>
              !configGroups.some((g) =>
                g.fields.some(([f, , secret]) => secret && f === k),
              ),
          ),
        ),
      );
      setClear([]);
      void reload();
      refresh();
      toast("配置已加密保存");
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page settings-page">
      <PageHead
        title="连接与设置"
        description="让数据与创作服务，接入同一个工作空间。"
      >
        <Button variant="primary" busy={busy} onClick={submit}>
          <Save size={15} />
          保存配置
        </Button>
      </PageHead>
      {error && <ErrorBox message={error} />}
      <div className="settings-summary">
        <span>
          <span className="status-dot green" />
          MySQL · 本地持久化
        </span>
        <span>已配置凭证不会返回浏览器；留空会保留原值。</span>
        <button onClick={() => setRevealed(!revealed)}>
          {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
          {revealed ? "隐藏" : "显示"}新输入
        </button>
      </div>
      {configGroups.map((g) => (
        <section className="config-section" key={g.name}>
          <div className="config-heading">
            <span className={`provider-symbol ${g.provider}`}>
              {g.name.slice(0, 1)}
            </span>
            <div>
              <h2>
                {g.name}
                <span
                  className={`provider-state ${data?.connections?.[g.provider] ? "connected" : ""}`}
                >
                  {data?.connections?.[g.provider] ? "凭证已配置" : "未连接"}
                </span>
              </h2>
              <p>{g.description}</p>
            </div>
            <a href={g.link} target="_blank" rel="noreferrer">
              获取凭证
              <ArrowUpRight size={14} />
            </a>
          </div>
          <div className="config-fields">
            {g.fields.map(([key, label, secret]) => (
              <label key={String(key)} className="field">
                <span>
                  {label}
                  {secret && data?.secrets?.[String(key)] && (
                    <small className="configured">已配置</small>
                  )}
                </span>
                <input
                  autoComplete="off"
                  type={secret && !revealed ? "password" : "text"}
                  value={values[String(key)] ?? ""}
                  placeholder={
                    secret && data?.secrets?.[String(key)]
                      ? "留空保留现有凭证"
                      : "请输入 " + label
                  }
                  onChange={(e) =>
                    setValues({ ...values, [String(key)]: e.target.value })
                  }
                />
                {secret && data?.secrets?.[String(key)] && (
                  <span className="clear-secret">
                    <input
                      type="checkbox"
                      checked={clear.includes(String(key))}
                      onChange={(e) =>
                        setClear((v) =>
                          e.target.checked
                            ? [...v, String(key)]
                            : v.filter((k) => k !== key),
                        )
                      }
                    />
                    移除此凭证
                  </span>
                )}
              </label>
            ))}
          </div>
          {g.provider === "echotik" && (
            <p className="config-note">
              使用专属 API 用户名/密码，采用 HTTP Basic。GMV 含预估；对外 SaaS
              展示、缓存和导出需确认数据许可。
            </p>
          )}
          {g.provider === "fal" && (
            <p className="config-note">
              当前字段适配 Kling v3、FLUX Schnell、Nano Banana 编辑与
              Topaz。修改模型须兼容对应输入 schema。供应商按实际调用收费。
            </p>
          )}
          {g.provider === "tiktok" && (
            <p className="config-note">
              需要开发者应用及相应 scopes。公开发布需要 TikTok
              审核；草稿箱任务仍需在 TikTok
              内完成。定时任务要求本地服务保持运行。
            </p>
          )}
        </section>
      ))}
      <div className="settings-save">
        <Button variant="primary" busy={busy} onClick={submit}>
          <Save size={15} />
          保存所有配置
        </Button>
        <span className="muted">密钥使用 AES-256-GCM 加密存储于 MySQL。</span>
      </div>
    </div>
  );
}

function PostEditor({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: accounts } = useData("/records/account");
  const { toast } = useApp();
  const [account, setAccount] = useState(""),
    [info, setInfo] = useState<Doc | null>(null),
    [asset, setAsset] = useState<Doc | null>(null),
    [picker, setPicker] = useState(false),
    [caption, setCaption] = useState(""),
    [mode, setMode] = useState("direct"),
    [privacy, setPrivacy] = useState(""),
    [schedule, setSchedule] = useState(""),
    [consent, setConsent] = useState(false),
    [isAigc, setAigc] = useState(true),
    [brandContent, setBrandContent] = useState(false),
    [brandOrganic, setBrandOrganic] = useState(false),
    [disableComment, setDisableComment] = useState(true),
    [disableDuet, setDisableDuet] = useState(true),
    [disableStitch, setDisableStitch] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setInfo(null);
    setPrivacy("");
    if (account)
      void post(`/tiktok/${account}/creator-info`)
        .then(setInfo)
        .catch((e) => setError(e.message));
  }, [account]);
  return (
    <Modal title="新建 TikTok 发布" onClose={onClose} wide>
      <div className="post-editor">
        <section>
          {asset ? (
            <>
              <video src={asset.url} controls playsInline />
              <p>{asset.name}</p>
            </>
          ) : (
            <Empty
              title="选择要发布的视频"
              description="从已生成作品或本地视频中选择。"
              icon={Film}
            />
          )}
          <div className="inline-actions">
            <Button onClick={() => setPicker(true)}>
              <FolderOpen size={15} />
              素材库
            </Button>
            <FilePicker
              accept="video/mp4,video/quicktime,video/webm"
              onPick={setAsset}
            />
          </div>
        </section>
        <section className="form-stack">
          <label className="field">
            发布账号
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">请选择已授权账号</option>
              {accounts?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {info && (
            <p className="account-disclosure">
              发布到：{info.creator_nickname || info.creator_username} · 最长{" "}
              {info.max_video_post_duration_sec || "—"} 秒
            </p>
          )}
          <label className="field">
            发布方式
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="direct">直接发布 / 定时发布</option>
              <option value="inbox">发送到 TikTok 草稿箱</option>
            </select>
          </label>
          {mode === "direct" && (
            <>
              <label className="field">
                文案
                <textarea
                  maxLength={2200}
                  value={caption}
                  rows={4}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder="添加文案和 #话题"
                />
              </label>
              <label className="field">
                谁可以观看（必须手动选择）
                <select
                  value={privacy}
                  onChange={(e) => setPrivacy(e.target.value)}
                >
                  <option value="">请选择</option>
                  {info?.privacy_level_options?.map((p: string) => (
                    <option key={p} value={p}>
                      {(
                        {
                          PUBLIC_TO_EVERYONE: "所有人",
                          MUTUAL_FOLLOW_FRIENDS: "互相关注的朋友",
                          FOLLOWER_OF_CREATOR: "关注者",
                          SELF_ONLY: "仅自己",
                        } as Doc
                      )[p] || p}
                    </option>
                  ))}
                </select>
              </label>
              <div className="checkbox-grid">
                <label>
                  <input
                    type="checkbox"
                    checked={!disableComment}
                    disabled={info?.comment_disabled}
                    onChange={(e) => setDisableComment(!e.target.checked)}
                  />
                  允许评论
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={!disableDuet}
                    disabled={info?.duet_disabled}
                    onChange={(e) => setDisableDuet(!e.target.checked)}
                  />
                  允许合拍
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={!disableStitch}
                    disabled={info?.stitch_disabled}
                    onChange={(e) => setDisableStitch(!e.target.checked)}
                  />
                  允许拼接
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={isAigc}
                    onChange={(e) => setAigc(e.target.checked)}
                  />
                  AI 生成内容
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={brandOrganic}
                    onChange={(e) => setBrandOrganic(e.target.checked)}
                  />
                  推广自己的品牌
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={brandContent}
                    onChange={(e) => setBrandContent(e.target.checked)}
                  />
                  付费品牌合作
                </label>
              </div>
              <label className="field">
                定时发送（选填，最多 30 天）
                <input
                  type="datetime-local"
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                />
                <small>采用本机时区；执行时会重新检查账号状态。</small>
              </label>
            </>
          )}
          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            我确认将所选视频发送到该 TikTok 账号，并同意 TikTok 的
            <a
              href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
              target="_blank"
              rel="noreferrer"
            >
              音乐使用确认
            </a>
            。付费合作内容另适用
            <a
              href="https://www.tiktok.com/legal/page/global/bc-policy/en"
              target="_blank"
              rel="noreferrer"
            >
              品牌内容政策
            </a>
            。
          </label>
          {error && <ErrorBox message={error} />}
          <Button
            variant="primary"
            busy={busy}
            disabled={
              !account ||
              !asset ||
              !consent ||
              !info ||
              (mode === "direct" && !privacy)
            }
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await newJob(
                  "publish",
                  {
                    accountId: account,
                    assetId: asset!.id,
                    caption,
                    mode,
                    privacy,
                    consent,
                    isAigc,
                    brandContent,
                    brandOrganic,
                    disableComment,
                    disableDuet,
                    disableStitch,
                  },
                  schedule ? new Date(schedule).toISOString() : undefined,
                );
                toast(schedule ? "已创建定时发布任务" : "发布任务已提交");
                onSaved();
                onClose();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Send size={15} />
            {schedule
              ? "确认定时发布"
              : mode === "inbox"
                ? "发送到草稿箱"
                : "确认发布"}
          </Button>
        </section>
      </div>
      {picker && (
        <AssetPicker
          type="video"
          onPick={setAsset}
          onClose={() => setPicker(false)}
        />
      )}
    </Modal>
  );
}
export function Publish() {
  const { data: accounts, reload: reloadAccounts } =
    useData("/records/account");
  const { data: jobs, reload, error } = useData("/jobs", 6000);
  const { toast } = useApp();
  const [editor, setEditor] = useState(false),
    [filter, setFilter] = useState("all"),
    [busy, setBusy] = useState(false);
  const posts = jobs?.filter(
    (j) => j.kind === "publish" && (filter === "all" || j.status === filter),
  );
  async function connect() {
    setBusy(true);
    try {
      const r = await post("/tiktok/connect");
      window.location.assign(r.url);
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <PageHead
        title="视频发布"
        description="从完成的作品，到自己的 TikTok 账号。"
      >
        <Button busy={busy} onClick={connect}>
          <Plug size={15} />
          连接 TikTok
        </Button>
        <Button variant="primary" onClick={() => setEditor(true)}>
          <Plus size={16} />
          新建发布
        </Button>
      </PageHead>
      <Connection provider="tiktok" label="TikTok 开发者应用" />
      <div className="accounts-strip">
        {accounts?.length ? (
          accounts.map((a) => (
            <div className="account-chip" key={a.id}>
              {a.avatar ? <img src={a.avatar} alt="" /> : <span>T</span>}
              <div>
                <strong>{a.name}</strong>
                <small>TikTok · 已授权</small>
              </div>
              <button
                className="icon-button"
                aria-label={`断开 ${a.name}`}
                onClick={async () => {
                  await del("account", a.id);
                  void reloadAccounts();
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        ) : (
          <>
            <span className="account-placeholder">
              <Users size={19} />
            </span>
            <div>
              <strong>连接你的 TikTok 账号</strong>
              <p>授权后，可以直接发布、定时发送或送达草稿箱。</p>
            </div>
            <Button busy={busy} onClick={connect}>
              连接账号 <ArrowUpRight size={14} />
            </Button>
          </>
        )}
      </div>
      <Tabs
        items={[
          { id: "all", label: "全部发布" },
          { id: "scheduled", label: "已定时" },
          { id: "processing", label: "发布中" },
          { id: "completed", label: "已完成" },
          { id: "inbox", label: "草稿箱" },
          { id: "review", label: "待核对" },
        ]}
        value={filter}
        onChange={setFilter}
      />
      {error && <ErrorBox message={error} />}
      {posts?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>发布内容</th>
                <th>账号</th>
                <th>方式</th>
                <th>状态</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.input.caption || "无文案视频"}
                    {p.error && (
                      <small className="danger-text">{p.error}</small>
                    )}
                  </td>
                  <td>
                    {accounts?.find((a) => a.id === p.input.accountId)?.name ||
                      "已断开账号"}
                  </td>
                  <td>
                    {p.input.mode === "inbox"
                      ? "草稿箱"
                      : p.runAt
                        ? "定时发布"
                        : "直接发布"}
                  </td>
                  <td>
                    <span className={`status-label ${p.status}`}>
                      {stateNames[p.status]}
                    </span>
                  </td>
                  <td>{date(p.runAt || p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="让你的第一条作品被看见"
          description="选择成品视频和发布账号，确认文案与可见范围后发送。"
          icon={Send}
        >
          <Button onClick={() => setEditor(true)}>
            <Plus size={15} />
            新建发布
          </Button>
        </Empty>
      )}
      {editor && (
        <PostEditor onClose={() => setEditor(false)} onSaved={() => reload()} />
      )}
    </div>
  );
}

export function Help() {
  return (
    <div className="page help-page">
      <PageHead
        title="使用指南"
        description="先连接服务，再把数据、创意和发布串成自己的工作流。"
      />
      <section>
        <h2>从选品到发布</h2>
        <ol className="help-steps">
          <li>
            <strong>连接数据</strong>
            <p>
              在设置中填写 EchoTik 专属 API
              用户名和密码。查询会记录来源、时间与估算状态。
            </p>
            <Link to="/settings">
              连接服务 <ArrowRight size={14} />
            </Link>
          </li>
          <li>
            <strong>研究商品与视频</strong>
            <p>
              在灵感与选品中查询榜单或最新搜索，研究经营详情、趋势和评论，收藏值得跟进的对象。
            </p>
            <Link to="/inspiration">
              发现机会 <ArrowRight size={14} />
            </Link>
          </li>
          <li>
            <strong>生成内容</strong>
            <p>
              上传商品图，选择 UGC、产品演示或访谈风格。Gemini
              用于脚本与分析；fal.ai 用于图片、视频和超分。
            </p>
            <Link to="/">
              开始创作 <ArrowRight size={14} />
            </Link>
          </li>
          <li>
            <strong>确认并发布</strong>
            <p>
              连接 TikTok
              应用和账号，选择视频、可见范围与发布时间。任务会持续记录实际供应商状态。
            </p>
            <Link to="/publish">
              发布作品 <ArrowRight size={14} />
            </Link>
          </li>
        </ol>
      </section>
      <section>
        <h2>数据与任务的边界</h2>
        <p>
          GMV 含外部预估，未收录不是零销量，金额保留来源币种。EchoTik
          数据不能替代自己的订单、库存、成本和利润。
        </p>
        <p>
          任务状态“待核对”表示提交结果不明确、轮询失败或服务中断。先查询供应商状态，避免重复提交和计费。本地定时发布需要服务保持运行。
        </p>
        <p>
          抖音解析可配置独立服务，也可先上传本地视频。提示词库需要从真实参考视频逐步积累，不会复制
          Clipcat 的专有案例数据库。
        </p>
      </section>
      <section>
        <h2>开发与配置文档</h2>
        <p>完整运行步骤、接口说明和功能对照见项目 README。</p>
        <a className="button" href="/api/help" target="_blank" rel="noreferrer">
          <BookOpen size={15} />
          打开项目文档
        </a>
      </section>
    </div>
  );
}

export function Downloads() {
  const [source, setSource] = useState(""),
    [busy, setBusy] = useState(false),
    [current, setCurrent] = useState(""),
    [error, setError] = useState("");
  const { data: jobs } = useData("/jobs", 4000);
  const { toast } = useApp();
  const job = jobs?.find((j) => j.id === current);
  return (
    <div className="page tool-page">
      <PageHead
        title="视频下载"
        description="将公开视频链接解析为素材，保留来源并归档到素材库。"
      />
      <div className="tool-layout">
        <section className="tool-input">
          <h2>视频链接</h2>
          <label className="field">
            TikTok / 抖音链接或视频直链
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="粘贴视频链接"
            />
            <small>
              TikTok 使用 EchoTik；抖音需要在设置中连接独立解析服务。单文件最大
              100MB。
            </small>
          </label>
          {error && <ErrorBox message={error} />}
          <Button
            variant="primary"
            busy={busy}
            disabled={!source.trim()}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const r = await newJob("download", { sourceUrl: source });
                setCurrent(r.id);
                toast("下载任务已提交");
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Download size={16} />
            解析并保存到素材库
          </Button>
          <p className="muted">
            仅下载你有权使用的素材。下载完成后可继续分析、抽取角色或研究销售结构。
          </p>
        </section>
        <section className="tool-output">
          <div className="section-heading">
            <h2>下载结果</h2>
            <Link className="text-link" to="/assets">
              素材库 <ArrowUpRight size={13} />
            </Link>
          </div>
          {job ? (
            <>
              <span className={`status-label ${job.status}`}>
                {stateNames[job.status]}
              </span>
              {job.error && <ErrorBox message={job.error} />}
              {job.result && <ResultView result={job.result} />}
            </>
          ) : (
            <Empty
              title="等待第一条参考视频"
              description="粘贴链接开始解析，视频文件会保存在本地素材库。"
              icon={Film}
            />
          )}
        </section>
      </div>
    </div>
  );
}
