# 常见问题

## 手机连不上服务端 {#phone-cannot-connect-to-server}

确认服务端进程正在运行、端口可达，客户端填写的是服务端基础地址，不带 `/api` 或 `/docs`。真机里的 `localhost` 指向手机自身；局域网连接应填写电脑的局域网地址。先在服务端本机访问 `/api/health`，再检查手机到服务端的网络和防火墙。

## AccessKey 被拒绝 {#access-key-rejected}

客户端要填写 `server.accessKey`，不是 `model.apiKey`。核对当前服务端所读配置及重启后的生效值；更换 AccessKey 会使旧 Token 失效，需要重新连接。不要把任何密钥贴到公开日志或问题报告里。

## 模型没有回复 {#no-model-reply}

检查 `model.baseUrl`、`model.id` 和 `model.apiKey` 是否对应同一个可用模型服务，并查看服务端的受控错误信息。模型服务出错后不会自动重试；如果前一轮执行了写入或其他操作，应先核对实际结果，再决定是否重新发起请求。

## 文件修改没有生效 {#file-modification-did-not-take-effect}

`write` 和 `edit` 每次都需要独立人工审批。请在客户端查看完整修改预览及审批状态；拒绝、过期、文件在等待时发生变化或运行取消，都会阻止该次提交。结果不明时先读取目标文件确认现状，不自动重发写操作。

配置字段与权限边界见[配置说明](configuration.md)，开发和接口排查入口见[开发入口](development.md)。
