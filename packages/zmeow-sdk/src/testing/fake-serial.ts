/**
 * In-memory Web Serial fakes for unit tests.
 *
 * `FakeSerialPort` behaves like a `SerialPort`: host writes are collected in
 * `writes`, and the test drives device-to-host traffic through `devicePush()`.
 * `FakeSerial` behaves like `navigator.serial`, recording the filters passed to
 * `requestPort()` and returning previously granted ports from `getPorts()`.
 */

import type {
  SerialLike,
  SerialOpenOptions,
  SerialPortFilter,
  SerialPortLike,
} from '../transport/types.ts';

export interface FakeSerialPortInfo {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
}

export interface FakeSerialPortOptions extends FakeSerialPortInfo {
  /** When set, `open()` rejects with this error. */
  readonly openError?: Error | null;
  /** Called synchronously after every host write, useful for scripted ACKs. */
  readonly onWrite?: (chunk: Uint8Array, port: FakeSerialPort) => void;
}

/** A fake `SerialPort` backed by in-memory streams. */
export class FakeSerialPort implements SerialPortLike {
  /** Raw host-to-device writes, one entry per `writer.write()` call. */
  readonly writes: Uint8Array[] = [];

  /** Options passed to `open()`, or `null` while the port has never opened. */
  openOptions: SerialOpenOptions | null = null;

  /** When set, `open()` rejects with this error. Mutable for per-test setup. */
  openError: Error | null;

  private readonly info: FakeSerialPortInfo;
  private readonly onWrite: ((chunk: Uint8Array, port: FakeSerialPort) => void) | null;
  private readableStream: ReadableStream<Uint8Array> | null = null;
  private writableStream: WritableStream<Uint8Array> | null = null;
  private readableController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private opened = false;

  constructor(options: FakeSerialPortOptions = {}) {
    this.info = { usbVendorId: options.usbVendorId, usbProductId: options.usbProductId };
    this.openError = options.openError ?? null;
    this.onWrite = options.onWrite ?? null;
  }

  get readable(): ReadableStream<Uint8Array> | null {
    return this.readableStream;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.writableStream;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(options: SerialOpenOptions): Promise<void> {
    if (this.opened) return;
    this.openOptions = options;
    if (this.openError) throw this.openError;

    this.opened = true;
    this.readableStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readableController = controller;
      },
      cancel: () => {
        this.readableController = null;
      },
    });
    this.writableStream = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (!this.opened) throw new Error('FakeSerialPort is not open');
        const copy = new Uint8Array(chunk);
        this.writes.push(copy);
        this.onWrite?.(copy, this);
      },
    });
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    this.closeReadable();
    this.readableStream = null;
    this.writableStream = null;
  }

  /** Emulates `SerialPort.getInfo()` for granted-port matching. */
  getInfo(): FakeSerialPortInfo {
    return { ...this.info };
  }

  /** Queues device-to-host bytes; the transport's read loop consumes them. */
  devicePush(bytes: Uint8Array | readonly number[]): void {
    const controller = this.readableController;
    if (!this.opened || !controller) {
      throw new Error('FakeSerialPort is not open');
    }
    controller.enqueue(new Uint8Array(bytes));
  }

  /**
   * Ends the device-to-host side of the link, emulating an unplugged device.
   * The port itself stays "open" from the host point of view.
   */
  deviceClose(): void {
    this.closeReadable();
    this.readableStream = null;
  }

  private closeReadable(): void {
    const controller = this.readableController;
    this.readableController = null;
    if (!controller) return;
    try {
      controller.close();
    } catch {
      // The stream was already closed or errored.
    }
  }
}

export interface FakeSerialOptions {
  /** Previously granted ports returned by `getPorts()`. */
  readonly ports?: readonly FakeSerialPort[];
  /** Port returned by `requestPort()` when no granted port exists. */
  readonly defaultPort?: FakeSerialPort;
  /** When set, `requestPort()` rejects with this error. */
  readonly requestPortError?: Error | null;
  /** When set, `getPorts()` rejects with this error. */
  readonly getPortsError?: Error | null;
}

/** A fake `navigator.serial`. */
export class FakeSerial implements SerialLike {
  readonly ports: FakeSerialPort[];

  /** Number of `requestPort()` calls, to prove the lazy connection contract. */
  requestPortCalls = 0;
  /** Filters of the most recent `requestPort()` call. */
  requestPortFilters: readonly SerialPortFilter[] | undefined;

  /** When set, `requestPort()` rejects with this error. Mutable per test. */
  requestPortError: Error | null;
  /** When set, `getPorts()` rejects with this error. Mutable per test. */
  getPortsError: Error | null;

  private readonly defaultPort: FakeSerialPort | null;

  constructor(options: FakeSerialOptions = {}) {
    this.ports = [...(options.ports ?? [])];
    this.defaultPort = options.defaultPort ?? null;
    this.requestPortError = options.requestPortError ?? null;
    this.getPortsError = options.getPortsError ?? null;
  }

  async getPorts(): Promise<SerialPortLike[]> {
    if (this.getPortsError) throw this.getPortsError;
    return [...this.ports];
  }

  async requestPort(options?: { filters?: readonly SerialPortFilter[] }): Promise<SerialPortLike> {
    this.requestPortCalls += 1;
    this.requestPortFilters = options?.filters;
    if (this.requestPortError) throw this.requestPortError;

    const port = this.ports[0] ?? this.defaultPort ?? new FakeSerialPort();
    if (!this.ports.includes(port)) this.ports.push(port);
    return port;
  }
}
