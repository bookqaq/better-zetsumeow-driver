# 页面 Tap 与主动连接

`ZetsuTap` 是 SDK 的“页面桥”层，面向**已经运行官方网页驱动**的场景。它有两种能力，二者可以同时存在：

| 模式 | 入口 | 行为 |
| --- | --- | --- |
| Tap（观察/改写） | `ZetsuTap.install()` | 在页面主世界 patch `HIDDevice.prototype` / `SerialPort.prototype`，拦截官方驱动对 HID 与串口的调用，可只观察、改写或丢弃帧 |
| Active（主动连接） | `tap.connectKeyboard()` / `tap.connectScreen()` | 用同一个已打开的 HID 句柄或串口端口创建 `ZetsuKeyboard` / `ZetsuScreen`；不会打开或关闭页面句柄 |

油猴脚本只负责**调用**这两个入口和渲染状态；它不直接 patch WebHID/WebSerial。SDK 内部负责所有 tap 逻辑。

```ts
import { ZETSU63_PRODUCT, ZetsuTap } from '@bookqaq/zmeow-sdk';

const tap = await ZetsuTap.install({ product: ZETSU63_PRODUCT });

tap.on('status', (status) => {
  console.log(status.state, status.fingerprint, status.reasons);
});
tap.on('frame', (frame) => {
  if (frame.direction === 'out') console.log(frame.kind, frame.frame.command);
});

// 主动连接（必须在用户手势内；页面已连接时复用页面句柄）
const keyboard = await tap.connectKeyboard();
const screen = await tap.connectScreen();

// 只关闭主动连接，页面句柄与 tap 保留
await tap.disconnect();

// 卸载 tap 并关闭主动连接
await tap.stop();
```

## 1. Tap 的工作方式

### HID

`HidTap` 安装以下包装，且都只在 VID/PID 匹配时生效：

- `HIDDevice.prototype.sendReport`：解析 64 字节 `0xAB` 帧，调用 `onHidOut`，可改写/丢弃。
- `HIDDevice.prototype.oninputreport` 的 setter：包裹官方驱动的属性 handler，调用 `onHidIn`，可改写/丢弃输入帧。
- `HIDDevice.prototype.addEventListener('inputreport')`：兼容未来改用事件监听的驱动。
- `open` / `close`：只更新 tap 的连接状态，不改变句柄生命周期。
- 额外挂一个原生 `inputreport` 监听，保证即使页面没有注册 handler，主动连接也能收到回包。

### Serial

`SerialTap` **不使用 `tee()`**。官方驱动的读循环长期锁住 `readable`，`tee()` 会永久锁住源流；正确做法是透明代理：

- 代理 `readable.getReader()` 返回的 reader 的 `read()`，在页面消费的同时观察/回放每个 chunk。
- 代理 `writable.getWriter()` 返回的 writer 的 `write()`，解析完整串口帧后调用 `onSerialOut`，可改写/丢弃。
- `open` / `close` 只更新状态，不关闭页面端口。
- `createPortFacade(port)` 给主动连接提供一个虚拟 `SerialPortLike`：
  - `readable` 由 tap 的输入 sink 供给；
  - `writable` 经 tap hooks 后写入真实端口；
  - `open` / `close` 为 no-op。

## 2. Hooks

```ts
interface TapHooks {
  onHidOut?(frame: ParsedFrame, device: HidDeviceLike):
    Uint8Array | null | undefined | Promise<Uint8Array | null | undefined>;
  onHidIn?(frame: ParsedFrame, device: HidDeviceLike): Uint8Array | null | undefined;
  onSerialOut?(frame: SerialFrame, port: SerialPortLike):
    Uint8Array | null | undefined | Promise<Uint8Array | null | undefined>;
  onSerialIn?(frame: SerialFrame, port: SerialPortLike): void;
}
```

返回值约定：

| 返回值 | 含义 |
| --- | --- |
| `undefined` | 原样放行 |
| `null` | 丢弃该帧 |
| `Uint8Array` | 替换帧字节；HID 必须是完整 64 字节，串口必须是完整 `0xAB...` 帧 |

HID 输入 hook 必须是同步的（浏览器事件 handler 是同步的）；HID/Serial 输出 hook 可以是异步的。

### 已知版本的改写示例

