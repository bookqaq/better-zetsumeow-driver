# Better ZetsuMeow Driver 发布步骤

本文是用户脚本 **Better ZetsuMeow Driver**（`packages/zmeow-userscript`，包名
`@bookqaq/better-zmeow-driver`）的发布清单。SDK（`@bookqaq/zmeow-sdk`）不随本流程
发布到 npm。

发布目标：

- **npm registry**：发布包含 `.user.js` / `.meta.js` 的 `@bookqaq/better-zmeow-driver`
  包，供 Tampermonkey 自动更新和 npm CDN / 镜像读取。
- **GitHub Releases**：创建版本化 release，上传同一组资产、校验和与发布说明。
- 自动更新默认走 `registry.npmmirror.com`，方便国内网络访问；也可改用 jsDelivr、
  unpkg 或自建静态地址。

## 1. 发布物

| 文件 | 用途 | npm | GitHub |
| --- | --- | --- | --- |
| `better-zmeow-driver.user.js` | release 模式用户脚本 | 是 | 是 |
| `better-zmeow-driver.meta.js` | Tampermonkey 更新检查用 metadata | 是 | 是 |
| `SHA256SUMS.txt` | 两个脚本的 SHA-256 | 是 | 是 |
| `RELEASE-NOTES.md` | 发布说明 | 是 | 是 |
| `README.md` / `LICENSE` | npm 包说明与 MIT 许可证 | 是 | 仓库内 |
| `dist/better-zmeow-driver.user.js` | debug 构建 | 否 | 否 |
| `dist/better-zmeow-driver.meta.js` | debug metadata | 否 | 否 |
| `dist/better-zmeow-driver.release.user.js` | release 源文件 | 否 | 否 |
| `dist/better-zmeow-driver.release.meta.js` | release metadata 源文件 | 否 | 否 |

发布脚本会把 release 源文件复制成不带 `.release` 的最终文件名，再打包上传。
debug 产物只用于开发、自动化测试和模拟器。

## 2. 版本与标签

- 唯一版本来源：`packages/zmeow-userscript/package.json` 的 `version`。
- 构建时 `build.mjs` 把它写入 `@version`；npm 包版本也使用同一个值。
- 使用 SemVer：`MAJOR.MINOR.PATCH`（允许 `-prerelease`）。
- GitHub tag 格式：`userscript-vX.Y.Z`，例如 `userscript-v0.2.0`。
- npm 包名固定为 `@bookqaq/better-zmeow-driver`。
- 已发布的版本不要复用；npm 同版本不能重复发布，GitHub release 也不应覆盖。

## 3. 发布前检查

在 `main` 上从干净工作区开始：

```bash
git switch main
git pull --ff-only
pnpm install
```

### 3.1 更新版本

编辑 `packages/zmeow-userscript/package.json` 的 `version`。如果本次也调整了 SDK，
同步更新 `packages/zmeow-sdk/package.json` 的版本，但 SDK 的 npm 发布不在本流程内。

### 3.2 检查 metadata 的匹配范围

生产 origin 统一在 `packages/zmeow-userscript/build.mjs` 的 `buildHeader()` 里维护。
debug 构建包含：

- `http://localhost/*`
- `http://127.0.0.1/*`
- `https://driver.zetsumeow.com/*`

release 构建只包含 `https://driver.zetsumeow.com/*`；`localhost` 与 `127.0.0.1`
仅用于本地调试，发布产物中不得出现这两个本地 `@match`。

### 3.3 跑完整检查

```bash
pnpm check
```

`pnpm check` 会执行 typecheck、全部测试和构建。发布脚本默认也会再跑一次，但发版前
先手动跑一遍便于定位失败。

### 3.4 清理旧构建并检查产物

```bash
rm -rf packages/zmeow-userscript/dist
pnpm -F @bookqaq/better-zmeow-driver build
ls -lh packages/zmeow-userscript/dist
sed -n '1,24p' packages/zmeow-userscript/dist/better-zmeow-driver.release.meta.js
```

确认：

- 只生成 `better-zmeow-driver*.user.js` / `.meta.js`，没有旧的
  `zmeow-driver-tap.*`。
