import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  KEY_LAYOUTS,
  layoutOverlapInfo,
  parseKeyboardConfig,
  stringifyKeyboardConfig,
} from '@bookqaq/zmeow-sdk';
import { convertWootingProfile, wootingProfileToConfig } from '../../src/wooting/index.ts';

const ASSETS = new URL('../../../../assets/wooting-share/', import.meta.url);

function readProfile(name: string): string {
  return readFileSync(new URL(name, ASSETS), 'utf8');
}

/** Entries of a raw plan layer whose target differs from the key's own default usage. */
function overrideCount(
  plan: ReturnType<typeof convertWootingProfile>,
  layer: number,
): number {
  const defaults = new Map(
    KEY_LAYOUTS[plan.layout].keys.map((key) => [key.hardCode, key.hidCode]),
  );
  return Object.entries(plan.remap[layer] ?? {}).filter(([rawHardCode, usage]) => {
    const defaultUsage = defaults.get(Number(rawHardCode));
    return defaultUsage !== undefined && defaultUsage !== usage;
  }).length;
}

test('80HE profile round-trips as an extended79 backup document', () => {
  const config = wootingProfileToConfig(readProfile('wootility_profile_80he_6b0ea656b67ceb3a5a8410227b2371991b65.txt'));
  assert.equal(config.layout, 'extended79');
  assert.deepEqual(parseKeyboardConfig(stringifyKeyboardConfig(config)), config);

  // The raw plan carries the full default table (A -> 4 on hardCode 42,
  // Enter -> 40 on hardCode 53 — profile.test.ts asserts those values), but
  // every one of the 78 entries is an identity entry. The firmware normalizes
  // identity remaps away, so the backup drops them all and the restore leaves
  // the base layer untouched (patch semantics).
  const plan = convertWootingProfile(readProfile('wootility_profile_80he_6b0ea656b67ceb3a5a8410227b2371991b65.txt'));
  assert.equal(plan.stats.remapKeys, 78);
  assert.equal(overrideCount(plan, 0), 0);
  assert.deepEqual(config.remap.layers, {});

  assert.equal(Object.keys(config.keyColors).length, plan.stats.colorKeys);
  assert.equal(Object.keys(config.travel).length, plan.stats.travelKeys);
  assert.equal(plan.stats.colorKeys, 78);
  assert.equal(plan.stats.travelKeys, 78);
  assert.equal(config.light.mode, 255);
});

test('60HE+ profile becomes a compact65 backup with colours, travel and warnings', () => {
  const config = wootingProfileToConfig(readProfile('wootility_profile_60he_3d824c56ebb58cbd4d7022711cb7ee18d52c.txt'));
  assert.equal(config.layout, 'compact65');
  // The profile has no remap table, so no remap layer is written at all.
  assert.deepEqual(config.remap.layers, {});
  assert.equal(Object.keys(config.keyColors).length, 58);
  assert.equal(Object.keys(config.travel).length, 58);
  assert.equal(config.light.mode, 255);
  assert.equal(config.light.brightness, 10);
  assert.ok((config.warnings?.length ?? 0) > 0);
  assert.match(config.warnings?.[0] ?? '', /^Generated from a Wooting profile: /);
  assert.ok(config.warnings?.some((line) => line.includes('RGB effect')));
});

test('zekken profile keeps only the Fn-layer overrides on compact65', () => {
  const config = wootingProfileToConfig(readProfile('wootility_profile_share_a05d1869a2a5b2bc5983a492c87181622eb9.txt'), {
    layers: [0, 1],
  });
  assert.equal(config.layout, 'compact65');
  // Layer 0 maps every key onto its own default usage: the identity filter
  // drops the whole layer instead of writing 57 no-op remaps.
  assert.equal(config.remap.layers['0'], undefined);

  // Fn layer: 35 raw entries, 7 of them identity -> 28 overrides survive.
  const layer1 = config.remap.layers['1'];
  assert.ok(layer1);
  assert.equal(Object.keys(layer1).length, 28);
  const plan = convertWootingProfile(readProfile('wootility_profile_share_a05d1869a2a5b2bc5983a492c87181622eb9.txt'), {
    layers: [0, 1],
  });
  assert.equal(Object.keys(layer1).length, overrideCount(plan, 1));
  // compact65 has no Escape (hardCode 0 belongs to extended79 only), so the
  // profile's (1,0) Esc cell is skipped on both layers.
  assert.equal(layer1[0], undefined);
  assert.equal(layer1[13], undefined);

  // No surviving entry anywhere equals its key's default usage.
  const defaults = new Map(
    KEY_LAYOUTS['compact65'].keys.map((key) => [key.hardCode, key.hidCode]),
  );
  for (const [rawLayer, table] of Object.entries(config.remap.layers)) {
    assert.ok(rawLayer === '0' || rawLayer === '1' || rawLayer === '2');
    for (const [rawHardCode, usage] of Object.entries(table)) {
      const defaultUsage = defaults.get(Number(rawHardCode));
      assert.ok(defaultUsage !== undefined, `hardCode ${rawHardCode} must exist on compact65`);
      assert.notEqual(
        defaultUsage,
        usage,
        `layer ${rawLayer} hardCode ${rawHardCode} must be an override, not an identity remap`,
      );
    }
  }
});

test('e883 SOCD profile carries advanced keys into the backup', () => {
  const config = wootingProfileToConfig(readProfile('wootility_profile_share_e883d4a46db97c6d467eb13ea5297199e1bc.txt'));
  const socd = config.features.filter((feature) => feature.kind === 'socd');
  assert.equal(socd.length, 2);
  assert.deepEqual(
    socd.map((feature) => feature.hardCode),
    [42, 29],
  );
  assert.deepEqual(socd[0]!.targetHardCodes, [44]);
  assert.equal(socd[0]!.first1, 1);
  assert.equal(socd[0]!.first2, 1);
  assert.equal(config.features.filter((feature) => feature.kind === 'mt').length, 2);
  assert.equal(config.travel[29]!.travelDownMm, 1.88);
  assert.equal(config.travel[29]!.travelUpMm, 0.24);
  assert.deepEqual(parseKeyboardConfig(stringifyKeyboardConfig(config)), config);
});

test('generated backup documents have the neutral restore-ready structure', () => {
  const config = wootingProfileToConfig(readProfile('wootility_profile_80he_6b0ea656b67ceb3a5a8410227b2371991b65.txt'));
  assert.deepEqual(config.features, []);
  assert.deepEqual(config.misc, { winLock: null, lightSleep: null });
  assert.equal(config.firmwareVersion, null);
  assert.ok(!('boardId' in config), 'generated backups must not contain the board id');
  assert.ok(!('serialNumber' in config), 'generated backups must not contain the serial number');
  assert.deepEqual(config.product, { id: 10011, title: 'Zetsu63', vid: 14470, pid: 16385 });
  const createdAt = new Date(config.createdAt);
  assert.ok(!Number.isNaN(createdAt.getTime()), `createdAt must parse: ${config.createdAt}`);
});

test('layout overlap numbers come from the SDK helper', () => {
  assert.deepEqual(layoutOverlapInfo('extended79', 'compact65'), {
    sourceLayout: 'extended79',
    targetLayout: 'compact65',
    sharedKeys: 65,
    skippedKeys: 14,
  });
  assert.deepEqual(layoutOverlapInfo('compact65', 'extended79'), {
    sourceLayout: 'compact65',
    targetLayout: 'extended79',
    sharedKeys: 65,
    skippedKeys: 0,
  });
});
