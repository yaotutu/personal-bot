# Personal Bot

基于 pi 的单用户个人助手，主要客户端为仓库内的 `web/`（Vite + React）。
支持多 thread 对话、会话压缩、身份/记忆、定时任务、后台任务、网页监控和逐次审批的文件写入；不是 nanobot 的整套功能迁移，也不使用 nanobot WebUI。

## 已实现

- 一个 OpenAI-compatible Chat Completions endpoint/model，服务端配置凭据。
- 自有 Web 通过 HTTP 契约与 AG-UI SSE 对接服务端；Hono 直接输出事件，不使用 CopilotKit runtime 或旧客户端兼容接口。
- 单用户、多 thread：每个 thread 独立 pi 会话与运行协调器，支持流式回答、上下文和历史恢复；`local-main` 是默认主会话，内部后台任务 `task-*` 不出现在用户会话列表中。
- Web 搜索与抓取：`search_web` 返回标题、URL 和摘要，优先 DuckDuckGo，被 challenge 时用 Bing RSS 兜底；`web_fetch` 抓取公网页面并提取 Markdown/text。二者均只读，带 DNS/SSRF 校验、重定向校验、超时和大小限制，并把外部内容标记为不可信数据。
- 实时天气：`get_weather` 使用无密钥 Open-Meteo Geocoding + Forecast API，返回当前温度、体感、湿度、降水、风力和今日概要；可在 config 中配置默认城市。天气请求不再依赖通用搜索，网络请求复用公网 DNS/SSRF 防护。
- 只读工具集：`currentTime`（本地时钟）+ `read`/`grep`/`find`/`ls`（复用 pi 内置只读文件工具，
  执行前强制路径边界——解析后必须落在 `DATA_DIR/workspace` 资料目录内，绝对路径与 `../` 逃逸一律拒绝）；
  工具调用与结果按展示策略投影为 AG-UI 四类事件（START/ARGS/END/RESULT），供客户端展示，
  历史投影包含 assistant 的 toolCalls 与 role "tool" 消息，刷新/重启后关联不变。
  把资料放进 `.personal-bot/workspace/` 即可让助手读它回答问题。
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
- 后台任务通过 `delegate_task` 在内部独立 thread 执行；`goal` 管理目标，`monitor` 管理周期网页监控。

暂不实现：shell、附件、自动记忆提取（Dream）、heartbeat、外部 channel、多用户、运行中 reconnect。
工具注册包括：currentTime / memory / schedule / delegate_task / goal / monitor / read / grep / find / ls / write / edit / search_web / web_fetch / get_weather；可选能力按配置启用，未实现功能不伪装成功。

## 客户端与协议

自有 `web/` 是开发与页面验收入口，直接复用 HTTP 消息/事件契约；不保留历史接口与占位字段。
聊天先读取 `{messages, revision}`，再向 `/api/conversation/run` 提交单条消息和 `expectedRevision`。版本冲突返回 409，页面同步历史并恢复草稿；Stop 同时绑定 threadId/runId。
审批独立读取 `/api/actions/pending` 的完整预览，历史摘要与单项详情分开查询。后台 queued + running 最多 32 项，后台会话不能继续委派或创建调度源。

## 启动真实模型

需要 Node 24+；此项目锁定 pnpm 12.10.1。

~~~sh
cd /Users/yaotutu/Desktop/code/personal-bot
pnpm install
mkdir -p .personal-bot
cp config.example.json .personal-bot/config.json
chmod 600 .personal-bot/config.json
~~~

所有启动配置都来自 `.personal-bot/config.json`：模型、端口、超时、调度间隔、访问密钥
和模型 API key 都直接写在这个文件中。项目不再读取旧的环境变量配置。完整字段说明见
`docs/configuration.md`。

base URL 是包含 /v1 等前缀的 API 根地址，不是完整 /chat/completions URL。
`server.accessKey` 是工作区访问密钥；`model.apiKey` 是模型凭据。不要把任何 key 发到聊天里。

~~~sh
pnpm dev
~~~

在另一终端启动仓库内的 Web 客户端：

~~~sh
cd /Users/yaotutu/Desktop/code/personal-bot/web
pnpm install
pnpm dev
~~~

打开 http://localhost:5173。Vite 默认把 `/api` 代理到 `http://127.0.0.1:8787`；若配置访问密钥，在 Web 登录框填写该密钥。
未配置模型时也可打开页面；聊天会明确报 MODEL_NOT_CONFIGURED，不自动选用其他供应商。

构建运行：

~~~sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
~~~

## 自研 Web 客户端（web/）

Vite + React + Tailwind，契约类型直接引用 `src/http/contracts`。默认服务端为 8787；若实际配置了其他端口，可仅为 Web 开发代理设置 `API_TARGET`：

```sh
cd web
pnpm install
API_TARGET=http://127.0.0.1:8790 pnpm dev   # 仅当服务端实际监听 8790 时使用
```

