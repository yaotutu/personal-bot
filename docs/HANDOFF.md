# Personal Bot 交接文档

> 用途：把当前项目状态、已完成内容、未完成事项和关键坑完整交接给下一轮执行的 Agent / 开发者。
> 更新日期：2026-10-11 ｜ 状态：P1–P4 全部完成并经真实模型 Web 验收。

## 1. 项目一句话

在 `/Users/yaotutu/Desktop/code/personal-bot` 的个人助手服务端：执行内核使用 pi
（@earendil-works/pi-coding-agent@1.1.0），对接现有 OpenMuse 的 Expo Web 客户端
（本地 CopilotKit runtime + AG-UI SSE），单 OpenAI-compatible endpoint、单会话、单用户。
最终目标：复刻 nanobot 的个人助手能力，不做多 channel、不引入 durable 框架。

## 2. 当前状态（全部完成，git 见下）

| 能力 | 状态 | 验收 |
| --- | --- | --- |
| 文本对话闭环（P1） | ✅ | 流式/历史/停止/断流/超时/去重，Web 全验 |
| 只读工具 currentTime + 文件工具 read/grep/find/ls（P2） | ✅ | 路径边界防护，真实模型 find→read 链式实测 |
| 会话压缩（P2.5） | ✅ | 比例收缩参数防小窗口死循环，测试覆盖 |
| 身份注入 SOUL/USER（P3 第一步） | ✅ | 改文件下一轮生效 |
| 长期记忆 CRUD + 注入 + Apps 界面（P3） | ✅ | 界面添加→模型引用，对话式记住/忘掉 |
| 定时任务：对话创建→调度→结果进聊天流（P4） | ✅ | 90 秒提醒实测，重启补跑测试覆盖 |
| 33 项集成测试 | ✅ 全绿 | `pnpm test` |

git 提交链（main）：

```
db9da64 P4 定时任务：对话式创建 + 调度器 + 结果进聊天流 + 重启补跑
7bd2bc2 P3 长期记忆与身份设置：显式记忆 CRUD + 注入 + OpenMuse 界面点亮
8ebdac1 开启会话压缩 + P3 第一步：SOUL/USER 身份注入
610a3be 开放 pi 内置只读文件工具：read/grep/find/ls + 路径边界防护
49d66d0 客户端兼容层最小化：撤回 textOnly，OpenMuse fork 压缩为 2 文件 patch
7bf5dc1 初始基线：P1 纯文本闭环 + P2 最小工具闭环（currentTime）
```

## 3. 架构与关键文件

分层、硬边界、设计哲学、fake-model 触发词表、数据目录说明全部在 **`AGENTS.md`**（项目根），
此处不重复。速查：

- `src/app.ts` HTTP/协议 + 调度器；`src/runtime.ts` AG-UI 适配
- `src/conversation.ts` 会话协调（run/trigger 共锁、历史投影、脱敏）
- `src/pi.ts` 内核装配（prompt 注入、工具 allowlist、guardTool 边界）
- `src/memory.ts` `src/jobs.ts` 能力模块（单文件 JSON 权威存储）
- `compat/openmuse/` 客户端最小 fork patch（2 文件约 90 行 + 基线 commit）

## 4. 运行环境事实

- 真实模型：局域网网关 `http://192.168.55.222:20128/v1`，模型 ID
  `silicon/deepseek-ai/DeepSeek-V4-Flash`（注意：`ds/` 前缀路由在网关上无凭据，
  会报 model_not_found；以 `/v1/models` 实际列表为准）。配置在本地 `.env`（gitignore）。
- 联调常驻：服务端 `pnpm dev`（8787，tsx watch），OpenMuse Web
  `EXPO_PUBLIC_API_URL=http://localhost:8787 pnpm web`（8081）。两者都在跑可随时用。
- OpenMuse 仓库：`~/Desktop/code/openmuse`，是 git 仓库；我们的改动在
  `packages/domain/src/index.ts` 与 `apps/mobile/src/chat.tsx`（diff 由 patch 跟随），
  其余 dirty 文件属于用户自己，勿动勿提交。

## 5. 本轮沉淀的关键经验（踩坑记录）

1. **pi 的 cwd 不是沙箱**：内置工具接受绝对路径与 `../`；必须 guardTool 强制边界。
2. **pi 默认压缩参数只适合大窗口**：reserveTokens=16384 在小 contextWindow 下阈值为负，
   压缩死循环；按窗口比例收缩。
3. **deepseek-flash 会省略工具参数**：schedule 工具曾连续 8 次缺 `prompt`；schema 必填 +
   描述显式强调后遵循。模型偶尔偷懒不调工具（引用历史旧时间），明确要求即可。
4. **fake-model 的分支必须在 event 函数定义之后**，否则 TDZ 让请求挂起（测试静默 hang）。
5. **loadConfig 抛错时 harness 的 fake-model server 不清理** → 测试进程 hang；改
   harness 环境变量时保证 MAX_TOKENS < CONTEXT_WINDOW。
6. **pi-durable 已评估并否决**：spike 在 `~/Desktop/code/pi-durable-spike`。卖点真实
   （崩溃恢复语义正确）但太不成熟（静默失败、错误无堆栈、文档失真）；用户定论"崩了重跑"，
   不引入任何 durable 框架。
7. **zsh noclobber**：覆盖重定向用 `>|`。

## 6. 下一步候选（未排期，等用户拍板）

1. web fetch 小工具（读网页链接，自写几十行，通配卡片免改客户端）。
2. 写文件能力 + 审批策略（edit/write 开放需要确认机制设计）。
3. MCP 接入（pi 有原生支持，ResourceLoader 目前刻意返回空）。
4. 子代理/委托长任务。
5. iOS/Android 原生端验收（用户目前 Web 优先，明确不急）。

## 7. 参考文档

- `AGENTS.md`：项目指南（分层/边界/哲学/测试/数据目录）——**先读这个**
- `README.md`：启动、联调、安全说明、验证状态
- `docs/implementation-plan.md`：原始分阶段计划（P0-P4 均已完成）
- `docs/openmuse-api-contract.md`：客户端接口契约与 SHA 指纹
- `docs/pi-reuse.md`：pi 生态选型边界
