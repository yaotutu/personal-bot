import { z } from "zod";

/**
 * 工作区变更通知事件契约（zod v4）：GET /api/events 流上发出的事件子集。
 *
 * 协议要点：
 * - Authorization: Bearer；与聊天 SSE 完全独立，不复用 AG-UI 命名空间。
 * - 三种事件均只承载触发信号（无业务正文、无 id、无 Last-Event-ID、无重放）。
 * - 客户端在 `ready` 之后读取 /api/agent 与 /api/actions/pending 获取正文。
 * - 30 秒注释行 `: keep-alive` 用于降低代理空闲超时风险，不作为事件 schema。
 *
 * workspace 涵盖：jobs / tasks / goals / memories / monitors / identity / worker；
 * 因此 `workspace_updated` 涵盖工作台任意成员变更。
 */

export const workspaceEvents = {
  ready: z
    .object({})
    .strict()
    .describe("首帧 event: ready / data: {}；首次连接及重连收到后均读取 /api/agent 与 /api/actions/pending。"),
  workspace_updated: z
    .object({})
    .strict()
    .describe("工作台可能变化（jobs/tasks/goals/memories/monitors/identity/worker），重读 /api/agent；刷新中再次收到时在本次完成后补刷。"),
  actions_updated: z
    .object({})
    .strict()
    .describe("审批集合变化（新增/批准/拒绝/过期/撤销），重读 /api/actions/pending；刷新中再次收到时在本次完成后补刷。"),
} as const;

export const WORKSPACE_SSE_DESCRIPTION = [
  "这是单用户工作区的缓存失效通知流，只提示重新读取，不携带实体 ID、任务状态或审批正文。它与 POST /api/conversation/run 的 AG-UI 聊天流独立，不是聊天文字增量推送，也不负责后台或锁屏推送。",
  "### 连接与鉴权\n\n" +
    "使用支持流式读取和自定义请求头的 fetch 连接 GET /api/events，携带 `Authorization: Bearer <token>`；token 由 POST /api/session 获取。浏览器原生 EventSource 不能设置此请求头，不要改为通过 URL 传递 token。" +
    "成功响应为 HTTP 200、Content-Type: text/event-stream、Cache-Control: no-cache, no-transform。" +
    "未提供或无效 token 在握手阶段返回 HTTP 401 JSON 错误，应重新登录，不要用无效凭据反复重连；服务关闭期间的新请求返回 HTTP 503 JSON 错误，可稍后重新连接。",
  "### 帧格式与事件\n\n" +
    "按标准 SSE 的空行分帧，使用 UTF-8 解码并累积跨网络 chunk 的未闭合帧。读取 event: 字段作为事件名，将 data: 字段按 JSON 解析；三种事件的数据均为空对象 {}。" +
    "不要按聊天 AG-UI 的 data.type 分派。示例（末尾有一个空行）：\n\n" +
    "```text\nevent: workspace_updated\ndata: {}\n\n```\n\n" +
    "| 事件名 | 含义与客户端处理 |\n| --- | --- |\n" +
    Object.entries(workspaceEvents).map(([name, schema]) => `| \`${name}\` | ${schema.description} |`).join("\n"),
  "服务端先注册订阅再发送 ready；ready 是每条连接恰好一次的首帧，先于后续变化通知。" +
    "workspace_updated 与 actions_updated 之间没有跨领域的固定顺序；信号可能合并或冗余，不承诺每次变更一一对应，不能用事件数量计数业务操作。" +
    "数据持久化成功后才通知，worker 忙闲在内存状态切换后通知；不监视外部进程直接修改数据文件。",
  "### 心跳\n\n" +
    "每 30 秒发送注释心跳 : keep-alive，完整帧为 `: keep-alive\\n\\n`。心跳不是业务事件，不按 JSON 解析，也不触发刷新。" +
    "慢连接背压时心跳可能延后发送；心跳只降低代理空闲超时风险，不保证网络永不断线。",
  "### 客户端同步与刷新合并\n\n" +
    "1. 首次连接及每次重连都必须等待 ready，然后读取 GET /api/agent 与 GET /api/actions/pending；不能只使用断线前的缓存。\n" +
    "2. workspace_updated 表示定时任务 jobs、后台任务 tasks、目标 goals、记忆 memories、监控 monitors、身份 identity 或 worker 忙闲可能变化，刷新 /api/agent；actions_updated 表示审批新增、批准、拒绝、过期或撤销，刷新 /api/actions/pending。仅以查询响应作为事实，允许复用现有聚合刷新方法；打开的审批历史或详情应同时刷新对应查询。\n" +
    "3. 同范围的通知可以合并；刷新请求进行中若再次收到通知，必须保留待刷新标记，在当前请求完成后至少再补刷一次，不能因已有在途请求而丢弃通知。不同范围均须处理。读取失败不能当作已同步，恢复连接或再次刷新时应重新读取。\n" +
    "4. 现有轮询可以保留，事件流作为可选加速通道。只有完成上述首次同步、重连和补刷处理后，客户端才可自行替换原有 5 秒盲轮询；仍需保留用户操作后刷新和手动刷新。本接口不会自动修改客户端轮询。",
  "### 断线、重连与结束\n\n" +
    "不发送事件 id，不支持历史重放，忽略 Last-Event-ID。网络断线后重连或 App 回到前台重连时，均以新的 ready 为同步边界，重新读取两个查询接口。" +
    "建议前台保留一条全局连接，退后台可主动断开；非主动断线后适度退避重连，不能紧密循环请求。" +
    "流没有 RUN_FINISHED 或其他终止业务事件；服务关闭会结束活跃流并清理订阅和心跳，客户端将 EOF 作为连接结束处理。" +
    "断开通知连接不取消聊天或后台任务；只释放通知订阅，停止聊天仍使用原有聊天取消协议。",
].join("\n\n");

export type WorkspaceEventName = keyof typeof workspaceEvents;