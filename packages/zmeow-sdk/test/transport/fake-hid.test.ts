import assert from 'node:assert/strict';
import test from 'node:test';

import type { HidInputReportEvent } from '../../src/transport/types.ts';
import { FakeHid, FakeHidDevice, makeFakeDevice } from '../../src/testing/fake-hid.ts';

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

test('makeFakeDevice() applies defaults and honours overrides', () => {
  const defaults = makeFakeDevice({});
  assert.equal(typeof defaults.vendorId, 'number');
  assert.equal(typeof defaults.productId, 'number');
  assert.equal(defaults.opened, false);
  assert.equal(defaults.sent.length, 0);
  assert.equal(defaults.collections.length, 1);

  const configured = makeFakeDevice({
    vendorId: 0x0102,
    productId: 0x0304,
    productName: 'Custom Board',
    opened: true,
    collections: [
      { usagePage: 0x01, usage: 0x06 },
      { usagePage: 0xff00, usage: 0x0001 },
    ],
  });

  assert.equal(configured.vendorId, 0x0102);
  assert.equal(configured.productId, 0x0304);
  assert.equal(configured.productName, 'Custom Board');
  assert.equal(configured.opened, true);
  assert.equal(configured.collections.length, 2);
  assert.deepEqual(configured.collections[1], { usagePage: 0xff00, usage: 0x0001 });
});

test('FakeHidDevice.open()/close() count calls and can fail on demand', async () => {
  const device = new FakeHidDevice();

  await device.open();
  await device.open();
  assert.equal(device.openCalls, 2);
  assert.equal(device.opened, true);

  await device.close();
  assert.equal(device.closeCalls, 1);
  assert.equal(device.opened, false);

  const openCause = new Error('open failed');
  device.openError = openCause;
  const openError = await captureRejection(device.open());
  assert.equal(openError, openCause);
  assert.equal(device.opened, false);

  const closeCause = new Error('close failed');
  device.closeError = closeCause;
  const closeError = await captureRejection(device.close());
  assert.equal(closeError, closeCause);
});

test('FakeHidDevice.sendReport() records copies and honours sendError', async () => {
  const device = new FakeHidDevice();
  await device.open();

  const payload = Uint8Array.from([1, 2, 3]);
  await device.sendReport(0, payload);

  assert.equal(device.sent.length, 1);
  assert.deepEqual(device.sent[0], payload);
  assert.notEqual(device.sent[0], payload);

  const cause = new Error('write failed');
  const failing = new FakeHidDevice({ sendError: cause });
  await failing.open();
  const error = await captureRejection(failing.sendReport(0, payload));
  assert.equal(error, cause);
  assert.equal(failing.sent.length, 0);
});

test('FakeHidDevice supports multiple listeners and precise removal', () => {
  const device = new FakeHidDevice();
  const first: number[] = [];
  const second: number[] = [];
  const firstListener = (): void => {
    first.push(1);
  };
  const secondListener = (): void => {
    second.push(1);
  };

  device.addEventListener('inputreport', firstListener);
  device.addEventListener('inputreport', secondListener);
  assert.equal(device.listenerCount('inputreport'), 2);

  device.emitInputReport(new Uint8Array([0]));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);

  device.removeEventListener('inputreport', firstListener);
  assert.equal(device.listenerCount('inputreport'), 1);

  device.emitInputReport(new Uint8Array([0]));
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
});

test('FakeHidDevice.emitInputReport() wraps views without copying the wrong slice', () => {
  const device = new FakeHidDevice();
  const events: HidInputReportEvent[] = [];
  device.addEventListener('inputreport', (event) => events.push(event as HidInputReportEvent));

  const backing = Uint8Array.from([9, 9, 1, 2, 3, 9]);
  device.emitInputReport(backing.subarray(2, 5));

  assert.equal(events.length, 1);
  const data = events[0].data;
  assert.ok(data instanceof DataView);
  assert.equal(data.byteOffset, 2);
  assert.equal(data.byteLength, 3);
  assert.deepEqual(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), Uint8Array.from([1, 2, 3]));

  const buffer = new ArrayBuffer(2);
  new Uint8Array(buffer).set([4, 5]);
  device.emitInputReport(buffer);
  assert.equal(events.length, 2);
  assert.ok(events[1].data instanceof DataView);
  assert.deepEqual(new Uint8Array(events[1].data.buffer), Uint8Array.from([4, 5]));
});

test('FakeHidDevice.emitDisconnect() closes the device and notifies listeners', () => {
  const device = new FakeHidDevice({ opened: true });
  let notifications = 0;
  device.addEventListener('disconnect', () => {
    notifications += 1;
  });

  device.emitDisconnect();

  assert.equal(device.opened, false);
  assert.equal(notifications, 1);
});

test('FakeHidDevice.forget() only runs when called explicitly', async () => {
  const device = new FakeHidDevice();
  assert.equal(device.forgetCalls, 0);
  await device.forget();
  assert.equal(device.forgetCalls, 1);
});

test('FakeHid lists devices, records request arguments and can fail on demand', async () => {
  const first = new FakeHidDevice();
  const second = new FakeHidDevice({ productId: 0x0002 });
  const hid = new FakeHid({ devices: [first, second] });

  const devices = await hid.getDevices();
  assert.equal(hid.getDevicesCalls, 1);
  assert.deepEqual(devices, [first, second]);

  const filters = [{ vendorId: 0x372d }] as const;
  const requested = await hid.requestDevice({ filters });
  assert.deepEqual(requested, [first, second]);
  assert.equal(hid.requests.length, 1);
  assert.deepEqual(hid.requests[0].filters, filters);

  const empty = new FakeHid({ devices: [first], requestDevices: [] });
  assert.deepEqual(await empty.requestDevice({ filters: [] }), []);
});

test('FakeHid.requestDevice()/getDevices() reject with configured errors', async () => {
  const requestCause = new DOMException('denied', 'NotFoundError');
  const requestFailing = new FakeHid({ requestError: requestCause });
  assert.equal(await captureRejection(requestFailing.requestDevice({ filters: [] })), requestCause);

  const getCause = new Error('enumeration failed');
  const getFailing = new FakeHid({ getDevicesError: getCause });
  assert.equal(await captureRejection(getFailing.getDevices()), getCause);
});
