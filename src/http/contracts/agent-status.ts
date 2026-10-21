import { z } from "zod";

/**
 * 运行状态（Agent Status）HTTP/SSE 契约：单个 run 的展示投影与查询参数。
 *
 * 边界：
 * - 这是服务端对真实执行事件的展示投影，不拥有执行锁，不写 Activity 历史，也不允许
 *   客户端写入；运行状态只用于展示当前/最终执行进度。
 * - 同一 (spaceId, runId) 的每次变化推进 revision；客户端只能按 revision 合并，
 *   不能按到达时间或 serverTime 排序。
 * - 普通 chat 可能没有登记 Activity，此时 activityId 为 null；这不是错误。
 * - 工具名属于敏感展示信息，受控/隐藏工具必须输出 null，由 label 承担展示文案。
 */

/** 同时跟踪的运行上限；超出时新运行被拒绝，不静默丢弃已有运行。 */
export const MAX_CURRENT_RUNS = 32;
/** 单个运行保留的进行中工具上限。 */
export const MAX_STATUS_TOOLS = 64;
/** 单个运行保留的子代理上限。 */
export const MAX_STATUS_SUBAGENTS = 64;
/** 运行标题最大字符数。 */
export const MAX_STATUS_TITLE_LENGTH = 500;
/** 运行/子代理展示文案最大字符数。 */
export const MAX_STATUS_LABEL_LENGTH = 500;

export const agentRunStatuses = ["running", "succeeded", "failed", "cancelled"] as const;
export const agentPhases = [
  "preparing",
  "waiting_model",
  "responding",
  "executing_tool",
  "waiting_subagents",
  "waiting_approval",
  "finalizing",
] as const;
export const agentToolStatuses = ["running", "waiting_approval"] as const;
export const subagentStatuses = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

/**
 * 子代理没有“等待子代理”阶段，避免出现自我等待；其余阶段与父运行一致。
 * 显式枚举并保持与 agentPhases 的编译期覆盖关系，新增阶段时不会静默漏掉子代理。
 */
export const subagentPhases = [
  "preparing",
  "waiting_model",
  "responding",
  "executing_tool",
  "waiting_approval",
  "finalizing",
] as const satisfies readonly Exclude<(typeof agentPhases)[number], "waiting_subagents">[];

type AssertNever<T extends never> = T;
type _SubagentPhasesCovered = AssertNever<
  Exclude<
    Exclude<(typeof agentPhases)[number], "waiting_subagents">,
    (typeof subagentPhases)[number]
  >
>;

const isoTime = z.iso.datetime().describe("ISO 8601 UTC 时间（服务端写入，固定 Z 后缀）");

const spaceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .describe("空间标识：字母或数字开头，可含 _ -，最长 64；与聊天接口的 spaceId 同一字符集");

const runIdSchema = z.string().min(1).max(200).describe("运行标识；同一会话内唯一，最长 200");

// ---------------------------------------------------------------------------
// 运行状态投影
// ---------------------------------------------------------------------------
export const agentToolState = z
  .strictObject({
    toolCallId: z.string().min(1).describe("工具调用 ID；与聊天历史中的 toolCallId 对应"),
    name: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "工具名；受控或隐藏工具为 null，表示服务端不暴露真实工具名。展示必须使用 label，" +
          "不要把 null 当作错误，也不要自行推断工具。",
      ),
    label: z
      .string()
      .max(MAX_STATUS_LABEL_LENGTH)
      .describe("可直接展示的工具状态文案；不包含原始参数、凭据或未脱敏内容"),
    status: z
      .enum(agentToolStatuses)
      .describe("running=正在执行；waiting_approval=工具已挂起，等待人工审批"),
    subagentId: z
      .string()
      .min(1)
      .nullable()
      .describe("发起该工具调用的子代理 ID；父运行直接发起的工具为 null"),
  })
  .describe("运行中的一次工具调用。工具结束后从数组移除，不在状态快照中保留历史。");

export const subagentState = z
  .strictObject({
    id: z.string().min(1).describe("子代理运行 ID，运行内稳定"),
    role: z.string().min(1).describe("子代理角色名；由服务端定义，不是模型自由文本"),
    status: z
      .enum(subagentStatuses)
      .describe("queued=等待并发名额；running=执行中；其余为终态，失败/取消如实保留"),
    phase: z
      .enum(subagentPhases)
      .nullable()
      .describe(
        "子代理当前阶段；与父运行阶段同名，但不含 waiting_subagents。终态或尚未开始时为 null。",
      ),
    label: z
      .string()
      .max(MAX_STATUS_LABEL_LENGTH)
      .describe("可直接展示的子代理状态文案；不包含模型思维或原始工具载荷"),
    startedAt: isoTime.nullable().describe("开始执行时间；仍在排队或从未开始时为 null"),
    updatedAt: isoTime.describe("该子代理状态最近一次变化时间"),
    endedAt: isoTime.nullable().describe("进入终态的时间；未结束时为 null"),
  })
  .describe("运行内的子代理状态。只展示当前运行实际创建的子代理，不另建 Activity 或任务记录。");

