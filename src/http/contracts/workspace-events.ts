import { z } from "zod";
import { MAX_CURRENT_RUNS, agentStatus } from "./agent-status.js";
import {
  MAX_PENDING_APPROVALS,
  approvalResolution,
  approvalView,
} from "./approvals.js";

/**
 * 工作区实时状态推送流契约（zod v4）：GET /api/events 上发出的四类事件。
 *
 * 与旧版“空对象失效通知”不同，本流直接承载可展示的最新状态：
 * - ready：连接建立时的完整当前集合（进行中的运行 + 待审批项）；
 * - agent_status_updated：单个运行的最新状态快照；
 * - approval_pending：新增待审批项的完整不可变内容；
 * - approval_updated：审批进入终态与执行回执变化时的轻量投影。
 *
 * 协议边界：
 * - 单向推送，不接收批准/拒绝/停止等操作；用户操作走独立 HTTP 接口。
 * - 不发送事件 id、不支持历史重放、忽略 Last-Event-ID；重连以新的 ready 为同步边界。
 * - 每条 data 是单行 JSON；按 (id, revision) 合并，不按时间排序。
 * - 通知连接断开不取消聊天、任务或子代理；不提供锁屏系统推送。
 */

/** 单个 SSE 事件（含 event/data 帧与 JSON 编码）允许的最大 UTF-8 字节数。 */
export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;
/** ready 事件允许的最大 UTF-8 字节数（完整当前集合可能大于单个增量事件）。 */
export const MAX_SSE_READY_BYTES = 12 * 1024 * 1024;

const instanceIdSchema = z
  .uuid()
  .describe(
    "产生该帧的服务进程实例 UUID。变化表示服务重启或切换到新实例；" +
      "运行时 revision 只在该实例内存内有效，instanceId 变化后应清空运行版本缓存，" +
      "但审批 revision 持久保存、不因实例变化重置。",
  );

const isoTime = z.iso.datetime().describe("ISO 8601 UTC 时间（服务端写入，固定 Z 后缀）");

/**
 * 事件表按名称索引；WORKSPACE_SSE_DESCRIPTION 直接遍历本表生成事件说明表格，
 * 避免文档与 schema 各写一份。
 */
export const workspaceEvents = {
  ready: z
    .strictObject({
      instanceId: instanceIdSchema,
      serverTime: isoTime.describe(
        "服务端生成该快照的时间。仅用于展示和诊断，不作为事件排序或版本比较依据。",
      ),
      agentStatuses: z
        .array(agentStatus)
        .max(MAX_CURRENT_RUNS)
        .describe(
          `当前仍在执行的运行快照，最多 ${MAX_CURRENT_RUNS} 个。这是当前集合的完整替换值：` +
            "不在数组中的运行应从本地进行中列表移除；已结束运行的最终状态通过 GET /api/agent/status 查询。",
        ),
      pendingApprovals: z
        .array(approvalView)
        .max(MAX_PENDING_APPROVALS)
        .describe(
          `当前待审批项的完整视图（含不可变预览全文），最多 ${MAX_PENDING_APPROVALS} 个。` +
            "这是当前待审批集合的完整替换值，不是增量；不在数组中的审批不再处于 pending。",
        ),
    })
    .describe(
      "每条连接恰好一次的首帧，先于后续增量事件。data 为完整当前集合；客户端应整体替换" +
        "进行中运行与待审批集合，而不是与旧缓存做并集。单帧不超过 12MiB。",
    ),
  agent_status_updated: agentStatus
    .extend({
      instanceId: instanceIdSchema,
    })
    .describe(
      "单个运行的最新状态快照（顶层额外带 instanceId）。同一 (threadId, runId) 只应用更高 revision；" +
        "相同或更低 revision 忽略。运行终态也会推送一次，endedAt 非 null；不要求再查询快照。",
    ),
  approval_pending: approvalView
    .extend({
      instanceId: instanceIdSchema,
    })
    .describe(
      "新增待审批项的完整视图（顶层额外带 instanceId），包含 title、kind 与完整不可变预览。" +
        "同一 id 只应用更高 revision；重复或乱序帧忽略。收到后即可展示并允许用户决定，无需先查询。",
    ),
  approval_updated: approvalResolution
    .extend({
      instanceId: instanceIdSchema,
    })
    .describe(
      "审批进入终态与执行回执变化时的轻量投影（顶层额外带 instanceId），不含 title、kind 与预览正文。" +
        "保留身份关联、revision、终态与时间；按 (id, revision) 更新，需要完整内容时读取 GET /api/approvals/:id。",
    ),
} as const;

