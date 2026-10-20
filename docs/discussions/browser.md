# 完整浏览器能力：调研与方案

记录日期：2026-10-18。

**状态：调研完成，方案待确认；未授权实施，未写任何代码。** 本文是可行性记录，不是接口契约。所有实测均在本机临时 profile 完成，已清理，未改动仓库与 `.pi-muse/`。

## 一、需求拆解

用户诉求可以拆成四条，缺一条就不算"完整浏览器"：

1. **有画面**。不是截图轮询，用户能连续看到页面滚动、动画、输入回显。
2. **能完整操作**。地址栏、前进后退、多标签、点击、滚动、悬停、键盘、中文输入、复制粘贴、右键、文件上传下载。
3. **能存登录态**。登录一次，下次打开还在。
4. **Agent 能操作同一个浏览器**。不是另一个沙箱实例，而是用户眼前这个。

第 4 条是分水岭：OpenMuse 满足 3 和 4，不满足 1 和 2。本方案的核心就是补上 1 和 2。

## 二、OpenMuse 的实现与差距

### 2.1 它是什么

服务端 headless Chromium（`chromium.launchPersistentContext`）＋ 自带 loopback 出站代理 ＋ 一个只有 `<img>` 的 HTML 控制台。

- 控制台：`apps/server/src/browser-console.ts`，只渲染一张 PNG，点击换算成 `x/1280*width` 后 POST 回去。
- 刷新：`setInterval(..., 2000)`，两秒一张。
- 输入：只有 `click / text / key / scroll` 四种；按键白名单 16 个（`apps/worker/src/browser.ts`）。
- Agent：`browse_web` / `read_web` 只返回 `{ url, title, innerText }`，模型看不到画面也看不到 DOM 结构。
- 登录态：每 session 一个 `profileDir`，关闭时另存 `storage.json`（只回灌 cookies）。

### 2.2 差距在哪

| 需求 | OpenMuse | 原因 |
| --- | --- | --- |
| 连续画面 | ✗ 2 秒轮询 | 无帧流通道 |
| 滚动/动画 | ✗ | 同上 |
| 悬停、拖拽、右键 | ✗ | 输入协议没有这些事件 |
| 中文输入 | ✗ | 只有 `insertText`，无 IME 组合过程 |
| 复制粘贴 | ✗ | 无剪贴板通道 |
| 文件上传 | ✗ | 无 `fileChooser` 处理 |
| 多标签 | ✗ | 一个 session 一个页面 |
| 浏览器外观 | ✗ | 无地址栏之外的任何 chrome |
| 登录态 | ✓ | 持久化 profile |
| Agent 操作 | △ | 只能读文本，不能可靠点界面 |

### 2.3 值得照搬的部分

网络与凭据边界做得扎实，这部分直接借鉴：

- 逐请求 DNS 校验后直连解析出的 IP，杜绝 DNS rebinding（`network.ts` / `proxy.ts`）。
- 禁 WebSocket、禁 Service Worker、禁 QUIC、禁 WebRTC UDP 泄漏。
- worker token 只走服务端到服务端，`timingSafeEqual` 比较，永不下发客户端。
- 容器 `read_only`、`cap_drop: ALL`、无 secrets。

## 三、显示通道选型（核心）

用户要"有画面"，可选通道有四类。我在本机全部实测了一遍，数据如下。

### 3.1 实测环境

macOS，Google Chrome 155.0.8059.82，Node v24.18.0，临时 profile，JPEG q60。

### 3.2 通道对比

| 通道 | 实测帧率 | 帧延迟 p50 | 带宽 | 覆盖范围 | 音频 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| **CDP `Page.startScreencast`** | 34.5 fps | 21.1 ms | 0.23 MB/s | 仅页面内容 | ✗ | **主通道** |
| **ScreenCaptureKit（macOS 窗口）** | 26.6 fps | — | 需编码 | 整个真实窗口 | ✓ | 可选增强 |
| `screencapture` CLI | 2–3 fps | ~350–590 ms | 0.5–1 MB/帧 | 整个窗口/屏幕 | ✗ | 否决 |
| VNC（x11vnc / 系统屏幕共享） | 未装，参考值 10–30 fps | 50–150 ms | 高 | 整个桌面 | 需额外配置 | 备选 |
| WebRTC | 未测 | 理论最低 | 中 | 视实现 | ✓ | 后置 |

