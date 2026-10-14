# Personal Bot 交接文档

> 更新日期：2026-10-12 ｜ 状态：产品 P1-P4 已完成；架构重构 R0-R6 与 R7A 已完成，R7B 延期；第一阶段 prompt 修正与真实模型 Web 核心复验已完成；第二阶段 P5A/P5B 服务端与 Web 验收已完成；当前配置入口已改为必需 config.json，Web Search/Fetch 已实现。当前以 OpenMuse Web 页面跑通为准，原生客户端暂不作为交付门槛。

## 1. 项目一句话

基于 pi 的单模型、单会话、单用户个人助手服务端，对接 OpenMuse Web 优先；当前目标是保持小型模块化单体，不做多 channel、多用户或多会话。

## 2. 当前验证状态

已完成并通过：

- `pnpm typecheck`
- `pnpm test`：176 项通过，测试显式覆盖 `tests/unit/` 与 `tests/integration/`
- `pnpm build`
- `git diff --check`
- 测试包含真实 HTTP、真实 pi SDK、fake provider、SSE、历史、鉴权、取消、重试、调度、并发写、配置文件、Web 工具和初始化失败清理。
- 配置入口为必需 `.personal-bot/config.json`：常规配置和模型 key 直接写入 JSON，无环境变量回退或插值；详见 `docs/configuration.md`。已用隔离临时配置完成编译入口 health/SIGTERM 冒烟，并确认缺失 config.json 时快速失败。
- Web Search/Fetch 已完成：`search_web` 优先 DuckDuckGo、challenge 时 Bing RSS 兜底；`web_fetch` 安全抓取公网 HTTP(S) 并提取 Markdown/text。DNS 校验并固定公网 IP，重定向逐跳校验，限制响应大小与超时；外部内容标记不可信。真实 transport 已直接验证 OpenAI 搜索结果和 example.com 抓取。
- OpenMuse 兼容修正：搜索工具已从 nanobot 语义的 `web_search` 调整为客户端专用 renderer 认可的 `search_web`，并返回 `{results,warnings,truncated}` JSON；新搜索在 Web DEV 页面显示为 “Found N sources” 卡片。历史里的旧 `web_search` 仍会按通配卡片展示，不改写既有会话。后续工具必须同时核对 nanobot 核心行为与 OpenMuse 工具名/结果 schema。
- 实时天气 `get_weather` 已完成：Open-Meteo Geocoding + Forecast、无需密钥、默认城市可在 config 配置（当前真实配置为上海），返回当前天气与今日概要；复用公网 HTTP 安全边界。真实模型 HTTP 与 OpenMuse Web DEV 已验证。OpenMuse 暂无天气专用 renderer，因此显示为通配只读卡片，内容为紧凑天气摘要。
- 2026-10-12 已完成真实配置迁移：旧 `.env` 删除，模型配置与 key 移入 gitignored、`0600` 的 `.personal-bot/config.json`；服务已用新配置重启。完整自动化验证、真实模型 HTTP、currentTime、memory 写入/清理、OpenMuse Web 聊天、服务重启与历史恢复均通过。
- 2026-10-12 已加入服务端工具展示策略：`tools.presentation` 默认 `hidden`，可按工具覆盖 `summary`；实时 AG-UI 与 GET/replay 历史统一过滤，完整结果仍留在模型/pi 权威历史，未修改 OpenMuse 客户端。专项 unit/integration 已覆盖隐藏卡片、搜索 schema、刷新/重启与 canonical 历史隔离。
- 2026-10-12 已补齐 OpenMuse Activity 定时任务详情闭环：`GET /api/agent/tasks/:id` 返回真实任务/最近事实时间线，控制 POST 支持 pause/resume/cancel/retry；暂停/取消不回滚副作用，retry 仅用户显式触发，未引入第二套历史或自动重试。OpenMuse Web 已实际打开正式喝水任务详情，原 501 消失；Workspace timeline 仍为空，因为 actions/activity 审批体系未开放。
- 隔离 DATA_DIR 的进程检查通过：编译入口未配置模型时 health/session/SIGTERM；mock health/session/currentTime SSE/SIGTERM；占用端口和非法配置失败后退出。
- 第一阶段：基础 prompt 修正，真实模型 HTTP/OpenMuse Web 核心复验通过（流式、停止/刷新、时间/文件工具、记忆、定时执行、重启历史）；发生过一次实际超时并验证新轮恢复。范围和证据见 `docs/archive/first-stage-acceptance.md`。
- 第二阶段第一轮：复现并修复 scheduler 在 `trigger` 完成但 `markRun` 未落盘时的重复执行，以及任务取消后旧 due 快照仍执行的问题；新增 6 项架构回归测试，未修改 pi、数据格式或 OpenMuse。
- 第二阶段 P5B 自动化：按用户“nanobot 怎么做就怎么做”的决定，启动时重算 daily 日程，过期一次性任务不补跑（覆盖旧 P4 的补跑行为）；保留任务记录且不改变 JSON 格式。一次性成功/失败不再展示为 cancelled。补齐跨日、长任务、多任务串行、正常重启、无改动不落盘及损坏文档保护测试。
- 第二阶段 P5A 自动化：借鉴 nanobot 的副作用保留与状态失败补存，保留本项目的“模型/工具不自动重试”约束；新增工具后 401/超时、空 choices、畸形 SSE、主动断流和工具后停止测试，确认工具写入可在最终模型失败后保留，失败后锁释放且下一轮可继续。
- 第二阶段真实模型/Web 补验：隔离临时数据目录中已验证真实对话、`currentTime`、任务创建与到点执行、一次性任务 `succeeded` 展示、重启后过期一次性任务不补跑、每日任务重算与真实触发、多个到期任务串行、真实网关 401 脱敏与恢复，以及真实工具写入后最终 401 不回滚。完整证据见 `docs/archive/second-stage-acceptance.md`。
- 第二阶段收尾真实模型/Web 补验：通过代理故障注入验证真实模型链路的主动断流和畸形 SSE 以脱敏 `RUN_ERROR` 结束且下一轮恢复；Web 实际验证 Stop 后换题、客户端长轮跨午夜与 daily 争锁、长 daily 跨多个日程点不重复，以及 Activity 的失败/取消展示。代理注入不等于供应商自然故障。
- 已确认的 pi 边界：停止后的半截 assistant 文本保留在展示历史，但 pi 会在下一次 provider 请求前过滤 `error/aborted` assistant；未为追求 nanobot 完全一致而修改 pi 底层。
- 第二阶段收尾补验：隔离临时数据的 mock health/session 登录与 SIGTERM 正常；端口占用和 DATA_DIR 为普通文件时初始化失败后及时退出，未遗留进程。本项不替代真实模型/Web 验收。

