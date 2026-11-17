import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  ScreenNotConnectedError,
  ScreenPermissionRequiredError,
  SerialPermissionError,
  TimeoutError,
  UnsupportedError,
  UnsupportedFeatureError,
  UserCancelledError,
  ValidationError,
} from '../../src/errors.ts';
import { ZetsuScreen, encodeRgb565, encodeScreenName } from '../../src/screen.ts';
import type { ScreenFrame } from '../../src/screen.ts';
import { FakeSerial, FakeSerialPort } from '../../src/testing/fake-serial.ts';
import {
  decodeSerialFrames,
  encodeSerialFrame,
  getSerialApi,
  isWebSerialSupported,
} from '../../src/transport/webserial.ts';
import type { SerialLike } from '../../src/transport/types.ts';
import type { ProductInfo, ScreenProgress } from '../../src/types.ts';

const SCREEN = { width: 194, height: 368, maxFrames: 30 } as const;
const PIXEL_BYTES = SCREEN.width * SCREEN.height * 2;

const PRODUCT: ProductInfo = {
  id: 1,
  title: 'Zetsu63',
  vid: 0x3886,
  pid: 0x4001,
  pidScreen: 0x4001,
  headNum: 0xab,
  headNumScreen: 0xab,
  usage: 0,
  usagePages: [],
  cateId: 0,
  fId: 0,
  isScreen: true,
  isSideLight: false,
  fmId: 0,
  keyRange: { min: 0, max: 1, value: 0, step: 1, fixed: 0 },
  screen: SCREEN,
  layouts: {
    compact65: { mode: 'compact65', keys: [] },
    extended79: { mode: 'extended79', keys: [] },
  },
};

const NO_SCREEN: ProductInfo = { ...PRODUCT, isScreen: false };

function solidFrame(red: number, green: number, blue: number): ScreenFrame {
  const data = new Uint8ClampedArray(SCREEN.width * SCREEN.height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
    data[index + 3] = 255;
  }
  return { data, width: SCREEN.width, height: SCREEN.height };
}

const RED_FRAME = solidFrame(255, 0, 0);

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function useSerial(serial: SerialLike | null): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: serial ? { serial } : {},
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete (globalThis as { navigator?: unknown }).navigator;
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createPort(): FakeSerialPort {
  const port: FakeSerialPort = new FakeSerialPort({
    usbVendorId: PRODUCT.vid,
    usbProductId: PRODUCT.pidScreen,
    onWrite: (chunk) => {
      const { frames } = decodeSerialFrames(chunk);
      if (frames.length > 0 && frames[0].command === 112) {
        port.devicePush(encodeSerialFrame(112, [1]));
      }
    },
  });
  return port;
}

test('encodeRgb565 encodes primary colours as big-endian RGB565', () => {
  const red = encodeRgb565({ data: new Uint8ClampedArray([255, 0, 0, 255]), width: 1, height: 1 });
  const green = encodeRgb565({ data: new Uint8ClampedArray([0, 255, 0, 255]), width: 1, height: 1 });
  const blue = encodeRgb565({ data: new Uint8ClampedArray([0, 0, 255, 255]), width: 1, height: 1 });

  assert.deepEqual([...red], [0xf8, 0x00]);
  assert.deepEqual([...green], [0x07, 0xe0]);
  assert.deepEqual([...blue], [0x00, 0x1f]);
  assert.deepEqual([...encodeRgb565(RED_FRAME)].slice(0, 2), [0xf8, 0x00]);
  assert.equal(encodeRgb565(RED_FRAME).length, PIXEL_BYTES);
});

