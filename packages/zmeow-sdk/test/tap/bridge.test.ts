import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ZetsuTap } from '../../src/tap/bridge.ts';
import { buildFrame } from '../../src/protocol/frame.ts';
import { ZETSU63_PRODUCT } from '../../src/generated/product-zetsu63.ts';
import { FakeHid, FakeHidDevice } from '../../src/testing/fake-hid.ts';
import { FakeSerial, FakeSerialPort } from '../../src/testing/fake-serial.ts';
import type { HidDeviceLike, SerialPortLike } from '../../src/transport/types.ts';
import type { TapEnvironment } from '../../src/tap/types.ts';

function infoFrame(): Uint8Array {
  const payload = new Array<number>(34).fill(0);
  payload[1] = 1;
  for (const [index, char] of [...'SN1234567890'].entries()) {
    payload[2 + index] = char.charCodeAt(0);
  }
  for (const [index, char] of [...'1.1.1'].entries()) {
    payload[23 + index] = char.charCodeAt(0);
  }
  return buildFrame(1, payload);
}

interface DeviceBag {
  readonly device: FakeHidDevice;
  readonly port: FakeSerialPort;
}

function makeDeviceBag(): DeviceBag {
  let device: FakeHidDevice;
  device = new FakeHidDevice({
    vendorId: ZETSU63_PRODUCT.vid,
    productId: ZETSU63_PRODUCT.pid,
    opened: true,
    onSend: (frame) => {
      const command = frame[2] ?? 0;
      const sub = frame[4] ?? 0;
      let response: Uint8Array | null = null;
      if (command === 1) response = infoFrame();
      else if (command === 2 && sub === 12) response = buildFrame(2, [0, 12, 1]);
      else if (command === 2 && sub === 19) response = buildFrame(2, [0, 19, 65]);
      if (response) queueMicrotask(() => device.emitInputReport(response!));
    },
  });
  const port = new FakeSerialPort({
    usbVendorId: ZETSU63_PRODUCT.vid,
    usbProductId: ZETSU63_PRODUCT.pidScreen,
  });
  return { device, port };
}

function environment(bag: DeviceBag): TapEnvironment {
  return {
    hid: new FakeHid({ devices: [bag.device] }),
    serial: new FakeSerial({ defaultPort: bag.port }),
    hidDevice: { prototype: FakeHidDevice.prototype },
    serialPort: { prototype: FakeSerialPort.prototype },
    document: null,
    fetch: null,
    crypto: null,
  };
}

function installProductTable(bag: DeviceBag, port: FakeSerialPort): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'data');
  const value = {
    keys_product_list: [
      {
        id: ZETSU63_PRODUCT.id,
        title: ZETSU63_PRODUCT.title,
        vid: ZETSU63_PRODUCT.vid,
        pid: ZETSU63_PRODUCT.pid,
        pid_screen: ZETSU63_PRODUCT.pidScreen,
        usage: ZETSU63_PRODUCT.usage,
        usagePage: ZETSU63_PRODUCT.usagePages.join(','),
        head_num: `0x${ZETSU63_PRODUCT.headNum.toString(16)}`,
        head_num_screen: `0x${ZETSU63_PRODUCT.headNumScreen.toString(16)}`,
        cate_id: ZETSU63_PRODUCT.cateId,
        f_id: ZETSU63_PRODUCT.fId,
        fm_id: ZETSU63_PRODUCT.fmId,
      },
    ],
    select_product_list: [bag.device],
    serial_port: port,
  };
  Object.defineProperty(globalThis, 'data', {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'data', previous);
    else delete (globalThis as { data?: unknown }).data;
  };
}

test('ZetsuTap captures devices from the injected page window (Tampermonkey sandbox)', async () => {
  const bag = makeDeviceBag();
  // The device record lives ONLY on the fake page window — the sandbox's own
  // globalThis has no `data`, mirroring an isolated userscript world.
  const pageWindow = {
    data: {
      keys_product_list: [],
      select_product_list: [bag.device],
      serial_port: bag.port,
    },
  };
  const tap = await ZetsuTap.install({
    environment: { ...environment(bag), window: pageWindow },
    autoFingerprint: false,
  });
  try {
    // start() polls the page window immediately; the matching device/port on
    // the fake page window must be captured even though globalThis.data is
    // absent.
    assert.equal(tap.status.hid.connected, true);
    assert.equal(tap.status.serial.attached, true);
  } finally {
    await tap.stop();
  }
});

test('ZetsuTap reports idle with no device and active once a handle is captured', async () => {
  const bag = makeDeviceBag();
  bag.device.opened = false;
  const restoreData = installProductTable(bag, bag.port);
  const tap = await ZetsuTap.install({
    environment: environment(bag),
    autoFingerprint: false,
  });
  try {
    const idle = tap.status;
    assert.equal(idle.state, 'idle');
    assert.equal(idle.hid.attached, true);
    assert.equal(idle.serial.attached, true);

    bag.device.opened = true;
    tap.captureDevice(bag.device);
    assert.equal(tap.status.state, 'active');
    assert.equal(tap.status.hid.connected, true);
  } finally {
    await tap.stop();
    restoreData();
  }
});

