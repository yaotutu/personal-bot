# HTTP 与聊天契约

端点唯一清单为 `src/http/contracts/endpoints.ts`，请求/响应/SSE schema 位于同目录。运行时 `/openapi.json` 自动生成 OpenAPI 3.1，`/docs` 提供 Scalar 页面，不维护手写 OpenAPI。完整接入规则以自动生成文档为准；本文仅作辅助说明，不承担关键规则的唯一来源。修改接口、工具报文或客户端接入时，必须遵守 [API 开发规范](api-development.md)。

## 聊天

1. `GET /api/conversation?spaceId=local-main` 返回 `{messages, revision}`。不存在、已删除或正在删除的合法 ID 返回空历史/revision=`empty`，不创建目录或重新进入列表；空间存在性以 `GET /api/spaces` 为准。
2. `POST /api/conversation/run` 提交 `{spaceId, runId, expectedRevision, message:{id,content}}`，只提交一条用户消息，禁止全量历史/客户端工具输入。响应为 AG-UI SSE。
3. 相同成功 runId 和原消息幂等重放；其他请求必须匹配 revision，冲突返回 HTTP 409。失败轮可用原 message ID/内容和最新 revision 重试，且只能重试最后用户消息。
4. `POST /api/conversation/stop` 提交 `{spaceId,runId}`，仅停止完全匹配的当前轮，等待取消及持久化完成；不匹配返回 `{stopped:false}`。断开 SSE 也取消所属轮。
5. UI 只以 RUN_FINISHED/RUN_ERROR 判断终态，每轮结束刷新权威历史。事件 schema 与 Web 联合类型同源，畸形事件及无终态断流明确失败。

## 空间与业务领域 REST API

- **空间管理（Spaces）**：`GET /api/spaces` 列出所有空间信息（含 `spaceId`、`sessionId`、`title`、`createdAt` 等）；`DELETE /api/spaces/:spaceId` 级联删除空间历史、私有工作区、定时任务与监控；`POST /api/spaces/:spaceId/reset` 提供空间重置功能（清空当前会话历史、分配全新 `sessionId`、作废在途待审批，保留空间工作区、指令、技能与 Dream 配置，支持可选 `clearSchedules`）。前端迁移细节见 `docs/frontend-space-session-migration.md`。
- **工作台快照**：`GET /api/agent` 已彻底解耦，不再包含 jobs、monitors、memories 或 goals，仅返回助手身份信息 `{ identity }`。旧的 `/api/agent/tasks*`、`/api/agent/monitors*`、`/api/agent/memories*`、`/api/agent/goals*` 均已下线并返回 501。各业务领域通过独立顶级资源访问。
- **人设与身份（Profile & Identity）**：
  - `GET /api/profile`：读取全局 `profile/SOUL.md`（助手灵魂定位）与 `profile/USER.md`（用户偏好画像）自由文本内容；未设置时返回空串。
  - `PUT /api/profile`：保存全局人设文本，下一轮 prompt 注入生效；传空串清空。
  - `POST /api/agent/identity`：保存助手全局展示身份设置，包括名字（`name`，注入每轮对话）、语气（`tone: "warm" | "concise" | "thoughtful"`）、头像（`avatar`）及是否在聊天中显示状态更新（`showChatUpdates`）；保存后即时生效于快照。
- **空间规则与技能（Instructions & Skills）**：
  - `GET /api/spaces/:spaceId/instructions`：读取该空间专属规则 `INSTRUCTIONS.md`。
  - `PUT /api/spaces/:spaceId/instructions`：保存专属规则，可选传入 `purpose` 声明空间用途（自动维护 `## 空间用途` 段落供 Dream 自动归属识别）。
  - `GET /api/spaces/:spaceId/skills`：读取全部技能默认状态与当前空间生效状态。
  - `PUT /api/spaces/:spaceId/skills`：整份替换并保存该空间的技能覆盖表。
- **Dream 后台记忆整理（Dream Memory Consolidation）**：
  - 全局管理：`GET /api/agent/dream` 读取全局 Dream 配置、默认提示词及全空间整理状态概览；`PUT /api/agent/dream` 保存全局 `profile/DREAM.md` 提示词。
  - 空间配置：`GET /api/spaces/:spaceId/dream` 读取该空间整理开关、是否继承全局提示词、已处理游标、最近运行记录及待决建议；`PUT /api/spaces/:spaceId/dream` 保存该空间开关与专属提示词。
  - 即时触发与建议处理：`POST /api/spaces/:spaceId/dream/run` 立即启动受限整理轮（带 4k token 重叠上下文）；`POST /api/spaces/:spaceId/dream/pending/:pendingId` 处理待决建议（`action: "apply" | "dismiss"`，可选 `target: "user" | "soul" | "instructions" | "memory"`）。
