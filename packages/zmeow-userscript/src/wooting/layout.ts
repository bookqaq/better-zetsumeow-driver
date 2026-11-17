/**
 * Wooting physical matrix -> Zetsu key identifiers.
 *
 * Wooting's profile stores RGB and per-key settings by `(rowNr, colNr)`. The
 * 60HE uses five rows (number/Q/A/Z/bottom) and the 80HE adds an F-row plus a
 * navigation cluster. Both families use the same 21-column RGB grid, but the
 * remappable area is 14 columns (60HE) / 17 columns (80HE).
 *
 * Only keys that exist on the Zetsu63 are listed. Wooting-only keys (Mode,
 * PrintScreen, Insert, Home, End, JIS/ISO extras, right Ctrl/Meta) are `null`
 * and are reported as skipped by the converter.
 */

import type { LayoutMode } from '@bookqaq/zmeow-sdk';
import type { WootingModel } from './types.ts';

export interface WootingModelDefinition {
  readonly id: WootingModel;
  readonly title: string;
  /** Wooting `target.device` ids whose profiles share this matrix. */
  readonly deviceIds: readonly number[];
  readonly defaultLayout: Exclude<LayoutMode, 'unknown'>;
  readonly rows: number;
  readonly cols: number;
  /** `cells[row][col]`; `null` means "not representable on Zetsu63". */
  readonly cells: readonly (readonly (string | null)[])[];
}

const N = null;

/**
 * 60HE: profile rows 1..5 correspond to the five physical rows, and the first
 * cell of row 1 is the physical top-left key — `Escape`, not `Backquote`.
 * Evidence: the zekken share profile (device 5) maps layer0 (1,0) -> keycode
 * 38 (HID usage 41 = Escape) and layer1 (1,0) -> 50 (usage 53 = Backquote,
 * i.e. Fn+Esc = `~`); Wootility renders Esc at (1,0) for the 60HE family and
 * the 60HE v2 demo matrix has Esc at (1,0); `key-catalog.ts` lists Escape
 * (hardCode 0 / usage 41) and Backquote (hardCode 13 / usage 53) as two
 * distinct keys. A 60% board has no dedicated grave key. The 80 family keeps
 * `Backquote` at (1,0): the 80HE sample maps (1,0) = 50 -> usage 53.
 */
const CELLS_60HE: readonly (readonly (string | null)[])[] = [
  [],
  [
    'Escape', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
    'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'Backspace',
  ],
  [
    'Tab', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI',
    'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', 'Backslash',
  ],
  [
    'CapsLock', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ',
    'KeyK', 'KeyL', 'Semicolon', 'Quote', N, 'Enter',
  ],
  [
    'ShiftLeft', N, 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM',
    'Comma', 'Period', 'Slash', N, 'ShiftRight',
  ],
  [
    'ControlLeft', 'MetaLeft', 'AltLeft', N, 'Space', 'Space', 'Space',
    'Space', 'Space', N, 'AltRight', N, N, 'Fn',
  ],
];

/** 80HE ANSI/JIS: six rows, 17 remappable columns. */
const CELLS_80HE: readonly (readonly (string | null)[])[] = [
  [
    'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', N, 'F9',
    'F10', 'F11', 'F12', N, N, N,
  ],
  [
    'Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
    'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', N,
    'Backspace', N, N,
  ],
  [
    'Tab', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI',
    'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', N, 'Backslash', 'Delete',
    'PageDown',
  ],
  [
    'CapsLock', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ',
    'KeyK', 'KeyL', 'Semicolon', 'Quote', N, N, 'Enter', N, N,
  ],
  [
    'ShiftLeft', N, 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM',
    'Comma', 'Period', 'Slash', N, N, 'ShiftRight', 'ArrowUp', N,
  ],
  [
    'ControlLeft', 'MetaLeft', 'AltLeft', N, 'Space', 'Space', 'Space',
    'Space', 'Space', N, 'AltRight', N, 'Fn', N, 'ArrowLeft', 'ArrowDown',
    'ArrowRight',
  ],
];

/**
 * Display names for every Wooting `target.device` id seen in profiles.
 * Device 5 is kept distinct from 9/11 on purpose: the bundled Wootility data
 * calls it "Wooting 60HE (ARM)" while 9/11 are the 60HE+ / 60HE v2 boards.
 */
export const WOOTING_DEVICE_TITLES: Readonly<Record<number, string>> = {
  0: 'Wooting One',
  1: 'Wooting Two',
  2: 'Lekker (switch module, not a keyboard)',
  3: 'Wooting Two HE',
  4: 'Wooting 60HE (AVR firmware)',
  5: 'Wooting 60HE (ARM)',
  6: 'Wooting Two HE (ARM)',
  7: 'Wooting UwU (non-RGB)',
  8: 'Wooting UwU RGB',
  9: 'Wooting 60HE+',
  10: 'Wooting 80HE',
  11: 'Wooting 60HE v2',
  12: 'Wooting 80HE+',
};

/** Display name for a Wooting `target.device` id, or `null` when unknown. */
export function wootingDeviceTitle(device: number): string | null {
  return WOOTING_DEVICE_TITLES[device] ?? null;
}

export const WOOTING_MODELS: Readonly<Record<WootingModel, WootingModelDefinition>> = {
  '60he': {
    id: '60he',
    title: 'Wooting 60HE',
    // 5/9/11 are official Wootility `compatibleDevices` cross-matches (v2/ARM
    // accept each other's profiles) and share this matrix; 4 (AVR) is merged
    // on the same matrix. The 60HE+ (9) is *not* device 11 — that is 60HE v2.
    deviceIds: [4, 5, 9, 11],
    defaultLayout: 'compact65',
    rows: 6,
    cols: 14,
    cells: CELLS_60HE,
  },
  '80he': {
    id: '80he',
    title: 'Wooting 80HE',
    // Wootility lists 10 and 12 in each other's place only via matrix parity:
    // remap/RGB grids are both 6 rows x 17 cols (RGB 21 cols), only muxConfig
    // differs, so profiles convert identically.
    deviceIds: [10, 12],
    defaultLayout: 'extended79',
    rows: 6,
    cols: 17,
    cells: CELLS_80HE,
  },
};

/** Map `target.device` to a model, or `null` when the profile is for another board. */
export function wootingModelForDevice(device: number | null | undefined): WootingModel | null {
  if (typeof device !== 'number') return null;
  for (const [model, definition] of Object.entries(WOOTING_MODELS)) {
    if (definition.deviceIds.includes(device)) return model as WootingModel;
  }
  return null;
}

export function wootingModel(model: WootingModel): WootingModelDefinition {
  return WOOTING_MODELS[model];
}

/** Zetsu `textCode` at a Wooting matrix cell, or `null` for unsupported cells. */
export function wootingCellTextCode(
  model: WootingModel,
  row: number,
  col: number,
): string | null {
  const cells = WOOTING_MODELS[model].cells;
  return cells[row]?.[col] ?? null;
}

/** Default Zetsu layout for a Wooting model. */
export function defaultLayoutForWooting(model: WootingModel): Exclude<LayoutMode, 'unknown'> {
  return WOOTING_MODELS[model].defaultLayout;
}
