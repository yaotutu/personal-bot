# 架构规范与新能力接入

本文是职责边界、状态所有权、生命周期、数据与权限细则的维护位置。修改业务、存储、权限或 pi 集成前必读；全局底线见 [AGENTS.md](../AGENTS.md)，测试与 API 交付分别见 [测试规范](testing.md)和 [API 开发规范](api-development.md)。当前进度与历史验收不在本文维护。

## 职责边界

单进程、单用户、单模型、多独立 thread 的模块化单体。保留函数式工厂、显式依赖注入、JSON 文件存储与 pi 内核，不为预防未来规模引入数据库、消息总线、持久队列或通用框架。

| 位置 | 负责 | 不负责 |
| --- | --- | --- |
| `src/index.ts`、`scripts/dev-mock.ts` | 配置加载、监听、信号退出；调用统一组合入口 | 业务规则、工具实现 |
| `src/config/load-config.ts` | 必需 JSON 配置、直接凭据与校验 | 环境变量回退、创建业务实例 |
| `src/bootstrap/create-service.ts`、`types.ts` | 唯一实例组装、启动校准、执行源启停、统一关闭 | DTO、agent loop |
| `src/features/` | conversation/messages/information/memory/identity/dream/jobs/goals/actions/monitors/skills/web/weather/workspace/activities/browser 的规则与最小 port | Hono、AG-UI、pi SDK、文件系统或具体 adapter |
| `src/adapters/pi/` | session factory、执行历史与消息事实投影、activity 记录与安全观察、诊断脱敏、资源隔离、prompt、工具装配与路径 guard | 第二份正文历史、手写 agent loop、反馈业务状态 |
| `src/adapters/ag-ui/` | SSE、事件投影、运行与取消适配 | 会话锁或业务域状态 |
| `src/adapters/storage/` | DataLayout、文件读写、各域 repository | 业务状态机、通用 CRUD 框架 |
| `src/adapters/web/`、`src/adapters/weather/`、`src/adapters/workspace/` | 安全网络传输、供应商适配、手动文件存储与提交队列 | 绕过 DNS/大小/超时/工作区路径边界 |
| `src/adapters/browser/` | 系统 Chrome 生命周期、CDP screencast、输入映射与可见结构投影 | HTTP/WS 协议、第二套浏览器实例或任意 evaluate 能力 |
| `src/adapters/auth/token-service.ts` | 登录、token 与签名密钥 | 业务规则 |
| `src/http/` | 鉴权、CORS、routes、contracts、presenter 与自动文档 | 创建业务实例、启动 scheduler |
| `web/src/` | 自有工作台、聊天 SSE、历史/任务/审批展示 | 自定义后端事实、复制手写 DTO |
| `src/shared/serialized-writer.ts` | 真正复用的串行写队列 | 杂项 utils、事件总线、DI 容器 |
| `tests/support/fake-model.ts` | OpenAI SSE 模拟 provider | 伪造业务工具副作用、替代真实模型验收 |

feature 只依赖业务类型与实际需要的最小 port；adapter 实现 port，bootstrap 显式连接。`tests/unit/dependencies.test.ts` 检查依赖方向；ID 生成允许 `node:crypto`。HTTP 只使用注入服务，不另建业务实例或启动调度。

## 会话、状态与执行所有权

