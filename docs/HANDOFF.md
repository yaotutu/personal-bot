# Personal Bot 交接文档

> 用途：把当前项目状态、已完成内容、未完成事项和关键坑完整交接给下一轮执行的 Agent / 开发者。
> 生成日期：2026-10-10 ｜ 当前代码基线：P1 纯文本闭环已完成并验收，P2 工具闭环尚未开始。

## 1. 项目一句话

在 `/Users/yaotutu/Desktop/code/personal-bot` 新建一个服务端：执行内核使用 pi（@earendil-works/pi-coding-agent@1.1.0），对接现有 OpenMuse 的 Expo Web/iOS/Android 客户端协议（本地 CopilotKit runtime + AG-UI SSE），第一阶段只支持一个 OpenAI-compatible endpoint，不接外部 channel、不多模型、不用 nanobot WebUI。

## 2. 当前状态（已完成，且已验证）

- 服务端：Hono + Node，含鉴权/CORS/health/workspace/agent/conversation/runtime 路由，未实现功能诚实返回 501 或空快照。
- pi 集成：真实 SDK（非 mock provider），`openPi()` 目前 `tools: [], noTools: "all"`（P1 无工具）。
- 会话：固定单主会话 `local-main`；流式回答、多轮上下文、稳定消息 ID、刷新与服务重启恢复、停止/断流/超时/并发拒绝、失败重试去重、陈旧历史拒绝。
- 历史：pi JSONL 是权威来源，客户端每轮完成后 finally GET 同步；客户端传来的 assistant/system/tool/context 不导入 pi。
- 测试：27 项自动测试全部通过（`pnpm test`）；`pnpm typecheck`、`pnpm build` 通过。
- OpenMuse Web 联调已通过：首轮、第二轮、刷新恢复、服务重启恢复、停止后继续发送。iOS/Android 未做模拟器/真机验收。
- 文档：`README.md`、`docs/implementation-plan.md`、`docs/openmuse-api-contract.md`、`docs/pi-reuse.md`、`docs/p1-web-smoke.png`。

## 3. 目录与关键文件

```
personal-bot/
├── package.json          # scripts: dev / start / build / typecheck / test / dev:mock
├── pnpm-workspace.yaml   # rxjs 7.8.1 override（统一 CopilotKit 依赖）
├── src/
│   ├── config.ts         # 环境配置：模型 baseURL/modelId/key、访问 key、端口、DATA_DIR、超时
│   ├── auth.ts           # session token（24h）、访问密钥校验、签名密钥 auth.key
│   ├── pi.ts             # openPi()：ModelRuntime + createAgentSession + 专用 ResourceLoader（P2 工具挂载点）
│   ├── conversation.ts   # 核心协调：validate / run / cancel / history 投影 / AG-UI 事件发出
│   ├── runtime.ts        # PiAgent(AbstractAgent) + 自定义 runner（SSE 退订即取消）
│   ├── app.ts            # Hono 路由全部组装
│   └── index.ts          # 启动入口
├── scripts/dev-mock.ts   # 本地联调：真实 pi + 本地模拟 OpenAI SSE endpoint（8788，不读 .env）
├── tests/
│   ├── fake-model.ts     # 本地 OpenAI-compatible SSE 模拟 provider
│   ├── integration.test.ts
│   └── config-auth.test.ts
├── dist/                 # 构建产物
├── .personal-bot/        # 运行数据（gitignore）：sessions/ workspace/ agent/ auth.key
└── docs/
```

OpenMuse（`/Users/yaotutu/Desktop/code/openmuse`）仅做了最小适配，用户原有 dirty 文件未动（SHA 指纹见 openmuse-api-contract.md）：

- `packages/domain/src/index.ts`：新增可选能力开关 `runtime.serverOwnedHistory` / `textOnly`。
- `apps/mobile/src/chat.tsx`：`!textOnly && ...` 隐藏富功能入口；已有工具卡片渲染逻辑（ToolCallResult / DesktopToolCard），后续展示工具不需要新造卡片。
- `apps/mobile/App.tsx` 相应适配。
- OpenMuse Git HEAD：`1ac68f3909f2478ab6280883f1ab5ea65eb5719d`。

