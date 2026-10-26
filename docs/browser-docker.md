# 真实浏览器 Docker 与 noVNC 使用说明

这个部署把浏览器工作站完整放进一个 Linux 容器：Node 服务、Google Chrome、Xvfb、fluxbox、x11vnc、websockify 和 noVNC 共享同一个虚拟显示。Chrome 仍然是真实带 GUI 的浏览器，不使用 `--headless`；Xvfb 只提供它必须存在的 X display。

## 架构

```text
用户浏览器
  ├── /browser       -> Node API/CDP 视口帧流与受控输入
  └── /vnc.html      -> websockify/noVNC -> x11vnc -> Xvfb -> Chrome 窗口
Agent
  └── 进程内 BrowserService -> Playwright/CDP -> 同一个 Chrome
```

`/browser` 适合产品化标签与视口操作；noVNC 适合观察和接管完整 Chrome 窗口，包括地址栏、标签条、右键菜单、下载气泡等原生浏览器 UI。两者操作的是同一个 Chrome 实例和同一份持久 profile。

## 启动

先准备独立配置。不要把真实模型密钥构建进镜像：

```sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
```

按需要编辑 `.pi-muse/config.json`。只用浏览器时模型可以留空；需要 Agent 对话时填写真实模型配置。然后构建并启动：

```sh
docker compose -f compose.browser.yaml up --build -d
```

访问地址没有写死在服务里，任何能路由到这台机器的地址都可以：

```text
http://<任意主机或域名>:17890/browser
http://<任意主机或域名>:6080/vnc.html?autoconnect=1&resize=scale
```

宿主机端口可改，不需要改代码。例如把 API 映射到 `18890`、GUI 映射到 `16080`：

```sh
PI_MUSE_BROWSER_PORT=18890 \
PI_MUSE_BROWSER_NOVNC_PORT=16080 \
docker compose -f compose.browser.yaml up -d
```

如使用反向代理，API 域名需要转发 `/api`、`/browser`、`/ws/browser`，其中 WebSocket Upgrade 头必须保留；noVNC 域名需要转发 HTTP 和 `/websockify` WebSocket。

## 数据与生命周期

- Chrome profile 持久化在 Docker volume `pi-muse-browser-data` 的 `/app/.pi-muse/browser/profile/`。
- `.pi-muse/config.json` 从宿主机只读挂载到 `/app/browser-config.json`，容器启动时复制到数据 volume 并保持 `0600`；镜像构建上下文明确排除 `.pi-muse`，不会把模型密钥打进镜像层。
- 入口脚本先用 root 修正数据 volume 属主，随后降权到 `pimuse`；Node、Chrome、Xvfb、x11vnc、websockify 和 fluxbox 都不以 root 运行。
- 容器启动完成会主动触发一次标签读取，让 Chrome 窗口立即可见；停止时先给 Node 发送 SIGTERM，Node 优雅关闭 Chrome，入口脚本再回收 fluxbox、x11vnc、websockify 和 Xvfb。
- 默认虚拟屏幕是 `1440x900x24`，可用环境变量 `BROWSER_SCREEN_SIZE` 调整，例如 `1920x1080x24`。
- Google Chrome 官方包当前是 linux/amd64；Apple Silicon 机器需让 Docker 使用 amd64 模拟。

## 验证

```sh
curl -fsS http://127.0.0.1:17890/api/health
curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null
```

打开 noVNC 后应能看到完整 Chrome 窗口。打开 `/browser` 或让 Agent 调用 `tab` / `navigate` 后，noVNC 中会看到同一个窗口的实时变化。