- `conversationHub` 每个 thread 缓存唯一协调器（含初始化 Promise），阻止重复创建两把锁；主会话 `local-main` 常驻。短生命周期锁串行协调初始化、HTTP 来源绑定、规则/技能保存和删除，不占用模型执行锁；删除先关门，旧引用关闭后不能向新同名会话投递。
- 历史读取和迟到 Stop 只查已有会话；不存在/已删 ID 返回空历史或 false，不 mkdir、不进入列表。显式新 run、规则/技能保存或来源绑定可建立会话；存在性以会话列表为准。
- 每个 conversation 独占 active run、运行锁和取消原因。客户端 run 与同 thread 的定时 trigger 共锁，其他用户 thread 独立；run 有客户端超时与断流取消，jobs trigger 保留既有无客户端超时语义，不擅自统一两者。
- pi 的 `createAgentSession` 负责执行循环、工具执行和持久化，SessionManager/JSONL 是唯一历史权威。聊天附件不落工作区、不建附件库：图片通过 SDK prompt images 进入同条 user message，UTF-8 正文以不可信数据包装进 prompt；custom turn 只存附件元数据，展示图片从该条 user message 的 image blocks 读取。展示读取完整 branch，模型 compaction/context edit 仍由 pi 管理，不维护第二套历史。
- PI 历史唯一权威指聊天正文、附件执行事实与工具结果不再复制；不禁止 Pi Muse 保存自己的业务事实。消息反馈保存在独立 repository，不能 append 到 PI branch、改变 expectedRevision 或自动进入普通聊天上下文；显式启用的信息后台可按空间读取当前反馈例证。
- 模型与工具诊断在进入模型上下文和 pi 持久化前脱敏，不只是清洗 SSE 副本。默认文案为 `Tool execution failed` / `Model request failed`；仅 guard 声明的受控拒绝（`details.denied`）可透传。文件缺失使用受控 `File not found.`，技能诊断使用 `builtin/...` / `user/...` 逻辑路径。
- 工具副作用不因最终回复失败而回滚，失败不自动重试。停止后的半截 assistant 文本仍受 pi 的 `error/aborted` 历史过滤规则限制，不为恢复半截文本修改 pi。
- memory/identity 共用一个 repository 与完整读改写队列；其他持久域各有唯一 repository，同一文档不得在路由或工具中另开 writer。
- 用户会话缓存达到软上限后，只在后续获取时回收已闲置至少五分钟的非主会话，不回收运行中会话。软上限不是严格并发配额；会话列表活动时间取 JSONL 文件 mtime，不能取目录 mtime。
- `SOUL.md`、`USER.md` 与会话 `INSTRUCTIONS.md` 每轮重读注入；`memory.json` 作为沉淀库按需由 `memory_search` 检索，system prompt 仅提示条数而不再全量拼入。长期记忆可通过对话工具、HTTP 管理接口或受限的 Dream 后台整理写入（上限 500 条，满额拒绝新增而不静默截断）；会话指令与 Dream 提示词不能扩大工具、文件或审批权限。

## 消息业务层与反馈

- `features/messages` 是对外消息业务主路径，定义 PI 无关的消息事实、反馈状态与最小 repository port；conversation 的 snapshot 和 completed 幂等重放必须经它投影，不保留无消息层的备用读取路径。
- PI adapter 只提供执行事实：稳定消息 ID、角色、对应 PI entry 时间、run/job/notification 可验证来源、context_edit 后仍存在与当前 run 可用性。旧历史缺少来源事实时返回 `source:null`，不按正文、runId 前缀或 Markdown 猜测。
- 反馈归属为 `spaceId + sessionId + messageId`。喜欢/不喜欢互斥且可置空撤销；同一消息允许多条服务端 ID 评论，文本 trim 后非空且最多 4000 字符。工具结果不可反馈，当前生成中的消息不可反馈；同空间旧落盘消息在其他流式运行期间仍可反馈。
- `messages/<spaceId>/<sessionId>.json` 保存原始操作事件：reaction 变更/撤销、评论新增、编辑（旧新文本）、删除（删除前文本）及服务端时间。当前反馈和事件均由事件流投影，不能只存最终值，也不能把反馈 append 进 PI branch。
- reset 生成新 sessionId 并按空间清理反馈文件；delete 级联清理。旧 sessionId 返回 409，不迁移到新会话，也不得复活已删除空间。repository 读写、清理与 reset/delete 共用串行队列；文件缺失视为空反馈，损坏文件启动或读取时报错。
- 反馈记录操作本身不触发模型、Dream、自动记忆或偏好学习，也不从 Markdown 拆推荐条目；信息后台启用后可在独立决策轮读取当前空间、当前会话的有限最新例证。这不是训练，也不把点赞泛化为全局偏好；显式空间规则与偏好 notes 优先。

## 通用信息后台