功能：多会话列表/新建、流式对话（AG-UI SSE 子集）、工具卡片、停止、历史刷新恢复。

### PWA（手机可安装）

`web/` 已内置 manifest + 图标 + Service Worker 离线壳（静态资产缓存、/api 永不缓存、
小屏抽屉式会话列表 + 安全区适配）。构建产物自带 PWA：

```sh
cd web && pnpm build && pnpm preview  # 4173，默认 API 代理到 8787
```

安装边界（诚实说明）：Android Chrome 要求 secure context，局域网 HTTP IP 不能安装
（需 HTTPS 或经 adb reverse 映射为 localhost）；iOS Safari 在局域网 HTTP 下可直接
"添加到主屏幕"。离线时应用壳可打开，聊天需服务端在线。

## 无凭据本地联调

~~~sh
cd /Users/yaotutu/Desktop/code/personal-bot
pnpm dev:mock
# 另一终端
cd /Users/yaotutu/Desktop/code/personal-bot/web
pnpm install
API_TARGET=http://127.0.0.1:8788 pnpm dev
~~~

mock 默认监听 8788，使用真实 pi SDK + 本地模拟 OpenAI SSE endpoint，不读取正式 config.json，不调用真实供应商。
模拟回复展示收到的用户轮数；发送 slow 可测试停止；发送含「时间/几点」的消息走 currentTime 工具闭环（模拟模型先发起 tool_calls，pi 执行工具后生成回答）。
模拟历史在 `.personal-bot/mock`，与正式历史隔离。
mock 端口和数据目录由脚本内显式配置固定，不提供环境变量覆盖。
这里的 `API_TARGET` 只改变 Vite 代理，不覆盖服务端或 mock 配置。

## 存储与安全边界

默认目录 `.personal-bot`（已忽略）：`config.json` 是必需服务配置，`sessions/<threadId>/` 保存各 thread 的 pi 会话，auth.key 是随机 token 签名密钥，workspace/ 与 agent/ 是专用运行目录。
`runtime.dataDir` 省略时使用配置文件所在目录；相对值也按配置文件目录解析，不按进程 cwd。推荐绝对路径以便部署排查，但并非必需。
默认 CORS 仅允许 localhost 和 127.0.0.1 的 5173 两个 origin；显式 `server.allowedOrigins` 会替换默认列表。
模型 key 只驻留受保护的 `.personal-bot/config.json` 与服务端内存，不写入 pi auth.json、不返回客户端；供应商错误诊断在持久化前脱敏。
对话本身按明文落盘，应保护或备份数据目录。登录 token 有效 24 小时，服务重启仍有效；更换访问密钥会使旧 token 失效。

这是可信本机、单进程、单 owner 服务，不是公开互联网生产部署。不要让两个进程共用同一个实例数据目录。
未做速率限制、跨进程锁或数据加密；文件写入采用逐次审批，CORS 不是鉴权。
监听非回环地址必须设置访问密钥；远程访问还需要 TLS/反向代理。手机的 localhost 不是 Mac，真机验收需单独配置地址。

页面 SSE 断开会取消对应客户端轮；刷新后以 pi 持久化历史为准，不保证取消时的半截文本可恢复。没有运行中续接；后台任务由独立 worker 执行，不是客户端流的断线续跑。
pi 自动压缩已开启（参数随上下文窗口收缩），展示历史完整保留；自动重试仍关闭。

此前 P2 工具闭环的 Web 联调记录保留在 `docs/archive/p2-web-smoke.png` 与 `docs/archive/p2-real-web-smoke.png`；这些是历史 OpenMuse 验收记录，不代表当前自有 Web 或本轮重新验收。

## 验证状态与后续

- 测试入口为 `pnpm test`（unit/integration + fake provider）；测试数量和通过状态以实际运行输出为准，不将模拟模型结果当作真实模型验收。
- 2026-10-15：252 项自动化测试、类型检查、服务端与 Web 构建通过；隔离 DEV 页面已验证工具、Stop、审批和版本冲突草稿恢复，真实模型 currentTime 与刷新恢复通过。既有 5173 正在使用，隔离验收另用 15173/15174；完整范围见 `docs/HANDOFF.md`。
- 历史验收记录见 `docs/archive/first-stage-acceptance.md` 与 `docs/archive/second-stage-acceptance.md`，其中 OpenMuse 页面观察只对应当时的版本与范围。
- 后续新增能力遵循 `feature → adapter → bootstrap` 显式装配，不把业务继续堆入 conversation 或 HTTP；不自动 commit/push。

架构说明见 `docs/architecture.md`；历史重构计划见 `docs/archive/refactoring-plan.md`；交接记录见 `docs/HANDOFF.md`；接口盘点见 `docs/http-api-contract.md`；pi 复用边界见 `docs/pi-reuse.md`。
