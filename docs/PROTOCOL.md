# ZetsuMeow 协议说明

本文记录 `@bookqaq/zmeow-sdk` 实现所依据的 ZetsuMeow 键盘协议与实测结果。内容只描述可观察行为、帧格式和 SDK 实现所依赖的结论，不包含驱动内部实现细节。

> 若后续固件或页面更新导致行为变化，请以真机验证结果为准，并同步修订本文件与 `src/protocol/`。

## 1. 链路总览

| 链路 | 技术 | 用途 |
|---|---|---|
| 键盘 | WebHID（`HIDDevice.sendReport(0, 64B)`） | 设备信息、灯效、重映射、高级键、行程、按键测试 |
| 屏幕 | Web Serial（115200 8N1） | 屏幕图片 / GIF 上传 |
| 屏幕（旧） | WebHID | 未实现（没有可用的写入路径） |

键盘与屏幕是**两条独立链路**：先连键盘（屏幕过滤器需要产品的 `vid`/`pid_screen`），屏幕只在用户进入「屏幕编辑」并点击连接时才申请串口权限（懒连接）。

## 2. HID 帧格式

写报告固定 64 字节，reportId = 0：

```
偏移  含义
[0]   head = 0xAB（product.head_num）
[1]   payload 长度 L（1..60）
[2]   命令码 cmd
[3]   校验和 = (L + cmd + payload[L-1]) & 0xFF
[4..] payload（L 字节）
剩余    补 0
```

校验规则：`checksum = (payload 长度 + cmd + payload 最后一个字节) & 0xFF`；注意只累加「长度 + 命令 + 最后一个 payload 字节」，不是整帧求和。

回包通过 `oninputreport` 到达，同样是 64 字节帧，`[0]=0xAB`、`[1]=L`、`[2]=cmd`；`cmd=2` 时 `[5]` 为子命令。

## 3. 写命令表

| cmd | 名称 | payload（从 `[4]` 起） | 长度 |
|---|---|---|---|
| 1 | 设备信息 | `FF FF` | 2 |
| 2 | 杂项（`[4]`=子命令） | `[sub, param]` | 2 |
| 17 | 侧灯读 | `00 FF` | 2 |
| 19 | 灯效读/写 | 读 `00 FF`；写 `01 mode speed turn gray r g b colorful` | 2 / 9 |
| 20 | 单键 RGB 读/写 | 读 `00 FF`；写 `01 count (hardCode r g b gray)*count` | 2 / 5n+2 |
| 35 | 重映射读/写 | 读 `00 fnNum FF`；写 `01 fnNum hardCode hidHi hidLo` | 3 / 5 |
| 36 | MT 读/写 | 读 `00 hardCode 00 00 00`；写 `01 hardCode hid1H hid1L hid2H hid2L time` | 5 / 7 |
| 37 | TGL 读/写 | 读 `00 hardCode 00 00 00`；写 `01 hardCode hidH hidL time` | 5 / 5 |
| 38 | DKS 读 | `00 hardCode 00 00 00` | 5 |
| 39 | MPT 读/写 | 读 `00 hardCode 00 00 00`；写 `01 hardCode mm1(2) hid1(2) mm2(2) hid2(2) mm3(2) hid3(2)` | 5 / 14 |
| 40 | END 读/写 | 读 `00 hardCode 00 00 00`；写 `01 hardCode hidH hidL time` | 5 / 5 |
| 41 | 行程批量读/写 | 读 `00 FF`；写 `01 total (hardCode type dd(2) du(2) tr(2) fo(2) up(2) dn(2))*n`，`total` 是本次写入的**总键数**（跨帧不变），单帧最多 4 键（`14*4+2=58 ≤ 60`） | 2 / 14n+2 |
| 43 | SOCD 读/写 | 读 `00 hardCode 00 00 00 00 00`；写 `01 k1 first1 k2 first2 bottom time` | 7 / 7 |
| 45 | RS 读/写 | 读 `00 hardCode 00 00 00`；写 `01 k1 k2 bottom time` | 5 / 5 |
| 47 | 特性批量读 / 清除 | 读 `00 FF`；清除 `01 hardCode` | 2 / 2 |
| 52 | JZ 颜色读 | `00 00 00 00 00 00 00` | 7 |
| 32 | 宏归属读 | `00 00 00 FF FF` | 5 |

