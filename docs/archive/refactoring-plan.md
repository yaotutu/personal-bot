# Personal Bot 架构重构计划

> 日期：2026-10-11
> 状态：R0-R6 已实施并通过本地验证；R7A 已实施，R7B 保持条件性延期。
> 方向：模块化单体；以 `features/` 命名功能目录；函数式工厂与显式依赖组装。
> 范围：重构现有能力，不实现新功能，不扩大产品边界。

## 1. 目标与基线

### 1.1 重构要解决的问题

- `app.ts` 混合依赖初始化、HTTP、OpenMuse 展示数据和调度器。
- `conversation.ts` 混合执行协调、输入校验、历史投影和协议事件转换。
- `pi.ts` 混合 SDK 装配、工具、提示词和路径安全策略。
- memory/jobs 被挂在 conversation 上，调用者通过会话访问不相关能力。
- 存储规则、业务规则、prompt 渲染和客户端 DTO 没有充分隔离。
- 现有测试主要通过完整链路验证，缺少可独立验证的纯函数边界。

主要目标不是增加目录数量，而是缩小修改影响范围：

1. 新增工具不再把实现堆进 `pi.ts`。
2. 调整 OpenMuse 展示结构不影响会话执行。
3. 修改调度规则不需要修改 HTTP 应用。
4. 修改 memory/jobs 的存储不影响 HTTP 或 pi 工具。
5. 会话锁、取消和终态处理继续只有一个权威协调入口。

### 1.2 本轮核实的基线

2026-10-11 在当前仓库运行：

```sh
pnpm typecheck && pnpm test && pnpm build
```

基线结果：类型检查通过，33 项测试全部通过，构建通过。重构推进后当前共 104 项测试全部通过，typecheck/build 通过；测试脚本显式覆盖 `tests/unit/` 与 `tests/integration/`。测试采用真实 HTTP、真实 pi SDK 和 fake provider；本轮未重新执行真实模型 Web 验收。

开始制定计划时工作树无已有改动；计划阶段只新增本文档。随后按第一批实施 R0 + R1；没有改依赖、OpenMuse 或真实 `.personal-bot/` 数据。

### 1.3 不做什么

- 不引入微服务、多进程 worker、数据库、ORM、DI 框架、事件总线、CQRS。
- 不引入 durable execution、断点续跑或自动重试。
- 不重新实现 agent loop、工具执行器或 pi 会话持久化。
- 不实现 web fetch、MCP、审批、写文件、子代理等新功能。
- 不增加多用户、多会话或外部 channel；它们仍不在当前产品范围内。
- 不修改 OpenMuse 上游界面或扩大兼容 patch。
- 不为了“以后可能用到”创建空目录、通用框架或多套同义类型。

## 2. 不变量

以下内容在所有结构性步骤中保持不变：

| 边界 | 必须保持 |
| --- | --- |
| 产品 | 单模型、单会话 `local-main`、单用户、单进程单 DATA_DIR |
| 执行 | `createAgentSession` 是唯一执行内核，工具执行与会话持久化仍交给 pi |
| 工具 | `currentTime/memory/schedule/read/grep/find/ls`；不开放 bash/edit/write |
| 文件 | 工具只能访问 workspace；绝对路径、`../` 等越界拒绝不弱化 |
| 凭据 | 模型 key 只驻留配置和内存，不写日志、不回客户端、不进会话文件 |
| 错误 | 模型/工具错误默认脱敏；只有 guard 的受控拒绝文案可透传 |
| 历史 | pi JSONL/当前分支是权威来源；客户端不能覆盖或伪造模型历史 |
| 消息 | user/assistant/tool 的稳定 ID、工具关联和重启恢复保持不变 |
| 重试 | 完成请求去重；失败/取消后的同消息重试不重复 canonical user |
| 锁 | 客户端 run 和定时 trigger 共用协调器，不各自创建运行锁 |
| 协议 | HTTP 路径、状态码、DTO、SSE 事件及其顺序不随文件拆分改变 |
| 记忆 | 只显式写入；下一轮重读记忆和身份信息；不做自动提取 |
| 任务 | 保持到期扫描、忙时等待、重启补跑、一次性关闭和失败标记语义 |
| 兼容 | 定时轮仍无实时推送，旧历史冲突仍通过现有同步流程处理 |
| 鉴权 | 非回环监听必须设访问密钥；旧 token 的重启与密钥轮换行为不变 |

