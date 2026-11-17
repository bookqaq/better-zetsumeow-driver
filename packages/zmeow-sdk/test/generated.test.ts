import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  KEY_CATALOG,
  KEY_CATALOG_CATEGORIES,
  KEY_LAYOUTS,
  LIGHT_BRIGHTNESS_MAX,
  LIGHT_MODES,
  ZETSU63_PRODUCT,
} from '../src/generated/index.ts';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const GENERATED_DIR = fileURLToPath(new URL('../src/generated/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUNDLE_REL = 'assets/zetsumeow-driver/assets/hid-Bjy9aA6C.js';
const EXTRACTOR = fileURLToPath(new URL('../scripts/extract-from-bundle.mjs', import.meta.url));

const F_ROW_EXTRA_CODES = [...Array.from({ length: 13 }, (_, index) => index), 0x4f];

test('ZETSU63_PRODUCT matches the known product row', () => {
  assert.equal(ZETSU63_PRODUCT.id, 10011);
  assert.equal(ZETSU63_PRODUCT.title, 'Zetsu63');

  assert.equal(ZETSU63_PRODUCT.vid, 0x3886);
  assert.equal(ZETSU63_PRODUCT.vid, 14470);
  assert.equal(ZETSU63_PRODUCT.pid, 0x4001);
  assert.equal(ZETSU63_PRODUCT.pid, 16385);
  assert.equal(ZETSU63_PRODUCT.pidScreen, 0x4001);

  // `head_num` is stored as the hex string "0xab" in the source table.
  assert.equal(ZETSU63_PRODUCT.headNum, 0xab);
  assert.equal(ZETSU63_PRODUCT.headNum, 171);
  assert.equal(ZETSU63_PRODUCT.headNumScreen, 171);

  assert.equal(ZETSU63_PRODUCT.usage, 1);
  assert.deepEqual([...ZETSU63_PRODUCT.usagePages], [65280, 255]);
  assert.ok(ZETSU63_PRODUCT.usagePages.includes(65280));
  assert.ok(ZETSU63_PRODUCT.usagePages.includes(255));

  assert.equal(ZETSU63_PRODUCT.isScreen, true);
  assert.equal(ZETSU63_PRODUCT.isSideLight, false);
  assert.equal(ZETSU63_PRODUCT.cateId, 1);
  assert.equal(ZETSU63_PRODUCT.fId, 0);
  assert.equal(ZETSU63_PRODUCT.fmId, 9);

  assert.equal(ZETSU63_PRODUCT.keyRange.min, 0.1);
  assert.equal(ZETSU63_PRODUCT.keyRange.max, 3.1);
  assert.equal(ZETSU63_PRODUCT.keyRange.fixed, 2);

  // Screen geometry is fixed: crop/GIF canvas 194x368, GIF frame cap 30.
  assert.deepEqual(
    { ...ZETSU63_PRODUCT.screen },
    { width: 194, height: 368, maxFrames: 30 },
  );

  assert.equal(ZETSU63_PRODUCT.layouts.compact65, KEY_LAYOUTS.compact65);
  assert.equal(ZETSU63_PRODUCT.layouts.extended79, KEY_LAYOUTS.extended79);
});

test('KEY_LAYOUTS has 65/79 keys and isFRow is only set on the F-row module keys', () => {
  const compact65 = KEY_LAYOUTS.compact65.keys;
  const extended79 = KEY_LAYOUTS.extended79.keys;

  assert.equal(compact65.length, 65);
  assert.equal(extended79.length, 79);

  const compactCodes = new Set(compact65.map((key) => key.hardCode));
  const extendedCodes = new Set(extended79.map((key) => key.hardCode));
  assert.equal(compactCodes.size, compact65.length, 'compact65 hardCode values must be unique');
  assert.equal(extendedCodes.size, extended79.length, 'extended79 hardCode values must be unique');

  for (const hardCode of compactCodes) {
    assert.ok(extendedCodes.has(hardCode), `extended79 is missing compact65 hardCode ${hardCode}`);
  }

  const extras = [...extendedCodes]
    .filter((hardCode) => !compactCodes.has(hardCode))
    .sort((a, b) => a - b);
  assert.deepEqual(extras, F_ROW_EXTRA_CODES);

  for (const key of compact65) {
    assert.equal(key.isFRow, false, `compact65 key ${key.hardCode} must not be marked isFRow`);
  }
  for (const key of extended79) {
    if (extras.includes(key.hardCode)) {
      assert.equal(key.isFRow, true, `extended79 F-row key ${key.hardCode} must be isFRow`);
    }
  }
  assert.equal(
    extended79.filter((key) => key.isFRow).length,
    F_ROW_EXTRA_CODES.length,
    'only the 14 F-row keys may be marked isFRow',
  );
});

test('every generated KeyDef satisfies the runtime contract', () => {
  const layouts = [KEY_LAYOUTS.compact65, KEY_LAYOUTS.extended79];
  for (const layout of layouts) {
    for (const key of layout.keys) {
      const label = `${layout.mode}/${key.hardCode}`;

      assert.ok(
        Number.isInteger(key.hardCode) && key.hardCode >= 0 && key.hardCode <= 255,
        `${label}: hardCode must be an integer in 0..255`,
      );
      assert.ok(Number.isInteger(key.hidCode) && key.hidCode > 0, `${label}: hidCode must be > 0`);
      assert.ok(
        key.hidCodeFn1 === null || (Number.isInteger(key.hidCodeFn1) && key.hidCodeFn1 > 0),
        `${label}: hidCodeFn1 must be null or a positive integer`,
      );
      assert.equal(typeof key.textCode, 'string', `${label}: textCode must be a string`);
      assert.ok(key.textCode.length > 0, `${label}: textCode must not be empty`);
      assert.equal(typeof key.title, 'string', `${label}: title must be a string`);
      assert.ok(key.isFast === 0 || key.isFast === 1, `${label}: isFast must be 0 or 1`);

      for (const coordinate of ['x', 'y', 'w', 'h'] as const) {
        assert.ok(
          Number.isFinite(key.geometry[coordinate]),
          `${label}: geometry.${coordinate} must be finite`,
        );
      }
      assert.equal(typeof key.geometry.img, 'string', `${label}: geometry.img must be a string`);
    }
  }
});

test('KEY_CATALOG exposes 186 keys across 6 categories', () => {
  assert.equal(KEY_CATALOG.length, 186);
  assert.equal(KEY_CATALOG_CATEGORIES.length, 6);

  for (const category of KEY_CATALOG_CATEGORIES) {
    const actualCount = KEY_CATALOG.filter((entry) => entry.cateId === category.id).length;
    assert.equal(
      actualCount,
      category.keyCount,
      `category ${category.id} (${category.title}) keyCount mismatch`,
    );
    assert.ok(category.title.length > 0, `category ${category.id} title must not be empty`);
    assert.ok(category.titleEn.length > 0, `category ${category.id} titleEn must not be empty`);
  }
  assert.equal(
    KEY_CATALOG_CATEGORIES.reduce((sum, category) => sum + category.keyCount, 0),
    KEY_CATALOG.length,
  );

  // The source table contains exactly one placeholder row (id 208, cat 6) whose
  // `hid_code_j` is "0x0000". It is kept in the catalog, so it is the single
  // entry whose `usage` is legitimately 0; every other entry must be > 0.
  const placeholder = KEY_CATALOG.filter((entry) => entry.usage === 0);
  assert.equal(placeholder.length, 1, 'expected exactly one zero-usage placeholder');
  assert.equal(placeholder[0]?.cateId, 6);
  assert.equal(placeholder[0]?.title, '');

  for (const entry of KEY_CATALOG) {
    assert.ok(Number.isFinite(entry.usage), 'usage must be a finite number');
    if (entry !== placeholder[0]) {
      assert.ok(entry.usage > 0, `usage must be > 0 for ${entry.cateTitle}/${entry.title}`);
    }
    assert.ok(Number.isInteger(entry.hardCode), 'hardCode must be an integer');
    assert.ok(Number.isFinite(entry.hidCode), 'hidCode must be a finite number');
    assert.ok(Number.isFinite(entry.keyCode), 'keyCode must be a finite number');
    assert.ok(Number.isFinite(entry.selfCode), 'selfCode must be a finite number');
    assert.equal(typeof entry.textCode, 'string');
  }
});

test('LIGHT_MODES covers modes 0..9 and brightness max is 10', () => {
  assert.equal(LIGHT_MODES.length, 10);
  assert.deepEqual(
    LIGHT_MODES.map((mode) => mode.mode),
    Array.from({ length: 10 }, (_, index) => index),
  );
  for (const mode of LIGHT_MODES) {
    assert.ok(mode.title.length > 0, `light mode ${mode.mode} title must not be empty`);
    assert.ok(mode.titleEn.length > 0, `light mode ${mode.mode} titleEn must not be empty`);
  }
  assert.equal(LIGHT_BRIGHTNESS_MAX, 10);
});

test('manifest.json records the source hash and the extracted counts', () => {
  const manifestText = readFileSync(`${GENERATED_DIR}manifest.json`, 'utf8');
  const manifest = JSON.parse(manifestText) as {
    sourceSha256: string;
    counts: Record<string, number>;
    generatedAt: string;
  };

  assert.match(manifest.sourceSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.counts, {
    compact65: 65,
    extended79: 79,
    catalogKeys: 186,
    catalogCategories: 6,
    lightModes: 10,
  });
  assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)), 'generatedAt must be a timestamp');

  const bundleBytes = readFileSync(`${REPO_ROOT}${BUNDLE_REL}`);
  const actualSha256 = createHash('sha256').update(bundleBytes).digest('hex');
  assert.equal(manifest.sourceSha256, actualSha256, 'manifest hash must match the source data');
});

test('generated files are reproducible via --check', () => {
  const result = spawnSync(process.execPath, [EXTRACTOR, '--check'], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `extract-from-bundle.mjs --check failed (status ${String(result.status)})\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /OK - generated files are up to date/);
});
