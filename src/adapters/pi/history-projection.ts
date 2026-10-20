import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  RESULT_ENTRY_TYPE,
  TURN_ENTRY_TYPE,
  type ConversationHistory,
  type HistoryMessage,
  type ConversationRecords,
  type ConversationResult,
  type ConversationTurn,
} from "../../features/conversation/types.js";
import type { DreamMessage } from "../../features/dream/types.js";
import { notificationIdOf } from "./notification-message.js";

/** 从 pi 的文本/内容块中提取可展示文本；非文本内容保持不可见。 */
export const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter(
            (x): x is { type: "text"; text: string } =>
              x?.type === "text" && typeof x.text === "string",
          )
          .map((x) => x.text)
          .join("")
      : "";

/**
 * 从 append-only entry 中读取会话控制记录。
 * custom entry 只是审计和 UI 元数据，不参与模型上下文。
 */
export const collectConversationRecords = (
  branch: readonly SessionEntry[],
): ConversationRecords => {
  const turns: ConversationTurn[] = [];
  const results = new Map<string, ConversationResult>();
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === TURN_ENTRY_TYPE)
      turns.push(entry.data as ConversationTurn);
    if (entry.customType === RESULT_ENTRY_TYPE) {
      const result = entry.data as ConversationResult;
      results.set(result.runId, result);
    }
  }
  return { turns, results };
};

const toolCallsOf = (
  message: Extract<SessionMessageEntry["message"], { role: "assistant" }>,
) =>
  (Array.isArray(message.content) ? message.content : []).flatMap((x) => {
    const block = x as
      | { type: string; id?: unknown; name?: unknown; arguments?: unknown }
      | undefined;
    return block?.type === "toolCall" && typeof block.id === "string"
      ? [
          {
            id: block.id,
            type: "function" as const,
            function: {
              name: String(block.name ?? ""),
              arguments: JSON.stringify(block.arguments ?? {}),
            },
          },
        ]
      : [];
  });

/**
 * 将 pi 当前分支投影为客户端历史。
 *
 * 这里保留原有稳定 ID、工具调用关联和 context edit 语义：
 * - 被 context edit 删除的 message 不出现在展示历史；
 * - 同一轮多个 assistant message 合并为一条；
 * - custom entry 不直接暴露给客户端。
 */
export const projectConversationHistory = (
  branch: readonly SessionEntry[],
): ConversationHistory => {
  const omitted = new Set(
    branch
      .filter((x) => x.type === "context_edit" && x.replacement === null)
      .map((x) => (x.type === "context_edit" ? x.targetId : "")),
  );
  const messages: HistoryMessage[] = [];
  let turn: ConversationTurn | undefined;
  let merged:
    | {
        id: string;
        role: "assistant";
        content: string;
        toolCalls?: NonNullable<
          Extract<HistoryMessage, { role: "assistant" }>["toolCalls"]
        >;
      }
    | undefined;

  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === TURN_ENTRY_TYPE) {
      turn = entry.data as ConversationTurn;
      merged = undefined;
    }
    if (entry.type !== "message" || omitted.has(entry.id)) continue;
    const { message } = entry;
    if (message.role === "user") {
      const content = textOf(message.content);
      if (!content) continue;
      messages.push({
        id: turn?.userId || entry.id,
        role: "user",
        content,
      });
      continue;
    }
    if (message.role === "assistant") {
      const content = textOf(message.content);
      const notificationId = notificationIdOf(message);
      if (notificationId) {
        messages.push({ id: notificationId, role: "assistant", content });
        // 通知独立于上一轮 assistant，不能合并进模型回复或沿用旧轮的 ID。
        merged = undefined;
        turn = undefined;
        continue;
      }
      const toolCalls = toolCallsOf(message);
      if (!content && !toolCalls.length) continue;
      if (merged) {
        merged.content = [merged.content, content].filter(Boolean).join("\n\n");
        merged.toolCalls = [...(merged.toolCalls || []), ...toolCalls];
      } else {
        merged = {
          id: turn?.assistantId || entry.id,
          role: "assistant",
          content,
          ...(toolCalls.length ? { toolCalls } : {}),
        };
        messages.push(merged);
      }
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({
        id: "tool-" + message.toolCallId,
        role: "tool",
        content: textOf(message.content),
        toolCallId: message.toolCallId,
        ...(message.isError ? { isError: true } : {}),
      });
    }
  }
  return messages;
};

/**
 * 提取供 Dream 后台整理轮读取的可信对话消息与最新压缩摘要：
 * - 只保留真实用户与助手文本，排除工具结果、服务端通知及失败/中断的半截回复；
 * - 尊重 context_edit，被重试替换的旧消息不再参与整理；
 * - 同一轮的多段助手输出合并为一条，ID 与展示历史一致，确保游标稳定。
 */
export const projectDreamTranscript = (
  branch: readonly SessionEntry[],
): { messages: DreamMessage[]; summary?: string } => {
  const omitted = new Set(
    branch
      .filter((x) => x.type === "context_edit" && x.replacement === null)
      .map((x) => (x.type === "context_edit" ? x.targetId : "")),
  );
  const messages: DreamMessage[] = [];
  let summary: string | undefined;
  let turn: ConversationTurn | undefined;
  let merged: DreamMessage | undefined;

  for (const entry of branch) {
    if (entry.type === "compaction" && entry.summary.trim()) {
      summary = entry.summary.trim();
      continue;
    }
    if (entry.type === "custom" && entry.customType === TURN_ENTRY_TYPE) {
      turn = entry.data as ConversationTurn;
      merged = undefined;
      continue;
    }
    if (entry.type !== "message" || omitted.has(entry.id)) continue;
    const { message } = entry;
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (!text) continue;
      messages.push({ id: turn?.userId || entry.id, role: "user", text });
      merged = undefined;
      continue;
    }
    if (message.role === "assistant") {
      if (notificationIdOf(message)) {
        merged = undefined;
        turn = undefined;
        continue;
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        continue;
      }
      const text = textOf(message.content).trim();
      if (!text) continue;
      if (merged) {
        merged.text = `${merged.text}\n\n${text}`;
      } else {
        merged = { id: turn?.assistantId || entry.id, role: "assistant", text };
        messages.push(merged);
      }
    }
  }
  return { messages, ...(summary ? { summary } : {}) };
};
