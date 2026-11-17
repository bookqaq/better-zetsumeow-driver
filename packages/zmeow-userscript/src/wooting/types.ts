/**
 * Types for Wooting Wootility share profiles (the JSON returned by the public
 * share endpoint). The parser accepts both the full `{ "data": ... }` response
 * and the inner profile object.
 */

import type { KeyboardConfigFeature, KeyColor, LayoutMode, TravelEntry } from '@bookqaq/zmeow-sdk';

export interface WootingIndex {
  readonly rowNr: number;
  readonly colNr: number;
}

export interface WootingRemapEntry {
  readonly index: WootingIndex;
  readonly value: number;
}

export interface WootingCustomActuation {
  readonly index: WootingIndex;
  readonly value: number;
}

export type WootingPerKeyRapidTriggerValue =
  | boolean
  | null
  | {
      readonly sensitivity?: number;
      readonly strictActuationRange?: boolean;
      readonly secondarySensitivity?: number | null;
    };

export interface WootingPerKeyRapidTrigger {
  readonly index: WootingIndex;
  /**
   * Older share profiles store a boolean (RT on/off) and use the global
   * sensitivity; newer profiles store `{ sensitivity, ... }` objects.
   */
  readonly value: WootingPerKeyRapidTriggerValue;
}

export interface WootingAnalog {
  /**
   * Actuation point. Wootility v12 share responses use millimetres
   * (`0.1` = 0.1 mm); older/local exports use 1/4096 mm integers
   * (`4096` = 1.0 mm). The converter detects the scale from the magnitude.
   */
  readonly actPoint?: number;
  /** Rapid-trigger press/re-trigger sensitivity (`travel_down`), same unit rules as {@link actPoint}. */
  readonly rapidTriggerSensitivity?: number;
  /** Rapid-trigger release/reset sensitivity (`travel_up`), same unit rules. */
  readonly rapidTriggerSecondarySensitivity?: number | null;
  readonly rapidTrigger?: boolean;
  readonly rapidTriggerStrictActuationRange?: boolean;
  readonly perKeyRapidTrigger?: readonly WootingPerKeyRapidTrigger[];
  readonly enableDigital?: boolean;
  readonly tachyonMode?: boolean;
  readonly dksTickRate?: number;
  readonly tachyonModeFocus?: number;
  readonly [key: string]: unknown;
}

export interface WootingRgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export interface WootingRgb {
  readonly kbdArray?: readonly (readonly (WootingRgbColor | null)[])[];
  readonly brightness?: number;
  readonly effects?: unknown;
  readonly capsColor?: WootingRgbColor;
  readonly fnLockColor?: WootingRgbColor;
  readonly [key: string]: unknown;
}

export interface WootingTarget {
  readonly layout?: number;
  readonly device?: number;
}

export interface WootingKeybind {
  /** Wooting key code (0..255), the form used by share profiles. */
  readonly byte?: number;
  /** Nested keybind used by toggleKey in some profile versions. */
  readonly keybind?: WootingKeybind | number | null;
  readonly [key: string]: unknown;
}

export interface WootingSocdConfig {
  readonly secondaryKey: WootingIndex;
  /** 0=both/disabled, 1=neutral, 2=absolute, 3=secondary priority, 4=last input. */
  readonly socd?: number;
  /** Older field name used by some internal/exported profiles. */
  readonly inputBothOnBottomOut?: boolean;
  /** Current share field. */
  readonly inputBothWhenBottomedOut?: boolean;
  readonly [key: string]: unknown;
}

export interface WootingModTapConfig {
  readonly tapKey?: WootingKeybind | number | null;
  readonly holdKey?: WootingKeybind | number | null;
  /** Long-press delay in milliseconds when present. */
  readonly holdDuration?: number;
  readonly [key: string]: unknown;
}

export interface WootingToggleConfig {
  readonly keybind?: WootingKeybind | number | null;
  readonly [key: string]: unknown;
}

export interface WootingRappySnappyConfig {
  readonly secondaryKey: WootingIndex;
  readonly socd?: number;
  readonly inputBothOnBottomOut?: boolean;
  readonly inputBothWhenBottomedOut?: boolean;
  readonly [key: string]: unknown;
}

export interface WootingAkcEntry {
  readonly keyIndex: WootingIndex;
  readonly layer?: number;
  readonly socd?: WootingSocdConfig;
  readonly modTap?: WootingModTapConfig;
  readonly toggleKey?: WootingToggleConfig;
  readonly rappySnappy?: WootingRappySnappyConfig;
  readonly dks?: unknown;
  readonly [key: string]: unknown;
}

export interface WootingProfile {
  readonly version?: number;
  readonly name?: string;
  readonly desc?: string;
  readonly guid?: string;
  readonly target?: WootingTarget;
  readonly remap?: readonly (readonly WootingRemapEntry[])[] | null;
  readonly customActuations?: readonly WootingCustomActuation[];
  readonly analog?: WootingAnalog;
  readonly rgb?: WootingRgb;
  readonly dks?: unknown;
  readonly akc?: readonly WootingAkcEntry[] | null;
  readonly gamepad?: {
    readonly mapping?: { readonly mappings?: readonly unknown[] };
    readonly [key: string]: unknown;
  };
  readonly lightbar?: unknown;
  readonly metadata?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Wooting models by shared physical matrix. Five shipped boards map onto these
 * two matrices through `WootingModelDefinition.deviceIds`; per-device display
 * names live in `WOOTING_DEVICE_TITLES` (do not add a model per board — the
 * cells table would be duplicated for nothing).
 */
export type WootingModel = '60he' | '80he';

export interface WootingProfileSummary {
  readonly model: WootingModel;
  /** Precise device name (e.g. `Wooting 60HE+`, `Wooting 60HE (ARM)`); unknown ids fall back to the family name. */
  readonly modelTitle: string;
  readonly targetDevice: number;
  readonly targetLayout: number | null;
  readonly name: string;
  readonly guid: string | null;
  readonly version: number | null;
}

export interface WootingImportOptions {
  /** Remap layers to import. Defaults to the base layer (`[0]`). */
  readonly layers?: readonly (0 | 1 | 2)[];
  /** Import the per-key `rgb.kbdArray`. Default true. */
  readonly colors?: boolean;
  /** Import actuation points and Rapid Trigger settings. Default true. */
  readonly actuation?: boolean;
}

export interface WootingConversionStats {
  readonly remapKeys: number;
  readonly colorKeys: number;
  readonly travelKeys: number;
  readonly featureKeys: number;
  readonly skippedCells: number;
  readonly unknownKeycodes: number;
}

/**
 * Pure, device-independent result of converting a Wooting profile. The plan
 * always targets the profile's native layout (60HE -> `compact65`,
 * 80HE -> `extended79`); restoring it onto a different layout is the SDK
 * restore path's job.
 */
export interface WootingImportPlan {
  readonly source: WootingProfileSummary;
  /** Layout the plan was converted for (the profile's native layout). */
  readonly layout: Exclude<LayoutMode, 'unknown'>;
  /** `layer -> hardCode -> HID usage`. */
  readonly remap: Readonly<Record<number, Readonly<Record<number, number>>>>;
  /** `hardCode -> colour`. */
  readonly keyColors: Readonly<Record<number, KeyColor>>;
  /** `hardCode -> travel configuration`. */
  readonly travel: Readonly<Record<number, TravelEntry>>;
  /** Advanced-key features (SOCD, MT, TGL, RS); DKS is not writable by the SDK. */
  readonly features: readonly KeyboardConfigFeature[];
  readonly warnings: readonly string[];
  readonly stats: WootingConversionStats;
}

