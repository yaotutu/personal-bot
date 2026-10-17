# AGENTS.md — pi-muse 项目指南

基于 pi 的个人助手服务端：单模型、单用户、多 thread，每个 thread 使用独立 pi 会话；主要客户端为仓库内的自有 `web/`（Vite 15173）；不提供 OpenMuse/CopilotKit 宿主兼容接口。
最终目标是复刻 nanobot 的个人助手能力，**不做**多 channel 对接。

## 开发约定

- JS/TS 优先函数式编程，使用函数式工厂和显式依赖注入；不引入 DI 框架。
- 添加详细中文注释，重点解释职责边界、安全约束、兼容原因和生命周期，不逐行复述代码。
- 禁止过度设计：按实际职责拆分，以 `features/` 命名业务目录；不创建空壳抽象、全局 `utils.ts`、通用插件框架、事件总线或泛型 CRUD。
- nanobot 是默认的产品行为参考：核对源码后直接实现可兼容逻辑，不把常规实现选择反复交给用户；明显不适配 pi 执行内核或触及现有安全边界时才单独提示，不为对齐行为修改 pi 底层。
- 双参考系优先级：交互、UI、HTTP、AG-UI 报文、工具卡片与客户端行为先核对自有 `web/` 和 `src/http/contracts/`。服务端能力语义、调度、副作用、失败策略先核对 nanobot 源码，再适配 pi。两边冲突时，不修改 pi 底层，不用假数据伪装兼容，明确选择更符合当前产品边界的一侧并记录差异。
- 工具名、参数名、结果 JSON 结构和事件顺序都是协议契约；已有专用 renderer 时必须按其 schema 返回。新增/改名工具要用自有 Web DEV 页面验收，不只看 AG-UI 事件。
- Subagent 只承担边界明确、容易验收的小任务；架构设计、跨层改造和关键路径留在主 Agent，不为了并行而并行。
- 测试使用隔离实例目录；未经明确要求，不修改真实 `.pi-muse/`（含 config.json）数据或 OpenMuse 仓库，不自动 commit/push，不撤销已有改动。

## 常用命令

```sh
pnpm dev        # 真实模型服务端（必需 .pi-muse/config.json，0.0.0.0:17890，tsx watch 热重载；端口被占会直接报错并给出占用 PID）
pnpm dev:mock   # 本地模拟模型（127.0.0.1:17891，不读正式 config，数据在 .pi-muse/mock）
pnpm test       # unit/integration + fake provider，数量及结果以实际输出为准
pnpm typecheck && pnpm build
```

自有 Web 客户端：`cd web && pnpm install && pnpm dev`（15173，dev 模式热更新），默认 `/api` 代理到 `http://127.0.0.1:17890`。mock 联调使用 `API_TARGET=http://127.0.0.1:17891 pnpm dev`；`API_TARGET` 只影响 Vite 代理，不是服务端配置覆盖。

默认 CORS 包含 localhost / 127.0.0.1 的 15173、17890 四个 origin，便于 Web 与服务端从本机或局域网 origin 访问。显式 `server.allowedOrigins` 会替换默认列表。

**端口选择**：服务端默认 17890、mock 默认 17891、Web dev 默认 15173、Web preview 默认 14173；均避开 nanobot(7890) 与 Vite(5173/4173) 的默认区间。**不会自动避让已占用端口**：被占用时启动直接失败，错误信息包含占用进程的 PID（用 `lsof` 查出，跨平台不兼容时退化为通用提示），由用户决定是改 `server.port` 还是 `kill -15 <pid>` 释放端口。