> 单键特性读取（cmd 36/37/38/39/40/45）固定 5 字节、SOCD（cmd 43）固定 7 字节。长度必须与固件预期一致，不能只发 2 字节。

固件升级命令（64–86）不在 SDK 范围内，仅保留编号。

### 3.1 cmd 2 子命令

| 子命令 | 含义 | 请求第二字节 | 回包 `[6]` |
|---|---|---|---|
| 2 | 开始手感测试 | 0 | — |
| 3 | 开始单键行程测试 | 0 | — |
| 4 | 结束测试 | `FF` | — |
| 5 | 恢复出厂 | 0 | — |
| 6 | 读 Win 锁 | 0 | 1 = 锁定 |
| 7 | 写 Win 锁 | 驱动固定 0 | **`[7, 0]` 是切换（toggle）**：驱动忽略目标值、只在状态与目标不同才发送；`[7, 1]` 驱动从不发送，语义未验证 |
| 9 | 读高精度 | 0 | 1 = 开启 |
| 12 | 读 pz_num | `FF` | 配置编号 |
| **13** | **写灯光休眠** | 分钟数 | — |
| 14 | 读灯光休眠 | 0 | 分钟数 |
| 15 | 写状态（锁） | 值 | — |
| 16 | 读状态 | 0 | 锁定值 |
| 18 | 读 Mac 模式 | 0 | 1 = Mac |
| **19** | **读 F 区模式** | 0 | **79 = 装 F 区** |

> 灯光休眠的写命令是子命令 13，读是 14，容易混淆。

### 3.2 cmd 41 / cmd 47 的单个与批量语义

- **cmd 41 同时支持单键与批量写入**，两者共用同一帧格式：`[4]=1, [5]=total`，随后每键 14 字节；`total` 是本次写入的**总键数**，跨帧不变。单键写 `total=1`、只有一帧；批量写 `total=N`，拆成 `ceil(N/4)` 帧，每块最多 4 键。固件对写入不回 ACK。
- 官方驱动没有第二条“单键命令”：单键与批量共用同一条命令，选中 1 键即单键，全选即批量。
- **cmd 47 没有批量写**：写只有 `[4]=1, [5]=hardCode` 的单键清除；官方所谓的“批量清特性”是逐键循环 cmd 47，不是协议级批量。读则是批量的 `[0, 0xFF]`，回包从 `[5]` 起每 2 字节一对 `(hardCode, featureCmd)`。
- **高级键设置不走 cmd 47**：MT/TGL/MPT/END/RS/SOCD 分别用 cmd 36/37/39/40/45/43 的**单键**命令写入；因此“批量设置特性”在协议层不存在，只能由客户端逐键写并自行控节奏。
- 官方完整的写入节奏见 §9.10；它也是 SDK `setTravelConfig` 与 config restore 的节奏依据。

## 4. 回包解析

