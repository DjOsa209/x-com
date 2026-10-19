import { VideoControls, PlanPreview, PipelineProgress } from "../VideoPipeline";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Plus,
  Save,
  Send,
  Users,
  RefreshCw,
  Play,
  Trash2,
  Copy,
  Shield,
  LogOut,
  ArrowRight,
  Workflow,
  Code2,
} from "lucide-react";
import { api, post, newJob, date, number, type Doc } from "../api";
import {
  useData,
  useApp,
  Button,
  PageHead,
  Empty,
  ErrorBox,
  Modal,
  FilePicker,
  ResultView,
  JsonView,
  copyText,
  Tabs,
} from "../ui";
import { markets } from "../templates";

function AuthForm({ state }: { state: Doc }) {
  const invite =
    new URLSearchParams(window.location.search).get("invite") || "";
  const [register, setRegister] = useState(!!invite),
    [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [workspaceName, setWorkspaceName] = useState("我的工作空间"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const bootstrap = state.bootstrapNeeded;
  return (
    <div className="auth-card">
      <div className="auth-brand">X-Ecommerce</div>
      <h1>
        {bootstrap
          ? "初始化管理员"
          : register
            ? "接受邀请并注册"
            : "登录工作空间"}
      </h1>
      <p className="muted">
        {bootstrap
          ? "创建第一个账号，并接管现有本地工作空间。"
          : "使用自己的账号访问已加入的团队。"}
      </p>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await post(
              bootstrap
                ? "/auth/bootstrap"
                : register
                  ? "/auth/register"
                  : "/auth/login",
              { email, name, password, workspaceName, inviteToken: invite },
            );
            window.location.assign(
              invite && !register
                ? "/account?invite=" + encodeURIComponent(invite)
                : "/",
            );
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {(bootstrap || register) && (
          <label className="field">
            姓名
            <input
              required
              value={name}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        <label className="field">
          邮箱
          <input
            required
            type="email"
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          密码
          <input
            required
            minLength={bootstrap || register ? 12 : 1}
            type="password"
            value={password}
            autoComplete={
              bootstrap || register ? "new-password" : "current-password"
            }
            onChange={(e) => setPassword(e.target.value)}
          />
          {(bootstrap || register) && <small>至少 12 个字符。</small>}
        </label>
        {bootstrap && (
          <label className="field">
            工作空间名称
            <input
              required
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
            />
          </label>
        )}
        {error && <ErrorBox message={error} />}
        <Button variant="primary" busy={busy} type="submit">
          {bootstrap ? "创建管理员" : register ? "注册并加入团队" : "登录"}
          <ArrowRight size={15} />
        </Button>
      </form>
      {register && (
        <Button onClick={() => setRegister(false)}>已有账号，前往登录</Button>
      )}
    </div>
  );
}
export function AuthGate({ children }: { children: ReactNode }) {
  const { data, error, loading } = useData<Doc>("/auth/status");
  if (loading)
    return (
      <div className="auth-screen">
        <p>正在连接工作空间…</p>
      </div>
    );
  if (error)
    return (
      <div className="auth-screen">
        <ErrorBox message={error} retry={() => window.location.reload()} />
      </div>
    );
  if (data?.required && !data.user)
    return (
      <div className="auth-screen">
        <AuthForm state={data} />
      </div>
    );
  return children;
}
function AcceptInvite({ token }: { token: string }) {
  const { data, error } = useData<Doc>(
    "/auth/invite-preview?token=" + encodeURIComponent(token),
  );
  const { toast } = useApp();
  return (
    <section className="config-section">
      <h2>工作空间邀请</h2>
      {error && <ErrorBox message={error} />}{" "}
      {data && (
        <>
          <p>
            {data.workspaceName} 邀请 {data.email} 以 {data.role} 身份加入。
          </p>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const r = await post("/workspaces/invites/accept", { token });
                await post("/workspaces/select", {
                  workspaceId: r.workspaceId,
                });
                window.location.assign("/team");
              } catch (e: any) {
                toast(e.message, true);
              }
            }}
          >
            接受邀请并进入工作空间
          </Button>
        </>
      )}
    </section>
  );
}
export function Account() {
  const { data, reload } = useData<Doc>("/auth/status");
  const { toast } = useApp();
  const [oldPassword, setOld] = useState(""),
    [newPassword, setNew] = useState("");
  if (!data) return null;
  if (!data.user)
    return (
      <div className="page">
        <AuthForm state={data} />
      </div>
    );
  return (
    <div className="page">
      <PageHead
        title="我的账号"
        description={`${data.user.name} · ${data.user.email}`}
      >
        <Button
          onClick={async () => {
            await post("/auth/logout");
            window.location.assign("/account");
          }}
        >
          <LogOut size={15} />
          退出登录
        </Button>
      </PageHead>
      {new URLSearchParams(window.location.search).get("invite") && (
        <AcceptInvite
          token={new URLSearchParams(window.location.search).get("invite")!}
        />
      )}
      <section className="config-section">
        <h2>修改密码</h2>
        <form
          className="form-stack account-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post("/auth/password", { oldPassword, newPassword });
              setOld("");
              setNew("");
              toast("密码已更新，其他会话已退出");
              void reload();
            } catch (e: any) {
              toast(e.message, true);
            }
          }}
        >
          <label className="field">
            原密码
            <input
              type="password"
              autoComplete="current-password"
              required
              value={oldPassword}
              onChange={(e) => setOld(e.target.value)}
            />
          </label>
          <label className="field">
            新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
            />
          </label>
          <Button variant="primary" type="submit">
            更新密码
          </Button>
        </form>
      </section>
    </div>
  );
}
export function Team() {
  const { data: auth } = useData<Doc>("/auth/status");
  const { data: spaces, reload: reloadSpaces } = useData("/workspaces");
  const { data: members, reload } = useData("/workspaces/members");
  const { data: invites, reload: reloadInvites } = useData(
    "/workspaces/invites",
  );
  const { toast } = useApp();
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("operator"),
    [name, setName] = useState(""),
    [inviteLink, setInviteLink] = useState("");
  return (
    <div className="page">
      <PageHead
        title="工作空间与团队"
        description="切换团队、邀请成员，并在后端校验每一次操作的权限。"
      />
      {!auth?.user && (
        <ErrorBox message="当前为本地模式。请先在“我的账号”初始化管理员，才能创建团队和邀请成员。" />
      )}
      <section className="config-section">
        <h2>我的工作空间</h2>
        <div className="space-list">
          {spaces?.map((s) => (
            <Button
              key={s.id}
              disabled={s.id === auth?.workspace}
              onClick={async () => {
                try {
                  await post("/workspaces/select", { workspaceId: s.id });
                  window.location.reload();
                } catch (e: any) {
                  toast(e.message, true);
                }
              }}
            >
              {s.name} · {s.role}
              {s.id === auth?.workspace ? " · 当前" : ""}
            </Button>
          ))}
        </div>
        <div className="inline-actions">
          <input
            aria-label="新空间名称"
            placeholder="新空间名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            disabled={!name.trim()}
            onClick={async () => {
              try {
                await post("/workspaces", { name });
                setName("");
                void reloadSpaces();
                toast("已创建工作空间");
              } catch (e: any) {
                toast(e.message, true);
              }
            }}
          >
            <Plus size={15} />
            创建空间
          </Button>
        </div>
      </section>
      <section className="config-section">
        <h2>成员</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>成员</th>
                <th>邮箱</th>
                <th>角色</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {members?.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.email}</td>
                  <td>
                    <select
                      aria-label={`${m.name}的角色`}
                      value={m.role}
                      disabled={m.role === "owner"}
                      onChange={async (e) => {
                        try {
                          await api("/workspaces/members/" + m.id, {
                            method: "PATCH",
                            body: JSON.stringify({ role: e.target.value }),
                          });
                          void reload();
                        } catch (e: any) {
                          toast(e.message, true);
                        }
                      }}
                    >
                      {m.role === "owner" && (
                        <option value="owner">所有者</option>
                      )}
                      <option value="admin">管理员</option>
                      <option value="operator">运营</option>
                      <option value="viewer">只读</option>
                    </select>
                  </td>
                  <td>
                    <Button
                      disabled={m.role === "owner"}
                      onClick={async () => {
                        try {
                          await api("/workspaces/members/" + m.id, {
                            method: "DELETE",
                          });
                          void reload();
                        } catch (e: any) {
                          toast(e.message, true);
                        }
                      }}
                    >
                      移除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="config-section">
        <h2>邀请成员</h2>
        <div className="inline-actions">
          <input
            aria-label="邀请邮箱"
            type="email"
            placeholder="成员邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            aria-label="邀请角色"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="operator">运营</option>
            <option value="admin">管理员</option>
            <option value="viewer">只读</option>
          </select>
          <Button
            onClick={async () => {
              try {
                const r = await post("/workspaces/invites", { email, role });
                setInviteLink(
                  window.location.origin + "/account?invite=" + r.token,
                );
                void reloadInvites();
              } catch (e: any) {
                toast(e.message, true);
              }
            }}
          >
            <Send size={15} />
            生成邀请链接
          </Button>
        </div>
        {inviteLink && (
          <div className="connection-note">
            <span>邀请已创建，7 天有效；请自行分享给对应邮箱的成员。</span>
            <Button onClick={() => copyText(inviteLink, toast)}>
              <Copy size={14} />
              复制链接
            </Button>
          </div>
        )}
        {invites?.map((i) => (
          <div className="favorite-row" key={i.id}>
            <span>
              {i.email} · {i.role} ·{" "}
              {i.accepted_at ? "已接受" : date(i.expires_at) + " 到期"}
            </span>
            <Button
              onClick={async () => {
                try {
                  await api("/workspaces/invites/" + i.id, {
                    method: "DELETE",
                  });
                  void reloadInvites();
                } catch (e: any) {
                  toast(e.message, true);
                }
              }}
            >
              撤销
            </Button>
          </div>
        ))}
      </section>
    </div>
  );
}

