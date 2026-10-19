import { z } from "zod";
import * as req from "./rest.js";
import * as resp from "./responses.js";
import * as activity from "./activities.js";
import { sseEvents, SSE_EVENT_ORDER } from "./sse-events.js";
import { workspaceEvents, WORKSPACE_SSE_DESCRIPTION } from "./workspace-events.js";

/**
 * 端点注册表：所有对外 HTTP 接口的唯一清单。新增/修改端点必须在这里登记，
 * OpenAPI 文档（/openapi.json）与 Scalar 页面（/docs）由此自动生成——
 * 禁止手写 OpenAPI 文件。契约测试遍历此表做防漂移校验。
 */
export type SseSpec = {
  /** 流描述（写入 OpenAPI 200 描述） */
  description: string;
  /**
   * 事件名 → 数据 schema。每端点显式绑定，不复用全表。
   * 与聊天 SSE 不同的命名空间必须各自一份 events map，避免事件契约混入。
   */
  events: Readonly<Record<string, z.ZodType>>;
};

export type EndpointSpec = {
  method: "get" | "post" | "put" | "delete";
  /** 路径模板，路径参数用 :name（生成时转 {name}） */
  path: string;
  tag: string;
  summary: string;
  /** 客户端正确接入所需的行为说明，同时生成 operation.description 与 x-agent-hint。 */
  hint?: string;
  auth: boolean;
  /** 请求体 schema（生成 io=input 的 JSON Schema） */
  request?: z.ZodType;
  /** 查询参数 schema（单对象，字段即参数） */
  query?: z.ZodType;
  /** 200 响应 schema（生成 io=output；契约测试对真实响应 safeParse） */
  response: z.ZodType;
  /**
   * 响应为 SSE 流时不生成 JSON schema，改挂 x-sse-events 事件契约。
   * 每端点显式提供 events map：聊天 SSE 绑定 sseEvents；工作区通知流绑定 workspaceEvents；
   * 互不复用，确保 OpenAPI 文档与生成器按各自命名空间渲染。
   */
  sse?: SseSpec;
};

const conversationQuery = z.object({
  threadId: z.string().optional().describe("会话标识；缺省 local-main"),
});

