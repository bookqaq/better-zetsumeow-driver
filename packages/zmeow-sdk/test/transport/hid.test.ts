import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeviceOpenError,
  NotConnectedError,
  TransportError,
  UnsupportedError,
  UserCancelledError,
} from '../../src/errors.ts';
import { FakeHid, FakeHidDevice } from '../../src/testing/fake-hid.ts';
import type { HidDeviceLike } from '../../src/transport/types.ts';
import {
  HidTransport,
  getGrantedHidDevices,
  getHidApi,
  isWebHidSupported,
  requestHidDevice,
} from '../../src/transport/webhid.ts';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function installNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function restoreNavigator(): void {
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
}

async function withNavigator<T>(value: unknown, run: () => Promise<T> | T): Promise<T> {
  installNavigator(value);
  try {
    return await run();
  } finally {
    restoreNavigator();
  }
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function frame(seed = 0): Uint8Array {
  return Uint8Array.from({ length: 64 }, (_, index) => (seed + index) & 0xff);
}

test('HidTransport.open() is idempotent and marks the transport open', async () => {
  const device = new FakeHidDevice();
  const transport = new HidTransport(device);

  assert.equal(transport.kind, 'hid');
  assert.equal(transport.device, device);
  assert.equal(transport.isOpen, false);

  await transport.open();
  await transport.open();

  assert.equal(device.openCalls, 1);
  assert.equal(device.opened, true);
  assert.equal(transport.isOpen, true);
});

test('HidTransport.open() adopts an already opened device without calling open()', async () => {
  const device = new FakeHidDevice({ opened: true });
  const transport = new HidTransport(device);

  await transport.open();

  assert.equal(device.openCalls, 0);
  assert.equal(transport.isOpen, true);
});

test('HidTransport.open() wraps device failures in DeviceOpenError', async () => {
  const cause = new Error('InvalidStateError');
  const device = new FakeHidDevice({ openError: cause });
  const transport = new HidTransport(device);

  const error = await captureRejection(transport.open());

  assert.ok(error instanceof DeviceOpenError);
  assert.equal(error.code, 'DEVICE_OPEN');
  assert.equal(error.cause, cause);
  assert.equal(transport.isOpen, false);
});

test('HidTransport.close() is idempotent, detaches listeners and blocks send()', async () => {
  const device = new FakeHidDevice();
  const transport = new HidTransport(device);
  await transport.open();

  assert.equal(device.listenerCount('inputreport'), 1);

  await transport.close();
  await transport.close();

  assert.equal(device.closeCalls, 1);
  assert.equal(device.opened, false);
  assert.equal(transport.isOpen, false);
  assert.equal(device.listenerCount('inputreport'), 0);
  assert.equal(device.listenerCount('disconnect'), 0);
  assert.equal(device.forgetCalls, 0);
  assert.equal(device.sent.length, 0);

  const error = await captureRejection(transport.send(frame()));
  assert.ok(error instanceof NotConnectedError);
  assert.equal(error.code, 'NOT_CONNECTED');
});

test('HidTransport delivers no frames after close()', async () => {
  const device = new FakeHidDevice();
  const transport = new HidTransport(device);
  await transport.open();

  const received: Uint8Array[] = [];
  transport.subscribe((report) => received.push(report));
  await transport.close();

  device.emitInputReport(frame(5));

  assert.equal(received.length, 0);
});

test('HidTransport.send() forwards the exact 64-byte frame', async () => {
  const device = new FakeHidDevice();
  const transport = new HidTransport(device);
  await transport.open();

  const payload = frame(7);
  await transport.send(payload);

  assert.equal(device.sent.length, 1);
  assert.deepEqual(device.sent[0], payload);
  assert.notEqual(device.sent[0], payload);
});

for (const size of [0, 1, 63, 65, 128]) {
  test(`HidTransport.send() rejects a ${size}-byte frame with TransportError`, async () => {
    const device = new FakeHidDevice();
    const transport = new HidTransport(device);
    await transport.open();

    const error = await captureRejection(transport.send(new Uint8Array(size)));

    assert.ok(error instanceof TransportError);
    assert.equal(error.code, 'TRANSPORT');
    assert.equal(device.sent.length, 0);
  });
}

test('HidTransport.send() wraps sendReport failures and keeps the cause', async () => {
  const cause = new Error('NetworkError: device rejected the report');
  const device = new FakeHidDevice({ sendError: cause });
  const transport = new HidTransport(device);
  await transport.open();

  const error = await captureRejection(transport.send(frame()));

  assert.ok(error instanceof TransportError);
  assert.equal(error.code, 'TRANSPORT');
  assert.equal(error.cause, cause);
  assert.equal(device.sent.length, 0);
});

test('input reports are copied, fanned out, and stop after unsubscribe', async () => {
  const device = new FakeHidDevice();
  const transport = new HidTransport(device);
  await transport.open();

  const first: Uint8Array[] = [];
  const second: Uint8Array[] = [];
  const unsubscribeFirst = transport.subscribe((report) => first.push(report));
  transport.subscribe((report) => second.push(report));

  const payload = frame(3);
  device.emitInputReport(payload);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(first[0], payload);
  assert.notEqual(first[0], payload);
  assert.notEqual(first[0], second[0]);

  first[0][0] = 0xff;
  assert.notEqual(second[0][0], 0xff);

  unsubscribeFirst();
  device.emitInputReport(payload);

  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
});

test('inputreport events without data are ignored', async () => {
  const device = new FakeHidDevice();
  const transport = new HidTransport(device);
  await transport.open();

  const received: Uint8Array[] = [];
  transport.subscribe((report) => received.push(report));

  device.dispatch('inputreport', { reportId: 0, device });
  assert.equal(received.length, 0);

  device.emitInputReport(Uint8Array.from([1, 2, 3]));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], Uint8Array.from([1, 2, 3]));
});

