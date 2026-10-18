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
- `GET /api/actions/pending` 仅返回当前未过期 pending 的完整预览；`GET /api/actions` 仅摘要；`GET /api/actions/:id` 返回单项完整详情。
- `POST /api/actions/:id/decide` 只决定人的批准/拒绝，批准不代表实际文件提交成功；实际结果看工具执行。任何过期/取消/版本变化均不能复用授权。

## 部署版本与错误诊断

- `GET /api/health.serviceVersion` 与 `/openapi.json` 的 `x-service-version` 使用同一快照，Scalar 首页显示包版本、commit、dirty、sourceHash、mode、builtAt。`info.version` 为包版本加指纹前12位。
- `source` 模式进程启动时快照，`build` 模式使用构建时写入 `dist/service-version.json` 的快照；请求不执行 git。commit/dirty 无法取得时为 null，dirty=true 时不能把 commit 当作完整部署身份，须比较完整 sourceHash。
- sourceHash 仅覆盖源码、内置资源、脚本、包/锁文件及 TypeScript 配置，不读取实例配置、凭据或会话数据。构建产物脱离仓库后仍保留原身份。
- 文件不存在使用受控 `File not found.`；其余原始工具错误在模型上下文和 JSONL 持久化前替换为通用文案。技能诊断使用 `builtin/...` / `user/...` 逻辑路径，不要求前端替换服务端绝对路径。

## 工作区变更通知（GET /api/events）

`GET /api/events` 是独立命名的 SSE 流，只推送"重新读取"信号，不承载业务正文；与 AG-UI 聊天流不复用事件命名空间。

- 鉴权：与其它 `/api/*` 相同，使用 `Authorization: Bearer <token>`；连接 `text/event-stream`，`Cache-Control: no-cache, no-transform`。
- 事件有三种：`event: ready` / `event: workspace_updated` / `event: actions_updated`，`data` 始终为 `{}`，每帧以空行结束。
- 心跳：空闲时每 30 秒发送注释帧 `: keep-alive\n\n`（不算业务事件，用于降低代理空闲超时概率；慢连接恢复可写后再发送）。
- 协议约束：无事件 ID，忽略 `Last-Event-ID`，不支持重放；首次建立连接服务端先发 `ready`，客户端之后才能收到通知。

客户端约定：

1. 拿到 `ready` 帧后再读取 `/api/agent` 与 `/api/actions/pending` 拉一次最新快照，避免先读后订阅的漏通知窗口。
2. 收到 `workspace_updated` 表示 jobs / goals / memories / monitors / identity 的数据可能变化，重读 `/api/agent`；收到 `actions_updated` 表示审批新增、批准、拒绝、过期或撤销，重读 `/api/actions/pending`。按这两个读取范围合并刷新即可，允许客户端复用现有聚合刷新方法。
3. 刷新期间到来的新通知不能丢：一次刷新未完成时若再收到同范围通知，必须在本次刷新完成后至少再补刷一次；不同范围按各自路径单独合并。
4. 断线、回前台重连：再次收到 `ready` 帧即视为一次同步边界，按 1-3 重新拉取；不要依赖本地缓存判断"是否漏通知"。
5. 本轮未修改客户端轮询。客户端完成连接、重连和补刷处理后，可以替换原有 5 秒盲轮询；保留首次同步、操作后刷新和手动刷新。建议前台保留一条连接，退后台可断开，非主动断线后适度退避重连；锁屏系统推送不在本接口范围内。握手 401 应重新登录，服务关闭期间 503 可稍后重连。

实现要点（供实现者对照；不作为客户端契约）：

- HTTP/工具/调度写入复用 repository 的提交后通知；业务执行不等待网络发送。信号允许合并或冗余，不承诺每帧都对应一个唯一变更；外部进程直接修改数据文件不在通知范围内。
- 慢连接有界合并：每条连接内部用至多一帧待发送 + 两个失效标记（每类一个），背压期间同类变更合并为一条帧，另一类不互挤。
- 服务关闭 / 请求 abort / reader cancel / 订阅者抛错都会触发清理，订阅者从集合移除后不再收到通知。

所有 `/api/*` 业务端点使用 Bearer token，health/session 和文档基础设施除外。未知接口不提供历史兼容响应。非回环监听必须配置访问密钥。
