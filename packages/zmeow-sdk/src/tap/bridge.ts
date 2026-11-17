/**
 * High-level driver bridge: installs the HID/Serial taps and optionally opens
 * an active connection on top of the same handles.
 *
 * Typical userscript usage:
 *
 * ```ts
 * const tap = await ZetsuTap.install();
 * tap.on('status', renderStatus);
 * // active connection only when the user asks for it:
 * await tap.connectKeyboard();
 * ```
 *
 * The bridge is deliberately conservative: tap-only traffic never opens or
 * closes a device, and active clients created on top of a tapped handle use a
 * transport whose `close()` is a no-op.
 */

import { Emitter } from '../emitter.ts';
import { UnsupportedError, ValidationError } from '../errors.ts';
import { ZETSU63_PRODUCT } from '../generated/product-zetsu63.ts';
import { decodeDeviceInfo, decodeMisc } from '../protocol/response.ts';
import { HidCommand, MiscSubCommand } from '../protocol/commands.ts';
import { ZetsuKeyboard } from '../keyboard.ts';
import type { ConnectOptions } from '../keyboard.ts';
import { ZetsuScreen } from '../screen.ts';
import type { ZetsuScreenOptions } from '../screen.ts';
import {
  getHidApi,
  getGrantedHidDevices,
} from '../transport/webhid.ts';
import { getSerialApi } from '../transport/webserial.ts';
import type { Transport } from '../transport/types.ts';
import type { HidDeviceLike, SerialPortLike } from '../transport/types.ts';
import type { ProductInfo } from '../types.ts';
import { HidTap } from './hid-tap.ts';
import { SerialTap } from './serial-tap.ts';
import {
  KNOWN_FIRMWARE_VERSIONS,
  fingerprintDriverAssets,
  makeFingerprint,
  productRecordMatches,
  readProductRecord,
} from './fingerprint.ts';
import type { AssetFingerprintResult } from './fingerprint.ts';
import type {
  TapAdapter,
  TapEvents,
  TapFrame,
  TapHooks,
  TapState,
  TapStatus,
  ZetsuTapOptions,
} from './types.ts';

const REPORT_SIZE = 64;

interface DriverDataLike {
  readonly keys_product_list?: readonly unknown[];
  readonly select_product_list?: readonly HidDeviceLike[];
  readonly serial_port?: SerialPortLike | null;
}

class TapHidTransport implements Transport {
  readonly kind = 'hid' as const;
  private readonly tap: HidTap;

  constructor(tap: HidTap) {
    this.tap = tap;
  }

  get isOpen(): boolean {
    return this.tap.isInstalled;
  }

  async open(): Promise<void> {
    // The tapped device is already open and owned by the page.
  }

  async close(): Promise<void> {
    // Never close a handle owned by the page.
  }

  async send(frame: Uint8Array): Promise<void> {
    if (frame.length !== REPORT_SIZE) {
      throw new ValidationError(`Expected a ${REPORT_SIZE}-byte frame, got ${frame.length}`);
    }
    await this.tap.sendTapped(frame);
  }

  subscribe(listener: (frame: Uint8Array) => void): () => void {
    return this.tap.subscribe(listener);
  }
}

export interface ActiveScreenOptions extends Partial<ZetsuScreenOptions> {
  /** Reuse the page's already-open serial port when available. Defaults to true. */
  readonly reusePagePort?: boolean;
}

/**
 * One page-level bridge. Create it with {@link ZetsuTap.install}.
 */
export class ZetsuTap {
  private readonly options: ZetsuTapOptions;
  private readonly product: ProductInfo;
  private readonly mode: 'tap' | 'active' | 'both';
  private readonly emitter = new Emitter<TapEvents>();
  private readonly userHooks: TapHooks;
  private readonly adapter: TapAdapter | undefined;

  private hidTap: HidTap | null = null;
  private serialTap: SerialTap | null = null;
  private hidError: Error | null = null;
  private serialError: Error | null = null;
  private installed = false;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private fingerprintScheduled = false;
  private fingerprintPromise: Promise<TapStatus> | null = null;
  private productTableSeen = false;