test('a matching disconnect event closes the transport and fires onDisconnect once', async () => {
  const device = new FakeHidDevice();
  const disconnected: HidDeviceLike[] = [];
  const transport = new HidTransport(device, {
    onDisconnect: (gone) => disconnected.push(gone),
  });
  await transport.open();

  device.emitDisconnect();

  assert.equal(transport.isOpen, false);
  assert.equal(disconnected.length, 1);
  assert.equal(disconnected[0], device);

  const error = await captureRejection(transport.send(frame()));
  assert.ok(error instanceof NotConnectedError);
});

test('disconnect events for another device are ignored', async () => {
  const device = new FakeHidDevice({ vendorId: 0x1111, productId: 0x2222 });
  const other = new FakeHidDevice({ vendorId: 0x3333, productId: 0x4444 });
  const disconnected: HidDeviceLike[] = [];
  const transport = new HidTransport(device, {
    onDisconnect: (gone) => disconnected.push(gone),
  });
  await transport.open();

  device.dispatch('disconnect', { device: other });

  assert.equal(transport.isOpen, true);
  assert.equal(disconnected.length, 0);
});

test('requestHidDevice() returns the first granted device and forwards the filters', async () => {
  const device = new FakeHidDevice();
  const second = new FakeHidDevice({ productId: 0x0002 });
  const hid = new FakeHid({ requestDevices: [device, second] });

  await withNavigator({ hid }, async () => {
    assert.equal(getHidApi(), hid);
    assert.equal(isWebHidSupported(), true);

    const filters = [{ vendorId: 0x372d, productId: 0x0001 }] as const;
    const picked = await requestHidDevice(filters);

    assert.equal(picked, device);
    assert.equal(hid.requests.length, 1);
    assert.deepEqual(hid.requests[0].filters, filters);
  });
});

test('requestHidDevice() treats an empty chooser result as cancellation', async () => {
  const hid = new FakeHid({ devices: [], requestDevices: [] });

  await withNavigator({ hid }, async () => {
    const error = await captureRejection(requestHidDevice([]));

    assert.ok(error instanceof UserCancelledError);
    assert.equal(error.code, 'USER_CANCELLED');
  });
});

for (const name of ['NotFoundError', 'AbortError']) {
  test(`requestHidDevice() maps a ${name} rejection to UserCancelledError`, async () => {
    const cause = new DOMException('The user cancelled the device chooser', name);
    const hid = new FakeHid({ requestError: cause });

    await withNavigator({ hid }, async () => {
      const error = await captureRejection(requestHidDevice([]));

      assert.ok(error instanceof UserCancelledError);
      assert.equal(error.cause, cause);
    });
  });
}

test('requestHidDevice() maps non-cancellation chooser failures to TransportError', async () => {
  const cause = new Error('SecurityError: request is not allowed here');
  const hid = new FakeHid({ requestError: cause });

  await withNavigator({ hid }, async () => {
    const error = await captureRejection(requestHidDevice([]));

    assert.ok(error instanceof TransportError);
    assert.equal(error.code, 'TRANSPORT');
    assert.equal(error.cause, cause);
  });
});

test('WebHID helpers degrade gracefully without navigator.hid', async () => {
  await withNavigator({}, async () => {
    assert.equal(getHidApi(), null);
    assert.equal(isWebHidSupported(), false);
    assert.deepEqual(await getGrantedHidDevices(), []);

    const error = await captureRejection(requestHidDevice([]));
    assert.ok(error instanceof UnsupportedError);
    assert.equal(error.code, 'UNSUPPORTED');
  });
});

test('getGrantedHidDevices() returns granted devices and wraps enumeration failures', async () => {
  const device = new FakeHidDevice();
  const hid = new FakeHid({ devices: [device] });

  await withNavigator({ hid }, async () => {
    const devices = await getGrantedHidDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0], device);
    assert.equal(hid.getDevicesCalls, 1);
  });

  const cause = new Error('NotAllowedError');
  const failing = new FakeHid({ getDevicesError: cause });
  await withNavigator({ hid: failing }, async () => {
    const error = await captureRejection(getGrantedHidDevices());
    assert.ok(error instanceof TransportError);
    assert.equal(error.cause, cause);
  });
});
