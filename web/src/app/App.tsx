import { useEffect, useState } from "react";
import { ChatView } from "../chat/ChatView";
import { JobsView } from "../jobs/JobsView";
import { GoalsView } from "../goals/GoalsView";
import { SettingsView } from "../settings/SettingsView";
import { isLoggedIn, listThreads, login } from "../lib/api";

/**
 * 应用骨架：左侧会话列表（threads），右侧聊天区。
 * 新 thread 通过侧栏输入创建（合法 id：字母数字开头，可含 _ -）。
 */
export const App = () => {
  const [authed, setAuthed] = useState(isLoggedIn());
  const [threads, setThreads] = useState<{ id: string; updatedAt: string }[]>([]);
  const [active, setActive] = useState("local-main");
  const [newThread, setNewThread] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  type View = "chat" | "jobs" | "goals" | "settings";
  const [view, setView] = useState<View>("chat");
  // 小屏（<768px）侧栏变为抽屉；默认开抽屉选会话，选完自动收起。
  const [drawer, setDrawer] = useState(false);

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

  if (!authed) {
    return (
      <div className="flex h-screen items-center justify-center bg-stone-100">
        <div className="w-80 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-stone-800">Personal Bot</h1>
          <p className="mt-1 text-sm text-stone-500">
            {accessKey === "" && error ? error : "输入服务端访问密钥（未配置密钥时直接进入）"}
          </p>
          <input
            type="password"
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                void login(accessKey).then((ok) => {
                  setAuthed(ok);
                  setError(ok ? "" : "访问密钥不正确");
                });
            }}
            placeholder="访问密钥"
            className="mt-4 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm outline-none focus:border-stone-500"
          />
          <button
            onClick={() =>
              void login(accessKey).then((ok) => {
                setAuthed(ok);
                setError(ok ? "" : "访问密钥不正确");
              })
            }
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
          Personal Bot
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
        <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5 md:hidden">
          <button
            onClick={() => setDrawer(true)}
            aria-label="打开会话列表"
            className="rounded-lg border border-stone-300 px-2.5 py-1 text-sm text-stone-600"
          >
            ☰
          </button>
          <span className="text-sm font-semibold text-stone-700">Personal Bot</span>
          <span className="ml-auto truncate text-xs text-stone-400">{active}</span>
        </header>
        <div className="min-h-0 flex-1">
        {view === "chat" && <ChatView threadId={active} />}
        {view === "jobs" && <JobsView />}
        {view === "goals" && <GoalsView />}
        {view === "settings" && <SettingsView />}
        </div>
      </main>
    </div>
  );
};