| cmd | 含义 | 布局（帧索引） |
|---|---|---|
| 1 | 设备信息 | `[5]`=运行模式(1 app/2 boot)，`[5..8]`=boardId(十六进制)，`[6..26]`=SN(ASCII)，`[27..37]`=固件版本(ASCII，按 `.` 分三段) |
| 2 | 杂项 | `[5]`=子命令，`[6]`=值（见 §3.1） |
| 19 | 灯效 | `[5]`=mode，`[6]`=speed，`[7]`=turn，`[8]`=gray，`[9..11]`=RGB，`[12]`=colorful |
| 20 | 单键 RGB | 11 组，基址 `[5+n*5]`：hardCode, r, g, b, gray |
| 35 | 键位映射 | `[1] > 3` 时从 `[5]` 起每 3 字节：hardCode, hidHi, hidLo；双 0 表示未分配 |
| 36 | MT | `[5]`=hardCode，`[6..7]`/`[8..9]`=两个 usage，`[10]`=时间字节 |
| 37 | TGL | `[5]`=hardCode，`[6..7]`=usage，`[8]`=时间字节 |
| 38 | DKS | 布局与请求长度不一致（疑似死代码），SDK 只返回 hardCode |
| 39 | MPT | `[5]`=hardCode，随后三组 (mm 2B, usage 2B)：`6..9`、`10..13`、`14..17` |
| 40 | END | `[5]`=hardCode，`[6..7]`=usage，`[8]`=时间字节 |
| 41 | 行程批量 | 4 组，基址 `[5+n*14]`：hardCode, type(1/2), deadDown(2), deadUp(2), travel(2), fastOut(2), up(2), down(2) |
| 43 | SOCD | `[5]`=k1，`[6]`=first1，`[7]`=k2，`[8]`=first2，`[9]`=bottom，`[10]`=时间字节 |
| 45 | RS | `[5]`=k1，`[6]`=k2，`[7]`=bottom，`[8]`=时间字节 |
| 47 | 特性列表 | 从 `[5]` 起每 2 字节：hardCode, 特性命令码（43/44=SOCD，45=RS，36=MT，37=TGL，38=DKS，39=MPT，40=END） |
| 48 | 单键行程事件 | `[5]`=hardCode，`[6..7]`=行程 µm；`FF FF` 表示抬起 |
| 102 | 12 键行程流 | 从 `[4]` 起每组 5 字节：hardCode, adc(2), travel(2) |

数值换算：

- 行程 `mm → bytes`：`round(mm * 10000)`，2 字节大端。
- **步进 0.01mm**：固件按 0.01mm 网格采纳行程值。SDK 在编码前先把值四舍五入到 0.01mm（`mmToTravelBytes`），否则设备自行取整会导致写后读回不一致。
- **硬件范围**：Gateron 磁轴触发行程 0–4mm（布局每键 `minTravel: 0.01` / `maxTravel: 4`）。原驱动 UI 的滑条预设为 0.1–3.1mm；SDK 校验以布局键范围为准。
- 回包 µm → mm：`value / 10000`，保留 2 位小数。
- MT/TGL 时间：`round(ms/10)` 单字节；回包 `×10` 得 ms。
- RS/SOCD 暂停：驱动固定 `10/10 = 1`；SDK 用 `round(ms/10)`，默认 10ms → 1。
- MPT 的三段时间字段实际使用**行程编码**（mm×10000，2 字节），不是毫秒。

## 5. 双布局（65 / 79 键）

产品对象同时含 `keys0`（65 项）与 `keys1`（79 项）：

- `keys1` 是 `keys0` 的超集，多出 14 个 `is_f: 1` 的键：`Esc(0x00)`、`F1..F12(0x01..0x0C)`、`DEL(0x4F)`。
- 模式由设备上报：

```
cmd==2 && [5]==19：
  [6]==79 → is_f=1，使用 keys1（79 键，装 F 区组件）
  否则     → is_f=0，使用 keys0（65 键）
```

- 判定后驱动会重新拉取该模式下的全部配置，因为行程/特性都挂在 `hard_code` 上。
- 用户口语中的「78 键」与 79 条目（14 个 F 区条目中含 Esc 与 Del）计数口径不同；SDK 以设备上报为准，并暴露 `layout.keyCount`。
- SDK 的两种模式名：`compact65`、`extended79`；`cmd 2/19` 超时或未识别时为 `unknown`，键相关 API 抛 `UnknownLayoutError`。

> 源键（被设置的键）必须存在于当前布局；目标键（映射到的键）来自 186 键的键目录，因此 65 键模式下把某个键重映射到 F1 是合法的，而把 F1 当作源键则会报错。

## 6. 屏幕串口协议

帧格式（与 HID 不同，长度可变）：

```
[0]   head = 0xAB
[1..4] payload 长度（4 字节大端）
[5]   cmd
[6]   校验 = (payload 长度 + cmd + payload 末字节) & 0xFF
[7..] payload
```

