import { z } from "zod";

/**
 * 响应契约（zod v4）：每个端点 200 响应的形状，全部从现有路由投影提炼。
 * 用途：1) OpenAPI 文档自动生成（io=output）；2) 契约测试对真实响应做
 * safeParse 防漂移（实现改了文档没跟，测试红）。schema 即文档。
 */

// 基础形状 -------------------------------------------------------------
export const healthResponse = z.object({
  ok: z.literal(true),
  backend: z.literal("pi"),
  configured: z.boolean().describe("模型是否已配置（决定聊天能否运行）"),
});
export const sessionResponse = z.object({
  token: z.string().describe("Bearer token，后续所有 /api/* 请求放 Authorization 头，24h 有效"),
  mode: z.literal("live"),
});
export const okResponse = z.object({ ok: z.literal(true) });
export const errorResponse = z.object({
  error: z.string().describe("人类可读错误；敏感细节（密钥/供应商响应）一律不透出"),
});

// 会话 -----------------------------------------------------------------
export const threadSnapshot = z.object({
  id: z.string().describe("threadId"),
  updatedAt: z.string().describe("该会话目录最近修改时间（ISO 8601）"),
});
export const threadsResponse = z.object({
  threads: z.array(threadSnapshot).describe("按最近活跃倒序"),
});
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
  messages: z.array(chatMessage).describe("服务端权威历史（含工具投影）；客户端不得回写"),
});
export const profileResponse = z.object({
  soul: z.string().describe("SOUL.md 内容；空串表示未设置"),
  user: z.string().describe("USER.md 内容；空串表示未设置"),
});

// 工作区快照 -----------------------------------------------------------
export const taskView = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  kind: z.enum(["monitor", "agent"]).describe("monitor=定时任务，agent=异步后台任务"),
  status: z.enum(["queued", "running", "scheduled", "paused", "succeeded", "failed", "cancelled"]),
  plan: z.array(z.unknown()),
  evidence: z.array(z.unknown()),
  input: z.record(z.string(), z.unknown()),
  state: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().optional().describe("定时任务下次触发时间；一次性任务完成后无此字段"),
  attempts: z.number(),
  artifactIds: z.array(z.string()),
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
export const taskDetail = taskView.extend({
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
export const pendingAction = z.object({
  id: z.string(),
  kind: z.enum(["file_write", "file_edit"]),
  title: z.string().describe("人类可读摘要，如：写入 notes.md"),
  payload: z.record(z.string(), z.string()).describe("写入内容/编辑前后文本（截断预览）"),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});
export const identityView = z.object({
  name: z.string(),
  tone: z.string(),
  avatar: z.string().optional(),
  showChatUpdates: z.boolean().optional(),
});
export const agentSnapshot = z.object({
  tasks: z.array(taskView).describe("定时+后台任务混合（kind 区分），按更新时间倒序"),
  goals: z.array(goalView),
  monitors: z.array(monitorView),
  memories: z.array(memoryItem),
  notifications: z.array(pendingAction).describe("审批队列（含历史终态，最近 100 条）"),
  ideas: z.array(z.unknown()).describe("占位，恒为空数组"),
  artifacts: z.array(z.unknown()).describe("占位，恒为空数组"),
  identity: identityView,
  worker: z.object({ running: z.boolean() }),
});

// AG-UI 运行时信息（info 端点；字段由 CopilotKit runtime 决定，做宽松投影）
export const runtimeInfoResponse = z.object({
  version: z.string().describe("CopilotKit runtime 版本"),
  agents: z.record(z.string(), z.object({ name: z.string(), description: z.string() }))
    .describe("可用 agent：目前仅 default（PiAgent）"),
  mode: z.literal("sse").describe("传输模式：SSE 流"),
}).loose();
