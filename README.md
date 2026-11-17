# Better ZetsuMeow Driver

**Better ZetsuMeow Driver** 为 ZetsuMeow 网页驱动增加配置备份/恢复、Wooting profile 导入和更清晰的状态面板。脚本通过 Tampermonkey 运行在驱动页面中，不修改官方驱动文件。

> 本项目与 ZetsuMeow、Wooting Team 均无隶属等关系。使用前请阅读[免责声明](#免责声明)。
> 本项目为 Vibe Coded 项目，以人工测试驱动功能开发，不对代码质量有任何保证。

## 功能介绍

- **驱动页面增强面板**：在官方驱动页右下角显示连接状态、固件版本、页面指纹和操作日志。
- **通过代理工作**：脚本观察官方驱动已经建立的 WebHID / Web Serial 连接，不抢占设备；官方驱动连接键盘后，面板会自动显示代理连接状态。
- **配置备份 / 恢复**：将重映射、灯效、单键颜色、行程、快速触发、高级键和杂项设置导出为 JSON；恢复时先校验文件，写入后回读校验，丢写会自动重试一次。
- **Wooting profile 导入**：通过分享码导入，兼容 Wooting 60HE / 80HE 家族；检测到不支持的型号会在写入设备前停止。
- **布局不一致保护**：备份文件与设备布局不一致时弹出确认对话框，确认后才写入，取消不会改动设备。
- **中英文界面**：内置简体中文与 English，语言选择会保存在浏览器中。
- **写入前建议先备份**：备份是手动操作（导入/还原不会自动备份设备现有配置）；恢复和导入共用同一套受保护的写入流程，并尽量把未采纳的配置项记录到日志。

## 安装与使用

### 系统要求

| 项目 | 要求 |
| --- | --- |
| 浏览器 | 桌面版 Chrome / Edge（需要 WebHID 与 Web Serial） |
| 用户脚本管理器 | Tampermonkey，建议使用最新版本 |
| 页面环境 | `https://driver.zetsumeow.com/` |
| 其他 | 不支持 Firefox、Safari 和移动端浏览器 |

### 安装

推荐从 npm CDN（jsDelivr）安装，自动更新也走同一地址；无法访问 jsDelivr 时再从 GitHub Releases 手动下载。

1. 打开 `https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver/better-zmeow-driver.user.js`，Tampermonkey 会接管安装。若无法访问 jsDelivr，改为打开本仓库的 **Releases** 页面下载最新版本的 `better-zmeow-driver.user.js`，再把文件拖入浏览器，或粘贴到 Tampermonkey 新建的脚本中。
2. 确认安装。脚本需要 `GM_xmlhttpRequest` / `unsafeWindow` 权限；首次使用 Wooting 分享码时，Tampermonkey 可能询问是否允许访问 `api.wooting.io`，请按需允许。
3. 打开 ZetsuMeow 网页驱动并像平常一样连接键盘。连接成功后，页面右下角会出现 **Better ZetsuMeow Driver** 面板。

> Tampermonkey 的 MV3 版本请在扩展设置中开启 **Allow User Scripts**，并把 Content Script API 设为 **UserScripts API Dynamic**，否则可能无法在 `document-start` 注入脚本。

> 发布版只匹配生产驱动域名 `https://driver.zetsumeow.com/`；`localhost` / `127.0.0.1` 仅用于本地调试构建。

> 发布版面板不显示“连接键盘 / 连接屏幕 / 断开连接”按钮；设备的连接和断开由官方驱动页负责。开发构建才包含这些手动连接入口。

### 使用z

面板默认展开在右下角，主要操作如下：

| 操作 | 说明 |
| --- | --- |
| **备份** | 读取当前配置并直接下载 JSON 文件。建议在恢复或导入前先备份。 |
| **还原** | 选择之前导出的 JSON，确认后写回设备。取消对话框不会写入任何内容。 |
| **Import Wooting profile** | 输入 Wooting 分享码；固定导入基础层 + 第一层 Fn（layer 0/1，不带入 Fn2 等更多层），转换完成后走与还原相同的写入流程，写入结束会询问是否刷新页面。 |
| **设置** | 切换简体中文 / English。语言选择会持久化。 |
| **状态与日志** | 查看连接状态、固件版本、页面指纹、操作进度和警告。 |

使用建议：

- 同一时间只让一个页面或程序持有键盘 HID / 屏幕串口，避免官方驱动与其他工具同时写入。
- 第一次恢复前先做一次备份；恢复完成后检查面板日志中的 `warnings`。
- 如果状态长期停留在“通过 tap 代理连接”但设备无响应，先在官方驱动页断开并重新连接键盘。
- 写入类操作必须由用户点击触发，浏览器需要这次点击来获得设备权限或文件访问权限。

## 更新

发布版包含 `@downloadURL` / `@updateURL`，Tampermonkey 会定期通过 npm CDN 检查稳定更新通道（默认 jsDelivr），发现新版本时提示升级。也可以手动更新：

1. 打开本仓库 **Releases** 页面，下载最新 `better-zmeow-driver.user.js`。
2. 在 Tampermonkey 中打开已安装的脚本，用新文件内容替换，或直接重新安装该文件。
3. 如果 Tampermonkey 中出现两个 **Better ZetsuMeow Driver** 条目，删除旧条目，只保留最新版。
4. 更新前建议先导出一份配置备份；更新后重新打开驱动页并确认面板正常。

可以在 Tampermonkey 的脚本列表或脚本详情中查看当前 `@version`。如果自动更新没有触发，可先在 Tampermonkey 中手动执行一次“检查更新”，或按上面的步骤手动安装。旧版本文件名可能是 `zmeow-driver-tap.user.js`，升级到新版后请确认旧脚本已被替换或移除。

## 开发

### 使用的程序版本

| 程序 | 版本 / 要求 |
| --- | --- |
| Node.js | ≥ 22.18 |
| pnpm | 11.24 |
| TypeScript | 5.9 |
| 浏览器 | 最新稳定版桌面 Chrome / Edge（WebHID + Web Serial） |

### Contribute

欢迎提交 issue 和 pull request。

- 动手前请（让你的大肥鱼）阅读 [AGENTS.md](AGENTS.md)，了解仓库结构、代码约定、测试方式和真机验证流程。
- SDK、页面 Tap、Wooting 导入与协议细节见 [docs/SDK.md](docs/SDK.md)、[docs/TAP.md](docs/TAP.md)、[docs/WOOTING-IMPORT.md](docs/WOOTING-IMPORT.md)、[docs/PROTOCOL.md](docs/PROTOCOL.md)；发布流程见 [docs/RELEASE.md](docs/RELEASE.md)。
- 用户手册站点（VitePress，Markdown → 静态网页）见 [apps/manual/README.md](apps/manual/README.md)，构建产物可独立部署到 Cloudflare Pages 或 nginx。
- 本地开发：

  ```bash
  pnpm install
  pnpm check
  ```

- 修改行为时请补充或更新测试；涉及设备写入、协议或导入逻辑的改动，请说明验证环境（浏览器、固件版本、键盘布局）。
- 提交 PR 前确保 `pnpm check` 通过，并同步更新受影响的文档。
- 提交 issue 时请提供脚本版本、浏览器版本、键盘型号/固件版本、复现步骤和相关日志；请勿粘贴设备序列号、分享码或其他敏感信息。
- 开发上欢迎使用大肥鱼，但对于PR请保证文字对人类友好，不要长篇大论以及语气过于AI

## 免责声明

- 本项目是独立的第三方开源项目，与 ZetsuMeow、Wooting Team 及其关联公司没有隶属或授权关系。
- 本项目按“现状”提供，不对适用性、稳定性、兼容性或数据完整性作任何明示或暗示担保。
- 配置写入可能改变键盘的按键映射、灯效、行程、快速触发、高级键等设置。请在操作前使用内置备份功能保存配置，并自行承担使用风险。
- 使用 Wooting 分享码导入时，分享码会发送到 Wootility 官方接口。请遵守其服务条款，并注意网络可用性、接口变更和限流限制。
- 导出的配置备份包含按键、灯效、行程等设置和固件版本，但不包含设备 SN / boardId；仍请妥善保管，不要随意上传到公共位置。
- 作者与贡献者不对因使用本项目造成的设备异常、配置丢失、数据丢失或其他损失承担责任。对关键配置，请优先使用官方驱动并保留可恢复的备份。
- 文中出现的商标、产品名称和服务名称归其各自所有者所有。

## 许可证

本项目采用 [MIT License](LICENSE)。
