# API、工具报文与自动文档开发规范

本文是修改 HTTP/SSE、工具报文及客户端接入/展示时必须遵守的开发与交付规范，不是另一份客户端接口说明。全局底线见 [AGENTS.md](../AGENTS.md)，层间职责见 [架构规范](architecture.md#http-与前端适配边界)，回归要求见 [测试规范](testing.md)。

## 完成标准

**前端只阅读服务端 `/docs` 与 `/openapi.json`，就能正确接入本次新增或修改的接口，不需要另读源码、Markdown 或聊天记录来补齐关键规则。**

接口能调用、路由已登记或 schema 校验通过，都不等于文档交付完成。所有 Agent 必须主动同步实现、契约、自动文档与契约测试，不等待用户提醒。`docs/http-api-contract.md` 及给前端的说明仅作辅助，不得成为关键接入规则的唯一出处。

## 契约唯一来源

| 来源 | 职责 |
| --- | --- |
| `src/http/contracts/endpoints.ts` | 所有对外 HTTP 端点唯一清单：method/path/tag/summary/hint/request/response schema；SSE 绑定本端点事件契约 |
| `src/http/contracts/rest.ts` | 请求 schema，字段约束与含义 |
| `src/http/contracts/responses.ts` | 响应 schema、状态与空值语义 |
| `src/http/contracts/activities.ts` | 活动概览、逐步明细、列表分页与查询 schema |
| `src/http/contracts/approvals.ts` | 审批决定、执行回执、完整预览与终态历史分页 schema |
| `src/http/contracts/agent-status.ts` | 单次运行最新状态查询与 SSE 运行状态投影 schema |
| `src/http/contracts/sse-events.ts` | AG-UI 聊天事件、数据与顺序 |
| `src/http/contracts/workspace-events.ts` | 工作区通知事件与客户端同步规则，不与聊天混用 |
| `src/http/openapi.ts` | 从契约生成 OpenAPI 3.1，不维护独立字段定义 |

- schema 使用 zod v4。字段含义、可选/空值语义、默认值、范围与状态含义写入 schema 和 `.describe()`，DTO / Web 类型从 schema 推导，不另抄手写类型。
- **行为语义同样是契约**：鉴权、调用前置条件、错误/冲突处理、副作用、幂等、取消、重连以及客户端必须执行的同步步骤，都必须进入生成文档的描述字段，不只定义 JSON 形状。
- `EndpointSpec.hint` 生成标准 `operation.description`，同时生成 `x-agent-hint`，不受“一句话”长度限制。SSE 的 `sse.description` 与事件 schema 的 `.describe()` 分别生成响应和事件描述。
- 普通代码注释不会自动进入文档，写了注释不等于补了契约。关键步骤也不能只放自定义扩展；`/docs` 未展示扩展时，通过契约源补充标准接口/响应描述，让页面使用者能直接看到。
- 禁止手写 OpenAPI JSON/YAML 或维护第二份接口规范。`src/http/openapi.ts` 使用 `z.toJSONSchema`，请求 `io=input`、响应 `io=output`；生成能力不足时扩展契约定义与生成器，不能绕开它另写规范。
- Hono 实现与端点注册表必须双向一致：不漏登记，也不保留已下线业务接口、旧字段或假成功占位响应。

## SSE 等有状态协议的必备说明

每个端点分别说明，不用笼统“支持 SSE”代替可接入契约：

1. `event:` 是否存在、如何命名，`data` 如何编码与分帧，事件名、数据结构及触发条件。
2. 首帧、事件顺序、心跳，以及成功/失败终态；无终态断流如何处理。
3. 断开是否取消执行，Stop/超时如何收尾，重连能否继续原执行。
4. 是否提供事件 ID、是否接受 Last-Event-ID、是否支持重放。
5. 连接/重连后的读取步骤、同步边界，以及刷新期间又收到通知时如何补刷。
6. 鉴权、握手错误、服务关闭和前后台切换的处理边界。

SSE 端点声明 `text/event-stream`，通过每端点 `x-sse-events` 提供机器可读事件 schema。聊天 AG-UI 与工作区通知不得共用事件表；关键规则必须同时进入标准接口/响应描述，不能只藏在扩展中。

当前两类流的语义不同，修改时必须分别核对契约和真实行为：

- **聊天流**：只提交 `{spaceId, runId, expectedRevision, message:{id,content}}`，不回传全量历史；revision 冲突在 SSE 前返回 HTTP 409，同一成功 run 的原消息可幂等重放。非法 spaceId 在宿主预校验即 HTTP 400，不进入聊天 SSE。流断开会取消所属 run。
- **聊天同步与 Stop**：历史返回 `{messages, revision}`；Stop 同时绑定 spaceId/runId，Web 等待取消完成后刷新权威历史。版本冲突恢复未接纳草稿，切换会话取消原流；这些正确性步骤必须在生成契约中完整表达，不能只依赖本文。
- **工作区通知**：单向通知客户端重读状态，断连不取消聊天；ready 后读取相应快照，刷新中收到新通知要补刷，重连重新同步。准确事件、心跳与重放能力以本端点契约为准，不复制聊天取消语义。

## 工具报文与自有 Web 一致性

- 修改前先看自有 `web/` 的实际 renderer 与 `src/http/contracts/`，不能凭历史 OpenMuse/CopilotKit 行为决定新报文。
- 工具名、参数名、结果 JSON、调用 ID 关联及事件顺序都是协议契约；已有专用 renderer 时按其 schema 返回，不随意改名、换结构或以自然语言伪装成功 JSON。
- 新增/改名工具必须在自有 Web DEV 页面实际验收，不只看 AG-UI 事件。是否新增客户端展示以现有 renderer 和契约为准，无法正确展示时扩展实际适配层，不做空壳兼容。
- Web service 返回结构化结果，pi 工具层才序列化 JSON；工具执行与展示投影各司其职，展示策略不扩大执行权限或替代审批。
- 文件审批必须完整展示修改前后文本，pending 完整预览、历史摘要和按需详情分开；工作台快照不包含审批。批准只表示人的决定，不保证落盘成功，实际执行结果、过期/取消/文件版本规则也要进入相关契约。
- 新工具的装配与权限见 [新能力接入](architecture.md#新能力接入)；工具/真实模型/审批/取消回归见 [测试规范](testing.md#必须为变更补回归测试)。Markdown 不替代实际 renderer 和生成接口文档。

## 每次接口变更的验收门槛

1. **先同步来源**：实现、端点注册、请求/响应/事件 schema 与行为描述一起修改；对外关键规则落到能生成标准文档的字段，不留在聊天或辅助 Markdown 中。
2. **补本次回归**：在现有 architecture/boundaries/response-contract 等测试补实际 HTTP / pi / 工具行为。保留并扩展 `tests/integration/docs-contract.test.ts`：结构完整、文档路由可达、无副作用 GET 响应校验、Hono 与注册表双向审计；两类 SSE 各自核对真实事件与其契约。
3. **验证语义生成**：检查实际生成的 `/openapi.json`，接口、字段、事件和关键行为说明存在且与实现一致。对本次接入步骤添加针对性断言，不能把旧结构测试通过当成语义完整的证明。
4. **实际打开 `/docs`**：确认新增/修改接口和关键接入说明在 Scalar 页面可见，而不只是 200 或 schema 存在。扩展未展示时修正契约标准描述；无法页面验证时明确报告未验证，不宣称完整文档已验收。
5. **验收客户端影响**：涉及工具报文或展示时，在自有 Web DEV 检查 renderer、刷新历史与错误态；需要真实模型链路时经明确费用授权另跑 live，不以 fake provider 或 HTTP/schema 替代。
6. **梳理多端变动说明**：仓库内的 `web/` 仅为接口验证与联调的测试页面，项目核心生产场景包含独立的 React Native (RN) 移动客户端。接口发生新增、废弃或语义调整时，必须主动总结变动的端点、字段、事件名称与逻辑影响，如实向用户说明客户端该如何对接调整，不提供具体代码实现。
7. **完成检查与报告**：按测试规范执行 `pnpm check` 及适用专项，分别报告自动化、文档页面、工具页面和真实模型的准确版本/范围。任何失败或跳过逐项说明。

运行时 `GET /openapi.json` 与 `GET /docs` 均免鉴权；Scalar 优先本地 `/scalar.js`，失败回退 CDN。启动隔离实例核对实际文档，不擅自修改正式配置或借页面验收对真实会话执行测试写入。
