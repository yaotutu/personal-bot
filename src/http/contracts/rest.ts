import { z } from "zod";

/**
 * REST 请求校验契约（zod v4）：路由实际使用的请求 schema 集中地，同时作为
 * OpenAPI 文档自动生成的输入（z.toJSONSchema）。schema 上的 .describe() 会
 * 直接进入生成的文档——写 schema 就是在写文档，禁止手写 OpenAPI 文件。
 * 响应形状见 responses.ts；SSE 事件见 sse-events.ts。
 */

// ---------------------------------------------------------------------------
// 记忆与身份
// ---------------------------------------------------------------------------
export const createMemorySchema = z.object({
  text: z.string().trim().min(1).max(2000).describe("要记住的事实，用户语言，简明"),
  source: z.string().max(200).optional().describe("来源标记，默认 Apps UI"),
});
export const editMemorySchema = z.object({
  text: z.string().trim().min(1).max(2000).describe("修改后的记忆文本"),
});
export const identitySchema = z.object({
  name: z.string().trim().min(1).max(80).optional().describe("助手名字，注入每轮对话"),
  tone: z.enum(["warm", "concise", "thoughtful"]).optional().describe("语气"),
  avatar: z.string().max(40).optional(),
  showChatUpdates: z.boolean().optional(),
});

// SOUL/USER 自由文本：下一轮对话注入生效；空串等于清空。
export const saveProfileSchema = z.object({
  soul: z.string().max(20000).optional().describe("助手人设自由文本（SOUL.md）"),
  user: z.string().max(20000).optional().describe("用户画像自由文本（USER.md）"),
});

// ---------------------------------------------------------------------------
// 任务：异步任务创建与控制（定时任务控制共用 control 端点）
// ---------------------------------------------------------------------------
export const taskControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry"]).describe("控制动作"),
  target: z
    .enum(["job", "task"])
    .optional()
    .describe("分发目标：job=定时任务（默认），task=异步后台任务。cancel/retry 两者皆可，必须显式指定 task 才作用于后台任务。"),
});
export const createTaskSchema = z.object({
  prompt: z.string().trim().min(1).max(12000).describe("后台执行的完整自包含指令（独立会话中运行，工具可用）"),
  title: z.string().trim().min(1).max(160).optional().describe("展示标题，默认截取 prompt"),
});

// ---------------------------------------------------------------------------
// 目标：CRUD、状态迁移与里程碑勾选
// ---------------------------------------------------------------------------
export const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(160).describe("目标标题"),
  description: z.string().max(2000).optional(),
  category: z.string().max(40).optional().describe("分类如 fitness/study，默认 general"),
  milestones: z.array(z.string().trim().min(1).max(160)).max(30).optional().describe("里程碑标题列表"),
});
export const editGoalSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(40).optional(),
});
export const goalStatusSchema = z.object({
  status: z.enum(["active", "paused", "completed", "archived"]).describe(
    "completed 会自动勾掉全部里程碑；重新激活不回退勾选记录",
  ),
});

// ---------------------------------------------------------------------------
// 监控：网页周期监控（change=指纹变化，contains=关键词命中）
// ---------------------------------------------------------------------------
export const monitorControlSchema = z.object({
  action: z.enum(["pause", "resume", "stop"]).describe("stop 为终态"),
});
export const createMonitorSchema = z.object({
  url: z.url().max(2048).regex(/^https?:\/\//, "http(s) only").describe("要监控的公网网页地址"),
  condition: z.enum(["change", "contains"]).describe(
    "change=内容指纹变化时通知（首检只建基线不通知）；contains=关键词从未命中到命中时通知（持续命中不重复）",
  ),
  value: z.string().max(200).optional().describe("contains 条件的关键词"),
  title: z.string().trim().min(1).max(120).optional().describe("展示标题，默认用 URL"),
  intervalMinutes: z.number().int().min(5).max(1440).optional().describe("检查间隔（分钟），默认 30，最小 5"),
});

// ---------------------------------------------------------------------------
// 审批：写操作的人工闸门（决定只能由人发出）
// ---------------------------------------------------------------------------
export const actionDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]).describe("approve 放行挂起中的写操作；deny 返回受控拒绝给模型"),
});

// ---------------------------------------------------------------------------
// 会话登录与 SSE run 请求（替换宿主预校验里对 @ag-ui/core v3 schema 的依赖）
// ---------------------------------------------------------------------------
export const sessionRequestSchema = z.object({
  accessKey: z.string().max(512).optional().describe("服务端配置了访问密钥时必填；回环默认部署可不填"),
});
export const runRequestSchema = z.looseObject({
  threadId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).describe(
    "会话标识：字母数字开头，可含 _ -，最长 64。不同 threadId 历史完全隔离；首次出现即创建",
  ),
  runId: z.string().min(1).max(200).describe("本轮唯一 ID；同 runId 重试可幂等重放"),
  messages: z.array(z.looseObject({})).max(1000).describe(
    "历史消息数组：服务端只信任 canonical 用户序列 + 最后一条新 user 消息（content 必须是 string）",
  ),
}).describe("AG-UI run 请求体：POST 后以 SSE 流返回事件（见该端点文档的 SSE 事件说明）");

// ---------------------------------------------------------------------------
// Web 端共享 DTO：与各域投影的 JSON 形状一致（Web 只做 import type）。
// ---------------------------------------------------------------------------
export type TaskDto = {
  id: string;
  title: string;
  prompt: string;
  kind: "agent" | "document" | "monitor" | "finance" | "plan";
  status: string;
  nextRunAt?: string;
  updatedAt: string;
  result?: string;
  error?: string | null;
};

export type MemoryDto = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type GoalDto = {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "active" | "paused" | "completed" | "archived";
  milestones: { id: string; title: string; done: boolean }[];
  createdAt: string;
  updatedAt: string;
};

export type MonitorDto = {
  id: string;
  title: string;
  url: string;
  condition: "change" | "contains";
  value?: string;
  intervalMinutes: number;
  status: "active" | "paused" | "stopped";
  checks: number;
  error?: string;
  lastCheckedAt?: string;
};

export type ActionDto = {
  id: string;
  kind: "file_write" | "file_edit";
  title: string;
  payload: Record<string, string>;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
};

export type AgentSnapshotDto = {
  tasks: TaskDto[];
  goals: GoalDto[];
  monitors: MonitorDto[];
  memories: MemoryDto[];
  notifications: ActionDto[];
  identity: { name: string; tone: string; avatar?: string; showChatUpdates?: boolean };
  worker: { running: boolean };
};

export type ThreadDto = { id: string; updatedAt: string };
