# 当前架构与新能力接入

> 2026-10-15：单进程、单用户、单模型、多个独立会话的模块化单体。当前主客户端是 `web/`，不提供历史兼容接口。维持函数式工厂、显式依赖注入和 JSON 文件存储，不引入通用框架或数据库迁移。

## 职责边界

| 位置 | 负责 | 不负责 |
| --- | --- | --- |
| `src/index.ts`、`scripts/dev-mock.ts` | 配置加载、监听、信号退出 | 业务规则、工具实现 |
| `src/bootstrap/create-service.ts` | 唯一实例组装、初始化恢复、执行源启动、统一关闭 | DTO、agent loop |
| `src/config/` | 必需 JSON 配置、凭据和校验 | 创建业务实例 |
| `src/features/` | conversation/memory/identity/jobs/goals/actions/monitors/web/weather 的规则与最小 port | Hono、AG-UI、pi SDK、文件系统 |
| `src/adapters/pi/` | pi session、历史投影、诊断脱敏、prompt、显式工具装配 | 第二套历史、手写 agent loop |
| `src/adapters/ag-ui/` | SSE/事件/运行和取消适配 | 会话锁或任务域状态（含 subagent） |
| `src/adapters/storage/` | DataLayout、文件读写、各域 repository | 业务状态机、通用 CRUD 框架 |
| `src/adapters/web/`、`src/adapters/weather/` | 安全网络传输、供应商适配 | 绕过 DNS/大小/超时边界 |
| `src/http/` | 鉴权、CORS、路由、契约、presenter、文档 | 创建业务实例、启动调度 |
| `web/src/` | 自有工作台、聊天 SSE、历史/任务/审批展示 | 自定义后端事实、复制手写 DTO |
| `src/shared/` | 真正复用的串行写队列 | 杂项 utils、事件总线、DI 容器 |

feature 只依赖业务类型与实际需要的 port；adapter 实现 port，bootstrap 显式连接。`tests/unit/dependencies.test.ts` 检查依赖方向；ID 生成允许 `node:crypto`。

## 会话、状态与执行所有权

- `conversationHub` 每个 thread 缓存唯一协调器（含初始化 Promise），阻止重复创建两把锁；主会话 `local-main` 常驻。短生命周期锁串行协调初始化、HTTP 来源绑定、规则/技能保存和删除，不占用模型执行锁；删除先关门，旧引用关闭后不能向新同名会话投递。
- 历史读取和迟到 Stop 只查已有会话；不存在/已删 ID 返回空历史或 false，不 mkdir、不进入列表。subagent 每次调用占独立 `subagent-<uuid>` 工作区，结果写回父 thread；旧 worker 内部 `task-*` 会话仍过滤掉、不进入用户列表，删除仍优先关闭旧引用。
- 每个 conversation 独占 active run、锁和取消原因。客户端 run 与同 thread 的定时 trigger 共锁，其他用户 thread 独立。run 有客户端超时与断线取消；jobs trigger 保留既有无客户端超时语义；tasks 显式传入自己的超时和 AbortSignal。
- pi 的 `createAgentSession` 负责执行循环、工具执行和持久化，SessionManager/JSONL 是唯一历史权威。展示读完整 branch，模型 compaction/context edit 仍由 pi 管理。
- 模型与工具诊断在 pi 持久化前脱敏，不是只清洗 SSE 副本；已发生的工具副作用不因最终回复失败而回滚。
- memory/identity 共用一个 repository 和完整读改写队列；其他持久域各有唯一 repository，不在路由或工具中另开 writer。
- subagent 内部 `subagent-<uuid>` 工作区与旧 worker 遗留 `task-*` 会话均不显示在用户侧栏；用户会话缓存达到软上限后，只在后续获取时回收已闲置至少五分钟的非主会话，不回收运行中会话。subagent 不持久化子会话，结果作为父工具结果回写；旧 `task-*` 历史文件不删除也不读取，仅保留隐式过滤约束。软上限不是严格并发配额。
- 会话列表活动时间取 JSONL 文件 mtime，不能取不会随内容追加而更新的目录 mtime。

## 两种后台行为与子代理

旧 worker（一次性后台队列、`delegate_task`、`POST /api/agent/tasks`、`/control` 的 `target: task` 分发）已下线，本节只剩 jobs / monitors 两种后台行为。subagent 是父模型直接调用的工具，不是服务端后台域。

| 域 | 执行方式 | 结果与失败 |
| --- | --- | --- |
| jobs | 定时到期后在所属会话执行真实 pi 轮，与该会话聊天争锁 | 按 nanobot 重算 daily；过期一次性任务启动不补跑；保存失败只补存同一次已得结果，不重跑模型/工具 |
| monitors | 固定扫表，到期抓取复用 web 安全边界；不启动模型轮 | change 首检建基线，contains 从未命中进入命中通知；抓取失败只记 error；变化先保存 pendingNotification，再投递和确认 |

### subagent（工具，不是后台域）

