import { z } from "zod";
import type { ApprovalViewDto } from "./approvals.js";

/**
 * 响应契约（zod v4）：每个端点 200 响应的形状，全部从现有路由投影提炼。
 * 用途：1) OpenAPI 文档自动生成（io=output）；2) 契约测试对真实响应做
 * safeParse 防漂移（实现改了文档没跟，测试红）。schema 即文档。
 *
 * 审批相关形状（完整视图/摘要/分页）已迁移到 contracts/approvals.ts；
 * 本文件不再保留旧 /api/actions 的 pending 列表或 payload 结构。
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
  code: z.string().optional().describe("机器可读业务错误码（如 MEMORY_CAPACITY_REACHED, REVISION_CONFLICT 等）"),
});

// 空间 -----------------------------------------------------------------
export const spaceSnapshot = z.object({
  id: z.string().describe("spaceId"),
  sessionId: z.string().describe("当前活跃绑定的 sessionId"),
  updatedAt: z.string().describe("该空间当前会话 JSONL 最近修改时间（ISO 8601）"),
});
export const spacesResponse = z.object({
  spaces: z.array(spaceSnapshot).describe("按最近活跃倒序"),
});
export const resetSpaceResponse = z.object({
  ok: z.literal(true),
  spaceId: z.string().describe("重置的空间 ID"),
  sessionId: z.string().describe("重置后绑定的全新 session ID"),
  cancelledApprovals: z.number().int().nonnegative().describe("重置时作废的待审批写操作数"),
  removed: z.object({
    jobs: z.number().int().nonnegative().describe("级联清理的定时任务数（当 clearSchedules=true）"),
    monitors: z.number().int().nonnegative().describe("级联清理的网页监控数（当 clearSchedules=true）"),
  }),
});
export type ResetSpaceDto = z.infer<typeof resetSpaceResponse>;
export const deleteSpaceResponse = z.object({
  ok: z.literal(true),
  removed: z.object({
    jobs: z.number().int().nonnegative().describe("级联删除的定时任务数"),
    monitors: z.number().int().nonnegative().describe("级联删除的网页监控数"),
  }),
});
export type DeleteSpaceDto = z.infer<typeof deleteSpaceResponse>;
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
  instructions: z.string().describe("该空间当前生效的专属指令文本（INSTRUCTIONS.md）"),
});
export type InstructionsDto = z.infer<typeof instructionsResponse>;

// 定时任务（Jobs） --------------------------------------------------------
export const jobItem = z.object({
  id: z.string().describe("定时任务唯一 ID"),
  title: z.string().describe("任务简短标题（由 prompt 截断）"),
  prompt: z.string().describe("到点后作为用户消息发给模型的内容"),
  kind: z.literal("job").describe("固定为 job"),
  daily: z.boolean().describe("是否每天重复"),
  at: z.string().describe("定时设定时刻（daily 为 HH:mm，一次性为 ISO 8601 时间戳）"),
  enabled: z.boolean().describe("是否处于启用/调度状态"),
  status: z.enum(["scheduled", "running", "paused", "succeeded", "failed", "cancelled", "queued"]).describe(
    "任务状态：scheduled=已排期；running=执行中；paused=已暂停；succeeded=上次成功；failed=上次失败；cancelled=已取消；queued=排队中",
  ),
  createdAt: z.string().describe("创建时间（ISO 8601）"),
  updatedAt: z.string().describe("更新时间（ISO 8601）"),
  nextRunAt: z.string().optional().describe("下次计划触发时间（ISO 8601）"),
  lastRunAt: z.string().optional().describe("最近一次触发时间（ISO 8601）"),
  lastResult: z.string().optional().describe("最近一次执行结果文本摘要"),
  error: z.string().nullable().describe("错误信息（上次执行失败时非 null）"),
  originSpaceId: z.string().optional().describe("所属空间 ID"),
});

export const jobsResponse = z.object({
  jobs: z.array(jobItem).describe("定时任务列表"),
});

export const taskView = jobItem;
export const runEvent = z.object({
  id: z.string(),
  taskId: z.string(),
  date: z.string(),
  kind: z.enum(["plan", "step", "observation", "approval", "result", "error", "status"]),
  title: z.string(),
  detail: z.string(),
});

export const jobDetail = z.object({
  job: jobItem,
  events: z.array(runEvent).describe("最近一次运行与控制操作的时间线"),
});

export const deleteJobResponse = z.object({
  ok: z.literal(true),
  id: z.string().describe("被删除的定时任务 ID"),
});

export const taskDetail = z.object({
  task: jobItem,
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
export const goalItem = goalView;
export const goalsResponse = z.object({
  goals: z.array(goalItem).describe("长期目标列表"),
});
export type GoalsResponseDto = z.infer<typeof goalsResponse>;
export const deleteGoalResponse = z.object({
  ok: z.literal(true),
  id: z.string().describe("已删除的目标 ID"),
});
export type DeleteGoalResponseDto = z.infer<typeof deleteGoalResponse>;
export const monitorItem = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  condition: z.enum(["change", "contains"]),
  value: z.string().optional(),
  intervalMinutes: z.number(),
  status: z.enum(["active", "paused", "stopped"]),
  createdAt: z.string(),
  originSpaceId: z.string().optional().describe("接收监控通知的来源空间；未指定时投递主空间"),
  lastCheckedAt: z.string().optional(),
  lastFingerprint: z.string().optional().describe("change 条件的内容指纹（内部）"),
  lastMatched: z.boolean().optional().describe("contains 条件上次是否命中"),
  lastNotifiedAt: z.string().optional(),
  checks: z.number().describe("累计检查次数"),
  error: z.string().optional().describe("上次抓取失败标记"),
});
export const monitorView = monitorItem;
export const monitorsResponse = z.object({
  monitors: z.array(monitorItem).describe("网页监控列表"),
});
export type MonitorsResponseDto = z.infer<typeof monitorsResponse>;
export const deleteMonitorResponse = z.object({
  ok: z.literal(true),
  id: z.string().describe("已删除的监控项 ID"),
});
export type DeleteMonitorResponseDto = z.infer<typeof deleteMonitorResponse>;
export const memoryItem = z.object({
  id: z.string(),
  text: z.string(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const memoriesResponse = z.object({
  memories: z.array(memoryItem).describe("长期记忆条目列表；传入 q 时按更新时间倒序返回匹配项"),
});
export type MemoriesResponseDto = z.infer<typeof memoriesResponse>;
export const deleteMemoryResponse = z.object({
  ok: z.literal(true),
  id: z.string().describe("已删除的记忆条目 ID"),
});
export type DeleteMemoryResponseDto = z.infer<typeof deleteMemoryResponse>;
export const dreamTargetView = z.enum(["user", "soul", "instructions", "memory"]);
export const dreamPendingItem = z.object({
  id: z.string().describe("待决建议 ID"),
  text: z.string().describe("建议保存的纯文本内容"),
  suggestedTarget: dreamTargetView.describe("模型建议归属"),
  reason: z
    .enum(["ambiguous", "global_from_session", "no_purpose"])
    .describe(
      "未直接落盘的原因：ambiguous=模型不确定归属，global_from_session=非主会话提出的全局 USER/SOUL 建议，no_purpose=会话未声明 `## 会话用途`",
    ),
  createdAt: z.string().describe("生成时间（ISO 8601）"),
});
export const dreamRunView = z.object({
  at: z.string().describe("本次整理开始时间（ISO 8601）"),
  status: z
    .enum(["running", "completed", "failed", "partial"])
    .describe(
      "running=执行中，completed=全部成功并已推进游标，partial=部分目标已写入后失败（游标未推进），failed=未产生写入",
    ),
  changed: z.array(dreamTargetView).describe("本次实际发生写入的目标"),
  processed: z.number().int().nonnegative().describe("本次待整理段的新消息条数"),
  error: z.string().optional().describe("受控错误说明；不含原始模型/文件载荷"),
});
export const dreamSpaceResponse = z.object({
  spaceId: z.string().describe("空间 ID"),
  enabled: z.boolean().describe("该空间是否开启周期 Dream 整理"),
  inheritGlobalPrompt: z.boolean().describe("是否继承全局 DREAM.md 提示词"),
  cursor: z.string().optional().describe("已整理到的消息 ID；整轮成功后才推进"),
  lastRun: dreamRunView.optional().describe("最近一次整理结果"),
  pending: z.array(dreamPendingItem).describe("等待人工确认归属的建议列表"),
  prompt: z.string().describe("该空间专属补充提示词（DREAM.md）；未设置为空串"),
  purpose: z.string().describe("从 INSTRUCTIONS.md 提取的 `## 空间用途` 正文；未设置为空串"),
});
export const dreamThreadResponse = dreamSpaceResponse;
export const dreamOverviewResponse = z.object({
  globalPrompt: z.string().describe("全局 DREAM.md 内容；空串表示使用 defaultPrompt"),
  defaultPrompt: z.string().describe("内置默认整理提示词（只读参考）"),
  intervalHours: z.number().int().positive().describe("后台周期检查间隔（小时，固定为 2）"),
  running: z.boolean().describe("当前进程内是否有 Dream 整理轮正在执行"),
  spaces: z.array(dreamSpaceResponse).describe("所有已知空间的 Dream 状态与待决项"),
  threads: z.array(dreamSpaceResponse).describe("兼容字段：等同于 spaces"),
});
export type DreamPendingDto = z.infer<typeof dreamPendingItem>;
export type DreamSpaceDto = z.infer<typeof dreamSpaceResponse>;
export type DreamThreadDto = DreamSpaceDto;
export type DreamOverviewDto = z.infer<typeof dreamOverviewResponse>;
export const identityView = z.object({
  name: z.string(),
  tone: z.string(),
  avatar: z.string().optional(),
  showChatUpdates: z.boolean().optional(),
});
export const agentSnapshot = z.object({
  identity: identityView,
});

/** 响应 schema 是服务端与自有 Web 共享 DTO 的唯一事实源。 */
export type JobDto = z.infer<typeof jobItem>;
export type JobDetailDto = z.infer<typeof jobDetail>;
export type JobsResponseDto = z.infer<typeof jobsResponse>;
export type DeleteJobResponseDto = z.infer<typeof deleteJobResponse>;
export type TaskDto = z.infer<typeof taskView>;
export type TaskDetailDto = z.infer<typeof taskDetail>;
export type RunEventDto = z.infer<typeof runEvent>;
export type MemoryDto = z.infer<typeof memoryItem>;
export type GoalDto = z.infer<typeof goalView>;
export type MonitorItemDto = z.infer<typeof monitorItem>;
export type MonitorDto = MonitorItemDto;
/**
 * 兼容别名：自有 Web 在迁移到 GET /api/approvals 与审批 View 前仍按 ActionDto 引用。
 * 它现在就是审批完整视图类型，不再包含旧 payload/actions 列表结构；
 * 旧 reader（/api/actions*）已下线，无历史兼容层。
 */
export type ActionDto = ApprovalViewDto;
export type AgentSnapshotDto = z.infer<typeof agentSnapshot>;
export type SpaceDto = z.infer<typeof spaceSnapshot>;
export type ThreadDto = SpaceDto;

// 技能 -----------------------------------------------------------------
export const skillItem = z.object({
  name: z.string().describe("技能名称（目录名）"),
  description: z.string().describe("技能描述"),
  defaultEnabled: z.boolean().describe("技能默认开关状态"),
  enabled: z.boolean().describe("当前空间的生效开关状态"),
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
