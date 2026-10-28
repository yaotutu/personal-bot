import { z } from "zod";
import * as req from "./rest.js";
import * as resp from "./responses.js";
import * as activity from "./activities.js";
import * as approval from "./approvals.js";
import * as status from "./agent-status.js";
import * as files from "./workspace-files.js";
import * as browser from "./browser.js";
import * as message from "./messages.js";
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
  operationId?: string;
  method: "get" | "post" | "put" | "patch" | "delete";
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
  /** 非 JSON 响应（当前仅调试页 HTML）；默认 application/json */
  responseContentType?: "application/json" | "text/html";
  /**
   * 业务错误响应（如 409 冲突携带当前审批视图）。
   * 键为 HTTP 状态码；未登记的 4xx 仍由生成器补通用 {error} 形状。
   */
  errorResponses?: Readonly<Record<number, { description: string; schema: z.ZodType }>>;
  /**
   * 响应为 SSE 流时不生成 JSON schema，改挂 x-sse-events 事件契约。
   * 每端点显式提供 events map：聊天 SSE 绑定 sseEvents；工作区通知流绑定 workspaceEvents；
   * 互不复用，确保 OpenAPI 文档与生成器按各自命名空间渲染。
   */
  sse?: SseSpec;
};

const conversationQuery = z.object({
  spaceId: z.string().optional().describe("空间标识；缺省 local-main"),
});