```ts
const tap = await ZetsuTap.install({
  hooks: {
    onHidOut: (frame) => {
      if (frame.command === 19) {
        // 改写灯光帧的亮度字节，并重建 CRC
        const payload = frame.payload.slice();
        payload[4] = Math.min(10, payload[4] ?? 0);
        return buildFrame(19, payload);
      }
      return undefined;
    },
  },
});
```

## 3. 状态、指纹与适配

`tap.status` 是一个快照：

```ts
type TapState = 'idle' | 'active' | 'readonly' | 'disabled';

interface TapStatus {
  state: TapState;
  mode: 'tap' | 'active' | 'both';
  fingerprint: TapFingerprint;
  hid: { attached: boolean; connected: boolean; device: HidDeviceLike | null };
  serial: { attached: boolean; connected: boolean; port: SerialPortLike | null };
  frames: { hidOut: number; hidIn: number; serialOut: number; serialIn: number };
  adapterId: string | null;
  reasons: string[];
}
```

`TapFingerprint` 记录：

- `indexHash` / `hidHash` / `screenHash`：官方页面资源的 SHA-256；
- `productOk`：`window.data.keys_product_list` 中的产品表是否仍与 SDK 的 `ZETSU63_PRODUCT` 一致；
- `firmwareVersion`：捕获到的 `cmd 1` 回包中的固件版本；
- `protocolOk`：捕获到的 `cmd 1` / `cmd 2/19` 是否仍能被 SDK 解码；
- `checked` / `hashKnown`：是否做过 hash 比对、是否匹配已知基线；
- `reasons`：人类可读的原因。

状态规则：

| 状态 | 条件 | 建议行为 |
| --- | --- | --- |
| `active` | 产品表/协议通过，或已知 hash，或已加载匹配的 adapter | 允许经过白名单的改写 |
| `readonly` | hash 未知或固件不在测试列表，但协议仍能解析 | 只观察，提示“驱动已更新，暂只读” |
| `disabled` | 环境无 WebHID/Serial、产品表不一致、协议解码失败 | 完全放行，不修改，提示“暂不可用” |
| `idle` | tap 已安装但尚未连接设备 | 等待官方页面连接 |

### 当前基线

| 项目 | 值 |
| --- | --- |
| `hid` 资源 | `1cd39f45ae0a7f10132c089b51fd090a9ef6b759a75ac7cca79afdeb7c4e87ab` |
| `screen` 资源 | `125f4951257039e483e7a4bfb0796a9e009b1bd9a10162986904fc79b9dc80f5` |
| `index` 资源 | `ccd124898e70de5e5f0243f9a4d78248dcc79ee5daec8553cbcf9eadade42396` |
| 产品 | `id 10011` / `vid 14470` / `pid 16385` / `usage 1` / `usagePages [65280, 255]` / `head 0xAB` |
| 已测固件 | `1.1.1` |

`refreshFingerprint()` 会在 `DOMContentLoaded` 后读取页面资源并 hash；产品表出现时也会自动刷新一次。页面资源变化但协议仍可解析时，状态会停在 `readonly`，不会静默继续改写。

适配新版本时，可以给 `ZetsuTap.install()` 传一个 `adapter`：

```ts
const tap = await ZetsuTap.install({
  adapter: {
    id: 'driver-2026-12',
    hidHashes: ['<new hid sha256>'],
    firmwareVersions: ['1.2.0'],
    hooks: {
      onHidOut: (frame) => { /* 新版本的改写 */ return undefined; },
    },
  },
});
```

adapter 的 `hidHashes` / `screenHashes` / `firmwareVersions` 都匹配时，`status.adapterId` 会有值，并且未知 hash 不会把状态压到 `readonly`。`allowUnknownHashes: true` 只应在人工 diff 过新驱动后使用。没有 adapter 时，优先在 `onHidOut` / `onSerialOut` 里按 command/payload 做白名单改写，并保持 `status.state === 'readonly'` 时默认不写。

## 4. 主动连接

### 键盘

```ts
const keyboard = await tap.connectKeyboard();
```

- 如果 tap 已捕获到页面打开的 HIDDevice：使用 `TapHidTransport` 共享该句柄，`open()`/`close()` 都是 no-op；`keyboard.disconnect()` 只清理 SDK 状态并补发测试结束帧，不会关闭页面句柄。
- 否则：走 `ZetsuKeyboard.requestDevice()`，必须在用户手势内调用；连接成功后 tap 会捕获新设备。

