/**
 * WebHID test doubles.
 *
 * `FakeHidDevice` implements {@link HidDeviceLike} with in-memory event
 * dispatch, so transport tests and consumer tests can run under plain Node.
 */

import type {
  HidCollectionInfo,
  HidConnectionEvent,
  HidDeviceFilter,
  HidDeviceLike,
  HidInputReportEvent,
  HidLike,
} from '../transport/types.ts';

const INPUT_REPORT_EVENT = 'inputreport';
const DISCONNECT_EVENT = 'disconnect';

/** Configuration for {@link FakeHidDevice}; every field has a default. */
export interface FakeHidDeviceOptions {
  readonly vendorId?: number;
  readonly productId?: number;
  readonly productName?: string;
  readonly collections?: readonly HidCollectionInfo[];
  /** Initial `opened` flag. Defaults to `false`. */
  readonly opened?: boolean;
  /** When set, `open()` rejects with this value. */
  readonly openError?: unknown;
  /** When set, `close()` rejects with this value. */
  readonly closeError?: unknown;
  /** When set, `sendReport()` rejects with this value (and records nothing). */
  readonly sendError?: unknown;
  /** Called after a report is accepted; useful for scripted device replies. */
  readonly onSend?: (data: Uint8Array, device: FakeHidDevice) => void;
}

/** One recorded `FakeHid.requestDevice` call. */
export interface FakeHidRequest {
  readonly filters: readonly HidDeviceFilter[];
}

/** Configuration for {@link FakeHid}. */
export interface FakeHidOptions {
  /** Devices returned by `getDevices()`. */
  readonly devices?: Iterable<FakeHidDevice>;
  /**
   * Devices returned by `requestDevice()`. Defaults to `devices`; pass `[]` to
   * simulate a cancelled chooser.
   */
  readonly requestDevices?: readonly FakeHidDevice[];
  /** When set, `requestDevice()` rejects with this value (e.g. a DOMException). */
  readonly requestError?: unknown;
  /** When set, `getDevices()` rejects with this value. */
  readonly getDevicesError?: unknown;
}

/**
 * Minimal `HIDDevice` stand-in.
 *
 * `open()`/`close()` are idempotent and count their invocations; `sendReport()`
 * stores a copy of every report. Errors configured through the constructor (or
 * assigned later) take precedence over the normal behaviour.
 */
export class FakeHidDevice implements HidDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: readonly HidCollectionInfo[];

  /** Copies of every report accepted by `sendReport()`. */
  readonly sent: Uint8Array[] = [];

  opened: boolean;
  openCalls = 0;
  closeCalls = 0;
  forgetCalls = 0;
  private inputHandler: ((event: unknown) => void) | null = null;

  /** Mirrors the WebHID event-handler attribute used by the official driver. */
  get oninputreport(): ((event: unknown) => void) | null {
    return this.inputHandler;
  }

  set oninputreport(value: ((event: unknown) => void) | null) {
    this.inputHandler = value;
  }

  /** Mutable so a single test can flip the failure on and off. */
  openError: unknown;
  closeError: unknown;
  sendError: unknown;
  private readonly onSend: ((data: Uint8Array, device: FakeHidDevice) => void) | null;

  private readonly eventListeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(options: FakeHidDeviceOptions = {}) {
    this.vendorId = options.vendorId ?? 0x372d;
    this.productId = options.productId ?? 0x0001;
    this.productName = options.productName ?? 'Fake ZetsuMeow';
    this.collections = options.collections
      ? [...options.collections]
      : [{ usagePage: 0x01, usage: 0x06, type: 1 }];
    this.opened = options.opened ?? false;
    this.openError = options.openError;
    this.closeError = options.closeError;
    this.sendError = options.sendError;
    this.onSend = options.onSend ?? null;
  }

  async open(): Promise<void> {
    this.openCalls += 1;
    if (this.openError !== undefined) throw this.openError;
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError !== undefined) throw this.closeError;
    this.opened = false;
  }

  async sendReport(reportId: number, data: Uint8Array): Promise<void> {
    if (this.sendError !== undefined) throw this.sendError;
    const copy = data.slice();
    this.sent.push(copy);
    void reportId;
    this.onSend?.(copy, this);
  }

  /** Present to prove the SDK never calls it (OS-level pairing reset). */
  async forget(): Promise<void> {
    this.forgetCalls += 1;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.eventListeners.get(type);
    if (!set) {
      set = new Set();
      this.eventListeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.eventListeners.get(type)?.delete(listener);
  }

  /** Number of listeners registered for `type` (assertion helper). */
  listenerCount(type: string): number {
    return this.eventListeners.get(type)?.size ?? 0;
  }

  /** Simulate a device report; `bytes` are wrapped in a fresh `DataView` event. */
  emitInputReport(bytes: Uint8Array | ArrayBuffer | DataView): void {
    const event: HidInputReportEvent = {
      data: toDataView(bytes),
      reportId: 0,
      device: this,
    };
    this.oninputreport?.(event);
    this.dispatch(INPUT_REPORT_EVENT, event);
  }

  /** Simulate a USB unplug: the device closes itself before notifying listeners. */
  emitDisconnect(): void {
    this.opened = false;
    const event: HidConnectionEvent = { device: this };
    this.dispatch(DISCONNECT_EVENT, event);
  }

  /** Dispatch an arbitrary event to the registered listeners (edge-case tests). */
  dispatch(type: string, event: unknown): void {
    const set = this.eventListeners.get(type);
    if (!set) return;
    for (const listener of [...set]) listener(event);
  }
}

/**
 * Minimal `navigator.hid` stand-in.
 *
 * `devices` is the enumeration result; `requestDevices` is what the chooser
 * "returns" (defaults to `devices`; empty simulates cancellation). Both call
 * sites and their arguments are recorded.
 */
export class FakeHid implements HidLike {
  readonly devices: FakeHidDevice[];
  requestDevices: readonly FakeHidDevice[];
  requestError: unknown;
  getDevicesError: unknown;

  /** Every `requestDevice()` call, in order. */
  readonly requests: FakeHidRequest[] = [];
  getDevicesCalls = 0;

  private readonly eventListeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(options: FakeHidOptions = {}) {
    this.devices = options.devices ? [...options.devices] : [];
    this.requestDevices = options.requestDevices ? [...options.requestDevices] : this.devices;
    this.requestError = options.requestError;
    this.getDevicesError = options.getDevicesError;
  }

  async getDevices(): Promise<HidDeviceLike[]> {
    this.getDevicesCalls += 1;
    if (this.getDevicesError !== undefined) throw this.getDevicesError;
    return [...this.devices];
  }

  async requestDevice(options: { filters: readonly HidDeviceFilter[] }): Promise<HidDeviceLike[]> {
    this.requests.push({ filters: [...options.filters] });
    if (this.requestError !== undefined) throw this.requestError;
    return [...this.requestDevices];
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.eventListeners.get(type);
    if (!set) {
      set = new Set();
      this.eventListeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.eventListeners.get(type)?.delete(listener);
  }
}

/** Convenience factory mirroring the object-literal style used in tests. */
export function makeFakeDevice(options: FakeHidDeviceOptions = {}): FakeHidDevice {
  return new FakeHidDevice(options);
}

function toDataView(bytes: Uint8Array | ArrayBuffer | DataView): DataView {
  if (bytes instanceof ArrayBuffer) return new DataView(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new TypeError('Unsupported input report payload');
}