## 架构分层（自上而下）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 进程入口 | `src/index.ts` `scripts/dev-mock.ts` | 配置、HTTP server 启停、信号处理；统一调用组合入口 |
| 配置 | `src/config/load-config.ts` `config.example.json` | 必需 JSON 配置文件、直接凭据与校验；无环境变量回退，不创建业务实例 |
| 组合与生命周期 | `src/bootstrap/create-service.ts` `src/bootstrap/types.ts` | 组装共享业务服务与 conversation hub；按 thread 创建会话协调器和 pi 历史，启动调度，统一 close |
| 数据路径适配 | `src/adapters/storage/data-layout.ts` | 集中声明现有 DATA_DIR 路径；本轮不迁移数据 |
| HTTP/协议 | `src/http/app.ts` | Hono 路由：自有业务接口、AG-UI SSE 挂载、鉴权、CORS；不启动调度器 |
| AG-UI 适配 | `src/adapters/ag-ui/` | Hono 路由与事件投影：SSE 断开取消所属 run，不再依赖 runtime/agent 宿主 |
| 会话协调 | `src/features/conversation/` | hub 按 thread 管理协调器；同一 thread 的 run / trigger 共用互斥锁，负责输入校验/去重/取消/超时；通过注入 port 访问历史与执行 |
| pi 适配 | `src/adapters/pi/` | session factory、权威历史与展示投影、执行事件脱敏、资源隔离、prompt、显式工具装配与 guardTool 路径边界 |
| Web / 天气 | `src/features/web/` `src/adapters/web/` `src/features/weather/` `src/adapters/weather/` | 搜索结果/页面内容投影与不可信标记；Open-Meteo 天气查询；公网 HTTP(S) DNS 校验、固定解析、重定向与大小/超时限制 |
| 能力与调度 | `src/features/memory/` `src/features/identity/` `src/features/jobs/` `src/adapters/storage/` | 业务 service 与 JSON repository 分开；调度器独立于 HTTP，固定扫描与生命周期由组合入口管理 |
| 客户端契约 | `src/http/contracts/` `src/http/routes/` `src/http/job-presenters.ts` | 自有 Web 共用的 HTTP 契约与响应投影；不拥有业务状态 |
| 鉴权 | `src/adapters/auth/token-service.ts` | 登录、token 与签名密钥；不承载业务规则 |
| 共享基础 | `src/shared/serialized-writer.ts` | 真正复用的串行写队列；shared 不作为杂项收纳箱 |
| 模拟 | `tests/support/fake-model.ts` | OpenAI SSE 模拟 provider，按触发词走各工具路径 |

历史重构记录见 `docs/archive/refactoring-plan.md`；当前会话历史按 thread 存放，不再使用单会话的平铺目录描述。

### 依赖与状态所有权

- feature 只依赖业务类型与实际需要的最小 port，不依赖 Hono、AG-UI、pi SDK、文件系统或具体 adapter。`tests/unit/dependencies.test.ts` 检查此边界；现有 ID 生成允许使用 `node:crypto`。
- adapter 实现 port，bootstrap 显式组装双方；HTTP 只使用注入的服务，不重新创建实例或启动 scheduler。
- 每个 thread 的 conversation 是该 thread 的 active run、运行锁和取消状态的唯一所有者；同 thread 的客户端轮与触发轮共锁，但不擅自统一二者的超时或 SSE 行为。
- 各 thread 的 pi SessionManager/JSONL 是其历史唯一权威来源，不维护第二套历史存储；模型与工具诊断必须在 pi 持久化前脱敏，不能只清洗 SSE 输出。内部 `task-*` thread 不显示在用户会话列表中。
- memory/identity 共用 repository 与完整读改写队列；同一文档不得创建第二个 writer。close 必须幂等，先停调度，再取消会话并等待已发出的任务与状态写入完成。

### 聊天与审批协议

- `GET /api/conversation` 返回 `{messages, revision}`；`POST /api/conversation/run` 仅接收 `{threadId, runId, expectedRevision, message:{id,content}}`，禁止回传全量历史。版本冲突在 SSE 前返回 HTTP 409；同一成功 run 的原消息可以幂等重放。
- `POST /api/conversation/stop` 必须同时指定 threadId/runId；Web 等待服务端取消完成后刷新历史，冲突恢复未接纳的草稿。切换会话直接取消原流。
- 审批轮询使用 `GET /api/actions/pending`，返回完整预览；`GET /api/actions` 只返回历史摘要，单项详情按需读取；工作台快照不包含审批。
- monitor 扫描不等待通知投递；按通知 ID 跟踪在途、确认后清 pending，单项错误不阻断其他监控。Web service 返回结构化结果，pi 工具层才序列化 JSON。

### 新能力接入

