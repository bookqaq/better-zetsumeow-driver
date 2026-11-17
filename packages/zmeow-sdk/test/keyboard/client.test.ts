/**
 * Client-level tests for {@link ZetsuKeyboard}.
 *
 * A {@link MockTransport} is injected instead of WebHID so the whole connect /
 * read / write path can be exercised under plain Node. Every device response is
 * built from the same frame builder the SDK uses, which keeps the tests honest
 * about length/CRC layout.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ZetsuKeyboard } from '../../src/keyboard.ts';
import { MockTransport } from '../../src/transport/mock.ts';
import { buildFrame } from '../../src/protocol/frame.ts';
import { ZETSU63_PRODUCT } from '../../src/generated/product-zetsu63.ts';
import { makeFakeDevice } from '../../src/testing/fake-hid.ts';
import { FakeSerial, FakeSerialPort } from '../../src/testing/fake-serial.ts';
import {
  NotConnectedError,
  TransportError,
  UnknownKeyError,
  ValidationError,
} from '../../src/errors.ts';
import { rankHidInterfaces } from '../../src/transport/webhid.ts';
import type { HidCollectionInfo } from '../../src/transport/types.ts';

type Handler = (cmd: number, sub: number, frame: Uint8Array) => Uint8Array | null;

/** Device info report: run mode app, SN + firmware version, 34-byte payload. */
function infoFrame(): Uint8Array {
  const payload = new Array<number>(34).fill(0);
  payload[1] = 1; // run mode: app
  const sn = 'SN1234567890';
  for (let index = 0; index < sn.length; index += 1) {
    payload[2 + index] = sn.charCodeAt(index);
  }
  const version = '1.2.3';
  for (let index = 0; index < version.length; index += 1) {
    payload[23 + index] = version.charCodeAt(index);
  }
  return buildFrame(1, payload);
}

interface SetupOptions {
  readonly fMode?: number | null;
  /** Extra responders keyed by command; they win over the defaults. */
  readonly extras?: Readonly<Record<number, (frame: Uint8Array) => Uint8Array>>;
}

function setup(options: SetupOptions = {}): {
  kb: ZetsuKeyboard;
  transport: MockTransport;
} {
  const device = makeFakeDevice({
    vendorId: ZETSU63_PRODUCT.vid,
    productId: ZETSU63_PRODUCT.pid,
  });
  const transport = new MockTransport({ autoOpen: true });
  const originalSend = transport.send.bind(transport);

  transport.send = async (frame: Uint8Array): Promise<void> => {
    await originalSend(frame);
    const command = frame[2] ?? 0;
    // Requests carry the cmd-2 sub command at byte 4; responses carry it at byte 5.
    const sub = frame[4] ?? 0;
    let response: Uint8Array | null = null;
    const extra = options.extras?.[command];
    if (extra) {
      response = extra(frame);
    } else if (command === 1) {
      response = infoFrame();
    } else if (command === 2 && sub === 12) {
      response = buildFrame(2, [0, 12, 1]);
    } else if (command === 2 && sub === 19) {
      response = buildFrame(2, [0, 19, options.fMode ?? 65]);
    }
    if (response) {
      const frameToEmit = response;
      queueMicrotask(() => transport.emit(frameToEmit));
    }
  };

  const kb = new ZetsuKeyboard(device, ZETSU63_PRODUCT, { transport });
  return { kb, transport };
}

async function connected(options: SetupOptions = {}): Promise<{
  kb: ZetsuKeyboard;
  transport: MockTransport;
}> {
  const context = setup(options);
  await context.kb.connect({ timeoutMs: 200, retries: 0 });
  return context;
}

function lastFrame(transport: MockTransport): Uint8Array {
  const frame = transport.sent.at(-1);
  assert.ok(frame, 'expected at least one report to be sent');
  return frame;
}

test('connect resolves compact65 when the device reports F mode 65', async () => {
  const { kb } = await connected({ fMode: 65 });
  assert.equal(kb.isConnected, true);
  assert.equal(kb.layout?.mode, 'compact65');
  assert.equal(kb.layout?.keyCount, 65);
  assert.equal(kb.keys.length, 65);
  assert.equal(kb.isFRowInstalled, false);
  assert.equal(kb.info.runModeNum, 1);
  assert.equal(kb.info.firmwareVersion, '1.2.3');
  assert.ok(kb.info.sn.startsWith('SN1234567890'));
});

test('connect resolves extended79 when the device reports F mode 79', async () => {
  const { kb } = await connected({ fMode: 79 });
  assert.equal(kb.layout?.mode, 'extended79');
  assert.equal(kb.keys.length, 79);
  assert.equal(kb.isFRowInstalled, true);
  const f1 = kb.keys.find((key) => key.textCode === 'F1');
  assert.ok(f1, 'F1 must exist in extended79');
  assert.equal(f1.isFRow, true);
  assert.equal(f1.hardCode, 0x01);
});

