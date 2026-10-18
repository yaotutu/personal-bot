import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChatView } from "../chat/ChatView";
import { JobsView } from "../jobs/JobsView";
import { GoalsView } from "../goals/GoalsView";
import { SettingsView } from "../settings/SettingsView";
import {
  decideAction,
  listPendingActions,
  subscribeAuth,
  isLoggedIn,
  listThreads,
  login,
  type ActionDto,
} from "../lib/api";

/** 审批必须呈现真实负载；React 文本节点转义文件内容，绝不把不可信文本当 HTML 渲染。 */
const ActionApproval = ({ action, onDecided }: { action: ActionDto; onDecided: () => void }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => { requestRef.current?.abort(); }, []);

  const { threadId, runId, expiresAt } = action;
  const expired = expiresAt !== undefined && Date.parse(expiresAt) <= Date.now();
  const payload = Object.entries(action.payload);
  const labels: Record<string, string> = {
    path: "文件路径",
    content: "待写入内容",
    oldText: "替换前文本",
    newText: "替换后文本",
    originalContent: "编辑前完整内容",
    baseVersion: "文件基准版本",
  };
  // 缺少正文/替换任一侧时不提供批准；空字符串则是合法的清空/删除预览，不能按 truthy 判断。
  const hasPreview = Boolean(action.payload.path) && (action.kind === "file_write"
    ? typeof action.payload.content === "string"
    : typeof action.payload.oldText === "string" && typeof action.payload.newText === "string");

  const decide = async (decision: "approve" | "deny") => {
    if (requestRef.current || expired || (decision === "approve" && !hasPreview)) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError("");
    try {
      await decideAction(action.id, decision, controller.signal);
      if (!controller.signal.aborted) onDecided();
    } catch (e) {
      // 409/网络错误不能伪装为决定成功；保留卡片与错误，后续快照负责移除已取消/过期项。
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-medium text-amber-900">{action.title}</span>
        <span className="text-xs text-amber-700">{expired ? "已过期，等待同步" : "等待批准"}</span>
      </div>
      <div className="mt-1 space-y-0.5 break-all text-xs text-amber-800">
        <p>操作：{action.kind} · 审批 ID：{action.id}</p>
        {threadId && <p>会话：{threadId}</p>}
        {runId && <p>运行：{runId}</p>}
        {expiresAt && <p>过期时间：{expiresAt}</p>}
      </div>
      <div className="mt-2 space-y-2">
        {payload.map(([key, value]) => (
          <div key={key}>
            <h3 className="mb-1 break-all text-xs font-medium text-amber-900">{labels[key] ?? key}</h3>
            <pre tabIndex={0} aria-label={labels[key] ?? key} className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md border border-amber-200 bg-white p-2 text-xs text-stone-700">
              {value === "" ? "（空文本）" : value}
            </pre>
          </div>
        ))}
        {!hasPreview && <p className="text-xs text-red-600">操作负载不完整，不能批准。</p>}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => void decide("approve")}
          disabled={busy || expired || !hasPreview}
          className="rounded-md bg-amber-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-40"
        >
          批准
        </button>
        <button
          onClick={() => void decide("deny")}
          disabled={busy || expired}
          className="rounded-md border border-amber-300 px-2.5 py-1 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-40"
        >
          拒绝
        </button>
        {busy && <span className="text-xs text-amber-700">提交中…</span>}
      </div>
    </section>
  );
};

/**
 * 应用骨架：左侧会话列表（threads），右侧聊天区。
 * 新 thread 通过侧栏输入创建（合法 id：字母数字开头，可含 _ -）。
 */
