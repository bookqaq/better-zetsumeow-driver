---
layout: home

hero:
  name: Better ZetsuMeow Driver
  text: 用户手册
  tagline: 为 ZetsuMeow 网页驱动补上配置备份 / 还原功能，并提供 Wooting 配置导入。
  actions:
    - theme: brand
      text: 快速开始
      link: /install
    - theme: alt
      text: 界面说明
      link: /panel
    - theme: alt
      text: GitHub
      link: https://github.com/bookqaq/better-zetsumeow-driver

features:
  - title: 配置备份 / 还原
    details: 把重映射、灯效、单键颜色、行程、快速触发、高级键和杂项设置导出为 JSON；还原时逐项写入并回读校验，丢写自动重试一次。
  - title: Wooting profile 导入
    details: 用分享码把 Wootility 的 60HE / 80HE 配置迁移到 Zetsu 键盘，固定导入基础层和第一层 Fn，不支持的功能会写入日志。
  - title: 不抢占设备
    details: 脚本观察官方驱动已经建立的 WebHID / Web Serial 连接，不修改官方驱动文件，也不接管官方页面的设备连接。
  - title: 写入保护
    details: 写入期间把官方页切到安全视图并隔离回包；布局不一致时必须确认，取消不会写入任何内容。
---

## 这是什么

**Better ZetsuMeow Driver** 是一个运行在 Tampermonkey 中的用户脚本，配合
[ZetsuMeow 网页驱动](https://driver.zetsumeow.com/) 使用。它通过页面 tap 观察官方驱动已建立的
WebHID / Web Serial 连接，在驱动页右下角提供一个独立面板，用来：

- 备份当前键盘配置，或把之前导出的配置写回设备；
- 用 Wooting 分享码导入 60HE / 80HE 的 profile；
- 查看连接状态、页面指纹、帧数与操作日志。

脚本不修改官方驱动文件，也不替代官方驱动；键盘的连接、断开和日常设置仍由官方页面负责。

::: warning 使用前请先备份
还原和 Wooting 导入都会直接改写设备配置，且**不会自动备份**当前配置。第一次操作前，请先在面板里点一次 **备份**，把 JSON 文件保存到本地。
:::

## 版本与兼容性

本文档随脚本发布同步更新。

| 项目 | 当前值 |
| --- | --- |
| 用户脚本版本 | <Version /> |
| 内置 SDK | <Version kind="sdk" /> |
| 驱动页面 | `https://driver.zetsumeow.com/` |
| 键盘布局 | `compact65`（65 键）/ `extended79`（79 键） |
| 已测固件基线 | `1.1.1` |
| 浏览器 | 桌面版 Chrome / Edge（需要 WebHID 与 Web Serial） |
| 许可证 | MIT |

::: info 兼容性说明
`1.1.1` 是当前的真机测试基线。其他固件通常也能工作，但页面指纹或协议解析不匹配时，
脚本会把状态降为“通过 tap 代理连接”并停止改写，详见[已知限制](/limits)。
:::

## 快速开始

1. **安装脚本**：在 Tampermonkey 中安装最新版 `better-zmeow-driver.user.js`，确认所需权限。
   详细步骤见[安装](/install)。
2. **连接键盘**：打开 `https://driver.zetsumeow.com/`，按官方驱动页面的流程连接键盘。
   连接成功后，页面右下角会出现 **Better ZetsuMeow Driver** 面板。
3. **先备份再写入**：点击面板上的 **备份**，保存下载的 JSON；之后再使用**还原**或
   **导入 Wooting 配置**。各项操作的细节见[备份配置](/backup)、[还原配置](/restore)和
   [导入 Wooting 配置](/wooting)。

## 阅读路径

| 你想…… | 从这里开始 |
| --- | --- |
| 第一次安装、确认脚本正常工作 | [安装](/install) |
| 看懂面板上的状态、指纹和日志 | [界面说明](/panel) |
| 保存一份当前配置 | [备份配置](/backup) |
| 把备份写回键盘 | [还原配置](/restore) |
| 从 Wootility 迁移 profile | [导入 Wooting 配置](/wooting) |
| 更新脚本 | [更新](/update) |
| 遇到报错、设备无响应 | [常见问题](/faq) |
| 了解能力边界和数据安全 | [已知限制](/limits)、[数据与隐私](/privacy) |

## 免责声明

- 本项目是独立的第三方开源项目，与 ZetsuMeow、Wooting Team 及其关联公司没有隶属或授权关系。
- 本项目按“现状”提供，不对适用性、稳定性、兼容性或数据完整性作任何明示或暗示担保。
- 配置写入可能改变按键映射、灯效、行程、快速触发和高级键设置。请先备份，并自行承担使用风险。
- 完整的数据处理方式和免责条款见[数据与隐私](/privacy)。
