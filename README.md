# pi-muse

基于 pi SDK 的单用户个人助手，包含 TypeScript 服务端与自有 Web 工作台。一个模型配置，多个独立会话，支持工具调用、显式记忆、定时提醒、网页监控和人工审批的文件写入。

个人助手行为参考 nanobot，UI 与交互参考 Muse；本项目不是 Muse 官方版本，不提供 OpenMuse/CopilotKit 兼容接口，也不对接外部聊天 channel。

## 功能与范围

- **对话与上下文**：多会话流式聊天、停止执行、历史恢复与自动上下文压缩。支持随单条消息提交 PNG/JPEG/GIF/WebP 图片和严格 UTF-8 文本附件；每个 thread 独立运行，pi JSONL 是历史唯一来源，压缩不删除展示历史。
- **身份与记忆**：SOUL/USER 身份文本、名字与语气每轮注入；长期记忆存放在 `memory.json` 并按需检索（`memory_search`），支持对话工具或 HTTP 显式增改删，以及按 2 小时周期运行的 Dream 后台记忆整理（主会话默认开启，非主会话全局建议与未声明用途的会话指令进待确认列表）。
- **会话设置与文件区**：会话专属指令、技能开关、私有工作目录，以及显式 scope 的私有/共享工作区 HTTP 文件管理。技能与规则不能扩大工具权限。
- **查询与文件工具**：时间、网页搜索与抓取、Open-Meteo 天气、文件读取与检索；`write` / `edit` 每次都需完整预览和人工审批，`bash` 不开放。
- **真实浏览器**：始终带 GUI 的系统 Chrome + CDP 帧流，服务端 `/browser` 调试页与 Agent 的 `navigate` / `snapshot` / `act` / `tab` 工具共享同一持久 profile，不提供 headless 模式。
- **提醒、目标与监控**：一次性或每日提醒、目标与里程碑、网页变化或关键词命中监控。定时提醒在来源会话执行，监控只抓取页面、不启动模型轮。
- **子代理**：主模型可调用 subagent，以单个、并行或链式方式处理独立子任务，结果回到父对话。单次最多 8 项，最多 4 项并发；不是后台任务队列，子代理权限只能收窄父会话上限。

当前面向可信本机或私人网络中的单用户使用，采用单进程、单模型配置。没有多用户、shell、外部 channel、执行断点恢复或模型/工具自动重试。图片附件要求当前模型支持视觉输入；PDF/Office/压缩包不解析。会话重置、浏览器能力等暂缓需求见 [需求池](docs/backlog.md)，不能当作已实现能力。

## 启动真实模型

需要 **Node.js 24+** 和 **pnpm 12.10.1**。以下命令均从仓库根目录执行，`pnpm install` 会安装服务端和 `web/` 工作区依赖。

```sh
pnpm install
```

首次使用时创建配置；已有配置直接编辑，不要覆盖：

```sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
```

编辑 `.pi-muse/config.json`：

- `model.baseUrl`：OpenAI-compatible Chat Completions 的 API 根地址，例如 `https://your-provider.example/v1`，不是完整的 `/chat/completions` 地址。
- `model.id`：模型 ID，必须与 baseUrl 一起配置；发送图片附件时该模型本身必须支持视觉输入，服务端不会自动换模型。
- `model.apiKey`：模型凭据，是否必填取决于供应商；不要与访问密钥混用。
- `server.accessKey`：Web 登录和 API 访问使用的密钥。默认监听 `0.0.0.0`，局域网访问应设置此项；仅本机使用可将 `server.host` 改为 `127.0.0.1`。

配置文件必须存在，非法 JSON、未知字段或无效值会启动失败；不从环境变量回退，也不展开 `${ENV_NAME}`。完整字段与默认值见 [配置说明](docs/configuration.md)。

启动服务端：

```sh
pnpm dev
```

