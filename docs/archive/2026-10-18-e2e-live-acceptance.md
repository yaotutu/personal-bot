# 本地 E2E 与真实模型验收入口交付记录（2026-10-18）

## 结论与范围

已新增可重复运行的服务端测试入口，并实际跑通：

- `pnpm check`：typecheck → unit/integration → build + dist进程E2E → Web build → diff检查，任一步失败即非零退出。
- `pnpm test:e2e`：只构建并运行本地假模型驱动的真实服务进程测试，无公网或正式凭据依赖。
- `pnpm test:live --config <JSON路径> --allow-live [--keep-artifacts]`：显式真实模型验收，仅读配置model，临时空DATA_DIR，真实key只在透明代理内存。不会被默认检查调用。

未新增生产接口、未更改业务执行/权限逻辑，未安装新的测试框架，未增加GitHub Actions或任何CI/远程设置，也未commit/push。用户后续只需运行本地命令，不必再重建临时验收脚本。

基础提交 `7bcdec94966e4da823caeb3473a9ad625ae468ad`，dirty=true。本轮服务版本sourceHash=`a8ed838da9ee8b96bb19a5c555998feb3175a3d5c83684350a231349c50d05ea`；该hash按现有白名单覆盖生产源码、资产、scripts、package/lock及tsconfig，不覆盖tests或Markdown，因此测试文件的变化不应仅靠此hash核对，实际测试结果如下。

## 稳定检查实跑

最终 `pnpm check` 退出码0：

| 步骤 | 结果 |
| --- | --- |
| TypeScript类型检查 | 通过 |
| unit/integration | 379/379，通过，0跳过 |
| 构建服务端与复制内置资产、版本身份 | 通过 |
| dist进程E2E | 11/11，通过，0跳过 |
| Web类型检查与Vite构建 | 通过 |
| git diff --check | 通过 |

E2E用例启动的是独立 `node dist/index.js`，配置位于本次mkdtemp的cwd/.pi-muse，端口动态探测，使用原生产配置入口而非测试专用HTTP注入。测试模型是本地OpenAI SSE服务，pi SDK、工具、审批、存储、HTTP/SSE和进程退出均真实执行。

11项覆盖：
1. 登录正确/错误密钥、无token拒绝、聊天工具流、记忆落盘、指令保存、token与历史重启恢复、服务版本/文档身份。
2. 子代理单个、两个实际重叠的并行请求、链式previous替换；权限上限、技能关闭、无任务队列或子会话持久化。
3–5. 子代理write分别批准、拒绝、等待中取消，完整审批/父运行归属与实际文件真值核对，取消后同会话可继续运行。
6. 子模型请求与真实慢HTTP正文在途Stop，provider/socket断开且不等待工具超时，随后工具轮可用。
7. 私有文件不泄露、共享可读、删除后迟到GET/Stop不重建会话或目录。
8. 工作区命名SSE ready及失效通知与契约一致，持有连接时SIGTERM自然code0。
9–11. 非法配置、损坏业务文档、端口占用时自然code1，不依赖强杀通过，不覆盖坏文档、不残留scheduler。

测试自身的保护也进入默认回归：CLI必须显式config+allow-live、未知/重复/命令行key拒绝；透明代理不沿用下游占位鉴权、不记录system/key、确实解析上游toolcall并在客户端取消时断开上游。`check`与`test:e2e`不得包含live入口的脚本守卫已补。

开发期间首轮进程测试只有指令文件行尾换行断言不符（实际writer自动追加换行），修正测试预期后通过；增加链式真实输出比对时出现TypeScript可空收窄错误，修正测试类型守卫并重新运行全套通过。没有为让测试通过修改业务代码，也没有吞掉失败或自动重试供应商/工具。

## 真实模型命令实跑

执行两轮，均14项PASS、退出码0：
- 第一轮显式 `--keep-artifacts`，核对脱敏summary与合成数据保留。
- 第二轮默认清理，强化并行两个结果回父模型、链式实际第一输出进入第二子任务的断言后重新执行；默认目录和监听均回收。

场景如下：

| 场景 | 验收依据 |
| --- | --- |
| single | 子模型真实currentTime调用与ISO工具结果，父模型收到子结果 |
| parallel | 单次tasks委派、两个子模型请求实际重叠、各调用currentTime、两个结果均回父模型 |
| chain | 单次chain委派，两步都调用currentTime，第二任务含第一步实际输出，不是仅有占位标记 |
| isolation | 父私有文件真实存在但子读不到；shared读取成功、`..`被拒、无私密标记泄漏 |
| approval-approve | pending完整路径/内容与父thread/run，批准前无文件，批准后精确落盘 |
| approval-deny | deny终态、子write真实发生但未提交文件 |
| approval-cancel | Stop撤销pending、无文件、父RUN_ERROR |
| model-stop | 真实子模型请求在途Stop，上游连接断开 |
| web-stop-headers | 55秒慢fixture确实接到子web_fetch，Stop销毁socket、未自然完成 |
| after-stop-headers | 同一thread新currentTime轮正常RUN_FINISHED |
| web-stop-body | fixture已发响应头与正文首段后Stop，socket关闭、未自然完成 |
| after-stop-body | 同一thread可再次正常执行 |
| permissions-and-old-queue | 子工具声明无禁止能力，旧POST501，无tasks.json/子会话持久目录/worker字段 |
| restart | 11个thread完整messages/revision、审批原件、共享文件哈希一致，pending=0，无模型自动续跑 |

第一轮保留的summary显示40次真实模型请求、两个HTTP fixture；取消耗时为审批10ms、子模型60ms、Web响应头61ms、Web正文7ms（只是本次观测值，不是延迟保证）。所有判断以trace里的实际模型toolcall、真实工具结果、文件和socket状态为据，不依赖主模型“我做了”的自述或逐字答案。

第一轮取证目录：`/var/folders/hl/dngy2s057pq4wyny6k87sj9w0000gn/T/pi-muse-live-zPFTn5/`，内含合成测试data和脱敏`summary.json`，未保存真实模型配置、鉴权头或key；目录明确按keep参数保留，不上传/提交。第二轮默认路径清理后仅上述显式保留目录存在，未发现E2E/真实模型服务遗留进程。

## 限制

- 这是服务端E2E，不是浏览器或移动端UI E2E，Web只进行了构建检查，不能替代实际renderer/页面观察。
- 模拟模型保证固定回归，不能证明真实模型自由决策或所有供应商都兼容。live中不调用预期工具或网络失败会真实标红，不自动retry凑通过。
- 未改锁文件或依赖，不执行干净安装/远端CI验证。本次在当前已安装依赖上运行，无GitHub Actions变更。
- 真实模型费用与速率限制不可控，默认命令不调用它；后续关键改动按规范显式运行live，不能以本次历史结果代替未来验证。
