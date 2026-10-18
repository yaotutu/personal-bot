# Subagent 真实模型专项验收（2026-10-18）

## 修复后全流程重新验收（2026-10-18，当前最终结论）

**本轮限定范围全部通过，未发现新的业务失败。** 用户要求“修复以后整个流程重新测”，因此不是沿用初次测试结果：新建 `/tmp/pi-muse-full-retest.t3iUqg/`，在修复后的同一源码快照从头执行整轮。真实模型通过本机透明代理原样转发，共记录44次模型请求；工具执行、审批和文件操作均走真实服务，不用fake模型。自动化fake-provider套件另行全量重跑。

代码身份：commit `d996f5e8e63ced62bb1e0a8fb3e5950b56e06381`，dirty=true，sourceHash=`ae86048af40752d0fadc9863fda47289ce9eea1c3cdce21d36bef9a2f76bb7f1`。源码/构建及重启后指纹一致，不能把commit视为全部工作树代码。

| 本轮重新执行的场景 | 结果与证据 |
| --- | --- |
| 单个子代理 | 真实子currentTime调用、真实ISO结果进入子模型，子结果返回主模型并RUN_FINISHED。 |
| 并行子代理 | 单次tasks参数产生scout/reviewer；真实子请求时间重叠，各自调用currentTime，按输入顺序汇总。 |
| 链式子代理 | 单次chain参数执行两子任务；第二步任务收到第一步真实标记/时间，`{previous}`已替换，两步都调用currentTime。 |
| 私有/共享隔离 | 父私有文件真实存在，子read同名文件找不到；shared读成功；`../parent-isolation/...`受控拒绝；子请求/工具结果无父私密标记。 |
| 审批批准 | 完整payload/父thread/run核对；批准前无文件，批准后精确内容落盘；真实子工具结果为Saved。 |
| 审批拒绝 | 真实子write挂起后deny，审批denied，目标文件不存在，无自动重试。 |
| 审批等待中Stop | Stop约15ms，审批cancelled，父终态RUN_ERROR，文件未写。 |
| 子模型在途Stop | 真实子模型请求已开始，Stop约8ms，代理观察连接断开，父终态RUN_ERROR。 |
| Web等待响应头时Stop | 实际55秒fixture已收到请求；Stop约17ms，socket关闭、`finished:false`；不等响应或超时。 |
| Web读取正文时Stop | 实际已返回headers与首段正文后挂起；Stop约7ms，socket关闭、`finished:false`。 |
| 两个Web取消后的后续轮次 | 分别在同一thread直接调用currentTime，均RUN_FINISHED，锁没有悬挂。 |
| 旧队列/权限 | 子模型声明无subagent/delegate_task/bash/schedule/monitor/instructions；无tasks.json/子会话历史目录；旧创建入口501，snapshot无worker。 |
| Web页面额外审批 | 新增test-ui-approval真实子write，在自有15173 DEV观察完整预览（内容、版本、父thread/run），页面批准后精确落盘并最终RUN_FINISHED；另观察并行摘要卡及取消后历史。 |
| 正常重启与刷新 | 12个thread列表、完整messages/revision、全部审批记录、共享文件哈希逐项一致；pending=0，重启无自动模型请求，页面刷新后可查看取消及后续成功工具卡。 |

验收脚本13项断言全部通过（单/并/链/隔离/三种审批/模型取消/两种Web取消/两项后续轮/旧入口权限），页面审批与重启另有独立证据。重启首次检查误读代理上次遗留的trace文件；只修正临时取证脚本使启动先写本进程空轨迹，再完整比对通过，未改业务代码、未将取证脚本问题当服务故障。

自动化重新运行：`pnpm typecheck && pnpm test && pnpm build && pnpm --dir web build && git diff --check` 全部通过，测试364/364、0跳过。此次只测试与更新记录，没有业务代码修改。当前未重测独立移动端、所有供应商公网搜索或全部角色自定义扩展，不扩大为这些范围均已验收。