默认 API 地址为 `http://127.0.0.1:17890`。服务端支持源码热重载；端口占用时直接失败，不自动换端口。开发服务可按 [工作区长期授权](../AGENTS.md#14-开发服务进程授权) 在核对归属后按需重启，无需逐次请示；不凭端口号停止生产、非本项目或归属不明的进程。

配置尚未填写模型时仍可启动和打开 Web，但聊天会明确报 `MODEL_NOT_CONFIGURED`，不会自动选用其他模型。

## 自研 Web 客户端（web/）

在另一终端启动 Web：

```sh
pnpm --dir web dev
```

打开 [Web 工作台](http://localhost:15173)。Vite 默认将 `/api` 代理到 `http://127.0.0.1:17890`；登录填写 `server.accessKey`，不是模型 API key。未设置访问密钥时可留空进入，但这不适合不可信网络。

Web 包含聊天、定时任务与监控、目标、身份/记忆设置，以及文件审批。服务端还提供会话规则、技能与删除接口，当前 Web 尚无对应管理界面；使用对话工具或按自动接口文档调用，不把服务端能力等同于页面已支持。

`API_TARGET` 可切换 Web 的后端代理，例如在服务端实际监听 18890 时：

```sh
API_TARGET=http://127.0.0.1:18890 pnpm --dir web dev
```

此变量只影响 Vite 代理，不覆盖服务端配置。Web dev 默认端口为 15173，构建预览默认端口为 14173，实际地址以启动日志为准。

工具执行与卡片展示是两回事；`hidden` / `summary` 只控制实时流和历史展示，不改变模型工具权限，也不省略审批。配置方法见 [工具展示策略](docs/configuration.md#工具展示策略)。

### 构建与 PWA

```sh
pnpm --dir web build
pnpm --dir web preview
```

Web 构建包含 manifest、图标和 Service Worker，后者仅在生产构建注册；缓存页面壳和静态资源，`/api/` 不缓存。离线可用范围仅为页面壳，聊天与业务数据仍需服务端在线。

安装与离线能力受浏览器、安全上下文及系统限制，建议使用 HTTPS；本机 localhost 可用于开发，不能把局域网 HTTP 下打开页面等同于完整 PWA 支持，也没有锁屏系统推送。

## 无凭据本地联调

无需模型配置或真实模型费用，可用本地 fake provider 跑 HTTP / pi / 工具链路：

```sh
pnpm dev:mock
```

另一终端启动 Web 并连接 mock：

```sh
API_TARGET=http://127.0.0.1:17891 pnpm --dir web dev
```

mock 监听 `127.0.0.1:17891`，不读取正式配置、不调用真实模型，数据保存在 `.pi-muse/mock/`。发送“现在几点”可触发时间工具，发送 `slow` 可测试慢流与停止；更多触发词见 [测试规范](docs/testing.md#fake-model-常用触发词)。

`.pi-muse/mock/` 是会保留数据的联调实例，不是自动化测试的临时目录；mock 端口和实例位置由脚本固定，不受 `API_TARGET` 改写。自动化和临时验收仍使用独立临时实例，不操作正式数据；需要重启开发服务时按上述工作区授权执行。

## 构建运行与接口文档

构建并运行服务端：

```sh
pnpm build
pnpm start
```

`pnpm start` 启动构建后的 API 服务，仍读取 `.pi-muse/config.json`；不会自动托管 `web/dist/`。Web 构建需另行静态托管并代理 `/api`，本地可用上面的 Vite preview 联调。

服务端默认提供以下入口，配置了其他端口时相应替换地址：

- [API 文档](http://127.0.0.1:17890/docs)：Scalar 页面。
- [浏览器调试页](http://127.0.0.1:17890/browser)：真实 Chrome 标签、画面与输入联调页面。
- [OpenAPI](http://127.0.0.1:17890/openapi.json)：由契约源生成的 OpenAPI 3.1。
- [健康检查](http://127.0.0.1:17890/api/health)：服务状态、模型配置状态与版本身份。

外部客户端通过 HTTP 和 AG-UI SSE 接入。鉴权、增量聊天、取消、审批和工作区通知的完整规则以部署版本的 `/docs` 与 `/openapi.json` 为准，不依赖历史适配稿或聊天说明。`/api/events` 是状态变更通知，不是运行续接或手机系统推送。

## 存储与安全边界

默认 DATA_DIR 是配置文件所在的 `.pi-muse/`，也可通过 `runtime.dataDir` 指定。相对路径始终按配置文件目录解析，不按进程 cwd；默认配置里填 `".pi-muse"` 会产生嵌套目录，省略或填 `"."` 才表示配置文件目录本身。

```text
.pi-muse/
├── config.json                         # 启动配置与凭据
├── auth.key                            # token 签名密钥
├── profile/                            # 全局用户画像、助手人设与记忆配置
│   ├── SOUL.md                         # 助手人设自由文本
│   ├── USER.md                         # 用户画像自由文本
│   ├── DREAM.md                        # 全局 Dream 整理提示词
│   └── memory.json                     # 长期记忆与身份设置（按需检索）
├── jobs.json / goals.json / actions.json / monitors.json
├── sessions/<threadId>/
│   ├── *.jsonl                          # pi 权威历史
│   ├── INSTRUCTIONS.md                  # 会话专属指令（含 ## 空间用途），按需存在
│   ├── DREAM.md                         # 会话补充 Dream 提示词，按需存在
│   ├── dream.json                       # 会话 Dream 开关、游标、最近结果与待决项，按需存在
│   └── skills.json                      # 会话技能覆盖，按需存在
├── workspace/
│   ├── shared/                          # 用 shared/... 显式访问
│   └── threads/<threadId>/              # 各会话私有文件区
├── skills/<name>/SKILL.md                # 可选的实例技能
├── subagents/<role>.md                  # 可选的实例角色覆盖
└── agent/                               # pi 运行资源
```

内置技能和子代理角色位于仓库 `assets/skills/`、`assets/subagents/`，构建时复制到 `dist/assets/`，不放入实例目录。实例中的同名技能或角色可以覆盖内置定义，但不能绕过既有权限。

- **文件隔离**：主会话 `local-main`、普通会话和每次 subagent 调用都有私有根；模型文件工具通过 `shared/...` 显式访问共享区，手动 HTTP 文件接口通过 `scope=space|shared` 显式选择根。两者都拒绝绝对路径、`..` 和符号链接。已启用技能的精确 `SKILL.md` 只读例外见 [架构规范](docs/architecture.md#文件工具与审批)。可信 extension 是服务端代码，文件工具 guard 不是操作系统沙箱。
- **写入审批**：模型每次 `write` / `edit` 都展示完整修改预览并绑定文件版本。拒绝、过期、取消或文件变化不能提交该次修改；批准仅代表授权，不等于落盘成功。手动文件 HTTP 仅在客户端已完成完整 before/after 预览并传 `confirmed:true` 后执行，最后一次成功保存生效；两条入口共用同路径提交队列，手动保存会使旧模型审批基准失效。
- **凭据与数据**：模型 key 只用于受保护配置和服务端内存，不写日志、返回客户端或进入会话文件。会话与业务数据按明文存储，配置、token 签名密钥和备份都需妥善保护；不要提交或上传实例目录及含凭据的备份。
- **访问控制**：登录 token 长期有效且可跨重启使用，更换访问密钥会使旧 token 失效。CORS 不是鉴权，不能代替访问密钥；远程访问还需 HTTPS/反向代理。手机的 localhost 不是运行服务端的电脑。
- **网络工具**：默认只允许公网 HTTP(S)，保留 DNS、固定 IP、逐跳重定向、大小和超时保护，外部内容标记为不可信。私网访问需显式配置，不会连带关闭其他保护。
- **数据与执行恢复**：单进程独占一个 DATA_DIR，没有跨进程锁、内置限流或数据加密。损坏数据明确报错，不通过删文件恢复空态，不自动迁移旧数据；旧 `tasks.json` / `task-*` 遗留数据不读、不迁移、不删除、不执行。

聊天流断开会取消所属运行，刷新后以已持久化历史为准，不保证恢复半截文本，也不支持运行中续接。定时任务失败如实记录，不自动重跑模型或工具；服务重启不补跑已过期的一次性提醒。

## 验证

代码改动后的默认检查入口：

```sh
pnpm check
```

依次执行类型检查、unit/integration、真实 dist 进程 E2E（含服务端构建）、Web 构建和 `git diff --check`。默认检查不调用真实模型；`pnpm test` 与 `pnpm test:e2e` 可分层执行，详细范围见 [测试规范](docs/testing.md)。

真实模型验收会产生费用，只有明确同意后才手动运行，不随默认检查、CI 或远程定时执行：

```sh
pnpm test:live --config .pi-muse/config.json --allow-live
```

live 仅从显式配置读取 model，真实 key 留在透明代理内存中，业务实例使用临时目录；默认回收，加 `--keep-artifacts` 可保留合成数据和脱敏报告，不接受命令行密钥。

新增功能或修复问题还需补本次回归，跑过旧测试不等于完成。服务端 fake provider、真实模型和 Web 页面验收分别记录，不能相互替代；本文不维护测试通过数量或历史进度流水。

## 开发文档

| 文档 | 用途 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 开发入口、全局底线、按任务必读和最低完成标准 |
| [架构规范](docs/architecture.md) | 职责、状态所有权、权限、生命周期与新能力接入 |
| [配置说明](docs/configuration.md) | 配置字段、实例路径、审批与工具展示选项 |
| [测试规范](docs/testing.md) | 回归、命令、证据标准与真实模型验收边界 |
| [API 开发规范](docs/api-development.md) | HTTP/SSE、工具报文、契约与自动文档交付 |
| [pi 复用边界](docs/pi-reuse.md) | SDK 集成范围、源码落点和升级核对 |
| [需求池](docs/backlog.md) | 已讨论但尚未实施的事项，不构成实施授权 |

[历史归档](docs/archive/)仅记录对应版本的讨论、实施与验收，不代表当前代码已经重新验证。
