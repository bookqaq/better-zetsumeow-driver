/**
 * JSON backup / restore of the keyboard's current settings.
 *
 * The backup is a plain document (see {@link KeyboardConfig}) that contains the
 * remap table of every Fn layer, the light state, per-key colours, travel
 * configuration, advanced-key features and the misc settings that the firmware
 * exposes. Restoring is diff-based: only values that differ are written.
 */

import {
  UnknownLayoutError,
  UnsupportedFeatureError,
  ValidationError,
} from '../errors.ts';
import type {
  FeatureConfig,
  FeatureKind,
  KeyColor,
  KeyRef,
  LightState,
  TravelEntry,
} from '../types.ts';
import type {
  KeyColorInput,
  RemapRestoreResult,
  RemapSnapshot,
  TravelConfigEntry,
} from '../keyboard.ts';
import {
  KEYBOARD_CONFIG_FORMAT,
  KEYBOARD_CONFIG_VERSION,
} from './types.ts';
import type {
  CaptureConfigOptions,
  ConfigKeyboard,
  FeatureRestoreSummary,
  KeyboardConfig,
  KeyboardConfigFeature,
  RestoreConfigOptions,
  RestoreConfigResult,
} from './types.ts';

const DEFAULT_LAYERS: readonly (0 | 1 | 2)[] = [0, 1, 2];
/**
 * Feature-read pacing: after the feature list, read one family at a time with
 * 10 ms between families and 55 ms between keys. Leave a short quiet window
 * after the travel read; 250 ms is a conservative choice for the backup path.
 */
const FEATURE_LIST_READ_SETTLE_MS = 250;
const FEATURE_ONE_READ_GAP_MS = 55;
const FEATURE_KINDS: ReadonlySet<string> = new Set([
  'none',
  'socd',
  'rs',
  'mt',
  'tgl',
  'mpt',
  'end',
  'dks',
]);
const LAYOUT_MODES: ReadonlySet<string> = new Set(['compact65', 'extended79', 'unknown']);

