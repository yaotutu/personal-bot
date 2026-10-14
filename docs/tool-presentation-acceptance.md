# 工具展示策略验收

日期：2026-10-12。

## 实现边界

- 仅修改 personal-bot；不修改 OpenMuse 客户端或 pi SDK，不新增工具、不扩大权限。
- `tools.presentation.default` 缺省为 `hidden`；`overrides` 显式开启指定工具的 `summary`。
- hidden 整组过滤工具事件/历史调用与结果；summary 用 `{}` 参数及受控摘要，保持工具名、ID、结果关联和专用 renderer schema。
- 模型仍收到完整工具结果；pi JSONL 保留权威历史。客户端读取、PUT 一致性、完成轮 replay 使用同一展示历史。
- 普通 assistant 文本仍然流式发送，包括工具轮之间的说明和最终回答。模型在回答中引用原数据不是展示层能够阻止的行为。
- 历史投影携带 pi `isError` 给摘要层判断，输出客户端前移除此内部标记；失败不会因刷新被描述为成功。

## 自动化

- `pnpm typecheck`、`pnpm test`（160 项）、`pnpm build`、`git diff --check` 通过。
- 新增 10 项 unit 与 4 项 integration：配置校验、disabled capability override、全部 hidden 工具事件、摘要参数过滤、缺失 START、孤立结果、历史不可变/幂等、工具-only 空消息、搜索结果 schema/错误/边界、历史失败与内部元数据清除。
- HTTP + 真实 pi + fake provider 验证完整 read 结果进入模型和 canonical JSONL，客户端不出现工具消息；GET/PUT、replay、下一轮、重启一致。
- hidden memory 的最终模型失败、超时、Stop 均保留已发生的副作用，不暴露工具卡片，释放锁后可以继续下一轮。Stop 为集成测试验证，不是本轮真实模型 Web Stop 复验。
- 隔离目录中使用编译入口验证 health/SIGTERM 正常退出、端口占用初始化失败后退出、未知 presentation 工具在初始化前拒绝。测试目录已清理。

## 真实模型 / OpenMuse Web DEV

使用受保护真实配置中的模型配置，仅复制到 `0700` 临时实例中的 `0600` config；运行实例与 workspace、memory、jobs、sessions 均隔离。Web 使用既有 8081 DEV 页面，未修改客户端代码；8787 原本无监听，验收期间由隔离实例临时占用。

实际观察：

1. `读资料 acceptance.txt`：真实 read 返回验收口令，聊天仅显示助手回答，无 read 卡片；说明模型执行仍获得结果。
2. `现在几点`：现有 Current time 卡片正常显示 ISO 时间摘要。
3. 明确请求 `search_web`：现有 SearchToolCard 显示 `Found 5 sources` 和来源链接，无 snippet/原始 JSON；模型随后调用 hidden `web_fetch`，页面无该工具卡片。
4. 上海天气、显式记忆、提醒：get_weather 卡片只显示当前/体感温度；memory 卡片只显示“已保存记忆”；schedule 在无效时间时显示失败，在明确 ISO 时间的后续请求中显示“已创建提醒”。记忆和提醒副作用只发生在隔离实例。
5. 第 4 项揭示实时失败与历史摘要不一致，已根据 pi `isError` 修正；用重新构建后的同一隔离实例重启并刷新页面，失败卡片仍显示“工具执行失败”。其余摘要正常、read/web_fetch 卡片仍隐藏。

边界与观察：

- 本轮搜索两次返回了与 Open-Meteo 不相关的来源。这是实测搜索内容质量问题，不是展示兼容成功就能证明搜索质量；未在本次展示改造中修改搜索 transport。模型自行说明来源不相关并抓取官方文档。
- 首次自然语言提醒的模型时间参数无效，按失败真实展示；后续用户明确指定 ISO 时间才创建成功，不把失败伪造成成功。
- 真实模型 Web 的 Stop/取消后换题尚未完成复验；对应状态与副作用链路已由集成测试覆盖，不能冒充 Web 观察。
- 隔离服务已停止，临时凭据副本与测试实例目录已清理；未修改真实 `.personal-bot/` 数据，不自动 commit/push。
