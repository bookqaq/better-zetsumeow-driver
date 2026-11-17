/**
 * ZetsuKeyboard — the high level client.
 *
 * Wraps the WebHID link, resolves the active key layout from the device
 * (`cmd 2/19`, 65 keys vs 79 keys with the F-row module) and exposes the
 * feature setters/getters extracted from the ZetsuMeow web driver.
 *
 * Screen (Web Serial) is optionally attached through a lazily created
 * {@link ZetsuScreen} handle: connecting the keyboard never touches the serial
 * API, exactly like the original driver where the screen link is opened only
 * after the user enters the screen section and clicks "connect screen".
 */

import { Emitter } from './emitter.ts';
import type { Listener } from './emitter.ts';
import {
  NotConnectedError,
  TransportError,
  TimeoutError,
  UnknownKeyError,
  UnknownLayoutError,
  UnsupportedError,
  UnsupportedFeatureError,
  ValidationError,
  ZmeowError,
} from './errors.ts';
import type {
  DeviceInfo,
  FeatureConfig,
  FeatureKind,
  HexColor,
  KeyColor,
  KeyDef,
  KeyLayout,
  KeyMapEntry,
  KeyRef,
  KeyReleaseEvent,
  KeyTestMode,
  KeyTravelEvent,
  KeyboardEvents,
  LayoutMode,
  LightState,
  ProductInfo,
  RunMode,
  TravelEntry,
} from './types.ts';
import type { HidDeviceLike, Transport } from './transport/types.ts';
import {
  HidTransport,
  describeHidDevice,
  getGrantedHidDevices,
  getHidApi,
  isWebHidSupported,
  rankHidInterfaces,
  requestHidDevices,
} from './transport/webhid.ts';
import type { HidInterfaceDescription } from './transport/webhid.ts';
import { buildFrame } from './protocol/frame.ts';
import {
  HidCommand,
  MiscSubCommand,
  deviceInfoPayload,
  endSetPayload,
  featureClearPayload,
  featureGetOnePayload,
  featureGetPayload,
  keyColorGetPayload,
  keyColorSetPayloads,
  lightGetPayload,
  lightSetPayload,
  miscPayload,
  mptSetPayload,
  mtSetPayload,
  remapGetPayload,
  remapSetPayload,
  rsSetPayload,
  socdSetPayload,
  tglSetPayload,
  travelGetPayload,
  travelSetPayloads,
} from './protocol/commands.ts';
import {
  decodeDeviceInfo,
  decodeFeature,
  decodeFeatureList,
  decodeKeyColors,
  decodeKeyMap,
  decodeKeyTravel,
  decodeLight,
  decodeMisc,
  decodeTravelConfig,
} from './protocol/response.ts';
import { hexToRgb } from './codec/color.ts';
import { msToByte } from './codec/units.ts';
import { ZETSU63_PRODUCT } from './generated/product-zetsu63.ts';
import { KEY_CATALOG } from './generated/key-catalog.ts';
import { LIGHT_BRIGHTNESS_MAX } from './generated/light-modes.ts';
import { ZetsuScreen } from './screen.ts';

/** Products this SDK knows how to talk to. */
export const PRODUCTS: readonly ProductInfo[] = [ZETSU63_PRODUCT];

const DEFAULT_TIMEOUT_MS = 800;
const DEFAULT_RETRIES = 2;

/**
 * `cmd 41` write pacing: wait 10 ms before chunking, wait 5 ms before every
 * chunk, then settle for `chunks * 10 + 100` ms. The firmware processes travel
 * writes asynchronously and silently drops close chunks; issuing the next read
 * before the settle can leave it queued behind the write work and time out
 * (docs/PROTOCOL.md 9.10).
 */
const TRAVEL_WRITE_LEAD_MS = 10;
const TRAVEL_WRITE_CHUNK_GAP_MS = 5;
const TRAVEL_WRITE_SETTLE_BASE_MS = 100;
const TRAVEL_WRITE_SETTLE_PER_CHUNK_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Keys added by the F-row module: Esc(0x00), F1..F12(0x01..0x0C), Del(0x4F). */
const F_ROW_HARD_CODES: ReadonlySet<number> = new Set([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x4f,
]);

export interface ConnectOptions {
  /** Per-report response timeout. */
  readonly timeoutMs?: number;
  /** How many times a timed out read is retried. */
  readonly retries?: number;
}

export interface DisconnectOptions {
  /** Keep the screen (serial) link open after the keyboard goes away. */
  readonly keepScreen?: boolean;
}

export interface OpenScreenOptions {
  /** Try `navigator.serial.getPorts()` before prompting (no user gesture needed). */
  readonly reuseGrantedPort?: boolean;
}

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface SetLightPatch {
  readonly mode?: number;
  readonly speed?: number;
  readonly turn?: number;
  readonly brightness?: number;
  readonly colorful?: number;
  readonly rgb?: HexColor | Rgb;
}

export interface SetKeyColorOptions {
  readonly brightness?: number;
}

/** One key-colour entry for {@link ZetsuKeyboard.setKeyColors}. */
export interface KeyColorInput {
  readonly key: KeyRef;
  readonly color: HexColor | Rgb;
  /** Defaults to the current light brightness. */
  readonly brightness?: number;
}

export interface SetRemapOptions {
  /** 0 = base layer, 1/2 = Fn layers. */
  readonly layer?: 0 | 1 | 2;
  /**
   * Read the layer back after writing and rewrite the key once if the value did
   * not stick. The firmware occasionally acknowledges a `cmd 35` write without
   * applying it (more likely while it streams multi-frame reports), which looks
   * exactly like "the remap did nothing". Costs one extra `cmd 35` series.
   */
  readonly verify?: boolean;
  /** Milliseconds to wait before the verification read. Default 250. */
  readonly settleMs?: number;
}

export interface ResetRemapOptions {
  /** 0 = base layer, 1/2 = Fn layers. */
  readonly layer?: 0 | 1 | 2;
  /**
   * `default` writes the key's own HID usage from the layout table
   * (the factory function of that key); `none` writes usage 0, which clears
   * the override on that layer (the firmware reports 0 for most Fn-layer keys
   * out of the box).
   */
  readonly mode?: 'default' | 'none';
  /** Milliseconds to wait before the caller re-reads the map. Default 0. */
  readonly settleMs?: number;
  /** Read back and rewrite keys whose write did not stick (see `SetRemapOptions`). */
  readonly verify?: boolean;
}

/**
 * A plain, JSON-serialisable copy of the remap table.
 *
 * Capture one before editing and hand it back to
 * {@link ZetsuKeyboard.restoreRemapSnapshot} to undo the change ("restore the
 * mapping as it was before this edit"), or persist it to offer a later rollback.
 */
export interface RemapSnapshot {
  /** `Date.now()` when the snapshot was taken. */
  readonly takenAt: number;
  /** Layout the snapshot was taken on; restoring it on another layout throws. */
  readonly layout: LayoutMode;
  /** `layer -> hardCode -> HID usage`. */
  readonly layers: Readonly<Record<number, Readonly<Record<number, number>>>>;
}

export interface RemapSnapshotOptions {
  /** Layers to include; defaults to `[0, 1]`. Duplicates are dropped. */
  readonly layers?: readonly (0 | 1 | 2)[];
}

export interface RestoreRemapOptions {
  /**
   * Layers to restore; defaults to every layer present in the snapshot.
   * A layer missing from the snapshot is skipped.
   */
  readonly layers?: readonly (0 | 1 | 2)[];
  /** Restrict the restore to these keys; defaults to every key in the snapshot. */
  readonly keys?: KeyRef | readonly KeyRef[];
  /**
   * Read the device and report what would change without writing anything.
   * Useful for a "N keys will be restored" confirmation.
   */
  readonly dryRun?: boolean;
  /** Milliseconds to wait before the caller re-reads the map. Default 0. */
  readonly settleMs?: number;
  /** Read back and rewrite keys whose write did not stick (see `SetRemapOptions`). */
  readonly verify?: boolean;
  /**
   * Gap between two `cmd 35` writes of a batch. The official driver sleeps
   * 300 ms after every remap write; firing them back-to-back makes the
   * firmware drop some (see docs/PROTOCOL.md 9.9). Default 0 — bulk flows
   * (config restore) opt in.
   */
  readonly writeGapMs?: number;
}

/** One key that {@link ZetsuKeyboard.restoreRemapSnapshot} wrote (or would write). */
export interface RemapRestoreEntry {
  readonly layer: number;
  readonly hardCode: number;
  readonly title: string;
  readonly textCode: string;
  /** Usage currently on the device (0 when the device no longer reports it). */
  readonly from: number;
  /** Usage recorded in the snapshot. */
  readonly to: number;
}

