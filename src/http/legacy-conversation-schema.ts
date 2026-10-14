import { z } from "zod/v3";

// 请求约束属于现有 OpenMuse 契约，不把客户端字段校验混进业务 service。
export const createMemorySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  source: z.string().max(200).optional(),
});
export const editMemorySchema = z.object({ text: z.string().trim().min(1).max(2000) });
export const identitySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  tone: z.enum(["warm", "concise", "thoughtful"]).optional(),
  avatar: z.string().max(40).optional(),
  showChatUpdates: z.boolean().optional(),
});
export const conversationSchema = z.object({ messages: z.array(z.unknown()).max(1000) });
export const taskControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry"]),
});
