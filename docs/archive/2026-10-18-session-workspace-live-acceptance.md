# 会话指令与工作区：真实模型验收

日期：2026-10-18。结论：**部分通过，不能认定已实现“所有会话彻底隔离”**。

## 验收环境与方法

- 使用现有正式配置中的真实模型 `silicon/deepseek-ai/DeepSeek-V4-Flash`，仅在内存中复用模型配置，没有使用 fake provider。
- 后端为隔离实例 `127.0.0.1:17892`，数据目录 `/private/tmp/pi-muse-live-qa.2h3pAN/data`；自有 Web 为 Vite DEV `127.0.0.1:15173`，代理到该隔离后端。
- 测试会话：`local-main`、`qa-mail`、`qa-other`、`qa-api`。所有文件均为本轮创建的无敏感测试内容。
- Web 实际完成登录、创建邮件会话、对话保存规则、下一轮邮件回复、刷新历史、完整写审批预览、批准/拒绝。部分只读和边界用例通过 HTTP 发起真实 pi/模型轮，保留 SSE、权威 JSONL 工具结果及物理文件核对证据；不是只看模型自述。
- 正式 `.pi-muse/` 仅只读获取模型配置；未写入正式会话或修改正式配置，未重启/关闭既有 17890 服务。本轮未修改业务代码。

## 已通过的实际行为

| 项目 | 实际结果 |
| --- | --- |
| 对话保存规则 | 在 Web 的 `qa-mail` 中要求使用 `instructions` 保存规则，工具真实执行，GET 和磁盘内容一致 |
| 下一轮规则生效 | 邮件回复与后续文件操作答复持续带有邮件专属标记 `【邮件台-QA731】` 和落款 |
| 不污染其他会话 | `qa-other` 的 `instructions get` 为空，答复不带邮件规则；全局长期记忆仍为 0 条 |
| HTTP 写规则 | PUT `qa-api/instructions` 后，真实模型答复出现仅在规则里指定的标记 |
| 热更新 | PUT 更换规则后，不重启即可让下一轮使用 `【新规则-Z92】`，不再使用旧标记；PUT 不推进 conversation revision |
| 正常重启 | 隔离服务 SIGTERM 正常 code 0；重新启动后四个会话的 messages/revision 与重启前完全相同，真实模型仍遵循修订规则 |
| 普通相对文件路径隔离 | `qa-mail` 的 `private-canary.txt` 与 `qa-other` 同名文件返回不同的随机标记；在 `qa-other` 读取邮件会话写的 `draft-qa.txt` 返回 ENOENT |
| 普通路径越界拒绝 | 在 `qa-other` 读取 `../qa-mail/private-canary.txt` 和邮件工作区绝对路径，均由 guard 返回受控拒绝 |
| 私有写入审批 | 真实 write 进入 pending，Web 展示完整内容与 threadId/runId；批准后仅在 `workspace/threads/qa-mail/draft-qa.txt` 落盘，其他会话及 shared 无同名文件 |
| 共享读写 | 批准 `shared/team-written.txt` 写入后，文件实际位于 `workspace/shared/`，另一会话能用 read 读取完全相同内容 |
| 共享目录检索 | 显式 `ls(path="shared")`、`find(path="shared", pattern="*.txt")`、`grep(path="shared", pattern="SHARED-WRITTEN-QA731")` 全部成功 |
| 拒绝不写入 | Web 拒绝 `rejected-qa.txt` 后，模型诚实报告未写入，物理文件不存在 |
| 符号链接写入保护 | 向预置的跨会话符号链接 `mail-link.txt` 写入，被工具直接拒绝，无审批、无实际修改 |
| 删除范围 | 删除 `qa-mail` 后，会话目录、指令文件与专属工作区消失；`qa-other` 私有文件和 shared 中已写文件保留 |

## 不通过：两处隔离漏洞

### 1. [P1] 主会话可以直接访问其他会话的私有文件

**复现：**

1. 在隔离数据中为 `qa-mail` 准备 `workspace/threads/qa-mail/private-canary.txt`，内容为仅写在文件里的随机标记。
2. 在 `local-main` 真实模型轮中要求用 read 读取 `threads/qa-mail/private-canary.txt`。
3. pi 工具真实返回 `MAIL-PRIVATE-ccb3095a-04ff-4e76-8517-1a19271dad70`，`isError=false`；Web 刷新后也展示了该私有文件内容。

**原因：** `src/adapters/storage/data-layout.ts:59-63` 为主会话返回整个 `workspace/`，而其他会话位于它的子目录。现有 guard 只看路径是否落在根目录之内，因此这个请求被认为合法。

**影响：** 主会话并未隔离；只要路径已知即可读取其他会话，递归检索也存在暴露范围。相同目录边界亦用于写工具，审批不能替代会话边界，但本轮没有执行主会话跨会话写入。