- `@name` 精确为 `Better ZetsuMeow Driver`。
- `@version` 等于 `package.json` 的版本。
- `@license` 为 `MIT`。
- release 的 `@match` 只包含生产 origin。
- 没有 `PRODUCTION ORIGIN PLACEHOLDER`。

### 3.5 键盘模拟器验证

```bash
pnpm serve
```

打开：

- debug：`http://127.0.0.1:8099/apps/simulator/`
- release：`http://127.0.0.1:8099/apps/simulator/?variant=release`

确认 `window.__ZMEOW_SIMULATOR__.ready === true`、`panelPresent === true`、
`errors` 为空；release 变体还应隐藏 Connect keyboard / Connect screen /
Disconnect，并保留还原弹窗。

涉及协议、SDK 写入或 Wooting 导入的改动，按 `AGENTS.md` 的“真机验证”流程在实体
键盘上补测，并把结论写进 `docs/PROTOCOL.md`。

### 3.6 提交版本改动

发布脚本要求工作区干净，所以先提交版本号/文档改动：

```bash
git add packages/zmeow-userscript/package.json README.md AGENTS.md docs packages/zmeow-userscript
git commit -m "chore(userscript): prepare vX.Y.Z release"
```

确认 `git status --porcelain` 无输出后再打包/发布。发布前还要确保当前 `HEAD` 已推送
到 GitHub 仓库的默认分支，因为 GitHub API 会用 HEAD SHA 创建 release tag。

## 4. 本地打包（不发布）

```bash
node packages/zmeow-userscript/scripts/release.mjs
# 或
pnpm -F @bookqaq/better-zmeow-driver release
```

默认行为：

1. 校验包名和 package.json 中版本。
2. 要求 git 工作区干净。
3. 在仓库根目录运行 `pnpm check`。
4. 构建 release 模式到 `packages/zmeow-userscript/dist/release/`。
5. 复制为 `better-zmeow-driver.user.js` / `.meta.js`，并删除源 `.release.*`。
6. 注入 `@downloadURL` / `@updateURL`（默认 npm mirror）。
7. 校验 metadata、release 分支痕迹、header 一致性和 `node --check`。
8. 写 `SHA256SUMS.txt` 与 `RELEASE-NOTES.md`。
9. 不执行 npm publish，也不调用 GitHub API。

仅本地调试可用：

```bash
node packages/zmeow-userscript/scripts/release.mjs --skip-check --allow-dirty
node packages/zmeow-userscript/scripts/release.mjs --outdir /tmp/zmd-release
```

`--skip-check` 跳过 `pnpm check`；`--allow-dirty` 允许未提交改动。真实发布不要用这两个
参数。

## 5. 在线发布（npm + GitHub）

### 5.1 凭据

```bash
export ZMEOW_NPM_TOKEN="npm_xxx"          # 或 NPM_TOKEN；也可事先 npm login
export ZMEOW_GITHUB_TOKEN="ghp_xxx"       # 或 GITHUB_TOKEN
```

- npm token 需要对 `@bookqaq/better-zmeow-driver` 有发布权限。
- GitHub token 需要 `repo` 权限（GitHub Actions 中为 `GITHUB_TOKEN`）。
- GitHub 默认仓库为 `bookqaq/zmeow-tools`；可用
  `ZMEOW_GITHUB_OWNER` / `ZMEOW_GITHUB_REPO` 或 `--github-owner` / `--github-repo`
  覆盖。GitHub Actions 会自动读取 `GITHUB_REPOSITORY`。
- npm 默认 registry 为 `https://registry.npmjs.org/`；可用
  `ZMEOW_NPM_REGISTRY` / `--npm-registry` 覆盖。
- 私有 GitHub Enterprise 可用 `ZMEOW_GITHUB_API_URL` /
  `ZMEOW_GITHUB_UPLOAD_URL` 覆盖 API 与上传地址。

### 5.2 先 dry-run

```bash
node packages/zmeow-userscript/scripts/release.mjs --publish --dry-run
```

dry-run 会完成构建与校验，只打印 npm 包版本、GitHub release、资产列表和自动更新
地址，不访问网络。

### 5.3 正式发布

```bash
node packages/zmeow-userscript/scripts/release.mjs --publish
```

执行顺序：