### 屏幕

```ts
const screen = await tap.connectScreen({ reusePagePort: true });
```

- 页面已打开串口：用 `createPortFacade(port)` + `ZetsuScreen({ port, openPort: false })`，不重新 `requestPort()`，也不关闭端口。
  - 复用依赖页面的读循环仍在运行；如果页面已经停止读取（`data.serial_open` 为 false / reader 已取消），tap 收不到数据，此时应让脚本走自己的 `requestPort()` 或先恢复页面连接。
- 页面尚未打开串口：走正常 `ZetsuScreen.open()`（用户手势内 `requestPort()`）。

### 与官方页面并发

tap 只观察页面已经在发的帧；主动连接会在同一句柄上额外发送请求。官方协议回包没有 request id，只有 `cmd`/`sub`，因此：

- **默认先用 tap**；主动连接只在用户明确点击按钮后使用，并尽量避开官方页面正在写入/轮询的时段。
- 需要并发时，把主动连接的操作串行化，并在 hook 里记录/过滤回包，避免把页面的回包当成自己的。
- 不要在 `connect()` 进行中让页面同时发同一 `cmd` 的请求。

## 5. 油猴脚本：Better ZetsuMeow Driver（只调用）

`packages/zmeow-userscript`（`@bookqaq/better-zmeow-driver`，展示名称
**Better ZetsuMeow Driver**）是薄壳 + Wooting 导入扩展：

- `src/sdk.ts` 与 `src/wooting/` 扩展模块 import SDK；
- `src/main.ts` 只调用 `ZetsuTap.install()`、`tap.on('status'|'frame')`、`connectKeyboard()`、`connectScreen()`、`disconnect()`，以及 `sdk.ts` 的 JSON 备份/恢复封装与 Wooting 导入管线（抓取 → 解析 → 转备份格式 → 还原）；
- `src/ui.ts` 只渲染 shadow DOM 面板，不碰 WebHID/WebSerial；面板包含连接、备份/下载（两步：Backup 入内存、Download 下载 JSON）、加载/还原（两步：Load restore file 校验入内存、Restore 写入设备）、Wooting 分享码输入与导入按钮（仅分享码入口）。还原/导入成功后面板弹出「刷新页面」确认对话框：点击「立即刷新」才执行 `location.reload()`，取消、关闭（×/Esc/点击遮罩）都不会刷新；
- 还原时若备份文件的 `layout` 与设备上报布局不一致，面板弹出「布局不一致」对话框（debug / release 两模式均有）：点击「同意还原」以 `allowLayoutMismatch: true` 继续写入，重叠按键生效、设备上不存在的按键按 hardCode 跳过并记入 warnings 日志；点击「取消」或按 Esc 则中止，不写入设备、不记错误、官方页安全视图原样返回。布局不匹配的还原也可以在 `sdk.ts` 的 `restoreBackup` 里传 `onLayoutMismatch` 钩子自定义询问逻辑；
- 构建产物是单个 IIFE，包含 SDK，不需要额外 `@require`；
- 脚本运行在 Tampermonkey 的**授权沙箱**（`@grant GM_xmlhttpRequest` / `GM.xmlHttpRequest` / `unsafeWindow` + `@sandbox JavaScript`）：GM 权限负责 Wootility 分享码取数（`@connect api.wooting.io`）；tap patch 通过 `unsafeWindow` 锚定到**宿主页面 realm**——`sdk.ts` 的 `resolvePageEnvironment()` 把页面 realm 的 `HIDDevice` / `SerialPort` / `navigator` 经 SDK `ZetsuTap.environment` 注入，`hid-tap` / `serial-tap` 把 patch 打在传入的原型上，沙箱自身 realm 的原型不受影响。没有 manager（测试、模拟器页面）时回退 `globalThis`，行为与主世界注入路径一致；`copyBytes` 用 `ArrayBuffer.isView` 做跨 realm 字节拷贝（页面 realm 的 TypedArray 不是沙箱 `instanceof Uint8Array`）。

### Wooting 导入（`src/wooting/` 扩展）

SDK 本体不含 Wooting 代码，也不执行任何网络请求；Wootility profile 导入完全由油猴包内的 `src/wooting/` 扩展实现，分两步：