export interface RemapRestoreResult {
  /** Keys whose value differed and were written; unchanged keys are skipped. */
  readonly entries: readonly RemapRestoreEntry[];
  /** `entries.length` (unchanged keys are not rewritten). */
  readonly written: number;
  /** Keys in the snapshot that already matched the device. */
  readonly unchanged: number;
  /** Keys in the snapshot that the active layout does not know about. */
  readonly skipped: number;
}

export interface RSKeyOptions {
  readonly key1: KeyRef;
  readonly key2: KeyRef;
  readonly bottom?: boolean;
  /** Pause in milliseconds; firmware stores `round(ms/10)` (default 10ms → 1). */
  readonly ms?: number;
}

export interface SocdKeyOptions {
  readonly key1: KeyRef;
  readonly key2: KeyRef;
  readonly first1?: 0 | 1;
  readonly first2?: 0 | 1;
  readonly bottom?: boolean;
  readonly ms?: number;
}

export interface MTKeyOptions {
  readonly key: KeyRef;
  readonly hold: KeyRef;
  readonly tap: KeyRef;
  /** Default 200ms (firmware byte 20). */
  readonly ms?: number;
}

export interface TglKeyOptions {
  readonly key: KeyRef;
  readonly target: KeyRef;
  readonly ms?: number;
}

export interface MptKeyOptions {
  readonly key: KeyRef;
  readonly targets: readonly [KeyRef, KeyRef, KeyRef];
  /** Three strictly increasing travel points in millimetres. */
  readonly mm: readonly [number, number, number];
}

export interface EndKeyOptions {
  readonly key: KeyRef;
  readonly target: KeyRef;
  /**
   * Pause in milliseconds; the firmware stores `round(ms/10)`.
   * The web driver hardcodes 10ms here, so 10 is the default.
   */
  readonly ms?: number;
}

/** One key's travel write, without repeating the key reference. */
export type KeyTravelPatch = Omit<TravelConfigEntry, 'key'>;

export interface TravelConfigEntry {
  readonly key: KeyRef;
  readonly pressMm: number;
  /** Legacy single release value; used for both directions when the split fields are absent. */
  readonly releaseMm: number;
  /** Fast-trigger press/re-trigger travel (`travel_down`), mm. */
  readonly travelDownMm?: number;
  /** Fast-trigger release/reset travel (`travel_up`), mm. */
  readonly travelUpMm?: number;
  readonly deadDownMm?: number;
  readonly deadUpMm?: number;
  readonly fastOutMm?: number;
  readonly fast?: boolean;
}

interface MutableDeviceInfo {
  boardId: string;
  sn: string;
  firmwareVersion: string;
  runMode: RunMode;
  runModeNum: number;
  pzNum: number;
  isMac: boolean | null;
  winLock: boolean | null;
  highPrecision: boolean | null;
  isLock: boolean | null;
  lightSleep: number | null;
  fMode: number | null;
}

interface PendingRequest {
  readonly matches: (raw: Uint8Array) => boolean;
  readonly resolve: (raw: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
}

/** Serializes every HID round trip so responses can be correlated by command. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Failures that make it worth retrying another HID interface. */
function isLinkFailure(error: unknown): boolean {
  return (
    error instanceof TransportError ||
    error instanceof NotConnectedError ||
    (error instanceof ZmeowError && error.code === 'DEVICE_OPEN')
  );
}

function parseKeyNumber(value: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(value)) return Number(value);
  if (/^\d+$/.test(value)) return Number(value);
  return null;
}

/** Validate, de-duplicate and order the Fn layer indexes of a remap operation. */
function normalizeRemapLayers(
  layers: readonly (0 | 1 | 2)[] | undefined,
  fallback: readonly (0 | 1 | 2)[],
): Array<0 | 1 | 2> {
  const source = layers && layers.length ? layers : fallback;
  const result: Array<0 | 1 | 2> = [];
  for (const layer of source) {
    if (layer !== 0 && layer !== 1 && layer !== 2) {
      throw new ValidationError(`Invalid layer ${String(layer)}; expected 0, 1 or 2`);
    }
    if (!result.includes(layer)) result.push(layer);
  }
  return result;
}

function makeLayout(
  mode: LayoutMode,
  product: ProductInfo,
  rawFMode: number | null,
): KeyLayout {
  if (mode === 'unknown') {
    return {
      mode,
      keyCount: 0,
      hasFRow: false,
      rawFMode,
      keys: [],
      byHardCode: new Map(),
      byTextCode: new Map(),
      byTitle: new Map(),
    };
  }
  const definition =
    mode === 'extended79' ? product.layouts.extended79 : product.layouts.compact65;
  const byHardCode = new Map<number, KeyDef>();
  const byTextCode = new Map<string, KeyDef>();
  const byTitle = new Map<string, KeyDef>();
  for (const key of definition.keys) {
    byHardCode.set(key.hardCode, key);
    byTextCode.set(key.textCode, key);
    byTitle.set(key.title, key);
  }
  return {
    mode,
    keyCount: definition.keys.length,
    hasFRow: definition.keys.some((key) => key.isFRow),
    rawFMode,
    keys: definition.keys,
    byHardCode,
    byTextCode,
    byTitle,
  };
}

function lookupCatalogEntry(name: string): { usage: number } | null {
  const exact = KEY_CATALOG.find(
    (entry) => entry.textCode === name || entry.title === name,
  );
  if (exact) return { usage: exact.usage };
  const lower = name.toLowerCase();
  const relaxed = KEY_CATALOG.find(
    (entry) =>
      entry.textCode.toLowerCase() === lower || entry.title.toLowerCase() === lower,
  );
  return relaxed ? { usage: relaxed.usage } : null;
}

export class ZetsuKeyboard {
  private currentDevice: HidDeviceLike;
  private readonly productInfo: ProductInfo;
  private transport: Transport;
  private readonly transportInjected: boolean;
  private readonly candidates: readonly HidDeviceLike[];
  private readonly events = new Emitter<KeyboardEvents>();
  private readonly mutex = new Mutex();

  private pending: PendingRequest | null = null;
  private unsubscribeTransport: (() => void) | null = null;
  private connected = false;
  private layoutState: KeyLayout | null = null;
  private lightState: LightState = {
    mode: 1,
    speed: 80,
    turn: 0,
    brightness: 8,
    colorful: 0,
    rgb: '#FFFFFF',
  };
  private keyColorState = new Map<number, KeyColor>();
  private featureState = new Map<number, FeatureKind>();
  private travelState = new Map<number, TravelEntry>();
  /**
   * Which key-test stream the firmware is currently in (`cmd 2/2` or `cmd 2/3`).
   *
   * The device keeps streaming `cmd 48` travel reports until it receives the end
   * command (`cmd 2/4` + `0xFF`) and normal typing is unavailable meanwhile, so
   * the SDK remembers the state and ends the test before closing the link.
   */
  private keyTestMode: KeyTestMode | null = null;
  private screenHandle: ZetsuScreen | null = null;
  private readonly infoState: MutableDeviceInfo = {
    boardId: '',
    sn: '',
    firmwareVersion: '',
    runMode: 'app',
    runModeNum: 0,
    pzNum: 0,
    isMac: null,
    winLock: null,
    highPrecision: null,
    isLock: null,
    lightSleep: null,
    fMode: null,
  };

  constructor(
    device: HidDeviceLike,
    product: ProductInfo = ZETSU63_PRODUCT,
    options: {
      readonly transport?: Transport;
      /** All interfaces granted by the chooser, best first. */
      readonly candidates?: readonly HidDeviceLike[];
    } = {},
  ) {
    this.currentDevice = device;
    this.productInfo = product;
    this.transportInjected = options.transport !== undefined;
    this.candidates =
      options.candidates && options.candidates.length > 0
        ? [...options.candidates]
        : [device];
    this.transport =
      options.transport ??
      new HidTransport(device, {
        onDisconnect: () => this.handleDeviceDisconnect(),
      });
  }

  // ---------------------------------------------------------------- statics

  /** True when the runtime exposes WebHID. */
  static isSupported(): boolean {
    return isWebHidSupported();
  }

  /** Prompt the user for a ZetsuMeow keyboard (or a specific product). */
  static async requestDevice(options: {
    readonly vendorId?: number;
    readonly productId?: number;
  } = {}): Promise<ZetsuKeyboard> {
    if (!isWebHidSupported() || !getHidApi()) {
      throw new UnsupportedError(
        'WebHID is not available. Use Chrome/Edge over https or http://localhost.',
      );
    }
    const filters =
      options.vendorId !== undefined && options.productId !== undefined
        ? [{ vendorId: options.vendorId, productId: options.productId }]
        : PRODUCTS.map((product) => ({
            vendorId: product.vid,
            productId: product.pid,
          }));
    const devices = await requestHidDevices(filters);

    const resolved: { device: HidDeviceLike; product: ProductInfo }[] = [];
    for (const device of devices) {
      const product = PRODUCTS.find(
        (candidate) =>
          candidate.vid === device.vendorId && candidate.pid === device.productId,
      );
      if (product) resolved.push({ device, product });
    }
    if (resolved.length === 0) {
      const ids = devices
        .map((device) => `${device.vendorId.toString(16)}:${device.productId.toString(16)}`)
        .join(', ');
      throw new UnsupportedError(`No supported ZetsuMeow interface was selected (got ${ids}).`);
    }
    const product = resolved[0]!.product;
    const ranked = rankHidInterfaces(
      resolved.map((entry) => entry.device),
      product,
    );
    return new ZetsuKeyboard(ranked[0]!.device, product, {
      candidates: ranked.map((entry) => entry.device),
    });
  }