- `features/information` 只服务普通空间：设置、偏好 notes、原始条目与执行记录保存在 `information/<spaceId>.json`，不是 PI JSONL。所有 HTTP 入口鉴权且目标必须已存在；GET/迟到输入/后台结果不创建或复活空间。设置默认 `false/15s`，0 表示到期即时聚合；reset 保留该文件但中断在途轮，delete 级联删除。
- 接入按整批校验，最多 50 条；`source+externalId` 是空间内幂等键。完全相同原始内容、标题与显式来源时间幂等回读稳定 ID；同 key 不同内容返回 409 且不覆盖原文。省略 `receivedAt` 的重复请求以首次落库时间为准；正文与标题仅拒绝全空白，不 trim 或改写。
- 后台单进程全局只有一个执行槽；手动 run 与 scheduler 在首个 await 前同步争用。每轮最多 20 条、60000 字符，并从最早 pending 条目聚合。pending 落盘；重启将遗留 `running` 标为 failed，也不重放“模型已完成但发布未确认”的轮次。
- 执行轮使用 `createAgentSession` 的独立内存 SessionManager，只装配 `submit_information_result` 工具；不提供 bash/write/edit/read、网络、memory、instructions 写、skills.save 或委派能力。空间规则与已启用技能的 `SKILL.md` 纯文本作为指引，不能扩权；原始信息、反馈和来源时间都是不可信数据。
- 结构化提交由 PI 无关的共享校验器强制：每个本批 item 恰好一次 silent/notify 决策，notify item 恰好被一条通知覆盖，silent 不得发布，reason/text 与引用有界。SDK 整轮成功且最终恰好一个有效工具提交才持久化决策；同一 SDK 轮内无效提交可收到工具错误并自行纠正，不触发应用重跑；空自然语言确认不要求，漏调/最终无有效提交/两次有效提交/请求失败均 failed 且不自动重试。
- 发布经唯一 `conversation.notify` 入口使用稳定 notificationId，repository 记录 run → 原始 items → notificationId/sessionId/messageId。通知排队未落盘前可被 disable/reset/delete/shutdown 撤销；已落盘消息不回滚。发布前检查取消、设置与目标 session，模型成功而投递失败时保留 model succeeded 并单独记录 publication failed。
- 普通聊天常开只读 `information` 工具，固定闭包到当前空间，仅能查询本空间信息、run、偏好与发布关联；子代理不装配。短信接入、供应商适配与移动端管理界面不在该域内。
- 普通主聊天的系统提示词说明信息后台的通知边界；PI 公开 `context` hook 仅在模型请求前把带服务端 marker 且符合稳定 `info-notification-inforun_UUID-index` 格式的通知包装为来源、notificationId、runId 与不可信原文。该投影不修改 PI JSONL/UI 原文/revision，也不运行时查库；通用服务端通知、普通 assistant/user 或用户伪造文本不得获得信息后台来源。

## 后台调度与通知

当前后台行为包含 jobs / monitors / dream；subagent 是父模型调用的工具，不是后台任务域。

| 域 | 执行方式 | 结果与失败 |
| --- | --- | --- |
| jobs | 定时到期后在所属会话执行真实 pi 轮，与该会话聊天争锁 | 按 nanobot 重算 daily；过期一次性任务启动不补跑；保存失败只补存同一次已得结果和完成时间，不重跑模型/工具 |
| monitors | 固定扫表，到期抓取复用 web 安全边界；不启动模型轮 | change 为指纹变化，首检建基线不通知；contains 从未命中进入命中才通知；抓取失败只记 error |
| dream | 固定 2 小时周期扫描已开启会话（主会话默认开启，其他默认关闭），按游标+约 4k token 重叠窗口读取新消息，在独立内存 SessionManager 中运行仅含 `propose_notes` 的受限整理轮 | 会话忙或无新消息时跳过；写前校验文件版本与 `## 空间用途`，非主会话全局建议及无用途会话指令进 `pending` 待用户确认；仅整轮无跳过/无失败时推进游标，重启遗留 `running` 标为 `failed` |

