import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  captureKeyboardConfig,
  parseKeyboardConfig,
  restoreKeyboardConfig,
  stringifyKeyboardConfig,
  validateKeyboardConfig,
} from '../../src/config/index.ts';
import { KEY_LAYOUTS, ZETSU63_PRODUCT } from '../../src/generated/product-zetsu63.ts';
import { ValidationError } from '../../src/errors.ts';
import type { ConfigKeyboard, KeyboardConfig } from '../../src/config/types.ts';
import type {
  FeatureConfig,
  FeatureKind,
  KeyColor,
  KeyLayout,
  KeyMapEntry,
  KeyRef,
  LightState,
  TravelEntry,
} from '../../src/types.ts';
import type {
  KeyColorInput,
  RemapRestoreResult,
  RemapSnapshot,
  SetKeyColorOptions,
  SetLightPatch,
  TravelConfigEntry,
} from '../../src/keyboard.ts';

function makeLayout(): KeyLayout {
  const keys = KEY_LAYOUTS.compact65.keys;
  return {
    mode: 'compact65',
    keyCount: keys.length,
    hasFRow: false,
    rawFMode: 65,
    keys,
    byHardCode: new Map(keys.map((key) => [key.hardCode, key])),
    byTextCode: new Map(keys.map((key) => [key.textCode, key])),
    byTitle: new Map(keys.map((key) => [key.title, key])),
  };
}

class FakeKeyboard implements ConfigKeyboard {
  readonly layout = makeLayout();
  readonly info = {
    boardId: '310110',
    sn: 'SN-TEST',
    firmwareVersion: '1.1.1',
    runMode: 'app' as const,
    runModeNum: 1,
    pzNum: 1,
    isMac: null,
    winLock: null,
    highPrecision: null,
    isLock: null,
    lightSleep: null,
    fMode: 65,
  };
  readonly product = ZETSU63_PRODUCT;

  light: LightState = {
    mode: 1,
    speed: 80,
    turn: 0,
    brightness: 8,
    colorful: 0,
    rgb: '#FF4570',
  };
  colors = new Map<number, KeyColor>();
  remaps: Record<number, Map<number, number>> = {
    0: new Map(),
    1: new Map(),
    2: new Map(),
  };
  features = new Map<number, FeatureConfig>();
  travel = new Map<number, TravelEntry>();
  winLock = false;
  lightSleep = 10;
  /** Layers whose `getKeyMap` rejects — for capture fault-tolerance tests. */
  readonly failLayers = new Set<0 | 1 | 2>();
  /** When true, `getFeatures` rejects — for the cmd 47 fault-tolerance tests. */
  failFeatures = false;
  /** hardCodes whose first travel write is silently dropped (verify tests). */
  readonly dropTravelOnce = new Set<number>();
  /** hardCodes whose travel writes are always dropped (verify tests). */
  readonly dropTravelAlways = new Set<number>();
  /** Last options the restore passed to `restoreRemapSnapshot`. */
  lastRestoreRemapOptions: {
    readonly layers?: readonly (0 | 1 | 2)[];
    readonly settleMs?: number;
    readonly verify?: boolean;
    readonly writeGapMs?: number;
  } | null = null;

  calls: string[] = [];