test('connecting never touches navigator.hid or navigator.serial', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let touched = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      get hid(): undefined {
        touched = true;
        return undefined;
      },
      get serial(): undefined {
        touched = true;
        return undefined;
      },
    },
  });
  try {
    const { kb } = await connected();
    assert.equal(touched, false);
    assert.equal(kb.screen.isOpen, false);
    assert.equal(kb.isScreenOpen, false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
});

test('openScreen before connect fails with NotConnectedError', async () => {
  const { kb } = setup();
  await assert.rejects(
    () => kb.openScreen(),
    (error: unknown) => error instanceof NotConnectedError,
  );
});

test('setLight sends the exact 13-byte report from the driver', async () => {
  const { kb, transport } = await connected();
  transport.sent.length = 0;
  await kb.setLight({
    mode: 1,
    speed: 80,
    turn: 0,
    brightness: 8,
    rgb: '#FF4570',
    colorful: 0,
  });
  const frame = lastFrame(transport);
  assert.equal(frame.length, 64);
  assert.equal(frame[0], 0xab);
  assert.equal(frame[1], 9);
  assert.equal(frame[2], 19);
  assert.equal(frame[3], (9 + 19 + 0) & 0xff);
  assert.deepEqual(Array.from(frame.subarray(4, 13)), [
    1, 1, 80, 0, 8, 255, 69, 112, 0,
  ]);
  assert.deepEqual(
    Array.from(frame.subarray(13)),
    new Array<number>(64 - 13).fill(0),
  );
});

test('setLight accepts the per-key custom mode 255', async () => {
  const { kb, transport } = await connected();
  transport.sent.length = 0;
  await kb.setLight({
    mode: 255,
    speed: 0,
    turn: 0,
    brightness: 0,
    rgb: '#000000',
    colorful: 1,
  });
  const frame = lastFrame(transport);
  assert.equal(frame[2], 19);
  assert.deepEqual(Array.from(frame.subarray(4, 13)), [1, 255, 0, 0, 0, 0, 0, 0, 1]);
});

test('setLight still rejects light modes outside 0..9 and 255', async () => {
  const { kb } = await connected();
  await assert.rejects(
    () => kb.setLight({ mode: 10 }),
    (error: unknown) => error instanceof ValidationError,
  );
  await assert.rejects(
    () => kb.setLight({ mode: 254 }),
    (error: unknown) => error instanceof ValidationError,
  );
});

test('getFeature decodes a short-declared cmd 45 reply with its parameters', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyW = kb.keys.find((key) => key.textCode === 'KeyW');
  assert.ok(keyW);
  const originalSend = transport.send.bind(transport);
  transport.send = async (frame: Uint8Array): Promise<void> => {
    await originalSend(frame);
    if (frame[2] === 47) {
      queueMicrotask(() => transport.emit(buildFrame(47, [0, keyW.hardCode, 45])));
      return;
    }
    if (frame[2] === 45 && frame[4] === 0) {
      const reply = buildFrame(45, [0, keyW.hardCode, 43, 1, 10]);
      reply[1] = 3; // the firmware declares fewer bytes than it writes
      queueMicrotask(() => transport.emit(reply));
      return;
    }
  };

  const feature = await kb.getFeature(keyW.hardCode);
  assert.deepEqual(feature, {
    hardCode: keyW.hardCode,
    kind: 'rs',
    targetHardCodes: [43],
    bottom: true,
    pauseMs: 100,
  });
});

test('setWinLock toggles like the driver instead of sending an unverified [7,1]', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  let locked = false;
  const originalSend = transport.send.bind(transport);
  transport.send = async (frame: Uint8Array): Promise<void> => {
    await originalSend(frame);
    if (frame[2] === 2 && frame[4] === 6) {
      queueMicrotask(() => transport.emit(buildFrame(2, [0, 6, locked ? 1 : 0])));
    }
  };
  const lockWrites = (): number[][] =>
    transport.sent
      .filter((frame) => frame[2] === 2 && frame[4] === 7)
      .map((frame) => Array.from(frame.subarray(4, 6)));

  // Raw toggle: byte-for-byte the frame the official driver sends.
  transport.sent.length = 0;
  await kb.setWinLock();
  assert.deepEqual(lockWrites(), [[7, 0]]);

  // Explicit true on an unlocked device: one toggle, never [7,1].
  transport.sent.length = 0;
  await kb.setWinLock(true);
  assert.deepEqual(lockWrites(), [[7, 0]]);

  // Already locked: no write at all — the driver's own state guard.
  locked = true;
  transport.sent.length = 0;
  await kb.setWinLock(true);
  assert.deepEqual(lockWrites(), []);

  // Explicit false on a locked device: toggles off.
  transport.sent.length = 0;
  await kb.setWinLock(false);
  assert.deepEqual(lockWrites(), [[7, 0]]);
});

test('remap uses the active layout for the source and the catalog for the target', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  assert.ok(keyA, 'KeyA must exist in compact65');
  transport.sent.length = 0;
  await kb.setKeyRemap('KeyA', 'F1', { layer: 1 });
  const frame = lastFrame(transport);
  assert.equal(frame[2], 35);
  assert.deepEqual(Array.from(frame.subarray(4, 9)), [
    1,
    1,
    keyA.hardCode,
    0x00,
    0x3a, // F1 HID usage 58
  ]);
});

