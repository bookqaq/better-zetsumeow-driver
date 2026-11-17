/**
 * Passive/rewriting Web Serial tap.
 *
 * The official driver holds `port.readable` locked in a long-running read loop
 * and briefly locks `port.writable` for each frame. The tap therefore wraps
 * `readable.getReader()` / `writable.getWriter()` with transparent proxies
 * instead of calling `tee()`: each byte remains owned by the page, and the tap
 * only observes or rewrites the chunk that already flows through it.
 */

import { NotConnectedError, TransportError, UnsupportedError } from '../errors.ts';
import type { SerialPortLike, SerialLike } from '../transport/types.ts';
import { decodeSerialFrames } from '../transport/webserial.ts';
import type { SerialFrame } from '../transport/webserial.ts';
import type { SerialPortConstructorLike, SerialTapFrame, TapDecision, TapHooks } from './types.ts';

const HEAD_BYTE = 0xab;
const HEADER_LENGTH = 7;

export interface SerialTapOptions {
  readonly product: {
    readonly vid: number;
    readonly pidScreen: number;
  };
  readonly hooks?: TapHooks;
  readonly serial?: SerialLike | null;
  readonly portCtor?: SerialPortConstructorLike | null;
  readonly onChange?: () => void;
  readonly onError?: (error: Error) => void;
}

interface OriginalDescriptors {
  readable: PropertyDescriptor;
  writable: PropertyDescriptor;
  open: PropertyDescriptor;
  close: PropertyDescriptor;
}

interface SerialPrototype {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: unknown): Promise<void>;
  close(): Promise<void>;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Serial tap for one product.
 *
 * `createPortFacade()` returns a structural `SerialPortLike` backed by the
 * tapped page's streams, so an active `ZetsuScreen` can use the same physical
 * port without opening or closing it.
 */
export class SerialTap {
  private readonly product: SerialTapOptions['product'];
  private readonly options: SerialTapOptions;
  private readonly frameListeners = new Set<(frame: SerialTapFrame) => void>();
  private readonly inputListeners = new Set<(chunk: Uint8Array, port: SerialPortLike) => void>();
  private readonly buffers = new WeakMap<SerialPortLike, Uint8Array>();
  private readonly sinks = new WeakMap<SerialPortLike, Set<(chunk: Uint8Array) => void>>();
  private readonly facades = new WeakMap<SerialPortLike, SerialPortLike>();

  private hooks: TapHooks;
  private originals: OriginalDescriptors | null = null;
  private proto: SerialPrototype | null = null;
  private currentPort: SerialPortLike | null = null;
  private connected = false;
  private installed = false;
  private counters = { out: 0, in: 0 };
  private serialApi: SerialLike | null = null;

  constructor(options: SerialTapOptions) {
    this.options = options;
    this.product = options.product;
    this.hooks = options.hooks ?? {};
    this.serialApi = options.serial ?? null;
  }

