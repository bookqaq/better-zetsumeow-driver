/**
 * WebHID transport.
 *
 * {@link HidTransport} adapts a `HIDDevice` (structurally typed as
 * {@link HidDeviceLike}) to the shared {@link Transport} contract: fixed
 * 64-byte report frames, input-report fan-out and typed SDK errors.
 *
 * The module is DOM-global free at import time: `navigator.hid` is looked up on
 * demand so the package stays loadable (and testable) under plain Node.
 */

import {
  DeviceOpenError,
  NotConnectedError,
  TransportError,
  UnsupportedError,
  UserCancelledError,
} from '../errors.ts';
import type { ProductInfo } from '../types.ts';
import type {
  FrameListener,
  HidCollectionInfo,
  HidConnectionEvent,
  HidDeviceFilter,
  HidDeviceLike,
  HidInputReportEvent,
  HidLike,
  Transport,
} from './types.ts';

/** Every keyboard report is one full 64-byte HID packet. */
const REPORT_SIZE = 64;

const INPUT_REPORT_EVENT = 'inputreport';
const DISCONNECT_EVENT = 'disconnect';

/** Options accepted by {@link HidTransport}. */
export interface HidTransportOptions {
  /** Called once the device fires a `disconnect` event that matches this transport. */
  readonly onDisconnect?: (device: HidDeviceLike) => void;
}

/**
 * Byte-pipe implementation over WebHID.
 *
 * Event listeners are attached in the constructor (and re-attached by a later
 * `open()` after `close()`), so a device that disappears before `open()` is
 * still observed. The transport owns no device state beyond `openState`: it
 * never calls `HIDDevice.forget()`.
 */
export class HidTransport implements Transport {
  readonly kind = 'hid' as const;

  private readonly hidDevice: HidDeviceLike;
  private readonly onDisconnectCallback: ((device: HidDeviceLike) => void) | undefined;
  private readonly listeners = new Set<FrameListener>();
  private openState = false;
  private listening = false;

  constructor(device: HidDeviceLike, options: HidTransportOptions = {}) {
    this.hidDevice = device;
    this.onDisconnectCallback = options.onDisconnect;
    this.startListening();
  }

  /** The wrapped device, exposed for diagnostics and disconnect bookkeeping. */
  get device(): HidDeviceLike {
    return this.hidDevice;
  }

  /** True once {@link open} succeeded and before {@link close}/disconnect. */
  get isOpen(): boolean {
    return this.openState;
  }

  /**
   * Open the underlying device. Idempotent: a device that is already `opened`
   * is adopted without another `open()` call.
   */
  async open(): Promise<void> {
    if (this.openState) return;
    this.startListening();
    if (this.hidDevice.opened) {
      this.openState = true;
      return;
    }
    try {
      await this.hidDevice.open();
    } catch (cause) {
      this.openState = false;
      throw new DeviceOpenError(`Failed to open ${describeDevice(this.hidDevice)}`, { cause });
    }
    this.openState = true;
  }

  /**
   * Close the underlying device. Idempotent: listeners are removed first and
   * the device is only closed when it is still open. Close failures are
   * swallowed because the transport is already unusable at that point.
   */
  async close(): Promise<void> {
    this.openState = false;
    this.stopListening();
    if (!this.hidDevice.opened) return;
    try {
      await this.hidDevice.close();
    } catch {
      // The link is closed from the SDK's point of view regardless. Never
      // escalate a teardown failure, and never call `forget()` here.
    }
  }

  /** Send one 64-byte frame as HID report id `0`. */
  async send(frame: Uint8Array): Promise<void> {
    if (frame.length !== REPORT_SIZE) {
      throw new TransportError(
        `Expected a ${REPORT_SIZE}-byte report for ${describeDevice(this.hidDevice)}, received ${frame.length} bytes`,
      );
    }
    if (!this.openState) {
      throw new NotConnectedError(`Cannot send: ${describeDevice(this.hidDevice)} is not open`);
    }
    try {
      await this.hidDevice.sendReport(0, frame);
    } catch (cause) {
      throw new TransportError(
        `Failed to send a report to ${describeDevice(this.hidDevice)} on interface [${describeInterface(
          this.hidDevice,
        )}]: ${causeMessage(cause)}`,
        { cause },
      );
    }
  }

  /** Register a frame listener. The returned function unsubscribes it. */
  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private startListening(): void {
    if (this.listening) return;
    this.listening = true;
    this.hidDevice.addEventListener(INPUT_REPORT_EVENT, this.handleInputReport);
    this.hidDevice.addEventListener(DISCONNECT_EVENT, this.handleDisconnect);
  }

  private stopListening(): void {
    if (!this.listening) return;
    const remove = this.hidDevice.removeEventListener;
    // A device without removeEventListener (some structural fakes) cannot be
    // detached: keep `listening` true so a later open() does not register the
    // handlers a second time.
    if (typeof remove !== 'function') return;
    remove.call(this.hidDevice, INPUT_REPORT_EVENT, this.handleInputReport);
    remove.call(this.hidDevice, DISCONNECT_EVENT, this.handleDisconnect);
    this.listening = false;
  }

