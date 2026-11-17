import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFrame } from '../../src/protocol/frame.ts';
import {
  HidCommand,
  MiscSubCommand,
  deviceInfoPayload,
  endSetPayload,
  featureClearPayload,
  featureGetOnePayload,
  featureGetPayload,
  jzColorGetPayload,
  keyColorGetPayload,
  keyColorSetPayloads,
  lightGetPayload,
  lightSetPayload,
  macroGetPayload,
  miscPayload,
  mptSetPayload,
  mtSetPayload,
  remapGetPayload,
  remapSetPayload,
  rsSetPayload,
  socdSetPayload,
  tglSetPayload,
  travelGetPayload,
  travelSetPayloads,
  type TravelSetEntry,
} from '../../src/protocol/commands.ts';
import { ValidationError } from '../../src/errors.ts';

function head(frame: Uint8Array, count: number): number[] {
  return Array.from(frame.slice(0, count));
}

function payloadOf(frame: Uint8Array): number[] {
  return Array.from(frame.slice(4, 4 + frame[1]));
}

test('commands: cmd ids match the driver', () => {
  assert.equal(HidCommand.DeviceInfo, 1);
  assert.equal(HidCommand.Misc, 2);
  assert.equal(HidCommand.Light, 19);
  assert.equal(HidCommand.KeyColor, 20);
  assert.equal(HidCommand.ScreenEnd, 22);
  assert.equal(HidCommand.Macro, 32);
  assert.equal(HidCommand.Remap, 35);
  assert.equal(HidCommand.Mt, 36);
  assert.equal(HidCommand.Tgl, 37);
  assert.equal(HidCommand.Dks, 38);
  assert.equal(HidCommand.Mpt, 39);
  assert.equal(HidCommand.End, 40);
  assert.equal(HidCommand.Travel, 41);
  assert.equal(HidCommand.Socd, 43);
  assert.equal(HidCommand.Rs, 45);
  assert.equal(HidCommand.Feature, 47);
  assert.equal(HidCommand.JzColor, 52);
  assert.equal(MiscSubCommand.SetLightSleep, 13);
  assert.equal(MiscSubCommand.GetLightSleep, 14);
  assert.equal(MiscSubCommand.GetFMode, 19);
});

test('golden 1: deviceInfoPayload + cmd 1', () => {
  const payload = deviceInfoPayload();
  assert.deepEqual(payload, [0xff, 0xff]);

  const frame = buildFrame(HidCommand.DeviceInfo, payload);
  // checksum = (2 + 1 + 0xFF) & 0xFF = 0x02
  assert.deepEqual(head(frame, 6), [0xab, 0x02, 0x01, 0x02, 0xff, 0xff]);
  assert.equal(frame[1], 2);
  assert.deepEqual(Array.from(frame.slice(6)), new Array<number>(58).fill(0));
});

test('golden 2: lightSetPayload + cmd 19', () => {
  const payload = lightSetPayload({
    mode: 1,
    speed: 80,
    turn: 0,
    brightness: 8,
    r: 255,
    g: 69,
    b: 112,
    colorful: 0,
  });
  assert.deepEqual(payload, [0x01, 0x01, 0x50, 0x00, 0x08, 0xff, 0x45, 0x70, 0x00]);
  assert.equal(payload.length, 9);

  const frame = buildFrame(HidCommand.Light, payload);
  // checksum = (9 + 19 + 0x00) & 0xFF = 0x1C
  assert.deepEqual(head(frame, 13), [
    0xab, 0x09, 0x13, 0x1c, 0x01, 0x01, 0x50, 0x00, 0x08, 0xff, 0x45, 0x70, 0x00,
  ]);
});

test('golden 3: miscPayload + cmd 2 keeps the 2-byte payload', () => {
  const payload = miscPayload(MiscSubCommand.GetFMode);
  assert.deepEqual(payload, [19, 0]);
  assert.equal(payload.length, 2);

  const frame = buildFrame(HidCommand.Misc, payload);
  // checksum = (2 + 2 + 0) & 0xFF = 0x04
  assert.deepEqual(head(frame, 6), [0xab, 0x02, 0x02, 0x04, 0x13, 0x00]);
  assert.equal(frame[1], 2);

  // Light-sleep write: sub 13, second byte is the value.
  const sleepFrame = buildFrame(HidCommand.Misc, miscPayload(MiscSubCommand.SetLightSleep, 30));
  // checksum = (2 + 2 + 30) & 0xFF = 0x22
  assert.deepEqual(head(sleepFrame, 6), [0xab, 0x02, 0x02, 0x22, 0x0d, 0x1e]);
});

test('golden 4: remapSetPayload uses 2 bytes for usages above 255', () => {
  const payload = remapSetPayload(1, 0x0e, 0x04ea);
  assert.deepEqual(payload, [0x01, 0x01, 0x0e, 0x04, 0xea]);
  assert.equal(payload.length, 5);

  const frame = buildFrame(HidCommand.Remap, payload);
  // checksum = (5 + 35 + 0xEA) & 0xFF = 0x12
  assert.deepEqual(head(frame, 9), [0xab, 0x05, 0x23, 0x12, 0x01, 0x01, 0x0e, 0x04, 0xea]);
});