test('encodeScreenName pads and truncates to 15 bytes', () => {
  assert.deepEqual(
    [...encodeScreenName('gif1')],
    [103, 105, 102, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    [...encodeScreenName('abcdefghijklmnopqrst')],
    [97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111],
  );
  assert.deepEqual([...encodeScreenName('gif1', 2)], [103, 105]);
});

test('construction is lazy and sendImage requires a user gesture', async () => {
  const port = new FakeSerialPort({
    usbVendorId: PRODUCT.vid,
    usbProductId: PRODUCT.pidScreen,
  });
  const serial = new FakeSerial({ ports: [port] });
  useSerial(serial);

  const screen = new ZetsuScreen({ product: PRODUCT });
  assert.equal(screen.supported, true);
  assert.equal(screen.isOpen, false);
  assert.equal(serial.requestPortCalls, 0);
  assert.equal(port.openOptions, null);

  await assert.rejects(screen.sendImage({ frames: [RED_FRAME] }), ScreenPermissionRequiredError);
  assert.equal(serial.requestPortCalls, 0);
  assert.equal(port.openOptions, null);
});

test('reuseGrantedPort silently reuses a granted port', async () => {
  const port = createPort();
  const serial = new FakeSerial({ ports: [port] });
  useSerial(serial);

  const screen = new ZetsuScreen({ product: PRODUCT, reuseGrantedPort: true });
  assert.equal(await screen.openGranted(), true);
  assert.equal(screen.isOpen, true);
  assert.equal(serial.requestPortCalls, 0);

  await screen.sendImage({ frames: [RED_FRAME] });
  assert.equal(serial.requestPortCalls, 0);
  assert.equal(port.openOptions?.baudRate, 115200);
  assert.equal(port.writes.length, 2);

  await screen.close();
});

test('reuseGrantedPort still requires a gesture when no port was granted', async () => {
  useSerial(new FakeSerial({ ports: [] }));
  const screen = new ZetsuScreen({ product: PRODUCT, reuseGrantedPort: true });

  assert.equal(await screen.openGranted(), false);
  await assert.rejects(screen.sendImage({ frames: [RED_FRAME] }), ScreenPermissionRequiredError);
});

test('open then sendImage performs 112 -> ACK -> 113', async () => {
  const port = new FakeSerialPort({
    usbVendorId: PRODUCT.vid,
    usbProductId: PRODUCT.pidScreen,
  });
  const serial = new FakeSerial({ ports: [port] });
  useSerial(serial);

  const screen = new ZetsuScreen({ product: PRODUCT });
  await screen.open();

  assert.equal(screen.isOpen, true);
  assert.equal(serial.requestPortCalls, 1);
  assert.deepEqual(serial.requestPortFilters, [
    { usbVendorId: PRODUCT.vid, usbProductId: PRODUCT.pidScreen },
  ]);
  assert.deepEqual(port.openOptions, {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });

  const progress: ScreenProgress[] = [];
  const sending = screen.sendImage({
    frames: [RED_FRAME],
    onProgress: (update) => progress.push(update),
  });
  sending.catch(() => undefined);

  await waitFor(() => port.writes.length >= 1, 'prepare frame');
  const prepare = decodeSerialFrames(port.writes[0]);
  assert.equal(prepare.frames.length, 1);
  const prepareFrame = prepare.frames[0];
  assert.equal(prepareFrame.command, 112);
  assert.equal(prepareFrame.payload.length, 17);
  assert.equal(prepareFrame.payload[0], 0);
  assert.equal(prepareFrame.payload[1], 1);
  assert.deepEqual(
    [...prepareFrame.payload.slice(2)],
    [103, 105, 102, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(port.writes.length, 1, 'nothing else is written before the ACK');

  port.devicePush(encodeSerialFrame(112, [1]));
  await sending;

  assert.equal(port.writes.length, 2);
  const transfer = decodeSerialFrames(port.writes[1]);
  assert.equal(transfer.frames.length, 1);
  const transferFrame = transfer.frames[0];
  assert.equal(transferFrame.command, 113);
  assert.equal(transferFrame.payload.length, 1 + PIXEL_BYTES);
  assert.equal(transferFrame.payload[0], 0);
  assert.equal(transferFrame.payload[1], 0xf8);
  assert.equal(transferFrame.payload[2], 0x00);

  assert.deepEqual(
    progress.filter((update) => update.phase === 'prepare').map((update) => update.percent),
    [0, 100],
  );
  const transferProgress = progress.filter((update) => update.phase === 'transfer');
  const lastUpdate = transferProgress[transferProgress.length - 1];
  assert.equal(lastUpdate.percent, 100);
  assert.equal(lastUpdate.sentBytes, PIXEL_BYTES);
  assert.equal(lastUpdate.totalBytes, PIXEL_BYTES);

  assert.equal(screen.isOpen, true, 'sendImage keeps the link open');
  await screen.close();
});

test('sendImage waits for the ACK and times out', async () => {
  const port = new FakeSerialPort({
    usbVendorId: PRODUCT.vid,
    usbProductId: PRODUCT.pidScreen,
  });
  const serial = new FakeSerial({ ports: [port] });
  useSerial(serial);

  const screen = new ZetsuScreen({ product: PRODUCT, ackTimeoutMs: 20 });
  await screen.open();

  await assert.rejects(
    screen.sendImage({ frames: [RED_FRAME] }),
    (error: unknown) => error instanceof TimeoutError && error.code === 'TIMEOUT',
  );
  assert.equal(port.writes.length, 1);
  assert.equal(screen.isOpen, true);

  await screen.close();
});

test('chunkSize splits command 113 without splitting pixels', async () => {
  const port = createPort();
  const serial = new FakeSerial({ ports: [port] });
  useSerial(serial);

  const screen = new ZetsuScreen({ product: PRODUCT });
  await screen.open();

  const progress: ScreenProgress[] = [];
  const chunkSize = 8192;
  await screen.sendImage({
    frames: [RED_FRAME],
    chunkSize,
    onProgress: (update) => progress.push(update),
  });

  const expectedChunks = Math.ceil(PIXEL_BYTES / chunkSize);
  assert.equal(expectedChunks, 18);
  assert.equal(port.writes.length, 1 + expectedChunks);

  let sent = 0;
  for (let index = 1; index < port.writes.length; index += 1) {
    const { frames, rest } = decodeSerialFrames(port.writes[index]);
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].command, 113);
    assert.equal(frames[0].payload[0], 0);
    const isLast = index === port.writes.length - 1;
    assert.equal(frames[0].payload.length, 1 + (isLast ? PIXEL_BYTES % chunkSize : chunkSize));
    sent += frames[0].payload.length - 1;
  }
  assert.equal(sent, PIXEL_BYTES);

  const percents = progress
    .filter((update) => update.phase === 'transfer')
    .map((update) => update.percent);
  assert.equal(percents.length, expectedChunks);
  assert.equal(percents[percents.length - 1], 100);
  for (let index = 1; index < percents.length; index += 1) {
    assert.ok(percents[index] >= percents[index - 1], 'progress is monotonic');
  }

  await screen.close();
});

test('invalid frames and chunk sizes raise ValidationError', async () => {
  const port = createPort();
  const serial = new FakeSerial({ ports: [port] });
  useSerial(serial);

  const screen = new ZetsuScreen({ product: PRODUCT });
  await screen.open();

  await assert.rejects(screen.sendImage({ frames: [] }), ValidationError);
  await assert.rejects(
    screen.sendImage({ frames: new Array<ScreenFrame>(SCREEN.maxFrames + 1).fill(RED_FRAME) }),
    ValidationError,
  );
  await assert.rejects(
    screen.sendImage({
      frames: [{ data: RED_FRAME.data, width: 100, height: SCREEN.height }],
    }),
    ValidationError,
  );
  await assert.rejects(
    screen.sendImage({
      frames: [{ data: new Uint8Array(16), width: SCREEN.width, height: SCREEN.height }],
    }),
    ValidationError,
  );
  await assert.rejects(screen.sendImage({ frames: [RED_FRAME], chunkSize: 3 }), ValidationError);
  await assert.rejects(screen.sendImage({ frames: [RED_FRAME], chunkSize: 0 }), ValidationError);
  assert.equal(port.writes.length, 0, 'invalid input never reaches the wire');

  await screen.close();
});

test('products without a screen raise UnsupportedFeatureError', async () => {
  useSerial(new FakeSerial());
  const screen = new ZetsuScreen({ product: NO_SCREEN });

  assert.equal(screen.supported, false);
  await assert.rejects(screen.open(), UnsupportedFeatureError);
  await assert.rejects(screen.sendImage({ frames: [RED_FRAME] }), UnsupportedFeatureError);
});

test('missing Web Serial raises UnsupportedError and isWebSerialSupported is false', async () => {
  useSerial(null);
  assert.equal(isWebSerialSupported(), false);
  assert.equal(getSerialApi(), null);

  const screen = new ZetsuScreen({ product: PRODUCT });
  await assert.rejects(screen.open(), UnsupportedError);
});

test('isWebSerialSupported reports navigator.serial presence', () => {
  const serial = new FakeSerial();
  useSerial(serial);
  assert.equal(isWebSerialSupported(), true);
  assert.equal(getSerialApi(), serial);
});

test('close is idempotent and sendImage after close raises ScreenNotConnectedError', async () => {
  const port = createPort();
  const serial = new FakeSerial({ ports: [port] });
  useSerial(serial);

  const screen = new ZetsuScreen({ product: PRODUCT });
  await screen.close();
  await screen.close();
  assert.equal(screen.isOpen, false);

  await screen.open();
  assert.equal(screen.isOpen, true);
  await screen.close();
  await screen.close();
  assert.equal(screen.isOpen, false);

  await assert.rejects(screen.sendImage({ frames: [RED_FRAME] }), ScreenNotConnectedError);
});

test('a device disconnect closes the handle and calls onDisconnect', async () => {
  const port = createPort();
  const serial = new FakeSerial({ ports: [port] });
  useSerial(serial);

  let disconnects = 0;
  const screen = new ZetsuScreen({
    product: PRODUCT,
    onDisconnect: () => {
      disconnects += 1;
    },
  });

  await screen.open();
  port.deviceClose();
  await waitFor(() => disconnects === 1 && !screen.isOpen, 'screen disconnect');

  await assert.rejects(screen.sendImage({ frames: [RED_FRAME] }), ScreenNotConnectedError);
  await screen.close();
  assert.equal(disconnects, 1);
});

test('requestPort failures map to UserCancelledError or SerialPermissionError', async () => {
  const serial = new FakeSerial();
  useSerial(serial);

  const cancelled = new ZetsuScreen({ product: PRODUCT });
  serial.requestPortError = new DOMException('cancelled', 'NotFoundError');
  await assert.rejects(cancelled.open(), UserCancelledError);

  const denied = new ZetsuScreen({ product: PRODUCT });
  serial.requestPortError = new DOMException('denied', 'SecurityError');
  await assert.rejects(denied.open(), SerialPermissionError);
});
