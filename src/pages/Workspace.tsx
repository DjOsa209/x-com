import { VideoControls, PipelineProgress } from "../VideoPipeline";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowUp,
  Sparkles,
  ImagePlus,
  Plus,
  X,
  Users,
  ChevronDown,
  Clapperboard,
  Film,
  ScanLine,
  Play,
  Save,
  ArrowRight,
  FolderOpen,
  Lightbulb,
  Check,
  Clock3,
  Settings2,
  ShoppingBag,
  Mic2,
  Camera,
} from "lucide-react";
import {
  api,
  newJob,
  post,
  save,
  date,
  kindNames,
  stateNames,
  type Doc,
} from "../api";
import {
  useApp,
  useData,
  Button,
  FilePicker,
  AssetPicker,
  Connection,
  ResultView,
  ErrorBox,
  Empty,
} from "../ui";
import { recipes } from "../templates";

export function Workspace() {
  const { toast, refresh, status } = useApp();
  const location = useLocation(),
    navigate = useNavigate();
  const [videoOptions, setVideoOptions] = useState<Doc>({});
  const [prompt, setPrompt] = useState(""),
    [name, setName] = useState(""),
    [mode, setMode] = useState("video"),
    [assets, setAssets] = useState<Doc[]>([]),
    [source, setSource] = useState(""),
    [videoAsset, setVideoAsset] = useState<Doc | null>(null),
    [character, setCharacter] = useState(""),
    [style, setStyle] = useState("UGC"),
    [duration, setDuration] = useState("10"),
    [aspect, setAspect] = useState("9:16"),
    [language, setLanguage] = useState("English"),
    [busy, setBusy] = useState(false),
    [picker, setPicker] = useState(false),
    [current, setCurrent] = useState(""),
    [error, setError] = useState("");
  const { data: characters } = useData("/records/character"),
    { data: drafts, reload: reloadDrafts } = useData("/records/draft"),
    { data: jobs } = useData("/jobs", 4000);
  const active = jobs?.find((j) => j.id === current);
  useEffect(() => {
    const s = location.state as Doc;
    if (s) {
      if (s.prompt) setPrompt(s.prompt);
      if (s.sourceUrl) {
        setSource(s.sourceUrl);
        setMode("replicate");
      }
      if (s.mode) setMode(s.mode);
      if (s.asset) setAssets([s.asset]);
      if (s.draft) {
        const d = s.draft;
        setPrompt(d.prompt || "");
        setAssets(d.assets || []);
        setName(d.name || "");
        setMode(d.mode || "video");
        setSource(d.sourceUrl || "");
        setStyle(d.style || "UGC");
        setDuration(String(d.duration || 10));
        setAspect(d.aspect || "9:16");
        setLanguage(d.language || "English");
        setCharacter(d.characterId || "");
        setVideoAsset(d.videoAsset || null);
        setVideoOptions({
          videoModelId: d.videoModelId,
          segmentStrategy: d.segmentStrategy,
          segmentSeconds: d.segmentSeconds,
        });
      }
      navigate("/", { replace: true, state: null });
    }
  }, [location.state, navigate]);
  function attach(a: Doc) {
    setAssets((prev) =>
      prev.some((v) => v.id === a.id) ? prev : [...prev, a].slice(0, 5),
    );
  }
  const payload = () => ({
    name: name || "未命名创作",
    prompt,
    assetIds: assets.map((a) => a.id),
    sourceUrl: source,
    videoAssetId: videoAsset?.id,
    characterId: character || undefined,
    style,
    duration: Number(duration),
    aspect,
    language,
    ...videoOptions,
  });
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (["video", "replicate"].includes(mode)) {
        const project = await post("/projects", {
          name: name || "未命名创作",
          input: { ...payload(), mode },
        });
        navigate("/projects?id=" + project.id);
        toast("项目已保存，请生成分镜并确认分段计划");
        return;
      }
      const j = await newJob(mode, payload());
      setCurrent(j.id);
      toast("任务已提交，可在任务管理中查看");
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function draft() {
    if (!prompt && !assets.length) {
      toast("先添加商品图片或创作要求", true);
      return;
    }
    try {
      await save("draft", { ...payload(), mode, assets, videoAsset });
      toast("草稿已保存到 MySQL");
      void reloadDrafts();
    } catch (e: any) {
      toast(e.message, true);
    }
  }
  return (
    <div className="workspace-page">
      <div className="workspace-intro">
        <div className="welcome-orbit">
          <Sparkles size={19} />
        </div>
        <h1>让好产品，成为好内容。</h1>
        <p>你的电商创作搭档，从一个产品灵感开始。</p>
      </div>
      <section className="composer-wrap" aria-label="电商内容创作">
        <div className="composer">
          <div className="composer-top">
            <div className="asset-attachments">
              {assets.map((a) => (
                <div className="attachment" key={a.id}>
                  <img src={a.url} alt={a.name} />
                  <button
                    aria-label={`移除 ${a.name}`}
                    onClick={() =>
                      setAssets((v) => v.filter((x) => x.id !== a.id))
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {assets.length < 5 && (
                <FilePicker className="upload-tile" onPick={attach}>
                  <ImagePlus size={25} />
                  <span>{assets.length ? "添加图片" : "上传商品图"}</span>
                </FilePicker>
              )}
              <div className="upload-context">
                <strong>
                  {assets.length
                    ? `${assets.length} 张参考图片`
                    : "从你的产品开始"}
                </strong>
                <span>JPG、PNG、WebP · 最多 5 张</span>
                <button onClick={() => setPicker(true)}>
                  从素材库选择 <ChevronDown size={12} />
                </button>
              </div>
            </div>
            <button
              className="icon-button"
              title="保存草稿"
              aria-label="保存草稿"
              onClick={draft}
            >
              <Save size={17} />
            </button>
          </div>
          <label className="sr-only" htmlFor="creative-prompt">
            创作要求
          </label>
          <textarea
            id="creative-prompt"
            className="creative-textarea"
            maxLength={4000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述你的产品和创意。比如：为一款便携咖啡机，制作一条真实自然的 UGC 开箱视频……"
          />
          {mode === "replicate" && (
            <div className="reference-input">
              <Film size={17} />
              {videoAsset ? (
                <span className="selected-file">
                  {videoAsset.name}
                  <button
                    aria-label="移除参考视频"
                    onClick={() => setVideoAsset(null)}
                  >
                    <X size={13} />
                  </button>
                </span>
              ) : (
                <input
                  aria-label="参考视频链接"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="粘贴 TikTok 视频链接或视频直链"
                />
              )}
              <FilePicker
                accept="video/mp4,video/quicktime,video/webm"
                onPick={setVideoAsset}
              >
                <Plus size={14} />
                本地视频
              </FilePicker>
            </div>
          )}
          <div className="composer-count">{prompt.length} / 4000</div>
          <div className="composer-bottom">
            <div className="composer-controls">
              <label className="mode-select">
                <Sparkles size={14} />
                <select
                  aria-label="创作模式"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="video">商品转视频</option>
                  <option value="replicate">一键复刻</option>
                  <option value="image">电商图片</option>
                  <option value="script">销售脚本</option>
                </select>
                <ChevronDown size={12} />
              </label>
              <span className="model-label">
                {mode === "script"
                  ? "Gemini"
                  : mode === "image"
                    ? "图片生成模型"
                    : "可配置视频模型"}
                <span className="tiny-dot" />
              </span>
            </div>
            <div className="composer-submit">
              <span>
                {mode === "script"
                  ? "从卖点到可拍摄分镜"
                  : ["video", "replicate"].includes(mode)
                    ? "下一步：审阅分镜与生成计划"
                    : "从灵感到成品"}
              </span>
              <Button
                className="generate-button"
                aria-label="开始创作"
                busy={busy}
                disabled={!prompt.trim()}
                onClick={submit}
              >
                <ArrowUp size={21} />
              </Button>
            </div>
          </div>
          <div className="composer-settings">
            <label>
              <Users size={14} />
              <select
                aria-label="出镜角色"
                value={character}
                onChange={(e) => setCharacter(e.target.value)}
              >
                <option value="">选择角色</option>
                {characters?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <select
                aria-label="内容风格"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
              >
                <option>UGC</option>
                <option>产品演示</option>
                <option>人物访谈</option>
              </select>
            </label>
            <label>
              <select
                aria-label="时长"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              >
                <option value="5">5 秒</option>
                <option value="10">10 秒</option>
                <option value="15">15 秒</option>
                {[20, 30, 45, 60, 90, 120].map((n) => (
                  <option key={n} value={n}>
                    {n} 秒
                  </option>
                ))}
              </select>
            </label>
            <label>
              <select
                aria-label="画幅"
                value={aspect}
                onChange={(e) => setAspect(e.target.value)}
              >
                <option>9:16</option>
                <option>16:9</option>
                <option>1:1</option>
              </select>
            </label>
            <label>
              <select
                aria-label="内容语言"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="English">英语</option>
                <option value="Chinese">中文</option>
              </select>
            </label>
            <input
              className="project-name"
              aria-label="项目名称"
              placeholder="项目名称（选填）"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
      </section>
      {["video", "replicate"].includes(mode) && (
        <section className="config-section">
          <h2>视频生成设置</h2>
          <VideoControls value={videoOptions} onChange={setVideoOptions} />
          <p className="config-note">
            下一步生成分镜，预览每段的模型时长与调用数量，再确认生成视频。
          </p>
        </section>
      )}
      <div className="composer-links">
        <Link to="/inspiration">
          <ShoppingBag size={15} />
          发现好产品
          <ArrowUpRight size={12} />
        </Link>
        <Link to="/prompts">
          <Play size={14} />
          寻找爆款灵感
          <ArrowUpRight size={12} />
        </Link>
        <Link to="/analysis">
          <ScanLine size={15} />
          拆解一条视频
          <ArrowUpRight size={12} />
        </Link>
      </div>
      {error && <ErrorBox message={error} />}
      <Connection
        provider={mode === "script" ? "gemini" : "fal"}
        label={mode === "script" ? "Gemini 脚本服务" : "图片 / 视频生成服务"}
      />
      {active && (
        <section className="active-result">
          <div className="section-heading">
            <h2>{active.status === "completed" ? "创作结果" : "创作任务"}</h2>
            <Link to="/tasks" className="text-link">
              查看任务 <ArrowRight size={14} />
            </Link>
          </div>
          <span className={`status-label ${active.status}`}>
            {stateNames[active.status]}
          </span>
          {active.error && <ErrorBox message={active.error} />}
          <PipelineProgress pipeline={active.pipeline} />
          {active.result && <ResultView result={active.result} />}
        </section>
      )}
      <section className="creative-start">
        <div className="section-heading">
          <h2>今天，想怎么讲你的产品？</h2>
          <span className="muted">创作模板</span>
        </div>
        <div className="recipe-grid">
          {recipes.map((r, i) => {
            const Icon = [Camera, ShoppingBag, Mic2][i];
            return (
              <button
                key={r.id}
                className={`recipe ${r.color}`}
                onClick={() => {
                  setPrompt(r.prompt);
                  setStyle(r.style);
                  document.getElementById("creative-prompt")?.focus();
                }}
              >
                <span className="recipe-icon">
                  <Icon size={23} strokeWidth={1.5} />
                </span>
                <div>
                  <h3>{r.title}</h3>
                  <p>{r.label}</p>
                </div>
                <ArrowUpRight size={16} />
              </button>
            );
          })}
        </div>
      </section>
      <section className="recent-section">
        <div className="section-heading">
          <h2>最近的创作</h2>
          <Link to="/tasks" className="text-link">
            全部任务 <ArrowRight size={14} />
          </Link>
        </div>
        {!drafts?.length && !jobs?.length ? (
          <div className="recent-empty">
            <span className="mini-folder">
              <FolderOpen size={22} />
            </span>
            <div>
              <strong>你的下一个创意，从这里开始</strong>
              <p>上传产品图开始创作，或者先把灵感保存为草稿。</p>
            </div>
            <button className="text-link" onClick={draft}>
              保存草稿 <Plus size={14} />
            </button>
          </div>
        ) : (
          <div className="recent-list">
            {drafts?.slice(0, 3).map((d) => (
              <button
                key={d.id}
                onClick={() => navigate("/", { state: { draft: d } })}
              >
                <span className="list-icon">
                  <Save size={18} />
                </span>
                <div>
                  <strong>{d.name || "未命名草稿"}</strong>
                  <small>草稿 · {date(d.updatedAt)}</small>
                </div>
                <ArrowUpRight size={16} />
              </button>
            ))}
            {jobs?.slice(0, 3).map((j) => (
              <button key={j.id} onClick={() => setCurrent(j.id)}>
                <span className="list-icon">
                  <Film size={18} />
                </span>
                <div>
                  <strong>{j.input.name || kindNames[j.kind]}</strong>
                  <small>
                    {kindNames[j.kind]} · {date(j.createdAt)}
                  </small>
                </div>
                <span className={`status-label ${j.status}`}>
                  {stateNames[j.status]}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      {picker && (
        <AssetPicker
          type="image"
          onPick={attach}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}