test('compact65 rejects an F-row key as the source key', async () => {
  const { kb } = await connected({ fMode: 65 });
  await assert.rejects(
    () => kb.setMT({ key: 'F1', hold: 'ShiftLeft', tap: 'KeyA' }),
    (error: unknown) => error instanceof UnknownKeyError,
  );
});

test('extended79 accepts an F-row key as the source key', async () => {
  const { kb, transport } = await connected({ fMode: 79 });
  transport.sent.length = 0;
  await kb.setMT({ key: 'F1', hold: 'ShiftLeft', tap: 'KeyA' });
  const frame = lastFrame(transport);
  assert.equal(frame[2], 36);
  assert.equal(frame[4], 1);
  assert.equal(frame[5], 0x01);
  // time byte: 200ms / 10 = 20
  assert.equal(frame[10], 20);
});

test('RS/SOCD/END reports match the bundle payload layout', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  const keyB = kb.keys.find((key) => key.textCode === 'KeyB');
  assert.ok(keyA && keyB);

  transport.sent.length = 0;
  await kb.setRS({ key1: 'KeyA', key2: 'KeyB' });
  const rs = lastFrame(transport);
  assert.equal(rs[2], 45);
  assert.deepEqual(Array.from(rs.subarray(4, 9)), [
    1, keyA.hardCode, keyB.hardCode, 0, 1,
  ]);

  transport.sent.length = 0;
  await kb.setSOCD({ key1: 'KeyA', key2: 'KeyB' });
  const socd = lastFrame(transport);
  assert.equal(socd[2], 43);
  assert.deepEqual(Array.from(socd.subarray(4, 11)), [
    1, keyA.hardCode, 1, keyB.hardCode, 0, 0, 1,
  ]);

  transport.sent.length = 0;
  await kb.setEND({ key: 'KeyA', target: 'F1' });
  const end = lastFrame(transport);
  assert.equal(end[2], 40);
  assert.deepEqual(Array.from(end.subarray(4, 9)), [
    1, keyA.hardCode, 0x00, 0x3a, 1,
  ]);
});

test('getLight decodes the device report', async () => {
  const { kb } = await connected({
    fMode: 65,
    extras: {
      19: () => buildFrame(19, [0, 3, 70, 0, 9, 0xff, 0x45, 0x70, 1]),
    },
  });
  const light = await kb.getLight();
  assert.equal(light.mode, 3);
  assert.equal(light.speed, 70);
  assert.equal(light.brightness, 9);
  assert.equal(light.rgb, '#FF4570');
  assert.equal(light.colorful, 1);
});

test('getKeyMap only keeps keys of the active layout', async () => {
  const { kb } = await connected({
    fMode: 65,
    extras: {
      35: () => buildFrame(35, [0, 0x0e, 0x00, 0x1e, 0x0f, 0x00, 0x1f]),
    },
  });
  const map = await kb.getKeyMap(0);
  assert.equal(map.size, 2);
  assert.equal(map.get(0x0e)?.hidCode, 0x1e);
  assert.equal(map.get(0x0e)?.title, '1');
  assert.equal(map.get(0x0f)?.hidCode, 0x1f);
});

test('disconnect drops the link and later writes fail fast', async () => {
  const { kb } = await connected();
  await kb.disconnect();
  assert.equal(kb.isConnected, false);
  await assert.rejects(
    () => kb.setLight({ mode: 1 }),
    (error: unknown) => error instanceof NotConnectedError,
  );
});

test('a second connect is a no-op', async () => {
  const { kb, transport } = await connected();
  const before = transport.sent.length;
  await kb.connect({ timeoutMs: 200, retries: 0 });
  assert.equal(transport.sent.length, before);
});

test('screen is lazy: serial is untouched until openScreen, then it opens', async () => {
  const port = new FakeSerialPort({ usbVendorId: ZETSU63_PRODUCT.vid, usbProductId: ZETSU63_PRODUCT.pidScreen });
  const serial = new FakeSerial({ ports: [port] });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { serial },
  });
  try {
    const { kb } = await connected({ fMode: 65 });
    assert.equal(serial.requestPortCalls, 0, 'connect() must not touch Web Serial');
    assert.equal(kb.screen.isOpen, false);

    await kb.openScreen();
    assert.equal(serial.requestPortCalls, 1);
    assert.equal(kb.screen.isOpen, true);
    assert.deepEqual(serial.requestPortFilters, [
      { usbVendorId: ZETSU63_PRODUCT.vid, usbProductId: ZETSU63_PRODUCT.pidScreen },
    ]);

    await kb.closeScreen();
    assert.equal(kb.screen.isOpen, false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
});

