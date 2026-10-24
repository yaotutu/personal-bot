import { z } from "zod";
import { isSpaceId } from "../../features/conversation/space-id.js";

/**
 * REST 请求校验契约（zod v4）：路由实际使用的请求 schema 集中地，同时作为
 * OpenAPI 文档自动生成的输入（z.toJSONSchema）。schema 上的 .describe() 会
 * 直接进入生成的文档——写 schema 就是在写文档，禁止手写 OpenAPI 文件。
 * 响应形状见 responses.ts；SSE 事件见 sse-events.ts。
 */

// ---------------------------------------------------------------------------
// 记忆与身份
// ---------------------------------------------------------------------------
export const memoriesQuerySchema = z.strictObject({
  q: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("按关键词子串检索（忽略大小写）；省略时返回全部记忆"),
  limit: z
    .preprocess(
      (value) => (typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number.parseInt(value, 10) : value),
      z.number().int().min(1).max(10),
    )
    .optional()
    .describe("传入 q 时的最大返回条数（1–10，默认 10）"),
  sort: z.enum(["updatedAt", "createdAt"]).optional().describe("排序字段，默认 updatedAt"),
  order: z.enum(["asc", "desc"]).optional().describe("排序方向，默认 desc"),
});
export const createMemorySchema = z.object({
  text: z.string().trim().min(1).max(2000).describe("要记住的事实，用户语言，简明"),
  source: z.string().max(200).optional().describe("来源标记，默认 Apps UI"),
});
export const updateMemorySchema = z.object({
  text: z.string().trim().min(1).max(2000).describe("修改后的记忆文本"),
});
export const editMemorySchema = updateMemorySchema;
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
// 定时任务（Jobs）：查询、控制、更新与过滤
// ---------------------------------------------------------------------------
// 来源空间会被用于通知投递，必须复用空间域的目录安全校验；未指定来源时投递主空间。
const originSpaceIdSchema = z.string().refine(isSpaceId, "Invalid originSpaceId")
  .optional().describe("接收结果通知的来源空间：字母数字开头，可含 _ -，最长 64；创建时省略默认 local-main，PATCH 修改时省略保留原绑定。显式指定新 ID 在接纳前先建立空间；删除进行中返回 409 SPACE_DELETING，客户端刷新空间列表后由用户重新选择，不自动重试旧 ID。删除来源空间将级联清理名下任务；来源不存在或删除后绝不改投主空间，目录不复活。");

export const jobsQuerySchema = z.strictObject({
  spaceId: z.string().refine(isSpaceId, "Invalid spaceId").optional().describe("按归属空间过滤；省略表示不按空间过滤"),
  sort: z.enum(["nextRunAt", "updatedAt", "createdAt"]).default("nextRunAt").describe("排序字段，默认 nextRunAt"),
  order: z.enum(["asc", "desc"]).optional().describe("排序方向：按 nextRunAt 默认 asc，按 updatedAt/createdAt 默认 desc"),
});

export const jobControlSchema = z.strictObject({
  action: z.enum(["pause", "resume", "cancel", "retry"]).describe("控制动作：pause=暂停调度，resume=恢复调度，cancel=取消任务，retry=失败任务立即重试"),
});

export const updateJobSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(2000).optional().describe("修改后的提醒/任务内容"),
  daily: z.boolean().optional().describe("是否每天重复"),
  // at 刻意不做 min(1)：空字符串也交给领域排期校验，与其它非法值一样返回
  // 400 INVALID_SCHEDULE_FORMAT，而不是请求结构错误 INVALID_REQUEST。
  at: z.string().trim().max(64).optional().describe("设定时刻：daily=true 时为严格两位 'HH:mm'（00:00 至 23:59，前导零必填，如 '09:00'），按服务端本地时区解释，前端无需转换；daily=false 时为带时区偏移的 ISO 8601 时间戳（如 '2026-10-22T09:00:00+08:00'）。非法日程返回 400 INVALID_SCHEDULE_FORMAT，不自动进位、不写入"),
  originSpaceId: originSpaceIdSchema,
});