/** Capture the keyboard's current settings into a JSON-serialisable document. */
export async function captureKeyboardConfig(
  keyboard: ConfigKeyboard,
  options: CaptureConfigOptions = {},
): Promise<KeyboardConfig> {
  const layout = keyboard.layout;
  if (layout === null || layout.mode === 'unknown') {
    throw new UnknownLayoutError(
      'Cannot back up a keyboard without a known layout. Reconnect, then try again.',
    );
  }

  const layers = normalizeLayers(options.layers ?? DEFAULT_LAYERS);
  const warnings: string[] = [];

  // One layer failing (an unsupported layer the firmware never answers, a
  // transient timeout on a shared handle) must not kill the whole backup: skip
  // it with a warning and restore leaves that layer untouched.
  const remap: Record<number, Record<number, number>> = {};
  for (const layer of layers) {
    try {
      const map = await keyboard.getKeyMap(layer);
      const table: Record<number, number> = {};
      for (const [hardCode, entry] of map) table[hardCode] = entry.hidCode;
      remap[layer] = table;
    } catch (error) {
      warnings.push(`Could not read the key map of layer ${layer}: ${messageOf(error)}`);
    }
  }

  const light = await keyboard.getLight();
  const keyColorMap = await keyboard.getKeyColors();
  const keyColors: Record<number, KeyColor> = {};
  for (const [hardCode, color] of keyColorMap) keyColors[hardCode] = color;

  const travelMap = await keyboard.getTravelConfig();
  const travel: Record<number, TravelEntry> = {};
  for (const [hardCode, entry] of travelMap) travel[hardCode] = entry;

  // A `cmd 47` read can time out on a busy shared handle even with the retry.
  // Like a failed remap layer, capture tolerates the failure: the warning is
  // recorded and `featuresRead: false` tells restore to leave the device's
  // features untouched instead of clearing them with an empty list.
  let featureKinds: Map<number, FeatureKind> | null = null;
  await delay(FEATURE_LIST_READ_SETTLE_MS);
  try {
    featureKinds = await keyboard.getFeatures();
  } catch (error) {
    warnings.push(`Could not read the feature list: ${messageOf(error)}`);
  }
  const features: KeyboardConfigFeature[] = [];
  for (const [hardCode, kind] of featureKinds ?? []) {
    if (kind === 'none') continue;
    const key = layout.byHardCode.get(hardCode);
    let config: FeatureConfig | null = null;
    try {
      config = await keyboard.getFeature(hardCode);
    } catch (error) {
      warnings.push(
        `Could not read ${kind} settings for hardCode ${hardCode}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (config === null) config = { hardCode, kind };
    features.push({
      ...config,
      ...(key ? { textCode: key.textCode, title: key.title } : {}),
    });
    // The official driver reads one key family at a time with a 55 ms gap.
    await delay(FEATURE_ONE_READ_GAP_MS);
  }

  let winLock: boolean | null = null;
  let lightSleep: number | null = null;
  try {
    winLock = await keyboard.getWinLock();
  } catch (error) {
    warnings.push(`Could not read the Win-lock state: ${messageOf(error)}`);
  }
  try {
    lightSleep = await keyboard.getLightSleep();
  } catch (error) {
    warnings.push(`Could not read the light-sleep delay: ${messageOf(error)}`);
  }

  const config: KeyboardConfig = {
    format: KEYBOARD_CONFIG_FORMAT,
    version: KEYBOARD_CONFIG_VERSION,
    createdAt: new Date().toISOString(),
    product: {
      id: keyboard.product.id,
      title: keyboard.product.title,
      vid: keyboard.product.vid,
      pid: keyboard.product.pid,
    },
    layout: layout.mode,
    firmwareVersion: keyboard.info.firmwareVersion || null,
    remap: { layers: remap },
    light,
    keyColors,
    travel,
    features,
    ...(featureKinds === null ? { featuresRead: false } : {}),
    misc: { winLock, lightSleep },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  validateKeyboardConfig(config);
  return config;
}

/** Alias with the user-facing name used in docs. */
export const backupKeyboardConfig = captureKeyboardConfig;

/** Serialize a backup as pretty-printed JSON after validating it. */
export function stringifyKeyboardConfig(config: KeyboardConfig, space = 2): string {
  validateKeyboardConfig(config);
  return JSON.stringify(stripSensitiveMetadata(config), null, space);
}

/**
 * Drop legacy device identifiers from an already parsed document.
 *
 * Older backups carried `boardId` / `serialNumber`. New captures omit them,
 * but parsing or re-serialising an old file must not leak them back out.
 * Firmware version is intentionally kept.
 */
function stripSensitiveMetadata(config: KeyboardConfig): KeyboardConfig {
  const record = config as unknown as Record<string, unknown>;
  if (!('boardId' in record) && !('serialNumber' in record)) return config;
  const { boardId: _boardId, serialNumber: _serialNumber, ...rest } = record;
  return rest as unknown as KeyboardConfig;
}

/** Parse and validate a backup from JSON text or an already-parsed object. */
export function parseKeyboardConfig(input: string | unknown): KeyboardConfig {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new ValidationError(
        `The backup is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  validateKeyboardConfig(value);
  return stripSensitiveMetadata(value as KeyboardConfig);
}

/** Validate the backup document shape; throws {@link ValidationError}. */
export function validateKeyboardConfig(input: unknown): asserts input is KeyboardConfig {
  if (!isRecord(input)) throw new ValidationError('The backup must be a JSON object');
  if (input['format'] !== KEYBOARD_CONFIG_FORMAT) {
    throw new ValidationError(
      `Unknown backup format ${JSON.stringify(input['format'])}; expected ${JSON.stringify(KEYBOARD_CONFIG_FORMAT)}`,
    );
  }
  if (input['version'] !== KEYBOARD_CONFIG_VERSION) {
    throw new ValidationError(
      `Unsupported backup version ${String(input['version'])}; expected ${KEYBOARD_CONFIG_VERSION}`,
    );
  }
  if (typeof input['createdAt'] !== 'string') {
    throw new ValidationError('The backup is missing createdAt');
  }
  if (!LAYOUT_MODES.has(String(input['layout']))) {
    throw new ValidationError(`Invalid layout ${JSON.stringify(input['layout'])}`);
  }

  const product = input['product'];
  if (!isRecord(product) || !isInteger(product['id']) || typeof product['title'] !== 'string') {
    throw new ValidationError('The backup is missing a valid product block');
  }

  const remap = input['remap'];
  if (!isRecord(remap) || !isRecord(remap['layers'])) {
    throw new ValidationError('The backup is missing remap.layers');
  }
  for (const [rawLayer, table] of Object.entries(remap['layers'])) {
    const layer = Number(rawLayer);
    if (layer !== 0 && layer !== 1 && layer !== 2) {
      throw new ValidationError(`Invalid remap layer ${rawLayer}`);
    }
    if (!isRecord(table)) throw new ValidationError(`Layer ${layer} must be an object`);
    for (const [rawHardCode, usage] of Object.entries(table)) {
      if (!isInteger(Number(rawHardCode))) {
        throw new ValidationError(`Layer ${layer} contains invalid hardCode ${rawHardCode}`);
      }
      if (!isInteger(usage) || usage < 0 || usage > 0xffff) {
        throw new ValidationError(`Layer ${layer} hardCode ${rawHardCode} has an invalid usage`);
      }
    }
  }

  validateLight(input['light']);
  validateKeyColors(input['keyColors']);
  validateTravel(input['travel']);
  validateFeatures(input['features']);
  validateMisc(input['misc']);

  const warnings = input['warnings'];
  if (warnings !== undefined) {
    if (!Array.isArray(warnings) || warnings.some((line) => typeof line !== 'string')) {
      throw new ValidationError('warnings must be an array of strings');
    }
  }
  if (input['featuresRead'] !== undefined && typeof input['featuresRead'] !== 'boolean') {
    throw new ValidationError('featuresRead must be a boolean when present');
  }
}

/**
 * Restore a backup.
 *
 * Missing settings are left untouched when the corresponding `restore*` option
 * is false. Keys the active layout does not know about are skipped and reported
 * in `warnings` (important when restoring a 79-key file on a 65-key board).
 */
export async function restoreKeyboardConfig(
  keyboard: ConfigKeyboard,
  backup: string | KeyboardConfig,
  options: RestoreConfigOptions = {},
): Promise<RestoreConfigResult> {
  const config = typeof backup === 'string' ? parseKeyboardConfig(backup) : backup;
  validateKeyboardConfig(config);

  const layout = keyboard.layout;
  if (layout === null || layout.mode === 'unknown') {
    throw new UnknownLayoutError('Cannot restore settings without a known layout.');
  }
  if (
    config.layout !== 'unknown' &&
    config.layout !== layout.mode &&
    options.allowLayoutMismatch !== true
  ) {
    throw new ValidationError(
      `The backup was captured on ${config.layout}, but the keyboard reports ${layout.mode}. ` +
        'Pass { allowLayoutMismatch: true } to restore the overlapping keys anyway.',
    );
  }

  const warnings: string[] = [...(config.warnings ?? [])];
  await keyboard.ensureKeyTestStopped();

  let lightRestored = false;
  if (options.restoreLight !== false) {
    await keyboard.setLight(config.light);
    lightRestored = true;
  }

  let colors = 0;
  if (options.restoreKeyColors !== false) {
    const entries: KeyColorInput[] = [];
    for (const [rawHardCode, color] of Object.entries(config.keyColors)) {
      const hardCode = Number(rawHardCode);
      if (!layout.byHardCode.has(hardCode)) {
        warnings.push(`Skipped colour for unknown hardCode ${hardCode}`);
        continue;
      }
      entries.push({
        key: hardCode,
        color: color.rgb,
        brightness: clampBrightness(color.brightness),
      });
    }
    await keyboard.setKeyColors(entries);
    colors = entries.length;
  }

  let remap: RemapRestoreResult | null = null;
  const layers = normalizeLayers(
    options.layers ?? (Object.keys(config.remap.layers).map(Number) as (0 | 1 | 2)[]),
  );
  if (layers.length > 0) {
    const snapshot: RemapSnapshot = {
      takenAt: Date.now(),
      layout: options.allowLayoutMismatch === true ? layout.mode : config.layout,
      layers: config.remap.layers,
    };
    // The firmware silently drops `cmd 35` writes (docs/PROTOCOL.md 9.9), so
    // verify the result and pace the writes like the official driver does.
    const verifyRemap = options.verifyRemap ?? true;
    remap = await keyboard.restoreRemapSnapshot(snapshot, {
      layers,
      settleMs: options.settleMs ?? (verifyRemap ? 250 : 0),
      verify: verifyRemap,
      writeGapMs: options.writeGapMs ?? 300,
    });
    if (remap.skipped > 0) {
      warnings.push(`Skipped ${remap.skipped} remap entries the active layout does not know`);
    }
  }

  let travel = 0;
  if (options.restoreTravel !== false) {
    const entries: TravelConfigEntry[] = [];
    for (const [rawHardCode, entry] of Object.entries(config.travel)) {
      const hardCode = Number(rawHardCode);
      if (!layout.byHardCode.has(hardCode)) {
        warnings.push(`Skipped travel settings for unknown hardCode ${hardCode}`);
        continue;
      }
      entries.push({ key: hardCode, ...entry });
    }
    if (entries.length > 0) {
      await keyboard.setTravelConfig(entries);
      travel = entries.length;
      if (options.verifyTravel ?? true) {
        // cmd 41 chunks are silently dropped by the firmware (docs/PROTOCOL.md
        // 9.10). The official driver paces the chunks and settles for
        // `chunks * 10 + 100` ms but never reads back; the SDK applies the same
        // settle inside `setTravelConfig`, then verifies like `verifyRemap`:
        // read back, rewrite the dropped keys once, and report whatever still
        // did not stick instead of failing the restore.
        const dropped = await findTravelMismatches(keyboard, entries, warnings);
        if (dropped.length > 0) {
          warnings.push(`Retrying travel settings for ${dropped.length} key(s) that did not stick`);
          await keyboard.setTravelConfig(dropped);
          const stillWrong = await findTravelMismatches(keyboard, dropped, warnings);
          if (stillWrong.length > 0) {
            warnings.push(
              `Travel settings for ${stillWrong.map((entry) => `0x${entry.key.toString(16)}`).join(', ')} were not adopted after a rewrite`,
            );
          }
        }
      }
    }
  }

  const features = await restoreFeatures(keyboard, config, layout, options, warnings);

  let winLock = false;
  let lightSleep = false;
  if (options.restoreMisc !== false) {
    if (config.misc.winLock !== null) {
      await keyboard.setWinLock(config.misc.winLock);
      winLock = true;
    }
    if (config.misc.lightSleep !== null) {
      await keyboard.setLightSleep(config.misc.lightSleep);
      lightSleep = true;
    }
  }

  return {
    remap,
    colors,
    travel,
    light: lightRestored,
    features,
    misc: { winLock, lightSleep },
    warnings,
  };
}

/** Alias with the user-facing name used in docs. */
export const restoreKeyboardConfigFromJson = restoreKeyboardConfig;

async function restoreFeatures(
  keyboard: ConfigKeyboard,
  config: KeyboardConfig,
  layout: NonNullable<ConfigKeyboard['layout']>,
  options: RestoreConfigOptions,
  warnings: string[],
): Promise<FeatureRestoreSummary> {
  if (options.restoreFeatures === false) {
    return { written: 0, cleared: 0, skipped: 0, warnings: [] };
  }
  if (config.featuresRead === false) {
    // The backup never saw the device's feature list (a timed-out cmd 47 read
    // at capture time). Restoring its empty list would CLEAR every device
    // feature via `clearExtraFeatures`; leave them untouched instead.
    warnings.push(
      'The backup could not read the feature list; the device features were left untouched.',
    );
    return { written: 0, cleared: 0, skipped: 0, warnings: [] };
  }

  const wanted = new Map<number, KeyboardConfigFeature>();
  for (const feature of config.features) {
    if (feature.kind === 'none') continue;
    wanted.set(feature.hardCode, feature);
  }

  // Official pacing: 500 ms after a feature set, 500 ms after a standalone
  // clear, and 1000 ms after a cmd 47 clear that precedes the replacement
  // feature (MPT is 500 ms there; the SDK is conservative and uses 1000 ms for
  // every family). The same 500 ms is used as a quiet window before every
  // cmd 47 list read — the official driver never reads the list back
  // immediately after writing.
  const setGapMs = options.featureGapMs ?? 500;
  const clearGapMs = options.featureClearGapMs ?? 1000;
  const gap = (ms: number): Promise<void> => (ms > 0 ? delay(ms) : Promise.resolve());

  // A cmd 47 read can still time out on a busy shared handle despite the
  // keyboard's own retry. Without the current list, clearing extras is unsafe
  // (it would clear features we never saw), so degrade: leave the device
  // features untouched instead of failing the whole restore.
  await gap(setGapMs);
  let current: Map<number, FeatureKind>;
  try {
    current = await keyboard.getFeatures();
  } catch (error) {
    warnings.push(
      `Could not read the device feature list; the device features were left untouched: ${messageOf(error)}`,
    );
    return { written: 0, cleared: 0, skipped: 0, warnings: [] };
  }
  let cleared = 0;
  if (options.clearExtraFeatures !== false) {
    for (const [hardCode, kind] of current) {
      if (kind === 'none' || wanted.has(hardCode)) continue;
      if (!layout.byHardCode.has(hardCode)) continue;
      await keyboard.clearFeature(hardCode);
      await gap(setGapMs);
      cleared += 1;
    }
  }

  let written = 0;
  let skipped = 0;
  const featureWarnings: string[] = [];
  const applied = new Map<number, KeyboardConfigFeature>();
  for (const [hardCode, feature] of wanted) {
    if (!layout.byHardCode.has(hardCode)) {
      skipped += 1;
      featureWarnings.push(`Skipped ${feature.kind} feature on unknown hardCode ${hardCode}`);
      continue;
    }
    // Validate the backup entry before touching the device: a DKS or
    // incomplete feature must never clear the device's existing feature just
    // to fail on the write.
    const problem = featureRestoreProblem(feature);
    if (problem !== null) {
      if (options.onUnsupportedFeature === 'error') throw new UnsupportedFeatureError(problem);
      skipped += 1;
      featureWarnings.push(problem);
      continue;
    }
    const activeKind = current.get(hardCode) ?? 'none';
    try {
      // The official driver cancels the selected key's existing feature before
      // every set, even when the kind is unchanged. Skipping the clear made
      // overwrites unreliable; mirror the official clear + 1000 ms + set flow.
      if (activeKind !== 'none') {
        await keyboard.clearFeature(hardCode);
        await gap(clearGapMs);
        cleared += 1;
      }
      await applyFeature(keyboard, feature);
      await gap(setGapMs);
      applied.set(hardCode, feature);
      written += 1;
    } catch (error) {
      if (error instanceof UnsupportedFeatureError) {
        if (options.onUnsupportedFeature === 'error') throw error;
        skipped += 1;
        featureWarnings.push(error.message);
        continue;
      }
      throw error;
    }
  }

  // Read the feature list back and give every key one clear + rewrite round
  // when the firmware did not adopt the assignment; still-wrong keys are
  // reported as warnings instead of failing the whole restore. A verify read
  // that times out (despite the retry) degrades to a warning too: the writes
  // themselves already went out.
  await gap(setGapMs);
  const pendingRewrite: KeyboardConfigFeature[] = [];
  let verifyList: Map<number, FeatureKind> | null = null;
  try {
    verifyList = await keyboard.getFeatures();
  } catch (error) {
    featureWarnings.push(`Could not verify the feature list after writing: ${messageOf(error)}`);
  }
  if (verifyList !== null) {
    for (const [hardCode, feature] of applied) {
      if ((verifyList.get(hardCode) ?? 'none') === feature.kind) continue;
      try {
        if ((verifyList.get(hardCode) ?? 'none') !== 'none') {
          await keyboard.clearFeature(hardCode);
          await gap(clearGapMs);
        }
        await applyFeature(keyboard, feature);
        await gap(setGapMs);
        pendingRewrite.push(feature);
      } catch (error) {
        if (error instanceof UnsupportedFeatureError) {
          if (options.onUnsupportedFeature === 'error') throw error;
          featureWarnings.push(error.message);
          continue;
        }
        throw error;
      }
    }
  }
  if (pendingRewrite.length > 0) {
    await gap(setGapMs);
    let finalList: Map<number, FeatureKind> | null = null;
    try {
      finalList = await keyboard.getFeatures();
    } catch (error) {
      finalList = null;
      featureWarnings.push(`Could not verify the feature list after rewriting: ${messageOf(error)}`);
    }
    if (finalList !== null) {
      for (const feature of pendingRewrite) {
        if ((finalList.get(feature.hardCode) ?? 'none') === feature.kind) continue;
        featureWarnings.push(
          `The device did not adopt the ${feature.kind} feature on hardCode ${feature.hardCode}`,
        );
      }
    }
  }

  warnings.push(...featureWarnings);
  return {
    written,
    cleared,
    skipped,
    warnings: featureWarnings,
  };
}

/**
 * Validate a backup feature without touching the device.
 *
 * Used before a cmd 47 clear: an unsupported or incomplete backup entry must
 * be skipped while the device's existing feature stays intact.
 */
function featureRestoreProblem(feature: KeyboardConfigFeature): string | null {
  const key = feature.hardCode;
  switch (feature.kind) {
    case 'none':
      return `Feature kind none cannot be restored on hardCode ${key}`;
    case 'dks':
      return 'DKS settings cannot be restored: this firmware exposes no DKS write command in the SDK.';
    case 'mt': {
      const [hold, tap] = feature.targetHidCodes ?? [];
      if (hold === undefined || tap === undefined) {
        return `MT feature on hardCode ${key} has no target usages`;
      }
      return null;
    }
    case 'tgl': {
      if (feature.targetHidCodes?.[0] === undefined) {
        return `TGL feature on hardCode ${key} has no target usage`;
      }
      return null;
    }
    case 'mpt': {
      const targets = feature.targetHidCodes;
      const mm = feature.travelMm;
      if (!targets || targets.length < 3 || !mm || mm.length < 3) {
        return `MPT feature on hardCode ${key} is incomplete`;
      }
      return null;
    }
    case 'end': {
      if (feature.targetHidCodes?.[0] === undefined) {
        return `END feature on hardCode ${key} has no target usage`;
      }
      return null;
    }
    case 'rs': {
      if (feature.targetHardCodes?.[0] === undefined) {
        return `RS feature on hardCode ${key} has no second key`;
      }
      return null;
    }
    case 'socd': {
      if (feature.targetHardCodes?.[0] === undefined) {
        return `SOCD feature on hardCode ${key} has no second key`;
      }
      return null;
    }
    default:
      return `Feature kind ${String((feature as { kind?: unknown }).kind)} cannot be restored`;
  }
}

async function applyFeature(keyboard: ConfigKeyboard, feature: KeyboardConfigFeature): Promise<void> {
  const key = feature.hardCode;
  switch (feature.kind) {
    case 'dks':
      throw new UnsupportedFeatureError(
        'DKS settings cannot be restored: this firmware exposes no DKS write command in the SDK.',
      );
    case 'mt': {
      const [hold, tap] = feature.targetHidCodes ?? [];
      if (hold === undefined || tap === undefined) {
        throw new UnsupportedFeatureError(`MT feature on hardCode ${key} has no target usages`);
      }
      await keyboard.setMT({ key, hold, tap, ms: feature.tapMs });
      return;
    }
    case 'tgl': {
      const target = feature.targetHidCodes?.[0];
      if (target === undefined) {
        throw new UnsupportedFeatureError(`TGL feature on hardCode ${key} has no target usage`);
      }
      await keyboard.setTGL({ key, target, ms: feature.tapMs });
      return;
    }
    case 'mpt': {
      const targets = feature.targetHidCodes;
      const mm = feature.travelMm;
      if (!targets || targets.length < 3 || !mm || mm.length < 3) {
        throw new UnsupportedFeatureError(`MPT feature on hardCode ${key} is incomplete`);
      }
      await keyboard.setMPT({
        key,
        targets: [targets[0]!, targets[1]!, targets[2]!],
        mm: [mm[0]!, mm[1]!, mm[2]!],
      });
      return;
    }
    case 'end': {
      const target = feature.targetHidCodes?.[0];
      if (target === undefined) {
        throw new UnsupportedFeatureError(`END feature on hardCode ${key} has no target usage`);
      }
      await keyboard.setEND({ key, target, ms: feature.tapMs });
      return;
    }
    case 'rs': {
      const key2 = feature.targetHardCodes?.[0];
      if (key2 === undefined) {
        throw new UnsupportedFeatureError(`RS feature on hardCode ${key} has no second key`);
      }
      await keyboard.setRS({
        key1: key,
        key2,
        bottom: feature.bottom,
        ms: feature.pauseMs,
      });
      return;
    }
    case 'socd': {
      const key2 = feature.targetHardCodes?.[0];
      if (key2 === undefined) {
        throw new UnsupportedFeatureError(`SOCD feature on hardCode ${key} has no second key`);
      }
      await keyboard.setSOCD({
        key1: key,
        key2,
        first1: feature.first1,
        first2: feature.first2,
        bottom: feature.bottom,
        ms: feature.pauseMs,
      });
      return;
    }
    default:
      throw new UnsupportedFeatureError(
        `Feature kind ${String((feature as { kind?: unknown }).kind)} cannot be restored`,
      );
  }
}

function validateLight(value: unknown): asserts value is LightState {
  if (!isRecord(value)) throw new ValidationError('The backup is missing light');
  for (const key of ['mode', 'speed', 'turn', 'brightness', 'colorful']) {
    if (!isInteger(value[key])) throw new ValidationError(`light.${key} must be an integer`);
  }
  if (typeof value['rgb'] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value['rgb'])) {
    throw new ValidationError('light.rgb must be a #RRGGBB string');
  }
}

function validateKeyColors(value: unknown): void {
  if (!isRecord(value)) throw new ValidationError('The backup is missing keyColors');
  for (const [rawHardCode, color] of Object.entries(value)) {
    if (!isInteger(Number(rawHardCode))) {
      throw new ValidationError(`keyColors contains invalid hardCode ${rawHardCode}`);
    }
    if (!isRecord(color) || typeof color['rgb'] !== 'string') {
      throw new ValidationError(`keyColors.${rawHardCode} is invalid`);
    }
    if (!isInteger(color['brightness']) || color['brightness'] < 0 || color['brightness'] > 10) {
      throw new ValidationError(`keyColors.${rawHardCode}.brightness must be 0..10`);
    }
  }
}

function validateTravel(value: unknown): void {
  if (!isRecord(value)) throw new ValidationError('The backup is missing travel');
  for (const [rawHardCode, entry] of Object.entries(value)) {
    if (!isInteger(Number(rawHardCode))) {
      throw new ValidationError(`travel contains invalid hardCode ${rawHardCode}`);
    }
    if (!isRecord(entry)) throw new ValidationError(`travel.${rawHardCode} must be an object`);
    for (const field of ['pressMm', 'releaseMm', 'deadDownMm', 'deadUpMm', 'fastOutMm']) {
      if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field])) {
        throw new ValidationError(`travel.${rawHardCode}.${field} must be a number`);
      }
    }
    for (const field of ['travelDownMm', 'travelUpMm']) {
      if (entry[field] !== undefined && (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]))) {
        throw new ValidationError(`travel.${rawHardCode}.${field} must be a number when present`);
      }
    }
    if (typeof entry['fast'] !== 'boolean') {
      throw new ValidationError(`travel.${rawHardCode}.fast must be a boolean`);
    }
  }
}

