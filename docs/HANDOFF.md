# pi-muse 当前交接

更新：2026-10-18。当前为单进程、单用户、单模型、多 thread 的模块化单体，自有 `web/` 是客户端。用户已明确不保留任何历史逻辑兼容；旧接口、占位字段和隐式迁移已移除。此前交接全文归档到 `docs/archive/handoff-before-incremental-protocol.md`，不能作为当前实现约定。

## 待实施需求入口

- 后续讨论但暂时不做的需求，统一记录在 [`backlog.md`](backlog.md)；详细方案放 `docs/discussions/`。认可方案不等于立即开工，开始实施仍需用户明确授权。
- **REQ-001：Dream 后台记忆整理**，用户已于 2026-10-18 认可方案并明确暂缓，详见 [`discussions/dream-memory.md`](discussions/dream-memory.md)。现有 pi 压缩不变，新增后台自动整理长期记忆；当前尚未实现，不提前改变现有“显式记忆写入”行为。
- **REQ-002：重置当前会话（保留记忆与工作区）**，用户已确认核心方案、暂缓实施：用于主动清空上下文或上下文故障，不是新建另一个会话；保留规则、记忆与原工作区。历史展示、运行/审批收尾及通知衔接在实施前细化；未开工，不与 Dream 混合实施。

## 工作区变更通知流（2026-10-18）

- 新增 `GET /api/events`（独立命名 SSE，不复用 AG-UI 聊天事件），仅推送“重新读取”信号；`workspace_updated` 涵盖 jobs/tasks/goals/memories/monitors/identity/worker，`actions_updated` 涵盖审批集合所有状态。完整客户端契约由 `contracts/workspace-events.ts` 与端点注册表生成到 `/docs`、`/openapi.json`，[`http-api-contract.md`](http-api-contract.md) 仅作辅助说明。
- 当前实现范围：服务端推送骨架 + 工作台/审批提交后通知触发 + 慢连接有界合并 + abort/cancel/service-close 清理。客户端协议仅约定，不替代现有轮询；移动端与浏览器后台锁屏不在本轮范围，分页与历史留存未做。
- 验证：SSE 专项 22 项（14 unit + 8 integration）通过；`pnpm typecheck && pnpm test && pnpm build`（全套 306/306）与 `git diff --check` 通过。覆盖鉴权、提交失败不通知、多连接、审批全终态、模型工具写入、worker 归闲、慢读合并、断连不取消聊天，以及持有 SSE 时入口 SIGTERM 自然 code 0；已有初始化失败清理回归同样通过。
- 隔离后端 + 自有 Web 15173 DEV 代理的浏览器 fetch 实测收到 `ready`、记忆保存后的 `workspace_updated`、拒绝审批后的 `actions_updated`，随后读取接口确认记忆存在且 pending 已清空。本轮没有改客户端轮询或验证自动接入，不冒充真实模型/移动端/锁屏推送验收；本轮临时服务、数据与浏览器页已清理，未改正式数据或自动 commit/push。
- 文档收尾：完整协议写入 `WORKSPACE_SSE_DESCRIPTION`，通过端点 `hint` 生成标准 `operation.description`；事件表由同一 zod 契约生成，关键说明不再仅存在于 Markdown 或 `x-sse-events`。隔离实例实际打开 `/docs` 的“通知”分类，确认鉴权、事件表、分帧、心跳、刷新补刷、前后台重连、401/503 和断连不取消业务均可见；实际 `/openapi.json` 内容一致。
- 收尾验证：SSE 与文档专项 28/28，全量 308/308，typecheck/build/diff 检查通过。全量首次运行暴露入口进程测试的 8 秒启动预算不足；改为启动最多 25 秒、独立保留 SIGTERM 后 8 秒退出检查后全量通过，业务实现未变。文档验收临时实例自然退出 code 0，临时数据和浏览器页均已清理。
- 工作区通知流及契约文档已提交为 `473213f`，会话技能/指令/隔离工作区基线为 `e37e544`，均在 `feat/auth-token-long-lived`；未 push。自有 Web 的现有轮询尚未替换，前端会话适配说明见 [`frontend-session-workspace-adaptation.md`](frontend-session-workspace-adaptation.md)。

## 旧数据清理与提交前整理（2026-10-18）

