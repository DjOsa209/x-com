import { useEffect, useState } from "react";
import { post, type Doc } from "./api";
import { useData, ErrorBox } from "./ui";
export const strategyNames: Doc = {
  balanced: "优先保留完整镜头",
  shots: "按镜头分段",
  fixed: "按固定时长分段",
  single: "整条单次生成",
};
export function VideoControls({
  value,
  onChange,
  duration = false,
}: {
  value: Doc;
  onChange: (value: Doc) => void;
  duration?: boolean;
}) {
  const { data, error } = useData<Doc>("/video/models");
  const selected = value.videoModelId || data?.defaults.videoModelId || "";
  const model = data?.models.find((m: Doc) => m.id === selected);
  const provider = model?.provider || "fal";
  const changeModel = (id: string) => {
    const next = data?.models.find((m: Doc) => m.id === id);
    onChange({
      ...value,
      videoModelId: id,
      resolution: next?.resolutions[0],
      frameSource: next?.provider === "kie" ? "product" : "generated",
    });
  };
  return (
    <div className="config-fields video-controls">
      {error && <ErrorBox message={error} />}
      <label className="field">
        视频生成渠道
        <select
          value={provider}
          disabled={!data}
          onChange={(e) => {
            const next = data?.models.find(
              (m: Doc) => (m.provider || "fal") === e.target.value,
            );
            if (next) changeModel(next.id);
          }}
        >
          {[
            ...new Set<string>(
              data?.models.map((m: Doc) => m.provider || "fal") || ["fal"],
            ),
          ].map((p) => (
            <option key={p} value={p}>
              {p === "kie" ? "Kie.ai" : "fal.ai"}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        视频模型
        <select value={selected} onChange={(e) => changeModel(e.target.value)}>
          {!data && <option value="">正在读取模型…</option>}
          {data?.models
            .filter((m: Doc) => (m.provider || "fal") === provider)
            .map((m: Doc) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.resolutions.join("/")}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        视频分辨率
        <select
          value={value.resolution || model?.resolutions[0] || "720p"}
          disabled={!model}
          onChange={(e) => onChange({ ...value, resolution: e.target.value })}
        >
          {(model?.resolutions || ["720p"]).map((r: string) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {provider === "kie" && (
        <label className="field">
          首帧方式
          <select
            value={value.frameSource || "product"}
            onChange={(e) =>
              onChange({ ...value, frameSource: e.target.value })
            }
          >
            <option value="product">直接使用第一张商品图</option>
            <option value="generated">AI 场景首帧（fal.ai）</option>
          </select>
          <small>
            直接商品图无需 fal Key；AI 首帧会额外调用 fal 图像服务。
          </small>
        </label>
      )}
      <label className="field">
        分段策略
        <select
          value={
            value.segmentStrategy ||
            data?.defaults.segmentStrategy ||
            "balanced"
          }
          onChange={(e) =>
            onChange({ ...value, segmentStrategy: e.target.value })
          }
        >
          {Object.entries(strategyNames).map(([id, label]) => (
            <option key={id} value={id}>
              {String(label)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        每段目标时长（秒）
        <input
          type="number"
          min={1}
          max={30}
          value={value.segmentSeconds ?? data?.defaults.segmentSeconds ?? 8}
          disabled={
            (value.segmentStrategy || data?.defaults.segmentStrategy) ===
            "single"
          }
          onChange={(e) =>
            onChange({ ...value, segmentSeconds: Number(e.target.value) })
          }
        />
        <small>按模型原生时长生成，拼接时裁至计划时长。</small>
      </label>
      {duration && (
        <label className="field">
          成片时长（秒）
          <input
            type="number"
            min={1}
            max={120}
            value={value.duration || 10}
            onChange={(e) =>
              onChange({ ...value, duration: Number(e.target.value) })
            }
          />
        </label>
      )}
    </div>
  );
}
export function PlanPreview({
  input,
  storyboard,
  onReady,
}: {
  input: Doc;
  storyboard: Doc;
  onReady: (plan: Doc | null) => void;
}) {
  const [plan, setPlan] = useState<Doc | null>(null),
    [error, setError] = useState("");
  const serialized = JSON.stringify({ input, storyboard });
  useEffect(() => {
    let active = true;
    setPlan(null);
    setError("");
    onReady(null);
    const timer = setTimeout(() => {
      post("/video/plan", JSON.parse(serialized))
        .then((p) => {
          if (active) {
            setPlan(p);
            onReady(p);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [serialized, onReady]);
  return (
    <section
      className="render-plan"
      aria-label="分段生成计划"
      aria-live="polite"
    >
      <h3>分段生成计划</h3>
      {error ? (
        <ErrorBox message={error} />
      ) : !plan ? (
        <p className="muted">正在核对时间轴与模型能力…</p>
      ) : (
        <>
          <p>
            {plan.policy.model.name} · {strategyNames[plan.policy.strategy]} ·
            成片 {plan.duration} 秒
          </p>
          <p className="muted">
            每条视频 {plan.segments.length} 段，预计 {plan.providerCalls}{" "}
            次生成调用
            {plan.policy.frameSource === "product"
              ? "（直接使用商品图首帧）"
              : "（含每段 AI 首帧）"}
            。供应商按实际请求收费，重试另计。
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>片段</th>
                  <th>成片位置</th>
                  <th>保留时长</th>
                  <th>模型生成时长</th>
                </tr>
              </thead>
              <tbody>
                {plan.segments.map((s: Doc) => (
                  <tr key={s.index}>
                    <td>{s.index + 1}</td>
                    <td>
                      {s.start}–{s.end} 秒
                    </td>
                    <td>{s.duration} 秒</td>
                    <td>{s.nativeDuration} 秒</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.warnings.map((w: string) => (
            <p className="config-note" key={w}>
              {w}
            </p>
          ))}
          <p className="config-note">
            分段生成可能存在人物、口播及画面的衔接差异，请检查成片后再发布。
          </p>
        </>
      )}
    </section>
  );
}
const segmentNames: Doc = {
  queued: "等待生成",
  preparing: "准备素材",
  submitting_frame: "提交首帧",
  frame: "生成首帧",
  ready_video: "首帧已就绪",
  submitting_video: "提交视频",
  video: "生成片段",
  completed: "片段已保存",
  failed: "生成失败",
  review: "待核对",
  cancelled: "已停止",
};
export function PipelineProgress({ pipeline }: { pipeline?: Doc }) {
  if (!pipeline) return null;
  return (
    <section className="render-plan" aria-label="分段生成进度">
      <h3>分段生成与拼接</h3>
      <p>
        {pipeline.model} · {strategyNames[pipeline.strategy]} ·{" "}
        {pipeline.duration} 秒
      </p>
      <ol className="pipeline-segments">
        {pipeline.segments.map((s: Doc) => (
          <li key={s.index}>
            <span>
              片段 {s.index + 1} · {s.start}–{s.end} 秒
            </span>
            <strong>{segmentNames[s.status] || s.status}</strong>
            {s.error && <p className="error-text">{s.error}</p>}
            {s.asset?.url && (
              <a href={s.asset.url} target="_blank" rel="noreferrer">
                查看片段
              </a>
            )}
          </li>
        ))}
      </ol>
      <p className="config-note">
        拼接：
        {(
          {
            pending: "等待片段完成",
            processing: "正在统一画幅、音轨并拼接",
            completed: "成片已保存",
            failed: "拼接失败，重试将复用已成功片段",
          } as Doc
        )[pipeline.concatStatus] || pipeline.concatStatus}
      </p>
    </section>
  );
}