test('read helpers decode misc / feature-list / travel reports', async () => {
  const { kb } = await connected({
    fMode: 65,
    extras: {
      2: (frame) => {
        const sub = frame[4] ?? 0;
        const values: Record<number, number> = { 6: 1, 9: 1, 14: 30, 16: 0, 18: 1 };
        return buildFrame(2, [0, sub, values[sub] ?? 0]);
      },
      47: () => buildFrame(47, [0, 0x0e, 36, 0x0f, 45]),
      41: () =>
        buildFrame(41, [
          1, 0x0e, 2,
          0x00, 0x64, 0x00, 0x64,
          0x03, 0xe8, 0x03, 0xe8,
          0x00, 0xfa, 0x00, 0xfa,
        ]),
    },
  });

  assert.equal(await kb.getWinLock(), true);
  assert.equal(await kb.getMacMode(), true);
  assert.equal(await kb.getLightSleep(), 30);
  assert.equal(await kb.getStatus(), false);

  const features = await kb.getFeatures();
  assert.equal(features.get(0x0e), 'mt');
  assert.equal(features.get(0x0f), 'rs');

  const travel = await kb.getTravelConfig();
  const entry = travel.get(0x0e);
  assert.ok(entry, 'travel entry for 0x0E');
  assert.equal(entry.fast, true);
  assert.equal(entry.pressMm, 0.1);
  assert.equal(entry.releaseMm, 0.025);
  assert.equal(entry.deadDownMm, 0.01);
});

test('rankHidInterfaces prefers the vendor collection with a 64-byte output report', () => {
  const boot: HidCollectionInfo = {
    usagePage: 0x01,
    usage: 0x06,
    outputReports: [{ reportId: 0, reportCount: 1, reportSize: 8 }],
  };
  const vendor: HidCollectionInfo = {
    usagePage: 0xff00,
    usage: 0x01,
    outputReports: [{ reportId: 0, reportCount: 64, reportSize: 8 }],
  };
  const bootDevice = makeFakeDevice({ collections: [boot] });
  const vendorDevice = makeFakeDevice({ collections: [vendor] });
  const ranked = rankHidInterfaces([bootDevice, vendorDevice], ZETSU63_PRODUCT);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]?.device, vendorDevice);
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
  assert.equal(ranked[0]?.outputReportBytes, 64);
});

test('connect falls back to the next HID interface when the first rejects reports', async () => {
  const bad = makeFakeDevice({
    vendorId: ZETSU63_PRODUCT.vid,
    productId: ZETSU63_PRODUCT.pid,
  });
  bad.sendReport = async (): Promise<void> => {
    throw new Error('The report length is invalid for this interface');
  };

  const good = makeFakeDevice({
    vendorId: ZETSU63_PRODUCT.vid,
    productId: ZETSU63_PRODUCT.pid,
  });
  const originalSend = good.sendReport.bind(good);
  good.sendReport = async (reportId: number, data: Uint8Array): Promise<void> => {
    await originalSend(reportId, data);
    const command = data[2] ?? 0;
    const sub = data[4] ?? 0;
    let response: Uint8Array | null = null;
    if (command === 1) response = infoFrame();
    else if (command === 2 && sub === 12) response = buildFrame(2, [0, 12, 1]);
    else if (command === 2 && sub === 19) response = buildFrame(2, [0, 19, 65]);
    if (response) {
      const frameToEmit = response;
      queueMicrotask(() => good.emitInputReport(frameToEmit));
    }
  };

  const kb = new ZetsuKeyboard(bad, ZETSU63_PRODUCT, { candidates: [bad, good] });
  await kb.connect({ timeoutMs: 200, retries: 0 });
  assert.equal(kb.isConnected, true);
  assert.equal(kb.layout?.mode, 'compact65');
  assert.equal(kb.deviceHandle, good);
});

test('getKeyMap merges every report of a multi-frame reply', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const originalSend = transport.send.bind(transport);
  transport.send = async (frame: Uint8Array): Promise<void> => {
    await originalSend(frame);
    if (frame[2] !== 35) return;
    const first = buildFrame(35, [0, 0x0e, 0x00, 0x1e, 0x0f, 0x00, 0x1f]);
    const second = buildFrame(35, [0, 0x10, 0x00, 0x20]);
    queueMicrotask(() => transport.emit(first));
    queueMicrotask(() => transport.emit(second));
  };
  const map = await kb.getKeyMap(0);
  assert.equal(map.size, 3);
  assert.equal(map.get(0x0e)?.hidCode, 0x1e);
  assert.equal(map.get(0x0f)?.hidCode, 0x1f);
  assert.equal(map.get(0x10)?.hidCode, 0x20);
});

test('getKeyMap waits past the inter-frame idle window for the first frame', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const originalSend = transport.send.bind(transport);
  transport.send = async (frame: Uint8Array): Promise<void> => {
    await originalSend(frame);
    if (frame[2] !== 35) return;
    // The device can stay busy well past the 90 ms idle window before it
    // answers (e.g. a driver page issuing its own exchanges on a shared
    // handle); the first frame must be bounded by maxMs, not idleMs.
    const first = buildFrame(35, [0, 0x0e, 0x00, 0x1e, 0x0f, 0x00, 0x1f]);
    const second = buildFrame(35, [0, 0x10, 0x00, 0x20]);
    setTimeout(() => {
      transport.emit(first);
      transport.emit(second);
    }, 120);
  };
  const map = await kb.getKeyMap(0);
  assert.equal(map.size, 3);
  assert.equal(map.get(0x0e)?.hidCode, 0x1e);
});