现有客户端 run 与 trigger 的生命周期并非完全一致。拆文件时先保留并测试这些差异，不能顺手更改 trigger 的超时、取消或清理语义。发现问题后单独提交行为修正及回归测试，不把新增策略伪装成纯重构。

## 3. 目标目录

这是职责地图，不是要求一次性创建所有文件。小文件可以暂时合并；出现独立职责或独立测试需求后再拆。

```text
src/
├── index.ts                         # 进程入口、启动 HTTP server、信号处理
├── bootstrap/
│   ├── create-service.ts            # 组装应用依赖和统一 close
│   └── types.ts                     # 容器与 HTTP 的实际依赖类型
├── config/
│   └── load-config.ts               # 配置解析与校验
├── features/
│   ├── conversation/
│   │   ├── conversation-service.ts # 锁、执行协调、取消、终态
│   │   ├── validate-input.ts        # canonical history、重试与冲突判断
│   │   ├── types.ts                 # 最小业务输入、输出、事件
│   │   ├── errors.ts                # 受控错误
│   │   └── ports.ts                 # 实际需要的执行/历史边界
│   ├── memory/
│   │   ├── memory-service.ts        # 显式记忆业务规则
│   │   ├── memory-prompt.ts         # 记忆渲染，不负责读写文件
│   │   └── types.ts                 # 当前类型/port 少，保持同文件
│   ├── identity/
│   │   ├── identity-service.ts      # 名字/语气设置，复用 memory repository
│   │   └── types.ts
│   └── jobs/
│       ├── job-service.ts           # 任务增删查、执行结果
│       ├── schedule-calculator.ts  # 时间计算纯函数
│       ├── scheduler.ts             # tick、运行和停止
│       ├── types.ts
│       └── ports.ts
├── adapters/
│   ├── pi/
│   │   ├── session-factory.ts       # model runtime、session 和 SDK 配置
│   │   ├── session-history.ts       # pi 分支、custom entries、context edits
│   │   ├── history-projection.ts    # pi branch 到最小内部历史/记录
│   │   ├── execution.ts             # 执行 port 与 SDK 事件/诊断边界
│   │   ├── system-prompt.ts         # prompt 组装
│   │   ├── resource-loader.ts       # 显式资源隔离
│   │   └── tools/
│   │       ├── index.ts             # 显式工具装配与 allowlist
│   │       ├── current-time.ts
│   │       ├── memory.ts
│   │       ├── schedule.ts
│   │       ├── files.ts
│   │       └── path-guard.ts
│   ├── ag-ui/
│   │   ├── agent.ts                 # AbstractAgent 适配
│   │   ├── runner.ts                # SSE 退订/stop
│   │   ├── routes.ts                # runtime 初始化、校验、挂载
│   │   └── events.ts                # 内部事件到 AG-UI
│   ├── openmuse/
│   │   ├── routes.ts                # 现有快照、memory、identity、history 接口
│   │   ├── schemas.ts               # 请求协议校验
│   │   └── presenters.ts            # job → task 等客户端展示转换
│   ├── auth/
│   │   └── token-service.ts
│   └── storage/
│       ├── data-layout.ts          # 保持旧路径，集中管理
│       ├── memory-repository.ts    # memory + identity 单文件权威存储
│       ├── job-repository.ts
│       ├── profile-files.ts        # SOUL/USER 文件读取
│       ├── document-schemas.ts     # 显式旧格式 reader 与损坏策略
│       └── json-document.ts        # 同目录原子替换
├── http/
│   └── app.ts                       # CORS/body limit、公开接口、鉴权、路由挂载
└── shared/                          # 仅放真实复用、与业务无关的基础函数
    └── serialized-writer.ts        # 有第二个使用点后抽取
```

