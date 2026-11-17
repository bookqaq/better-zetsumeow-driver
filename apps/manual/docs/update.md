# 更新

当前手册对应脚本版本：<Version />。

## 自动更新

发布版脚本的 metadata 带有自动更新地址：

```text
@downloadURL  https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver/better-zmeow-driver.user.js
@updateURL    https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver/better-zmeow-driver.meta.js
```

Tampermonkey 会定期读取 `@updateURL` 的 metadata，比较 `@version` 后提示更新，再从
`@downloadURL` 下载新脚本。看到更新提示时确认即可。默认使用 jsDelivr CDN。

## 手动更新

1. 更新前先在面板里[备份配置](/backup)。
2. 打开[最新 Release](https://github.com/bookqaq/better-zetsumeow-driver/releases/latest)，
   下载新的 `better-zmeow-driver.user.js`。
3. 在 Tampermonkey 中打开已安装的脚本，用新文件内容替换；或直接重新安装该文件。
4. 如果脚本列表中出现两个 **Better ZetsuMeow Driver**，删除旧条目，只保留最新版。
5. 重新打开驱动页并连接键盘，确认面板正常、版本号正确。

手动安装也可以直接使用 npm CDN：

```text
https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver/better-zmeow-driver.user.js
```

## 查看当前版本

在 Tampermonkey 的脚本列表或脚本详情中查看 **Better ZetsuMeow Driver** 的 `@version`。
面板本身不显示脚本版本，只显示内置 SDK 是否可用；版本以脚本管理器中的信息为准。

## 更新地址

自动更新地址写在**已经安装的脚本**里。更换地址后，旧安装仍会访问旧地址，需要用新地址
重新安装一次，或等待发布一个包含新地址的版本。

更新地址固定在 jsDelivr：

| 服务 | 更新基址 |
| --- | --- |
| jsDelivr | `https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver` |

仅在自建静态目录时，才需要覆盖这个地址。

## 更新后检查

| 检查项 | 期望 |
| --- | --- |
| Tampermonkey 版本 | 与最新 Release 一致 |
| 面板出现 | 打开驱动页后右下角面板正常显示 |
| 连接状态 | 键盘连接后显示 **已连接**；如果显示只读代理，查看日志原因 |
| 备份 / 还原 | 各做一次最小验证；写入后检查 `警告` 行 |
| 语言设置 | 语言选择仍然生效 |

## 更新失败或回滚

- **自动更新没有触发**：在 Tampermonkey 中手动执行一次“检查更新”，或按上面的步骤手动安装。
- **CDN 404 / 仍是旧版本**：确认 npm 包已发布；jsDelivr 有缓存，刚发布时可能尚未刷新，等待缓存过期；期间可以从 GitHub Release 手动安装。
- **新版本有问题**：从 Releases 重新安装上一个可用版本；不要复用或覆盖已经发布的 tag。
- **版本回退后仍提示更新**：自动更新会跟随 npm 的 `latest`，回退安装旧版本后可能再次被提示升级；
  可以暂时关闭该脚本的自动更新，或等待修复版本。

旧版本文件名可能是 `zmeow-driver-tap.user.js`。升级到新版后请确认旧脚本已被替换或移除，
避免两个脚本同时注入驱动页。

## 下一步

- 安装与权限：[安装](/install)
- 更新后遇到问题：[常见问题](/faq)