test('getKeyMap retries a timed-out read once', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const originalSend = transport.send.bind(transport);
  let remapRequests = 0;
  transport.send = async (frame: Uint8Array): Promise<void> => {
    await originalSend(frame);
    if (frame[2] !== 35) return;
    remapRequests += 1;
    if (remapRequests < 2) return; // first read: the device stays silent
    transport.emit(buildFrame(35, [0, 0x0e, 0x00, 0x1e]));
  };
  const map = await kb.getKeyMap(0);
  assert.equal(remapRequests, 2);
  assert.equal(map.get(0x0e)?.hidCode, 0x1e);
});

test('getFeatures retries a timed-out read once', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const originalSend = transport.send.bind(transport);
  let featureRequests = 0;
  transport.send = async (frame: Uint8Array): Promise<void> => {
    await originalSend(frame);
    if (frame[2] !== 47) return;
    featureRequests += 1;
    if (featureRequests < 2) return; // first read: the device stays silent
    transport.emit(buildFrame(47, [0, 0x0e, 36, 0x0f, 45]));
  };
  const features = await kb.getFeatures();
  assert.equal(featureRequests, 2);
  assert.equal(features.get(0x0e), 'mt');
  assert.equal(features.get(0x0f), 'rs');
});

test('key test reports become keyTravel / keyRelease events', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const events: Array<{ kind: string; hardCode: number; mm?: number }> = [];
  kb.on('keyTravel', (event) => events.push({ kind: 'travel', hardCode: event.hardCode, mm: event.mm }));
  kb.on('keyRelease', (event) => events.push({ kind: 'release', hardCode: event.hardCode }));

  await kb.startKeyTest({ mode: 'stroke' });

  const press = buildFrame(48, [0, 0x2a, 0x03, 0xe8]);
  press[1] = 3; // short declared length, exactly like the device
  transport.emit(press);
  transport.emit(buildFrame(48, [0, 0x2a, 0xff, 0xff]));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(events, [
    { kind: 'travel', hardCode: 0x2a, mm: 0.1 },
    { kind: 'release', hardCode: 0x2a },
  ]);
  await kb.stopKeyTest();
});

test('setKeyTravel writes exactly one key entry', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  assert.ok(keyA);
  transport.sent.length = 0;
  await kb.setKeyTravel('KeyA', {
    pressMm: 2.4,
    releaseMm: 1.6,
    deadDownMm: 0.2,
    deadUpMm: 0.2,
    fastOutMm: 0,
    fast: false,
  });
  const frame = lastFrame(transport);
  assert.equal(frame[2], 41);
  assert.equal(frame[5], 1, 'total count is one key');
  assert.equal(frame[6], keyA.hardCode);
  assert.equal(frame[7], 1, 'type 1 = normal key');
  const travel = ((frame[12] ?? 0) << 8) | (frame[13] ?? 0);
  assert.equal(travel, 24000, '2.4mm in micrometres');
});

test('setTravelConfig splits batches and applies the official cmd 41 settle', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const entries = kb.keys.slice(0, 5).map((key) => ({
    key: key.textCode,
    pressMm: 2,
    releaseMm: 2,
  }));
  transport.sent.length = 0;

  const started = Date.now();
  await kb.setTravelConfig(entries);
  const elapsed = Date.now() - started;

  const writes = transport.sent.filter((frame) => frame[2] === 41);
  assert.equal(writes.length, 2, 'five keys split into 4 + 1');
  assert.equal(writes[0]![1], 4 * 14 + 2);
  assert.equal(writes[1]![1], 1 * 14 + 2);
  assert.equal(writes[0]![5], 5, 'total count stays 5 on every frame');
  assert.equal(writes[1]![5], 5);
  // Official pacing: 10 ms lead + 2 * 5 ms chunk gap + (2 * 10 + 100) ms settle.
  assert.ok(elapsed >= 130, `official cmd 41 pacing should take >= 130ms, took ${elapsed}ms`);
});

test('resetKeyRemap writes the key default usage and can clear it', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  const keyB = kb.keys.find((key) => key.textCode === 'KeyB');
  assert.ok(keyA && keyB);

  transport.sent.length = 0;
  const written = await kb.resetKeyRemap('KeyA', { layer: 0 });
  assert.deepEqual(written, [keyA.hardCode]);
  const frame = lastFrame(transport);
  assert.equal(frame[2], 35);
  assert.deepEqual(Array.from(frame.subarray(4, 9)), [
    1,
    0,
    keyA.hardCode,
    0,
    keyA.hidCode & 0xff,
  ]);

  transport.sent.length = 0;
  await kb.resetKeyRemap(['KeyA', 'KeyB'], { layer: 1, mode: 'none' });
  assert.equal(transport.sent.length, 2);
  for (const sent of transport.sent) {
    assert.equal(sent[2], 35);
    assert.equal(sent[4], 1);
    assert.equal(sent[5], 1, 'layer 1');
    assert.equal(sent[7], 0, 'cleared usage high byte');
    assert.equal(sent[8], 0, 'cleared usage low byte');
  }
});