test('ZetsuTap active keyboard shares the page handle and does not close it', async () => {
  const bag = makeDeviceBag();
  const restoreData = installProductTable(bag, bag.port);
  const tap = await ZetsuTap.install({
    environment: environment(bag),
    autoFingerprint: false,
  });
  try {
    const keyboard = await tap.connectKeyboard({ timeoutMs: 200, retries: 0 });
    assert.equal(keyboard.isConnected, true);
    assert.equal(keyboard.layout?.mode, 'compact65');
    assert.equal(bag.device.closeCalls, 0);

    await keyboard.disconnect();
    assert.equal(bag.device.opened, true);
    assert.equal(bag.device.closeCalls, 0);

    const again = await tap.connectKeyboard({ timeoutMs: 200, retries: 0 });
    assert.notEqual(again, keyboard);
    await again.disconnect();
  } finally {
    await tap.stop();
    restoreData();
  }
});

test('ZetsuTap active screen reuses the page serial port without closing it', async () => {
  const bag = makeDeviceBag();
  await bag.port.open({ baudRate: 115200 });
  const restoreData = installProductTable(bag, bag.port);
  const tap = await ZetsuTap.install({
    environment: environment(bag),
    autoFingerprint: false,
  });
  try {
    const screen = await tap.connectScreen();
    assert.equal(screen.isOpen, true);
    assert.equal(bag.port.isOpen, true);
    await screen.close();
    assert.equal(bag.port.isOpen, true);
  } finally {
    await tap.stop();
    restoreData();
  }
});

test('tap-only mode rejects active connections', async () => {
  const bag = makeDeviceBag();
  const restoreData = installProductTable(bag, bag.port);
  const tap = await ZetsuTap.install({
    mode: 'tap',
    environment: environment(bag),
    autoFingerprint: false,
  });
  try {
    await assert.rejects(
      () => tap.connectKeyboard(),
      (error: unknown) =>
        error instanceof Error && error.message.includes('tap-only'),
    );
  } finally {
    await tap.stop();
    restoreData();
  }
});

test('status validates the page product table and detects a mismatch', async () => {
  const bag = makeDeviceBag();
  const restoreData = installProductTable(bag, bag.port);
  const tap = await ZetsuTap.install({
    environment: environment(bag),
    autoFingerprint: false,
  });
  try {
    await tap.refreshFingerprint();
    assert.equal(tap.status.fingerprint.productOk, true);

    (globalThis as unknown as { data: { keys_product_list: Array<Record<string, unknown>> } }).data.keys_product_list[0]!.vid = 0x1234;
    await tap.refreshFingerprint();
    assert.equal(tap.status.fingerprint.productOk, false);
    assert.equal(tap.status.state, 'disabled');
  } finally {
    await tap.stop();
    restoreData();
  }
});

test('active keyboard works with a device captured from window.data', async () => {
  const bag = makeDeviceBag();
  const restoreData = installProductTable(bag, bag.port);
  const tap = await ZetsuTap.install({
    environment: environment(bag),
    autoFingerprint: false,
  });
  try {
    const device: HidDeviceLike = bag.device;
    const port: SerialPortLike = bag.port;
    assert.equal(tap.status.hid.device, device);
    assert.equal(tap.status.serial.port, port);
    const keyboard = await tap.connectKeyboard({ timeoutMs: 200, retries: 0 });
    assert.equal(keyboard.deviceHandle, device);
  } finally {
    await tap.stop();
    restoreData();
  }
});

test('an adapter can supply version-specific write hooks', async () => {
  const bag = makeDeviceBag();
  const restoreData = installProductTable(bag, bag.port);
  const replacement = buildFrame(2, [0, 19, 79]);
  const tap = await ZetsuTap.install({
    environment: environment(bag),
    autoFingerprint: false,
    adapter: {
      id: 'test-adapter',
      hooks: {
        onHidOut: (frame) => (frame.command === 2 ? replacement : undefined),
      },
    },
  });
  try {
    assert.equal(tap.status.adapterId, 'test-adapter');
    await bag.device.sendReport(0, buildFrame(2, [0, 19, 65]));
    assert.deepEqual([...(bag.device.sent.at(-1) ?? [])], [...replacement]);
  } finally {
    await tap.stop();
    restoreData();
  }
});

test('an unknown driver resource leaves the bridge readonly', async () => {
  const bag = makeDeviceBag();
  const restoreData = installProductTable(bag, bag.port);
  const doc = {
    querySelector(selector: string) {
      if (selector === 'script[type="module"][src]') {
        return { src: 'https://driver.test/index-unknown.js' };
      }
      if (selector.includes('/hid-')) {
        return { href: 'https://driver.test/hid-unknown.js' };
      }
      return null;
    },
  } as unknown as Document;
  const env: TapEnvironment = {
    ...environment(bag),
    document: doc,
    fetch: (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch,
    crypto: globalThis.crypto,
  };
  const tap = await ZetsuTap.install({
    environment: env,
    autoFingerprint: false,
  });
  try {
    tap.captureDevice(bag.device);
    await tap.refreshFingerprint();
    assert.equal(tap.status.fingerprint.checked, true, JSON.stringify(tap.status.fingerprint));
    assert.equal(tap.status.fingerprint.hashKnown, false);
    assert.equal(tap.status.state, 'readonly');
  } finally {
    await tap.stop();
    restoreData();
  }
});