### 3.3 CDP 帧流细节

| 场景 | fps | p50 | p95 | 单帧 | 带宽 |
| --- | --- | --- | --- | --- | --- |
| 1280×800，动画页 | 34.5 | 21.1 ms | 87.6 ms | 6.7 KB | 0.23 MB/s |
| 1280×800，DPR 2 | 35.7 | 20.2 ms | 74.7 ms | 6.7 KB | 0.23 MB/s |
| 1920×1080，动画页 | 16.9 | 38.1 ms | 164.4 ms | 12.8 KB | 0.21 MB/s |
| headed 模式 1280×800 | 36.3 | 19.5 ms | — | — | — |
| 静态页面（无变化） | 0（不发帧） | — | — | — | 0 |

关键结论：

- **帧流是 damage 驱动**。页面不动就不发帧，空闲时几乎零带宽。这对长时间挂着非常友好。
- **1080p 帧率减半**（16.9fps）。1280×800 是甜点，1080p 在快速滚动时会有可感知的顿挫。
- **DPR 2 不增加带宽**，因为 `maxWidth` 已经限定了输出像素；但要真清晰，`maxWidth` 得按物理像素给。
- **后台标签页完全不发帧**（实测 0 帧）。这是硬约束：多标签必须"切到哪个串流哪个"，或者给每个标签单独 attach。

### 3.4 ScreenCaptureKit 细节

macOS 15 已移除 `CGWindowListCreateImage`，必须用 ScreenCaptureKit。

- 实测真实 Chrome 窗口 1280×800，`minimumFrameInterval` 设 1/30，稳定 **26.6 fps**。
- 能捕获**整个真实窗口**：标签条、地址栏、扩展图标、下载气泡、右键菜单，全部在内。
- 需要 TCC「屏幕录制」授权，且必须在有 AppKit 初始化的进程里跑（我第一版没有 `NSApplication.shared` 直接崩在 `CGS_REQUIRE_INIT`）。
- 可同时捕获音频（`capturesAudio = true`），这是 CDP 帧流做不到的。

### 3.5 为什么不选 VNC / WebRTC

- **VNC**：延迟通常 50–150ms，带宽高，需要额外进程（macOS 自带屏幕共享但面向整屏、权限重、并发差）。它的优势是"什么都能看"，但我们的目标是浏览器，不需要整桌面。
- **WebRTC**：延迟和音视频质量最好，但要引入信令、STUN/TURN、编码协商，对一个单用户自托管服务是过重基建。等真需要音频或远程公网访问时再上。

### 3.6 选型结论

**主通道用 CDP `Page.startScreencast`**，理由：

1. 跨平台（macOS/Linux 都能跑，headless 也行），Web 端和移动端都能接。
2. 34fps / 0.23MB/s，局域网和公网都够用。
3. 与 Agent 的控制通道是同一套 CDP，不用维护两条链路。
4. damage 驱动，空闲零开销。

**代价**：只能看到页面内容，看不到浏览器自身的 UI。所以必须**自绘一套浏览器 chrome**（地址栏、标签条、前进后退），这反而比截真实窗口更可控、更像一个产品。

**ScreenCaptureKit 作为 macOS 本地增强**：当服务跑在用户自己的 Mac 上、且用户想看"真窗口"时，提供"打开真实窗口"——此时用户直接看那个窗口就行，根本不需要串流。只有远程/移动端访问才需要把窗口流出去，那时再启用 ScreenCaptureKit。

## 四、控制通道

### 4.1 实测的输入链路

| 操作 | 实测延迟 | 验证方式 |
| --- | --- | --- |
| 点击 → DOM 变化 | 34–53 ms | 按钮计数 0→1 |
| 键盘 5 字符 | 27.9 ms | 输入框实时回显 |
| 中文 `Input.insertText` | 46.3 ms | 值为"你好世界" |
| 滚轮 | 立即生效 | `scrollY` 0→243 |
| 悬停 | 立即生效 | CSS `:hover` 背景变蓝 |
| headed 无焦点输入 | 正常 | 未激活窗口也能点到 |

**headed 模式下 CDP 输入不依赖窗口焦点**，这是好消息：Agent 可以在后台操作，用户不必把窗口切到前台。

### 4.2 输入映射表

