# pi-muse

基于 pi 构建的开源单用户个人助手，UI 与交互参考 Muse，主要客户端为仓库内的 `web/`（Vite + React）。
本项目为非官方项目，不代表 Muse 官方开源版本。
支持多 thread 对话、会话压缩、身份/记忆、定时任务、子代理（subagent）、网页监控和逐次审批的文件写入；不是 nanobot 的整套功能迁移，也不使用 nanobot WebUI。

## 已实现

- 一个 OpenAI-compatible Chat Completions endpoint/model，服务端配置凭据。
- 自有 Web 通过 HTTP 契约与 AG-UI SSE 对接服务端；Hono 直接输出事件，不使用 CopilotKit runtime 或旧客户端兼容接口。
- 单用户、多 thread：每个 thread 独立 pi 会话与运行协调器，支持流式回答、上下文和历史恢复；`local-main` 是默认主会话，subagent 内部 `subagent-<uuid>` 工作区与旧 worker 遗留的 `task-*` 不出现在用户会话列表中。
- Web 搜索与抓取：`search_web` 返回标题、URL 和摘要，优先 DuckDuckGo，被 challenge 时用 Bing RSS 兜底；`web_fetch` 抓取公网页面并提取 Markdown/text。二者均只读，带 DNS/SSRF 校验、重定向校验、超时和大小限制，并把外部内容标记为不可信数据。
- 实时天气：`get_weather` 使用无密钥 Open-Meteo Geocoding + Forecast API，返回当前温度、体感、湿度、降水、风力和今日概要；可在 config 中配置默认城市。天气请求不再依赖通用搜索，网络请求复用公网 DNS/SSRF 防护。
- 只读工具集：`currentTime`（本地时钟）+ `read`/`grep`/`find`/`ls`（复用 pi 内置只读文件工具，
  执行前强制路径边界——普通相对路径只可达 `DATA_DIR/workspace/threads/<threadId>/`，主会话同样使用 `threads/local-main/`；
  `shared/...` 显式访问 `workspace/shared/`。绝对路径、`..` 与目标/父目录符号链接一律拒绝；已启用技能的精确 `SKILL.md` 路径仅允许 read 读取）；
  工具调用与结果按展示策略投影为 AG-UI 四类事件（START/ARGS/END/RESULT），供客户端展示，
  历史投影包含 assistant 的 toolCalls 与 role "tool" 消息，刷新/重启后关联不变。
  主会话资料放进 `.pi-muse/workspace/threads/local-main/`，跨会话资料放进 `.pi-muse/workspace/shared/`；`workspace/` 本身只作容器。
- 文件写入：`write`/`edit` 默认开启，但每次执行都需人工审批。审批包含完整修改前后文本并绑定文件版本；提交前复核 workspace 路径、文件版本、审批期限和取消状态。拒绝、过期或运行取消不会提交该次修改，文件变化需重新审批；`bash` 永不暴露。
- pi JSONL 是历史权威来源；客户端每轮完成后读取历史，不再用旧快照覆盖服务端。
- 会话压缩（P2.5）：超阈值时 pi 用摘要替换模型上下文，展示历史全量保留；压缩参数按
  contextWindow 比例收缩，避免小窗口下阈值变负导致压缩死循环。
- 身份注入（P3 第一步）：`DATA_DIR/SOUL.md`（助手性格）与 `USER.md`（用户画像）注入
  system prompt；文件不在资料目录内、模型工具读不到，每轮重读、改完下一轮即生效。
- 长期记忆（P3）：`DATA_DIR/memory.json` 权威存储，只显式写入（对话说"记住/忘掉"或
  HTTP 记忆管理接口增改忘）；每轮注入 system prompt，改完下一轮生效；
  身份设置（名字/语气）同存并注入。不做自动提取。
