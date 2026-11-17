import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

const REPO = 'https://github.com/bookqaq/better-zetsumeow-driver'
const RELEASES = `${REPO}/releases`

/** A version string used by the docs page and the nav badge. */
function readJsonVersion(relativePath: string): string {
  const file = fileURLToPath(new URL(relativePath, import.meta.url))
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
}

const userscriptVersion = readJsonVersion('../../../../packages/zmeow-userscript/package.json')
const sdkVersion = readJsonVersion('../../../../packages/zmeow-sdk/package.json')

/**
 * Deployment base path. `/` for a dedicated domain, `/manual/` for a subpath.
 * VitePress requires a leading and trailing slash.
 */
function normalizeBase(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return '/'
  let base = raw.trim()
  if (!base.startsWith('/')) base = `/${base}`
  if (!base.endsWith('/')) base = `${base}/`
  return base
}

const base = normalizeBase(process.env.MANUAL_BASE)
const description =
  'Better ZetsuMeow Driver 用户手册：安装、面板说明、配置备份与还原、Wooting 配置导入、更新与常见问题。'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Better ZetsuMeow Driver',
  description,
  base,
  cleanUrls: false,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#0f766e' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Better ZetsuMeow Driver 用户手册' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],

  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
  },

  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'Better ZetsuMeow Driver 手册',

    nav: [
      { text: '安装', link: '/install', activeMatch: '^/install' },
      { text: '使用', link: '/panel', activeMatch: '^/(panel|backup|restore|wooting)' },
      { text: '常见问题', link: '/faq', activeMatch: '^/(faq|limits|privacy|update)' },
      { text: `v${userscriptVersion}`, link: RELEASES },
    ],

    sidebar: [
      {
        text: '开始',
        items: [
          { text: '简介与快速开始', link: '/' },
          { text: '安装', link: '/install' },
          { text: '界面说明', link: '/panel' },
        ],
      },
      {
        text: '使用',
        items: [
          { text: '备份配置', link: '/backup' },
          { text: '还原配置', link: '/restore' },
          { text: '导入 Wooting 配置', link: '/wooting' },
        ],
      },
      {
        text: '参考',
        items: [
          { text: '更新', link: '/update' },
          { text: '常见问题', link: '/faq' },
          { text: '已知限制', link: '/limits' },
          { text: '数据与隐私', link: '/privacy' },
        ],
      },
    ],

    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: false,
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色主题',
    darkModeSwitchTitle: '切换到深色主题',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    langMenuLabel: '语言',

    editLink: {
      pattern: `${REPO}/edit/main/apps/manual/docs/:path`,
      text: '在 GitHub 上编辑此页',
    },

    socialLinks: [{ icon: 'github', link: REPO }],

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档',
          },
          modal: {
            noResultsText: '没有找到相关内容',
            resetButtonTitle: '清除查询',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    notFound: {
      title: '页面不存在',
      quote: '链接可能已过期。请从左侧目录重新进入，或回到首页。',
      linkLabel: '返回首页',
      linkText: '返回首页',
    },

    footer: {
      message: '基于 MIT 许可证发布 · 本项目与 ZetsuMeow、Wooting 无隶属关系',
      copyright: 'Better ZetsuMeow Driver',
    },
  },

  vite: {
    define: {
      __MANUAL_VERSION__: JSON.stringify(userscriptVersion),
      __MANUAL_SDK_VERSION__: JSON.stringify(sdkVersion),
    },
  },
})
