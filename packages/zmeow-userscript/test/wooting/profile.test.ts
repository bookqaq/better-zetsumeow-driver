import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import {
  WOOTING_MODELS,
  WootingProfileVersionError,
  convertWootingProfile,
  extractWootingJson,
  parseWootingShare,
  summarizeWootingProfile,
  wootingDeviceTitle,
  wootingKeycodeToUsage,
  wootingModelForDevice,
  wootingProfileToConfig,
  wootingRestoreOptions,
} from '../../src/wooting/index.ts';
import { UnsupportedError } from '@bookqaq/zmeow-sdk';

const ASSETS = new URL('../../../../assets/wooting-share/', import.meta.url);

function readProfile(name: string): string {
  return readFileSync(new URL(name, ASSETS), 'utf8');
}

test('share fixtures store raw JSON and full profile codes in filenames', () => {
  const fixtures = readdirSync(ASSETS).filter((name) => name.endsWith('.txt'));
  assert.ok(fixtures.length >= 5);
  for (const name of fixtures) {
    const text = readProfile(name);
    assert.ok(text.startsWith('{'), `${name} must start with a JSON object`);
    assert.doesNotMatch(text, /^curl\b/m, `${name} must not contain curl headers`);
    const code = name.match(/([0-9a-f]{32,64})\.txt$/)?.[1];
    assert.ok(code, `${name} must contain the full profile code`);
    assert.ok(text.includes(code), `${name} must contain the code recorded in its name`);
  }
});

test('parses the 60HE fixture and summarizes the target', () => {
  const profile = parseWootingShare(readProfile('wootility_profile_60he_3d824c56ebb58cbd4d7022711cb7ee18d52c.txt'));
  const summary = summarizeWootingProfile(profile);
  assert.equal(summary.model, '60he');
  assert.equal(summary.targetDevice, 11);
  assert.equal(summary.name, 'Rapid Profile');
  assert.equal(summary.guid, '3d824c56ebb58cbd4d7022711cb7ee18d52c');
});

test('parses the 80HE fixture and detects the model', () => {
  const profile = parseWootingShare(readProfile('wootility_profile_80he_6b0ea656b67ceb3a5a8410227b2371991b65.txt'));
  assert.equal(summarizeWootingProfile(profile).model, '80he');
  assert.equal(summarizeWootingProfile(profile).name, 'Typing Profile');
});

test('extractWootingJson accepts a bare object, raw body and legacy curl wrapper', () => {
  const profile = extractWootingJson('{"data":{"target":{"device":11},"version":15}}');
  assert.deepEqual(profile, { data: { target: { device: 11 }, version: 15 } });
  assert.ok(extractWootingJson(readProfile('wootility_profile_60he_3d824c56ebb58cbd4d7022711cb7ee18d52c.txt')));

  const legacyCurl = [
    "curl --url 'https://api.wooting.io/public/wootility/profiles?code=test' \\",
    "  -H 'accept: */*'",
    '',
    '{"data":{"target":{"device":11},"version":15}}',
  ].join('\n');
  assert.deepEqual(extractWootingJson(legacyCurl), {
    data: { target: { device: 11 }, version: 15 },
  });
});

test('Wooting key codes map to HID usages and consumer usages', () => {
  assert.equal(wootingKeycodeToUsage(0x01), 0x04); // A
  assert.equal(wootingKeycodeToUsage(0x25), 0x28); // Enter
  assert.equal(wootingKeycodeToUsage(0x31), 0x34); // [
  assert.equal(wootingKeycodeToUsage(0x4f), 0x52); // Up
  assert.equal(wootingKeycodeToUsage(0xc4), 0x10e9); // Volume Up
  assert.equal(wootingKeycodeToUsage(0xe7), 40961); // Fn
  assert.equal(wootingKeycodeToUsage(0xe6), null); // Mode/system code without a Zetsu target
  assert.equal(wootingKeycodeToUsage(0xfe), null);
});