未做或不应误称为已完成：

- 真实模型/Web 补验已覆盖第二阶段服务端交付范围；仍不能把代理故障注入称为供应商自然故障，也不能把一次 Web 观察扩展成模型行为绝对保证。具体证据和边界见 `docs/archive/second-stage-acceptance.md`。
- 原生客户端暂不纳入当前交付门槛。Android 隔离模拟器已有核心 smoke test 记录；iOS 因本机缺少完整 Xcode 未验收。真机、后台断线、生产签名包和 Android Stop 提示均延期处理，不影响 Web 页面跑通与服务端交付。
- 未修改 OpenMuse 仓库，也未执行数据目录迁移。
- 未自动 commit 或 push。

既有产品能力与验收记录（重构前，非本轮复验；P5B 重启策略更新另见上方）：

| 能力 | 状态 | 验收 |
| --- | --- | --- |
| 文本对话闭环（P1） | ✅ | 流式/历史/停止/断流/超时/去重，Web 全验 |
| 只读工具 currentTime + 文件工具 read/grep/find/ls（P2） | ✅ | 路径边界防护，真实模型 find→read 链式实测 |
| 会话压缩（P2.5） | ✅ | 比例收缩参数防小窗口死循环，测试覆盖 |
| 身份注入 SOUL/USER（P3 第一步） | ✅ | 改文件下一轮生效 |
| 长期记忆 CRUD + 注入 + Apps 界面（P3） | ✅ | 界面添加→模型引用，对话式记住/忘掉 |
| 定时任务：对话创建→调度→结果进聊天流（P4） | ✅ | 90 秒提醒实测；一次性任务执行结果展示；重启不补跑过期一次性任务 |

历史功能提交链（本轮重构未提交）：

