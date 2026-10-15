import { useEffect, useRef, useState } from "react";
import type { MessageView, ToolCallView } from "./chat-state";
import { StreamAggregator, projectHistory } from "./chat-state";
import {
  loadHistory,
  runConversation,
  stopConversation,
  type ApiMessage,
} from "../lib/api.js";

const randomRunId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random()}`);

const toolLabel = (call: ToolCallView): string => {
  switch (call.name) {
    case "currentTime":
      return "查询当前时间";
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
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const historyRef = useRef<ApiMessage[]>([]);

  // 切换 thread 或首次加载：拉权威历史。
  useEffect(() => {
    setError("");
    setViews([]);
    historyRef.current = [];
    void loadHistory(threadId)
      .then((messages) => {
        historyRef.current = messages;
        setViews(projectHistory(messages));
      })
      .catch((e: Error) => setError(e.message));
  }, [threadId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [views]);

  const send = async () => {
    const text = draft.trim();
    if (!text || running) return;
    setDraft("");
    setError("");
    // 乐观视图：用户消息 + 流式聚合器。
    const optimistic: MessageView = {
      id: `user-${Date.now()}`,
      role: "user",
      text,
      toolCalls: [],
    };
    const aggregator = new StreamAggregator([...views, optimistic]);
    setViews([...aggregator.messages]);
    setRunning(true);
    const runId = randomRunId();
    try {
      await runConversation(
        {
          threadId,
          runId,
          // 服务端校验 canonical 用户序列：已发消息 + 新消息。
          messages: [
            ...historyRef.current.filter((x) => x.role === "user"),
            { id: optimistic.id, role: "user", content: text },
          ],
        },
        (event) => {
          aggregator.push(event);
          // 聚合器内部原位修改；拷贝触发渲染。
          setViews([...aggregator.messages]);
          if (event.type === "RUN_ERROR") setError(event.message ?? "运行失败");
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      aggregator.settle();
      // 以服务端权威历史收尾（含工具投影与最终文本）。
      try {
        const messages = await loadHistory(threadId);
        historyRef.current = messages;
        setViews(projectHistory(messages));
      } catch {
        setViews([...aggregator.messages]);
      }
    }
  };

  const stop = async () => {
    try {
      await stopConversation(threadId);
    } catch {
      // 停止失败由 run 轮的终态事件兜底。
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-5">
        {views.length === 0 && !error && (
          <div className="mt-16 text-center text-sm text-stone-400">
            有什么可以帮你的？
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
              onClick={() => void stop()}
              className="rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
            >
              停止
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!draft.trim()}
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