test('80HE conversion maps the default layer onto Zetsu extended79', () => {
  const plan = convertWootingProfile(readProfile('wootility_profile_80he_6b0ea656b67ceb3a5a8410227b2371991b65.txt'));
  assert.equal(WOOTING_MODELS['80he'].defaultLayout, 'extended79');
  assert.equal(plan.layout, 'extended79');
  assert.equal(plan.stats.remapKeys, 78);
  assert.equal(plan.stats.colorKeys, 78);
  assert.equal(plan.stats.travelKeys, 78);
  assert.equal(plan.remap[0]![42], 4); // A
  assert.equal(plan.remap[0]![53], 40); // Enter
  assert.equal(plan.remap[0]![79], 76); // Delete
  assert.equal(plan.remap[0]![81], 78); // PageDown
  assert.equal(plan.remap[0]![82], 82); // Up
  assert.equal(plan.remap[0]![170], 40961); // Fn
  assert.equal(plan.travel[42]!.pressMm, 1.6);
  assert.equal(plan.travel[42]!.fast, false);
  assert.equal(plan.keyColors[42]!.brightness, 10);
  // Wooting's digital-mode flag has no Zetsu equivalent; the analog settings
  // are still imported, so the conversion reports it instead of dropping them.
  assert.ok(plan.warnings.some((line) => line.includes('digital mode')));
});

test('60HE conversion imports custom actuation, per-key RT and colours', () => {
  const plan = convertWootingProfile(readProfile('wootility_profile_60he_3d824c56ebb58cbd4d7022711cb7ee18d52c.txt'));
  assert.equal(plan.layout, 'compact65');
  assert.equal(plan.stats.remapKeys, 0);
  // (1,0) is Escape, which compact65 does not have — one colour/travel fewer
  // than before the (1,0) correction (was 59 via the wrong Backquote mapping).
  assert.equal(plan.stats.colorKeys, 58);
  assert.equal(plan.stats.travelKeys, 58);
  assert.equal(plan.travel[29]!.pressMm, 0.4); // W
  assert.equal(plan.travel[29]!.fast, true);
  assert.equal(plan.travel[42]!.pressMm, 0.4); // A
  assert.equal(plan.travel[43]!.fast, true); // S
  assert.equal(plan.travel[44]!.fast, true); // D
  assert.equal(plan.travel[67]!.pressMm, 3); // Left Win custom actuation
  assert.ok(plan.warnings.some((line) => line.includes('no remap table')));
  assert.ok(plan.warnings.some((line) => line.includes('RGB effect')));
});

test('Wooting actuation up to the full 4mm switch travel is kept', () => {
  // Gateron magnetic switches span 0-4 mm; the old 3.1 mm cap was the official
  // UI slider preset and silently clamped legitimate Wootility values.
  const profile = {
    target: { device: 11 },
    analog: {
      actPoint: 16384, // 4.0 mm
      rapidTrigger: true,
      rapidTriggerSensitivity: 16384, // 4.0 mm press sensitivity
    },
  };
  const plan = convertWootingProfile(profile);
  const entries = Object.values(plan.travel);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.pressMm, 4);
    assert.equal(entry.releaseMm, 4); // rapid trigger active -> sensitivity
  }
  assert.ok(!plan.warnings.some((line) => line.includes('clamped')));
});

test('Wooting imports clear both Zetsu dead zones so minimum travel works', () => {
  for (const actPoint of [0.1, 3.9, 4]) {
    const plan = convertWootingProfile({
      target: { device: 11 },
      analog: { actPoint, rapidTriggerSensitivity: 0.15, rapidTrigger: true },
    });
    const entry = Object.values(plan.travel)[0]!;
    assert.equal(entry.pressMm, actPoint);
    assert.equal(entry.deadDownMm, 0, `top dead zone must be 0 at ${actPoint}mm`);
    assert.equal(entry.deadUpMm, 0, `bottom dead zone must be 0 at ${actPoint}mm`);
  }
});

