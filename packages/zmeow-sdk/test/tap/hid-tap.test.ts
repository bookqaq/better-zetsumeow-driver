import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HidTap } from '../../src/tap/hid-tap.ts';
import { buildFrame } from '../../src/protocol/frame.ts';
import { ZETSU63_PRODUCT } from '../../src/generated/product-zetsu63.ts';
import { FakeHidDevice } from '../../src/testing/fake-hid.ts';
import type { HidDeviceConstructorLike } from '../../src/tap/types.ts';

function makeTap(onHooks: Parameters<HidTap['setHooks']>[0] = {}): {
  tap: HidTap;
  device: FakeHidDevice;
} {
  const tap = new HidTap({
    product: { vid: ZETSU63_PRODUCT.vid, pid: ZETSU63_PRODUCT.pid },
    deviceCtor: { prototype: FakeHidDevice.prototype } as unknown as HidDeviceConstructorLike,
    hooks: onHooks,
  });
  tap.install();
  const device = new FakeHidDevice({
    vendorId: ZETSU63_PRODUCT.vid,
    productId: ZETSU63_PRODUCT.pid,
    opened: true,
  });
  tap.captureDevice(device);
  return { tap, device };
}

test('HID tap rewrites an outgoing report and preserves the 64-byte size', async () => {
  const original = buildFrame(19, [1, 1, 80, 0, 8, 255, 69, 112, 0]);
  const replacement = buildFrame(19, [1, 1, 20, 0, 4, 0, 255, 0, 0]);
  const { tap, device } = makeTap({
    onHidOut: () => replacement,
  });
  try {
    await device.sendReport(0, original);
    assert.deepEqual([...(device.sent.at(-1) ?? [])], [...replacement]);
  } finally {
    tap.stop();
  }
});

test('HID tap drops an outgoing report when the hook returns null', async () => {
  const { tap, device } = makeTap({ onHidOut: () => null });
  try {
    await device.sendReport(0, buildFrame(19, [1, 1, 80, 0, 8, 255, 69, 112, 0]));
    assert.equal(device.sent.length, 0);
  } finally {
    tap.stop();
  }
});

test('HID tap observes and rewrites the oninputreport property handler', () => {
  const incoming = buildFrame(2, [0, 19, 65]);
  const replacement = buildFrame(2, [0, 19, 79]);
  const { tap, device } = makeTap({
    onHidIn: (frame) => {
      assert.equal(frame.command, 2);
      return replacement;
    },
  });
  try {
    let received: Uint8Array | null = null;
    device.oninputreport = (event) => {
      const data = (event as { data: DataView }).data;
      received = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    };
    device.emitInputReport(incoming);
    assert.deepEqual([...(received ?? [])], [...replacement]);
    assert.equal(tap.counts.in, 1);
  } finally {
    tap.stop();
  }
});

test('HID tap also wraps addEventListener inputreport listeners', () => {
  const incoming = buildFrame(2, [0, 12, 1]);
  let seen = 0;
  const { tap, device } = makeTap({
    onHidIn: () => {
      seen += 1;
      return undefined;
    },
  });
  try {
    let received: Uint8Array | null = null;
    const listener = (event: unknown): void => {
      const data = (event as { data: DataView }).data;
      received = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    };
    device.addEventListener('inputreport', listener);
    device.emitInputReport(incoming);
    assert.equal(seen, 1);
    assert.deepEqual([...(received ?? [])], [...incoming]);
    device.removeEventListener('inputreport', listener);
  } finally {
    tap.stop();
  }
});

test('HID tap passes non-target devices through untouched', async () => {
  let called = 0;
  const { tap } = makeTap({
    onHidOut: () => {
      called += 1;
      return null;
    },
  });
  const other = new FakeHidDevice({ vendorId: 0x1234, productId: 0x5678, opened: true });
  try {
    await other.sendReport(0, buildFrame(19, [1, 1, 80, 0, 8, 255, 69, 112, 0]));
    assert.equal(called, 0);
    assert.equal(other.sent.length, 1);
  } finally {
    tap.stop();
  }
});

test('stopping a HID tap restores sendReport', async () => {
  const { tap, device } = makeTap({ onHidOut: () => null });
  tap.stop();
  const frame = buildFrame(19, [1, 1, 80, 0, 8, 255, 69, 112, 0]);
  await device.sendReport(0, frame);
  assert.equal(device.sent.length, 1);
});

/**
 * In real Chromium, EventTarget owns add/removeEventListener, so
 * HIDDevice.prototype has no own descriptors for them. The tap still installs
 * and observes by patching the instance.
 */
class EventTargetHidDevice extends EventTarget {
  readonly vendorId = ZETSU63_PRODUCT.vid;
  readonly productId = ZETSU63_PRODUCT.pid;
  readonly productName = 'EventTarget fake';
  readonly collections = [{ usagePage: 0xff00, usage: 1 }];
  opened = true;
  readonly sent: Uint8Array[] = [];
  private handler: ((event: unknown) => void) | null = null;

  get oninputreport(): ((event: unknown) => void) | null {
    return this.handler;
  }

  set oninputreport(value: ((event: unknown) => void) | null) {
    this.handler = value;
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async sendReport(_reportId: number, data: Uint8Array): Promise<void> {
    this.sent.push(data.slice());
  }
}

test('HID tap installs when addEventListener is inherited from EventTarget', () => {
  const tap = new HidTap({
    product: { vid: ZETSU63_PRODUCT.vid, pid: ZETSU63_PRODUCT.pid },
    deviceCtor: {
      prototype: EventTargetHidDevice.prototype,
    } as unknown as HidDeviceConstructorLike,
  });
  let seen = 0;
  tap.setHooks({
    onHidIn: () => {
      seen += 1;
      return undefined;
    },
  });
  const device = new EventTargetHidDevice();
  try {
    tap.install();
    tap.captureDevice(device);
    let pageSeen = 0;
    device.addEventListener('inputreport', () => {
      pageSeen += 1;
    });
    const event = new Event('inputreport');
    Object.defineProperty(event, 'data', {
      configurable: true,
      value: new DataView(buildFrame(2, [0, 12, 1]).buffer),
    });
    device.dispatchEvent(event);
    assert.equal(seen, 1);
    assert.equal(pageSeen, 1);
  } finally {
    tap.stop();
  }
});
