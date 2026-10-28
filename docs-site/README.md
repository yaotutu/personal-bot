# Pi Muse 本地文档站

VitePress 默认主题，CLI root 为 `docs-site/`，页面唯一来源是 `docs/manual/`。工程文档、讨论、backlog 和历史验收记录不进入构建或本地搜索。本站只供本地预览，不配置部署。

在仓库根目录安装依赖后运行：

```sh
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

开发与预览固定监听 `127.0.0.1:4174`，端口被占用时退出。构建结果在 `docs-site/.vitepress/dist/`，缓存也位于 `docs-site/.vitepress/`，均不提交。验证子路径时，先以 `pnpm docs:build --base /pi-muse/` 构建，再以 `pnpm docs:preview --base /pi-muse/` 预览。

维护页面时，在 `docs/manual/` 写唯一正文；页内链接使用相对 `.md` 路径，图片等资源路径也相对当前 Markdown 文件。每页写清楚一级标题，并在 `docs-site/.vitepress/config.mts` 的 sidebar 注册新页；主要栏目同时维护 nav。不要复制工程文档或把敏感配置放进手册。