- 经用户明确授权，停掉本项目遗留 watcher/17890 服务后，校验备份 58 个文件至 `.pi-muse-backups/before-session-workspace-reset-20261018-115852/`；备份目录0700、文件0600，含凭据，禁止提交或上传。
- 清空旧 sessions/workspace、jobs/tasks/goals/actions/monitors、两条长期记忆、旧 mock 和嵌套 `.personal-bot/mock`，删除实例内旧 config 备份副本。原 config.json/auth.key/SOUL.md/USER.md 字节不变，memory.json 的 identity 设置保留。恢复单一 `pnpm dev` 实例，health正常、仅local-main、历史revision=empty，记忆/任务/目标/监控均0。
- 提交前收尾：技能元数据统一使用 pi parser；坏技能配置不覆盖且返回诊断，坏会话覆盖文件报错，覆盖写入复用串行队列与wx/0600/rename；会话指令工具与HTTP共用原子writer，无content的set不再误清空；扩展同名工具从实际注册中剔除；资产复制使用Node脚本，重复构建不嵌套、运行路径不依赖cwd。
- 本轮提交树在独立目录验证：284项测试全部通过、typecheck、服务端连续两次build、Web build通过；不把工作树同时新增的 `/api/events` 工作区通知能力混入此次提交，相关未提交改动原样保留。此前277项及真实模型范围见下方验收记录，本轮整理不冒充新增真实模型验收。

## 会话工作区隔离修复完成（2026-10-18）

- 所有会话（含local-main/task-*）统一使用 `workspace/threads/<threadId>/` 私有根，shared映射到 `workspace/shared/`；执行cwd、工具根与SessionManager.continueRecent的cwd一致，禁止global workspace fallback。
- 普通文件工具拒绝绝对路径、..、根/父目录/目标符号链接；只读operations核查SDK实际路径，递归搜索不跟随链接，ls跳过链接。write/edit复用同一检查，审批版本/取消/时效与共享提交队列不变。仅read精确开放本轮启用技能的SKILL.md，不开放相邻文件或目录。
- 277/277测试、typecheck、服务端/Web构建和diff检查通过。编译入口隔离实例health=200、SIGTERM code0；threads容器为链接时初始化明确失败code1且外部测试文件不变，无残留进程。
- 真实DeepSeek+自有Web复测：主会话跨会话读取和文件/目录链接绕过均已拒绝；自身私有/共享读取、Web审批后的私有/共享写入、另一会话读取共享文件、会话规则保存与重启后保留均有效；三会话重启messages/revision一致。权威JSONL确认没有邮件私有标记泄漏到其他会话工具结果。完整范围见 [`archive/2026-10-18-workspace-isolation-fix-acceptance.md`](archive/2026-10-18-workspace-isolation-fix-acceptance.md)。
- 正式数据/旧文件/旧JSONL未迁移改写或删除；新cwd不自动恢复旧cwd历史。已有真实数据需停服备份后单独处理。临时验收服务均已停止；未主动重启或停止既有17890 watcher（其可能随源码变化热重载）。无自动commit/push。
- 本边界不等于操作系统沙箱，不限制已安装的可信extension任意服务端代码，不承诺抵御外部恶意进程路径竞争。下方初次验收的两处P1是修复前记录，不再是本轮代码的未修复项。

## 会话指令与工作区真实验收（2026-10-18）

- 当前未提交的会话指令/工作区改造经真实 DeepSeek 模型 + 自有 Web DEV 验收，结论为**部分通过，不可宣称工作区已彻底隔离**。完整复现与证据见 [`archive/2026-10-18-session-workspace-live-acceptance.md`](archive/2026-10-18-session-workspace-live-acceptance.md)。
- 指令通过对话工具与 HTTP 保存、下一轮注入、热更新、跨会话不污染、正常重启后保留均有效；真实模型对“固定标记独占第一行”的遵循并非每次严格，不能视为强制格式协议。
- 普通会话私有路径、显式 shared 读写/检索、Web 批准与拒绝、删除会话保留共享区均通过。**发现两处 P1：主会话根为整个 workspace，能读取其下其他会话私有文件；只读 guard 未校验链接实际指向，可经预置符号链接跨会话读取。**此前 269 项测试没有覆盖这两种情况，不能代替隔离验收。
- prompt 未说明 shared 别名且仍声称无文件写权限，真实模型曾在默认根目录检索后误报共享文件不存在；明确指定 shared 路径后工具可用。当前 Web 无会话规则编辑面板，仅有对话/HTTP 入口。
- 本轮仅测试与记录，没有修复业务代码。隔离实例使用临时数据目录，凭据仅在服务内存读取；正式数据未写入、既有 17890 服务未停止。本轮隔离后端与 15173 Web DEV 已停止，测试证据暂留在报告注明的本地目录。

