# Personal Bot：分阶段实施计划

日期：2026-10-10。状态：用户已批准 P1 实现。最小服务端与 OpenMuse Web mock 闭环已完成；目标模型与原生端验收待补。

> 后续功能完成情况见 `HANDOFF.md`；2026-10-11 起的结构调整由 `refactoring-plan.md` 跟踪。本文保留原始功能实施计划，不作为当前目录布局说明。

## 1. 目标和边界

- 在 personal-bot 建立新的服务端，执行内核使用 pi。
- 对接现有 OpenMuse 的 Expo 前端及 Web/iOS/Android 客户端，不使用 nanobot WebUI。
- 参考 nanobot 的身份、个人记忆、skills、主动任务设计；不逐行迁移它的 Python agent loop。
- 先只支持一个指定的 OpenAI-compatible endpoint / model，暂不做多供应商切换、外部聊天 channel、多用户平台。
- 优先验证 Web；原生客户端随后复用同一协议做 smoke test，不把同时发布三个平台作为首次聊天闭环的门槛。
- 首期不默认开启邮件、日历、计算机、浏览器、自动任务、任意 shell、第三方扩展。

## 2. 推荐结构：一进程、三层，而非三套服务

~~~text
OpenMuse Web / iOS / Android
    |
    | 既有业务 HTTP + CopilotKit / AG-UI SSE
    v
兼容层：session / workspace / agent snapshot / conversation / runtime
    |
    v
会话协调：固定 local-main、串行运行、去重、取消、历史投影
    |
    v
pi SDK：session / agent loop / tools / skills / compaction / 模型流
    |
    v
一个 OpenAI-compatible endpoint
~~~

这三个层次最初可由少量文件实现，不引入微服务、通用插件平台、消息队列或通用多租户框架。
JS/TS 业务逻辑优先纯函数与组合；AG-UI 的 AbstractAgent 如需继承，只做 SDK 边界适配。

推荐保留 CopilotKit 的本地 runtime 作为协议胶水，不使用 Intelligence 云服务。只实现 pi 到 AG-UI 的事件适配，不复制 OpenMuse 原有 TanStack 模型执行层。
备选是直接实现少量 runtime 路由，复用 AG-UI schema/encoder；只有本地 runtime 对 session/取消造成明显阻碍时才选它，不同时维护两条运行路径。

## 3. 阶段与验收门槛

### P0：接口盘点与最小契约冻结（已完成）

产物：

1. OpenMuse 实际客户端请求清单：调用位置、方法、请求/响应、启动必需/按功能访问。
2. 最小聊天契约、SSE 顺序、鉴权、错误、停止、历史写回约束。
3. 明确首期哪些 UI 不开放，以及是否允许少量前端能力开关。
4. 将契约转换为 fixture / schema / contract test 的待办；目前文档不是已运行验证的 OpenAPI。

验收：每个首页请求都有真实定义；不要求实现所有 OpenMuse 服务端路由；用户确认 P1 范围和关键选型。

### P1a：pi 与目标模型的短验证

仅验证未来正式路径需要的能力，不搭另一套产品：

- 固定发布版 pi SDK，显式指定 model、agentDir、sessionDir、cwd 和资源来源。
- 用目标 endpoint 跑文本流、第二轮上下文、abort、session 保存与重开。
- 替换默认 coding prompt 为 personal assistant prompt，默认无工具；禁用未审核扩展和全局配置自动加载。
- 记录目标模型的 context window、max tokens、reasoning、tool calling 能力；不因为标称兼容 OpenAI 就开启全部兼容开关。

验收：真实模型回应；停止后确实 idle；重开后上下文成立；明确最终完成事件；不依赖 CLI 输出解析。
如果这一步发现 SDK 不适合嵌入，再讨论 agent-core，不预先造两套 runtime。

### P1b：端到端最小闭环

范围：

- session 登录、Bearer 鉴权、CORS、health。
- workspace / agent 以及其他首页必需的未配置快照。
- runtime info、default agent run、stop，AG-UI 文本 SSE。
- local-main 唯一主会话，pi session 持久化与 OpenMuse history 恢复。
- 未实现的功能不伪装成功；UI 禁用或服务端返回清晰 JSON 不支持提示。

验收场景：