function validateFeatures(value: unknown): void {
  if (!Array.isArray(value)) throw new ValidationError('The backup is missing features');
  for (const [index, feature] of value.entries()) {
    if (!isRecord(feature)) throw new ValidationError(`features[${index}] must be an object`);
    if (!isInteger(feature['hardCode'])) {
      throw new ValidationError(`features[${index}].hardCode must be an integer`);
    }
    if (typeof feature['kind'] !== 'string' || !FEATURE_KINDS.has(feature['kind'])) {
      throw new ValidationError(`features[${index}].kind is invalid`);
    }
    if (feature['textCode'] !== undefined && typeof feature['textCode'] !== 'string') {
      throw new ValidationError(`features[${index}].textCode must be a string`);
    }
    if (feature['title'] !== undefined && typeof feature['title'] !== 'string') {
      throw new ValidationError(`features[${index}].title must be a string`);
    }
  }
}

function validateMisc(value: unknown): void {
  if (!isRecord(value)) throw new ValidationError('The backup is missing misc');
  if (value['winLock'] !== null && typeof value['winLock'] !== 'boolean') {
    throw new ValidationError('misc.winLock must be a boolean or null');
  }
  if (value['lightSleep'] !== null) {
    if (!isInteger(value['lightSleep']) || value['lightSleep'] < 0 || value['lightSleep'] > 255) {
      throw new ValidationError('misc.lightSleep must be 0..255 or null');
    }
  }
}

