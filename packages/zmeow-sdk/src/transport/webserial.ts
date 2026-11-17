/**
 * Web Serial transport for the ZetsuMeow screen interface.
 *
 * The screen protocol is a tiny binary framing on a 115200 8N1 serial link:
 *
 *   [0]      0xAB
 *   [1..4]   payload length, uint32 big-endian
 *   [5]      command
 *   [6]      checksum = (payloadLength + command + lastPayloadByte) & 0xFF
 *   [7..]    payload (payloadLength bytes)
 *
 * A serial chunk may contain a partial frame, several frames or both, so the
 * read loop keeps a carry-over buffer and decodes as many complete frames as
 * possible after every chunk.
 */

import { DeviceOpenError, NotConnectedError, TransportError } from '../errors.ts';
import type { SerialLike, SerialPortLike } from './types.ts';

/** Default line speed of the screen interface. */
export const DEFAULT_BAUD_RATE = 115200;

const HEAD_BYTE = 0xab;
const HEADER_LENGTH = 7;

/** One complete frame decoded from the serial stream. */
export interface SerialFrame {
  readonly command: number;
  readonly payload: Uint8Array;
  /** Full wire bytes of the frame, header included. */
  readonly raw: Uint8Array;
}

export interface SerialTransportOptions {
  readonly baudRate?: number;
  /**
   * When `false`, the port is already open and owned by the caller (for
   * example a page being tapped): `open()` and `close()` do not call
   * `SerialPort.open()` / `SerialPort.close()`, they only manage the reader.
   * Defaults to `true`.
   */
  readonly openPort?: boolean;
  /**
   * Called once when the link goes away unexpectedly (device unplugged, read
   * loop failed). Never called for a `close()` initiated by the caller.
   */
  readonly onDisconnect?: () => void;
}

/**
 * Minimal transport for the screen serial port. It deliberately does not know
 * anything about screen commands: it only opens the port, frames outgoing
 * payloads, decodes incoming frames and fans them out to subscribers.
 */
export class SerialTransport {
  readonly kind: 'serial' = 'serial';

  private readonly port: SerialPortLike;
  private readonly options: SerialTransportOptions;
  private readonly listeners = new Set<(frame: SerialFrame) => void>();
  private buffer: Uint8Array = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private opened = false;
  private reading = false;

  constructor(port: SerialPortLike, options: SerialTransportOptions = {}) {
    this.port = port;
    this.options = options;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    if (this.options.openPort !== false) {
      try {
        await this.port.open({
          baudRate: this.options.baudRate ?? DEFAULT_BAUD_RATE,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          flowControl: 'none',
        });
      } catch (error) {
        throw new DeviceOpenError('Failed to open the screen serial port', { cause: error });
      }
    }
    this.opened = true;
    this.startReadLoop();
  }