| cmd | 方向 | payload | 含义 |
|---|---|---|---|
| 112 | 主机→设备 | `[0]=0, [1]=帧数, [2..16]=15 字节名字` | 准备上传（名字默认 `gif1`） |
| 112 | 设备→主机 | `[0] >= 1` | 允许传输 |
| 113 | 主机→设备 | `[0]=0` + 全部 RGB565 数据 | 传图像数据 |

图像规格：**194×368**，RGB565（`(r>>3)<<11 | (g>>2)<<5 | (b>>3)`，2 字节大端/像素），GIF 多帧时把各帧字节直接拼接在同一条 113 中，最多 30 帧。

时序：

```
用户点击「连接屏幕」
  → navigator.serial.requestPort({filters:[{usbVendorId:0x3886, usbProductId:0x4001}]})
  → port.open({baudRate:115200, dataBits:8, stopBits:1, parity:'none', flowControl:'none'})
  → 发 112（帧数 + 名字）
  → 等设备回 112 且 payload[0] >= 1
  → 发 113（全部像素）
```

懒连接要求（SDK 行为）：

1. 键盘 `connect()` **不触碰**任何 `navigator.serial` API。
2. 只有 `openScreen()`（用户手势内）或显式允许复用已授权端口时才会申请串口。
3. 键盘与屏幕生命周期独立；`disconnect()` 默认同时关闭屏幕，可用 `{ keepScreen: true }` 保留。
4. 不做自动重连（与驱动一致）。

## 7. 连接握手

```
HID: navigator.hid.requestDevice({filters:[{vendorId,productId}]})
  → device.open()
  → cmd 1            设备信息（boardId / SN / 固件版本 / 运行模式）
  → cmd 2/12         pz_num
  → cmd 2/19         F 区模式 → 决定键表（65 / 79）
  → 之后按需读取灯效、键位、特性、行程
```

驱动额外要求 `collections.length == 1 && usage == 1 && usagePages 含 usagePage`；SDK 放宽为在多个 collection 中按 `usagePage(0xFF00/0x00FF) + usage(1)` 选择，并且**不会**像驱动那样对已授权设备调用 `forget()`。

## 8. 已知缺口与规避

| 缺口 | SDK 处理 |
|---|---|
| 对已授权设备调用 `forget()` | 不调用 |
| HID 屏幕链路不可用 | 只实现串口链路 |
| 写 Win 锁命令忽略入参、不下发值 | 视为 **toggle**：SDK 的 `setWinLock(value)` 先读当前状态，不同才发 `[7, 0]` 切换（与驱动的状态守卫一致，幂等）；省略参数时原样发送 `[7, 0]` |
| SN / 鼠标 / 接收器相关命令为空实现 | v1 不支持 |
| 宏只有读命令（cmd 32），无写命令 | 不支持宏写入 |
| 设备刚 open 后直接发送会失败 | 先 `await open()` 再发 |
| DKS 回包布局自相矛盾 | 只返回 hardCode，不解析细节 |

## 9. 真机验证记录（ZetsuMeow Dimension Pro，2026-11-03）

以下数据来自真实设备（`3886:4001`，固件 `1.1.1`）在 Chrome 中的实测。

### 9.1 复合设备与接口选择

设备是复合设备，`navigator.hid.requestDevice({filters:[{vendorId,productId}]})` 会一次返回 **3 个顶层 collection**（每个都是独立 `HIDDevice`）：

| # | usagePage | usage | 用途 | 是否可发 64 字节报告 |
|---|---|---|---|---|
| 1 | `0x000C` | `0x01` | Consumer Control | 否（`sendReport` 失败） |
| 2 | `0xFF00` | `0x01` | 厂商接口（键盘协议） | **是** |
| 3 | `0x0001` | `0x02` | Mouse | 否 |

因此**不能取 `devices[0]`**。SDK 的排序规则：`usagePage ∈ 产品 usagePages` +8、`usage == product.usage` +4、`collections.length == 1` +2，另在 Chrome 暴露报告长度时对 64 字节 output 报告 +6；连接失败时还会按排名依次回退尝试其余接口。

