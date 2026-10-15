import { z } from "zod/v3";

/**
 * REST 校验契约：服务端路由实际使用的请求/响应 schema 集中地。
 * 只保留被路由引用的 schema；路径常量、会话形状等未消费的导出一律不设，
 * 避免"看起来是契约、实际没人用"的第二事实源。SSE 事件形状见 Web 端
 * api.ts 的 SseEvent（AG-UI 子集）；如需服务端运行时校验再按需补回。
 */

// ---------------------------------------------------------------------------
// 记忆与身份
// ---------------------------------------------------------------------------
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

// SOUL/USER 自由文本：下一轮对话注入生效；空串等于清空。
export const saveProfileSchema = z.object({
  soul: z.string().max(20000).optional(),
  user: z.string().max(20000).optional(),
});

// ---------------------------------------------------------------------------
// 任务：异步任务创建与控制（定时任务控制共用 control 端点）
// ---------------------------------------------------------------------------
export const taskControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry"]),
  /** 分发目标：job（定时任务，默认）或 task（异步任务）。 */
  target: z.enum(["job", "task"]).optional(),
});
export type TaskControlAction = z.infer<typeof taskControlSchema>;
export const createTaskSchema = z.object({
  prompt: z.string().trim().min(1).max(12000),
  title: z.string().trim().min(1).max(160).optional(),
});

// ---------------------------------------------------------------------------
// 目标：CRUD、状态迁移与里程碑勾选（全部 POST，与现有端点风格一致）
// ---------------------------------------------------------------------------
export const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(2000).optional(),
  category: z.string().max(40).optional(),
  milestones: z.array(z.string().trim().min(1).max(160)).max(30).optional(),
});
export const editGoalSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(40).optional(),
});
export const goalStatusSchema = z.object({
  status: z.enum(["active", "paused", "completed", "archived"]),
});