- 实现：官方 1.3.0 subagent 示例的 SDK child 适配，单/并行/链式三种模式，本地 fork 仅做 runner/discovery/渲染适配；同进程内独立 SDK session 上下文隔离，不写自造 loop；最多 8 个并行请求、同时 4 个，链式失败即停，不自动重试。
- 边界：子会话继承父 session 的 model/key，role 提示词来自 `assets/subagents/<role>.md`（内置四个 role，DATA_DIR `subagents/*.md` 可覆盖，role 文件不接受 model 字段）；只受父会话已启用技能与工具上限约束，且必须收窄（不开放 subagent/schedule/monitor/instructions/bash，不读取个人 `~/.pi`，不接受 `cwd`/`agentScope` 等越界参数）。
- 状态：每个调用占独立 `workspace/threads/subagent-<uuid>/`（不复制父 workspace/history/INSTRUCTIONS.md）；写/编辑仍逐次人工审批，归属父 thread/run；子会话不持久化，结果作为父工具结果写回。
- HTTP 边界：`POST /api/agent/tasks` 已下线；`/api/agent` 任务快照的 tasks 数组仅含定时 job（kind=job），不再混入 worker；`/control` 仅分发 `target: job`；删除会话 `removed` 只统计 jobs/monitors。
- 旧实现：`tasks.json` / `task-*` 目录 / `delegate_task` 工具 / `POST /api/agent/tasks` / `target: task` 控制路径仅作历史记录，不读、不迁移、不删除、不执行，不保留旧 reader。

任务/监控记录可选来源 thread，仅省略时使用主会话。HTTP 显式新来源在接纳前建立；删除中的来源绑定返回409。来源删除后的迟到通知不改投主会话、不复活会话或投向新同名会话；监控/jobs 解析目的地后重查绑定，不能执行旧扫描快照。完成通知是确定性的服务端事实，不再伪造用户请求、调用模型总结，避免通知再次执行有副作用的工具。

通知经 conversation.notify 写入 pi 历史；忙时排队，轮次释放前落盘，稳定 ID 去重。新会话只有 custom entry 时 pi 不创建文件，因此通知使用公开 `appendMessage` 接口，明确标识 `personal-bot/server-notification`、零模型消耗，稳定 ID 同条写入。它在 UI 中独立展示，也进入后续模型上下文，不创建额外历史数据库。监控扫描不等待投递，按 monitor/notification ID 跟踪进程内在途通知；已有 pending 时不新抓取覆盖，单项错误不阻断其他监控。只有投递成功后才更新 lastNotifiedAt；下次扫描可补通知而不重新抓取或执行模型。定时任务结果以 jobs.json 为准；通知失败不重试任务，仍可从任务详情查看结果。进程崩溃时不承诺任务通知必达，也不恢复未完成模型轮。

## 写文件与审批

- read/grep/find/ls 默认仅可达 `DATA_DIR/workspace/threads/<threadId>/`，包括主会话；`shared/...` 仅映射到 `workspace/shared/`。绝对路径、父目录跳转、根/中间目录/目标符号链接均拒绝；只读 operations 检查 SDK 最终解析路径，递归 grep/find 不开启跟随链接，ls 跳过链接。已启用技能的精确 SKILL.md 仅允许 read 读取，不开放目录或其他文件。bash 永不暴露。启用 writable 时只注册受控 write/edit，不开放 pi 默认的无限制写工具。
- 审批域只记录人的决定，不执行副作用。每次操作登记完整路径、内容/编辑前后文本、文件基准版本，以及 threadId/runId/expiresAt；Web 原样转义展示，不能只展示截断摘要后让人批准。
- 截止时间登记时固定，决定时也原子检查过期；Stop/abort 撤销 pending；启动前撤销旧进程遗留 pending，批准旧卡片不能复活已取消的执行。
- 提交前再次检查取消、有效期、路径和文件版本。不同工具实例共用逐物理路径队列；任何旧审批遇到文件变化都拒绝，必须重新申请，不覆盖他人新内容。
- 写入/编辑拒绝符号链接和越界，先写同目录临时文件再提交，限制正文大小。保护针对单进程工具并发，不承诺防止外部恶意进程在最终检查与 rename 间篡改文件系统；不增加跨进程锁或事务框架。
- approved 表示人的批准，不代表磁盘提交成功；实际结果见对应工具结果，不把审批审计当作执行成功记录。

## 生命周期

1. 组装 repository/services，读取并校验所有持久域；重算 jobs、撤销旧 pending 审批、恢复崩溃任务。所有实际执行源最后才启动。
2. HTTP/协议复用已注入服务，不自行启动 scheduler。service.close 同步关门，新 HTTP 请求返回 503，hub/scheduler/subagent 不再创建或派发新工作。
3. 停表与取消会话协同进行，等待已经发出的执行、通知、状态写入和已接纳 HTTP 请求收尾；关闭幂等，某个清理失败也不跳过其他实例。
4. 进程入口停止接收连接并等待 close。mock 入口额外关闭 fake provider；初始化失败也必须清理本次分配资源。

## 数据布局与校验

