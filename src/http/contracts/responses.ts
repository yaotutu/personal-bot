import { z } from "zod";

/**
 * 响应契约（zod v4）：每个端点 200 响应的形状，全部从现有路由投影提炼。
 * 用途：1) OpenAPI 文档自动生成（io=output）；2) 契约测试对真实响应做
 * safeParse 防漂移（实现改了文档没跟，测试红）。schema 即文档。
 */

// 基础形状 -------------------------------------------------------------
export const serviceVersionSchema = z.object({
  version: z.string().describe("服务包版本；不单独用作部署提交标识"),
  commit: z.string().nullable().describe("启动/构建时的完整 Git commit；无法取得时为 null"),
  dirty: z.boolean().nullable().describe("启动/构建时有未提交改动为 true；无法核验 Git 状态为 null，不能把 commit 当作精确产物"),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).describe("SHA-256 源码指纹：src/assets/scripts、包/锁文件及 TS 配置的有序路径与字节；不含实例数据。dirty=true 时应以此核验实际代码"),
  mode: z.enum(["source", "build"]).describe("source=源码进程启动快照，build=构建时固定快照；均不随每次请求重新读取仓库"),
  builtAt: z.string().nullable().describe("build 的构建时间（ISO 8601）；source 为 null"),
}).describe("运行服务的不可变版本快照；与 OpenAPI x-service-version 和 /docs 展示一致");
export const healthResponse = z.object({
  ok: z.literal(true),
  backend: z.literal("pi"),
  configured: z.boolean().describe("模型是否已配置（决定聊天能否运行）"),
  serviceVersion: serviceVersionSchema,
});
export const sessionResponse = z.object({
  token: z.string().describe(
    "Bearer token，后续所有 /api/* 请求放 Authorization 头。长期有效：服务重启仍可用，仅当 config.json 的 accessKey 变更/清除后旧 token 才会被拒绝。",
  ),
  mode: z.literal("live"),
});
export const okResponse = z.object({ ok: z.literal(true) });
export const errorResponse = z.object({
  error: z.string().describe("人类可读错误；敏感细节（密钥/供应商响应）一律不透出"),
});

// 会话 -----------------------------------------------------------------
export const threadSnapshot = z.object({
  id: z.string().describe("threadId"),
  updatedAt: z.string().describe("该会话 JSONL 最近修改时间（ISO 8601）"),
});
export const threadsResponse = z.object({
  threads: z.array(threadSnapshot).describe("按最近活跃倒序"),
});
export const deleteThreadResponse = z.object({
  ok: z.literal(true),
  removed: z.object({
    jobs: z.number().int().nonnegative().describe("级联删除的定时任务数"),
    monitors: z.number().int().nonnegative().describe("级联删除的网页监控数"),
  }),
});
export type DeleteThreadDto = z.infer<typeof deleteThreadResponse>;
export const chatMessage = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().optional().describe("文本内容；assistant 消息可为空（纯工具轮）"),
  toolCalls: z
    .array(
      z.object({
        id: z.string().describe("工具调用 ID，与 role=tool 消息的 toolCallId 对应"),
        type: z.literal("function"),
        function: z.object({
          name: z.string().describe("工具名（read/write/schedule/...）"),
          arguments: z.string().describe("JSON 字符串形式的调用参数"),
        }),
      }),
    )
    .optional(),
  toolCallId: z.string().optional().describe("role=tool 时对应的调用 ID"),
});
export const conversationResponse = z.object({
  revision: z.string().describe("pi 当前叶子版本；空会话为 empty，发送时作为 expectedRevision"),
  messages: z.array(chatMessage).describe("服务端权威历史（含工具投影）；客户端不得回写"),
});
export const profileResponse = z.object({
  soul: z.string().describe("SOUL.md 内容；空串表示未设置"),
  user: z.string().describe("USER.md 内容；空串表示未设置"),
});
export const instructionsResponse = z.object({
  instructions: z.string().describe("该会话当前生效的专属指令文本（INSTRUCTIONS.md）"),
});
export type InstructionsDto = z.infer<typeof instructionsResponse>;

