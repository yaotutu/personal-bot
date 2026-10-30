# 真实浏览器 Docker 与 noVNC 使用说明

这个部署把浏览器工作站完整放进一个 Linux 容器：Node 服务、Google Chrome、Xvfb、fluxbox、x11vnc、websockify 和 noVNC 共享同一个虚拟显示。Chrome 仍然是真实带 GUI 的浏览器，不使用 `--headless`；Xvfb 只提供它必须存在的 X display。

浏览器标签识别要求 Chrome 150 或更高版本。打开 `/browser` 帧流后，在 noVNC 中手工切换原生标签会在约 1 秒内同步当前标签和帧流；没有帧流订阅时不会运行周期探测。Chrome 缺少所需原生标签元数据时，浏览器操作返回受控错误，不回退到页面 DOM 可见性或标签顺序猜测。

## 架构 {#architecture}

```text
用户浏览器（只连服务端同地址）
  ├── /browser                  -> Node API/CDP 视口帧流与受控输入
  └── /browser/desktop/vnc.html -> 同源桌面网关（一次性 ticket + HttpOnly cookie）
                                     -> websockify/noVNC -> x11vnc -> Xvfb -> Chrome 窗口
Agent
  └── 进程内 BrowserService -> Playwright/CDP -> 同一个 Chrome
```

noVNC/websockify 只在容器内绑定 127.0.0.1（`tools.browser.desktopPort`，默认 6080），不再发布到宿主机；所有桌面流量经服务端同源 `/browser/desktop/` 前缀代理，由 Bearer 换取的一次性 ticket 和短期 HttpOnly 会话 cookie 把关。

`/browser` 适合产品化标签与视口操作；noVNC 适合观察和接管完整 Chrome 窗口，包括地址栏、标签条、右键菜单、下载气泡等原生浏览器 UI。两者操作的是同一个 Chrome 实例和同一份持久 profile。移动版页面只做触控、缩放和软键盘适配，不添加自定义浏览器外壳或地址栏。

## 启动 {#startup}

在服务端仓库根目录执行以下命令。先准备独立配置；不要把真实模型密钥构建进镜像：

```sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
```

按需要编辑 `.pi-muse/config.json`。只用浏览器时模型可以留空；需要 Agent 对话时填写真实模型配置。然后构建并启动：

```sh
docker compose -f compose.browser.yaml up --build -d
```

API 与桌面都走同一个服务地址，任何能路由到这台机器的地址都可以：

```text
http://<任意主机或域名>:12330/browser
http://<任意主机或域名>:12330/api/browser/status
```

打开完整远程桌面只需两步（不再需要单独的 noVNC 端口或 SSH 隧道）：

```sh
# 1. 用 Bearer token 换一次性 60 秒 ticket
curl -fsS -X POST http://<主机>:12330/api/browser/desktop-ticket \
  -H "Authorization: Bearer <session-token>"
# => {"launchPath":"/browser/desktop/launch?ticket=...","expiresAt":"..."}

# 2. 在浏览器打开同源 launch 地址，服务端签发 HttpOnly cookie 后自动进入桌面
#    http://<主机>:12330/browser/desktop/launch?ticket=...
```

`/browser` 页面需手动输入 AccessKey 登录；登录成功后输入框会清空，当前标签会话只保存 Session Token。不要在链接中附加密钥：页面不使用 `accessKey` 或 `key` 查询参数登录，并会将其从地址栏移除。连接中断后，点击 **Reconnect** 重新同步标签与画面；不会自动重发导航、新建或关闭等操作。该调试页支持中文输入、文本粘贴和左、中、右鼠标按键，但不包含完整 Chrome 的原生菜单；完整窗口使用 `/browser/desktop/` 桌面。

桌面和手机共用 `/browser/desktop/vnc.html` 入口：默认 `layout=auto`，视口宽度不超过 700px 时自动切到移动页，恢复桌面宽度后自动回到官方 noVNC。显式 `layout=desktop` 或 `layout=mobile` 会固定当前页面，不因窗口尺寸导航。跳转会保留查询和 `#` 参数。移动页默认连接同源 `/browser/desktop/websockify`，也支持通过查询参数覆盖 `path`、`host` 或 `port`。

::: danger 远程桌面访问边界
桌面会话 cookie 只授予查看与操作整个远端桌面的完整能力，包括已登录的网站。ticket 一次性且 60 秒过期，会话 cookie 1 小时到期不续期。HTTP 明文部署下桌面流量不加密，仅在可信网络使用；HTTPS 终止反代当前不受支持（cookie 的 Secure 标记与 WS Origin 校验按直连协议判定）。手机客户端暂未接入桌面入口。
:::

真实浏览器由服务端配置；手机客户端不保存桌面地址，也不提供打开入口。需要查看远端桌面时，用上面的 ticket 流程在系统浏览器中打开同源 launch 地址。

## 文件上传与下载 {#files}

`/browser` 连接成功后，工具栏的 **Files** 会打开文件面板。只有面板打开且连接仍在线时，面板才每 2 秒读取当前待上传 chooser 和下载记录；关闭面板或断线会停止轮询。单次读取失败会保留上一次列表并显示错误，随后继续轮询，不能把失败当成空列表。

上传必须由远端真实页面的 filechooser 事件发起：

1. 在远端页面点击网站的上传按钮，触发页面 filechooser；Playwright 会截获该 chooser，不需要等待远端原生文件选择器。
2. 在 Files 面板看到对应的待上传项后，在该面板选择本机文件。
3. 明确点击 **Upload**。服务端只把这次选择的内存字节交给页面；不会读取服务端路径、workspace 或模型文件工具。

