import type { ConversationInput, ConversationRecords, HistoryMessage } from "./types.js";
import { rejectConversation } from "./errors.js";

/** 仅校验用户序列；客户端伪造的模型/工具历史不进入执行上下文。 */
export const validateConversationInput = (
  input: ConversationInput,
  history: readonly HistoryMessage[],
  records: ConversationRecords,
) => {
  if (input.threadId !== "local-main")
    rejectConversation("UNSUPPORTED_THREAD", "Only local-main is supported");
  if (input.runId.length > 200 || !input.runId)
    rejectConversation("INVALID_INPUT", "Invalid run ID");
  // 客户端传来的 assistant/system/tool/context 都不导入 pi，防止历史伪造或越权。
  const users = input.messages.filter((x) => x.role === "user");
  const last = users.at(-1);
  if (
    !last ||
    typeof last.content !== "string" ||
    !last.content.trim() ||
    last.content.length > 32_000 ||
    !last.id.trim() ||
    last.id.length > 200
  )
    rejectConversation(
      "INVALID_INPUT",
      "Send one non-empty text message (maximum 32000 characters)",
    );
  if (
    users.some((x) => typeof x.content !== "string") ||
    new Set(users.map((x) => x.id)).size !== users.length
  )
    rejectConversation(
      "INVALID_INPUT",
      "User message IDs must be unique and content must be text",
    );
  const canonical = history.filter((x) => x.role === "user");
  const { turns, results } = records;
  const sameRun = turns.find((x) => x.runId === input.runId);
  if (
    sameRun &&
    (sameRun.userId !== last!.id || sameRun.text !== last!.content)
  )
    rejectConversation("RUN_ID_CONFLICT", "Run ID was already used for another message");
  // 只接受 canonical 用户历史 + 一条新消息，或最后一个用户消息的重试。
  // 不比较 assistant，因为流中断后客户端的局部文本可能与最终投影不同。
  const retry = canonical.length === users.length;
  if (
    !(users.length === canonical.length + 1 || retry) ||
    canonical.some(
      (x, i) => x.id !== users[i]?.id || x.content !== users[i]?.content,
    )
  )
    rejectConversation(
      "HISTORY_CONFLICT",
      "Conversation changed; reload history before sending",
    );
  const previous = retry
    ? turns.findLast((x) => x.userId === last!.id)
    : undefined;
  return {
    user: last!,
    previous,
    replay: previous && results.get(previous.runId)?.status === "completed",
  };
};