1. 无状态只读工具直接放 `src/adapters/pi/tools/`；有独立业务规则或持久化时才新增 `src/features/<name>/`，文件读写放 storage adapter。
2. 工具在 `src/adapters/pi/tools/index.ts` 显式注册，allowlist 从注册结果生成；禁止扫描目录自动注册或维护第二套名单。
3. 先查自有 `web/` 与 HTTP 契约是否已有对应工具展示或管理入口。协议展示放对应适配层，按实际需要扩展契约/routes/presenter，不把新功能堆进 conversation、HTTP app 或 session factory。
4. 在 `src/bootstrap/create-service.ts` 显式创建并注入依赖，为纯规则补 unit tests，为 HTTP/pi/tool/history 行为补 integration tests。
5. 新增网络、写文件、MCP、委托任务等能力前单独设计权限和错误边界；注册新工具不等于自动扩大权限。

## 硬边界（违规即返工）

- 模型 key 只驻留受保护的 `.pi-muse/config.json` 与服务端内存；不写日志、不返回客户端、不进会话文件。
- 文件工具只允许 `DATA_DIR/workspace`（路径 guard 强制，绝对路径/`../` 逃逸拒绝）；读始终开放。`write`/`edit` 默认开启（`tools.writable.enabled` 可关闭），但每次都需人工审批，载荷包含完整修改前后文本并绑定文件版本；写入拒绝目标及父目录符号链接，提交前再次核对路径、版本、审批期限与取消状态。文件变化须重新审批，拒绝/过期/运行取消不提交该次修改，服务重启取消遗留 pending 审批。
- Web 工具默认只允许公网 HTTP(S)（DNS 校验/私网拒绝/IP 固定防 rebinding/重定向逐跳校验/大小超时限制；内容标记不可信）。本机联调可经 config `tools.web.allowPrivateTargets: true` 显式放宽（默认关闭，不改变其余边界）。搜索摘要和页面内容必须标记为不可信数据。
- 工具/模型的错误信息默认脱敏（"Tool execution failed"/"Model request failed"）；仅 guard 声明的受控拒绝文案（`details.denied`）可透传。
- 不在 `createAgentSession` 之外手写 agent loop；工具执行与持久化交给 pi。
- 工具显式注册包括 `currentTime`、`memory`、`schedule`、`delegate_task`、`goal`、`monitor`、`read`、`grep`、`find`、`ls`、`write`、`edit`、`search_web`、`web_fetch`、`get_weather`；执行 allowlist 由实际注册结果生成，可选能力按配置启用。`bash` 永不暴露，`write`/`edit` 不得绕过逐次审批。
- 单进程单 DATA_DIR；默认 host 为 `0.0.0.0` 便于局域网访问，但启动时会打印 `server.accessKey` 缺失警告。生产部署应在 config.json 显式设置 `server.accessKey` 并保留 accessKey 鉴权中间件。

## 设计哲学（用户定论，勿违背）

- **nanobot 行为优先**：默认参考本机 nanobot 实现可兼容的个人助手行为，不逐项让用户选择技术方案；仅在与 pi 或已确认的产品规则明显不兼容时提示。不得为照搬 nanobot 修改 pi SDK、重写 agent loop 或扩大权限。
- **简单优先，崩了重跑**：不为低概率故障做复杂设计；无 durable execution、无断点续跑、无模型/工具自动重试。定时任务失败只诚实标记；scheduler 可以在固定扫描时补存同一次执行结果，但绝不重新执行模型或工具。
- **自有 Web、无历史兼容**：主要客户端为仓库内 `web/`，直接消费 HTTP 契约与 AG-UI。不保留旧请求、旧字段或旧存储 reader；不合适的结构直接重构，历史文档仅在 archive 留作记录。
- 记忆只显式写入（对话工具 + HTTP 记忆管理接口），不做自动提取。
- 新工具是否需要客户端展示改动，以自有 Web 的现有 renderer 和契约为准。

## 测试与 fake-model 触发词

测试按职责分布：`tests/unit/` 测纯规则与适配边界，`tests/integration/` 测完整链路，`tests/support/` 放 fake provider 等辅助代码。`pnpm test` 显式运行前两个目录的 `*.test.ts`，任一目录未发现测试都会失败；每项测试超时为 60 秒，support 不作为测试入口。

代码改动后运行 `pnpm typecheck && pnpm test && pnpm build`，并执行 `git diff --check`。只改文档可检查差异与引用，不必重复全量测试。涉及启动/退出时补隔离 DATA_DIR 的进程检查，覆盖初始化失败清理与 SIGTERM；不能用 fake provider 结果代替真实模型 Web 验收。涉及客户端展示或工具报文时，主要在自有 Web 15173 DEV 页面验证实际 renderer、历史刷新和错误态，接口/schema 测试不能替代页面观察。

