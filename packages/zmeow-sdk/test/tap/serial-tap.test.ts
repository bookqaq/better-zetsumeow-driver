import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SerialTap } from '../../src/tap/serial-tap.ts';
import { ZETSU63_PRODUCT } from '../../src/generated/product-zetsu63.ts';
import { FakeSerial, FakeSerialPort } from '../../src/testing/fake-serial.ts';
import { encodeSerialFrame } from '../../src/transport/webserial.ts';
import { SerialTransport } from '../../src/transport/webserial.ts';
import { ZetsuScreen } from '../../src/screen.ts';
import type { SerialPortConstructorLike } from '../../src/tap/types.ts';

function makeTap(onHooks: Parameters<SerialTap['setHooks']>[0] = {}): {
  tap: SerialTap;
  port: FakeSerialPort;
} {
  const tap = new SerialTap({
    product: { vid: ZETSU63_PRODUCT.vid, pidScreen: ZETSU63_PRODUCT.pidScreen },
    portCtor: { prototype: FakeSerialPort.prototype } as unknown as SerialPortConstructorLike,
    serial: new FakeSerial(),
    hooks: onHooks,
  });
  tap.install();
  const port = new FakeSerialPort({
    usbVendorId: ZETSU63_PRODUCT.vid,
    usbProductId: ZETSU63_PRODUCT.pidScreen,
  });
  return { tap, port };
}

async function openPort(port: FakeSerialPort): Promise<void> {
  await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
}

test('serial tap rewrites outgoing command 112 frames', async () => {
  const original = encodeSerialFrame(112, [0, 1, 103, 105, 102, 49]);
  const replacement = encodeSerialFrame(113, [0, 1, 2, 3]);
  const { tap, port } = makeTap({ onSerialOut: () => replacement });
  try {
    await openPort(port);
    const writer = port.writable!.getWriter();
    await writer.write(original);
    writer.releaseLock();
    assert.deepEqual([...(port.writes.at(-1) ?? [])], [...replacement]);
  } finally {
    tap.stop();
  }
});

test('serial tap observes incoming frames from the page reader', async () => {
  const incoming = encodeSerialFrame(112, [1]);
  const seen: number[] = [];
  const { tap, port } = makeTap({
    onSerialIn: (frame) => {
      seen.push(frame.command);
    },
  });
  try {
    await openPort(port);
    const reader = port.readable!.getReader();
    port.devicePush(incoming);
    const result = await reader.read();
    reader.releaseLock();
    assert.equal(result.done, false);
    assert.deepEqual(seen, [112]);
    assert.equal(tap.counts.in, 1);
  } finally {
    tap.stop();
  }
});

test('serial facade forwards writes through the tapped port', async () => {
  const frame = encodeSerialFrame(112, [0, 1, 103, 105, 102, 49]);
  const { tap, port } = makeTap();
  try {
    await openPort(port);
    const facade = tap.createPortFacade(port);
    const writer = facade.writable!.getWriter();
    await writer.write(frame);
    writer.releaseLock();
    assert.deepEqual([...(port.writes.at(-1) ?? [])], [...frame]);
  } finally {
    tap.stop();
  }
});

test('serial facade receives tapped input and can be consumed independently', async () => {
  const frame = encodeSerialFrame(112, [1]);
  const { tap, port } = makeTap();
  try {
    await openPort(port);
    const facade = tap.createPortFacade(port);
    const pageReader = port.readable!.getReader();
    const facadeReader = facade.readable!.getReader();
    port.devicePush(frame);
    const pageChunk = await pageReader.read();
    pageReader.releaseLock();
    assert.equal(pageChunk.done, false);
    const facadeChunk = await facadeReader.read();
    facadeReader.releaseLock();
    assert.equal(facadeChunk.done, false);
    assert.deepEqual([...(facadeChunk.value ?? [])], [...frame]);
  } finally {
    tap.stop();
  }
});

test('SerialTransport openPort:false leaves the page port open', async () => {
  const { tap, port } = makeTap();
  try {
    await openPort(port);
    const transport = new SerialTransport(port, { openPort: false });
    await transport.open();
    assert.equal(transport.isOpen, true);
    await transport.close();
    assert.equal(port.isOpen, true);
  } finally {
    tap.stop();
  }
});

test('ZetsuScreen can attach to an externally opened port without closing it', async () => {
  const { tap, port } = makeTap();
  try {
    await openPort(port);
    const screen = new ZetsuScreen({
      product: ZETSU63_PRODUCT,
      port,
      openPort: false,
    });
    await screen.open();
    assert.equal(screen.isOpen, true);
    assert.equal(port.isOpen, true);
    await screen.close();
    assert.equal(port.isOpen, true);
  } finally {
    tap.stop();
  }
});
