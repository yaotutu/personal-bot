import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ConversationEvent } from "../../features/conversation/types.js";

/**
 * 每次客户端 run 独享一个协议投影器，状态不进入主会话锁。
 * 保持原有文本 START/CONTENT/END 和工具三段式；供应商漏掉 start 时补发。
 */
export const createEventProjector = (emit: (event: BaseEvent) => void) => {
  let assistantId = "";
  let textStarted = false;
  const startedTools = new Set<string>();
  const startTool = (id: string, name: string) => {
    if (startedTools.has(id)) return;
    startedTools.add(id);
    emit({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name, parentMessageId: assistantId });
  };
  return (event: ConversationEvent) => {
    switch (event.type) {
      case "run_started":
        assistantId = event.assistantId;
        emit({ type: EventType.RUN_STARTED, threadId: event.threadId, runId: event.runId });
        break;
      case "run_finished":
        emit({ type: EventType.RUN_FINISHED, threadId: event.threadId, runId: event.runId });
        break;
      case "run_error":
        emit({ type: EventType.RUN_ERROR, code: event.code, message: event.message });
        break;
      case "history_snapshot":
        emit({ type: EventType.MESSAGES_SNAPSHOT, messages: event.messages });
        break;
      case "text_delta":
        if (!event.delta) return;
        if (!textStarted) {
          textStarted = true;
          emit({ type: EventType.TEXT_MESSAGE_START, messageId: assistantId, role: "assistant" });
        }
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: assistantId, delta: event.delta });
        break;
      case "text_end":
        if (textStarted) emit({ type: EventType.TEXT_MESSAGE_END, messageId: event.assistantId });
        break;
      case "tool_start":
        startTool(event.id, event.name);
        break;
      case "tool_delta":
        startTool(event.id, event.name);
        emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: event.id, delta: event.delta });
        break;
      case "tool_end":
        if (!startedTools.has(event.id)) {
          startTool(event.id, event.name);
          const args = JSON.stringify(event.arguments ?? {});
          if (args !== "{}") emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: event.id, delta: args });
        }
        emit({ type: EventType.TOOL_CALL_END, toolCallId: event.id });
        break;
      case "tool_result":
        emit({ type: EventType.TOOL_CALL_RESULT, messageId: "tool-" + event.id, toolCallId: event.id, content: event.content, role: "tool" });
        break;
      case "assistant_end":
        // pi 的消息终止并非 run 终态；协调器等待 idle/持久化后才发送完成事件。
        break;
    }
  };
};
