# 会话私有根与符号链接防护：修复后验收

日期：2026-10-18。对应前次报告：[`2026-10-18-session-workspace-live-acceptance.md`](2026-10-18-session-workspace-live-acceptance.md)。

## 本轮改动

- 所有 thread（主会话 local-main、普通用户会话与 task-*）统一使用 `workspace/threads/<threadId>/`，不再允许主会话或缺少 threadId 时回退整个 workspace。
- `SessionManager.continueRecent` 的 cwd 与执行 cwd、文件工具根保持一致。只恢复同 cwd 的权威历史，不增加旧路径兼容 reader，不自动迁移或删除旧根文件。
- 新增 workspace-path：普通路径先选择私有/共享根，再解析一次；拒绝绝对路径、`..` 和反斜杠，目标、祖先与根目录逐段 lstat 拒绝符号链接。部署路径的已存在系统父目录别名（如 macOS /tmp）通过 realpath 规范化，不将 workspace 根本身的符号链接视为合法。
- 只读 read/ls/grep 使用 pi 公开 operations 核查 SDK 最终路径；read 用 O_NOFOLLOW 打开普通文件并保留图片识别。ls 跳过链接；find/grep 保留 SDK 默认不跟随链接的递归实现，直接入口链接在执行前被拒绝。
- write/edit 复用同一实际路径检查，审批、版本检查、取消、过期与逐目标提交队列不变。shared 仍需逐次审批，两个会话写同一个共享文件时过时基线不能提交。
- `shared/...` 为工具别名，不在私有目录中创建符号链接。system prompt 和只读工具说明补齐私有/共享的区别，移除“没有文件写权限”的过时声明。
- pi 的技能清单给出绝对 SKILL.md 路径，显式允许 read 读取本轮启用技能的精确文件；不开放相邻文件/目录，不对 grep/find/ls 或写工具放宽。
- 更新 README 全目录树、配置文档、architecture、AGENTS 和旧讨论稿的优先级说明。未修改 SDK 或引入沙箱框架。

## 自动化验证

- `pnpm typecheck`：通过。
- `pnpm test`：277/277，通过（原269项，加7项文件边界单测和1项完整 HTTP/pi/cwd 重启集成回归）。
- `pnpm build`、`pnpm --dir web build`：通过。
- `git diff --check`：通过。
- 新单测覆盖主/普通/task目录并列、双向越界、共享read/ls/find/grep、文件/目录/断链/同根链接、根与容器链接初始化拒绝、精确技能文件例外、PNG图片读取、共享审批并发版本冲突。递归搜索测试在链接存在时执行，不先删除链接绕开验证。
- 新集成回归经真实HTTP+pi（仅模型fake）验证主会话与其他会话访问边界、共享读取、旧根文件保留且不可达、SessionManager头cwd、重启messages/revision完全一致。

## 编译入口生命周期

使用隔离 cwd、无真实模型的临时 config 启动 `dist/index.js`：

- 正常启动 health=200，SIGTERM 自然退出 code=0。
- 将 workspace/threads 预置为指向外部测试目录的符号链接，启动明确抛 Unsafe workspace directory，自然退出 code=1；外部目录中的 sentinel 文件原样保留，无额外目录创建、无残留interval或监听进程。

## 真实模型与自有 Web 复测

- 模型：`silicon/deepseek-ai/DeepSeek-V4-Flash`（现有配置只读加载于服务内存，不打印或复制凭据）。
- 全新隔离实例：`/private/tmp/pi-muse-isolation-retest.iw56js/data`，后端17892、自有Web DEV15173，未向正式会话发送测试消息。
- 两个旧漏洞均已实测修复，结论不依赖模型自述：从 pi JSONL 实际 toolResult 提取并校验私有随机标记没有出现在其他会话工具结果中。

### 复测结果

| 用例 | 真实结果 |
| --- | --- |
| local-main 读取自身 private-canary.txt | 只返回 MAIN-PRIVATE 随机标记 |
| local-main 使用旧 threads/qa-mail/... 路径 | 只在自身私有目录中解析，返回 ENOENT，没有邮件内容 |
| local-main 使用 ../qa-mail/... | Access denied |
| local-main 读取文件链接 mail-file-link.txt | Access denied |
| local-main 读取目录链接 mail-dir-link/private-canary.txt | Access denied |
| qa-other 读取自身同名 private-canary.txt | 只返回 OTHER-PRIVATE 标记 |
| qa-other 读取 mail-link.txt 或 ../qa-mail/... | Access denied；之前此链接可泄漏邮件内容，本轮不能 |
| qa-other 在默认根 grep MAIL-PRIVATE- | No matches found；链接保持存在 |
| 主/普通会话 read shared/team-canary.txt | 均正常返回同一共享随机标记 |
| 真实 write shared/approved.txt | Web完整预览与会话/运行信息正确，批准后只写入 workspace/shared/approved.txt |
| qa-other 读取/列出共享写入产物 | read 得 FIXED-SHARED-M27；ls列出approved.txt，grep正常执行（所选查询不命中文本时返回No matches） |
| 真实 write approved-private.txt | Web批准后仅写入 qa-mail 私有根，local-main与qa-other无同名副本 |
| Web instructions 保存会话规则 | 真实工具执行，持久化仅qa-mail，后续最终回复使用【邮件复测-M27】 |
| 正常重启隔离服务 | 三个会话messages/revision完全一致；重启后的无工具算术回复仍保留qa-mail规则标记 |

核对文件内容为 FIXED-PRIVATE-M27（模型写入末尾换行）与 FIXED-SHARED-M27，审批无pending残留。Web实际观察了旧越界读取的拒绝/失败卡片、指令工具卡片、完整私有/共享审批预览、批准后审批消失，以及刷新后的历史。

## 诚实范围与未扩展部分

- 此边界是普通文件工具的权限，不是操作系统沙箱；可信 extension 仍是服务端代码，不承诺抵御外部恶意进程在检查和I/O之间竞争替换路径，也没有解决硬链接或多用户隔离。
- 真实模型在一次主会话批量验收中重复读取并产生了对工具参数包装的混乱解释；验收使用权威JSONL结果核对，不采信这段解释。另一次“确认明天下午回复”被模型理解为创建提醒，本轮仅在隔离实例中取消了该提醒，后续用无工具算术请求复核重启规则。没有修改通用调度产品语义，也没有把模型行为当作目录防护故障。
- 原有Web没有会话规则设置页面；本轮仍使用对话工具和HTTP管理，不新增客户端功能或修改renderer协议。
- 正式 .pi-muse 数据、配置、旧workspace文件、旧JSONL头均未迁移、改写或删除。现有17890 watcher可能随源码编辑热重载；本轮没有主动重启或停止该服务。不要将“旧数据仍在”理解为新cwd会自动读取旧历史。
- 全部本轮临时后端/DEV服务已停止；新验收数据与证据暂留供核对，无自动commit/push。

## 本地证据

目录：`/private/tmp/pi-muse-isolation-retest.iw56js/evidence/`。

- `main-fixed-boundaries.json/.sse`、`other-fixed-symlink.json/.sse`：真实模型复现两处旧漏洞已拒绝。
- `canonical-results.json`：实际工具结果与无跨会话私有标记泄漏断言。
- `fixed-shared-write.json`、`fixed-private-write.json`、`fixed-shared-cross-thread.json`：真实写入、Web审批后结果及另一会话读取。
- `restart-check.json`、`fixed-rules-final.json`：重启前后历史一致与规则保留。
- `final-files.json`、`process-lifecycle.json`：实际落盘位置与编译入口生命周期。