**修复方向：** 主会话也必须使用与其他会话并列的 `workspace/threads/local-main/`，而不是它们的父目录。不能为维持旧测试夹具而给主会话开例外；更新测试夹具并加入主会话访问其他会话被拒绝的断言。

### 2. [P1] 只读文件工具可通过符号链接跨越会话边界

**复现：**

1. 验收脚本预置 `workspace/threads/qa-other/mail-link.txt`，指向 `workspace/threads/qa-mail/private-canary.txt`。链接不是模型通过 write 创建的。
2. `qa-other` 直接用 `../` 和绝对路径访问邮件会话时被拒绝。
3. 同一真实模型轮用 read 读取 `mail-link.txt` 时却获得相同邮件私有随机标记，权威 JSONL 中 `isError=false`。
4. 对这个链接调用 write 则被拒绝，说明只读与写入路径的实际防护不一致。

**原因：** `src/adapters/pi/tools/path-guard.ts:9-21,30-49` 只校验字符串解析后的路径，没有校验实际文件系统中的链接指向。底层 read 会跟随链接。

**影响：** 用户手动放入、导入或其他可信代码创建的链接可以破坏“彻底隔离”。无需模型获得 bash 权限。不能将“write 不允许创建链接”等同于只读隔离成立。

**修复方向：** 为只读工具添加实际路径边界校验，并检查目录递归遍历的链接策略；不能只验证起始目录，随后让 grep/find/ls 随链接越界。仍需保留 skills 文件只读等当前产品能力的显式边界。

## 体验和模型行为问题

### 共享目录未被明确告知模型

`src/adapters/pi/system-prompt.ts:16-17` 仍表示文件工具只读、没有写权限；没有描述 `shared/` 虚拟目录入口、当前会话私有目录与共享目录的区别。

- `qa-mail` 遵照指定路径直接 read 时能读到共享文件。
- `qa-other` 初次被要求读取私有和共享文件时，先用默认根目录 find/ls，未发现 shared，随后误报共享文件不存在。
- 明确说明 `shared/` 是服务端别名并要求直接 read，或显式将检索 path 指定为 shared 后，read/ls/find/grep 全部成功。

这不是共享文件未落盘，而是能力说明与路径可发现性不足。需要补齐 prompt/工具路径说明，避免让用户每次解释别名。

### 规则注入不等于强制格式约束

邮件规则与 HTTP 规则均能持久化并影响真实模型，但“第一行只能是固定标记”没有每次严格遵守：模型有时将正文接在标记同一行（例如 `【API会话-QA984】我可以……`）。落款和修订后的结尾标记验证成功。当前实现是提示词指导，不是输出格式验证器，不应承诺严格格式保证。

### Web 管理入口缺失

当前 Web 没有会话规则或技能编辑面板。此次规则录入通过对话工具和 HTTP 管理接口完成，不把它描述为已有规则设置页面。Web 工具摘要在刷新后显示 `读取 {}` / `写入 {}`，完整审批预览仍能显示真实路径与正文；这属于展示限制，不是本轮隔离结论的依据。

## 本轮结论与范围

- **会话指令：持久化、动态注入、修改、会话隔离与重启有效；格式遵循仍受真实模型能力影响。**
- **工作区：普通会话的正常相对路径及 shared 读写有效，但整体隔离不通过。主会话父目录暴露和只读符号链接绕过是必须修复的问题。**
- 之前“269 项测试通过，因此彻底隔离验收完成”的表述不成立；原测试未覆盖上述跨会话读取和链接场景。
- 未测试真实邮件发送（当前无邮件连接器）、所有自定义 extension 的任意服务端代码、外部恶意进程的路径竞争、删除并发竞态。不能由本轮结果推断这些范围已通过。
- 本轮不改实现、不删正式旧数据、不自动 commit/push。隔离后端与 Web DEV 已正常停止；证据和隔离测试数据暂留以便复核。

## 证据

- 本轮本地证据目录：`/private/tmp/pi-muse-live-qa.2h3pAN/evidence/`（只含人工测试内容，无模型 key）。
- `main-cross-thread-read.json` / `.sse`：主会话真实 read 返回其他会话私有文件。
- `other-boundaries-and-symlink.json` / `.sse`：直接越界拒绝与链接绕过对照。
- `canonical-tool-results.json`：从 pi 权威 JSONL 提取的实际工具成功/失败结果（不是模型推断）。
- `private-write-approved.json`、`shared-write-approved.json`、`private-write-rejected.json`：写审批三条真实模型轮。
- `instructions-and-files-state.json`、`instructions-refresh.json`、`instructions-after-restart.json`、`restart-history-check.json`：规则热更新、文件与重启核对。
- `shared-ls-find-grep.json`、`delete-thread-check.json`：共享检索和会话删除范围。
- Web 截图：`/Users/yaotutu/.zcode/cli/artifacts/sess_72037215-0dad-4d76-8edf-3ece2e3d84ab/call_e642f681b3bd421daea0acb4c0f02bc0-tool-result-9a1c5e47-36cf-4db4-b665-355822851fc0.png`。