- **执行活动（Activities）**：
  - `GET /api/activities`：查询执行活动列表（支持 `spaceId` 与 `status` 过滤，默认按 `createdAt` 降序分页，游标绑定过滤条件）。
  - `GET /api/activities/:id`：读取单项活动详情（包含概览与脱敏后的 `steps` 逐步真实执行明细）。
  - `POST /api/activities/:id/cancel`：安全取消正在推进中的执行活动。
- **定时任务（Jobs）**：`GET /api/jobs`（支持 `spaceId` 过滤，`sort: nextRunAt|updatedAt|createdAt` 与 `order: asc|desc` 排序，全量返回不分页）；`GET /api/jobs/:id` 获取详情；`POST /api/jobs` 创建；`PATCH /api/jobs/:id` 更新 prompt/周期；`POST /api/jobs/:id/control` 控制 `pause|resume|cancel|retry`；`DELETE /api/jobs/:id` 删除。
  - **时区与时刻设定说明**：
    1. **每日任务（`daily: true`）**：设定时刻 `at` 格式为 `HH:mm`（例如 `"09:00"`）。服务端直接按自身系统本地时区（可由 `GET /api/health` 的 `timeZone` 字段读取，如 `"Asia/Shanghai"`）解释该时间；在个人同地区使用场景下，前端直接透传用户选择的时分，**无需进行任何 UTC 时区转换**。
    2. **一次性任务（`daily: false`）**：设定时刻 `at` 必须为带时区偏移的完整 ISO 8601 时间戳（例如 `"2026-10-22T09:00:00+08:00"`），表示全局唯一绝对时刻。
    3. **下次运行时间（`nextRunAt`）**：无论每日任务还是一次性任务，服务端计算并返回的 `nextRunAt` 统一为标准 ISO 8601 UTC 字符串（带 `Z` 后缀，如 `"2026-10-22T01:00:00.000Z"`）。前端如需在界面展示下次执行时间，直接调用 `new Date(job.nextRunAt)` 即可自动转换为用户设备当前时区显示。
- **网页监控（Monitors）**：`GET /api/monitors`（支持 `spaceId` 过滤，`sort: createdAt|lastCheckedAt|status` 与 `order: asc|desc` 排序，全量返回不分页）；`GET /api/monitors/:id` 获取详情；`POST /api/monitors` 创建；`PATCH /api/monitors/:id` 更新属性与条件（条件变更自动重置内容基线）；`POST /api/monitors/:id/control` 控制 `pause|resume|stop`；`DELETE /api/monitors/:id` 删除。
- **长期记忆（Memories）**：`GET /api/memories`（支持关键词 `q` 忽略大小写子串搜索、`limit` 限制条数、`sort: updatedAt|createdAt` 与 `order: asc|desc` 排序，全量返回不分页，受 500 条上限保护）；`GET /api/memories/:id` 获取单条；`POST /api/memories` 创建；`PATCH /api/memories/:id` 更新内容；`DELETE /api/memories/:id` 删除。
- **目标管理（Goals）**：`GET /api/goals`（支持 `status` 与 `category` 过滤，`sort: updatedAt|createdAt` 与 `order: asc|desc` 排序，全量返回不分页）；`GET /api/goals/:id` 获取单条；`POST /api/goals` 创建；`PATCH /api/goals/:id` 更新属性与状态（设为 completed 时自动勾选所有里程碑）；`POST /api/goals/:id/milestones/:mid/toggle` 切换里程碑状态；`DELETE /api/goals/:id` 删除。
- `subagent` 是主模型的工具调用，不是 REST 创建的后台任务。single/parallel/chain 三选一，最多8项、4并发，链式失败停止；子结果回到父模型，父聊天继续。父Stop、超时或断开聊天流会取消子会话，写入仍逐次审批且绑定父thread/run；不落 tasks.json 或子会话历史，不自动重试/续跑。完整接入与展示边界已生成到聊天 run 接口描述中。
- 审批查询与决定：`GET /api/approvals` 为已处理/失效审批历史摘要列表（分页，不含 preview）；`GET /api/approvals/:id` 返回单项完整详情（含不可变 preview 全文）。当前 pending 审批主要由 `/api/events` 推送，`GET /api/approvals/pending` 是补充只读入口。历史按 resolvedAt/id 倒序，游标绑定 status/spaceId/activityId 过滤；不按时间或条数清理预览，不再使用已下线的 `/api/actions` 接口。
- `POST /api/approvals/:id/decision` 提交人工决定（`approve`/`deny`），只决定人的授权，批准不代表实际文件提交成功；实际结果以 execution、真实工具执行与 Activity 步骤为准；execution=null 不代表成功，重启遗留在途提交为 unknown，不补跑。相同决定的重复提交幂等返回原审批，相反决定、已过期或已取消返回 409（响应体带当前审批视图）。任何过期/取消/版本变化均不能复用授权。

