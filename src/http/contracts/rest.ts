import { z } from "zod/v3";

/**
 * REST 接口契约：路径常量 + 请求/响应 schema 的单一事实源。
 * 自研 Web（web/）从这里 import 类型实现编译期对齐；服务端路由也从这里取
 * 校验 schema，避免契约散落在各路由文件里各自漂移。
 * 兼容 OpenMuse 的历史端点（workspace/conversation PUT 等）不在此定义新形状，
 * 它们只服务过渡期，自研 Web 不消费。
 */

// ---------------------------------------------------------------------------
// 路径常量
// ---------------------------------------------------------------------------
export const paths = {
  health: "/api/health",
  session: "/api/session",
  conversation: "/api/conversation",
  agent: "/api/agent",
  threads: "/api/threads",
  agentTask: (id: string) => `/api/agent/tasks/${id}`,
  agentTaskControl: (id: string) => `/api/agent/tasks/${id}/control`,
  memories: "/api/agent/memories",
  memory: (id: string) => `/api/agent/memories/${id}`,
  memoryForget: (id: string) => `/api/agent/memories/${id}/forget`,
  identity: "/api/agent/identity",
  profile: "/api/profile",
  /** AG-UI 事件流入口（POST，SSE 响应）；threadId 见 validateThreadId。 */
  run: "/api/copilotkit/agent/default/run",
  stop: (threadId: string) => `/api/copilotkit/agent/default/stop/${threadId}`,
} as const;

// ---------------------------------------------------------------------------
// 会话与基础
// ---------------------------------------------------------------------------
export const sessionRequestSchema = z.object({
  accessKey: z.string().max(512).optional(),
});
export const sessionResponseSchema = z.object({
  token: z.string(),
  mode: z.literal("live"),
});
// 单 owner 多会话：threadId 是客户端自选的稳定标识（如 main / trip-2026）。
// 校验规则单一事实源在会话 feature（纯函数），契约层包装为 zod schema 供 Web 校验。
import { isThreadId } from "../../features/conversation/validate-input.js";
export const threadIdSchema = z.string().refine(isThreadId, {
  message: "threadId: letters, digits, _ or - (max 64)",
});
export type ThreadId = string;

// ---------------------------------------------------------------------------
// 记忆与身份
// ---------------------------------------------------------------------------
export const memoryItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

export const createMemorySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  source: z.string().max(200).optional(),
});
export const editMemorySchema = z.object({
  text: z.string().trim().min(1).max(2000),
});
export const identitySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  tone: z.enum(["warm", "concise", "thoughtful"]).optional(),
  avatar: z.string().max(40).optional(),
  showChatUpdates: z.boolean().optional(),
});
export type IdentityPatch = z.infer<typeof identitySchema>;

// ---------------------------------------------------------------------------
// 任务（定时任务投影）
// ---------------------------------------------------------------------------
export const taskControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry"]),
});
export type TaskControlAction = z.infer<typeof taskControlSchema>;

// ---------------------------------------------------------------------------
// SOUL / USER 自由文本（下一轮对话注入生效；空串等于清空）
// ---------------------------------------------------------------------------
export const saveProfileSchema = z.object({
  soul: z.string().max(20000).optional(),
  user: z.string().max(20000).optional(),
});
export type ProfileState = { soul: string; user: string };