test('Wooting strict actuation range controls the Zetsu fastOut field', () => {
  const strict = convertWootingProfile({
    target: { device: 11 },
    analog: {
      actPoint: 4096,
      rapidTrigger: true,
      rapidTriggerSensitivity: 1638,
      rapidTriggerStrictActuationRange: true,
    },
  });
  assert.equal(Object.values(strict.travel)[0]!.fastOutMm, 1);

  const fullRange = convertWootingProfile({
    target: { device: 11 },
    analog: {
      actPoint: 4096,
      rapidTrigger: true,
      rapidTriggerSensitivity: 1638,
      rapidTriggerStrictActuationRange: false,
    },
  });
  assert.equal(Object.values(fullRange.travel)[0]!.fastOutMm, 0);
});

test('global split RT sensitivity fills both travel directions', () => {
  // Direction verified against Wootility demo (2026-11-12): the primary
  // sensitivity slider is KEY PRESS - ACTIVATE (travelDown), the secondary is
  // KEY RELEASE - DEACTIVATE (travelUp).
  const plan = convertWootingProfile({
    version: 15,
    target: { device: 11 },
    analog: {
      actPoint: 4096,
      rapidTrigger: true,
      rapidTriggerSensitivity: 4096,
      rapidTriggerSecondarySensitivity: 1638,
      rapidTriggerStrictActuationRange: true,
    },
  });
  const entry = plan.travel[29]!;
  assert.equal(entry.fast, true);
  assert.equal(entry.pressMm, 1);
  assert.equal(entry.releaseMm, 0.4); // legacy alias: release/reset
  assert.equal(entry.travelUpMm, 0.4); // secondary 1638/4096 = release
  assert.equal(entry.travelDownMm, 1); // primary 4096/4096 = press
});

test('pre-v3 profiles use the legacy 8-bit analog scale', () => {
  const plan = convertWootingProfile({
    version: 2,
    target: { device: 11 },
    analog: { actPoint: 64, rapidTriggerSensitivity: 191, rapidTrigger: true },
    customActuations: [{ index: { rowNr: 1, colNr: 4 }, value: 128 }],
  });
  // 64/255*4 = 1.00 mm, 191/255*4 = 3.00 mm, 128/255*4 = 2.01 mm.
  assert.equal(plan.travel[29]!.pressMm, 1); // W, global actPoint
  assert.equal(plan.travel[29]!.releaseMm, 3);
  assert.equal(plan.travel[17]!.pressMm, 2.01); // Digit4, custom actuation
  assert.ok(plan.warnings.some((line) => line.includes('Legacy Wooting profile schema')));
  assert.ok(!plan.warnings.some((line) => line.includes('clamped')));
});

test('version 0 strict-actuation flag uses the pre-migration inverted semantics', () => {
  const old = convertWootingProfile({
    version: 0,
    target: { device: 11 },
    analog: {
      actPoint: 0.7,
      rapidTrigger: true,
      rapidTriggerSensitivity: 0.15,
      rapidTriggerStrictActuationRange: true,
    },
  });
  // Migration 1 flips the old flag: old true => current false => full-range RT.
  assert.equal(Object.values(old.travel)[0]!.fastOutMm, 0);

  const current = convertWootingProfile({
    version: 14,
    target: { device: 11 },
    analog: {
      actPoint: 0.7,
      rapidTrigger: true,
      rapidTriggerSensitivity: 0.15,
      rapidTriggerStrictActuationRange: true,
    },
  });
  assert.equal(Object.values(current.travel)[0]!.fastOutMm, 0.7);
});

test('wootingModelForDevice covers the 60HE and 80HE families', () => {
  for (const device of [4, 5, 9, 11]) assert.equal(wootingModelForDevice(device), '60he');
  for (const device of [10, 12]) assert.equal(wootingModelForDevice(device), '80he');
  // uwu / one / two / lekker and unknown ids are not importable
  for (const device of [0, 1, 2, 3, 6, 7, 8, 13]) assert.equal(wootingModelForDevice(device), null);
  assert.equal(wootingModelForDevice(null), null);
  assert.equal(wootingModelForDevice(undefined), null);
  assert.equal(wootingModelForDevice(Number.NaN), null);
});

