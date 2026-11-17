import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFrame } from '../../src/protocol/frame.ts';
import { HidCommand, jzColorGetPayload } from '../../src/protocol/commands.ts';
import {
  decodeDeviceInfo,
  decodeFeature,
  decodeFeatureList,
  decodeKeyColors,
  decodeKeyMap,
  decodeKeyTravel,
  decodeLight,
  decodeMisc,
  decodeTravelConfig,
} from '../../src/protocol/response.ts';

const SN = 'SN123456789012345678'; // 20 chars + NUL fill = 21-byte field

function deviceInfoPayload(runModeNum: number): number[] {
  const payload = new Array<number>(34).fill(0);
  payload[0] = 0xff;
  // frame[5] doubles as the board-id's first byte and the run mode.
  payload[1] = runModeNum;
  for (let i = 0; i < SN.length; i += 1) payload[2 + i] = SN.charCodeAt(i);
  const version = '1.2.9';
  for (let i = 0; i < version.length; i += 1) payload[23 + i] = version.charCodeAt(i);
  return payload;
}

test('decode: cmd 1 device info', () => {
  const frame = buildFrame(HidCommand.DeviceInfo, deviceInfoPayload(1));
  assert.deepEqual(decodeDeviceInfo(frame), {
    // board id covers frame bytes 5..8 = run-mode byte + "SN1"
    boardId: '01534E31',
    sn: SN,
    firmwareVersion: '1.2.9',
    runMode: 'app',
    runModeNum: 1,
  });

  const boot = decodeDeviceInfo(buildFrame(HidCommand.DeviceInfo, deviceInfoPayload(2)));
  assert.ok(boot);
  assert.equal(boot.boardId, '02534E31');
  assert.equal(boot.runMode, 'boot');
  assert.equal(boot.runModeNum, 2);

  // Unknown run modes stay app but are reported verbatim.
  const odd = decodeDeviceInfo(buildFrame(HidCommand.DeviceInfo, deviceInfoPayload(7)));
  assert.ok(odd);
  assert.equal(odd.runMode, 'app');
  assert.equal(odd.runModeNum, 7);

  assert.equal(decodeDeviceInfo(buildFrame(HidCommand.Light, [0, 0, 0])), null);
});

test('decode: cmd 2 misc readings', () => {
  const misc = (sub: number, value: number): Uint8Array =>
    buildFrame(HidCommand.Misc, [0x00, sub, value]);

  assert.deepEqual(decodeMisc(misc(6, 1)), { kind: 'winLock', value: true });
  assert.deepEqual(decodeMisc(misc(6, 0)), { kind: 'winLock', value: false });
  assert.deepEqual(decodeMisc(misc(9, 1)), { kind: 'highPrecision', value: true });
  assert.deepEqual(decodeMisc(misc(12, 66)), { kind: 'pzNum', value: 66 });
  assert.deepEqual(decodeMisc(misc(14, 8)), { kind: 'lightSleep', value: 8 });
  assert.deepEqual(decodeMisc(misc(16, 1)), { kind: 'isLock', value: 1 });
  assert.deepEqual(decodeMisc(misc(18, 1)), { kind: 'macMode', value: true });
  // 79 means the F-row module is installed.
  assert.deepEqual(decodeMisc(misc(19, 79)), { kind: 'fMode', value: 79 });
  // Unknown sub-commands and other commands are not misc readings.
  assert.equal(decodeMisc(misc(77, 0)), null);
  assert.equal(decodeMisc(buildFrame(HidCommand.Light, [0, 0, 0])), null);
});

test('decode: cmd 19 light state', () => {
  const frame = buildFrame(HidCommand.Light, [0x00, 1, 80, 0, 8, 255, 69, 112, 0]);
  assert.deepEqual(decodeLight(frame), {
    mode: 1,
    speed: 80,
    turn: 0,
    brightness: 8,
    rgb: '#FF4570',
    colorful: 0,
  });
  assert.equal(decodeLight(buildFrame(HidCommand.KeyColor, [0, 0])), null);
});