对 `0xFF00` 接口发送 `AB 02 01 03 FF FF`（cmd 1）得到回包：

```
AB 22 01 2B 00 01 ...
head=0xAB len=0x22(34) cmd=1 crc=0x2B
payload: 00 01 ...   // [1]=runMode=1(app)，后续为设备标识与固件版本
```

Chrome **不下发** `reportCount` / `reportSize`（实测只有 `reportId`），所以 SDK 不能依赖报告长度做判别，只能把缺失当作 `unknown`。

### 9.2 固件声明的长度小于实际字段位置

真机回包存在「`[1]` 长度字节比实际写入字段更短」的情况，**固定偏移字段必须按帧绝对偏移读取，不能按 `[1]` 截断**：

| 回包 | 声明长度 | 实际字段位置 | 现象 |
|---|---|---|---|
| cmd 2（读 pz_num / f_mode / 状态 …） | `2` | 值在帧 `[6]` | 按长度截断会丢值 |
| cmd 19（读灯效） | `8` | `colorful` 在帧 `[12]` | 按长度截断会误判为非法回包 |
| cmd 36/37/38/39/40/43/45（高级键单键读） | 待真机抓帧确认（2026-11-08 间接实测：cmd 45 回包声明字节少于实际字段） | 字段在帧 `[5..]` | 按长度截断使 `decodeFeature` 返回 null——备份里 RS 只剩 kind 没有参数，还原时报「has no second key」跳过 |

实测样本：

```
cmd 2/12  → AB 02 02 05 00 0C 01       // pz_num = [6] = 1
cmd 2/16  → AB 02 02 04 00 10 00       // status = [6] = 0
cmd 2/19  → AB 02 02 45 00 13 41       // f_mode = [6] = 0x41 = 65
cmd 19    → AB 08 13 1C 00 00 00 00 00 00 00 00 01   // 灯效全 0，colorful=[12]=1
```

模式字节语义（cmd 19，读与写同布局，写入 `[4]=1`）：`0` = 关闭，`1..9` = 内置灯效，**`255` = 轴体单键自定义**——设备把每键颜色/亮度存在 cmd 20 的键色表里，全局 speed/turn/gray 字节在该模式下报 0（2026-11-08 实测：处于单键自定义的设备回包 `mode=255, speed=0, turn=0, brightness=0, colorful=1`；驱动切换到该模式时把 `mode` 直接写 255，并在回包 `mode=255` 时追加一次 cmd 20 读）。SDK `setLight` 必须接受 255，否则单键自定义模式的备份无法还原。

- **写键色前的必要前置**：官方驱动每次发 cmd 20 键色写之前都会先写 cmd 19 mode=255。`restoreKeyboardConfig` 自动满足该前置：还原按「先写灯效、再写键色」的顺序执行，而 Wooting 导入扩展转换出的备份文档 `light` 块固定携带 mode 255（单键自定义），因此经还原路径写键色前设备已处于 255。直接调用 `setKeyColor(s)` 的调用方必须自行保证设备处于 255，否则键色写不生效。
- **mode 255 下不要用回包亮度当写色默认值**：该模式回包 `brightness=0`，而 `setKeyColor(s)` 缺省亮度回退 `lightState.brightness`——不显式传亮度会写出亮度 0 的键色条目。Wooting 导入扩展转换出的备份文档写的是转换后的显式亮度（Wootility 0..255 → Zetsu 0..10），`restoreKeyboardConfig` 的 `setLight` / `setKeyColors` 也都写显式亮度，均不受影响（2026-11-11 实测，Dimension Pro 固件 1.1.1）。
- **键色表与行程表的键位覆盖不一致**（固件特性）：同一设备上颜色表（cmd 20 读）覆盖 0x1–0xaa 的 72 键，行程表（cmd 48 读）覆盖 58 键，且两者缺的键不同（如 0xf 在颜色表不在行程表、0x10 相反；0x0 在两个表都不存在）。读回校验时不能假设两表键集相同。

### 9.3 多帧回包