## 迁移后真实运行复测（2026-10-17）

- 正式 17890 服务健康检查通过，6 个 thread 的 49 条展示消息及 revision 与迁移备份一致，auth.key 未变；没有向正式会话写测试消息。
- 隔离实例使用真实模型，在自有 Web DEV 验证错误密钥、currentTime 查询、memory 写入、中文回答、桌面/移动端工具卡片与刷新恢复；正常重启隔离服务后，消息数量、revision、记忆和原 token 保持一致，无未捕获异常或 console.error。
- 类型检查、261 项测试、服务端与 Web 构建、差异检查通过；本轮临时浏览器、服务及隔离数据已清理，正式服务保持运行。现有非回环监听且未设 accessKey 的配置警告未在改名任务中擅自修改。

## 数据目录迁移（2026-10-17）

- 当前默认配置与实例目录为 `.pi-muse/config.json` / `.pi-muse/`，mock 为 `.pi-muse/mock`；不读取旧目录、不运行中迁移、不新增 fallback。当前启动说明以本节和下方“启动与联调”为准，后文品牌更新中“保留旧目录”是此前阶段记录。
- 经用户确认正常停止原 watcher/服务后，完整备份到 `.pi-muse-backups/2026-10-17T07-58-38-142Z/`（0700，config.json/auth.key 为0600），58个文件逐一校验后移动目录；配置仅更新 runtime.dataDir 的绝对路径语义，其余字段不变。
- pi continueRecent 会按 header.cwd 筛选会话，因此离线更新正式、mock及既有嵌套实例中23个会话头的旧根前缀；消息正文、自定义条目、ID、时间戳及文件mtime保持。既有内部相对目录结构不重排，原本cwd不匹配的历史不强制纳入；22个会话目录的最近会话选择与迁移前一致。未修改pi SDK或增加新的会话选择策略。
- 原17890开发服务已从新默认目录恢复；只读核对6个thread、49条展示消息及revision与备份投影相同，auth.key字节未变，备份密钥签发的token可用，旧根目录已不存在；未向真实会话发送验收消息。
- 类型检查、261项测试、服务端/Web构建和diff检查通过。新增默认路径测试覆盖“只读新目录、旧目录不回退”；隔离迁移覆盖绝对路径配置、历史/revision/工具结果/通知、token、自定义identity、parentSession、mtime及cwd隔离，损坏header在rename前拒绝。新默认目录的编译入口验证SIGTERM code 0、配置/数据损坏code 1且原件不变。
- 隔离Web DEV验证迁移后工具卡片、通知和刷新、迁移前token继续登录，无未捕获异常或console.error；模型为fake provider，仅用于本轮迁移回归，不冒充新的真实模型验收。此前品牌阶段的真实模型验收范围不扩大。
- 回退必须先停新服务，保留故障目录，再从上述受保护备份恢复原 `.personal-bot/` 及config/会话头，并同步回退本轮默认路径（不要撤销品牌改动）或显式加载原配置；不能让两套目录同时运行。备份含凭据和对话，保持权限、不要提交/上传，不通过删损坏文档消除错误。启动仍沿用既有审批取消、任务状态恢复和jobs重算语义。
- 本地项目文件夹、GitHub仓库/remote、历史协议标识和已有identity未改；未覆盖用户正在编辑的讨论稿，未自动commit/push。

## pi-muse 品牌更新（2026-10-17）

