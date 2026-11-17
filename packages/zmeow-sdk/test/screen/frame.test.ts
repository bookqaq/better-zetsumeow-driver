import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeSerialFrames,
  encodeSerialFrame,
} from '../../src/transport/webserial.ts';

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function namePayload(name: string): number[] {
  const bytes = [0, 1];
  for (let index = 0; index < 15; index += 1) {
    bytes.push(index < name.length ? name.charCodeAt(index) : 0);
  }
  return bytes;
}

test('encodeSerialFrame writes head, big-endian length, command and CRC', () => {
  const payload = namePayload('gif1');
  const frame = encodeSerialFrame(112, payload);

  assert.equal(payload.length, 17);
  assert.equal(frame.length, 7 + 17);
  assert.equal(frame[0], 0xab);
  assert.equal(readUint32BE(frame, 1), 17);
  assert.equal(frame[5], 112);
  // CRC = (payloadLength + command + last payload byte) & 0xFF
  assert.equal(frame[6], (17 + 112 + frame[frame.length - 1]) & 0xff);
  assert.deepEqual([...frame.slice(7)], payload);
  assert.deepEqual([...frame.slice(7, 11)], [0, 1, 103, 105]);
});

test('encodeSerialFrame treats an empty payload as last byte 0', () => {
  const frame = encodeSerialFrame(113, []);

  assert.equal(frame.length, 7);
  assert.equal(frame[0], 0xab);
  assert.equal(readUint32BE(frame, 1), 0);
  assert.equal(frame[5], 113);
  assert.equal(frame[6], 113);
});

test('decodeSerialFrames returns a complete frame and no rest', () => {
  const wire = encodeSerialFrame(112, [0, 1, 103, 105, 102, 49]);
  const { frames, rest } = decodeSerialFrames(wire);

  assert.equal(frames.length, 1);
  assert.equal(rest.length, 0);
  assert.equal(frames[0].command, 112);
  assert.deepEqual([...frames[0].payload], [0, 1, 103, 105, 102, 49]);
  assert.deepEqual([...frames[0].raw], [...wire]);
});

test('decodeSerialFrames keeps a half frame in rest', () => {
  const wire = encodeSerialFrame(112, [0, 1]);
  const head = wire.slice(0, 5);
  const tail = wire.slice(5);

  const first = decodeSerialFrames(head);
  assert.equal(first.frames.length, 0);
  assert.deepEqual([...first.rest], [...head]);

  const combined = new Uint8Array(first.rest.length + tail.length);
  combined.set(first.rest);
  combined.set(tail, first.rest.length);
  const second = decodeSerialFrames(combined);
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0].command, 112);
  assert.deepEqual([...second.frames[0].payload], [0, 1]);
  assert.equal(second.rest.length, 0);
});

test('decodeSerialFrames handles sticky frames and a trailing partial frame', () => {
  const first = encodeSerialFrame(112, [0, 1]);
  const second = encodeSerialFrame(113, [0, 0xf8, 0x00]);
  const third = encodeSerialFrame(113, [0, 0x07, 0xe0]);
  const partial = third.slice(0, 6);

  const merged = new Uint8Array(first.length + second.length + partial.length);
  merged.set(first);
  merged.set(second, first.length);
  merged.set(partial, first.length + second.length);

  const { frames, rest } = decodeSerialFrames(merged);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].command, 112);
  assert.equal(frames[1].command, 113);
  assert.deepEqual([...frames[1].payload], [0, 0xf8, 0x00]);
  assert.deepEqual([...rest], [...partial]);
});

test('decodeSerialFrames resynchronises on the next head byte', () => {
  const wire = encodeSerialFrame(112, [0, 1]);
  const noise = new Uint8Array(3);
  noise.set([0x00, 0xff, 0x12]);
  const merged = new Uint8Array(noise.length + wire.length);
  merged.set(noise);
  merged.set(wire, noise.length);

  const { frames, rest } = decodeSerialFrames(merged);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].command, 112);
  assert.equal(rest.length, 0);
});

test('decodeSerialFrames drops garbage without a head byte', () => {
  const { frames, rest } = decodeSerialFrames(new Uint8Array([0x00, 0x11, 0x22]));
  assert.equal(frames.length, 0);
  assert.equal(rest.length, 0);
});
