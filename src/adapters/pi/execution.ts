import type { AgentSession, AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ConversationExecution } from "../../features/conversation/ports.js";
import type { ExecutionEvent } from "../../features/conversation/types.js";
import { textOf } from "./history-projection.js";

/**
 * 归一化 SDK 事件并在 pi 持久化前清洗诊断。
 * message_end 的 listener 在 pi 内部 appendMessage 之前运行，必须清洗原对象，
 * 而不只是给 SSE 生成一份脱敏副本。正常模型文本不改写。
 */
export const projectExecutionEvent = (event: AgentSessionEvent): ExecutionEvent | undefined => {
  if (event.type === "message_end" && event.message.role === "assistant") {
    if (event.message.errorMessage)
      event.message.errorMessage = "Model request failed or was cancelled";
    return { type: "assistant_end", reason: event.message.stopReason, text: textOf(event.message.content) };
  }
  if (event.type === "tool_execution_end") {
    const result = event.result as { content?: unknown; details?: { denied?: boolean } } | undefined;
    const controlled = event.isError && result?.details?.denied === true;
    return {
      type: "tool_result", id: event.toolCallId,
      content: event.isError && !controlled ? "Tool execution failed" : textOf(result?.content),
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
  prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
  waitForIdle: () => session.waitForIdle(),
  abort: () => session.abort(),
  dispose: () => session.dispose(),
  syncContext: () => { session.agent.state.messages = manager.buildSessionContext().messages; },
  subscribe: (listener) => session.subscribe((event) => {
    const projected = projectExecutionEvent(event);
    if (projected) listener(projected);
  }),
});
