import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Upload,
  Download,
  FolderOpen,
  Music,
  Check,
  Archive,
  ArrowRight,
  Trash2,
} from "lucide-react";
import { api, upload, date, type Doc } from "../api";
import {
  useData,
  useApp,
  PageHead,
  Button,
  Tabs,
  Empty,
  ErrorBox,
  Modal,
} from "../ui";
import { PageNavigation } from "../components";

export function Library() {
  const navigate = useNavigate(),
    { toast } = useApp();
  const [page, setPage] = useState(1),
    [q, setQ] = useState(""),
    [type, setType] = useState("all"),
    [archived, setArchived] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [uploadError, setUploadError] = useState("");
  const { data, error, loading, reload } = useData<Doc>(
    `/library/asset?page=${page}&pageSize=24&q=${encodeURIComponent(q)}&archived=${archived}${type === "all" ? "" : "&type=" + type}`,
  );
  const mutate = async (id: string, body: Doc) => {
    await api(`/records/asset/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    void reload();
  };
  async function batchDownload() {
    setBusy(true);
    try {
      const r = await fetch("/api/assets/archive-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selected }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "x-ecommerce-assets.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  const go = (a: Doc, path: string) =>
    navigate(
      path +
        (path === "/publish" || path === "/studio/edit"
          ? `?assetId=${encodeURIComponent(a.id)}`
          : ""),
      {
        state:
          path === "/"
            ? {
                asset: a.type === "image" ? a : undefined,
                videoAsset: a.type === "video" ? a : undefined,
                mode: a.type === "video" ? "replicate" : "video",
              }
            : { asset: a },
      },
    );
  return (
    <div className="page">
      <PageHead
        title="素材库"
        description="图片、视频和音频集中管理，随时进入下一步创作。"
      >
        <label className={`button primary ${busy ? "disabled" : ""}`}>
          <Upload size={16} />
          批量上传
          <input
            aria-label="上传素材"
            type="file"
            multiple
            disabled={busy}
            hidden
            accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,.m4a"
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = "";
              setBusy(true);
              setUploadError("");
              const errors: string[] = [];
              for (let i = 0; i < files.length; i++) {
                setProgress(
                  `正在上传 ${i + 1}/${files.length}：${files[i].name}`,
                );
                try {
                  await upload(files[i]);
                } catch (err: any) {
                  errors.push(files[i].name + "：" + err.message);
                }
              }
              setProgress("");
              setBusy(false);
              setUploadError(errors.join("；"));
              void reload();
              toast(
                `${files.length - errors.length} 个素材已上传`,
                !!errors.length,
              );
            }}
          />
        </label>
      </PageHead>
      <div className="list-toolbar">
        <Tabs
          items={[
            { id: "all", label: "全部" },
            { id: "image", label: "图片" },
            { id: "video", label: "视频" },
            { id: "audio", label: "音频" },
          ]}
          value={type}
          onChange={(v) => {
            setType(v);
            setPage(1);
            setSelected([]);
          }}
        />
        <input
          aria-label="搜索素材"
          placeholder="搜索名称或标签"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
              setPage(1);
            }}
          />
          显示已归档
        </label>
      </div>
      {progress && <p role="status">{progress}</p>}
      {(error || uploadError) && (
        <ErrorBox message={error || uploadError} retry={reload} />
      )}
      {!!selected.length && (
        <div className="selection-bar">
          <span>已选 {selected.length} 个素材</span>
          <Button busy={busy} onClick={batchDownload}>
            <Download size={15} />
            打包下载
          </Button>
          <Button
            onClick={async () => {
              try {
                await Promise.all(
                  selected.map((id) => mutate(id, { archived: !archived })),
                );
                setSelected([]);
                toast(archived ? "已恢复" : "已归档");
              } catch (e: any) {
                toast(e.message, true);
              }
            }}
          >
            <Archive size={15} />
            {archived ? "恢复" : "归档"}
          </Button>
          <Button onClick={() => setSelected([])}>清除选择</Button>
        </div>
      )}
      {loading ? (
        <p role="status">正在读取素材…</p>
      ) : data?.items?.length ? (
        <>
          <div className="assets-grid">
            {data.items.map((a: Doc) => (
              <article className="asset-card" key={a.id}>
                <div className="asset-selection">
                  <label>
                    <input
                      aria-label={`选择 ${a.name}`}
                      type="checkbox"
                      checked={selected.includes(a.id)}
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked
                            ? [...s, a.id]
                            : s.filter((id) => id !== a.id),
                        )
                      }
                    />
                    选择
                  </label>
                </div>
                <button className="asset-preview" onClick={() => setDetail(a)}>
                  {a.type === "image" ? (
                    <img src={a.url} alt={a.name} loading="lazy" />
                  ) : a.type === "audio" ? (
                    <Music size={40} />
                  ) : (
                    <video src={a.url} preload="metadata" />
                  )}
                </button>
                <div className="asset-caption">
                  <strong>{a.name}</strong>
                  <small>
                    {
                      { image: "图片", video: "视频", audio: "音频" }[
                        a.type as string
                      ]
                    }{" "}
                    · {(a.bytes / 1048576).toFixed(2)} MB
                  </small>
                </div>
                <div className="asset-actions">
                  <button
                    onClick={() =>
                      a.type === "audio"
                        ? setDetail(a)
                        : go(a, a.type === "image" ? "/" : "/studio/edit")
                    }
                  >
                    {a.type === "image"
                      ? "用于创作"
                      : a.type === "video"
                        ? "编辑成片"
                        : "音频详情"}
                    <ArrowRight size={13} />
                  </button>
                  <a
                    aria-label={`下载 ${a.name}`}
                    href={`/api/assets/${a.id}/download`}
                  >
                    <Download size={15} />
                  </a>
                </div>
              </article>
            ))}
          </div>
          <PageNavigation
            page={page}
            pageSize={24}
            total={data.total}
            onChange={setPage}
          />
        </>
      ) : (
        <Empty
          title={
            q
              ? "没有匹配的素材"
              : archived
                ? "暂无归档素材"
                : "添加第一份商品素材"
          }
          description="上传图片、视频或音频。单个文件最大 100MB，上传后可用于创作和后期。"
          icon={FolderOpen}
        />
      )}
      {detail && (
        <AssetDetail
          asset={detail}
          onClose={() => setDetail(null)}
          onSaved={() => {
            void reload();
            setDetail(null);
          }}
          onGo={go}
        />
      )}
    </div>
  );
}
function AssetDetail({
  asset,
  onClose,
  onSaved,
  onGo,
}: {
  asset: Doc;
  onClose: () => void;
  onSaved: () => void;
  onGo: (a: Doc, path: string) => void;
}) {
  const [name, setName] = useState(asset.name),
    [tags, setTags] = useState((asset.tags || []).join(", ")),
    [busy, setBusy] = useState(false);
  const { toast } = useApp();
  const { data: refs, error } = useData<Doc[]>(
    `/assets/${asset.id}/references`,
  );
  return (
    <Modal title="素材详情" onClose={onClose} wide>
      <div className="asset-detail">
        <div>
          {asset.type === "image" ? (
            <img src={asset.url} alt={asset.name} />
          ) : asset.type === "audio" ? (
            <audio src={asset.url} controls />
          ) : (
            <video src={asset.url} controls playsInline />
          )}
          <div className="inline-actions">
            {asset.type === "video" && (
              <>
                <Button onClick={() => onGo(asset, "/analysis")}>分析</Button>
                <Button onClick={() => onGo(asset, "/")}>复刻</Button>
                <Button onClick={() => onGo(asset, "/enhance")}>超分</Button>
                <Button onClick={() => onGo(asset, "/studio/edit")}>
                  后期编辑
                </Button>
                <Button onClick={() => onGo(asset, "/publish")}>发布</Button>
              </>
            )}
            {asset.type === "image" && (
              <Button onClick={() => onGo(asset, "/")}>用于创作</Button>
            )}
          </div>
        </div>
        <div className="form-stack">
          <label className="field">
            名称
            <input
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            标签（逗号分隔）
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <p className="muted">
            {asset.mime} · {date(asset.createdAt)}
          </p>
          {asset.jobId && (
            <Link to={`/tasks?jobId=${asset.jobId}`}>查看生成任务</Link>
          )}
          {asset.projectId && (
            <Link to={`/projects?projectId=${asset.projectId}`}>
              查看创作项目
            </Link>
          )}
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/records/asset/${asset.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    name,
                    tags: tags
                      .split(/[,，]/)
                      .map((v: string) => v.trim())
                      .filter(Boolean),
                  }),
                });
                onSaved();
              } catch (e: any) {
                toast(e.message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Check size={15} />
            保存修改
          </Button>
          <Button
            onClick={async () => {
              try {
                await api(`/records/asset/${asset.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ archived: !asset.archived }),
                });
                onSaved();
              } catch (e: any) {
                toast(e.message, true);
              }
            }}
          >
            {asset.archived ? "恢复到素材库" : "归档素材"}
          </Button>
          <details>
            <summary>引用情况（{refs?.length ?? "…"}）</summary>
            {error && <ErrorBox message={error} />}
            <ul>
              {refs?.map((r, i) => (
                <li key={i}>
                  {r.kind} · {r.id}
                </li>
              ))}
            </ul>
            {refs?.length === 0 && <p>暂未被项目或任务引用。</p>}
          </details>
          <Button
            disabled={!refs || refs.length > 0}
            onClick={async () => {
              try {
                await api(`/records/asset/${asset.id}`, { method: "DELETE" });
                onSaved();
              } catch (e: any) {
                toast(e.message, true);
              }
            }}
          >
            <Trash2 size={15} />
            删除未引用素材
          </Button>
        </div>
      </div>
    </Modal>
  );
}
