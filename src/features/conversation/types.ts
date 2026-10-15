/** 会话控制条目与模型消息共同存放在 pi 权威历史中。 */
export const TURN_ENTRY_TYPE = "personal-bot.turn";
export const RESULT_ENTRY_TYPE = "personal-bot.result";
export type ConversationNotification = { id: string; text: string };

export type ConversationTurn = {
  userId: string;
  text: string;
  runId: string;
  assistantId: string;
};
export type ConversationResult = {
  runId: string;
  status: "completed" | "failed" | "aborted";
};
export type ConversationRecords = {
  turns: ConversationTurn[];
  results: Map<string, ConversationResult>;
};

/** 只描述本项目使用的历史字段；协议 SDK 的其他能力不进入业务层。 */
export type HistoryMessage =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      toolCalls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { id: string; role: "tool"; content: string; toolCallId: string; isError?: boolean };
export type ConversationHistory = HistoryMessage[];

/** 客户端只提交一条消息及读取时的历史版本，不能注入模型/工具历史。 */
export type ConversationInput = {
  threadId: string;
  runId: string;
  expectedRevision: string;
  message: { id: string; content: string };
};
export type ConversationSnapshot = { messages: ConversationHistory; revision: string };
export type CancelReason = "STOPPED" | "DISCONNECTED" | "TIMEOUT" | "SHUTDOWN";

/** pi adapter 清洗并归一化的事件，不复制 SDK 的完整事件/消息接口。 */
export type ExecutionEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_delta"; id: string; name: string; delta: string }
  | { type: "tool_end"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; id: string; content: string }
  | { type: "assistant_end"; reason: string | undefined; text: string };

/** 生命周期由协调器决定，文本/工具事件的协议形状由 AG-UI adapter 决定。 */
export type ConversationEvent =
  | ExecutionEvent
  | { type: "run_started"; threadId: string; runId: string; assistantId: string }
  | { type: "run_finished"; threadId: string; runId: string }
  | { type: "run_error"; code: string; message: string }
  | { type: "history_snapshot"; messages: ConversationHistory }
  | { type: "text_end"; assistantId: string };
