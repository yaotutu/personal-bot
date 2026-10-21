import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ConversationEvent } from "../../features/conversation/types.js";
import type { ToolPresentation } from "./tool-presentation.js";

/**
 * 每次客户端 run 独享一个协议投影器，状态不进入主会话锁。
 * hidden 抑制整组工具事件；summary 只在 END 时发送安全参数，不泄露参数增量。
 * 可省略展示策略以测试原始协议投影；生产由组合入口传入显式策略。
 */
export const createEventProjector = (
  emit: (event: BaseEvent) => void,
  presentation?: ToolPresentation,
) => {
  let assistantId = "";
  let textStarted = false;
  const toolNames = new Map<string, string>();
  const startedTools = new Set<string>();
  const modeFor = (name: string) => presentation?.modeFor(name) ?? "summary";
  const startTool = (id: string, name: string) => {
    toolNames.set(id, name);
    if (startedTools.has(id) || (presentation && modeFor(name) === "hidden")) return;
    startedTools.add(id);
    emit({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name, parentMessageId: assistantId });
  };
  return (event: ConversationEvent) => {
    switch (event.type) {
      case "run_started":
        assistantId = event.assistantId;
        emit({ type: EventType.RUN_STARTED, spaceId: event.spaceId, threadId: event.spaceId, runId: event.runId } as BaseEvent);
        break;
      case "run_finished":
        toolNames.clear();
        startedTools.clear();
        emit({ type: EventType.RUN_FINISHED, spaceId: event.spaceId, threadId: event.spaceId, runId: event.runId } as BaseEvent);
        break;
      case "run_error":
        toolNames.clear();
        startedTools.clear();
        emit({ type: EventType.RUN_ERROR, code: event.code, message: event.message });
        break;
      case "history_snapshot":
        emit({ type: EventType.MESSAGES_SNAPSHOT, messages: presentation ? presentation.presentHistory(event.messages) : event.messages });
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
        if (!presentation) emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: event.id, delta: event.delta });
        break;
      case "tool_end": {
        const alreadyStarted = startedTools.has(event.id);
        startTool(event.id, event.name);
        const name = toolNames.get(event.id) ?? event.name;
        if (presentation && modeFor(name) === "hidden") break;
        if (presentation) {
          emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: event.id, delta: presentation.presentArguments(name, event.arguments) });
        } else if (!alreadyStarted) {
          const args = JSON.stringify(event.arguments ?? {});
          if (args !== "{}") emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: event.id, delta: args });
        }
        emit({ type: EventType.TOOL_CALL_END, toolCallId: event.id });
        break;
      }
      case "tool_result": {
        const name = toolNames.get(event.id);
        toolNames.delete(event.id);
        if (presentation && (!name || modeFor(name) === "hidden")) break;
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "tool-" + event.id,
          toolCallId: event.id,
          content: presentation && name ? presentation.presentResult(name, event.content) : event.content,
          role: "tool",
        });
        break;
      }
      case "assistant_end":
        // pi 的消息终止并非 run 终态；协调器等待 idle/持久化后才发送完成事件。
        break;
    }
  };
};