test('decode: cmd 20 key colours skip empty slots', () => {
  const payload = [
    0x00,
    0x0e, 255, 69, 112, 8,
    0x0f, 0, 255, 0, 10,
    0x00, 0, 0, 0, 0,
  ];
  const colors = decodeKeyColors(buildFrame(HidCommand.KeyColor, payload));
  assert.ok(colors);
  assert.equal(colors.size, 2);
  assert.deepEqual(colors.get(0x0e), { rgb: '#FF4570', brightness: 8 });
  assert.deepEqual(colors.get(0x0f), { rgb: '#00FF00', brightness: 10 });
  assert.equal(colors.has(0x00), false);
  assert.equal(decodeKeyColors(buildFrame(HidCommand.Light, [0, 0])), null);
});

test('decode: cmd 35 key map', () => {
  const payload = [
    0x00,
    0x0e, 0x04, 0xea,
    0x0f, 0x00, 0x2c,
    0x10, 0x00, 0x00,
  ];
  const frame = buildFrame(HidCommand.Remap, payload);
  const map = decodeKeyMap(frame);
  assert.ok(map);
  assert.equal(map.size, 3);
  assert.deepEqual(map.get(0x0e), { usage: 0x04ea, assigned: true });
  assert.deepEqual(map.get(0x0f), { usage: 0x2c, assigned: true });
  assert.deepEqual(map.get(0x10), { usage: 0, assigned: false });

  // A 3-byte payload is the single-key remap ack, not a key map.
  assert.equal(decodeKeyMap(buildFrame(HidCommand.Remap, [0, 0x0e, 0xff])), null);
  assert.equal(decodeKeyMap(buildFrame(HidCommand.Light, [0, 0])), null);
});

test('decode: cmd 47 feature list', () => {
  const payload = [0x00, 0x0e, 43, 0x0f, 45, 0x10, 40, 0x11, 0, 0x12, 44];
  const map = decodeFeatureList(buildFrame(HidCommand.Feature, payload));
  assert.ok(map);
  assert.deepEqual(
    [...map.entries()],
    [
      [0x0e, 'socd'],
      [0x0f, 'rs'],
      [0x10, 'end'],
      [0x11, 'none'],
      [0x12, 'socd'],
    ],
  );
  assert.equal(decodeFeatureList(buildFrame(HidCommand.Light, [0, 0])), null);
});

test('decode: cmd 36 MT', () => {
  const frame = buildFrame(HidCommand.Mt, [0x00, 0x0e, 0x04, 0xea, 0x04, 0xeb, 3]);
  assert.deepEqual(decodeFeature(frame), {
    hardCode: 0x0e,
    kind: 'mt',
    targetHidCodes: [0x04ea, 0x04eb],
    tapMs: 30,
  });
});

test('decode: cmd 37 TGL and cmd 40 END', () => {
  assert.deepEqual(decodeFeature(buildFrame(HidCommand.Tgl, [0x00, 0x0e, 0x04, 0xea, 2])), {
    hardCode: 0x0e,
    kind: 'tgl',
    targetHidCodes: [0x04ea],
    tapMs: 20,
  });
  assert.deepEqual(decodeFeature(buildFrame(HidCommand.End, [0x00, 0x0e, 0x00, 0x2c, 5])), {
    hardCode: 0x0e,
    kind: 'end',
    targetHidCodes: [0x2c],
    tapMs: 50,
  });
});

test('decode: cmd 38 DKS only exposes the key id', () => {
  assert.deepEqual(decodeFeature(buildFrame(HidCommand.Dks, [0x00, 0x0e])), {
    hardCode: 0x0e,
    kind: 'dks',
  });
});

