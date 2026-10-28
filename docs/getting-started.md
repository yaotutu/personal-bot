# 快速上手指南

本文档介绍如何从零配置并启动 Pi Muse 服务端，并与手机客户端连接。完整的配置字段详细说明以 [配置说明](configuration.md) 为唯一权威。

## 环境准备

- **Node.js**：`>= 24`
- **pnpm**：`12.10.1`
- **大模型服务**：任意兼容 OpenAI Chat Completions 协议的接口（需具备 `baseUrl` 与模型 `id`，根据供应商提供对应 `apiKey`）

## 1. 安装与配置

克隆代码仓库并安装依赖：

```sh
git clone https://github.com/yaotutu/pi-muse.git
cd pi-muse
pnpm install
```

初始化配置文件（已存在则直接编辑，不要覆盖）：

```sh
mkdir -p .pi-muse
cp -n config.example.json .pi-muse/config.json
chmod 600 .pi-muse/config.json
```

编辑 `.pi-muse/config.json`，将下方的接口地址、模型名称和密钥替换为自己的值；服务访问密钥请使用足够长的随机值，不要直接沿用示例：

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

### 关键配置区分

- **`model.apiKey` 与 `server.accessKey` 切勿混淆**：
  - `model.apiKey` 是调用外部大模型供应商的 API 凭据，由服务端发起模型请求时使用。
  - `server.accessKey` 是 Pi Muse 服务端的访问密钥，用于手机客户端与 Web 工作台鉴权登录。在局域网或公网部署时务必设置。
- **`model.baseUrl`**：填写 API 根地址（如 `https://api.openai.com/v1`），不要填写完整的 `/chat/completions`。
- **`server.host`**：默认为 `0.0.0.0`，允许所有网卡接入，方便手机在局域网连接；若仅在本机通过网页或命令行访问，可设为 `127.0.0.1`。
- 更多工具与运行时字段见 [配置说明](configuration.md)。

## 2. 启动服务

### 开发调试模式

```sh
pnpm dev
```

该命令以源码监听模式运行，支持热重载，默认监听所有网卡的 `17890` 端口；在服务端本机可通过 `http://127.0.0.1:17890` 访问。

### 生产构建运行

```sh
pnpm build
pnpm start
```

> **注意**：`pnpm start` 启动编译后的 API 接口服务，**不会自动托管静态前端页面**。如需使用开发者 Web 工作台，请参考 [开发指南](development.md)。

### 服务持续在线说明

Pi Muse 服务端承载了后台定时提醒扫描、长期记忆整理（Dream 反思任务）以及网页监控等周期性职责。为了保证提醒按时触发与客户端正常连接，建议将服务端部署在常开的主机或服务器上（如配合 tmux、pm2 或 systemd 等后台管理工具）。

服务重启不会补跑已过期的一次性提醒，失败任务也不会自动重新调用模型或工具。对话流断开会取消所属运行，但已经完成的操作不会因此回滚。

## 3. 连接手机客户端

Pi Muse 用户端以独立移动客户端为主（目前 Android 优先）。

1. **下载安装**：前往 [pi-muse-mobile Releases](https://github.com/yaotutu/pi-muse-mobile/releases) 下载最新 Android 安装包（APK）。
2. **确认网络连通**：
   - 手机可直接通过 HTTP 连接局域网或远程服务端，不要求域名、证书或 HTTPS 反向代理。安全虚拟组网与 HTTPS 均为可选项。
   - **不要在手机上填写 `localhost` 或 `127.0.0.1`**：手机中的 `localhost` 指向手机本机，无法访问电脑上的服务。
   - 若在局域网使用，查询电脑在局域网中的真实 IP 地址（例如 `http://192.168.1.100:17890`），并检查电脑防火墙确保开放 `17890` 端口入站连接。
3. **客户端登录**：
   - 在手机端填入可达的 HTTP 基础地址（如 `http://192.168.1.100:17890` 或 `http://your-server.example:17890`），不要附加 `/api` 或 `/docs`。
   - 在访问密钥处填入配置文件中的 `server.accessKey`。
   - 点击「测试连接」，通过后点击「连接服务器」保存；只测试成功不会自动保存。

## 4. 网络安全边界

- **局域网访问**：当 `server.host` 设置为 `0.0.0.0` 时，必须设置强随机 `server.accessKey`，防止同一局域网内的未授权设备调用。
- **HTTP 与远程访问**：HTTP 正常受支持，服务端端口需允许手机访问；但访问密钥、Token 和聊天内容没有传输加密，AccessKey 不能替代加密。优先在可信网络中使用，HTTPS 或安全虚拟组网作为可选保护，不是启动或连接的前提。
- **实例数据保护**：实例目录 `.pi-muse/` 中包含模型 API key、服务访问密钥、token 签名密钥以及所有明文会话与记忆数据，切勿公开或上传。

## 5. 服务验证

服务启动后，可通过以下接口验证服务状态：

- **健康检查**：`http://127.0.0.1:17890/api/health`（返回服务状态与模型配置是否就绪）
- **接口文档**：`http://127.0.0.1:17890/docs`（Scalar API 交互文档）
- **OpenAPI 规范**：`http://127.0.0.1:17890/openapi.json`

如需无需真实模型凭据的本地开发与全链路联调，请参阅 [开发指南](development.md#无凭据本地联调)。
