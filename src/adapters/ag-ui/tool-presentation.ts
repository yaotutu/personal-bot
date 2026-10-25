import type { Config } from "../../config/load-config.js";
import type { ConversationHistory, HistoryMessage } from "../../features/conversation/types.js";

type ToolPresentationMode = "hidden" | "summary";

export type ToolPresentation = {
  modeFor: (name: string) => ToolPresentationMode;
  presentArguments: (name: string, args: unknown) => string;
  presentResult: (name: string, content: string, isError?: boolean) => string;
  presentHistory: (history: ConversationHistory) => ConversationHistory;
};

const compact = (value: string, max = 500) => {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};

const failure = "工具执行失败";
const finished = "工具执行已结束（详情已隐藏）";
const controlledDenials = new Set([
  "Access denied: path is outside the documents directory.",
  "Access denied: path is outside the documents directory or contains a symlink.",
]);

const errorText = (content: string) =>
  content === "Tool execution failed" || content === failure
    ? failure
    : controlledDenials.has(content) ? content : undefined;

/**
 * SearchToolCard 只接受来源 URL/title。保留来源而非伪造成功的空结果；
 * 不发送 snippet/供应商诊断，URL 的查询串和 fragment 也不属于展示摘要。
 */
const searchSummary = (content: string) => {
  const unreadable = () => JSON.stringify({ error: "Search failed." });
  try {
    const value = JSON.parse(content) as {
      results?: unknown;
      warnings?: unknown;
      truncated?: unknown;
      error?: unknown;
    };
    if (!value || typeof value !== "object") return unreadable();
    if (typeof value.error === "string")
      return JSON.stringify({ error: "Search failed." });
    if (!Array.isArray(value.results)) return unreadable();
    const results = value.results.slice(0, 10).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const rawUrl = (item as { url?: unknown }).url;
      const title = (item as { title?: unknown }).title;
      if (typeof rawUrl !== "string" || rawUrl.length > 2048) return [];
      try {
        const url = new URL(rawUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
        url.search = "";
        url.hash = "";
        return [{ url: url.href, title: typeof title === "string" ? compact(title, 180) : null }];
      } catch {
        return [];
      }
    });
    return JSON.stringify({
      results,
      warnings: Array.isArray(value.warnings) && value.warnings.length
        ? ["部分搜索信息未展示。"] : [],
      truncated: value.truncated === true || results.length !== value.results.length,
    });
  } catch {
    return unreadable();
  }
};

const summaryResult = (name: string, content: string, isError = false) => {
  const error = errorText(content) ?? (isError ? failure : undefined);
  if (name === "search_web") return error ? JSON.stringify({ error: "Search failed." }) : searchSummary(content);
  if (error) return error;
  // 自身输出也是合法输入，历史快照的防漏投影可以重复执行而不改变语义。
  const confirmations = [finished, "已保存记忆", "已修改记忆", "已删除记忆", "未找到该记忆", "未找到匹配的记忆", "已检索记忆", "已创建提醒", "已取消提醒", "未找到该提醒", "未设置提醒", "已查询提醒列表"];
  if (confirmations.includes(content)) return content;
  if (name === "currentTime") {
    const iso = /(?:^|\n)ISO 8601: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(?:$|\n)/.exec(content)?.[1];
    return iso ? `ISO 8601: ${iso}` : finished;
  }
  if (name === "get_weather") {
    const temperature = /^当前 -?\d+(?:\.\d+)?°C，体感 -?\d+(?:\.\d+)?°C$/m.exec(content)?.[0];
    return temperature ?? finished;
  }
  if (name === "memory") {
    if (content.startsWith("Remembered: ")) return "已保存记忆";
    if (content.startsWith("Edited memory ")) return "已修改记忆";
    if (content.startsWith("Forgot memory ")) return "已删除记忆";
    if (content.startsWith("No memory with id ")) return "未找到该记忆";
  }
  if (name === "memory_search") {
    if (content.startsWith("No memory matches ")) return "未找到匹配的记忆";
    if (content.startsWith("- [")) return "已检索记忆";
  }
  if (name === "schedule") {
    if (content.startsWith("Scheduled (id ")) return "已创建提醒";
    if (content === "Cancelled.") return "已取消提醒";
    if (content === "No such job.") return "未找到该提醒";
    if (content === "No scheduled jobs.") return "未设置提醒";
    if (content.startsWith("- ")) return "已查询提醒列表";
  }
  if (name === "navigate") return "已打开页面";
  if (name === "snapshot") return "已读取页面结构";
  if (name === "act") return "已执行浏览器操作";
  if (name === "tab") return "已管理浏览器标签";
  // 文件/页面内容没有必要靠解析正文猜成功；缺少可信结果信息时只确认结束。
  return finished;
};

const toolCallsOf = (message: Extract<HistoryMessage, { role: "assistant" }>) =>
  message.toolCalls ?? [];

/**
 * 工具执行和展示是两个出口：这里永远只复制/投影客户端消息，不修改 pi entry。
 * history()、实时 SSE 和 replay 都使用同一规则，避免刷新后重新泄露隐藏结果。
 */
export const createToolPresentation = (config: Config["presentation"]): ToolPresentation => {
  const defaultMode = config.default;
  const overrides = { ...config.overrides };
  const modeFor = (name: string) => Object.hasOwn(overrides, name) ? overrides[name]! : defaultMode;
  const presentArguments = (name: string, _args: unknown) =>
    modeFor(name) === "hidden" ? "" : "{}";
  const presentResult = (name: string, content: string, isError?: boolean) =>
    modeFor(name) === "hidden" ? "" : summaryResult(name, content, isError);

  const presentHistory = (history: ConversationHistory): ConversationHistory => {
    const hiddenCallIds = new Set<string>();
    const callsById = new Map<string, string>();
    for (const message of history) {
      if (message.role !== "assistant") continue;
      for (const call of toolCallsOf(message)) {
        callsById.set(call.id, call.function.name);
        if (modeFor(call.function.name) === "hidden") hiddenCallIds.add(call.id);
      }
    }
    const result: ConversationHistory = [];
    for (const message of history) {
      if (message.role === "assistant") {
        const toolCalls = toolCallsOf(message)
          .filter((call) => !hiddenCallIds.has(call.id))
          .map((call) => ({
            ...call,
            function: { ...call.function, arguments: presentArguments(call.function.name, call.function.arguments) },
          }));
        if (!message.content && !toolCalls.length) continue;
        result.push({ ...message, toolCalls: toolCalls.length ? toolCalls : undefined });
        continue;
      }
      if (message.role === "tool") {
        const name = callsById.get(message.toolCallId);
        if (!name || modeFor(name) === "hidden") continue;
        // isError 是 pi 的内部结果事实，不属于 AG-UI Message schema；使用后移除。
        const { isError, ...shown } = message;
        result.push({ ...shown, content: presentResult(name, message.content, isError) });
        continue;
      }
      result.push(message);
    }
    return result;
  };

  return { modeFor, presentArguments, presentResult, presentHistory };
};
