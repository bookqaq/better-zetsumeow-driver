#!/usr/bin/env node
/**
 * Extracts the static Zetsu63 data tables that ship inside the ZetsuMeow
 * driver bundle and regenerates the TypeScript modules under `src/generated/`.
 *
 * Strategy: locate a well-known anchor in the bundle source, take a
 * bracket-balanced slice of the literal that follows it (string / escape
 * aware) and evaluate only that slice inside a throw-away `node:vm` context.
 * The bundle as a whole is never evaluated.
 *
 * Usage:
 *   node scripts/extract-from-bundle.mjs           # write generated files
 *   node scripts/extract-from-bundle.mjs --check   # verify files are current
 *
 * `--check` regenerates everything in memory, compares it against what is on
 * disk and exits with code 1 (printing a small diff summary) on any mismatch.
 *
 * The output is deterministic: the same bundle bytes always produce the same
 * files. The only timestamp is `manifest.json#generatedAt`, and it is derived
 * from the source bundle's mtime so it is stable across regenerations.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const OUTPUT_DIR = resolve(PACKAGE_DIR, 'src', 'generated');

/** Bundle that carries every table extracted here (repo-relative). */
const HID_BUNDLE_REL = 'assets/zetsumeow-driver/assets/hid-Bjy9aA6C.js';

const EXPECTED = Object.freeze({
  productId: 10011,
  productTitle: 'Zetsu63',
  compact65: 65,
  extended79: 79,
  catalogKeys: 186,
  catalogCategories: 6,
  lightModes: 10,
  brightnessMax: 10,
});

// Screen geometry is not part of the product table: it is hard-coded in the
// screen editor bundle. See inputs/screen-notes in `renderProductHeader()`.
const SCREEN = Object.freeze({ width: 194, height: 368, maxFrames: 30 });

// ---------------------------------------------------------------------------
// Bundle slicing
// ---------------------------------------------------------------------------

const QUOTE_CHARS = new Set(['`', '"', "'"]);

/**
 * Returns the balanced `[...]` / `{...}` literal starting at `startIndex`.
 * Handles template literals and single/double quoted strings including
 * backslash escapes. Line/block comments are not expected inside the data
 * literals we slice, so they are not special-cased.
 *
 * @param {string} source
 * @param {number} startIndex index of the opening `[` or `{`
 * @returns {string}
 */
function sliceBalanced(source, startIndex) {
  const opener = source[startIndex];
  const closer = opener === '[' ? ']' : opener === '{' ? '}' : null;
  if (closer === null) {
    throw new Error(
      `sliceBalanced: expected "[" or "{" at index ${startIndex}, got ${JSON.stringify(opener)}`,
    );
  }

  let depth = 0;
  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];

    if (QUOTE_CHARS.has(ch)) {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < source.length) {
        const inner = source[i];
        if (inner === '\\') {
          i += 2;
          continue;
        }
        if (inner === quote) {
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        throw new Error(
          `sliceBalanced: unterminated ${quote} string while scanning the literal at index ${startIndex}`,
        );
      }
      continue;
    }

    if (ch === opener) {
      depth += 1;
    } else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }

  throw new Error(`sliceBalanced: unbalanced literal starting at index ${startIndex}`);
}

/**
 * Finds `marker` (which must end immediately before the literal's opening
 * bracket) and evaluates the literal that follows it.
 *
 * @param {string} source
 * @param {string} marker e.g. `"data_keys_config = "`
 * @param {string} label used in error messages
 */
