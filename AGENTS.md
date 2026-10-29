# AGENTS.md — pi-muse 服务端开发入口

基于 pi 的个人助手服务端：单用户、多 space、单业务模型；每个 space 绑定独立 pi 会话。`web/` 只是接口与 renderer 联调工作台，不是移动端产品；不做多用户、多 channel 或 OpenMuse/CopilotKit 宿主兼容层。

所有开发工作先读[根规则](../AGENTS.md)与[Agent 协作指南](docs/agent-workflow-guide.md)，再按下表读取专项文档。链接不代表内容已自动加载；跨层任务要读完所有适用项。

## 按任务必读

| 任务 | 必读入口 |
| --- | --- |
| 接手项目、确认状态 | [README](README.md)、当前源码、`git status`；全局状态另见[项目地图](../project-map.md) |
| 修改业务、状态、存储、权限、pi 集成或生命周期 | [架构规范](docs/architecture.md)、[pi 复用边界](docs/pi-reuse.md) |
| 新增功能或修复问题 | [测试规范](docs/testing.md)，并按实际改动补回归测试 |
| 修改 HTTP/SSE、工具报文或客户端接入 | [API 开发规范](docs/api-development.md)，同时核对 `src/http/contracts/` 与自有 `web/` |
| 修改配置、启动、部署或联调环境 | [开发与联调指南](docs/development.md)、[快速上手](docs/manual/getting-started.md)、[配置说明](docs/manual/configuration.md) |
| 编写文档或修改用户可见行为 | [Agent 文档编写指南](docs/agent-documentation-guide.md) |
| 修改虚拟形象素材或展示能力 | [虚拟形象素材说明](docs/avatar.md) |
| 制作或修改项目吉祥物、默认角色、品牌图标及其派生素材 | [项目级品牌资产基准](docs/assets/brand/README.md)，所有端以同一 T1 形象为来源 |

## 技术底线

- 使用 Node.js 24+ 与 `package.json` 声明的 pnpm 版本；依赖安装与脚本以当前工程定义为准，不改全局工具配置。
- JS/TS 优先函数式工厂和显式依赖注入，不引入 DI 框架、空壳抽象、万能 `utils.ts`、通用插件框架或事件总线。
- 交互、HTTP、AG-UI 报文与工具卡先核对自有 `web/` 和 `src/http/contracts/`；能力语义、调度、副作用与失败策略先核对 nanobot 源码再适配 pi。冲突时不改 pi 底层、不用假数据伪装兼容，明确差异并记录。
- pi 的 `createAgentSession` 是执行循环、工具执行与持久化权威：不手写第二套 agent loop，不修改 pi 底层。各 thread 的 SessionManager/JSONL 是聊天正文、附件事实与工具结果唯一历史；Pi Muse 自有业务事实使用独立 repository，不为存储这些事实 append 到 PI branch、隐式注入模型上下文或改变会话 revision。显式信息处理与只读工具查询的消费边界见架构规范。
- 开发用子 Agent 与产品内 subagent 是两套机制；开发委派不增加产品能力或权限。产品内新增网络、文件、MCP、委托等能力前，先定义权限、审批与错误边界，注册工具名不等于授权。

## 安全与数据边界

- 服务端永不暴露 `bash`；`write`/`edit` 必须完整差异预览、人工二次审批并绑定文件版本。拒绝、过期、文件变化或运行取消不能提交该次修改，会话规则与技能开关不能扩大权限。
- 模型 API Key 只留在受保护实例配置与服务端内存，不写日志、不返回客户端、不进会话文件；备份按敏感凭据处理。
- Web 抓取默认仅允许公网 HTTP(S)，保留 DNS/固定 IP/重定向/大小/超时等 SSRF 防护，外部内容标记不可信；私网例外必须显式配置，不能顺带关闭其他保护。
- 模型/工具错误在进入模型上下文和 pi 持久化前脱敏，仅受控拒绝文案可透传；不能只清洗 SSE。
- 普通文件工具仅访问当前 thread 私有根与显式 `shared/...`；无父目录特权，不允许越界或符号链接绕过，技能读取例外见架构规范。
- 单进程绑定单 DATA_DIR，保留 AccessKey 鉴权。仅缺失数据文件可初始化；损坏或非法数据必须报错，不得静默置空、过滤坏条目或删文件消除错误。
- 未经明确授权不修改真实 `.pi-muse/`、备份、凭据或 OpenMuse 仓库；测试与临时验收使用独立临时实例。开发进程启停、模块收尾与本地提交按根规则长期授权执行。

## 最低完成标准

- 功能变更补本次回归测试并断言实际状态，不以模型自然语言自述当结果；代码改动完成 `pnpm check`，失败、阻塞和未运行项如实报告。
- 所有测试遵守根规则：真实连接当前后端并真实调用外部大模型，不以 fake provider、拦截值或本地假模型替代。用户已长期授权开发测试真实模型费用；现存 `pnpm check` 不含 live，单独通过不满足该要求。
- HTTP/SSE 与工具报文变更同步契约源、契约测试和自动生成 `/docs`、`/openapi.json`，不手写 OpenAPI，不产生影子端点。工具名、参数、结果 JSON 与事件顺序都是协议契约。
- 涉及工具卡或客户端展示时，在自有 Web DEV 实际验证 renderer、历史刷新和错误态；不能只看 schema 或 AG-UI 事件。
- 重大服务端改动向主 Agent 交付事件、字段与失败语义差异，由其安排当前移动端适配和整体回归，不口头宣称多端已同步。
- 文档-only 变更检查差异、引用、命名与规则一致性；用户手册、导航或构建受影响时按文档指南验证。

## 规则归属

详细规则只有一个归属：架构与权限边界在架构规范，测试与验收在测试规范，契约开发与交付在 API 开发规范，环境与命令在开发指南，文档写法在文档指南。本文件不累积业务实现、历史验收或待办；当前状态核对源码与本次验证，历史进 archive，待办进 backlog/discussions。