- 项目及页面品牌统一为 `pi-muse`，包名为 `pi-muse` / `pi-muse-web`；登录页、桌面侧栏、移动顶栏、HTML/PWA 标题、API 文档、日志与新实例默认身份均已更新。README 说明基于 pi、UI 与交互参考 Muse，属于非官方项目。
- `.personal-bot/`、默认配置路径、pi 历史条目类型及通知元数据、浏览器 token/cache key 均保留；不做自动迁移、双写或旧格式 reader。已有 identity 名称属于用户数据，不覆盖；历史方案中的旧名及对 OpenMuse 的引用不改写。本地目录、GitHub 仓库和 remote 未改名。
- `pnpm typecheck`、`pnpm test`（260/260）、`pnpm build`、`pnpm --dir web build`、`git diff --check` 通过；API 品牌标题已有契约回归断言。
- 自有 Web DEV 在独立端口 15175、隔离后端 18890 验证登录及错误密钥、桌面/390px 移动端品牌、manifest、真实模型 currentTime 工具卡片与中文回答、刷新恢复和登录保持、Scalar API 文档。未观察到未捕获异常或 console.error；真实模型范围仅为此次时间工具链路。
- 构建预览在 14175 验证 Service Worker 激活、旧应用壳缓存经联网刷新更新为新品牌、离线导航保留新品牌、token 保留且 `/api` 未缓存；未将这些结果表述为手机系统安装名称已自动更新。
- 编译入口在自建临时 cwd/DATA_DIR 验证 health/API 标题与 SIGTERM code 0；非法配置及损坏 monitors 初始化失败均自然 code 1，原文件字节不变。真实配置仅为隔离真实模型验收在内存中读取模型配置，凭据未打印或复制到临时配置文件；未修改真实数据、OpenMuse 仓库及用户未跟踪的讨论稿。
- 下方保留此前架构调整的阶段记录；当前工作区以 `git status` 为准，不能将此前“干净”的记录当作本轮状态。此次未自动 commit/push。

## 接手起点

- 当前分支：`main`；架构调整与代码整理已按用户要求提交为 `54e914a`（重构个人助手执行边界与增量聊天协议），未 push。
- 更新本交接前工作区干净。本文是该提交之后的文档更新；接手时先执行 `git status --short`，不要撤销新增改动，也不要误认为主体重构仍未提交。
- 本轮约定的重构已完成，没有必须继续修复的已知阻塞项。后续按用户实际需求推进，不为预防未来规模提前引入数据库、队列框架或执行恢复。
- 优先阅读顺序：`AGENTS.md` → 本文 → `docs/architecture.md` → `docs/http-api-contract.md`。`docs/archive/` 只作历史记录。

## 本轮架构调整

- 聊天直接由 Hono 接收增量请求并输出 AG-UI SSE，删除 CopilotKit runtime、PiAgent、runner 及对应依赖。GET 历史返回 pi 叶子 revision；run 仅提交单条 message、expectedRevision 与 runId，版本冲突在 SSE 前返回 HTTP 409。成功原请求幂等重放；失败轮可显式重试最后同内容消息。
- Stop 接口绑定 threadId/runId。Web 等待服务端取消、落盘和通知队列释放后刷新历史；切换会话则取消原流。版本冲突恢复未接纳的草稿，不吞用户输入。
- 后台会话不装配 delegate_task/schedule/monitor，防止递归生成执行源；queued + running 上限 32，create/retry 都在 repository 串行更新内检查，HTTP 满额 429，工具返回受控拒绝。
- 监控投递按 monitor/notification ID 独立跟踪，不阻塞扫描；pending/在途期间不新抓取覆盖，单项失败不阻断其他监控；close 等待扫描与在途确认。
- 审批独立查询 pending（完整预览）、历史摘要和单项详情，工作台快照不再读取审批或返回 notifications。任务 kind 为 job/task；删除 plan/evidence/input/state/attempts/artifactIds、详情空集合、ideas/artifacts 等无实现占位字段，控制 target 必填。
- Web 消息、请求、事件类型均来自 schema；SSE 运行时同源校验，畸形事件及缺终态断流明确报错。token 是前端认证唯一事实，401 与跨标签变化会同步 React，错误密钥正常显示。
- provider/key 只在 bootstrap 初始化一次。Web service 返回结构化联合结果，pi 工具边界才序列化 JSON，监控不再解析工具文本。
- session 初始化只 mkdir，不隐式迁移平铺 JSONL；memory/tasks/jobs 坏条目整体拒绝，不再过滤或填补已有文档的缺字段。真实数据没有迁移或改写。
- 默认 CORS 包含 localhost/127.0.0.1 的 15173、17890 共四个 origin；mock 数据路径显式绝对解析，避免配置目录造成重复嵌套。