test('summarizeWootingProfile reports the precise per-device title', () => {
  const titleFor = (device: number): string =>
    summarizeWootingProfile({ target: { device } }).modelTitle;
  assert.equal(titleFor(5), 'Wooting 60HE (ARM)');
  assert.equal(titleFor(9), 'Wooting 60HE+');
  assert.equal(titleFor(12), 'Wooting 80HE+');
  assert.equal(titleFor(11), 'Wooting 60HE v2');
  assert.equal(wootingDeviceTitle(2), 'Lekker (switch module, not a keyboard)');
  assert.equal(wootingDeviceTitle(99), null);
  assert.equal(wootingDeviceTitle(Number.NaN), null);
});

test('summarizeWootingProfile rejects unsupported devices with the family list', () => {
  const messageFor = (device: number): string => {
    try {
      summarizeWootingProfile({ target: { device } });
    } catch (error) {
      assert.ok(error instanceof UnsupportedError);
      return error.message;
    }
    throw new Error(`expected device ${device} to be rejected`);
  };
  assert.match(messageFor(7), /UwU/);
  assert.match(messageFor(8), /UwU/);
  assert.match(messageFor(0), /One/);
  assert.match(messageFor(1), /Two/);
  assert.match(messageFor(3), /Two/);
  assert.match(messageFor(6), /Two/);
  const unknown = messageFor(99);
  assert.match(unknown, /\b99\b/);
  assert.match(unknown, /unknown id, possibly a new Wooting model/);
  assert.match(unknown, /4\/5\/9\/11 \(60HE family\), 10\/12 \(80HE family\)/);
});

test('zekken share profile converts both layers onto its native compact65', () => {
  const plan = convertWootingProfile(readProfile('wootility_profile_share_a05d1869a2a5b2bc5983a492c87181622eb9.txt'), {
    layers: [0, 1],
  });
  // The profile's device id 5 (60HE ARM) is a 60HE model: the conversion always
  // targets the native compact65 layout; cross-layout is restore's job.
  assert.equal(plan.layout, 'compact65');
  // compact65 has no Escape (hardCode 0 belongs to extended79 only), so the
  // (1,0) Esc cell is skipped instead of mapping anywhere — and in particular
  // it must not become a Backquote remap on hardCode 13.
  assert.equal(plan.remap[0]![0], undefined);
  assert.equal(plan.remap[1]![0], undefined);
  assert.equal(plan.remap[1]![13], undefined);
  // L0: 62 entries - 4 null cells - 1 Escape cell = 57 writable; L1:
  // 43 - 2 null cells - 5 unknown consumer keycodes - 1 Escape cell = 35
  // writable -> 57 + 35 = 92 remaps, 5 + 3 = 8 skipped cells.
  assert.deepEqual(plan.stats, {
    remapKeys: 92,
    colorKeys: 58,
    travelKeys: 58,
    featureKeys: 0,
    skippedCells: 8,
    unknownKeycodes: 5,
  });
  assert.equal(
    plan.warnings.filter((line) => line.startsWith('Skipped Wooting keycode')).length,
    5,
  );
});

test('parseWootingShare accepts array wrappers and null optional blocks', () => {
  const profile = {
    version: 15,
    target: { device: 11 },
    analog: null,
    rgb: null,
    customActuations: null,
  };
  assert.equal(parseWootingShare({ data: [profile] }).version, 15);
  assert.equal(parseWootingShare([profile]).version, 15);
  assert.throws(
    () => parseWootingShare({ data: [profile, profile] }),
    /contains 2 profiles/,
  );
  assert.throws(
    () => parseWootingShare({ data: [] }),
    /contains no profile/,
  );
});

