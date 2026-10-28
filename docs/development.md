# 开发与联调指南

本文档面向参与 Pi Muse 服务端与 Web 联调台开发的开发者。核心生产用户端为独立移动客户端，仓库内的 `web/` 是用于接口验证与联调的开发者工作台。

## 开发者 Web 工作台（web/）

### 启动开发服务器

在另一终端启动 Web 开发环境：

```sh
pnpm --dir web dev
```

访问 `http://localhost:15173`。Vite 默认将 `/api` 代理转发至服务端的 `http://127.0.0.1:17890`。

### 代理目标切换（API_TARGET）

当服务端监听在非默认端口时，可通过 `API_TARGET` 环境变量指定代理目标：

```sh
API_TARGET=http://127.0.0.1:18890 pnpm --dir web dev
```

> **注意**：`API_TARGET` 仅影响 Vite 开发服务器的接口代理转发，不会改写服务端实际的监听地址或配置。

### 登录与功能边界

- **登录鉴权**：在 Web 登录页填入配置文件中的 `server.accessKey`（若配置为空则留空进入），切勿填入大模型 `model.apiKey`。
- **功能覆盖**：Web 工作台包含多会话流式交互、定时任务与监控展示、目标列表、身份/记忆设置，以及文件写入/修改的人工审批预览。
- 服务端还提供了会话专属指令、技能开关与清理等 API 接口；未在 Web 页面提供专门管理界面的能力，可通过对话工具或按自动生成的接口文档调用。

### 构建与 PWA 边界

```sh
pnpm --dir web build
pnpm --dir web preview
```

- Web 构建产物包含 Manifest 配置、图标与 Service Worker（仅在生产构建中注册）。
- Service Worker 仅缓存页面外壳和静态资源，`/api/` 接口请求一律不缓存。
- 离线可用范围仅限于页面壳渲染；聊天交互与业务数据流转仍依赖服务端在线。
- PWA 安装与离线行为受浏览器安全上下文限制，建议在 HTTPS 环境下使用；局域网 HTTP 无法获得完整 PWA 支持，且不具备锁屏系统推送能力。

## 无凭据本地联调

无需配置真实大模型或消耗 API 费用，即可使用内置的 Fake Provider 进行服务端全链路与工具调用联调：

```sh
pnpm dev:mock
```

在另一终端启动 Web 并连接至 mock 服务：

```sh
API_TARGET=http://127.0.0.1:17891 pnpm --dir web dev
```

### Mock 运行机制

- mock 服务固定监听 `127.0.0.1:17891`，不读取正式配置 `.pi-muse/config.json`，数据隔离保存在 `.pi-muse/mock/`。
- **常用触发词**：
  - 发送“现在几点”可触发时间工具调用。
  - 发送 `slow` 可测试慢速流式响应与打断停止机制。
  - 更多预置触发词请参阅 [测试规范](testing.md#fake-model-常用触发词)。
- `.pi-muse/mock/` 是持久化的本地联调实例，不是自动化测试的临时目录。

## 代码检查与验证

### 默认完整检查

在提交代码前，执行项目默认检查门禁：

```sh
pnpm check
```

该检查会依次执行：
1. TypeScript 类型检查（`pnpm typecheck`）
2. 单元测试与集成测试（`pnpm test`）
3. 真实构建后的 dist 进程端到端测试（`pnpm test:e2e`）
4. Web 前端构建（`pnpm --dir web build`）
5. Git 差异检查（`git diff --check`）

> **验收边界注意**：`dev:mock` 仅用于前端与交互无凭据开发，默认 `pnpm check` 亦不调用真实大模型。它们**均不能代替真实后端与外部模型的全链路验收**。根据 [测试规范](testing.md)，涉及真实能力验证必须连接真实后端并调用外部大模型接口。

### 真实模型验收测试（Live）

针对真实模型与外部工具链路的验收：

```sh
pnpm test:live --config .pi-muse/config.json --allow-live
```

> `test:live` 仅在显式传入 `--config` 与 `--allow-live` 时运行，不会随 `pnpm check` 隐式触发。详细的验收标准与证据要求请参阅 [测试规范](testing.md)。

## 相关开发文档

- [架构规范](architecture.md)：职责边界、隔离机制、文件审批与新能力接入
- [配置说明](manual/configuration.md)：完整字段说明、实例目录树与展示策略
- [测试规范](testing.md)：测试分层、证据标准与回归要求
- [API 开发规范](api-development.md)：HTTP/SSE 契约设计与文档生成
- [pi 复用边界](pi-reuse.md)：SDK 集成边界与升级核对