  /**
   * Copy the report out of the live `DataView` before handing it to listeners:
   * the browser may reuse the buffer once the handler returns.
   */
  private readonly handleInputReport = (event: unknown): void => {
    const data = (event as HidInputReportEvent | null | undefined)?.data;
    if (!data) return;
    const report = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    for (const listener of [...this.listeners]) {
      // Hand every listener its own copy so one consumer cannot corrupt another.
      listener(report.slice());
    }
  };

  private readonly handleDisconnect = (event: unknown): void => {
    const disconnected = (event as HidConnectionEvent | null | undefined)?.device;
    if (!disconnected || !sameDevice(disconnected, this.hidDevice)) return;
    this.openState = false;
    this.onDisconnectCallback?.(this.hidDevice);
  };
}

/** `(navigator as any).hid`, or `null` when WebHID is unavailable. */
export function getHidApi(): HidLike | null {
  const navigator = (globalThis as { readonly navigator?: { readonly hid?: HidLike } }).navigator;
  return navigator?.hid ?? null;
}

/** True when `navigator.hid` exists (Chromium, secure context). */
export function isWebHidSupported(): boolean {
  return getHidApi() !== null;
}

/**
 * Show the WebHID device chooser and return the first granted device.
 *
 * @throws {UnsupportedError} when WebHID is unavailable.
 * @throws {UserCancelledError} when the chooser was dismissed (empty result,
 * `NotFoundError`/`AbortError`, or a cancellation message).
 * @throws {TransportError} when the chooser fails for any other reason (the
 * browser refused the request: permission policy, insecure context, …). WebHID
 * itself exists, so that is a transport failure, not an "unsupported runtime".
 */
export async function requestHidDevice(filters: readonly HidDeviceFilter[]): Promise<HidDeviceLike> {
  const hid = getHidApi();
  if (!hid) {
    throw new UnsupportedError(
      'WebHID is unavailable: navigator.hid is missing. Use a Chromium browser over HTTPS (or localhost).',
    );
  }

  let devices: readonly HidDeviceLike[];
  try {
    devices = await hid.requestDevice({ filters });
  } catch (cause) {
    if (isUserCancellation(cause)) throw new UserCancelledError(undefined, { cause });
    throw new TransportError('WebHID device chooser failed', { cause });
  }

  const [device] = devices;
  if (!device) throw new UserCancelledError('No HID device was selected');
  return device;
}

/**
 * Devices the user already granted access to. Returns an empty array when
 * WebHID is unavailable; enumeration failures are surfaced as
 * {@link TransportError}.
 */
export async function getGrantedHidDevices(): Promise<HidDeviceLike[]> {
  const hid = getHidApi();
  if (!hid) return [];
  try {
    return await hid.getDevices();
  } catch (cause) {
    throw new TransportError('Failed to enumerate granted HID devices', { cause });
  }
}

function isUserCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { readonly name?: unknown }).name;
  if (name === 'NotFoundError' || name === 'AbortError') return true;
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === 'string' && /cancel/i.test(message);
}

function sameDevice(a: HidDeviceLike, b: HidDeviceLike): boolean {
  // A composite device exposes several HID interfaces that share vendorId /
  // productId, so identity alone is not enough and USB ids alone are too coarse:
  // compare the collection signature as well.
  return a === b || interfaceSignature(a) === interfaceSignature(b);
}

function interfaceSignature(device: HidDeviceLike): string {
  const collections = device.collections ?? [];
  const parts = collections.map(
    (collection) => `${collection.usagePage}/${collection.usage}`,
  );
  return `${device.vendorId}:${device.productId}:${parts.join('|')}`;
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause === undefined || cause === null) return 'unknown error';
  return String(cause);
}

function describeDevice(device: HidDeviceLike): string {
  const name = device.productName ?? 'HID device';
  return `${name} (${toHex(device.vendorId)}:${toHex(device.productId)})`;
}

function toHex(value: number): string {
  return value.toString(16).padStart(4, '0');
}

/** Byte length of a collection's first output report, when WebHID reports it. */
export function outputReportBytes(
  collection: HidCollectionInfo | null | undefined,
): number | null {
  const report = collection?.outputReports?.[0];
  if (!report) return null;
  // Chromium currently exposes reportId only on granted devices, so treat a
  // missing/zero count as "unknown" instead of computing NaN.
  if (!Number.isFinite(report.reportCount) || report.reportCount <= 0) return null;
  const bits = report.reportCount * (report.reportSize ?? 8);
  return Math.ceil(bits / 8);
}

function inputReportBytes(
  collection: HidCollectionInfo | null | undefined,
): number | null {
  const report = collection?.inputReports?.[0];
  if (!report) return null;
  if (!Number.isFinite(report.reportCount) || report.reportCount <= 0) return null;
  const bits = report.reportCount * (report.reportSize ?? 8);
  return Math.ceil(bits / 8);
}

