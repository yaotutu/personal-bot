# AGENTS.md — Personal Bot 项目指南

基于 pi 的个人助手服务端：单模型、单会话、单用户，对接 OpenMuse 客户端（Web 优先）。
最终目标是复刻 nanobot 的个人助手能力，**不做**多 channel 对接。

## 开发约定

- JS/TS 优先函数式编程，使用函数式工厂和显式依赖注入；不引入 DI 框架。
- 添加详细中文注释，重点解释职责边界、安全约束、兼容原因和生命周期，不逐行复述代码。
- 禁止过度设计：按实际职责拆分，以 `features/` 命名业务目录；不创建空壳抽象、全局 `utils.ts`、通用插件框架、事件总线或泛型 CRUD。
- nanobot 是默认的产品行为参考：核对源码后直接实现可兼容逻辑，不把常规实现选择反复交给用户；明显不适配 pi 执行内核或触及现有安全边界时才单独提示，不为对齐行为修改 pi 底层。
- 双参考系优先级：交互、UI、HTTP、AG-UI 报文、工具卡片与客户端行为先核对 OpenMuse 源码和现有 renderer；服务端能力语义、调度、副作用、失败策略先核对 nanobot 源码，再适配 pi 与 OpenMuse。两边冲突时，不修改 pi 底层，不用假数据伪装兼容，明确选择更符合当前产品边界的一侧并记录差异。
- 给 OpenMuse 暴露工具时，工具名、参数名、结果 JSON 结构和事件顺序都是协议契约。若客户端已有专用 renderer，必须按其 schema 返回；不能只实现 nanobot 语义后让通配卡片兜底。新增/改名工具要用真实 Web DEV 页面验收，不只看 AG-UI 事件。
- Subagent 只承担边界明确、容易验收的小任务；架构设计、跨层改造和关键路径留在主 Agent，不为了并行而并行。
- 测试使用隔离实例目录；未经明确要求，不修改真实 `.personal-bot/`（含 config.json）数据或 OpenMuse 仓库，不自动 commit/push，不撤销已有改动。

## 常用命令

```sh
pnpm dev        # 真实模型服务端（必需 .personal-bot/config.json，127.0.0.1:8787，tsx watch 热重载）
pnpm dev:mock   # 本地模拟模型（8788，不读正式 config，数据在 .personal-bot/mock）
pnpm test       # 当前 146 项测试（unit/integration + fake provider）
pnpm typecheck && pnpm build
```

OpenMuse Web 客户端（另一仓库，`~/Desktop/code/openmuse`）：
`EXPO_PUBLIC_API_URL=http://localhost:8787 pnpm dev:web`（8081，dev 模式热更新）。

## 架构分层（自上而下）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 进程入口 | `src/index.ts` `scripts/dev-mock.ts` | 配置、HTTP server 启停、信号处理；统一调用组合入口 |
| 配置 | `src/config/load-config.ts` `config.example.json` | 必需 JSON 配置文件、直接凭据与校验；无环境变量回退，不创建业务实例 |
| 组合与生命周期 | `src/bootstrap/create-service.ts` `src/bootstrap/types.ts` | 创建唯一 auth/memory/identity/jobs/conversation/scheduler 实例，启动调度，统一 close |
| 数据路径适配 | `src/adapters/storage/data-layout.ts` | 集中声明现有 DATA_DIR 路径；本轮不迁移数据 |
| HTTP/协议 | `src/http/app.ts` | Hono 路由：OpenMuse 快照接口（兼容层）、AG-UI runtime 挂载、鉴权、CORS；不启动调度器 |
| AG-UI 适配 | `src/adapters/ag-ui/` | PiAgent/runner/路由：SSE 退订即取消 |
| 会话协调 | `src/features/conversation/` | run（客户端轮）/ trigger（定时轮）共用互斥锁；输入校验/去重/取消/超时；通过注入 port 访问历史与执行 |
| pi 适配 | `src/adapters/pi/` | session factory、权威历史与展示投影、执行事件脱敏、资源隔离、prompt、显式工具装配与 guardTool 路径边界 |
| Web / 天气 | `src/features/web/` `src/adapters/web/` `src/features/weather/` `src/adapters/weather/` | 搜索结果/页面内容投影与不可信标记；Open-Meteo 天气查询；公网 HTTP(S) DNS 校验、固定解析、重定向与大小/超时限制 |
| 能力与调度 | `src/features/memory/` `src/features/identity/` `src/features/jobs/` `src/adapters/storage/` | 业务 service 与 JSON repository 分开；调度器独立于 HTTP，固定扫描与生命周期由组合入口管理 |
| 客户端兼容 | `src/adapters/openmuse/` | OpenMuse schema、路由与 presenter；不拥有业务状态 |
| 鉴权 | `src/adapters/auth/token-service.ts` | 登录、token 与签名密钥；不承载业务规则 |
| 共享基础 | `src/shared/serialized-writer.ts` | 真正复用的串行写队列；shared 不作为杂项收纳箱 |
| 模拟 | `tests/support/fake-model.ts` | OpenAI SSE 模拟 provider，按触发词走各工具路径 |

