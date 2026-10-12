# 第二阶段：nanobot 行为对照与可靠性补齐

> 日期：2026-10-12。参考本机 `../nanobot`，commit `b0d28af3`。
> 状态：第二阶段服务端与 Web 验收已完成。按当前范围，OpenMuse Web 页面能正常使用即可，原生客户端暂不作为第二阶段交付门槛；Android/iOS 记录保留但延期处理。已按 nanobot 可兼容的行为完成调度竞态、工具副作用和 provider 故障矩阵补齐，并通过真实模型链路的受控坏流、停止后换题、跨午夜争锁、长 daily 和失败/取消展示验收；真实供应商自然坏流仍单独保留为环境相关的后续观察。

## 1. 不改变的边界

nanobot 作为产品行为参考，pi 作为执行内核。业务规则属于 `features/`，SDK 和协议差异属于对应 adapter。

- 不修改 pi SDK 源码、`node_modules` 或依赖补丁，不复制 nanobot 的 provider/agent loop。
- `createAgentSession` 负责模型执行和工具循环，pi SessionManager/JSONL 是唯一历史来源。
- 不引入恢复协调器、durable checkpoint、工具事务、自动重试或第二份上下文存储。
- 单进程、单用户、单会话，不引入 channel 投递、任务队列或 worker。
- memory 仍只在用户明确请求时写入；nanobot 的 Dream/记忆整理不属于本阶段。
- 不修改真实 `.env`、真实 DATA_DIR 或 OpenMuse 仓库，不自动 commit/push。

## 2. 五项验收说明的源码对照

### 2.1 工具写入成功后，最终回复超时

含义是“操作成功”和“最终解释成功”不是同一个事务：记忆已经保存或删除，即使后面的模型请求超时，也保留该操作。

当前实现：`src/features/memory/memory-service.ts` 完成 repository 写入后，memory 工具才返回；conversation 后续失败不回滚业务文件。

nanobot 的 `nanobot/agent/loop.py` 在显式停止时恢复部分上下文，并说明下一轮应能看到已经完成的工具结果。这支持保留操作事实，不支持一律删除失败轮的工具结果。

但不能声称 nanobot 存在与我们的 `memory(remember/forget)` 完全等价的工具：该基线的 `nanobot/agent/memory.py` 包含归档、checkpoint 与 Dream 记忆整理；记忆产品和权限不同，不照搬。

已完成的最小实现：

1. fake provider 覆盖 memory/schedule 工具完成后最终模型 401、超时，以及空 choices、畸形 SSE、主动断流。
2. 集成测试确认业务文件、pi 工具结果、SSE 错误、重启后历史和下一轮恢复；没有自动重试，也没有回滚已完成的工具写入。
3. 失败提示明确说明已发生的工具修改不会回滚，但不把只读工具结果误报成写入成功。

真实网关 401 已补验：真实模型完成 memory 写入后，通过临时代理仅把下一次请求的凭据改成无效值，真实网关返回 401；记忆和工具结果仍保留。真实模型链路的主动断流/畸形 SSE 也已通过临时代理注入并确认失败后下一轮恢复；这不是供应商自然故障的证明。实现不通过推迟写入、跨工具事务或自动补偿解决，也不新增语义去重规则。

### 2.2 停止长回复后，下一轮偶尔延续旧话题

已确认的事实：我们停止后保留部分 assistant 文本，自动测试验证 pi idle、锁释放及下一轮可执行，但未证明真实模型一定不延续旧话题。

nanobot 的 `nanobot/agent/loop.py` 区分显式停止和 gateway shutdown：前者保留可读部分上下文与工具结果，后者可保留 checkpoint 供恢复。`nanobot/session/recovery.py` 是副作用安全的持久化恢复系统，不是我们需要复制的“停止清理”。`nanobot/session/turn_continuation.py` 主要处理预算边界下持续目标的内部续轮，也不是停止后换话题的直接修复。

已完成的自动化与真实 Web 验证：

1. 普通文本生成停止、工具成功后停止：pi idle、锁释放、工具结果和历史保留，下一轮可以继续。
2. 已确认 pi 会在下一次请求前过滤 `error/aborted` assistant 消息；这与 nanobot 继续携带半截文本不同。
3. OpenMuse Web 实际点击 `Stop reply` 后，半截回复保留；随后发送全新话题，真实模型正常完成且未延续上一轮“海边日落”话题。

这个差异没有修改 pi，也没有另建历史或手写 agent loop。真实 Web 本轮观察到换题后未延续“海边日落”话题；这只说明本次轮次未复现，不把单次观察扩展成模型行为的绝对保证。

没有结构性证据就不删历史、不改写工具结果、不新增 checkpoint；也不为这个已知 pi 差异重造 agent loop。Web 这次观察只证明本次真实轮次未复现话题延续，不把它扩展成模型行为的绝对保证。