// 工作区快照 -----------------------------------------------------------
export const taskView = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  // 工作台任务仅剩定时任务（job）；保留字段与描点兼容未来扩展但当前只输出 job。
  kind: z.enum(["job"]).describe("job=定时任务；后台任务 API 已下线"),
  // 状态枚举未顺手收紧 queued/running，避免连带改动定时 job 的现有语义（如 retry_pending）。
  status: z.enum(["queued", "running", "scheduled", "paused", "succeeded", "failed", "cancelled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().optional().describe("定时任务下次触发时间"),
  result: z.string().optional().describe("最近一次执行的输出文本（截断存储）"),
  error: z.string().nullable(),
});
export const runEvent = z.object({
  id: z.string(),
  taskId: z.string(),
  date: z.string(),
  kind: z.enum(["plan", "step", "observation", "approval", "result", "error", "status"]),
  title: z.string(),
  detail: z.string(),
});
// 详情路由返回包装对象而不是扁平 TaskView；两个任务来源共用这一契约。
export const taskDetail = z.object({
  task: taskView,
  events: z.array(runEvent).describe("最近一次运行与控制操作的时间线"),

});
export const goalView = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  status: z.enum(["active", "paused", "completed", "archived"]),
  milestones: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      done: z.boolean(),
      doneAt: z.string().optional(),
    }),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const monitorView = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  condition: z.enum(["change", "contains"]),
  value: z.string().optional(),
  intervalMinutes: z.number(),
  status: z.enum(["active", "paused", "stopped"]),
  createdAt: z.string(),
  originThreadId: z.string().optional().describe("接收监控通知的来源会话；未指定时投递主会话"),
  lastCheckedAt: z.string().optional(),
  lastFingerprint: z.string().optional().describe("change 条件的内容指纹（内部）"),
  lastMatched: z.boolean().optional().describe("contains 条件上次是否命中"),
  lastNotifiedAt: z.string().optional(),
  checks: z.number().describe("累计检查次数"),
  error: z.string().optional().describe("上次抓取失败标记"),
});
export const memoryItem = z.object({
  id: z.string(),
  text: z.string(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const identityView = z.object({
  name: z.string(),
  tone: z.string(),
  avatar: z.string().optional(),
  showChatUpdates: z.boolean().optional(),
});
export const agentSnapshot = z.object({
  tasks: z.array(taskView).describe("定时任务列表（按更新时间倒序）"),
  goals: z.array(goalView),
  monitors: z.array(monitorView),
  memories: z.array(memoryItem),
  identity: identityView,
});

/** 响应 schema 是服务端与自有 Web 共享 DTO 的唯一事实源。 */
export type TaskDto = z.infer<typeof taskView>;
export type TaskDetailDto = z.infer<typeof taskDetail>;
export type RunEventDto = z.infer<typeof runEvent>;
export type MemoryDto = z.infer<typeof memoryItem>;
export type GoalDto = z.infer<typeof goalView>;
export type MonitorDto = z.infer<typeof monitorView>;
export type AgentSnapshotDto = z.infer<typeof agentSnapshot>;
export type ThreadDto = z.infer<typeof threadSnapshot>;

// 技能 -----------------------------------------------------------------
export const skillItem = z.object({
  name: z.string().describe("技能名称（目录名）"),
  description: z.string().describe("技能描述"),
  defaultEnabled: z.boolean().describe("技能默认开关状态"),
  enabled: z.boolean().describe("当前会话的生效开关状态"),
});
export const skillsResponse = z.object({
  skills: z.array(skillItem),
  diagnostics: z.array(z.object({
    path: z.string().describe("诊断逻辑路径 builtin/<技能>/... 或 user/<技能>/...；不包含服务端绝对路径"),
    message: z.string(),
  })).optional().describe("技能加载诊断信息"),
});
export type SkillDto = z.infer<typeof skillItem>;

export type ChatMessageDto = z.infer<typeof chatMessage>;
export type ConversationSnapshotDto = z.infer<typeof conversationResponse>;