test('decode: cmd 39 MPT', () => {
  const payload = [
    0x00, 0x0e,
    0x27, 0x10, 0x04, 0xea,
    0x61, 0xa8, 0x04, 0xeb,
    0xff, 0xff, 0x00, 0x2c,
  ];
  assert.deepEqual(decodeFeature(buildFrame(HidCommand.Mpt, payload)), {
    hardCode: 0x0e,
    kind: 'mpt',
    travelMm: [1, 2.5, 6.5535],
    targetHidCodes: [0x04ea, 0x04eb, 0x2c],
  });
});

test('decode: cmd 43 SOCD and cmd 45 RS', () => {
  assert.deepEqual(
    decodeFeature(buildFrame(HidCommand.Socd, [0x00, 0x0e, 1, 0x0f, 1, 1, 2])),
    {
      hardCode: 0x0e,
      kind: 'socd',
      targetHardCodes: [0x0f],
      first1: 1,
      first2: 1,
      bottom: true,
      pauseMs: 20,
    },
  );
  assert.deepEqual(decodeFeature(buildFrame(HidCommand.Rs, [0x00, 0x0e, 0x0f, 0, 3])), {
    hardCode: 0x0e,
    kind: 'rs',
    targetHardCodes: [0x0f],
    bottom: false,
    pauseMs: 30,
  });
  // Unrelated commands are not feature responses.
  assert.equal(decodeFeature(buildFrame(HidCommand.Light, [0, 0])), null);
});

test('decode: feature replies use fixed offsets even when [1] is declared short', () => {
  // 2026-11-08 real device: cmd 45 replies declared fewer bytes than they
  // actually wrote, so the clamping decoder returned null and backups
  // captured the RS kind without any of its parameters.
  const rs = buildFrame(HidCommand.Rs, [0x00, 29, 43, 1, 10]);
  rs[1] = 3;
  assert.deepEqual(decodeFeature(rs), {
    hardCode: 29,
    kind: 'rs',
    targetHardCodes: [43],
    bottom: true,
    pauseMs: 100,
  });

  const mt = buildFrame(HidCommand.Mt, [0x00, 0x0e, 0x04, 0xea, 0x04, 0xeb, 3]);
  mt[1] = 4;
  assert.deepEqual(decodeFeature(mt), {
    hardCode: 0x0e,
    kind: 'mt',
    targetHidCodes: [0x04ea, 0x04eb],
    tapMs: 30,
  });

  const socd = buildFrame(HidCommand.Socd, [0x00, 0x0e, 1, 0x0f, 1, 1, 2]);
  socd[1] = 2;
  assert.deepEqual(decodeFeature(socd), {
    hardCode: 0x0e,
    kind: 'socd',
    targetHardCodes: [0x0f],
    first1: 1,
    first2: 1,
    bottom: true,
    pauseMs: 20,
  });
});

test('decode: cmd 48 travel (single + release)', () => {
  assert.deepEqual(decodeKeyTravel(buildFrame(48, [0x00, 0x0e, 0xff, 0xff])), {
    kind: 'release',
    hardCode: 0x0e,
  });
  assert.deepEqual(decodeKeyTravel(buildFrame(48, [0x00, 0x0e, 0x2e, 0xe0])), {
    kind: 'single',
    hardCode: 0x0e,
    mm: 1.2,
  });
  assert.equal(decodeKeyTravel(buildFrame(HidCommand.Light, [0, 0])), null);
});

test('decode: cmd 102 12-key travel batch', () => {
  const payload = new Array<number>(60).fill(0);
  // slot 0: hardCode 0x0E, adc 0x0100, travel 1.0 mm
  payload[0] = 0x0e;
  payload[1] = 0x01;
  payload[2] = 0x00;
  payload[3] = 0x27;
  payload[4] = 0x10;
  // slot 1 stays empty (hardCode 0) and must be skipped.
  // slot 2: hardCode 0x0F, adc 0x0200, travel 2.5 mm
  payload[10] = 0x0f;
  payload[11] = 0x02;
  payload[12] = 0x00;
  payload[13] = 0x61;
  payload[14] = 0xa8;

  assert.deepEqual(decodeKeyTravel(buildFrame(102, payload)), {
    kind: 'batch',
    entries: [
      { hardCode: 0x0e, mm: 1, adc: 0x0100 },
      { hardCode: 0x0f, mm: 2.5, adc: 0x0200 },
    ],
  });
});