export const WORKSPACE_SSE_DESCRIPTION = [
  "这是单用户工作区的实时状态推送流：连接建立时直接给出当前进行中的运行和待审批项的完整内容，之后推送最新变化。它与 POST /api/conversation/run 的 AG-UI 聊天文字流完全独立；不是聊天增量，不负责锁屏系统推送，也不接收任何操作命令。客户端收到事件后可直接更新界面，不需要为每条事件再拉一次快照。",
  "### 连接与鉴权\n\n" +
    "使用支持流式读取和自定义请求头的 fetch 连接 GET /api/events，携带 `Authorization: Bearer <token>`；token 由 POST /api/session 获取。浏览器原生 EventSource 不能设置此请求头，不要改为通过 URL 传递 token。" +
    "成功响应为 HTTP 200、Content-Type: text/event-stream、Cache-Control: no-cache, no-transform。" +
    "未提供或无效 token 在握手阶段返回 HTTP 401 JSON 错误，应重新登录，不要用无效凭据反复重连；服务关闭期间的新请求返回 HTTP 503 JSON 错误，可稍后重连；并发连接超过服务上限返回 HTTP 429 JSON 错误，应关闭闲置连接并退避重连。",
  "### 帧格式\n\n" +
    "按标准 SSE 的空行分帧：以 UTF-8 解码并累积跨网络 chunk 的未闭合帧，读取 `event:` 字段作为事件名，把 `data:` 字段按 JSON 解析；每个事件恰好一行 data，JSON 内部的换行会转义为 \\n，不会产生裸多行 data。每帧以空行结束。" +
    "不要按聊天 AG-UI 的 data.type 分派。示例（末尾有一个空行）：\n\n" +
    "```text\nevent: agent_status_updated\ndata: {\"instanceId\":\"...\",\"threadId\":\"local-main\",...}\n\n```\n\n" +
    "| 事件名 | 含义与客户端处理 |\n| --- | --- |\n" +
    Object.entries(workspaceEvents)
      .map(([name, schema]) => `| \`${name}\` | ${schema.description} |`)
      .join("\n"),
  "### 首帧 ready 与完整集合\n\n" +
    "服务端先注册订阅，再在同一同步步骤内取得当前运行与待审批集合、生成 ready 并放入发送缓冲；从订阅到快照之间没有 await，因此不会出现“先读快照、后订阅”的漏通知窗口。订阅后、ready 发出前到达的增量先进入同一有界队列缓冲，ready 作为首帧先发送，随后再按 revision 合并发送增量，保证不漏掉快照窗口内的变化，也不会让旧帧覆盖新状态。ready 是每条连接恰好一次的首帧，先于后续增量事件。" +
    "ready.agentStatuses 与 ready.pendingApprovals 是各自集合的完整替换值：以 ready 整体覆盖本地进行中运行和待审批集合，移除不在其中的旧项，不能只做并集或保留断线前缓存。ready 不含已结束运行的历史；某个运行结束后如需最终状态，使用 GET /api/agent/status 查询。" +
    "ready.serverTime 是服务端快照时间，仅用于展示/诊断。所有时间字段都不能用于排序或判定新旧。",
  "### 版本合并与 instanceId\n\n" +
    "运行以 (threadId, runId) 为身份、以 revision 为版本；审批以 id 为身份、以 revision 为版本。客户端只应用 revision 更高的帧，相同或更低 revision 直接忽略，因此乱序、重复或合并后的帧不会让界面倒退。revision 从 1 开始，状态变化时递增；审批进入终态或收到执行回执时 +1，重复决定不推进版本。" +
    "instanceId 标识产生事件的进程实例。instanceId 变化表示服务重启或切换实例：必须清空内存中的运行状态与运行 revision 缓存，并以新的 ready 重建；审批记录及其 revision 跨进程持久，不能因 instanceId 变化而重置或丢弃。运行 revision 只在该实例内存内有效；审批 revision 则跨进程持续有效。" +
    "事件之间没有跨领域的固定顺序，可能合并、重复或冗余；不要用事件数量计数业务操作，也不要用 serverTime/updatedAt/createdAt 排序。",
  "### 运行状态\n\n" +
    "agent_status_updated 直接携带该运行的最新展示状态，包含来源（chat/job）、所属会话与运行、当前阶段、整体文案、进行中的工具与子代理、待审批 ID 引用和时间。普通聊天可能没有登记 Activity，此时 activityId 为 null，不是错误；source=job 时 jobId 指向定时任务，source=chat 时为 null。" +
    "受控或隐藏工具的真实名称不得暴露，name 为 null；展示必须使用 label，不能根据 null 推断工具，也不能把受控工具当成执行失败。单个运行最多保留 64 个进行中工具、64 个子代理；服务端最多同时跟踪 32 个运行，超出时拒绝新运行，不静默丢弃已有运行。" +
    "运行结束后会收到一次终态帧（status 为 succeeded/failed/cancelled，phase 为 null，endedAt 非 null），该运行随后不再出现在 ready 的进行中集合。要查询某个运行（包括已结束运行）的最终状态，使用 GET /api/agent/status?threadId=<threadId>&runId=<runId>；响应包装含 instanceId 与 status，运行不存在返回 404。Activity 的查询接口与语义保持不变，仍使用 GET /api/activities 与 GET /api/activities/:id。",
  "### 审批内容、版本与决定\n\n" +
    "approval_pending 直接推送完整审批视图：title、kind 与 preview 全文，preview 包含作用域、归属会话、路径、完整 before/after 文本和 beforeExists。内容在登记时固定，之后不读取当前文件替换，也不截断；用户不需要先查询详情就能作决定。单个审批按 UTF-8 JSON 最大 1.5MB；所有 pending 累计最大 6MB 且最多 32 项；超限时服务端拒绝登记，不会截断预览或静默丢弃。" +
    "preview.scope=thread 表示会话私有工作区，ownerThreadId 指向文件归属的工作区会话；由子代理或子会话发起的审批仍归属其 ownerThreadId，scope=thread 的归属以 ownerThreadId 为准，而不是子会话自身。scope=shared 表示显式 shared/... 共享区，ownerThreadId 为 null。HTTP 审批对象不带 instanceId：审批记录与 revision 跨进程持久。" +
    "审批以 (id, revision) 做版本校验。只有 pending 可以决定，决定通过 POST /api/approvals/:id/decision 提交，请求体只接受 {\"decision\":\"approve\"|\"deny\"}；未知 id 返回 404，已处于其他终态返回 409，相同决定的重复提交幂等返回原审批，不再次执行。批准只代表授权执行预览中绑定的这一次操作，不代表执行成功，也不代表整项 Activity 完成；批准后仍可能因文件版本变化、过期、运行取消或提交失败而没有落盘，实际结果以 execution、真实工具执行和 Activity 步骤为准；execution=null 表示尚未观察到执行，运行中断遗留提交为 unknown，不重跑。每次执行回执也推送 approval_updated 并递增 revision，不修改 decidedAt/resolvedAt。" +
    "审批进入终态后推送 approval_updated：保留 id、revision、会话/运行/工具/子代理/工作区/活动关联、终态与时间，省略 title、kind 和预览正文，避免重复推送大内容。收到未知 id、需要重新查看完整预览或历史详情时，读取 GET /api/approvals/:id；历史列表使用 GET /api/approvals，只包含已处理/失效审批的摘要，不混入 pending，也不返回正文。审批历史和完整预览长期保留，不按时间或数量静默裁剪；历史记录存在不代表授权仍有效。",
  "### 心跳、背压与容量\n\n" +
    "每 30 秒发送注释心跳，完整帧为 `: keep-alive\\n\\n`。心跳不是业务事件，不按 JSON 解析，也不触发界面更新；慢连接时心跳可能延后。" +
    "服务端为每条连接维护有界队列：同一运行的多个待发状态帧可合并为最新 revision；审批新增与终态帧不会被静默丢弃。单个事件编码后最大 8MiB，ready 最大 12MiB；单帧超限或排队字节/事件数超过上限时，服务端直接断流，而不是发送半截 JSON 或无限积压。" +
    "断流后客户端应退避重连；重连会收到新的 ready，按完整集合重建即可恢复，不依赖丢失的增量。服务端也可能因连接数达到上限而在握手阶段返回 429。",
  "### 断线、重连与结束\n\n" +
    "不发送事件 id，不支持历史重放，忽略 Last-Event-ID。网络断线、App 回到前台或切换网络后重连时，一律以新的 ready 为同步边界：整体替换进行中运行与待审批集合，不能从断线前的缓存继续叠加增量。" +
    "流没有 RUN_FINISHED 之类的终止业务事件；服务关闭会结束活跃流并清理订阅与心跳，客户端将 EOF 作为连接结束处理。断开通知连接不会取消聊天、定时任务、子代理或审批等待；停止聊天仍使用原有聊天 Stop 协议，审批只能由运行取消或过期等真实业务事件进入终态。" +
    "本轮不发送记忆（memory）变化通知，也不新增 jobs/goals 的推送事件；这些领域仍按现有查询接口读取，后续是否推送另行讨论。",
].join("\n\n");

export type WorkspaceEventName = keyof typeof workspaceEvents;
export type ReadyEventDto = z.infer<typeof workspaceEvents.ready>;
export type AgentStatusUpdatedEventDto = z.infer<typeof workspaceEvents.agent_status_updated>;
export type ApprovalPendingEventDto = z.infer<typeof workspaceEvents.approval_pending>;
export type ApprovalUpdatedEventDto = z.infer<typeof workspaceEvents.approval_updated>;
