# Wootility Web 配置导入

本文记录 **Better ZetsuMeow Driver** 油猴脚本从 Wootility Web profile 导入到
Zetsu 键盘时的字段口径、支持范围和限制。实现位于 `packages/zmeow-userscript/src/wooting/`。

## 1. 数据流与 schema

Wootility Web v5.4.2 的分享 profile 先经过 Wootility 自身的迁移，再交给页面编辑器使用；当前页面 profile schema 为 **15**。

导入入口接受以下形状：

- 裸 profile 对象；
- `{ "data": profile }`；
- 单元素数组，或 `{ "data": [profile] }`。

多 profile 数组会明确报错，不会猜测使用哪一个。

| schema | 导入策略 |
| --- | --- |
| `> 15` | 拒绝，抛 `WootingProfileVersionError`；面板提示配置版本过新 |
| `9–15` | 按 §4 功能矩阵兼容 |
| `< 9` | 尽力导入，记录 legacy warning；不推测旧 remap / DKS 结构 |

## 2. 支持设备

| 型号 | `target.device` | Zetsu 目标布局 |
| --- | --- | --- |
| Wooting 60HE / 60HE AVR / 60HE+ / 60HE v2 | 4 / 5 / 9 / 11 | `compact65` |
| Wooting 80HE / 80HE+ | 10 / 12 | `extended79` |

以下型号不支持，且不做重叠键部分迁移：

- Wooting One（0）
- Wooting Two（1）
- Wooting Two HE（3 / 6）
- Wooting UwU（7 / 8）
- Wooting Lekker 模块（2）
- 未知 device id

预检发生在设备写入之前；不支持型号不会进入还原流程。

## 3. 字段口径

| 字段 | 说明 |
| --- | --- |
| `cfg.actuationPoint` | 全局触发点 |
| `cfg.enableRapidTrigger` | 全局 RT 开关 |
| `cfg.rapidTriggerSensitivity` | KEY PRESS - ACTIVATE（按下/再触发），映射到 `travelDownMm` |
| `cfg.rapidTriggerSecondarySensitivity` | KEY RELEASE - DEACTIVATE（松开/重置），映射到 `travelUpMm`；缺省时回退主值 |
| `cfg.rapidTriggerStrictActuationRange` | 映射到 `fastOutMm`：`true` → `pressMm`，`false` → 0 |
| `cfg.perKeyRapidTrigger` | 支持 `true` / `false` / `null` / `{ sensitivity, secondarySensitivity, strictActuationRange }`；`false` 显式关闭并优先于全局 RT |
| `analog.customActuations` | 逐键自定义触发点；无全局 `actPoint` 时只导入显式自定义键 |
| `rgb.kbdArray` | 静态逐键颜色；亮度 0..255 映射到 0..10 |
| `remap` | 按键重映射；固定导入基础层 + 第一层 Fn（layer 0/1） |
| `akc` | SOCD / MT / TGL / Rappy Snappy；DKS 跳过 |

模拟量单位按 schema 和数值量级识别：

- `v0–v2`：8-bit `0..255 → 0..4mm`；
- `v3–v8`：毫米；
- `v9+`：支持 14-bit 迁移的设备使用 `1/4096mm` 整数，其余仍按毫米；
- `v12` 自定义触发值：`0.1mm` 步进；
- `v14+` 自定义触发值：直接使用毫米。

导入时 Zetsu 的顶部/底部防误触死区固定写 **0**，避免 0.1mm 触发点被默认 0.2mm 死区吞掉。

## 4. 功能迁移矩阵

| 功能 | 支持度 | 规则 / 限制 |
| --- | --- | --- |
| 基础层 remap | 完全 | 跳过恒等项；未知 keycode 或目标布局不存在的键记 warning |
| Fn / 第 2 层 remap | 部分 | 固定与基础层一起导入（layer 0/1）；Zetsu 只有一个 Fn 层，layer 2（Fn2）及更多层忽略并记入 warning |
| 静态逐键 RGB | 完全 | 只取 `rgb.kbdArray`；没有 `kbdArray` 时不改写设备灯效 |
| RGB effects / `rgb.layers` | 不可 / 部分 | 不导入动态效果和多层颜色，只取静态 `kbdArray`；记 warning |
| 触发点 / RT | 完全 | 0.1–4.0mm；方向口径见 §3；支持全局和 per-key |
| per-key RT | 完全 | `false`、`null`、布尔值、v15 对象均兼容；`false` 优先于全局 |
| 自定义触发点 | 完全 | 支持 v12 的 0.1mm 步进、v14 的毫米、v15 的 1/4096mm |
| SOCD | 完全 | mode 1 中立、2 第一键优先、3 第二键优先、4 后输入优先；`inputBothWhenBottomedOut` / `inputBothOnBottomOut` 映射 `bottom` |
| Rappy Snappy (RS) | 完全 | 第二键 + `bottom`；`socd` 模式无 Zetsu 等价，忽略 |
| Mod Tap (MT) | 完全 | `holdKey` / `tapKey` → usage；`holdDuration` → `tapMs` |
| Toggle (TGL) | 完全 | `toggleKey.keybind`（支持嵌套 `keybind.byte`）→ target usage |
| DKS | 不可 | SDK 没有 DKS 写命令；不能等价成 MPT |
| MPT / END | N/A | Wootility share 格式无对应字段 |
| gamepad | 不可 | Zetsu 无等价协议 |
| lightbar | 不可 | Zetsu 无等价设置 |
| tachyon / digital / tick rate | 不可 | Zetsu 无等价设置；记 warning |
| 系统 / 配置切换 / 多媒体特殊键 | 部分 | 有 Zetsu usage 的键映射；其余记 warning |
| profile 元数据 | 不可 | 只进入 warning，不写设备 |

### 两键功能的键对规则

SOCD 和 RS 都是一对两键的功能。导入时：

- 同一无序键对（`A→B` 与 `B→A`）只导入一次；
- 一个键（源键或目标键）只能出现在一个同功能键对中；
- 自配对、重复对、与已有键对冲突的条目跳过并记 warning；
- SOCD 与 RS 使用独立的键对集合。

## 5. 布局、层与还原

- 转换目标始终是设备自己的原生布局；跨布局由 SDK restore 按 hardCode 过滤，并在面板弹确认框。
- Wooting 60HE 的左上 `(1,0)` 是 Esc，而 `compact65` 没有 Escape 且没有 hardCode 0，因此该格按 key-code 语义跳过；不会改写成 Backquote。
- ISO / JIS 的额外键没有 Zetsu cell 时跳过并 warning。
- AKC 不支持按层作用域；`akc.layer != 0` 的条目跳过并 warning。
- `restoreOptions` 按 profile 内容决定是否写灯效/高级键：没有静态键色时 `restoreLight` / `restoreKeyColors` 为 `false`；没有高级键时 `restoreFeatures` 为 `false`；`clearExtraFeatures` 保持 `false`。
- DEBUG 构建下载的中间 JSON 不携带 `restoreOptions`；离线还原无静态颜色的 profile 时需显式关闭灯效写入。

## 6. 相关代码

- `packages/zmeow-userscript/src/wooting/profile.ts`：解析、版本守卫、设备预检、错误类型。
- `packages/zmeow-userscript/src/wooting/convert.ts`：share profile → 转换计划。
- `packages/zmeow-userscript/src/wooting/backup.ts`：转换计划 → SDK 备份文档与 `restoreOptions`。
- `packages/zmeow-userscript/src/wooting/share.ts`：分享码取数。
- `packages/zmeow-userscript/src/wooting/index.ts`：对外导出。