function readLiteral(source, marker, label) {
  const at = source.indexOf(marker);
  if (at === -1) {
    throw new Error(`could not find anchor ${JSON.stringify(marker)} for ${label}`);
  }
  const startIndex = at + marker.length;
  const slice = sliceBalanced(source, startIndex);
  try {
    return runInNewContext(`(${slice})`, Object.create(null), { timeout: 5000 });
  } catch (error) {
    throw new Error(`failed to evaluate ${label}: ${error instanceof Error ? error.message : error}`);
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** `"0x1E"` / `30` / `null` -> finite number (fallback for null-ish input). */
function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`expected a finite number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function toFlag01(value) {
  return toNumber(value) === 1 ? 1 : 0;
}

/** Deterministic numeric literal (JSON keeps numbers round-trip exact here). */
function formatNumber(value) {
  if (!Number.isFinite(value)) {
    throw new Error(`refusing to emit non-finite number: ${value}`);
  }
  return JSON.stringify(value);
}

function formatString(value) {
  return JSON.stringify(String(value));
}

function formatKeyRange(jsonText) {
  const parsed = JSON.parse(jsonText);
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// Mapping: bundle tables -> TypeScript data
// ---------------------------------------------------------------------------

/**
 * Maps one bundle key row to the `KeyDef` contract in `src/types.ts`.
 * Numeric hex strings such as `"0x1E"` are converted with `Number(...)`.
 */
function mapKey(raw) {
  const bundleTextCode = raw.text_code;
  const title = String(raw.title ?? '');
  // The Fn key (hard_code 0xAA) ships `text_code: null`; fall back to its
  // title so consumers always get a usable identifier.
  const textCode =
    bundleTextCode === null || bundleTextCode === undefined || bundleTextCode === ''
      ? title
      : String(bundleTextCode);

  return {
    hardCode: toNumber(raw.hard_code),
    hidCode: toNumber(raw.hid_code),
    hidCodeFn1: raw.hid_code_fn1 === null || raw.hid_code_fn1 === undefined
      ? null
      : toNumber(raw.hid_code_fn1),
    selfCode: toNumber(raw.self_code),
    scanId: toNumber(raw.scan_id),
    keyCode: toNumber(raw.key_code),
    textCode,
    title,
    status: toNumber(raw.status),
    travel: toNumber(raw.travel),
    travelUp: toNumber(raw.travel_up),
    travelDown: toNumber(raw.travel_down),
    maxTravel: toNumber(raw.max_travel),
    minTravel: toNumber(raw.min_travel),
    isFast: toFlag01(raw.is_fast),
    isFRow: toNumber(raw.is_f) === 1,
    geometry: {
      x: toNumber(raw.x),
      y: toNumber(raw.y),
      w: toNumber(raw.w),
      h: toNumber(raw.h),
      img: String(raw.img ?? ''),
    },
  };
}

function mapProduct(raw) {
  const usagePages = String(raw.usagePage)
    .split(',')
    .map((part) => toNumber(part.trim()));
  for (const page of usagePages) {
    if (!Number.isInteger(page)) {
      throw new Error(`usage page is not an integer: ${page}`);
    }
  }

  return {
    id: toNumber(raw.id),
    title: String(raw.title ?? ''),
    vid: toNumber(raw.vid),
    pid: toNumber(raw.pid),
    pidScreen: toNumber(raw.pid_screen),
    headNum: toNumber(raw.head_num),
    headNumScreen: toNumber(raw.head_num_screen),
    usage: toNumber(raw.usage),
    usagePages,
    cateId: toNumber(raw.cate_id),
    fId: toNumber(raw.f_id),
    isScreen: toNumber(raw.is_screen) !== 0,
    isSideLight: toNumber(raw.is_side_light) !== 0,
    fmId: toNumber(raw.fm_id),
    keyRangeJson: formatKeyRange(raw.key_range_init),
    screen: { ...SCREEN },
  };
}

function mapCatalogEntry(raw, category) {
  return {
    cateId: toNumber(category.id),
    cateTitle: String(category.title ?? ''),
    cateTitleEn: String(category.title_en ?? ''),
    title: String(raw.title ?? ''),
    textCode: String(raw.text_code ?? ''),
    // `hid_code_j` is the value the target firmware actually uses.
    usage: toNumber(raw.hid_code_j),
    hidCode: toNumber(raw.hid_code),
    hardCode: toNumber(raw.hard_code),
    keyCode: toNumber(raw.key_code),
    selfCode: toNumber(raw.self_code),
  };
}

// ---------------------------------------------------------------------------
// Load + validate bundle tables
// ---------------------------------------------------------------------------

function loadBundleTables() {
  const bundlePath = resolve(REPO_ROOT, HID_BUNDLE_REL);
  if (!existsSync(bundlePath)) {
    throw new Error(`bundle not found: ${bundlePath}`);
  }
  const bundleBytes = readFileSync(bundlePath);
  const source = bundleBytes.toString('utf8');
  const sha256 = createHash('sha256').update(bundleBytes).digest('hex');

  const products = readLiteral(source, 'data_keys_product_list = ', 'data_keys_product_list');
  if (!Array.isArray(products) || products.length !== 1) {
    throw new Error(`expected exactly one product, got ${Array.isArray(products) ? products.length : typeof products}`);
  }
  const product = products[0];
  if (toNumber(product.id) !== EXPECTED.productId || product.title !== EXPECTED.productTitle) {
    throw new Error(
      `unexpected product: ${JSON.stringify({ id: product.id, title: product.title })}`,
    );
  }
  if (product.keys0.length !== EXPECTED.compact65 || product.keys1.length !== EXPECTED.extended79) {
    throw new Error(
      `unexpected layout sizes: compact65=${product.keys0.length}, extended79=${product.keys1.length}`,
    );
  }

  const categories = readLiteral(source, 'data_keys_config = ', 'data_keys_config');
  if (!Array.isArray(categories) || categories.length !== EXPECTED.catalogCategories) {
    throw new Error(`expected ${EXPECTED.catalogCategories} key categories, got ${categories?.length}`);
  }
  const catalogSize = categories.reduce((sum, category) => sum + category.keys.length, 0);
  if (catalogSize !== EXPECTED.catalogKeys) {
    throw new Error(`expected ${EXPECTED.catalogKeys} catalog keys, got ${catalogSize}`);
  }

  const lightModeList = readLiteral(source, 'j_light_mode_list: ', 'j_light_mode_list');
  if (!Array.isArray(lightModeList) || lightModeList.length !== EXPECTED.lightModes) {
    throw new Error(`expected ${EXPECTED.lightModes} light modes, got ${lightModeList?.length}`);
  }
  const lightModeMy = readLiteral(source, 'j_light_mode_my: ', 'j_light_mode_my');
  if (toNumber(lightModeMy.gray_max) !== EXPECTED.brightnessMax) {
    throw new Error(
      `expected j_light_mode_my.gray_max=${EXPECTED.brightnessMax}, got ${lightModeMy.gray_max}`,
    );
  }

  const modeIds = [...new Set(lightModeList.map((mode) => toNumber(mode.hid_code)))].sort(
    (a, b) => a - b,
  );
  const expectedModeIds = Array.from({ length: EXPECTED.lightModes }, (_, index) => index);
  if (modeIds.join(',') !== expectedModeIds.join(',')) {
    throw new Error(`light mode ids are not 0..9: ${modeIds.join(',')}`);
  }

  const compactKeys = product.keys0.map((raw) => mapKey(raw));
  const extendedKeys = product.keys1.map((raw) => mapKey(raw));
  const mapped = mapProduct(product);

  const catalog = categories.flatMap((category) =>
    category.keys.map((raw) => mapCatalogEntry(raw, category)),
  );
  const catalogCategories = categories.map((category) => ({
    id: toNumber(category.id),
    title: String(category.title ?? ''),
    titleEn: String(category.title_en ?? ''),
    keyCount: category.keys.length,
  }));

  const lightModes = [...lightModeList]
    .sort((a, b) => toNumber(a.hid_code) - toNumber(b.hid_code))
    .map((mode) => ({
      mode: toNumber(mode.hid_code),
      title: String(mode.title ?? ''),
      titleEn: String(mode.title_en ?? ''),
    }));

  return {
    bundlePath,
    sha256,
    compactKeys,
    extendedKeys,
    product: mapped,
    catalog,
    catalogCategories,
    lightModes,
    brightnessMax: toNumber(lightModeMy.gray_max),
    generatedAt: statSync(bundlePath).mtime.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHeader(notes = []) {
  const lines = [
    '/**',
    ' * GENERATED FILE - do not edit by hand.',
    ' * Regenerate with: node scripts/extract-from-bundle.mjs',
  ];
  for (const note of notes) {
    lines.push(note === '' ? ' *' : ` * ${note}`);
  }
  lines.push(' */', '');
  return lines.join('\n');
}

function renderKey(key) {
  const parts = [
    `hardCode: ${formatNumber(key.hardCode)}`,
    `hidCode: ${formatNumber(key.hidCode)}`,
    `hidCodeFn1: ${key.hidCodeFn1 === null ? 'null' : formatNumber(key.hidCodeFn1)}`,
    `selfCode: ${formatNumber(key.selfCode)}`,
    `scanId: ${formatNumber(key.scanId)}`,
    `keyCode: ${formatNumber(key.keyCode)}`,
    `textCode: ${formatString(key.textCode)}`,
    `title: ${formatString(key.title)}`,
    `status: ${formatNumber(key.status)}`,
    `travel: ${formatNumber(key.travel)}`,
    `travelUp: ${formatNumber(key.travelUp)}`,
    `travelDown: ${formatNumber(key.travelDown)}`,
    `maxTravel: ${formatNumber(key.maxTravel)}`,
    `minTravel: ${formatNumber(key.minTravel)}`,
    `isFast: ${formatNumber(key.isFast)}`,
    `isFRow: ${key.isFRow}`,
    `geometry: { x: ${formatNumber(key.geometry.x)}, y: ${formatNumber(key.geometry.y)}, w: ${formatNumber(key.geometry.w)}, h: ${formatNumber(key.geometry.h)}, img: ${formatString(key.geometry.img)} }`,
  ];
  return `      { ${parts.join(', ')} },`;
}

function renderProductFile() {
  const product = data.product;
  const header = renderHeader([
    '',
    'Screen panel geometry: crop/GIF canvas 194 x 368, GIF frame cap 30.',
  ]);

  const lines = [
    header,
    "import type { KeyRangeInit, LayoutDefinition, ProductInfo } from '../types.ts';",
    '',
    'export const KEY_LAYOUTS: {',
    '  compact65: LayoutDefinition;',
    '  extended79: LayoutDefinition;',
    '} = {',
    '  compact65: {',
    "    mode: 'compact65',",
    '    keys: [',
    ...data.compactKeys.map(renderKey),
    '    ],',
    '  },',
    '  extended79: {',
    "    mode: 'extended79',",
    '    keys: [',
    ...data.extendedKeys.map(renderKey),
    '    ],',
    '  },',
    '};',
    '',
    'export const ZETSU63_PRODUCT: ProductInfo = {',
    `  id: ${formatNumber(product.id)},`,
    `  title: ${formatString(product.title)},`,
    `  vid: ${formatNumber(product.vid)},`,
    `  pid: ${formatNumber(product.pid)},`,
    `  pidScreen: ${formatNumber(product.pidScreen)},`,
    `  headNum: ${formatNumber(product.headNum)},`,
    `  headNumScreen: ${formatNumber(product.headNumScreen)},`,
    `  usage: ${formatNumber(product.usage)},`,
    `  usagePages: [${product.usagePages.map(formatNumber).join(', ')}],`,
    `  cateId: ${formatNumber(product.cateId)},`,
    `  fId: ${formatNumber(product.fId)},`,
    `  isScreen: ${product.isScreen},`,
    `  isSideLight: ${product.isSideLight},`,
    `  fmId: ${formatNumber(product.fmId)},`,
    '  keyRange: JSON.parse(',
    `    ${formatString(product.keyRangeJson)},`,
    '  ) as KeyRangeInit,',
    `  screen: { width: ${SCREEN.width}, height: ${SCREEN.height}, maxFrames: ${SCREEN.maxFrames} },`,
    '  layouts: KEY_LAYOUTS,',
    '};',
    '',
  ];
  return lines.join('\n');
}

function renderKeyCatalogFile() {
  const header = renderHeader();
  const lines = [
    header,
    'export interface KeyCatalogEntry {',
    '  readonly cateId: number;',
    '  readonly cateTitle: string;',
    '  readonly cateTitleEn: string;',
    '  readonly title: string;',
    '  readonly textCode: string;',
    '  readonly usage: number;',
    '  readonly hidCode: number;',
    '  readonly hardCode: number;',
    '  readonly keyCode: number;',
    '  readonly selfCode: number;',
    '}',
    '',
    'export const KEY_CATALOG: readonly KeyCatalogEntry[] = [',
  ];

  for (const entry of data.catalog) {
    lines.push(
      `  { cateId: ${formatNumber(entry.cateId)}, cateTitle: ${formatString(entry.cateTitle)}, cateTitleEn: ${formatString(entry.cateTitleEn)}, title: ${formatString(entry.title)}, textCode: ${formatString(entry.textCode)}, usage: ${formatNumber(entry.usage)}, hidCode: ${formatNumber(entry.hidCode)}, hardCode: ${formatNumber(entry.hardCode)}, keyCode: ${formatNumber(entry.keyCode)}, selfCode: ${formatNumber(entry.selfCode)} },`,
    );
  }

  lines.push(
    '];',
    '',
    'export const KEY_CATALOG_CATEGORIES: readonly {',
    '  id: number;',
    '  title: string;',
    '  titleEn: string;',
    '  keyCount: number;',
    '}[] = [',
  );
  for (const category of data.catalogCategories) {
    lines.push(
      `  { id: ${formatNumber(category.id)}, title: ${formatString(category.title)}, titleEn: ${formatString(category.titleEn)}, keyCount: ${formatNumber(category.keyCount)} },`,
    );
  }
  lines.push('];', '');
  return lines.join('\n');
}

function renderLightModesFile() {
  const header = renderHeader();
  const lines = [
    header,
    'export interface LightModeDefinition {',
    '  readonly mode: number;',
    '  readonly title: string;',
    '  readonly titleEn: string;',
    '}',
    '',
    'export const LIGHT_MODES: readonly LightModeDefinition[] = [',
  ];
  for (const mode of data.lightModes) {
    lines.push(
      `  { mode: ${formatNumber(mode.mode)}, title: ${formatString(mode.title)}, titleEn: ${formatString(mode.titleEn)} },`,
    );
  }
  lines.push(
    '];',
    '',
    '/** Highest brightness value accepted by the firmware. */',
    `export const LIGHT_BRIGHTNESS_MAX = ${formatNumber(data.brightnessMax)};`,
    '',
  );
  return lines.join('\n');
}

function renderIndexFile() {
  return [
    renderHeader(),
    "export * from './product-zetsu63.ts';",
    "export * from './key-catalog.ts';",
    "export * from './light-modes.ts';",
    '',
  ].join('\n');
}

function renderManifestFile() {
  const manifest = {
    sourceSha256: data.sha256,
    counts: {
      compact65: data.compactKeys.length,
      extended79: data.extendedKeys.length,
      catalogKeys: data.catalog.length,
      catalogCategories: data.catalogCategories.length,
      lightModes: data.lightModes.length,
    },
    generatedAt: data.generatedAt,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let data;

function renderAll() {
  return new Map([
    ['product-zetsu63.ts', renderProductFile()],
    ['key-catalog.ts', renderKeyCatalogFile()],
    ['light-modes.ts', renderLightModesFile()],
    ['index.ts', renderIndexFile()],
    ['manifest.json', renderManifestFile()],
  ]);
}

function outputPath(name) {
  return join(OUTPUT_DIR, name);
}

function displayPath(name) {
  return relative(REPO_ROOT, outputPath(name));
}

function printDiff(name, actual, expected) {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const lineCount = Math.max(actualLines.length, expectedLines.length);
  const differing = [];
  for (let index = 0; index < lineCount; index += 1) {
    if (actualLines[index] !== expectedLines[index]) differing.push(index);
  }

  console.error(
    `  ${displayPath(name)} is out of date (${differing.length} differing line(s))`,
  );
  for (const index of differing.slice(0, 5)) {
    console.error(`    line ${index + 1}:`);
    console.error(`      disk:      ${JSON.stringify(actualLines[index] ?? '<missing>')}`);
    console.error(`      generated: ${JSON.stringify(expectedLines[index] ?? '<missing>')}`);
  }
  if (differing.length > 5) {
    console.error(`    ... ${differing.length - 5} more differing line(s)`);
  }
}

function main(argv) {
  const checkOnly = argv.includes('--check');
  data = loadBundleTables();
  const outputs = renderAll();

  if (checkOnly) {
    let dirty = false;
    console.log(
      `[extract] --check: comparing ${outputs.size} file(s) against ${relative(REPO_ROOT, OUTPUT_DIR)}`,
    );
    for (const [name, expected] of outputs) {
      const target = outputPath(name);
      if (!existsSync(target)) {
        console.error(`  missing: ${displayPath(name)}`);
        dirty = true;
        continue;
      }
      const actual = readFileSync(target, 'utf8');
      if (actual !== expected) {
        printDiff(name, actual, expected);
        dirty = true;
      }
    }
    if (dirty) {
      console.error('[extract] generated files are stale - run node scripts/extract-from-bundle.mjs');
      process.exitCode = 1;
      return;
    }
    console.log('[extract] OK - generated files are up to date');
    return;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const [name, content] of outputs) {
    writeFileSync(outputPath(name), content, 'utf8');
    console.log(`[extract] wrote ${displayPath(name)}`);
  }
  console.log(
    `[extract] compact65=${data.compactKeys.length} extended79=${data.extendedKeys.length} ` +
      `catalogKeys=${data.catalog.length} catalogCategories=${data.catalogCategories.length} ` +
      `lightModes=${data.lightModes.length} brightnessMax=${data.brightnessMax}`,
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`[extract] failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