- 定时任务（P4）：对话说"X 点提醒我 Y"→ schedule 工具创建（ISO 一次性或每日 HH:mm）；
  调度器每 `runtime.schedulerIntervalMs`（默认 30s）扫表，到点且空闲时触发一轮，
  结果作为 ⏰ 消息进入聊天流并持久化；一次性任务跑完即关闭，服务重启时已过期的一次性任务不再补跑。
  崩溃哲学：失败只诚实标记，不做断点续跑。
- 停止、HTTP 断流、超时、并发拒绝；等待 pi idle 后才释放运行锁（含工具执行轮）。
- 增量发送一条消息与历史 revision，拒绝版本冲突和重复消息 ID；同一成功 run 可幂等重放。客户端不回传模型/工具历史。
- 专用 pi 数据/资源目录；不加载个人 CLI 的全局配置、skills、extensions 或 MCP。
- 子代理（subagent）通过聊天工具调用，在每个调用独立的 `subagent-<uuid>` 工作区里跑子模型 pi 轮，结果回到父工具结果；`goal` 管理目标，`monitor` 管理周期网页监控。旧 `delegate_task` / 后台任务队列已下线，遗留的 `task-*` 文件不读不删不执行。

暂不实现：shell、附件、自动记忆提取（Dream）、heartbeat、外部 channel、多用户、运行中 reconnect。
工具注册包括：currentTime / instructions / memory / schedule / subagent / goal / monitor / read / grep / find / ls / write / edit / search_web / web_fetch / get_weather；可选能力按配置启用，未实现功能不伪装成功。`subagent` 是官方 1.3.0 subagent 示例的 SDK child 适配，单/并行/链式三模式同进程内上下文隔离，最多 8 队列 / 4 并发，链式失败即停；子模型继承父 model/key，role 仅做收窄，不读 `~/.pi`、不接受 `cwd` / `agentScope`，不持久化子会话、不复制父历史/INSTRUCTIONS，子调用仍逐次审批、归属父 thread/run。

## 客户端与协议

自有 `web/` 是开发与页面验收入口，直接复用 HTTP 消息/事件契约；不保留历史接口与占位字段。
聊天先读取 `{messages, revision}`，再向 `/api/conversation/run` 提交单条消息和 `expectedRevision`。版本冲突返回 409，页面同步历史并恢复草稿；Stop 同时绑定 threadId/runId。
审批通过 `/api/events` 的 ready/approval_pending 推送完整预览，`/api/approvals/pending` 为补充只读入口；`/api/approvals` 分页返回终态历史摘要，单项详情保留申请时的完整内容。审批与预览长期保留，不按时间或条数自动裁剪；`approved` 仅代表授权，真实提交结果另见 `execution`。后台行为只有定时 jobs 与网页 monitors；subagent 在父聊天轮内运行，不使用旧 worker 队列，子工具权限只能收窄父会话上限。完整接入规则以服务端 `/docs` 与 `/openapi.json` 为准。

## 启动真实模型

需要 Node 24+；此项目锁定 pnpm 12.10.1。以下命令均从仓库根目录执行，Web 使用 `pnpm --dir web` 启动。

~~~sh
pnpm install
mkdir -p .pi-muse
cp config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
~~~

所有启动配置都来自 `.pi-muse/config.json`：模型、端口、超时、调度间隔、访问密钥
和模型 API key 都直接写在这个文件中。项目不再读取旧的环境变量配置。完整字段说明见
`docs/configuration.md`。

base URL 是包含 /v1 等前缀的 API 根地址，不是完整 /chat/completions URL。
`server.accessKey` 是工作区访问密钥；`model.apiKey` 是模型凭据。不要把任何 key 发到聊天里。

~~~sh
pnpm dev
~~~

在另一终端启动仓库内的 Web 客户端：

~~~sh
pnpm --dir web dev
~~~

打开 http://localhost:15173。Vite 默认把 `/api` 代理到 `http://127.0.0.1:17890`；若配置访问密钥，在 Web 登录框填写该密钥。
未配置模型时也可打开页面；聊天会明确报 MODEL_NOT_CONFIGURED，不自动选用其他供应商。

