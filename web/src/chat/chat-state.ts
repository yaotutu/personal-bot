/**
 * 聊天运行时状态：把 AG-UI 事件流聚合成可渲染的消息视图。
 * 运行结束后由服务端权威历史（GET /api/conversation）替换，避免双份事实。
 */
import type { ApiMessage, SseEvent } from "../lib/api.js";

export type ToolCallView = {
  id: string;
  name: string;
  args: string;
  result?: string;
};

export type MessageView = {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolCalls: ToolCallView[];
  /** 运行中的 assistant 消息（流式聚合）。 */
  streaming?: boolean;
};

/** 把服务端历史（含 toolCalls/tool 消息）投影为视图。 */
export const projectHistory = (messages: ApiMessage[]): MessageView[] => {
  const views: MessageView[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      views.push({
        id: message.id,
        role: "user",
        text: typeof message.content === "string" ? message.content : "",
        toolCalls: [],
      });
    } else if (message.role === "assistant") {
      const view: MessageView = {
        id: message.id,
        role: "assistant",
        text: typeof message.content === "string" ? message.content : "",
        toolCalls: (message.toolCalls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          args: call.function.arguments,
        })),
      };
      views.push(view);
    } else if (message.role === "tool" && message.toolCallId) {
      // 工具结果挂到同 thread 之前出现的对应 toolCall 上。
      for (let i = views.length - 1; i >= 0; i--) {
        const hit = views[i]!.toolCalls.find((x) => x.id === message.toolCallId);
        if (hit) {
          hit.result = typeof message.content === "string" ? message.content : "";
          break;
        }
      }
    }
  }
  return views;
};

/** 运行期聚合器：消费 SSE 事件，维护本地乐观视图。 */
export class StreamAggregator {
  readonly messages: MessageView[];
  private current?: MessageView;
  private readonly args = new Map<string, string>();

  constructor(existing: MessageView[]) {
    this.messages = [...existing];
  }

  push(event: SseEvent): void {
    switch (event.type) {
      case "TEXT_MESSAGE_START": {
        // 服务端同一轮工具与文本共用 assistant ID。工具先建出的占位消息
        // 必须继续复用，不能再次 push 同 ID，否则 React key 重复且工具卡片闪动。
        const id = event.messageId;
        const existing = this.messages.find((message) => message.role === "assistant" && message.id === id);
        this.current = existing ?? { id, role: "assistant", text: "", toolCalls: [] };
        this.current.streaming = true;
        if (!existing) this.messages.push(this.current);
        break;
      }
      case "TEXT_MESSAGE_CONTENT": {
        if (this.current && event.delta) this.current.text += event.delta;
        break;
      }
      case "TEXT_MESSAGE_END": {
        if (this.current) this.current.streaming = false;
        break;
      }
      case "TOOL_CALL_START": {
        const target =
          this.current ??
          ({
            id: event.parentMessageId ?? `assistant-${Date.now()}`,
            role: "assistant",
            text: "",
            toolCalls: [],
            streaming: true,
          } as MessageView);
        if (!this.current) {
          this.current = target;
          this.messages.push(target);
        }
        target.toolCalls.push({
          id: event.toolCallId,
          name: event.toolCallName,
          args: "",
        });
        break;
      }
      case "TOOL_CALL_ARGS": {
        if (event.toolCallId && event.delta)
          this.args.set(
            event.toolCallId,
            (this.args.get(event.toolCallId) ?? "") + event.delta,
          );
        break;
      }
      case "TOOL_CALL_END": {
        if (event.toolCallId) {
          const args = this.args.get(event.toolCallId) ?? "{}";
          this.args.delete(event.toolCallId);
          for (let i = this.messages.length - 1; i >= 0; i--) {
            const call = this.messages[i]!.toolCalls.find((x) => x.id === event.toolCallId);
            if (call) {
              call.args = args;
              break;
            }
          }
        }
        break;
      }
      case "TOOL_CALL_RESULT": {
        if (event.toolCallId) {
          for (let i = this.messages.length - 1; i >= 0; i--) {
            const call = this.messages[i]!.toolCalls.find((x) => x.id === event.toolCallId);
            if (call) {
              call.result = event.content ?? "";
              break;
            }
          }
        }
        break;
      }
      case "MESSAGES_SNAPSHOT": {
        if (event.messages) {
          this.messages.length = 0;
          this.messages.push(...projectHistory(event.messages));
          // 快照替换了消息对象，不能再向旧 current 引用或旧参数缓存继续追加。
          this.current = undefined;
          this.args.clear();
        }
        break;
      }
    }
  }

  /** 运行结束：从聚合视图移除 streaming 标记，交给调用方刷新权威历史。 */
  settle(): void {
    for (const message of this.messages) message.streaming = false;
  }
}