原始证据保留于本轮临时目录：`results.json`、`summary.json`、`trace-before-restart.json`、各场景request/SSE、`ui-approval-evidence.json`、`before-restart.json`、`restart-evidence.json`，没有真实鉴权头或凭据。隔离后端正常SIGTERM自然code0（重启两次），Web已正常停止、浏览器页已关闭，正式配置和数据未改。目录暂留复查，不上传或提交；本轮无commit/push。

## 修复后复测（2026-10-18，单项修复记录）

用户明确要求修复后，已将调用方 AbortSignal 从 pi Web 工具，经 Web service / transport 传到底层 Node HTTP 请求；等待响应头、读取正文、逐跳重定向均可取消。DNS 查询本身不能中断，但停止等待后不会继续建立请求；搜索取消不会触发供应商兜底。普通网络错误继续脱敏，公网校验、DNS固定、超时和大小限制保持。

**原来唯一未通过的慢 Web 取消项已真实复测通过：**
- 使用新隔离目录 `/tmp/pi-muse-web-cancel-fixed.VMBd64/` 和相同55秒慢fixture，主/子模型请求均真实转发。
- 子模型确实产生 `web_fetch {url: .../slow}`；目标服务器收到请求后，对父运行调用 Stop。
- Stop **19ms** 返回 `stopped:true`；服务器确认socket已关闭，`finished:false`，没有等到55秒响应或60秒超时。父SSE终态为 `RUN_ERROR/STOPPED`。
- 同一会话随后真实调用currentTime，正常返回 `LIVE-AFTER-STOP-OK` 并RUN_FINISHED，证明运行锁释放可继续使用。
- 取证 `fixed-evidence.json`、`after-stop-evidence.json`、`trace.json`、`summary.json` 留于上述新目录；不含真实凭据。测试代码快照 sourceHash=`ae86048af40752d0fadc9863fda47289ce9eea1c3cdce21d36bef9a2f76bb7f1`，dirty=true。
- 新增工具/service/HTTP取消测试、普通会话和subagent真实HTTP+pi链路测试；取消专项26/26、全量364/364、typecheck、服务端/Web build、diff检查通过。取消与大小保护回归还暴露并修正了超限时AbortSignal销毁已完成socket导致未处理错误的问题，改为直接销毁当前响应。
- 隔离实例SIGTERM自然code0；未改正式配置/数据，未commit/push。未重复其余已通过真实场景，以下记录保留其原始版本与证据范围。

## 初次结论（修复前记录）

**部分通过，不能宣称全部验收通过。** 单个/并行/链式委派、真实子工具调用、写入审批、审批中取消、子模型请求取消、私有/共享路径隔离及重启历史恢复通过；**在途 Web 工具的取消不及时**，发现一个明确缺口，未在本轮测试请求中擅自修改业务实现。

本次使用配置中的真实模型，经本地透明代理原样转发请求/响应进行取证，不使用 fake provider。只用新建隔离 DATA_DIR，自有 Web DEV 为15173、后端18894；正式数据未写入、正式服务未停止，凭据仅内存读取，不打印、不写取证文件。

代码快照：commit `d996f5e8e63ced62bb1e0a8fb3e5950b56e06381`，dirty=true；sourceHash `0dd904741b8ea54575c3638836925fcaa85877aa2902b66623452d5b567e50d8`。以sourceHash和工作树为准，不能把commit当完整版本。

## 已通过