test('summarizeWootingProfile rejects a future schema before conversion', () => {
  assert.throws(
    () => summarizeWootingProfile({ version: 16, target: { device: 11 } }),
    WootingProfileVersionError,
  );
  assert.throws(
    () => parseWootingShare({ version: '15', target: { device: 11 } }),
    /version must be a non-negative integer/,
  );
});

test('excluded Wooting models say One / Two series / UwU are unsupported', () => {
  for (const device of [0, 1, 3, 6, 7, 8]) {
    try {
      summarizeWootingProfile({ target: { device } });
      throw new Error(`expected device ${device} to be rejected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Wooting One/);
      assert.match(message, /Wooting Two series/);
      assert.match(message, /Wooting UwU/);
      assert.match(message, /no partial migration/);
    }
  }
});

test('demo AKC fixture imports SOCD/MT/TGL/RS, skips DKS and layer 1', () => {
  const plan = convertWootingProfile(readProfile('wootility_profile_demo_akc.json'));

  const socd = plan.features.filter((feature) => feature.kind === 'socd');
  assert.equal(socd.length, 3);
  assert.deepEqual(
    socd.map((feature) => [feature.first1, feature.first2, feature.bottom]),
    [
      [1, 0, false],
      [0, 1, true],
      [1, 1, false],
    ],
  );

  const mt = plan.features.find((feature) => feature.kind === 'mt');
  assert.equal(mt?.hardCode, 42);
  assert.deepEqual(mt?.targetHidCodes, [0xe1, 0x04]);
  assert.equal(mt?.tapMs, 180);

  const tgl = plan.features.find((feature) => feature.kind === 'tgl');
  assert.equal(tgl?.hardCode, 43);
  assert.deepEqual(tgl?.targetHidCodes, [0x1a]);

  const rs = plan.features.find((feature) => feature.kind === 'rs');
  assert.equal(rs?.hardCode, 44);
  assert.deepEqual(rs?.targetHardCodes, [45]);
  assert.equal(rs?.bottom, true);

  assert.ok(plan.warnings.some((line) => line.includes('DKS')));
  assert.ok(plan.warnings.some((line) => line.includes('layer 1')));
  assert.equal(plan.features.some((feature) => feature.kind === 'dks'), false);
});

test('per-key RT false wins over global RT and duplicate cells merge', () => {
  const plan = convertWootingProfile(readProfile('wootility_profile_demo_akc.json'));
  // Global rapidTrigger is true; KeyS (row 3/col 2) has an explicit false.
  assert.equal(plan.travel[43]!.fast, false);
  assert.equal(plan.travel[43]!.releaseMm, plan.travel[43]!.pressMm);
  // KeyA has an object setting: sensitivity is press/down, secondary is release/up.
  assert.equal(plan.travel[42]!.fast, true);
  assert.equal(plan.travel[42]!.travelUpMm, 0.1); // secondary = release
  assert.equal(plan.travel[42]!.travelDownMm, 0.4); // primary = press
  // Space's custom actuation lands on the fifth matrix cell, not the first.
  assert.equal(plan.travel[69]!.pressMm, 0.4);
  assert.equal(plan.travel[69]!.fast, true);
});

test('wootingRestoreOptions skips lighting when the profile has no static colours', () => {
  const fixture = readProfile('wootility_profile_demo_akc.json');
  const withColors = wootingProfileToConfig(fixture);
  assert.ok(Object.keys(withColors.keyColors).length > 0);
  assert.deepEqual(wootingRestoreOptions(withColors), {
    restoreLight: true,
    restoreKeyColors: true,
    restoreFeatures: true,
    clearExtraFeatures: false,
  });

  const withoutColors = wootingProfileToConfig({
    version: 15,
    target: { device: 11 },
    analog: { actPoint: 4096 },
  });
  assert.equal(Object.keys(withoutColors.keyColors).length, 0);
  assert.deepEqual(wootingRestoreOptions(withoutColors), {
    restoreLight: false,
    restoreKeyColors: false,
    restoreFeatures: false,
    clearExtraFeatures: false,
  });
});

test('layer selection only imports the requested remap layers', () => {
  const fixture = readProfile('wootility_profile_demo_akc.json');
  const base = convertWootingProfile(fixture);
  assert.deepEqual(base.remap, {});
  const withFn = convertWootingProfile(fixture, { layers: [0, 1] });
  assert.equal(withFn.remap[1]![29], 0x08); // Wooting keycode 5 = HID E
});

test('Fn2 (layer 2) is ignored with a warning because Zetsu has one Fn layer', () => {
  // This share profile carries entries for all three Wooting layers. The import
  // asks for layer 0 (base) + layer 1 (first Fn); layer 2 has no Zetsu target.
  const fixture = readProfile('wootility_profile_share_a05d1869a2a5b2bc5983a492c87181622eb9.txt');
  const plan = convertWootingProfile(fixture, { layers: [0, 1] });
  assert.deepEqual(Object.keys(plan.remap), ['0', '1']);
  assert.ok(
    plan.warnings.some((line) => line.includes('remap layer(s) 2 were ignored')),
    'the ignored Fn2 layer must be reported',
  );
});

test('SOCD pairs are imported once and a key cannot join two pairs', () => {
  const cell = (rowNr: number, colNr: number) => ({ rowNr, colNr });
  const socd = (from: [number, number], to: [number, number]) => ({
    keyIndex: cell(...from),
    layer: 0,
    socd: { secondaryKey: cell(...to), socd: 2, inputBothWhenBottomedOut: false },
  });
  const plan = convertWootingProfile({
    version: 15,
    target: { device: 11 },
    akc: [
      socd([2, 2], [2, 3]), // W/E: accepted
      socd([2, 3], [2, 2]), // E/W: same unordered pair -> duplicate
      socd([2, 4], [2, 5]), // R/T: accepted (disjoint)
      socd([3, 1], [3, 2]), // A/S: accepted (disjoint)
      socd([3, 1], [2, 3]), // A/E: A already source in A/S -> duplicate source
      socd([3, 2], [3, 3]), // S/D: S already in A/S -> conflict
      socd([3, 4], [3, 4]), // F/F: self pair
    ],
  });
  const pairs = plan.features
    .filter((feature) => feature.kind === 'socd')
    .map((feature) => [feature.hardCode, feature.targetHardCodes?.[0]]);
  assert.deepEqual(pairs, [
    [29, 30], // W/E
    [31, 32], // R/T
    [42, 43], // A/S
  ]);
  assert.ok(plan.warnings.some((line) => line.includes('duplicate Wooting SOCD pair KeyE/KeyW')));
  assert.ok(plan.warnings.some((line) => line.includes('duplicate Wooting AKC entry on KeyA')));
  assert.ok(plan.warnings.some((line) => line.includes('KeyS is already bound')));
  assert.ok(plan.warnings.some((line) => line.includes('both keys are the same')));
});

test('RS pairs are also unique and exclusive', () => {
  const rs = (from: [number, number], to: [number, number]) => ({
    keyIndex: { rowNr: from[0], colNr: from[1] },
    layer: 0,
    rappySnappy: {
      secondaryKey: { rowNr: to[0], colNr: to[1] },
      socd: 0,
      inputBothWhenBottomedOut: false,
    },
  });
  const plan = convertWootingProfile({
    version: 15,
    target: { device: 11 },
    akc: [
      rs([2, 2], [2, 3]),
      rs([2, 3], [2, 2]),
      rs([2, 3], [2, 4]),
      rs([2, 4], [2, 4]),
    ],
  });
  assert.equal(plan.features.filter((feature) => feature.kind === 'rs').length, 1);
  assert.ok(plan.warnings.some((line) => line.includes('duplicate Wooting RS pair')));
  assert.ok(plan.warnings.some((line) => line.includes('already bound')));
  assert.ok(plan.warnings.some((line) => line.includes('both keys are the same')));
});