## 验证记录

- `pnpm typecheck`、`pnpm test`（252/252）、`pnpm build`、`pnpm --dir web build`、`git diff --check` 通过。依赖移除后重装成功；vue-demi 安装脚本显式禁用，与本项目只使用 Scalar 浏览器 bundle 的方式一致。
- 自动化覆盖 >1 MiB 真实 pi 用户历史后的 <1 KiB 增量请求、旧全量请求 400、陈旧版本 409、成功消息重复身份拒绝、重启幂等、迟到 Stop、断连取消、后台容量并发竞争、后台工具裁剪、监控忙会话隔离和失败补投、审批跨域隔离/完整预览/摘要、401 状态及非法 SSE。
- 编译入口独立进程使用自建临时 cwd/DATA_DIR：health=200，SIGTERM 自然 code 0；非法配置及损坏 monitors 自然 code 1，原文件字节不变。
- 自有 Web DEV + 隔离服务 + fake provider 实际验证：错误密钥、时间工具卡片、挂起轮 Stop 后立即下一轮、完整审批预览、批准写入、待审批 Stop 撤销、后台事实导致的 409 草稿恢复与手动重发。无前端未捕获错误。
- 真实模型使用现有模型配置的内存凭据、全新临时数据目录：Web 请求 currentTime 成功，中文回答与工具卡片正常，页面刷新恢复，控制台无 error/warn。本轮真实模型范围不扩展为所有工具/供应商故障场景已验证。
- 验收时既有 5173 开发服务占用中，未停止或改代理；隔离 DEV 另用 15173（fake）和 15174（真实模型），后端 18788/18789。本轮临时服务与文件均在验收后清理，这些端口不是接手时仍在运行的承诺。真实 `.personal-bot/`、OpenMuse 仓库及已有开发进程未作为测试对象。
- 提交前再次执行类型检查、252 项测试、服务端/Web 构建和差异检查，全部通过。最后的整理仅清理无效语句、重复类型声明、初始化条件分支和注释；未改变已验收的交互行为。

## 启动与联调

```sh
pnpm install --frozen-lockfile
pnpm dev
# 另一个终端；默认代理到 127.0.0.1:17890
pnpm --dir web dev
```

真实服务读取必需的 `.pi-muse/config.json`，实际端口以该文件或启动日志为准，不要在交接文档里复制模型凭据。**端口被占用时不会自动避让**：启动直接报错，错误信息包含占用进程的 PID（用 `lsof` 查），由用户决定是改 `server.port` 还是 `kill -15 <pid>` 释放端口；这避免了"启动时端口悄悄变了而 Vite 代理还在 17890"的同步错位。启动前检查端口监听，不要停止已有开发进程。

模拟联调用 `pnpm dev:mock`（17891）和 `API_TARGET=http://127.0.0.1:17891 pnpm --dir web dev`；其数据写入 `.pi-muse/mock`，不是自动化测试的隔离目录。自动化与临时页面验收仍必须使用自己创建的临时 DATA_DIR；不修改真实配置或数据。

端口选择说明：服务端默认 17890、mock 默认 17891、Web dev 默认 15173、Web preview 默认 14173，避开 nanobot(7890) 与 Vite(5173/4173) 的默认区间；host 默认 `0.0.0.0` 便于局域网访问，未设 `server.accessKey` 时启动会打印安全警告。

当前协议不接受旧客户端回传的 messages/state/tools/context/forwardedProps，也不提供 `/api/copilotkit/*`。前后端应一起使用当前代码。已有数据若不满足当前 reader 会明确失败；没有自动补字段或迁移，不能通过删文件来消除报错。

## 当前边界

保留 JSON、pi 历史权威、函数式工厂和显式依赖注入。无数据库、消息总线、durable execution、运行恢复或模型/工具自动重试；工具副作用不回滚。任务通知失败可查任务详情，不承诺崩溃后必达；文件 guard 不承诺抵御外部恶意进程竞争。

历史读取目前仍为全量展示投影，增量发送已解除请求体增长限制；分页和虚拟列表可按实际长会话体验另做，不维护第二份历史。

入口与约定见 `AGENTS.md`，职责和生命周期见 `docs/architecture.md`，接口见 `docs/http-api-contract.md` 与运行时 `/docs`，配置见 `docs/configuration.md`。