export const endpoints: EndpointSpec[] = [
  // ---- 基础 ----
  {
    operationId: "getHealth",
    method: "get", path: "/api/health", tag: "基础", summary: "健康检查",
    hint: "无需鉴权；探测服务存活状态、模型配置及权威本地时区（timeZone，如 Asia/Shanghai）。每日定时任务（daily at: HH:mm）以此时区为基准解释，客户端在同地区个人使用场景下无需做 UTC 转换。serviceVersion 为启动/构建时固定快照：version、commit、dirty、sourceHash、mode、builtAt；与 /openapi.json 的 x-service-version 及 /docs 一致。dirty=true 时不能只比较 commit，须核对 sourceHash；commit/dirty 无法核验时为 null。",
    auth: false, request: undefined, response: resp.healthResponse,
  },
  {
    operationId: "createSession",
    method: "post", path: "/api/session", tag: "基础", summary: "登录换取 Bearer token",
    hint: "一切 /api/* 调用的第一步；回环部署无密钥时空 body 即可。",
    auth: false, request: req.sessionRequestSchema, response: resp.sessionResponse,
  },
  {
    operationId: "listSpaces",
    method: "get", path: "/api/spaces", tag: "空间", summary: "列出空间（按活跃倒序）",
    hint: "多空间入口：先取列表再选 spaceId 聊天；新空间无需显式创建（run、规则/技能保存或显式来源绑定时建立）。历史 GET 和迟到 Stop 不会建立空间。",
    auth: true, response: resp.spacesResponse,
  },
  {
    operationId: "resetSpace",
    method: "post", path: "/api/spaces/:spaceId/reset", tag: "空间", summary: "重置空间会话（更换 session ID，清空会话历史并作废待审批，保留工作区与规则）",
    hint: "清空当前空间的会话聊天历史并生成全新 session ID，同时清理该空间全部消息反馈事件；当前空间的私有工作区文件、INSTRUCTIONS.md、技能开关与 Dream 配置均完整保留。若存在正在进行的运行或待审批操作，均安全取消；可选传入 clearSchedules: true 同时清理该空间绑定的定时任务与网页监控，默认 false 保留并转绑到新会话。",
    auth: true, request: req.resetSpaceSchema, response: resp.resetSpaceResponse,
  },
  {
    operationId: "getConversation",
    method: "get", path: "/api/conversation", tag: "空间", summary: "读取会话权威历史",
    hint: "刷新/恢复时同步历史用；历史只读，客户端不要回写。合法但不存在、已删除或正在删除的 ID 返回 200 {sessionId:null, messages:[], revision:'empty'}，不创建会话或工作区，不使其出现在列表；非法 ID 返回 400。空历史不代表空间存在，存在性以 GET /api/spaces 为准。消息含工具投影（toolCalls 与 role=tool 消息按 toolCallId 关联）；user/assistant 消息必带 metadata（PI entry 时间、chat/job/notification 可靠来源、run/job/notification 关联与 feedbackAvailable）和当前 feedback。role=user 还可有 attachments；每项为 id/name/kind/mimeType/size/sha256，kind=image 还可带 image:{mimeType,dataBase64} 并按本条 SDK user 的 image blocks 顺序关联，文本正文不自动展开。文件/模型原始错误在进入模型上下文与历史前脱敏，文件缺失使用受控提示，不返回服务端绝对路径。",
    auth: true, query: conversationQuery, response: resp.conversationResponse,
  },
  // ---- 消息反馈（独立业务层；不触发模型，不修改 PI 历史）----
  {
    operationId: "getMessageFeedback",
    method: "get", path: "/api/spaces/:spaceId/messages/:messageId/feedback", tag: "消息反馈",
    summary: "读取消息当前反馈",
    hint:
      "按 spaceId+sessionId+messageId 读取用户/助手消息的当前喜欢/不喜欢与全部评论。sessionId 必填；" +
      "reset 后旧 sessionId 返回 409。空间不存在返回 404，非法参数返回 400。工具结果和未落盘/当前生成中的消息不可反馈，按目标不存在返回 404。本接口不触发模型、不追加聊天消息，也不改变对话 revision。",
    auth: true, query: message.messageTargetSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法 spaceId、messageId 或 sessionId", schema: resp.errorResponse },
      404: { description: "空间或可反馈消息不存在", schema: resp.errorResponse },
      409: { description: "sessionId 不是该空间当前会话，或空间正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "listMessageFeedbackEvents",
    method: "get", path: "/api/spaces/:spaceId/messages/:messageId/feedback/events", tag: "消息反馈",
    summary: "读取消息原始反馈事件",
    hint:
      "返回该消息的完整操作历史：reaction 变更/撤销、评论新增、编辑（旧新文本）与删除（删除前文本），均带服务端时间与 ID。事件只追加到 Pi Muse 反馈存储，不进入 PI branch 或模型上下文；空间 reset/delete 级联删除。",
    auth: true, query: message.messageTargetSchema, response: message.messageFeedbackEventsResponse,
    errorResponses: {
      400: { description: "非法 spaceId、messageId 或 sessionId", schema: resp.errorResponse },
      404: { description: "空间或可反馈消息不存在", schema: resp.errorResponse },
      409: { description: "sessionId 不是该空间当前会话，或空间正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "setMessageReaction",
    method: "put", path: "/api/spaces/:spaceId/messages/:messageId/feedback/reaction", tag: "消息反馈",
    summary: "设置或撤销喜欢/不喜欢",
    hint:
      "reaction 为 like/dislike/null；like 与 dislike 互斥，null 撤销当前反应。重复设置当前值不追加事件。成功返回完整当前反馈。反馈不触发模型、不追加聊天消息，也不改变 expectedRevision；同一空间内以前已落盘消息可在流式运行期间反馈。",
    auth: true, request: message.reactionRequestSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法请求、reaction 或目标 ID", schema: resp.errorResponse },
      404: { description: "空间、消息或评论不存在；工具/未落盘/当前生成中目标不可反馈", schema: resp.errorResponse },
      409: { description: "sessionId 不是该空间当前会话，或空间正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "addMessageComment",
    method: "post", path: "/api/spaces/:spaceId/messages/:messageId/feedback/comments", tag: "消息反馈",
    summary: "新增消息评论",
    hint:
      "text 先 trim，必须非空且最多 4000 字符。支持多条评论；ID 与 createdAt/updatedAt 由服务端生成。成功返回完整当前反馈。",
    auth: true, request: message.createCommentRequestSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法请求、sessionId、messageId 或空/超长评论", schema: resp.errorResponse },
      404: { description: "空间或可反馈消息不存在", schema: resp.errorResponse },
      409: { description: "sessionId 不是该空间当前会话，或空间正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "editMessageComment",
    method: "patch", path: "/api/spaces/:spaceId/messages/:messageId/feedback/comments/:commentId", tag: "消息反馈",
    summary: "编辑消息评论",
    hint:
      "text 先 trim，必须非空且最多 4000 字符。成功返回完整当前反馈；原始事件保留编辑前后文本。相同文本不追加事件；评论不存在返回 404。",
    auth: true, request: message.updateCommentRequestSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法请求或空/超长评论", schema: resp.errorResponse },
      404: { description: "空间、消息或评论不存在", schema: resp.errorResponse },
      409: { description: "sessionId 不是该空间当前会话，或空间正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "deleteMessageComment",
    method: "delete", path: "/api/spaces/:spaceId/messages/:messageId/feedback/comments/:commentId", tag: "消息反馈",
    summary: "删除消息评论",
    hint:
      "删除当前评论并保留删除前文本的原始事件；重复删除返回 404，不冒充成功。sessionId 为查询参数。成功返回完整当前反馈。",
    auth: true, query: message.messageTargetSchema, response: message.messageFeedbackResponse,
    errorResponses: {
      400: { description: "非法目标 ID 或 sessionId", schema: resp.errorResponse },
      404: { description: "空间、消息或评论不存在", schema: resp.errorResponse },
      409: { description: "sessionId 不是该空间当前会话，或空间正在删除", schema: resp.errorResponse },
      503: { description: "服务正在关闭；本次反馈未保存", schema: resp.errorResponse },
    },
  },
  {
    operationId: "getSpaceSkills",
    method: "get", path: "/api/spaces/:spaceId/skills", tag: "空间", summary: "读取空间技能开关",
    hint: "返回全部技能的默认状态与当前空间的生效状态。",
    auth: true, response: resp.skillsResponse,
  },
  {
    operationId: "updateSpaceSkills",
    method: "put", path: "/api/spaces/:spaceId/skills", tag: "空间", summary: "保存空间技能开关",
    hint: "整份替换覆盖表；未知技能名返回 400。显式保存可建立新空间；删除进行中返回 409 SPACE_DELETING，刷新列表后由用户重新选择，不自动重试旧 ID。",
    auth: true, request: req.updateSkillsSchema, response: resp.skillsResponse,
  },
  {
    operationId: "deleteSpace",
    method: "delete", path: "/api/spaces/:spaceId", tag: "空间", summary: "删除空间（不可删除主空间）",
    hint: "不可删除 local-main（409）；关闭旧空间并取消其当前轮，级联删除该空间名下的定时任务与监控，取消其排队/运行中后台任务。删除等待已接纳的来源绑定与规则/技能写入完成后清理，期间同 ID 的写操作/来源绑定返回 409 SPACE_DELETING，不自动重试。迟到历史 GET/Stop 不重建空间；已完成任务的迟到通知不改投主空间或新同名空间，结果仍可读任务详情。成功后客户端取消本地请求、屏蔽迟到结果并刷新 spaces/agent 与工作区通知流。删除非事务，失败不承诺回滚；404 表示不存在且无活跃绑定。删除成功后显式 run/规则/技能保存或来源绑定可建立全新同名空间，不恢复旧历史。",
    auth: true, response: resp.deleteSpaceResponse,
  },
  {
    operationId: "getSpaceInstructions",
    method: "get", path: "/api/spaces/:spaceId/instructions", tag: "空间", summary: "读取空间专属规则",
    hint: "读取当前空间的 INSTRUCTIONS.md 内容；未设置时返回空串。",
    auth: true, response: resp.instructionsResponse,
  },
  {
    operationId: "updateSpaceInstructions",
    method: "put", path: "/api/spaces/:spaceId/instructions", tag: "空间", summary: "保存空间专属规则",
    hint: "下一轮对话开始时注入生效；传空串等于清空。可选传入 purpose 声明空间用途（自动在开头生成 `## 空间用途` 段落，供 Dream 后台整理判定本空间专属规则归属；Dream 整理轮禁止修改该段落）。显式保存可建立新空间；删除进行中返回 409 SPACE_DELETING，刷新列表后由用户重新选择，不自动重试旧 ID。",
    auth: true, request: req.saveInstructionsSchema, response: resp.instructionsResponse,
  },
  {
    operationId: "getSpaceDream",
    method: "get", path: "/api/spaces/:spaceId/dream", tag: "空间", summary: "读取空间 Dream 整理状态与配置",
    hint: "纯只读查询：返回该空间的 Dream 开关、是否继承全局提示词、已整理游标、最近一次运行结果、待决建议列表、空间补充提示词（DREAM.md）及 `## 空间用途`。文件不存在时返回默认值（local-main 默认开启，其余空间默认关闭），不创建任何目录或文件。",
    auth: true, response: resp.dreamSpaceResponse,
  },
  {
    operationId: "updateSpaceDream",
    method: "put", path: "/api/spaces/:spaceId/dream", tag: "空间", summary: "保存空间 Dream 开关与补充提示词",
    hint: "按字段更新该空间的 Dream 开关（enabled）、是否继承全局提示词（inheritGlobalPrompt）或空间补充提示词（prompt，写入 sessions/<spaceId>/DREAM.md；空串清空）。显式保存可建立新空间；删除进行中返回 409 SPACE_DELETING。",
    auth: true, request: req.updateSpaceDreamSchema, response: resp.dreamSpaceResponse,
  },
  {
    operationId: "runSpaceDream",
    method: "post", path: "/api/spaces/:spaceId/dream/run", tag: "空间", summary: "立即执行当前空间的 Dream 记忆整理",
    hint: "不受 2 小时周期限制，立即对该空间自上次 cursor 以来的新消息（带约 4k token 重叠上下文）运行受限整理轮：全局稳定用户信息写入 USER.md、全局助手约定写入 SOUL.md、符合本空间 `## 空间用途` 的规则写入 INSTRUCTIONS.md、按需检索事实写入 memory.json；拿不准或非主空间提出的全局建议进入 pending。整轮成功后才推进 cursor；并发修改的目标跳过覆盖并记为 partial/failed。空间不存在返回 404，空间正在对话或已有 Dream 运行中返回 409。",
    auth: true, response: resp.dreamSpaceResponse,
  },
  {
    operationId: "resolveSpaceDreamPending",
    method: "post", path: "/api/spaces/:spaceId/dream/pending/:pendingId", tag: "空间", summary: "处理空间 Dream 待决建议（应用或忽略）",
    hint: "action=apply 将该条待决建议写入 target（省略时采用 suggestedTarget）对应的存储（USER.md / SOUL.md / 本空间 INSTRUCTIONS.md / memory.json）并从 pending 移除；action=dismiss 直接移除不写入。空间或 pendingId 不存在返回 404；记忆达到 500 条上限或空间正在删除返回 409。",
    auth: true, request: req.resolveDreamPendingSchema, response: resp.dreamSpaceResponse,
  },
  // ---- 增量聊天（AG-UI SSE 输出）----
  {
    operationId: "runConversation",
    method: "post", path: "/api/conversation/run", tag: "空间", summary: "提交一条用户消息（SSE 流）",
    hint: `提交 message 和 expectedRevision；版本冲突 409 后重新读取历史。首次合法 ID 建立新空间；删除进行中返回 409 SPACE_DELETING，客户端不自动重试旧 ID。事件顺序：${SSE_EVENT_ORDER}。` +
      "message.attachments 最多 4 项，随本条消息一次性提交：PNG/JPEG/GIF/WebP 单图最大 8MiB，全部原始字节合计最大 8MiB，严格 UTF-8 文本合计最大 100000 字节；请求体上限 12MiB，超限在 SSE/历史/模型开始前返回 413 REQUEST_TOO_LARGE。图片需要当前单业务模型支持视觉，服务端不自动换模型、不静默丢图；PDF/Office/压缩包及其他二进制拒绝，SVG/HTML 只按不可信文本处理。completed 重放或失败显式重试必须保持附件顺序与字节 SHA-256 身份一致。" +
      "主模型可在本轮调用 subagent 工具（官方 pi 1.3.0 示例适配），子会话返回结果后主模型继续；这不是独立后台任务队列，不提供创建子任务的 HTTP 接口。" +
      "工具参数为单个 {agent,task}、并行 {tasks:[{agent,task}]} 或链式 {chain:[{agent,task}]} 三选一；最多8项，最多4个子会话并发，链式用 {previous} 引用上一步结果，失败即停止。" +
      "subagent 的客户端卡片按 tools.presentation 的 hidden/summary 策略显示，参数正文不透出；父 SSE 不直接嵌套子会话聊天流或暴露原始工具详情。" +
      "子会话上下文与私有目录独立，通过 shared/... 显式共享；写入仍逐次审批，审批 spaceId/runId 绑定父运行。Stop、父超时、删除空间和聊天流断开会同时取消并等待子会话清理；不会在服务重启后自动续跑。",
    auth: true, request: req.runRequestSchema, response: z.object({}).describe("SSE 流"),
    errorResponses: {
      400: { description: "非法消息、附件或空间 ID；未创建可见用户轮", schema: resp.errorResponse },
      409: { description: "历史版本、运行或消息身份冲突，空间正删除或会话正忙；重新核对，不自动重发", schema: resp.errorResponse },
      413: { description: "run JSON 请求体超过 12MiB；SSE、历史与模型均未开始", schema: resp.errorResponse },
      503: { description: "模型未配置或服务正关闭；本次消息未接纳", schema: resp.errorResponse },
    },
    sse: {
      description: "AG-UI 事件流（text/event-stream，每帧 data: <JSON>）",
      events: sseEvents,
    },
  },
  {
    operationId: "stopConversation",
    method: "post", path: "/api/conversation/stop", tag: "空间", summary: "停止指定运行",
    hint: "spaceId/runId 必须同时匹配当前轮；迟到 Stop 返回 false，不影响下一轮。不存在或正在删除的空间返回 {stopped:false}，不建立空间或工作区。",
    auth: true, request: req.stopRequestSchema, response: z.object({ stopped: z.boolean() }),
  },
  // ---- 工作区文件（手动管理；模型写入仍走审批工具）----
  {
    operationId: "listWorkspaceFiles",
    method: "get", path: "/api/workspace/files", tag: "工作区文件", summary: "列出工作区文件目录",
    hint: "必须显式选择 scope=space 或 shared；scope=space 时 spaceId 必填且只允许已有合法空间，本接口不隐式创建空间或目录，根目录缺失时返回空列表。path 相对所选根，默认 `.`。返回目录优先、名称升序；目录超过 1000 项返回 413，不截断。符号链接与特殊文件不返回，也不跟随 shared/ 前缀别名。",
    auth: true, query: files.workspaceListQuerySchema, response: files.workspaceListResponse,
    errorResponses: {
      400: { description: "非法选择器/路径或目录不是普通目录", schema: resp.errorResponse },
      404: { description: "空间或目录不存在", schema: resp.errorResponse },
      413: { description: "目录超过 1000 项", schema: resp.errorResponse },
    },
  },
  {
    operationId: "readWorkspaceFile",
    method: "get", path: "/api/workspace/files/content", tag: "工作区文件", summary: "完整打开或下载工作区文件",
    hint: "读取现存普通文件，最大 8388608 字节，超过返回 413。kind=text 要求严格 UTF-8 且无 NUL，返回完整 content；PNG/JPEG/GIF/WebP 仅在魔数确认后返回 image，其余为 binary；image/binary 返回 dataBase64 与 mimeType。SVG/HTML 按文本原样返回，客户端必须按不可信文本展示而非执行。路径逐段拒绝符号链接，不透出绝对路径。",
    auth: true, query: files.workspaceContentQuerySchema, response: files.workspaceContentResponse,
    errorResponses: {
      400: { description: "非法路径、目标是目录/符号链接或非普通文件", schema: resp.errorResponse },
      404: { description: "空间或文件不存在", schema: resp.errorResponse },
      413: { description: "文件超过下载上限", schema: resp.errorResponse },
    },
  },
  {
    operationId: "createWorkspaceTextFile",
    method: "post", path: "/api/workspace/files/text", tag: "工作区文件", summary: "手动新建文本文件",
    hint: "调用前客户端必须向用户展示完整新内容并获得明确确认，confirmed:true 只表达这个已完成的确认，不创建 preview token、版本协议或服务端审批记录。仅新建；目标存在返回 409。content 最大 100000 UTF-8 字节、必须无 NUL 且是有效 Unicode；路径每段仅允许 ASCII 字母/数字/./-/_。scope=space 必须是已有空间，不会隐式创建空间。成功返回实际写入后的完整文本详情。",
    auth: true, request: files.workspaceCreateTextSchema, response: files.workspaceTextWriteResponse,
    errorResponses: {
      400: { description: "未显式确认、非法路径/文本或路径不安全", schema: resp.errorResponse },
      404: { description: "空间不存在", schema: resp.errorResponse },
      409: { description: "目标文件已存在", schema: resp.errorResponse },
      413: { description: "文本超过 100000 字节", schema: resp.errorResponse },
    },
  },
  {
    operationId: "updateWorkspaceTextFile",
    method: "put", path: "/api/workspace/files/text", tag: "工作区文件", summary: "手动保存文本文件",
    hint: "调用前客户端必须向用户展示完整 before/after 并获得明确确认；confirmed:true 表达该确认。仅更新已存在普通文本文件，缺失返回 404。content 最大 100000 UTF-8 字节、必须无 NUL 且是有效 Unicode；路径每段仅允许 ASCII 字母/数字/./-/_。服务端用同目录临时文件提交，不截断旧文件；最后一次成功保存生效，不提供版本冲突协议或自动重试。成功返回实际写入后的完整文本详情。手动保存后，旧 pending 模型审批因基准版本变化不能覆盖。",
    auth: true, request: files.workspaceUpdateTextSchema, response: files.workspaceTextWriteResponse,
    errorResponses: {
      400: { description: "未显式确认、非法路径/文本或路径不安全", schema: resp.errorResponse },
      404: { description: "空间或文件不存在", schema: resp.errorResponse },
      409: { description: "提交后无法读回结果", schema: resp.errorResponse },
      413: { description: "文本超过 100000 字节", schema: resp.errorResponse },
    },
  },
  {
    operationId: "deleteWorkspaceFile",
    method: "delete", path: "/api/workspace/files", tag: "工作区文件", summary: "删除工作区普通文件",
    hint: "仅删除现存普通文件；目录、符号链接与特殊文件拒绝，不提供目录删除、重命名、回收站或版本树。scope=space 必须是已有空间。成功返回 ok:true 与选择器/path。",
    auth: true, query: files.workspaceDeleteQuerySchema, response: files.workspaceDeleteResponse,
    errorResponses: {
      400: { description: "非法路径、目标是目录/符号链接或非普通文件", schema: resp.errorResponse },
      404: { description: "空间或文件不存在", schema: resp.errorResponse },
    },
  },
  // ---- 人设 ----
  {
    operationId: "getProfile",
    method: "get", path: "/api/profile", tag: "人设", summary: "读取 SOUL/USER 人设文本",
    hint: "读取全局 profile/SOUL.md（助手灵魂与人设定位）与 profile/USER.md（用户画像与背景偏好）的自由文本内容；未设置或文件不存在时对应字段返回空串，不创建任何文件。如需编辑人设，通过 PUT /api/profile 保存。",
    auth: true, response: resp.profileResponse,
  },
  {
    operationId: "updateProfile",
    method: "put", path: "/api/profile", tag: "人设", summary: "保存 SOUL/USER 人设",
    hint: "下一轮对话注入生效；传空串等于清空该段人设。",
    auth: true, request: req.saveProfileSchema, response: resp.profileResponse,
  },
  // ---- 工作区快照 ----
  {
    operationId: "getAgentSnapshot",
    method: "get", path: "/api/agent", tag: "快照", summary: "全量工作区快照",
    hint:
      "工作台首屏读取身份设置；定时任务已迁移至独立 /api/jobs 接口，网页监控已迁移至独立 /api/monitors 接口，长期记忆已迁移至独立 /api/memories 接口，长期目标已迁移至独立 /api/goals 接口，快照中不再包含 tasks、monitors、memories 与 goals 字段。不提供 POST /api/agent/tasks 创建入口；旧调用按未知 API 返回501。" +
      "subagent 是主模型的一次工具调用，不会产生任务记录，结果回到来源聊天；旧 tasks.json 不读取或执行。" +
      "审批横幅由 GET /api/events 的 ready.pendingApprovals 与 approval_pending 事件同步，不在此快照中；旧审批列表接口已下线。",
    auth: true, response: resp.agentSnapshot,
  },
  // ---- 执行活动（只读；登记与推进由对话工具完成）----
  {
    operationId: "listActivities",
    method: "get", path: "/api/activities", tag: "活动", summary: "列出执行活动（按创建时间倒序分页）",
    hint:
      "执行活动是主模型在决定开始推进用户交办的工作时通过对话工具显式登记的记录，不是每轮消息自动生成，" +
      "也不是后端解析回复或按关键词/工具次数机械分类；普通交流、解释、澄清和简单查询通常没有记录。" +
      "本接口只读：没有创建/更新/完成活动的 HTTP 写入口，活动的登记、进展、等待与完成只能由对话工具在真实执行中产生；" +
      "步骤是工具、模型、子代理、审批与文件提交等真实执行事件的安全投影，不含模型内部思维、凭据、原始工具参数或未脱敏日志。" +
      "排序为 createdAt 降序、同一时间按 id 降序；limit 默认 20、范围 1–100。" +
      "cursor 是上一页返回的不透明 base64url，原样回传即可；它绑定生成时的 spaceId/status 过滤条件，改变过滤后必须从第一页重新开始。" +
      "严格校验：未声明参数、重复参数、非法 limit、非法游标（结构/时间/过滤不匹配）一律 400。" +
      "分页不冻结：每次请求读取当前投影，执行中的状态与步骤会更新，期间新增活动只可能出现在第一页，已读页不保证与首次读取一致。" +
      "completed 表示主模型已明确声明完成且结果已交付；单次工具结束、子代理返回或一轮回复结束都不会自动完成。" +
      "awaiting_continuation 表示本轮结束但工作未完成，需用户明确要求继续；继续同一工作时更新原活动（runIds 追加新 run），不新建活动。" +
      "活动随来源空间删除而删除；本接口不新增 SSE 事件，状态变化由客户端重新读取本接口获取。",
    auth: true, query: activity.activitiesQuerySchema, response: activity.activitiesResponse,
  },
  {
    operationId: "getActivity",
    method: "get", path: "/api/activities/:id", tag: "活动", summary: "读取活动详情（概览＋逐步明细）",
    hint:
      "返回 activity 概览与 steps 逐步明细；steps 按真实执行顺序，失败、拒绝、取消、过期与中断如实保留，" +
      "是安全投影而非原始工具载荷或模型思维。只读，不提供修改/完成入口；活动不存在或来源空间已删除返回 404。" +
      "本接口不新增 SSE 事件，客户端在收到工作区通知或用户操作后重新读取。",
    auth: true, response: activity.activityDetailResponse,
  },
  // ---- 定时任务（Jobs）----
  {
    operationId: "listJobs",
    method: "get", path: "/api/jobs", tag: "任务", summary: "查询定时任务列表",
    hint:
      "按条件查询定时任务列表。支持按 spaceId 过滤与排序，全量返回不分页。时区规则：每日任务（daily=true）设定时刻 at 为 HH:mm，按服务端本地时区（GET /api/health.timeZone）解释；下一次运行时刻 nextRunAt 统一以带 Z 的 ISO 8601 UTC 字符串返回，前端通过 new Date(nextRunAt) 即可自动转为本地时间展示。",
    auth: true, query: req.jobsQuerySchema, response: resp.jobsResponse,
  },
  {
    operationId: "getJob",
    method: "get", path: "/api/jobs/:id", tag: "任务", summary: "定时任务详情（含时间线）",
    hint:
      "读取指定定时任务的详细信息及操作/运行时间线；任务不存在返回 404。",
    auth: true, response: resp.jobDetail,
  },
  {
    operationId: "controlJob",
    method: "post", path: "/api/jobs/:id/control", tag: "任务", summary: "控制定时任务（pause/resume/cancel/retry）",
    hint:
      "对定时任务执行生命周期操作：pause=暂停调度，resume=恢复调度，cancel=取消任务，retry=失败任务立即重试。pause 只影响后续调度，不中止正在执行的一轮。",
    auth: true, request: req.jobControlSchema, response: resp.jobItem,
  },
  {
    operationId: "updateJob",
    method: "patch", path: "/api/jobs/:id", tag: "任务", summary: "修改定时任务",
    hint:
      "修改定时任务的提示词（prompt）、执行周期与时刻（daily、at）或归属空间（originSpaceId）。时刻设定规则：daily=true 时 at 必须为严格两位 HH:mm（00:00 至 23:59，前导零不可省略），按服务端本地时区解释，前端无需换算；daily=false 时 at 必须为带时区偏移的完整 ISO 8601 时间戳。非法日程返回 400 INVALID_SCHEDULE_FORMAT，不自动进位、不写入；合法日程按服务端本地时区计算并保存。修改时刻且任务处于调度中时，将自动重算下次触发时刻 nextRunAt（ISO 8601 UTC）。任务不存在返回 404。originSpaceId 省略时保留原绑定（不改投主空间也不创建新空间）；显式改绑新 ID 时在接纳前先建立目标空间，并与目标空间的删除串行协调。目标空间正在删除中返回 409 SPACE_DELETING，客户端不自动重试旧 ID；改绑成功后随新空间删除级联清理，来源删除后绝不改投主空间，目录不复活。",
    auth: true, request: req.updateJobSchema, response: resp.jobItem,
  },
  {
    operationId: "deleteJob",
    method: "delete", path: "/api/jobs/:id", tag: "任务", summary: "删除定时任务",
    hint:
      "彻底删除指定的定时任务；任务不存在返回 404。",
    auth: true, response: resp.deleteJobResponse,
  },
  // ---- 长期记忆（Memories）----
  {
    operationId: "listMemories",
    method: "get", path: "/api/memories", tag: "记忆", summary: "查询或检索长期记忆列表",
    hint: "独立读取 memory.json 中的长期记忆，不依赖工作区大汇总且不广播 SSE。记忆现作为沉淀库按需检索，不再全量拼入每轮 system prompt；可选传入 q（按关键词忽略大小写子串匹配）、limit 及 sort/order（默认按 updatedAt 倒序），省略 q 时返回全部条目。未声明或重复查询参数返回 400。",
    auth: true, query: req.memoriesQuerySchema, response: resp.memoriesResponse,
  },
  {
    operationId: "getMemory",
    method: "get", path: "/api/memories/:id", tag: "记忆", summary: "读取单条记忆详情",
    hint: "读取指定 ID 的长期记忆条目；条目不存在返回 404。",
    auth: true, response: resp.memoryItem,
  },
  {
    operationId: "createMemory",
    method: "post", path: "/api/memories", tag: "记忆", summary: "新增记忆",
    hint: "显式新增一条长期记忆；上限 500 条，满额时返回 409 拒绝写入，绝不静默丢弃旧条目。",
    auth: true, request: req.createMemorySchema, response: resp.memoryItem,
  },
  {
    operationId: "updateMemory",
    method: "patch", path: "/api/memories/:id", tag: "记忆", summary: "修改记忆内容",
    hint: "修改指定 ID 记忆的文本内容，自动更新 updatedAt 时间戳；条目不存在返回 404。",
    auth: true, request: req.updateMemorySchema, response: resp.memoryItem,
  },
  {
    operationId: "deleteMemory",
    method: "delete", path: "/api/memories/:id", tag: "记忆", summary: "删除记忆",
    hint: "按条目 ID 精确删除；条目不存在返回 404。",
    auth: true, response: resp.deleteMemoryResponse,
  },
  {
    operationId: "getGlobalDream",
    method: "get", path: "/api/agent/dream", tag: "记忆", summary: "读取 Dream 后台记忆整理全局概览",
    hint: "返回全局 DREAM.md 提示词、内置默认提示词、固定 2 小时周期、当前是否有整理轮在运行，以及所有已知会话的 Dream 状态与待决建议汇总。",
    auth: true, response: resp.dreamOverviewResponse,
  },
  {
    operationId: "updateGlobalDream",
    method: "put", path: "/api/agent/dream", tag: "记忆", summary: "保存全局 Dream 整理提示词",
    hint: "保存 profile/DREAM.md；传空串清空自定义覆盖并回退为内置默认提示词。服务端安全硬规则固定拼入，不受此文件覆盖。",
    auth: true, request: req.saveGlobalDreamSchema, response: resp.dreamOverviewResponse,
  },
  {
    operationId: "saveIdentity",
    method: "post", path: "/api/agent/identity", tag: "人设", summary: "保存身份设置（名字/语气）",
    hint: "保存助手的全局展示身份设置，包括名字（name，注入每轮对话 prompt）、语气风格（tone: warm/concise/thoughtful）、头像标识（avatar）及是否在聊天中显示状态更新（showChatUpdates）。保存后立即生效并同步更新 GET /api/agent 快照。",
    auth: true, request: req.identitySchema, response: resp.identityView,
  },
  // ---- 目标 ----
  {
    operationId: "listGoals",
    method: "get", path: "/api/goals", tag: "目标", summary: "查询目标列表",
    hint: "独立读取 goals.json，支持 status、category 过滤以及 sort/order 排序（默认按 updatedAt 倒序）。全量返回目标列表，不分页。未声明或重复查询参数返回 400。",
    auth: true, query: req.goalsQuerySchema, response: resp.goalsResponse,
  },
  {
    operationId: "getGoal",
    method: "get", path: "/api/goals/:id", tag: "目标", summary: "读取单项目标详情",
    hint: "按 ID 查询目标详情及里程碑列表；目标不存在返回 404。",
    auth: true, response: resp.goalView,
  },
  {
    operationId: "createGoal",
    method: "post", path: "/api/goals", tag: "目标", summary: "创建目标（可含里程碑）",
    hint: "新建目标，初始状态为 active；active 目标每轮注入对话（标题+进度+下一里程碑），助手规划类回答会引用。",
    auth: true, request: req.createGoalSchema, response: resp.goalView,
  },
  {
    operationId: "updateGoal",
    method: "patch", path: "/api/goals/:id", tag: "目标", summary: "修改目标属性或状态",
    hint: "修改目标标题、描述、分类或状态；若更新为 completed，自动勾掉名下全部未完成里程碑；目标不存在返回 404。",
    auth: true, request: req.updateGoalSchema, response: resp.goalView,
  },
  {
    operationId: "toggleGoalMilestone",
    method: "post", path: "/api/goals/:id/milestones/:mid/toggle", tag: "目标", summary: "勾选/取消里程碑",
    hint: "切换指定里程碑的完成状态（done/doneAt）；全部勾完不自动完成目标（完成是用户的显式决定）；目标或里程碑不存在返回 404。",
    auth: true, response: resp.goalView,
  },
  {
    operationId: "deleteGoal",
    method: "delete", path: "/api/goals/:id", tag: "目标", summary: "删除目标",
    hint: "按目标 ID 彻底删除；目标不存在返回 404。",
    auth: true, response: resp.deleteGoalResponse,
  },
  // ---- 网页监控（Monitors）----
  {
    operationId: "listMonitors",
    method: "get", path: "/api/monitors", tag: "监控", summary: "查询网页监控列表",
    hint: "按条件查询网页监控列表。支持按 spaceId 过滤，支持按 createdAt、lastCheckedAt、status 排序（默认按 createdAt 降序），全量返回，不分页。",
    auth: true, query: req.monitorsQuerySchema, response: resp.monitorsResponse,
  },
  {
    operationId: "getMonitor",
    method: "get", path: "/api/monitors/:id", tag: "监控", summary: "网页监控详情",
    hint: "读取指定网页监控的配置与检查状态；监控项不存在返回 404。",
    auth: true, response: resp.monitorItem,
  },
  {
    operationId: "createMonitor",
    method: "post", path: "/api/monitors", tag: "监控", summary: "创建网页监控",
    hint: "创建网页周期监控。change=页面变化通知（首检建基线不通知）；contains=关键词命中通知。📡 结果投递 originSpaceId 指定来源，仅省略时投递 local-main。显式新 ID 在接纳前建立；删除中返回 409 SPACE_DELETING，客户端刷新列表后由用户重新选择，不自动重试。删除来源空间会删除绑定监控，旧扫描不重建空间或改投主空间。",
    auth: true, request: req.createMonitorSchema, response: resp.monitorItem,
  },
  {
    operationId: "controlMonitor",
    method: "post", path: "/api/monitors/:id/control", tag: "监控", summary: "控制监控（pause/resume/stop）",
    hint: "对网页监控执行状态控制：pause=暂停检查，resume=恢复检查，stop=停止监控（终态）。",
    auth: true, request: req.monitorControlSchema, response: resp.monitorItem,
  },
  {
    operationId: "updateMonitor",
    method: "patch", path: "/api/monitors/:id", tag: "监控", summary: "修改网页监控",
    hint: "修改网页监控的标题（title）、URL、触发条件（condition）、关键词（value）、检查间隔（intervalMinutes）或归属空间（originSpaceId）。若修改了 URL、触发条件或关键词，将自动重置内容指纹与命中基线。监控项不存在返回 404。",
    auth: true, request: req.updateMonitorSchema, response: resp.monitorItem,
  },
  {
    operationId: "deleteMonitor",
    method: "delete", path: "/api/monitors/:id", tag: "监控", summary: "删除网页监控",
    hint: "彻底删除指定的网页监控项；监控项不存在返回 404。",
    auth: true, response: resp.deleteMonitorResponse,
  },
  // ---- 审批 ----
  // 当前 pending 由 GET /api/events 的 ready/approval_pending 直接推送；HTTP 只负责历史读取与人的决定。
  {
    operationId: "listApprovals",
    method: "get", path: "/api/approvals", tag: "审批", summary: "读取已处理/失效审批摘要（分页，不含正文）",
    hint:
      "只返回已处理/失效审批的摘要，不含 preview 正文；当前 pending 不在此列表，由 GET /api/events 的 ready.pendingApprovals 与 approval_pending 事件同步。" +
      "按最近处理时间（resolvedAt）降序、同一时间按 id 降序；limit 默认 20、范围 1–100。" +
      "cursor 是上一页返回的不透明 base64url，原样回传即可；它绑定 status/spaceId/activityId 过滤，改变过滤后必须从第一页重新开始。结构非法、非规范编码或过滤不匹配返回 400。" +
      "严格校验：未声明参数、重复参数、非法 limit、非法游标一律 400。" +
      "分页不冻结：每次请求读取当前审批记录；历史与预览在登记后不可变，已处理/失效审批长期保留，不按时间或数量静默裁剪。" +
      "可按 status（approved/denied/expired/cancelled）、spaceId、activityId 过滤；pending 非法。execution=null 表示尚未观察到执行，不能当作成功。历史记录存在不代表授权仍有效；需要完整预览时读取 GET /api/approvals/:id。",
    auth: true, query: approval.approvalListQuery, response: approval.approvalPage,
    errorResponses: {
      400: { description: "查询参数或游标非法", schema: resp.errorResponse },
    },
  },
  {
    operationId: "listPendingApprovals",
    method: "get", path: "/api/approvals/pending", tag: "审批", summary: "补充读取当前待审批完整预览",
    hint: "只读返回未过期 pending；主要同步来源仍是 SSE ready.pendingApprovals 与 approval_pending，不要求客户端轮询。读取不写入决定、不执行文件操作。execution 为 null，不从授权推断成功。",
    auth: true, response: approval.pendingApprovalsResponse,
  },
  {
    operationId: "getApproval",
    method: "get", path: "/api/approvals/:id", tag: "审批", summary: "读取单个审批完整视图（含不可变预览）",
    hint:
      "返回完整审批视图，包含 title、kind 与 preview 全文；预览在登记时固定，不读取当前文件替换，也不截断。" +
      "pending 与历史审批都可用同一路径读取；不存在返回 404。execution 字段始终存在，null 表示尚未观察到执行，不代表成功；已回报的执行结果独立于人的决定。" +
      "scope=space 时 ownerSpaceId 指向文件归属的工作区空间（子代理发起仍归属 ownerSpaceId）；scope=shared 时为 null。" +
      "单项按 UTF-8 JSON 最大 1.5MB；所有 pending 累计最大 6MB 且最多 32 项；超限时服务端拒绝登记，不截断预览。",
    auth: true, response: approval.approvalView,
    errorResponses: {
      404: { description: "审批不存在", schema: resp.errorResponse },
    },
  },
  {
    operationId: "decideApproval",
    method: "post", path: "/api/approvals/:id/decision", tag: "审批", summary: "审批写操作（approve/deny）",
    hint:
      "模型调用 write/edit 时工具挂起等此决定：approve 才落盘，deny 返回受控拒绝。" +
      "批准只代表授权执行预览中绑定的这一次操作，不代表执行成功；实际结果以 execution 与真实工具、Activity 步骤为准。execution=null 表示尚未观察到执行。" +
      "只有 pending 状态可决定。相同决定的重复提交幂等返回 200 与原审批，revision 不变，不再次执行；" +
      "相反决定、已 expired 或 cancelled 返回 409，响应为 {error, approval: 当前完整审批视图}。" +
      "未知 id 返回 404，请求体非法返回 400，未鉴权由中间件返回 401。" +
      "expired 不是人的决定：status=expired、decidedAt=null，resolvedAt 记录失效时间；有效期由 expiresAt 决定（默认5分钟），后台每秒对齐过期状态，不清理历史。" +
      "执行开始与回执各推进 revision 并推送 approval_updated，但不改 decidedAt/resolvedAt；running 遗留在重启后标记 unknown，不重跑。",
    auth: true, request: approval.approvalDecisionRequest, response: approval.approvalView,
    errorResponses: {
      400: { description: "决定请求体非法（只接受 approve/deny）", schema: resp.errorResponse },
      404: { description: "审批不存在", schema: resp.errorResponse },
      409: {
        description: "审批已处于其他终态或已过期；返回当前完整审批视图",
        schema: z.object({
          error: z.string().describe("受控冲突文案；不包含预览正文或服务端路径"),
          approval: approval.approvalView.describe("当前审批完整视图，供客户端按 (id, revision) 更新本地状态"),
        }),
      },
    },
  },
  // ---- 运行状态（只读单 run 查询）----
  {
    operationId: "getAgentStatus",
    method: "get", path: "/api/agent/status", tag: "活动", summary: "查询单个运行的最新状态",
    hint:
      "只读查询指定 (spaceId, runId) 的最新运行状态，包含运行结束后的最终终态；不调用模型、不建立空间、不创建目录、不写 Activity 历史。" +
      "普通 chat 可能没有登记 Activity，此时 status.activityId 为 null，不是错误。" +
      "活动列表与详情查询保持不变，仍使用 GET /api/activities 与 GET /api/activities/:id。" +
      "响应为 {instanceId, status}：instanceId 标识产生该状态的服务实例，运行 revision 只在该实例内存内有效；" +
      "该 revision 与 GET /api/events 的 ready.agentStatuses / agent_status_updated 共用同一运行状态版本，" +
      "客户端按 revision 合并同一运行的状态，instanceId 变化后清空运行版本缓存。" +
      "spaceId 与 runId 都必填；缺失、重复或未声明参数返回 400，运行不存在或已被清理返回 404。",
    auth: true, query: status.agentStatusQuery, response: status.agentStatusResponse,
    errorResponses: {
      400: { description: "查询参数非法", schema: resp.errorResponse },
      404: { description: "运行状态不存在或已被清理", schema: resp.errorResponse },
    },
  },
  // ---- 工作区实时状态推送（独立命名 SSE，不与聊天流共用事件）----
  {
    operationId: "subscribeEvents",
    method: "get", path: "/api/events", tag: "通知", summary: "工作区实时状态推送流（SSE）",
    hint: WORKSPACE_SSE_DESCRIPTION,
    auth: true, response: z.object({}).describe("SSE 流"),
    sse: {
      // 流描述直接复用契约模块的单一事实源；事件表由 workspaceEvents 生成，
      // 四类事件（ready/agent_status_updated/approval_pending/approval_updated）直接携带可展示状态。
      description: WORKSPACE_SSE_DESCRIPTION,
      events: workspaceEvents,
    },
  },
  // ---- 真实浏览器 ----
  {
    operationId: "getBrowserDebugPage",
    method: "get", path: "/browser", tag: "浏览器", summary: "打开服务端自带浏览器调试页",
    hint: "免鉴权 HTML 页面。页面内先调用 POST /api/session 登录，再通过 REST 管理标签并换取一次性 WS ticket；URL 可加 ?accessKey=<workspace-access-key> 或 ?key=<workspace-access-key> 自动登录。该页面不是移动端产品，仅用于验证真实浏览器链路。",
    auth: false, response: browser.browserDebugResponse, responseContentType: "text/html",
  },
  {
    operationId: "listBrowserTabs",
    method: "get", path: "/api/browser/tabs", tag: "浏览器", summary: "列出真实浏览器标签",
    hint: "首次调用会懒启动系统 Chrome 并使用 DATA_DIR/browser/profile 持久 profile。返回全局标签列表；只有 active=true 的标签会推送帧。",
    auth: true, response: browser.browserTabsResponse,
  },
  {
    operationId: "createBrowserTab",
    method: "post", path: "/api/browser/tabs", tag: "浏览器", summary: "新建浏览器标签",
    hint: "可传初始 HTTP(S) URL；省略时打开 about:blank。私网目标默认被拒绝，需 tools.browser.allowPrivateTargets=true 才允许本机联调。",
    auth: true, request: browser.createBrowserTabSchema, response: browser.browserTab,
  },
  {
    operationId: "closeBrowserTab",
    method: "delete", path: "/api/browser/tabs/:tabId", tag: "浏览器", summary: "关闭浏览器标签",
    hint: "关闭指定标签；若关闭激活标签，剩余第一个标签会成为新的激活标签。标签不存在返回 404。",
    auth: true, response: browser.browserTabsResponse,
  },
  {
    operationId: "activateBrowserTab",
    method: "post", path: "/api/browser/tabs/:tabId/activate", tag: "浏览器", summary: "激活浏览器标签",
    hint: "全局只允许一个 active 标签。切换后旧标签停止 screencast，新标签在存在 WS 订阅者时重启 screencast。",
    auth: true, response: browser.browserTab,
  },
  {
    operationId: "navigateBrowserTab",
    method: "post", path: "/api/browser/tabs/:tabId/navigation", tag: "浏览器", summary: "导航、后退、前进或刷新",
    hint: "action=navigate 必须带 HTTP(S) url；back/forward/reload 不带 url。返回最新标签状态，页面标题和内容都是不可信外部数据。",
    auth: true, request: browser.browserNavigationSchema, response: browser.browserTab,
  },
  {
    operationId: "createBrowserWebSocketTicket",
    method: "post", path: "/api/browser/ws-ticket", tag: "浏览器", summary: "换取一次性浏览器 WS ticket",
    hint: "必须携带现有 Bearer token。返回的 ticket 60 秒过期且只能使用一次；WS 地址为 /ws/browser?ticket=...。完整二进制帧、ready/tabs/error、输入与 ack 协议见 OpenAPI 顶层 x-websocket-contracts.browser，OpenAPI 不把 WebSocket 伪装成普通 HTTP operation。",
    auth: true, response: browser.browserTicketResponse,
  },
];
