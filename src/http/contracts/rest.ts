import { z } from "zod";
import { isThreadId } from "../../features/conversation/validate-input.js";

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
// 来源会话会被用于通知投递，必须复用会话域的目录安全校验；未指定来源时投递主会话。
const originThreadIdSchema = z.string().refine(isThreadId, "Invalid originThreadId")
  .optional().describe("通知来源会话：字母数字开头，可含 _ -，最长 64；缺省主会话");

export const taskControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry"]).describe("控制动作"),
  target: z
    .enum(["job", "task"])
    .describe("分发目标：job=定时任务，task=异步后台任务，必须显式指定。"),
}).refine(
  // 后台任务没有暂停/恢复语义；在路由分发前拒绝，避免将未支持的动作映射成取消。
  ({ target, action }) => target !== "task" || action === "cancel" || action === "retry",
  { path: ["action"], message: "Background tasks only support cancel or retry" },
);
export const createTaskSchema = z.object({
  prompt: z.string().trim().min(1).max(12000).describe("后台执行的完整自包含指令（独立会话中运行，工具可用）"),
  title: z.string().trim().min(1).max(160).optional().describe("展示标题，默认截取 prompt"),
  originThreadId: originThreadIdSchema,
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
  originThreadId: originThreadIdSchema,
});

// ---------------------------------------------------------------------------
// 审批：写操作的人工闸门（决定只能由人发出）
// ---------------------------------------------------------------------------
export const actionDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]).describe("approve 放行挂起中的写操作；deny 返回受控拒绝给模型"),
});

// ---------------------------------------------------------------------------
// 会话登录与增量聊天请求（Hono 直接使用同一契约校验）
// ---------------------------------------------------------------------------
export const sessionRequestSchema = z.object({
  accessKey: z.string().max(512).optional().describe("服务端配置了访问密钥时必填；回环默认部署可不填"),
});
const threadIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const runRequestSchema = z.strictObject({
  threadId: threadIdSchema.describe("会话标识；首次出现即创建独立会话"),
  runId: z.string().min(1).max(200).describe("本轮唯一 ID；同一成功请求可幂等重放"),
  expectedRevision: z.string().min(1).max(200).describe("GET /api/conversation 返回的版本；新空会话为 empty，冲突返回 409"),
  message: z.strictObject({
    id: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(32000).refine((value) => !!value.trim(), "Message cannot be blank"),
  }).describe("唯一的新用户消息；失败重试使用原消息 ID 和内容"),
}).describe("增量聊天请求，响应为 AG-UI SSE；客户端不回传历史");
export const stopRequestSchema = z.strictObject({
  threadId: threadIdSchema,
  runId: z.string().min(1).max(200).describe("只停止该 run；迟到请求不会影响后续运行"),
});
export type RunRequestDto = z.infer<typeof runRequestSchema>;
