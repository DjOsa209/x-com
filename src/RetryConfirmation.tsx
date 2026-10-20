import { useState } from "react";
import { api, post, type Doc } from "./api";
import { Button, Modal, ErrorBox, useApp } from "./ui";
export function RetryAction({
  endpoint,
  onRetried,
  children,
}: {
  endpoint: string;
  onRetried: (value: Doc) => void;
  children: React.ReactNode;
}) {
  const [quote, setQuote] = useState<Doc | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { toast } = useApp();
  return (
    <>
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            setQuote(await api(endpoint + "-quote"));
          } catch (e: any) {
            toast(e.message, true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
      </Button>
      {quote && (
        <Modal
          title="确认重试与新增费用"
          onClose={() => !busy && setQuote(null)}
        >
          <div className="form-stack">
            {quote.jobs.map((q: Doc) => (
              <section key={q.jobId}>
                <p>
                  {q.pendingSegments == null
                    ? "模型/分析任务"
                    : `${q.pendingSegments} 个片段需重试，${q.reusedSegments} 个成功片段复用`}
                </p>
                <strong>
                  {q.amount == null
                    ? "新增费用未知"
                    : q.amount === 0
                      ? "无新增模型生成费"
                      : `新增估算 ${q.currency || ""} ${q.amount}`}
                </strong>
                {q.components.map((c: Doc, i: number) => (
                  <p className="muted" key={i}>
                    {c.label} · {c.modelId} · {c.seconds} 秒 / {c.requests} 次 ·{" "}
                    {c.amount == null
                      ? "未知"
                      : `${c.currency || ""} ${c.amount}`}
                  </p>
                ))}
                <p className="muted">{q.notice}</p>
              </section>
            ))}
            {!quote.jobs.length && <p>项目将返回草稿，不提交生成请求。</p>}
            <p>
              重试产生新的任务和费用记录。请先确认供应商已明确失败，或此前任务尚未提交。
            </p>
            {error && <ErrorBox message={error} />}
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await post(endpoint, {
                    confirm: true,
                    fingerprint: quote.fingerprint || quote.jobs[0].fingerprint,
                  });
                  setQuote(null);
                  onRetried(r);
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认新增费用并重试
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
