# 安装

## 系统要求

| 项目 | 要求 |
| --- | --- |
| 浏览器 | 桌面版 Chrome / Edge（需要 WebHID 与 Web Serial） |
| 用户脚本管理器 | Tampermonkey，建议使用最新版本 |
| 驱动页面 | `https://driver.zetsumeow.com/` |
| 网络 | 安装脚本和首次检查更新需要访问 GitHub 或 npm CDN |
| 不支持 | Firefox、Safari、移动端浏览器；`file://` 页面 |

::: info 为什么只支持桌面 Chromium
键盘通过 WebHID 通信，屏幕通过 Web Serial 通信，两者目前只有桌面版 Chromium
内核浏览器完整支持。Firefox、Safari 和移动端浏览器无法建立这两类连接。
:::

## 安装脚本

发布版只匹配生产驱动域名 `https://driver.zetsumeow.com/`，不会在其他网站上运行。
请先安装 [Tampermonkey](https://www.tampermonkey.net/)，并在浏览器扩展设置中启用它。

### 方式一：npm CDN 直链（推荐）

发布包分发到 npm，并由 jsDelivr 提供 CDN。打开下面的链接，Tampermonkey 会接管安装：

```text
https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver/better-zmeow-driver.user.js
```

这个地址同时用于自动更新，详见[更新](/update)；安装后脚本会通过 jsDelivr 检查新版本。

### 方式二：GitHub Releases

1. 打开[最新 Release](https://github.com/bookqaq/better-zetsumeow-driver/releases/latest)，
   下载 `better-zmeow-driver.user.js`。
2. 让 Tampermonkey 接管安装，任选一种：
   - 直接把 `.user.js` 文件拖进浏览器窗口；
   - 或打开该文件的 URL；
   - 或在 Tampermonkey 中新建脚本，粘贴文件内容。
3. 在安装页确认脚本名称 **Better ZetsuMeow Driver** 和版本号，点击安装。

## 权限说明

安装时 Tampermonkey 会列出脚本申请的权限。它们分别用于：

| 权限 | 用途 |
| --- | --- |
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | 获取 Wooting 分享码对应的 profile，不受驱动页 CORS 限制 |
| `unsafeWindow` | 把页面 tap 注入官方驱动所在的页面环境，观察 WebHID / Web Serial 调用 |
| `@connect api.wooting.io` | 仅允许访问 Wooting 分享接口 |
| `@sandbox JavaScript` | 让 tap 和脚本权限在受控沙箱中协作 |

首次使用 Wooting 分享码时，Tampermonkey 可能额外询问是否允许访问 `api.wooting.io`，
选择允许即可。脚本不申请其他网站的访问权限，也不会在后台常驻。

::: tip Tampermonkey MV3
如果使用 Tampermonkey 的 MV3 版本，请在扩展设置中开启 **Allow User Scripts**，
并把 Content Script API 设为 **UserScripts API Dynamic**。否则脚本可能无法在
`document-start` 注入，面板也不会出现。
:::

## 第一次运行

1. 打开 `https://driver.zetsumeow.com/`。
2. 按官方驱动页面的流程连接键盘（正常授权 HID 设备）。
3. 连接成功后，页面右下角会出现 **Better ZetsuMeow Driver** 面板。
   如果面板没有出现，先刷新页面；仍不出现时见[常见问题](/faq)。
4. 打开面板的 **设置** 页签，确认语言为简体中文或 English。

打开面板的 **主面板** 页签，可以看到连接状态、页面指纹、帧数和 SDK 状态。
各字段的含义见[界面说明](/panel)。

## 验证安装

| 检查项 | 期望结果 |
| --- | --- |
| Tampermonkey 脚本列表 | 名称为 **Better ZetsuMeow Driver**，版本与 Release 一致 |
| 驱动页右下角 | 出现同名面板，可以展开 / 收起 |
| 主面板状态 | 键盘已连接时显示 **已连接** 或 **通过 tap 代理连接** |
| 操作日志 | 连接后出现状态变化记录，正常操作没有红色错误 |
| 备份 | 点击 **备份** 后立即下载 `zmeow-config-<时间戳>.json` |

::: tip 先做一次空备份
即使暂时不改配置，也建议先点一次 **备份** 验证整条读取链路是否畅通。备份文件可以保留，
也可以直接丢弃；它的内容见[备份配置](/backup)。
:::

## 发布版与调试版

从 Release 或 npm CDN 安装的是 **release 构建**：

- **备份** 一步完成：读取配置后立即下载 JSON；
- **还原** 会先打开选择文件 + 确认对话框，取消不会写入；
- 面板不显示“连接键盘 / 连接屏幕 / 断开连接”按钮，设备连接由官方驱动页负责。

调试构建只用于本地开发和模拟器，额外提供连接按钮和两步式备份 / 还原，**不建议日常使用**。
开发说明见仓库中的 `AGENTS.md` 与 `apps/simulator/README.md`。

## 卸载

1. 在 Tampermonkey 的脚本列表中删除 **Better ZetsuMeow Driver**。
2. 刷新驱动页即可，脚本不会修改官方驱动的任何文件。

脚本只在驱动页的 `localStorage` 中保存语言选择（键名 `zmeow-tap.locale`）。卸载脚本不会
改变键盘上的配置；如果要在设备上恢复出厂设置，请使用官方驱动。

## 下一步

- 弄清面板上每个状态的含义：[界面说明](/panel)
- 保存第一份配置：[备份配置](/backup)
- 从 Wootility 迁移配置：[导入 Wooting 配置](/wooting)
