# Activity 专项 E2E 补全与验收记录

日期：2026-10-19。分支：`feat/activity-records`；独立 worktree：`pi-muse-activity`，基于 `e6b3639b42fac0e27618fb2d61caec6887100948`，未提交、未合并、未推送。

## 本次纠正

前一轮只运行了既有 11 项真实进程 E2E，它们并未断言 `/api/activities`，不能作为 Activity 专项 E2E 证据；此前“完整验收”的表述不成立。本次新增 `tests/e2e/activity.test.ts`，自动纳入 `pnpm test:e2e` 与 `pnpm check`，不新增 CI 或远程执行入口。

## 专项覆盖

本次新增 26 项 Activity 真实 `dist/index.js` 进程 E2E：

- Bearer 鉴权、普通对话与单纯调用工具不登记；查询不修改历史 revision、JSONL 字节或 mtime，不创建不存在的来源。
- 登记去重、真实工具 callId 与步骤 ID 对应、成功 run 幂等重放、token/活动/步骤跨进程重启保持。
- 未声明完成、complete 后继续工具、最终无文本交付、等待用户；完成声明后 Stop 或模型失败不能变成 completed。
- Stop 关闭真实 provider socket、普通下一轮不自动绑定活动、显式 resume 沿用原 ID 并保留旧步骤。
- 超时、客户端断流、SIGTERM 自然关闭、专门注入的 SIGKILL 崩溃；重启不重跑模型，恢复后保留旧中断步骤。SIGKILL 仅用于故意崩溃测试，不当作优雅退出证据。
- 父会话文件审批 approve / deny / expire / cancel / conflict；完整预览仍在审批，Activity 步骤不复制文件路径或正文。批准与真实提交分别断言，拒绝、过期、取消不写，版本冲突不覆盖外部内容。
- 并行子代理真实模型/工具步骤嵌套，子模型无 activity/bash/subagent 权限；子代理文件审批 approve / cancel 与父活动关联，磁盘结果真实核对。
- hidden 工具仅保留安全执行事实，不暴露工具名、参数或文件内容；跨会话及已完成活动不能 resume；不存在 HTTP Activity 写入口。
- 列表分页、过滤、非法/重复参数 400、过滤绑定游标、同毫秒 ID 全序、超过七天的活动不清理；删除后 404、新同名会话不复活旧记录、shared 保留。
- 删除执行中会话取消 provider 且迟到 Stop/查询/重启不复活；损坏 Activity custom entry 查询 500，不静默过滤或改写。

排序/七天留存边界在服务停止时仅修改真实 JSONL 的创建时间，随后重开进程验证；不伪造工具、副作用或生命周期记录。

## E2E 发现并修复的问题

1. 审批步骤原先错误挂到 execution 根节点，没有关联实际 write/edit 调用。现将会话前缀及 toolCallId 传到审批观察端口，主/子审批均关联对应工具步骤。
2. 审批步骤标题原先复制了文件路径。现只保存通用安全标题，完整文件预览仍在审批能力中。
3. 崩溃后 resume 时，旧步骤会因新 run 活跃重新显示 running。现逐步按自身 runId 判断是否中断；新 run 不复活旧步骤，无法确认的结束时刻保持 null，并同步生成契约描述。

首次新增 E2E 22 项中 5 个审批场景失败，定位并修复后 22/22 通过；随后扩充到 26 项，并补崩溃恢复旧步骤断言，最终以完整检查结果为准。

## 自动化验证

补齐专项 E2E 阶段的业务代码版本：`sourceHash=3d06665c0f5fcdd9fc5e97e2c3d11df3d8ec1f9990119508134b1f802e9e7583`（dirty=true；源码与构建版共用同一代码散列，mode 不同）。测试与 Markdown 不包含在服务源码散列中；提交前整理后的版本与重验见下文，不将本节结果替代最新结果。

- `pnpm check`：类型检查、417 项 unit/integration、37 项进程 E2E（26 项 Activity＋11 项既有）、服务端构建、Web 构建、`git diff --check`。
- 本轮同时新增 6 项生成文档语义防漂移测试，`docs-contract.test.ts` 共 14 项；核对实际 operation/参数/schema 与真实 HTTP，而非整份 spec 字符串。
- 最终完整运行退出码为 0：417/417 unit/integration、37/37 真实进程 E2E、前后端构建与差异检查全部通过。运行日志：`/Users/yaotutu/.zcode/cli/exec/sess_f3279f68-ece1-437e-af24-b8046a161387/call_d1c6a4cc43994d0dbbcc84081d879f51-stdout.log`。

## 自有 Web DEV 与文档页面

使用临时空 DATA_DIR、本地 fake provider、随机 loopback 后端；Web DEV 15173 通过 `API_TARGET` 指向隔离实例。未使用真实 `.pi-muse/` 或固定 mock 数据。

在最终代码版本的自有 Web 实际操作确认：

- 交办通过真实聊天流调用 activity start/complete，两张“登记工作活动”卡片与最终回复正常显示。
- 刷新页面后同样的工具卡与结果从权威历史恢复。
- 登记后 provider 失败展示受控错误、保留已执行卡片，不伪装整项完成、不泄露诊断。部分浏览器高层点击/键盘没有实际触发时，先重读页面，再用可见坐标或已确认按钮的原生点击；没有通过注入假消息冒充页面链路。
- 实际打开 `/docs` 的活动分组，列表/详情、四个查询参数、8 状态、游标过滤绑定、400/404/鉴权、只读和无 SSE 新事件说明可见；打开详情 Show Schema，概览/步骤/空值与崩溃结束时间规则可见。