集成测试走真实 HTTP + pi 链路，仅模型是模拟的。触发词表（`tests/support/fake-model.ts`）：

| 用户消息 | 模拟行为 |
| --- | --- |
| 含 `时间/几点` | currentTime 工具轮 → 第二轮 `time reply: <结果>` |
| 含 `读`（含 `敏感/secret` 则越界） | read 工具轮（越界路径 `/etc/passwd`）→ `file reply:` |
| 含 `记住/忘掉` | memory 工具轮 → `memory reply:` |
| 含 `提醒我` | schedule 工具（15 秒后一次性任务）→ `schedule reply:` |
| 以 `⏰` 开头 | 直接回 `JOB-RAN ...`（定时触发轮） |
| system 含 `context summarization assistant` | 返回短摘要（pi 压缩请求） |
| 字面量 `fail-once/freeze/slow/disconnect/broken` | 401 一次 / 挂起 / 慢流 / 断流 / 半截响应 |
| `工具后失败/工具后挂起` | 工具已执行后，最终模型 401 / 挂起；副作用不回滚 |
| `empty/malformed` | 空 choices / 畸形 SSE；由 pi 解析并以失败终态释放会话 |

测试配置对象中 `model.maxTokens` 必须 < `model.contextWindow`；不合法时 createConfig/loadConfig 抛错。harness 在初始化失败时也必须清理所有已分配资源，配置/service/login 失败已有回归测试，避免 fake provider 遗留导致测试进程 hang。

## 数据目录（`.pi-muse/`，gitignore）

| 路径 | 内容 |
| --- | --- |
| `sessions/<threadId>/` | 每个 thread 的 pi 会话 JSONL（历史权威来源）；内部 `task-*` 不显示在用户会话列表中 |
| `SOUL.md` / `USER.md` | 自由文本身份（注入 system prompt，每轮重读） |
| `memory.json` | 长期记忆条目 + identity 设置（P3 权威存储） |
| `goals.json` `tasks.json` `actions.json` `monitors.json` | 目标 / 后台任务 / 审批 / 监控（各自裸数组） |
| `jobs.json` | 定时任务（P4） |
| `workspace/` | 文件工具的唯一可达范围：read/grep/find/ls，以及逐次审批的 write/edit |
| `config.json` | 必需服务配置；模型 key 与访问密钥直接存放于此 |
| `agent/` `auth.key` | pi 运行目录 / token 签名密钥 |

- 路径统一由 `src/adapters/storage/data-layout.ts` 声明，不在新能力里散写文件路径。
- `memory.json` 保持 `{ memories: [...], identity: {...} }` 对象格式，已有文档必须包含完整 identity；`jobs.json` 保持裸数组。目前不写 `schemaVersion`，带版本字段的对象必须拒绝，等待显式版本 reader。
- 仅文件缺失可返回初始化默认值；JSON 损坏、非法根结构、已知 identity 字段类型错误、未知版本和其他 I/O 错误必须抛错，禁止静默覆盖为空文档。条目必须满足当前 reader，不允许静默过滤坏条目后写回，缺省只在整个文件不存在时生成。
- 写入先在内存序列化，以 `wx`、`0600` 创建同目录临时文件，再 `rename` 替换；失败清理本次临时文件并保留原始错误。底层 writer 不做 fsync、自动重试、跨进程锁或 durable execution；scheduler 的补存仅重用已经得到的运行结果和完成时间。
- 损坏文档需停止服务、保留原件并从有效备份恢复，不直接删文件消除报错。未来若改格式或路径，单独设计离线迁移与回退，不运行中双写。

## API 文档（自动生成，禁止手写 OpenAPI）

- **端点注册表** `src/http/contracts/endpoints.ts` 是所有对外 HTTP 接口的唯一清单：
  新增/修改端点必须在此登记（method/path/tag/summary/hint/request/response schema）。
- **schema 即文档**：`contracts/rest.ts`（请求）、`contracts/responses.ts`（响应）、
  `contracts/sse-events.ts`（AG-UI 事件子集）全部 zod v4；`.describe()` 直接进文档。
  **禁止手写 OpenAPI JSON/YAML 文件**——文档由 `src/http/openapi.ts` 调
  `z.toJSONSchema`（请求 io=input、响应 io=output）自动拼装 OpenAPI 3.1。
