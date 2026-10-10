# AGENTS.md — Personal Bot 项目指南

基于 pi 的个人助手服务端：单模型、单会话、单用户，对接 OpenMuse 客户端（Web 优先）。
最终目标是复刻 nanobot 的个人助手能力，**不做**多 channel 对接。

## 常用命令

```sh
pnpm dev        # 真实模型服务端（读 .env，127.0.0.1:8787，tsx watch 热重载）
pnpm dev:mock   # 本地模拟模型（8788，不读 .env，数据在 .personal-bot/mock）
pnpm test       # 33 项集成测试（node:test，真实 HTTP + 真实 pi SDK + 模拟 provider）
pnpm typecheck && pnpm build
```

OpenMuse Web 客户端（另一仓库，`~/Desktop/code/openmuse`）：
`EXPO_PUBLIC_API_URL=http://localhost:8787 pnpm web`（8081，dev 模式热更新）。

## 架构分层（自上而下）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| HTTP/协议 | `src/app.ts` | Hono 路由：OpenMuse 快照接口（兼容层）、AG-UI runtime 挂载、鉴权、CORS、调度器启动 |
| AG-UI 适配 | `src/runtime.ts` | PiAgent(AbstractAgent) + 自定义 runner：SSE 退订即取消 |
| 会话协调 | `src/conversation.ts` | run（客户端轮）/ trigger（定时轮）共用互斥锁；历史投影（toolCalls/tool 消息）；validate/去重/取消/超时；脱敏 |
| pi 内核 | `src/pi.ts` | openPi()：单 provider 注册、系统提示词（基础 + SOUL/USER + 记忆注入）、工具注册与 allowlist、guardTool 路径边界 |
| 能力模块 | `src/memory.ts` `src/jobs.ts` | 记忆 CRUD + 渲染注入；定时任务存储 + nextRun 计算（均为单文件 JSON，串行化写） |
| 模拟 | `tests/fake-model.ts` | OpenAI SSE 模拟 provider，按触发词走各工具路径 |

## 硬边界（违规即返工）

- 模型 key 只驻留 `.env` 与服务端内存；不写日志、不返回客户端、不进会话文件。
- 文件工具只读且只允许 `DATA_DIR/workspace`（guardTool 强制，绝对路径/`../` 逃逸拒绝）。
- 工具/模型的错误信息默认脱敏（"Tool execution failed"/"Model request failed"）；仅 guard 声明的受控拒绝文案（`details.denied`）可透传。
- 不在 `createAgentSession` 之外手写 agent loop；工具执行与持久化交给 pi。
- 允许列表：`tools: ["currentTime","memory","schedule","read","grep","find","ls"]`——bash/edit/write 永不暴露。
- 单进程单 DATA_DIR；非回环监听必须设访问密钥。

## 设计哲学（用户定论，勿违背）

- **简单优先，崩了重跑**：不为低概率故障做复杂设计；无 durable execution、无断点续跑、无自动重试。定时任务失败只诚实标记。
- **最小 fork**：对 OpenMuse 的改动压缩到 2 文件约 90 行，以 patch 维护在 `compat/openmuse/`（含基线 commit 与应用方式）；服务端自成一体，自研客户端直接对接 AG-UI。
- 记忆只显式写入（对话工具 + Apps 界面），不做自动提取。
- 通用工具卡片（OpenMuse 端 `name: "*"`）已兜底：服务端新增只读工具**不需要改客户端**。

## 测试与 fake-model 触发词

集成测试走真实 HTTP + pi 链路，仅模型是模拟的。触发词表（`tests/fake-model.ts`）：

| 用户消息 | 模拟行为 |
| --- | --- |
| 含 `时间/几点` | currentTime 工具轮 → 第二轮 `time reply: <结果>` |
| 含 `读`（含 `敏感/secret` 则越界） | read 工具轮（越界路径 `/etc/passwd`）→ `file reply:` |
| 含 `记住/忘掉` | memory 工具轮 → `memory reply:` |
| 含 `提醒我` | schedule 工具（15 秒后一次性任务）→ `schedule reply:` |
| 以 `⏰` 开头 | 直接回 `JOB-RAN ...`（定时触发轮） |
| system 含 `context summarization assistant` | 返回短摘要（pi 压缩请求） |
| 字面量 `fail-once/freeze/slow/disconnect/broken` | 401 一次 / 挂起 / 慢流 / 断流 / 半截响应 |

改 harness 环境变量时注意：`PERSONAL_MODEL_MAX_TOKENS` 必须 < `PERSONAL_MODEL_CONTEXT_WINDOW`，否则 loadConfig 抛错且 fake-model server 未清理会让测试进程静默 hang。

## 数据目录（`.personal-bot/`，gitignore）

| 路径 | 内容 |
| --- | --- |
| `sessions/` | pi 会话 JSONL（历史权威来源） |
| `SOUL.md` / `USER.md` | 自由文本身份（注入 system prompt，每轮重读） |
| `memory.json` | 长期记忆条目 + identity 设置（P3 权威存储） |
| `jobs.json` | 定时任务（P4） |
| `workspace/` | 资料目录（read/grep/find/ls 的唯一可达范围） |
| `agent/` `auth.key` | pi 运行目录 / token 签名密钥 |

## 已知限制（诚实声明）

- 真实模型 endpoint 为局域网网关（`silicon/deepseek-ai/DeepSeek-V4-Flash`）；模型偶尔省略工具参数（已用 schema 必填缓解）或偷懒不调工具（提示明确要求即可）。
- 定时触发轮无实时 SSE 推送（用户刷新/下轮同步后可见）；客户端旧历史与触发轮冲突时收到一次 409 后自动同步。
- iOS/Android 未验收（Web 优先）；多会话/多用户/外部 channel 明确不做。