一次请求会返回多帧，必须收齐（SDK 用「帧间静默 90ms 或达到帧数上限」收集；首帧最长等 1.5s，不受 90ms 限制——设备忙时首帧可能晚到，见 9.9）：

| 命令 | 分帧 | 实测帧数（65 键） |
|---|---|---|
| cmd 35 读键位 | 每帧约 17 个三元组 | 4 |
| cmd 47 读特性 | 每帧 29 对 | 3 |
| cmd 20 读键色 | 每帧 11 键 | 6 |
| cmd 41 读行程 | 每帧 4 键 | 12 |

### 9.4 实测读写结果

| 能力 | 结果 |
|---|---|
| 连接握手 | 7ms；`layout=compact65`、65 键、`rawFMode=65` |
| 设备信息 | `boardId=<redacted>`、`SN=<redacted>`、`firmwareVersion=1.1.1`、app 模式 |
| `getLight` | 成功（mode 0、rgb `#000000`、colorful 1） |
| `getWinLock` / `getStatus` / `getLightSleep` | `false` / `false` / `0` |
| `getKeyMap(0)` / `(1)` | 61 键；Fn 层出现 `0xF100` 这类扩展码 |
| `getFeatures` | 62 项，全部 `none` |
| `getKeyColors` | 61 项；亮度上报 **17**（超过 UI 上限 10，SDK 按驱动行为 clamp 到 10） |
| `getTravelConfig` | 48 项；默认 2.0mm、死区 0.2mm |
| 写入 | `setKeyRemap` 写回原值后读回一致；`setLightSleep(0)`、`setWinLock(false)` 均被设备接受 |
| `getMacMode`（cmd 2/18） | 该型号**无回包**（超时），SDK 保留 API 并抛 `TimeoutError`，文档标注可能不支持 |

### 9.5 仍未验证

- 屏幕 Web Serial 链路（需要串口授权与屏幕硬件）。
- 按键测试流（cmd 48 / 102）的实时上报。
- 79 键（F 区组件）模式：当前设备上报 65，未接 F 区。
- `setMPT` / `setEND` / `setTGL` / `setSOCD` / `setRS` 的写入与回读一致性。

### 9.6 第二轮真机验证（行程 / 按键测试）

| 项目 | 实测结果 |
|---|---|
| 按键测试启动 | `cmd 2/3`（stroke）与 `cmd 2/2`（tap）均被接受，`cmd 2/4 (+FF)` 停止 |
| 测试数据流 | 只有 **cmd 48**，约 **50Hz**，未观察到 cmd 102（该型号用单键轮询而非 12 键批量） |
| cmd 48 回包 | `[1] = 3`（声明长度偏短），实际字段：`[5]=hardCode`、`[6..7]=行程 µm`；`FF FF`=抬起；`hardCode=0` 为空闲帧 |
| 单键行程写入 | `cmd 41` 只写 1 条（`total=1`）时只影响该键；KeyA 2.0→2.4mm，回读 2.4mm，其余键不变 |
| cmd 41 回读语义 | 官方驱动对 `type=1`（普通键）跳过 `travelUp/travelDown/fastOut` 字段，SDK 同样跳过；`releaseMm=pressMm`、`fastOut=0` 是 SDK 的回读归一化，不等于固件把这三个字段写成了 0。只有 `type=2` 才解析 RT 字段 |

解码规则：

- `cmd 48` 必须按帧绝对偏移解析（不能按 `[1]` 截断），并跳过 `hardCode=0`。
- `cmd 41` 的 `releaseMm`：`fast=false` 时取 `pressMm`；`fast=true` 时取 `travelDown`（为 0 再回退 `pressMm`）。
- `cmd 102` 仍保留解析（面向其他固件），但当前型号不会发送。

API 侧新增 `getKeyTravel(key)` / `setKeyTravel(key, patch)`，Playground 选中单键时会自动读取该键当前行程并只写该键。

### 9.7 重映射恢复