const TRAVEL_ENTRIES: TravelSetEntry[] = [
  {
    hardCode: 0x0e,
    type: 1,
    deadDownMm: 0.5,
    deadUpMm: 0.3,
    travelMm: 1.2,
    fastOutMm: 0,
    travelUpMm: 1.5,
    travelDownMm: 1.0,
  },
  {
    hardCode: 0x0f,
    type: 2,
    deadDownMm: 0.4,
    deadUpMm: 0.2,
    travelMm: 2.0,
    fastOutMm: 2.5,
    travelUpMm: 2.2,
    travelDownMm: 0.8,
  },
  {
    hardCode: 0x10,
    type: 1,
    deadDownMm: 1.0,
    deadUpMm: 0.5,
    travelMm: 1.5,
    fastOutMm: 0,
    travelUpMm: 1.8,
    travelDownMm: 1.2,
  },
  {
    hardCode: 0x11,
    type: 1,
    deadDownMm: 0.6,
    deadUpMm: 0.25,
    travelMm: 2.6,
    fastOutMm: 0,
    travelUpMm: 3.0,
    travelDownMm: 2.4,
  },
  {
    hardCode: 0x12,
    type: 2,
    deadDownMm: 0.7,
    deadUpMm: 0.35,
    travelMm: 3.2,
    fastOutMm: 3.4,
    travelUpMm: 3.6,
    travelDownMm: 3.1,
  },
];

test('golden 5: travelSetPayloads splits 5 keys into 4 + 1', () => {
  const payloads = travelSetPayloads(TRAVEL_ENTRIES, 5);
  assert.equal(payloads.length, 2);

  const [first, second] = payloads;
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.length, 14 * 4 + 2);
  assert.equal(first.length, 58);
  assert.equal(second.length, 14 * 1 + 2);
  assert.equal(second.length, 16);

  assert.deepEqual(first, [
    0x01, 0x05,
    0x0e, 0x01, 0x13, 0x88, 0x0b, 0xb8, 0x2e, 0xe0, 0x00, 0x00, 0x3a, 0x98, 0x27, 0x10,
    0x0f, 0x02, 0x0f, 0xa0, 0x07, 0xd0, 0x4e, 0x20, 0x61, 0xa8, 0x55, 0xf0, 0x1f, 0x40,
    0x10, 0x01, 0x27, 0x10, 0x13, 0x88, 0x3a, 0x98, 0x00, 0x00, 0x46, 0x50, 0x2e, 0xe0,
    0x11, 0x01, 0x17, 0x70, 0x09, 0xc4, 0x65, 0x90, 0x00, 0x00, 0x75, 0x30, 0x5d, 0xc0,
  ]);
  assert.deepEqual(second, [
    0x01, 0x05,
    0x12, 0x02, 0x1b, 0x58, 0x0d, 0xac, 0x7d, 0x00, 0x84, 0xd0, 0x8c, 0xa0, 0x79, 0x18,
  ]);

  const firstFrame = buildFrame(HidCommand.Travel, first);
  const secondFrame = buildFrame(HidCommand.Travel, second);
  // (58 + 41 + 0xC0) & 0xFF = 0x23; (16 + 41 + 0x18) & 0xFF = 0x51
  assert.equal(firstFrame[1], 58);
  assert.equal(firstFrame[3], 0x23);
  assert.equal(secondFrame[1], 16);
  assert.equal(secondFrame[3], 0x51);
});

test('golden 6: mptSetPayload orders mm, hid per tap', () => {
  // 6.5535 mm is quantised onto the firmware's 0.01 mm grid (6.55 mm).
  const payload = mptSetPayload(0x0e, [0x04ea, 0x04eb, 0x2c], [1.0, 2.5, 6.5535]);
  assert.deepEqual(payload, [
    0x01, 0x0e,
    0x27, 0x10, 0x04, 0xea,
    0x61, 0xa8, 0x04, 0xeb,
    0xff, 0xdc, 0x00, 0x2c,
  ]);
  assert.equal(payload.length, 14);

  const frame = buildFrame(HidCommand.Mpt, payload);
  // checksum = (14 + 39 + 0x2C) & 0xFF = 0x61
  assert.deepEqual(head(frame, 18), [
    0xab, 0x0e, 0x27, 0x61,
    0x01, 0x0e,
    0x27, 0x10, 0x04, 0xea,
    0x61, 0xa8, 0x04, 0xeb,
    0xff, 0xdc, 0x00, 0x2c,
  ]);
});