- monitor 默认每 60 秒扫描到期的 active 项，检查间隔为分钟级；支持 pause/resume/stop。入口为对话 `monitor` 工具与 `POST /api/agent/monitors`，调用结构以生成契约为准。
- jobs/monitors 仅省略 `originThreadId` 时使用主会话。显式新来源在接纳前建立，删除中的来源绑定返回 409；删除来源后的迟到通知不改投主会话、不复活会话或投向新同名会话。解析目的地后重查绑定，不能执行旧扫描快照。
- 完成通知是确定性的服务端事实，不伪造用户请求或再调用模型总结，避免通知再次执行有副作用的工具。通知经 `conversation.notify` 写入 pi 历史；忙时排队，轮次释放前落盘，稳定 ID 去重。
- 新会话只有 custom entry 时 pi 不创建文件，因此通知使用公开 `appendMessage` 接口，明确标识 `personal-bot/server-notification`、零模型消耗，稳定 ID 同条写入。UI 独立展示，后续模型上下文可见，不另建历史数据库。
- monitor 先保存 pendingNotification，再投递和确认；扫描不等待投递，按 monitor/notification ID 跟踪进程内在途通知。已有 pending 时不新抓取覆盖，单项错误不阻断其他监控；只有投递成功才更新 lastNotifiedAt，下次扫描可补通知而不重新抓取或执行模型。
- jobs 结果以 jobs.json 为准；通知失败不重试任务，仍可从详情查看。进程崩溃不承诺任务通知必达，也不恢复未完成模型轮。定时触发轮不接入当前聊天实时 SSE，刷新或下轮同步后可见；旧 revision 可能触发一次 409，同步规则见生成契约。

## 子代理（subagent）

- 实现为 `src/adapters/pi/subagent/extension.ts` 与 `session-factory.ts` 的 SDK child 装配，基于官方 1.3.0 subagent 示例；本地 fork 仅做 runner/discovery/渲染适配，同进程内独立 SDK session 上下文隔离，不写自造 loop。single/parallel/chain 三种模式，最多 8 项、同时 4 个，链式失败即停，不自动重试。
- 子模型继承父 session 的 model/key；角色和工具只能收窄父会话已启用技能与工具上限，不开放 bash/subagent/schedule/monitor/instructions，不读取个人 `~/.pi`，不接受 `cwd` / `agentScope` 等越界参数。
- 每个调用独占 `workspace/threads/subagent-<uuid>/`，不复制父 workspace、历史或 `INSTRUCTIONS.md`；仅 `shared/...` 显式互通。写/编辑仍逐次人工审批，归属父 thread/run；父 Stop、超时或聊天断流取消子会话并等待清理。
- 子会话不持久化，结果作为父工具结果回写；`subagent-*` 内部工作区不作为用户会话展示。role 来自内置 `assets/subagents/<role>.md`，`DATA_DIR/subagents/*.md` 可覆盖；角色不允许另配 model，来源与本地差异见 [适配说明](../src/adapters/pi/subagent/README.md)。
- **旧 worker 的现行处理边界**：旧 `tasks.json`、`task-*` 目录不读、不迁移、不删除、不执行，不保留旧 reader；遗留 `task-*` 从用户列表和父文件根解析中过滤。`delegate_task`、`POST /api/agent/tasks`、`target: task` 分发已下线；原 `task` 技能名只装载 subagent，保留是为了不破坏会话技能覆盖。工作区快照 `/api/agent` 已解耦为仅保留 `identity`，定时任务收拢至独立 `/api/jobs`，删除空间的 removed 只统计 jobs/monitors。更早实现仅查 archive，不恢复旧队列。

## 工作活动（Activity）

- **定义与自主决策**：Activity 是主 Agent 被交办具体工作目标并实际推进执行的过程记录。由主 Agent 根据对话上下文自主决定是否调用 `activity` 工具登记（`start`），不使用关键词白名单、耗时阈值或分类模型；普通问答、解释、澄清、方案讨论与简单查询不作为活动登记。
- **生命周期状态机**：明确区分 `running`、`waiting_approval`、`waiting_user`、`awaiting_continuation`、`completed`、`failed`、`stopped`、`interrupted`。同一执行轮次至多绑定一项活动，重复 `start` 幂等返回当前活动；下一轮不自动续跑或绑定，由 Agent 显式调用 `resume`。
- **完成保护**：调用 `complete` 仅表示完成声明，须在当前轮次所有工具/子代理/审批步骤均已结束时方可调用；实际状态维持 pending，仅当本轮模型顺利收尾且最终回复文本成功交付客户端后，才在服务端投影为 `completed`；若中途又执行其它工具、被用户 Stop、失败或中断，声明失效并如实反映真实终态。
- **权威存储与级联生命周期**：Activity 概览与步骤均以 custom entries (`pi-muse.activity`) 保存于该 thread 唯一的 SessionManager / JSONL 历史树中，不维护第二套历史或单独的 activities.json。来源会话被删除时，其活动记录随 JSONL 物理文件一并清理；重新建立同名会话不会复活已删除活动。
- **真实逐步明细与安全观察**：明细步骤由 `createActivityObserver` 从真实的 SDK 事件流与审批回调捕获（包含 execution、model、tool、subagent、approval、file_commit），不依赖模型在事后回忆或编造。子代理步骤以 `main:tool:<parentCallId>` 为 parentId 形成嵌套；所有步骤严格遵守脱敏与安全展示规则，不暴露原始工具参数、全文载荷、模型思维或内部诊断。
- **查询接口**：对外暴露只读的 `GET /api/activities`（支持 `limit` 1–100、不透明 base64url 游标、`spaceId` 与 `status` 过滤；按 `createdAt` 倒序及唯一 ID 全序稳定排序）与 `GET /api/activities/:id`（概览与逐步明细）；不提供前端直接写或强制完成活动的 HTTP 接口。分页不冻结快照。

