# Personal Bot

基于 pi 的个人助手服务端，对接已有 OpenMuse 的 Expo Web/iOS/Android 客户端。
当前完成 P1 的纯文本闭环与 P2 的最小工具闭环（只读 currentTime 工具）；不是 nanobot 的整套功能迁移，也不使用 nanobot WebUI。

## 已实现

- 一个 OpenAI-compatible Chat Completions endpoint/model，服务端配置凭据。
- OpenMuse session/workspace/agent/conversation 接口，以及本地 CopilotKit + AG-UI SSE。
- 固定单主会话 `local-main`：流式回答、多轮上下文、稳定消息 ID、刷新与服务重启恢复。
- 只读工具集：`currentTime`（本地时钟）+ `read`/`grep`/`find`/`ls`（复用 pi 内置只读文件工具，
  执行前强制路径边界——解析后必须落在 `DATA_DIR/workspace` 资料目录内，绝对路径与 `../` 逃逸一律拒绝）；
  工具调用与结果按 AG-UI 四类事件（START/ARGS/END/RESULT）透传给 OpenMuse 卡片展示，
  历史投影包含 assistant 的 toolCalls 与 role "tool" 消息，刷新/重启后关联不变。
  把资料放进 `.personal-bot/workspace/` 即可让助手读它回答问题。
- pi JSONL 是历史权威来源；客户端每轮完成后读取历史，不再用旧快照覆盖服务端。
- 停止、HTTP 断流、超时、并发拒绝；等待 pi idle 后才释放运行锁（含工具执行轮）。
- 完成请求去重、失败/取消后的同消息重试，拒绝陈旧用户历史和冲突 run ID；客户端伪造的 tools 不透传给模型。
- 专用 pi 数据/资源目录；不加载个人 CLI 的全局配置、skills、extensions 或 MCP。
- OpenMuse 的 serverOwnedHistory 可选能力开关；旧服务端未返回开关时保持原行为。

暂不实现：写文件、shell、附件、长期记忆、身份编辑、后台任务、定时/heartbeat、外部 channel、多会话、多用户、运行中 reconnect。
工具闭环已支持 currentTime / 其余工具未开放；未实现功能不伪装成功：只读快照诚实为空，不支持的 API 返回 501。

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
cp .env.example .env
~~~

在本地 `.env` 填写 `PERSONAL_MODEL_BASE_URL`、`PERSONAL_MODEL_ID` 和按需的 `PERSONAL_MODEL_API_KEY`。
base URL 是包含 /v1 等前缀的 API 根地址，不是完整 /chat/completions URL。
访问密钥 `PERSONAL_ACCESS_KEY` 与模型 key 分离；不用把任何 key 发到聊天里。

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

## 无凭据本地联调

~~~sh
cd /Users/yaotutu/Desktop/code/personal-bot
pnpm dev:mock
# 另一终端
cd /Users/yaotutu/Desktop/code/openmuse
EXPO_PUBLIC_API_URL=http://localhost:8788 pnpm dev:web
~~~

mock 默认监听 8788，使用真实 pi SDK + 本地模拟 OpenAI SSE endpoint，不读取 .env，不调用真实供应商。
模拟回复展示收到的用户轮数；发送 slow 可测试停止；发送含「时间/几点」的消息走 currentTime 工具闭环（模拟模型先发起 tool_calls，pi 执行工具后生成回答）。
模拟历史在 `.personal-bot/mock`，与正式历史隔离。
可通过 PORT / MOCK_DATA_DIR 覆盖 mock 端口和目录。

## 存储与安全边界

默认目录 `.personal-bot`（已忽略）：sessions/ 是 pi 会话，auth.key 是随机 token 签名密钥，workspace/ 与 agent/ 是专用运行目录。
模型 key 只驻留服务端内存，不写入 pi auth.json、不返回客户端；供应商错误诊断在持久化前脱敏。
对话本身按明文落盘，应保护或备份数据目录。登录 token 有效 24 小时，服务重启仍有效；更换访问密钥会使旧 token 失效。

这是可信本机、单进程、单 owner 服务，不是公开互联网生产部署。不要让两个进程共用一个 DATA_DIR。
P1 未做速率限制、跨进程锁、细粒度权限或数据加密；CORS 不是鉴权。
监听非回环地址必须设置访问密钥；远程访问还需要 TLS/反向代理。手机的 localhost 不是 Mac，真机验收需单独配置地址。

页面断开会取消正在生成的回复，已有部分文本保留；刷新后取最终持久化历史。没有运行中续接/后台聊天。
P1 关闭自动压缩和自动重试；长会话可能触及 endpoint 上下文限制，后续再接入可观察的压缩策略。

## 验证状态与后续

- 28 项自动测试全部通过（27 项 P1 既有 + 1 项工具闭环集成测试），经过实际 HTTP + pi SDK + 本地模拟 provider，覆盖协议、上下文、重启、去重、停止、断流、超时、鉴权、历史安全和工具事件序列。
- 工具闭环（问时间 → currentTime 执行 → 卡片展示 → 回答 → 刷新后关联）先在本地模拟 endpoint 下通过 Web 联调（docs/p2-web-smoke.png），随后在真实模型 endpoint 下复验通过（docs/p2-real-web-smoke.png）：
  真实模型会正确发起 currentTime 工具调用（finish_reason=tool_calls），工具前/后两段 assistant 文本正确合并展示，刷新后历史与工具卡片关联不变，普通文本轮正常。
- 真实 endpoint 配置在本地 `.env`（模型 ID 以网关实际路由为准，如 `silicon/deepseek-ai/DeepSeek-V4-Flash`）；key 只驻留本地文件与服务端内存。
- iOS/Android 复用现有客户端代码，但尚未做模拟器/真机运行验收。
- 下一步可评估 P2 后续的有限工具与可信 skills 扩展；不直接跳到完整后台任务体系。

详细规划见 docs/implementation-plan.md；接口盘点见 docs/openmuse-api-contract.md；pi 复用边界见 docs/pi-reuse.md。
