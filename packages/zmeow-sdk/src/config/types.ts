/**
 * JSON backup format for the keyboard's current settings.
 *
 * The format is intentionally plain data: it contains no class instances and no
 * functions, so `JSON.stringify` / `JSON.parse` are the only persistence APIs a
 * caller needs. Keys are addressed by their matrix `hardCode`, which is stable
 * for a given layout.
 */

import type {
  DeviceInfo,
  FeatureConfig,
  FeatureKind,
  KeyColor,
  KeyLayout,
  KeyMapEntry,
  KeyRef,
  LightState,
  LayoutMode,
  ProductInfo,
  TravelEntry,
} from '../types.ts';
import type {
  RemapRestoreResult,
  RemapSnapshot,
  SetRemapOptions,
  SetKeyColorOptions,
  SetLightPatch,
  TravelConfigEntry,
  KeyColorInput,
} from '../keyboard.ts';

export const KEYBOARD_CONFIG_FORMAT = 'zmeow.keyboard-config';
export const KEYBOARD_CONFIG_VERSION = 1;

/** A feature entry in a backup, enriched with human-readable labels. */
export interface KeyboardConfigFeature extends FeatureConfig {
  readonly textCode?: string;
  readonly title?: string;
}

export interface KeyboardConfigMisc {
  readonly winLock: boolean | null;
  readonly lightSleep: number | null;
}

export interface KeyboardConfigProduct {
  readonly id: number;
  readonly title: string;
  readonly vid: number;
  readonly pid: number;
}

/**
 * The complete, portable keyboard settings document.
 *
 * Device-identifying fields (SN / boardId) are intentionally omitted; the
 * firmware version is kept for diagnostics.
 */
export interface KeyboardConfig {
  readonly format: typeof KEYBOARD_CONFIG_FORMAT;
  readonly version: number;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  readonly product: KeyboardConfigProduct;
  readonly layout: LayoutMode;
  /** Firmware version is kept for diagnostics; no serial/board identifiers. */
  readonly firmwareVersion: string | null;
  /** `layer -> hardCode -> HID usage`. */
  readonly remap: {
    readonly layers: Readonly<Record<number, Readonly<Record<number, number>>>>;
  };
  readonly light: LightState;
  /** `hardCode -> colour`. */
  readonly keyColors: Readonly<Record<number, KeyColor>>;
  /** `hardCode -> travel configuration`. */
  readonly travel: Readonly<Record<number, TravelEntry>>;
  readonly features: readonly KeyboardConfigFeature[];
  /**
   * `false` marks a backup whose feature list (`cmd 47`) could not be read at
   * capture time (busy shared handle; the failure is recorded in `warnings`).
   * Restoring such a backup leaves the device's features untouched — restoring
   * the empty list would otherwise clear them. Absent means the list was read.
   */
  readonly featuresRead?: boolean;
  readonly misc: KeyboardConfigMisc;
  /** Non-fatal notes produced while capturing (usually empty). */
  readonly warnings?: readonly string[];
}

/** Structural subset of {@link ZetsuKeyboard} used by config backup/restore. */
export interface ConfigKeyboard {
  readonly layout: KeyLayout | null;
  readonly info: Readonly<DeviceInfo>;
  readonly product: ProductInfo;

  ensureKeyTestStopped(): Promise<boolean>;
  getLight(): Promise<LightState>;
  getKeyColors(): Promise<Map<number, KeyColor>>;
  getKeyMap(layer?: 0 | 1 | 2): Promise<Map<number, KeyMapEntry>>;
  getFeatures(): Promise<Map<number, FeatureKind>>;
  getFeature(key: KeyRef): Promise<FeatureConfig | null>;
  getTravelConfig(): Promise<Map<number, TravelEntry>>;
  getWinLock(): Promise<boolean>;
  getLightSleep(): Promise<number>;

  setLight(patch: SetLightPatch): Promise<void>;
  setKeyColors(entries: readonly KeyColorInput[]): Promise<void>;
  setKeyColor(
    keys: KeyRef | readonly KeyRef[],
    color: string | { readonly r: number; readonly g: number; readonly b: number },
    options?: SetKeyColorOptions,
  ): Promise<void>;
  setKeyRemap(source: KeyRef, target: KeyRef, options?: SetRemapOptions): Promise<void>;
  restoreRemapSnapshot(
    snapshot: RemapSnapshot,
    options?: {
      readonly layers?: readonly (0 | 1 | 2)[];
      readonly settleMs?: number;
      readonly verify?: boolean;
      readonly writeGapMs?: number;
    },
  ): Promise<RemapRestoreResult>;
  setTravelConfig(entries: readonly TravelConfigEntry[]): Promise<void>;
  setWinLock(value?: boolean): Promise<void>;
  setLightSleep(minutes: number): Promise<void>;

