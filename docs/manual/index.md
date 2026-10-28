# Pi Muse 手册

本文档对应当前仓库源码，介绍 Pi Muse 服务端和独立移动客户端的安装、连接、日常使用与安全边界。Android 已发布版本的实际功能以[移动客户端 Releases](https://github.com/yaotutu/pi-muse-mobile/releases)及对应版本说明为准；这里不代表新的 APK 已发布。

## 从哪里开始 {#where-to-start}

- [快速上手](getting-started.md)：安装服务端、准备配置并连接手机客户端。
- [核心能力](usage.md)：了解空间、对话、任务、目标、记忆与审批入口。
- [配置说明](configuration.md)：查询服务端配置字段和数据目录。
- [浏览器 Docker 与 noVNC](browser-docker.md)：按需使用带图形界面的浏览器部署。
- [开发入口](development.md)：本地文档站、业务开发和接口文档。
- [常见问题](troubleshooting.md)：排查连接、AccessKey、模型和审批。

仓库内 `web/` 用于 HTTP/SSE 联调与验证；主要产品客户端是独立的移动应用。对接接口请以运行中服务端的 `/docs` 和 `/openapi.json` 为准。
