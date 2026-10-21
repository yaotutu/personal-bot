import { z } from "zod";
import { chatMessage } from "./responses.js";

/**
 * SSE 事件契约（zod v4）：AG-UI run 端点在 text/event-stream 流上发出的
 * 事件子集。以结构化 schema 定义（生成进 OpenAPI 的 x-sse-events 扩展），
 * 事件顺序约定写在 runRequestSchema 与端点文档里。工具结果 content 已由
 * 服务端脱敏/摘要，可直接展示。
 */
const base = { timestamp: z.number().optional() };

export const sseEvents = {
  RUN_STARTED: z
    .object({ ...base, spaceId: z.string(), runId: z.string() })
    .describe("一轮开始；每轮恰好一个"),
  TEXT_MESSAGE_START: z
    .object({ ...base, messageId: z.string(), role: z.string() })
    .describe("assistant 文本段开始（一轮可有多段，与工具调用交替）"),
  TEXT_MESSAGE_CONTENT: z
    .object({ ...base, messageId: z.string(), delta: z.string() })
    .describe("文本增量；按到达顺序拼接"),
  TEXT_MESSAGE_END: z.object({ ...base, messageId: z.string() }),
  TOOL_CALL_START: z
    .object({
      ...base,
      toolCallId: z.string(),
      toolCallName: z.string().describe("工具名，用于渲染卡片"),
      parentMessageId: z.string().nullable().optional(),
    })
    .describe("工具调用开始；toolCallName 是渲染依据"),
  TOOL_CALL_ARGS: z
    .object({ ...base, toolCallId: z.string(), delta: z.string() })
    .describe("参数 JSON 增量；拼接后 parse 得到完整参数"),
  TOOL_CALL_END: z.object({ ...base, toolCallId: z.string() }),
  TOOL_CALL_RESULT: z
    .object({
      ...base,
      messageId: z.string().describe("固定为 tool-<toolCallId>，与历史投影一致"),
      toolCallId: z.string(),
      content: z.string().describe("已脱敏/摘要的结果文本，可直接展示"),
      role: z.literal("tool"),
    })
    .describe("工具执行结果"),
  RUN_FINISHED: z
    .object({ ...base, spaceId: z.string(), runId: z.string() })
    .describe("正常终态"),
  RUN_ERROR: z
    .object({ ...base, code: z.string(), message: z.string() })
    .describe("失败终态；message 为受控文案（不含供应商细节）"),
  MESSAGES_SNAPSHOT: z
    .object({ ...base, messages: z.array(chatMessage) })
    .describe("幂等重放时的全量快照（同 runId 重试成功路径）"),
} as const;

export const SSE_EVENT_ORDER = [
  "RUN_STARTED",
  "TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT* / TEXT_MESSAGE_END（可多段，与工具交替）",
  "TOOL_CALL_START / TOOL_CALL_ARGS* / TOOL_CALL_END / TOOL_CALL_RESULT（可多组）",
  "RUN_FINISHED 或 RUN_ERROR（二选一收尾）",
].join(" → ");

/** 类型与运行时校验由同一套事件 schema 派生；事件名进入联合类型用于分支收窄。 */
export const sseEventSchema = z.discriminatedUnion("type", [
  sseEvents.RUN_STARTED.extend({ type: z.literal("RUN_STARTED") }),
  sseEvents.TEXT_MESSAGE_START.extend({ type: z.literal("TEXT_MESSAGE_START") }),
  sseEvents.TEXT_MESSAGE_CONTENT.extend({ type: z.literal("TEXT_MESSAGE_CONTENT") }),
  sseEvents.TEXT_MESSAGE_END.extend({ type: z.literal("TEXT_MESSAGE_END") }),
  sseEvents.TOOL_CALL_START.extend({ type: z.literal("TOOL_CALL_START") }),
  sseEvents.TOOL_CALL_ARGS.extend({ type: z.literal("TOOL_CALL_ARGS") }),
  sseEvents.TOOL_CALL_END.extend({ type: z.literal("TOOL_CALL_END") }),
  sseEvents.TOOL_CALL_RESULT.extend({ type: z.literal("TOOL_CALL_RESULT") }),
  sseEvents.RUN_FINISHED.extend({ type: z.literal("RUN_FINISHED") }),
  sseEvents.RUN_ERROR.extend({ type: z.literal("RUN_ERROR") }),
  sseEvents.MESSAGES_SNAPSHOT.extend({ type: z.literal("MESSAGES_SNAPSHOT") }),
]);
export type SseEvent = z.infer<typeof sseEventSchema>;
