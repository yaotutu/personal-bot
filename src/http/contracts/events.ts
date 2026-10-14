import {
  EventType,
  MessagesSnapshotEventSchema,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
  type BaseEvent,
} from "@ag-ui/core";
import { z } from "zod/v3";

/**
 * SSE 事件契约：服务端在 run 端点的 SSE 流上发出的 AG-UI 事件子集。
 * 协议形状沿用 AG-UI（已验证、生态兼容），但这层是服务端内部实现细节的
 * 边界声明——自研 Web 只依赖本文件列出的子集，未列出的类型不承诺。
 */

/** 本服务端会发出的全部事件类型；Web 端按此枚举做穷尽处理。 */
export const supportedEventTypes = [
  EventType.RUN_STARTED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_RESULT,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.MESSAGES_SNAPSHOT,
] as const;
export type SupportedEventType = (typeof supportedEventTypes)[number];

/** 事件 schema 子集（与 supportedEventTypes 一一对应），供 Web 端做运行时校验。 */
export const eventSchemas = {
  RUN_STARTED: RunStartedEventSchema,
  TEXT_MESSAGE_START: TextMessageStartEventSchema,
  TEXT_MESSAGE_CONTENT: TextMessageContentEventSchema,
  TEXT_MESSAGE_END: TextMessageEndEventSchema,
  TOOL_CALL_START: ToolCallStartEventSchema,
  TOOL_CALL_ARGS: ToolCallArgsEventSchema,
  TOOL_CALL_END: ToolCallEndEventSchema,
  TOOL_CALL_RESULT: ToolCallResultEventSchema,
  RUN_FINISHED: RunFinishedEventSchema,
  RUN_ERROR: RunErrorEventSchema,
  MESSAGES_SNAPSHOT: MessagesSnapshotEventSchema,
} as const;

/**
 * 事件发生顺序约定（客户端渲染依赖）：
 * RUN_STARTED → (TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT* → TEXT_MESSAGE_END)?
 *            →  (TOOL_CALL_START → TOOL_CALL_ARGS* → TOOL_CALL_END → TOOL_CALL_RESULT)*
 *            → RUN_FINISHED | RUN_ERROR
 * 文本段与工具调用可交替多轮；一次 run 恰好一个 RUN_STARTED 与一个终态事件。
 * 工具结果 content 已由服务端脱敏/摘要（见 tool-presentation），可直接展示。
 */
export const sseEventSchema: z.ZodType<BaseEvent> = z
  .object({ type: z.enum(supportedEventTypes) })
  .passthrough();