  /**
   * Diagnostics: describe every HID interface the user already granted.
   *
   * The SDK does not call `forget()` (the web driver does, which loses the
   * grant); call {@link requestDevice} again to grant additional interfaces.
   */
  static async listGrantedInterfaces(): Promise<
    {
      readonly product: ProductInfo | null;
      readonly device: HidInterfaceDescription;
      readonly score: number | null;
    }[]
  > {
    const devices = await getGrantedHidDevices();
    return devices.map((device) => {
      const product =
        PRODUCTS.find(
          (candidate) =>
            candidate.vid === device.vendorId && candidate.pid === device.productId,
        ) ?? null;
      const score = product ? (rankHidInterfaces([device], product)[0]?.score ?? null) : null;
      return { product, device: describeHidDevice(device), score };
    });
  }

  /** Wrap an already granted HID device. */
  static fromDevice(device: HidDeviceLike, product?: ProductInfo): ZetsuKeyboard {
    const resolved =
      product ??
      PRODUCTS.find(
        (candidate) =>
          candidate.vid === device.vendorId && candidate.pid === device.productId,
      );
    if (!resolved) {
      throw new UnsupportedError(
        `Unsupported device ${device.vendorId.toString(16)}:${device.productId
          .toString(16)}.`,
      );
    }
    return new ZetsuKeyboard(device, resolved);
  }

  // ------------------------------------------------------------- accessors

  get product(): ProductInfo {
    return this.productInfo;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get info(): Readonly<DeviceInfo> {
    return this.infoState;
  }

  /** Resolved layout, `null` before {@link connect}. */
  get layout(): KeyLayout | null {
    return this.layoutState;
  }

  /** Keys of the active layout (empty when the layout is unknown). */
  get keys(): readonly KeyDef[] {
    return this.layoutState?.keys ?? [];
  }

  get isFRowInstalled(): boolean {
    return this.layoutState?.hasFRow ?? false;
  }

  get deviceHandle(): HidDeviceLike {
    return this.currentDevice;
  }

  /** Diagnostics for the interface currently in use. */
  get interfaceInfo(): HidInterfaceDescription {
    return describeHidDevice(this.currentDevice);
  }

  /** Screen handle. Creating it performs no I/O; call {@link openScreen}. */
  get screen(): ZetsuScreen {
    if (!this.screenHandle) this.screenHandle = this.createScreen();
    return this.screenHandle;
  }

  get isScreenOpen(): boolean {
    return this.screenHandle?.isOpen ?? false;
  }

  on<K extends keyof KeyboardEvents>(
    event: K,
    listener: Listener<KeyboardEvents[K]>,
  ): () => void {
    return this.events.on(event, listener);
  }

  once<K extends keyof KeyboardEvents>(
    event: K,
    listener: Listener<KeyboardEvents[K]>,
  ): () => void {
    return this.events.once(event, listener);
  }

  off<K extends keyof KeyboardEvents>(
    event: K,
    listener: Listener<KeyboardEvents[K]>,
  ): void {
    this.events.off(event, listener);
  }

  // -------------------------------------------------------------- lifecycle

  async connect(options: ConnectOptions = {}): Promise<this> {
    if (this.connected) return this;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options.retries ?? DEFAULT_RETRIES;

    if (this.transportInjected) {
      await this.connectCandidate(this.currentDevice, timeoutMs, retries);
      return this;
    }

    const candidates = this.candidates.length > 0 ? this.candidates : [this.currentDevice];
    let lastError: unknown = null;
    for (const device of candidates) {
      try {
        await this.connectCandidate(device, timeoutMs, retries);
        return this;
      } catch (error) {
        lastError = error;
        // A composite device exposes several interfaces; the wrong one rejects
        // output reports. Try the next candidate before giving up.
        if (!isLinkFailure(error)) throw error;
        this.events.emit('error', toError(error));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new TransportError('Every granted HID interface failed');
  }

  private async connectCandidate(
    device: HidDeviceLike,
    timeoutMs: number,
    retries: number,
  ): Promise<void> {
    await this.mutex.run(async () => {
      if (this.connected) return;
      if (!this.transportInjected) {
        this.transport = new HidTransport(device, {
          onDisconnect: () => this.handleDeviceDisconnect(),
        });
      }
      this.currentDevice = device;
      await this.transport.open();
      this.unsubscribeTransport = this.transport.subscribe((frame) =>
        this.handleFrame(frame),
      );
      this.connected = true;
      this.keyTestMode = null;
      try {
        const infoFrame = await this.sendWithRetry(
          buildFrame(HidCommand.DeviceInfo, deviceInfoPayload()),
          HidCommand.DeviceInfo,
          null,
          timeoutMs,
          retries,
        );
        const decoded = decodeDeviceInfo(infoFrame);
        if (!decoded) throw new TransportError('Device returned an invalid info report');
        this.applyDeviceInfo(decoded);

        try {
          const pzFrame = await this.sendWithRetry(
            buildFrame(HidCommand.Misc, miscPayload(MiscSubCommand.GetPzNum, 255)),
            HidCommand.Misc,
            MiscSubCommand.GetPzNum,
            timeoutMs,
            retries,
          );
          this.applyMisc(pzFrame);
        } catch {
          // pz_num is informational; keep going.
        }

        try {
          const fModeFrame = await this.sendWithRetry(
            buildFrame(HidCommand.Misc, miscPayload(MiscSubCommand.GetFMode)),
            HidCommand.Misc,
            MiscSubCommand.GetFMode,
            timeoutMs,
            retries,
          );
          this.applyMisc(fModeFrame);
        } catch (error) {
          this.infoState.fMode = null;
          this.layoutState = makeLayout('unknown', this.productInfo, null);
          this.events.emit('error', toError(error));
        }
      } catch (error) {
        this.connected = false;
        this.unsubscribeTransport?.();
        this.unsubscribeTransport = null;
        this.layoutState = null;
        try {
          await this.transport.close();
        } catch {
          // ignore secondary failure
        }
        throw error;
      }
    });
  }

  async disconnect(options: DisconnectOptions = {}): Promise<void> {
    if (!options.keepScreen && this.screenHandle) {
      try {
        await this.screenHandle.close();
      } catch {
        // ignore
      }
    }
    if (this.keyTestMode && this.connected) {
      // Leaving the device in its test stream keeps the firmware reporting
      // travel instead of typing, so close it out before the link goes away.
      try {
        await this.send(HidCommand.Misc, miscPayload(MiscSubCommand.TestEnd, 0xff));
      } catch {
        // best effort: the link may already be gone
      }
      this.keyTestMode = null;
    }
    await this.mutex.run(async () => {
      this.connected = false;
      this.rejectPending(new NotConnectedError());
      this.unsubscribeTransport?.();
      this.unsubscribeTransport = null;
      try {
        await this.transport.close();
      } catch {
        // ignore
      }
    });
  }

  /** Re-read `cmd 2/19` and rebuild the key layout (F-row hot plug / reconnect). */
  async refreshLayout(options: ConnectOptions = {}): Promise<KeyLayout> {
    const layout = await this.reloadLayout(options);
    return layout;
  }

  /** Alias kept for discoverability. */
  async retryLayout(options: ConnectOptions = {}): Promise<KeyLayout> {
    return this.refreshLayout(options);
  }

  // ------------------------------------------------------------- device info

  async getDeviceInfo(): Promise<DeviceInfo> {
    const frame = await this.request(
      HidCommand.DeviceInfo,
      deviceInfoPayload(),
      null,
    );
    const decoded = decodeDeviceInfo(frame);
    if (!decoded) throw new TransportError('Device returned an invalid info report');
    this.applyDeviceInfo(decoded);
    return this.info;
  }

  // ------------------------------------------------------------------ reads

  /**
   * Read one layer's key map.
   *
   * A `cmd 35` read can time out once and succeed on the next attempt — right
   * after the device leaves its key-test stream, or while a driver page keeps
   * a shared handle busy — so a timed-out read is retried a single time.
   */
  async getKeyMap(layer: 0 | 1 | 2 = 0): Promise<Map<number, KeyMapEntry>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.readKeyMap(layer);
      } catch (error) {
        if (!(error instanceof TimeoutError) || attempt > 0) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new TimeoutError(`Timed out reading layer ${layer}`);
  }

  private async readKeyMap(layer: 0 | 1 | 2): Promise<Map<number, KeyMapEntry>> {
    const layout = this.requireLayout();
    const frames = await this.requestSeries(HidCommand.Remap, remapGetPayload(layer));
    const result = new Map<number, KeyMapEntry>();
    const merged = new Map<number, { usage: number; assigned: boolean }>();
    for (const frame of frames) {
      const decoded = decodeKeyMap(frame);
      if (!decoded) continue;
      for (const [hardCode, value] of decoded) merged.set(hardCode, value);
    }
    for (const [hardCode, value] of merged) {
      const key = layout.byHardCode.get(hardCode);
      if (!key) continue;
      result.set(hardCode, {
        hardCode,
        hidCode: value.usage,
        title: key.title,
        textCode: key.textCode,
      });
    }
    return result;
  }

  async getLight(): Promise<LightState> {
    const frame = await this.request(HidCommand.Light, lightGetPayload());
    const decoded = decodeLight(frame);
    if (!decoded) throw new TransportError('Device returned an invalid light report');
    this.lightState = decoded;
    return decoded;
  }

  /**
   * Read every key colour. Multi-frame reads can lose their first frame to a
   * busy shared handle (docs/PROTOCOL.md 9.9), so a timed-out read is retried
   * a single time, like {@link getKeyMap}.
   */
  async getKeyColors(): Promise<Map<number, KeyColor>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.readKeyColors();
      } catch (error) {
        if (!(error instanceof TimeoutError) || attempt > 0) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new TimeoutError('Timed out reading the key colours');
  }

  private async readKeyColors(): Promise<Map<number, KeyColor>> {
    const frames = await this.requestSeries(HidCommand.KeyColor, keyColorGetPayload());
    const merged = new Map<number, KeyColor>();
    for (const frame of frames) {
      const decoded = decodeKeyColors(frame);
      if (!decoded) continue;
      for (const [hardCode, color] of decoded) {
        // The firmware can report above the UI maximum (a Dimension Pro returns
        // 17 while the driver's slider tops out at 10); the driver clamps this
        // value before showing it, so the SDK exposes the same clamped range.
        merged.set(hardCode, {
          ...color,
          brightness: Math.min(color.brightness, LIGHT_BRIGHTNESS_MAX),
        });
      }
    }
    if (merged.size === 0) {
      throw new TransportError('Device returned an invalid colour report');
    }
    this.keyColorState = merged;
    return merged;
  }

  /**
   * Read the advanced-key feature list.
   *
   * A `cmd 47` read can time out once and succeed on the next attempt while a
   * driver page keeps a shared handle busy (same failure mode as the `cmd 35`
   * reads — docs/PROTOCOL.md 9.9), so a timed-out read is retried a single
   * time, like {@link getKeyMap}.
   */
  async getFeatures(): Promise<Map<number, FeatureKind>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.readFeatures();
      } catch (error) {
        if (!(error instanceof TimeoutError) || attempt > 0) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new TimeoutError('Timed out reading the feature list');
  }

