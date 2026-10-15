import type { ConversationInput, ConversationRecords, HistoryMessage } from "./types.js";
import { rejectConversation } from "./errors.js";

/**
 * threadId：单 owner 多会话的稳定标识（如 main / trip-2026）。
 * 字符集限制保证可直接作为目录名；契约层（src/http/contracts）复用此函数校验来源会话。
 * 纯函数校验，不引入 schema 库（features 层只依赖 features/shared 与原生能力）。
 */
const THREAD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const isThreadId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 64 &&
  THREAD_ID_PATTERN.test(value);

/**
 * 幂等身份先于版本判断：同一成功 run 的原请求可在刷新/重启后重放，不能重做工具。
 * 其他请求必须匹配 pi 当前叶子版本；失败轮可使用相同 message ID 显式重试，
 * 但只能替换最后一条用户消息，且内容必须相同，防止把历史编辑混入发送接口。
 */
export const validateConversationInput = (
  input: ConversationInput,
  history: readonly HistoryMessage[],
  records: ConversationRecords,
  revision: string,
) => {
  if (!isThreadId(input.threadId)) rejectConversation("UNSUPPORTED_THREAD", "Invalid threadId");
  if (!input.runId || input.runId.length > 200 ||
      typeof input.expectedRevision !== "string" || !input.expectedRevision ||
      !input.message || typeof input.message.id !== "string" || !input.message.id.trim() || input.message.id.length > 200 ||
      typeof input.message.content !== "string" || !input.message.content.trim() || input.message.content.length > 32_000)
    rejectConversation("INVALID_INPUT", "Send one non-empty text message (maximum 32000 characters)");
  const user = { ...input.message, role: "user" as const };
  const { turns, results } = records;
  const sameRun = turns.find((turn) => turn.runId === input.runId);
  if (sameRun && (sameRun.userId !== user.id || sameRun.text !== user.content))
    rejectConversation("RUN_ID_CONFLICT", "Run ID was already used for another message");
  if (sameRun && results.get(sameRun.runId)?.status === "completed")
    return { user, previous: sameRun, replay: true };
  if (input.expectedRevision !== revision)
    rejectConversation("HISTORY_CONFLICT", "Conversation changed; reload history before sending");
  const users = history.filter((message) => message.role === "user");
  const existing = users.find((message) => message.id === user.id);
  if (existing && (existing !== users.at(-1) || existing.content !== user.content))
    rejectConversation("MESSAGE_ID_CONFLICT", "Message ID was already used for another message");
  const previous = existing ? turns.findLast((turn) => turn.userId === user.id) : undefined;
  if (existing && (!previous || results.get(previous.runId)?.status === "completed"))
    rejectConversation("MESSAGE_ID_CONFLICT", "Only the last unsuccessful message can be retried");
  return { user, previous, replay: false };
};
