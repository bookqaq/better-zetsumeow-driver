# AGENTS.md — 开发与维护指南

面向在本仓库工作的开发者 / agent。用户文档见 [README.md](README.md) 与 [docs/SDK.md](docs/SDK.md)。

## 文档职责

| 文件 | 内容 | 不要放什么 |
| --- | --- | --- |
| `README.md` | 面向用户的功能介绍、安装/使用/更新、开发版本与 Contribute、免责声明 | 构建细节、SDK API 教程、真机排查清单 |
| `docs/SDK.md` | 完整 API 参考（连接、读写、快照、事件、屏幕、传输层、错误） | 协议字节偏移 |
| `docs/PROTOCOL.md` | HID/串口帧格式、命令表、回包解析、实测记录 | SDK 使用教程 |
| `docs/TAP.md` | 页面 Tap / 主动连接、hooks、指纹/状态机、油猴脚本与 Wooting 导入扩展 | 基础 SDK 连接教程 |
| `docs/WOOTING-IMPORT.md` | Wootility Web profile schema/版本迁移、60HE/80HE 迁移矩阵、排除型号、字段口径与限制 | SDK API 教程、协议字节 |
| `docs/RELEASE.md` | Better ZetsuMeow Driver 发布前检查、版本/tag、打包、上传、校验与回滚 | 构建实现细节、SDK API 教程 |
| `AGENTS.md` | 本文件：结构、命令、约定、生成物、测试与真机验证流程 | 面向最终用户的说明 |

新增/修改 API 时同步 `docs/SDK.md`；改协议行为时同步 `docs/PROTOCOL.md`；两者都影响时先改协议记录再改文档。

## 仓库结构

```
zmeow-tools/
├─ assets/zetsumeow-driver/          # 本地参考数据（git 忽略）
├─ packages/zmeow-sdk/               # @bookqaq/zmeow-sdk
│  ├─ src/
│  │  ├─ keyboard.ts                 # ZetsuKeyboard（连接、读写、快照、事件）
│  │  ├─ screen.ts                   # ZetsuScreen（Web Serial 懒连接）
│  │  ├─ tap/                        # ZetsuTap：页面 HID/Serial 观察/改写 + 主动连接
│  │  ├─ config/                     # JSON 配置备份 / 恢复 + layoutOverlapInfo 布局重叠
│  │  ├─ types.ts / errors.ts / emitter.ts
│  │  ├─ protocol/                   # 帧、命令、回包解码（无 DOM）
│  │  ├─ codec/                      # 字节/键位/单位/颜色编码
│  │  ├─ transport/                  # webhid、webserial、mock
│  │  ├─ generated/                  # 本地生成的布局/键目录/灯效（git 忽略）
│  │  └─ testing/                    # FakeHid / FakeSerial
│  ├─ scripts/extract-from-bundle.mjs
│  ├─ test/                          # node --test 测试
│  └─ dist/                          # 构建产物（git 忽略）
├─ packages/zmeow-userscript/        # Better ZetsuMeow Driver（油猴脚本，IIFE，仅调用 SDK）
│  ├─ src/                           # main.ts / sdk.ts / ui.ts
│  │  └─ wooting/                    # Wooting 导入扩展（解析/转换；backup.ts 产出备份格式 JSON）
│  ├─ build.mjs                      # 零依赖 TS → IIFE 打包
│  ├─ scripts/release.mjs            # 零依赖发布打包（校验/checksum/notes/npm/GitHub）
│  ├─ test/                          # 构建产物测试 + 发布脚本测试 + Wooting 扩展测试（test/wooting/）
│  └─ dist/                          # .user.js / .meta.js / release/（git 忽略）
├─ apps/
│  ├─ serve.mjs                      # 静态服务器（多线程 + no-cache）
│  ├─ playground/                    # 纯静态调试台（无构建、无 CDN）
│  ├─ simulator/                     # 键盘模拟器（假 WebHID/Serial）
│  └─ manual/                        # 用户手册站点（VitePress，独立部署；见 apps/manual/README.md）
├─ docs/                             # SDK.md、PROTOCOL.md、TAP.md、WOOTING-IMPORT.md、RELEASE.md、截图
├─ LICENSE                           # MIT
├─ package.json                      # 根脚本
└─ pnpm-workspace.yaml               # packages/* + apps/*
```

