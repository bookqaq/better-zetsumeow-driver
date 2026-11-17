/**
 * Shared public types for the ZetsuMeow SDK.
 *
 * These types are the contract between the protocol layer (frames / commands /
 * response decoding), the transport layer and the client ({@link ZetsuKeyboard}).
 * Keep them free of DOM types so the package stays testable under plain Node.
 */

export type HexColor = `#${string}`;

/** One physical key position of a product layout. */
export interface KeyDef {
  /** Matrix position, the identifier used by every feature command. */
  readonly hardCode: number;
  /** HID usage sent for this key (may exceed 255, encoded as 2 bytes). */
  readonly hidCode: number;
  /** Fn-layer HID usage when the firmware ships one, otherwise `null`. */
  readonly hidCodeFn1: number | null;
  readonly selfCode: number;
  readonly scanId: number;
  readonly keyCode: number;
  /** KeyboardEvent.code style identifier, e.g. `KeyA`, `Digit1`. */
  readonly textCode: string;
  readonly title: string;
  readonly status: number;
  /** Nominal actuation point in millimetres. */
  readonly travel: number;
  readonly travelUp: number;
  readonly travelDown: number;
  readonly maxTravel: number;
  readonly minTravel: number;
  readonly isFast: 0 | 1;
  /** True for keys that only exist once the F-row module is installed. */
  readonly isFRow: boolean;
  readonly geometry: KeyGeometry;
}

export interface KeyGeometry {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly img: string;
}

/** `compact65` = base board, `extended79` = F-row module installed. */
export type LayoutMode = 'compact65' | 'extended79' | 'unknown';

/** A generated layout table, before the runtime lookup maps are built. */
export interface LayoutDefinition {
  readonly mode: Exclude<LayoutMode, 'unknown'>;
  readonly keys: readonly KeyDef[];
}

/** Runtime layout, resolved from the device at connect time. */
export interface KeyLayout {
  readonly mode: LayoutMode;
  readonly keyCount: number;
  readonly hasFRow: boolean;
  /** Raw byte reported by the device for `cmd 2/19` (79 = F-row installed). */
  readonly rawFMode: number | null;
  readonly keys: readonly KeyDef[];
  readonly byHardCode: ReadonlyMap<number, KeyDef>;
  readonly byTextCode: ReadonlyMap<string, KeyDef>;
  readonly byTitle: ReadonlyMap<string, KeyDef>;
}

export interface KeyRangeInit {
  readonly min: number;
  readonly max: number;
  readonly value: number;
  readonly step: number;
  readonly fixed: number;
  /** Optional fields present in the firmware's `key_range_init` JSON. */
  readonly fastMin?: number;
  readonly fastMax?: number;
  readonly fastValue?: number;
  readonly fastStep?: number;
  readonly deadMin?: number;
  readonly deadMax?: number;
  readonly deadValue?: number;
  readonly deadStep?: number;
}

export interface ScreenInfo {
  readonly width: number;
  readonly height: number;
  readonly maxFrames: number;
}

export interface ProductInfo {
  readonly id: number;
  readonly title: string;
  readonly vid: number;
  readonly pid: number;
  /** USB product id of the serial (screen) interface. */
  readonly pidScreen: number;
  readonly headNum: number;
  readonly headNumScreen: number;
  readonly usage: number;
  readonly usagePages: readonly number[];
  readonly cateId: number;
  readonly fId: number;
  readonly isScreen: boolean;
  readonly isSideLight: boolean;
  readonly fmId: number;
  readonly keyRange: KeyRangeInit;
  readonly screen: ScreenInfo;
  readonly layouts: Readonly<Record<'compact65' | 'extended79', LayoutDefinition>>;
}

export type RunMode = 'app' | 'boot';

export interface DeviceInfo {
  readonly boardId: string;
  readonly sn: string;
  readonly firmwareVersion: string;
  readonly runMode: RunMode;
  readonly runModeNum: number;
  readonly pzNum: number;
  readonly isMac: boolean | null;
  readonly winLock: boolean | null;
  readonly highPrecision: boolean | null;
  readonly isLock: boolean | null;
  readonly lightSleep: number | null;
  readonly fMode: number | null;
}

export interface LightState {
  /** 0 = off, 1..9 = effect id. */
  readonly mode: number;
  readonly speed: number;
  readonly turn: number;
  /** 0..10 */
  readonly brightness: number;
  /** Colourful/static switch reported by the device. */
  readonly colorful: number;
  readonly rgb: HexColor;
}

export interface KeyColor {
  readonly rgb: HexColor;
  readonly brightness: number;
}

export type FeatureKind =
  | 'none'
  | 'socd'
  | 'rs'
  | 'mt'
  | 'tgl'
  | 'mpt'
  | 'end'
  | 'dks';

export interface KeyMapEntry {
  readonly hardCode: number;
  readonly hidCode: number;
  readonly title: string;
  readonly textCode: string;
}

/** Advanced key configuration, one family at a time. */
export interface FeatureConfig {
  readonly hardCode: number;
  readonly kind: FeatureKind;
  readonly bottom?: boolean;
  readonly pauseMs?: number;
  readonly targetHardCodes?: readonly number[];
  readonly targetHidCodes?: readonly number[];
  /** SOCD only: which of the two keys wins when both are held. */
  readonly first1?: 0 | 1;
  readonly first2?: 0 | 1;
  readonly tapMs?: number;
  readonly travelMm?: readonly number[];
}

/** One entry of the bulk travel (high precision) configuration. */
export interface TravelEntry {
  readonly hardCode: number;
  /** Actuation point, mm. */
  readonly pressMm: number;
  /**
   * Rapid-trigger release sensitivity in mm for `fast` keys; for normal keys
   * the firmware ignores it, so it equals {@link pressMm}. This is the legacy
   * single-value field: when {@link travelDownMm}/{@link travelUpMm} are
   * present they take precedence.
   */
  readonly releaseMm: number;
  /** Fast-trigger press/re-trigger travel (`travel_down`), mm. */
  readonly travelDownMm?: number;
  /** Fast-trigger release/reset travel (`travel_up`), mm. */
  readonly travelUpMm?: number;
  readonly deadDownMm: number;
  readonly deadUpMm: number;
  readonly fastOutMm: number;
  readonly fast: boolean;
}

export type KeyTestMode = 'stroke' | 'tap';

export interface KeyTravelEvent {
  readonly hardCode: number;
  readonly key: KeyDef | null;
  /** Travel in millimetres, 2 decimals (firmware units are micrometres). */
  readonly mm: number;
  readonly adc?: number;
}

export interface KeyReleaseEvent {
  readonly hardCode: number;
  readonly key: KeyDef | null;
}

export interface ScreenProgress {
  readonly phase: 'prepare' | 'transfer';
  readonly percent: number;
  readonly sentBytes?: number;
  readonly totalBytes?: number;
}

/** Callback map for {@link KeyboardEvents}. */
export interface KeyboardEvents {
  disconnect: { readonly product: ProductInfo };
  input: { readonly frame: Uint8Array };
  keyTravel: KeyTravelEvent;
  keyRelease: KeyReleaseEvent;
  error: Error;
  'screen:disconnect': { readonly product: ProductInfo };
}

export type KeyboardEventName = keyof KeyboardEvents;

/** Anything accepted as a key reference by the public API. */
export type KeyRef = number | string | { readonly hardCode: number } | { readonly textCode: string };
