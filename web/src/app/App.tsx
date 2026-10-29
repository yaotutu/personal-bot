import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { ChatView } from "../chat/ChatView";
import { JobsView } from "../jobs/JobsView";
import { GoalsView } from "../goals/GoalsView";
import { SettingsView } from "../settings/SettingsView";
import {
  ApiError,
  decideApproval,
  subscribeAuth,
  isLoggedIn,
  listSpaces,
  login,
  subscribeWorkspaceEvents,
  type ActivityUpdatedEventDto,
  type AgentStatusDto,
  type ApprovalViewDto,
  type SpaceDto,
  type WorkspaceEvent,
} from "../lib/api";

/**
 * 审批卡片只展示服务端登记时固定的完整预览。
 * before/after 是不可信文件文本：使用 React 文本节点渲染（自动转义），绝不拼 HTML。
 */
const ActionApproval = ({
  action,
  onDecided,
}: {
  action: ApprovalViewDto;
  onDecided: (resolved: ApprovalViewDto) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => { requestRef.current?.abort(); }, []);

  const { preview } = action;
  const expired = Date.parse(action.expiresAt) <= Date.now();
  // 技能库是实例共享内容；发起空间不是文件归属，未知作用域不能显示成技能库。
  const scopeText = preview.scope === "skill"
    ? "技能库"
    : preview.scope === "shared"
      ? "共享区 shared/..."
      : `空间私有工作区 · 归属空间 ${preview.ownerSpaceId ?? "未知"}`;
  const beforeLabel = action.kind === "file_edit"
    ? "替换前内容"
    : preview.beforeExists ? "写入前内容" : "写入前内容（文件不存在）";
  const afterLabel = action.kind === "file_write" ? "写入后内容" : "替换后内容";

  const decide = async (decision: "approve" | "deny") => {
    if (requestRef.current || expired) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError("");
    try {
      // 只有服务端确认（2xx 返回权威审批视图）才触发本地移除；409/网络错误保留卡片等待 SSE 校正。
      const resolved = await decideApproval(action.id, decision, controller.signal);
      if (!controller.signal.aborted) onDecided(resolved);
    } catch (e) {
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
        <p>操作：{action.kind === "file_write" ? "写入文件" : "编辑文件"} · 审批 ID：{action.id} · 版本：r{action.revision}</p>
        <p>作用域：{scopeText}</p>
        {action.spaceId && <p>发起空间：{action.spaceId}</p>}
        {action.runId && <p>运行：{action.runId}</p>}
        <p>过期时间：{action.expiresAt}</p>
      </div>
      <div className="mt-2 space-y-2">
        <div>
          <h3 className="mb-1 break-all text-xs font-medium text-amber-900">文件路径</h3>
          <pre tabIndex={0} aria-label="文件路径" className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md border border-amber-200 bg-white p-2 text-xs text-stone-700">
            {preview.path}
          </pre>
        </div>
        <div>
          <h3 className="mb-1 break-all text-xs font-medium text-amber-900">{beforeLabel}</h3>
          <pre tabIndex={0} aria-label={beforeLabel} className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md border border-amber-200 bg-white p-2 text-xs text-stone-700">
            {preview.before === "" ? "（空文本）" : preview.before}
          </pre>
        </div>
        <div>
          <h3 className="mb-1 break-all text-xs font-medium text-amber-900">{afterLabel}</h3>
          <pre tabIndex={0} aria-label={afterLabel} className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md border border-amber-200 bg-white p-2 text-xs text-stone-700">
            {preview.after === "" ? "（空文本）" : preview.after}
          </pre>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => void decide("approve")}
          disabled={busy || expired}
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
 * 工作区实时状态：只保留服务端推送的当前集合，不另建活动/审批历史。
 *
 * 版本规则（与服务端契约一致）：
 * - 运行以 (spaceId, runId) 为身份，只应用更高 revision；终态帧移除并留下版本墓碑，
 *   迟到的旧 running 帧不能复活。instanceId 变化时清空运行与运行版本缓存。
 * - 审批以 id 为身份；revision 跨进程持久，ready 重建 pending 集合时不能让版本倒退，
 *   终态移除后保留 tombstone，迟到的 approval_pending 不能重新显示已处理审批。
 */
type WorkspaceState = {
  instanceId: string | null;
  approvals: ApprovalViewDto[];
  approvalRevisions: Record<string, number>;
  approvalTombstones: Record<string, number>;
  statuses: AgentStatusDto[];
  statusRevisions: Record<string, number>;
  // 进行中的活动概览（含 waiting_* / awaiting_continuation）；终态活动进入 notices 供通知展示。
  activities: ActivityUpdatedEventDto[];
  notices: ActivityUpdatedEventDto[];
};

type WorkspaceAction =
  | WorkspaceEvent
  | { type: "decided"; data: ApprovalViewDto }
  | { type: "dismiss_notice"; id: string }
  | { type: "reset" };

const initialWorkspaceState: WorkspaceState = {
  instanceId: null,
  approvals: [],
  approvalRevisions: {},
  approvalTombstones: {},
  statuses: [],
  statusRevisions: {},
  activities: [],
  notices: [],
};

const runKey = (spaceId: string, runId: string) => JSON.stringify([spaceId, runId]);

const workspaceReducer = (state: WorkspaceState, action: WorkspaceAction): WorkspaceState => {
  switch (action.type) {
    case "reset":
      return initialWorkspaceState;
    case "ready": {
      const { instanceId, agentStatuses, pendingApprovals, activities } = action.data;
      // ready 是进行中集合的完整替换值：运行版本缓存也随之重建，不保留已结束运行的旧版本。
      // 运行 revision 只在同一实例内有效；新实例本来就必须清空缓存。
      const statusRevisions: Record<string, number> = {};
      const statuses: AgentStatusDto[] = [];
      for (const status of agentStatuses) {
        const key = runKey(status.spaceId, status.runId);
        const known = statusRevisions[key] ?? 0;
        if (status.revision < known) continue;
        statusRevisions[key] = status.revision;
        // ready 只应包含进行中的运行；终态帧不会被当作当前运行展示。
        if (status.status === "running") statuses.push(status);
      }
      // 审批 revision 跨实例持久：ready 整体重建 pending，但不能回退已知版本或复活墓碑。
      const approvalRevisions = { ...state.approvalRevisions };
      const approvalTombstones = { ...state.approvalTombstones };
      const approvals: ApprovalViewDto[] = [];
      const present = new Set<string>();
      for (const approval of pendingApprovals) {
        const revision = approvalRevisions[approval.id] ?? 0;
        const tombstone = approvalTombstones[approval.id] ?? 0;
        // 版本更低说明本地已见过更新状态；同版本墓碑说明该审批已终态，ready 不应复活它。
        if (approval.revision < revision || approval.revision <= tombstone) continue;
        approvalRevisions[approval.id] = approval.revision;
        approvals.push(approval);
        present.add(approval.id);
      }
      // 不在 ready 中的本地 pending 已不再等待；记下已知版本，阻止迟到帧复活。
      for (const approval of state.approvals) {
        if (present.has(approval.id)) continue;
        approvalTombstones[approval.id] = Math.max(
          approvalTombstones[approval.id] ?? 0,
          approvalRevisions[approval.id] ?? 0,
        );
      }
      // ready.activities 是进行中活动集合的完整替换值；终态活动的历史通知不随重连复活。
      return { instanceId, approvals, approvalRevisions, approvalTombstones, statuses, statusRevisions, activities, notices: [] };
    }
    case "agent_status_updated": {
      const status = action.data;
      // ready 是每条连接唯一实例边界，且保证先于增量帧；其他实例的迟到帧直接忽略。
      if (state.instanceId !== status.instanceId) return state;
      const statusRevisions = { ...state.statusRevisions };
      const key = runKey(status.spaceId, status.runId);
      const known = statusRevisions[key] ?? 0;
      if (status.revision <= known) return state;
      statusRevisions[key] = status.revision;
      const rest = state.statuses.filter(
        (item) => runKey(item.spaceId, item.runId) !== key,
      );
      return {
        ...state,
        instanceId: status.instanceId,
        statusRevisions,
        // 终态帧只用于移除并留下 revision 墓碑，不生成活动历史。
        statuses: status.status === "running" ? [...rest, status] : rest,
      };
    }
    case "approval_pending": {
      const approval = action.data;
      const known = Math.max(
        state.approvalRevisions[approval.id] ?? 0,
        state.approvalTombstones[approval.id] ?? 0,
      );
      // 相同或更低 revision 忽略，避免重复/乱序帧覆盖或复活。
      if (approval.revision <= known) return state;
      return {
        ...state,
        approvals: [...state.approvals.filter((item) => item.id !== approval.id), approval],
        approvalRevisions: { ...state.approvalRevisions, [approval.id]: approval.revision },
      };
    }
    case "approval_updated": {
      const approval = action.data;
      const known = state.approvalRevisions[approval.id] ?? 0;
      if (approval.revision < known) return state;
      return {
        ...state,
        approvals: state.approvals.filter((item) => item.id !== approval.id),
        approvalRevisions: { ...state.approvalRevisions, [approval.id]: approval.revision },
        approvalTombstones: {
          ...state.approvalTombstones,
          [approval.id]: Math.max(state.approvalTombstones[approval.id] ?? 0, approval.revision),
        },
      };
    }
    case "activity_updated": {
      const activity = action.data;
      if (state.instanceId !== activity.instanceId) return state;
      const terminal = activity.status === "completed" || activity.status === "failed"
        || activity.status === "stopped" || activity.status === "interrupted";
      const activities = terminal
        ? state.activities.filter((item) => item.id !== activity.id)
        : [...state.activities.filter((item) => item.id !== activity.id), activity];
      // 终态活动转成一条通知：用户在别的空间时也能看到“调研 X 已完成/失败”。
      const notices = terminal
        ? [...state.notices.filter((item) => item.id !== activity.id), activity].slice(-8)
        : state.notices;
      return { ...state, activities, notices };
    }
    case "dismiss_notice":
      return { ...state, notices: state.notices.filter((item) => item.id !== action.id) };
    case "decided": {
      // 决定接口返回权威审批视图；只有服务端确认后才会走到这里。
      const approval = action.data;
      const known = state.approvalRevisions[approval.id] ?? 0;
      if (approval.status === "pending" || approval.revision < known) return state;
      return {
        ...state,
        approvals: state.approvals.filter((item) => item.id !== approval.id),
        approvalRevisions: { ...state.approvalRevisions, [approval.id]: approval.revision },
        approvalTombstones: {
          ...state.approvalTombstones,
          [approval.id]: Math.max(state.approvalTombstones[approval.id] ?? 0, approval.revision),
        },
      };
    }
  }
};

export const App = () => {
  const authed = useSyncExternalStore(subscribeAuth, isLoggedIn);
  const [spaces, setSpaces] = useState<SpaceDto[]>([]);
  const [active, setActive] = useState("local-main");
  const [newSpace, setNewSpace] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  type View = "chat" | "jobs" | "goals" | "settings";
  const [view, setView] = useState<View>("chat");
  // 小屏（<768px）侧栏变为抽屉；默认开抽屉选会话，选完自动收起。
  const [drawer, setDrawer] = useState(false);
  const [workspace, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);

  // 单一工作区 SSE 连接：断线 3 秒后重连；重连后的 ready 负责整体重建。
  // 401 已由 request 清除 token，不再重连；卸载/退出登录时 abort 并清除重连定时器。
  useEffect(() => {
    if (!authed) {
      dispatch({ type: "reset" });
      return;
    }
    const controller = new AbortController();
    // 可中断的固定退避：卸载/退出登录时立即清理定时器，不留下悬挂 timer。
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      if (controller.signal.aborted) return resolve();
      const finish = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      controller.signal.addEventListener("abort", finish, { once: true });
    });
    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          await subscribeWorkspaceEvents((event) => {
            if (!controller.signal.aborted) dispatch(event);
          }, controller.signal);
        } catch (e) {
          // 401 表示凭据失效，登录态变化会清理本 effect；其余错误按固定间隔重连。
          if (controller.signal.aborted || (e instanceof ApiError && e.status === 401)) return;
        }
        if (controller.signal.aborted) return;
        await sleep(3000);
      }
    };
    void connect();
    return () => {
      controller.abort();
    };
  }, [authed]);

  const refreshSpaces = () => {
    if (!authed) return;
    void listSpaces()
      .then((list) => {
        setSpaces(list);
        if (list.length && !list.some((x) => x.id === active)) setActive(list[0]!.id);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    refreshSpaces();
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

  // 只展示一行当前运行状态；优先当前会话，其次任意进行中的运行，不构造活动列表。
  const currentStatus =
    workspace.statuses.find((status) => status.spaceId === active) ?? workspace.statuses[0];

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
          {spaces.map((space) => (
            <button
              key={space.id}
              onClick={() => {
                setActive(space.id);
                setView("chat");
                setDrawer(false);
              }}
              className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm ${
                space.id === active
                  ? "bg-stone-800 text-white"
                  : "text-stone-600 hover:bg-stone-100"
              }`}
            >
              {space.id}
            </button>
          ))}
        </div>
        <div className={`border-t border-stone-200 p-2 ${view === "chat" ? "" : "hidden"}`}>
          <input
            value={newSpace}
            onChange={(e) => setNewSpace(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !newSpace.trim()) return;
              const id = newSpace.trim();
              if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
                setError("空间名：字母或数字开头，可含 _ -");
                return;
              }
              if (!spaces.some((x) => x.id === id)) {
                setSpaces([...spaces, { id, sessionId: "", updatedAt: new Date().toISOString() }]);
              }
              setActive(id);
              setNewSpace("");
              setError("");
            }}
            placeholder="新空间名称…"
            className="w-full rounded-lg border border-stone-300 px-2.5 py-1.5 text-sm outline-none focus:border-stone-500"
          />
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {workspace.approvals.length > 0 && (
          <div className="flex max-h-[50vh] shrink-0 items-start gap-3 overflow-y-auto border-b border-amber-200 bg-amber-50 px-4 py-2">
            <span aria-hidden>🔔</span>
            <div className="min-w-0 flex-1 space-y-2">
              {workspace.approvals.map((action) => (
                <ActionApproval
                  key={action.id}
                  action={action}
                  onDecided={(resolved) => dispatch({ type: "decided", data: resolved })}
                />
              ))}
            </div>
          </div>
        )}
        {currentStatus && (
          <div className="flex items-center gap-2 border-b border-stone-200 bg-white px-4 py-1.5 text-xs text-stone-500">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" aria-hidden />
            <span className="truncate">
              {currentStatus.title} · {currentStatus.label}
            </span>
            <span className="ml-auto shrink-0 text-stone-400">
              {currentStatus.source === "job" ? "定时任务" : currentStatus.spaceId}
            </span>
          </div>
        )}
        {workspace.notices.length > 0 && (
          <div className="shrink-0 space-y-1 border-b border-stone-200 bg-emerald-50 px-4 py-2">
            {workspace.notices.map((notice) => (
              <div key={notice.id} className="flex items-start gap-2 text-xs">
                <span aria-hidden>{notice.status === "completed" ? "✅" : "⚠️"}</span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-stone-700">{notice.title}</span>
                  <span className="ml-1.5 text-stone-500">
                    {notice.status === "completed" ? "已完成" : notice.status === "failed" ? "失败" : notice.status === "stopped" ? "已停止" : "已中断"}
                  </span>
                  {notice.result && (
                    <p className="mt-0.5 truncate text-stone-500">{notice.result}</p>
                  )}
                  <span className="ml-1.5 text-stone-400">{notice.spaceId}</span>
                </div>
                <button
                  onClick={() => dispatch({ type: "dismiss_notice", id: notice.id })}
                  aria-label="关闭通知"
                  className="shrink-0 rounded px-1 text-stone-400 hover:bg-stone-200 hover:text-stone-600"
                >
                  ✕
                </button>
              </div>
            ))}
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
        {view === "chat" && (
          <ChatView
            key={active}
            spaceId={active}
            sessionId={spaces.find((s) => s.id === active)?.sessionId}
            onReset={refreshSpaces}
          />
        )}
        {view === "jobs" && <JobsView />}
        {view === "goals" && <GoalsView />}
        {view === "settings" && <SettingsView spaceId={active} />}
        </div>
      </main>
    </div>
  );
};