`assets/` 只用于对照与生成布局数据：**不要**从中 import，也不要把它登记成 workspace 包。
`assets/zetsumeow-driver/` 与 `src/generated/` 已被 git 忽略，不随仓库分发；本地生成后 build/test 才能运行。

## 命令

```bash
pnpm install
pnpm typecheck                 # tsc -p tsconfig.json（src + test）
pnpm test                      # node --test "test/**/*.test.ts"
pnpm -F @bookqaq/zmeow-sdk build   # tsc -p tsconfig.build.json → dist/
pnpm -F @bookqaq/better-zmeow-driver build  # 生成 dist/better-zmeow-driver*.user.js
pnpm -F @bookqaq/better-zmeow-driver release # 本地打包到 dist/release/；加 -- --publish 发 npm + GitHub
pnpm check                     # typecheck + test + build（提交前必跑）
pnpm serve                     # 静态服务器 http://localhost:8099/apps/playground/
pnpm manual                    # 构建用户手册 → apps/manual/docs/.vitepress/dist/
pnpm manual:dev                # 本地预览手册 http://localhost:5173
```

单独跑一个测试文件：

```bash
cd packages/zmeow-sdk && node --test "test/keyboard/client.test.ts"
node --test --test-name-pattern "remap" "test/**/*.test.ts"
```

## 技术栈与代码约定

- Node **≥ 22.18**、pnpm 11、TypeScript 5.9；**零运行时依赖**，不要引入 npm 包。
- `apps/manual` 是例外：用户手册站点用 VitePress（构建期依赖，独立于 `packages/`）生成静态网页，
  可以部署到 Cloudflare Pages / nginx；不要把它接入 SDK、油猴包或发布产物。
- 源码里相对导入必须带 `.ts` 扩展名（`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`）。
- `verbatimModuleSyntax`：类型导入写 `import type { ... }`。
- `erasableSyntaxOnly`：不能用 `enum` / `namespace` / 构造函数参数属性；命令字用 `const` 对象 + `as const`（见 `protocol/commands.ts`）。
- `strict` + `noImplicitOverride`：实现接口/覆写时显式标注。
- 协议层不得引用 DOM 类型（`lib` 含 DOM，但 `src/protocol`、`src/codec` 保持纯 Node 可测）。
- 构建产物不提交；Playground 直接加载 `dist/index.js`，改 SDK 后必须重新 build。
- 新增测试文件放在 `packages/zmeow-sdk/test/**/*.test.ts`，使用 `node:test` + `node:assert/strict`。
- Tap 层测试放在 `packages/zmeow-sdk/test/tap/`，用 `FakeHidDevice` / `FakeSerialPort` 注入原型；配置测试在 `test/config/`（含 `layout.test.ts`，覆盖 `layoutOverlapInfo`）；SDK 的 `test/wooting/` 已随 Wooting 代码迁出而删除，Wooting 扩展测试在 `packages/zmeow-userscript/test/wooting/`（转换测试，不触网）；其余油猴脚本测试在 `packages/zmeow-userscript/test/`。
- Wooting 分享样本位于 `assets/wooting-share/`，测试直接读取（单元测试不触网，fetch 注入 stub）。文件名包含完整 profile code，文件内容只保留响应 JSON，不含 `curl` 请求头；parser 仍兼容旧 curl dump。`wootility_profile_demo_akc.json` 是按 Wootility 2.14.1 schema 构造的合成 fixture，覆盖 SOCD/MT/TGL/RS/DKS/layer 1/per-key RT/custom actuation；不要删除。SDK 不含任何 Wooting 代码，也没有任何网络请求。运行时唯一的触网入口是油猴扩展 `packages/zmeow-userscript/src/wooting/share.ts` 的 `fetchWootingShare`（分享码导入；油猴内优先走 GM 桥接），请求固定带 `origin: https://wootility.io`；不要新增其他运行时网络请求，也不要动这条请求头的语义。
- 油猴脚本的 `src/sdk.ts` 与 `src/wooting/` 扩展模块 import SDK；`main.ts` / `ui.ts` 不允许直接 patch `navigator.hid` / `navigator.serial`。

## 生成物管线

`src/generated/` 由脚本从源数据生成，**不要手改**：