单选 chooser 只能提交 1 个文件，多选允许 1 到 4 个，原始字节合计最多 8MiB。文件名只允许 ASCII 字母、数字、点、下划线和连字符，且不能以点开头；空 MIME 类型按 `application/octet-stream` 处理。点击 **Cancel** 只删除该待上传项，不会用空选择清掉页面已有文件。页面主导航、标签关闭或新 chooser 出现后，旧项会失效；再次提交返回 404。

下载来自远端页面的 Playwright download 事件。完成的下载可在 Files 面板点击 **Save** 保存到当前设备；删除前会要求确认。单个完成下载上限为 32MiB，超过上限或下载失败会标记为 failed，不保留为可读取的 completed 内容。进行中的下载没有可读取内容，读取会返回冲突而不是半截文件。

下载记录保存在 Docker volume 的 `/app/.pi-muse/browser/downloads/<uuid>/`，包含 `content` 与 `meta.json`，权限分别受保护。容器重启后，completed 记录仍可读取；中断的 downloading 记录会标记为 failed，不会自动重新下载。该目录不属于 workspace，普通模型文件工具不能读取。

### 外部工具条与内置栏 {#external-toolbar-and-built-in-bar}

官方桌面页和手机页都暴露 `window.piMuseViewer` 控制桥。默认保留各自工具条；在 URL 查询或片段中加 `toolbar=hidden` 会隐藏页面工具条、状态和重连覆盖，但远端画布仍可操作。`toolbar.set` 可再次显示它。桥接命令与事件字段见 [viewer bridge 说明](browser-viewer-bridge.md)。

取得桌面会话 cookie 后，访问同源桌面路径下的 `/browser/desktop/viewer-bridge-demo.html`，可用一套静态外部工具条操作 iframe 中的真实桌面：连接、按键、文字、剪贴板、缩放和内置栏显示。默认嵌入 `vnc.html?autoconnect=1&resize=scale&toolbar=hidden&layout=desktop`，固定桌面布局，避免容器尺寸变化时跳页。输入框只接受同源相对 viewer 路径，不填写 IP；当前网关只允许同源 iframe，桥协议的 `parentOrigin` 参数不会解除网关限制。全屏由演示页按钮直接进入 iframe 容器；跨窗口命令和手机软键盘不能保证保留用户手势。

宿主机端口可改，不需要改代码。例如把服务映射到 `18890`：

```sh
PI_MUSE_BROWSER_PORT=18890 docker compose -f compose.browser.yaml up -d
```

如使用 HTTP 反向代理，域名需要转发 `/api`、`/browser`、`/ws/browser` 与 `/browser/desktop/`，保留原始 `Host`、`Origin` 和两处 WebSocket Upgrade 头。桌面 WebSocket 要求 `Origin` 与服务端实际连接协议和 `Host` 一致；当前不支持 HTTPS 终止反代。

### 手机竖屏实例 {#mobile-portrait-instance}

Compose 里提供独立的 `mobile` profile。它使用 `720x1280x24` 虚拟屏幕和独立 Chrome profile volume，不影响默认桌面实例；默认宿主端口为 `18891`：

```sh
docker compose -f compose.browser.yaml --profile mobile up -d pi-muse-browser-mobile
```

访问：

```text
http://<任意主机或域名>:18891/api/health
http://<任意主机或域名>:18891/browser/desktop/launch?ticket=...
```

移动实例同样不发布 noVNC 端口；桌面访问走各自服务地址的同源 `/browser/desktop/` 网关。

两个实例可以同时运行。需要同时重建时执行：

```sh
docker compose -f compose.browser.yaml --profile mobile up --build -d
```

## 数据与生命周期 {#data-and-lifecycle}

- Chrome profile 持久化在 Docker volume `pi-muse-browser-data` 的 `/app/.pi-muse/browser/profile/`。
- 浏览器下载持久化在 `/app/.pi-muse/browser/downloads/`，每个 UUID 目录只放 `content` 与 `meta.json`；目录和文件权限受保护，不进入 workspace。
- `.pi-muse/config.json` 从宿主机只读挂载到 `/app/browser-config.json`，容器启动时复制到数据 volume 并保持 `0600`；镜像构建上下文明确排除 `.pi-muse`，不会把模型密钥打进镜像层。
- 入口脚本先用 root 修正数据 volume 属主，随后降权到 `pimuse`；Node、Chrome、Xvfb、x11vnc、websockify 和 fluxbox 都不以 root 运行。
- 容器启动完成会主动触发一次标签读取，让 Chrome 窗口立即可见；停止时入口脚本只先给独立 Node 进程发送 SIGTERM 并等待其完成，Node 优雅关闭 Chrome 后才回收 fluxbox、x11vnc、websockify 和 Xvfb，确保 X server 在 Chrome 退出及 profile 写入期间保持存活。入口脚本不另设等待超时；超过 Docker stop grace period 时由 Docker 最终硬终止。
- 默认虚拟屏幕是 `1440x900x24`，可用环境变量 `BROWSER_SCREEN_SIZE` 调整，例如 `1920x1080x24`。
- Google Chrome 官方包当前是 linux/amd64；Apple Silicon 机器需让 Docker 使用 amd64 模拟。

## 验证 {#verification}

```sh
curl -fsS http://127.0.0.1:12330/api/health
curl -fsS -X POST http://127.0.0.1:12330/api/browser/desktop-ticket \
  -H "Authorization: Bearer <session-token>"
```

用返回的 `launchPath` 打开桌面后应能看到完整 Chrome 窗口。打开 `/browser` 或让 Agent 调用 `tab` / `navigate` 后，桌面里会看到同一个窗口的实时变化。

`viewer-bridge-demo.html` 是静态验收工具，不是浏览器业务客户端。后续改动桥、布局或输入逻辑时，需要复验真实浏览器里的 iframe 控制、工具条遮挡、连接恢复和手机输入。