  /** Idempotent: cancels the reader, releases the lock and closes the port. */
  async close(): Promise<void> {
    const wasOpen = this.opened;
    this.opened = false;
    this.buffer = new Uint8Array(0);

    const reader = this.reader;
    this.reader = null;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // A reader that already failed cannot be cancelled; releasing is enough.
      }
      try {
        reader.releaseLock();
      } catch {
        // Already released by the read loop.
      }
    }

    if (!wasOpen) return;
    if (this.options.openPort === false) return;
    try {
      await this.port.close();
    } catch (error) {
      throw new TransportError('Failed to close the screen serial port', { cause: error });
    }
  }

  async sendCommand(command: number, payload: Uint8Array | readonly number[]): Promise<void> {
    if (!this.opened) {
      throw new NotConnectedError('The screen serial port is not open');
    }
    const writable = this.port.writable;
    if (!writable) {
      throw new NotConnectedError('The screen serial port is not writable');
    }

    const frame = encodeSerialFrameBytes(command, payload);
    const writer = writable.getWriter();
    try {
      await writer.write(frame);
    } catch (error) {
      throw new TransportError(`Failed to send serial command ${command}`, { cause: error });
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // The stream may already be errored/closed; nothing else to release.
      }
    }
  }

  subscribe(listener: (frame: SerialFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private startReadLoop(): void {
    if (this.reading) return;
    this.reading = true;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    try {
      while (this.opened) {
        const readable = this.port.readable;
        if (!readable) break;
        const reader = readable.getReader();
        this.reader = reader;
        try {
          while (this.opened) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length > 0) this.ingest(value);
          }
        } finally {
          this.reader = null;
          try {
            reader.releaseLock();
          } catch {
            // Already released.
          }
        }
        if (!this.opened) break;
        // The readable side ended while we still considered the link open:
        // treat it as an unexpected disconnect.
        this.handleDisconnect();
      }
    } catch {
      if (this.opened) this.handleDisconnect();
    } finally {
      this.reading = false;
    }
  }

  private ingest(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);

    const decoded = decodeSerialFrames(merged);
    this.buffer = decoded.rest;
    for (const frame of decoded.frames) {
      for (const listener of [...this.listeners]) {
        try {
          listener(frame);
        } catch {
          // A broken subscriber must not tear down the read loop.
        }
      }
    }
  }

  private handleDisconnect(): void {
    if (!this.opened) return;
    this.opened = false;
    this.buffer = new Uint8Array(0);
    const callback = this.options.onDisconnect;
    if (!callback) return;
    try {
      callback();
    } catch {
      // Disconnect listeners are best effort.
    }
  }
}

/** Returns `navigator.serial` when the runtime provides Web Serial. */
export function getSerialApi(): SerialLike | null {
  const navigatorLike = (globalThis as { navigator?: { serial?: SerialLike } }).navigator;
  return navigatorLike?.serial ?? null;
}

export function isWebSerialSupported(): boolean {
  return getSerialApi() !== null;
}

/**
 * Encodes one serial frame. The payload is copied as-is; an empty payload
 * contributes `0` to the checksum.
 */
export function encodeSerialFrame(command: number, payload: readonly number[]): Uint8Array {
  return encodeSerialFrameBytes(command, payload);
}

/**
 * Splits an arbitrary serial buffer into complete frames. Bytes belonging to an
 * incomplete frame are returned in `rest` and should be prepended to the next
 * chunk. Bytes before the first `0xAB` head are discarded.
 */
export function decodeSerialFrames(buffer: Uint8Array): { frames: SerialFrame[]; rest: Uint8Array } {
  const frames: SerialFrame[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer[offset] !== HEAD_BYTE) {
      let next = -1;
      for (let index = offset + 1; index < buffer.length; index += 1) {
        if (buffer[index] === HEAD_BYTE) {
          next = index;
          break;
        }
      }
      if (next < 0) {
        offset = buffer.length;
        break;
      }
      offset = next;
      continue;
    }

    if (buffer.length - offset < HEADER_LENGTH) break;

    const payloadLength = readUint32BE(buffer, offset + 1);
    const totalLength = HEADER_LENGTH + payloadLength;
    if (buffer.length - offset < totalLength) break;

    const raw = buffer.slice(offset, offset + totalLength);
    frames.push({
      command: raw[5],
      payload: raw.slice(HEADER_LENGTH),
      raw,
    });
    offset += totalLength;
  }

  return { frames, rest: buffer.slice(offset) };
}

function encodeSerialFrameBytes(command: number, payload: ArrayLike<number>): Uint8Array {
  const payloadLength = payload.length;
  const frame = new Uint8Array(HEADER_LENGTH + payloadLength);
  frame[0] = HEAD_BYTE;
  writeUint32BE(frame, 1, payloadLength);
  frame[5] = command & 0xff;
  for (let index = 0; index < payloadLength; index += 1) {
    frame[HEADER_LENGTH + index] = payload[index] & 0xff;
  }
  const lastByte = payloadLength > 0 ? frame[HEADER_LENGTH + payloadLength - 1] : 0;
  frame[6] = (payloadLength + (command & 0xff) + lastByte) & 0xff;
  return frame;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3]) >>>
    0
  );
}

function writeUint32BE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = (value >>> 24) & 0xff;
  buffer[offset + 1] = (value >>> 16) & 0xff;
  buffer[offset + 2] = (value >>> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}