interface RemapDeviceState {
  readonly tables: Map<number, Map<number, number>>;
  readonly writes: Array<{ layer: number; hardCode: number; usage: number }>;
  /** Number of remap writes the fake firmware silently drops (acknowledged, not applied). */
  dropWrites: number;
}

/**
 * Attach a mutable `cmd 35` remap table to the mock transport, so capture and
 * restore can be tested against a device that remembers what was written.
 */
function attachRemapDevice(transport: MockTransport): RemapDeviceState {
  const tables = new Map<number, Map<number, number>>();
  const writes: Array<{ layer: number; hardCode: number; usage: number }> = [];
  const state: RemapDeviceState = { tables, writes, dropWrites: 0 };
  const tableOf = (layer: number): Map<number, number> => {
    let table = tables.get(layer);
    if (!table) {
      table = new Map();
      tables.set(layer, table);
    }
    return table;
  };
  const originalSend = transport.send.bind(transport);
  transport.send = async (frame: Uint8Array): Promise<void> => {
    await originalSend(frame);
    if (frame[2] !== 35) return;
    const action = frame[4] ?? 0;
    const layer = frame[5] ?? 0;
    if (action === 1) {
      const hardCode = frame[6] ?? 0;
      const usage = ((frame[7] ?? 0) << 8) | (frame[8] ?? 0);
      writes.push({ layer, hardCode, usage });
      if (state.dropWrites > 0) {
        // Acknowledge but do not commit, exactly like the hardware sometimes does.
        state.dropWrites -= 1;
      } else {
        tableOf(layer).set(hardCode, usage);
      }
      queueMicrotask(() => transport.emit(buildFrame(35, [layer, 0, hardCode])));
      return;
    }
    const payload = [layer];
    for (const [hardCode, usage] of [...tableOf(layer)].slice(0, 10)) {
      payload.push(hardCode, usage >> 8, usage & 0xff);
    }
    queueMicrotask(() => transport.emit(buildFrame(35, payload)));
  };
  return state;
}

test('captureRemapSnapshot records the requested layers as plain data', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  const keyB = kb.keys.find((key) => key.textCode === 'KeyB');
  assert.ok(keyA && keyB);
  const device = attachRemapDevice(transport);
  device.tables.set(0, new Map([[keyA.hardCode, 0x04], [keyB.hardCode, 0x05]]));
  device.tables.set(1, new Map([[keyA.hardCode, 0x00]]));

  transport.sent.length = 0;
  const snapshot = await kb.captureRemapSnapshot({ layers: [0, 1] });

  assert.equal(snapshot.layout, 'compact65');
  assert.deepEqual(snapshot.layers[0], { [keyA.hardCode]: 0x04, [keyB.hardCode]: 0x05 });
  assert.deepEqual(snapshot.layers[1], { [keyA.hardCode]: 0x00 });
  assert.ok(Number.isFinite(snapshot.takenAt));
  const layerReads = transport.sent
    .filter((frame) => frame[2] === 35 && frame[4] === 0)
    .map((frame) => frame[5]);
  assert.deepEqual(layerReads, [0, 1], 'one read series per requested layer');
});

test('restoreRemapSnapshot writes only the keys that differ', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  const keyB = kb.keys.find((key) => key.textCode === 'KeyB');
  assert.ok(keyA && keyB);
  const device = attachRemapDevice(transport);
  device.tables.set(0, new Map([[keyA.hardCode, 0x04], [keyB.hardCode, 0x05]]));

  const snapshot = await kb.captureRemapSnapshot({ layers: [0] });
  // The user remaps KeyA afterwards; KeyB is untouched.
  device.tables.get(0)?.set(keyA.hardCode, 0x3a);

  device.writes.length = 0;
  const result = await kb.restoreRemapSnapshot(snapshot, { settleMs: 0 });

  assert.equal(result.written, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.entries, [
    {
      layer: 0,
      hardCode: keyA.hardCode,
      title: keyA.title,
      textCode: keyA.textCode,
      from: 0x3a,
      to: 0x04,
    },
  ]);
  assert.deepEqual(device.writes, [{ layer: 0, hardCode: keyA.hardCode, usage: 0x04 }]);
  assert.equal(device.tables.get(0)?.get(keyA.hardCode), 0x04, 'device table restored');
  assert.equal(device.tables.get(0)?.get(keyB.hardCode), 0x05, 'untouched key kept');
});

