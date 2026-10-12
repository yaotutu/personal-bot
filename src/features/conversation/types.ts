/** custom entry 的类型名保持不变，继续兼容现有 pi JSONL。 */
export const TURN_ENTRY_TYPE = "personal-bot.turn";
export const RESULT_ENTRY_TYPE = "personal-bot.result";

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
  | { id: string; role: "tool"; content: string; toolCallId: string };
export type ConversationHistory = HistoryMessage[];

/** 输入只读取用户序列；客户端的 state/tools/context 从不导入 pi。 */
export type ConversationInput = {
  threadId: string;
  runId: string;
  messages: { id: string; role: string; content?: unknown }[];
};
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