  setRS(options: {
    readonly key1: KeyRef;
    readonly key2: KeyRef;
    readonly bottom?: boolean;
    readonly ms?: number;
  }): Promise<void>;
  setSOCD(options: {
    readonly key1: KeyRef;
    readonly key2: KeyRef;
    readonly first1?: 0 | 1;
    readonly first2?: 0 | 1;
    readonly bottom?: boolean;
    readonly ms?: number;
  }): Promise<void>;
  setMT(options: {
    readonly key: KeyRef;
    readonly hold: KeyRef;
    readonly tap: KeyRef;
    readonly ms?: number;
  }): Promise<void>;
  setTGL(options: {
    readonly key: KeyRef;
    readonly target: KeyRef;
    readonly ms?: number;
  }): Promise<void>;
  setMPT(options: {
    readonly key: KeyRef;
    readonly targets: readonly [KeyRef, KeyRef, KeyRef];
    readonly mm: readonly [number, number, number];
  }): Promise<void>;
  setEND(options: {
    readonly key: KeyRef;
    readonly target: KeyRef;
    readonly ms?: number;
  }): Promise<void>;
  clearFeature(key: KeyRef): Promise<void>;
}

export interface CaptureConfigOptions {
  /** Layers to read. Defaults to all three (`0, 1, 2`). */
  readonly layers?: readonly (0 | 1 | 2)[];
}

export interface RestoreConfigOptions {
  /** Layers to write; defaults to every layer present in the file. */
  readonly layers?: readonly (0 | 1 | 2)[];
  readonly restoreLight?: boolean;
  readonly restoreKeyColors?: boolean;
  readonly restoreTravel?: boolean;
  readonly restoreFeatures?: boolean;
  readonly restoreMisc?: boolean;
  /** Clear features that exist on the device but not in the backup. Default true. */
  readonly clearExtraFeatures?: boolean;
  /**
   * Re-read remapped keys and rewrite once if the value did not stick.
   * Default true — the firmware silently drops writes, especially on a
   * handle shared with the driver page.
   */
  readonly verifyRemap?: boolean;
  /**
   * Read the travel table back after writing and rewrite the dropped keys
   * once. Default true — back-to-back `cmd 41` chunks are silently dropped by
   * the firmware. The official driver does not read back; it paces every chunk
   * and settles for `chunks * 10 + 100` ms, and the SDK applies the same
   * pacing inside `setTravelConfig` before this verify read happens.
   */
  readonly verifyTravel?: boolean;
  /** Pause before the verify re-read. Default 250. */
  readonly settleMs?: number;
  /**
   * Gap between two device writes of the restore. The official driver sleeps
   * 300 ms after a remap write; back-to-back writes can be silently dropped.
   * Default 300 for remaps.
   */
  readonly writeGapMs?: number;
  /**
   * Feature write/read gap. Default 500 — the official driver sleeps 500 ms
   * after a feature set and the SDK also leaves this quiet window before every
   * `cmd 47` list read.
   */
  readonly featureGapMs?: number;
  /**
   * Gap after a `cmd 47` clear before the replacement feature is written.
   * Default 1000 — the official driver sleeps 1000 ms after a pre-set clear
   * (MPT uses 500 ms; the SDK uses the conservative 1000 ms for every family).
   */
  readonly featureClearGapMs?: number;
  /** Allow restoring a compact65 backup on extended79 (or vice versa). */
  readonly allowLayoutMismatch?: boolean;
  /** `skip` records a warning for DKS/unsupported feature kinds; `error` aborts. */
  readonly onUnsupportedFeature?: 'skip' | 'error';
}

export interface FeatureRestoreSummary {
  readonly written: number;
  readonly cleared: number;
  readonly skipped: number;
  readonly warnings: readonly string[];
}

export interface RestoreConfigResult {
  readonly remap: RemapRestoreResult | null;
  readonly colors: number;
  readonly travel: number;
  readonly light: boolean;
  readonly features: FeatureRestoreSummary;
  readonly misc: { readonly winLock: boolean; readonly lightSleep: boolean };
  readonly warnings: readonly string[];
}
