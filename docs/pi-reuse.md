# pi 复用清单与选型边界

调研日期：2026-10-10；生态复查：2026-10-14（见第 8 节）。已采用版本：@earendil-works/pi-coding-agent@1.1.0。
已安装并锁定该版本；真实 SDK + 本地模拟 OpenAI SSE 已通过自动测试和 OpenMuse Web 联调。真实目标模型尚未配置。

## 1. 优先复用什么

| 能力 | pi 提供的边界 | 我们仍需做的工作 | 计划 |
| --- | --- | --- | --- |
| 模型调用/流式解析 | pi-ai 及 SDK ModelRuntime；兼容endpoint可配置已有API类型 | 只暴露一个baseURL/model/key配置；验证目标endpoint行为 | P1 |
| agent loop | pi-agent-core，经coding-agent SDK使用 | 产品prompt、工具允许列表、客户端事件适配 | P1 |
| 会话保存/重开 | SessionManager、session文件 | owner/thread到session文件映射、稳定UI消息ID、单writer | P1 |
| 取消/运行终态 | session.abort / waitForIdle / 生命周期事件 | stop和断流传播；锁直到idle，不提前发送成功终态 | P1 |
| 上下文压缩/重试 | SDK会话能力 | 不把压缩后模型上下文当完整UI聊天历史；确认重试不会重复UI事件 | P1/P2 |
| system prompt/resources | DefaultResourceLoader，覆盖prompt/指定资源 | personal assistant身份；不要保留默认coding定位或自动读取个人全局资源 | P1 |
| 读文件/写文件/bash等 | 内置工具与自定义工具接口 | 权限策略、输出大小、路径边界、确认和UI工具卡片 | P2 |
| skills | SKILL.md发现与加载 | 选择实际有用且可信的技能，限制资源目录 | P2 |
| MCP | v1.1.0 SDK可显式加载MCP扩展 | 选一个已审核服务；连接生命周期、超时、取消、secret和权限配置 | P2以后 |
| 扩展机制 | 官方extensions/resources | 信任列表和可控加载；不需要自造通用插件市场 | 按需 |

关键区别：会话压缩是模型上下文管理，不是长期记忆；pi工具接入是执行能力，不是OpenMuse的任务产品语义。

## 2. 为什么优先选 coding-agent SDK

虽然名称含coding，但官方SDK允许替换system prompt、工具集合、模型、session和resource loader。可将它作为personal agent运行宿主，不必把默认CLI交互和工具全部带进服务端。

它能减少我们需要维护的session、compaction、skills/resources代码。先通过P1a确认嵌入、取消和历史能力，再落最终决定。

使用agent-core更轻，但会让我们自行承担上述持久化和资源管理。只有遇到明确SDK阻碍才降到这一层，不因为名字就先放弃复用。

调用方式优先in-process SDK，不解析终端输出，不在首期增加RPC子进程。以后如果执行隔离需要worker，重新讨论进程边界。

## 3. 版本与生态注意事项

npm registry核实：

| 包 | latest标记 | 备注 |
| --- | --- | --- |
| @earendil-works/pi-coding-agent | 1.1.0 | Node >=22.19.0；2026-10-07 UTC发布 |
| @earendil-works/pi-agent-core | 1.1.0 | 与同一命名空间SDK配套 |
| @mariozechner/pi-coding-agent | 0.73.1 | 旧命名空间；不能把这版API与1.1.0文档混用 |

新实现建议选已发布版本并提交lockfile，不跟main滚动升级，不混用新旧namespace。
SDK最终完成按选定版本核对：v1.1.0文档区分agent_end与agent_settled；前者之后可能还有自动恢复/队列工作，不能每个agent_end都发RUN_FINISHED。

## 4. 已找到的相关现成方案

### pi 官方 experimental server

@earendil-works/pi-server 的v1.1.0 README明确标为experimental，主要是应用托管Session的路由/attachment/facet-service机制；示例为Unix socket，认证策略仍由应用提供。

它不是OpenMuse的HTTP/AG-UI业务API，也不自动提供workspace、memory、tasks等产品接口。首期不为了“有server包”增加一层私有协议和进程管理；未来有多worker/多presentation需求时再评估。

### 社区 pi-web 的 AG-UI bridge

Epsilondelta-ai/pi-web 自身声明有AG-UI SSE bridge，可以参考其session事件映射和测试用例。

但该项目同时包含Astro前端和Go后端，不是确认可直接安装到我们TypeScript服务中的轻量SDK。当前仅审阅了README/package metadata，尚未审计bridge源码、取消/去重/恢复行为以及对所选pi版本的兼容性。

采用规则：P1实现前做一次有时间边界的源码检查；若有独立、许可明确、版本兼容的适配模块则复用，否则只借鉴事件映射，写满足最小契约的薄适配层。不要为了复用几十行事件映射引入另一套完整服务。

### 调度/heartbeat生态