test('restoreRemapSnapshot dryRun reports the diff without writing', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  assert.ok(keyA);
  const device = attachRemapDevice(transport);
  device.tables.set(0, new Map([[keyA.hardCode, 0x04]]));

  const snapshot = await kb.captureRemapSnapshot({ layers: [0] });
  device.tables.get(0)?.set(keyA.hardCode, 0x3a);
  device.writes.length = 0;

  const result = await kb.restoreRemapSnapshot(snapshot, { dryRun: true });
  assert.equal(result.written, 1);
  assert.deepEqual(device.writes, [], 'dryRun must not write');
  assert.equal(device.tables.get(0)?.get(keyA.hardCode), 0x3a);
});

test('restoreRemapSnapshot can be limited to selected keys', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  const keyB = kb.keys.find((key) => key.textCode === 'KeyB');
  assert.ok(keyA && keyB);
  const device = attachRemapDevice(transport);
  device.tables.set(0, new Map([[keyA.hardCode, 0x04], [keyB.hardCode, 0x05]]));

  const snapshot = await kb.captureRemapSnapshot({ layers: [0] });
  device.tables.get(0)?.set(keyA.hardCode, 0x3a);
  device.tables.get(0)?.set(keyB.hardCode, 0x3b);

  const result = await kb.restoreRemapSnapshot(snapshot, { keys: ['KeyB'] });
  assert.equal(result.written, 1);
  assert.equal(result.entries[0]?.textCode, 'KeyB');
  assert.equal(device.tables.get(0)?.get(keyA.hardCode), 0x3a, 'unselected key kept');
  assert.equal(device.tables.get(0)?.get(keyB.hardCode), 0x05);
});

test('restoreRemapSnapshot rejects a snapshot from another layout', async () => {
  const { kb } = await connected({ fMode: 65 });
  const snapshot = {
    takenAt: 1,
    layout: 'extended79',
    layers: {},
  } as const;
  await assert.rejects(
    () => kb.restoreRemapSnapshot(snapshot),
    (error: unknown) => error instanceof ValidationError && /extended79/.test(error.message),
  );
});

test('setKeyRemap verify rewrites a report the device silently dropped', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  assert.ok(keyA);
  const device = attachRemapDevice(transport);
  device.tables.set(0, new Map([[keyA.hardCode, 0x04]]));
  device.writes.length = 0;
  device.dropWrites = 1;

  await kb.setKeyRemap('KeyA', 'F1', { layer: 0, verify: true, settleMs: 0 });

  assert.equal(device.tables.get(0)?.get(keyA.hardCode), 0x3a);
  assert.deepEqual(device.writes, [
    { layer: 0, hardCode: keyA.hardCode, usage: 0x3a },
    { layer: 0, hardCode: keyA.hardCode, usage: 0x3a },
  ]);
});

test('setKeyRemap verify rejects when the device keeps the old mapping', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  assert.ok(keyA);
  const device = attachRemapDevice(transport);
  device.tables.set(0, new Map([[keyA.hardCode, 0x04]]));
  device.dropWrites = 10;

  await assert.rejects(
    () => kb.setKeyRemap('KeyA', 'F1', { layer: 0, verify: true, settleMs: 0 }),
    (error: unknown) => error instanceof TransportError,
  );
  assert.equal(device.tables.get(0)?.get(keyA.hardCode), 0x04);
});

test('resetKeyRemap verify retries a dropped report', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  assert.ok(keyA);
  const device = attachRemapDevice(transport);
  device.tables.set(0, new Map([[keyA.hardCode, 0x3a]]));
  device.writes.length = 0;
  device.dropWrites = 1;

  const written = await kb.resetKeyRemap('KeyA', { layer: 0, verify: true });

  assert.deepEqual(written, [keyA.hardCode]);
  assert.equal(device.tables.get(0)?.get(keyA.hardCode), 0x04);
  assert.equal(device.writes.length, 2, 'dropped once, then retried');
});

test('restoreRemapSnapshot verify rewrites a dropped write in a batch restore', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  const keyB = kb.keys.find((key) => key.textCode === 'KeyB');
  assert.ok(keyA && keyB);
  const device = attachRemapDevice(transport);
  device.tables.set(0, new Map([[keyA.hardCode, 0x04], [keyB.hardCode, 0x05]]));
  device.writes.length = 0;
  device.dropWrites = 1; // the first write of the batch is dropped

  const snapshot = {
    takenAt: 1,
    layout: 'compact65' as const,
    layers: { 0: { [keyA.hardCode]: 0x3a, [keyB.hardCode]: 0x3b } },
  };
  const result = await kb.restoreRemapSnapshot(snapshot, { verify: true, settleMs: 0 });

  assert.equal(result.written, 2);
  assert.equal(device.tables.get(0)?.get(keyA.hardCode), 0x3a);
  assert.equal(device.tables.get(0)?.get(keyB.hardCode), 0x3b);
  assert.equal(device.writes.length, 3, 'A dropped, A rewritten, then B');
});