- 设备没有“恢复映射”专用命令，恢复 = 用 `cmd 35` 写回默认 usage。
- 基础层默认值来自键表 `hid_code`：真机校验 65 键中 60 键与设备当前值一致，其余 5 键为用户自定义或工厂差异。
- Fn 层（layer 1）多数键出厂值为 **0（无覆盖）**；`hid_code_fn1` 并非设备 Fn 层实际值（实测 22 个带该字段的键中只有 7 个匹配，其余设备返回 0，且该字段含 `0x10xx/0xF3xx` 这类非设备实际 usage 的编码）——SDK 不据此恢复。
- 真机验证：KeyA 重映射为 58 后调用恢复，读回 4（键表默认），其余键与条目数不变。

### 9.8 快照回退（恢复到「本次修改前」）

- 映射表没有“撤销”命令，回退同样是读取 + 定向写回：`captureRemapSnapshot({ layers })` 用 `cmd 35` 读整层（基础层 61 条实际条目、4 帧），`restoreRemapSnapshot(snapshot)` 先重读该层，**只对 `from !== to` 的键发 `cmd 35` 写**，未变化的键不发任何报文。
- 快照为纯数据（`{ takenAt, layout, layers[layer][hardCode] = usage }`），可落 `localStorage`；`layout` 用于拒绝跨布局（65 ↔ 79）恢复。
- 真机验证（Dimension Pro，固件 1.1.1，`compact65`）：
  - 基础层：快照 KeyA=4 → 写 58 → `dryRun` 报 `written=1`（58→4）且设备仍为 58 → 恢复写入 1 键（`unchanged=60`）→ 读回 4，KeyB 仍为 5，映射条目数仍 61 → 再次恢复 `written=0 / unchanged=61`（幂等）。
  - Fn 层：快照 layer 1 KeyA=0 → 写 58 → 读回 58 → 恢复写入 1 键（58→0）→ 读回 0，layer 0 的 KeyA 仍为 4。
  - Playground 全链路：页面连接 → UI 重映射 A→F1（探针读回 58）→「恢复到本次修改前」（日志 `写入 1 个键，60 个键已一致；A 0x003A→0x0004`）→ 探针读回 4。
- 页面每次「重映射」/「恢复默认映射」前自动拍快照入栈（上限 20、断开清空）；「恢复到本次修改前」按栈回退，写后回读并打印 `from → to`。

### 9.9 写配置的可靠性