**第一步：取数与解析（不碰设备）。**

- 分享码路径：`sdk.ts` 的 `fetchWootingProfile(code)` 调扩展的 `fetchWootingShare`（GET Wootility 分享接口，固定 `origin: https://wootility.io`）。取数优先走 `GM_xmlhttpRequest`（脚本自带 grant，从扩展后台发出，不受页面 CORS 约束；兼容 `GM.xmlHttpRequest` Promise 变体），没有 manager 提供时回退页面 `fetch`（驱动页会被 CORS 拦截，此时导入会明确失败并提示网络/CORS）。拿到响应后立即 `summarizeWootingProfile` 摘要型号。分享接口限流约 40 次 / 10s（响应带 `x-ratelimit-*` 头）；HTTP 429 归为网络/限流失败。
- **型号预检**：摘要只认 60HE 家族（`target.device` 4/5/9/11 → 原生布局 `compact65`）与 80HE 家族（10/12 → `extended79`）；Wooting One（0）、Wooting Two 系列（Two=1、Two HE=3/6）、UwU（7/8）、Lekker（2，开关模块）与未知 id 在这一步抛 `UnsupportedError`。错误文案明确写出 `Wooting One / Two series / UwU` **不支持，且不进行重叠键部分迁移**。预检发生在受保护传输开始之前——不支持的型号永远不会触发设备写入，也不会把驱动页切进安全视图。详细矩阵见 [WOOTING-IMPORT.md](WOOTING-IMPORT.md)。

**第二步：转换与还原（走 SDK 还原路径）。**

- `wootingToBackup(profile, { layers: [0, 1] })` 调扩展的 `wootingProfileToConfig`，把 profile 转成 SDK 的备份格式 `KeyboardConfig`：纯转换、不碰设备，**总是转换到 profile 的原生布局**（60HE 家族 → `compact65`，80HE 家族 → `extended79`），跨布局交给还原路径处理。层选择固定为基础层 + 第一层 Fn（layer 0/1；Zetsu 只有一个 Fn 层，面板不再提供选项），layer 2（Fn2）及更多 Wooting 层忽略并记入 `warnings`。
- 导入**不会**在写入前读取或备份设备现有配置：管线只有「解析 profile → 转备份文档 → 还原写入」；需要保留当前配置时，请先用面板的「备份」手动导出。
- DEBUG 构建会额外把这份中间产物下载为 `wooting-import-<时间戳>.json`（可脱离油猴、用 SDK 的 `restoreKeyboardConfig` 离线复现导入）；release 构建跳过这一步。调试 JSON 不携带 `restoreOptions`：若原 profile 没有静态键色，离线还原时请显式传 `{ restoreLight: false, restoreKeyColors: false, restoreFeatures: false }`，否则会改写设备灯效。
- 随后在**受保护传输**（安全视图 + 页面输入静默 + 成功弹窗询问是否刷新页面）里调 `restoreBackup`——即 SDK 已验证的 `restoreKeyboardConfig` 路径，verify、写入节奏与布局过滤与备份还原共用同一条管线：
  - 转换文档通过 `wootingRestoreOptions()` 生成还原选项：**没有静态键色**（`rgb.kbdArray` 缺失）时 `restoreLight=false`、`restoreKeyColors=false`，不改写设备灯效；**没有高级键**时 `restoreFeatures=false`；有高级键时 `clearExtraFeatures: false`，导入仍是**补丁**而不是全量恢复，避免清掉设备上已有但配置里没有的高级键；
  - 布局不一致时复用与备份还原相同的 `Panel.confirmLayoutMismatch` 确认对话框（Wooting 文案），shared/skipped 键数来自 SDK 的 `layoutOverlapInfo`；
  - 转换要点：恒等重映射条目被过滤（固件会把「写回默认值」规范化掉，写入它们没有实际效果，也会干扰还原时的回读比对）；有键色时 `light` 块合成 mode 255（还原先写灯效再写键色，满足 cmd 20 键色写前置，见 PROTOCOL.md 9.2）；Wootility 亮度 0..255 映射到 Zetsu 0..10；`akc` 中的 SOCD / MT / TGL / Rappy Snappy (RS) 会导入（旧版布尔 keybind、`inputBothWhenBottomedOut`/`inputBothOnBottomOut` 字段也兼容；SOCD/RS 为两键功能，同一无序键对只导入一次，且一个键不能出现在两个同功能键对中），DKS 因 SDK 没有写入命令而跳过；gamepad / lightbar / tachyon / digital mode / tick rate 不导入，连同跳过的键、RGB effects/layers 一起计入 `warnings`。`version > 15` 抛 `WootingProfileVersionError`，面板归类为“配置版本过新”，不会进入设备写入。
  - 行程 / 快速触发：Wootility 当前 profile schema 是 **15**。本扩展对 **9–15** 做字段兼容/单位启发式导入；**< 9** 记录 legacy warning（不做推测性的旧 remap/dks 迁移）；**> 15** 拒绝。单位约定：**v0–v2** 的模拟量是 8-bit `0..255 → 0..4mm`，**v3–v8** 是 mm，**v9+** 对支持 14-bit 的设备转成 `1/4096mm` 整数（不支持该迁移的设备仍可能是 mm）；**v12** 的自定义触发值用 `0.1mm` 步进（`1 = 0.1mm`），**v14+** 直接用 mm（`0.7` / `1` / `2`）。转换按数值量级 + `version` 自动识别；`customActuations[].value` 允许小数。RT 的按下/松开行程取 Wooting 的 split sensitivity：`rapidTriggerSensitivity`（KEY PRESS - ACTIVATE 按下/再触发）→ `travelDownMm`，`rapidTriggerSecondarySensitivity`（KEY RELEASE - DEACTIVATE 松开/重置）→ `travelUpMm`（全局和 per-key 都支持）；`perKeyRapidTrigger` 同时兼容旧版的布尔值、`null` 和 v15 的 `{sensitivity}` 对象；`false` 是显式单键关闭，优先于全局 RT；无全局 `actPoint` 时只导入显式 `customActuations` 的键；`fastOut` 按 `rapidTriggerStrictActuationRange` 映射（strict=true → `pressMm`，false → 0）；Wooting 没有 Zetsu 的顶部/底部防误触安全区，导入时两者固定写 **0**；保留 0.2mm 默认会让最小 0.1mm 触发点无法生效。

