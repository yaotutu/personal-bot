import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MessageView, ToolCallView } from "./chat-state";
import { StreamAggregator, projectHistory } from "./chat-state";
import {
  loadHistory,
  runConversation,
  stopConversation,
  ApiError,
} from "../lib/api.js";

const randomRunId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random()}`);

type ForegroundRun = {
  threadId: string;
  runId: string;
  controller: AbortController;
};

type ChatSession = {
  threadId: string;
  controller: AbortController;
  historyReady: boolean;
  revision: string;
  run?: ForegroundRun;
};

const toolLabel = (call: ToolCallView): string => {
  switch (call.name) {
    case "currentTime":
      return "查询当前时间";
    case "activity":
      return "登记工作活动";
    case "memory":
      return "记忆操作";
    case "schedule":
      return "定时任务";
    case "read":
      return `读取 ${call.args}`;
    case "grep":
      return `搜索 ${call.args}`;
    case "find":
      return `查找 ${call.args}`;
    case "ls":
      return "列出目录";
    case "write":
      return `写入 ${call.args}`;
    case "edit":
      return `编辑 ${call.args}`;
    case "search_web":
      return "网页搜索";
    case "web_fetch":
      return "抓取网页";
    case "get_weather":
      return "查询天气";
    default:
      return call.name;
  }
};

const ToolCard = ({ call }: { call: ToolCallView }) => (
  <div className="my-1 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
    <div className="flex items-center gap-2 text-stone-600">
      <span aria-hidden>🔧</span>
      <span className="font-medium">{toolLabel(call)}</span>
      {call.result === undefined && (
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
      )}
    </div>
    {call.result !== undefined && (
      <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-all text-stone-500">
        {call.result || "（空结果）"}
      </p>
    )}
  </div>
);

const MessageBubble = ({ message }: { message: MessageView }) => {
  const mine = message.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
          mine
            ? "bg-stone-800 text-stone-50"
            : "border border-stone-200 bg-white text-stone-800"
        }`}
      >
        {message.toolCalls.length > 0 && (
          <div className={mine ? "" : "mb-2"}>
            {message.toolCalls.map((call) => (
              <ToolCard key={call.id} call={call} />
            ))}
          </div>
        )}
        {message.text && <p className="whitespace-pre-wrap">{message.text}</p>}
        {message.streaming && !message.text && message.toolCalls.length === 0 && (
          <span className="inline-flex gap-1">
            <span className="animate-bounce">·</span>
            <span className="animate-bounce [animation-delay:120ms]">·</span>
            <span className="animate-bounce [animation-delay:240ms]">·</span>
          </span>
        )}
      </div>
    </div>
  );
};

