# Pi Muse 手册

本手册介绍 Pi Muse 服务端和独立移动客户端的安装、连接、日常使用与安全边界。内容按当前仓库源码核对；当前源码不自动等于某个已发布 APK，Android 实际能力以[移动客户端 Releases](https://github.com/yaotutu/pi-muse-mobile/releases)及对应版本说明为准。

## 从哪里开始 {#where-to-start}

- [快速上手](getting-started.md)：安装服务端、连接手机、发送消息并收到回复。
- [对话与空间](conversations-and-spaces.md)：发送和停止对话、切换空间、重置会话与删除空间。
- [附件、文件与审批](files-and-approvals.md)：区分消息附件、工作区文件和模型文件写入审批。
- [任务与网页监控](tasks-and-monitors.md)：创建和管理定时任务、网页监控，查看活动记录。
- [目标与里程碑](goals.md)：建立目标、更新状态与里程碑，区分目标和定时执行。
- [记忆与 Dream](memory-and-dream.md)：管理长期记忆、配置整理并处理待决建议。
- [资料与设置](profile-and-settings.md)：修改助手与用户资料、主题，管理连接、浏览器入口与应用更新。
- [核心能力](usage.md)：查看任务、目标、记忆、浏览器与数据边界概览。
- [配置说明](configuration.md)：查询服务端配置字段和数据目录。
- [浏览器 Docker 与 noVNC](browser-docker.md)：按需使用带图形界面的浏览器部署。
- [开发入口](development.md)：本地文档站、业务开发和接口文档。
- [常见问题](troubleshooting.md)：排查连接、AccessKey、模型、附件和审批。

仓库内 `web/` 用于 HTTP/SSE 联调与验证；主要产品客户端是独立移动应用。对接接口时，以运行中服务端的 `/docs` 和 `/openapi.json` 为准。
