/**
 * Passive/rewriting WebHID tap.
 *
 * Installs wrappers on `HIDDevice.prototype` so every page that calls
 * `sendReport()` / assigns `oninputreport` is observed without handing the SDK
 * a second device handle. The wrappers can rewrite or drop frames, but they
 * never call `open()`, `close()` or `forget()` themselves.
 */

import { NotConnectedError, UnsupportedError, ValidationError } from '../errors.ts';
import { parseFrame } from '../protocol/frame.ts';
import type { ParsedFrame } from '../protocol/frame.ts';
import type { HidDeviceLike, HidLike } from '../transport/types.ts';
import type { HidTapFrame, TapDecision, TapHooks } from './types.ts';
import type { HidDeviceConstructorLike } from './types.ts';

const REPORT_SIZE = 64;
const INPUT_EVENT = 'inputreport';

export interface HidTapOptions {
  readonly product: {
    readonly vid: number;
    readonly pid: number;
  };
  readonly hooks?: TapHooks;
  readonly hid?: HidLike | null;
  readonly deviceCtor?: HidDeviceConstructorLike | null;
  readonly onChange?: () => void;
  readonly onError?: (error: Error) => void;
}

interface OriginalDescriptors {
  sendReport: PropertyDescriptor;
  open: PropertyDescriptor;
  close: PropertyDescriptor;
  oninputreport?: PropertyDescriptor;
}

interface HidPrototype {
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  open(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
}

/**
 * Copy bytes regardless of the value's realm: a page-world TypedArray/DataView
 * is not `instanceof` this realm's `Uint8Array` when the tap runs in an
 * isolated userscript world, but the internal buffer slot is still readable
 * (`ArrayBuffer.isView` checks the slot, not the prototype chain).
 */
function copyBytes(data: unknown): Uint8Array | null {
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return null;
}

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * HID tap for one product.
 *
 * Call {@link install} once per page; {@link stop} restores the prototypes and
 * makes any still-attached page handler pass through untouched.
 */
export class HidTap {
  private readonly product: HidTapOptions['product'];
  private readonly options: HidTapOptions;
  private readonly inputListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly frameListeners = new Set<(frame: HidTapFrame) => void>();
  private readonly listenerWrappers = new WeakMap<HidDeviceLike, Map<Function, Function>>();
  private readonly eventDecisions = new WeakMap<object, TapDecision>();
  private readonly processedEvents = new WeakSet<object>();
  private readonly observedDevices = new WeakSet<HidDeviceLike>();
  private readonly instancePatches: Array<{
    readonly device: HidDeviceLike;
    readonly add: PropertyDescriptor | undefined;
    readonly remove: PropertyDescriptor | undefined;
    readonly nativeAdd: Function;
    readonly nativeRemove: Function | null;
    readonly listener: (event: unknown) => void;
    readonly restoreAdd: boolean;
    readonly restoreRemove: boolean;
  }> = [];

  private hooks: TapHooks;
  private originals: OriginalDescriptors | null = null;
  private proto: HidPrototype | null = null;
  private currentDevice: HidDeviceLike | null = null;
  private connected = false;
  private installed = false;
  private counters = { out: 0, in: 0 };
  private hidApi: HidLike | null = null;

  constructor(options: HidTapOptions) {
    this.options = options;
    this.product = options.product;
    this.hooks = options.hooks ?? {};
    this.hidApi = options.hid ?? null;
  }

