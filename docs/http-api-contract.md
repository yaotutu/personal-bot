# HTTP 与聊天契约

端点唯一清单为 `src/http/contracts/endpoints.ts`，请求/响应/SSE schema 位于同目录。运行时 `/openapi.json` 自动生成 OpenAPI 3.1，`/docs` 提供 Scalar 页面，不维护手写 OpenAPI。

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

所有 `/api/*` 业务端点使用 Bearer token，health/session 和文档基础设施除外。未知接口不提供历史兼容响应。非回环监听必须配置访问密钥。
