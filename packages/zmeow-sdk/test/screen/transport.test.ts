import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DeviceOpenError, NotConnectedError, TransportError } from '../../src/errors.ts';
import { FakeSerialPort } from '../../src/testing/fake-serial.ts';
import {
  SerialTransport,
  decodeSerialFrames,
  encodeSerialFrame,
} from '../../src/transport/webserial.ts';

async function tick(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('sendCommand before open throws NotConnectedError', async () => {
  const port = new FakeSerialPort();
  const transport = new SerialTransport(port);

  assert.equal(transport.isOpen, false);
  await assert.rejects(transport.sendCommand(112, [0, 1]), (error: unknown) => {
    return error instanceof NotConnectedError && error.code === 'NOT_CONNECTED';
  });
  assert.equal(port.writes.length, 0);
});

test('open forwards 115200 8N1 and maps failures to DeviceOpenError', async () => {
  const port = new FakeSerialPort();
  const transport = new SerialTransport(port, { baudRate: 115200 });
  await transport.open();

  assert.deepEqual(port.openOptions, {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });
  assert.equal(transport.isOpen, true);
  await transport.close();

  const failing = new FakeSerialPort({ openError: new Error('no device') });
  const failingTransport = new SerialTransport(failing);
  await assert.rejects(failingTransport.open(), (error: unknown) => {
    return error instanceof DeviceOpenError && error.code === 'DEVICE_OPEN';
  });
  assert.equal(failingTransport.isOpen, false);
});

test('read loop reassembles split frames and fans out decoded payloads', async () => {
  const port = new FakeSerialPort();
  const transport = new SerialTransport(port);
  await transport.open();

  const received: { command: number; payload: number[] }[] = [];
  const unsubscribe = transport.subscribe((frame) => {
    received.push({ command: frame.command, payload: [...frame.payload] });
  });

  const wire = encodeSerialFrame(112, [0, 1]);
  port.devicePush(wire.slice(0, 6));
  await tick();
  assert.equal(received.length, 0);

  port.devicePush(wire.slice(6));
  await waitFor(() => received.length === 1, 'reassembled frame');
  assert.deepEqual(received[0], { command: 112, payload: [0, 1] });

  unsubscribe();
  port.devicePush(encodeSerialFrame(113, [0, 0xf8]));
  await tick();
  assert.equal(received.length, 1);

  await transport.close();
});

test('sendCommand writes one encoded frame', async () => {
  const port = new FakeSerialPort();
  const transport = new SerialTransport(port);
  await transport.open();

  await transport.sendCommand(112, [0, 1, 103, 105, 102, 49]);
  assert.equal(port.writes.length, 1);

  const { frames } = decodeSerialFrames(port.writes[0]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].command, 112);
  assert.deepEqual([...frames[0].payload], [0, 1, 103, 105, 102, 49]);

  await transport.close();
});

test('close is idempotent and the reader is released', async () => {
  const port = new FakeSerialPort();
  const transport = new SerialTransport(port);
  await transport.open();

  await transport.close();
  await transport.close();
  assert.equal(transport.isOpen, false);
  assert.equal(port.isOpen, false);
});

test('device side close marks the link disconnected and invokes onDisconnect', async () => {
  const port = new FakeSerialPort();
  let disconnected = 0;
  const transport = new SerialTransport(port, {
    baudRate: 115200,
    onDisconnect: () => {
      disconnected += 1;
    },
  });

  await transport.open();
  assert.equal(transport.isOpen, true);

  port.deviceClose();
  await waitFor(() => disconnected === 1, 'disconnect callback');
  assert.equal(transport.isOpen, false);
  await assert.rejects(transport.sendCommand(112, [0, 1]), (error: unknown) => {
    return error instanceof NotConnectedError;
  });

  await transport.close();
});

test('a missing writable stream is reported instead of hanging', async () => {
  const port = new FakeSerialPort();
  const transport = new SerialTransport(port);
  await transport.open();

  Object.defineProperty(port, 'writable', { value: null, configurable: true });
  await assert.rejects(transport.sendCommand(112, [0, 1]), (error: unknown) => {
    return error instanceof NotConnectedError || error instanceof TransportError;
  });

  await transport.close();
});