  async ensureKeyTestStopped(): Promise<boolean> {
    this.calls.push('ensureKeyTestStopped');
    return false;
  }
  async getLight(): Promise<LightState> {
    return { ...this.light };
  }
  async getKeyColors(): Promise<Map<number, KeyColor>> {
    return new Map(this.colors);
  }
  async getKeyMap(layer: 0 | 1 | 2 = 0): Promise<Map<number, KeyMapEntry>> {
    if (this.failLayers.has(layer)) {
      throw new Error(`layer ${layer} does not answer`);
    }
    const map = new Map<number, KeyMapEntry>();
    for (const [hardCode, usage] of this.remaps[layer] ?? []) {
      const key = this.layout.byHardCode.get(hardCode);
      if (!key) continue;
      map.set(hardCode, { hardCode, hidCode: usage, title: key.title, textCode: key.textCode });
    }
    return map;
  }
  async getFeatures(): Promise<Map<number, FeatureKind>> {
    if (this.failFeatures) {
      throw new Error('cmd 47 timed out');
    }
    const map = new Map<number, FeatureKind>();
    for (const [hardCode, feature] of this.features) map.set(hardCode, feature.kind);
    return map;
  }
  async getFeature(key: KeyRef): Promise<FeatureConfig | null> {
    return this.features.get(Number(key)) ?? null;
  }
  async getTravelConfig(): Promise<Map<number, TravelEntry>> {
    return new Map(this.travel);
  }
  async getWinLock(): Promise<boolean> {
    return this.winLock;
  }
  async getLightSleep(): Promise<number> {
    return this.lightSleep;
  }
  async setLight(patch: SetLightPatch): Promise<void> {
    this.calls.push('setLight');
    this.light = { ...this.light, ...patch } as LightState;
  }
  async setKeyColors(entries: readonly KeyColorInput[]): Promise<void> {
    this.calls.push(`setKeyColors:${entries.length}`);
    for (const entry of entries) {
      this.colors.set(Number(entry.key), {
        rgb: entry.color as KeyColor['rgb'],
        brightness: entry.brightness ?? 8,
      });
    }
  }
  async setKeyColor(
    _keys: KeyRef | readonly KeyRef[],
    _color: string | { readonly r: number; readonly g: number; readonly b: number },
    _options?: SetKeyColorOptions,
  ): Promise<void> {
    throw new Error('setKeyColor is not used by the config module');
  }
  async setKeyRemap(
    source: KeyRef,
    target: KeyRef,
    options: { readonly layer?: 0 | 1 | 2 } = {},
  ): Promise<void> {
    this.calls.push('setKeyRemap');
    this.remaps[options.layer ?? 0]!.set(Number(source), Number(target));
  }
  async restoreRemapSnapshot(
    snapshot: RemapSnapshot,
    options: {
      readonly layers?: readonly (0 | 1 | 2)[];
      readonly settleMs?: number;
      readonly verify?: boolean;
      readonly writeGapMs?: number;
    } = {},
  ): Promise<RemapRestoreResult> {
    this.calls.push('restoreRemapSnapshot');
    this.lastRestoreRemapOptions = options;
    const layers = options.layers ?? (Object.keys(snapshot.layers).map(Number) as (0 | 1 | 2)[]);
    let written = 0;
    let unchanged = 0;
    let skipped = 0;
    const entries: RemapRestoreResult['entries'][number][] = [];
    for (const layer of layers) {
      const table = snapshot.layers[layer];
      if (!table) continue;
      for (const [rawHardCode, to] of Object.entries(table)) {
        const hardCode = Number(rawHardCode);
        const key = this.layout.byHardCode.get(hardCode);
        if (!key) {
          skipped += 1;
          continue;
        }
        const from = this.remaps[layer]?.get(hardCode) ?? 0;
        if (from === to) {
          unchanged += 1;
          continue;
        }
        this.remaps[layer]!.set(hardCode, to);
        written += 1;
        entries.push({
          layer,
          hardCode,
          title: key.title,
          textCode: key.textCode,
          from,
          to,
        });
      }
    }
    return { entries, written, unchanged, skipped };
  }
  async setTravelConfig(entries: readonly TravelConfigEntry[]): Promise<void> {
    this.calls.push(`setTravelConfig:${entries.length}`);
    for (const entry of entries) {
      const key = Number(entry.key);
      if (this.dropTravelAlways.has(key)) continue;
      if (this.dropTravelOnce.delete(key)) continue;
      // Store like the device reads back: for normal (type 1) keys the
      // firmware does not keep the RT fields (releaseMm = pressMm, fastOut 0).
      const fast = entry.fast === true;
      this.travel.set(key, {
        hardCode: key,
        pressMm: entry.pressMm,
        releaseMm: fast ? entry.releaseMm : entry.pressMm,
        deadDownMm: entry.deadDownMm ?? 0.2,
        deadUpMm: entry.deadUpMm ?? 0.2,
        fastOutMm: fast ? entry.fastOutMm ?? entry.pressMm : 0,
        fast,
      });
    }
  }
  async setWinLock(value?: boolean): Promise<void> {
    this.calls.push('setWinLock');
    this.winLock = value ?? false;
  }
  async setLightSleep(minutes: number): Promise<void> {
    this.calls.push('setLightSleep');
    this.lightSleep = minutes;
  }
  async setRS(): Promise<void> {
    this.calls.push('setRS');
  }
  async setSOCD(options: {
    readonly key1: KeyRef;
    readonly key2: KeyRef;
    readonly first1?: 0 | 1;
    readonly first2?: 0 | 1;
    readonly bottom?: boolean;
    readonly ms?: number;
  }): Promise<void> {
    this.calls.push('setSOCD');
    void options;
  }
  async setMT(options: {
    readonly key: KeyRef;
    readonly hold: KeyRef;
    readonly tap: KeyRef;
    readonly ms?: number;
  }): Promise<void> {
    this.calls.push('setMT');
    this.features.set(Number(options.key), {
      hardCode: Number(options.key),
      kind: 'mt',
      targetHidCodes: [Number(options.hold), Number(options.tap)],
      tapMs: options.ms,
    });
  }
  async setTGL(): Promise<void> {
    this.calls.push('setTGL');
  }
  async setMPT(): Promise<void> {
    this.calls.push('setMPT');
  }
  async setEND(): Promise<void> {
    this.calls.push('setEND');
  }
  async clearFeature(key: KeyRef): Promise<void> {
    this.calls.push('clearFeature');
    this.features.delete(Number(key));
  }
}

