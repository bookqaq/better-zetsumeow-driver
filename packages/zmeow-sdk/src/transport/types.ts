/**
 * Structural interfaces for the browser APIs the SDK needs.
 *
 * WebHID and Web Serial are not part of TypeScript's `lib.dom.d.ts`, and the SDK
 * must also run (and be unit-tested) where those globals are absent. Declaring
 * the minimal shapes here keeps the transport layer testable with fakes.
 */

export interface HidReportInfo {
  readonly reportId: number;
  readonly reportCount: number;
  /** Report size in bits, as reported by WebHID. */
  readonly reportSize?: number;
}

export interface HidCollectionInfo {
  readonly usagePage: number;
  readonly usage: number;
  readonly type?: number;
  readonly inputReports?: readonly HidReportInfo[];
  readonly outputReports?: readonly HidReportInfo[];
  readonly featureReports?: readonly HidReportInfo[];
}

export interface HidInputReportEvent {
  readonly data?: DataView;
  readonly reportId?: number;
  readonly device?: HidDeviceLike;
}

export interface HidConnectionEvent {
  readonly device: HidDeviceLike;
}

/** Minimal `HIDDevice` shape used by {@link HidTransport}. */
export interface HidDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly opened: boolean;
  readonly collections: readonly HidCollectionInfo[];
  open(): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export interface HidDeviceFilter {
  readonly vendorId?: number;
  readonly productId?: number;
  readonly usage?: number;
  readonly usagePage?: number;
}

/** Minimal `HID` (navigator.hid) shape. */
export interface HidLike {
  getDevices(): Promise<HidDeviceLike[]>;
  requestDevice(options: { filters: readonly HidDeviceFilter[] }): Promise<HidDeviceLike[]>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export interface SerialOpenOptions {
  readonly baudRate: number;
  readonly dataBits?: number;
  readonly stopBits?: number;
  readonly parity?: 'none' | 'even' | 'odd';
  readonly flowControl?: 'none' | 'hardware';
  readonly bufferSize?: number;
}

/** Minimal `SerialPort` shape used by {@link SerialTransport}. */
export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  addEventListener?(type: string, listener: (event: never) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export interface SerialPortFilter {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
}

/** Minimal `Serial` (navigator.serial) shape. */
export interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: { filters?: readonly SerialPortFilter[] }): Promise<SerialPortLike>;
  addEventListener?(type: string, listener: (event: never) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export type TransportKind = 'hid' | 'serial' | 'mock';

export type FrameListener = (frame: Uint8Array) => void;

/** Byte pipe shared by every transport. Frames are always 64-byte HID reports. */
export interface Transport {
  readonly kind: TransportKind;
  open(): Promise<void>;
  close(): Promise<void>;
  send(frame: Uint8Array): Promise<void>;
  subscribe(listener: FrameListener): () => void;
  /** True when the link is usable without another `open()` call. */
  readonly isOpen: boolean;
}
