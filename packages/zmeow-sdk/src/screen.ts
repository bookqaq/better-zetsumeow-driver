/**
 * ZetsuMeow screen (Web Serial) client.
 *
 * The screen is a separate USB serial interface (115200 8N1) that does not
 * follow the keyboard's HID protocol. Two commands exist:
 *
 *   112 `prepare`  payload: [0, frameCount, ...15-byte image name]
 *   113 `transfer` payload: [0, ...RGB565 bytes (all frames concatenated)]
 *
 * The device answers `112` with a frame whose first payload byte is `>= 1`;
 * only then is the image data sent. Everything is lazy: constructing a
 * `ZetsuScreen` never touches `navigator.serial`, `open()` must run inside a
 * user gesture (`requestPort`), and `sendImage()` never closes the link.
 */

import {
  ScreenNotConnectedError,
  ScreenPermissionRequiredError,
  SerialPermissionError,
  TimeoutError,
  TransportError,
  UnsupportedError,
  UnsupportedFeatureError,
  UserCancelledError,
  ValidationError,
} from './errors.ts';
import { SerialTransport, getSerialApi } from './transport/webserial.ts';
import type { SerialPortLike } from './transport/types.ts';
import type { ProductInfo, ScreenProgress } from './types.ts';

/** Command that prepares the device for an image transfer. */
const PREPARE_COMMAND = 112;
/** Command that transfers RGB565 image bytes. */
const TRANSFER_COMMAND = 113;
const DEFAULT_ACK_TIMEOUT_MS = 2000;
const DEFAULT_SCREEN_NAME = 'gif1';
const SCREEN_NAME_LENGTH = 15;

/** One RGBA frame, as produced by `CanvasRenderingContext2D.getImageData()`. */
export interface ScreenFrame {
  readonly data: Uint8ClampedArray | Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface ZetsuScreenOptions {
  readonly product: ProductInfo;
  /**
   * When true, `ensureOpen()` tries to silently reuse a port already granted to
   * the page instead of requiring a user gesture. Defaults to `false`, matching
   * the driver, which calls `requestPort()` every time.
   */
  readonly reuseGrantedPort?: boolean;
  /**
   * Attach to an existing port instead of calling `requestPort()`. Used by the
   * tap bridge to drive a port the page already opened. The port is not opened
   * or closed by the screen handle.
   */
  readonly port?: SerialPortLike;
  /**
   * When `false` with {@link port}, the port is already open and is left open
   * on `close()`. Defaults to `true` (normal ownership).
   */
  readonly openPort?: boolean;
  readonly baudRate?: number;
  /** How long to wait for the device ACK of command 112. Defaults to 2000 ms. */
  readonly ackTimeoutMs?: number;
  readonly onDisconnect?: () => void;
}

export interface ScreenSendOptions {
  /** Frames to send, 1..`product.screen.maxFrames`. */
  readonly frames: readonly ScreenFrame[];
  /** Image name, default `gif1`. Truncated/padded to 15 bytes. */
  readonly name?: string;
  readonly onProgress?: (progress: ScreenProgress) => void;
  /**
   * Split command 113 into chunks of this many image bytes. Must be a multiple
   * of 2 so pixels are never split. Defaults to sending everything in one frame.
   */
  readonly chunkSize?: number;
}

/**
 * Lazy handle over the screen serial port. One instance per `ZetsuKeyboard`
 * (see `Keyboard.openScreen()`); operations follow the "connect keyboard HID
 * first, request the serial port only when the screen tab is opened" flow.
 */
export class ZetsuScreen {
  private readonly product: ProductInfo;
  private readonly reuseGrantedPort: boolean;
  private readonly baudRate: number;
  private readonly ackTimeoutMs: number;
  private readonly disconnectListener: (() => void) | undefined;
  private readonly externalPort: SerialPortLike | undefined;
  private readonly openPort: boolean;

  private transport: SerialTransport | null = null;
  /** True once a serial link has been opened at least once. */
  private everOpened = false;
  /** True when the link was explicitly closed or lost after being opened. */
  private linkClosed = false;

  constructor(options: ZetsuScreenOptions) {
    this.product = options.product;
    this.reuseGrantedPort = options.reuseGrantedPort ?? false;
    this.baudRate = options.baudRate ?? 115200;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.disconnectListener = options.onDisconnect;
    this.externalPort = options.port;
    this.openPort = options.openPort ?? options.port === undefined;
  }

  get isOpen(): boolean {
    return this.transport !== null && this.transport.isOpen;
  }

  get supported(): boolean {
    return this.product.isScreen;
  }