// ---------------------------------------------------------------------------
// 长期目标（Goals）：列表过滤、创建、修改与状态迁移
// ---------------------------------------------------------------------------
export const goalsQuerySchema = z.strictObject({
  status: z.enum(["active", "paused", "completed", "archived"]).optional().describe("按状态过滤"),
  category: z.string().trim().min(1).max(40).optional().describe("按分类过滤"),
  sort: z.enum(["updatedAt", "createdAt"]).optional().describe("排序字段，默认 updatedAt"),
  order: z.enum(["asc", "desc"]).optional().describe("排序方向，默认 desc"),
});
export const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(160).describe("目标标题"),
  description: z.string().max(2000).optional(),
  category: z.string().max(40).optional().describe("分类如 fitness/study，默认 general"),
  milestones: z.array(z.string().trim().min(1).max(160)).max(30).optional().describe("里程碑标题列表"),
});
export const updateGoalSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(40).optional(),
  status: z.enum(["active", "paused", "completed", "archived"]).optional().describe(
    "completed 会自动勾掉全部里程碑；重新激活不回退勾选记录",
  ),
});
export const editGoalSchema = updateGoalSchema;
export const goalStatusSchema = z.object({
  status: z.enum(["active", "paused", "completed", "archived"]).describe(
    "completed 会自动勾掉全部里程碑；重新激活不回退勾选记录",
  ),
});

// ---------------------------------------------------------------------------
// 监控：网页周期监控（change=指纹变化，contains=关键词命中）
// ---------------------------------------------------------------------------
export const monitorsQuerySchema = z.strictObject({
  spaceId: z.string().refine(isSpaceId, "Invalid spaceId").optional().describe("按归属空间过滤；省略表示不按空间过滤"),
  sort: z.enum(["createdAt", "lastCheckedAt", "status"]).optional().describe("排序字段，默认 createdAt"),
  order: z.enum(["asc", "desc"]).optional().describe("排序方向，默认 desc"),
});

export const monitorControlSchema = z.strictObject({
  action: z.enum(["pause", "resume", "stop"]).describe("stop 为终态"),
});

export const createMonitorSchema = z.strictObject({
  url: z.url().max(2048).regex(/^https?:\/\//, "http(s) only").describe("要监控的公网网页地址"),
  condition: z.enum(["change", "contains"]).describe(
    "change=内容指纹变化时通知（首检只建基线不通知）；contains=关键词从未命中到命中时通知（持续命中不重复）",
  ),
  value: z.string().max(200).optional().describe("contains 条件的关键词"),
  title: z.string().trim().min(1).max(120).optional().describe("展示标题，默认用 URL"),
  intervalMinutes: z.number().int().min(5).max(1440).optional().describe("检查间隔（分钟），默认 30，最小 5"),
  originSpaceId: originSpaceIdSchema,
});

export const updateMonitorSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional().describe("展示标题"),
  url: z.url().max(2048).regex(/^https?:\/\//, "http(s) only").optional().describe("要监控的公网网页地址"),
  condition: z.enum(["change", "contains"]).optional().describe(
    "change=内容指纹变化时通知（首检只建基线不通知）；contains=关键词从未命中到命中时通知（持续命中不重复）",
  ),
  value: z.string().max(200).optional().describe("contains 条件的关键词"),
  intervalMinutes: z.number().int().min(5).max(1440).optional().describe("检查间隔（分钟），最小 5"),
  originSpaceId: originSpaceIdSchema,
});

// ---------------------------------------------------------------------------
// 审批：写操作的人工闸门（决定只能由人发出）
// ---------------------------------------------------------------------------
// 决定请求 schema 已迁移到 contracts/approvals.ts 的 approvalDecisionRequest；
// 此处不再保留旧 actionDecisionSchema，避免出现第二份可漂移的请求契约。