| 用户操作 | CDP 方法 |
| --- | --- |
| 移动/点击/双击/右键 | `Input.dispatchMouseEvent`（`mouseMoved` / `mousePressed` / `mouseReleased`，`button: left/right/middle`，`clickCount`） |
| 拖拽 | `mousePressed` → 多次 `mouseMoved` → `mouseReleased` |
| 滚轮 | `Input.dispatchMouseEvent({ type: "mouseWheel", deltaX, deltaY })` |
| 键盘 | `Input.dispatchKeyEvent`（`keyDown` / `keyUp`，带 `windowsVirtualKeyCode`、`code`、`modifiers`） |
| 中文/IME | 组合期间本地显示，`compositionend` 时 `Input.insertText` |
| 粘贴 | 读系统剪贴板 → `Input.insertText`；或 `navigator.clipboard` + 授权 |
| 文件上传 | `Page.setInterceptFileChooserDialog` 拦截 → 客户端选文件 → 上传服务端临时区 → `DOM.setFileInputFiles` |
| 下载 | `Browser.setDownloadBehavior` 指定目录 → 完成后 HTTP 下发 |

### 4.3 实测发现的两个坑

**后台标签页零帧**。`Page.startScreencast` 只对激活标签产帧。多标签方案必须是"切哪个串哪个"：切换时对旧标签 `stopScreencast`、对新标签 `startScreencast`。好处是带宽不翻倍，坏处是切换有约一帧的延迟。

**剪贴板权限按 origin 授予**。`Browser.grantPermissions` 不带 origin 时 `navigator.clipboard.writeText` 抛 `NotAllowedError`；带上 origin 才成功。实测两种都验证过。所以要么给每个访问过的 origin 单独授权（不可行），要么走"服务端剪贴板 + `Input.insertText`"这条路——推荐后者。

## 五、登录态持久化

### 5.1 实测结果

| 关闭方式 | cookie | localStorage |
| --- | --- | --- |
| `Browser.close`（优雅） | ✅ 保留 | ✅ 保留 |
| `SIGTERM` | ❌ 丢失 | ✅ 保留 |
| `SIGKILL` | ❌ 丢失 | ❌ 丢失 |

**结论：cookie 库不保证在 SIGTERM 下落盘。** 这是 Chromium 的已知行为，不是配置问题。

### 5.2 三层保障

1. **优雅关闭**：进程退出流程里必须先 `browser.close()`，再关 HTTP server。现有 `src/index.ts` 已有 shutdown 序列，需要把浏览器加进去且排在前面。
2. **定期快照**：每隔几分钟 `context.storageState({ path })` 写一份，覆盖崩溃场景。这份快照包含 cookies 和 localStorage。
3. **启动回灌**：profile 目录存在就直接用；快照比 profile 新时用 `addCookies` 回灌。

### 5.3 密码本身

浏览器的密码库（Chrome 的 Login Data）受系统钥匙串保护，在自动化环境里通常不可用。**不要把"保存密码"作为需求**：登录态靠 cookie 维持就够了，用户登录一次之后不需要再输密码。如果确实需要存密码，那是独立的凭据管理问题，不能塞进浏览器 profile 里假装安全。

## 六、推荐架构

```
┌─────────────────────────────────────────────────────┐
│  web/ (React)          pagent-mobile (RN)           │
│  自绘浏览器 chrome      同一套协议                     │
│  canvas 渲染帧          WebView 渲染帧                │
└──────────────┬──────────────────────────────────────┘
               │ WebSocket：二进制帧 ↑ / 输入事件 ↓
               ▼
┌─────────────────────────────────────────────────────┐
│  Hono server（单进程，沿用现有 Bearer 鉴权）           │
│                                                     │
│  BrowserService (src/features/browser/)             │
│   · 标签归属、控制权租约、下载/上传、敏感域策略         │
│                                                     │
│  BrowserDriver (src/adapters/browser/)              │
│   · Chromium 生命周期、CDP 会话、帧分发、输入映射      │
└──────────────┬──────────────────────────────────────┘
               │ CDP（WebSocket，127.0.0.1）
               ▼
┌─────────────────────────────────────────────────────┐
│  Chromium（channel: "chrome"，持久化 profile）        │
│   · 用户和 Agent 操作同一个实例、同一份登录态           │
└─────────────────────────────────────────────────────┘
```