  get port(): SerialPortLike | null {
    return this.currentPort;
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

  get serial(): SerialLike | null {
    return this.serialApi;
  }

  setHooks(hooks: TapHooks): void {
    this.hooks = hooks;
  }

  install(): this {
    if (this.installed) return this;

    const ctor =
      this.options.portCtor ??
      (globalThis as { SerialPort?: SerialPortConstructorLike }).SerialPort ??
      null;
    if (!ctor?.prototype) {
      throw new UnsupportedError(
        'Web Serial is unavailable: SerialPort is missing. Use Chromium over HTTPS or localhost.',
      );
    }
    const proto = ctor.prototype as unknown as SerialPrototype;
    const readable = Object.getOwnPropertyDescriptor(proto, 'readable');
    const writable = Object.getOwnPropertyDescriptor(proto, 'writable');
    const open = Object.getOwnPropertyDescriptor(proto, 'open');
    const close = Object.getOwnPropertyDescriptor(proto, 'close');
    if (!readable?.get || !writable?.get || !open || !close) {
      throw new UnsupportedError('SerialPort.prototype is missing required accessors');
    }

    this.proto = proto;
    this.originals = { readable, writable, open, close };
    const tap = this;

    Object.defineProperty(proto, 'readable', {
      ...readable,
      get: function (this: SerialPortLike) {
        const stream = readable.get!.call(this);
        if (!stream || !tap.matches(this)) return stream;
        return tap.wrapReadable(this, stream);
      },
    });

    Object.defineProperty(proto, 'writable', {
      ...writable,
      get: function (this: SerialPortLike) {
        const stream = writable.get!.call(this);
        if (!stream || !tap.matches(this)) return stream;
        return tap.wrapWritable(this, stream);
      },
    });

    Object.defineProperty(proto, 'open', {
      ...open,
      value: async function (this: SerialPortLike, options: unknown): Promise<void> {
        const result = await (open.value as (options: unknown) => Promise<void>).call(this, options);
        if (tap.matches(this)) {
          tap.currentPort = this;
          tap.connected = true;
          tap.options.onChange?.();
        }
        return result;
      },
    });

    Object.defineProperty(proto, 'close', {
      ...close,
      value: async function (this: SerialPortLike): Promise<void> {
        try {
          return await (close.value as () => Promise<void>).call(this);
        } finally {
          if (tap.matches(this) && tap.currentPort === this) {
            tap.connected = false;
            tap.options.onChange?.();
          }
        }
      },
    });

    this.installed = true;
    this.options.onChange?.();
    return this;
  }

  stop(): void {
    if (!this.installed || !this.proto || !this.originals) return;
    for (const [name, descriptor] of Object.entries(this.originals)) {
      if (descriptor) Object.defineProperty(this.proto, name, descriptor);
    }
    this.installed = false;
    this.connected = false;
    this.options.onChange?.();
  }

  /** Adopt a port discovered outside the prototype hooks (e.g. window.data). */
  capturePort(port: SerialPortLike): void {
    if (!this.matches(port)) return;
    this.currentPort = port;
    this.connected = port.readable !== null || port.writable !== null;
    this.options.onChange?.();
  }

  /** Raw inbound chunks, used to feed an active client's facade. */
  subscribe(listener: (chunk: Uint8Array, port: SerialPortLike) => void): () => void {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }

  onFrame(listener: (frame: SerialTapFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /**
   * A virtual port for active clients: `readable` receives every tapped chunk,
   * `writable` goes through the tap hooks and then to the real port.
   */
  createPortFacade(port: SerialPortLike): SerialPortLike {
    const cached = this.facades.get(port);
    if (cached) return cached;

    const tap = this;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const sink = (chunk: Uint8Array): void => {
      if (!controller) return;
      try {
        controller.enqueue(chunk.slice());
      } catch {
        // The active consumer went away; page traffic is unaffected.
      }
    };
    const readableStream = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
        tap.addSink(port, sink);
      },
      cancel: () => {
        controller = null;
        tap.removeSink(port, sink);
      },
    });
    const writableStream = new WritableStream<Uint8Array>({
      write: (chunk) => tap.writeTapped(port, chunk),
    });

    const facade: SerialPortLike = {
      get readable() {
        return readableStream;
      },
      get writable() {
        return writableStream;
      },
      async open() {
        // The page already opened the physical port.
      },
      async close() {
        // Never close a handle owned by the page.
      },
      getInfo:
        typeof (port as { getInfo?: unknown }).getInfo === 'function'
          ? () => (port as unknown as { getInfo: () => unknown }).getInfo()
          : undefined,
    } as SerialPortLike;

    this.facades.set(port, facade);
    return facade;
  }