export const ChatView = ({ threadId }: { threadId: string }) => {
  const [views, setViews] = useState<MessageView[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState<ForegroundRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ChatSession | null>(null);

  // 每次挂载/切换都创建独立归属对象，避免 A→B→A 时仅比较 threadId 误认旧请求。
  // layout cleanup 在新界面可交互前撤销归属；abort 只负责停 I/O，归属校验负责拦截已排队回调。
  useLayoutEffect(() => {
    const session: ChatSession = {
      threadId,
      controller: new AbortController(),
      historyReady: false,
      revision: "empty",
    };
    sessionRef.current = session;
    const ownsSession = () => sessionRef.current === session && !session.controller.signal.aborted;
    setError("");
    setViews([]);
    setDraft("");
    setRunning(null);
    setStopping(false);
    setLoading(true);
    void loadHistory(threadId, session.controller.signal)
      .then(({ messages, revision }) => {
        if (!ownsSession()) return;
        session.revision = revision;
        session.historyReady = true;
        setViews(projectHistory(messages));
      })
      .catch((e: unknown) => {
        if (ownsSession()) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (ownsSession()) setLoading(false);
      });
    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      session.controller.abort();
      session.run?.controller.abort();
    };
  }, [threadId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [views]);

  const send = async () => {
    const text = draft.trim();
    const session = sessionRef.current;
    // ref 同步占有 run，防止 React 尚未提交 running 状态时连续 Enter 发出重复请求。
    // 首次历史未成功加载前不允许发送，否则空 历史版本会覆盖不了服务端已有历史。
    if (!text || !session || session.threadId !== threadId || !session.historyReady || session.run) return;
    const run: ForegroundRun = { threadId: session.threadId, runId: randomRunId(), controller: new AbortController() };
    session.run = run;
    const ownsRun = () =>
      sessionRef.current === session && !session.controller.signal.aborted && session.run === run;
    setDraft("");
    setError("");
    setStopping(false);
    // 乐观视图：用户消息 + 流式聚合器。
    const optimistic: MessageView = {
      id: `user-${Date.now()}`,
      role: "user",
      text,
      toolCalls: [],
    };
    const aggregator = new StreamAggregator([...views, optimistic]);
    setViews([...aggregator.messages]);
    setRunning(run);
    let restoredDraft = false;
    const restoreDraft = () => {
      if (restoredDraft || !ownsRun()) return;
      restoredDraft = true;
      // 请求未被接纳时恢复原文，同时保留用户运行期间新输入的草稿，不能静默丢消息。
      setDraft((current) => current ? `${text}\n${current}` : text);
    };
    try {
      await runConversation(
        {
          threadId: run.threadId,
          runId: run.runId,
          expectedRevision: session.revision,
          message: { id: optimistic.id, content: text },
        },
        (event) => {
          if (!ownsRun() || run.controller.signal.aborted) return;
          aggregator.push(event);
          // 聚合器内部原位修改；拷贝触发渲染。
          setViews([...aggregator.messages]);
          if (event.type === "RUN_ERROR") {
            setError(event.message);
            if (["HISTORY_CONFLICT", "agent_thread_locked", "MODEL_NOT_CONFIGURED"].includes(event.code)) restoreDraft();
          }
        },
        run.controller.signal,
      );
    } catch (e) {
      // 用户 Stop 或离开页面属于正常取消，不把 AbortError 显示成模型故障。
      if (ownsRun() && !run.controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
        if (e instanceof ApiError && [400, 409, 503].includes(e.status)) restoreDraft();
      }
    } finally {
      if (ownsRun()) {
        aggregator.settle();
        setViews([...aggregator.messages]);
        // Stop 只取消本轮流，刷新使用会话级 signal；切换/卸载则两者都取消。
        // 直到刷新结束才释放 run，防止旧 finally 覆盖新一轮视图或 历史版本。
        try {
          const { messages, revision } = await loadHistory(run.threadId, session.controller.signal);
          if (ownsRun()) {
            session.revision = revision;
            setViews(projectHistory(messages));
          }
        } catch (e) {
          if (ownsRun()) {
            // 刷新失败时保留已展示的结果，但禁止用旧 历史版本继续发送。
            session.historyReady = false;
            setError(e instanceof Error ? e.message : String(e));
          }
        } finally {
          if (ownsRun()) {
            session.run = undefined;
            setRunning(null);
            setStopping(false);
          }
        }
      }
    }
  };

  const stop = async (run: ForegroundRun) => {
    const session = sessionRef.current;
    if (!session || session.threadId !== run.threadId || session.run !== run) return;
    setStopping(true);
    try {
      // 等待服务端的 abort、结果落盘和通知队列释放；SSE 自然结束后才刷新并允许下一轮。
      // 离开页面仍直接取消本轮流；迟到的显式 Stop 因 runId 不匹配而不会影响新轮。
      await stopConversation(run.threadId, run.runId, session.controller.signal);
    } catch (e) {
      if (sessionRef.current === session && session.run === run) {
        setError(e instanceof Error ? e.message : String(e));
        setStopping(false);
      }
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-5">
        {views.length === 0 && !error && (
          <div className="mt-16 text-center text-sm text-stone-400">
            {loading ? "正在加载历史…" : "有什么可以帮你的？"}
          </div>
        )}
        {views.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {error && (
          <div className="mx-auto max-w-[85%] rounded-lg bg-red-50 px-3 py-2 text-center text-sm text-red-600">
            {error}
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="border-t border-stone-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="输入消息，Enter 发送"
            rows={Math.min(4, Math.max(1, draft.split("\n").length))}
            className="flex-1 resize-none rounded-xl border border-stone-300 px-3 py-2 text-[15px] outline-none focus:border-stone-500"
          />
          {running ? (
            <button
              onClick={() => void stop(running)}
              disabled={stopping}
              className="rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40"
            >
              {stopping ? "停止中…" : "停止"}
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!draft.trim() || loading || !sessionRef.current?.historyReady}
              className="rounded-xl bg-stone-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