### 6.1 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 浏览器二进制 | `playwright-core` + `channel: "chrome"` | 系统 Chrome 有 H.264/AAC/Widevine，反爬表现好；`playwright-core` 不下载 150MB |
| headed / headless | 配置项，本地默认 headed | headed 下 Google/Cloudflare 登录成功率高得多；headless 用于服务器部署 |
| 画面通道 | CDP screencast → WS 二进制帧 | 实测 34fps / 0.23MB/s，跨平台 |
| 输入通道 | WS → `Input.*` | 实测 35–50ms |
| 背压 | 帧真正写入 WS 后才 `screencastFrameAck` | 慢客户端让 Chrome 丢帧，不在服务端堆积 |
| 帧率控制 | 仅在有订阅者时启动 screencast | 无人观看零开销 |
| 登录态 | 全局单一 profile | 用户心智是"我的浏览器"；按 thread 拆 profile 会导致每个会话重新登录 |
| 标签归属 | 服务端记录 `targetId → threadId` | profile 共享登录态，标签可见性按会话收窄 |
| 控制权 | 每标签一个租约，最后操作方持有 N 秒，用户可一键接管 | 避免 Agent 和用户同时拖动 |
| Agent 观察 | 可访问性树 + 元素 ref，主用 ref，坐标兜底 | 比纯坐标可靠；canvas 应用退回截图 |
| 任意 JS | **不向模型暴露 `evaluate`** | 等价于在已登录浏览器里执行任意脚本 |

### 6.2 Agent 工具面

挂在新 `browser` 技能下，5 个工具：

- `browser_navigate({ url })`
- `browser_snapshot()` — 标题、URL、可访问性摘要、可交互元素（`ref`、role、名称、可编辑性）
- `browser_act({ ref?, action, text?, key?, deltaY?, x?, y? })` — `click / type / press / scroll / hover`
- `browser_screenshot()` — 当前视口 PNG（实测 72ms，成本可接受）
- `browser_tab({ action, tabId?, url? })` — `list / new / close / activate`

### 6.3 用户界面

新增一级视图（与 chat/jobs/goals/settings 并列），不是聊天里的卡片：

- 顶部：后退 / 前进 / 刷新 / 地址栏 / 新标签
- 标签条：标注每个标签属于哪个会话
- 主区：`<canvas>` 渲染帧流，透明 `<textarea>` 承接键盘与 IME
- 状态条：显示"用户操作中"或"Agent 操作中"，带接管按钮

Agent 操作时视图实时可见，用户随时可以接管。

## 七、必须解决的难点

| 难点 | 影响 | 方案 | 实测状态 |
| --- | --- | --- | --- |
| **中文 IME** | 不处理无法输入中文 | 透明 textarea 承接组合，`compositionend` 时 `insertText` | `insertText` 已验证，组合浮层未验证 |
| **文件上传** | 原生选择框在截图里看不到 | 拦截 `fileChooser` → 客户端选 → `DOM.setFileInputFiles` | 拦截与设置均验证通过 |
| **下载** | 默认落到服务端临时目录 | `Browser.setDownloadBehavior` → HTTP 下发 | 未验证 |
| **音频** | screencast 不含音频 | v1 不支持；本地 headed 窗口本身有声；远程需 ScreenCaptureKit 或 WebRTC | 未验证 |
| **DRM 视频** | 依赖浏览器二进制 | 系统 Chrome 解决 | 未验证 |
| **多标签** | 后台标签零帧 | 切哪个串哪个 | 已验证 0 帧，切换方案未实现 |
| **高 DPI** | 画面发虚 | `maxWidth = CSS 宽 × DPR` | 已验证 2x 不增带宽 |
| **反爬** | headless 易被挑战 | 默认 headed + 系统 Chrome + 持久 profile | 未验证真实登录流程 |
| **优雅关闭** | SIGTERM 丢 cookie | 退出调 `browser.close()` + 定期快照 | 已验证三种关闭方式差异 |
| **资源占用** | 每个 Chromium 200–400MB | 全局单实例多标签 | 未测长期内存 |

### 7.1 尚未验证的项目

诚实标注，避免把推测当结论：

- Google / Cloudflare / 微信等真实站点的登录与反爬表现。
- DRM 视频（Netflix 等）在系统 Chrome 里的实际可播放性。
- 音频捕获。
- 真实 IME 组合浮层的交互体验（只验证了最终提交）。
- 下载链路。
- 多客户端同时观看同一标签。
- 长时间运行的稳定性与内存增长。
- 移动端 WebView 渲染 canvas 帧流的实际表现。