export const App = () => {
  const authed = useSyncExternalStore(subscribeAuth, isLoggedIn);
  const [threads, setThreads] = useState<{ id: string; updatedAt: string }[]>([]);
  const [active, setActive] = useState("local-main");
  const [newThread, setNewThread] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  type View = "chat" | "jobs" | "goals" | "settings";
  const [view, setView] = useState<View>("chat");
  // 小屏（<768px）侧栏变为抽屉；默认开抽屉选会话，选完自动收起。
  const [drawer, setDrawer] = useState(false);
  const [pendingActions, setPendingActions] = useState<ActionDto[]>([]);
  const actionRevision = useRef(0);

  // 审批轮询只读取 pending 操作；切换认证状态时取消旧请求，避免返回迟到卡片。
  useEffect(() => {
    if (!authed) { setPendingActions([]); return; }
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const revision = actionRevision.current;
      try {
        const actions = await listPendingActions(controller.signal);
        // 决定之前发出的旧快照不得把已处理项重新显示；取消/过期等终态统一不再提供按钮。
        if (!controller.signal.aborted && revision === actionRevision.current) {
          setPendingActions(actions);
        }
      } catch {
        // 瞬时轮询失败保留当前卡片；审批请求自身仍展示错误，不能因此盲目移除。
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    void listThreads()
      .then((list) => {
        setThreads(list);
        if (list.length && !list.some((x) => x.id === active)) setActive(list[0]!.id);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  const signIn = async () => {
    try { setError(await login(accessKey) ? "" : "访问密钥不正确"); }
    catch (e) { setError(e instanceof Error ? e.message : "登录失败"); }
  };

  if (!authed) {
    return (
      <div className="flex h-screen items-center justify-center bg-stone-100">
        <div className="w-80 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-stone-800">pi-muse</h1>
          <p className="mt-1 text-sm text-stone-500">
            {error || "输入服务端访问密钥（未配置密钥时直接进入）"}
          </p>
          <input
            type="password"
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void signIn();
            }}
            placeholder="访问密钥"
            className="mt-4 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
          />
          <button
            onClick={() => void signIn()}
            className="mt-3 w-full rounded-xl bg-stone-800 py-2 text-sm font-medium text-white hover:bg-stone-700"
          >
            进入
          </button>
        </div>
      </div>
    );
  }

  const navItems: { key: View; label: string }[] = [
    { key: "chat", label: "聊天" },
    { key: "jobs", label: "任务" },
    { key: "goals", label: "目标" },
    { key: "settings", label: "设置" },
  ];

  return (
    <div className="flex h-screen bg-stone-100">
      {/* 小屏抽屉遮罩 */}
      {drawer && (
        <div
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside
        className={`flex w-56 shrink-0 flex-col border-r border-stone-200 bg-white max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:transition-transform ${
          drawer ? "max-md:translate-x-0" : "max-md:-translate-x-full"
        }`}
      >
        <div className="px-4 py-4 text-sm font-semibold tracking-wide text-stone-700">
          pi-muse
        </div>
        <div className="flex gap-1 px-2 pb-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => {
                setView(item.key);
                setDrawer(false);
              }}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium ${
                view === item.key
                  ? "bg-stone-800 text-white"
                  : "text-stone-500 hover:bg-stone-100"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className={`flex-1 space-y-0.5 overflow-y-auto px-2 ${view === "chat" ? "" : "hidden"}`}>
          {threads.map((thread) => (
            <button
              key={thread.id}
              onClick={() => {
                setActive(thread.id);
                setView("chat");
                setDrawer(false);
              }}
              className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm ${
                thread.id === active
                  ? "bg-stone-800 text-white"
                  : "text-stone-600 hover:bg-stone-100"
              }`}
            >
              {thread.id}
            </button>
          ))}
        </div>
        <div className={`border-t border-stone-200 p-2 ${view === "chat" ? "" : "hidden"}`}>
          <input
            value={newThread}
            onChange={(e) => setNewThread(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !newThread.trim()) return;
              const id = newThread.trim();
              if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
                setError("会话名：字母或数字开头，可含 _ -");
                return;
              }
              if (!threads.some((x) => x.id === id)) {
                setThreads([...threads, { id, updatedAt: new Date().toISOString() }]);
              }
              setActive(id);
              setNewThread("");
              setError("");
            }}
            placeholder="新会话名称…"
            className="w-full rounded-lg border border-stone-300 px-2.5 py-1.5 text-sm outline-none focus:border-stone-500"
          />
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {pendingActions.length > 0 && (
          <div className="flex max-h-[50vh] shrink-0 items-start gap-3 overflow-y-auto border-b border-amber-200 bg-amber-50 px-4 py-2">
            <span aria-hidden>🔔</span>
            <div className="min-w-0 flex-1 space-y-2">
              {pendingActions.map((action) => (
                <ActionApproval key={action.id} action={action} onDecided={() => {
                  actionRevision.current += 1;
                  setPendingActions((list) => list.filter((x) => x.id !== action.id));
                }} />
              ))}
            </div>
          </div>
        )}
        <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5 md:hidden">
          <button
            onClick={() => setDrawer(true)}
            aria-label="打开会话列表"
            className="rounded-lg border border-stone-300 px-2.5 py-1 text-sm text-stone-600"
          >
            ☰
          </button>
          <span className="text-sm font-semibold text-stone-700">pi-muse</span>
          <span className="ml-auto truncate text-xs text-stone-400">{active}</span>
        </header>
        <div className="min-h-0 flex-1">
        {view === "chat" && <ChatView key={active} threadId={active} />}
        {view === "jobs" && <JobsView />}
        {view === "goals" && <GoalsView />}
        {view === "settings" && <SettingsView />}
        </div>
      </main>
    </div>
  );
};