## 文件工具与审批

- read/grep/find/ls 默认只可达 `DATA_DIR/workspace/threads/<threadId>/`，主会话使用 `threads/local-main/`，无父目录特权。`workspace/`、`threads/` 仅是容器，不得回退为会话根；`shared/...` 仅映射到 `workspace/shared/`。HTTP 手动文件管理使用显式 `scope=space|shared` 选择根，不再解释 `shared/` 前缀；scope=space 必须指向已有空间，GET 与写操作都不隐式创建空间。
- 拒绝绝对路径、`..`、根/中间目录/目标符号链接。只读 operations 核查 SDK 最终解析路径，递归 grep/find 不跟随链接，ls 跳过链接。仅 read 可额外读取本轮启用技能的精确 `SKILL.md` 与 `references/`、`assets/` 下受支持文本资源；例外按技能根到目标的全链路逐次复核，不开放 ls/grep/find、相邻文件、配置或代码。
- `bash` 永不暴露。`write`/`edit` 默认开启，可由 `tools.writable.enabled` 关闭；仅注册受控工具，不开放 pi 默认的无限制写工具。主会话另有 `skills` 技能维护工具：`action=list|read|save`，`name` 为小写字母/数字/连字符且至多 64 位，`file` 默认 `SKILL.md`，`save` 必须提供完整 UTF-8 内容；该工具由默认启用的 `skill-creator` 技能映射，子代理不装配。
- `skills.list` 返回当前空间生效状态与 builtin/user 来源，不返回物理路径；`skills.read` 可读已安装或禁用技能以供编辑。`skills.save` 只写 `DATA_DIR/skills/<name>`；同名内置技能写成实例覆盖，绝不修改内置文件。资源文件必须等合法实例 `SKILL.md` 先存在，避免产生 loader 看不到的孤儿资源。
- 技能文件仅允许 `SKILL.md` 与 `references/`、`assets/` 下 `.md/.txt/.json/.csv/.yaml/.yml` 普通文本，单文件 100KB；拒绝路径穿越、绝对路径、空格/非法文件名、符号链接、目录操作、`config.json`、脚本/代码与二进制。`SKILL.md` 先用 pi `parseFrontmatter` 精确要求 frontmatter `name === 目录名`，再复用 `loadSkillsFromDir` 全量校验。禁止在资源目录保存嵌套 `SKILL.md`。
- 技能保存复用 file_write/file_edit 审批、版本绑定、Stop/过期/拒绝语义与共享提交队列。审批 preview 使用 `scope=skill`、`ownerSpaceId=null`、`workspaceSpaceId=null`，逻辑 path 为 `<name>/<file>`；批准提交后回读确认。新建技能仅系统创建 `{ "defaultEnabled": false }`，不隐式打开全局或当前空间；启用后的变化从下一轮模型装配生效，结果未明不得自动重发。
- `tools.writable.enabled=false` 时 `skills.list/read` 仍可用，`skills.save` 受控拒绝；该开关仍会移除普通 `write/edit`，不扩大普通工作区权限。技能 authoring 不提供删除、市场、版本平台或 extension 编辑；已安装 extension 属可信服务端代码，与可编辑文本资源隔离。
- 审批域记录人的决定和工具回报的执行事实，不直接执行副作用。每次操作登记完整路径、内容/编辑前后文本、文件基准版本及 spaceId/runId/expiresAt，可关联 activityId/toolCallId；Web 原样转义展示完整预览，不能只展示截断摘要让人批准。
- 截止时间登记时固定，决定时原子检查过期；Stop/abort 撤销 pending，启动前撤销旧进程遗留 pending。批准旧卡片不能复活已取消的执行。
- 提交前再次核对路径、版本、审批期限与取消状态。不同工具实例共用逐物理路径队列；文件变化必须重新申请审批。拒绝、过期或运行取消不提交该次修改，不覆盖他人新内容。手动 HTTP 新建/更新/删除与模型工具提交注入同一个队列；HTTP 更新同样先写临时文件再替换，不截断旧文件。客户端必须在调用前完整展示 before/after 并取得用户确认，但这不是模型审批，也不能改变模型工具的版本绑定审批。
- 写入/编辑先写同目录临时文件再提交，限制正文大小；保护针对单进程工具并发，不承诺抵御外部恶意进程在最终检查与 rename 间的路径竞争，不增加跨进程锁或事务框架。
- approved 仅表示人的批准，不代表磁盘提交成功。工具先原子登记执行开始，再报告实际提交结果；无执行回报时不推断成功，重启将遗留 running 执行标记 unknown，不重跑文件操作。会话规则、技能开关和展示策略不能绕过路径边界或审批。
- 终态历史与登记时的完整预览长期保留，不按时间或条数裁剪；历史分页只返回摘要，完整预览按需读取详情。相同决定幂等返回，不延长授权也不重新执行；相反决定、过期或取消发生冲突。读取 pending 不返回过期项，也不为查询改写决定状态。
- 审批预览主要通过 SSE 直接推送；人工决定及每次执行回执递增持久 revision，防止客户端按版本去重时丢失执行结果。resolvedAt 表示审批终态时间；decidedAt 只表示人工批准/拒绝，过期或取消不得伪造人的决定。历史按 resolvedAt 倒序分页，查询过滤与游标绑定。
- 路径 guard 不是操作系统沙箱；已安装的可信技能 extension 是服务端代码，不承诺用普通文件工具边界限制它。

