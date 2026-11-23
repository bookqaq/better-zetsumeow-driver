# @bookqaq/zmeow-sdk 文档

ZetsuMeow 磁轴键盘 SDK 的完整 API 参考。SDK 通过 **WebHID** 与键盘通信、通过 **Web Serial** 与屏幕通信，协议细节见 [PROTOCOL.md](PROTOCOL.md)。

- 入口：`@bookqaq/zmeow-sdk`（源码 `packages/zmeow-sdk/src/index.ts`，构建产物 `packages/zmeow-sdk/dist/index.js`）
- 测试入口：`@bookqaq/zmeow-sdk/testing`（WebHID / Web Serial 假设备）
- 运行时依赖：无；导入模块不会触碰 `navigator.hid` / `navigator.serial`
- 范围：SDK 只覆盖 ZetsuMeow 键盘本身的能力，**不含任何 Wooting 代码，也不执行任何网络 I/O**；Wooting profile 导入是驱动油猴脚本的扩展（`packages/zmeow-userscript/src/wooting/`），见 [TAP.md](TAP.md) §5

```ts
import {
  ZetsuKeyboard,
  isWebHidSupported,
  ZmeowError,
  TimeoutError,
} from '@bookqaq/zmeow-sdk';
```

## 目录

1. [连接与生命周期](#1-连接与生命周期)
2. [实例属性](#2-实例属性)
3. [键引用 KeyRef](#3-键引用-keyref)
4. [读取 API](#4-读取-api)
5. [写入 API](#5-写入-api)
6. [重映射快照](#6-重映射快照)
7. [按键测试与事件](#7-按键测试与事件)
8. [屏幕（Web Serial）](#8-屏幕web-serial)
9. [传输层与测试注入](#9-传输层与测试注入)
10. [错误类型](#10-错误类型)
11. [主要类型](#11-主要类型)
12. [内置数据](#12-内置数据)
13. [限制与注意事项](#13-限制与注意事项)
14. [配置备份 / 恢复](#14-配置备份--恢复)

---

## 1. 连接与生命周期

### `ZetsuKeyboard.isSupported()`

```ts
static isSupported(): boolean
```

运行环境是否有 WebHID（等价于 `isWebHidSupported()`）。

### `ZetsuKeyboard.requestDevice(options?)`

```ts
static requestDevice(options?: {
  vendorId?: number;
  productId?: number;
}): Promise<ZetsuKeyboard>
```

弹出浏览器 HID 选择框，按产品过滤（默认匹配仓库内置产品）。**必须在用户手势中调用**。会在已选设备中按厂商接口评分排序，把全部已授权接口作为候选传入实例，`connect()` 失败时自动尝试下一个接口。

### `ZetsuKeyboard.fromDevice(device, product?)`

```ts
static fromDevice(device: HidDeviceLike, product?: ProductInfo): ZetsuKeyboard
```

包装一个已经获得授权的 `HIDDevice`（例如来自 `navigator.hid.getDevices()`），不会弹框。传入未知 VID/PID 会抛 `UnsupportedError`。

### `ZetsuKeyboard.listGrantedInterfaces()`

```ts
static listGrantedInterfaces(): Promise<Array<{
  product: ProductInfo | null;
  device: HidInterfaceDescription;
  score: number | null;
}>>
```

诊断用：列出当前页面已授权的所有 HID 接口及其用途/评分，不打开设备。

### `connect(options?)`

```ts
connect(options?: { timeoutMs?: number; retries?: number }): Promise<this>
```

打开 HID 接口，读取设备信息（`cmd 1`）、`pz_num`（`cmd 2/12`）、F 区模式（`cmd 2/19`），并解析当前布局。默认 `timeoutMs = 800`、`retries = 2`。

- 使用候选接口列表时，若某个接口打不开或首份回包失败，会自动换下一个候选（复合设备的非厂商接口会拒绝 64 字节输出报告）。
- 已经连接时调用是幂等的。
- 布局解析失败不会抛错，`layout.mode` 会变成 `'unknown'`，键级 API 随后抛 `UnknownLayoutError`。

### `disconnect(options?)`

```ts
disconnect(options?: { keepScreen?: boolean }): Promise<void>
```

结束正在运行的按键测试（补发 `cmd 2/4 + 0xFF`），关闭屏幕串口（`keepScreen: true` 时保留），关闭 HID 链路。**不会**调用 `HIDDevice.forget()`，已授权的设备下次仍然可用。

### `refreshLayout(options?)`

```ts
refreshLayout(options?: ConnectOptions): Promise<KeyLayout>
```

重新读取设备信息与 `cmd 2/19`，用于热插拔 F 区模块后刷新 65/79 键布局。别名 `retryLayout()`。

### 典型连接流程

```ts
const kb = await ZetsuKeyboard.requestDevice();
try {
  await kb.connect();
  console.log(kb.info.boardId, kb.layout?.mode);
} catch (error) {
  if (error instanceof ZmeowError) console.error(error.code, error.message);
} finally {
  await kb.disconnect();
}
```

---

## 2. 实例属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `product` | `ProductInfo` | 当前产品定义（VID/PID、布局、屏幕尺寸、行程范围等） |
| `isConnected` | `boolean` | 是否已连接 |
| `info` | `Readonly<DeviceInfo>` | 设备信息快照，连接后填充 |
| `layout` | `KeyLayout \| null` | 当前布局；连接前为 `null` |
| `keys` | `readonly KeyDef[]` | 当前布局的键（`layout.keys` 的快捷方式） |
| `isFRowInstalled` | `boolean` | 是否安装了 F 区模块（79 键） |
| `deviceHandle` | `HidDeviceLike` | 当前使用的 HID 设备对象 |
| `interfaceInfo` | `HidInterfaceDescription` | 当前接口的 usagePage / usage / 报告长度等 |
| `screen` | `ZetsuScreen` | 屏幕句柄；读取该属性不会做 I/O |
| `isScreenOpen` | `boolean` | 串口是否已打开 |
| `activeKeyTest` | `'stroke' \| 'tap' \| null` | 当前正在运行的按键测试流 |

`DeviceInfo` 字段：`boardId`、`sn`、`firmwareVersion`、`runMode`（`'app'` / `'boot'`）、`runModeNum`、`pzNum`、`isMac`、`winLock`、`highPrecision`、`isLock`、`lightSleep`、`fMode`。未读取过的字段为 `null`。

`KeyDef` 字段：`hardCode`（矩阵位置，所有配置命令的标识）、`hidCode`（默认输出 usage）、`hidCodeFn1`、`selfCode`、`scanId`、`keyCode`、`textCode`、`title`、`status`、`travel`、`maxTravel`、`minTravel`、`isFast`、`isFRow`、`geometry {x,y,w,h,img}`。

---

## 3. 键引用 KeyRef

```ts
type KeyRef = number | string | { hardCode: number } | { textCode: string };
```

作为**源键**（要配置的键）时：

- `number` → `hardCode`
- `string` → 优先匹配 `textCode`（`'KeyA'`），其次匹配 `title`（`'A'`），也接受 `'0x2A'` / `'42'` 形式的 hardCode
- 对象 → 按 `hardCode` 或 `textCode` 查找

作为**目标键**（映射到的键）时：

- `number` → HID usage
- `string` → 优先从 186 键的目录（`KEY_CATALOG`）按名称/`textCode` 查找 usage，其次接受数字字符串

> 同一个 `number` 在源键位置表示 hardCode、在目标键位置表示 HID usage，这是最容易踩的坑。

---

## 4. 读取 API

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `getDeviceInfo()` | `DeviceInfo` | 重新读取 `cmd 1` |
| `getKeyMap(layer?)` | `Map<hardCode, KeyMapEntry>` | 某一层的重映射表；`layer` 为 `0 / 1 / 2`，默认 0 |
| `getLight()` | `LightState` | 当前灯效 |
| `getKeyColors()` | `Map<hardCode, KeyColor>` | 单键颜色（亮度被压到 `0..10`） |
| `getFeatures()` | `Map<hardCode, FeatureKind>` | 每个键使用的高级功能（`none` / `socd` / `rs` / `mt` / `tgl` / `mpt` / `end` / `dks`） |
| `getFeature(key)` | `FeatureConfig \| null` | 单个键的高级功能配置 |
| `getTravelConfig()` | `Map<hardCode, TravelEntry>` | 行程配置 |
| `getKeyTravel(key)` | `TravelEntry \| null` | 单个键的行程（内部会读取整张表） |
| `getWinLock()` | `boolean` | 锁 Win 状态 |
| `getMacMode()` | `boolean` | Mac 模式；**当前固件不回复该查询，会抛 `TimeoutError`** |
| `getFMode()` | `number` | F 区模式原始字节（79 = 已装 F 区） |
| `getStatus()` | `boolean` | 设备状态位 |
| `getLightSleep()` | `number` | 灯光休眠分钟数 |

多数读取是多帧回包（重映射 4 帧、特性列表 3 帧、键色 6 帧、行程 12 帧），SDK 会合并到最后一个满帧后返回。多帧收集的时序：帧间静默 90ms 视为收齐；首帧最长等 1.5s——设备忙时（例如 Tap 共享句柄下官方驱动正在收发）首帧可能晚到，不会被 90ms 截断。

`getKeyMap()` 对超时自动重试一次（间隔 200ms）：设备刚结束按键测试流、或共享句柄被官方驱动占用时，`cmd 35` 读可能先超时一次再成功；连续两次超时才抛 `TimeoutError`。

`KeyMapEntry`：`{ hardCode, hidCode, title, textCode }`。

---

## 5. 写入 API

### 灯效

```ts
setLight(patch: {
  mode?: number;        // 0 = 关闭，1..9 = 灯效，255 = 轴体单键自定义（颜色来自 cmd 20 键色表）
  speed?: number;       // 0..100
  turn?: number;        // 0 正向 / 1 反向
  brightness?: number;  // 0..10
  colorful?: number;
  rgb?: HexColor | { r: number; g: number; b: number };
}): Promise<void>
```

未传的字段沿用上次读取/写入的状态（连接后默认 `mode:1, speed:80, turn:0, brightness:8`）。非法值抛 `ValidationError`；`mode 255`（单键自定义）是合法值——官方驱动直接把 255 写进 cmd 19 的模式字节，备份恢复依赖这一点。

```ts
setKeyColor(
  keys: KeyRef | KeyRef[],
  color: HexColor | Rgb,
  options?: { brightness?: number },
): Promise<void>

setKeyColors(entries: Array<{
  key: KeyRef;
  color: HexColor | Rgb;
  brightness?: number;
}>): Promise<void>
```

`setKeyColors` 把不同颜色的键打包进 `cmd 20` 报告（每帧最多 11 个），适合恢复整张键盘的 RGB。

### 重映射

```ts
setKeyRemap(
  source: KeyRef,
  target: KeyRef,
  options?: { layer?: 0 | 1 | 2; verify?: boolean; settleMs?: number },
): Promise<void>

resetKeyRemap(
  keys: KeyRef | KeyRef[],
  options?: { layer?: 0 | 1 | 2; mode?: 'default' | 'none'; settleMs?: number; verify?: boolean },
): Promise<number[]>   // 返回写入的 hardCode
```

- `resetKeyRemap` 的 `mode: 'default'`（默认）写入该键在布局表中的 `hidCode`，即恢复键自身功能；`mode: 'none'` 写入 0，清空该层覆盖（多数键 Fn 层的出厂状态）。
- `verify: true`：写入后等待 `settleMs`（默认 250ms）回读该层，只对没写进去的键重写一次；仍不一致抛 `TransportError`。适用于固件偶发「确认写入但不生效」的场景。

```ts
await kb.setKeyRemap('KeyA', 'F1', { layer: 0, verify: true });
await kb.resetKeyRemap(['KeyA', 'KeyB'], { layer: 0 });
await kb.resetKeyRemap('KeyA', { layer: 1, mode: 'none' });
```

### 高级功能

```ts
setRS({ key1, key2, bottom?, ms? }): Promise<void>       // 深度优先
setSOCD({ key1, key2, first1?, first2?, bottom?, ms? }): Promise<void>  // 后覆盖
setMT({ key, hold, tap, ms? }): Promise<void>            // 点按双效，默认 200ms
setTGL({ key, target, ms? }): Promise<void>              // 点击持续
setMPT({ key, targets: [k1, k2, k3], mm: [m1, m2, m3] }): Promise<void> // 三行程触发
setEND({ key, target, ms? }): Promise<void>              // 弹起跟随，固件按 10ms 步进
clearFeature(key: KeyRef): Promise<void>
```

| 缩写 | 名称 | 官方说明 |
| --- | --- | --- |
| RS | 深度优先 | 两个按键中会优先触发按下更深的按键。 |
| SOCD | 后覆盖 | 监测两个按键，后按下的按键会自动释放前一个按键。 |
| MT | 点按双效 | 正常点击触发 `tap`，按住不放触发 `hold`。 |
| TGL | 点击持续 | 点击后持续触发某一功能，再次点击停止。 |
| MPT | 三行程触发 | 按键三个不同行程深度分别定义 3 种功能。 |
| END | 弹起跟随 | 按键抬起时触发另一个按键。 |

> `ms` 参数在 RS / SOCD / END 中固件按 `round(ms / 10)` 存储；`setEND` 的默认值是驱动硬编码的 10ms。

### 行程 / 快速触发

```ts
setKeyTravel(key: KeyRef, patch: {
  pressMm: number;       // 触发行程
  releaseMm: number;     // 旧版单值：未提供下面两个字段时同时用于按下/抬起
  travelDownMm?: number; // 按下（触发/再触发）RT 行程，对应固件 travel_down
  travelUpMm?: number;   // 松开（重置）RT 行程，对应固件 travel_up
  deadDownMm?: number;
  deadUpMm?: number;
  fastOutMm?: number;
  fast?: boolean;        // true = 开启快速触发
}): Promise<void>

setTravelConfig(entries: Array<{ key: KeyRef } & KeyTravelPatch>): Promise<void>
```

- 单键写入只发送该键一条记录，不影响其他键；批量写入按每块最多 4 键拆帧，`total` 始终是总键数。
- `setTravelConfig` 按官方写入节奏：先等 **10ms**，每块前等 **5ms**，全部写完后等 **块数×10 + 100ms** 再返回（单键约 125ms，58 键约 335ms，不含 HID 往返）。这段 settle 是必要的：固件对写入是异步处理，紧接着的 `cmd 41` / `cmd 47` 读可能因排队而超时（`docs/PROTOCOL.md` 9.10）。
- `pressMm` / `releaseMm` / `fastOutMm` 范围由每个键的布局定义决定（Zetsu63 磁轴：`minTravel..maxTravel = 0.01..4.0mm`，Gateron 磁轴触发区间 0–4mm）。原驱动 UI 的 `0.1..3.1mm` 只是官方滑条预设，不是硬件范围。
- 所有行程值在编码前会**量化到固件的 0.01mm 步进**（`mmToTravelBytes` 先四舍五入到 0.01mm 再编码），避免写入非步进值后读回不一致。
- `deadDownMm` / `deadUpMm` 范围 `0..1mm`（产品 `keyRange.dead`）。
- `travelDownMm` / `travelUpMm` 是 RT 的两个独立行程；省略时都回退到 `releaseMm`，因此旧的单值写法保持兼容。Wooting 导入会把 `rapidTriggerSensitivity`（KEY PRESS - ACTIVATE，按下/再触发）映射到 `travelDownMm`，把 `rapidTriggerSecondarySensitivity`（KEY RELEASE - DEACTIVATE，松开/重置）映射到 `travelUpMm`。
- `fast: false` 时 `fastOutMm` 被忽略。回读时 SDK 对普通键跳过 RT 字段，把 `releaseMm` 归一化为 `pressMm`、`fastOutMm` 归一化为 0；`travelDownMm` / `travelUpMm` 同样归一化为 `pressMm`。这是 SDK 的回读语义，不代表固件把 RT 字段写成了这些值。

```ts
await kb.setKeyTravel('KeyA', { pressMm: 2.4, releaseMm: 1.6, fast: false });
const one = await kb.getKeyTravel('KeyA');
```

### 其它写入

```ts
setWinLock(value?: boolean): Promise<void>
setLightSleep(minutes: number): Promise<void> // 0..255
restoreDefaults(): Promise<void>              // 危险：恢复所有设置到固件默认
```

锁 Win 的写入语义：官方驱动只会发 `cmd 2/7` 且第二字节固定 0（目标值被忽略），因此 **`[7, 0]` 是切换而不是绝对设置**。省略参数时 SDK 原样发送这个切换帧；传入 `value` 时先回读当前状态，仅在与目标不同才发切换帧——幂等，绝不发送驱动从不使用的 `[7, 1]`。配置恢复（`restoreKeyboardConfig`）因此能把 `misc.winLock` 正确还原到备份时刻的状态：已一致不写，不一致切换一次。

---

## 6. 重映射快照

「恢复到本次修改前」等回滚能力基于快照：快照是纯数据，可 `JSON.stringify` 后存入 `localStorage`。

```ts
interface RemapSnapshot {
  takenAt: number;
  layout: LayoutMode;                                   // 拍摄时的布局
  layers: Record<number, Record<number, number>>;       // layer -> hardCode -> usage
}
```

```ts
captureRemapSnapshot(options?: {
  layers?: Array<0 | 1 | 2>;   // 默认 [0, 1]
}): Promise<RemapSnapshot>

restoreRemapSnapshot(snapshot: RemapSnapshot, options?: {
  layers?: Array<0 | 1 | 2>;   // 默认：快照里出现的所有层
  keys?: KeyRef | KeyRef[];    // 只回滚这些键
  dryRun?: boolean;            // 只读并返回将要写入的差异
  settleMs?: number;           // 写后等待时间，默认 0
  verify?: boolean;            // 回读校验 + 一次重写
}): Promise<RemapRestoreResult>
```

```ts
interface RemapRestoreResult {
  entries: Array<{
    layer: number;
    hardCode: number;
    title: string;
    textCode: string;
    from: number;   // 设备当前 usage
    to: number;     // 快照 usage
  }>;
  written: number;    // 实际写入的键数（与快照一致的键不会重写）
  unchanged: number;
  skipped: number;    // 当前布局不认识的键
}
```

- 只写与快照不同的键；`dryRun` 不发任何写报文。
- 快照布局与当前布局不一致时抛 `ValidationError`（避免 65/79 键互相污染）。
- 快照是**相对拍摄时刻**的：如果键早已被改成别的值，下次快照记录的就是那个值，回滚不会「猜到」出厂值——恢复出厂请用 `resetKeyRemap`。

---

## 7. 按键测试与事件

```ts
startKeyTest(options?: { mode?: 'stroke' | 'tap' }): Promise<void>
stopKeyTest(): Promise<void>
ensureKeyTestStopped(): Promise<boolean>   // 有测试在跑时结束并返回 true
get activeKeyTest(): 'stroke' | 'tap' | null
```

- `stroke`（`cmd 2/3`）：设备以约 50Hz 上报每个键的实时行程（`cmd 48`）。
- `tap`（`cmd 2/2`）：手感测试模式。
- 测试期间设备把按键变成行程上报流，**不会产生普通键入**；必须发结束命令（`cmd 2/4 + 0xFF`）才恢复。SDK 的 `disconnect()` 会自动补发；`ensureKeyTestStopped()` 可手动收尾。

### 事件

```ts
const off = kb.on('keyTravel', ({ hardCode, key, mm }) => {
  // mm 保留两位小数；空闲帧（hardCode = 0）不会派发
});
kb.once('keyRelease', ({ hardCode, key }) => { /* FF FF = 抬起 */ });
kb.on('disconnect', ({ product }) => { /* 设备被拔掉 */ });
kb.on('error', (error) => { /* 链路/解码错误 */ });
kb.on('screen:disconnect', ({ product }) => { /* 屏幕串口断开 */ });
kb.on('input', ({ frame }) => { /* 所有原始 64 字节帧，调试用 */ });
off(); // 取消订阅
```

事件表：`disconnect`、`input`、`keyTravel`、`keyRelease`、`error`、`screen:disconnect`。

---

## 8. 屏幕（Web Serial）

键盘走 HID，屏幕走独立串口（115200 8N1）。连接键盘不会触碰串口；只有在用户手势中调用 `openScreen()` 才会申请权限。

```ts
openScreen(options?: { reuseGrantedPort?: boolean }): Promise<void>
closeScreen(): Promise<void>
```

- `reuseGrantedPort: true` 会先尝试 `navigator.serial.getPorts()` 复用已授权端口（无需手势），失败再走弹框。
- 非手势调用会抛 `ScreenPermissionRequiredError`。

### `kb.screen`（`ZetsuScreen`）

| 成员 | 说明 |
| --- | --- |
| `supported` | 产品是否有屏幕 |
| `isOpen` | 串口是否已打开 |
| `open()` | 申请端口并打开（需用户手势）；传入 `{ port }` 时直接挂载已有端口，`openPort: false` 表示不关闭它 |
| `openGranted()` | 静默复用已授权端口，返回是否成功 |
| `ensureOpen()` | 已打开则直接返回，否则按 `reuseGrantedPort` 决定是否静默打开 |
| `sendImage(options)` | 发送图像 |
| `close()` | 关闭串口 |

```ts
new ZetsuScreen({
  product: ZETSU63_PRODUCT,
  port,                 // 已由页面/外部打开的 SerialPortLike
  openPort: false,      // 不调用 port.open()/port.close()
})
```

```ts
sendImage(options: {
  frames: Array<{ data: Uint8ClampedArray | Uint8Array; width: number; height: number }>;
  name?: string;                               // 默认 'gif1'，截断/补齐到 15 字节
  chunkSize?: number;                          // 113 命令分片大小，必须是 2 的倍数
  onProgress?: (p: ScreenProgress) => void;    // { phase: 'prepare' | 'transfer', percent }
}): Promise<void>
```

```ts
const canvas = document.createElement('canvas');
canvas.width = 194;
canvas.height = 368;
const ctx = canvas.getContext('2d')!;
// 把图片按 cover 画进去…
const imageData = ctx.getImageData(0, 0, 194, 368);

await kb.openScreen();               // 必须在 click 回调里直接调用
await kb.screen.sendImage({
  frames: [{ data: imageData.data, width: 194, height: 368 }],
  onProgress: ({ phase, percent }) => console.log(phase, percent),
});
await kb.closeScreen();
```

屏幕固定 **194×368**、最多 30 帧、RGB565 大端；传输分两步：`cmd 112` 准备（设备先回 ACK），再 `cmd 113` 发送像素。

---

## 9. 传输层与测试注入

`ZetsuKeyboard` 的构造函数接受 `{ transport?, candidates? }`，可注入自定义传输层（测试、Node 环境、代理设备等）。

```ts
new ZetsuKeyboard(device, product?, {
  transport?: Transport;
  candidates?: HidDeviceLike[];
})
```

### `MockTransport`

```ts
new MockTransport({ autoOpen?: boolean; sendDelayMs?: number })
```

| 成员 | 说明 |
| --- | --- |
| `sent` | 已成功发出的帧（副本） |
| `emit(frame)` | 注入一份设备回包 |
| `failNextSend(error)` | 让下一次 `send` 抛错（仅一次） |
| `setSendDelay(ms)` | 为后续 `send` 增加延迟 |
| `open()` / `close()` / `isOpen` | 链路状态 |

### `HidTransport`

```ts
new HidTransport(device: HidDeviceLike, { onDisconnect?: (device) => void })
```

WebHID 字节管道：在构造函数里挂事件监听，`open()` 可重复打开；**永远不会调用 `forget()`**。

### `SerialTransport`

```ts
new SerialTransport(port: SerialPortLike, {
  baudRate?: number;
  openPort?: boolean;
  onDisconnect?: () => void;
})
```

屏幕串口管道；`openPort: false` 表示端口已由调用方（例如被 tap 的官方页面）打开，`open()`/`close()` 不再调用 `SerialPort.open/close`。`onDisconnect` 只在非主动关闭时触发。

### WebHID / Web Serial 助手

| 函数 | 说明 |
| --- | --- |
| `isWebHidSupported()` / `isWebSerialSupported()` | 能力检测 |
| `getHidApi()` / `getSerialApi()` | 取 `navigator.hid` / `navigator.serial`（不可用时返回 `null`） |
| `requestHidDevice(filters)` / `requestHidDevices(filters)` | 封装设备选择框与取消语义 |
| `getGrantedHidDevices()` | 已授权的 HID 设备 |
| `rankHidInterfaces(devices, product)` | 按 usagePage / usage / 报告长度给接口打分排序 |
| `describeHidDevice(device)` / `describeInterface(device)` | 诊断信息 |
| `outputReportBytes(device)` | 计算可用输出报告长度 |

### 测试入口 `@bookqaq/zmeow-sdk/testing`

```ts
import { FakeHid, FakeHidDevice, makeFakeDevice, FakeSerial, FakeSerialPort } from '@bookqaq/zmeow-sdk/testing';
```

- `FakeHidDevice` / `makeFakeDevice(options)`：可配置 VID/PID、collections、`open()` / `sendReport()` 失败、记录所有发出的报告。
- `FakeHid` / `FakeSerial` / `FakeSerialPort`：模拟 `navigator.hid` / `navigator.serial`，支持记录调用与注入错误。

---

## 10. 错误类型

所有错误继承 `ZmeowError`，带 `code` 字段：

| 类 | code | 场景 |
| --- | --- | --- |
| `UnsupportedError` | `UNSUPPORTED` | 环境不支持 WebHID / Web Serial，或设备不在支持列表 |
| `UserCancelledError` | `USER_CANCELLED` | 用户取消了设备选择框 |
| `DeviceOpenError` | `DEVICE_OPEN` | `HIDDevice.open()` / `SerialPort.open()` 失败 |
| `NotConnectedError` | `NOT_CONNECTED` | 未连接就调用需要连接的 API |
| `UnknownKeyError` | `UNKNOWN_KEY` | 键不在当前布局（附带 `key`） |
| `UnknownLayoutError` | `UNKNOWN_LAYOUT` | 布局未知（`cmd 2/19` 解析失败） |
| `ValidationError` | `VALIDATION` | 参数非法（层号、usage、行程范围、快照布局不符等） |
| `TimeoutError` | `TIMEOUT` | 设备未在超时内回包（附 `command` / `subCommand`） |
| `TransportError` | `TRANSPORT` | 报告发送失败、回包解码失败、写入校验失败 |
| `SerialPermissionError` | `SERIAL_PERMISSION` | 串口授权被拒 |
| `ScreenNotConnectedError` | `SCREEN_NOT_CONNECTED` | 串口未打开 |
| `ScreenPermissionRequiredError` | `SCREEN_PERMISSION_REQUIRED` | 非用户手势中打开了屏幕 |
| `UnsupportedFeatureError` | `UNSUPPORTED_FEATURE` | 产品不支持该功能（如无屏幕） |

```ts
import { TimeoutError, ZmeowError } from '@bookqaq/zmeow-sdk';

try {
  await kb.setKeyRemap('KeyA', 'F1');
} catch (error) {
  if (error instanceof TimeoutError) console.warn('设备没回包');
  else if (error instanceof ZmeowError) console.warn(error.code);
}
```

---

## 11. 主要类型

| 类型 | 用途 |
| --- | --- |
| `KeyDef` | 键定义（hardCode / hidCode / textCode / title / geometry …） |
| `KeyLayout` | 运行时布局（mode / keyCount / hasFRow / byHardCode / byTextCode …） |
| `ProductInfo` | 产品定义（VID/PID、布局表、屏幕尺寸、行程范围） |
| `DeviceInfo` | 设备信息（boardId、sn、固件、运行模式、各项状态） |
| `LightState` / `KeyColor` | 灯效与单键颜色 |
| `FeatureKind` / `FeatureConfig` | 高级功能种类与配置 |
| `TravelEntry` / `TravelConfigEntry` | 行程配置 |
| `RemapSnapshot` / `RemapRestoreResult` / `RemapRestoreEntry` | 重映射快照与回滚结果 |
| `KeyboardConfig` / `RestoreConfigResult` | JSON 配置备份与恢复结果 |
| `LayoutOverlapInfo` | 布局重叠统计（`layoutOverlapInfo` 的返回值，见 14） |
| `KeyboardEvents` | 事件载荷表 |
| `Transport` / `HidDeviceLike` / `SerialPortLike` | 传输层接口 |

完整字段以源码 `packages/zmeow-sdk/src/types.ts` 与 `keyboard.ts` 为准（构建产物含 `.d.ts`）。

---

## 12. 内置数据

| 导出 | 内容 |
| --- | --- |
| `ZETSU63_PRODUCT` | Zetsu63 产品定义（`0x3886:0x4001`，194×368 屏幕，两种布局） |
| `KEY_LAYOUTS` | `compact65`（65 键）与 `extended79`（79 键）布局表 |
| `KEY_CATALOG` | 186 个可映射目标键（标准键、多媒体、系统热键…），含 `usage` / `textCode` |
| `LIGHT_MODES` | 10 种灯效（0 = 关闭） |
| `LIGHT_BRIGHTNESS_MAX` | 亮度上限（10） |

---

## 13. 限制与注意事项

> 页面 Tap / 主动连接（观察或改写官方驱动已有的 HID/Serial 句柄）见 [TAP.md](TAP.md)。

### 页面 Tap

`ZetsuTap` 提供两种能力：`install()` 安装页面主世界的 HID/Serial tap（只观察/改写，不打开/关闭页面句柄），`connectKeyboard()` / `connectScreen()` 在已捕获的句柄上建立主动连接。详细状态机、hooks、指纹和限制见 [TAP.md](TAP.md)。

- 只支持桌面版 Chrome / Edge 的 WebHID / Web Serial，且必须是 `https://` 或 `http://localhost` 安全上下文。
- 同一时间只能有一个页面 / 程序占用键盘 HID 或屏幕串口。
- 布局在 `connect()` 时读取一次；插拔 F 区模块后调用 `refreshLayout()`。
- 部分固件不实现某些查询：`getMacMode()`（`cmd 2/18`）在已测固件上必然超时。
- 写入可能被固件静默丢弃（`sendReport` 成功但值未变），关键写入建议 `verify: true`。
- 按键测试期间设备不产生普通键入；离开页面 / 断开连接前请结束测试（SDK 的 `disconnect()` 已自动处理）。
- 屏幕尺寸、帧数上限、命令字都是产品常量（`ProductInfo.screen`），不要按其他型号假设。


---

## 14. 配置备份 / 恢复

### 14.1 JSON 配置备份 / 恢复

`captureKeyboardConfig()` 读取键盘**当前设置**并生成一个纯数据文档；`restoreKeyboardConfig()` 把文档写回设备。两者都是 diff 写入：值相同的键不会重发报告。

```ts
import {
  captureKeyboardConfig,
  restoreKeyboardConfig,
  stringifyKeyboardConfig,
  parseKeyboardConfig,
} from '@bookqaq/zmeow-sdk';

const config = await captureKeyboardConfig(kb);
const json = stringifyKeyboardConfig(config);       // 建议下载为 .json
localStorage.setItem('zmeow-backup', json);

// 恢复（字符串或对象均可）
const result = await restoreKeyboardConfig(kb, json);
console.log(result.remap?.written, result.colors, result.travel, result.features);
```

可靠性默认值（针对固件可能「确认写入但不生效 / 静默丢弃」的行为，见 `docs/PROTOCOL.md` 9.9/9.10）：

- `verifyRemap` 默认 **true**：每层写完等 `settleMs`（默认 250ms）回读，只对没写进去的键按驱动节奏重写一次；仍不一致抛 `TransportError`。显式传 `verifyRemap: false` 可关闭。
- `verifyTravel` 默认 **true**：`setTravelConfig` 先按官方 10ms / 5ms / `块数×10+100ms` 节奏写完并 settle，再回读行程表；丢写的键重写一次，仍不一致记 `warning`（不抛错）。
- `writeGapMs` 默认 **300**（与官方驱动一致）：批量 `cmd 35` 写入之间留间隔。
- `featureGapMs` 默认 **500**：高级键 set 后、单独 cancel 后、以及每次 `cmd 47` 读 feature 表前留的安静窗；`featureClearGapMs` 默认 **1000**（官方预清后 sleep(1000)，MPT 为 500；SDK 统一用保守值）：`cmd 47` 清除已有 feature 后到写新 feature 之间的间隔。连续紧贴的写入会被固件丢掉，也会把后续 `cmd 47` 读排进写队列导致超时。
- 2026-11-12 真机复核（extended79 / 固件 1.1.1）：3 键 `setTravelConfig` 129ms、58 键 377ms；写后 `getTravelConfig` ×4 / `getFeatures` ×5 均无超时；定向还原（travel + features）2.21s、warnings 0、回读 0 mismatch。
- 备份时某一层读不到（如固件不支持的层、共享句柄下瞬时超时）只记入 `warnings` 并跳过该层，**其余层照常备份**；恢复时文件里没有的层保持原样。

备份内容：

| 字段 | 内容 |
| --- | --- |
| `remap.layers` | 0 / 1 / 2 三层的 `hardCode -> HID usage`（读不到的层整个缺失，见 `warnings`） |
| `light` | 灯效模式、速度、方向、亮度、colorful、颜色 |
| `keyColors` | 每个键的颜色与亮度 |
| `travel` | 每个键的触发行程、释放行程、死区、快速触发 |
| `features` | RS / SOCD / MT / TGL / MPT / END / DKS 的当前配置 |
| `misc` | Win 锁、灯光休眠 |
| `product` / `layout` / `firmwareVersion` | 来源设备信息；不含 SN / boardId 等设备标识 |

默认恢复全部内容；可用 `restoreLight`、`restoreKeyColors`、`restoreTravel`、`restoreFeatures`、`restoreMisc` 单独跳过。`allowLayoutMismatch: true` 允许把 65 键备份恢复到 79 键设备（重叠键生效，未知键计入 `warnings`）。

- 恢复前自动结束按键测试。
- 备份里的 feature 在设备上不存在时会写入；设备上多出来的 feature 默认清理（`clearExtraFeatures: false` 可保留）。
- 按官方流程，写入某个 feature 前会先清除该键已有的 feature（**即使 kind 相同**），等 `featureClearGapMs` 后再写；清除前先做可恢复性校验，DKS/缺参数条目只记 `warnings`，不会先把设备上的 feature 清掉。
- 高级键写完后回读 feature 列表校验：没被设备采纳的键会先「清理 + 重写」一轮，仍不生效记入 `warnings`（`The device did not adopt the ... feature`）。
- **DKS 无法恢复**：SDK 没有 DKS 写命令；默认跳过并写入 `warnings`，`onUnsupportedFeature: 'error'` 可改成直接报错。
- 备份不包含设备 SN / boardId；固件版本保留用于诊断。解析旧备份时会丢弃遗留的 `boardId` / `serialNumber` 字段。

#### `layoutOverlapInfo(sourceLayout, targetLayout)`

```ts
function layoutOverlapInfo(
  sourceLayout: 'compact65' | 'extended79',
  targetLayout: 'compact65' | 'extended79',
): LayoutOverlapInfo
```

计算两个布局的重叠情况（按 `hardCode` 集合比较），返回 `{ sourceLayout, targetLayout, sharedKeys, skippedKeys }`：

- `sharedKeys`：两个布局共有的键数——跨布局恢复时这些键会写入；
- `skippedKeys`：源布局有、目标布局不认识的键数——跨布局恢复时跳过并计入 `warnings`。

纯数据计算，不连接设备。配置还原（`allowLayoutMismatch: true`）与油猴脚本扩展导入（Wooting profile）在展示「布局不一致」确认对话框时，都用它统计重叠键数，保证两处口径一致。

### 14.2 Better ZetsuMeow Driver（油猴脚本）

构建后的面板：

- **Backup JSON**：连接键盘后下载当前设置；
- **Restore JSON**：选择备份文件后写回；
- **Import Wooting profile**：Wooting 导入不是 SDK 的能力，而是油猴包内的扩展（`packages/zmeow-userscript/src/wooting/`）——分享码经桥接 / 页面 fetch 取回、转换成本节的备份格式 JSON 后，走 `restoreKeyboardConfig()` 路径写设备；布局不一致确认对话框同样作用于该导入。取数、转换与应用的完整流程见 [TAP.md](TAP.md) §5。

脚本仍然只调用 SDK，不直接 patch `navigator.hid` / `navigator.serial`。