// ---------------------------------------------------------------------------
// 会话登录与增量聊天请求（Hono 直接使用同一契约校验）
// ---------------------------------------------------------------------------
export const sessionRequestSchema = z.object({
  accessKey: z.string().max(512).optional().describe("服务端配置了访问密钥时必填；回环默认部署可不填"),
});
const spaceIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const resetSpaceSchema = z.object({
  clearSchedules: z.boolean().optional().describe("是否同时清理该空间绑定的定时任务与监控；默认 false 保留并转绑新会话"),
});
export type ResetSpaceRequestDto = z.infer<typeof resetSpaceSchema>;
const attachmentIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
const attachmentNameSchema = z.string().min(1).max(200).refine(
  (value) => !value.includes("/") && !value.includes("\\") && !/[\u0000-\u001f\u007f]/.test(value),
  "Attachment name must not contain control characters, slash, or backslash",
);
const attachmentMimeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "image/svg+xml",
  "application/json",
  "application/xml",
  "text/xml",
  "application/yaml",
  "text/yaml",
  "application/javascript",
  "text/javascript",
  "text/typescript",
  "application/sql",
  "text/css",
  "application/octet-stream",
]);
/** 大附件不能使用嵌套量词 regex：11MB 级输入会触发 regex 栈溢出。 */
const hasStandardBase64Shape = (value: string): boolean => {
  if (!value.length || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    const isUppercase = code >= 65 && code <= 90;
    const isLowercase = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isUppercase && !isLowercase && !isDigit && value[index] !== "+" && value[index] !== "/")
      return false;
  }
  return true;
};
const attachmentBase64Schema = z.string().min(1).refine(
  hasStandardBase64Shape,
  "dataBase64 must be standard Base64 with valid padding and no whitespace",
);
export const messageAttachmentSchema = z.strictObject({
  id: attachmentIdSchema.describe("客户端生成的附件稳定 ID；仅允许 ASCII 字母/数字/./-/_，不用于磁盘路径"),
  name: attachmentNameSchema.describe("用户可见原始文件名；纯展示，不用作路径，允许 Unicode"),
  mimeType: attachmentMimeSchema.describe("显式 MIME。application/octet-stream 只能依赖已知文本扩展名识别；PDF/Office/压缩包等二进制拒绝"),
  dataBase64: attachmentBase64Schema.describe("标准 Base64 字符集与 padding；服务端继续校验 canonical 编码、实际字节数、UTF-8 或图片魔数"),
});
export const runRequestSchema = z.strictObject({
  spaceId: spaceIdSchema.default("local-main").describe("空间标识；缺省为 local-main"),
  runId: z.string().min(1).max(200).describe("本轮唯一 ID；同一成功请求可幂等重放"),
  expectedRevision: z.string().min(1).max(200).describe("GET /api/conversation 返回的版本；新空会话为 empty，冲突返回 409"),
  message: z.strictObject({
    id: z.string().trim().min(1).max(200),
    content: z.string().max(32000).describe("用户输入文本；可为空串，但无文本且无附件时拒绝"),
    attachments: z.array(messageAttachmentSchema).max(4).optional().describe("随这条消息显式提交的有序附件，最多 4 项；不提供独立上传"),
  }).describe("唯一的新用户消息；失败重试使用原消息 ID、内容与附件身份"),
}).describe("增量聊天请求，响应为 AG-UI SSE；客户端不回传历史");
export const stopRequestSchema = z.strictObject({
  spaceId: spaceIdSchema.default("local-main").describe("空间标识；缺省为 local-main"),
  runId: z.string().min(1).max(200).describe("只停止该 run；迟到请求不会影响后续运行"),
});

// ---------------------------------------------------------------------------
// 技能：会话级开关覆盖
// ---------------------------------------------------------------------------
export const updateSkillsSchema = z.object({
  overrides: z.record(z.string(), z.boolean()).describe("技能开关覆盖表，整份替换；未知技能名返回 400"),
});

// 会话专属规则/指令：下一轮对话注入生效；空串等于清空。
export const saveInstructionsSchema = z.object({
  instructions: z.string().max(20000).describe("空间专属规则/提示词自由文本；空串等于清空"),
  purpose: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "可选空间用途；传入时自动在 INSTRUCTIONS.md 开头生成 `## 空间用途` 段落，供 Dream 后台整理判定本空间专属规则归属",
    ),
});

// ---------------------------------------------------------------------------
// Dream 后台记忆整理
// ---------------------------------------------------------------------------
export const dreamTargetSchema = z
  .enum(["user", "soul", "instructions", "memory"])
  .describe(
    "笔记归属目标：user=全局 USER.md，soul=全局 SOUL.md，instructions=本空间 INSTRUCTIONS.md，memory=按需检索的 memory.json",
  );
export const saveGlobalDreamSchema = z.object({
  globalPrompt: z
    .string()
    .max(20000)
    .describe("全局 Dream 整理提示词（profile/DREAM.md）；传空串清空覆盖，回退为内置默认提示词"),
});
export const updateSpaceDreamSchema = z.object({
  enabled: z
    .boolean()
    .optional()
    .describe("是否开启该空间的每 2 小时周期后台整理；local-main 默认开启，其余空间默认关闭"),
  inheritGlobalPrompt: z
    .boolean()
    .optional()
    .describe(
      "true=全局提示词与空间补充叠加；false=仅使用本空间补充提示词（服务端固定安全规则始终生效）",
    ),
  prompt: z
    .string()
    .max(20000)
    .optional()
    .describe("本空间的 Dream 补充提示词（sessions/<spaceId>/DREAM.md）；传空串清空"),
});
export const resolveDreamPendingSchema = z.object({
  action: z
    .enum(["apply", "dismiss"])
    .describe("apply=按选定归属写入对应存储并移除待决项；dismiss=丢弃该建议不写入"),
  target: dreamTargetSchema
    .optional()
    .describe("apply 时可选改选归属；省略时采用 suggestedTarget"),
});
export type RunRequestDto = z.infer<typeof runRequestSchema>;