### 2.3 每日跨日、多任务争锁、重启重算

当前每日任务按服务端进程本地时区计算，`HH:mm` 不是手机所在地时区；执行结束后推进到下一次时刻。服务启动时按 nanobot 逻辑重算仍启用任务：daily 计算未来最近一次，一次性任务若已过期则关闭，不把停机期间错过的任务补发为新一轮。

nanobot 的 `nanobot/cron/service.py` 值得借鉴的是：调度独立于模型执行、每个候选任务执行前重新检查当前 enabled/时间、执行结果与后续调度分别记录。

按用户后续“nanobot 怎么做就怎么做”的决定，覆盖旧 P4 的重启补跑规则，现已按它的重启行为实现：`createJobService.reconcileOnStart()` 在 scheduler 启动前重算任务时间；一次性时间已经过去的任务关闭，daily 任务计算下一次未来时刻。nanobot 对过期一次性任务使用空 next_run_at；本项目在不改变现有 JSON 形状的前提下将其停用，保留原记录。这一展示兼容差异不影响“不补跑”的行为；没有修改 pi，也没有引入 durable execution。

本次已复现并修复：

- tick 重入：会话锁在 trigger 完成后释放，但 markRun 尚未完成，后续 tick 可再次读到同一到期任务。
- 过期扫描快照：任务 A 执行期间任务 B 被取消，旧 due 数组仍可执行 B。
- 未开始执行的 busy 不能消耗一次性任务；异步重读后也必须再次检查关闭状态和会话锁。

竞态修复在 `src/features/jobs/scheduler.ts`：一个进程内 `ticking` 标志覆盖完整 tick，每个候选执行前重读，不引入队列、持久化 claim 或文件格式变化。补存则由 `src/features/jobs/job-service.ts` 的 `markRun` 接收原完成时间，避免延后 daily 下一轮或覆盖实际完成时间。

`tests/integration/architecture.test.ts` 新增 6 项确定性回归：状态写入挂起、首次读取挂起、重读时关闭、重读时开始客户端轮次、同批后续任务取消、busy 不落失败状态。保留原有关闭时等待 trigger/markRun 的测试。

另外已按 nanobot `_store_dirty` 的安全原则处理状态落盘失败：只在内存保留同一次执行结果，后续 tick 优先补写 `markRun`，成功前不扫描其他任务，也不重跑模型；补写成功后下一次扫描才恢复派发。这个状态不跨进程持久化。

剩余边界：这不是 exactly-once。在途状态补存避免同一进程内重跑，但进程崩溃会丢失这份内存结果。重启按 nanobot 重算时间，不补跑过期一次性任务，也不会修复丢失的完成状态；daily 从未来一轮恢复。没有持久化恢复保证。本轮另以受控时钟验证了客户端长轮跨午夜不被 daily 抢占、长 daily 跨多个日程点不重复执行；这仍不改变单进程和无 durable execution 的边界。

P5B 自动化已完成：`tests/integration/jobs-scheduler.test.ts` 使用真实业务服务/JSON 存储与受控执行端口，验证跨午夜、长任务跳过已过时刻、多任务串行、单任务失败不阻塞后续、会话忙后只执行一次以及重启重算。`tests/unit/jobs.test.ts` 验证启动重算、无变化不落盘与损坏文件保护；现有 HTTP + pi + fake-provider 调度用例验证重启后不补跑过期一次性任务。

任务展示已修正：一次性任务完成后显示 succeeded，失败后显示 failed，不再把自动停用映射成 cancelled；取消每日调度仍显示 cancelled，并保留历史执行结果。展示映射有完整组合回归，不修改 OpenMuse 仓库或业务数据格式。真实模型/Web 已验证一次性任务成功展示、重启重算、每日触发和多任务串行；证据见 `docs/second-stage-acceptance.md`。

### 2.4 原生端验收状态

这不是已确认的服务端 bug。nanobot 的 channel 投递机制不能证明 OpenMuse 原生端正常。

Android 已在隔离 Android 36 x86_64 模拟器完成安装、登录、真实对话、流式展示、Stop、换题和重启后历史恢复的 smoke test；但点击 Stop 后客户端显示 `Network request failed`，实际取消已经成功，pi 记录为 `aborted`，下一轮也能完成。这是原生客户端提示问题，不修改 pi；真机、后台断线和生产签名包仍未覆盖。

iOS 仍需完整 Xcode、Simulator runtime 或实际设备才能验收。Web 优先保持不变；原生端单独检查局域网地址/访问密钥、流式展示、后台断线、Stop 和重新加载历史。不能用 HTTP 或 Web 成功代替原生端验收。遇到异常先定位网络、客户端生命周期、协议还是服务端问题，不直接调整 pi。

### 2.5 真实供应商 401、畸形 SSE 和主动断流

当前 fake provider 的覆盖要准确描述：