- **写入确认**：`cmd 35` 等写命令可能返回成功但设备没有采纳。SDK 在 `settleMs`（默认 250ms）后回读该层，只对不一致的键重发一次；仍不一致抛 `TransportError`。对应 `verify: true`，Playground 默认开启并打印读回确认。
- **批量还原**：`restoreKeyboardConfig()` 默认开启 `verifyRemap`（`settleMs` 250ms），按 `writeGapMs` 300 / `featureGapMs` 500 / `featureClearGapMs` 1000 的节奏分批写入；高级键先清后写，写后回读 feature 列表，未采纳的键清理后重写一次，仍不一致记 `warnings`。`captureKeyboardConfig()` 对单层 `cmd 35` 读失败跳过该层并记 `warnings`，避免一个读不出来的层让整个备份失败。
- **按键测试收尾**：按键测试（`cmd 2/3` stroke 或 `cmd 2/2` tap）会以约 50Hz 上报 `cmd 48` 行程流，必须发 `cmd 2/4 + 0xFF` 才回到正常键入。`disconnect()` 在关闭链路前补发结束命令；`kb.activeKeyTest` / `kb.ensureKeyTestStopped()` 暴露状态；Playground 在断开、`pagehide` 和所有写配置按钮前自动结束测试并记日志。
- **「本次修改前」快照语义**：快照记录拍摄时刻设备上的值，不一定是出厂默认；恢复出厂用 `resetKeyRemap`，不要用「恢复到本次修改前」代替。
- **共享句柄与多帧收集**：Tap / 油猴脚本与官方驱动共用一个 HID 句柄时，页面自己的收发会让首帧晚到。多帧收集采用「帧间静默 90ms 收齐，首帧最长等 1.5s」；`getKeyMap()` 超时后自动重试一次（间隔 200ms）。
- **`cmd 47` 特性读取**：单次读实测耗时约 256–1001ms，共享句柄叠加页面流量后可能超过 1.5s。`getFeatures()` / `getKeyColors()` / `getTravelConfig()` 和 `getKeyMap()` 一样在超时后 200ms 重试一次；`captureKeyboardConfig` 对特性读失败记 `warnings` 并标记 `featuresRead: false`；还原侧读到失败或标记时跳过特性步骤且不清空设备特性，只记 warning。feature 阶段每次 `cmd 47` 读前留 500ms 安静窗，预清后等 1000ms 再写。
- **`cmd 41` 写行程**：官方写入节奏是 `sleep(10)` → 每块（≤4 键）前 `sleep(5)` → 尾部 `sleep(块数×10 + 100)`，没有写后读回。`setTravelConfig` 对齐该节奏；`restoreKeyboardConfig` 的 `verifyTravel`（默认开）在 settle 后回读，重写丢失键一次，仍不一致记 warning，比较按 `cmd 41` 回读语义归一化。
- **恢复出厂后的特性读取**：`cmd 2/5` 后有约 5s 的 `cmd 47` 无响应窗口；特性读重试和 config 容错可以保证还原不中断，特性步骤可能以 warning 降级。
- **真机验证**（2026-11-12，extended79 / 79 键 / 固件 1.1.1）：
  - `setTravelConfig` 3 键 **129.1ms**、58 键 **377.3ms**（含 HID 往返；理论值 125 / 335ms，尾部 settle 生效）。
  - 写后 `getTravelConfig` 4 次 **124.4–129.6ms**、`getFeatures` 5 次 **98.3–100.8ms**，全部成功；全程无 `Timed out waiting for command 41/47`。
  - 写入 1.2 / 1.6 / 2.4mm（第三键带 RT）与 `CapsLock` 的 MT 后，用 baseline 做 travel + features 的定向 restore：**2210.5ms**、warnings 0、`features.cleared=1`、travel mismatch 0、feature mismatch 0；结束后 3 个 HID 句柄均 `opened:false`。

### 9.10 cmd 41 / 47 写入节奏（2026-11-12）

> 目的：给 `setTravelConfig` 和 config restore 的 feature 阶段一个可对照的官方基线。下表只保留可观察的时序结果。

| 操作 | 节奏 |
|---|---|
| cmd 41 写（单键/批量） | `sleep(10)` → 每个 ≤4 键块前 `sleep(5)` 再发送 → `sleep(块数×10)` + `sleep(100)` |
| cmd 41 整表读 | 所有键 `to_set=1` → 发 `[0,0xFF]` → `sleep(500)` → 统计未确认键 → `sleep(10)` 重试 |
| cmd 41 读后接 cmd 47 | cmd 41 读后 `sleep(50)` 再进入特性读取 |
| cmd 47 读列表 | 发 `[0,0xFF]` → `sleep(10)` → 逐族读单键：族间 10ms、键间 55ms |
| cmd 47 单键清除 | 发 `[1,hardCode]`；单独 cancel 后 `sleep(500)`；设置前预清后 `sleep(1000)`（MPT 500） |
| 高级键设置 | 单键命令写后 `sleep(500)` |

伪代码（官方写入行程）：

```js
await sleep(10);
const chunks = chunk(entries, 4);
for (const chunk of chunks) {
  await sleep(5);
  writeChunk(total, chunk); // 官方没有 await，5ms 是提交间隔
}
await sleep(chunks.length * 10);
await sleep(100);
```

要点：

- 单键与批量只在 entries 数量上不同；`total` 始终是总键数，不是本帧键数。
- 官方**没有**写后读回校验；500ms 是整表读取轮询，不是写入确认。
- 官方 cmd 47 只有单键清除，批量清特性是逐键循环。
- 官方发完 cmd 47 只等 10ms 就开始逐族读，并不等列表收齐；这是官方自身的竞态，SDK 不应照搬。
- 因此 SDK 的顺序是：先按官方节奏写完 cmd 41 并 settle，再读 cmd 41；每次 cmd 47 读前留安静窗；cmd 47 预清后等 1000ms 再写。