  /**
   * Requests the serial port and opens it. Must be called from a user gesture
   * (click handler) because of `navigator.serial.requestPort()`. Idempotent.
   */
  async open(): Promise<void> {
    this.assertSupported();
    if (this.isOpen) return;

    if (this.externalPort) {
      await this.attach(this.externalPort);
      return;
    }

    const serial = getSerialApi();
    if (!serial) {
      throw new UnsupportedError('Web Serial is not available in this environment');
    }

    const filters = [{ usbVendorId: this.product.vid, usbProductId: this.product.pidScreen }];
    let port: SerialPortLike;
    try {
      port = await serial.requestPort({ filters });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        throw new UserCancelledError('The serial port chooser was dismissed', { cause: error });
      }
      throw new SerialPermissionError('Could not get permission to open the screen serial port', {
        cause: error,
      });
    }

    await this.attach(port);
  }

  /**
   * Tries to reuse an already granted port without a user gesture. Returns
   * `true` when a matching port was found and opened.
   */
  async openGranted(): Promise<boolean> {
    if (this.isOpen) return true;
    if (!this.supported) return false;

    if (this.externalPort) {
      try {
        await this.attach(this.externalPort);
        return this.isOpen;
      } catch {
        this.transport = null;
        return false;
      }
    }

    const serial = getSerialApi();
    if (!serial) return false;

    let ports: SerialPortLike[];
    try {
      ports = await serial.getPorts();
    } catch {
      return false;
    }

    const port = ports.find((candidate) => this.matches(candidate));
    if (!port) return false;

    try {
      await this.attach(port);
      return this.isOpen;
    } catch {
      this.transport = null;
      return false;
    }
  }

  /**
   * Ensures the link is open without prompting unless `reuseGrantedPort` was
   * requested. Throws `ScreenPermissionRequiredError` when a user gesture is
   * still needed, and `ScreenNotConnectedError` when the link was closed after
   * having been opened.
   */
  async ensureOpen(): Promise<void> {
    if (this.isOpen) return;
    this.assertSupported();
    if (this.externalPort) {
      await this.attach(this.externalPort);
      return;
    }
    if (this.everOpened && this.linkClosed) {
      throw new ScreenNotConnectedError(
        'The screen link was closed or disconnected. Call openScreen() again from a user gesture.',
      );
    }
    if (this.reuseGrantedPort && (await this.openGranted())) return;
    throw new ScreenPermissionRequiredError();
  }

  /**
   * Sends 1..maxFrames RGBA frames: command 112, wait for the device ACK, then
   * one or more command 113 frames carrying RGB565 data. The link stays open.
   */
  async sendImage(options: ScreenSendOptions): Promise<void> {
    this.assertSupported();
    await this.ensureOpen();

    const transport = this.transport;
    if (!transport || !transport.isOpen) {
      throw new ScreenNotConnectedError('The screen serial port is not open');
    }

    const frames = options.frames;
    this.validateFrames(frames);
    const chunkSize = this.validateChunkSize(options.chunkSize);

    const name = encodeScreenName(options.name ?? DEFAULT_SCREEN_NAME, SCREEN_NAME_LENGTH);
    const image = concatBytes(frames.map((frame) => encodeRgb565(frame)));
    const totalBytes = image.length;

    const report = (progress: ScreenProgress): void => {
      options.onProgress?.(progress);
    };

    // 112: prepare. Subscribe before sending so a fast ACK is never missed.
    const preparePayload = new Uint8Array(2 + SCREEN_NAME_LENGTH);
    preparePayload[0] = 0;
    preparePayload[1] = frames.length;
    preparePayload.set(name, 2);

    report({ phase: 'prepare', percent: 0 });
    await this.sendAndWaitForAck(transport, PREPARE_COMMAND, preparePayload);
    report({ phase: 'prepare', percent: 100 });

    // 113: transfer. All frames are concatenated into one payload unless
    // `chunkSize` asks for fragmentation; every frame starts with a zero byte.
    const step = chunkSize !== undefined && chunkSize < totalBytes ? chunkSize : totalBytes;
    let sentBytes = 0;
    for (let offset = 0; offset < totalBytes; offset += step) {
      const end = Math.min(offset + step, totalBytes);
      const chunk = image.subarray(offset, end);
      const payload = new Uint8Array(1 + chunk.length);
      payload[0] = 0;
      payload.set(chunk, 1);
      await transport.sendCommand(TRANSFER_COMMAND, payload);
      sentBytes += chunk.length;
      report({
        phase: 'transfer',
        percent: totalBytes === 0 ? 100 : Math.floor((sentBytes * 100) / totalBytes),
        sentBytes,
        totalBytes,
      });
    }
  }

  /** Closes the link. Idempotent; the handle can be reopened from a gesture. */
  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (this.everOpened) this.linkClosed = true;
    if (!transport) return;