- `fail-once` 返回一次 401，集成测试检查失败、脱敏和人工重试恢复。
- `freeze` 挂起，验证超时。
- `disconnect` 仍是慢流，由测试客户端取消连接，不代表供应商主动断流；`broken` 才模拟供应商主动断流。
- `broken` 输出部分内容后 `res.destroy()`，模拟供应商断流；`empty` 与 `malformed` 已分别覆盖空 choices 和畸形 JSON/SSE。

因此“已有异常测试”不等于“完整故障矩阵已验收”，更不等于“真实供应商故障已验收”。

nanobot 的 `nanobot/providers/openai_compat_provider.py` 属于它的 provider 实现，只用于理解边界，不搬入本项目。我们继续由 pi 解析供应商响应，自己的 execution/conversation adapter 负责业务终态和诊断脱敏。

上述 fake-provider 故障矩阵已完成；真实网关 401、工具写入后最终 401 不回滚及恢复配置后的新轮已补验。真实模型链路的断流/畸形 SSE 已通过代理故障注入验证脱敏失败和同进程恢复，但不等于真实供应商自然故障证据。若真实 pi SDK 的公开行为不符合预期，先记录最小复现和限制，不通过手写流解析器/agent loop 绕过它。

## 3. 后续顺序与验收门槛

| 工作 | 当前状态 | 完成标准 |
| --- | --- | --- |
| 确认可借鉴行为与不可复制内核 | 完成 | 有本地源码证据，不用泛化结论代替 |
| 调度竞态最小修复 | 完成 | 6 项新增回归及原有生命周期测试通过 |
| P5A 中断、工具副作用和 provider 故障矩阵 | 完成 | 真实 pi + fake provider 的事实链、脱敏、工具副作用保留、真实网关 401，以及真实模型链路代理故障注入后的下一轮恢复 |
| P5B 调度剩余语义及任务展示 | 完成 | 自动化与真实模型链路均验证任务创建、触发、串行、重启重算和展示；跨午夜争锁与长 daily 另以受控进程时钟完成补验 |
| 隔离 DATA_DIR 的真实模型/Web 补验 | 服务端/Web 交付范围完成 | 证据、故障注入方法与残留限制记录在 `docs/second-stage-acceptance.md` |
| P5C 原生端 smoke test | 延期，不阻塞第二阶段 | 当前只要求 OpenMuse Web 页面跑通；原生客户端问题后续单独处理，不影响本阶段服务端交付 |
| P6 可信 Skills/本地资源 | 待设计 | 优先复用 pi ResourceLoader，独立明确来源、路径和权限；不开放脚本/shell |

下一步只保留环境可行时的真实供应商自然坏流观察；原生端验收和客户端提示修复延期，不阻塞第二阶段服务端/Web 交付，也不应促使我们修改 pi 底层或扩大权限。

## 4. 本轮验证记录

- P5A 验证记录：`pnpm typecheck && pnpm test && pnpm build && git diff --check` 全部通过；当时 124 项测试通过。
- P5B 补齐 11 项自动化用例：3 项启动重算/存储保护，5 项调度语义，3 项任务展示组合；`pnpm typecheck && pnpm test && pnpm build && git diff --check` 全部通过，当前共 135 项。完整链路调度用例同步更新为重启不补跑，并验证一次性执行成功展示。
- P5B 隔离 DATA_DIR 的编译进程检查通过：无模型配置时 health/session/SIGTERM 正常；jobs.json 损坏时启动及时失败、原文件字节不变。未读取 `.env`，子进程与临时目录均清理。
- 2026-10-11 补做隔离临时 DATA_DIR 的 mock 进程检查：health、POST session 登录正常，SIGTERM 后以 0 退出；端口占用、DATA_DIR 指向普通文件时均以非 0 退出，无初始化失败后挂起。
- 进程检查未读取 `.env`，未使用真实模型或用户数据；临时目录、子进程和监听均已清理，未干预日常联调服务。
- 2026-10-12 真实模型/Web 补验通过：普通对话、`currentTime`、一次性任务创建与触发、Web `Succeeded` 展示、重启后过期任务不补跑、每日任务重算/触发、多任务串行、真实网关 401 及恢复、工具写入后最终 401 不回滚。详见 `docs/second-stage-acceptance.md`。
- 2026-10-12 第二阶段收尾真实模型/Web 验收：代理注入的主动断流和畸形 SSE 均返回脱敏 `RUN_ERROR`，同进程下一轮恢复；Web Stop 后换题、跨午夜争锁、长 daily 跨多个日程点，以及 Activity 的失败/取消状态均已实际核对。代理故障注入不等于供应商自然故障。
- iOS 仍无验收证据：本机缺少完整 Xcode 和 Simulator；Android 已完成隔离模拟器 smoke test，但 Stop 后的 `Network request failed` 客户端提示尚未修复。不得把 Android smoke test 或 Web 结果扩展成完整移动端验收。