> 端口选择：服务端默认 `17890`、mock 默认 `17891`、Web dev 默认 `15173`、Web preview 默认 `14173`，避开 nanobot(7890) 与 Vite(5173/4173) 默认区间。**不会自动避让已占用端口**：被占用时启动直接报错并指出占用 PID，由你决定是改 `server.port` 还是 `kill -15 <pid>` 释放。

构建运行：

~~~sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
~~~

提交前把验证收紧到一条命令：

~~~sh
pnpm check   # typecheck + test + test:e2e + pnpm --dir web build + git diff --check
~~~

`pnpm check` 包含 `pnpm test:e2e`（自动先 `pnpm build` 再用 `node:test/tsx` 跑 `tests/e2e/*.test.ts`，串行进程套件，单项 90s）。它走真实 `dist/index.js`，fake provider 仍是本地 OpenAI SSE，不依赖外网；稳定用例覆盖鉴权、工具流、子代理三种模式、审批 approve/deny/cancel、慢 Web + 模型中途 Stop、隔离删除重启、`/api/events` SSE 与 SIGTERM、初始化失败清理。`pnpm test:e2e` 不需要在浏览器侧配合，也不能代替真实模型与自有 Web 页面验收。

`pnpm test:live` 是显式 opt-in 的真实模型验收，不进入 `pnpm check`：

~~~sh
pnpm test:live --config .pi-muse/config.json --allow-live           # 默认清临时目录
pnpm test:live --config .pi-muse/config.json --allow-live --keep-artifacts   # 保留脱敏 summary/traces
~~~

命令允许参数开头的一个 `--`（如 `pnpm test:live -- --config … --allow-live`），其余未知或重复参数会拒绝，不能在命令行传密钥。live 仅读取 `--config` 中的 `.model`，凭据仅保留在透明代理内存，脱敏报告不含真实key或鉴权头。DATA_DIR使用临时空实例，默认finally清理；`--keep-artifacts`保留合成测试数据及summary.json。live会产生模型费用，不自动运行，不进入`pnpm check`；不配置CI或GitHub Actions。详情见 `docs/testing.md`。

## 自研 Web 客户端（web/）

Vite + React + Tailwind，契约类型直接引用 `src/http/contracts`。默认服务端为 `17890`；若实际配置了其他端口，可仅为 Web 开发代理设置 `API_TARGET`：

```sh
pnpm install
API_TARGET=http://127.0.0.1:17891 pnpm --dir web dev   # 仅当 mock 实际监听 17891 时使用
# 若服务端配置了其他端口，按启动日志设置 API_TARGET
```

功能：多会话列表/新建、流式对话（AG-UI SSE 子集）、工具卡片、停止、历史刷新恢复。

### PWA（手机可安装）

`web/` 已内置 manifest + 图标 + Service Worker 离线壳（静态资产缓存、/api 永不缓存、
小屏抽屉式会话列表 + 安全区适配）。构建产物自带 PWA：

```sh
pnpm --dir web build && pnpm --dir web preview  # 14173，默认 API 代理到 17890
```

安装边界（诚实说明）：Android Chrome 要求 secure context，局域网 HTTP IP 不能安装
（需 HTTPS 或经 adb reverse 映射为 localhost）；iOS Safari 在局域网 HTTP 下可直接
"添加到主屏幕"。离线时应用壳可打开，聊天需服务端在线。

## 无凭据本地联调

~~~sh
pnpm dev:mock
# 另一终端
API_TARGET=http://127.0.0.1:17891 pnpm --dir web dev
~~~

mock 默认监听 17891，使用真实 pi SDK + 本地模拟 OpenAI SSE endpoint，不读取正式 config.json，不调用真实供应商。
模拟回复展示收到的用户轮数；发送 slow 可测试停止；发送含「时间/几点」的消息走 currentTime 工具闭环（模拟模型先发起 tool_calls，pi 执行工具后生成回答）。
模拟历史在 `.pi-muse/mock`，与正式历史隔离。
mock 端口和数据目录由脚本内显式配置固定，不提供环境变量覆盖。
这里的 `API_TARGET` 只改变 Vite 代理，不覆盖服务端或 mock 配置。