```bash
pnpm -F @bookqaq/better-zmeow-driver build
# dist/better-zmeow-driver.user.js             主脚本（tap + 面板 + Wooting 取数，单文件即装）
# dist/better-zmeow-driver.release.user.js     release 模式

pnpm -F @bookqaq/better-zmeow-driver release
# dist/release/better-zmeow-driver.user.js     面向用户的发布包
# release 版 metadata 含 @downloadURL / @updateURL（默认 jsDelivr）
# 发布步骤见 RELEASE.md
```

键盘模拟器位于 `apps/simulator/`，打开
`http://localhost:8099/apps/simulator/` 即可运行。

安装时注意：

- **单脚本安装**（tap patch 与 Wooting 取数已合并，无伴生脚本）；首次请求 `api.wooting.io` 时 Tampermonkey 可能弹出 `@connect` 确认，选择允许；
- 脚本运行在授权沙箱（`@sandbox JavaScript`）：tap patch 经 `unsafeWindow` 注入宿主页面 realm，Wooting 取数走 `GM_xmlhttpRequest`——两者在同一个脚本里互不干扰；
- `@run-at document-start` 越早越好，但 `@require` 会延迟执行；本项目把 SDK 打进同一个 IIFE，避免这个问题；
- Tampermonkey MV3 需要开启 “Allow User Scripts”，并把 Content Script API 设为 “UserScripts API Dynamic” 才有真正的 document-start；
- 本地页面必须通过 `https://` 或 `http://localhost` 打开，`file://` 没有 WebHID/Web Serial。

## 6. 限制

- 只内置 `Zetsu63` 产品；产品表新增型号时状态会变为 `disabled`，需要扩展 `PRODUCTS`。
- HID 回包无事务 id；并发使用主动客户端时无法完全避免回包串台。
- 官方页面每次连接都会 `forget()` 已授权 HID 设备；tap 不阻止这一行为，也不应缓存旧句柄。
- 页面更新后内部实现可能变化；tap 只依赖 Web API 与协议字节，不依赖内部实现细节。
- 浏览器只支持桌面 Chromium（Chrome / Edge）。