## 外部 Web 与凭据

- Web 工具默认仅允许公网 HTTP(S)：DNS 校验、私网拒绝、固定解析防 rebinding、重定向逐跳校验、响应大小及超时限制。`tools.web.allowPrivateTargets: true` 仅显式放宽私网目标，不改变其余边界。搜索摘要和页面内容必须标记不可信数据。
- Web service 返回结构化成功/失败联合结果，监控等业务消费者直接读取；pi 工具层才负责 JSON 序列化与错误标记，不从工具文本反向解析业务状态。
- 取消信号必须沿工具、service、transport 传到在途网络请求，停止不伪装成普通成功或触发搜索兜底；不能只取消客户端显示而等待工具继续执行。
- 模型 key 只在受保护实例配置与服务端内存，不写 pi auth.json、日志、客户端或 JSONL；provider/runtime key 在 bootstrap 注册一次。独立资源目录不加载个人 CLI 全局配置、skills、extensions 或 MCP。
- 单进程单 DATA_DIR；保留 accessKey 鉴权中间件。默认 `0.0.0.0` 便于局域网访问，缺 accessKey 会警告；生产部署应显式配置访问密钥。配置和启动细节见 [配置说明](manual/configuration.md)。
- 真实浏览器是独立 `browser` 域，不复用 `web_fetch`。默认同样拒绝私网目标；`tools.browser.allowPrivateTargets` 仅用于本机联调。页面标题、文本和元素名是不可信数据；不向模型暴露任意 JavaScript evaluate，不返回 cookie/localStorage/密码值。

## 真实浏览器

