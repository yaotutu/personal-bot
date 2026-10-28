import { defineConfig } from 'vitepress'

export default defineConfig({
  // srcDir 相对 CLI root（docs-site/）解析；从本配置文件看则是 ../../docs/manual/。
  srcDir: '../docs/manual',
  lang: 'zh-CN',
  title: 'Pi Muse 手册',
  description: 'Pi Muse 服务端与移动客户端使用手册',
  vite: {
    build: {
      rollupOptions: {
        output: {
          // 本地搜索的自动生成 chunk 名含 @；产物文件名遵守工作区命名规则。
          sanitizeFileName: (name) => name.replace(/[^A-Za-z0-9._\/-]/g, '-'),
        },
      },
    },
  },
  themeConfig: {
    nav: [
      { text: '开始', link: '/getting-started' },
      { text: '使用', link: '/usage' },
      { text: '配置', link: '/configuration' },
      { text: '浏览器', link: '/browser-docker' },
      { text: '开发', link: '/development' },
    ],
    sidebar: [
      { text: '开始', items: [{ text: '手册首页', link: '/' }, { text: '快速上手', link: '/getting-started' }] },
      { text: '使用', items: [{ text: '核心能力', link: '/usage' }, { text: '常见问题', link: '/troubleshooting' }] },
      { text: '配置', items: [{ text: '配置说明', link: '/configuration' }] },
      { text: '浏览器', items: [{ text: 'Docker 与 noVNC', link: '/browser-docker' }, { text: 'Viewer 控制桥', link: '/browser-viewer-bridge' }] },
      { text: '开发', items: [{ text: '开发入口', link: '/development' }] },
    ],
    search: { provider: 'local' },
  },
})
