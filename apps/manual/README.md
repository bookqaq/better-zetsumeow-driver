# Better ZetsuMeow Driver 用户手册

面向用户的独立手册站点，使用 [VitePress](https://vitepress.dev/) 把 Markdown 构建成纯静态
网页。产物只包含 HTML、JS、CSS 和静态资源，不依赖 Node 服务端，可以直接部署到
Cloudflare Pages、任意静态托管，或用 nginx 托管。

VitePress 只作为本目录的**构建期依赖**，不会进入 SDK、油猴脚本或发布产物，也不影响
`packages/` 的零依赖约定。

## 目录结构

```
apps/manual/
├─ package.json              # @bookqaq/zmeow-manual（private）
├─ docs/
│  ├─ .vitepress/
│  │  ├─ config.mts          # 站点配置：导航、侧栏、搜索、版本号注入
│  │  └─ theme/              # 默认主题 + 品牌色 / 中文字体 / 打印样式
│  ├─ public/                # 原样复制到产物根目录（favicon、_headers、robots.txt）
│  ├─ index.md               # 首页：简介、版本与兼容性、快速开始
│  ├─ install.md             # 安装
│  ├─ panel.md               # 界面说明
│  ├─ backup.md              # 备份配置
│  ├─ restore.md             # 还原配置
│  ├─ wooting.md             # 导入 Wooting 配置
│  ├─ update.md              # 更新
│  ├─ faq.md                 # 常见问题
│  ├─ limits.md              # 已知限制
│  └─ privacy.md             # 数据与隐私 / 免责声明
├─ deploy/
│  └─ nginx.conf.example     # nginx 托管示例
└─ README.md                 # 本文件
```

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 22.18（与仓库一致） |
| pnpm | 11.24（根 `packageManager` 已锁定） |
| 网络 | 首次安装需要下载 VitePress 依赖 |

首次安装（在仓库根目录，会同时安装工作区依赖）：

```bash
pnpm install
```

::: tip esbuild 构建脚本
`pnpm install` 会在 `pnpm-workspace.yaml` 的 `allowBuilds` 中允许 `esbuild` 执行安装脚本。
如果看到 `ERR_PNPM_IGNORED_BUILDS`，执行 `pnpm approve-builds` 选择 `esbuild` 后重新安装。
:::

## 本地开发

```bash
pnpm -F @bookqaq/zmeow-manual dev
# http://localhost:5173
```

也可以从仓库根目录使用快捷脚本：

```bash
pnpm manual:dev
```

## 构建

```bash
pnpm -F @bookqaq/zmeow-manual build
# 或
pnpm manual
```

产物目录：`apps/manual/docs/.vitepress/dist/`。

本地预览构建结果：

```bash
pnpm -F @bookqaq/zmeow-manual preview
# http://localhost:4173
```

产物结构（名称带 hash 的资源除外）：

| 文件 | 说明 |
| --- | --- |
| `index.html` | 首页 |
| `install.html`、`panel.html` 等 | 各手册页面 |
| `404.html` | 未找到页面 |
| `assets/*` | 带 hash 的 JS / CSS / 字体 |
| `favicon.svg`、`robots.txt`、`_headers` | 从 `docs/public/` 复制 |

## 版本号

页面中的 `<Version />` 组件和导航栏版本徽章在构建时读取：

- `packages/zmeow-userscript/package.json` 的 `version`；
- `packages/zmeow-sdk/package.json` 的 `version`。

发布新版本后重新构建即可同步，无需手改文档。`config.mts` 通过 `vite.define` 注入
`__MANUAL_VERSION__` / `__MANUAL_SDK_VERSION__`。

## 部署到 Cloudflare Pages

### 方式一：Git 集成（推荐）

在 Cloudflare Pages 中连接仓库，构建设置：

| 设置 | 值 |
| --- | --- |
| Root directory | `/`（仓库根目录） |
| Build command | `pnpm install --frozen-lockfile && pnpm -F @bookqaq/zmeow-manual build` |
| Build output directory | `apps/manual/docs/.vitepress/dist` |
| 环境变量 `NODE_VERSION` | `22.18.0` |
| 环境变量 `PNPM_VERSION`（如需要） | `11.24.0` |

`docs/public/_headers` 会随构建复制到产物根目录，Pages 会自动应用其中的缓存与安全头。
每次推送后 Pages 重新构建，产物是纯静态文件。

### 方式二：直接上传

```bash
pnpm install
pnpm -F @bookqaq/zmeow-manual build
npx wrangler pages deploy apps/manual/docs/.vitepress/dist --project-name zmeow-manual
```

首次使用需要 `npx wrangler login`。部署完成后 Pages 会给出 `*.pages.dev` 地址，可在
控制台绑定自定义域名。

### 子路径部署

如果站点不在域名根路径（例如 `https://example.com/manual/`），构建时设置 base：

```bash
MANUAL_BASE=/manual/ pnpm -F @bookqaq/zmeow-manual build
```

`MANUAL_BASE` 会自动补全首尾 `/`。部署到独立域名或根路径时不要设置该变量。

## 部署到 nginx

```bash
pnpm -F @bookqaq/zmeow-manual build

sudo mkdir -p /var/www/zmeow-manual
sudo rsync -a --delete apps/manual/docs/.vitepress/dist/ /var/www/zmeow-manual/

sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/zmeow-manual.conf
# 按需修改 server_name / root / 证书路径
sudo ln -s /etc/nginx/sites-available/zmeow-manual.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

示例配置见 [`deploy/nginx.conf.example`](deploy/nginx.conf.example)，包含：

- `try_files` 与 `404.html`；
- 带 hash 的 `/assets/` 长缓存，HTML 不做强缓存；
- gzip；
- 基础安全响应头。

启用 HTTPS 时可用 certbot：

```bash
sudo certbot --nginx -d manual.example.com
```

## 其他静态托管

产物是普通静态文件，以下平台同样适用：

- GitHub Pages：把 `dist/` 发布到 `gh-pages` 分支；
- Netlify / Vercel：构建命令同上，发布目录指向 `apps/manual/docs/.vitepress/dist`；
- 对象存储 / CDN（OSS、COS、S3）：上传整个 `dist/`，把 `index.html` 设为默认首页，
  404 指向 `404.html`。

## 修改文档

- 页面内容在 `docs/*.md`，使用 VitePress 的 Markdown 扩展（提示块、代码块、表格等）；
- 导航和侧栏在 `docs/.vitepress/config.mts`；
- 品牌色、字体和打印样式在 `docs/.vitepress/theme/custom.css`；
- `docs/public/` 中的文件会原样进入产物根目录。

不要直接修改 `docs/.vitepress/dist/`，它由构建生成，并且已被 git 忽略。

## 写作约定

- 面向用户，避免暴露内部协议偏移、测试细节；这些内容留在仓库 `docs/` 下。
- 使用中文全角标点；界面按钮名使用 **加粗**（例如 **备份**）。
- 危险或不可逆操作前用 `::: warning` / `::: danger` 提示先备份。
- 新增页面时同步更新 `config.mts` 的侧栏和首页“阅读路径”。

## 验证

构建后建议检查：

```bash
pnpm -F @bookqaq/zmeow-manual build
pnpm -F @bookqaq/zmeow-manual preview
```

- 首页、侧栏各页面、404 页面可访问；
- 本地搜索能返回结果；
- 深色 / 浅色主题切换正常；
- 移动端宽度下侧栏可以打开和关闭；
- 控制台没有资源或 hydration 报错。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `vitepress: not found` | 在仓库根目录重新执行 `pnpm install` |
| `ERR_PNPM_IGNORED_BUILDS` | `pnpm approve-builds` 允许 `esbuild`，再 `pnpm install` |
| 页面 404 / 资源 404 | 检查 `MANUAL_BASE` 是否与部署路径一致 |
| 搜索无结果 | 确认构建产物完整，`assets/` 已上传 |
| 样式错乱 | 确认 `_headers` 没有把 HTML 缓存成旧版本；强制刷新 |