const projectState: Doc = {
  draft: "草稿",
  processing: "处理中",
  waiting_confirmation: "等待分镜确认",
  completed: "已完成",
  failed: "失败",
  review: "待核对",
  cancelled: "已取消",
};
export function Projects() {
  const { data, reload, error } = useData("/projects", 6000);
  const { toast } = useApp();
  const [videoOptions, setVideoOptions] = useState<Doc>({ duration: 10 }),
    [plan, setPlan] = useState<Doc | null>(null);
  const [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [prompt, setPrompt] = useState(""),
    [asset, setAsset] = useState<Doc | null>(null),
    [selected, setSelected] = useState<Doc | null>(null),
    [modified, setModified] = useState<Doc>({}),
    [count, setCount] = useState("1"),
    [busy, setBusy] = useState(false);
  async function open(id: string) {
    try {
      const p = await api("/projects/" + id);
      setSelected(p);
      setModified(p.script || {});
    } catch (e: any) {
      toast(e.message, true);
    }
  }
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) void open(id);
  }, []);
  useEffect(() => {
    if (!selected || !["processing", "review"].includes(selected.status))
      return;
    let active = true;
    const id = selected.id;
    const timer = setInterval(() => {
      api("/projects/" + id)
        .then((p) => {
          if (active) {
            setSelected(p);
            if (p.status === "waiting_confirmation")
              setModified(p.script || {});
          }
        })
        .catch(() => {});
    }, 6000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected?.id, selected?.status]);
  async function action(endpoint: string, body: Doc = {}) {
    if (!selected) return;
    setBusy(true);
    try {
      await post("/projects/" + selected.id + "/" + endpoint, body);
      await open(selected.id);
      void reload();
      toast("项目已更新");
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <PageHead
        title="项目与分镜确认"
        description="先审阅脚本，再确认生成；每次确认都会保存不可替换的版本快照。"
      >
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus size={15} />
          创建项目
        </Button>
        <Button onClick={() => reload()}>
          <RefreshCw size={15} />
          刷新
        </Button>
      </PageHead>
      {error && <ErrorBox message={error} />}
      {data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>项目</th>
                <th>状态</th>
                <th>版本</th>
                <th>更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{projectState[p.status] || p.status}</td>
                  <td>v{p.version}</td>
                  <td>{date(p.updated_at)}</td>
                  <td>
                    <Button onClick={() => open(p.id)}>打开</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="先确认创意，再开始生成"
          description="创建项目后生成脚本，编辑分镜，再确认一个或多个视频版本。"
          icon={Workflow}
        />
      )}
      {adding && (
        <Modal title="创建项目" onClose={() => setAdding(false)}>
          <div className="form-stack">
            <label className="field">
              项目名称
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              产品与创作要求
              <textarea
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            <FilePicker onPick={setAsset} />
            {asset && <p>{asset.name}</p>}
            <VideoControls
              value={videoOptions}
              onChange={setVideoOptions}
              duration
            />
            <Button
              variant="primary"
              disabled={!name || !prompt || !asset}
              onClick={async () => {
                try {
                  const p = await post("/projects", {
                    name,
                    input: {
                      prompt,
                      assetIds: [asset!.id],
                      aspect: "9:16",
                      duration: 10,
                      language: "English",
                      style: "UGC",
                      ...videoOptions,
                    },
                  });
                  setAdding(false);
                  void reload();
                  await open(p.id);
                } catch (e: any) {
                  toast(e.message, true);
                }
              }}
            >
              保存项目草稿
            </Button>
          </div>
        </Modal>
      )}
      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(null)} wide>
          <div className="section-heading">
            <span>
              {projectState[selected.status]} · v{selected.version}
            </span>
            <div className="inline-actions">
              <Button
                busy={busy}
                disabled={
                  !["draft", "failed", "waiting_confirmation"].includes(
                    selected.status,
                  )
                }
                onClick={() => action("prepare")}
              >
                生成分镜
              </Button>
              <Button busy={busy} onClick={() => action("cancel")}>
                取消项目
              </Button>
              {["failed", "cancelled"].includes(selected.status) && (
                <Button onClick={() => action("retry")}>新建重试版本</Button>
              )}
              <Button onClick={() => open(selected.id)}>刷新</Button>
            </div>
          </div>
          {selected.script && selected.status !== "waiting_confirmation" && (
            <ResultView result={selected.script} />
          )}
          {selected.status === "waiting_confirmation" && (
            <div className="form-stack">
              <VideoControls
                value={selected.input}
                onChange={(input) => setSelected({ ...selected, input })}
                duration
              />
              <label className="field">
                编辑最终销售提示词
                <textarea
                  rows={6}
                  value={modified.shootingPrompt || ""}
                  onChange={(e) =>
                    setModified({ ...modified, shootingPrompt: e.target.value })
                  }
                />
              </label>
              <details>
                <summary>编辑每个镜头的时间、画面和口播</summary>
                {Array.isArray(modified.scenes) &&
                  modified.scenes.map((s: Doc, i: number) => (
                    <div key={i} className="scene">
                      <label className="field">
                        镜头 {i + 1} 时间（秒，例如 0-3s）
                        <input
                          value={
                            s.time ||
                            s.timestamp ||
                            (s.start !== undefined
                              ? `${s.start}-${s.end}s`
                              : "")
                          }
                          onChange={(e) =>
                            setModified({
                              ...modified,
                              scenes: modified.scenes.map(
                                (v: Doc, n: number) =>
                                  n === i
                                    ? {
                                        ...v,
                                        time: e.target.value,
                                        timestamp: undefined,
                                        start: undefined,
                                        end: undefined,
                                      }
                                    : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        画面
                        <textarea
                          value={s.visual || ""}
                          onChange={(e) =>
                            setModified({
                              ...modified,
                              scenes: modified.scenes.map(
                                (v: Doc, n: number) =>
                                  n === i
                                    ? { ...v, visual: e.target.value }
                                    : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        口播
                        <textarea
                          value={s.voiceover || ""}
                          onChange={(e) =>
                            setModified({
                              ...modified,
                              scenes: modified.scenes.map(
                                (v: Doc, n: number) =>
                                  n === i
                                    ? { ...v, voiceover: e.target.value }
                                    : v,
                              ),
                            })
                          }
                        />
                      </label>
                    </div>
                  ))}
              </details>
              <PlanPreview
                input={{
                  ...selected.input,
                  prompt: modified.shootingPrompt || modified.script,
                }}
                storyboard={modified}
                onReady={setPlan}
              />
              <label className="field">
                生成视频数量
                <select
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option value={n} key={n}>
                      {n} 条
                    </option>
                  ))}
                </select>
              </label>
              <div className="inline-actions">
                <Button
                  onClick={async () => {
                    try {
                      const p = await api("/projects/" + selected.id, {
                        method: "PATCH",
                        body: JSON.stringify({
                          version: selected.version,
                          modifiedData: modified,
                          input: selected.input,
                        }),
                      });
                      setSelected(p);
                      toast("分镜已保存为新版本");
                    } catch (e: any) {
                      toast(e.message, true);
                    }
                  }}
                >
                  保存分镜版本
                </Button>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={!plan}
                  onClick={() =>
                    action("confirm", {
                      version: selected.version,
                      modifiedData: modified,
                      videoGenerationCount: Number(count),
                      renderOptions: Object.fromEntries(
                        Object.entries(selected.input).filter(([k]) =>
                          [
                            "videoModelId",
                            "segmentStrategy",
                            "segmentSeconds",
                            "duration",
                            "aspect",
                            "resolution",
                            "generateAudio",
                          ].includes(k),
                        ),
                      ),
                      planFingerprint: plan?.fingerprint,
                    })
                  }
                >
                  确认并生成 {count} 条视频
                </Button>
              </div>
            </div>
          )}
          {selected.tasks
            ?.filter(
              (t: Doc) =>
                !["script", "analysis"].includes(t.kind) || !selected.script,
            )
            .map((t: Doc) => (
              <section className="config-section" key={t.id}>
                <h3>子任务 · {t.status}</h3>
                {t.error && <ErrorBox message={t.error} />}
                <PipelineProgress pipeline={t.pipeline} />
                {t.result?.asset && <ResultView result={t.result} />}
              </section>
            ))}
        </Modal>
      )}
    </div>
  );
}

export function Automations() {
  const { data, reload, error } = useData("/automations", 10000);
  const { data: observations } = useData("/records/observation");
  const { data: opportunities } = useData("/records/opportunity");
  const { toast } = useApp();
  const [tab, setTab] = useState("automations"),
    [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [kind, setKind] = useState("collect"),
    [region, setRegion] = useState("US"),
    [interval, setInterval] = useState("1440"),
    [extract, setExtract] = useState(false),
    [selected, setSelected] = useState<Doc | null>(null);
  return (
    <div className="page">
      <PageHead
        title="自动采集与机会发现"
        description="持续采集真实榜单与评论，让机会发现成为可追踪的后台任务。"
      >
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus size={15} />
          创建自动化
        </Button>
      </PageHead>
      <Tabs
        items={[
          { id: "automations", label: "自动化" },
          { id: "observations", label: "采集记录" },
          { id: "opportunities", label: "机会库" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {error && <ErrorBox message={error} />}
      {tab === "automations" ? (
        data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>频率</th>
                  <th>下次执行</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.name}
                      <small>{a.last_error}</small>
                    </td>
                    <td>{a.interval_minutes} 分钟</td>
                    <td>{date(a.next_run_at)}</td>
                    <td>{a.enabled ? "启用" : "暂停"}</td>
                    <td>
                      <div className="inline-actions">
                        <Button
                          onClick={async () => {
                            try {
                              await post("/automations/" + a.id + "/run");
                              toast("已创建采集任务");
                            } catch (e: any) {
                              toast(e.message, true);
                            }
                          }}
                        >
                          <Play size={13} />
                          执行一次
                        </Button>
                        <Button
                          onClick={async () => {
                            await api("/automations/" + a.id, {
                              method: "PATCH",
                              body: JSON.stringify({ enabled: !a.enabled }),
                            });
                            void reload();
                          }}
                        >
                          {a.enabled ? "暂停" : "启用"}
                        </Button>
                        <Button
                          onClick={async () => {
                            await api("/automations/" + a.id, {
                              method: "DELETE",
                            });
                            void reload();
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="建立你的第一个市场观察任务"
            description="选择市场和频率，持续收集 AI 带货视频，或扫描商品与评论机会。"
            icon={Workflow}
          />
        )
      ) : (
        <div className="recent-list">
          {(tab === "observations" ? observations : opportunities)?.map((r) => (
            <button key={r.id} onClick={() => setSelected(r)}>
              <span>{r.name || r.title || "采集结果"}</span>
              <span>{date(r.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
      {adding && (
        <Modal title="创建自动化" onClose={() => setAdding(false)}>
          <div className="form-stack">
            <label className="field">
              名称
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              流程
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="collect">采集 AI 带货视频榜单</option>
                <option value="opportunity_scan">
                  商品榜单 → 详情与评论 → 机会分析
                </option>
              </select>
            </label>
            <label className="field">
              市场
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                {markets.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              执行间隔（分钟）
              <input
                type="number"
                min="15"
                max="43200"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              />
            </label>
            {kind === "collect" && (
              <label className="consent">
                <input
                  type="checkbox"
                  checked={extract}
                  onChange={(e) => setExtract(e.target.checked)}
                />
                同时分析前 2 条视频并入提示词库，会调用 Gemini；每轮也会消费
                EchoTik 额度。
              </label>
            )}
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={async () => {
                try {
                  await post("/automations", {
                    name,
                    kind,
                    input: {
                      region,
                      maxPages: 1,
                      maxProducts: 3,
                      maxVideos: 2,
                      extractPrompts: extract,
                    },
                    intervalMinutes: Number(interval),
                    enabled: true,
                  });
                  setAdding(false);
                  void reload();
                } catch (e: any) {
                  toast(e.message, true);
                }
              }}
            >
              启用自动化
            </Button>
          </div>
        </Modal>
      )}
      {selected && (
        <Modal
          title={selected.title || selected.name || "采集结果"}
          wide
          onClose={() => setSelected(null)}
        >
          <ResultView result={selected} />
        </Modal>
      )}
    </div>
  );
}

export function Billing() {
  const { data, reload, error } = useData<Doc>("/billing");
  const { data: orders } = useData("/billing/orders");
  const { data: storage } = useData<Doc>("/storage");
  const { data: settings } = useData<Doc>("/settings");
  const [costs, setCosts] = useState(""),
    [storageLimit, setStorageLimit] = useState("");
  useEffect(() => {
    if (settings) {
      setCosts(settings.values.CREDIT_COSTS_JSON);
      setStorageLimit(settings.values.STORAGE_LIMIT_MB);
    }
  }, [settings]);
  const { data: auth } = useData<Doc>("/auth/status");
  const { toast } = useApp();
  const [units, setUnits] = useState("100"),
    [busy, setBusy] = useState(false);
  return (
    <div className="page">
      <PageHead
        title="额度与订单"
        description="额度是平台内部任务单位，供应商费用仍以各自账单为准。"
      />
      {error && <ErrorBox message={error} />}
      <div className="analytics-summary">
        <div>
          <span>可用额度</span>
          <strong>
            {data?.wallet.enabled
              ? number(data.wallet.remainingCredits)
              : "未启用计量"}
          </strong>
        </div>
        <div>
          <span>冻结额度</span>
          <strong>{number(data?.wallet.frozenCredits ?? 0)}</strong>
        </div>
        <div>
          <span>账户余额</span>
          <strong>{number(data?.wallet.balance ?? 0)}</strong>
        </div>
      </div>
      {auth?.platformAdmin && (
        <section className="config-section">
          <h2>平台额度管理</h2>
          <details>
            <summary>任务单价与存储额度</summary>
            <div className="form-stack">
              <label className="field">
                存储上限（MB）
                <input
                  type="number"
                  min="1"
                  value={storageLimit}
                  onChange={(e) => setStorageLimit(e.target.value)}
                />
              </label>
              <label className="field">
                任务额度 JSON
                <textarea
                  rows={5}
                  value={costs}
                  onChange={(e) => setCosts(e.target.value)}
                />
              </label>
              <Button
                onClick={async () => {
                  try {
                    await api("/settings", {
                      method: "PUT",
                      body: JSON.stringify({
                        CREDIT_COSTS_JSON: costs,
                        STORAGE_LIMIT_MB: storageLimit,
                      }),
                    });
                    toast("计量规则已保存");
                  } catch (e: any) {
                    toast(e.message, true);
                  }
                }}
              >
                保存计量规则
              </Button>
            </div>
          </details>

          <div className="inline-actions">
            <Button
              onClick={async () => {
                try {
                  await api("/billing/metering", {
                    method: "PUT",
                    body: JSON.stringify({ enabled: !data?.wallet.enabled }),
                  });
                  void reload();
                } catch (e: any) {
                  toast(e.message, true);
                }
              }}
            >
              {data?.wallet.enabled ? "停用任务计量" : "启用任务计量"}
            </Button>
            <input
              aria-label="发放额度"
              type="number"
              min="1"
              value={units}
              onChange={(e) => setUnits(e.target.value)}
            />
            <Button
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await post("/billing/grant", {
                    units: Number(units),
                    reference: crypto.randomUUID(),
                    note: "平台管理员手动发放",
                  });
                  void reload();
                } catch (e: any) {
                  toast(e.message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              发放额度
            </Button>
          </div>
        </section>
      )}
      <section className="config-section">
        <h2>购买额度 / 订阅</h2>
        {data?.packs.length ? (
          <div className="inline-actions">
            {data.packs.map((p: Doc) => (
              <Button
                key={p.id}
                disabled={!data.checkoutAvailable}
                onClick={async () => {
                  try {
                    const r = await post("/billing/checkout", {
                      packId: p.id,
                      requestId: crypto.randomUUID(),
                    });
                    window.location.assign(r.url);
                  } catch (e: any) {
                    toast(e.message, true);
                  }
                }}
              >
                {p.name} · {p.credits} 额度 ·{" "}
                {p.mode === "subscription" ? "订阅" : "单次购买"}
              </Button>
            ))}
          </div>
        ) : (
          <p className="muted">
            尚未配置真实 Stripe 套餐。设置 Price ID 和 webhook
            后才会启用购买；不会创建虚假支付成功记录。
          </p>
        )}
      </section>
      <section className="config-section">
        <h2>素材存储</h2>
        <p className="muted">
          {storage?.driver === "s3" ? "S3 对象存储" : "本地文件"} · 已用{" "}
          {number(storage?.usedBytes)} 字节 / {number(storage?.limitBytes)}{" "}
          字节，上传中预留 {number(storage?.reservedBytes)} 字节
        </p>
      </section>
      <section className="config-section">
        <h2>订单记录</h2>
        {orders?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>订单</th>
                  <th>额度</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.id}</td>
                    <td>{o.units}</td>
                    <td>{o.status}</td>
                    <td>{date(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            暂无订单。购买完成后由经过验签的支付回调确认到账。
          </p>
        )}
      </section>
      <section className="config-section">
        <h2>额度流水</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>额度</th>
                <th>余额</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {data?.ledger.map((l: Doc) => (
                <tr key={l.id}>
                  <td>{date(l.created_at)}</td>
                  <td>{l.kind}</td>
                  <td>{l.units}</td>
                  <td>{l.balance_after}</td>
                  <td>{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
export function Admin() {
  const { data: users, reload, error } = useData("/admin/users");
  const { data: audits } = useData("/admin/audit");
  const { toast } = useApp();
  return (
    <div className="page">
      <PageHead
        title="后台管理"
        description="管理账号状态，查看工作空间审计记录。"
      />
      {error && <ErrorBox message={error} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>邮箱</th>
              <th>平台角色</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{u.global_role}</td>
                <td>{u.disabled ? "已停用" : "正常"}</td>
                <td>
                  <Button
                    onClick={async () => {
                      try {
                        await api("/admin/users/" + u.id, {
                          method: "PATCH",
                          body: JSON.stringify({ disabled: !u.disabled }),
                        });
                        void reload();
                      } catch (e: any) {
                        toast(e.message, true);
                      }
                    }}
                  >
                    {u.disabled ? "启用" : "停用"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="config-section">
        <h2>操作审计</h2>
        <JsonView value={audits || []} />
      </section>
    </div>
  );
}
export function Models() {
  const { data } = useData("/models");
  const { toast } = useApp();
  const [model, setModel] = useState(""),
    [payload, setPayload] = useState(
      '{\n  "prompt": "a natural ecommerce product photo"\n}',
    );
  return (
    <div className="page">
      <PageHead
        title="模型与高级生成"
        description="常规工作流使用已适配的模型；高级模式按供应商 schema 提交原始输入。"
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>模型</th>
              <th>用途</th>
              <th>适配器</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td>
                <td>{m.type}</td>
                <td>{m.adapter}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="config-section form-stack">
        <h2>原始模型输入</h2>
        <label className="field">
          模型
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">请选择</option>
            {data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          输入 JSON
          <textarea
            rows={10}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </label>
        <Button
          disabled={!model}
          onClick={async () => {
            try {
              await newJob("raw", {
                modelId: model,
                payload: JSON.parse(payload),
              });
              toast("已提交到任务管理");
            } catch (e: any) {
              toast(e.message, true);
            }
          }}
        >
          提交高级生成任务
        </Button>
      </section>
    </div>
  );
}