```
db9da64 P4 定时任务：对话式创建 + 调度器 + 结果进聊天流 + 重启补跑
7bd2bc2 P3 长期记忆与身份设置：显式记忆 CRUD + 注入 + OpenMuse 界面点亮
8ebdac1 开启会话压缩 + P3 第一步：SOUL/USER 身份注入
610a3be 开放 pi 内置只读文件工具：read/grep/find/ls + 路径边界防护
49d66d0 客户端兼容层最小化：撤回 textOnly，OpenMuse fork 压缩为 2 文件 patch
7bf5dc1 初始基线：P1 纯文本闭环 + P2 最小工具闭环（currentTime）
```

## 3. 当前架构

```text
src/
├── bootstrap/              # 唯一运行时组装入口与依赖容器
├── config/                 # 配置解析、校验
├── features/               # 业务规则：conversation、memory、identity、jobs
├── adapters/               # pi、AG-UI、OpenMuse、auth、storage 适配
├── http/                   # Hono middleware 和协议挂载，不拥有调度器
└── shared/                 # 少量真正复用的基础能力
```

关键文件：

- `src/bootstrap/create-service.ts`：创建唯一的 auth、memory/identity、jobs、conversation、scheduler，并提供幂等 `close()`。
- `src/features/conversation/conversation-service.ts`：唯一 active run、客户端轮/定时轮共锁、取消、超时、重试和终态。
- `src/adapters/pi/session-history.ts`：pi SessionManager、custom entry、context edit、checkpoint/branch/reset；pi JSONL 是历史权威来源。
- `src/adapters/pi/execution.ts`：pi session 执行边界；SDK 事件归一化，assistant 诊断在 pi 持久化前脱敏。
- `src/adapters/ag-ui/events.ts`：内部事件到 AG-UI 的单轮投影，保证工具 start/args/end/result 顺序与 ID 关联。
- `src/adapters/storage/memory-repository.ts`：memory 与 identity 共用一个 repository 和串行读改写队列。
- `src/adapters/storage/job-repository.ts`：jobs 裸数组读写和队列。
- `src/adapters/storage/document-schemas.ts`、`json-document.ts`：旧 JSON 格式显式读取与原子写入。
- `src/config/load-config.ts`：必需 JSON 配置文件、直接凭据与启动前校验。
- `src/features/web/web-service.ts`、`src/adapters/web/http-transport.ts`：Web 搜索/抓取业务投影与安全传输。
- `src/adapters/pi/tools/web.ts`：`search_web` / `web_fetch` 工具装配。
- `src/features/weather/weather-service.ts`、`src/adapters/weather/open-meteo.ts`、`src/adapters/pi/tools/weather.ts`：实时天气服务、供应商适配和工具装配。
- `src/http/app.ts`：CORS、body limit、health/session、鉴权、OpenMuse 兼容路由和 AG-UI 路由。

## 4. 数据与安全边界

- 继续使用 `.personal-bot/` 旧布局：`config.json`、`sessions/`、`memory.json`、`jobs.json`、`workspace/`、`SOUL.md`、`USER.md`、`agent/`、`auth.key`。
- 本次没有引入 `schemaVersion`，没有改变 memory 对象或 jobs 裸数组格式，也没有迁移真实数据。
- 缺失 JSON 文件可以使用空默认值；JSON 损坏、根形状错误、未知版本字段和其他文件系统错误会失败，绝不静默覆盖为新空文档。
- JSON 写入先创建同目录 `0600` 临时文件，再 `rename` 替换目标；不做 fsync、重试、跨进程锁或 durable execution。
- 模型 key 只驻留受保护的 `.personal-bot/config.json` 与服务端内存；工具只允许 `DATA_DIR/workspace`，bash/edit/write 不开放。

## 5. 开发与测试

```sh
pnpm dev        # 真实模型，默认 127.0.0.1:8787，读取必需 config.json
pnpm dev:mock   # fake provider，默认 127.0.0.1:8788，不读取正式 config.json
pnpm test
pnpm typecheck && pnpm build
```

OpenMuse Web 在另一个仓库运行：

```sh
EXPO_PUBLIC_API_URL=http://localhost:8787 pnpm dev:web
```

测试 fake provider 在 `tests/support/fake-model.ts`，不要重新发明另一套 harness；测试数据必须使用临时 DATA_DIR，不读取真实 config.json 或用户数据。

