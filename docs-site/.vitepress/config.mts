import { defineConfig } from 'vitepress'

export default defineConfig({
  // srcDir 相对 CLI root（docs-site/）解析；从本配置文件看则是 ../../docs/manual/。
  srcDir: '../docs/manual',
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
  // VitePress 在站点级配置中读取搜索提供者并按 locale 分别建立索引。
  themeConfig: {
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索手册' },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '清除搜索',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有找到相关结果：',
                footer: {
                  selectText: '选择',
                  selectKeyAriaLabel: '回车',
                  navigateText: '切换结果',
                  navigateUpKeyAriaLabel: '上方向键',
                  navigateDownKeyAriaLabel: '下方向键',
                  closeText: '关闭',
                  closeKeyAriaLabel: 'Esc',
                },
              },
            },
          },
          en: {
            translations: {
              button: { buttonText: 'Search', buttonAriaLabel: 'Search the manual' },
              modal: {
                displayDetails: 'Display detailed list',
                resetButtonTitle: 'Reset search',
                backButtonTitle: 'Close search',
                noResultsText: 'No results for',
                footer: {
                  selectText: 'to select',
                  selectKeyAriaLabel: 'enter',
                  navigateText: 'to navigate',
                  navigateUpKeyAriaLabel: 'up arrow',
                  navigateDownKeyAriaLabel: 'down arrow',
                  closeText: 'to close',
                  closeKeyAriaLabel: 'escape',
                },
              },
            },
          },
        },
      },
    },
  },
  // 两种语言的页面 basename 一一对应，默认主题据此切换到另一语言的同一主题。
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Pi Muse 手册',
      description: 'Pi Muse 服务端与移动客户端使用手册',
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
          {
            text: '使用',
            items: [
              { text: '核心能力', link: '/usage' },
              { text: '对话与空间', link: '/conversations-and-spaces' },
              { text: '附件、文件与审批', link: '/files-and-approvals' },
              { text: '任务与网页监控', link: '/tasks-and-monitors' },
              { text: '目标与里程碑', link: '/goals' },
              { text: '记忆与 Dream', link: '/memory-and-dream' },
              { text: '资料与设置', link: '/profile-and-settings' },
              { text: '常见问题', link: '/troubleshooting' },
            ],
          },
          { text: '配置', items: [{ text: '配置说明', link: '/configuration' }] },
          { text: '浏览器', items: [{ text: 'Docker 与 noVNC', link: '/browser-docker' }, { text: 'Viewer 控制桥', link: '/browser-viewer-bridge' }] },
          { text: '开发', items: [{ text: '开发入口', link: '/development' }] },
        ],
        outline: { label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色主题',
        darkModeSwitchTitle: '切换到深色主题',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '返回顶部',
        langMenuLabel: '切换语言',
        skipToContentLabel: '跳转到正文',
        notFound: {
          title: '页面未找到',
          quote: '请检查链接，或返回手册首页。',
          linkLabel: '返回手册首页',
          linkText: '返回首页',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en',
      title: 'Pi Muse Manual',
      description: 'User guide for the Pi Muse server and mobile app',
      themeConfig: {
        nav: [
          { text: 'Start', link: '/en/getting-started' },
          { text: 'Usage', link: '/en/usage' },
          { text: 'Configuration', link: '/en/configuration' },
          { text: 'Browser', link: '/en/browser-docker' },
          { text: 'Development', link: '/en/development' },
        ],
        sidebar: [
          { text: 'Start', items: [{ text: 'Manual home', link: '/en/' }, { text: 'Getting started', link: '/en/getting-started' }] },
          {
            text: 'Usage',
            items: [
              { text: 'Core features', link: '/en/usage' },
              { text: 'Conversations and spaces', link: '/en/conversations-and-spaces' },
              { text: 'Attachments, files, and approvals', link: '/en/files-and-approvals' },
              { text: 'Tasks and webpage monitors', link: '/en/tasks-and-monitors' },
              { text: 'Goals and milestones', link: '/en/goals' },
              { text: 'Memory and Dream', link: '/en/memory-and-dream' },
              { text: 'Profile and settings', link: '/en/profile-and-settings' },
              { text: 'Troubleshooting', link: '/en/troubleshooting' },
            ],
          },
          { text: 'Configuration', items: [{ text: 'Configuration guide', link: '/en/configuration' }] },
          { text: 'Browser', items: [{ text: 'Docker and noVNC', link: '/en/browser-docker' }, { text: 'Viewer control bridge', link: '/en/browser-viewer-bridge' }] },
          { text: 'Development', items: [{ text: 'Development guide', link: '/en/development' }] },
        ],
        outline: { label: 'On this page' },
        docFooter: { prev: 'Previous page', next: 'Next page' },
        darkModeSwitchLabel: 'Appearance',
        lightModeSwitchTitle: 'Switch to light theme',
        darkModeSwitchTitle: 'Switch to dark theme',
        sidebarMenuLabel: 'Menu',
        returnToTopLabel: 'Return to top',
        langMenuLabel: 'Change language',
        skipToContentLabel: 'Skip to content',
        notFound: {
          title: 'PAGE NOT FOUND',
          quote: 'Check the link or return to the manual home page.',
          linkLabel: 'Go to manual home',
          linkText: 'Take me home',
        },
      },
    },
  },
})
