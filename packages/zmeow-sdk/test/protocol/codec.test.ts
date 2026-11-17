import test from 'node:test';
import assert from 'node:assert/strict';

import {
  asciiToBytes,
  bytesToAscii,
  bytesToHex,
  chunk,
  numToUint8,
  numToUint8_2B,
  numToUint8_4B,
  toHexByte,
} from '../../src/codec/bytes.ts';
import { bytesToHidCode, hidCodeToBytes } from '../../src/codec/keys.ts';
import { byteToMs, MAX_TRAVEL_MM, mmToTravelBytes, msToByte, travelBytesToMm } from '../../src/codec/units.ts';
import { hexToRgb, rgb565ToBytes, rgbToHex, rgbToRgb565 } from '../../src/codec/color.ts';
import { ValidationError } from '../../src/errors.ts';

test('bytes: numToUint8 truncates to one byte', () => {
  assert.equal(numToUint8(0), 0);
  assert.equal(numToUint8(255), 255);
  assert.equal(numToUint8(256), 0);
  assert.equal(numToUint8(0x1ff), 0xff);
  assert.equal(numToUint8(-1), 0xff);
});

test('bytes: numToUint8_2B is big-endian', () => {
  assert.deepEqual(numToUint8_2B(0), [0x00, 0x00]);
  assert.deepEqual(numToUint8_2B(0x04ea), [0x04, 0xea]);
  assert.deepEqual(numToUint8_2B(0xffff), [0xff, 0xff]);
  assert.deepEqual(numToUint8_2B(0x12345), [0x23, 0x45]);
});

test('bytes: numToUint8_4B is big-endian', () => {
  assert.deepEqual(numToUint8_4B(0x01020304), [0x01, 0x02, 0x03, 0x04]);
  assert.deepEqual(numToUint8_4B(0), [0, 0, 0, 0]);
});

test('bytes: ascii round-trip and NUL skipping', () => {
  assert.deepEqual(asciiToBytes('AB1'), [0x41, 0x42, 0x31]);
  assert.equal(bytesToAscii([0x41, 0x00, 0x42, 0x00]), 'AB');
  assert.equal(bytesToAscii(asciiToBytes('VM653-2A')), 'VM653-2A');
});

test('bytes: hex helpers are upper-case and padded', () => {
  assert.equal(toHexByte(0), '00');
  assert.equal(toHexByte(0x0e), '0E');
  assert.equal(toHexByte(255), 'FF');
  assert.equal(bytesToHex([0xab, 0x02, 0x01]), 'AB0201');
});

test('bytes: chunk splits and keeps a short tail', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2, 3, 4], 4), [[1, 2, 3, 4]]);
  assert.deepEqual(chunk([], 4), []);
  assert.deepEqual(chunk([1, 2], 0), []);
});

test('keys: hidCodeToBytes encodes big-endian HID usages', () => {
  assert.deepEqual(hidCodeToBytes(0x00), [0x00, 0x00]);
  assert.deepEqual(hidCodeToBytes(0x2c), [0x00, 0x2c]);
  assert.deepEqual(hidCodeToBytes(255), [0x00, 0xff]);
  assert.deepEqual(hidCodeToBytes(256), [0x01, 0x00]);
  assert.deepEqual(hidCodeToBytes(0x04ea), [0x04, 0xea]);
  assert.deepEqual(hidCodeToBytes(0xffff), [0xff, 0xff]);
  assert.equal(bytesToHidCode(0x04, 0xea), 0x04ea);
  assert.equal(bytesToHidCode(0x00, 0x2c), 0x2c);
});

test('units: millimetres <-> 2-byte micrometres (0.01mm grid)', () => {
  assert.deepEqual(mmToTravelBytes(0), [0x00, 0x00]);
  assert.deepEqual(mmToTravelBytes(0.5), [0x13, 0x88]); // 5000
  assert.deepEqual(mmToTravelBytes(1.2), [0x2e, 0xe0]); // 12000
  assert.deepEqual(mmToTravelBytes(2.5), [0x61, 0xa8]); // 25000
  assert.deepEqual(mmToTravelBytes(4), [0x9c, 0x40]); // 40000 — full 4mm switch travel
  // Finer input is quantised to the firmware's 0.01 mm grid before encoding.
  assert.deepEqual(mmToTravelBytes(1.2345), [0x30, 0x0c]); // 12300 = 1.23mm
  assert.deepEqual(mmToTravelBytes(MAX_TRAVEL_MM), [0xff, 0xdc]); // 65500 = 6.55mm
  assert.equal(travelBytesToMm(0x2e, 0xe0), 1.2);
  assert.equal(travelBytesToMm(0x61, 0xa8), 2.5);
  assert.equal(travelBytesToMm(0xff, 0xff), 6.5535);
});

test('units: 10 ms time ticks', () => {
  assert.equal(msToByte(0), 0);
  assert.equal(msToByte(30), 3);
  assert.equal(msToByte(35), 4); // round(3.5)
  assert.equal(msToByte(2560), 0); // 256 & 0xff
  assert.equal(byteToMs(3), 30);
  assert.equal(byteToMs(0), 0);
});

test('color: hex <-> rgb', () => {
  assert.deepEqual(hexToRgb('#FF4570'), { r: 255, g: 69, b: 112 });
  assert.deepEqual(hexToRgb('#000000'), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToRgb('#0a0b0c'), { r: 10, g: 11, b: 12 });
  assert.equal(rgbToHex(255, 69, 112), '#FF4570');
  assert.equal(rgbToHex(0, 0, 0), '#000000');
  assert.equal(rgbToHex(10, 11, 12), '#0A0B0C');
});

test('color: invalid hex throws ValidationError', () => {
  assert.throws(() => hexToRgb('FF4570FF'), ValidationError);
  assert.throws(() => hexToRgb('#FFF'), ValidationError);
  assert.throws(() => hexToRgb('nope'), ValidationError);
});

test('color: rgb565 packing', () => {
  // (255>>3)<<11 | (69>>2)<<5 | (112>>3) = 0xFA2E
  assert.equal(rgbToRgb565(255, 69, 112), 0xfa2e);
  assert.equal(rgbToRgb565(0, 0, 0), 0);
  assert.deepEqual(rgb565ToBytes(0xfa2e), [0xfa, 0x2e]);
  assert.deepEqual(rgb565ToBytes(0), [0, 0]);
});