test('restoreRemapSnapshot paces batch writes with writeGapMs', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA');
  const keyB = kb.keys.find((key) => key.textCode === 'KeyB');
  assert.ok(keyA && keyB);
  const device = attachRemapDevice(transport);
  device.tables.set(0, new Map([[keyA.hardCode, 0x04], [keyB.hardCode, 0x05]]));

  const snapshot = {
    takenAt: 1,
    layout: 'compact65' as const,
    layers: { 0: { [keyA.hardCode]: 0x3a, [keyB.hardCode]: 0x3b } },
  };
  const started = Date.now();
  await kb.restoreRemapSnapshot(snapshot, { writeGapMs: 60 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 60, `second write must wait for the gap, took ${elapsed}ms`);
  assert.deepEqual(device.writes, [
    { layer: 0, hardCode: keyA.hardCode, usage: 0x3a },
    { layer: 0, hardCode: keyB.hardCode, usage: 0x3b },
  ]);
});

test('disconnect ends a running key test before closing the link', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  await kb.startKeyTest({ mode: 'stroke' });
  assert.equal(kb.activeKeyTest, 'stroke');

  transport.sent.length = 0;
  await kb.disconnect();

  const testFrames = transport.sent.filter((frame) => frame[2] === 2);
  assert.equal(testFrames.length, 1);
  assert.deepEqual(Array.from(testFrames[0]!.subarray(4, 6)), [4, 0xff]);
  assert.equal(kb.activeKeyTest, null);
});

test('disconnect does not touch the key-test stream when no test is running', async () => {
  const { kb, transport } = await connected({ fMode: 65 });
  transport.sent.length = 0;
  await kb.disconnect();
  assert.equal(transport.sent.filter((frame) => frame[2] === 2).length, 0);
});

test('setKeyColors packs up to 11 keys per cmd 20 report', async () => {
  const { kb, transport } = await connected();
  transport.sent.length = 0;
  const keys = kb.keys.slice(0, 12).map((key) => key.textCode);
  await kb.setKeyColors(keys.map((key) => ({ key, color: '#112233', brightness: 7 })));
  assert.equal(transport.sent.length, 2);
  assert.deepEqual(Array.from(transport.sent[0]!.subarray(4, 7)), [1, 12, 14]);
  assert.equal(transport.sent[0]![2], 20);
  assert.equal(transport.sent[0]![1], 5 * 11 + 2);
  assert.equal(transport.sent[1]![1], 5 * 1 + 2);
});

test('setTravelConfig validates against the per-key 0.01..4mm switch range', async () => {
  const { kb, transport } = await connected();
  transport.sent.length = 0;
  // The official UI slider stops at 3.1mm, but the switches span 0..4mm.
  await kb.setTravelConfig([{ key: 'KeyA', pressMm: 4, releaseMm: 4 }]);
  const write = transport.sent.find((frame) => frame[2] === 41);
  assert.ok(write, 'expected a cmd 41 travel report');
  const keyA = kb.keys.find((key) => key.textCode === 'KeyA')!;
  assert.equal(write[6], keyA.hardCode);
  // press 4 mm -> 40000 µm -> 0x9c 0x40 at frame bytes 12..13
  assert.deepEqual(Array.from(write.subarray(12, 14)), [0x9c, 0x40]);

  await assert.rejects(
    kb.setTravelConfig([{ key: 'KeyA', pressMm: 4.5, releaseMm: 4.5 }]),
    (error: unknown) =>
      error instanceof ValidationError &&
      /out of range 0\.01\.\.4/.test((error as Error).message),
  );
  await assert.rejects(
    kb.setTravelConfig([{ key: 'KeyA', pressMm: 0.005, releaseMm: 0.005 }]),
    (error: unknown) => error instanceof ValidationError,
  );
});

test('setTravelConfig writes split press/release RT travel', async () => {
  const { kb, transport } = await connected();
  transport.sent.length = 0;
  await kb.setTravelConfig([
    {
      key: 'KeyA',
      pressMm: 2.4,
      releaseMm: 1.6,
      travelDownMm: 0.8,
      travelUpMm: 1.2,
      fast: true,
    },
  ]);
  const write = transport.sent.find((frame) => frame[2] === 41)!;
  assert.equal(write[7], 2, 'type 2 = fast trigger');
  assert.deepEqual(Array.from(write.subarray(16, 18)), [0x2e, 0xe0]); // travelUp 1.2mm
  assert.deepEqual(Array.from(write.subarray(18, 20)), [0x1f, 0x40]); // travelDown 0.8mm
});

test('setTravelConfig quantises values onto the firmware 0.01mm grid', async () => {
  const { kb, transport } = await connected();
  transport.sent.length = 0;
  await kb.setTravelConfig([{ key: 'KeyA', pressMm: 1.2345, releaseMm: 2.3456 }]);
  const write = transport.sent.find((frame) => frame[2] === 41)!;
  assert.deepEqual(Array.from(write.subarray(12, 14)), [0x30, 0x0c]); // 12300 = 1.23mm
  // travelUp/travelDown both carry the quantised release point.
  assert.deepEqual(Array.from(write.subarray(16, 18)), [0x5b, 0xcc]); // 23500 = 2.35mm
  assert.deepEqual(Array.from(write.subarray(18, 20)), [0x5b, 0xcc]);
});