```bash
node packages/zmeow-sdk/scripts/extract-from-bundle.mjs           # 重新生成
node packages/zmeow-sdk/scripts/extract-from-bundle.mjs --check   # 校验是否最新（CI 用）
```

- 脚本用「括号配平切片 + `node:vm` 只求值一个字面量」，不执行源文件；输出确定性（时间戳来自源文件 mtime）。
- `src/generated/manifest.json` 记录源数据 SHA-256；源数据更新后必须重跑脚本。
- 生成内容包括：`product-zetsu63.ts`（产品与 65/79 布局）、`key-catalog.ts`（186 个目标键）、`light-modes.ts`。

## Playground 开发

- 无框架、无 CDN、无构建步骤；`app.js` 是唯一含 SDK 调用的文件，SDK 签名变化只需改这里。
- 静态服务器用 `pnpm serve`（`apps/serve.mjs`，多线程 + `no-cache`，serve 整个仓库根）。不要用 `python3 -m http.server`：单线程，浏览器并行加载 ES module 时会随机 `ERR_CONNECTION_RESET`。
- 页面从 `../../packages/zmeow-sdk/dist/index.js` 动态 import；构建产物缺失时页面显示提示并禁用连接。
- 修改 `dist/` 后需要刷新页面（ES module 映射按 document 缓存），必要时换端口或硬刷新。
- 页面分区与锚点：`#sec-connect`、`#sec-layout`、`#sec-light`、`#sec-key`、`#sec-test`、`#sec-screen`、`#sec-log`；新增按钮使用 `data-requires` 控制启用状态（`connected` / `selection` / `two-selection` / `sdk` …）。
- 写配置按钮统一走 `runAction(button, label, fn)`，它会在写入前自动结束按键测试；纯读取和测试按钮传 `{ write: false }`。

## 测试策略

### 单元测试

- 协议层用 `buildFrame` 构造回包断言解码结果；多帧回包按 90ms 空闲合并，测试里直接 `transport.emit()` 连发。
- 客户端测试注入 `MockTransport`：在 `transport.send` 上按 `frame[2]`（命令字）回包，模拟设备状态（见 `test/keyboard/client.test.ts` 中的 `attachRemapDevice`）。
- 屏幕测试注入 `FakeSerial` / `FakeSerialPort`，不要在测试里触达真实 `navigator.serial`。
- 修改 `setKeyRemap` / `resetKeyRemap` / `restoreRemapSnapshot` 时，保留 `verify` 相关用例（丢帧重试、持续丢帧抛 `TransportError`）。

### Tap / 油猴脚本验证

- `pnpm -F @bookqaq/zmeow-sdk test` 覆盖 HID/Serial tap 与主动连接（复用句柄、不关闭页面端、Serial facade）。
- `pnpm -F @bookqaq/better-zmeow-driver build && pnpm -F @bookqaq/better-zmeow-driver test` 校验 IIFE、metadata、`node --check` 与发布脚本；发布测试使用本地 mock API/假 npm，不触外网。
- `apps/simulator/` 用假 `HIDDevice` / `SerialPort` 在 Chromium 中跑完整页面流程；用 `pnpm serve` 后打开。
- Tap 油猴脚本运行在授权沙箱（`@grant GM_xmlhttpRequest/GM.xmlHttpRequest/unsafeWindow` + `@sandbox JavaScript` + `@connect api.wooting.io`）：patch 经 `unsafeWindow` 锚定到页面 realm（SDK `ZetsuTap.environment` 注入页面 realm 的 `HIDDevice`/`SerialPort`/`navigator`/`window`），Wooting 取数直连 `GM_xmlhttpRequest`。沙箱里的 `globalThis.HIDDevice` 是另一个 realm，直接 patch 它对页面无效；跨 realm 字节判断一律用 `ArrayBuffer.isView`，不要用 `instanceof`。

### 真机验证

硬件验证通过浏览器完成，流程：