  private assets: AssetFingerprintResult = {
    indexHash: null,
    hidHash: null,
    screenHash: null,
    checked: false,
    hashKnown: true,
    reasons: [],
  };
  private productOk = true;
  private protocolOk = true;
  private firmwareVersion: string | null = null;
  private adapterActive = false;

  private activeKeyboard: ZetsuKeyboard | null = null;
  private activeScreen: ZetsuScreen | null = null;

  private constructor(options: ZetsuTapOptions) {
    this.options = options;
    this.product = options.product ?? ZETSU63_PRODUCT;
    this.mode = options.mode ?? 'both';
    this.userHooks = options.hooks ?? {};
    this.adapter = options.adapter;
  }

  /** Install the page taps and return the bridge. */
  static async install(options: ZetsuTapOptions = {}): Promise<ZetsuTap> {
    const tap = new ZetsuTap(options);
    await tap.start();
    return tap;
  }

  get status(): TapStatus {
    const fingerprint = makeFingerprint({
      assets: this.assets,
      productOk: this.productOk,
      firmwareVersion: this.firmwareVersion,
      protocolOk: this.protocolOk,
      extraReasons: [
        ...(this.hidError ? [`HID tap unavailable: ${this.hidError.message}`] : []),
        ...(this.serialError
          ? [`Serial tap unavailable: ${this.serialError.message}`]
          : []),
      ],
    });
    const state = this.computeState(fingerprint);
    return {
      state,
      mode: this.mode,
      fingerprint,
      hid: {
        attached: this.hidTap?.isInstalled ?? false,
        connected: this.hidTap?.isConnected ?? false,
        device: this.hidTap?.device ?? null,
      },
      serial: {
        attached: this.serialTap?.isInstalled ?? false,
        connected: this.serialTap?.isConnected ?? false,
        port: this.serialTap?.port ?? null,
      },
      frames: {
        hidOut: this.hidTap?.counts.out ?? 0,
        hidIn: this.hidTap?.counts.in ?? 0,
        serialOut: this.serialTap?.counts.out ?? 0,
        serialIn: this.serialTap?.counts.in ?? 0,
      },
      adapterId: this.adapterActive ? (this.adapter?.id ?? null) : null,
      reasons: fingerprint.reasons,
    };
  }

  get isInstalled(): boolean {
    return this.installed;
  }

  get productInfo(): ProductInfo {
    return this.product;
  }

