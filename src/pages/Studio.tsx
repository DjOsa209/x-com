import { RetryAction } from "../RetryConfirmation";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Plus,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Trash2,
  Save,
  Copy,
  Archive,
  Clapperboard,
  Download,
  RefreshCw,
  Film,
} from "lucide-react";
import { api, post, type Doc, date } from "../api";
import {
  useData,
  useApp,
  PageHead,
  Button,
  Empty,
  ErrorBox,
  FilePicker,
  AssetPicker,
  Tabs,
  ResultView,
} from "../ui";
import { VideoControls, PlanPreview, PipelineProgress } from "../VideoPipeline";
import "../studio.css";
const statusLabels: Doc = {
  draft: "草稿",
  processing: "处理中",
  waiting_confirmation: "待确认分镜",
  completed: "已完成",
  partially_completed: "部分完成",
  failed: "失败",
  review: "待核对",
  cancelled: "已取消",
};
const seconds = (value: string) => {
  const m = value.match(/([\d.]+)\s*[-–]\s*([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};
function shotsOf(script: Doc, duration = 10): Doc[] {
  const source = script.scenes || script.shots || [];
  return Array.isArray(source)
    ? source.map((s: Doc, i: number) => {
        const t =
          typeof s.start === "number"
            ? [s.start, s.end]
            : seconds(s.time || "");
        return {
          ...s,
          id: s.id || crypto.randomUUID(),
          start: t?.[0] ?? (duration * i) / source.length,
          end: t?.[1] ?? (duration * (i + 1)) / source.length,
        };
      })
    : [];
}
function retime(shots: Doc[]): Doc[] {
  let at = 0;
  return shots.map((s) => {
    const d = Math.max(0.1, Number(s.end) - Number(s.start));
    const start = Math.round(at * 100) / 100;
    at += d;
    return { ...s, start, end: Math.round(at * 100) / 100, time: undefined };
  });
}
function downloadText(text: string, name: string, type = "text/plain") {
  const u = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function Quote({ value }: { value: Doc | null }) {
  return (
    <div className="studio-quote" aria-live="polite">
      <strong>供应商生成成本估算</strong>
      <p>
        {!value
          ? "等待有效分镜…"
          : value.amount === null
            ? "尚无完整报价，请在报价规则中录入已核实的供应商价格。"
            : `${value.currency || ""} ${Number(value.amount).toFixed(4)}${value.status === "local" ? "（本地处理）" : "（估算）"}`}
      </p>
      {value?.components?.map((c: Doc, i: number) => (
        <p key={i} className="muted">
          {c.label} · {c.requests} 次 / {c.seconds} 秒 ·{" "}
          {c.amount === null ? "价格未知" : `${c.currency} ${c.amount}`}{" "}
          {c.priceCheckedAt && `· 核实于 ${date(c.priceCheckedAt)}`}
        </p>
      ))}
      <small>{value?.notice || "内部积分与供应商成本分开计量。"}</small>
    </div>
  );
}

export function Studio() {
  const [params, setParams] = useSearchParams(),
    id = params.get("id") || params.get("projectId");
  const [archived, setArchived] = useState(false),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [creating, setCreating] = useState(false),
    [tab, setTab] = useState(
      params.has("assetId") || window.location.pathname === "/studio/edit"
        ? "post"
        : "projects",
    );
  const { data, loading, error, reload } = useData(
    `/projects?archived=${archived}&q=${encodeURIComponent(query)}&limit=50&offset=${offset}`,
    6000,
  );
  const opened = (pid: string) => {
    setParams({ id: pid });
    setCreating(false);
  };
  if (id)
    return (
      <ProjectEditor id={id} onBack={() => setParams({})} onOpen={opened} />
    );
  return (
    <div className="page studio">
      <PageHead
        title="创作项目"
        description="把商品证据、销售脚本、分段视频和成片放在同一条工作流中。"
      >
        <Button variant="primary" onClick={() => setCreating(!creating)}>
          <Plus size={16} />
          创建项目
        </Button>
      </PageHead>
      <Tabs
        items={[
          { id: "projects", label: "项目" },
          { id: "batch", label: "批量创作" },
          { id: "post", label: "视频后期" },
          { id: "quotes", label: "报价规则" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "batch" ? (
        <BatchCreator
          onCreated={() => {
            setTab("projects");
            void reload();
          }}
        />
      ) : tab === "post" ? (
        <PostEditor initialAssetId={params.get("assetId") || undefined} />
      ) : tab === "quotes" ? (
        <QuoteRules />
      ) : (
        <>
          {creating && (
            <ProjectCreator
              onCreated={(p) => {
                void reload();
                opened(p.id);
              }}
            />
          )}
          <div className="list-toolbar">
            <input
              aria-label="搜索创作项目"
              placeholder="搜索项目名称"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
            <label className="studio-checkbox">
              <input
                type="checkbox"
                checked={archived}
                onChange={(e) => {
                  setArchived(e.target.checked);
                  setOffset(0);
                }}
              />
              已归档
            </label>
            <Button onClick={() => reload()}>
              <RefreshCw size={15} />
              刷新
            </Button>
          </div>
          {error && <ErrorBox message={error} />}
          {loading ? (
            <p className="muted">正在读取项目…</p>
          ) : data?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>状态</th>
                    <th>版本 / 语言</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                        {p.batch_id && (
                          <small className="studio-block muted">批量项目</small>
                        )}
                      </td>
                      <td>{statusLabels[p.status] || p.status}</td>
                      <td>
                        v{p.version} · {p.input.language || "English"}
                      </td>
                      <td>{date(p.updated_at)}</td>
                      <td>
                        <Button onClick={() => opened(p.id)}>打开项目</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="从一份商品资料开始"
              description="上传商品图，手动编写或生成分镜；确认生成计划后，再提交视频任务。"
              icon={Clapperboard}
            >
              <Button onClick={() => setCreating(true)}>创建第一个项目</Button>
            </Empty>
          )}
          <div className="studio-pagination">
            <Button
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              上一页
            </Button>
            <span>第 {offset / 50 + 1} 页</span>
            <Button
              disabled={!data || data.length < 50}
              onClick={() => setOffset(offset + 50)}
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
function ProjectCreator({ onCreated }: { onCreated: (p: Doc) => void }) {
  const { toast } = useApp();
  const [name, setName] = useState(""),
    [input, setInput] = useState<Doc>({
      prompt: "",
      duration: 10,
      language: "English",
      style: "UGC",
      aspect: "9:16",
      assetIds: [],
    }),
    [assets, setAssets] = useState<Doc[]>([]),
    [picker, setPicker] = useState(false),
    [busy, setBusy] = useState(false);
  const add = (a: Doc) => {
    setAssets((old) => [...old.filter((x) => x.id !== a.id), a].slice(0, 5));
  };
  return (
    <section className="studio-panel">
      <h2>新建创作项目</h2>
      <div className="studio-form-grid">
        <label className="field">
          项目名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
          />
        </label>
        <label className="field">
          创作模式
          <select
            value={input.mode || "video"}
            onChange={(e) => setInput({ ...input, mode: e.target.value })}
          >
            <option value="video">商品转视频</option>
            <option value="replicate">参考视频复刻</option>
          </select>
        </label>
        <label className="field studio-full">
          商品卖点与创作要求
          <textarea
            rows={4}
            value={input.prompt}
            onChange={(e) => setInput({ ...input, prompt: e.target.value })}
            maxLength={4000}
          />
        </label>
        {input.mode === "replicate" && (
          <label className="field studio-full">
            参考视频链接
            <input
              value={input.sourceUrl || ""}
              onChange={(e) =>
                setInput({ ...input, sourceUrl: e.target.value })
              }
              placeholder="TikTok 分享链接或视频直链"
            />
          </label>
        )}
        <label className="field">
          口播语言
          <input
            value={input.language}
            onChange={(e) => setInput({ ...input, language: e.target.value })}
          />
        </label>
        <label className="field">
          内容风格
          <select
            value={input.style}
            onChange={(e) => setInput({ ...input, style: e.target.value })}
          >
            <option>UGC</option>
            <option>产品演示</option>
            <option>人物访谈</option>
            <option>问题解决</option>
          </select>
        </label>
      </div>
      <div className="studio-assets">
        {assets.map((a) => (
          <div key={a.id}>
            <img src={a.url} alt={a.name} />
            <button
              aria-label={`移除 ${a.name}`}
              onClick={() => setAssets(assets.filter((x) => x.id !== a.id))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="inline-actions">
        <FilePicker onPick={add} />
        <Button onClick={() => setPicker(true)}>从素材库选择商品图</Button>
      </div>
      <VideoControls value={input} onChange={setInput} duration />
      <Button
        variant="primary"
        busy={busy}
        disabled={!name.trim() || !input.prompt.trim() || !assets.length}
        onClick={async () => {
          setBusy(true);
          try {
            onCreated(
              await post("/projects", {
                name,
                input: { ...input, assetIds: assets.map((a) => a.id) },
              }),
            );
          } catch (e: any) {
            toast(e.message, true);
          } finally {
            setBusy(false);
          }
        }}
      >
        保存项目草稿
      </Button>
      {picker && (
        <AssetPicker
          type="image"
          onPick={add}
          onClose={() => setPicker(false)}
        />
      )}
    </section>
  );
}
function ProjectEditor({
  id,
  onBack,
  onOpen,
}: {
  id: string;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const { data: p, error, reload } = useData<Doc>(`/projects/${id}`, 5000),
    { toast } = useApp();
  const [input, setInput] = useState<Doc>({}),
    [script, setScript] = useState<Doc>({}),
    [name, setName] = useState(""),
    [count, setCount] = useState(1),
    [plan, setPlan] = useState<Doc | null>(null),
    [quote, setQuote] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("storyboard"),
    [revision, setRevision] = useState<Doc | null>(null),
    [postAsset, setPostAsset] = useState<Doc | null>(null);
  useEffect(() => {
    if (p) {
      setInput(p.input);
      setName(p.name);
      setScript({
        ...p.script,
        scenes: shotsOf(p.script || {}, p.input.duration || 10),
      });
      setCount(p.input.requestedVariants || 1);
    }
  }, [p?.id, p?.version, p?.status === "waiting_confirmation"]);
  const quoteRequest = JSON.stringify({
    input: { ...input, prompt: script.shootingPrompt || input.prompt },
    storyboard: script,
    count,
  });
  useEffect(() => {
    let active = true;
    setQuote(null);
    const timer = setTimeout(() => {
      post("/quotes/preview", JSON.parse(quoteRequest))
        .then((x) => {
          if (active) setQuote(x);
        })
        .catch(() => {});
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [quoteRequest]);
  const ready = useCallback((value: Doc | null) => setPlan(value), []);
  async function task(action: () => Promise<any>, message = "已保存") {
    setBusy(true);
    try {
      const result = await action();
      await reload();
      toast(message);
      return result;
    } catch (e: any) {
      toast(e.message, true);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    return api(`/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        version: p!.version,
        name,
        input,
        ...(script.scenes?.length
          ? {
              modifiedData: {
                ...script,
                shootingPrompt: script.shootingPrompt || input.prompt,
              },
            }
          : {}),
      }),
    });
  }
  const setShots = (shots: Doc[]) => {
    const next = retime(shots);
    setScript({ ...script, scenes: next });
    if (next.length)
      setInput({ ...input, duration: next[next.length - 1].end });
  };
  if (error)
    return (
      <div className="page">
        <ErrorBox message={error} />
        <Button onClick={onBack}>返回项目</Button>
      </div>
    );
  if (!p)
    return (
      <div className="page">
        <p>正在读取项目…</p>
      </div>
    );
  const editable = ["draft", "waiting_confirmation", "failed"].includes(
    p.status,
  );
  return (
    <div className="page studio">
      <Button onClick={onBack}>
        <ArrowLeft size={15} />
        全部项目
      </Button>
      <PageHead
        title={p.name}
        description={`${statusLabels[p.status] || p.status} · v${p.version}`}
      >
        <Button
          busy={busy}
          onClick={() =>
            task(async () => {
              const x = await post(`/projects/${id}/duplicate`);
              onOpen(x.id);
            }, "已复制为新的创作项目")
          }
        >
          <Copy size={15} />
          复制项目
        </Button>
        <Button
          busy={busy}
          disabled={["processing", "review"].includes(p.status)}
          onClick={() =>
            task(
              () => post(`/projects/${id}/archive`, { archived: !p.archived }),
              p.archived ? "已取消归档" : "已归档",
            )
          }
        >
          <Archive size={15} />
          {p.archived ? "取消归档" : "归档"}
        </Button>
      </PageHead>
      <Tabs
        items={[
          { id: "storyboard", label: "分镜与生成" },
          { id: "renders", label: "视频与片段" },
          { id: "post", label: "后期与封面" },
          { id: "history", label: "版本记录" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "storyboard" && (
        <div className="studio-editor-layout">
          <section>
            <div className="studio-form-grid">
              <label className="field">
                项目名称
                <input
                  disabled={!editable}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="field">
                口播语言
                <input
                  disabled={!editable}
                  value={input.language || "English"}
                  onChange={(e) =>
                    setInput({ ...input, language: e.target.value })
                  }
                />
              </label>
              <label className="field studio-full">
                商品与创作要求
                <textarea
                  disabled={!editable}
                  rows={3}
                  value={input.prompt || ""}
                  onChange={(e) =>
                    setInput({ ...input, prompt: e.target.value })
                  }
                />
              </label>
            </div>
            <div className="studio-section-heading">
              <h2>分镜时间轴</h2>
              <span className="muted">
                {script.scenes?.length || 0} 镜头 · {input.duration || 10} 秒
              </span>
            </div>
            {!script.scenes?.length && (
              <p className="muted">
                可以添加镜头手动编写，或连接 Gemini 生成分镜。
              </p>
            )}
            {(script.scenes || []).map((s: Doc, i: number) => (
              <article className="studio-shot" key={s.id || i}>
                <div className="studio-shot-heading">
                  <strong>
                    镜头 {i + 1}{" "}
                    <small>
                      {s.start}–{s.end} 秒
                    </small>
                  </strong>
                  <div className="inline-actions">
                    <Button
                      aria-label={`镜头 ${i + 1} 上移`}
                      disabled={!editable || !i}
                      onClick={() => {
                        const a = [...script.scenes];
                        [a[i - 1], a[i]] = [a[i], a[i - 1]];
                        setShots(a);
                      }}
                    >
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      aria-label={`镜头 ${i + 1} 下移`}
                      disabled={!editable || i === script.scenes.length - 1}
                      onClick={() => {
                        const a = [...script.scenes];
                        [a[i + 1], a[i]] = [a[i], a[i + 1]];
                        setShots(a);
                      }}
                    >
                      <ArrowDown size={14} />
                    </Button>
                    <Button
                      aria-label={`删除镜头 ${i + 1}`}
                      disabled={!editable}
                      onClick={() =>
                        setShots(
                          script.scenes.filter((_: Doc, j: number) => j !== i),
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
                <div className="studio-form-grid">
                  <label className="field">
                    时长（秒）
                    <input
                      type="number"
                      min={0.1}
                      max={120}
                      step={0.1}
                      disabled={!editable}
                      value={Math.round((s.end - s.start) * 100) / 100}
                      onChange={(e) =>
                        setShots(
                          script.scenes.map((x: Doc, j: number) =>
                            j === i
                              ? { ...x, end: x.start + Number(e.target.value) }
                              : x,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="field">
                    镜头方式
                    <input
                      disabled={!editable}
                      value={s.shot || ""}
                      onChange={(e) =>
                        setScript({
                          ...script,
                          scenes: script.scenes.map((x: Doc, j: number) =>
                            j === i ? { ...x, shot: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field studio-full">
                    画面与商品动作
                    <textarea
                      rows={2}
                      disabled={!editable}
                      value={s.visual || ""}
                      onChange={(e) =>
                        setScript({
                          ...script,
                          scenes: script.scenes.map((x: Doc, j: number) =>
                            j === i ? { ...x, visual: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field studio-full">
                    口播 / 字幕
                    <textarea
                      rows={2}
                      disabled={!editable}
                      value={s.voiceover || ""}
                      onChange={(e) =>
                        setScript({
                          ...script,
                          scenes: script.scenes.map((x: Doc, j: number) =>
                            j === i ? { ...x, voiceover: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </label>
                </div>
              </article>
            ))}
            {editable && (
              <div className="inline-actions">
                <Button
                  onClick={() =>
                    setShots([
                      ...(script.scenes || []),
                      {
                        id: crypto.randomUUID(),
                        start: 0,
                        end: script.scenes?.length
                          ? 3
                          : Number(input.duration || 10),
                        visual: "",
                        voiceover: "",
                        shot: "",
                      },
                    ])
                  }
                >
                  <Plus size={15} />
                  添加镜头
                </Button>
                <Button
                  busy={busy}
                  onClick={() =>
                    task(async () => {
                      await save();
                      return post(`/projects/${id}/prepare`);
                    }, "分镜生成任务已提交")
                  }
                >
                  AI 生成分镜
                </Button>
                <Button busy={busy} onClick={() => task(save)}>
                  <Save size={15} />
                  保存分镜
                </Button>
              </div>
            )}
            <label className="field studio-brief">
              整片拍摄提示
              <textarea
                disabled={!editable}
                rows={3}
                value={script.shootingPrompt || ""}
                placeholder="留空时使用商品创作要求"
                onChange={(e) =>
                  setScript({ ...script, shootingPrompt: e.target.value })
                }
              />
            </label>
          </section>
          <aside className="studio-render-options">
            <h2>生成计划</h2>
            <fieldset disabled={!editable}>
              <VideoControls value={input} onChange={setInput} />
              <label className="field">
                视频变体数量
                <select
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} 条（同一分镜，独立生成）
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <PlanPreview
              input={{
                ...input,
                prompt: script.shootingPrompt || input.prompt,
              }}
              storyboard={{
                ...script,
                shootingPrompt: script.shootingPrompt || input.prompt,
              }}
              onReady={ready}
            />
            <Quote value={quote} />
            <Button
              variant="primary"
              busy={busy}
              disabled={!editable || !plan || !quote}
              onClick={() =>
                task(async () => {
                  const saved = await save();
                  return post(`/projects/${id}/confirm`, {
                    version: saved.version,
                    modifiedData: {
                      ...script,
                      shootingPrompt: script.shootingPrompt || input.prompt,
                    },
                    videoGenerationCount: count,
                    renderOptions: Object.fromEntries(
                      [
                        "videoModelId",
                        "segmentStrategy",
                        "segmentSeconds",
                        "duration",
                        "aspect",
                        "resolution",
                        "generateAudio",
                        "frameSource",
                      ]
                        .filter((k) => input[k] !== undefined)
                        .map((k) => [k, input[k]]),
                    ),
                    planFingerprint: plan!.fingerprint,
                    quoteFingerprint: quote!.fingerprint,
                  });
                }, "已确认并提交视频生成")
              }
            >
              确认 {count} 条视频并生成
            </Button>
            <p className="muted">
              确认会提交可能计费的模型请求；各片段及报价按当前版本保存。
            </p>
          </aside>
        </div>
      )}
      {tab === "renders" && (
        <>
          <div className="inline-actions">
            {["failed", "cancelled", "partially_completed"].includes(
              p.status,
            ) && (
              <RetryAction
                endpoint={`/projects/${id}/retry`}
                onRetried={() => {
                  void reload();
                  toast("仅重试未成功的视频");
                }}
              >
                重试失败视频
              </RetryAction>
            )}
            {["processing", "review"].includes(p.status) && (
              <Button
                busy={busy}
                onClick={() =>
                  task(
                    () => post(`/projects/${id}/cancel`),
                    "已请求停止未提交片段",
                  )
                }
              >
                停止后续生成
              </Button>
            )}
          </div>
          {p.tasks
            ?.filter((t: Doc) => t.kind === "video")
            .map((t: Doc) => (
              <section className="studio-render" key={t.id}>
                <div className="studio-section-heading">
                  <h2>视频 {t.input.variant || 1}</h2>
                  <span>{statusLabels[t.status] || t.status}</span>
                </div>
                {t.error && <ErrorBox message={t.error} />}
                <ResultView result={t.result || {}} />
                {t.result?.asset && (
                  <div className="inline-actions">
                    <Button
                      onClick={() => {
                        setPostAsset(t.result.asset);
                        setTab("post");
                      }}
                    >
                      添加字幕 / 配音 / 封面
                    </Button>
                    <Link
                      className="button primary"
                      to={`/publish?assetId=${t.result.asset.id}`}
                    >
                      发布到 TikTok
                    </Link>
                    <Link
                      className="button"
                      to={`/enhance?assetId=${t.result.asset.id}`}
                    >
                      视频超分
                    </Link>
                  </div>
                )}
                <PipelineProgress pipeline={t.pipeline} />
                {t.status === "completed" && (
                  <div className="studio-segment-actions">
                    {t.pipeline?.segments?.map((s: Doc) => (
                      <Button
                        key={s.index}
                        onClick={() => setRevision({ job: t, segment: s })}
                      >
                        修改片段 {s.index + 1}
                      </Button>
                    ))}
                  </div>
                )}
              </section>
            ))}
          {!p.render_job_ids?.length && (
            <Empty
              title="还没有生成视频"
              description="在分镜页确认生成计划，或先手动完善脚本。"
            />
          )}
          {revision && (
            <SegmentRevision
              projectId={id}
              value={revision}
              onClose={() => setRevision(null)}
              onDone={() => {
                setRevision(null);
                void reload();
              }}
            />
          )}
        </>
      )}
      {tab === "post" && (
        <PostEditor
          initialAsset={
            postAsset ||
            p.tasks?.find((t: Doc) => t.result?.asset?.type === "video")?.result
              .asset
          }
          initialCues={(script.scenes || [])
            .filter((s: Doc) => s.voiceover?.trim())
            .map((s: Doc) => ({
              start: s.start,
              end: s.end,
              text: s.voiceover,
            }))}
        />
      )}
      {tab === "history" && <ProjectHistory id={id} />}
    </div>
  );
}
function SegmentRevision({
  projectId,
  value,
  onClose,
  onDone,
}: {
  projectId: string;
  value: Doc;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useApp();
  const [action, setAction] = useState("regenerate"),
    [prompt, setPrompt] = useState(value.segment.prompt || ""),
    [replacement, setReplacement] = useState<Doc | null>(null),
    [picker, setPicker] = useState(false),
    [quote, setQuote] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false),
    [requestKey] = useState(() => crypto.randomUUID());
  const body = {
    segmentIndex: value.segment.index,
    action,
    prompt: prompt || undefined,
    assetId: replacement?.id,
    dedupeKey: requestKey,
  };
  return (
    <section className="studio-panel studio-revision">
      <div className="studio-section-heading">
        <h2>修改片段 {value.segment.index + 1}</h2>
        <Button onClick={onClose}>关闭编辑</Button>
      </div>
      <p>
        保存为新的视频版本，保留原成片与其他成功片段。替换现有素材只执行本地拼接。
      </p>
      <label className="field">
        修改方式
        <select
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setQuote(null);
          }}
        >
          <option value="regenerate">重新生成此片段（可能计费）</option>
          <option value="replace">替换为素材库视频（本地合成）</option>
        </select>
      </label>
      {action === "regenerate" ? (
        <label className="field">
          片段生成提示
          <textarea
            rows={5}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setQuote(null);
            }}
          />
        </label>
      ) : (
        <div className="inline-actions">
          <Button onClick={() => setPicker(true)}>选择替换视频</Button>
          <span>
            {replacement?.name || `需要至少 ${value.segment.duration} 秒的视频`}
          </span>
        </div>
      )}
      <Quote value={quote} />
      <div className="inline-actions">
        <Button
          busy={busy}
          disabled={action === "replace" && !replacement}
          onClick={async () => {
            setBusy(true);
            try {
              setQuote(
                (
                  await post(
                    `/projects/${projectId}/renders/${value.job.id}/revision-preview`,
                    body,
                  )
                ).quote,
              );
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          预览本次修改费用
        </Button>
        <Button
          variant="primary"
          disabled={!quote}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await post(
                `/projects/${projectId}/renders/${value.job.id}/revise`,
                {
                  ...body,
                  ...(quote?.fingerprint !== "local"
                    ? { quoteFingerprint: quote!.fingerprint }
                    : {}),
                },
              );
              toast("已创建新视频版本");
              onDone();
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          确认修改并生成新版本
        </Button>
      </div>
      {picker && (
        <AssetPicker
          type="video"
          onPick={(a) => {
            setReplacement(a);
            setQuote(null);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </section>
  );
}
function ProjectHistory({ id }: { id: string }) {
  const { data, error } = useData<Doc>(`/projects/${id}/history`);
  return (
    <section className="studio-panel">
      <h2>版本与确认记录</h2>
      {error && <ErrorBox message={error} />}
      <p className="muted">旧成片与确认快照保留，修改片段会产生新的任务。</p>
      {!data ? (
        <p>正在读取…</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>版本</th>
                  <th>类型</th>
                  <th>时间</th>
                  <th>查看</th>
                </tr>
              </thead>
              <tbody>
                {data.scripts.map((s: Doc) => (
                  <tr key={s.id}>
                    <td>v{s.version}</td>
                    <td>分镜编辑前快照</td>
                    <td>{date(s.created_at)}</td>
                    <td>
                      <Button
                        onClick={() =>
                          downloadText(
                            JSON.stringify(s.snapshot, null, 2),
                            `storyboard-v${s.version}.json`,
                            "application/json",
                          )
                        }
                      >
                        导出 JSON
                      </Button>
                    </td>
                  </tr>
                ))}
                {data.confirmations.map((c: Doc) => (
                  <tr key={c.id}>
                    <td>v{c.version}</td>
                    <td>生成确认 · {c.jobIds.length} 条</td>
                    <td>{date(c.created_at)}</td>
                    <td>
                      <Button
                        onClick={() =>
                          downloadText(
                            JSON.stringify(
                              { storyboard: c.snapshot, quote: c.quote },
                              null,
                              2,
                            ),
                            `confirmation-v${c.version}.json`,
                            "application/json",
                          )
                        }
                      >
                        导出确认及报价
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.revisions.map((r: Doc) => (
            <p key={r.id}>
              片段 {r.change.segmentIndex + 1} ·{" "}
              {r.change.action === "replace" ? "素材替换" : "重新生成"} ·{" "}
              {date(r.created_at)}
            </p>
          ))}
          <h3>历史成片</h3>
          <div className="studio-history-videos">
            {data.tasks
              .filter((t: Doc) => t.result?.asset)
              .map((t: Doc) => (
                <div key={t.id}>
                  <video src={t.result.asset.url} controls preload="metadata" />
                  <a
                    className="button"
                    href={`/api/assets/${t.result.asset.id}/download`}
                  >
                    <Download size={15} />
                    {t.result.asset.name}
                  </a>
                </div>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
function BatchCreator({ onCreated }: { onCreated: () => void }) {
  const { toast } = useApp();
  const { data: assets } = useData("/records/asset");
  const [name, setName] = useState("商品内容批次"),
    [products, setProducts] = useState<Doc[]>([
      { name: "", prompt: "", assetId: "" },
    ]),
    [languages, setLanguages] = useState("English"),
    [variants, setVariants] = useState(1),
    [options, setOptions] = useState<Doc>({
      duration: 10,
      aspect: "9:16",
      videoModelId: "kie-seedance-mini",
      resolution: "480p",
      frameSource: "product",
    }),
    [preview, setPreview] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false),
    [key] = useState(() => crypto.randomUUID());
  const body = {
    name,
    products: products.map((p) => ({
      name: p.name,
      prompt: p.prompt,
      assetIds: [p.assetId],
    })),
    languages: languages
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean),
    variants,
    defaults: options,
    dedupeKey: key,
  };
  const serialized = JSON.stringify(body);
  useEffect(() => setPreview(null), [serialized]);
  const change = (i: number, k: string, v: string) =>
    setProducts(products.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  return (
    <section className="studio-panel">
      <h2>明确批次的商品与语言</h2>
      <p className="muted">
        先生成项目草稿，逐个审阅分镜后提交。创建批次不会消费视频生成额度。
      </p>
      <div className="studio-form-grid">
        <label className="field">
          批次名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          目标语言（逗号分隔）
          <input
            value={languages}
            onChange={(e) => setLanguages(e.target.value)}
            placeholder="English, Español"
          />
        </label>
        <label className="field">
          每个商品 / 语言的变体数量
          <select
            value={variants}
            onChange={(e) => setVariants(Number(e.target.value))}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      {products.map((p, i) => (
        <div className="studio-batch-row" key={i}>
          <label className="field">
            商品 {i + 1}
            <input
              aria-label={`商品 ${i + 1} 名称`}
              value={p.name}
              onChange={(e) => change(i, "name", e.target.value)}
              placeholder="商品名称"
            />
          </label>
          <label className="field">
            商品图
            <select
              value={p.assetId}
              onChange={(e) => change(i, "assetId", e.target.value)}
            >
              <option value="">选择已上传的图片</option>
              {assets
                ?.filter((a) => a.type === "image")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field studio-full">
            创作要求
            <textarea
              rows={2}
              value={p.prompt}
              onChange={(e) => change(i, "prompt", e.target.value)}
            />
          </label>
          <Button
            disabled={products.length === 1}
            onClick={() => setProducts(products.filter((_, j) => j !== i))}
          >
            <Trash2 size={14} />
            移除商品
          </Button>
        </div>
      ))}
      <Button
        disabled={products.length >= 20}
        onClick={() =>
          setProducts([...products, { name: "", prompt: "", assetId: "" }])
        }
      >
        <Plus size={15} />
        添加商品
      </Button>
      <VideoControls value={options} onChange={setOptions} duration />
      <div className="inline-actions">
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setPreview(await post("/projects/batch/preview", body));
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          预览批次数量
        </Button>
        {preview && (
          <>
            <strong>
              {preview.projectCount} 个项目 · 计划 {preview.videoCount} 条视频
            </strong>
            <Button
              busy={busy}
              variant="primary"
              onClick={async () => {
                setBusy(true);
                try {
                  await post("/projects/batch", body);
                  toast("已创建全部批次草稿");
                  onCreated();
                } catch (e: any) {
                  toast(e.message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              创建这些项目草稿
            </Button>
          </>
        )}
      </div>
      {preview && (
        <ul>
          {preview.items.map((p: Doc, i: number) => (
            <li key={i}>{p.name}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
export function PostEditor({
  initialAsset,
  initialAssetId,
  initialCues = [],
}: {
  initialAsset?: Doc;
  initialAssetId?: string;
  initialCues?: Doc[];
}) {
  const { toast } = useApp();
  const [asset, setAsset] = useState<Doc | null>(initialAsset || null),
    [picker, setPicker] = useState(""),
    [cues, setCues] = useState<Doc[]>(initialCues),
    [voice, setVoice] = useState<Doc | null>(null),
    [music, setMusic] = useState<Doc | null>(null),
    [options, setOptions] = useState<Doc>({
      burnCaptions: false,
      originalVolume: 1,
      voiceVolume: 1,
      musicVolume: 0.15,
      captionSize: 32,
    }),
    [cover, setCover] = useState(false),
    [coverTime, setCoverTime] = useState(0),
    [busy, setBusy] = useState(false),
    [jobId, setJobId] = useState<string | null>(null);
  const { data: jobs } = useData("/jobs", jobId ? 4000 : 0),
    job = jobs?.find((j) => j.id === jobId);
  useEffect(() => {
    if (initialAsset) {
      setAsset(initialAsset);
      setCues(initialCues);
    }
  }, [initialAsset?.id]);
  useEffect(() => {
    if (initialAssetId) {
      let active = true;
      api(`/records/asset/${initialAssetId}`)
        .then((a) => {
          if (active) {
            if (a.type !== "video") throw new Error("请选择视频素材");
            setAsset(a);
          }
        })
        .catch((e) => toast(e.message, true));
      return () => {
        active = false;
      };
    }
  }, [initialAssetId]);
  const updateCue = (i: number, k: string, v: any) =>
    setCues(cues.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  async function convert(format: "srt" | "vtt") {
    try {
      const r = await post("/video/subtitles/convert", { cues });
      downloadText(r[format], `captions.${format}`);
    } catch (e: any) {
      toast(e.message, true);
    }
  }
  return (
    <section className="studio-panel">
      <h2>视频后期与封面</h2>
      <p className="muted">
        使用本地 FFmpeg 处理素材，无需模型 API Key。配音使用上传的音频文件。
      </p>
      <div className="studio-post-layout">
        <div>
          <div className="inline-actions">
            <Button onClick={() => setPicker("video")}>选择原视频</Button>
            <FilePicker
              accept="video/mp4,video/quicktime,video/webm"
              onPick={setAsset}
            />
          </div>
          {asset ? (
            <>
              <p>{asset.name}</p>
              <video
                className="studio-post-video"
                src={asset.url}
                controls
                playsInline
                preload="metadata"
              />
            </>
          ) : (
            <Empty
              title="选择要处理的视频"
              description="可以使用生成成片或上传已有视频。"
              icon={Film}
            />
          )}
          <div className="studio-form-grid">
            <label className="field">
              原声音量
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={options.originalVolume}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    originalVolume: Number(e.target.value),
                  })
                }
              />
              <small>{Math.round(options.originalVolume * 100)}%</small>
            </label>
            <label className="field">
              配音音量
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={options.voiceVolume}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    voiceVolume: Number(e.target.value),
                  })
                }
              />
              <small>{Math.round(options.voiceVolume * 100)}%</small>
            </label>
          </div>
          <div className="studio-audio-row">
            <strong>配音</strong>
            <span>{voice?.name || "未添加"}</span>
            <FilePicker
              accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a"
              onPick={(a) => {
                setVoice(a);
                setOptions({ ...options, originalVolume: 0 });
              }}
            >
              上传配音
            </FilePicker>
            <Button onClick={() => setPicker("voice")}>素材库</Button>
            {voice && <Button onClick={() => setVoice(null)}>移除</Button>}
          </div>
          <div className="studio-audio-row">
            <strong>背景音乐</strong>
            <span>{music?.name || "未添加"}</span>
            <FilePicker
              accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a"
              onPick={setMusic}
            >
              上传音乐
            </FilePicker>
            <Button onClick={() => setPicker("music")}>素材库</Button>
            {music && <Button onClick={() => setMusic(null)}>移除</Button>}
          </div>
          <label className="field">
            音乐音量
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={options.musicVolume}
              onChange={(e) =>
                setOptions({ ...options, musicVolume: Number(e.target.value) })
              }
            />
            <small>
              {Math.round(options.musicVolume * 100)}%；音乐循环至成片结束。
            </small>
          </label>
          <div className="studio-form-grid">
            <label className="studio-checkbox">
              <input
                type="checkbox"
                checked={cover}
                onChange={(e) => setCover(e.target.checked)}
              />
              同时导出封面
            </label>
            {cover && (
              <label className="field">
                封面时间（秒）
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={coverTime}
                  onChange={(e) => setCoverTime(Number(e.target.value))}
                />
              </label>
            )}
          </div>
        </div>
        <div>
          <div className="studio-section-heading">
            <h3>字幕</h3>
            <label className="button">
              导入 SRT / VTT
              <input
                className="sr-only"
                type="file"
                accept=".srt,.vtt,text/plain,text/vtt"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    setCues(
                      (
                        await post("/video/subtitles/convert", {
                          text: await file.text(),
                        })
                      ).cues,
                    );
                  } catch (err: any) {
                    toast(err.message, true);
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <p className="muted">
            分镜口播可直接编辑为字幕。时间按成片全局秒数填写。
          </p>
          {cues.map((c, i) => (
            <div className="studio-cue" key={i}>
              <label>
                开始
                <input
                  aria-label={`字幕 ${i + 1} 开始秒数`}
                  type="number"
                  min={0}
                  step={0.1}
                  value={c.start}
                  onChange={(e) =>
                    updateCue(i, "start", Number(e.target.value))
                  }
                />
              </label>
              <label>
                结束
                <input
                  aria-label={`字幕 ${i + 1} 结束秒数`}
                  type="number"
                  min={0}
                  step={0.1}
                  value={c.end}
                  onChange={(e) => updateCue(i, "end", Number(e.target.value))}
                />
              </label>
              <button
                className="icon-button"
                aria-label={`删除字幕 ${i + 1}`}
                onClick={() => setCues(cues.filter((_, j) => j !== i))}
              >
                <Trash2 size={15} />
              </button>
              <textarea
                aria-label={`字幕 ${i + 1} 文本`}
                rows={2}
                value={c.text}
                onChange={(e) => updateCue(i, "text", e.target.value)}
              />
            </div>
          ))}
          <div className="inline-actions">
            <Button
              onClick={() =>
                setCues([
                  ...cues,
                  {
                    start: cues.at(-1)?.end || 0,
                    end: (cues.at(-1)?.end || 0) + 3,
                    text: "",
                  },
                ])
              }
            >
              <Plus size={14} />
              添加字幕
            </Button>
            <Button disabled={!cues.length} onClick={() => convert("srt")}>
              导出 SRT
            </Button>
            <Button disabled={!cues.length} onClick={() => convert("vtt")}>
              导出 VTT
            </Button>
          </div>
          <label className="studio-checkbox">
            <input
              type="checkbox"
              checked={options.burnCaptions}
              onChange={(e) =>
                setOptions({ ...options, burnCaptions: e.target.checked })
              }
            />
            将字幕烧录进视频画面
          </label>
          {options.burnCaptions && (
            <label className="field">
              字幕字号
              <input
                type="number"
                min={16}
                max={72}
                value={options.captionSize}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    captionSize: Number(e.target.value),
                  })
                }
              />
            </label>
          )}
          <Button
            variant="primary"
            busy={busy}
            disabled={!asset}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post("/video/edits", {
                  input: {
                    ...options,
                    assetId: asset!.id,
                    name: `${asset!.name} · 后期版`,
                    captions: cues,
                    voiceAssetId: voice?.id,
                    musicAssetId: music?.id,
                    ...(cover ? { coverTime } : {}),
                  },
                  dedupeKey: crypto.randomUUID(),
                });
                setJobId(r.id);
                toast("本地后期任务已提交");
              } catch (e: any) {
                toast(e.message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            导出新的成片
          </Button>
        </div>
      </div>
      {job && (
        <section className="studio-render">
          <h3>后期任务 · {statusLabels[job.status] || job.status}</h3>
          {job.error && <ErrorBox message={job.error} />}
          <ResultView result={job.result || {}} />
          {job.result?.coverAsset && (
            <a
              className="button"
              href={`/api/assets/${job.result.coverAsset.id}/download`}
            >
              下载封面
            </a>
          )}
          {job.result?.asset && (
            <Link
              className="button primary"
              to={`/publish?assetId=${job.result.asset.id}`}
            >
              发布此成片
            </Link>
          )}
        </section>
      )}
      {picker && (
        <AssetPicker
          type={picker === "video" ? "video" : "audio"}
          onPick={(a) => {
            if (picker === "video") setAsset(a);
            else if (picker === "voice") {
              setVoice(a);
              setOptions({ ...options, originalVolume: 0 });
            } else setMusic(a);
          }}
          onClose={() => setPicker("")}
        />
      )}
    </section>
  );
}
function QuoteRules() {
  const { data: auth } = useData<Doc>("/auth/status");
  const canEdit = !!auth && ["owner", "admin"].includes(auth.role);
  const { data: rules, error, reload } = useData("/quotes/rules"),
    { data: models } = useData<Doc>("/video/models"),
    { toast } = useApp();
  const [rule, setRule] = useState<Doc>({
      modelId: "kie-seedance-mini",
      resolution: "480p",
      unit: "second",
      amount: "",
      currency: "USD",
      source: "",
      priceCheckedAt: new Date().toISOString().slice(0, 10),
    }),
    [busy, setBusy] = useState(false);
  return (
    <section className="studio-panel">
      <h2>可核对的报价规则</h2>
      <p className="muted">
        工作空间管理员录入已核实价格。未录入的模型显示未知，不把历史促销价格当作当前账单。
      </p>
      {error && <ErrorBox message={error} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>模型 / 分辨率</th>
              <th>单价</th>
              <th>依据</th>
              <th>核实时间</th>
            </tr>
          </thead>
          <tbody>
            {rules?.map((r: Doc) => (
              <tr key={r.modelId + r.resolution}>
                <td>
                  {r.modelId} / {r.resolution}
                </td>
                <td>
                  {r.amount === null
                    ? "未知"
                    : `${r.currency} ${r.amount} / ${r.unit === "second" ? "秒" : "次"}`}
                </td>
                <td>{r.source}</td>
                <td>{date(r.priceCheckedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>新增或更新规则</h3>
      {!canEdit && <p className="muted">需要工作空间管理员保存报价规则。</p>}
      <fieldset disabled={!canEdit} className="studio-fieldset">
        <div className="studio-form-grid">
          <label className="field">
            模型 ID
            <input
              list="quote-models"
              value={rule.modelId}
              onChange={(e) => setRule({ ...rule, modelId: e.target.value })}
            />
            <datalist id="quote-models">
              {models?.models.map((m: Doc) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </datalist>
          </label>
          <label className="field">
            分辨率
            <input
              value={rule.resolution}
              onChange={(e) => setRule({ ...rule, resolution: e.target.value })}
              placeholder="480p / 720p / *"
            />
          </label>
          <label className="field">
            计价单位
            <select
              value={rule.unit}
              onChange={(e) => setRule({ ...rule, unit: e.target.value })}
            >
              <option value="second">每个原生生成秒</option>
              <option value="request">每次请求</option>
            </select>
          </label>
          <label className="field">
            单价（空白为未知）
            <input
              type="number"
              min={0}
              step="any"
              value={rule.amount}
              onChange={(e) => setRule({ ...rule, amount: e.target.value })}
            />
          </label>
          <label className="field">
            币种
            <input
              maxLength={3}
              value={rule.currency}
              onChange={(e) =>
                setRule({ ...rule, currency: e.target.value.toUpperCase() })
              }
            />
          </label>
          <label className="field">
            价格核实日期
            <input
              type="date"
              value={rule.priceCheckedAt}
              onChange={(e) =>
                setRule({ ...rule, priceCheckedAt: e.target.value })
              }
            />
          </label>
          <label className="field studio-full">
            价格来源 / 合同依据
            <input
              value={rule.source}
              onChange={(e) => setRule({ ...rule, source: e.target.value })}
              placeholder="官方价格页链接或合同记录"
            />
          </label>
        </div>
        <Button
          busy={busy}
          variant="primary"
          disabled={!rule.source || !rule.modelId}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/quotes/rules", {
                method: "PUT",
                body: JSON.stringify({
                  ...rule,
                  amount: rule.amount === "" ? null : Number(rule.amount),
                  priceCheckedAt: new Date(rule.priceCheckedAt).toISOString(),
                }),
              });
              await reload();
              toast("报价规则已保存，已确认任务保持原快照");
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          保存报价规则
        </Button>
      </fieldset>
    </section>
  );
}