- `sessions/<threadId>/*.jsonl`：pi 历史；同目录 INSTRUCTIONS.md/skills.json 分别为会话规则/技能覆盖。
- `workspace/threads/<threadId>/`：会话私有文件根；主会话没有例外。`workspace/shared/`：全局共享区，用 shared/ 别名显式访问；workspace/ 与 threads/ 仅为容器。
- SessionManager.continueRecent 与 createAgentSession 使用同一私有 cwd；重启只恢复相同 cwd 的权威历史，不回退旧路径。规则每轮重读，instructions 工具只修改本会话规则，不能扩大文件或审批权限；全局 SOUL.md/USER.md 仍共享。
- 路径守卫约束普通文件工具，不是操作系统沙箱；已安装的可信 extension 是服务端代码。
- `memory.json`：`{ memories: [...], identity: {...} }`，已有文档必须包含完整 identity。
- `jobs.json`、`goals.json`、`actions.json`、`monitors.json`：各域裸数组；记录遵守当前 reader；不加 schemaVersion，不隐式迁移数据。旧 `tasks.json`（worker 队列遗留）不读、不迁移、不删除、不执行，亦不保留旧 reader，仅作为历史文件留盘。
- DataLayout 集中声明路径；相对 runtime.dataDir 相对配置文件所在目录解析，绝对路径便于部署核对。
- 缺文件可初始化；JSON 损坏、非法根形状、未知版本和 I/O 错误必须报错，不能以空文档覆盖。memory/tasks/jobs 的每个条目都完整校验，任一坏条目整体拒绝，禁止过滤后静默丢失。
- JSON writer 先内存序列化，以 wx/0600 建同目录临时文件，再 rename；不做 fsync、自动重试、跨进程锁或 durable execution。
- sessions 初始化仅创建目录，不探测、迁移或归位旧文件。当前不提供历史数据 reader 或隐式迁移。
- 损坏文件需保留原件并从有效备份恢复，不直接删数据消除报错。

## HTTP 契约与前端一致性

- Hono 直接提供 `/api/conversation/run` 与 `/api/conversation/stop`，保留 AG-UI 事件语义，删除 CopilotKit runtime、PiAgent 和 runner。
- 历史 GET 返回 pi 当前叶子 revision；run 请求只含新消息与 expectedRevision。版本冲突 HTTP 409，同一成功 run 的原请求可忽略旧版本重放；其余重复 ID 拒绝，失败轮仅允许重试最后同内容消息。
- 审批独立查询 pending（完整正文）、历史摘要及单项详情。工作台聚合快照不读取 approvals，不返回旧 notifications/ideas/artifacts。
- token 是前端唯一认证事实，React 订阅其变化；401 和跨标签退出及时回到登录，错误密钥正常显示错误。

- `src/http/contracts/endpoints.ts` 是端点唯一清单；请求与响应 schema 使用 zod，OpenAPI 从 schema 生成，禁止手写第二份规范。
- `bootstrap/service-version.ts` 在源码启动时固定 package/git/白名单源码SHA-256快照；构建脚本生成 `dist/service-version.json`，产物运行时只读它、不读git或源码。health、OpenAPI和Scalar共用版本身份；dirty=true时比较sourceHash而非只比较commit。
- DTO 从响应 schema 推导，消息与事件联合类型同源；Web 对入站 SSE 使用同一 schema 校验，异常帧与无终态断流明确失败。
- 任务 kind 仅保留 job；删除无实现的 plan/evidence/artifacts/task 等占位字段。任务详情与定时任务一致使用 `{ task, events }`；事件只来自已记录事实。monitor.pendingNotification 不对外暴露；旧 `worker.running` / `task` 状态不再出现在快照里。
- Web history/SSE/结束刷新均绑定 thread 和运行代次，切换/卸载 abort 原请求；历史刷新完成前不启动新轮。Stop 调用 threadId/runId 绑定的接口并等待终态，切换/卸载取消原 SSE；409 刷新后恢复草稿。
- 测试覆盖端点登记双向审计、非空响应契约及生命周期；fake provider + 真 HTTP/pi 不等于真实模型 Web 验收，两者需分别记录。

## 外部 Web 结果

Web service 返回结构化成功/失败联合结果，业务消费者直接读取；pi 工具层负责 JSON 序列化与错误标记。DNS、IP 固定、重定向、超时、大小及不可信标记边界仍在原职责内。

## 新能力接入

1. 无状态只读工具放 `adapters/pi/tools/`；有独立规则/状态时才新增 feature，读写放 storage adapter。
2. 工具显式注册，allowlist 从注册结果生成；新增网络、写入、MCP 或委托能力先定义权限/失败边界，不因注册工具就扩大权限。
3. bootstrap 创建唯一实例并注入，HTTP/presenter 处理展示；不要把新功能继续堆进 conversation、app 或 session factory。
4. 纯规则补 unit，协议/持久化/执行补 integration；UI 变化在自有 Web 实际验收。修改后运行 typecheck、test、build、Web build、diff 检查；启动/退出变化补隔离目录进程检查。

现阶段不引入 PGlite、消息总线、持久队列、自动重试或通用工作流框架。先守住所有权、生命周期、审批和契约，等真实规模需求出现后再评估存储替换。