1. OpenMuse Web 指向新服务端后进入聊天，不要求原 OpenMuse 后端在线。
2. 发出一条真实请求并逐字显示，第二轮能引用第一轮内容。
3. 页面刷新、服务端正常重启后，UI 历史与模型上下文都保留。
4. 点击停止后模型请求取消、会话最终 idle；随后能继续发送，不遗留锁。
5. endpoint 401、超时、断流以可理解错误结束，UI 不一直 loading；模型错误重试不会重复追加用户消息。
6. 并发发送不同时操作同一 pi session；陈旧 PUT 不覆盖服务端历史。
7. 无模型 key 泄露、无 Intelligence 云依赖、无未经配置的外部工具请求。
8. 客户端 SSE 断开时，首期选择取消当前运行；不承诺断线继续或执行中刷新重连。正常完成后的刷新恢复必须支持。

首期接受：单用户、单会话、单进程、无工具、无执行中事件重放、无自动失败任务恢复。

### P2：第一个有用的工具 + skills

- 先选一个具体用户任务，例如在指定资料目录读取文件并总结。
- 优先复用 pi 工具或官方 MCP 接入；只添加一个审核过的能力，不一开始接十几个 MCP。
- 映射 TOOL_CALL_*，确保 toolCallId、参数、结果、错误、取消完整。
- 给 OpenMuse 增加通用工具卡片或做小型适配，不把任意 pi 工具伪装成已有的特殊工具。
- 引入一项实际会用的 SKILL.md；验证资源只来自指定目录。

验收：一次真实的工具调用可见、可失败、可停止，刷新后工具结果仍关联正确。之后再考虑写文件/bash及确认策略。

### P3：个人身份和长期记忆

- 参考 nanobot 的 SOUL / USER / memory 设计，接入 OpenMuse 的 identity 和 memory 编辑界面。
- 只选一个长期记忆权威来源。建议用结构化存储支持 UI CRUD，再由 prompt loader 渲染；不能让数据库和 MEMORY.md 同时独立决定事实。
- 区分对话 session/context compaction 与长期用户事实；前者复用 pi，后者属于产品能力。
- 先显式 remember / edit / forget，再评估自动提取、整合或 Dream。

验收：记住一条事实，跨重启可用；编辑/删除后模型下一轮遵守新值；不会保存敏感凭证。
数据库具体选型到本阶段按用途决定，不为了聊天先搬整个 OpenMuse 数据库。

### P4：可恢复后台任务，再做定时和主动性

- 先做 delegate_task 的单次后台执行和可观察状态，再做 cron / heartbeat / monitors。
- 聊天和任务使用同一 pi 会话工厂和工具策略；后台任务用独立 session，不与主聊天抢同一个 session。
- 对齐 OpenMuse 的 task status、进度、通知、暂停/取消/重试和必要审批；不一次实现全部计划/证据/lease字段的业务语义。
- 先审查 pi 生态调度方案，再决定复用或写最小 scheduler。仅有 CLI 定时发 prompt 不等于重启恢复、错过执行、去重和 UI 状态闭环。

验收：离开聊天页任务可继续；重启后状态不虚假 running；定时执行不重复、失败可观察、用户可取消。
Goals、复杂监控、邮件/日历/浏览器/desktop 和多会话继续拆成独立后续范围，不绑定在一个大版本。

## 4. 首次实现的最小任务切分

| 顺序 | 任务 | 依赖 | 交付与验收 |
| --- | --- | --- | --- |
| 1 | 最小 schema/fixtures 与协议测试 | P0确认 | 锁定快照、history、SSE正常/错误样例 |
| 2 | pi endpoint/session 验证 | endpoint、SDK选择 | 文本流、abort、resume真实通过 |
| 3 | Hono 启动、配置、session 与快照 | 1 | 前端能启动，未开放能力诚实展示 |
| 4 | pi session 协调和 history 投影 | 2 | 串行、稳定ID、去重、持久化 |
| 5 | AG-UI 适配和 runtime 路由 | 1、3、4 | 发消息、取消、错误均有终态 |
| 6 | 原 OpenMuse Web 联调 | 5 | 登录→聊天→第二轮→刷新→重启→停止 |
| 7 | 原生客户端 smoke test | 6 | 地址/CORS/网络与流式读取一致 |

任务2与3可在接口冻结后独立推进；会话协调、历史权限、取消传播属于关键路径，不为了并行拆给多个 agent。

## 5. P1 已采用选型

