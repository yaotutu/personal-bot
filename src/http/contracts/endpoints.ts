import { z } from "zod";
import * as req from "./rest.js";
import * as resp from "./responses.js";
import { sseEvents, SSE_EVENT_ORDER } from "./sse-events.js";

/**
 * 端点注册表：所有对外 HTTP 接口的唯一清单。新增/修改端点必须在这里登记，
 * OpenAPI 文档（/openapi.json）与 Scalar 页面（/docs）由此自动生成——
 * 禁止手写 OpenAPI 文件。契约测试遍历此表做防漂移校验。
 */
export type EndpointSpec = {
  method: "get" | "post" | "put" | "delete";
  /** 路径模板，路径参数用 :name（生成时转 {name}） */
  path: string;
  tag: string;
  summary: string;
  /** 给 agent 的一句话使用提示（生成 x-agent-hint） */
  hint?: string;
  auth: boolean;
  /** 请求体 schema（生成 io=input 的 JSON Schema） */
  request?: z.ZodType;
  /** 查询参数 schema（单对象，字段即参数） */
  query?: z.ZodType;
  /** 200 响应 schema（生成 io=output；契约测试对真实响应 safeParse） */
  response: z.ZodType;
  /** 响应为 SSE 流时不生成 JSON schema，改挂 x-sse-events 事件契约 */
  sse?: boolean;
};

const conversationQuery = z.object({
  threadId: z.string().describe("会话标识；缺省 local-main"),
});

export const endpoints: EndpointSpec[] = [
  // ---- 基础 ----
  {
    method: "get", path: "/api/health", tag: "基础", summary: "健康检查",
    hint: "无需鉴权；探测服务是否存活与模型配置状态。",
    auth: false, request: undefined, response: resp.healthResponse,
  },
  {
    method: "post", path: "/api/session", tag: "基础", summary: "登录换取 Bearer token",
    hint: "一切 /api/* 调用的第一步；回环部署无密钥时空 body 即可。",
    auth: false, request: req.sessionRequestSchema, response: resp.sessionResponse,
  },
  {
    method: "get", path: "/api/threads", tag: "会话", summary: "列出会话（按活跃倒序）",
    hint: "多会话入口：先取列表再选 threadId 聊天；新会话无需显式创建（run 时任意合法 id 即建）。",
    auth: true, response: resp.threadsResponse,
  },
  {
    method: "get", path: "/api/conversation", tag: "会话", summary: "读取会话权威历史",
    hint: "刷新/恢复时同步历史用；历史只读，客户端不要回写。消息含工具投影（toolCalls 与 role=tool 消息按 toolCallId 关联）。",
    auth: true, query: conversationQuery, response: resp.conversationResponse,
  },
  {
    method: "get", path: "/api/threads/:threadId/skills", tag: "会话", summary: "读取会话技能开关",
    hint: "返回全部技能的默认状态与当前会话的生效状态。",
    auth: true, response: resp.skillsResponse,
  },
  {
    method: "put", path: "/api/threads/:threadId/skills", tag: "会话", summary: "保存会话技能开关",
    hint: "整份替换覆盖表；未知技能名返回 400。",
    auth: true, request: req.updateSkillsSchema, response: resp.skillsResponse,
  },
  {
    method: "delete", path: "/api/threads/:threadId", tag: "会话", summary: "删除会话（不可删除主会话）",
    hint: "不可删除 local-main（409）；级联删除该会话名下的定时任务与监控，取消其排队/运行中后台任务。",
    auth: true, response: resp.deleteThreadResponse,
  },
  {
    method: "get", path: "/api/threads/:threadId/instructions", tag: "会话", summary: "读取会话专属规则",
    hint: "读取当前会话的 INSTRUCTIONS.md 内容；未设置时返回空串。",
    auth: true, response: resp.instructionsResponse,
  },
  {
    method: "put", path: "/api/threads/:threadId/instructions", tag: "会话", summary: "保存会话专属规则",
    hint: "下一轮对话开始时注入生效；传空串等于清空。",
    auth: true, request: req.saveInstructionsSchema, response: resp.instructionsResponse,
  },
  // ---- 增量聊天（AG-UI SSE 输出）----
  {
    method: "post", path: "/api/conversation/run", tag: "会话", summary: "提交一条用户消息（SSE 流）",
    hint: `提交 message 和 expectedRevision；版本冲突 409 后重新读取历史。事件顺序：${SSE_EVENT_ORDER}。`,
    auth: true, request: req.runRequestSchema, response: z.object({}).describe("SSE 流"), sse: true,
  },
  {
    method: "post", path: "/api/conversation/stop", tag: "会话", summary: "停止指定运行",
    hint: "threadId/runId 必须同时匹配当前轮；迟到 Stop 返回 false，不影响下一轮。",
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
      "工作台首屏读取任务/目标/监控/记忆/身份；不包含审批正文。" +
      "审批横幅独立读取 GET /api/actions/pending。",
    auth: true, response: resp.agentSnapshot,
  },
  // ---- 后台/定时任务 ----
  {
    method: "post", path: "/api/agent/tasks", tag: "任务", summary: "创建后台任务（立即排队执行）",
    hint: "异步干活的入口：任务在独立会话执行（工具可用），完成后 📋 通知进主聊天流。",
    auth: true, request: req.createTaskSchema, response: resp.taskView,
  },
  {
    method: "get", path: "/api/agent/tasks/:id", tag: "任务", summary: "任务详情（含时间线）",
    auth: true, response: resp.taskDetail,
  },
  {
    method: "post", path: "/api/agent/tasks/:id/control", tag: "任务", summary: "控制任务（pause/resume/cancel/retry）",
    hint:
      "同一端点管两类：必须指定 target=job（定时）或 task（后台）。" +
      "job 的 pause 只影响后续调度，不中止正在执行的一轮。",
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
    hint: "change=页面变化通知（首检建基线不通知）；contains=关键词命中通知。结果以 📡 进主聊天流。",
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
 ];