/**
 * Compare a cmd 41 read-back against the intended entry, normalising the
 * SDK's read semantics: the official driver (and this SDK) skip the RT fields
 * for normal (type 1) keys, so the decoded entry reports releaseMm = pressMm
 * and fastOutMm = 0 regardless of what bytes the firmware kept there
 * (docs/PROTOCOL.md 9.6). Values adopt the 0.01 mm grid.
 */
function travelEntryMatches(read: TravelEntry, intended: TravelConfigEntry): boolean {
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 0.011;
  const fast = intended.fast === true;
  const downExpected = fast ? intended.travelDownMm ?? intended.releaseMm : intended.pressMm;
  const upExpected = fast ? intended.travelUpMm ?? intended.releaseMm : intended.pressMm;
  const fastOutExpected = fast ? intended.fastOutMm ?? intended.pressMm : 0;
  return (
    read.fast === fast &&
    close(read.pressMm, intended.pressMm) &&
    close(read.travelDownMm ?? read.releaseMm, downExpected) &&
    close(read.travelUpMm ?? read.releaseMm, upExpected) &&
    close(read.deadDownMm, intended.deadDownMm ?? 0.2) &&
    close(read.deadUpMm, intended.deadUpMm ?? 0.2) &&
    close(read.fastOutMm, fastOutExpected)
  );
}