test('commands: remaining payload lengths match the frame length byte', () => {
  const cases: [string, readonly number[], number][] = [
    ['lightGetPayload', lightGetPayload(), 2],
    ['keyColorGetPayload', keyColorGetPayload(), 2],
    ['travelGetPayload', travelGetPayload(), 2],
    ['featureGetPayload', featureGetPayload(), 2],
    ['remapGetPayload', remapGetPayload(0), 3],
    ['featureClearPayload', featureClearPayload(0x0e), 2],
    ['featureGetOnePayload', featureGetOnePayload(HidCommand.Mt, 0x0e), 5],
    ['mtSetPayload', mtSetPayload(0x0e, 0x04ea, 0x04eb, 3), 7],
    ['tglSetPayload', tglSetPayload(0x0e, 0x2c, 3), 5],
    ['endSetPayload', endSetPayload(0x0e, 0x2c, 3), 5],
    ['socdSetPayload', socdSetPayload(0x0e, 1, 0x0f, 1, 1, 2), 7],
    ['rsSetPayload', rsSetPayload(0x0e, 0x0f, 1, 2), 5],
    ['jzColorGetPayload', jzColorGetPayload(), 7],
    ['macroGetPayload', macroGetPayload(), 5],
  ];
  for (const [name, payload, expected] of cases) {
    assert.equal(payload.length, expected, name);
    for (const byte of payload) {
      assert.ok(Number.isInteger(byte) && byte >= 0 && byte <= 255, `${name} byte out of range`);
    }
    const frame = buildFrame(1, payload);
    assert.equal(frame[1], expected, name);
  }

  assert.deepEqual(remapGetPayload(0), [0, 0, 0xff]);
  assert.deepEqual(remapGetPayload(2), [0, 2, 0xff]);
  assert.deepEqual(mtSetPayload(0x0e, 0x04ea, 0x2c, 3), [1, 0x0e, 0x04, 0xea, 0x00, 0x2c, 3]);
  assert.deepEqual(tglSetPayload(0x0e, 0x04ea, 2), [1, 0x0e, 0x04, 0xea, 2]);
  assert.deepEqual(featureClearPayload(0x0e), [1, 0x0e]);
  assert.deepEqual(featureGetOnePayload(HidCommand.Rs, 0x0e), [0, 0x0e, 0, 0, 0]);
  assert.deepEqual(featureGetOnePayload(HidCommand.Socd, 0x0e), [0, 0x0e, 0, 0, 0, 0, 0]);
  assert.deepEqual(macroGetPayload(), [0, 0, 0, 0xff, 0xff]);
});

test('commands: key colours are chunked 5n + 2', () => {
  const entries = [
    { hardCode: 0x0e, r: 255, g: 69, b: 112, brightness: 8 },
    { hardCode: 0x0f, r: 0, g: 255, b: 0, brightness: 10 },
  ];
  const payloads = keyColorSetPayloads(entries);
  assert.equal(payloads.length, 1);
  const [payload] = payloads;
  assert.ok(payload);
  assert.equal(payload.length, 5 * 2 + 2);
  assert.deepEqual(payload, [0x01, 0x02, 0x0e, 0xff, 0x45, 0x70, 0x08, 0x0f, 0x00, 0xff, 0x00, 0x0a]);

  const many = new Array(13).fill({ hardCode: 0x0e, r: 1, g: 2, b: 3, brightness: 4 });
  const chunks = keyColorSetPayloads(many, 11);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, 5 * 11 + 2);
  assert.equal(chunks[1]?.length, 5 * 2 + 2);
});

test('commands: travel values above 6.5535 mm are rejected', () => {
  assert.throws(() => mptSetPayload(0x0e, [0, 0, 0], [7, 0, 0]), ValidationError);
  assert.throws(() => mptSetPayload(0x0e, [0, 0, 0], [-1, 0, 0]), ValidationError);
  assert.throws(
    () => travelSetPayloads([{ ...TRAVEL_ENTRIES[0]!, travelMm: 7 }], 1),
    ValidationError,
  );
  assert.throws(
    () => travelSetPayloads([{ ...TRAVEL_ENTRIES[0]!, deadUpMm: 6.6 }], 1),
    ValidationError,
  );
  // The limit itself is fine; travel occupies payload bytes 8..9. 6.5535 mm is
  // quantised down to 6.55 mm (0xffdc) by the 0.01 mm grid.
  const payloads = travelSetPayloads([{ ...TRAVEL_ENTRIES[0]!, travelMm: 6.5535 }], 1);
  assert.deepEqual(payloads[0]?.slice(8, 10), [0xff, 0xdc]);
  const maxStep = travelSetPayloads([{ ...TRAVEL_ENTRIES[0]!, travelMm: 6.55 }], 1);
  assert.deepEqual(maxStep[0]?.slice(8, 10), [0xff, 0xdc]);
});

test('commands: chunking hints are validated', () => {
  assert.throws(() => keyColorSetPayloads([], 0), ValidationError);
  assert.throws(() => keyColorSetPayloads([], 12), ValidationError);
  assert.throws(() => travelSetPayloads([], 0, 0), ValidationError);
  assert.throws(() => travelSetPayloads([], 0, 5), ValidationError);
  assert.throws(() => travelSetPayloads([], 256), ValidationError);
  assert.deepEqual(travelSetPayloads([], 0), []);
});

test('commands: payloads are not shared between calls', () => {
  const a = miscPayload(19);
  const b = miscPayload(19);
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});
