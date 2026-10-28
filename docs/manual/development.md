# 开发入口

## 本地文档站 {#local-documentation-site}

在仓库根目录运行 `pnpm docs:dev`，用浏览器打开 `http://127.0.0.1:4174/`。运行 `pnpm docs:build` 生成静态手册，再用 `pnpm docs:preview` 在相同回环端口预览。端口被占用时命令会退出。验证子路径可运行 `pnpm docs:build --base /pi-muse/`，然后用 `pnpm docs:preview --base /pi-muse/` 预览。本站只读取 `docs/manual/`，不会构建工程文档或历史记录。

## 业务本地开发 {#local-business-development}

服务端源码监听入口是 `pnpm dev`；仓库内 Web 联调页是 `pnpm --dir web dev`，默认在 `http://localhost:15173`。需要无凭据交互调试时可用 `pnpm dev:mock`，但它使用 fake provider，不能作为真实后端和外部模型的业务验收。详细流程见 GitHub 上的[服务端开发指南](https://github.com/yaotutu/pi-muse/blob/main/docs/development.md)与[测试规范](https://github.com/yaotutu/pi-muse/blob/main/docs/testing.md)。

## 接口与工程文档 {#apis-and-engineering-documents}

运行中的服务端提供 `/docs` 和 `/openapi.json`，它们是 HTTP/SSE 客户端接入的接口说明；本站是安装与使用手册，不维护第二份接口契约。架构与权限细节见[架构规范](https://github.com/yaotutu/pi-muse/blob/main/docs/architecture.md)，API 开发规则见[API 开发规范](https://github.com/yaotutu/pi-muse/blob/main/docs/api-development.md)。