function populated(): FakeKeyboard {
  const keyboard = new FakeKeyboard();
  keyboard.light = {
    mode: 2,
    speed: 40,
    turn: 1,
    brightness: 7,
    colorful: 1,
    rgb: '#112233',
  };
  keyboard.colors.set(42, { rgb: '#FF0000', brightness: 8 });
  keyboard.colors.set(43, { rgb: '#00FF00', brightness: 6 });
  keyboard.remaps[0]!.set(42, 4);
  keyboard.remaps[0]!.set(43, 22);
  keyboard.remaps[1]!.set(42, 0);
  keyboard.remaps[2]!.set(43, 0);
  keyboard.travel.set(42, {
    hardCode: 42,
    pressMm: 0.8,
    releaseMm: 0.4,
    deadDownMm: 0.2,
    deadUpMm: 0.2,
    fastOutMm: 0.8,
    fast: true,
  });
  keyboard.features.set(44, {
    hardCode: 44,
    kind: 'mt',
    targetHidCodes: [4, 5],
    tapMs: 200,
  });
  keyboard.winLock = true;
  keyboard.lightSleep = 30;
  return keyboard;
}

test('capture produces a complete JSON document', async () => {
  const keyboard = populated();
  const config = await captureKeyboardConfig(keyboard);
  assert.equal(config.format, 'zmeow.keyboard-config');
  assert.equal(config.version, 1);
  assert.equal(config.layout, 'compact65');
  assert.equal(config.light.rgb, '#112233');
  assert.deepEqual(config.keyColors[42], { rgb: '#FF0000', brightness: 8 });
  assert.equal(config.remap.layers[0]![42], 4);
  assert.equal(config.remap.layers[1]![42], 0);
  assert.equal(config.travel[42]!.fast, true);
  assert.equal(config.features.length, 1);
  assert.equal(config.features[0]!.kind, 'mt');
  assert.equal(config.features[0]!.textCode, 'KeyD');
  assert.deepEqual(config.misc, { winLock: true, lightSleep: 30 });
  assert.match(config.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(config.firmwareVersion, '1.1.1');
  assert.ok(!('boardId' in config), 'backups must not contain the board id');
  assert.ok(!('serialNumber' in config), 'backups must not contain the serial number');
});

test('legacy boardId / serialNumber are stripped when parsing and serialising', async () => {
  const config = await captureKeyboardConfig(populated());
  const legacy = { ...config, boardId: '310110', serialNumber: 'SN-TEST' } as unknown as KeyboardConfig;

  const parsed = parseKeyboardConfig(JSON.stringify(legacy));
  assert.ok(!('boardId' in parsed));
  assert.ok(!('serialNumber' in parsed));
  assert.equal(parsed.firmwareVersion, '1.1.1');

  const json = stringifyKeyboardConfig(legacy);
  assert.doesNotMatch(json, /boardId|serialNumber|SN-TEST/);
  assert.match(json, /"firmwareVersion": "1\.1\.1"/);
});

test('serialize -> parse round-trips the document', async () => {
  const config = await captureKeyboardConfig(populated());
  const json = stringifyKeyboardConfig(config);
  const parsed = parseKeyboardConfig(json);
  assert.deepEqual(parsed, config);
});

test('restore writes every captured setting', async () => {
  const source = populated();
  const config = await captureKeyboardConfig(source);

  const target = new FakeKeyboard();
  target.colors.set(42, { rgb: '#000000', brightness: 1 });
  target.remaps[0]!.set(42, 99);
  target.travel.set(42, {
    hardCode: 42,
    pressMm: 2,
    releaseMm: 2,
    deadDownMm: 0.2,
    deadUpMm: 0.2,
    fastOutMm: 2,
    fast: false,
  });
  target.features.set(44, { hardCode: 44, kind: 'dks' });
  target.features.set(45, { hardCode: 45, kind: 'tgl', targetHidCodes: [4], tapMs: 200 });

  const result = await restoreKeyboardConfig(target, config);
  assert.equal(result.light, true);
  assert.equal(result.colors, 2);
  assert.equal(result.travel, 1);
  assert.equal(result.remap?.written, 2); // layer 0 key 42 + layer 1 key 42
  assert.equal(result.features.cleared, 2); // dks on 44 + tgl on 45
  assert.equal(result.features.written, 1);
  assert.equal(result.misc.winLock, true);
  assert.equal(result.misc.lightSleep, true);

  assert.deepEqual(target.light, source.light);
  assert.deepEqual(target.colors.get(42), source.colors.get(42));
  assert.equal(target.remaps[0]!.get(42), 4);
  assert.equal(target.travel.get(42)!.pressMm, 0.8);
  assert.equal(target.features.get(44)!.kind, 'mt');
  assert.equal(target.features.has(45), false);
  assert.equal(target.winLock, true);
  assert.equal(target.lightSleep, 30);
});

test('restore rejects a layout mismatch unless explicitly allowed', async () => {
  const config = await captureKeyboardConfig(populated());
  const json = stringifyKeyboardConfig({ ...config, layout: 'extended79' });
  await assert.rejects(
    () => restoreKeyboardConfig(new FakeKeyboard(), json),
    (error: unknown) => error instanceof ValidationError,
  );
  const result = await restoreKeyboardConfig(new FakeKeyboard(), json, {
    allowLayoutMismatch: true,
    restoreLight: false,
    restoreKeyColors: false,
    restoreTravel: false,
    restoreFeatures: false,
    restoreMisc: false,
  });
  assert.equal(result.light, false);
});

test('DKS features are skipped or rejected explicitly', async () => {
  const keyboard = populated();
  keyboard.features.set(44, { hardCode: 44, kind: 'dks' });
  const config = await captureKeyboardConfig(keyboard);
  const target = new FakeKeyboard();

  const skipped = await restoreKeyboardConfig(target, config, {
    restoreLight: false,
    restoreKeyColors: false,
    restoreTravel: false,
  });
  assert.equal(skipped.features.written, 0);
  assert.equal(skipped.features.skipped, 1);
  assert.ok(skipped.warnings.some((line) => line.includes('DKS')));

  await assert.rejects(
    () =>
      restoreKeyboardConfig(new FakeKeyboard(), config, {
        restoreLight: false,
        restoreKeyColors: false,
        restoreTravel: false,
        onUnsupportedFeature: 'error',
      }),
    (error: unknown) => error instanceof Error && error.name === 'UnsupportedFeatureError',
  );
});

test('capture skips a layer that cannot be read and records a warning', async () => {
  const keyboard = populated();
  keyboard.failLayers.add(2);
  const config = await captureKeyboardConfig(keyboard);

  // One dead layer must not kill the backup: the readable layers stay complete
  // and restore leaves the missing layer untouched.
  assert.deepEqual(Object.keys(config.remap.layers).sort(), ['0', '1']);
  assert.equal(config.remap.layers[1]![42], 0);
  assert.ok((config.warnings ?? []).some((line) => line.includes('layer 2')));
});

test('capture tolerates a failed feature-list read and marks featuresRead false', async () => {
  const keyboard = populated();
  keyboard.failFeatures = true;
  const config = await captureKeyboardConfig(keyboard);

  // A timed-out cmd 47 read must not kill the backup: the warning is recorded
  // and the document carries featuresRead: false so restore knows the list was
  // never seen (restoring the empty list would clear the device features).
  assert.equal(config.featuresRead, false);
  assert.deepEqual(config.features, []);
  assert.ok(
    (config.warnings ?? []).some((line) => line.includes('Could not read the feature list')),
  );
  const parsed = parseKeyboardConfig(stringifyKeyboardConfig(config));
  assert.equal(parsed.featuresRead, false);
});

test('restore leaves the device features untouched when the backup never read them', async () => {
  const captureSource = populated();
  captureSource.failFeatures = true;
  const config = await captureKeyboardConfig(captureSource);
  assert.equal(config.featuresRead, false);

  const keyboard = populated(); // device has an MT feature on hardCode 44
  const result = await restoreKeyboardConfig(keyboard, config);
  assert.ok(
    result.warnings.some((line) => line.includes('left untouched')),
    'restore must record why the features were skipped',
  );
  assert.equal(result.features.written, 0);
  assert.equal(result.features.cleared, 0);
  assert.ok(!keyboard.calls.includes('clearFeature'), 'no feature may be cleared');
  assert.ok(keyboard.features.has(44), 'the device feature must survive the restore');
});

test('restore degrades gracefully when the device feature list cannot be read', async () => {
  const config = await captureKeyboardConfig(populated());
  assert.ok(config.features.length > 0, 'the backup must contain features');

  const keyboard = populated();
  keyboard.failFeatures = true; // cmd 47 times out on this device right now
  const result = await restoreKeyboardConfig(keyboard, config);

  // The restore itself must not die on the cmd 47 read: everything else is
  // restored, the feature step degrades with a warning and clears nothing.
  assert.ok(
    result.warnings.some((line) => line.includes('left untouched')),
    'restore must record why the features were skipped',
  );
  assert.equal(result.features.written, 0);
  assert.equal(result.features.cleared, 0);
  assert.ok(!keyboard.calls.includes('clearFeature'));
});

test('restore rewrites travel entries the device dropped', async () => {
  const config = await captureKeyboardConfig(populated());
  const keyboard = populated();
  keyboard.travel.clear(); // factory-reset-like target
  keyboard.dropTravelOnce.add(42);

  const result = await restoreKeyboardConfig(keyboard, config);

  // The verify pass catches the dropped cmd 41 chunk, rewrites it, and the
  // second read-back matches — no persistent-mismatch warning.
  assert.ok(result.warnings.some((line) => line.includes('Retrying travel')));
  assert.ok(!result.warnings.some((line) => line.includes('were not adopted')));
  assert.equal(keyboard.travel.get(42)?.pressMm, 0.8);
  assert.equal(keyboard.travel.get(42)?.fast, true);
});

test('restore reports travel entries that never stick', async () => {
  const config = await captureKeyboardConfig(populated());
  const keyboard = populated();
  keyboard.travel.clear();
  keyboard.dropTravelAlways.add(42);

  const result = await restoreKeyboardConfig(keyboard, config);

  assert.ok(result.warnings.some((line) => line.includes('were not adopted')));
  assert.ok(keyboard.travel.get(42) === undefined, 'the dropped key stays at its old value');
});

test('restore verifies remap writes and paces device writes by default', async () => {
  const config = await captureKeyboardConfig(populated());
  const restoreSettings = {
    restoreLight: false,
    restoreKeyColors: false,
    restoreTravel: false,
    restoreFeatures: false,
    restoreMisc: false,
  } as const;

  const target = new FakeKeyboard();
  await restoreKeyboardConfig(target, config, restoreSettings);
  assert.equal(target.lastRestoreRemapOptions?.verify, true);
  assert.equal(target.lastRestoreRemapOptions?.settleMs, 250);
  assert.equal(target.lastRestoreRemapOptions?.writeGapMs, 300);

  const loose = new FakeKeyboard();
  await restoreKeyboardConfig(loose, config, {
    ...restoreSettings,
    verifyRemap: false,
    settleMs: 0,
    writeGapMs: 0,
  });
  assert.equal(loose.lastRestoreRemapOptions?.verify, false);
  assert.equal(loose.lastRestoreRemapOptions?.settleMs, 0);
  assert.equal(loose.lastRestoreRemapOptions?.writeGapMs, 0);
});

test('restore rewrites a feature the device did not adopt', async () => {
  const keyboard = populated();
  keyboard.features.set(45, {
    hardCode: 45,
    kind: 'socd',
    targetHardCodes: [46],
    first1: 1,
    first2: 0,
    bottom: true,
    pauseMs: 100,
  });
  const config = await captureKeyboardConfig(keyboard);

  const target = new FakeKeyboard();
  const baseSetSOCD = target.setSOCD.bind(target);
  let socdWrites = 0;
  target.setSOCD = async (options) => {
    socdWrites += 1;
    await baseSetSOCD(options);
    const hardCode = Number(options.key1);
    // The FakeKeyboard base does not model SOCD registration; adopt it here,
    // except for the first write which the firmware simulation drops entirely.
    if (socdWrites > 1) {
      target.features.set(hardCode, {
        hardCode,
        kind: 'socd',
        targetHardCodes: [Number(options.key2)],
        first1: options.first1 ?? 1,
        first2: options.first2 ?? 0,
        bottom: options.bottom ?? false,
        pauseMs: options.ms ?? 100,
      });
    }
  };

  const result = await restoreKeyboardConfig(target, config, {
    restoreLight: false,
    restoreKeyColors: false,
    restoreTravel: false,
    restoreMisc: false,
    featureGapMs: 1,
    writeGapMs: 1,
    settleMs: 1,
  });

  assert.equal(socdWrites, 2, 'the verify pass rewrote the dropped assignment');
  assert.equal(result.features.written, 2); // mt on 44 + socd on 45
  assert.equal(target.features.get(45)?.kind, 'socd');
  assert.ok(!result.warnings.some((line) => line.includes('did not adopt')));
});

test('restore clears an existing feature even when the kind matches', async () => {
  const config = await captureKeyboardConfig(populated()); // MT on hardCode 44
  const target = new FakeKeyboard();
  target.features.set(44, {
    hardCode: 44,
    kind: 'mt',
    targetHidCodes: [4, 5],
    tapMs: 200,
  });

  const result = await restoreKeyboardConfig(target, config, {
    restoreLight: false,
    restoreKeyColors: false,
    restoreTravel: false,
    restoreMisc: false,
    featureGapMs: 1,
    featureClearGapMs: 1,
    writeGapMs: 1,
    settleMs: 1,
  });

  // The official driver always cancels the selected key's feature before set,
  // even when the family is unchanged; overwriting in place was unreliable.
  assert.equal(result.features.cleared, 1);
  assert.equal(result.features.written, 1);
  const clearIndex = target.calls.indexOf('clearFeature');
  assert.ok(clearIndex >= 0, 'the existing MT feature must be cleared first');
  assert.ok(target.calls.indexOf('setMT') > clearIndex, 'MT must be written after the clear');
  assert.equal(target.features.get(44)?.kind, 'mt');
});

test('restore skips an unsupported DKS feature without clearing the device copy', async () => {
  const source = populated();
  source.features.set(44, { hardCode: 44, kind: 'dks' });
  const config = await captureKeyboardConfig(source);

  const target = new FakeKeyboard();
  target.features.set(44, { hardCode: 44, kind: 'dks' });

  const result = await restoreKeyboardConfig(target, config, {
    restoreLight: false,
    restoreKeyColors: false,
    restoreTravel: false,
    restoreMisc: false,
    featureGapMs: 1,
    featureClearGapMs: 1,
    writeGapMs: 1,
    settleMs: 1,
  });

  // Pre-validation must run before the cmd 47 clear: a DKS entry cannot be
  // rewritten, so clearing it would destroy the device's working feature.
  assert.equal(result.features.skipped, 1);
  assert.ok(!target.calls.includes('clearFeature'), 'unsupported features must not be cleared');
  assert.ok(target.features.has(44), 'the device DKS feature must survive');
});

test('a per-key custom light mode (255) round-trips through restore', async () => {
  const keyboard = populated();
  keyboard.light = { mode: 255, speed: 0, turn: 0, brightness: 0, colorful: 1, rgb: '#000000' };
  const config = await captureKeyboardConfig(keyboard);
  assert.equal(config.light.mode, 255);

  const target = new FakeKeyboard();
  await restoreKeyboardConfig(target, config, {
    restoreKeyColors: false,
    restoreTravel: false,
    restoreFeatures: false,
    restoreMisc: false,
    writeGapMs: 1,
    settleMs: 1,
  });
  assert.equal(target.light.mode, 255);
  assert.equal(target.light.rgb, '#000000');
  assert.ok(target.calls.includes('setLight'));
});

test('validation rejects malformed documents', () => {  const config = {
    format: 'zmeow.keyboard-config',
    version: 1,
    createdAt: new Date().toISOString(),
    product: { id: 10011, title: 'Zetsu63', vid: 14470, pid: 16385 },
    layout: 'compact65',
    remap: { layers: { 0: { 1: -1 } } },
    light: { mode: 1, speed: 80, turn: 0, brightness: 8, colorful: 0, rgb: '#FFFFFF' },
    keyColors: {},
    travel: {},
    features: [],
    misc: { winLock: null, lightSleep: null },
  };
  assert.throws(
    () => validateKeyboardConfig(config),
    (error: unknown) => error instanceof ValidationError,
  );
  assert.throws(() => parseKeyboardConfig('{'), (error: unknown) => error instanceof ValidationError);
});

// Keep the type import used so the test fails at compile time if the public
// document shape drifts.
const _typecheck: KeyboardConfig | null = null;
void _typecheck;