R0-R6 与 R7A 已完成；R7B（物理数据目录迁移）条件性延期，当前路径和文件格式保持不变。

### 依赖与状态所有权

- feature 只依赖业务类型与实际需要的最小 port，不依赖 Hono、AG-UI、pi SDK、文件系统或具体 adapter。`tests/unit/dependencies.test.ts` 检查此边界；现有 ID 生成允许使用 `node:crypto`。
- adapter 实现 port，bootstrap 显式组装双方；HTTP 只使用注入的服务，不重新创建实例或启动 scheduler。
- conversation 是 active run、运行锁和取消状态的唯一所有者；客户端轮与定时轮共锁，但不擅自统一二者的超时或 SSE 行为。
- pi SessionManager/JSONL 是历史唯一权威来源，不维护第二套历史存储；模型与工具诊断必须在 pi 持久化前脱敏，不能只清洗 SSE 输出。
- memory/identity 共用 repository 与完整读改写队列；同一文档不得创建第二个 writer。close 必须幂等，先停调度，再取消会话并等待已发出的任务与状态写入完成。

### 新能力接入

1. 无状态只读工具直接放 `src/adapters/pi/tools/`；有独立业务规则或持久化时才新增 `src/features/<name>/`，文件读写放 storage adapter。
2. 工具在 `src/adapters/pi/tools/index.ts` 显式注册，allowlist 从注册结果生成；禁止扫描目录自动注册或维护第二套名单。
3. 先查 OpenMuse 客户端是否已有同名工具或专用 renderer；若有，工具名和结果 JSON 必须兼容该 renderer。协议展示放对应 adapter；确有管理界面才扩展 OpenMuse schema/routes/presenter，不把新功能堆进 conversation、HTTP app 或 session factory。
4. 在 `src/bootstrap/create-service.ts` 显式创建并注入依赖，为纯规则补 unit tests，为 HTTP/pi/tool/history 行为补 integration tests。
5. 新增网络、写文件、MCP、委托任务等能力前单独设计权限和错误边界；注册新工具不等于自动扩大权限。

## 硬边界（违规即返工）

- 模型 key 只驻留受保护的 `.personal-bot/config.json` 与服务端内存；不写日志、不返回客户端、不进会话文件。
- 文件工具只读且只允许 `DATA_DIR/workspace`（guardTool 强制，绝对路径/`../` 逃逸拒绝）。
- Web 工具只允许公网 HTTP(S)；DNS 解析结果为私网/回环/链路本地/保留地址时拒绝，并固定已校验 IP 防 rebinding；重定向逐跳重新校验，响应限制大小与超时。搜索摘要和页面内容必须标记为不可信数据。
- 工具/模型的错误信息默认脱敏（"Tool execution failed"/"Model request failed"）；仅 guard 声明的受控拒绝文案（`details.denied`）可透传。
- 不在 `createAgentSession` 之外手写 agent loop；工具执行与持久化交给 pi。
- 允许列表：`tools: ["currentTime","memory","schedule","read","grep","find","ls","search_web","web_fetch","get_weather"]`——bash/edit/write 永不暴露。
- 单进程单 DATA_DIR；非回环监听必须设访问密钥。

## 设计哲学（用户定论，勿违背）

- **nanobot 行为优先**：默认参考本机 nanobot 实现可兼容的个人助手行为，不逐项让用户选择技术方案；仅在与 pi 或已确认的产品规则明显不兼容时提示。不得为照搬 nanobot 修改 pi SDK、重写 agent loop 或扩大权限。
- **简单优先，崩了重跑**：不为低概率故障做复杂设计；无 durable execution、无断点续跑、无模型/工具自动重试。定时任务失败只诚实标记；scheduler 可以在固定扫描时补存同一次执行结果，但绝不重新执行模型或工具。
- **最小 fork**：对 OpenMuse 的改动压缩到 2 文件约 90 行，以 patch 维护在 `compat/openmuse/`（含基线 commit 与应用方式）；服务端自成一体，自研客户端直接对接 AG-UI。
- 记忆只显式写入（对话工具 + Apps 界面），不做自动提取。
- 通用工具卡片（OpenMuse 端 `name: "*"`）已兜底：服务端新增只读工具**不需要改客户端**。

## 测试与 fake-model 触发词

测试按职责分布：`tests/unit/` 测纯规则与适配边界，`tests/integration/` 测完整链路，`tests/support/` 放 fake provider 等辅助代码。`pnpm test` 显式运行前两个目录的 `*.test.ts`，任一目录未发现测试都会失败；每项测试超时为 60 秒，support 不作为测试入口。

代码改动后运行 `pnpm typecheck && pnpm test && pnpm build`，并执行 `git diff --check`。只改文档可检查差异与引用，不必重复全量测试。涉及启动/退出时补隔离 DATA_DIR 的进程检查，覆盖初始化失败清理与 SIGTERM；不能用 fake provider 结果代替真实模型 Web 验收。涉及 OpenMuse 展示或工具报文时，必须在 8081 Web DEV 页面验证实际 renderer、历史刷新和错误态；接口/schema 测试不能替代页面观察。

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