export const agentStatus = z
  .strictObject({
    activityId: z
      .string()
      .min(1)
      .nullable()
      .describe("关联的 Activity ID；普通 chat 未登记活动时为 null，不要求每轮都有活动"),
    spaceId: spaceIdSchema.describe("所属空间"),
    runId: runIdSchema,
    revision: z
      .number()
      .int()
      .min(1)
      .describe(
        "运行展示版本；创建时为 1，每次状态变化 +1。客户端只应用更高 revision，" +
          "相同或更低忽略。该版本只代表当前服务实例内存中的运行快照；instanceId 变化后" +
          "必须清空运行版本缓存，以新的 ready 和之后的第一帧为准，不能与旧实例的 revision 比较。",
      ),
    source: z
      .enum(["chat", "job"])
      .describe("来源：chat=用户聊天触发的运行；job=定时任务触发的运行"),
    jobId: z
      .string()
      .min(1)
      .nullable()
      .describe("source=job 时对应的定时任务 ID；source=chat 时为 null"),
    title: z
      .string()
      .max(MAX_STATUS_TITLE_LENGTH)
      .describe("运行标题；有 Activity 时使用活动标题，否则为服务端受控文案"),
    status: z
      .enum(agentRunStatuses)
      .describe("running=执行中；succeeded=正常完成；failed=失败；cancelled=用户或系统取消"),
    phase: z
      .enum(agentPhases)
      .nullable()
      .describe(
        "running 时的当前阶段：preparing/waiting_model/responding/executing_tool/" +
          "waiting_subagents/waiting_approval/finalizing；终态为 null。",
      ),
    label: z
      .string()
      .max(MAX_STATUS_LABEL_LENGTH)
      .describe("可直接展示的整体状态文案；不包含模型思维、凭据或原始工具参数"),
    tools: z
      .array(agentToolState)
      .max(MAX_STATUS_TOOLS)
      .describe("当前进行中的工具调用；最多 64 个，结束即移除"),
    subagents: z
      .array(subagentState)
      .max(MAX_STATUS_SUBAGENTS)
      .describe("当前运行的子代理状态；最多 64 个"),
    pendingApprovalIds: z
      .array(z.string().min(1))
      .describe(
        "该运行当前等待的审批 ID 引用；审批完整内容通过 approval_pending 事件单独推送，" +
          "两者可能不同时到达。终态时清空。",
      ),
    startedAt: isoTime.describe("运行开始时间"),
    updatedAt: isoTime.describe("运行状态最近一次变化时间；只用于展示，不作为事件排序依据"),
    endedAt: isoTime.nullable().describe("进入终态的时间；仍在 running 时为 null"),
  })
  .describe(
    "单个运行的展示状态快照。由真实执行事件投影得到，不代表 Activity 的完成状态，" +
      "也不作为执行锁或历史存储。同一 (spaceId, runId) 按 revision 合并。",
  );

// ---------------------------------------------------------------------------
// 查询与 HTTP 响应
// ---------------------------------------------------------------------------
export const agentStatusQuery = z
  .strictObject({
    spaceId: spaceIdSchema.describe("要查询的运行所属空间"),
    runId: runIdSchema.describe("要查询的运行 ID；必填"),
  })
  .describe("GET /api/agent/status 查询参数；两个字段都必填，不接受未声明参数。");

/**
 * 运行状态查询响应：HTTP 对象不带审批的 instanceId，但运行状态必须带上产生它的
 * 服务实例 ID，客户端才能区分重启前后同 ID 的 run revision。
 */
export const agentStatusResponse = z
  .strictObject({
    instanceId: z
      .uuid()
      .describe(
        "产生该状态的服务进程实例 UUID。变化表示服务重启或切换到新实例；" +
          "运行 revision 只在该实例内存内有效，instanceId 变化后应清空运行版本缓存。",
      ),
    status: agentStatus,
  })
  .describe(
    "GET /api/agent/status 的响应：指定运行的当前状态，或运行结束后持久化的最终状态。" +
      "运行不存在或已被清理时返回 404。Activity 查询仍使用 /api/activities，语义不变。",
  );

export type AgentToolStateDto = z.infer<typeof agentToolState>;
export type SubagentStateDto = z.infer<typeof subagentState>;
export type AgentStatusDto = z.infer<typeof agentStatus>;
export type AgentStatusQueryDto = z.infer<typeof agentStatusQuery>;
export type AgentStatusResponseDto = z.infer<typeof agentStatusResponse>;
