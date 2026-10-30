# 快速上手指南

本页介绍从零配置并启动 Pi Muse 服务端，连接 Android 手机客户端，发送消息并收到回复。完整配置字段以[配置说明](configuration.md)为准；空间管理、附件、工作区文件和审批的日常操作分别见[对话与空间](conversations-and-spaces.md)和[附件、文件与审批](files-and-approvals.md)。

本手册按当前仓库源码核对编写；源码能力不自动等于 [pi-muse-mobile Releases](https://github.com/yaotutu/pi-muse-mobile/releases) 中某个已发布 APK 的能力。使用发布版时，以该版本实际界面和版本说明为准。

## 前提 {#prerequisites}

- **Node.js**：`>= 24`
- **pnpm**：`12.10.1`
- **大模型服务**：任意兼容 OpenAI Chat Completions 协议的接口，需要可用的 `baseUrl`、模型 `id` 和供应商提供的 `apiKey`。若希望模型理解图片，所配置模型还必须自身支持图片输入。
- **手机客户端**：Android 优先；当前手册中的手机入口来自移动端源码核对，不等同于已发布 APK 的实测结论。

## 安装与配置 {#install-and-configure}

1. 在准备运行服务端的主机上克隆代码并安装依赖：

   ```sh
   git clone https://github.com/yaotutu/pi-muse.git
   cd pi-muse
   pnpm install
   ```

2. 初始化配置文件。若 `.pi-muse/config.json` 已存在，直接编辑它，不要覆盖：

   ```sh
   mkdir -p .pi-muse
   cp -n config.example.json .pi-muse/config.json
   chmod 600 .pi-muse/config.json
   ```

3. 编辑 `.pi-muse/config.json`，把示例值替换为自己的服务地址、模型和密钥。`server.accessKey` 使用足够长的随机值，不要沿用示例：

   ```json
   {
     "schemaVersion": 1,
     "server": {
       "host": "0.0.0.0",
       "port": 17890,
       "accessKey": "your-secure-access-key"
     },
     "model": {
       "baseUrl": "https://your-provider.example/v1",
       "id": "your-model-id",
       "apiKey": "your-model-api-key"
     }
   }
   ```

### 关键配置区分 {#important-configuration-distinctions}

- **`model.apiKey` 与 `server.accessKey` 切勿混淆**：
  - `model.apiKey` 是调用外部大模型供应商的 API 凭据，只由服务端使用。
  - `server.accessKey` 是 Pi Muse 服务端访问密钥，用于手机客户端和 Web 工作台换取会话 Token。
- **`model.baseUrl`** 填 API 根地址，例如 `https://api.openai.com/v1`，不要追加完整的 `/chat/completions`。
- **`server.host`** 默认 `0.0.0.0`，监听所有网卡，便于手机从局域网访问；若只在本机访问，可设为 `127.0.0.1`。
- 更多工具与运行时字段见[配置说明](configuration.md)。

## 启动服务 {#start-service}

开发调试模式：

```sh
pnpm dev
```

该命令以源码监听模式运行，默认监听所有网卡的 `17890` 端口；在服务端本机可访问 `http://127.0.0.1:17890`。

生产构建运行：

```sh
pnpm build
pnpm start
```

`pnpm start` 启动编译后的 API 服务，不会自动托管开发者 Web 工作台；如需工作台，见[开发入口](development.md)。

Pi Muse 服务端还承载定时提醒扫描、Dream 记忆整理和网页监控等周期性职责。为保证提醒和客户端连接可用，建议部署在常开主机上，并按需要使用 tmux、pm2 或 systemd 等进程管理工具。

服务重启不会补跑已过期的一次性提醒，失败任务也不会自动重新调用模型或工具。聊天流断开会取消所属运行，但已经完成的工具操作不会回滚。

## 连接手机客户端 {#connect-mobile-client}

1. 从 [pi-muse-mobile Releases](https://github.com/yaotutu/pi-muse-mobile/releases) 下载并安装与你设备架构匹配的 Android APK。安装前核对该 Release 说明；不要把当前服务端源码能力当成 APK 已有能力。
   iOS 用户只有在对应 Release 实际提供 `app-release-unsigned.ipa` 时，才可下载后使用自己的有效证书和描述文件重新签名安装。未签名 IPA 不能直接安装；它不是 App Store 或 TestFlight 分发，也不走 Android 应用内更新。
2. 确认手机能访问服务端：
   - 手机可直接通过 HTTP 连接局域网或远程服务端；域名、证书和 HTTPS 反向代理都不是必需项。
   - 不要在手机上填写 `localhost` 或 `127.0.0.1`。手机里的 `localhost` 指向手机自身，不是运行服务端的电脑。
   - 局域网使用时，填写电脑的真实局域网地址，例如 `http://192.168.1.100:17890`，并确认电脑防火墙允许 `17890` 入站。
3. 打开 Pi Muse，进入底部「设置」页，点击「连接与设备」中的「服务器连接」（Server Connection）。
4. 在「服务器连接」页填写：
   - 「服务器地址」：服务端基础地址，不带 `/api`、`/docs` 或路径末尾斜杠。
   - 「访问密钥」：配置文件中的 `server.accessKey`，不是 `model.apiKey`。
5. 点击「测试连接」。成功时界面显示「测试通过，尚未保存」。
6. 点击「连接服务器」。成功后面板关闭，连接状态显示「已连接」。

测试等待中可点击「取消测试」或关闭面板，不会保存草稿；保存或清理本机缓存期间需等操作结束。只点击「测试连接」不会保存配置。若改为其他服务器地址，客户端会先要求确认清理本机业务缓存和旧凭据；该操作不会删除远端服务器数据。

## 发送消息并收到回复 {#send-first-real-reply}

1. 回到底部「聊天」页。首次使用会显示「主空间」和「有什么想聊的？」。
2. 在输入框占位符「消息」中输入一条简短、可验证的请求，例如让它回答一个你知道答案的问题。
3. 点击输入框右侧的发送箭头。发送后可以看到你的消息气泡，顶部状态会显示执行中。
4. 等待助手回复完成。真实回复会流式显示在聊天页；若模型调用工具，工具状态会以工具卡或会话面板中的动态展示。

如果聊天页显示模型未配置、连接断开或需要重新认证，先按[常见问题](troubleshooting.md)排查，不要连续重发同一条消息。发送附件见[附件、文件与审批](files-and-approvals.md#send-attachments)；停止运行、重新同步和结果未明见[对话与空间](conversations-and-spaces.md#send-and-stop-conversations)。

## 网络安全边界 {#network-security-boundaries}

- **局域网访问**：`server.host` 为 `0.0.0.0` 时必须设置强随机 `server.accessKey`，防止同一局域网内的未授权设备调用。
- **HTTP 与远程访问**：HTTP 可正常连接，但 AccessKey、Token 和聊天内容没有传输加密。优先在可信网络使用；HTTPS 或安全虚拟组网是可选增强，不是启动或连接前提。
- **实例数据保护**：`.pi-muse/` 包含模型 API key、服务访问密钥、token 签名密钥以及明文会话和记忆数据。不要公开目录或上传备份。

## 验证服务 {#verify-service}

服务启动后，可在服务端本机检查：

- **健康检查**：`http://127.0.0.1:17890/api/health`，返回服务状态和模型配置是否就绪。
- **接口文档**：`http://127.0.0.1:17890/docs`，由当前运行实例自动生成。
- **OpenAPI 规范**：`http://127.0.0.1:17890/openapi.json`。

健康检查通过不等于模型请求可用。请以手机成功发送消息并收到外部模型的回复，确认安装、连接与模型配置这条链路已打通。