### 联调环境（第一阶段已确认运行状态）

- 真实模型：局域网网关 `http://192.168.55.222:20128/v1`，模型 ID
  `silicon/deepseek-ai/DeepSeek-V4-Flash`（注意：`ds/` 前缀路由在网关上无凭据，
  会报 model_not_found；以 `/v1/models` 实际列表为准）。配置在本地 `.personal-bot/config.json`（gitignore，含敏感 key）。
- 联调常驻：服务端 `pnpm dev`（8787，tsx watch），OpenMuse Web
  `EXPO_PUBLIC_API_URL=http://localhost:8787 pnpm dev:web`（8081）。第一阶段复验时二者均运行；未停止或修改这些日常服务。
- OpenMuse 仓库：`~/Desktop/code/openmuse`，是 git 仓库；我们的改动在
  `packages/domain/src/index.ts` 与 `apps/mobile/src/chat.tsx`（diff 由 patch 跟随），
  其余 dirty 文件属于用户自己，勿动勿提交。

### 历史踩坑记录

1. **pi 的 cwd 不是沙箱**：内置工具接受绝对路径与 `../`；必须 guardTool 强制边界。
2. **pi 默认压缩参数只适合大窗口**：reserveTokens=16384 在小 contextWindow 下阈值为负，
   压缩死循环；按窗口比例收缩。
3. **deepseek-flash 会省略工具参数**：schedule 工具曾连续 8 次缺 `prompt`；schema 必填 +
   描述显式强调后遵循。模型偶尔偷懒不调工具（引用历史旧时间），明确要求即可。
4. **fake-model 的分支必须在 event 函数定义之后**，否则 TDZ 让请求挂起（测试静默 hang）。
5. **初始化失败曾遗留 fake provider 导致测试 hang**：R0 已修复，配置/service/login 失败都有清理回归测试。MAX_TOKENS 仍必须小于 CONTEXT_WINDOW。
6. **pi-durable 已评估并否决**：spike 在 `~/Desktop/code/pi-durable-spike`。卖点真实
   （崩溃恢复语义正确）但太不成熟（静默失败、错误无堆栈、文档失真）；用户定论"崩了重跑"，
   不引入任何 durable 框架。
7. **zsh noclobber**：覆盖重定向用 `>|`。

## 6. 后续工作建议

1. 如果继续扩展能力，新增业务规则放到对应 `features/`，pi 工具放到 `adapters/pi/tools/`，协议展示放到对应 adapter，最后在 `bootstrap/create-service.ts` 显式装配。
2. 不把新能力直接塞进 conversation、HTTP app 或 session factory；不创建全局 `utils.ts`、事件总线、DI 容器或空壳抽象。
3. 新增写文件、web fetch、MCP、子代理等能力前，分别设计权限和错误边界，不顺手放宽现有 allowlist。
4. 若未来必须改 JSON 格式，先停服务并备份 `.personal-bot/`，做一次性离线迁移和回滚说明；不要在运行中双写。
5. 第一阶段核心 Web 复验、P5A/P5B 故障矩阵与调度/展示自动化，以及第二阶段服务端/Web 补验已完成；当前以 OpenMuse Web 页面跑通为交付标准，原生客户端暂不阻塞，供应商自然坏流仍未观察。准确范围见 `docs/archive/second-stage-acceptance.md`；不引入自动重试。

## 7. 参考文档

- `AGENTS.md`：项目硬边界、目录职责、fake-model 触发词和数据目录。
- `docs/archive/refactoring-plan.md`：R0-R7A 实施记录和后续约束。
- `docs/architecture.md`：当前职责、状态所有权、持久化策略与新能力接入。
- `docs/archive/first-stage-acceptance.md`：第一阶段真实验收、隔离环境、已通过与未覆盖项。
- `docs/archive/second-stage-plan.md`：nanobot 行为对照、第二阶段实施边界、已修复调度竞态和剩余验收顺序。
- `docs/archive/second-stage-acceptance.md`：第二阶段真实模型/Web 补验证据、故障注入方式和未覆盖范围。
- `README.md`：启动、联调、安全和验证状态。
- `docs/archive/implementation-plan.md`：原始 P1-P4 功能实施历史。
- `docs/openmuse-api-contract.md`：客户端接口契约。
- `docs/pi-reuse.md`：pi 复用边界。
