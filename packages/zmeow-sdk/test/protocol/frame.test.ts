import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFrame,
  computeChecksum,
  parseFrame,
  MAX_PAYLOAD_LENGTH,
  REPORT_HEAD,
  REPORT_SIZE,
} from '../../src/protocol/frame.ts';
import { ValidationError } from '../../src/errors.ts';

test('frame: buildFrame lays out head / length / command / checksum / payload', () => {
  const frame = buildFrame(19, [0x01, 0x02, 0x03]);

  assert.equal(frame.length, REPORT_SIZE);
  // (3 + 19 + 3) & 0xff = 25 = 0x19 — the checksum uses the last payload byte.
  assert.deepEqual(
    Array.from(frame.slice(0, 7)),
    [REPORT_HEAD, 0x03, 0x13, 0x19, 0x01, 0x02, 0x03],
  );
  assert.equal(frame[3], 0x19);
  // Everything after the payload is zero padding.
  assert.deepEqual(Array.from(frame.slice(7)), new Array<number>(57).fill(0));
});

test('frame: checksum follows (length + command + lastPayloadByte) & 0xff', () => {
  assert.equal(computeChecksum(2, 1, 0xff), 0x02); // 258 & 0xff
  assert.equal(computeChecksum(9, 19, 0), 28);
  assert.equal(computeChecksum(5, 35, 0xea), 18);
  assert.equal(computeChecksum(58, 41, 0xc0), 35);
  assert.equal(computeChecksum(255, 255, 255), 253);
});

test('frame: custom head and size options', () => {
  const frame = buildFrame(1, [0xaa], { head: 0x5a, size: 8 });
  assert.equal(frame.length, 8);
  assert.deepEqual(Array.from(frame), [0x5a, 0x01, 0x01, (1 + 1 + 0xaa) & 0xff, 0xaa, 0, 0, 0]);
});

test('frame: payload bounds are validated', () => {
  assert.throws(() => buildFrame(1, []), ValidationError);
  assert.throws(() => buildFrame(1, new Array<number>(MAX_PAYLOAD_LENGTH + 1).fill(0)), ValidationError);
  assert.throws(() => buildFrame(1, [1], { size: 4 }), ValidationError);
  assert.throws(() => buildFrame(1, [1], { size: 0 }), ValidationError);
  // Exactly at the limit is fine: 60 payload bytes -> 64-byte report.
  const max = buildFrame(1, new Array<number>(MAX_PAYLOAD_LENGTH).fill(0xff));
  assert.equal(max[1], 60);
  assert.equal(max.length, 64);
});

test('frame: parseFrame round-trips a valid report', () => {
  const built = buildFrame(19, [0x01, 0x50, 0xff]);
  const parsed = parseFrame(built);

  assert.ok(parsed);
  assert.equal(parsed.head, REPORT_HEAD);
  assert.equal(parsed.length, 3);
  assert.equal(parsed.command, 19);
  assert.equal(parsed.checksum, (3 + 19 + 0xff) & 0xff);
  assert.deepEqual(Array.from(parsed.payload), [0x01, 0x50, 0xff]);
  assert.equal(parsed.bytes, built);
});

test('frame: parseFrame rejects foreign heads and impossible lengths', () => {
  const frame = buildFrame(1, [0xff, 0xff]);

  const badHead = frame.slice();
  badHead[0] = 0xaa;
  assert.equal(parseFrame(badHead), null);

  const tooLong = frame.slice();
  tooLong[1] = 61; // 61 + 4 > 64
  assert.equal(parseFrame(tooLong), null);

  const zeroLength = frame.slice();
  zeroLength[1] = 0;
  assert.equal(parseFrame(zeroLength), null);

  // A physically short report whose length byte promises more than exists.
  const truncated = new Uint8Array(5);
  truncated[0] = REPORT_HEAD;
  truncated[1] = 10;
  truncated[2] = 1;
  assert.equal(parseFrame(truncated), null);

  assert.equal(parseFrame(new Uint8Array(0)), null);
  assert.equal(parseFrame(new Uint8Array([REPORT_HEAD, 1, 1])), null);
});

test('frame: parseFrame accepts a short report that exactly fits', () => {
  const frame = new Uint8Array([REPORT_HEAD, 2, 2, 0x04, 0x13, 0x00]);
  const parsed = parseFrame(frame);
  assert.ok(parsed);
  assert.equal(parsed.length, 2);
  assert.equal(parsed.command, 2);
  assert.deepEqual(Array.from(parsed.payload), [0x13, 0x00]);
});