到P4再针对durable执行要求评估。没有在本轮选定任何社区cron/heartbeat依赖，也不声称pi SDK已替我们实现重启恢复、审批、任务状态和OpenMuse通知。

## 5. 我们真正需要编写的少量代码

1. OpenMuse业务接口兼容层和诚实的未配置快照。
2. pi事件到AG-UI事件的转换，消息/toolCall稳定ID和错误终态。
3. 主会话协调：增量用户输入、运行去重、取消、history投影/写回策略。
4. 逐步增加个人身份、记忆、任务调度和必要权限策略。

不要重复实现：LLM token流解析、agent循环、通用会话格式、上下文压缩、skills parser、MCP wire protocol。

## 6. 参考来源

- 发布包：https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest
- 固定版本SDK：https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/sdk.md
- 兼容endpoint：https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/models.md
- 安全：https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/security.md
- session示例：https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/examples/sdk/11-sessions.ts
- prompt示例：https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/examples/sdk/03-custom-prompt.ts
- 官方实验server：https://github.com/earendil-works/pi/blob/v1.1.0/packages/server/README.md
- 社区bridge候选：https://github.com/Epsilondelta-ai/pi-web

## 7. 实现更新

P1 已复用 createAgentSession / ModelRuntime / SessionManager / abort / waitForIdle。业务历史和运行标识通过 custom entry 关联，重试通过 context edit 排除旧条目；不自行实现 agent loop 或模型 token parser。

选择自写薄 AG-UI adapter 和 runner，没有引入 pi-web 的完整服务栈，也没有复制其代码；社区 bridge 仍未完成源码审计，不作为当前可靠性依据。Pi 资源使用完全由宿主提供的 ResourceLoader；P2 再选择可信 skills/工具，避免自动开放执行能力。

## 8. 生态复查（2026-10-14）：版本动态与包适配结论

复查时点：官方包全线发布 1.2.0（2026-10-12），本项目仍锁定 1.1.0。monorepo 现有包：pi-ai、pi-agent-core、pi-coding-agent、pi-durable、chord、pi-codemode、pi-mcp、pi-tui、pi-telemetry、pi-server（停在 1.1.0）。项目活跃度：~115k stars，约每周一版。

### 版本策略

v1 稳定期继续锁 1.1.0；v2 动工（V0）时一次性升 1.2.x，按以下 SDK 相关变更核对：

- run 启动期间会话即计入 busy：`isIdle()` 为 false、`sendMessage()` 改为排队、abort 传递到启动中的 run（对取消链路是行为修正）。
- `before_agent_start` 变 union 且 sendMessage 触发的 run 也会触发；确认 resource-loader 的 `createExtensionRuntime` 未注册受影响 hook。
- `serializeConversation()`（压缩序列化）不再输出 thinking 块，修复"摘要请求大于被摘要上下文"的故障模式。
- 1.2.0 起 coding-agent 依赖树移除 chord（仅 pi-durable 依赖它），对我们是净简化。

### 包适配复查：自研功能对照 pi 生态

| 包 / 内置能力 | 对应本项目功能 | 结论 |
| --- | --- | --- |
| `pi-mcp` | MCP 接入（P2 以后） | 采用路径：已随 coding-agent 传递依赖存在，真要用时提为直接依赖，不引入第二套 wire 实现 |
| coding-agent 内置 skills | resource-loader `getSkills()` 现显式为空 | 未来给助手加技能知识时，开受控的 `DATA_DIR/skills` 目录发现，零新依赖；不打开默认发现 |
| `pi-codemode` | 模型写沙箱 JS 组合只读工具（新能力候选，非现有需求） | 唯一值得排期评估的新包；启用前须单独设计权限与资源边界（CPU/时间/输出大小/审批） |
| `pi-durable` | tasks/worker、jobs、PGlite records（v2 主线） | 否决维持：官方自标实验性且 API 随版变更；独立于 coding-agent 的第二套持久化体系；与"简单优先，崩了重跑"定论冲突。若未来要求任务断点续跑，应整体评估替换执行层而非混用 |
| `pi-telemetry` | 工具/模型错误诊断 | 单用户场景过重，不用 |
| `chord` / `pi-tui` | — | 不用：插件宿主/终端 UI 均超出项目边界 |
| `pi-server` | HTTP/AG-UI 服务 | 不用：仍 experimental 且未跟进 1.2.0，形状非本项目 API |
| 社区 pi-web 的 AG-UI 桥 | `src/adapters/ag-ui/` | 不用：桥内嵌于 Astro+Go 单二进制，不可独立安装；维持自研薄适配层 |

其余自研功能——memory 长期记忆、jobs 调度、goals/monitors、actions 审批、文件/web/天气工具、AG-UI 投影、鉴权——在 pi 生态没有对应物，是产品语义层，维持自研。文件工具不复用 pi 内置 read/grep/edit：结果 JSON 结构是 OpenMuse renderer 协议契约，且必须挂接本项目 workspace 边界与审批闸。