| 场景 | 实际证据 |
| --- | --- |
| 单个委派 | 主模型真实产生 `subagent {agent:worker,task:...}`；子模型产生 `currentTime {}`；下一轮子模型收到真实ISO结果并返回标记；父模型工具结果含相同标记和时间，最后RUN_FINISHED。 |
| 并行委派 | 一次 `tasks` 调用产生scout/reviewer两个子会话；两个子模型请求分别在10:52:07.769Z和.770Z开始，时间实际重叠；各自调用currentTime并取得结果；两项均回到父模型。 |
| 链式委派 | 一次 `chain` 调用；第二子会话的user任务实际包含第一步返回的 `LIVE-CHAIN-STEP1` 和ISO时间，未保留字面`{previous}`；两步均真实调用currentTime。 |
| 写入审批 | 真实子模型调用write；pending记录含完整内容、父threadId=`live-approve`和父runId。批准前目标文件不存在；在Web查看完整预览后批准，实际文件内容为`LIVE-APPROVED-CONTENT`；子模型收到`Saved shared/live-approved.txt.`，父轮成功结束。 |
| 审批中Stop | 第二个子模型write挂起审批；Stop约14ms返回stopped=true，审批变cancelled、父SSE为RUN_ERROR/STOPPED，目标文件始终不存在。 |
| 子模型请求中Stop | 监测到真实子模型请求在途时立即Stop，约7ms返回stopped=true；透明代理确认子模型连接断开，父SSE为RUN_ERROR/STOPPED。第一次长输出尝试在停止前已结束，不算取消验收；第二次实时观察并停止才计入通过。 |
| 私有路径隔离 | 父local-main真实存在私有标记文件；子read同名相对路径得到File not found，shared文件取得公开测试标记，`../local-main/...`得到受控拒绝；子请求/工具结果未出现父私密标记。 |
| 权限与存储 | 真实子模型声明中无subagent/delegate_task/bash/schedule/monitor/instructions；无子会话持久目录，无tasks.json；旧POST任务创建返回501，快照无worker。 |
| 页面与重启 | Web实际观察subagent摘要卡、父模型回复和完整审批预览，刷新后可恢复。正常停止并重启隔离实例，8个用户thread的完整messages与revision逐一相等，pending为空，已批准文件仍存在。 |

## 未通过：在途 web_fetch 不随Stop及时取消

复现：
1. 真实主模型调用worker子代理，让其读取本机受控慢响应页面（临时实例显式配置`allowPrivateTargets: true`，不改变正式配置）。
2. 真实子模型调用web_fetch；本地HTTP fixture实际收到`/slow`请求，准备55秒后响应。
3. 在请求未结束时调用父运行Stop。
4. Stop约47380ms后才返回；fixture最终完成55秒响应，而不是在Stop时关闭。父轮最终为STOPPED，没有继续返回正常完成结果。

根因定位：
- `src/adapters/pi/tools/web.ts` 的execute未接收或向Web service传递工具取消信号。
- `src/features/web/types.ts`、`web-service.ts` 的port当前没有调用方AbortSignal参数。
- `src/adapters/web/http-transport.ts` 的requestOnce只使用内部超时AbortController，没有合并父工具取消信号。

因此问题不是“子模型生成无法取消”，而是已有Web工具不支持调用方取消，子会话等待工具完成才能收尾。它也影响普通聊天中的在途Web请求。**应另行补齐工具→service→transport信号传递并回归，不应靠丢弃Promise提前报告停止。** 本轮只测试、定位和记录，未修复。

## 本地证据与清理

取证目录：`/tmp/pi-muse-subagent-live.utJuhE/`（仅测试内容，无配置或真实凭据）。
- `trace-before-restart.json`：33次真实模型请求的主/子标识、声明工具、真实工具调用/结果和时序；不保存鉴权头。
- `*-request.json` / `*-sse.txt` / `*-result.json`：各场景真实HTTP请求和事件。
- `cancel-evidence.json`、`modelcancel-evidence.json`、`slowcancel-evidence.json`：取消时序。
- `isolation-evidence.json`、`write-summary.json`、`restart-evidence.json`、`summary.json`：文件、隔离、存储与恢复核对。

两次隔离后端均SIGTERM自然code0；Web正常SIGTERM停止（143）；本轮浏览器页已关闭。为复查取消缺口暂留隔离目录与测试数据，不上传、不提交；没有自动commit/push。本次不重复声称自动化测试已覆盖该慢Web取消场景。