- 运行时端点：`GET /openapi.json`（规范本体）、`GET /docs`（Scalar 页，
  本地 bundle `/scalar.js` 优先、加载失败回退 CDN）。三者免鉴权。
- **防漂移**：`tests/integration/docs-contract.test.ts` 四重守卫——结构完整
  （每端点有 summary+schema）、文档路由可达、无副作用 GET 响应被注册表
  schema safeParse、**双向路由审计**（Hono 实际路由表 ↔ 注册表逐条比对：
  加了路由不登记→"文档会漏掉它"红；登记了不实现→"文档在撒谎"红。
  例外仅为 /docs 三条文档基础设施路由）。
  改接口不改 schema，测试红；漏登记新端点，测试红。
- SSE 端点在 OpenAPI 里标 `text/event-stream`，事件契约挂 `x-sse-events` 扩展
  （agent 可直接读）；非法 threadId 在宿主预校验即 HTTP 400（不进 SSE 流）。

## 监控域（monitors）

- `src/features/monitors/`：网页周期监控（change=内容指纹变化；contains=关键词未命中→命中），
  首检建基线不通知；抓取复用 web 服务安全边界（公网 DNS 校验/私网拒绝），失败只记 error。
- 调度 `monitor-scheduler`（默认 60s 扫表，间隔分钟级到期的 active 才检查）；通知进入 `originThreadId` 指定的来源会话，未指定时回落主会话（📡）。
- 入口：对话 `monitor` 工具 / `POST /api/agent/monitors`；控制 pause/resume/stop。

## 异步任务域（worker）

- `src/features/tasks/`：一次性后台任务（与定时 jobs 分域），独立 thread（`task-<id>`）执行完整 pi 轮；
  worker 进程内串行；queued + running 最多 32 项，后台工具禁止 delegate_task/schedule/monitor；完成向来源会话发 📋 事实通知，未指定来源时回落主会话；内部 task thread 不显示在用户列表中，重启遗留 running 标记 failed 可重试（崩了重跑）。
- 入口：聊天 `delegate_task` 工具 / `POST /api/agent/tasks`；控制经 `/control` 按 `target: job|task` 分发。
- `/api/agent` 的 tasks 数组混合两类（kind: job=定时 / task=后台）。

## 已知限制（诚实声明）

- `runtime.dataDir` 省略时使用配置文件所在目录；相对值也按配置文件目录解析，不按进程 cwd。绝对路径推荐但非必需；配置位于 `.pi-muse/config.json` 时填 `".pi-muse"` 会指向嵌套目录，填 `"."` 才是配置文件目录本身。
- 定时触发轮无实时 SSE 推送（用户刷新/下轮同步后可见）；客户端旧历史与触发轮冲突时收到一次 409 后自动同步。服务启动时按 nanobot 语义重算 daily 任务，已过期的一次性任务不补跑。
- 工具副作用不回滚，最终模型失败不自动重试；停止后的半截 assistant 文本仍受 pi 的 `error/aborted` 历史过滤规则限制，不为此修改 pi。
- 历史第一阶段 HTTP/OpenMuse Web 记录见 `docs/archive/first-stage-acceptance.md`；历史第二阶段行为对照与验收记录见 `docs/archive/second-stage-plan.md`、`docs/archive/second-stage-acceptance.md`。其中真实模型、代理故障注入及原生客户端观察仅对应当时的版本与范围，不代表当前自有 Web 已重新验收。
- 当前主要页面验收入口是自有 Web 15173；支持单用户多 thread，不做多用户与外部 channel。OpenMuse 及原生客户端的历史验收不替代当前自有 Web 检查。

## 文档索引

- `docs/HANDOFF.md`：当前进度、验证记录、联调注意事项与后续工作，接手项目先读。
- `docs/architecture.md`：当前职责边界、状态所有权、生命周期、数据策略和新能力接入。
- `docs/archive/`：已完成阶段的历史记录（实施计划、各阶段验收、重构记录、冒烟截图）。
- `docs/configuration.md`：必需 JSON 配置、直接密钥、错误策略和字段对照。
- `docs/http-api-contract.md`：客户端协议契约；`docs/pi-reuse.md`：pi 复用边界。
- `docs/discussions/other-agent.md`：常驻专职 agent（other agent）的讨论记录，未实现，先记录。
- `README.md`：启动与使用。