/** Human-readable summary of the first collection of a device. */
export function describeInterface(device: HidDeviceLike): string {
  const collections = device.collections ?? [];
  if (collections.length === 0) return 'no collections';
  const collection = collections[0] as HidCollectionInfo;
  const bytes = outputReportBytes(collection);
  const usagePage = `usagePage=0x${collection.usagePage.toString(16).toUpperCase()}`;
  const usage = `usage=0x${collection.usage.toString(16).toUpperCase()}`;
  const output = bytes === null ? 'output=<unknown>' : `output=${bytes}B`;
  return `${usagePage}, ${usage}, ${output}`;
}

/** Structured interface description, used by diagnostics and the playground. */
export interface HidInterfaceDescription {
  readonly productName: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly opened: boolean;
  readonly collections: readonly {
    readonly usagePage: number;
    readonly usage: number;
    readonly outputReportBytes: number | null;
    readonly inputReportBytes: number | null;
  }[];
}

export function describeHidDevice(device: HidDeviceLike): HidInterfaceDescription {
  return {
    productName: device.productName ?? 'HID device',
    vendorId: device.vendorId,
    productId: device.productId,
    opened: device.opened,
    collections: (device.collections ?? []).map((collection) => ({
      usagePage: collection.usagePage,
      usage: collection.usage,
      outputReportBytes: outputReportBytes(collection),
      inputReportBytes: inputReportBytes(collection),
    })),
  };
}

/** One ranked HID interface for a product. */
export interface HidInterfaceCandidate {
  readonly device: HidDeviceLike;
  readonly score: number;
  readonly collection: HidCollectionInfo | null;
  readonly outputReportBytes: number | null;
  readonly reasons: readonly string[];
}

/**
 * Rank the interfaces returned by the chooser for one product.
 *
 * The original driver only accepted a device with exactly one collection whose
 * `usage` is the product usage and whose `usagePage` is in the product's list;
 * a composite keyboard exposes several collections, and sending a 64-byte
 * report to the wrong one fails with a `TransportError`. This ranking keeps the
 * driver's criteria as the strongest signal and additionally prefers the
 * collection that declares a 64-byte output report.
 */
export function rankHidInterfaces(
  devices: readonly HidDeviceLike[],
  product: ProductInfo,
): HidInterfaceCandidate[] {
  const ranked = devices.map((device): HidInterfaceCandidate => {
    const collections = device.collections ?? [];
    const reasons: string[] = [];
    let bestCollection: HidCollectionInfo | null = null;
    let bestCollectionScore = -1;
    for (const collection of collections) {
      let score = 0;
      if (product.usagePages.includes(collection.usagePage)) score += 8;
      if (collection.usage === product.usage) score += 4;
      const bytes = outputReportBytes(collection);
      if (bytes === REPORT_SIZE) score += 6;
      else if (bytes !== null) score += 2;
      if (score > bestCollectionScore) {
        bestCollectionScore = score;
        bestCollection = collection;
      }
    }
    let score = Math.max(bestCollectionScore, 0);
    if (collections.length === 1) {
      score += 2;
      reasons.push('single collection');
    }
    if (bestCollection) {
      if (product.usagePages.includes(bestCollection.usagePage)) {
        reasons.push(`usagePage 0x${bestCollection.usagePage.toString(16)} matches product`);
      }
      if (bestCollection.usage === product.usage) {
        reasons.push(`usage 0x${bestCollection.usage.toString(16)} matches product`);
      }
      const bytes = outputReportBytes(bestCollection);
      if (bytes === REPORT_SIZE) reasons.push(`output report is ${REPORT_SIZE}B`);
      else if (bytes !== null) reasons.push(`output report is ${bytes}B (expected ${REPORT_SIZE}B)`);
    }
    if (collections.length === 0) reasons.push('device reports no collections');
    return {
      device,
      score,
      collection: bestCollection,
      outputReportBytes: outputReportBytes(bestCollection),
      reasons,
    };
  });
  return ranked.sort((left, right) => right.score - left.score);
}

/**
 * Show the WebHID device chooser and return every granted top-level collection.
 *
 * A composite device yields one `HIDDevice` per top-level collection, so the
 * caller must pick the right interface (see {@link rankHidInterfaces}).
 */
export async function requestHidDevices(
  filters: readonly HidDeviceFilter[],
): Promise<HidDeviceLike[]> {
  const hid = getHidApi();
  if (!hid) {
    throw new UnsupportedError(
      'WebHID is unavailable: navigator.hid is missing. Use a Chromium browser over HTTPS (or localhost).',
    );
  }
  let devices: readonly HidDeviceLike[];
  try {
    devices = await hid.requestDevice({ filters });
  } catch (cause) {
    if (isUserCancellation(cause)) throw new UserCancelledError(undefined, { cause });
    throw new TransportError('WebHID device chooser failed', { cause });
  }
  if (devices.length === 0) {
    throw new UserCancelledError('No HID device was selected');
  }
  return [...devices];
}