## 数据目录（`.personal-bot/`，gitignore）

| 路径 | 内容 |
| --- | --- |
| `sessions/` | pi 会话 JSONL（历史权威来源） |
| `SOUL.md` / `USER.md` | 自由文本身份（注入 system prompt，每轮重读） |
| `memory.json` | 长期记忆条目 + identity 设置（P3 权威存储） |
| `jobs.json` | 定时任务（P4） |
| `workspace/` | 资料目录（read/grep/find/ls 的唯一可达范围） |
| `config.json` | 必需服务配置；模型 key 与访问密钥直接存放于此 |
| `agent/` `auth.key` | pi 运行目录 / token 签名密钥 |

- 路径统一由 `src/adapters/storage/data-layout.ts` 声明，不在新能力里散写文件路径。
- `memory.json` 保持 `{ memories: [...], identity: {...} }` 对象格式，旧版缺省/局部 identity 合并默认值；`jobs.json` 保持裸数组。目前不写 `schemaVersion`，带版本字段的对象必须拒绝，等待显式版本 reader。
- 仅文件缺失可返回初始化默认值；JSON 损坏、非法根结构、已知 identity 字段类型错误、未知版本和其他 I/O 错误必须抛错，禁止静默覆盖为空文档。条目筛选保留旧 reader 的兼容语义，不在重构中顺手收紧历史数据要求。
- 写入先在内存序列化，以 `wx`、`0600` 创建同目录临时文件，再 `rename` 替换；失败清理本次临时文件并保留原始错误。底层 writer 不做 fsync、自动重试、跨进程锁或 durable execution；scheduler 的补存仅重用已经得到的运行结果和完成时间。
- 损坏文档需停止服务、保留原件并从有效备份恢复，不直接删文件消除报错。未来若改格式或路径，单独设计离线迁移与回退，不运行中双写。

## 已知限制（诚实声明）

- 真实模型 endpoint 为局域网网关（`silicon/deepseek-ai/DeepSeek-V4-Flash`）；模型偶尔省略工具参数（已用 schema 必填缓解）或偷懒不调工具（提示明确要求即可）。
- 定时触发轮无实时 SSE 推送（用户刷新/下轮同步后可见）；客户端旧历史与触发轮冲突时收到一次 409 后自动同步。服务启动时按 nanobot 语义重算 daily 任务，已过期的一次性任务不补跑。
- 第一阶段已修正基础 prompt 并完成隔离数据的真实模型 HTTP/OpenMuse Web 核心复验，范围见 `docs/first-stage-acceptance.md`；真实链路曾发生 120 秒超时，后续新轮恢复。工具已完成的记忆/任务写入不会因后续模型超时而回滚，不引入自动重试。
- 第二阶段已按 nanobot 的兼容行为补齐：工具副作用不回滚；最终模型失败不自动重试；scheduler 在状态写入失败时只补存同一次结果，成功前不重跑模型或执行其他任务；异常响应由 pi 负责解析，业务层只做终态和脱敏。停止后的半截 assistant 文本仍受 pi 的 `error/aborted` 历史过滤规则限制，不为此修改 pi。行为对照和剩余验收见 `docs/second-stage-plan.md`。
- 第二阶段服务端/Web 验收已完成：除既有主路径外，真实模型链路的代理注入断流/畸形 SSE、Web Stop 后换题、跨午夜长轮争锁、长 daily 跨多个日程点、Web 失败/取消展示、真实网关 401 和工具写入后最终 401 保留记忆均已补验。代理故障注入不等于供应商自然故障；详细证据和边界见 `docs/second-stage-acceptance.md`。
- 当前第二阶段交付以 OpenMuse Web 页面跑通为准，原生客户端暂不作为门槛。Android 隔离模拟器已有核心 smoke test 记录；iOS、真机、后台断线、生产签名包和客户端 Stop 提示延期处理。多会话/多用户/外部 channel 明确不做。

## 文档索引

- `docs/HANDOFF.md`：当前进度、验证记录、联调注意事项与后续工作，接手项目先读。
- `docs/architecture.md`：当前职责边界、状态所有权、生命周期、数据策略和新能力接入。
- `docs/first-stage-acceptance.md`：prompt 修正与真实模型 Web 核心验收、隔离方式、实际观察和未覆盖范围。
- `docs/second-stage-plan.md`：nanobot 行为对照、第二阶段边界、调度竞态修复与后续验收顺序。
- `docs/second-stage-acceptance.md`：第二阶段真实模型/Web 补验范围、证据和剩余空缺。
- `docs/refactoring-plan.md`：R0-R7A 重构实施记录及 R7B 延期条件，不是待从头执行的计划。
- `docs/configuration.md`：必需 JSON 配置、直接密钥、错误策略和字段对照。
- `docs/openmuse-api-contract.md`：客户端协议契约；`docs/pi-reuse.md`：pi 复用边界。
- `README.md`：启动与使用；`docs/implementation-plan.md`：原始 P1-P4 功能实施历史。
