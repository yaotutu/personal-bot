import type { AgentSession, AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ConversationExecution } from "../../features/conversation/ports.js";
import type { ExecutionEvent } from "../../features/conversation/types.js";
import { textOf } from "./history-projection.js";

const GENERIC_TOOL_ERROR = "Tool execution failed";
/** 默认错误在模型上下文与 JSONL 之前清洗；仅 guard 标记的受控文案可以保留。 */
type ScrubbableToolResult = { isError?: boolean; details?: unknown; content?: unknown };
const isControlledRejection = (result: ScrubbableToolResult | undefined) =>
  (result?.details as { denied?: unknown } | undefined)?.denied === true;
const scrubToolResultInPlace = (result: ScrubbableToolResult | undefined, isError = result?.isError) => {
  if (!result || !isError || isControlledRejection(result)) return;
  result.content = [{ type: "text", text: GENERIC_TOOL_ERROR }];
  result.details = undefined;
};

export const projectExecutionEvent = (event: AgentSessionEvent): ExecutionEvent | undefined => {
  if (event.type === "message_end" && event.message.role === "assistant") {
    if (event.message.errorMessage)
      event.message.errorMessage = "Model request failed or was cancelled";
    return { type: "assistant_end", reason: event.message.stopReason, text: textOf(event.message.content) };
  }
  if (event.type === "message_end" && event.message.role === "toolResult") {
    // SDK 在 _emit 同步通知后才会 appendMessage(event.message)，
    // 此处原地修改会被持久化并送回模型，因此必须早于 message_end 落盘。
    scrubToolResultInPlace(event.message as unknown as ScrubbableToolResult);
    return;
  }
  if (event.type === "tool_execution_end") {
    const result = event.result as ScrubbableToolResult | undefined;
    const controlled = event.isError && isControlledRejection(result);
    scrubToolResultInPlace(result, event.isError);
    return {
      type: "tool_result", id: event.toolCallId,
      content: event.isError && !controlled ? GENERIC_TOOL_ERROR : textOf(result?.content),
    };
  }
  if (event.type !== "message_update") return;
  const update = event.assistantMessageEvent;
  if (update.type === "text_delta") return { type: "text_delta", delta: update.delta };
  if (update.type === "toolcall_end") {
    const call = update.toolCall;
    return { type: "tool_end", id: call.id, name: call.name, arguments: call.arguments };
  }
  if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
    const block = update.partial.content[update.contentIndex];
    if (block?.type !== "toolCall" || !block.id) return;
    return update.type === "toolcall_start"
      ? { type: "tool_start", id: block.id, name: block.name }
      : { type: "tool_delta", id: block.id, name: block.name, delta: update.delta };
  }
};

/** 包装当前 pi session，不创建新的执行状态、重试机制或持久化容器。 */
export const createPiExecution = (session: AgentSession, manager: SessionManager): ConversationExecution => ({
  prompt: (text, images) => session.prompt(text, {
    expandPromptTemplates: false,
    ...(images?.length ? { images: images.map((image) => ({ ...image })) } : {}),
  }),
  waitForIdle: () => session.waitForIdle(),
  abort: () => session.abort(),
  dispose: () => session.dispose(),
  syncContext: () => { session.agent.state.messages = manager.buildSessionContext().messages; },
  compactIfNeeded: async (customInstructions?: string) => {
    try {
      const usage = session.getContextUsage();
      if (usage?.percent && usage.percent >= 80) {
        await session.compact(customInstructions);
        session.agent.state.messages = manager.buildSessionContext().messages;
        return true;
      }
    } catch {
      // 若无需压缩或无法压缩（会话太小），安全略过
    }
    return false;
  },
  subscribe: (listener) => session.subscribe((event) => {
    const projected = projectExecutionEvent(event);
    if (projected) listener(projected);
  }),
});
