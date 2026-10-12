# 第二阶段：真实模型与 Web 补验

> 日期：2026-10-12（Asia/Shanghai）。当前交付范围：隔离 `DATA_DIR` 的真实模型、真实网关和 OpenMuse Web；不修改真实 `.env`、真实 `.personal-bot/` 或 OpenMuse 源仓库。Android 记录仅作为补充，不作为本阶段门槛。

## 1. 环境与方法

- 服务端使用最新构建产物 `dist/index.js`，真实模型为 `silicon/deepseek-ai/DeepSeek-V4-Flash`。
- 数据目录使用临时目录 `/tmp/personal-bot-phase2-close.8hI0EG`；验收结束后服务、代理和监听端口均已关闭。
- Web 使用 OpenMuse 现有开发服务，通过临时本地代理把 API 请求转到隔离服务；没有修改客户端代码。
- 浏览器为独立的 headless Chromium，页面入口 `localhost:8091` 与日常 `localhost:8081` 分离。检查的是实际 OpenMuse Web 页面，不是移动端或用户原浏览器会话。
- Android 使用隔离 AVD `personal-bot-phase2-api36`（Android 36 x86_64）和隔离 OpenMuse 副本；未启动或复用用户现有 AVD，未修改 OpenMuse 源仓库。
- Android Metro 使用端口 8092，客户端通过模拟器地址 `10.0.2.2:8797` 连接隔离 API，数据目录为 `/tmp/personal-bot-phase2-android-data.VwsL24`，访问密钥仅用于验收；重启后重新登录，不宣称登录态持久化已通过。
- 所有任务提示都带有唯一验收标记，避免把旧历史误认为本轮结果。
- 除对话创建的一次性任务外，其余重启/串行场景的任务在隔离服务停止时预置到临时 `jobs.json`，启动后由真实 scheduler 和模型执行；没有运行中改写业务文件，也没有修改系统时间。
- 跨午夜与长 daily 场景只推进隔离服务进程的受控时钟，模型请求仍走真实网关；没有调整系统时钟，也没有等待多个自然日。这与实际连续跨日运行的长测不同。

## 2. 已通过的真实验收

| 场景 | 结果 |
| --- | --- |
| 普通真实模型对话 | 通过。服务端返回 `RUN_FINISHED`，文本为 `PHASE2_REAL_READY`。 |
| 真实 `currentTime` 工具 | 通过。模型实际发起 `currentTime`，返回工具结果并完成第二轮。 |
| 对话创建一次性任务 | 通过。模型实际调用 `schedule` 创建任务。 |
| 一次性任务到点执行 | 通过。任务真实触发，结果 `PHASE2_CHAT_JOB_DONE` 写入会话历史，任务状态为 `succeeded`。 |
| Web 任务状态 | 通过。OpenMuse Activity 页面显示该任务为 `Succeeded`，不再把一次性成功误显示为取消。 |
| 重启后的过期一次性任务 | 通过。启动重算后状态为 `cancelled`，没有出现 `SHOULD_NOT_RUN_EXPIRED` 触发消息。这里的 `cancelled` 是“启动时停用过期任务”的兼容展示，不代表它曾执行后被用户取消。 |
| 重启后的每日任务 | 通过。启动时重算到未来的 `nextRunAt`，真实触发后推进到下一天，没有补跑停机期间的旧时刻。 |
| 同时到期的多个任务 | 通过。两个任务分别返回 `PHASE2_SERIAL_A_DONE`、`PHASE2_SERIAL_B_DONE`，按串行顺序进入历史，没有并发抢占主会话。 |
| 真实供应商 401 | 通过。直接向真实网关使用无效凭据得到 HTTP 401；服务端以脱敏 `RUN_ERROR` 结束，不向客户端泄露凭据或供应商细节。恢复有效配置后，下一轮返回 `PHASE2_AFTER_401_RECOVERED`。 |
| 工具写入后最终请求 401 | 通过。真实模型先完成 `memory` 写入，再由临时代理让第二次真实网关请求返回 401；错误明确说明不回滚，记忆仍可读到 `PHASE2_MEMORY_KEEP_401`。代理只用于稳定触发故障，不是伪造成功模型响应。 |
| 真实模型受控主动断流 | 通过。真实模型请求收到部分流后由本地代理主动断开，服务端返回脱敏 `RUN_ERROR`；同一进程下一轮正常完成，确认会话锁已释放。这里是“真实模型链路 + 代理故障注入”，不是供应商自然断流。 |
| 真实模型受控畸形 SSE | 通过。真实模型请求由本地代理返回非法 SSE/JSON，服务端返回脱敏 `RUN_ERROR`；同一进程下一轮正常完成，确认会话锁已释放。这里是“真实模型链路 + 代理故障注入”，不是供应商自然返回畸形数据。 |
| Web 停止长回复后换题 | 通过。OpenMuse Web 点击 `Stop reply` 后半截回复保留；随后发送全新话题，真实模型正常完成，实际内容没有延续上一轮“海边日落”话题。 |
| 长客户端轮与 daily 争锁 | 通过。受控时钟让客户端轮跨过午夜；daily 任务在客户端轮执行期间没有抢占，客户端轮结束后任务只执行一次。 |
| 长 daily 执行跨多个日程点 | 通过。任务执行期间跨过多个受控日期/日程点，没有重复执行；完成后按完成时间推进到下一次 daily 时间。 |
| Web 失败与取消展示 | 通过。Activity 页面实际显示失败一次性任务为 `Failed` / `Last run failed`，用户取消的 daily 任务为 `Cancelled`。 |
| Android development APK 构建 | 通过。隔离副本同时构建 `arm64-v8a` 和 `x86_64` Debug APK，ZIP 完整性与 APK v2 签名校验通过。 |
| Android 模拟器登录与聊天 | 通过。隔离 AVD 安装 x86_64 APK，使用隔离 API 完成访问密钥登录、真实模型对话，并收到 `PHASE2_ANDROID_OK`。 |
| Android 停止、换题与历史恢复 | 核心流程通过。长回复显示停止按钮并点击停止，pi 会话记录 `stopReason=aborted`；随后新话题返回 `PHASE2_ANDROID_AFT`，重启客户端并重新登录后历史仍可见。已知客户端问题：停止后界面显示 `Network request failed`，但实际取消成功且下一轮可继续。 |