- `BrowserService` 是全局唯一入口，HTTP REST、`/browser` 调试页、WS 输入与 Agent 工具共享同一个懒启动、始终带 GUI 的系统 Chrome 和持久 profile；不做多实例、控制权租约或崩溃恢复框架。CDP 帧流转发 active tab 视口；Docker 场景另用 Xvfb/x11vnc/noVNC 暴露完整真实窗口，两者不替代彼此，也不用无头渲染替代 GUI。
- 全局只维护一份标签列表；仅当前激活标签在有 WS 订阅者时启动 CDP screencast，切换标签先停止旧流再启动新流，无订阅者时停止推帧。慢客户端按未 ack 帧跳帧，缓冲超限时断开。
- WS 先用现有 Bearer token 换取一次性短时 ticket，长期 token 不进入 URL；帧格式、输入消息与 ack 语义以 `src/http/contracts/browser.ts` 生成的 OpenAPI extension 为准。
- snapshot 是服务端固定实现的可见结构投影，仅用于给模型提供标题、文本、元素角色与 ref；外部内容一律标记不可信，不提供任意 JavaScript evaluate。
- 浏览器核心只依赖 `features/browser`、`adapters/browser` 与基础 shared 工具；REST/WS 是薄协议适配，pi 工具是薄入口适配。禁止 browser 引用 `web_fetch`、conversation 或应用组装层，保证后续可以整体抽成独立浏览器服务。

## 生命周期

1. 组装 repository/services，读取并校验持久域（含消息反馈与信息事件文件）；重算 jobs、撤销旧 pending 审批，校准中断的信息 run，不恢复崩溃模型轮或旧 worker。所有实际执行源最后才启动。
2. HTTP/协议复用已注入服务，不自行启动 scheduler。service.close 同步关门，新 HTTP 请求返回 503，hub/scheduler/subagent 不再创建或派发新工作。
3. 先停调度、取消会话并结束工作区通知长连接，等待已发出的执行、通知、状态写入和已接纳 HTTP 请求收尾。关闭必须幂等，某个清理失败也不跳过其他实例。
4. 进程入口停止接收连接并等待 close；mock 入口额外关闭 fake provider，浏览器域结束 WS 订阅并优雅关闭 Chrome。初始化失败也必须清理本次已分配资源，不能遗留定时器、socket 或进程。

## 数据布局与校验

路径统一由 `src/adapters/storage/data-layout.ts` 声明，不在新能力里散写路径。下表基于 DATA_DIR；内置 assets 随服务代码/构建发布，不是新增实例状态。

| 路径 | 内容 |
| --- | --- |
| `sessions/<threadId>/*.jsonl` | pi 历史唯一权威来源 |
| `messages/<spaceId>/<sessionId>.json` | Pi Muse 消息反馈原始事件；正文仍在上方 PI JSONL |
| `information/<spaceId>.json` | 空间局部信息设置、偏好 notes、原始条目、模型决策与发布溯源；reset 保留，delete 级联删除 |
| `sessions/<threadId>/INSTRUCTIONS.md` | 本会话专属规则（含 `## 空间用途`），下一轮注入 |
| `sessions/<threadId>/DREAM.md` | 本会话补充 Dream 提示词，按需存在 |
| `sessions/<threadId>/dream.json` | 本会话 Dream 开关、游标、最近结果与待确认项，按需存在 |
| `sessions/<threadId>/skills.json` | 本会话技能开关覆盖，技能资产全局一份 |
| `profile/SOUL.md` / `profile/USER.md` / `profile/DREAM.md` | 全局自由文本身份与 Dream 提示词（`DREAM.md` 缺失时回退内置默认） |
| `profile/memory.json` | 长期记忆（按需检索）与 identity 设置 |
| `jobs.json` / `goals.json` / `actions.json` / `monitors.json` | 对应域持久状态 |
| `workspace/threads/<threadId>/` | 会话私有文件工具根；主会话也在此布局内 |
| `workspace/shared/` | 全局共享区，用 `shared/...` 显式访问 |
| `subagents/*.md` | 实例级 role 覆盖，优先于内置 `assets/subagents/<role>.md` |
| `skills/<name>/SKILL.md` | 实例级技能资产 |
| `config.json` / `auth.key` / `agent/` | 必需配置、token 签名密钥与 pi 运行资源 |
| `browser/profile/` | 系统 Chrome 持久 profile；与配置同级按敏感登录态保护，不给普通文件工具访问 |