  get device(): HidDeviceLike | null {
    return this.currentDevice;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get isInstalled(): boolean {
    return this.installed;
  }

  get counts(): { readonly out: number; readonly in: number } {
    return { ...this.counters };
  }

  get hid(): HidLike | null {
    return this.hidApi;
  }

  setHooks(hooks: TapHooks): void {
    this.hooks = hooks;
  }

  /** Install the WebHID wrappers. Idempotent. */
  install(): this {
    if (this.installed) return this;

    const ctor =
      this.options.deviceCtor ??
      (globalThis as { HIDDevice?: HidDeviceConstructorLike }).HIDDevice ??
      null;
    if (!ctor?.prototype) {
      throw new UnsupportedError(
        'WebHID is unavailable: HIDDevice is missing. Use Chromium over HTTPS or localhost.',
      );
    }
    const proto = ctor.prototype as unknown as HidPrototype;
    const sendReport = Object.getOwnPropertyDescriptor(proto, 'sendReport');
    const open = Object.getOwnPropertyDescriptor(proto, 'open');
    const close = Object.getOwnPropertyDescriptor(proto, 'close');
    if (!sendReport || !open || !close) {
      throw new UnsupportedError('HIDDevice.prototype is missing required methods');
    }

    this.proto = proto;
    this.originals = {
      sendReport,
      open,
      close,
      oninputreport: Object.getOwnPropertyDescriptor(proto, 'oninputreport'),
    };

    const tap = this;

    Object.defineProperty(proto, 'sendReport', {
      ...sendReport,
      value: function (this: HidDeviceLike, reportId: number, data: Uint8Array): Promise<void> {
        return tap.sendReport(this, reportId, data);
      },
    });

    Object.defineProperty(proto, 'open', {
      ...open,
      value: async function (this: HidDeviceLike): Promise<void> {
        const result = await (open.value as () => Promise<void>).call(this);
        if (tap.matches(this)) {
          tap.currentDevice = this;
          tap.connected = this.opened;
          tap.observe(this);
          tap.options.onChange?.();
        }
        return result;
      },
    });

    Object.defineProperty(proto, 'close', {
      ...close,
      value: async function (this: HidDeviceLike): Promise<void> {
        try {
          return await (close.value as () => Promise<void>).call(this);
        } finally {
          if (tap.matches(this) && tap.currentDevice === this) {
            tap.connected = false;
            tap.options.onChange?.();
          }
        }
      },
    });

    const inputDescriptor = this.originals.oninputreport;
    if (inputDescriptor?.set) {
      Object.defineProperty(proto, 'oninputreport', {
        configurable: true,
        enumerable: inputDescriptor.enumerable,
        get: inputDescriptor.get
          ? function (this: HidDeviceLike) {
              return inputDescriptor.get!.call(this);
            }
          : undefined,
        set: function (this: HidDeviceLike, handler: unknown) {
          if (typeof handler !== 'function') {
            inputDescriptor.set!.call(this, handler);
            return;
          }
          const device = this;
          inputDescriptor.set!.call(device, (event: unknown) => {
            tap.dispatchInput(device, event, handler as (event: unknown) => void);
          });
        },
      });
    }

    this.installed = true;
    this.options.onChange?.();
    return this;
  }

  /** Restore the original prototypes. Safe to call multiple times. */
  stop(): void {
    if (!this.installed || !this.proto || !this.originals) return;
    const proto = this.proto;
    for (const patch of this.instancePatches) {
      if (patch.nativeRemove) {
        try {
          patch.nativeRemove.call(patch.device, INPUT_EVENT, patch.listener);
        } catch {
          // The device may already be gone.
        }
      }
      if (patch.restoreAdd) restoreInstanceProperty(patch.device, 'addEventListener', patch.add);
      if (patch.restoreRemove) {
        restoreInstanceProperty(patch.device, 'removeEventListener', patch.remove);
      }
    }
    this.instancePatches.length = 0;
    for (const [name, descriptor] of Object.entries(this.originals)) {
      if (!descriptor) continue;
      Object.defineProperty(proto, name, descriptor);
    }
    this.installed = false;
    this.connected = false;
    this.options.onChange?.();
  }

  /** Adopt a device discovered outside the prototype hooks (e.g. window.data). */
  captureDevice(device: HidDeviceLike): void {
    if (!this.matches(device)) return;
    this.currentDevice = device;
    this.connected = device.opened;
    this.observe(device);
    this.options.onChange?.();
  }

  /** Raw inbound reports, for an active client's transport. */
  subscribe(listener: (bytes: Uint8Array) => void): () => void {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }

  /** Decoded frames, for diagnostics and the userscript UI. */
  onFrame(listener: (frame: HidTapFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /** Send through the tap hooks, used by an active client sharing the handle. */
  async sendTapped(bytes: Uint8Array): Promise<void> {
    const device = this.currentDevice;
    if (!device) throw new NotConnectedError('No tapped HID device is open');
    const originals = this.originals;
    if (!originals) throw new NotConnectedError('The HID tap is not installed');
    await this.performSend(device, 0, bytes, originals.sendReport.value as Function);
  }

  /** Bypass hooks, used for internal cleanup frames. */
  async sendRaw(bytes: Uint8Array): Promise<void> {
    const device = this.currentDevice;
    const originals = this.originals;
    if (!device || !originals) throw new NotConnectedError('No tapped HID device is open');
    await (originals.sendReport.value as Function).call(device, 0, bytes);
  }

  private matches(device: HidDeviceLike): boolean {
    return device.vendorId === this.product.vid && device.productId === this.product.pid;
  }

  private async sendReport(
    device: HidDeviceLike,
    reportId: number,
    data: Uint8Array,
  ): Promise<void> {
    const originals = this.originals;
    if (!originals || !this.installed || reportId !== 0 || !this.matches(device)) {
      return (originals?.sendReport.value as Function | undefined)?.call(device, reportId, data) ??
        Promise.resolve();
    }
    const bytes = copyBytes(data);
    if (!bytes) {
      return (originals.sendReport.value as Function).call(device, reportId, data);
    }
    const parsed = parseFrame(bytes);
    if (!parsed) {
      return (originals.sendReport.value as Function).call(device, reportId, bytes);
    }
    await this.performSend(device, reportId, bytes, originals.sendReport.value as Function, parsed);
  }

  private async performSend(
    device: HidDeviceLike,
    reportId: number,
    bytes: Uint8Array,
    original: Function,
    parsedInput?: ParsedFrame,
  ): Promise<void> {
    const parsed = parsedInput ?? parseFrame(bytes);
    if (!parsed) {
      await original.call(device, reportId, bytes);
      return;
    }
    this.counters.out += 1;
    this.emitFrame({
      kind: 'hid',
      direction: 'out',
      device,
      frame: parsed,
      raw: bytes,
    });

    const hook = this.hooks.onHidOut;
    if (!hook) {
      await original.call(device, reportId, bytes);
      return;
    }

    let decision: TapDecision;
    try {
      decision = await hook(parsed, device);
    } catch (error) {
      this.options.onError?.(isError(error) ? error : new Error(String(error)));
      await original.call(device, reportId, bytes);
      return;
    }
    if (decision === null) return;
    if (decision === undefined) {
      await original.call(device, reportId, bytes);
      return;
    }
    // Realm-safe check: the hook may hand back a view from any world.
    if (!ArrayBuffer.isView(decision) || decision.byteLength !== REPORT_SIZE) {
      this.options.onError?.(
        new ValidationError(
          `HID rewrite must return a ${REPORT_SIZE}-byte Uint8Array, got ${
            ArrayBuffer.isView(decision) ? String(decision.byteLength) : 'non-view'
          }`,
        ),
      );
      await original.call(device, reportId, bytes);
      return;
    }
    await original.call(device, reportId, decision as unknown as Uint8Array);
  }

  private observe(device: HidDeviceLike): void {
    if (this.observedDevices.has(device) || !this.originals) return;
    this.observedDevices.add(device);
    const tap = this;
    const listener = (event: unknown): void => {
      tap.processInput(device, event);
    };
    const nativeAdd = (device.addEventListener as Function).bind(device);
    const nativeRemove =
      typeof device.removeEventListener === 'function'
        ? (device.removeEventListener as Function).bind(device)
        : null;
    const addDescriptor = Object.getOwnPropertyDescriptor(device, 'addEventListener');
    const removeDescriptor = Object.getOwnPropertyDescriptor(device, 'removeEventListener');

    try {
      nativeAdd(INPUT_EVENT, listener);
    } catch {
      // Without a native listener the property/instance wrappers still work.
    }

    let patchedAdd = false;
    let patchedRemove = false;
    try {
      Object.defineProperty(device, 'addEventListener', {
        configurable: true,
        writable: true,
        value: function (
          this: HidDeviceLike,
          type: string,
          pageListener: (event: unknown) => void,
          options?: unknown,
        ): void {
          if (type !== INPUT_EVENT || typeof pageListener !== 'function') {
            nativeAdd(type, pageListener, options);
            return;
          }
          let map = tap.listenerWrappers.get(device);
          if (!map) {
            map = new Map();
            tap.listenerWrappers.set(device, map);
          }
          const wrapped = (event: unknown) => tap.dispatchInput(device, event, pageListener);
          map.set(pageListener, wrapped);
          nativeAdd(type, wrapped, options);
        },
      });
      patchedAdd = true;
    } catch {
      // Platform object may reject expando methods; observation still works.
    }

    if (nativeRemove) {
      try {
        Object.defineProperty(device, 'removeEventListener', {
          configurable: true,
          writable: true,
          value: function (
            this: HidDeviceLike,
            type: string,
            pageListener: (event: unknown) => void,
            options?: unknown,
          ): void {
            const map = tap.listenerWrappers.get(device);
            const wrapped = map?.get(pageListener);
            if (type === INPUT_EVENT && wrapped) {
              map!.delete(pageListener);
              nativeRemove(type, wrapped, options);
              return;
            }
            nativeRemove(type, pageListener, options);
          },
        });
        patchedRemove = true;
      } catch {
        // See above.
      }
    }

    this.instancePatches.push({
      device,
      add: addDescriptor,
      remove: removeDescriptor,
      nativeAdd,
      nativeRemove,
      listener,
      restoreAdd: patchedAdd,
      restoreRemove: patchedRemove,
    });
  }

  /**
   * Observe one input report once, regardless of whether the page uses the
   * `oninputreport` property or `addEventListener`. Returns the rewrite
   * decision for the page handler wrappers to consume.
   */
  private processInput(
    device: HidDeviceLike,
    event: unknown,
  ): { readonly bytes: Uint8Array; readonly decision: TapDecision } | null {
    if (!this.installed || !this.matches(device)) return null;
    const key = typeof event === 'object' && event !== null ? (event as object) : null;
    if (key && this.processedEvents.has(key)) {
      const bytes = copyBytes((event as { data?: unknown }).data);
      return bytes ? { bytes, decision: this.eventDecisions.get(key) } : null;
    }

    const data = (event as { readonly data?: unknown } | null)?.data;
    const bytes = copyBytes(data);
    if (!bytes) return null;

    if (key) this.processedEvents.add(key);
    this.counters.in += 1;
    for (const listener of [...this.inputListeners]) {
      try {
        listener(bytes.slice());
      } catch (error) {
        this.options.onError?.(isError(error) ? error : new Error(String(error)));
      }
    }

    const parsed = parseFrame(bytes);
    if (!parsed) {
      if (key) this.eventDecisions.set(key, undefined);
      return { bytes, decision: undefined };
    }
    this.emitFrame({ kind: 'hid', direction: 'in', device, frame: parsed, raw: bytes });

    const hook = this.hooks.onHidIn;
    if (!hook) {
      if (key) this.eventDecisions.set(key, undefined);
      return { bytes, decision: undefined };
    }

    let decision: TapDecision;
    try {
      decision = hook(parsed, device);
    } catch (error) {
      this.options.onError?.(isError(error) ? error : new Error(String(error)));
      decision = undefined;
    }
    if (decision !== undefined && decision !== null) {
      if (!ArrayBuffer.isView(decision) || decision.byteLength !== REPORT_SIZE) {
        this.options.onError?.(
          new ValidationError(
            `HID input rewrite must return a ${REPORT_SIZE}-byte Uint8Array, got ${
              ArrayBuffer.isView(decision) ? String(decision.byteLength) : 'non-view'
            }`,
          ),
        );
        decision = undefined;
      }
    }
    if (key) this.eventDecisions.set(key, decision);
    return { bytes, decision };
  }

  private dispatchInput(
    device: HidDeviceLike,
    event: unknown,
    handler: (event: unknown) => void,
  ): void {
    if (!this.installed || !this.matches(device)) {
      handler(event);
      return;
    }
    const processed = this.processInput(device, event);
    if (!processed) {
      handler(event);
      return;
    }
    const { decision } = processed;
    if (decision === undefined) {
      handler(event);
      return;
    }
    if (decision === null) return;
    const fakeEvent = {
      data: new DataView(decision.buffer, decision.byteOffset, decision.byteLength),
      reportId: (event as { readonly reportId?: number }).reportId ?? 0,
      device,
      currentTarget: device,
      target: device,
    };
    handler(fakeEvent);
  }

  private emitFrame(frame: HidTapFrame): void {
    for (const listener of [...this.frameListeners]) {
      try {
        listener(frame);
      } catch (error) {
        this.options.onError?.(isError(error) ? error : new Error(String(error)));
      }
    }
  }
}


function restoreInstanceProperty(
  device: HidDeviceLike,
  property: 'addEventListener' | 'removeEventListener',
  descriptor: PropertyDescriptor | undefined,
): void {
  try {
    if (descriptor) Object.defineProperty(device, property, descriptor);
    else delete (device as unknown as Record<string, unknown>)[property];
  } catch {
    // Best effort; the page is going away or the platform object is locked.
  }
}