    try {
      await transport.close();
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError('Failed to close the screen link', { cause: error });
    }
  }

  private async attach(port: SerialPortLike): Promise<void> {
    const transport = new SerialTransport(port, {
      baudRate: this.baudRate,
      openPort: this.openPort,
      onDisconnect: () => {
        this.transport = null;
        this.linkClosed = true;
        this.disconnectListener?.();
      },
    });
    await transport.open();
    this.transport = transport;
    this.everOpened = true;
    this.linkClosed = false;
  }

  private assertSupported(): void {
    if (this.supported) return;
    throw new UnsupportedFeatureError(`Product "${this.product.title}" has no screen interface`);
  }

  private matches(port: SerialPortLike): boolean {
    const candidate = port as SerialPortLike & {
      getInfo?: () => { usbVendorId?: number; usbProductId?: number };
    };
    if (typeof candidate.getInfo !== 'function') return true;

    let info: { usbVendorId?: number; usbProductId?: number };
    try {
      info = candidate.getInfo();
    } catch {
      return false;
    }
    if (typeof info.usbVendorId !== 'number' || typeof info.usbProductId !== 'number') return true;
    return info.usbVendorId === this.product.vid && info.usbProductId === this.product.pidScreen;
  }

  private validateFrames(frames: readonly ScreenFrame[]): void {
    if (!Array.isArray(frames) || frames.length === 0) {
      throw new ValidationError('At least one screen frame is required');
    }
    if (frames.length > this.product.screen.maxFrames) {
      throw new ValidationError(
        `Too many screen frames: ${frames.length} (maximum ${this.product.screen.maxFrames})`,
      );
    }
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const width = this.product.screen.width;
      const height = this.product.screen.height;
      if (frame.width !== width || frame.height !== height) {
        throw new ValidationError(
          `Screen frame ${index} is ${frame.width}x${frame.height}, expected ${width}x${height}`,
        );
      }
      const expectedDataLength = frame.width * frame.height * 4;
      if (frame.data.length !== expectedDataLength) {
        throw new ValidationError(
          `Screen frame ${index} has ${frame.data.length} bytes, expected ${expectedDataLength} RGBA bytes`,
        );
      }
    }
  }

  private validateChunkSize(chunkSize: number | undefined): number | undefined {
    if (chunkSize === undefined) return undefined;
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new ValidationError(`chunkSize must be a positive integer, got ${String(chunkSize)}`);
    }
    if (chunkSize % 2 !== 0) {
      throw new ValidationError('chunkSize must be a multiple of 2 so RGB565 pixels are not split');
    }
    return chunkSize;
  }

  private async sendAndWaitForAck(
    transport: SerialTransport,
    command: number,
    payload: Uint8Array,
  ): Promise<void> {
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const ack = new Promise<void>((resolve, reject) => {
      unsubscribe = transport.subscribe((frame) => {
        if (frame.command === command && frame.payload.length > 0 && frame.payload[0] >= 1) {
          resolve();
        }
      });
      timer = setTimeout(() => {
        reject(
          new TimeoutError(`Timed out waiting for the serial ACK of command ${command}`, {
            command,
          }),
        );
      }, this.ackTimeoutMs);
    });
    // The ACK may reject while the send is still in flight; keep it handled.
    ack.catch(() => undefined);

    try {
      await transport.sendCommand(command, payload);
      await ack;
    } finally {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    }
  }
}

/** Encodes one RGBA frame to RGB565, two bytes per pixel, big-endian. */
export function encodeRgb565(frame: ScreenFrame): Uint8Array {
  const { width, height, data } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ValidationError(`Invalid screen frame size ${width}x${height}`);
  }
  if (data.length !== width * height * 4) {
    throw new ValidationError(
      `Screen frame has ${data.length} bytes, expected ${width * height * 4} RGBA bytes`,
    );
  }

  const output = new Uint8Array(width * height * 2);
  for (let source = 0, target = 0; source < data.length; source += 4, target += 2) {
    const red = data[source] >> 3;
    const green = data[source + 1] >> 2;
    const blue = data[source + 2] >> 3;
    const value = (red << 11) | (green << 5) | blue;
    output[target] = (value >> 8) & 0xff;
    output[target + 1] = value & 0xff;
  }
  return output;
}

/**
 * Encodes the 15-byte image name: Latin-1 bytes, right-padded with zeros and
 * truncated to `length`.
 */
export function encodeScreenName(name: string, length = 15): Uint8Array {
  const size = Math.max(0, Math.trunc(length));
  const output = new Uint8Array(size);
  const limit = Math.min(size, name.length);
  for (let index = 0; index < limit; index += 1) {
    const code = name.charCodeAt(index);
    output[index] = code > 0xff ? 0x3f : code;
  }
  return output;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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