两个刻意调整：

- pi 历史投影归 pi adapter，输出最小内部消息；形状已满足协议边界，没有另建只转发的 history mapper。事件协议转换归 AG-UI adapter，feature 不依赖 SDK/协议类型。
- `/api/workspace`、`/api/agent`、memory/identity/history 的现有 OpenMuse 契约统一归兼容 adapter；不同时在 `http/routes` 再建一套同义实现。HTTP 层只挂载它们。

`types.ts`、`ports.ts`、`errors.ts` 不要求每个 feature 标配。类型少时和实现同文件；不创建空壳目录或满是转发代码的 service。

## 4. 依赖与所有权

### 4.1 编译依赖和运行调用分开理解

```text
bootstrap ──组装──→ features + adapters + http
http / 协议 adapter / pi tool ──调用──→ feature service
feature service ──编译依赖──→ 自己需要的最小 port/type
具体 adapter ──实现──→ feature 声明的 port
```

feature 通过注入的函数调用 adapter，但不直接 import 具体 adapter。没有 DI 容器框架，只有显式 factory 调用。

规则：

1. feature 不直接 import Hono、AG-UI、pi SDK 或文件系统。
2. 不为完整 pi SDK 创建镜像接口；port 只描述实际使用的执行和历史能力。
3. 不重造 AG-UI 全部类型；仅在会话边界定义必要的输入、历史和事件结构。
4. 不为了可替换引擎改写 pi；本次继续只支持 pi。
5. config 的类型保留推导即可；clock/ID 注入只在有明确测试需求时加入。
6. 新能力默认归自己的 feature/adapter，不允许逐渐形成通用 `utils.ts` 大文件。

### 4.2 状态的唯一所有者

| 状态 | 所有者 |
| --- | --- |
| 主会话 active run/锁/取消原因 | ConversationService |
| pi SessionManager、分支、custom entry | pi history adapter |
| 记忆和 identity 设置 | 同一个 memory repository，保持 memory.json |
| SOUL/USER 文件 | profile-files adapter；每轮重读 |
| jobs JSON 与串行修改 | job repository |
| scheduler interval/tick 生命周期 | Scheduler |
| token 签名密钥 | auth adapter |
| SDK、服务实例、启动/关闭顺序 | bootstrap |

Identity 在业务上独立，但不能因为拆目录就创建第二个 memory.json writer。memory 与 identity 必须共享同一个 repository 实例和写入队列。

pi history adapter 只封装现有 SessionManager 操作；不维护第二份历史，不另写 JSONL，不把会话复制成业务数据库。

## 5. 实施顺序

主线：`R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7A`。

物理目录迁移 `R7B` 是最后的条件项，不阻塞主线完成；只有确实值得调整路径时实施。当前结构仍适用于单用户单会话，不因“看起来更整齐”引入复杂迁移系统。

每一步先移动/提取现有实现，再整理接口。结构改变和行为修正分开提交。阶段内可分多个小变更，不要求一个阶段对应一个巨大 commit；未经用户要求，不自动提交或推送。

### R0：固定基线和测试保护

- [x] 读取实际代码、已有计划、AGENTS 和 HANDOFF。
- [x] 检查工作树，运行 typecheck/test/build，记录 33 项通过。
- [x] 编写本计划。
- [x] 给现有 HTTP/SSE/历史语义建立检查清单。
- [x] 在测试 harness 的初始化路径也注册清理，防止 loadConfig/createApp 抛错留下 fake server。
- [x] 按后续拆分的风险补最少的 characterization tests，不为了凑覆盖率重写所有测试。

验收：旧测试不删除、不降低断言；初始化失败测试可退出；所有验证通过。

说明：harness 清理属于测试基础设施修正，独立于生产代码结构调整。

R0 已保护的契约清单（既有测试断言未删除或降低）：