注意：`personal-bot` 目录当前**不是 git 仓库**（无 `.git`）。OpenMuse 才是 git 仓库。建议下一步先在 personal-bot 初始化 git 并提交基线，便于后续 diff/回滚。

## 4. 当前有效目标（上一轮中断处）

> 实现并验证最小工具闭环：用户在 OpenMuse 问当前时间，personal-bot 的 pi 调用只读时间工具，通过 AG-UI 展示工具执行与结果，再生成回答；保留现有聊天、历史、取消和安全边界。使用本地模拟 endpoint 做自动测试和 Web 联调，明确真实模型未配置的验收限制。必要的 OpenMuse 修改限定为展示该工具。完成后再讨论下一次迭代。

上一轮在写交接文档时被用户中断，**时间工具一行代码都还没写**。本次交接以完成该目标为下一轮起点。

## 5. 工具闭环实现要点（下一轮直接按此推进）

### 5.1 后端：注册只读 currentTime 工具

- 修改 `src/pi.ts` 的 `openPi()`：`tools: []`/`noTools: "all"` → 注册一个只读 `currentTime` 工具（零参数或可选 `format`，读本地时间，不碰文件/shell/网络）。
- 不要自造工具协议。已安装 SDK 里有现成定义可参考：
  - `node_modules/.pnpm/@earendil-works+pi-coding-agent@1.1.0_*/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.d.ts`（`Tool = AgentTool<any>`；内置 createReadTool/createReadOnlyTools 等）
  - `node_modules/.pnpm/@earendil-works+pi-agent-core@1.1.0_*/node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts`（Agent 构造/toolExecution）
  - 先核实 `ToolDeclaration`/`ToolExecutionMode`/`AgentState.tools` 实际形状再写，不要拍脑袋。
- 注册时机：SessionManager 是持久化的，工具集合与模型配置相关。注意 `createAgentSession` 的恢复语义——工具默认集合随 session 持久化，若旧 session 无工具而新代码要加工具，需确认 SDK 是否会在恢复时合并（参考 coding-agent 的 Tool 加载逻辑）。

### 5.2 AG-UI 事件适配（conversation.ts 的订阅部分）

- 当前 subscribe 只处理 `text_delta` 和 `message_end`（`src/conversation.ts` 中 `textStarted`/`endText` 那段）。需要补充 pi 的工具事件 → AG-UI 事件：
  - `TOOL_CALL_START`：字段 `toolCallId`、`toolCallName`、`parentMessageId`
  - `TOOL_CALL_ARGS`：`toolCallId`、`delta`（参数增量）
  - `TOOL_CALL_END`：`toolCallId`
  - `TOOL_CALL_RESULT`（= ToolCallResultEvent，不是 TOOL_RESULT）：`messageId`、`toolCallId`、`content`、`role?: "tool"`
- schema 定义在 `node_modules/.pnpm/@ag-ui+core@0.0.59/node_modules/@ag-ui/core/dist/index.d.ts`（EventType 枚举、各事件 schema、BaseEvent eventMap 映射）。
- OpenMuse `apps/mobile/src/chat.tsx` 已有 `toolCalls` 投影与 DesktopToolCard 渲染，因此服务端只要按 AG-UI 事件发出去，前端即可展示。
- 历史投影（`history()`）当前只投影 user/assistant 文本。工具结果是否进入历史由验收决定，先不要过度设计；最小方案是工具调用/结果作为自定义 entry 或透传事件但不在模型上下文重复注入（pi 自己会管理 tool message）。

### 5.3 取消/终态语义不能破坏

- `conversation.ts` 的 `message_end` 会在 SDK 持久化前清洗 `errorMessage`（脱敏）；工具事件若带错误信息也要走同样的脱敏处理，不能把供应商响应/密钥反射给客户端。
- `runtime.ts` 的自定义 runner 保证 HTTP SSE 退订即取消；`waitForIdle()` 在 prompt 后才提交终态。加工具后 pi 会在工具执行前/后多次等待，`waitForIdle` 的语义必须保持，不能因为工具事件提前发 `RUN_FINISHED`。
- 停止/断流/超时路径：`running.reason` 机制不变；工具执行中 abort 也要最终回到 idle。

