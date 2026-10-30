# 测试与验收规范

本文是测试分层、回归补强、执行命令和验收证据的维护位置。新增功能、修复问题或修改代码前必读；架构接入见 [架构规范](architecture.md#新能力接入)，接口与工具报文交付见 [API 开发规范](api-development.md)。测试 Markdown 不替代 `src/http/contracts/` 与运行时 `/docs`。

## 隔离与授权

- 自动化测试与临时验收使用独立临时实例目录，不修改真实 `.pi-muse/`（含 config.json）数据或 OpenMuse 仓库；开发进程启停遵守 [工作区长期授权](../../AGENTS.md#14-开发服务进程授权)。`.pi-muse/mock` 是固定联调实例，不是测试临时目录。不撤销已有改动；模块收尾的本地提交遵守 [根规则](../../AGENTS.md#15-模块收尾与提交)，不自动 push。
- 所有测试必须真实连接后端，并真实调用外部大模型接口；不得使用 mock、fake provider 或拦截返回值替代。用户已长期授权本项目所有开发测试的真实模型费用，无需担心费用或逐次请示，不得以费用为由跳过。现存模拟测试不算满足本规则；live 不进入默认检查不等于可以跳过。
- 不新增 CI、GitHub Actions、远程定时或自动循环入口；真实调用授权不改变用户数据、凭据、审批与发布保护。
- 启动前核对端口与进程归属；确认是本项目开发服务时可按根规则协调重启，不停止生产、非本项目或归属不明的进程。测试服务、fixture、provider、定时器和临时目录均需在失败路径清理，SIGKILL 只能记为退出检查失败，不能冒充自然退出。

## 现存测试入口与局限

下表描述现有脚本实现，不是对新规则的例外授权。目前 unit/integration/E2E 中仍有模拟模型；运行这些旧脚本不能宣称已完成用户要求的测试。必须另外执行真实后端与外部大模型测试，不能仅修改文档就宣称现存脚本已迁移。

| 层 | 目录 | 入口 | 用途 | 模型 / 网络 |
| --- | --- | --- | --- | --- |
| 单元 | `tests/unit/` | `pnpm test` | 纯规则、适配边界、JSON 读写、subagent role、live CLI 等 | 不调用真实模型 |
| 集成 | `tests/integration/` | `pnpm test` | 真实 HTTP + pi + 工具 + 历史链路，架构/边界/契约/生命周期 | fake provider（本地 OpenAI SSE） |
| E2E | `tests/e2e/` | `pnpm test:e2e` | 真实 `dist/index.js` 进程，鉴权/审批/取消/隔离/启停 | fake provider（本地），不需外网 |
| live | `tests/live/` | `pnpm test:live`，显式 opt-in | 真实模型透明代理，核心工具链路与重启一致性 | 真实模型，需要外网与 token 费用 |
| 支撑 | `tests/support/` | 无独立测试入口 | fake provider、HTTP 客户端、dist 进程支架、透明模型代理 | 随使用方隔离 |

`tests/support/` 不是任何测试命令的入口；`tests/e2e/`、`tests/live/`、`tests/support/` 均不通过 `pnpm test` 触发。

## 必须为变更补回归测试

`pnpm check` 验证既有流程，不能代替新增/修改功能的回归测试。每次变更按以下最小集合补充，不以跑过旧测试声明本次回归完成。

| 变更 | 必须补充的覆盖 |
| --- | --- |
| 新能力 / 修复 bug | `tests/integration/` 的真实 HTTP/pi/工具/历史端到端覆盖；纯规则和边界入 `tests/unit/` |
| 新工具 / 新接口 | 在 `architecture.test.ts`、`boundaries.test.ts`、`response-contract.test.ts` 等集成测试补对应断言；`docs-contract.test.ts` 覆盖 `/docs`、`/openapi.json` 及关键行为说明 |
| 跨进程生命周期、真实 dist、provider 取消 | `tests/e2e/` 的实际进程/连接证据 |
| 启动 / 退出 / 隔离目录 / SIGTERM | 在 `tests/e2e/startup.test.ts` 已有 invalid-config / corrupt-document / occupied-port 三轴模式补对应列项，覆盖初始化失败清理与正常 SIGTERM |
| 鉴权 / token / SSE | 纳入 `tests/e2e/server.test.ts` 顶部固定场景集 |
| 真实模型适配、子代理、工具、审批或取消关键链路 | 在 `tests/live/run.ts` 场景集中补对应 scenario 与逐项 `[PASS]` / `[FAIL]` 输出，并显式真实验收 |
| 工具报文或客户端展示 | 自有 Web DEV 实际观察 renderer、历史刷新和错误态；新增/改名工具同样必须验证 |

- **断言依据**：实际工具调用与结果、文件内容、审批状态、HTTP 状态、SSE 事件、socket 关闭、messages/revision、重启后状态。按职责检查真实文件和状态，不依赖模型自述或自然语言快照。
- **不得替代**：不以 `console.log`、隐藏 stack、自然语言答案或快照对比作为通过证明；不能拿 fake provider、HTTP/schema 或旧版本验收冒充真实模型/页面验收，也不能用页面测试代替 HTTP/SSE 断言。
- **失败逐项记录**：任何场景 FAIL 必须按事实单条报告，不能汇总掩盖、合并断言或自动 retry 模型/工具凑通过。取消应检查终态与连接/副作用，不把 RUN_ERROR 当作普通执行成功。
- **完成状态**：未补相应回归的变更须标记「未完成回归」并说明阻塞；缺少凭据、服务不可用或页面环境不具备时明确写未验证，不以费用为由跳过。代码修改、自动化、真实模型和页面验收必须分别报告准确版本与范围。

## 命令与完成检查

```sh
pnpm typecheck                 # 仅类型检查
pnpm build                     # 服务端构建
pnpm test                      # unit + integration
pnpm test:e2e                  # 自动先 build，再串行执行真实 dist 进程套件
pnpm test:live --config <path> --allow-live [--keep-artifacts]  # 显式真实模型验收
node --import tsx tests/live/skill-authoring.ts --config <path> --allow-live --keep-artifacts
node --import tsx tests/live/information.ts --config <path> --allow-live [--keep-artifacts]
node --import tsx tests/live/news.ts --config <path> --allow-live [--keep-artifacts] [--allow-private-targets]
node --import tsx tests/live/space-tool-scope.ts --config <path> --allow-live
node --import tsx tests/live/space-prompt-scope.ts --config <path> --allow-live --scenario prompt
node --import tsx tests/live/space-prompt-scope.ts --config <path> --allow-live --scenario dream
node --import tsx tests/live/message-feedback.ts --allow-live --base-url <url> --token-file <path> --context-file <path> --phase record|verify
pnpm check                     # typecheck + test + test:e2e + Web build + diff 检查
```

`skill-authoring.ts` 单独启动隔离实例，验证技能及参考文件创建、默认关闭、启用后下一轮普通读取、修改、拒绝与 Stop。运行时必须逐次查看完整预览，并在终端输入审批决定；不写入所给配置对应的真实实例数据。

空间边界专项同样使用隔离后端与真实模型透明代理：`space-tool-scope.ts` 验证聊天工具的任务/监控列表与控制限于当前空间，全局 REST 管理仍可聚合；`space-prompt-scope.ts` 的 `prompt` 场景核对实际工具、能力说明、身份保留、目标按需读取和子会话裁剪，`dream` 场景核对局部规则、全局记忆、待决新增及其他空间原始内容不变。不支持保留临时实例，不自动重试模型；失败须保留原因，不能只以模型自然语言自述验收。

代码改动完成后运行 `pnpm check`，任一步失败都必须报告，不以跑过旧版本替代本次验证。仅文档改动可检查差异、引用和规则一致性，不必重复全量测试。真实模型和页面验收不包含在 `pnpm check` 中，按变更范围与授权另行执行。

### `pnpm test`

- 只跑 `tests/unit/*.test.ts` 与 `tests/integration/*.test.ts`，任一目录未发现测试直接失败；每项超时 60 秒。
- 集成测试仅模型是模拟的，HTTP / pi / 工具 / fs / 历史是实际链路，不伪造业务副作用。fake-model 常用触发词见本文末节，实际分支以源码为准。
- 测试配置必须满足 `model.maxTokens < model.contextWindow`；不合法时 createConfig/loadConfig 抛错。
- harness 初始化失败也必须回收所有已分配资源；配置/service/login 失败均需覆盖，防止 fake provider 遗留造成测试进程 hang。

### `pnpm test:e2e`

- 自动先 `pnpm build`，再用 `node:test/tsx` 串行执行 `tests/e2e/*.test.ts`，单项超时 90 秒。
- `tests/support/service-process.ts` 用 `mkdtemp` 创建临时 cwd / DATA_DIR、假 accessKey 与本地 fake provider，不读真实实例。启动断言 `health.serviceVersion.mode === "build"`，确认实际运行 `dist/index.js`。
- dist 不存在时支架直接报 `Missing dist/index.js; run pnpm build first`。正常 SIGTERM 必须自然 `code: 0`，超时 SIGKILL 标红并提示 `service required SIGKILL after SIGTERM`。
- 不依赖外网，不需要浏览器配合，不替代真实模型或自有 Web DEV 页面验收。固定范围见下节，测试数量以本次输出为准。

### `pnpm test:live`

- 必须同时给出 `--config` 与 `--allow-live`；允许参数开头一个 `--`，未知/重复参数、尾随多余参数和命令行密钥均拒绝，缺参数非零退出。
- 仅读显式配置的 `.model`（baseUrl、id、可选 apiKey、contextWindow、maxTokens），不引用其 runtime.dataDir、不复制完整配置。真实 key 仅驻留 `tests/support/live-model.ts` 透明代理内存，业务实例只用代理占位 key。
- DATA_DIR 使用临时空实例，服务仅监听 `127.0.0.1` 随机端口；正式 DATA_DIR、17890 服务、OpenMuse 和 watcher 都不是测试对象。关闭与异常均走 finally，回收 service / server / 慢 HTTP fixture / 代理 / 定时器 / 临时目录。
- 不由 `pnpm test`、`pnpm check`、CI 或远程定时隐式触发；主 Agent 按任务范围主动执行，使用用户已给出的长期费用授权，不重复请示。保留 `--config` 与 `--allow-live` 作为命令级防误触门禁；不做模型/工具自动 retry，不为验收修改 pi 底层。
- 默认 finally 清理；`--keep-artifacts` 保留合成测试 data 与脱敏 summary.json/traces，包含逐项结果、调用轨迹及版本身份，不保存真实配置、供应商鉴权头或 key。trace 落盘前将 key 替换为 `[REDACTED]`，上游失败仅返回受控 502，不返回供应商错误正文，不承诺保留任意错误 stack。
- 以透明代理记录的真实 tool call / result / 时序和 HTTP、文件系统、状态证据判断，不以自然语言自述通过。价格/速率限制不可控，任何 FAIL 单独记录，不凑 N/N。

### `tests/live/message-feedback.ts`

- 专项连接已运行的真实后端与外部模型；`--base-url`、`--token-file`、`--context-file` 与 `--allow-live` 必须显式给出，token 只进请求头且不输出。
- `--phase record` 创建独立空间并写入不含凭据的重启 context；主 Agent 重启后端后用同参数执行 `--phase verify` 验证持久化、后续真实模型、reset/delete 生命周期。失败不自动重试写入。

### `tests/live/information.ts`

- 专项启动隔离后端并经 `createLiveModel` 透明代理真实调用外部模型，不读取或修改正式 DATA_DIR。入口必须显式给出 `--config` 与 `--allow-live`，可追加 `--keep-artifacts` 保留脱敏证据。
- 覆盖混合批与全静默结构化提交、silent 不写聊天、通知发布与 notification/session/message 溯源、偏好 notes 与当前反馈例证进入下一轮、普通聊天只读 `information` 工具、幂等/冲突/跨空间隔离、自动调度、disable/reset/delete 取消排队通知以及重启持久化。
- 以后端 repository、PI 历史 revision/message、真实代理 tool call/result 与 HTTP 状态为证据；后台请求必须只声明 `submit_information_result`。同一 SDK 轮内允许无效提交后由模型自行纠正，但最终必须恰好一个有效提交；测试策略只约束合成数据，不用关键词代码替代模型决策，失败不自动重试模型。

### `tests/live/news.ts`

- 启动隔离后端并经真实透明代理调用外部模型，不读取正式实例或凭据；显式抓取真实公网 RSS2，不使用合成 feed 冒充真实验收。
- 覆盖源添加、重复 refresh 不重复接纳、cold start、结构化推荐与 reason、全部/推荐/收藏筛选、逐篇喜欢/不喜欢/评论/收藏、反馈进入下一轮模型输入与 learnedNotes、删除源保留文章和反馈、内部空间不出现在公开列表且主聊天 revision 不变、重启后源/文章/反馈/偏好恢复。
- 以真实 RSS HTTP、后端 repository/API 状态、真实代理 tool call/result 与重启回读为证据；失败不自动重试模型。纯解析、存储和路由边界可用合成 XML/本地 HTTP 另做聚焦回归，但不能替代本项真实公网与模型验收。
- `--allow-private-targets` 是 news live 脚本专属选项，默认 `false`，重复传入会拒绝。仅当本机 DNS 对公网域名返回 198.18 Fake-IP、需要在 loopback 隔离实例中抓取真实 RSS 时显式启用；共享 live options、生产配置和默认 SSRF 防护均不改变。输出必须如实说明该网络例外。

### `pnpm check`

顺序为 typecheck → test → test:e2e（含服务端 build）→ `pnpm --dir web build` → `git diff --check`，任一步非零即停；不包含 live，不自动产生真实模型费用。

### 已运行开发服务的 CORS 真实联调

运行 `node --import tsx tests/live/cors.ts --config .pi-muse/config.json --allow-live`，可追加 `--keep-artifacts` 保存脱敏汇总。该专项与上面的隔离实例 runner 不同：直接连接本机配置端口的已运行后端，读取 `server.port/accessKey` 与 `model.id`，不使用模型 key，不启动或修改服务。

执行前确认目标是使用真实外部模型、数据隔离的开发实例。脚本先完成一轮真实模型对话，再通过 REST 创建专用测试记忆，验证 PATCH 预检、修改落盘及未鉴权 401，最后通过 API 清理本轮记忆和空间；失败非零退出，不重试模型，不使用 fake provider。它验证 HTTP/CORS 协议，不冒充浏览器页面或原生 UI 验收。

## 稳定 E2E 覆盖范围

每次变更后实际执行，不能用历史验收替代当前结果；源码中的固定用例是执行事实，不在文档硬编码通过数量。

- **初始化失败清理**（`tests/e2e/startup.test.ts`）：invalid-config、corrupt-document、occupied-port 三类各自 code 1、不写坏文件、不留 scheduler 周期，25 秒内自然退出。
- **聊天鉴权与重启**（`tests/e2e/server.test.ts`）：错误 accessKey 为 401，health/OpenAPI 的版本身份一致，文档提供 Scalar；token、历史与消息关联重启不变。
- **工具流**：currentTime / memory / instructions 实际调用与历史/状态检查。
- **子代理 single / parallel / chain**：child 请求实际重叠，chain 第二步含上一步结果；子工具不含 bash/subagent/schedule/monitor/instructions/delegate_task；无 tasks.json、无子会话持久历史，关闭技能后不再触发。
- **approve / deny / cancel**：子代理文件审批绑定父 thread/run，approve 后字节一致，deny/cancel 不落盘；cancel 的父 SSE 为 RUN_ERROR，后续同 thread 可 RUN_FINISHED。
- **慢 Web 与子模型 Stop**：父 Stop 后 RUN_ERROR，provider 及真实 HTTP socket 关闭，不等待 transport 超时；稳定 E2E fixture 持续挂起，live 使用 55 秒慢 fixture，后续轮可用。
- **隔离与删除不复活**：shared 跨 thread 显式可读，私有标记不泄露；删除后 GET 空历史、迟到 Stop false、目录不存在。
- **工作区 SSE 与退出**：`/api/events` 首帧 ready；通知成功 append 后仅发布 `conversation_updated` 身份帧，取消/失败/幂等 noop 不发布；持有 SSE 时 SIGTERM 自然 code 0。
- **Activity 专项**（`tests/e2e/activity.test.ts`）：普通对话不登记、鉴权/只读查询无文件或 revision 副作用、显式登记与幂等重放、完成声明/最终交付保护、等待用户、Stop/断流/超时/优雅关闭/故意崩溃后的诚实状态及原活动继续；父/子审批、实际提交、拒绝/过期/冲突不写，子代理层级、安全隐藏、过滤/同时间游标/留存、删除不复活与损坏记录失败关闭。此层只模拟模型决策，不能称作自主分类真实验收。
- **旧队列不恢复**：`/api/agent/tasks` 不出现在文档且 POST 501，快照无 worker，不因测试或重启创建旧任务数据。
- **范围之外**：浏览器 UI、PWA 安装、移动端锁屏等不在本层；HTTP 版本断言或 fake provider 通过不是这些行为的验收。

## 自有 Web 页面验收

- 主要入口为仓库自有 Web DEV（默认 15173），后端使用隔离实例，按实际监听端口设置 `API_TARGET`；不要擅自改已有服务配置，开发进程启停按根规则授权执行。启动与代理用法见 [开发指南](development.md)。
- 涉及工具报文或展示时，实际查看对应 renderer、完整审批预览、刷新后历史恢复及错误态，不只抓 AG-UI 事件或验证 JSON。
- HTTP/SSE 变更还需按 [API 开发规范](api-development.md#每次接口变更的验收门槛)实际打开 `/docs` 确认接入说明可见；页面 200 或 schema 存在不算文档语义验收。
- 真实模型 + Web、fake provider + Web、服务端自动化分别记录，不用历史 OpenMuse/原生客户端记录替代当前自有 Web 验收。

## fake-model 常用触发词

实现为 `tests/support/fake-model.ts`。下表用于查找入口，不是模型行为或对外工具协议；工具分支要求本轮声明了对应工具、尚无工具结果，组合触发词有分支优先级，新增用例先核对源码。

| 输入 | 模拟行为 |
| --- | --- |
| 含 `时间/几点` | currentTime 工具轮，工具结果后生成 `time reply:` |
| 含 `读` | read 指定 txt/md/json 路径或 notes.txt；含 `敏感/secret` 改为越界 `/etc/passwd`；随后 `file reply:` |
| 含 `记住/忘掉` | memory 写入/忘记，随后 `memory reply:` |
| 含 `提醒我` | schedule 创建 15 秒后一次性任务，随后 `schedule reply:` |
| 以 `⏰` 开头 | 直接 `JOB-RAN ...`，用于定时 trigger |
| 含 `设定规则` | instructions 写本会话规则 |
| 含 `写入` / `改一下草稿` | write draft.md / edit marker；不绕过真实审批 |
| 含 `建个目标` | goal 创建带两个里程碑的目标 |
| 含 `子代理` | subagent；`只读子代理` 选 scout，否则 worker；写入/挂起/读取按分支传给子任务 |
| 精确 `fail-once` | 同一 fake provider 的首次返回 401；不代表生产自动重试 |
| 精确 `freeze` 或 `Task: freeze` | 挂起直到连接关闭 |
| 精确 `slow` / `disconnect` | 持续慢流；disconnect 用例由客户端中断，非 provider 主动断流 |
| 精确 `broken` | 输出 fragment 后破坏连接 |
| 含 `工具后失败/工具后挂起/工具后慢流` | 本轮工具已执行后最终模型 401 / 挂起 / 慢流；副作用不回滚 |
| 精确 `empty` / `malformed` | 空 choices / 畸形 SSE，由真实 pi 解析失败终态并释放会话 |
| system 含 `context summarization assistant` | 压缩请求返回短摘要，避免回显造成循环 |
| `E2E ...` / `Task: E2E ...` | 固定进程用例的单/并/链/时间/Web 编排，详见 fake-model 与 `tests/e2e/server.test.ts` |