1. 构建 release 产物。
2. 生成临时 npm 包目录（含两个脚本、checksum、发布说明、README、LICENSE），
   执行 `npm publish --access public --tag latest`。
3. 通过 GitHub API 创建 `userscript-vX.Y.Z` release（tag 指向当前 HEAD），上传
   四个资产。
4. 打印 npm 包地址和 GitHub release 地址。

npm 包不包含源码或 workspace 依赖，只是可分发的用户脚本包。

### 5.4 npm 2FA（网页认证）

npm 账号开启两步验证后，`npm publish` 需要完成一次网页认证，发布脚本支持并等待它：

1. 终端打印认证地址并提示 `Press ENTER to open in the browser...`，按回车；
2. 浏览器打开 npm 页面，完成 2FA（认证不可绕过，脚本不会跳过或伪造 OTP）；
3. npm 轮询到认证成功后自动重试发布，`release.mjs` 会一直等到 npm 退出，再继续
   GitHub release 步骤。

实现上 `npm publish` 以 `stdio: 'inherit'` 运行，`stdin`/`stdout` 直接连到当前终端
（npm 的 `otplease()` 只有在两者都是 TTY 时才会走网页/OTP 流程）。因此：

- 必须在真实终端里运行 `--publish`，不要用管道或重定向输出（如 `| tee`）；
- CI 中没有交互终端，无法完成网页认证，只能用不需要交互的发布凭据；
- 默认最多等待 30 分钟，可用 `ZMEOW_PUBLISH_TIMEOUT_MS`（毫秒）调整：

```bash
ZMEOW_PUBLISH_TIMEOUT_MS=3600000 node packages/zmeow-userscript/scripts/release.mjs --publish
```

如果 npm 成功但 GitHub 失败，可先修复 GitHub 凭据/仓库配置，再重试：

```bash
node packages/zmeow-userscript/scripts/release.mjs --publish --skip-npm
```

只想发布其中一侧：

```bash
node packages/zmeow-userscript/scripts/release.mjs --publish --skip-github
node packages/zmeow-userscript/scripts/release.mjs --publish --skip-npm
```

`--skip-npm` 只应在当前版本已经成功发布到 npm 后使用；否则安装脚本的
`@downloadURL` / `@updateURL` 会指向不存在的包版本。

## 6. 自动更新

release 产物的 metadata 默认包含：

```js
// @downloadURL  https://registry.npmmirror.com/@bookqaq/better-zmeow-driver/latest/files/better-zmeow-driver.user.js
// @updateURL    https://registry.npmmirror.com/@bookqaq/better-zmeow-driver/latest/files/better-zmeow-driver.meta.js
```

Tampermonkey 会定期读取 `@updateURL`，比较 `@version` 后提示更新，再从
`@downloadURL` 下载新脚本。npm 包根目录直接放置两个脚本，因此 npmmirror 的
`/latest/files/<file>` 路径可用。

可替换的镜像/静态地址：

| 服务 | 更新基址 |
| --- | --- |
| npmmirror（默认，国内加速） | `https://registry.npmmirror.com/@bookqaq/better-zmeow-driver/latest/files` |
| jsDelivr | `https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver@latest` |
| unpkg | `https://unpkg.com/@bookqaq/better-zmeow-driver@latest` |
| 自建静态目录 | 任意同时托管两个文件的 HTTPS 目录 |

切换基址：

```bash
ZMEOW_UPDATE_BASE_URL="https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver@latest" \
  node packages/zmeow-userscript/scripts/release.mjs --publish
```

或：

```bash
node packages/zmeow-userscript/scripts/release.mjs --publish \
  --update-base-url "https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver@latest"
```

注意：更新地址写在已安装的脚本里；切换镜像后，旧安装仍会访问旧地址，需要用新地址
重新安装一次或发布一次包含新地址的版本。

npmmirror 同步 npm 可能有延迟。发布后若 `@updateURL` 暂时 404，等待同步完成即可；
GitHub Release 资产不受此影响，可作为手动安装/回退来源。

## 7. 发布后验证

