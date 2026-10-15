import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationNotification } from "../../features/conversation/types.js";

/**
 * 服务端生成的确定性通知，不代表模型回复，也没有 token 消耗。
 * 使用 pi 的公开 message 写入接口：只有 custom entry 的新会话不会落盘，
 * 因而不能把 custom entry 当成已持久化的投递凭据。稳定 ID 随同一条 message
 * 存入唯一的 JSONL 历史，展示与下轮模型上下文均能读到，不创建第二份通知历史。
 */
type NotificationMessage = AssistantMessage & { personalBotNotificationId: string };

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