## 存储与安全边界

默认实例目录为 `.pi-muse`（已忽略）：`config.json` 是必需服务配置，`sessions/<threadId>/` 保存各 thread 的 pi 会话、`INSTRUCTIONS.md` 与技能覆盖，auth.key 是随机 token 签名密钥。普通文件工具只可达自己的私有区与显式共享区：

```text
.pi-muse/
├── config.json / auth.key / SOUL.md / USER.md
├── memory.json / goals.json / jobs.json / actions.json / monitors.json
├── tasks.json（遗留）                   # 旧 worker 队列文件；不读、不迁移、不删除、不执行
├── assets/subagents/<role>.md           # subagent role 提示词内置；DATA_DIR/subagents/*.md 可覆盖
├── skills/<name>/SKILL.md                # 用户技能，全局一份
├── sessions/<threadId>/
│   ├── *.jsonl                          # pi 权威历史
│   ├── INSTRUCTIONS.md                  # 该会话规则，按需存在
│   └── skills.json                      # 该会话技能开关覆盖，按需存在
├── workspace/
│   ├── shared/                          # 所有会话用 shared/... 访问
│   └── threads/
│       ├── local-main/                  # 主会话也没有父目录访问特权
│       ├── email/
│       └── subagent-<uuid>/             # subagent 每次调用的私有工作区，旧 task-<id>/ 仅遗留
└── agent/                               # pi 内部运行资源，不开放给文件工具
```

会话规则通过 `instructions` 工具或 `GET/PUT /api/threads/:threadId/instructions` 管理，下一轮生效；当前 Web 没有专属规则编辑面板。规则不能扩大工具权限。删除会话同时清理其 `sessions/<id>/` 和 `workspace/threads/<id>/`，不删除共享文件。

新布局不自动读取、搬移或删除旧 workspace 根目录文件，也不为旧 cwd 提供历史回退；已有数据需停服后单独备份和处理。普通文件路径边界不等同于操作系统沙箱；用户安装的技能 extension 是可信服务端代码，不受这些普通文件工具约束。
`runtime.dataDir` 省略时使用配置文件所在目录；相对值也按配置文件目录解析，不按进程 cwd。推荐绝对路径以便部署排查，但并非必需。
默认 CORS 包含 localhost/127.0.0.1 的 15173 与 17890 四个 origin，便于从本机或局域网访问；显式 `server.allowedOrigins` 会替换默认列表。
模型 key 只驻留受保护的 `.pi-muse/config.json` 与服务端内存，不写入 pi auth.json、不返回客户端；供应商错误诊断在持久化前脱敏。
对话本身按明文落盘，应保护或备份数据目录。登录 token 长期有效，服务重启仍有效；更换访问密钥会使旧 token 立即失效，本轮之前签发的 24h 短 token 仍按原到期时间被拒。

这是可信本机、单进程、单 owner 服务，不是公开互联网生产部署。不要让两个进程共用同一个实例数据目录。
未做速率限制、跨进程锁或数据加密；文件写入采用逐次审批，CORS 不是鉴权。
默认 host 为 `0.0.0.0` 便于局域网访问，但启动时会打印 `server.accessKey` 缺失警告；生产部署仍应在 config.json 设置 `server.accessKey`。远程访问还需要 TLS/反向代理。手机的 localhost 不是 Mac，真机验收需单独配置地址。

页面 SSE 断开会取消对应客户端轮；刷新后以 pi 持久化历史为准，不保证取消时的半截文本可恢复。没有运行中续接；subagent 走独立 SDK child session、结果回到父工具结果，不是客户端流的断线续跑；旧的独立 worker 后台任务已下线。
pi 自动压缩已开启（参数随上下文窗口收缩），展示历史完整保留；自动重试仍关闭。

