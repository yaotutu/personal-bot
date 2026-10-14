# Personal Bot

基于 pi 的个人助手服务端，对接已有 OpenMuse 的 Expo Web/iOS/Android 客户端。
当前完成 P1–P4：文本对话、只读工具、会话压缩、身份/记忆与定时任务；不是 nanobot 的整套功能迁移，也不使用 nanobot WebUI。

## 已实现

- 一个 OpenAI-compatible Chat Completions endpoint/model，服务端配置凭据。
- OpenMuse session/workspace/agent/conversation 接口，以及本地 CopilotKit + AG-UI SSE。
- 固定单主会话 `local-main`：流式回答、多轮上下文、稳定消息 ID、刷新与服务重启恢复。
- Web 搜索与抓取：`search_web` 返回标题、URL 和摘要，优先 DuckDuckGo，被 challenge 时用 Bing RSS 兜底；`web_fetch` 抓取公网页面并提取 Markdown/text。二者均只读，带 DNS/SSRF 校验、重定向校验、超时和大小限制，并把外部内容标记为不可信数据。
- 实时天气：`get_weather` 使用无密钥 Open-Meteo Geocoding + Forecast API，返回当前温度、体感、湿度、降水、风力和今日概要；可在 config 中配置默认城市。天气请求不再依赖通用搜索，网络请求复用公网 DNS/SSRF 防护。
- 只读工具集：`currentTime`（本地时钟）+ `read`/`grep`/`find`/`ls`（复用 pi 内置只读文件工具，
  执行前强制路径边界——解析后必须落在 `DATA_DIR/workspace` 资料目录内，绝对路径与 `../` 逃逸一律拒绝）；
  工具调用与结果按 AG-UI 四类事件（START/ARGS/END/RESULT）透传给 OpenMuse 卡片展示，
  历史投影包含 assistant 的 toolCalls 与 role "tool" 消息，刷新/重启后关联不变。
  把资料放进 `.personal-bot/workspace/` 即可让助手读它回答问题。
- pi JSONL 是历史权威来源；客户端每轮完成后读取历史，不再用旧快照覆盖服务端。
- 会话压缩（P2.5）：超阈值时 pi 用摘要替换模型上下文，展示历史全量保留；压缩参数按
  contextWindow 比例收缩，避免小窗口下阈值变负导致压缩死循环。
- 身份注入（P3 第一步）：`DATA_DIR/SOUL.md`（助手性格）与 `USER.md`（用户画像）注入
  system prompt；文件不在资料目录内、模型工具读不到，每轮重读、改完下一轮即生效。
- 长期记忆（P3）：`DATA_DIR/memory.json` 权威存储，只显式写入（对话说"记住/忘掉"或
  Apps 页 Personality & memory 界面增改忘）；每轮注入 system prompt，改完下一轮生效；
  身份设置（名字/语气）同存并注入。不做自动提取。
- 定时任务（P4）：对话说"X 点提醒我 Y"→ schedule 工具创建（ISO 一次性或每日 HH:mm）；
  调度器每 `runtime.schedulerIntervalMs`（默认 30s）扫表，到点且空闲时触发一轮，
  结果作为 ⏰ 消息进入聊天流并持久化；一次性任务跑完即关闭，服务重启时已过期的一次性任务不再补跑。
  崩溃哲学：失败只诚实标记，不做断点续跑。
- 停止、HTTP 断流、超时、并发拒绝；等待 pi idle 后才释放运行锁（含工具执行轮）。
- 完成请求去重、失败/取消后的同消息重试，拒绝陈旧用户历史和冲突 run ID；客户端伪造的 tools 不透传给模型。
- 专用 pi 数据/资源目录；不加载个人 CLI 的全局配置、skills、extensions 或 MCP。
- 
暂不实现：写文件、shell、附件、自动记忆提取（Dream）、heartbeat、外部 channel、多会话、多用户、运行中 reconnect。
已开放工具：currentTime / memory / schedule / read / grep / find / ls / search_web / web_fetch / get_weather（均只读或受控写入）；未实现功能不伪装成功：不支持的 API 返回 501。

## 客户端兼容策略

服务端自成一体：AG-UI runtime 是标准协议（未来自研客户端直接对接），OpenMuse 风格的
快照接口（workspace/agent/session/conversation）是纯兼容层。复用 OpenMuse 客户端时，
对它的改动压缩到两个文件、约 60 行（能力开关类型 + 历史协商 + currentTime 卡片注册），
以 patch 维护在 `compat/openmuse/`（含应用方式与基线 commit），便于跟随上游更新；
富功能入口保持上游原版，未实现的能力显示为空数据/离线，不隐藏也不伪装。

## 启动真实模型

需要 Node 24+；此项目锁定 pnpm 12.10.1，OpenMuse 仍使用自己的 pnpm 11.19.0。

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

在另一终端启动现有客户端（不要启动 OpenMuse 的旧服务端）：