## 3. 剩余限制与未覆盖范围

- 真实供应商自然主动断流和自然畸形 SSE：未验收。已完成的是通过本地代理注入故障的真实模型链路验收，不能等同于供应商自然故障。
- 原生客户端：暂不纳入第二阶段交付门槛。Android 隔离模拟器已有 smoke test 记录，iOS 因本机缺少完整 Xcode 未验收；真机、后台断线、生产签名包以及 Android Stop 提示均延期处理，不影响 Web 页面验收。

## 4. 自动验证与观察

- `pnpm typecheck`、`pnpm test`（135 项）、`pnpm build` 和 `git diff --check` 均通过。
- 没有修改生产代码；本轮只补验并更新进度文档，未 commit/push。
- 模型把时间工具返回的 `12:02:00 AM` 解释成了中文“12:02”，实际 ISO 时间对应北京时间 `00:02`。这是模型释义错误，工具原始结果和任务 ISO 时间正确；本轮未为此修改 pi 或工具。
- 受控断流后的恢复轮虽然返回 `RUN_FINISHED`，模型却追加了上一轮“春天”内容；这是本轮仍观察到的交互质量限制。Web Stop 后换题那次未复现，不能据此声称任何失败/取消之后都绝不延续旧话题，也不能把锁释放等同于回答内容完全符合要求。
- 临时代理未转发开发 WebSocket，页面出现过连接失败和现有 React Native Web 弃用警告；普通页面加载、历史恢复和 Activity 状态检查通过。这里不声称验证了 HMR。
- 临时进程 SIGTERM 退出正常；清理时代理因保活连接等待关闭，随后验收运行时被重置。Android API、Metro 和模拟器也已关闭；最终检查确认 8797/8799/8091/8092 无残留监听，日常 8787/8081 服务仍在。
- 关键证据摘要：代理报告记录了 `broken`、`malformed`、`401`、`tool401` 与后续正常请求；Web Activity 抓取到失败任务为 `Failed`、用户取消 daily 为 `Cancelled`；Android UI dump 记录停止后的 `Network request failed`、后续 `PHASE2_ANDROID_AFT` 和重启后的历史恢复，pi JSONL 记录 `PHASE2_ANDROID_OK`、长回复 `aborted` 与 `PHASE2_ANDROID_AFT`。原始证据保留在 `/tmp/personal-bot-phase2-close.8hI0EG/`、`/tmp/personal-bot-phase2-android-*.json` 和隔离 DATA_DIR 中。

## 5. 结论

第二阶段 P5A/P5B 的服务端和 Web 验收已完成：真实对话、工具、任务创建、任务触发、重启重算、多任务串行、坏流后的恢复、停止后换题、跨午夜争锁、长 daily、任务状态展示和真实 401 均有隔离证据。当前按“Web 页面跑通”作为交付标准，原生客户端不阻塞本阶段。仍不能把代理故障注入写成供应商自然故障。

实现仍保持原边界：没有修改 pi 底层、没有手写 agent loop、没有事务回滚、没有自动重试、没有 durable execution，也没有迁移数据目录。