### 5.4 fake-model 与测试

- `tests/fake-model.ts` 目前只回文本 SSE（支持 fail-once/slow/disconnect/freeze/broken 字面量）。需要扩展为：当用户内容包含触发词（如“现在几点”/“时间”）时，流式返回 OpenAI `tool_calls` chunk，让真实 pi 执行工具后继续出文本；其它内容仍走原文本路径，保证 27 项既有测试不回归。
- 新增 integration test：询问时间 → 工具事件序列（START/ARGS/END/RESULT）→ 文本回答 → 历史/取消/并发不回归。
- 测试 session 文件不应含 mock API key，延续现有断言风格。

### 5.5 Web 联调

- `pnpm dev:mock`（8788）+ OpenMuse `EXPO_PUBLIC_API_URL=http://localhost:8788 pnpm dev:web`（8081），用 cua 验证：发送“现在几点”后卡片/结果可见、回答生成、刷新后状态不坏。
- OpenMuse 若需要展示该工具，只允许小改 `chat.tsx` 或 domain 类型，不扩展其它功能。
- 真实模型未配置时，验收结论要明确写“工具闭环在本地模拟 endpoint 下通过，不等于目标供应商已验收”。

## 6. 约束（硬边界，违规即返工）

- JS/TS 优先函数式；详细中文注释；禁止过度设计（工具闭环保持最小，不做自动重试/压缩、不做记忆/后台任务/文件/任意 shell）。
- 不输出真实 API key、不要求用户在聊天中粘贴密钥；模型 key 只驻留服务端内存。
- 一个进程共用一个 DATA_DIR；不监听非回环地址而不设访问密钥；CORS 不是鉴权。
- 不在 `createAgentSession` 之外手写 agent loop；工具执行与持久化都交给 pi SDK。
- 停止联调临时进程时只杀自己启动的进程树（8788/8081），避免误杀本会话的 cua 内核（如 PID 90621）等无关进程。

## 7. 验收 checklist（下一轮完成后逐项自检）

- [ ] `pnpm typecheck`、`pnpm build`、`pnpm test` 全绿（既有 27 项 + 新增工具测试）。
- [ ] 后端已注册且只注册了只读 currentTime；无文件/shell/网络能力。
- [ ] AG-UI 四类工具事件 schema 校验通过；取消中不会提前 RUN_FINISHED。
- [ ] mock 联调：问时间 → 卡片展示 → 回答生成 → 刷新后历史与工具结果关联正确。
- [ ] 停止/断流/并发/失败重试路径未回归；工具错误信息已脱敏。
- [ ] README 增加“工具闭环已支持 currentTime / 其余未开放”的诚实说明；implementation-plan 整体阶段结构不改。
- [ ] 明确写出真实模型未配置的验收限制。

## 8. 下一步优先级（完成工具闭环之后）

1. 配置目标真实 endpoint 跑同一闭环（文本→工具），确认 Chat Completions 兼容性与工具调用能力。
2. personal-bot 初始化 git 并提交基线（当前无 .git）。
3. iOS/Android 原生端 smoke test（复用同一协议，地址/CORS/网络/SSE 与 Web 一致）。
4. 再进入 P2 的“有限工具 + skills”扩展（读指定资料目录总结等）；P4 后台任务/定时另行评估。

## 9. 参考文档

- `docs/implementation-plan.md`：分阶段计划（P0-P4）与验收门槛。
- `docs/openmuse-api-contract.md`：OpenMuse 客户端接口契约、本地修改 SHA 指纹。
- `docs/pi-reuse.md`：pi 生态选型边界、复用清单、社区候选。
- `README.md`：启动/联调/存储安全说明。
- `tests/*.test.ts` 与 `scripts/dev-mock.ts`：可运行的最小验证样例。
