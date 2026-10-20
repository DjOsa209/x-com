import { useState } from "react";
import { Link } from "react-router-dom";
import { api, post, date, type Doc } from "../api";
import { useData, useApp, PageHead, Button, ErrorBox, Empty } from "../ui";
import { PageNavigation } from "../components";

export function Sessions() {
  const { data, reload, error } = useData<Doc[]>("/auth/sessions");
  const { toast } = useApp();
  return (
    <section className="config-section">
      <h2>登录会话</h2>
      {error && <ErrorBox message={error} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>登录时间</th>
              <th>到期</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((s) => (
              <tr key={s.id}>
                <td>{date(s.createdAt)}</td>
                <td>{date(s.expiresAt)}</td>
                <td>{s.current ? "当前会话" : "其他会话"}</td>
                <td>
                  <Button
                    onClick={async () => {
                      try {
                        await api(`/auth/sessions/${s.id}`, {
                          method: "DELETE",
                        });
                        if (s.current) window.location.assign("/account");
                        else void reload();
                      } catch (e: any) {
                        toast(e.message, true);
                      }
                    }}
                  >
                    退出此会话
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
export function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get("reset") || "";
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  return (
    <div className="auth-screen">
      <section className="auth-card">
        <h1>恢复账号</h1>
        {done ? (
          <>
            <p>密码已更新，所有旧会话已退出。</p>
            <a className="button primary" href="/account">
              重新登录
            </a>
          </>
        ) : (
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post("/auth/reset-password", { token, password });
                setDone(true);
                window.history.replaceState({}, "", "/account");
              } catch (err: any) {
                setError(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>请输入至少 12 位的新密码。恢复链接使用后立即失效。</p>
            <label className="field">
              新密码
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={200}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <ErrorBox message={error} />}
            <Button variant="primary" type="submit" busy={busy}>
              保存新密码
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
export function ControlCenter() {
  const { data, error, reload } = useData<Doc>("/diagnostics", 30000),
    { data: auth } = useData<Doc>("/auth/status");
  const [page, setPage] = useState(1),
    [q, setQ] = useState("");
  const { data: audits, error: auditError } = useData<Doc>(
    `/audit?page=${page}&pageSize=30&q=${encodeURIComponent(q)}`,
  );
  return (
    <div className="page">
      <PageHead
        title="运行与审计"
        description="检查服务、配置与团队操作，定位需要处理的问题。"
      >
        <Button onClick={reload}>刷新检查</Button>
        <Link className="button" to="/settings">
          连接设置
        </Link>
      </PageHead>
      {error && <ErrorBox message={error} />}{" "}
      {data && (
        <>
          <section className="config-section">
            <h2>服务状态</h2>
            <dl className="health-list">
              <div>
                <dt>MySQL</dt>
                <dd>{data.database ? "可读写" : "不可用"}</dd>
              </div>
              <div>
                <dt>FFmpeg / FFprobe</dt>
                <dd>{data.mediaReady ? "可用" : "需安装或配置"}</dd>
              </div>
              <div>
                <dt>后台任务</dt>
                <dd>
                  {data.worker.healthy ? "运行中" : "心跳过期或未启动"} ·{" "}
                  {date(data.worker.lastHeartbeat)}
                </dd>
              </div>
              <div>
                <dt>素材存储</dt>
                <dd>
                  {data.storage.driver} ·{" "}
                  {(data.storage.usedBytes / 1048576).toFixed(1)} /{" "}
                  {(data.storage.limitBytes / 1048576).toFixed(0)} MB
                </dd>
              </div>
            </dl>
          </section>
          <section className="config-section">
            <h2>外部服务配置</h2>
            <p className="muted">
              这里检查凭据是否已配置，真实接口、费用和账户权限需要实际任务验证。
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>服务</th>
                    <th>配置</th>
                    <th>真实联调</th>
                  </tr>
                </thead>
                <tbody>
                  {data.connections.map((c: Doc) => (
                    <tr key={c.provider}>
                      <td>{c.provider}</td>
                      <td>{c.configured ? "已配置" : "未配置"}</td>
                      <td>通过任务结果核对</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {auth?.platformAdmin && <AccountRecovery />}
      <section className="config-section">
        <h2>工作空间操作审计</h2>
        <input
          aria-label="筛选审计日志"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="搜索操作类型或操作者"
        />
        {auditError && <ErrorBox message={auditError} />}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>操作者</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {audits?.items?.map((r: Doc) => (
                <tr key={r.id}>
                  <td>{date(r.created_at)}</td>
                  <td>{r.action}</td>
                  <td>{r.user_id}</td>
                  <td>
                    <details>
                      <summary>查看记录</summary>
                      <pre>{JSON.stringify(r.details, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {audits && (
          <PageNavigation
            page={page}
            total={audits.total}
            pageSize={30}
            onChange={setPage}
          />
        )}
      </section>
    </div>
  );
}
function AccountRecovery() {
  const { data, error } = useData<Doc[]>("/admin/users");
  const [target, setTarget] = useState(""),
    [link, setLink] = useState(""),
    [busy, setBusy] = useState(false);
  const { toast } = useApp();
  return (
    <section className="config-section">
      <h2>账号恢复</h2>
      <p className="muted">
        为成员生成一小时有效、只能使用一次的恢复链接。不会发送邮件。
      </p>
      {error && <ErrorBox message={error} />}
      <div className="inline-actions">
        <select
          aria-label="恢复账号"
          disabled={busy}
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setLink("");
          }}
        >
          <option value="">选择账号</option>
          {data
            ?.filter((u) => !u.disabled)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.email}
              </option>
            ))}
        </select>
        <Button
          busy={busy}
          disabled={!target}
          onClick={async () => {
            setBusy(true);
            setLink("");
            try {
              const r = await post(`/admin/users/${target}/recovery`);
              setLink(window.location.origin + r.path);
            } catch (e: any) {
              toast(e.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          生成恢复链接
        </Button>
      </div>
      {link && (
        <label className="field">
          恢复账号：{data?.find((u) => u.id === target)?.email}
          （请直接交给本人）
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
        </label>
      )}
    </section>
  );
}