- pi `continueRecent` 与执行使用同一会话私有 cwd；重启仅恢复相同 cwd 的权威历史，不回退旧路径。sessions 初始化只 mkdir，不探测、搬移或删除旧 workspace 根文件与旧历史；已有数据需停服后单独备份处理。
- `memory.json` 为 `{ memories: [...], identity: {...} }`，已有文档必须包含完整 identity；jobs/goals/actions/monitors 为裸数组。持久业务文档目前不写 `schemaVersion`，拒绝带版本的对象，等待显式版本 reader；不要与启动配置的 schemaVersion 混淆。
- 仅文件缺失可返回初始化默认值（`SOUL.md`/`USER.md`/`DREAM.md`/`INSTRUCTIONS.md` 同样仅 `ENOENT` 视为空串，其他 I/O 错误抛错）；JSON 损坏、非法根结构、已知字段类型错误、未知版本与其他 I/O 错误必须抛错。每个条目都应符合当前 reader，任一坏条目整体拒绝，禁止过滤后静默丢失或填补已有文档字段。
- 写入先在内存序列化，以 `wx`、`0600` 创建同目录临时文件，再 `rename`；文本档案与会话指令共用带预期版本比对的原子写入口，防止后台整理覆盖并发编辑。不做 fsync、自动重试、跨进程锁或 durable execution。
- 损坏文件需停止服务、保留原件并从有效备份恢复，不直接删文件消除报错。未来格式/路径变更单独设计离线迁移与回退，不运行中双写，不保留隐式旧 reader。
- `runtime.dataDir` 省略或为相对路径时按配置文件目录解析，不按进程 cwd；嵌套目录陷阱与完整实例树见 [配置说明](manual/configuration.md#instance-directory-structure)。

## HTTP 与前端适配边界

本节只说明层间职责，字段和客户端关键接入步骤必须来自 `src/http/contracts/` 与生成的 `/docs` / `/openapi.json`，不在 Markdown 维护第二份规范；修改前读 [API 开发规范](api-development.md)。

- Hono 直接处理聊天增量请求并输出 AG-UI SSE，不引入 CopilotKit runtime、PiAgent 或旧宿主 runner；HTTP/presenter 不拥有业务状态。
- DTO、消息、事件联合类型从 schema 推导，自有 Web 对入站 SSE 同源校验，畸形事件或缺终态断流明确失败，不伪造成功。
- Web history/SSE/结束刷新绑定 thread 与运行代次，切换/卸载取消原流。客户端同步 revision、恢复冲突草稿并等待 Stop 收尾，具体协议由生成契约约束，不自行用旧快照覆盖服务端事实。
- 审批单独读取 pending 完整预览、历史摘要与详情，不塞入工作台快照；token 是前端唯一认证事实，401 与跨标签退出及时同步登录状态。
- `src/bootstrap/service-version.ts` 在源码启动时固定 package/git/白名单源码 SHA-256 快照；构建产物读取 `dist/service-version.json`，不在请求时执行 git 或读取源码。health、OpenAPI 和 Scalar 共用版本身份，dirty=true 时比较 sourceHash，不只比较 commit。
- `/api/events` 是单向工作区推送：运行/审批/活动携带展示投影，通知落盘只发送会话身份失效信号；断开此流不取消聊天。聊天流与工作区通知的事件表和取消语义不得混用，具体协议以各自契约为准。

## 新能力接入

1. 无状态只读工具直接放 `src/adapters/pi/tools/`；有独立业务规则或持久化才新增 `src/features/<name>/`，文件读写放 storage adapter。
2. 工具在 `src/adapters/pi/tools/index.ts` 显式注册；allowlist 从实际注册结果生成，不扫描目录自动注册，不维护第二套名单。当前工具与可选开关以注册实现和配置为准。
3. 新增网络、写入、MCP 或委托能力先设计权限与失败边界，不能因注册工具扩大权限。
4. 先核对自有 `web/` 的 renderer 与 HTTP 契约；工具名、参数、结果 JSON、事件顺序必须兼容实际 schema，不用假数据伪装已有展示能力。协议展示放适配层，按需扩展 contracts/routes/presenter。
5. 在 `src/bootstrap/create-service.ts` 显式创建并注入唯一实例，不继续堆入 conversation、HTTP app 或 session factory；纯规则与跨层验证按 [测试规范](testing.md)执行，接口/工具报文变更同时遵守 [API 开发规范](api-development.md)。