- HTTP：health/session 公开；其他 API 先鉴权；CORS、413、400/401/409/501、快照字段保持。
- SSE：真实 HTTP + AG-UI SDK；各事件 schema、工具参数/结果、取消与终态保持。
- 历史：稳定 ID、重启恢复、已完成去重、失败重试、客户端伪造历史拒绝、压缩后的完整展示保持。
- 安全：workspace 越界拒绝、模型/工具错误脱敏、凭据不进入事件或 pi JSONL 保持。
- 能力：UI/工具记忆共用存储、身份每轮注入、一次性任务关闭和重启补跑保持。

### R1：建立组合入口与数据路径边界

- [x] 增加 `DataLayout`，原样返回现有数据路径，不迁移数据。
- [x] 增加 `createService(config)` 作为组合入口；不先造一组只有名称的抽象类型。
- [x] 集中创建 auth、memory、jobs、conversation 的实例；同一 store 不重复实例化。
- [x] conversation 改为接受依赖，移出它内部创建 memory/jobs 的职责。
- [x] HTTP 和 scheduler 从组合对象取服务，不再访问 `conversation.memory/jobs`。
- [x] 从 app 提取 scheduler，归 `features/jobs/scheduler.ts`；本阶段只移动，不改变调度算法。
- [x] `index.ts` 与 `scripts/dev-mock.ts` 统一调用组合入口。
- [x] 统一 close：停止接受调度工作、取消会话、清理 interval/订阅/session/server；保持幂等。
- [x] 兼容过渡期可保留旧 `createApp(config)` 转发入口，但唯一初始化路径只有一条。

验收：旧路径/JSON/auth key 不变；重启恢复与鉴权通过；创建 HTTP app 本身不隐式启动 scheduler；真实/mock 服务入口都能启动和关闭。

R1 验证记录（2026-10-11）：

- `pnpm typecheck && pnpm test && pnpm build`：44 项通过（原有 33 项 + 3 项初始化失败 + 8 项架构边界）。
- 隔离临时 DATA_DIR、清除模型配置后运行真实进程入口：health、SIGTERM 正常退出、占用端口失败退出通过。
- mock 入口：health、currentTime 工具 SSE、SIGTERM、占用端口及非法 PORT 配置失败退出通过。
- 新关闭流程只补生命周期：同步停表、取消会话、等待已发出的 tick 和 markRun；到期/忙时/补跑算法不变。
- 未使用真实 `.env` 或用户数据；未重新执行真实模型 Web 验收。

### R2：隔离业务能力和存储所有权

- [x] 将 memory 类型/业务规则移入 `features/memory/`。
- [x] 将 memory + identity 文件读写移入一个 repository。
- [x] 把记忆 prompt 渲染抽成纯函数，业务数据读取与渲染分离。
- [x] 将 identity 业务入口与 SOUL/USER 读取责任明确分开；不改变数据格式。
- [x] 将 jobs 类型和业务操作移入 `features/jobs/`；将 JSON 读写放入 job repository。
- [x] 提取 `nextRunAfter()`，接受明确参考时间，保持当前服务器本地时区语义。
- [x] pi 工具和 HTTP 调用 service，而不是直接调用存储对象。
- [x] 仅抽取 memory/jobs 真正重复的串行化 helper；不创建泛型 CRUD 框架。

验收：memory UI/工具 CRUD、500 条规则、identity 下一轮生效、每日推进、一次性关闭、重启补跑均保持。增加并发 memory/identity 修改不互相覆盖的测试。

R2 验证记录（2026-10-11）：typecheck/test/build 通过，63 项测试全部通过；新增 memory/identity 并发写、500 条上限、旧文件形状、纯 prompt 渲染与 jobs 时间/状态边界测试。jobs 单元测试同时在 `TZ=Asia/Shanghai` 和 `TZ=UTC` 下通过。未改数据格式或读取错误策略。

### R3：拆 pi 工具、prompt 与执行装配

