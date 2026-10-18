# HTTP 与聊天契约

端点唯一清单为 `src/http/contracts/endpoints.ts`，请求/响应/SSE schema 位于同目录。运行时 `/openapi.json` 自动生成 OpenAPI 3.1，`/docs` 提供 Scalar 页面，不维护手写 OpenAPI。完整接入规则以自动生成文档为准；本文仅作辅助说明，不承担关键规则的唯一来源。

## 聊天

1. `GET /api/conversation?threadId=local-main` 返回 `{messages, revision}`。新空会话的 revision 为 `empty`。
2. `POST /api/conversation/run` 提交 `{threadId, runId, expectedRevision, message:{id,content}}`，只提交一条用户消息，禁止全量历史/客户端工具输入。响应为 AG-UI SSE。
3. 相同成功 runId 和原消息幂等重放；其他请求必须匹配 revision，冲突返回 HTTP 409。失败轮可用原 message ID/内容和最新 revision 重试，且只能重试最后用户消息。
4. `POST /api/conversation/stop` 提交 `{threadId,runId}`，仅停止完全匹配的当前轮，等待取消及持久化完成；不匹配返回 `{stopped:false}`。断开 SSE 也取消所属轮。
5. UI 只以 RUN_FINISHED/RUN_ERROR 判断终态，每轮结束刷新权威历史。事件 schema 与 Web 联合类型同源，畸形事件及无终态断流明确失败。

## 工作台、任务和审批

- `/api/agent` 是任务/目标/监控/记忆/身份快照，不含审批正文或未实现的占位字段。
- 任务 kind 为 `job | task`；详情为 `{task,events}`；控制必须显式指定 `target: job | task`。
- queued + running 后台任务上限 32；创建/重试满额返回 HTTP 429，状态不变。后台工具不允许递归委派、定时或监控。
- `GET /api/actions/pending` 仅返回当前未过期 pending 的完整预览；`GET /api/actions` 仅摘要；`GET /api/actions/:id` 返回单项完整详情。
- `POST /api/actions/:id/decide` 只决定人的批准/拒绝，批准不代表实际文件提交成功；实际结果看工具执行。任何过期/取消/版本变化均不能复用授权。

## 工作区变更通知（GET /api/events）

`GET /api/events` 是独立命名的 SSE 流，只推送"重新读取"信号，不承载业务正文；与 AG-UI 聊天流不复用事件命名空间。

- 鉴权：与其它 `/api/*` 相同，使用 `Authorization: Bearer <token>`；连接 `text/event-stream`，`Cache-Control: no-cache, no-transform`。
- 事件有三种：`event: ready` / `event: workspace_updated` / `event: actions_updated`，`data` 始终为 `{}`，每帧以空行结束。
- 心跳：空闲时每 30 秒发送注释帧 `: keep-alive\n\n`（不算业务事件，用于降低代理空闲超时概率；慢连接恢复可写后再发送）。
- 协议约束：无事件 ID，忽略 `Last-Event-ID`，不支持重放；首次建立连接服务端先发 `ready`，客户端之后才能收到通知。

客户端约定：

1. 拿到 `ready` 帧后再读取 `/api/agent` 与 `/api/actions/pending` 拉一次最新快照，避免先读后订阅的漏通知窗口。
2. 收到 `workspace_updated` 表示 jobs / tasks / goals / memories / monitors / identity / worker 的数据可能变化，重读 `/api/agent`；收到 `actions_updated` 表示审批新增、批准、拒绝、过期或撤销，重读 `/api/actions/pending`。按这两个读取范围合并刷新即可，允许客户端复用现有聚合刷新方法。
3. 刷新期间到来的新通知不能丢：一次刷新未完成时若再收到同范围通知，必须在本次刷新完成后至少再补刷一次；不同范围按各自路径单独合并。
4. 断线、回前台重连：再次收到 `ready` 帧即视为一次同步边界，按 1-3 重新拉取；不要依赖本地缓存判断"是否漏通知"。
5. 本轮未修改客户端轮询。客户端完成连接、重连和补刷处理后，可以替换原有 5 秒盲轮询；保留首次同步、操作后刷新和手动刷新。建议前台保留一条连接，退后台可断开，非主动断线后适度退避重连；锁屏系统推送不在本接口范围内。握手 401 应重新登录，服务关闭期间 503 可稍后重连。

实现要点（供实现者对照；不作为客户端契约）：

- HTTP/工具/后台写入复用 repository 的提交后通知，worker 忙闲变化在内存状态切换后通知；业务执行不等待网络发送。信号允许合并或冗余，不承诺每帧都对应一个唯一变更；外部进程直接修改数据文件不在通知范围内。
- 慢连接有界合并：每条连接内部用至多一帧待发送 + 两个失效标记（每类一个），背压期间同类变更合并为一条帧，另一类不互挤。
- 服务关闭 / 请求 abort / reader cancel / 订阅者抛错都会触发清理，订阅者从集合移除后不再收到通知。

所有 `/api/*` 业务端点使用 Bearer token，health/session 和文档基础设施除外。未知接口不提供历史兼容响应。非回环监听必须配置访问密钥。
