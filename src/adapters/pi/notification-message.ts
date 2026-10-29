import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationNotification } from "../../features/conversation/types.js";

/**
 * 服务端生成的确定性通知，不代表模型回复，也没有 token 消耗。
 * 使用 pi 的公开 message 写入接口：只有 custom entry 的新会话不会落盘，
 * 因而不能把 custom entry 当成已持久化的投递凭据。稳定 ID 随同一条 message
 * 存入唯一的 JSONL 历史，展示与下轮模型上下文均能读到，不创建第二份通知历史。
 */
type NotificationMessage = AssistantMessage & { personalBotNotificationId: string };
type InformationNotificationSource = { notificationId: string; runId: string };

const informationNotificationIdPattern =
  /^info-notification-(inforun_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(0|[1-9][0-9]*)$/;

export const createNotificationMessage = (notification: ConversationNotification): NotificationMessage => ({
  role: "assistant",
  content: [{ type: "text", text: notification.text }],
  provider: "personal-bot",
  model: "server-notification",
  api: "openai-completions",
  personalBotNotificationId: notification.id,
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

export const notificationIdOf = (message: AssistantMessage): string | undefined => {
  const id = "personalBotNotificationId" in message ? message.personalBotNotificationId : undefined;
  return message.provider === "personal-bot" && message.model === "server-notification" && typeof id === "string"
    ? id : undefined;
};

/** 只有服务端 marker 与稳定 ID 格式同时成立，才把通知识别为信息后台来源。 */
export const informationNotificationSourceOf = (message: AssistantMessage): InformationNotificationSource | undefined => {
  const notificationId = notificationIdOf(message);
  if (!notificationId) return undefined;
  const match = informationNotificationIdPattern.exec(notificationId);
  return match ? { notificationId, runId: match[1]! } : undefined;
};
