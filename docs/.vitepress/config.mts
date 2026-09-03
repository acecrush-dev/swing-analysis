import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Swing-Analysis',
  description: 'AceCrush Swing-Analysis — automated tennis swing detection, segmentation, and skeleton-overlay preview generation.',

  // Project page lives at https://<owner>.github.io/<repo>/, so all generated
  // absolute URLs (/, /zh/, /guide/, /zh/guide/) get prefixed with this base.
  // For local dev `npm run docs:dev` serves at http://localhost:5173/swing-analysis/.
  base: '/swing-analysis/',

  // VitePress serves files from docs/public/ at the site root (with base prepended).
  // Override head tags only if you need to add PWA / theme-color metadata; the
  // default favicon resolution from docs/public/ is fine for Swing-Analysis.
  head: [
    ['meta', { name: 'theme-color', content: '#2DBA68' }]
  ],

  // The docs cross-reference vendored source files (e.g. ../../backend/core/...)
  // and the project root LICENSE which exist on disk but aren't part of the
  // static-site URL space — those are reference links, not navigable pages.
  // Ignore them so docs:build doesn't fail on dead-link checks.
  ignoreDeadLinks: true,

  // English is the site root (default); Chinese under /zh/
  // Source layout mirrors URLs directly: docs/ ↔ /, docs/guide/ ↔ /guide/,
  // docs/zh/ ↔ /zh/, docs/zh/guide/ ↔ /zh/guide/ — no rewrites needed.
  //
  // 📑 When adding a new chapter under docs/guide/ or docs/zh/guide/:
  //    1. Create the .md file
  //    2. Add a row to the table in docs/index.md and docs/zh/index.md
  //    3. Add the entry to the appropriate sidebar group below.
  //       VitePress does NOT auto-discover pages — sidebar and nav are
  //       explicit lists.
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Index', link: '/' },
          { text: 'Guide', link: '/guide/00-introduction' },
          { text: 'CLI', link: '/guide/03-cli-usage' },
          { text: 'REST API', link: '/guide/04-rest-api' },
          { text: 'GUI', link: '/guide/05-electron-gui' }
        ],
        sidebar: {
          // Home page — section header itself acts as the link to /.
          '/': [
            {
              text: 'Index',
              link: '/'
            },
            {
              text: 'Guide',
              items: [
                { text: '00 · Introduction', link: '/guide/00-introduction' },
                { text: '01 · Getting Started', link: '/guide/01-getting-started' },
                { text: '02 · Architecture', link: '/guide/02-architecture' }
              ]
            },
            {
              text: 'Reference',
              items: [
                { text: '03 · CLI Usage', link: '/guide/03-cli-usage' },
                { text: '04 · REST API', link: '/guide/04-rest-api' },
                { text: '05 · Electron GUI', link: '/guide/05-electron-gui' }
              ]
            },
            {
              text: 'Deep Dive',
              items: [
                { text: '06 · Algorithm', link: '/guide/06-algorithm' },
                { text: '07 · Troubleshooting', link: '/guide/07-troubleshooting' },
                { text: '08 · Build & Package', link: '/guide/08-build-package' }
              ]
            }
          ],
          // Guide subpages — top entry is a back link to the index.
          '/guide/': [
            {
              text: '← Index',
              link: '/'
            },
            {
              text: 'Guide',
              items: [
                { text: '00 · Introduction', link: '/guide/00-introduction' },
                { text: '01 · Getting Started', link: '/guide/01-getting-started' },
                { text: '02 · Architecture', link: '/guide/02-architecture' }
              ]
            },
            {
              text: 'Reference',
              items: [
                { text: '03 · CLI Usage', link: '/guide/03-cli-usage' },
                { text: '04 · REST API', link: '/guide/04-rest-api' },
                { text: '05 · Electron GUI', link: '/guide/05-electron-gui' }
              ]
            },
            {
              text: 'Deep Dive',
              items: [
                { text: '06 · Algorithm', link: '/guide/06-algorithm' },
                { text: '07 · Troubleshooting', link: '/guide/07-troubleshooting' },
                { text: '08 · Build & Package', link: '/guide/08-build-package' }
              ]
            }
          ]
        }
      }
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '文档索引', link: '/zh/' },
          { text: '使用指南', link: '/zh/guide/00-introduction' },
          { text: 'CLI', link: '/zh/guide/03-cli-usage' },
          { text: 'REST API', link: '/zh/guide/04-rest-api' },
          { text: 'GUI', link: '/zh/guide/05-electron-gui' }
        ],
        sidebar: {
          '/zh/': [
            // Section header itself acts as the link to /zh/ — no duplicated inner item.
            {
              text: '文档索引',
              link: '/zh/'
            },
            {
              text: '使用指南',
              items: [
                { text: '00 · 项目介绍', link: '/zh/guide/00-introduction' },
                { text: '01 · 快速开始', link: '/zh/guide/01-getting-started' },
                { text: '02 · 架构', link: '/zh/guide/02-architecture' }
              ]
            },
            {
              text: '参考',
              items: [
                { text: '03 · CLI 用法', link: '/zh/guide/03-cli-usage' },
                { text: '04 · REST API', link: '/zh/guide/04-rest-api' },
                { text: '05 · Electron GUI', link: '/zh/guide/05-electron-gui' }
              ]
            },
            {
              text: '深入',
              items: [
                { text: '06 · 算法原理', link: '/zh/guide/06-algorithm' },
                { text: '07 · 故障排查', link: '/zh/guide/07-troubleshooting' },
                { text: '08 · 打包与发布', link: '/zh/guide/08-build-package' }
              ]
            }
          ],
          '/zh/guide/': [
            {
              text: '← 文档索引',
              link: '/zh/'
            },
            {
              text: '使用指南',
              items: [
                { text: '00 · 项目介绍', link: '/zh/guide/00-introduction' },
                { text: '01 · 快速开始', link: '/zh/guide/01-getting-started' },
                { text: '02 · 架构', link: '/zh/guide/02-architecture' }
              ]
            },
            {
              text: '参考',
              items: [
                { text: '03 · CLI 用法', link: '/zh/guide/03-cli-usage' },
                { text: '04 · REST API', link: '/zh/guide/04-rest-api' },
                { text: '05 · Electron GUI', link: '/zh/guide/05-electron-gui' }
              ]
            },
            {
              text: '深入',
              items: [
                { text: '06 · 算法原理', link: '/zh/guide/06-algorithm' },
                { text: '07 · 故障排查', link: '/zh/guide/07-troubleshooting' },
                { text: '08 · 打包与发布', link: '/zh/guide/08-build-package' }
              ]
            }
          ]
        }
      }
    }
  }
})