~~~sh
cd /Users/yaotutu/Desktop/code/openmuse
EXPO_PUBLIC_API_URL=http://localhost:8787 pnpm dev:web
~~~

打开 http://localhost:8081。若配置访问密钥，在 OpenMuse 工作区登录框填写该密钥。
未配置模型时也可打开页面；聊天会明确报 MODEL_NOT_CONFIGURED，不自动选用其他供应商。

构建运行：

~~~sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
~~~

## 自研 Web 客户端（web/）

~~（PWA 路线第一步）~~ Vite + React + Tailwind，契约类型直接引用 `src/http/contracts`。

```sh
cd web
pnpm install
API_TARGET=http://127.0.0.1:8790 pnpm dev   # 5173，/api 代理到服务端
```

功能：多会话列表/新建、流式对话（AG-UI SSE 子集）、工具卡片、停止、历史刷新恢复。
OpenMuse 客户端兼容层保留至该页覆盖全部用法后移除。

## 无凭据本地联调

~~~sh
cd /Users/yaotutu/Desktop/code/personal-bot
pnpm dev:mock
# 另一终端
cd /Users/yaotutu/Desktop/code/openmuse
EXPO_PUBLIC_API_URL=http://localhost:8788 pnpm dev:web
~~~

mock 默认监听 8788，使用真实 pi SDK + 本地模拟 OpenAI SSE endpoint，不读取正式 config.json，不调用真实供应商。
模拟回复展示收到的用户轮数；发送 slow 可测试停止；发送含「时间/几点」的消息走 currentTime 工具闭环（模拟模型先发起 tool_calls，pi 执行工具后生成回答）。
模拟历史在 `.personal-bot/mock`，与正式历史隔离。
mock 端口和数据目录由脚本内显式配置固定，不提供环境变量覆盖。

## 存储与安全边界

默认目录 `.personal-bot`（已忽略）：`config.json` 是必需服务配置，sessions/ 是 pi 会话，auth.key 是随机 token 签名密钥，workspace/ 与 agent/ 是专用运行目录。
模型 key 只驻留受保护的 `.personal-bot/config.json` 与服务端内存，不写入 pi auth.json、不返回客户端；供应商错误诊断在持久化前脱敏。
对话本身按明文落盘，应保护或备份数据目录。登录 token 有效 24 小时，服务重启仍有效；更换访问密钥会使旧 token 失效。

这是可信本机、单进程、单 owner 服务，不是公开互联网生产部署。不要让两个进程共用同一个实例数据目录。
P1 未做速率限制、跨进程锁、细粒度权限或数据加密；CORS 不是鉴权。
监听非回环地址必须设置访问密钥；远程访问还需要 TLS/反向代理。手机的 localhost 不是 Mac，真机验收需单独配置地址。

页面断开会取消正在生成的回复，已有部分文本保留；刷新后取最终持久化历史。没有运行中续接/后台聊天。
pi 自动压缩已开启（参数随上下文窗口收缩），展示历史完整保留；自动重试仍关闭。

此前 P2 工具闭环的 Web 联调记录保留在 `docs/p2-web-smoke.png` 与 `docs/p2-real-web-smoke.png`；这些是重构前的验收记录，不代表本轮重新验收。

## 验证状态与后续

- 当前 `pnpm test` 共 146 项通过，覆盖真实 HTTP/pi/fake-provider 主链路、unit/integration 边界、协议事件、历史安全、停止/断流/超时、工具副作用、provider 异常、鉴权、调度器、并发写、初始化失败和存储损坏保护。
- 架构重构 R0-R6 与 R7A 已完成：`bootstrap/create-service.ts` 是唯一组装入口；业务规则位于 `features/`；pi、AG-UI、OpenMuse、storage 位于 `adapters/`；`http/app.ts` 不拥有调度器。
- 持久化仍保持既有 `memory.json` 对象和 `jobs.json` 裸数组格式；缺失文件默认空值，损坏/未知版本/读写错误拒绝继续写，不静默覆盖用户数据；R7B 物理目录迁移延期。
- mock 进程使用隔离数据目录和 fake provider；关键进程级启动/关闭、占用端口、非法配置和 mock SSE 检查已通过。
- 第一阶段已修正基础 prompt，使用隔离 DATA_DIR 和真实模型完成 OpenMuse Web 核心复验：流式、停止、刷新、时间/文件工具、记忆、定时执行与重启历史。实际观察与未覆盖范围见 `docs/first-stage-acceptance.md`；iOS/Android 仍未验收。
- 当前没有自动 commit/push；后续新增能力遵循 `feature → adapter → bootstrap` 显式装配，不把业务继续堆入 conversation 或 HTTP。

当前架构和新能力接入见 docs/architecture.md；架构重构计划与当前进度见 docs/refactoring-plan.md；交接状态见 docs/HANDOFF.md；第一阶段验收见 docs/first-stage-acceptance.md；接口盘点见 docs/openmuse-api-contract.md；pi 复用边界见 docs/pi-reuse.md。
