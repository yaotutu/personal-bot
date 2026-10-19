# HTTP 与聊天契约

端点唯一清单为 `src/http/contracts/endpoints.ts`，请求/响应/SSE schema 位于同目录。运行时 `/openapi.json` 自动生成 OpenAPI 3.1，`/docs` 提供 Scalar 页面，不维护手写 OpenAPI。完整接入规则以自动生成文档为准；本文仅作辅助说明，不承担关键规则的唯一来源。修改接口、工具报文或客户端接入时，必须遵守 [API 开发规范](api-development.md)。

## 聊天

1. `GET /api/conversation?threadId=local-main` 返回 `{messages, revision}`。不存在、已删除或正在删除的合法 ID 返回空历史/revision=`empty`，不创建目录或重新进入列表；会话存在性以 `GET /api/threads` 为准。
2. `POST /api/conversation/run` 提交 `{threadId, runId, expectedRevision, message:{id,content}}`，只提交一条用户消息，禁止全量历史/客户端工具输入。响应为 AG-UI SSE。
3. 相同成功 runId 和原消息幂等重放；其他请求必须匹配 revision，冲突返回 HTTP 409。失败轮可用原 message ID/内容和最新 revision 重试，且只能重试最后用户消息。
4. `POST /api/conversation/stop` 提交 `{threadId,runId}`，仅停止完全匹配的当前轮，等待取消及持久化完成；不匹配返回 `{stopped:false}`。断开 SSE 也取消所属轮。
5. UI 只以 RUN_FINISHED/RUN_ERROR 判断终态，每轮结束刷新权威历史。事件 schema 与 Web 联合类型同源，畸形事件及无终态断流明确失败。

## 工作台、任务和审批

- `/api/agent` 是定时任务/目标/监控/记忆/身份快照，不含审批正文或 worker 字段；tasks 仅返回 `kind: job`。详情为 `{task,events}`，控制必须指定 `target: job`；旧 POST `/api/agent/tasks` 不再提供，走未知 API 的 501，`target: task` 返回400。
- 监控仅省略 `originThreadId` 时默认主会话；显式新 ID 在接纳前建立会话，不因来源消失改投主会话。删除中的来源绑定/规则或技能保存返回409 `THREAD_DELETING`，客户端不自动重试旧ID。
- 删除等待已接纳的来源写入收尾再级联清理定时任务与监控；迟到 GET/Stop 不重建会话。删除成功后显式 run/规则或技能保存/监控来源绑定仍可建立全新同名会话；删除非事务，不承诺失败回滚。
- `subagent` 是主模型的工具调用，不是 REST 创建的后台任务。single/parallel/chain 三选一，最多8项、4并发，链式失败停止；子结果回到父模型，父聊天继续。父Stop、超时或断开聊天流会取消子会话，写入仍逐次审批且绑定父thread/run；不落 tasks.json 或子会话历史，不自动重试/续跑。完整接入与展示边界已生成到聊天 run 接口描述中。
- 审批查询与决定：`GET /api/approvals` 为已处理/失效审批历史摘要列表（分页，不含 preview）；`GET /api/approvals/:id` 返回单项完整详情（含不可变 preview 全文）。当前 pending 审批主要由 `/api/events` 推送，`GET /api/approvals/pending` 是补充只读入口。历史按 resolvedAt/id 倒序，游标绑定 status/threadId/activityId 过滤；不按时间或条数清理预览，不再使用已下线的 `/api/actions` 接口。
- `POST /api/approvals/:id/decision` 提交人工决定（`approve`/`deny`），只决定人的授权，批准不代表实际文件提交成功；实际结果以 execution、真实工具执行与 Activity 步骤为准；execution=null 不代表成功，重启遗留在途提交为 unknown，不补跑。相同决定的重复提交幂等返回原审批，相反决定、已过期或已取消返回 409（响应体带当前审批视图）。任何过期/取消/版本变化均不能复用授权。

## 部署版本与错误诊断

- `GET /api/health.serviceVersion` 与 `/openapi.json` 的 `x-service-version` 使用同一快照，Scalar 首页显示包版本、commit、dirty、sourceHash、mode、builtAt。`info.version` 为包版本加指纹前12位。
- `source` 模式进程启动时快照，`build` 模式使用构建时写入 `dist/service-version.json` 的快照；请求不执行 git。commit/dirty 无法取得时为 null，dirty=true 时不能把 commit 当作完整部署身份，须比较完整 sourceHash。
- sourceHash 仅覆盖源码、内置资源、脚本、包/锁文件及 TypeScript 配置，不读取实例配置、凭据或会话数据。构建产物脱离仓库后仍保留原身份。
- 文件不存在使用受控 `File not found.`；其余原始工具错误在模型上下文和 JSONL 持久化前替换为通用文案。技能诊断使用 `builtin/...` / `user/...` 逻辑路径，不要求前端替换服务端绝对路径。

## 工作区实时状态推送（GET /api/events）

`GET /api/events` 是独立命名的 SSE 流，直接承载可展示的最新状态（运行状态与待审批项），不与 AG-UI 聊天流复用事件命名空间。单向推送，不接收用户操作（操作走独立 HTTP 接口）。

- 鉴权：与其它 `/api/*` 相同，使用 `Authorization: Bearer <token>`；连接 `text/event-stream`，`Cache-Control: no-cache, no-transform`。
- 事件有四类，`data` 为单行 JSON 载荷：
  1. `event: ready`：首帧，提供完整当前集合，包含 `instanceId`、`serverTime`、`agentStatuses`（进行中运行快照，最多32项）与 `pendingApprovals`（当前待审批完整视图，最多32项）。
  2. `event: agent_status_updated`：单个运行最新状态快照（含 `instanceId`、`threadId`、`runId`、`revision`、`phase` 等），终态也会推送一次。
  3. `event: approval_pending`：新增待审批项完整视图（含 `id`、`revision: 1`、`title`、`kind` 与不可变 `preview` 全文）。
  4. `event: approval_updated`：审批进入终态（`approved`/`denied`/`expired`/`cancelled`）或执行回执变化后的轻量投影（revision 每次递增，含 execution、关联 ID 与时间，不含 preview/title）。
- 心跳：空闲时每 30 秒发送注释帧 `: keep-alive\n\n`。
- 协议约束：无事件 ID，忽略 `Last-Event-ID`，不支持重放；每次重连以首帧 `ready` 为全新同步边界，整体替换本地进行中与待审批集合。
- 运行状态查询：`GET /api/agent/status?threadId=...&runId=...` 返回 `{instanceId, status}`，可按指定运行只读查询最新/终态状态。
- 服务关闭 / 请求 abort / reader cancel / 订阅者抛错都会触发清理，订阅者从集合移除后不再收到通知。

所有 `/api/*` 业务端点使用 Bearer token，health/session 和文档基础设施除外。未知接口不提供历史兼容响应。非回环监听必须配置访问密钥。