此前 P2 工具闭环的 Web 联调记录保留在 `docs/archive/p2-web-smoke.png` 与 `docs/archive/p2-real-web-smoke.png`；这些是历史 OpenMuse 验收记录，不代表当前自有 Web 或本轮重新验收。

## 验证状态与后续

- 2026-10-18：会话私有根统一为 `workspace/threads/<id>/`，修复主会话父目录暴露和只读符号链接绕过；277项自动化测试、类型检查、前后端构建通过。真实DeepSeek+自有Web确认旧越界请求已拒绝、私有/共享审批读写与重启规则/历史有效；不自动迁移旧数据。详见 `docs/archive/2026-10-18-workspace-isolation-fix-acceptance.md`。
- 2026-10-18：新增本地 `pnpm test:e2e`、`pnpm test:live` 与 `pnpm check`；真实dist进程E2E、显式真实模型流程和资源清理均已实跑，准确数量、版本和验收范围见 `docs/HANDOFF.md` / `docs/archive/2026-10-18-e2e-live-acceptance.md`。不加CI，不修改生产接口，使用方法见 `docs/testing.md`。

- 2026-10-17：默认数据目录及真实实例已离线迁移为 `.pi-muse/`，绝对配置路径与pi会话头同步更新；261项测试、类型检查、前后端构建和迁移后历史/登录回归通过。受保护备份位置与回退方式见 `docs/HANDOFF.md`。
- 2026-10-17：品牌统一为 `pi-muse`；260 项自动化测试、类型检查、服务端/Web 构建通过。隔离 DEV 已验证桌面/移动端品牌、真实模型时间工具及历史刷新；PWA 已验证旧壳刷新与离线品牌。数据目录随后已离线迁移为 `.pi-muse/`，历史协议标识和已有自定义身份仍保留，备份及完整验收范围见 `docs/HANDOFF.md`。
- 测试入口为 `pnpm test`（unit/integration + fake provider）；测试数量和通过状态以实际运行输出为准，不将模拟模型结果当作真实模型验收。
- 2026-10-15：252 项自动化测试、类型检查、服务端与 Web 构建通过；隔离 DEV 页面已验证工具、Stop、审批和版本冲突草稿恢复，真实模型 currentTime 与刷新恢复通过。既有 5173 正在使用，隔离验收另用 15173/15174；完整范围见 `docs/HANDOFF.md`。
- 默认端口已迁移到 17890/17891/15173/14173（避开 nanobot/Vite 默认区间）；被占用时启动直接报错并给出占用 PID，不自动避让；详见 `docs/HANDOFF.md`。
- 历史验收记录见 `docs/archive/first-stage-acceptance.md` 与 `docs/archive/second-stage-acceptance.md`，其中 OpenMuse 页面观察只对应当时的版本与范围。
- 后续新增能力遵循 `feature → adapter → bootstrap` 显式装配，不把业务继续堆入 conversation 或 HTTP；不自动 commit/push。

## 开发文档

- [AGENTS.md](AGENTS.md)：全局底线、按任务必读入口与最低完成标准。
- [架构规范](docs/architecture.md)：职责、状态所有权、权限、生命周期、数据与新能力接入。
- [测试规范](docs/testing.md)：回归补强、命令、验收证据、live 边界与 fake-model 触发词。
- [API 开发规范](docs/api-development.md)：HTTP/SSE、工具报文、自动文档和契约交付要求；对外接入仍以运行时 `/docs`、`/openapi.json` 为准，[HTTP 辅助说明](docs/http-api-contract.md)不维护第二份规范。
- [配置说明](docs/configuration.md)、[pi 复用边界](docs/pi-reuse.md)：启动配置与内核适配参考。
- [交接记录](docs/HANDOFF.md)、[待实施需求](docs/backlog.md)：当前进度与暂缓事项；[历史归档](docs/archive/)只记录对应版本的实施与验收，不作为当前实现约定。