  private async readFeatures(): Promise<Map<number, FeatureKind>> {
    const frames = await this.requestSeries(HidCommand.Feature, featureGetPayload());
    const merged = new Map<number, FeatureKind>();
    for (const frame of frames) {
      const decoded = decodeFeatureList(frame);
      if (!decoded) continue;
      for (const [hardCode, kind] of decoded) merged.set(hardCode, kind);
    }
    if (merged.size === 0) {
      throw new TransportError('Device returned an invalid feature report');
    }
    this.featureState = merged;
    return merged;
  }

  async getFeature(key: KeyRef): Promise<FeatureConfig | null> {
    const keyDef = this.resolveSourceKey(key);
    if (this.featureState.size === 0) {
      // The per-key getters need to know which family to query.
      await this.getFeatures();
    }
    const kind = this.featureState.get(keyDef.hardCode) ?? 'none';
    if (kind === 'none') return null;
    const command = this.commandForFeature(kind);
    const frame = await this.request(
      command,
      featureGetOnePayload(command, keyDef.hardCode),
    );
    const decoded = decodeFeature(frame);
    return decoded ?? { hardCode: keyDef.hardCode, kind };
  }

  /** Read every travel entry, retrying a timed-out read once (see 9.9). */
  async getTravelConfig(): Promise<Map<number, TravelEntry>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.readTravelConfig();
      } catch (error) {
        if (!(error instanceof TimeoutError) || attempt > 0) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new TimeoutError('Timed out reading the travel table');
  }

  private async readTravelConfig(): Promise<Map<number, TravelEntry>> {
    const frames = await this.requestSeries(HidCommand.Travel, travelGetPayload());
    const merged = new Map<number, TravelEntry>();
    for (const frame of frames) {
      const decoded = decodeTravelConfig(frame);
      if (!decoded) continue;
      for (const [hardCode, entry] of decoded) merged.set(hardCode, entry);
    }
    if (merged.size === 0) {
      throw new TransportError('Device returned an invalid travel report');
    }
    this.travelState = merged;
    return merged;
  }

  /** Read one key's travel configuration. */
  async getKeyTravel(key: KeyRef): Promise<TravelEntry | null> {
    const keyDef = this.resolveSourceKey(key);
    const config = await this.getTravelConfig();
    return config.get(keyDef.hardCode) ?? null;
  }

  /**
   * Write one key's travel configuration without touching any other key.
   *
   * Verified on hardware: writing one key leaves every other key's
   * configuration untouched.
   */
  async setKeyTravel(key: KeyRef, patch: KeyTravelPatch): Promise<void> {
    await this.setTravelConfig([{ key, ...patch }]);
  }

  async getWinLock(): Promise<boolean> {
    const frame = await this.request(
      HidCommand.Misc,
      miscPayload(MiscSubCommand.GetWinLock),
      MiscSubCommand.GetWinLock,
    );
    const decoded = decodeMisc(frame);
    if (!decoded || decoded.kind !== 'winLock') {
      throw new TransportError('Device returned an invalid Win-lock report');
    }
    return decoded.value;
  }

  async getMacMode(): Promise<boolean> {
    const frame = await this.request(
      HidCommand.Misc,
      miscPayload(MiscSubCommand.GetMacMode),
      MiscSubCommand.GetMacMode,
    );
    const decoded = decodeMisc(frame);
    if (!decoded || decoded.kind !== 'macMode') {
      throw new TransportError('Device returned an invalid Mac-mode report');
    }
    return decoded.value;
  }

  async getFMode(): Promise<number> {
    const frame = await this.request(
      HidCommand.Misc,
      miscPayload(MiscSubCommand.GetFMode),
      MiscSubCommand.GetFMode,
    );
    const decoded = decodeMisc(frame);
    if (!decoded || decoded.kind !== 'fMode') {
      throw new TransportError('Device returned an invalid F-mode report');
    }
    return decoded.value;
  }

  async getStatus(): Promise<boolean> {
    const frame = await this.request(
      HidCommand.Misc,
      miscPayload(MiscSubCommand.GetStatus),
      MiscSubCommand.GetStatus,
    );
    const decoded = decodeMisc(frame);
    if (!decoded || decoded.kind !== 'isLock') {
      throw new TransportError('Device returned an invalid status report');
    }
    return decoded.value !== 0;
  }

  async getLightSleep(): Promise<number> {
    const frame = await this.request(
      HidCommand.Misc,
      miscPayload(MiscSubCommand.GetLightSleep),
      MiscSubCommand.GetLightSleep,
    );
    const decoded = decodeMisc(frame);
    if (!decoded || decoded.kind !== 'lightSleep') {
      throw new TransportError('Device returned an invalid sleep report');
    }
    return decoded.value;
  }

  // ----------------------------------------------------------------- writes

  async setKeyRemap(
    source: KeyRef,
    target: KeyRef,
    options: SetRemapOptions = {},
  ): Promise<void> {
    const key = this.resolveSourceKey(source);
    const hidCode = this.resolveTargetUsage(target);
    const layer = options.layer ?? 0;
    if (layer !== 0 && layer !== 1 && layer !== 2) {
      throw new ValidationError(`Invalid layer ${String(layer)}; expected 0, 1 or 2`);
    }
    await this.send(
      HidCommand.Remap,
      remapSetPayload(layer, key.hardCode, hidCode),
    );
    if (options.verify) {
      // The firmware normalizes identity remaps away: writing a key's default
      // usage leaves no entry behind, so an absent read-back is success for
      // default-target writes (verified on hardware, firmware 1.1.1).
      const absentOk = hidCode === key.hidCode ? new Set([key.hardCode]) : undefined;
      const result = await this.verifyRemapWrites(
        layer,
        new Map([[key.hardCode, hidCode]]),
        options.settleMs ?? 0,
        0,
        absentOk,
      );
      if (result.failed.length > 0) {
        throw new TransportError(
          `The device kept the old mapping for "${key.title}" (hardCode 0x${key.hardCode.toString(16).toUpperCase()}) after a rewrite.`,
        );
      }
    }
  }

  /**
   * Restore one or more keys' remapping.
   *
   * `mode: 'default'` (default) writes the key's own layout HID usage, i.e. the
   * key behaves like itself again. `mode: 'none'` writes usage 0, clearing the
   * override on that layer — this matches how the firmware reports most keys on
   * the Fn layers out of the box.
   *
   * Returns the hard codes that were written.
   */
  async resetKeyRemap(
    keys: KeyRef | readonly KeyRef[],
    options: ResetRemapOptions = {},
  ): Promise<number[]> {
    const list = Array.isArray(keys) ? keys : [keys as KeyRef];
    const layer = options.layer ?? 0;
    const mode = options.mode ?? 'default';
    if (layer !== 0 && layer !== 1 && layer !== 2) {
      throw new ValidationError(`Invalid layer ${String(layer)}; expected 0, 1 or 2`);
    }
    const written: number[] = [];
    const expected = new Map<number, number>();
    for (const reference of list) {
      const key = this.resolveSourceKey(reference);
      const usage = mode === 'none' ? 0 : key.hidCode;
      await this.send(HidCommand.Remap, remapSetPayload(layer, key.hardCode, usage));
      written.push(key.hardCode);
      expected.set(key.hardCode, usage);
    }
    const settleMs = options.settleMs ?? 0;
    if (options.verify) {
      // In `default` mode every target equals the key's own usage, which the
      // firmware normalizes to "no entry" — an absent read-back is success.
      const absentOk = mode === 'default' ? new Set(written) : undefined;
      const result = await this.verifyRemapWrites(layer, expected, settleMs, 0, absentOk);
      if (result.failed.length > 0) {
        throw new TransportError(
          `The device kept the old mapping for ${result.failed.length} key(s) after a rewrite.`,
        );
      }
    } else if (settleMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
    }
    return written;
  }

  /**
   * Read the remap table into a plain snapshot so it can be restored later.
   *
   * This is the "restore what it was before this edit" primitive: capture a
   * snapshot before writing, keep it in memory (or `localStorage`), then pass it
   * back to {@link restoreRemapSnapshot}. Only the given layers are read, so the
   * default `[0, 1]` costs two `cmd 35` series (≈100 ms each on hardware).
   */
  async captureRemapSnapshot(options: RemapSnapshotOptions = {}): Promise<RemapSnapshot> {
    const layout = this.requireLayout();
    const layers = normalizeRemapLayers(options.layers, [0, 1]);
    const captured: Record<number, Record<number, number>> = {};
    for (const layer of layers) {
      const map = await this.getKeyMap(layer);
      const table: Record<number, number> = {};
      for (const [hardCode, entry] of map) table[hardCode] = entry.hidCode;
      captured[layer] = table;
    }
    return { takenAt: Date.now(), layout: layout.mode, layers: captured };
  }

  /**
   * Write a snapshot back, restoring the mapping to the state it was captured in.
   *
   * Only keys whose current usage differs from the snapshot are written, so an
   * untouched table costs no reports. Pass `dryRun: true` to preview the diff
   * without touching the device, and `keys` to undo a single key's edit. Keys the
   * snapshot does not contain are left alone (they are reported as `skipped`
   * when the active layout does not know them).
   */
  async restoreRemapSnapshot(
    snapshot: RemapSnapshot,
    options: RestoreRemapOptions = {},
  ): Promise<RemapRestoreResult> {
    const layout = this.requireLayout();
    if (snapshot.layout !== 'unknown' && snapshot.layout !== layout.mode) {
      throw new ValidationError(
        `Snapshot was taken on layout ${snapshot.layout}, but the device reports ${layout.mode}. Capture a fresh snapshot.`,
      );
    }
    const snapshotLayers = Object.keys(snapshot.layers)
      .map((layer) => Number(layer))
      .filter((layer): layer is 0 | 1 | 2 => layer === 0 || layer === 1 || layer === 2);
    const layers = normalizeRemapLayers(options.layers, snapshotLayers);
    const only =
      options.keys == null
        ? null
        : Array.isArray(options.keys)
          ? options.keys
          : [options.keys as KeyRef];
    const onlyHardCodes =
      only == null
        ? null
        : new Set(only.map((reference) => this.resolveSourceKey(reference).hardCode));

    const entries: RemapRestoreEntry[] = [];
    const expectedByLayer = new Map<number, Map<number, number>>();
    let unchanged = 0;
    let skipped = 0;
    const writeGapMs = options.writeGapMs ?? 0;
    const gap = (): Promise<void> =>
      writeGapMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, writeGapMs)) : Promise.resolve();
    let wroteAny = false;
    for (const layer of layers) {
      const wanted = snapshot.layers[layer];
      if (!wanted) continue;
      const current = await this.getKeyMap(layer);
      const expected = new Map<number, number>();
      for (const [rawHardCode, to] of Object.entries(wanted)) {
        const hardCode = Number(rawHardCode);
        if (onlyHardCodes && !onlyHardCodes.has(hardCode)) continue;
        const keyDef = layout.byHardCode.get(hardCode);
        if (!keyDef) {
          skipped += 1;
          continue;
        }
        const from = current.get(hardCode)?.hidCode ?? 0;
        if (from === to) {
          unchanged += 1;
          continue;
        }
        if (!options.dryRun) {
          // Pace batch writes like the official driver: a `cmd 35` write that
          // lands right after the previous one can be silently dropped.
          if (wroteAny) await gap();
          await this.send(HidCommand.Remap, remapSetPayload(layer, hardCode, to));
          expected.set(hardCode, to);
          wroteAny = true;
        }
        entries.push({
          layer,
          hardCode,
          title: keyDef.title,
          textCode: keyDef.textCode,
          from,
          to,
        });
      }
      if (expected.size > 0) expectedByLayer.set(layer, expected);
    }
    const settleMs = options.settleMs ?? 0;
    if (!options.dryRun && options.verify) {
      for (const [layer, expected] of expectedByLayer) {
        const result = await this.verifyRemapWrites(layer as 0 | 1 | 2, expected, settleMs, writeGapMs);
        if (result.failed.length > 0) {
          throw new TransportError(
            `The device kept the old mapping for ${result.failed.length} key(s) on layer ${layer} after a rewrite.`,
          );
        }
      }
    } else if (settleMs > 0 && !options.dryRun) {
      await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
    }
    return { entries, written: entries.length, unchanged, skipped };
  }

  async setLight(patch: SetLightPatch): Promise<void> {
    const mode = patch.mode ?? this.lightState.mode;
    const speed = patch.speed ?? this.lightState.speed;
    const turn = patch.turn ?? this.lightState.turn;
    const brightness = patch.brightness ?? this.lightState.brightness;
    const colorful = patch.colorful ?? this.lightState.colorful;
    const rgb = patch.rgb ?? this.lightState.rgb;
    // 255 is the per-key custom mode (单键自定义): the driver writes it
    // straight into the cmd 19 mode byte, and per-key colours then come from
    // `cmd 20`. Backup files captured in that mode must restore instead of
    // being rejected here.
    if (!Number.isInteger(mode) || mode < 0 || (mode > 9 && mode !== 255)) {
      throw new ValidationError(
        `Light mode must be an integer 0..9 or 255 (per-key custom), received ${mode}`,
      );
    }
    if (!Number.isInteger(brightness) || brightness < 0 || brightness > LIGHT_BRIGHTNESS_MAX) {
      throw new ValidationError(
        `Brightness must be an integer 0..${LIGHT_BRIGHTNESS_MAX}, received ${brightness}`,
      );
    }
    const channels = typeof rgb === 'string' ? hexToRgb(rgb) : rgb;
    const payload = lightSetPayload({
      mode,
      speed,
      turn,
      brightness,
      r: channels.r,
      g: channels.g,
      b: channels.b,
      colorful,
    });
    await this.send(HidCommand.Light, payload);
    this.lightState = {
      mode,
      speed,
      turn,
      brightness,
      colorful,
      rgb: typeof rgb === 'string' ? rgb : this.lightState.rgb,
    };
  }

  async setKeyColor(
    keys: KeyRef | readonly KeyRef[],
    color: HexColor | Rgb,
    options: SetKeyColorOptions = {},
  ): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys as KeyRef];
    const channels = typeof color === 'string' ? hexToRgb(color) : color;
    const brightness = options.brightness ?? this.lightState.brightness;
    if (!Number.isInteger(brightness) || brightness < 0 || brightness > LIGHT_BRIGHTNESS_MAX) {
      throw new ValidationError(
        `Brightness must be an integer 0..${LIGHT_BRIGHTNESS_MAX}, received ${brightness}`,
      );
    }
    const entries = list.map((reference) => {
      const key = this.resolveSourceKey(reference);
      return {
        hardCode: key.hardCode,
        r: channels.r,
        g: channels.g,
        b: channels.b,
        brightness,
      };
    });
    for (const payload of keyColorSetPayloads(entries)) {
      await this.send(HidCommand.KeyColor, payload);
    }
  }

  /**
   * Write different colours for many keys in one call.
   *
   * Entries are packed into `cmd 20` reports of up to 11 keys, so restoring a
   * per-key RGB layout costs a handful of reports instead of one per key.
   */
  async setKeyColors(entries: readonly KeyColorInput[]): Promise<void> {
    if (entries.length === 0) return;
    const defaultBrightness = this.lightState.brightness;
    const payloadEntries = entries.map((entry) => {
      const key = this.resolveSourceKey(entry.key);
      const channels = typeof entry.color === 'string' ? hexToRgb(entry.color) : entry.color;
      const brightness = entry.brightness ?? defaultBrightness;
      if (!Number.isInteger(brightness) || brightness < 0 || brightness > LIGHT_BRIGHTNESS_MAX) {
        throw new ValidationError(
          `Brightness must be an integer 0..${LIGHT_BRIGHTNESS_MAX}, received ${brightness}`,
        );
      }
      return {
        hardCode: key.hardCode,
        r: channels.r,
        g: channels.g,
        b: channels.b,
        brightness,
      };
    });
    for (const payload of keyColorSetPayloads(payloadEntries)) {
      await this.send(HidCommand.KeyColor, payload);
    }
  }

  async setRS(options: RSKeyOptions): Promise<void> {
    const key1 = this.resolveSourceKey(options.key1);
    const key2 = this.resolveSourceKey(options.key2);
    if (key1.hardCode === key2.hardCode) {
      throw new ValidationError('RS requires two different keys');
    }
    await this.send(
      HidCommand.Rs,
      rsSetPayload(
        key1.hardCode,
        key2.hardCode,
        options.bottom ? 1 : 0,
        msToByte(options.ms ?? 10),
      ),
    );
  }

  async setSOCD(options: SocdKeyOptions): Promise<void> {
    const key1 = this.resolveSourceKey(options.key1);
    const key2 = this.resolveSourceKey(options.key2);
    if (key1.hardCode === key2.hardCode) {
      throw new ValidationError('SOCD requires two different keys');
    }
    await this.send(
      HidCommand.Socd,
      socdSetPayload(
        key1.hardCode,
        options.first1 ?? 1,
        key2.hardCode,
        options.first2 ?? 0,
        options.bottom ? 1 : 0,
        msToByte(options.ms ?? 10),
      ),
    );
  }

  async setMT(options: MTKeyOptions): Promise<void> {
    const key = this.resolveSourceKey(options.key);
    const hold = this.resolveTargetUsage(options.hold);
    const tap = this.resolveTargetUsage(options.tap);
    await this.send(
      HidCommand.Mt,
      mtSetPayload(key.hardCode, hold, tap, msToByte(options.ms ?? 200)),
    );
  }

  async setTGL(options: TglKeyOptions): Promise<void> {
    const key = this.resolveSourceKey(options.key);
    const target = this.resolveTargetUsage(options.target);
    await this.send(
      HidCommand.Tgl,
      tglSetPayload(key.hardCode, target, msToByte(options.ms ?? 200)),
    );
  }

  async setMPT(options: MptKeyOptions): Promise<void> {
    const key = this.resolveSourceKey(options.key);
    const [t1, t2, t3] = options.targets;
    const usages: [number, number, number] = [
      this.resolveTargetUsage(t1),
      this.resolveTargetUsage(t2),
      this.resolveTargetUsage(t3),
    ];
    const [m1, m2, m3] = options.mm;
    if (!(m1 < m2 && m2 < m3)) {
      throw new ValidationError('MPT travel points must be strictly increasing');
    }
    const range = this.productInfo.keyRange;
    for (const value of options.mm) {
      if (value < range.min || value > range.max) {
        throw new ValidationError(
          `MPT travel ${value}mm out of range ${range.min}..${range.max}mm`,
        );
      }
    }
    await this.send(
      HidCommand.Mpt,
      mptSetPayload(key.hardCode, usages, [m1, m2, m3]),
    );
  }

  async setEND(options: EndKeyOptions): Promise<void> {
    const key = this.resolveSourceKey(options.key);
    const target = this.resolveTargetUsage(options.target);
    await this.send(
      HidCommand.End,
      endSetPayload(key.hardCode, target, msToByte(options.ms ?? 10)),
    );
  }

  async clearFeature(key: KeyRef): Promise<void> {
    const keyDef = this.resolveSourceKey(key);
    await this.send(HidCommand.Feature, featureClearPayload(keyDef.hardCode));
    this.featureState.set(keyDef.hardCode, 'none');
  }

  async setTravelConfig(entries: readonly TravelConfigEntry[]): Promise<void> {
    if (entries.length === 0) {
      throw new ValidationError('setTravelConfig requires at least one entry');
    }
    const range = this.productInfo.keyRange;
    const deadMin = range.deadMin ?? 0;
    const deadMax = range.deadMax ?? 1;
    const payloadEntries = entries.map((entry) => {
      const key = this.resolveSourceKey(entry.key);
      // Hardware limits are the per-key layout values (minTravel/maxTravel =
      // 0.01..4.0 mm for the stock Gateron magnetic switches, 0.01 mm grid).
      // The product `keyRange` (0.1..3.1 mm) is only the official UI slider
      // preset; the firmware stores the full switch range.
      const check = (label: string, value: number, min: number, max: number) => {
        if (!Number.isFinite(value) || value < min || value > max) {
          throw new ValidationError(
            `${label} ${value}mm out of range ${min}..${max}mm for ${key.title}`,
          );
        }
      };
      check('pressMm', entry.pressMm, key.minTravel, key.maxTravel);
      check('releaseMm', entry.releaseMm, 0, key.maxTravel);
      const travelDownMm = entry.travelDownMm ?? entry.releaseMm;
      const travelUpMm = entry.travelUpMm ?? entry.releaseMm;
      check('travelDownMm', travelDownMm, 0, key.maxTravel);
      check('travelUpMm', travelUpMm, 0, key.maxTravel);
      const deadDownMm = entry.deadDownMm ?? range.deadValue ?? 0.2;
      const deadUpMm = entry.deadUpMm ?? range.deadValue ?? 0.2;
      check('deadDownMm', deadDownMm, deadMin, deadMax);
      check('deadUpMm', deadUpMm, deadMin, deadMax);
      const fast = entry.fast === true;
      const fastOutMm = fast ? entry.fastOutMm ?? entry.pressMm : 0;
      check('fastOutMm', fastOutMm, 0, key.maxTravel);
      return {
        hardCode: key.hardCode,
        type: fast ? 2 : 1,
        deadDownMm,
        deadUpMm,
        travelMm: entry.pressMm,
        fastOutMm,
        travelUpMm,
        travelDownMm,
      };
    });
    const payloads = travelSetPayloads(payloadEntries, entries.length);
    // Mirrors the official pacing exactly: 10 ms before the
    // first chunk, 5 ms before *every* chunk (including the first), then the
    // tail settle the official driver uses before it shows success. Without
    // the settle the following verify read / `cmd 47` read can queue behind
    // the firmware's travel work and time out (docs/PROTOCOL.md 9.10).
    await sleep(TRAVEL_WRITE_LEAD_MS);
    for (const payload of payloads) {
      await sleep(TRAVEL_WRITE_CHUNK_GAP_MS);
      await this.send(HidCommand.Travel, payload);
    }
    await sleep(
      payloads.length * TRAVEL_WRITE_SETTLE_PER_CHUNK_MS + TRAVEL_WRITE_SETTLE_BASE_MS,
    );
  }

  /**
   * Write the Win-key lock.
   *
   * The official driver only ever puts `cmd 2/7` on the wire with the second
   * byte 0 — regardless of the target state — and guards the write with a
   * state comparison, so `[7, 0]` behaves as a **toggle**, not an absolute
   * set. It never sends `[7, 1]`, so that frame's semantics are unverified;
   * an explicit {@link setWinLock} value is therefore implemented as
   * read + conditional toggle, which is idempotent and matches the driver's
   * own behaviour. Omitting the value reproduces the driver's raw toggle.
   */
  async setWinLock(value?: boolean): Promise<void> {
    if (value === undefined) {
      await this.send(HidCommand.Misc, miscPayload(MiscSubCommand.SetWinLock));
      return;
    }
    const current = await this.getWinLock();
    if (current !== value) {
      await this.send(HidCommand.Misc, miscPayload(MiscSubCommand.SetWinLock));
    }
    this.infoState.winLock = value;
  }

  async setLightSleep(minutes: number): Promise<void> {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 255) {
      throw new ValidationError(`Light sleep must be an integer 0..255, received ${minutes}`);
    }
    await this.send(HidCommand.Misc, miscPayload(MiscSubCommand.SetLightSleep, minutes));
    this.infoState.lightSleep = minutes;
  }

  /** Destructive: restores every keyboard setting to firmware defaults. */
  async restoreDefaults(): Promise<void> {
    await this.send(HidCommand.Misc, miscPayload(MiscSubCommand.RestoreDefault));
  }

  // -------------------------------------------------------------- key test

  async startKeyTest(options: { readonly mode?: KeyTestMode } = {}): Promise<void> {
    const mode = options.mode ?? 'stroke';
    const sub =
      mode === 'tap'
        ? MiscSubCommand.HandTestStart
        : MiscSubCommand.StrokeTestStart;
    await this.send(HidCommand.Misc, miscPayload(sub));
    this.keyTestMode = mode;
  }

  async stopKeyTest(): Promise<void> {
    await this.send(HidCommand.Misc, miscPayload(MiscSubCommand.TestEnd, 0xff));
    this.keyTestMode = null;
  }

  /**
   * Stop a running key test, if any, so the firmware returns to normal typing.
   *
   * Returns `true` when a test was actually stopped. Writes never need this on
   * hardware, but a device left in the `cmd 48` stream stops typing until it
   * receives the end command, so callers can be defensive before a write.
   */
  async ensureKeyTestStopped(): Promise<boolean> {
    if (!this.keyTestMode) return false;
    await this.stopKeyTest();
    return true;
  }

  /** Which key-test stream is running (`cmd 2/2`, `cmd 2/3`), or `null`. */
  get activeKeyTest(): KeyTestMode | null {
    return this.keyTestMode;
  }

  // ----------------------------------------------------------------- screen

  /**
   * Open the screen (serial) link. Must be called from a user gesture the first
   * time, because Web Serial prompts for permission.
   */
  async openScreen(options: OpenScreenOptions = {}): Promise<void> {
    this.requireConnected();
    if (!this.productInfo.isScreen) {
      throw new UnsupportedFeatureError(`${this.productInfo.title} has no screen`);
    }
    if (this.screenHandle?.isOpen) return;
    if (options.reuseGrantedPort) {
      // Silent path: reuse a port the user already granted (no gesture needed).
      const handle = this.createScreen(true);
      if (await handle.openGranted()) {
        this.screenHandle = handle;
        return;
      }
    }
    await this.screen.open();
  }

  async closeScreen(): Promise<void> {
    if (this.screenHandle) await this.screenHandle.close();
  }

  // --------------------------------------------------------------- internals

  private createScreen(reuseGrantedPort = false): ZetsuScreen {
    return new ZetsuScreen({
      product: this.productInfo,
      reuseGrantedPort,
      onDisconnect: () => {
        this.events.emit('screen:disconnect', { product: this.productInfo });
      },
    });
  }

  private requireConnected(): void {
    if (!this.connected) throw new NotConnectedError();
  }

  private requireLayout(): KeyLayout {
    const layout = this.layoutState;
    if (!layout || layout.mode === 'unknown') {
      throw new UnknownLayoutError(
        'Key layout is unknown: the device did not report cmd 2/19. Call refreshLayout().',
      );
    }
    return layout;
  }

  /**
   * Read one layer as `hardCode -> HID usage`.
   *
   * Timeout resilience lives in {@link getKeyMap}, which retries a timed-out
   * `cmd 35` read once.
   */
  private async readLayerRemap(layer: 0 | 1 | 2): Promise<Map<number, number>> {
    const map = await this.getKeyMap(layer);
    const usages = new Map<number, number>();
    for (const [hardCode, entry] of map) usages.set(hardCode, entry.hidCode);
    return usages;
  }

  /**
   * Wait for a remap write to commit, read the layer back, and rewrite the keys
   * that did not stick (the firmware sometimes accepts `cmd 35` without applying
   * it while it is busy streaming reports).
   */
  private async verifyRemapWrites(
    layer: 0 | 1 | 2,
    expected: ReadonlyMap<number, number>,
    settleMs: number,
    writeGapMs = 0,
    /** Hard codes whose target equals the key's default usage: an absent entry is success. */
    absentOk?: ReadonlySet<number>,
  ): Promise<{ retried: number[]; failed: number[] }> {
    const wait = settleMs > 0 ? settleMs : 250;
    const mismatched = (
      usages: ReadonlyMap<number, number>,
      hardCode: number,
      usage: number,
    ): boolean => {
      const read = usages.get(hardCode);
      if (read === usage) return false;
      return !(absentOk?.has(hardCode) && read === undefined);
    };
    let usages = await this.readLayerRemap(layer);
    const retry = [...expected.entries()].filter(([hardCode, usage]) =>
      mismatched(usages, hardCode, usage),
    );
    if (retry.length === 0) return { retried: [], failed: [] };
    let first = true;
    for (const [hardCode, usage] of retry) {
      if (first) first = false;
      else if (writeGapMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, writeGapMs));
      await this.send(HidCommand.Remap, remapSetPayload(layer, hardCode, usage));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
    usages = await this.readLayerRemap(layer);
    const failed = retry
      .filter(([hardCode, usage]) => mismatched(usages, hardCode, usage))
      .map(([hardCode]) => hardCode);
    return { retried: retry.map(([hardCode]) => hardCode), failed };
  }

  private commandForFeature(kind: Exclude<FeatureKind, 'none'>): number {
    switch (kind) {
      case 'mt':
        return HidCommand.Mt;
      case 'tgl':
        return HidCommand.Tgl;
      case 'dks':
        return HidCommand.Dks;
      case 'mpt':
        return HidCommand.Mpt;
      case 'end':
        return HidCommand.End;
      case 'socd':
        return HidCommand.Socd;
      case 'rs':
        return HidCommand.Rs;
    }
  }

  private resolveSourceKey(reference: KeyRef): KeyDef {
    const layout = this.requireLayout();
    if (typeof reference === 'number') return this.keyOrThrow(layout, reference, reference);
    if (typeof reference === 'string') {
      const direct =
        layout.byTextCode.get(reference) ?? layout.byTitle.get(reference);
      if (direct) return direct;
      const lower = reference.toLowerCase();
      const relaxed = layout.keys.find(
        (key) =>
          key.textCode.toLowerCase() === lower || key.title.toLowerCase() === lower,
      );
      if (relaxed) return relaxed;
      const numeric = parseKeyNumber(reference);
      if (numeric !== null) return this.keyOrThrow(layout, numeric, reference);
      throw new UnknownKeyError(
        `Unknown key "${reference}" for layout ${layout.mode}.`,
        reference,
      );
    }
    if ('hardCode' in reference) {
      return this.keyOrThrow(layout, reference.hardCode, reference);
    }
    const byText =
      layout.byTextCode.get(reference.textCode) ??
      layout.keys.find(
        (key) => key.textCode.toLowerCase() === reference.textCode.toLowerCase(),
      );
    if (byText) return byText;
    throw new UnknownKeyError(
      `Unknown key "${reference.textCode}" for layout ${layout.mode}.`,
      reference,
    );
  }

  private keyOrThrow(layout: KeyLayout, hardCode: number, reference: unknown): KeyDef {
    const key = layout.byHardCode.get(hardCode);
    if (key) return key;
    const fRowHint = F_ROW_HARD_CODES.has(hardCode)
      ? ` Key 0x${hardCode.toString(16).toUpperCase()} belongs to the F-row module, but the device reported layout ${layout.mode} (F mode ${String(layout.rawFMode)}).`
      : '';
    throw new UnknownKeyError(
      `Unknown key 0x${hardCode.toString(16).toUpperCase()} for layout ${layout.mode}.${fRowHint}`,
      reference,
    );
  }

  private resolveTargetUsage(reference: KeyRef): number {
    if (typeof reference === 'number') {
      if (!Number.isInteger(reference) || reference < 0 || reference > 0xffff) {
        throw new ValidationError(`HID usage must be 0..65535, received ${reference}`);
      }
      // Numbers are HID usages; wrap a layout key when a hard code is meant.
      return reference;
    }
    if (typeof reference === 'string') {
      const catalogEntry = lookupCatalogEntry(reference);
      if (catalogEntry) return catalogEntry.usage;
      const numeric = parseKeyNumber(reference);
      if (numeric !== null) return numeric;
      throw new UnknownKeyError(
        `Unknown target key "${reference}"; pass a key name or a HID usage.`,
        reference,
      );
    }
    if ('hardCode' in reference) {
      const layout = this.requireLayout();
      return this.keyOrThrow(layout, reference.hardCode, reference).hidCode;
    }
    return this.resolveTargetUsage(reference.textCode);
  }

  private applyDeviceInfo(decoded: ReturnType<typeof decodeDeviceInfo>): void {
    if (!decoded) return;
    this.infoState.boardId = decoded.boardId;
    this.infoState.sn = decoded.sn;
    this.infoState.firmwareVersion = decoded.firmwareVersion;
    this.infoState.runMode = decoded.runMode;
    this.infoState.runModeNum = decoded.runModeNum;
  }

  private applyMisc(raw: Uint8Array): void {
    const decoded = decodeMisc(raw);
    if (!decoded) return;
    switch (decoded.kind) {
      case 'winLock':
        this.infoState.winLock = decoded.value;
        break;
      case 'highPrecision':
        this.infoState.highPrecision = decoded.value;
        break;
      case 'pzNum':
        this.infoState.pzNum = decoded.value;
        break;
      case 'lightSleep':
        this.infoState.lightSleep = decoded.value;
        break;
      case 'isLock':
        this.infoState.isLock = decoded.value !== 0;
        break;
      case 'macMode':
        this.infoState.isMac = decoded.value;
        break;
      case 'fMode':
        this.infoState.fMode = decoded.value;
        this.layoutState = makeLayout(
          decoded.value === 79 ? 'extended79' : 'compact65',
          this.productInfo,
          decoded.value,
        );
        break;
    }
  }

  private async reloadLayout(options: ConnectOptions = {}): Promise<KeyLayout> {
    this.requireConnected();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options.retries ?? DEFAULT_RETRIES;
    const frame = await this.mutex.run(() =>
      this.sendWithRetry(
        buildFrame(HidCommand.Misc, miscPayload(MiscSubCommand.GetFMode)),
        HidCommand.Misc,
        MiscSubCommand.GetFMode,
        timeoutMs,
        retries,
      ),
    );
    this.applyMisc(frame);
    return this.requireLayout();
  }

  private handleFrame(raw: Uint8Array): void {
    this.events.emit('input', { frame: raw });
    const pending = this.pending;
    if (pending && pending.matches(raw)) {
      pending.resolve(raw);
      return;
    }
    this.dispatchUnsolicited(raw);
  }

  private dispatchUnsolicited(raw: Uint8Array): void {
    const info = decodeDeviceInfo(raw);
    if (info) {
      this.applyDeviceInfo(info);
      return;
    }
    const misc = decodeMisc(raw);
    if (misc) {
      this.applyMisc(raw);
      return;
    }
    const travel = decodeKeyTravel(raw);
    if (travel) {
      this.emitKeyTravel(travel);
      return;
    }
    const light = decodeLight(raw);
    if (light) {
      this.lightState = light;
      return;
    }
    const colors = decodeKeyColors(raw);
    if (colors) {
      this.keyColorState = colors;
      return;
    }
    const features = decodeFeatureList(raw);
    if (features) {
      this.featureState = features;
      return;
    }
    const travelConfig = decodeTravelConfig(raw);
    if (travelConfig) {
      this.travelState = travelConfig;
    }
  }

  private emitKeyTravel(
    decoded: NonNullable<ReturnType<typeof decodeKeyTravel>>,
  ): void {
    const layout = this.layoutState;
    const resolveKey = (hardCode: number): KeyDef | null =>
      layout?.byHardCode.get(hardCode) ?? null;
    if (decoded.kind === 'release') {
      const event: KeyReleaseEvent = {
        hardCode: decoded.hardCode,
        key: resolveKey(decoded.hardCode),
      };
      this.events.emit('keyRelease', event);
      return;
    }
    if (decoded.kind === 'single') {
      const event: KeyTravelEvent = {
        hardCode: decoded.hardCode,
        key: resolveKey(decoded.hardCode),
        mm: decoded.mm,
      };
      this.events.emit('keyTravel', event);
      return;
    }
    for (const entry of decoded.entries) {
      const event: KeyTravelEvent = {
        hardCode: entry.hardCode,
        key: resolveKey(entry.hardCode),
        mm: entry.mm,
        adc: entry.adc,
      };
      this.events.emit('keyTravel', event);
    }
  }

  private handleDeviceDisconnect(): void {
    this.connected = false;
    this.keyTestMode = null;
    this.rejectPending(new NotConnectedError('The keyboard was disconnected'));
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    const screen = this.screenHandle;
    if (screen) {
      void screen.close().catch(() => undefined);
    }
    this.events.emit('disconnect', { product: this.productInfo });
  }

  private rejectPending(error: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.reject(error);
  }

  private send(command: number, payload: readonly number[]): Promise<void> {
    this.requireConnected();
    const frame = buildFrame(command, payload);
    return this.mutex.run(() => this.transport.send(frame));
  }

  private async request(
    command: number,
    payload: readonly number[],
    subCommand: number | null = null,
    options: ConnectOptions = {},
  ): Promise<Uint8Array> {
    this.requireConnected();
    const frame = buildFrame(command, payload);
    return this.mutex.run(() =>
      this.sendWithRetry(
        frame,
        command,
        subCommand,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.retries ?? DEFAULT_RETRIES,
      ),
    );
  }

  /**
   * Send one request and collect every response for `command` until the device
   * goes quiet.
   *
   * Several reads are streamed in chunks (key map: 4 reports, feature list: 3,
   * per-key colours and travel config likewise), so taking only the first
   * report would silently return a partial configuration.
   *
   * `idleMs` measures silence *between* frames of a series; the wait for the
   * first frame is bounded by `maxMs` alone. The device can stay busy well
   * past `idleMs` before it answers (e.g. a driver page issuing its own
   * exchanges on a shared handle), and cutting the first frame off at
   * `idleMs` turned into spurious `cmd 35` read timeouts.
   */
  private async requestSeries(
    command: number,
    payload: readonly number[],
    options: { readonly idleMs?: number; readonly maxMs?: number; readonly maxFrames?: number } = {},
  ): Promise<Uint8Array[]> {
    this.requireConnected();
    const frame = buildFrame(command, payload);
    const idleMs = options.idleMs ?? 90;
    const maxMs = options.maxMs ?? 1500;
    const maxFrames = options.maxFrames ?? 40;
    return this.mutex.run(() =>
      this.sendAndCollect(frame, command, idleMs, maxMs, maxFrames),
    );
  }

  private sendAndCollect(
    frame: Uint8Array,
    command: number,
    idleMs: number,
    maxMs: number,
    maxFrames: number,
  ): Promise<Uint8Array[]> {
    return new Promise<Uint8Array[]>((resolve, reject) => {
      const frames: Uint8Array[] = [];
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const overallTimer = setTimeout(() => {
        finishError(new TimeoutError(`Timed out waiting for command ${command}`, { command }));
      }, maxMs);
      const clearTimers = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(overallTimer);
      };
      const finishOk = (): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (this.pending && this.pending.reject === reject) this.pending = null;
        resolve(frames);
      };
      const finishError = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (this.pending && this.pending.reject === reject) this.pending = null;
        reject(error);
      };
      // Only armed once frames have arrived: it ends the series after a quiet
      // gap, it is not the deadline for the first frame.
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finishOk, idleMs);
      };
      this.pending = {
        matches: (raw) =>
          raw.length >= 6 && raw[0] === 0xab && raw[2] === command,
        resolve: (raw) => {
          frames.push(raw.slice());
          if (frames.length >= maxFrames) finishOk();
          else armIdle();
        },
        reject: finishError,
      };
      this.transport.send(frame).catch(finishError);
    });
  }

  private async sendWithRetry(
    frame: Uint8Array,
    command: number,
    subCommand: number | null,
    timeoutMs: number,
    retries: number,
  ): Promise<Uint8Array> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.sendAndWait(frame, command, subCommand, timeoutMs);
      } catch (error) {
        lastError = error;
        if (!(error instanceof TimeoutError) || attempt === retries) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new TimeoutError(`Timed out waiting for command ${command}`, {
          command,
          subCommand,
        });
  }

  private sendAndWait(
    frame: Uint8Array,
    command: number,
    subCommand: number | null,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.pending && this.pending.reject === reject) this.pending = null;
        action();
      };
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new TimeoutError(
              `Timed out waiting for command ${command}${
                subCommand === null ? '' : `/${subCommand}`
              }`,
              { command, subCommand },
            ),
          ),
        );
      }, timeoutMs);
      this.pending = {
        matches: (raw) =>
          raw.length >= 6 &&
          raw[0] === 0xab &&
          raw[2] === command &&
          (subCommand === null || raw[5] === subCommand),
        resolve: (raw) => finish(() => resolve(raw)),
        reject,
      };
      this.transport.send(frame).catch((error: unknown) => {
        finish(() =>
          reject(
            error instanceof ZmeowError
              ? error
              : new TransportError('Failed to send report', { cause: error }),
          ),
        );
      });
    });
  }
}