此处是 **fake provider＋自有 Web 页面验收**，不是浏览器自动化回归套件，也不是“真实模型＋页面”验收。移动端、PWA、锁屏不在本次范围。

## 真实模型复验：存在失败，不能报告全绿

真实模型只读取经本轮授权的 model 配置，key 留在透明代理内存，测试数据全部隔离。此前旧版本 live 通过不能替代当前结论。

1. 第一轮最终代码 live：14 个场景通过后，`activity-approval-approve` 被测试断言误拦截：断言把模型自己在 overview.deliverable 中给出的文件名也当作步骤泄露。步骤本身未含原始路径/正文。修正为只检查 steps，保留本次 FAIL 事实；finally 撤销 pending 并回收进程。证据：`/var/folders/hl/dngy2s057pq4wyny6k87sj9w0000gn/T/pi-muse-live-5c5oau/summary.json`。
2. 修正测试后的完整新运行：`single` 失败。透明代理证据显示父模型确实调用 subagent，但子模型没有调用 currentTime，直接输出了一个时间；断言正确拒绝了自然语言自述。这不是服务端自动重试，亦未弱化断言再跑凑通过。后续场景（包含 Activity 新增审批场景及最终重启）本轮未执行。证据：`/var/folders/hl/dngy2s057pq4wyny6k87sj9w0000gn/T/pi-muse-live-I5vV78/summary.json`。

因此结论为：**Activity 专项进程 E2E 与自动化/页面验证已补齐；本轮真实模型完整验收未通过，新增 Activity 审批 live 不能记为通过。** 不以模拟 provider 或历史结果覆盖此失败。

## 提交前整理与重验

用户要求“测试没问题以后整理代码提交”。提交前移除未使用的 activityContext、统一审批观察端口类型、移除 SDK 事件已包含的 toolName 冗余缓存、复用列表投影实现详情读取。接口不变，未合并主工作区的其他改动。

整理后代码身份：`sourceHash=15f7852ab2f0ff5240b4476c1a9aaa579d88ddd3b645b734a8102e91e1ba55e4`。

- 首次 `pnpm check`：417/417 unit/integration 通过；进程 E2E 为 36/37，timeout 场景在重启后的正常 resume 仍使用 1500ms 整轮预算，负载下再次触发超时。将该测试预算调整为 10 秒，并补断言挂起阶段必须返回 `RUN_ERROR.code=TIMEOUT`，生产配置不变；补 crash 场景的结束时刻为 null 的进程断言。
- 第二次完整检查在既有 P4 定时任务集成测试失败：assistant 历史先写入，scheduler 的 markRun 后保存，测试只等待聊天历史即提前断言 job 状态。现改为同时观察历史和任务成功终态，不调整业务调度、不以固定延迟假定保存完成。
- 第三次完整检查发现 Activity Stop 集成测试使用固定 150ms 休眠，负载下活动尚未登记就被取消，列表为 0。现改为等待真实 Activity.currentRunId 与第二个 provider 请求出现后再 Stop，同时将审批观察也改成有界状态等待。未重试模型或工具来掩盖副作用。
- 最后完整检查退出码 0：417/417 unit/integration、37/37 真实进程 E2E（26 项 Activity＋11 项既有）、类型检查、前后端构建及差异检查全部通过。日志：`/Users/yaotutu/.zcode/cli/exec/sess_f3279f68-ece1-437e-af24-b8046a161387/call_31989f2cd32149dc93ffe6cfc5b496dc-stdout.log`；同版源码散列仍为 `15f7852ab2f0ff5240b4476c1a9aaa579d88ddd3b645b734a8102e91e1ba55e4`。
- 同版真实模型验收：single、parallel、chain、isolation、approval-approve、approval-deny、approval-cancel、model-stop、web-stop-headers 共 9 项通过；after-stop-headers 失败。透明代理记录新父模型请求在 180 秒内没有任何工具调用或文本内容，历史以受控失败/取消收尾。不能据此声称 Activity 后续 live 场景已通过，也不能直接断言为业务代码故障或网络故障。未进行模型自动重试或修改 pi 底层。
- 真实验收合成证据：`/var/folders/hl/dngy2s057pq4wyny6k87sj9w0000gn/T/pi-muse-live-6LwsDg/summary.json`；log：`/Users/yaotutu/.zcode/cli/exec/sess_f3279f68-ece1-437e-af24-b8046a161387/call_8284d8bb63cb492eb3ac41dbf017a9d4-stdout.log`。资源均已由 finally 关闭，证据按 keep-artifacts 保留。

用户的提交前提尚未满足：未隐藏真实模型失败、未将历史通过结果代替本轮重验，不进行 commit/merge/push。

## 交付边界

- 主工作区与正式业务数据保持不变。没有自动 commit、merge、push、CI 或模型重试。
- 本轮不增加 Activity SSE 事件；活动页与移动端不重构。接口字段仍以契约源自动生成文档为准。
- 临时页面实例与 Web DEV 在本轮收尾时关闭；live 合成证据按 `--keep-artifacts` 保留，不包含真实配置或 key。