test('decode: cmd 41 bulk travel configuration', () => {
  const payload = new Array<number>(57).fill(0);
  payload[0] = 0x01; // write flag echoed by the device

  // slot 0 @ payload[1..14]
  payload[1] = 0x0e;
  payload[2] = 1; // normal
  payload[3] = 0x13; // deadDown 0.5
  payload[4] = 0x88;
  payload[5] = 0x0b; // deadUp 0.3
  payload[6] = 0xb8;
  payload[7] = 0x2e; // travel 1.2
  payload[8] = 0xe0;
  payload[9] = 0x00; // fastOut 0
  payload[10] = 0x00;
  payload[11] = 0x3a; // travelUp 1.5
  payload[12] = 0x98;
  payload[13] = 0x27; // travelDown 1.0
  payload[14] = 0x10;

  // slot 1 @ payload[15..28] stays an empty slot (hardCode 0).

  // slot 2 @ payload[29..42], fast trigger, travel-down 0 -> release falls back
  payload[29] = 0x10;
  payload[30] = 2; // fast
  payload[31] = 0x0f; // deadDown 0.4
  payload[32] = 0xa0;
  payload[33] = 0x07; // deadUp 0.2
  payload[34] = 0xd0;
  payload[35] = 0x4e; // travel 2.0
  payload[36] = 0x20;
  payload[37] = 0x61; // fastOut 2.5
  payload[38] = 0xa8;
  payload[39] = 0x55; // travelUp 2.2
  payload[40] = 0xf0;
  payload[41] = 0x00; // travelDown 0
  payload[42] = 0x00;

  const config = decodeTravelConfig(buildFrame(HidCommand.Travel, payload));
  assert.ok(config);
  assert.deepEqual(
    [...config.keys()],
    [0x0e, 0x10],
  );
  // Normal (type 1) keys carry no rapid-trigger data: the bundle skips
  // travelUp/travelDown entirely, so release collapses to the actuation point.
  assert.deepEqual(config.get(0x0e), {
    hardCode: 0x0e,
    pressMm: 1.2,
    releaseMm: 1.2,
    travelDownMm: 1.2,
    travelUpMm: 1.2,
    deadDownMm: 0.5,
    deadUpMm: 0.3,
    fastOutMm: 0,
    fast: false,
  });
  assert.deepEqual(config.get(0x10), {
    hardCode: 0x10,
    pressMm: 2,
    releaseMm: 2,
    travelDownMm: 2,
    travelUpMm: 2.2,
    deadDownMm: 0.4,
    deadUpMm: 0.2,
    fastOutMm: 2.5,
    fast: true,
  });
  assert.equal(decodeTravelConfig(buildFrame(HidCommand.Light, [0, 0])), null);
});

test('decode: jz colour request payload is not mistaken for a response', () => {
  assert.deepEqual(jzColorGetPayload(), [0, 0, 0, 0, 0, 0, 0]);
});

test('decode: cmd 48 travel reads absolute offsets despite a short length byte', () => {
  // The firmware declares [1] = 3 while the payload bytes live at 4..7.
  const press = buildFrame(48, [0, 0x1c, 0x03, 0xe8]);
  press[1] = 3;
  assert.deepEqual(decodeKeyTravel(press), { kind: 'single', hardCode: 0x1c, mm: 0.1 });

  const release = buildFrame(48, [0, 0x1c, 0xff, 0xff]);
  release[1] = 3;
  assert.deepEqual(decodeKeyTravel(release), { kind: 'release', hardCode: 0x1c });

  // hardCode 0 is an idle slot, not a key.
  assert.equal(decodeKeyTravel(buildFrame(48, [0, 0, 0, 0])), null);
});
