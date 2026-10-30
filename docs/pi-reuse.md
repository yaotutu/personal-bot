# pi 集成与复用边界

本文说明当前代码复用了哪些 pi 能力，以及哪些职责必须留在本项目。修改 pi 集成或子代理前，与 [架构规范](architecture.md)一起阅读；详细权限与生命周期规则只在架构规范维护，接口交付和验收分别遵守 [API 开发规范](api-development.md)与 [测试规范](testing.md)。

## 版本与核对依据

- `package.json` 直接锁定 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` 为 `1.3.0`；API 以 lockfile、本地安装包及当前源码为准，不混用旧命名空间、旧版本或上游 main 的接口。
- 执行层使用进程内 coding-agent SDK。底层模型调用与循环由 pi-ai / pi-agent-core 承担，本项目不直接装配 pi-agent-core，也不解析 CLI 终端输出或另起 RPC 执行层。
- SDK 名称中的 coding 不代表必须使用默认 coding prompt、全部文件工具或个人 CLI 资源；本项目显式注入个人助手 prompt、模型、工具、资源和 SessionManager。
- 本文不是 npm latest 或生态现状调查，不把历史升级排期当作当前待办。2026-10-10 / 2026-10-14 调研及整理前原文见 [历史快照](archive/2026-10-18-pi-reuse-before-cleanup.md)，其中计划、包评价和旧实现描述不作为当前接入依据。

## 当前复用清单

| 能力 | 实际复用 | 本项目负责的边界 |
| --- | --- | --- |
| 模型配置与流解析 | `ModelRuntime`、SDK 模型调用与 pi-ai 流解析 | 单 endpoint/model，bootstrap 注册 provider 与内存 key，不把凭据写进历史 |
| 执行循环 | `createAgentSession`、`session.prompt` | 对话接纳、run/thread 标识、互斥锁、超时和产品提示词；不手写第二套 loop |
| 取消与收尾 | `session.abort`、`waitForIdle`、`dispose` | Stop/断流传播至工具与子会话，等待执行收尾才释放锁，不提前报告成功 |
| 会话历史 | `SessionManager`、JSONL、branch/custom entry/context edit | thread 与私有 cwd 映射、revision、展示投影及通知去重，不维护另一份聊天历史 |
| 上下文压缩 | SDK compaction 与 `SettingsManager` | 压缩参数按模型窗口收缩；展示读完整 branch，不拿压缩摘要替代长期记忆或完整 UI 历史 |
| 只读文件工具 | `createReadToolDefinition`、`createGrepToolDefinition`、`createFindToolDefinition`、`createLsToolDefinition` | 入口 guard 和 operations 路径复核，私有/shared 边界、符号链接拒绝、技能精确读取例外 |
| 写入工具接入 | SDK `defineTool` 与工具执行机制 | write/edit 是本项目实现，不直接开放 SDK 默认 write/edit；完整预览、版本绑定、逐次审批与提交检查由项目控制 |
| 技能解析与加载 | `parseFrontmatter`、`loadSkillsFromDir`，将生效技能传给 ResourceLoader | 内置 assets 与实例 skills 发现、会话开关与诊断；authoring 精确校验 frontmatter name 后复用 loader，不另写 YAML 解析器 |
| Extension 宿主 | SDK 扩展加载与运行机制、内联 extension factory | 仅装配已启用技能的显式 extension 路径和受控 subagent factory，不自造通用插件框架 |
| Subagent 编排 | 官方 1.3.0 示例的 single/parallel/chain 语义 | CLI runner 改为注入的独立 SDK session，参数统一为顶层 mode + tasks 契约，权限继承与收窄、父取消、审批归属和展示适配 |

自动压缩已开启，模型/工具自动重试关闭（`retry.enabled: false`）。显式用户重试与 pi context edit 不是自动重试，也不恢复未完成执行；具体规则见架构与生成契约。

## 主要源码落点

- `src/bootstrap/create-service.ts`：唯一 `ModelRuntime`、provider 与内存凭据的初始化；不同 thread 共享 runtime，不共享执行锁和上下文。
- `src/adapters/pi/session-factory.ts`：每轮会话装配、模型选择、技能/工具裁剪、压缩设置、subagent child runner。
- `src/adapters/pi/resource-loader.ts`：向 SDK 提供明确的 system prompt、已启用技能和扩展，不发现个人 CLI 的 context files、prompt templates 或 themes。
- `src/adapters/pi/session-history.ts`、`history-projection.ts`：权威 JSONL 读取、custom entry/context edit、revision 与展示历史投影。
- `src/adapters/pi/execution.ts`：SDK 事件投影、取消/idle port，以及进入模型上下文和 JSONL 前的错误脱敏。
- `src/adapters/pi/tools/files.ts`、`path-guard.ts`、`workspace-path.ts`：只读工具复用、启用技能资源精确读取例外与路径收口；`src/adapters/pi/tools/files-writable.ts`、`file-approval.ts`、`skills.ts`：本项目逐次审批写入与技能维护。
- `src/adapters/pi/tools/index.ts`：显式工具注册及技能映射；`src/adapters/storage/skill-repository.ts`：会话技能覆盖与诊断。

## 资源、技能与扩展

- 技能不再为空。会话装配通过 SDK 解析内置 `assets/skills/`（构建后 `dist/assets/skills/`）和实例 `DATA_DIR/skills/`，根据生效开关选择技能；同名实例技能优先。普通会话指令单独从本会话 `INSTRUCTIONS.md` 注入，不交给 SDK 默认目录发现。
- `skills` 只维护产品技能文本：实例保存仍由 pi 解析规则验收；允许的 references/assets 文本作为启用技能的 read-only 例外装配。资源必须依附合法实例 `SKILL.md`，不能创建/修改 `extension.ts`、脚本、config 或嵌套技能根。
- 已启用技能目录中的 `extension.ts` 通过显式路径装配；保留名或重复工具不会靠加载覆盖已注册工具。全局可选能力、技能开关与子角色约束共同收窄工具，不因发现资源就扩大权限。
- 技能正文属于模型可读资源，extension 则是可信服务端代码；路径 guard 不是执行 extension 的操作系统沙箱。不能把“复用了 SDK 加载器”表述为恶意代码隔离保证。
- 子代理只接收父会话许可的资源/工具上限，不加载个人 `~/.pi`，不复制父历史或会话指令。精确例外与隔离细则见 [文件工具与审批](architecture.md#文件工具与审批)和 [子代理](architecture.md#子代理subagent)。

## Subagent 示例的本地适配

官方包附带 `examples/extensions/subagent`，它是示例扩展，不是自动启用的内置后台任务系统。本项目保留编排语义，但将其启动 CLI 的 runner 改为受限的 `createAgentSession` 调用，并将入参统一收拢为顶层必填 `mode` + `tasks`（移除混传入口，声明 `constrainedSampling` strict prefer）；子会话使用 `SessionManager.inMemory`，结果回到父工具结果，不引入第二套执行或持久队列。

源码来源、MIT 许可和本地差异见 [适配目录说明](../src/adapters/pi/subagent/README.md)。运行权限、并发限制、审批与旧 worker 数据处理统一以 [架构规范](architecture.md#子代理subagent)为准，HTTP 与工具展示以当前生成契约和自有 Web 为准，不复制历史 OpenMuse 报文作为兼容目标。

## 不因 SDK 或依赖存在而引入的能力

- memory/identity、jobs 调度、goals、monitors、actions 审批、HTTP 鉴权和 AG-UI 投影是本项目产品职责；SDK 提供执行与资源机制，不自动提供这些业务语义。不得因此将它们迁入第二套 agent loop 或状态系统。
- pi-mcp、pi-codemode 等可能随 SDK 作为传递依赖安装，不等于产品已经接入 MCP 或沙箱代码执行。当前显式装配不开放这些能力，启用前必须单独定义权限、凭据、生命周期、取消与失败边界，不能把历史候选包清单当作实施授权。
- 不引入 pi-durable、持久队列或自动恢复来改变“崩了重跑”的已确认原则。不因为 SDK 有重试能力而打开自动重试，不把压缩视为 Dream 或自动记忆提取。
- HTTP 层仍是项目自有 Hono/契约/AG-UI 适配，不因有 pi-server 或社区 pi-web 而增加另一层宿主或兼容接口。历史包评价只说明当时的选型，不宣称完成了当前生态的全面审计。

## 升级或改造时的核对清单

1. 先核对 `package.json`、lockfile 和本地安装包的 SDK 文档/声明/源码，确认当前版本实际支持的 API；升级同步依赖版本，不直接修改 node_modules、SDK 底层或借升级扩大工具权限。
2. 核对 prompt/abort/idle/事件顺序，特别是有工具执行、压缩、子会话或取消时的收尾；不能只凭一次 agent_end 或文本输出发出成功终态。
3. 核对历史 branch/context edit、SessionManager 的 cwd 选择和 JSONL 持久化时序；错误脱敏必须早于模型接收和落盘，不能退化为仅清洗 SSE。
4. 核对只读工具参数/结果、路径解析与 operations 钩子，重跑越界/符号链接/私有与 shared/技能精确读取回归；write/edit 保留逐次审批，不换回无限制默认工具。
5. 核对资源发现、扩展钩子和子会话 allowlist；对照官方 subagent 示例更新本地差异，不能悄悄恢复 CLI spawning、个人资源发现或子代理递归权限。
6. 按 [测试规范](testing.md)补本次回归并运行 `pnpm check`；真实模型适配、子代理、工具、审批与取消关键链路需经费用授权 live 验收，工具展示/API 文档另做适用页面检查。历史报告不是新版本通过证明。

固定版本上游参考：[SDK 文档](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/sdk.md)、[模型配置](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/models.md)、[安全边界](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/security.md)、[subagent 示例](https://github.com/earendil-works/pi/tree/v1.3.0/packages/coding-agent/examples/extensions/subagent)。引用用于定位来源，实际核对以项目安装包为准。