export const endpoints: EndpointSpec[] = [
  // ---- 基础 ----
  {
    method: "get", path: "/api/health", tag: "基础", summary: "健康检查",
    hint: "无需鉴权；探测服务是否存活与模型配置状态。serviceVersion 为启动/构建时固定快照：version、commit、dirty、sourceHash、mode、builtAt；与 /openapi.json 的 x-service-version 及 /docs 一致。dirty=true 时不能只比较 commit，须核对 sourceHash；commit/dirty 无法核验时为 null。",
    auth: false, request: undefined, response: resp.healthResponse,
  },
  {
    method: "post", path: "/api/session", tag: "基础", summary: "登录换取 Bearer token",
    hint: "一切 /api/* 调用的第一步；回环部署无密钥时空 body 即可。",
    auth: false, request: req.sessionRequestSchema, response: resp.sessionResponse,
  },
  {
    method: "get", path: "/api/threads", tag: "会话", summary: "列出会话（按活跃倒序）",
    hint: "多会话入口：先取列表再选 threadId 聊天；新会话无需显式创建（run、规则/技能保存或显式来源绑定时建立）。历史 GET 和迟到 Stop 不会建立会话。",
    auth: true, response: resp.threadsResponse,
  },
  {
    method: "get", path: "/api/conversation", tag: "会话", summary: "读取会话权威历史",
    hint: "刷新/恢复时同步历史用；历史只读，客户端不要回写。合法但不存在、已删除或正在删除的 ID 返回 200 {messages:[], revision:'empty'}，不创建会话或工作区，不使其出现在列表；非法 ID 返回 400。空历史不代表会话存在，存在性以 GET /api/threads 为准。消息含工具投影（toolCalls 与 role=tool 消息按 toolCallId 关联）。文件/模型原始错误在进入模型上下文与历史前脱敏，文件缺失使用受控提示，不返回服务端绝对路径。",
    auth: true, query: conversationQuery, response: resp.conversationResponse,
  },
  {
    method: "get", path: "/api/threads/:threadId/skills", tag: "会话", summary: "读取会话技能开关",
    hint: "返回全部技能的默认状态与当前会话的生效状态。",
    auth: true, response: resp.skillsResponse,
  },
  {
    method: "put", path: "/api/threads/:threadId/skills", tag: "会话", summary: "保存会话技能开关",
    hint: "整份替换覆盖表；未知技能名返回 400。显式保存可建立新会话；删除进行中返回 409 THREAD_DELETING，刷新列表后由用户重新选择，不自动重试旧 ID。",
    auth: true, request: req.updateSkillsSchema, response: resp.skillsResponse,
  },
  {
    method: "delete", path: "/api/threads/:threadId", tag: "会话", summary: "删除会话（不可删除主会话）",
    hint: "不可删除 local-main（409）；关闭旧会话并取消其当前轮，级联删除该会话名下的定时任务与监控，取消其排队/运行中后台任务。删除等待已接纳的来源绑定与规则/技能写入完成后清理，期间同 ID 的写操作/来源绑定返回 409 THREAD_DELETING，不自动重试。迟到历史 GET/Stop 不重建会话；已完成任务的迟到通知不改投主会话或新同名会话，结果仍可读任务详情。成功后客户端取消本地请求、屏蔽迟到结果并刷新 threads/agent/actions/pending。删除非事务，失败不承诺回滚；404 表示不存在且无活跃绑定。删除成功后显式 run/规则/技能保存或来源绑定可建立全新同名会话，不恢复旧历史。",
    auth: true, response: resp.deleteThreadResponse,
  },
  {
    method: "get", path: "/api/threads/:threadId/instructions", tag: "会话", summary: "读取会话专属规则",
    hint: "读取当前会话的 INSTRUCTIONS.md 内容；未设置时返回空串。",
    auth: true, response: resp.instructionsResponse,
  },
  {
    method: "put", path: "/api/threads/:threadId/instructions", tag: "会话", summary: "保存会话专属规则",
    hint: "下一轮对话开始时注入生效；传空串等于清空。显式保存可建立新会话；删除进行中返回 409 THREAD_DELETING，刷新列表后由用户重新选择，不自动重试旧 ID。",
    auth: true, request: req.saveInstructionsSchema, response: resp.instructionsResponse,
  },
  // ---- 增量聊天（AG-UI SSE 输出）----
  {
    method: "post", path: "/api/conversation/run", tag: "会话", summary: "提交一条用户消息（SSE 流）",
    hint: `提交 message 和 expectedRevision；版本冲突 409 后重新读取历史。首次合法 ID 建立新会话；删除进行中返回 409 THREAD_DELETING，客户端不自动重试旧 ID。事件顺序：${SSE_EVENT_ORDER}。` +
      "主模型可在本轮调用 subagent 工具（官方 pi 1.3.0 示例适配），子会话返回结果后主模型继续；这不是独立后台任务队列，不提供创建子任务的 HTTP 接口。" +
      "工具参数为单个 {agent,task}、并行 {tasks:[{agent,task}]} 或链式 {chain:[{agent,task}]} 三选一；最多8项，最多4个子会话并发，链式用 {previous} 引用上一步结果，失败即停止。" +
      "subagent 的客户端卡片按 tools.presentation 的 hidden/summary 策略显示，参数正文不透出；父 SSE 不直接嵌套子会话聊天流或暴露原始工具详情。" +
      "子会话上下文与私有目录独立，通过 shared/... 显式共享；写入仍逐次审批，审批 threadId/runId 绑定父运行。Stop、父超时、删除会话和聊天流断开会同时取消并等待子会话清理；不会在服务重启后自动续跑。",
    auth: true, request: req.runRequestSchema, response: z.object({}).describe("SSE 流"),
    sse: {
      description: "AG-UI 事件流（text/event-stream，每帧 data: <JSON>）",
      events: sseEvents,
    },
  },
  {
    method: "post", path: "/api/conversation/stop", tag: "会话", summary: "停止指定运行",
    hint: "threadId/runId 必须同时匹配当前轮；迟到 Stop 返回 false，不影响下一轮。不存在或正在删除的会话返回 {stopped:false}，不建立会话或工作区。",
    auth: true, request: req.stopRequestSchema, response: z.object({ stopped: z.boolean() }),
  },
  // ---- 人设 ----
  {
    method: "get", path: "/api/profile", tag: "人设", summary: "读取 SOUL/USER 人设文本",
    auth: true, response: resp.profileResponse,
  },
  {
    method: "put", path: "/api/profile", tag: "人设", summary: "保存 SOUL/USER 人设",
    hint: "下一轮对话注入生效；传空串等于清空该段人设。",
    auth: true, request: req.saveProfileSchema, response: resp.profileResponse,
  },
  // ---- 工作区快照 ----
  {
    method: "get", path: "/api/agent", tag: "快照", summary: "全量工作区快照",
    hint:
      "工作台首屏读取定时任务/目标/监控/记忆/身份；tasks 数组仅包含 kind=job 的定时任务，不再返回后台任务或 worker 字段。不提供 POST /api/agent/tasks 创建入口；旧调用按未知 API 返回501。" +
      "subagent 是主模型的一次工具调用，不会产生此处的任务记录，结果回到来源聊天；旧 tasks.json 不读取或执行。快照目前仍全量返回定时任务，不做7天过滤或分页。" +
      "审批横幅独立读取 GET /api/actions/pending。",
    auth: true, response: resp.agentSnapshot,
  },
  // ---- 执行活动（只读；登记与推进由对话工具完成）----
  {
    method: "get", path: "/api/activities", tag: "活动", summary: "列出执行活动（按创建时间倒序分页）",
    hint:
      "执行活动是主模型在决定开始推进用户交办的工作时通过对话工具显式登记的记录，不是每轮消息自动生成，" +
      "也不是后端解析回复或按关键词/工具次数机械分类；普通交流、解释、澄清和简单查询通常没有记录。" +
      "本接口只读：没有创建/更新/完成活动的 HTTP 写入口，活动的登记、进展、等待与完成只能由对话工具在真实执行中产生；" +
      "步骤是工具、模型、子代理、审批与文件提交等真实执行事件的安全投影，不含模型内部思维、凭据、原始工具参数或未脱敏日志。" +
      "排序为 createdAt 降序、同一时间按 id 降序；limit 默认 20、范围 1–100。" +
      "cursor 是上一页返回的不透明 base64url，原样回传即可；它绑定生成时的 threadId/status 过滤条件，改变过滤后必须从第一页重新开始。" +
      "严格校验：未声明参数、重复参数、非法 limit、非法游标（结构/时间/过滤不匹配）一律 400。" +
      "分页不冻结：每次请求读取当前投影，执行中的状态与步骤会更新，期间新增活动只可能出现在第一页，已读页不保证与首次读取一致。" +
      "completed 表示主模型已明确声明完成且结果已交付；单次工具结束、子代理返回或一轮回复结束都不会自动完成。" +
      "awaiting_continuation 表示本轮结束但工作未完成，需用户明确要求继续；继续同一工作时更新原活动（runIds 追加新 run），不新建活动。" +
      "活动随来源会话删除而删除；本接口不新增 SSE 事件，状态变化由客户端重新读取本接口获取。",
    auth: true, query: activity.activitiesQuerySchema, response: activity.activitiesResponse,
  },
  {
    method: "get", path: "/api/activities/:id", tag: "活动", summary: "读取活动详情（概览＋逐步明细）",
    hint:
      "返回 activity 概览与 steps 逐步明细；steps 按真实执行顺序，失败、拒绝、取消、过期与中断如实保留，" +
      "是安全投影而非原始工具载荷或模型思维。只读，不提供修改/完成入口；活动不存在或来源会话已删除返回 404。" +
      "本接口不新增 SSE 事件，客户端在收到工作区通知或用户操作后重新读取。",
    auth: true, response: activity.activityDetailResponse,
  },
  // ---- 定时任务 ----
  // 仅保留定时任务（job）域：详情读取与控制（pause/resume/cancel/retry）。
  {
    method: "get", path: "/api/agent/tasks/:id", tag: "任务", summary: "定时任务详情（含时间线）",
    auth: true, response: resp.taskDetail,
  },
  {
    method: "post", path: "/api/agent/tasks/:id/control", tag: "任务", summary: "控制定时任务（pause/resume/cancel/retry）",
    hint:
      "target 必须为 job（定时任务）；pause 只影响后续调度，不中止正在执行的一轮。",
    auth: true, request: req.taskControlSchema, response: resp.taskView,
  },
  // ---- 记忆与身份 ----
  {
    method: "post", path: "/api/agent/memories", tag: "记忆", summary: "新增记忆",
    auth: true, request: req.createMemorySchema, response: resp.memoryItem,
  },
  {
    method: "post", path: "/api/agent/memories/:id", tag: "记忆", summary: "编辑记忆",
    auth: true, request: req.editMemorySchema, response: resp.memoryItem,
  },
  {
    method: "post", path: "/api/agent/memories/:id/forget", tag: "记忆", summary: "删除记忆",
    hint: "对话里说「忘掉 X」走同一存储；删除后下一轮注入即消失。",
    auth: true, response: resp.okResponse,
  },
  {
    method: "post", path: "/api/agent/identity", tag: "记忆", summary: "保存身份设置（名字/语气）",
    auth: true, request: req.identitySchema, response: resp.identityView,
  },
  // ---- 目标 ----
  {
    method: "post", path: "/api/agent/goals", tag: "目标", summary: "创建目标（可含里程碑）",
    hint: "active 目标每轮注入对话（标题+进度+下一里程碑），助手规划类回答会引用。",
    auth: true, request: req.createGoalSchema, response: resp.goalView,
  },
  {
    method: "post", path: "/api/agent/goals/:id", tag: "目标", summary: "编辑目标",
    auth: true, request: req.editGoalSchema, response: resp.goalView,
  },
  {
    method: "post", path: "/api/agent/goals/:id/status", tag: "目标", summary: "目标状态迁移",
    auth: true, request: req.goalStatusSchema, response: resp.goalView,
  },
  {
    method: "post", path: "/api/agent/goals/:id/milestones/:mid/toggle", tag: "目标", summary: "勾选/取消里程碑",
    hint: "全部勾完不自动完成目标——完成必须显式调 status 端点。",
    auth: true, response: resp.goalView,
  },
  {
    method: "post", path: "/api/agent/goals/:id/remove", tag: "目标", summary: "删除目标",
    auth: true, response: resp.okResponse,
  },
  // ---- 监控 ----
  {
    method: "post", path: "/api/agent/monitors", tag: "监控", summary: "创建网页监控",
    hint: "change=页面变化通知（首检建基线不通知）；contains=关键词命中通知。📡 结果投递 originThreadId 指定来源，仅省略时投递 local-main。显式新 ID 在接纳前建立；删除中返回 409 THREAD_DELETING，客户端刷新列表后由用户重新选择，不自动重试。删除来源会话会删除绑定监控，旧扫描不重建会话或改投主会话。",
    auth: true, request: req.createMonitorSchema, response: resp.monitorView,
  },
  {
    method: "post", path: "/api/agent/monitors/:id/control", tag: "监控", summary: "控制监控（pause/resume/stop）",
    auth: true, request: req.monitorControlSchema, response: resp.monitorView,
  },
  // ---- 审批 ----
  {
    method: "get", path: "/api/actions/pending", tag: "审批", summary: "读取当前待审批操作（完整预览）",
    auth: true, response: resp.pendingActionsResponse,
  },
  {
    method: "get", path: "/api/actions", tag: "审批", summary: "读取审批历史摘要（不含文件正文）",
    auth: true, response: resp.actionsResponse,
  },
  {
    method: "get", path: "/api/actions/:id", tag: "审批", summary: "读取单个审批详情",
    auth: true, response: resp.pendingAction,
  },
  {
    method: "post", path: "/api/actions/:id/decide", tag: "审批", summary: "审批写操作（approve/deny）",
    hint:
      "模型调用 write/edit 时工具挂起等此决定：approve 才落盘，deny 返回受控拒绝。" +
      "5 分钟不决定自动 expired。只有 pending 状态可决定（重复决定 409）。",
    auth: true, request: req.actionDecisionSchema, response: resp.pendingAction,
  },
  // ---- 工作区变更通知（独立命名 SSE，不与聊天流共用事件）----
  {
    method: "get", path: "/api/events", tag: "通知", summary: "工作区变更通知流（SSE）",
    hint: WORKSPACE_SSE_DESCRIPTION,
    auth: true, response: z.object({}).describe("SSE 流"),
    sse: {
      description:
        "命名 SSE：event: ready / workspace_updated / actions_updated，data: {}，每帧以空行结束。" +
        "首帧 ready 后读取 /api/agent 与 /api/actions/pending；刷新期间收到新通知须在当前请求完成后补刷；重连后再次同步。" +
        "每30秒注释 : keep-alive 为心跳，无事件ID或重放；断开通知连接不取消聊天或后台任务。完整接入规则见本接口描述。",
      events: workspaceEvents,
    },
  },
];