  /** Send through the tap, used by active clients. */
  async writeTapped(port: SerialPortLike, chunk: Uint8Array): Promise<void> {
    const writer = await this.acquireWriter(port);
    try {
      await this.handleWrite(port, writer, chunk);
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // Already released by a failed write.
      }
    }
  }

  /** Send without hooks, for internal cleanup. */
  async writeRaw(port: SerialPortLike, chunk: Uint8Array): Promise<void> {
    const writer = await this.acquireWriter(port);
    try {
      await writer.write(chunk);
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // Already released.
      }
    }
  }

  private matches(port: SerialPortLike): boolean {
    const getInfo = (port as { getInfo?: () => { usbVendorId?: number; usbProductId?: number } })
      .getInfo;
    if (typeof getInfo !== 'function') return true;
    try {
      const info = getInfo.call(port);
      if (typeof info.usbVendorId !== 'number') return true;
      return info.usbVendorId === this.product.vid && info.usbProductId === this.product.pidScreen;
    } catch {
      return true;
    }
  }

  private wrapReadable(
    port: SerialPortLike,
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> {
    const tap = this;
    return new Proxy(stream, {
      get(target, property) {
        if (property === 'getReader') {
          return (...args: unknown[]) =>
            tap.wrapReader(port, (target.getReader as Function).apply(target, args));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private wrapReader(port: SerialPortLike, reader: ReadableStreamDefaultReader<Uint8Array>) {
    const tap = this;
    return new Proxy(reader, {
      get(target, property) {
        if (property === 'read') {
          return async (...args: unknown[]) => {
            const result = (await (target.read as Function).apply(target, args)) as {
              readonly done: boolean;
              readonly value?: Uint8Array;
            };
            if (!result.done && result.value) tap.ingest(port, result.value);
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private wrapWritable(
    port: SerialPortLike,
    stream: WritableStream<Uint8Array>,
  ): WritableStream<Uint8Array> {
    const tap = this;
    return new Proxy(stream, {
      get(target, property) {
        if (property === 'getWriter') {
          return (...args: unknown[]) =>
            tap.wrapWriter(port, (target.getWriter as Function).apply(target, args));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private wrapWriter(
    port: SerialPortLike,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): WritableStreamDefaultWriter<Uint8Array> {
    const tap = this;
    return new Proxy(writer, {
      get(target, property) {
        if (property === 'write') {
          return async (chunk: unknown) => {
            const bytes = copyBytes(chunk);
            if (!bytes) return (target.write as Function).call(target, chunk);
            return tap.handleWrite(port, target, bytes);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private async handleWrite(
    port: SerialPortLike,
    writer: { write(chunk: Uint8Array): Promise<void> },
    bytes: Uint8Array,
  ): Promise<void> {
    this.counters.out += 1;
    const decoded = decodeSerialFrames(bytes);
    if (decoded.frames.length === 0) {
      await writer.write(bytes);
      return;
    }

    const hook = this.hooks.onSerialOut;
    let changed = false;
    const parts: Uint8Array[] = [];
    for (const frame of decoded.frames) {
      this.emitFrame({ kind: 'serial', direction: 'out', port, frame, raw: frame.raw });
      let output: Uint8Array | null = frame.raw;
      if (hook) {
        let decision: TapDecision;
        try {
          decision = await hook(frame, port);
        } catch (error) {
          this.options.onError?.(isError(error) ? error : new Error(String(error)));
          decision = undefined;
        }
        if (decision === null) {
          changed = true;
          output = null;
        } else if (ArrayBuffer.isView(decision)) {
          // Realm-safe: the hook may hand back a view from any world.
          const bytes = decision as unknown as Uint8Array;
          if (!this.isValidFrame(bytes)) {
            this.options.onError?.(
              new TransportError('Serial rewrite did not return a complete 0xAB frame'),
            );
            output = frame.raw;
          } else {
            changed = true;
            output = bytes;
          }
        } else if (decision === undefined) {
          output = frame.raw;
        }
      }
      if (output) parts.push(output);
    }

    if (!changed) {
      await writer.write(bytes);
      return;
    }
    parts.push(decoded.rest);
    await writer.write(concat(parts));
  }

  private ingest(port: SerialPortLike, chunk: Uint8Array): void {
    this.counters.in += 1;
    for (const listener of [...this.inputListeners]) {
      try {
        listener(chunk.slice(), port);
      } catch (error) {
        this.options.onError?.(isError(error) ? error : new Error(String(error)));
      }
    }
    const sinks = this.sinks.get(port);
    if (sinks) {
      for (const sink of [...sinks]) {
        try {
          sink(chunk);
        } catch (error) {
          this.options.onError?.(isError(error) ? error : new Error(String(error)));
        }
      }
    }

    const previous = this.buffers.get(port) ?? new Uint8Array(0);
    const merged = new Uint8Array(previous.length + chunk.length);
    merged.set(previous, 0);
    merged.set(chunk, previous.length);
    const decoded = decodeSerialFrames(merged);
    this.buffers.set(port, decoded.rest);
    for (const frame of decoded.frames) {
      this.emitFrame({ kind: 'serial', direction: 'in', port, frame, raw: frame.raw });
      try {
        this.hooks.onSerialIn?.(frame, port);
      } catch (error) {
        this.options.onError?.(isError(error) ? error : new Error(String(error)));
      }
    }
  }

  private addSink(port: SerialPortLike, sink: (chunk: Uint8Array) => void): void {
    let set = this.sinks.get(port);
    if (!set) {
      set = new Set();
      this.sinks.set(port, set);
    }
    set.add(sink);
  }

  private removeSink(port: SerialPortLike, sink: (chunk: Uint8Array) => void): void {
    this.sinks.get(port)?.delete(sink);
  }

  private async acquireWriter(
    port: SerialPortLike,
  ): Promise<WritableStreamDefaultWriter<Uint8Array>> {
    const writable = this.originals?.writable.get?.call(port) as
      | WritableStream<Uint8Array>
      | null
      | undefined;
    if (!writable) throw new NotConnectedError('The tapped serial port is not writable');

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return writable.getWriter();
      } catch (error) {
        lastError = error;
        await sleep(5);
      }
    }
    throw new TransportError('The page is holding the serial writer', { cause: lastError });
  }

  private isValidFrame(bytes: Uint8Array): boolean {
    if (bytes.length < HEADER_LENGTH || bytes[0] !== HEAD_BYTE) return false;
    const length =
      (((bytes[1] ?? 0) << 24) |
        ((bytes[2] ?? 0) << 16) |
        ((bytes[3] ?? 0) << 8) |
        (bytes[4] ?? 0)) >>>
      0;
    return bytes.length >= HEADER_LENGTH + length;
  }

  private emitFrame(frame: SerialTapFrame): void {
    for (const listener of [...this.frameListeners]) {
      try {
        listener(frame);
      } catch (error) {
        this.options.onError?.(isError(error) ? error : new Error(String(error)));
      }
    }
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