- [x] 拆出 currentTime、memory、schedule、files 和 path guard。
- [x] 用普通函数显式装配工具；不使用目录扫描、插件注册中心或运行时自动发现。
- [x] 工具列表只定义一次，由注册结果得到当前显式 allowlist，防止两个名单漂移。
- [x] 拆出 system prompt 构建，保留每轮读取 SOUL/USER/记忆的行为。
- [x] 拆出 session factory，集中 provider 注册、内存 key、compaction 和 retry 配置。
- [x] 保持资源隔离，不发现 ~/.pi、父目录配置、skills、extensions。
- [x] 每个工具保留现有 name、参数 schema、description、结果格式和拒绝文案。
- [x] 为 path guard、prompt 构建、工具允许列表增加定向测试。

验收：原工具集、工具卡片、链式调用、文件边界、错误脱敏、压缩和身份注入全部通过。

发现基础 prompt 仍含旧能力描述等问题时，记录并作为独立 prompt 行为修正处理，不在文件移动里偷偷变更。

R3 验证记录（2026-10-11）：typecheck/build 通过；71 项业务/架构测试和 8 项 pi adapter 定向测试通过。工具 schema、顺序、拒绝文案和资源隔离保持；允许列表从显式注册结果得到。基础 prompt 仍有“无长期记忆/后台任务”的旧文案，本次刻意未改行为，后续作为独立 prompt 修正处理。

### R4：隔离 HTTP、AG-UI 和 OpenMuse

- [x] 把 OpenMuse 路由、校验 schema、job → task 等 presenter 移入兼容 adapter。
- [x] 把 PiAgent、runner 和 CopilotKit 挂载移入 AG-UI adapter。
- [x] HTTP app 只保留 middleware、公开 health/session、鉴权和 adapter 挂载。
- [x] 保持 health/session 在鉴权 middleware 之前，未知 `/api/*` 在鉴权之后。
- [x] 保持 body limit、CORS、输入校验、允许路径、501/409/400 文案。
- [x] 继续在动态导入 CopilotKit runtime 前关闭 telemetry。
- [x] 不新增第二套“自研 REST API”，不修改客户端 patch。

验收：现有 HTTP 契约测试、HttpAgent SDK 流式链路通过；OpenMuse DTO 的字段及映射不变；HTTP 层不包含任务执行或存储业务。

R4 验证记录（2026-10-11，阶段性记录）：OpenMuse routes/schemas/presenter 与 AG-UI agent/runner/routes 已从 HTTP app 移出；HTTP 契约、SSE、停止、鉴权和 501 边界保持。协议 adapter 定向测试 7 项通过，全量测试当时 78 项通过。未修改 OpenMuse 仓库。

### R5：拆会话协调，建立最小执行/历史 port

- [x] 提取 records/history 计算与输入校验，建立纯函数测试；保留 retry/dedup 规则。
- [x] 提取 pi-specific history 操作到 `adapters/pi/session-history.ts`：custom entries、context edits、checkpoint/branch/reset、buildSessionContext。
- [x] 提取 pi execution adapter，归一化 SDK 事件，并在 pi 持久化前清洗 assistant 诊断。
- [x] 提取 AG-UI 事件 projector，保留文本/工具事件顺序、缺失 start 补发和受控错误文案。
- [x] 用最小 execution/history port 替换 feature 对具体 SDK 的直接依赖；不复制整套 SDK 类型。
- [x] 保留一处 active run 权威状态；run/trigger 共用锁但保留入口差异。
- [x] 删除 conversation 对 memory/jobs 的公共暴露和具体 adapter import。

R5 验证记录（2026-10-11）：纯历史/记录/校验、事件时序、取消/锁/早停和完整 HTTP/pi 集成均通过；错误清洗发生在 pi 写入历史之前。未重写会话算法，也未改变 trigger 的既有生命周期差异。

### R6：测试结构、依赖检查与收尾清理

