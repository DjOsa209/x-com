import { useState, useEffect, useCallback } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Link,
  useLocation,
} from "react-router-dom";
import {
  LayoutDashboard,
  Compass,
  Clapperboard,
  ScanLine,
  FolderOpen,
  Users,
  ClipboardList,
  Send,
  ChartNoAxesCombined,
  Settings2,
  BookOpen,
  ChevronsLeft,
  ChevronRight,
  Menu,
  X,
  ArrowUpRight,
  Command,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Plug,
  Code2,
} from "lucide-react";
import { api, type Doc } from "./api";
import { AppContext, useData } from "./ui";
import { Workspace } from "./pages/Workspace";
import {
  Inspiration,
  Explorer,
  PromptLibrary,
  Competitors,
} from "./pages/Research";
import {
  Assets,
  Characters,
  Tasks,
  Tool,
  Analytics,
  Settings,
  Publish,
  Help,
  Downloads,
} from "./pages/Manage";
const navigation = [
  {
    group: "创作",
    items: [
      ["/", "创作工作台", LayoutDashboard],
      ["/inspiration", "灵感与选品", Compass],
      ["/prompts", "爆款提示词库", Sparkles],
      ["/analysis", "视频分析", ScanLine],
      ["/enhance", "视频超分", Clapperboard],
      ["/download", "视频下载", Clapperboard],
    ],
  },
  {
    group: "管理",
    items: [
      ["/publish", "视频发布", Send],
      ["/analytics", "数据分析", ChartNoAxesCombined],
      ["/assets", "素材库", FolderOpen],
      ["/characters", "我的角色", Users],
      ["/tasks", "任务管理", ClipboardList],
    ],
  },
  {
    group: "连接",
    items: [
      ["/explorer", "EchoTik 数据接口", Code2],
      ["/competitors", "竞品跟踪", Compass],
      ["/settings", "连接与设置", Settings2],
    ],
  },
];
function Shell() {
  const location = useLocation();
  const [status, setStatus] = useState<Doc | null>(null),
    [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
      null,
    ),
    [open, setOpen] = useState(false),
    [collapsed, setCollapsed] = useState(false);
  const { data: jobs } = useData<Doc[]>("/jobs", 10000);
  const refresh = useCallback(() => {
    void api("/status")
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(id);
    }
  }, [toast]);
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const page =
    navigation
      .flatMap((n) => n.items)
      .find((n) => n[0] === location.pathname)?.[1] || "使用指南";
  return (
    <AppContext.Provider value={{ status, refresh, toast: notify }}>
      <div className={`app-shell ${collapsed ? "collapsed" : ""}`}>
        {open && (
          <button
            className="nav-scrim"
            aria-label="关闭导航"
            onClick={() => setOpen(false)}
          />
        )}
        <aside className={`sidebar ${open ? "open" : ""}`}>
          <Link className="brand" to="/" aria-label="X-Ecommerce 工作台">
            <span className="brand-mark">
              <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <path
                  d="m9 8 14 16M23 8 9 24"
                  stroke="currentColor"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                />
                <path
                  d="m21 7 4 4M7 21l4 4"
                  stroke="#69d6ed"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span>
              X-Ecommerce
              <span className="brand-sub">CREATE. CONNECT. GROW.</span>
            </span>
          </Link>
          <nav aria-label="主导航">
            {navigation.map((group) => (
              <div className="nav-group" key={group.group}>
                <p>{group.group}</p>
                {group.items.map(([href, label, Icon]: any) => (
                  <NavLink
                    title={label}
                    end={href === "/"}
                    key={href}
                    to={href}
                    className={({ isActive }) =>
                      isActive ? "nav-link active" : "nav-link"
                    }
                  >
                    <Icon size={18} strokeWidth={1.7} />
                    <span>{label}</span>
                    {href === "/inspiration" && (
                      <span className="new-badge">NEW</span>
                    )}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          {!collapsed && (
            <div className="sidebar-bottom">
              <div className="workspace-label">
                <span className="workspace-avatar">X</span>
                <div>
                  <strong>我的工作空间</strong>
                  <small>本地 · MySQL</small>
                </div>
              </div>
              <button
                onClick={() => setCollapsed(true)}
                className="collapse-button"
              >
                <ChevronsLeft size={15} />
                收起侧栏
              </button>
            </div>
          )}
          {collapsed && (
            <button
              className="expand-sidebar"
              aria-label="展开导航"
              onClick={() => setCollapsed(false)}
            >
              <ChevronRight size={18} />
            </button>
          )}
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label="打开导航"
                onClick={() => setOpen(true)}
              >
                <Menu size={20} />
              </button>
              <span className="muted">工作空间</span>
              <ChevronRight size={13} />
              <span>{page as string}</span>
            </div>
            <div className="topbar-actions">
              <Link to="/help" className="docs-link">
                <BookOpen size={15} />
                使用指南
                <ArrowUpRight size={12} />
              </Link>
              <Link className="connection-status" to="/settings">
                <span
                  className={`status-dot ${status?.connections?.echotik ? "green" : ""}`}
                />
                <span>
                  {status?.connections?.echotik
                    ? "EchoTik 已配置"
                    : "连接 EchoTik"}
                </span>
                <Plug size={13} />
              </Link>
              <Link to="/settings" className="avatar" aria-label="工作空间设置">
                X
              </Link>
            </div>
          </header>
          <main id="main-content">
            <Routes>
              <Route path="/" element={<Workspace />} />
              <Route path="/inspiration" element={<Inspiration />} />
              <Route path="/explorer" element={<Explorer />} />
              <Route path="/prompts" element={<PromptLibrary />} />
              <Route path="/competitors" element={<Competitors />} />
              <Route path="/assets" element={<Assets />} />
              <Route path="/characters" element={<Characters />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/analysis" element={<Tool kind="analysis" />} />
              <Route path="/enhance" element={<Tool kind="enhance" />} />
              <Route path="/download" element={<Downloads />} />
              <Route path="/publish" element={<Publish />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/help" element={<Help />} />
              <Route
                path="*"
                element={
                  <div className="empty">
                    <h1>页面不存在</h1>
                    <Link to="/">回到工作台</Link>
                  </div>
                }
              />
            </Routes>
          </main>
          <footer className="app-footer">
            <span>X-Ecommerce</span>
            <span>从数据发现机会，用创意连接生意。</span>
            <Link to="/settings">
              连接管理 <ArrowUpRight size={12} />
            </Link>
          </footer>
        </div>
        {toast && (
          <div className={`toast ${toast.error ? "error" : ""}`} role="status">
            {toast.error ? (
              <AlertCircle size={18} />
            ) : (
              <CheckCircle2 size={18} />
            )}
            <span>{toast.text}</span>
            <button aria-label="关闭提示" onClick={() => setToast(null)}>
              <X size={15} />
            </button>
          </div>
        )}
      </div>
    </AppContext.Provider>
  );
}
export default function App() {
  return (
    <BrowserRouter>
      <a className="skip-link" href="#main-content">
        跳转到主要内容
      </a>
      <Shell />
    </BrowserRouter>
  );
}