## 部署版本与错误诊断

- `GET /api/health` 提供服务存活探测、模型配置状态、部署版本（`serviceVersion`）及服务端权威本地时区（`timeZone`，如 `"Asia/Shanghai"`）。每日任务（`daily: true`）以此时区为基准解析。
- `GET /api/health.serviceVersion` 与 `/openapi.json` 的 `x-service-version` 使用同一快照，Scalar 首页显示包版本、commit、dirty、sourceHash、mode、builtAt。`info.version` 为包版本加指纹前12位。
- `source` 模式进程启动时快照，`build` 模式使用构建时写入 `dist/service-version.json` 的快照；请求不执行 git。commit/dirty 无法取得时为 null，dirty=true 时不能把 commit 当作完整部署身份，须比较完整 sourceHash。
- sourceHash 仅覆盖源码、内置资源、脚本、包/锁文件及 TypeScript 配置，不读取实例配置、凭据或会话数据。构建产物脱离仓库后仍保留原身份。
- 文件不存在使用受控 `File not found.`；其余原始工具错误在模型上下文和 JSONL 持久化前替换为通用文案。技能诊断使用 `builtin/...` / `user/...` 逻辑路径，不要求前端替换服务端绝对路径。

## 工作区实时状态推送（GET /api/events）

`GET /api/events` 是独立命名的 SSE 流，直接承载可展示的最新状态（运行状态与待审批项），不与 AG-UI 聊天流复用事件命名空间。单向推送，不接收用户操作（操作走独立 HTTP 接口）。

- 鉴权：与其它 `/api/*` 相同，使用 `Authorization: Bearer <token>`；连接 `text/event-stream`，`Cache-Control: no-cache, no-transform`。
- 事件有四类，`data` 为单行 JSON 载荷：
  1. `event: ready`：首帧，提供完整当前集合，包含 `instanceId`、`serverTime`、`agentStatuses`（进行中运行快照，最多32项）、`pendingApprovals`（当前待审批完整视图，最多32项）与 `activities`（在途活跃活动）。
  2. `event: agent_status_updated`：单个运行最新状态快照（含 `instanceId`、`spaceId`、`runId`、`revision`、`phase` 等），终态也会推送一次。
  3. `event: approval_pending`：新增待审批项完整视图（含 `id`、`revision: 1`、`title`、`kind` 与不可变 `preview` 全文）。
  4. `event: approval_updated`：审批进入终态（`approved`/`denied`/`expired`/`cancelled`）或执行回执变化后的轻量投影（revision 每次递增，含 execution、关联 ID 与时间，不含 preview/title）。
  5. `event: activity_updated`：执行活动状态变更增量事件（含 `id`、`spaceId`、`status`、`title`、`result` 等），终态推送后客户端自动更新本地活动面板。
- 心跳：空闲时每 30 秒发送注释帧 `: keep-alive\n\n`。
- 协议约束：无事件 ID，忽略 `Last-Event-ID`，不支持重放；每次重连以首帧 `ready` 为全新同步边界，整体替换本地进行中与待审批集合。
- 运行状态查询：`GET /api/agent/status?spaceId=...&runId=...` 返回 `{instanceId, status}`，可按指定运行只读查询最新/终态状态。
- 服务关闭 / 请求 abort / reader cancel / 订阅者抛错都会触发清理，订阅者从集合移除后不再收到通知。

所有 `/api/*` 业务端点使用 Bearer token，health/session 和文档基础设施除外。未知接口不提供历史兼容响应。非回环监听必须配置访问密钥。
