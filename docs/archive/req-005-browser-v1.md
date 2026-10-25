# REQ-005 浏览器 V1 验收记录

- **验收日期：** 2026-10-25；2026-10-26 按产品要求移除 headless 配置并固定带 GUI 启动。
- **验收范围：** 服务端独立浏览器模块。本页验收 `/browser` 用户调试页与 Agent 工具共享同一个系统 Chrome；不包含移动客户端集成。

## 实施结果

- 使用 `playwright-core` 驱动本机系统 Chrome，Chrome 固定以带 GUI 的真实窗口懒启动，并使用 `DATA_DIR/browser/profile/` 持久 profile；不提供 headless 模式。
- REST 管理全局标签：list、new、close、activate、navigate/back/forward/reload。
- `/browser` 提供地址栏、标签条、画布、鼠标、滚轮、键盘与 IME 输入。
- `/ws/browser` 使用一次性 60 秒 ticket，当前激活标签通过 CDP screencast 推送 JPEG 二进制帧；客户端绘制后 ack，慢客户端跳帧或断开。
- Agent 工具 `navigate`、`snapshot`、`act`、`tab` 与用户调试页共享同一个 `BrowserService`。
- 不提供任意 JavaScript evaluate，不返回 cookie、localStorage 或密码值；页面内容标记不可信。

## 验收结果

- `pnpm typecheck` 通过。
- `node --import tsx --test --test-timeout=90000 tests/integration/browser.test.ts` 通过，覆盖真实系统 Chrome、REST、WS JPEG 多帧、点击/输入、标签切换、一次性 ticket 与 Agent 工具。
- `pnpm test` 通过，531/531（含浏览器独立抽取边界与禁止 headless 配置测试）。
- `pnpm test:e2e` 通过，39/39。
- `pnpm check` 通过（typecheck、test、E2E、Web build 与 diff check）。
- 实际打开当前版本 `/docs`，左侧出现“浏览器”分组，页面无脚本错误。
- 实际打开当前版本 `/browser`，登录后访问本地 fixture，收到连续帧；点击后页面显示 `Clicks:1`，输入框显示 `browser-ui-ok`，页面无脚本错误。
- 使用真实外部模型发起聊天，模型实际调用 `tab`、`navigate`、`snapshot`、`act`、`snapshot`，最终返回 `{"clicks":1,"inputText":"","title":"pi-muse fixture"}`，SSE 以 `RUN_FINISHED` 结束。

## 当前边界

- 本验收不包含移动客户端集成。
- 浏览器连接保持现有 HTTP(S) 与私网默认拒绝策略；Chrome 自身连接未实现 `web_fetch` 的固定 IP pin。
- 崩溃恢复、storageState 定期兜底、下载管理和多 profile 隔离不属于 V1。