- [x] 测试迁移到 `tests/unit/`、`tests/integration/`、`tests/support/`。
- [x] `support` 复用 fake provider；主链路保留已验证的 harness，继续统一临时目录、HTTP/SSE 请求和失败清理，避免再造一套测试基础设施。
- [x] 保留真实 HTTP + pi 主链路，并按 feature/adapter/protocol/conversation 拆边界测试。
- [x] `pnpm test` 显式检查两个测试目录均有文件，再运行两个 glob；空目录会失败。
- [x] 验证 test timeout、资源清理和初始化失败不会被误报为成功。
- [x] 删除旧根级入口、临时重复类型和过渡 import；当前唯一生产组装入口是 `createService`。
- [x] 增加轻量静态依赖检查：feature 不 import 协议 SDK、文件系统或具体 adapter。
- [x] 增加新能力接入说明：feature service → pi tool/协议 adapter → bootstrap 显式装配。

验收：当前 `pnpm test` 共 104 项通过；`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。当前未自动提交或推送。

### R7A：持久化加固与错误策略

这是与纯结构重构分开的行为变更。为了保持既有用户数据可读，本阶段不引入 `schemaVersion`，也不改变 memory 对象和 jobs 裸数组格式。

- [x] 明确 legacy reader：memory 对象要求 `memories` 数组，jobs 要求裸数组；条目仍按旧 `id/text`、`id/prompt` 条件过滤。
- [x] 缺失文件返回初始化默认值；权限、I/O、JSON 或根形状损坏直接抛出受控错误。
- [x] 拒绝任何未知 `schemaVersion`，避免未来版本被静默当成空文档覆盖。
- [x] 写入使用同目录临时文件 + `rename`，临时文件 `0600`；保留 repository 内串行读改写队列。
- [x] 写入/序列化失败尽量清理本次临时文件并保留原始错误；不引入重试、fsync、跨进程锁或 durable execution。
- [x] 增加损坏文件保护、缺失默认、I/O 错误、原子写失败、writer 恢复、未知版本和原文件不变测试。
- [x] 文档明确：没有真实 DATA_DIR 在线迁移；如未来变更格式，必须先停服务并备份，再做一次性离线升级。

验收：当前存储格式不变，R7A 只改变“损坏不能静默覆盖”的错误策略。R7B 物理目录迁移不实施。

### R7B：物理数据目录调整（延期）

当前 `DataLayout` 已集中声明旧路径，继续保留 `.personal-bot/` 的 sessions、memory、jobs、workspace、agent 和 auth key 布局。除非未来有明确运维收益，否则不做物理迁移；不为一次目录调整设计 durable migration framework。

## 6. 验证矩阵

| 范围 | 必测内容 |
| --- | --- |
| 启动/关闭 | 真实/mock 入口、未配置模型、初始化失败清理、close 幂等、停止调度 |
| 鉴权 | loopback、非回环密钥、签名文件权限、重启 token、轮换失效 |
| HTTP | 原路径、DTO、middleware 顺序、CORS、413、400/401/409/501 |
| 会话 | 新消息、锁、停止、断流、超时、错误、去重、失败重试、重启 |
| 历史 | 稳定 ID、多段 assistant、toolCalls/tool result、context edit、compaction |
| 安全 | 越界输入、伪造客户端工具/历史、凭据不进入事件/日志/会话 |
| 记忆/身份 | UI 与工具写入、上限、下一轮注入、并发写、重启 |
| 任务 | 一次性、每日计算、忙时等待、到期补跑、执行失败、close |
| 存储升级 | legacy、未知版本、损坏、原子写失败、备份恢复（R7 才需要） |

每个结构阶段：

```sh
pnpm typecheck
pnpm test
pnpm build
```

集成测试只使用临时 DATA_DIR 和 fake provider。不得为了测试读取真实 `.env`、改真实用户数据或依赖真实模型可用性。

真实模型 Web 冒烟仍待独立补验，本次未执行：普通流式聊天、停止、工具卡片、刷新历史、记忆、定时提醒。沿用现有 Web 客户端；测试记忆/任务用专门验收数据，避免污染日常使用。

不能把 build/test 通过表述为“真实模型 Web 已验收”。

## 7. 风险与回退

| 风险 | 控制方式 |
| --- | --- |
| 拆分后实例化两套 store/锁 | bootstrap 唯一组装，明确状态所有者 |
| 身份与记忆并发写覆盖 | 共用 repository 实例和串行修改队列 |
| SSE 退订取消错误 run | 所有权参数保留，测试并发拒绝和断流 |
| 历史/context edit/checkpoint 改变 | 先 characterization tests，逐步提取，不重写算法 |
| DTO 中字段遗漏/中间件顺序变化 | 现有契约断言与公开/受保护接口测试 |
| mapper 只脱敏展示而泄漏持久化 | 在 SDK 持久化前清洗，检查 JSONL |
| 测试拆分后用例未运行 | 更新发现规则，验证数量和既有场景 |
| 数据格式升级不兼容旧代码 | 延后到 R7，升级前完整备份，回退恢复数据 |
| 物理目录影响 session/token | 条件项最后执行，恢复测试先于真实迁移 |
| 借重构扩大需求/过度抽象 | 不变量与非目标约束，新增行为独立提交 |

结构阶段不改数据格式：保留独立可验证变更，按正常版本控制方式回退对应代码即可。数据升级阶段：停止服务，同时恢复代码和升级前数据；不允许旧版本读取新版数据后静默写空。

开始每个阶段重新检查 git status；不覆盖用户变更，不自动 amend，不使用 destructive reset/checkout。

## 8. 执行节奏与委派

第一批：R0 剩余测试保护 + R1；不拆会话算法、不改 HTTP 契约、不迁移数据。

第二批：R2/R3/R4；完成业务、pi、客户端适配边界。

第三批：R5/R6；完成会话核心拆分、测试目录和依赖检查。

第四批：R7A；按实际需要决定是否执行 R7B。

架构决策、组合入口、会话协调和数据迁移由主 Agent 处理。仅将已定位且有独立写入范围的简单任务（单个工具提取、纯函数测试等）交给 Subagent，不为了并行拆关键路径，不把多个 Agent 放在同一个核心文件上。

## 9. 文档与完成定义

执行时随阶段更新本文档复选框，不提前宣称完成。同时更新：

- `AGENTS.md`：当前职责、入口、测试命令和边界。
- `README.md`：真实启动方式、功能状态、数据格式和升级说明。
- `docs/HANDOFF.md`：当前里程碑、验证结果、未完成工作。
- `docs/architecture.md`：在主要边界稳定后写最终架构，不复制一份随计划漂移的目录图。
- `docs/implementation-plan.md`：保留原功能实施历史，注明结构调整由本文档跟踪。

主线完成标准：

1. `features/`、`adapters/`、`http/`、`bootstrap/` 职责清晰，依赖无循环。
2. Conversation 不暴露 memory/jobs，不混入客户端 DTO 或具体 SDK 初始化。
3. HTTP app 不实现调度；pi session factory 不实现所有业务工具。
4. 状态和持久化只有一个权威所有者；pi 继续负责 agent loop 与 JSONL。
5. 既有核心用例仍全部运行，当前 104 项测试覆盖 R0-R7A 的 feature/adapter/协议/存储边界；typecheck/build 通过。
6. 诚实记录真实 Web 与原生端验收空缺，不把本地 mock 集成等同于 Web 验收。
7. 新能力只需自己的实现、适配器和一处显式装配，不必修改会话核心算法。
8. 不以行数衡量设计；文件变短但多出大量转发层，不算完成。
9. 存储格式保持不变，显式旧格式 reader/损坏保护/原子写经测试；恢复建议见 architecture.md；物理目录迁移不实施。

最终验证补充（2026-10-11）：104 项自动测试、typecheck/build/diff check 通过；隔离 DATA_DIR 的编译入口未配置模型和 mock 入口的 health/session/SIGTERM、占用端口清理、mock 工具 SSE 与非法配置清理通过。真实模型 Web 与原生端未重新验收。
