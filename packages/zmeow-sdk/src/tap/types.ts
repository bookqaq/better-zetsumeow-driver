/**
 * Public types for the driver tap layer.
 *
 * The tap layer observes and optionally rewrites traffic that another page
 * (the official ZetsuMeow web driver) sends through WebHID / Web Serial. It is
 * deliberately separate from the active clients (`ZetsuKeyboard`,
 * `ZetsuScreen`): a tap never owns a handle and never opens or closes one.
 */

import type { ParsedFrame } from '../protocol/frame.ts';
import type { SerialFrame } from '../transport/webserial.ts';
import type { HidDeviceLike, HidLike, SerialLike, SerialPortLike } from '../transport/types.ts';
import type { ProductInfo } from '../types.ts';

/** Which capabilities a bridge exposes. */
export type TapMode = 'tap' | 'active' | 'both';

/**
 * Compatibility state of the attached page.
 *
 * - `idle`: taps are installed but no compatible device has been seen yet.
 * - `active`: known driver/protocol and writes are allowed.
 * - `readonly`: unknown driver build, but the wire protocol still parses.
 * - `disabled`: taps could not be installed or the protocol is not understood.
 */
export type TapState = 'idle' | 'active' | 'readonly' | 'disabled';

export type TapDirection = 'in' | 'out';

/** One decoded HID report observed on the tapped device. */
export interface HidTapFrame {
  readonly kind: 'hid';
  readonly direction: TapDirection;
  readonly device: HidDeviceLike;
  readonly frame: ParsedFrame;
  /** Exact bytes seen on the wire (before any rewrite). */
  readonly raw: Uint8Array;
}

/** One decoded serial frame observed on the tapped port. */
export interface SerialTapFrame {
  readonly kind: 'serial';
  readonly direction: TapDirection;
  readonly port: SerialPortLike;
  readonly frame: SerialFrame;
  /** Exact bytes of the complete frame (before any rewrite). */
  readonly raw: Uint8Array;
}

export type TapFrame = HidTapFrame | SerialTapFrame;

/**
 * Return value of a rewrite hook.
 *
 * - `undefined`: pass the original bytes through
 * - `null`: drop the frame
 * - `Uint8Array`: replace the frame bytes (must still be a valid frame)
 */
export type TapDecision = Uint8Array | null | undefined;

/** Optional synchronous/asynchronous rewrites applied by a tap. */
export interface TapHooks {
  /** Before an outgoing 64-byte HID report is sent. May be async. */
  onHidOut?(frame: ParsedFrame, device: HidDeviceLike): TapDecision | Promise<TapDecision>;
  /** Before an incoming HID report reaches the page handler. Must be sync. */
  onHidIn?(frame: ParsedFrame, device: HidDeviceLike): TapDecision;
  /** Before an outgoing serial frame is written. May be async. */
  onSerialOut?(frame: SerialFrame, port: SerialPortLike): TapDecision | Promise<TapDecision>;
  /** Observe an incoming serial frame. The page already consumed the bytes. */
  onSerialIn?(frame: SerialFrame, port: SerialPortLike): void;
}

/** Result of comparing the page against the known driver build. */
export interface TapFingerprint {
  readonly indexHash: string | null;
  readonly hidHash: string | null;
  readonly screenHash: string | null;
  /** True when the exported product table still matches {@link ProductInfo}. */
  readonly productOk: boolean;
  /** Firmware reported by the device, once `cmd 1` has been observed. */
  readonly firmwareVersion: string | null;
  /** True until a known frame fails to decode. */
  readonly protocolOk: boolean;
  /**
   * True when at least one protocol resource hash was compared and matched the
   * known baseline. False with all-null hashes means "not checked", not
   * "mismatch" — see {@link TapFingerprint.checked}.
   */
  readonly hashKnown: boolean;
  /** True once an asset hash comparison actually ran. */
  readonly checked: boolean;
  readonly reasons: readonly string[];
}

/** A version-specific compatibility pack for a driver build. */
export interface TapAdapter {
  readonly id: string;
  /** HID resource hashes this adapter was written for. */
  readonly hidHashes?: readonly string[];
  /** Screen resource hashes this adapter was written for. */
  readonly screenHashes?: readonly string[];
  /** Firmware versions this adapter was validated against. */
  readonly firmwareVersions?: readonly string[];
  /**
   * When true, a hash mismatch does not disqualify the adapter. Use only after
   * manually diffing the new driver; default false.
   */
  readonly allowUnknownHashes?: boolean;
  /** Rewrites applied before the user's hooks. */
  readonly hooks?: TapHooks;
}

export interface TapHidStatus {
  readonly attached: boolean;
  readonly connected: boolean;
  readonly device: HidDeviceLike | null;
}

export interface TapSerialStatus {
  readonly attached: boolean;
  readonly connected: boolean;
  readonly port: SerialPortLike | null;
}

export interface TapCounters {
  readonly hidOut: number;
  readonly hidIn: number;
  readonly serialOut: number;
  readonly serialIn: number;
}

/** Snapshot returned by {@link ZetsuTap.status}. */
export interface TapStatus {
  readonly state: TapState;
  readonly mode: TapMode;
  readonly fingerprint: TapFingerprint;
  readonly hid: TapHidStatus;
  readonly serial: TapSerialStatus;
  readonly frames: TapCounters;
  readonly adapterId: string | null;
  readonly reasons: readonly string[];
}

/** Events emitted by {@link ZetsuTap}. */
export interface TapEvents {
  status: TapStatus;
  frame: TapFrame;
  error: Error;
}

/** Structural constructor shape, used by tests without real WebHID/Web Serial. */
export interface HidDeviceConstructorLike {
  readonly prototype: HidDeviceLike;
}

export interface SerialPortConstructorLike {
  readonly prototype: SerialPortLike;
}

/** Injectable environment so the tap layer is testable under plain Node. */
export interface TapEnvironment {
  readonly hid?: HidLike | null;
  readonly serial?: SerialLike | null;
  readonly hidDevice?: HidDeviceConstructorLike | null;
  readonly serialPort?: SerialPortConstructorLike | null;
  /**
   * The HOST page's window (e.g. Tampermonkey's `unsafeWindow`), used to read
   * page globals such as `window.data`. When the tap runs in an isolated
   * userscript world, `globalThis.data` is the sandbox's own binding — only the
   * injected page window sees the driver page's. Defaults to `globalThis`.
   */
  readonly window?: unknown;
  readonly document?: Document | null;
  readonly fetch?: typeof fetch | null;
  readonly crypto?: Crypto | null;
}

export interface ZetsuTapOptions {
  /** Product used to scope taps and to create active clients. */
  readonly product?: ProductInfo;
  readonly mode?: TapMode;
  readonly hooks?: TapHooks;
  /** Optional version-specific adapter; matching adapters enable writes. */
  readonly adapter?: TapAdapter;
  /**
   * Hash the driver's script assets at startup. This performs same-origin
   * fetches; disable in tests or on pages where that is undesirable.
   * Defaults to `true`.
   */
  readonly autoFingerprint?: boolean;
  /** Override globals (tests, non-window runtimes). */
  readonly environment?: TapEnvironment;
}