  on<K extends keyof TapEvents>(event: K, listener: (payload: TapEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  once<K extends keyof TapEvents>(event: K, listener: (payload: TapEvents[K]) => void): () => void {
    return this.emitter.once(event, listener);
  }

  off<K extends keyof TapEvents>(event: K, listener: (payload: TapEvents[K]) => void): void {
    this.emitter.off(event, listener);
  }

  /** Register a device discovered outside the page globals (tests, custom hosts). */
  captureDevice(device: HidDeviceLike): void {
    this.hidTap?.captureDevice(device);
    this.publishStatus();
  }

  /** Register a port discovered outside the page globals. */
  capturePort(port: SerialPortLike): void {
    this.serialTap?.capturePort(port);
    this.publishStatus();
  }

  /** Replace user hooks without reinstalling the taps. */
  setHooks(hooks: TapHooks): void {
    Object.assign(this.userHooks, hooks);
    this.hidTap?.setHooks(this.buildHooks());
    this.serialTap?.setHooks(this.buildHooks());
    this.publishStatus();
  }

  /** Re-read the product table and hash the driver assets. */
  refreshFingerprint(): Promise<TapStatus> {
    if (this.fingerprintPromise) return this.fingerprintPromise;
    const pending = this.runFingerprint().finally(() => {
      this.fingerprintPromise = null;
    });
    this.fingerprintPromise = pending;
    return pending;
  }

  private async runFingerprint(): Promise<TapStatus> {
    const environment = this.options.environment;
    // `window.data` lives on the host page's window, not on the sandbox's own
    // globalThis (see captureFromPage).
    const globalObject: unknown =
      environment?.window ?? (globalThis as { data?: { keys_product_list?: unknown } });
    const data = (globalObject as { data?: { keys_product_list?: unknown } }).data;
    const hasProductTable =
      Array.isArray(data?.keys_product_list) && data.keys_product_list.length > 0;
    if (hasProductTable) this.productTableSeen = true;
    const record = readProductRecord(globalObject, this.product.id);
    this.productOk = hasProductTable ? productRecordMatches(record, this.product) : true;

    try {
      this.assets = await fingerprintDriverAssets(
        environment?.document ?? (globalThis as { document?: Document }).document ?? null,
        environment?.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch ?? null,
        environment?.crypto ?? (globalThis as { crypto?: Crypto }).crypto ?? null,
      );
    } catch (error) {
      this.assets = {
        indexHash: null,
        hidHash: null,
        screenHash: null,
        checked: false,
        hashKnown: true,
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    }
    this.refreshAdapter();
    this.publishStatus();
    return this.status;
  }

  private scheduleFingerprint(): void {
    if (this.options.autoFingerprint === false || this.fingerprintScheduled) return;
    this.fingerprintScheduled = true;
    const run = (): void => {
      this.fingerprintScheduled = false;
      void this.refreshFingerprint();
    };
    const doc = this.options.environment?.document ?? (globalThis as { document?: Document }).document;
    if (doc && doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      setTimeout(run, 0);
    }
  }

  /**
   * Open an active keyboard connection.
   *
   * If the page already has a matching HID handle open, the returned client
   * shares it and its `close()` is a no-op. Otherwise the normal WebHID chooser
   * is used (call from a user gesture).
   */
  async connectKeyboard(options: ConnectOptions = {}): Promise<ZetsuKeyboard> {
    this.assertActiveAllowed();
    if (this.activeKeyboard?.isConnected) return this.activeKeyboard;

    const captured = this.hidTap?.device;
    if (captured?.opened && this.hidTap?.isInstalled) {
      const keyboard = new ZetsuKeyboard(captured, this.product, {
        transport: new TapHidTransport(this.hidTap),
      });
      await keyboard.connect(options);
      this.activeKeyboard = keyboard;
      this.publishStatus();
      return keyboard;
    }

    const keyboard = await ZetsuKeyboard.requestDevice({
      vendorId: this.product.vid,
      productId: this.product.pid,
    });
    await keyboard.connect(options);
    this.activeKeyboard = keyboard;
    if (this.hidTap && keyboard.deviceHandle) {
      this.hidTap.captureDevice(keyboard.deviceHandle);
    }
    this.publishStatus();
    return keyboard;
  }

  /** Open an active screen connection, reusing the page's port when possible. */
  async connectScreen(options: ActiveScreenOptions = {}): Promise<ZetsuScreen> {
    this.assertActiveAllowed();
    if (this.activeScreen?.isOpen) return this.activeScreen;

    const { reusePagePort, ...screenRest } = options;
    const reuse = reusePagePort !== false;
    const captured = reuse ? this.serialTap?.port : null;
    const screenOptions: ZetsuScreenOptions = {
      product: this.product,
      ...(captured
        ? {
            port: this.serialTap!.createPortFacade(captured),
            openPort: false,
          }
        : {}),
      ...screenRest,
    };

    const screen = new ZetsuScreen(screenOptions);
    await screen.open();
    this.activeScreen = screen;
    this.publishStatus();
    return screen;
  }

  /** Close only the active clients; page taps and page handles stay intact. */
  async disconnect(): Promise<void> {
    const keyboard = this.activeKeyboard;
    const screen = this.activeScreen;
    this.activeKeyboard = null;
    this.activeScreen = null;
    if (keyboard) {
      try {
        await keyboard.disconnect();
      } catch {
        // Best effort: the page still owns the handle.
      }
    }
    if (screen) {
      try {
        await screen.close();
      } catch {
        // Best effort: an external port is never closed.
      }
    }
    this.publishStatus();
  }

  /** Restore prototypes and close active clients. */
  async stop(): Promise<void> {
    if (!this.installed) return;
    if (this.captureTimer !== null) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    await this.disconnect();
    this.hidTap?.stop();
    this.serialTap?.stop();
    this.hidTap = null;
    this.serialTap = null;
    this.installed = false;
    this.publishStatus();
  }

  private async start(): Promise<void> {
    if (this.installed) return;
    const environment = this.options.environment;
    const hid = environment?.hid ?? getHidApi();
    const serial = environment?.serial ?? getSerialApi();
    const hidCtor =
      environment?.hidDevice ??
      (globalThis as { HIDDevice?: { prototype: HidDeviceLike } }).HIDDevice ??
      null;
    const serialCtor =
      environment?.serialPort ??
      (globalThis as { SerialPort?: { prototype: SerialPortLike } }).SerialPort ??
      null;

    if (hidCtor) {
      this.hidTap = new HidTap({
        product: this.product,
        hooks: this.buildHooks(),
        hid,
        deviceCtor: hidCtor,
        onChange: () => this.publishStatus(),
        onError: (error) => this.emitter.emit('error', error),
      });
      try {
        this.hidTap.install();
        this.hidTap.onFrame((frame) => this.handleFrame(frame));
      } catch (error) {
        this.hidError = error instanceof Error ? error : new Error(String(error));
      }
    } else {
      this.hidError = new UnsupportedError('WebHID is not available in this browser');
    }

    if (serialCtor) {
      this.serialTap = new SerialTap({
        product: { vid: this.product.vid, pidScreen: this.product.pidScreen },
        hooks: this.buildHooks(),
        serial,
        portCtor: serialCtor,
        onChange: () => this.publishStatus(),
        onError: (error) => this.emitter.emit('error', error),
      });
      try {
        this.serialTap.install();
        this.serialTap.onFrame((frame) => this.handleFrame(frame));
      } catch (error) {
        this.serialError = error instanceof Error ? error : new Error(String(error));
      }
    } else {
      this.serialError = new UnsupportedError('Web Serial is not available in this browser');
    }

    this.installed = (this.hidTap?.isInstalled ?? false) || (this.serialTap?.isInstalled ?? false);
    this.refreshAdapter();
    this.captureFromPage();
    if (this.installed) {
      this.captureTimer = setInterval(() => this.captureFromPage(), 1000);
    }

    if (this.options.autoFingerprint !== false) {
      this.scheduleFingerprint();
    } else {
      this.publishStatus();
    }
  }

  private buildHooks(): TapHooks {
    const adapterHooks = this.adapterActive ? this.adapter?.hooks : undefined;
    return {
      onHidOut: this.userHooks.onHidOut?.bind(this.userHooks) ?? adapterHooks?.onHidOut,
      onHidIn: this.userHooks.onHidIn?.bind(this.userHooks) ?? adapterHooks?.onHidIn,
      onSerialOut:
        this.userHooks.onSerialOut?.bind(this.userHooks) ?? adapterHooks?.onSerialOut,
      onSerialIn: this.userHooks.onSerialIn?.bind(this.userHooks) ?? adapterHooks?.onSerialIn,
    };
  }

  private refreshAdapter(): void {
    const adapter = this.adapter;
    if (!adapter) {
      this.adapterActive = false;
      return;
    }
    if (!adapter.allowUnknownHashes) {
      if (
        adapter.hidHashes &&
        adapter.hidHashes.length > 0 &&
        this.assets.hidHash !== null &&
        !adapter.hidHashes.includes(this.assets.hidHash)
      ) {
        this.adapterActive = false;
        this.applyAdapterHooks();
        return;
      }
      if (
        adapter.screenHashes &&
        adapter.screenHashes.length > 0 &&
        this.assets.screenHash !== null &&
        !adapter.screenHashes.includes(this.assets.screenHash)
      ) {
        this.adapterActive = false;
        this.applyAdapterHooks();
        return;
      }
    }
    if (
      adapter.firmwareVersions &&
      adapter.firmwareVersions.length > 0 &&
      this.firmwareVersion !== null &&
      !adapter.firmwareVersions.includes(this.firmwareVersion)
    ) {
      this.adapterActive = false;
      this.applyAdapterHooks();
      return;
    }
    this.adapterActive = true;
    this.applyAdapterHooks();
  }

  private applyAdapterHooks(): void {
    this.hidTap?.setHooks(this.buildHooks());
    this.serialTap?.setHooks(this.buildHooks());
  }

  private computeState(fingerprint: ReturnType<typeof makeFingerprint>): TapState {
    if (!this.installed) return 'disabled';
    if (!this.hidTap?.isInstalled && !this.serialTap?.isInstalled) return 'disabled';
    if (!fingerprint.productOk || !fingerprint.protocolOk) return 'disabled';
    if (fingerprint.checked && !fingerprint.hashKnown && !this.adapterActive) {
      return 'readonly';
    }
    if (
      fingerprint.firmwareVersion !== null &&
      !KNOWN_FIRMWARE_VERSIONS.includes(fingerprint.firmwareVersion) &&
      !this.adapterActive
    ) {
      return 'readonly';
    }
    return this.hidTap?.isConnected || this.serialTap?.isConnected || this.activeKeyboard
      ? 'active'
      : 'idle';
  }

  private handleFrame(frame: TapFrame): void {
    if (frame.kind === 'hid' && frame.direction === 'in') {
      if (frame.frame.command === HidCommand.DeviceInfo) {
        const info = decodeDeviceInfo(frame.frame.bytes);
        if (!info) {
          this.protocolOk = false;
        } else {
          this.firmwareVersion = info.firmwareVersion;
          this.refreshAdapter();
        }
      } else if (frame.frame.command === HidCommand.Misc) {
        const subCommand = frame.frame.bytes[5] ?? 0;
        if (subCommand === MiscSubCommand.GetFMode && !decodeMisc(frame.frame.bytes)) {
          this.protocolOk = false;
        }
      }
    }
    this.emitter.emit('frame', frame);
    this.publishStatus();
  }

  private captureFromPage(): void {
    // Read `window.data` from the HOST page's window: in a Tampermonkey
    // sandbox the bridge's own globalThis is the isolated world, where the
    // driver page's globals are invisible.
    const pageWindow =
      this.options.environment?.window ?? (globalThis as { data?: DriverDataLike });
    const data = (pageWindow as { data?: DriverDataLike }).data;
    if (!data) return;

    const devices = data.select_product_list;
    if (Array.isArray(devices)) {
      for (const device of devices) {
        if (
          device &&
          device.vendorId === this.product.vid &&
          device.productId === this.product.pid
        ) {
          this.hidTap?.captureDevice(device);
          break;
        }
      }
    }

    const port = data.serial_port;
    if (port) this.serialTap?.capturePort(port);

    if (!this.productTableSeen && Array.isArray(data.keys_product_list)) {
      void this.refreshFingerprint();
    }
  }

  private publishStatus(): void {
    try {
      this.emitter.emit('status', this.status);
    } catch (error) {
      this.emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private assertActiveAllowed(): void {
    if (this.mode === 'tap') {
      throw new UnsupportedError(
        'This ZetsuTap was created in tap-only mode; construct it with mode "both" for active connections',
      );
    }
  }
}

/** Convenience helper mirroring `ZetsuTap.install()`. */
export function installZetsuTap(options: ZetsuTapOptions = {}): Promise<ZetsuTap> {
  return ZetsuTap.install(options);
}

/** Read granted HID devices without prompting; useful for active-button gating. */
export async function listGrantedKeyboards(product: ProductInfo = ZETSU63_PRODUCT) {
  const devices = await getGrantedHidDevices();
  return devices.filter(
    (device) => device.vendorId === product.vid && device.productId === product.pid,
  );
}