/**
 * Read the travel table back and return the entries whose values did not
 * stick. A verify read that still times out (despite the keyboard's own
 * retry) degrades to a warning with an empty result — the restore must not
 * die after its writes went out.
 */
async function findTravelMismatches(
  keyboard: ConfigKeyboard,
  entries: readonly TravelConfigEntry[],
  warnings: string[],
): Promise<TravelConfigEntry[]> {
  let readBack: Map<number, TravelEntry>;
  try {
    readBack = await keyboard.getTravelConfig();
  } catch (error) {
    warnings.push(`Could not verify the travel settings: ${messageOf(error)}`);
    return [];
  }
  return entries.filter((entry) => {
    const read = readBack.get(Number(entry.key));
    return read === undefined || !travelEntryMatches(read, entry);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizeLayers(layers: readonly (0 | 1 | 2)[]): (0 | 1 | 2)[] {
  const result: (0 | 1 | 2)[] = [];
  for (const layer of layers) {
    if (layer !== 0 && layer !== 1 && layer !== 2) {
      throw new ValidationError(`Invalid layer ${String(layer)}; expected 0, 1 or 2`);
    }
    if (!result.includes(layer)) result.push(layer);
  }
  return result.sort((a, b) => a - b);
}

function clampBrightness(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.max(0, Math.min(10, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported for callers that want to inspect the supported layer set. */
export const KEYBOARD_CONFIG_LAYERS = DEFAULT_LAYERS;