1. `pnpm -F @bookqaq/zmeow-sdk build && pnpm serve`，用 Playwright/Chrome 打开 `http://localhost:8099/apps/playground/`。
2. 若设备已授权，页面上下文里可直接 `await navigator.hid.getDevices()`；用 `ZetsuKeyboard.fromDevice(rankHidInterfaces(devices, ZETSU63_PRODUCT)[0].device)` 建实例，避免 `requestDevice()` 的弹框（自动化时可用 init script 覆盖 `requestDevice` 返回已授权设备）。
3. **同一时间只保留一个打开的 HID 句柄**：第二个句柄同时打开时，第一个句柄的写入可能被固件忽略，读回也会出现旧值。验证结束后 `disconnect()` 或直接刷新页面释放句柄。
4. 每次写入都`await`到下一次读取之间留 ≥250ms，必要时用 `verify: true`；断言读回值而不是只看日志。
5. 把结论（命令、长度、偏移、时序、现象）追加到 `docs/PROTOCOL.md` 的实测记录小节，注明固件版本与布局模式。

## 协议与真机要点

改 `keyboard.ts` / `protocol/*` 之前先读 [docs/PROTOCOL.md](docs/PROTOCOL.md)，以下是最容易踩的坑：

- **不要调用 `HIDDevice.forget()`**：会丢失系统授权，下次必须重新选择设备。
- 复合设备有 3 个已授权接口（`0x000C/0x01`、`0xFF00/0x01`、`0x0001/0x02`），只有 `0xFF00/0x01` 接受 64 字节输出报告；接口排序与回退逻辑不要删。
- 固件常在回包里把长度字段写短：`cmd 2`（L=2，值在帧 `[6]`）、`cmd 19`（L=8，`colorful` 在 `[12]`）、`cmd 48`（L=3，行程在 `[6..7]`）。解码必须用绝对偏移，不能按 `[1]` 截断。
- 多帧回包必须合并（重映射 4 帧、特性列表 3 帧、键色 6 帧、行程 12 帧），按空闲 90ms 收齐。
- 写入可能**静默丢弃**（`sendReport` 成功但值未变）：关键写入使用 `verify: true`（回读 + 一次重写）。
- 按键测试（`cmd 2/2`、`cmd 2/3`）必须用 `cmd 2/4 + 0xFF` 收尾，否则设备停在 `cmd 48` 流、不产生普通键入；`disconnect()` 会补发。
- 重映射快照是拍摄时刻的拷贝；「本次修改前」不是「出厂默认」，恢复出厂用 `resetKeyRemap`。
- 布局只在连接时读一次；F 区热插拔后调用 `refreshLayout()`。
- `cmd 2/18`（Mac 模式）在已测固件上无回包，`getMacMode()` 会超时；这是该固件的既定行为，不需要额外兼容分支。
- 屏幕是独立串口（115200 8N1，`cmd 112` 准备 + `cmd 113` 传 RGB565），HID 侧没有屏幕通道；`openScreen()` 必须在用户手势内调用。

## 发布

- 用户脚本（**Better ZetsuMeow Driver**）的发布步骤见 [docs/RELEASE.md](docs/RELEASE.md)：
  版本号在 `packages/zmeow-userscript/package.json`（生成 `@version`），
  GitHub tag 格式 `userscript-vX.Y.Z`，npm 包名 `@bookqaq/better-zmeow-driver`。
- `release` 脚本要求干净工作区并运行 `pnpm check`；不带参数时只生成本地产物与校验文件。
  `--publish` 会发布 npm 包并通过 GitHub API 创建 release / 上传资产（不执行 git
  commit/push），`--dry-run` 只打印计划；token 与更新地址配置见发布文档。npm 的 2FA
  （网页认证或 OTP）需要交互终端：`--publish` 用继承 stdio 运行 npm 并等待认证完成，
  默认最长等 30 分钟（`ZMEOW_PUBLISH_TIMEOUT_MS` 可调），不要通过管道/CI 跑。
- 自动更新 metadata 使用 jsDelivr 的 npm CDN；仅在自建静态目录时，才用
  `ZMEOW_UPDATE_BASE_URL` 或 `--update-base-url` 覆盖。
- `@bookqaq/zmeow-sdk` 目前只作为 workspace 包使用，未配置 npm 发布。
- SDK 版本号在 `packages/zmeow-sdk/package.json`；`files` 只包含 `dist` 与 `README.md`。
- 提交前跑 `pnpm check`，并确认 `pnpm -F @bookqaq/zmeow-sdk build` 后 Playground 能正常加载。
- 用户手册站点见 `apps/manual/README.md`；脚本行为或用户可见流程变化时同步更新
  `apps/manual/docs/*.md`（版本号由构建自动读取 `package.json`）。
