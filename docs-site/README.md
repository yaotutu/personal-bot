# Pi Muse 本地文档站

本站使用 VitePress 默认主题，CLI root 为 `docs-site/`，页面来源是 `docs/manual/`。中文页面位于 `docs/manual/*.md`，对应站点根路径 `/`；英文页面位于 `docs/manual/en/*.md`，对应 `/en/`。工程文档、讨论、backlog 和历史验收记录不进入构建或本地搜索。本站只供本地预览，不配置部署。

在仓库根目录安装依赖后运行：

```sh
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

开发与预览固定监听 `127.0.0.1:4174`，端口被占用时退出。中文首页为 `http://127.0.0.1:4174/`，英文首页为 `http://127.0.0.1:4174/en/`。构建结果在 `docs-site/.vitepress/dist/`，缓存也位于 `docs-site/.vitepress/`，均不提交。验证子路径时，先以 `pnpm docs:build --base /pi-muse/` 构建，再以 `pnpm docs:preview --base /pi-muse/` 预览。

中英文页面使用相同的相对路径和 basename，例如中文 `getting-started.md` 对应英文 `en/getting-started.md`。新增、删除或改名页面时，同步维护中文与英文文件及两套导航；对应路径使默认主题的语言切换保留当前主题，配对章节使用相同显式锚点。完整编写与同步要求见[Agent 文档编写指南](../docs/agent-documentation-guide.md)，不在此维护第二套规则。