| 项目 | 推荐 | 理由 / 留待确认 |
| --- | --- | --- |
| 语言与运行时 | TypeScript + Node 24 + pnpm | 与 OpenMuse 接近；本机 Node v24.18.0，pnpm 12.10.1；实现时 pin 版本，不修改 OpenMuse 的 pnpm 11.19.0 配置 |
| HTTP | Hono + Node server，HTTP/SSE | 沿用客户端语义，不额外设计 WS 协议 |
| pi层级 | pi-coding-agent SDK | 优先复用会话/compaction/resources；不解析 CLI 文本 |
| pi版本 | 已锁定 @earendil-works/pi-coding-agent@1.1.0 | 2026-10-10 registry核实；与旧 @mariozechner 0.x 不混用，先做 smoke test再锁版 |
| 客户端协议 | 保留本地 CopilotKit runtime + AG-UI | 无云服务；最小客户端变动。直接路由为备选，不同时实现 |
| 会话持久化 | pi SessionManager 文件 | 运行历史权威来源；UI消息只是投影，可加最小稳定ID/运行状态元数据 |
| 首期用户与会话 | 一个 owner + local-main | 无多租户、无多会话列表；会话token与模型key分离 |
| 能力范围 | 文本先行，工具第二阶段 | 切分模型/协议问题和工具权限问题 |
| 部署 | 首先本机服务 + Web | 如需手机访问，另配置 LAN/TLS/鉴权，不能把 localhost 当手机可达地址 |

## 6. 必须守住的边界

- 模型 key 仅在服务端，绝不放进 EXPO_PUBLIC_* 或 workspace JSON。
- 普通请求 body 和客户端 AG-UI tools/context/forwardedProps 不得变成执行权限、任意系统指令、文件路径或模型配置。
- cwd 不是安全沙箱。以后开放文件/shell必须有真实访问边界；想要任意 shell 时，应讨论独立容器/OS隔离。
- 使用专用 pi agentDir，避免自动继承个人 CLI 的 extensions、MCP、凭据或配置。关闭可选 telemetry/模型目录网络更新，按固定model工作。
- 命令取消需贯穿 HTTP → runtime adapter → pi session → provider/tool；不是只关闭 SSE。
- 明确SDK完整完成和runtime取消的区别；CopilotKit stop回包表示已请求停止，不天然保证pi已idle。
- 首期 single writer，下一轮只能在 pi idle 后开始；不抢跑、不重复调用 prompt。

## 7. 已确认与后续待补

P1 已按用户批准采用：单主会话、纯文本、Web 优先、本地 CopilotKit、允许少量客户端能力开关。本次先在 Mac 联调。

仍需补充：目标 endpoint 的 baseURL、model ID、Chat Completions 兼容性及模型真实上下文上限。key 通过本地环境配置，不需要在聊天中提供。

下一轮先验收真实 endpoint；原生端需决定模拟器/真机与服务地址。如改为远程部署，再讨论 TLS、认证和工具执行边界。P2 的工具/skills 允许列表尚未开放。

## 8. 调研与验证状态

- OpenMuse基线：1ac68f3909f2478ab6280883f1ab5ea65eb5719d，并包含现有本地修改；详见接口文档。
- nanobot基线：b0d28af321933dbae08aa02a4d5d2a75fbbda9f0；本地存在个人配置目录，不修改/复制这些个人内容。
- OpenMuse 最小接口已经实际 Web 联调：首轮、第二轮、刷新恢复、停止后继续聊天通过；未开放入口由 textOnly 隐藏。
- 已安装并锁定 pi 1.1.0。测试使用真实 SDK + HTTP 模拟 OpenAI endpoint；目标供应商尚未配置，原生客户端未运行验收。

详细接口：openmuse-api-contract.md。pi复用边界：pi-reuse.md。

## 9. P1 实现记录

- 新服务端采用 Hono + pi SDK + AG-UI，未引入数据库、消息队列或额外 worker。
- 保留 CopilotKit 本地 handler；替换其默认 InMemory runner 为薄 runner，HTTP 退订会取消本轮，stop 等待 pi idle。
- pi JSONL 是模型上下文与 UI 历史权威来源；只采纳新增 user，客户端 tools/system/assistant/context 不导入。
- textOnly / serverOwnedHistory 为可选标记，OpenMuse 旧服务端省略时保持原交互；本服务客户端 finally GET 同步。
- 失败重试使用 pi context edit 排除旧轮而非追加重复 user；早期失败无新 user 时恢复原叶子。
- P1 关闭自动 compaction/retry；专用 ResourceLoader 无全局资源和工具。
- 自动测试覆盖配置、鉴权/CORS、事件 schema、上下文、重启、错误脱敏、重复请求、并发/停止/断流/超时；命令见 README。
- 模型 API key 和工作区访问 key 分离，模型 key 不落 auth.json；更换访问 key 使旧 token 失效。

P1 尚未关闭的验收项：目标 endpoint 的兼容性和实际质量、iOS/Android 网络与 SSE。完成这两项前，不宣称完整 P1 产品验收。