```bash
# npm 版本
npm view @bookqaq/better-zmeow-driver version

# npm mirror 上的 metadata 必须是新版本
curl -fsSL "https://registry.npmmirror.com/@bookqaq/better-zmeow-driver/latest/files/better-zmeow-driver.meta.js" \
  | sed -n '1,12p'

# GitHub release 资产
curl -fsSL "https://github.com/bookqaq/zmeow-tools/releases/download/userscript-vX.Y.Z/better-zmeow-driver.meta.js" \
  | sed -n '1,12p'
```

在干净的 Chromium 用户配置（或临时安装 Tampermonkey 的配置）里：

1. 从 GitHub Release 安装 `better-zmeow-driver.user.js`，或在 Tampermonkey 中安装
   npm mirror 的 `@downloadURL`。
2. Tampermonkey 面板显示的名称是 `Better ZetsuMeow Driver`，版本是 `X.Y.Z`。
3. 打开驱动页，确认右下角面板出现且标题正确。
4. 验证 release 行为：Backup 一步下载 JSON；Restore 弹出选择 + 确认对话框，取消
   不写设备；连接按钮不可见。还原/导入成功后弹出「刷新页面」确认对话框：点击
   「立即刷新」才刷新，取消/关闭/Esc 不刷新。
5. 验证设置页、语言切换/持久化、Wooting 分享码导入入口仍然存在；Wooting 面板
   不再有层选择下拉框（固定基础层 + 第一层 Fn，layer 0/1），也没有“从文件导入”。
6. 安装上一个版本后触发 Tampermonkey“检查更新”，确认能升级到新版本。
7. 如有条件，在 `https://driver.zetsumeow.com/*` 上做一次最小连接/读取验证；涉及
   写入或协议变更时按真机流程执行并记录。
8. 把实际安装 URL、版本、校验结果和验证人记录到发布说明或内部记录。

## 8. 回滚

- 坏版本：在 npm 上 `npm deprecate` 或按 npm 政策撤回该版本，发布一个 patch 版本；
  不要把 latest 指回旧版本。
- GitHub：编辑/删除坏 release 或标记 pre-release，然后发布修复版本；不要复用已发布
  tag。
- 自动更新：安装脚本会跟随 npm `latest` 的 `@version`；发布修复版本后，用户下次
  检查更新即可恢复。若 mirror 尚未同步，可先用 GitHub Release 资产手动安装。
- 只有在确认无人使用且团队同意后才删除远端 tag/版本；默认通过补丁版本修复。

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| npm 报 401/403 | 检查 `ZMEOW_NPM_TOKEN` / `NPM_TOKEN` 是否有该 scope 的发布权限 |
| npm 报版本已存在 | 修改 `packages/zmeow-userscript/package.json` 的版本，不能复用已发布版本 |
| npm 要求 OTP / 2FA | 在真实终端运行 `--publish` 并完成网页认证；脚本会等待。无 TTY（管道、CI）时 npm 会直接失败 |
| GitHub 401/403 | 检查 token 与 `ZMEOW_GITHUB_OWNER` / `ZMEOW_GITHUB_REPO` |
| GitHub release 已存在 | 若是失败重试，先删除不完整的 release（tag 可保留），再用 `--publish --skip-npm` 重试；否则提升版本后重新发布 |
| npm mirror 上的更新 404 | 等待 npmmirror 同步，或换 jsDelivr/unpkg 基址重新发布 |
| 自动更新不触发 | 确认 `@updateURL` 可访问、`@version` 增加、Tampermonkey 允许该脚本更新 |
| release 仍匹配 localhost | 检查 `buildHeader()` 的 release 分支，发布脚本会拒绝该产物 |
| 校验命令不存在 | macOS 用 `shasum -a 256 -c`，Linux 用 `sha256sum -c` |

## 10. 可选的 CI 自动化

GitHub Actions 中可直接使用 `GITHUB_TOKEN` 和 npm automation token：

> 注意：网页 2FA 需要交互终端，CI 里无法完成；CI 发布需要用账号允许的自动化
> 发布凭据，或者改在本地终端执行 `--publish` 并完成网页认证。

```yaml
permissions:
  contents: write

# ...
- run: pnpm install --frozen-lockfile
- run: pnpm check
- run: node packages/zmeow-userscript/scripts/release.mjs --publish
  env:
    ZMEOW_NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
    ZMEOW_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

CI 中不需要再手动 `git tag` 或创建 release；脚本会通过 GitHub API 创建 tag/release。