## 八、安全边界

| 项 | 规则 |
| --- | --- |
| profile 位置 | `<DATA_DIR>/browser/profile`，0700；不在 thread 工作区内，现有文件工具天然访问不到 |
| 私网访问 | 独立配置 `tools.browser.allowPrivateTargets`，默认 false；关闭时走固定 IP 代理防 rebinding |
| 禁止自访问 | 无论配置如何，禁止访问 pi-muse 自身端口与控制面 |
| 提示注入 | 页面内容标记不可信；不暴露 `evaluate`；不读 cookie/localStorage |
| 密码框 | 不向 `input[type=password]` 输入，不返回其值；登录由用户完成 |
| 敏感域 | 可选 `approvalOrigins`，命中时 Agent 的提交类动作走现有 `ActionService` |
| 审批复用 | `ActionKind` 增加 `browser_action`，复用 `submit/poll/decide/cancel` 与过期语义 |
| WS 鉴权 | 浏览器无法给 WebSocket 设 Authorization 头，用短时签名 token 放 query，不写日志 |
| 凭据 | 不注入任何模型 key；profile 与 `config.json` 同级保护，备份按敏感数据处理 |

## 九、与现有架构的接入点

| 文件 | 改动 |
| --- | --- |
| `src/features/browser/`（新增） | 标签归属、控制权租约、下载/上传、敏感域策略；不依赖 Hono 与 pi |
| `src/adapters/browser/`（新增） | Chromium 生命周期、CDP 会话、screencast、输入映射、a11y 快照 |
| `src/adapters/pi/tools/browser.ts`（新增） | 5 个工具定义 |
| `src/adapters/pi/tools/index.ts` | 注册新工具组；`skillToToolsMap` 增加 `browser` |
| `src/adapters/pi/system-prompt.ts` | 删除"No shell, browser..."中的 browser 表述，补不可信与密码框规则 |
| `src/config/load-config.ts` | `tools.browser` schema |
| `src/http/contracts/` | 新增 REST 端点与 DTO |
| `src/http/routes/browser.ts`（新增） | REST 路由 |
| `src/features/actions/types.ts` | `ActionKind` 增加 `browser_action` |
| `web/src/browser/`（新增） | 浏览器视图、canvas 帧渲染、输入采集、标签条 |
| `src/adapters/ag-ui/tool-presentation.ts` | `browser_*` 的摘要投影 |
| `src/adapters/storage/data-layout.ts` | `browserDir`、`browserProfileDir`、下载目录 |

### 9.1 两个前置问题

**WebSocket 支持**。`@hono/node-server` 本身不支持 upgrade，需要引入 `@hono/node-ws`。这是新依赖，需要在实施前确认。

**WS 契约如何进文档**。OpenAPI 不描述 WebSocket。按项目"不手写 OpenAPI"的规则，WS 协议应定义在 `src/http/contracts/` 的类型源中，通过 OpenAPI 扩展字段或 `/docs` 补充段落暴露，并配契约测试。这一点需要先定。

## 十、分期建议

- **P1 可用**：全局单实例、系统 Chrome、headed/headless 可配、帧流 + 鼠标键盘 + IME、地址栏/前进后退/刷新、登录态持久化、4 个 Agent 工具（navigate/snapshot/act/screenshot）。
- **P2 完整**：多标签、下载、上传、控制权租约与接管 UI、密码框保护、敏感域审批。
- **P3 增强**：标签会话恢复、音频、DRM 站点验证、ScreenCaptureKit 本地增强、WebRTC 远程。

## 十一、待确认

1. **本地 vs 远程的优先级**。如果服务只在自己 Mac 上跑，`headed` 模式直接开一个真 Chrome 窗口就是最完整的浏览器，串流只在手机/远程时才需要。这决定 P1 是否必须做帧流。
2. **全局单 profile 是否可接受**。意味着所有会话共享登录态；好处是不用反复登录，代价是没有"工作/个人"隔离。
3. **工具粒度**。5 个独立工具，还是 1 个 `browser` 带 `action` 枚举。
4. **敏感域默认清单**与审批粒度（整站 vs 单次提交）。
5. **WS 帧编码**：二进制（省 33% 带宽）还是 base64 JSON（易调试）。
6. 是否需要"在本地 Chrome 打开当前页"的逃生口。
