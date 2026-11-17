import assert from 'node:assert/strict';
import test from 'node:test';

import { NotConnectedError, TransportError } from '../../src/errors.ts';
import { MockTransport } from '../../src/transport/mock.ts';

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

test('MockTransport is closed by default and can auto-open', async () => {
  const closed = new MockTransport();
  assert.equal(closed.kind, 'mock');
  assert.equal(closed.isOpen, false);
  assert.equal(closed.sent.length, 0);

  const error = await captureRejection(closed.send(frame()));
  assert.ok(error instanceof NotConnectedError);
  assert.equal(error.code, 'NOT_CONNECTED');

  const opened = new MockTransport({ autoOpen: true });
  assert.equal(opened.isOpen, true);
});

test('MockTransport.open()/close() toggle the link and close() is repeatable', async () => {
  const transport = new MockTransport();
  await transport.open();
  assert.equal(transport.isOpen, true);

  await transport.close();
  assert.equal(transport.isOpen, false);

  await transport.close();
  assert.equal(transport.isOpen, false);

  const error = await captureRejection(transport.send(frame()));
  assert.ok(error instanceof NotConnectedError);
});

test('MockTransport.send() records an independent copy of each frame', async () => {
  const transport = new MockTransport({ autoOpen: true });
  const payload = frame(1);

  await transport.send(payload);

  assert.equal(transport.sent.length, 1);
  assert.deepEqual(transport.sent[0], payload);
  assert.notEqual(transport.sent[0], payload);

  payload[0] = 0xaa;
  assert.notEqual(transport.sent[0][0], 0xaa);
});

for (const size of [0, 63, 65]) {
  test(`MockTransport.send() rejects a ${size}-byte frame`, async () => {
    const transport = new MockTransport({ autoOpen: true });

    const error = await captureRejection(transport.send(new Uint8Array(size)));

    assert.ok(error instanceof TransportError);
    assert.equal(transport.sent.length, 0);
  });
}

test('MockTransport.failNextSend() fails exactly one send', async () => {
  const transport = new MockTransport({ autoOpen: true });
  const cause = new Error('simulated write failure');
  transport.failNextSend(cause);

  const error = await captureRejection(transport.send(frame()));
  assert.equal(error, cause);
  assert.equal(transport.sent.length, 0);

  await transport.send(frame());
  assert.equal(transport.sent.length, 1);
});

test('MockTransport.emit() delivers copies to subscribers and unsubscribe stops them', () => {
  const transport = new MockTransport({ autoOpen: true });
  const seen: Uint8Array[] = [];
  const unsubscribe = transport.subscribe((report) => seen.push(report));

  const payload = frame(9);
  transport.emit(payload);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], payload);
  assert.notEqual(seen[0], payload);

  unsubscribe();
  transport.emit(payload);
  assert.equal(seen.length, 1);
});

test('MockTransport.setSendDelay() still delivers after the delay', async () => {
  const transport = new MockTransport({ autoOpen: true });
  transport.setSendDelay(1);

  await transport.send(frame(4));

  assert.equal(transport.sent.length, 1);

  transport.setSendDelay(0);
  await transport.send(frame(5));
  assert.equal(transport.sent.length, 2);
});
