# Personal Bot 当前交接

更新：2026-10-15。当前为单进程、单用户、单模型、多 thread 的模块化单体，自有 `web/` 是客户端。用户已明确不保留任何历史逻辑兼容；旧接口、占位字段和隐式迁移已移除。此前交接全文归档到 `docs/archive/handoff-before-incremental-protocol.md`，不能作为当前实现约定。

## 接手起点

- 当前分支：`main`；架构调整与代码整理已按用户要求提交为 `54e914a`（重构个人助手执行边界与增量聊天协议），未 push。
- 更新本交接前工作区干净。本文是该提交之后的文档更新；接手时先执行 `git status --short`，不要撤销新增改动，也不要误认为主体重构仍未提交。
- 本轮约定的重构已完成，没有必须继续修复的已知阻塞项。后续按用户实际需求推进，不为预防未来规模提前引入数据库、队列框架或执行恢复。
- 优先阅读顺序：`AGENTS.md` → 本文 → `docs/architecture.md` → `docs/http-api-contract.md`。`docs/archive/` 只作历史记录。

## 本轮架构调整

- 聊天直接由 Hono 接收增量请求并输出 AG-UI SSE，删除 CopilotKit runtime、PiAgent、runner 及对应依赖。GET 历史返回 pi 叶子 revision；run 仅提交单条 message、expectedRevision 与 runId，版本冲突在 SSE 前返回 HTTP 409。成功原请求幂等重放；失败轮可显式重试最后同内容消息。
- Stop 接口绑定 threadId/runId。Web 等待服务端取消、落盘和通知队列释放后刷新历史；切换会话则取消原流。版本冲突恢复未接纳的草稿，不吞用户输入。
- 后台会话不装配 delegate_task/schedule/monitor，防止递归生成执行源；queued + running 上限 32，create/retry 都在 repository 串行更新内检查，HTTP 满额 429，工具返回受控拒绝。
- 监控投递按 monitor/notification ID 独立跟踪，不阻塞扫描；pending/在途期间不新抓取覆盖，单项失败不阻断其他监控；close 等待扫描与在途确认。
- 审批独立查询 pending（完整预览）、历史摘要和单项详情，工作台快照不再读取审批或返回 notifications。任务 kind 为 job/task；删除 plan/evidence/input/state/attempts/artifactIds、详情空集合、ideas/artifacts 等无实现占位字段，控制 target 必填。
- Web 消息、请求、事件类型均来自 schema；SSE 运行时同源校验，畸形事件及缺终态断流明确报错。token 是前端认证唯一事实，401 与跨标签变化会同步 React，错误密钥正常显示。
- provider/key 只在 bootstrap 初始化一次。Web service 返回结构化联合结果，pi 工具边界才序列化 JSON，监控不再解析工具文本。
- session 初始化只 mkdir，不隐式迁移平铺 JSONL；memory/tasks/jobs 坏条目整体拒绝，不再过滤或填补已有文档的缺字段。真实数据没有迁移或改写。
- 默认 CORS 包含 localhost/127.0.0.1 的 15173、17890 共四个 origin；mock 数据路径显式绝对解析，避免配置目录造成重复嵌套。

## 验证记录

- `pnpm typecheck`、`pnpm test`（252/252）、`pnpm build`、`pnpm --dir web build`、`git diff --check` 通过。依赖移除后重装成功；vue-demi 安装脚本显式禁用，与本项目只使用 Scalar 浏览器 bundle 的方式一致。
- 自动化覆盖 >1 MiB 真实 pi 用户历史后的 <1 KiB 增量请求、旧全量请求 400、陈旧版本 409、成功消息重复身份拒绝、重启幂等、迟到 Stop、断连取消、后台容量并发竞争、后台工具裁剪、监控忙会话隔离和失败补投、审批跨域隔离/完整预览/摘要、401 状态及非法 SSE。
- 编译入口独立进程使用自建临时 cwd/DATA_DIR：health=200，SIGTERM 自然 code 0；非法配置及损坏 monitors 自然 code 1，原文件字节不变。
- 自有 Web DEV + 隔离服务 + fake provider 实际验证：错误密钥、时间工具卡片、挂起轮 Stop 后立即下一轮、完整审批预览、批准写入、待审批 Stop 撤销、后台事实导致的 409 草稿恢复与手动重发。无前端未捕获错误。
- 真实模型使用现有模型配置的内存凭据、全新临时数据目录：Web 请求 currentTime 成功，中文回答与工具卡片正常，页面刷新恢复，控制台无 error/warn。本轮真实模型范围不扩展为所有工具/供应商故障场景已验证。
- 验收时既有 5173 开发服务占用中，未停止或改代理；隔离 DEV 另用 15173（fake）和 15174（真实模型），后端 18788/18789。本轮临时服务与文件均在验收后清理，这些端口不是接手时仍在运行的承诺。真实 `.personal-bot/`、OpenMuse 仓库及已有开发进程未作为测试对象。
- 提交前再次执行类型检查、252 项测试、服务端/Web 构建和差异检查，全部通过。最后的整理仅清理无效语句、重复类型声明、初始化条件分支和注释；未改变已验收的交互行为。

## 启动与联调

```sh
pnpm install --frozen-lockfile
pnpm dev
# 另一个终端；默认代理到 127.0.0.1:17890
pnpm --dir web dev
```

真实服务读取必需的 `.personal-bot/config.json`，实际端口以该文件或启动日志为准，不要在交接文档里复制模型凭据。**端口被占用时不会自动避让**：启动直接报错，错误信息包含占用进程的 PID（用 `lsof` 查），由用户决定是改 `server.port` 还是 `kill -15 <pid>` 释放端口；这避免了"启动时端口悄悄变了而 Vite 代理还在 17890"的同步错位。启动前检查端口监听，不要停止已有开发进程。

模拟联调用 `pnpm dev:mock`（17891）和 `API_TARGET=http://127.0.0.1:17891 pnpm --dir web dev`；其数据写入 `.personal-bot/mock`，不是自动化测试的隔离目录。自动化与临时页面验收仍必须使用自己创建的临时 DATA_DIR；不修改真实配置或数据。

端口选择说明：服务端默认 17890、mock 默认 17891、Web dev 默认 15173、Web preview 默认 14173，避开 nanobot(7890) 与 Vite(5173/4173) 的默认区间；host 默认 `0.0.0.0` 便于局域网访问，未设 `server.accessKey` 时启动会打印安全警告。

当前协议不接受旧客户端回传的 messages/state/tools/context/forwardedProps，也不提供 `/api/copilotkit/*`。前后端应一起使用当前代码。已有数据若不满足当前 reader 会明确失败；没有自动补字段或迁移，不能通过删文件来消除报错。

## 当前边界

保留 JSON、pi 历史权威、函数式工厂和显式依赖注入。无数据库、消息总线、durable execution、运行恢复或模型/工具自动重试；工具副作用不回滚。任务通知失败可查任务详情，不承诺崩溃后必达；文件 guard 不承诺抵御外部恶意进程竞争。

历史读取目前仍为全量展示投影，增量发送已解除请求体增长限制；分页和虚拟列表可按实际长会话体验另做，不维护第二份历史。

入口与约定见 `AGENTS.md`，职责和生命周期见 `docs/architecture.md`，接口见 `docs/http-api-contract.md` 与运行时 `/docs`，配置见 `docs/configuration.md`。
