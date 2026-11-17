/**
 * Wooting share profile -> Zetsu settings plan.
 *
 * The conversion is intentionally pure: it does not touch a device. The plan
 * always targets the profile's native layout; call {@link wootingProfileToConfig}
 * to turn it into a `KeyboardConfig` backup document that the SDK restore path
 * can write.
 */

import { ValidationError, KEY_LAYOUTS } from '@bookqaq/zmeow-sdk';
import type {
  HexColor,
  KeyColor,
  KeyDef,
  KeyboardConfigFeature,
  TravelEntry,
} from '@bookqaq/zmeow-sdk';
import { wootingKeycodeToUsage } from './keycodes.ts';
import {
  WOOTING_MODELS,
  defaultLayoutForWooting,
  wootingCellTextCode,
} from './layout.ts';
import {
  WOOTING_PROFILE_VERSION_MIN_FULL,
  parseWootingShare,
  summarizeWootingProfile,
} from './profile.ts';
import type {
  WootingAkcEntry,
  WootingAnalog,
  WootingCustomActuation,
  WootingImportOptions,
  WootingImportPlan,
  WootingPerKeyRapidTrigger,
  WootingProfile,
  WootingRgb,
} from './types.ts';

/** Wooting analog values are in 1/4096 mm (4096 = 1.0 mm). */
const WOOTING_UNITS_PER_MM = 4096;
/** Wootility's lowest actuation point; the Zetsu switches go down to 0.01 mm. */
const WOOTING_MIN_PRESS_MM = 0.1;
/** Gateron magnetic switches span 0–4 mm (the official UI slider stops at 3.1). */
const ZETSU_MAX_PRESS_MM = 4.0;
const DEFAULT_RT_SENSITIVITY_MM = 0.1;

/**
 * Convert a share response into a device-independent plan.
 *
 * @param input raw response text, `{data}` wrapper, or the profile object
 */
export function convertWootingProfile(
  input: string | WootingProfile,
  options: WootingImportOptions = {},
): WootingImportPlan {
  const profile = parseWootingShare(input);
  const source = summarizeWootingProfile(profile);
  const model = WOOTING_MODELS[source.model];
  // The plan always targets the profile's native layout (60HE -> compact65,
  // 80HE -> extended79); restoring onto a different layout is the SDK restore
  // path's job (it filters every write against the active layout).
  const layout = defaultLayoutForWooting(source.model);
  const layoutDef = KEY_LAYOUTS[layout];
  if (!layoutDef) throw new ValidationError(`Unknown target layout ${String(layout)}`);

  const byTextCode = new Map<string, KeyDef>();
  for (const key of layoutDef.keys) byTextCode.set(key.textCode, key);

  const warnings: string[] = [];
  let skippedCells = 0;
  let unknownKeycodes = 0;

  if (source.targetLayout !== null && source.targetLayout !== 0) {
    warnings.push(
      `Wooting target.layout=${source.targetLayout} is not the ANSI layout; ` +
        'keys are mapped best-effort and ISO/JIS-only keys may be skipped.',
    );
  }
  if (profile.remap === null) {
    warnings.push('The Wooting profile has no remap table; the base layer will be left unchanged.');
  }
  if (source.version !== null && source.version < WOOTING_PROFILE_VERSION_MIN_FULL) {
    warnings.push(
      `Legacy Wooting profile schema v${source.version}; ` +
        'only fields with a known meaning are imported, and advanced-key/remap data may be incomplete. ' +
        'Re-save the profile in a current Wootility version for a full import.',
    );
  }

  const remap: Record<number, Record<number, number>> = {};
  const layers = options.layers ?? [0];
  for (const layer of layers) {
    if (layer !== 0 && layer !== 1 && layer !== 2) {
      throw new ValidationError(`Invalid remap layer ${String(layer)}`);
    }
    const entries = profile.remap?.[layer];
    if (!entries) continue;
    const table: Record<number, number> = {};
    for (const entry of entries) {
      const textCode = wootingCellTextCode(source.model, entry.index.rowNr, entry.index.colNr);
      if (textCode === null) {
        skippedCells += 1;
        continue;
      }
      const key = byTextCode.get(textCode);
      if (!key) {
        skippedCells += 1;
        continue;
      }
      const usage = wootingKeycodeToUsage(entry.value);
      if (usage === null) {
        unknownKeycodes += 1;
        warnings.push(
          `Skipped Wooting keycode ${entry.value} at row ${entry.index.rowNr}, col ${entry.index.colNr} (${textCode}).`,
        );
        continue;
      }
      table[key.hardCode] = usage;
    }
    if (Object.keys(table).length > 0) remap[layer] = table;
  }
  if (layers.includes(1) && profile.remap?.[1]) {
    warnings.push('Fn-layer remapping was imported into Zetsu layer 1; verify media keys on the device.');
  }

  const keyColors: Record<number, KeyColor> = {};
  const rgb = profile.rgb;
  if (rgb !== undefined && rgb !== null) {
    if (rgb.effects !== undefined || rgb['effect'] !== undefined) {
      warnings.push(
        'Wooting RGB effect layers are not imported; only static per-key colours are used.',
      );
    }
    if (Array.isArray(rgb.layers) && rgb.layers.length > 0) {
      warnings.push(
        'Wooting per-layer RGB data is not imported; only rgb.kbdArray is used.',
      );
    }
  }
  if (options.colors !== false) {
    if (rgb?.kbdArray) {
      const brightness = wootingBrightness(rgb);
      for (let row = 0; row < rgb.kbdArray.length; row += 1) {
        const cells = rgb.kbdArray[row] ?? [];
        for (let col = 0; col < cells.length; col += 1) {
          const textCode = wootingCellTextCode(source.model, row, col);
          if (textCode === null) continue;
          const key = byTextCode.get(textCode);
          if (!key) continue;
          const color = cells[col];
          if (!color) continue;
          keyColors[key.hardCode] = {
            rgb: rgbToHex(color.red, color.green, color.blue),
            brightness,
          };
        }
      }
    } else if (rgb !== undefined && rgb !== null) {
      warnings.push(
        'The Wooting profile has no static per-key colours (rgb.kbdArray); ' +
          'the keyboard lighting is left unchanged.',
      );
    }
  }

  const travel: Record<number, TravelEntry> = {};
  if (options.actuation !== false) {
    Object.assign(
      travel,
      convertActuation(
        profile.analog,
        profile.customActuations ?? [],
        source.model,
        byTextCode,
        warnings,
        source.version ?? undefined,
      ),
    );
  }

  const features = convertAdvancedKeys(profile, source.model, byTextCode, warnings);

  if (profile.analog?.enableDigital === true) {
    warnings.push(
      'Wooting digital mode has no Zetsu equivalent; actuation/RT settings are imported as analog settings.',
    );
  }
  if (profile.analog?.tachyonMode === true) {
    warnings.push('Wooting Tachyon mode has no Zetsu equivalent and was skipped.');
  }

  const dksCount = wootingDksCount(profile.dks);
  if (dksCount > 0) {
    warnings.push(
      `Wooting DKS settings (${dksCount}) cannot be written by this SDK and were skipped.`,
    );
    if (typeof profile.analog?.dksTickRate === 'number' && profile.analog.dksTickRate > 0) {
      warnings.push('Wooting DKS tick-rate settings were skipped with DKS.');
    }
  }
  if ((profile.gamepad?.mapping?.mappings?.length ?? 0) > 0) {
    warnings.push('Wooting gamepad mappings are not supported and were skipped.');
  }
  if (profile.lightbar !== null && profile.lightbar !== undefined) {
    warnings.push('Wooting lightbar settings are not supported and were skipped.');
  }
  if (Array.isArray(profile.remap)) {
    // Zetsu has a single Fn layer: the import asks for the base layer plus the
    // first Fn layer (0/1), so any other Wooting remap layer (Fn2 / layer 2 and
    // beyond) is ignored even when the profile carries entries for it.
    const ignoredLayers: number[] = [];
    profile.remap.forEach((entries, layer) => {
      if (Array.isArray(entries) && entries.length > 0 && !layers.some((requested) => requested === layer)) {
        ignoredLayers.push(layer);
      }
    });
    if (ignoredLayers.length > 0) {
      warnings.push(
        `Wooting remap layer(s) ${ignoredLayers.join(', ')} were ignored; ` +
          `only layer(s) ${layers.join(', ')} are imported.`,
      );
    }
  }

  return {
    source,
    layout,
    remap,
    keyColors,
    travel,
    features,
    warnings,
    stats: {
      remapKeys: Object.values(remap).reduce((sum, table) => sum + Object.keys(table).length, 0),
      colorKeys: Object.keys(keyColors).length,
      travelKeys: Object.keys(travel).length,
      featureKeys: features.length,
      skippedCells,
      unknownKeycodes,
    },
  };
}

/**
 * Wooting SOCD enum -> Zetsu `first1`/`first2`.
 *
 * Zetsu's UI mapping (from the official driver):
 *   1,1 = last input priority; 1,0 = first-key absolute; 0,1 = second-key
 *   absolute; 0,0 = neutral.
 * Wooting uses 4=last input, 3=secondary priority, 2=absolute priority,
 * 1=neutral, 0=both/disabled.
 */
const WOOTING_SOCD_PRIORITY: Readonly<
  Record<number, { readonly first1: 0 | 1; readonly first2: 0 | 1 }>
> = {
  1: { first1: 0, first2: 0 }, // neutral
  2: { first1: 1, first2: 0 }, // absolute priority (first key)
  3: { first1: 0, first2: 1 }, // absolute priority (second key)
  4: { first1: 1, first2: 1 }, // last input priority
};

interface PairClaims {
  readonly pairs: Set<string>;
  readonly keys: Set<number>;
}

function createPairClaims(): PairClaims {
  return { pairs: new Set<string>(), keys: new Set<number>() };
}

/**
 * Claim an unordered two-key advanced feature (SOCD / Rappy Snappy).
 *
 * Wooting can store a pair once per direction or even bind one key into
 * several pairs. Zetsu's SOCD/RS commands describe one physical pair, so a key
 * may only participate in one pair of a given feature and each unordered pair
 * may only be imported once. First occurrence wins; later duplicates/conflicts
 * are reported instead of being written twice.
 */
function claimPair(
  claims: PairClaims,
  label: 'SOCD' | 'RS',
  first: KeyDef,
  second: KeyDef,
  warnings: string[],
): boolean {
  if (first.hardCode === second.hardCode) {
    warnings.push(
      `Skipped Wooting ${label} pair ${first.textCode}/${second.textCode}: both keys are the same.`,
    );
    return false;
  }
  const pairId =
    first.hardCode < second.hardCode
      ? `${first.hardCode}:${second.hardCode}`
      : `${second.hardCode}:${first.hardCode}`;
  if (claims.pairs.has(pairId)) {
    warnings.push(
      `Skipped duplicate Wooting ${label} pair ${first.textCode}/${second.textCode}: ` +
        'the pair was already imported.',
    );
    return false;
  }
  const conflict = claims.keys.has(first.hardCode)
    ? first
    : claims.keys.has(second.hardCode)
      ? second
      : null;
  if (conflict !== null) {
    warnings.push(
      `Skipped Wooting ${label} pair ${first.textCode}/${second.textCode}: ` +
        `${conflict.textCode} is already bound in another ${label} pair.`,
    );
    return false;
  }
  claims.pairs.add(pairId);
  claims.keys.add(first.hardCode);
  claims.keys.add(second.hardCode);
  return true;
}

function convertAdvancedKeys(
  profile: WootingProfile,
  model: WootingImportPlan['source']['model'],
  byTextCode: ReadonlyMap<string, KeyDef>,
  warnings: string[],
): KeyboardConfigFeature[] {
  const entries = Array.isArray(profile.akc) ? profile.akc : [];
  if (entries.length === 0) return [];

  const features: KeyboardConfigFeature[] = [];
  const seen = new Set<number>();
  const socdClaims = createPairClaims();
  const rsClaims = createPairClaims();

  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      warnings.push('Skipped an invalid Wooting AKC entry.');
      continue;
    }
    const key = resolveAkcKey(entry.keyIndex, model, byTextCode);
    if (key === null) {
      warnings.push(
        `Skipped Wooting AKC at row ${indexPart(entry.keyIndex, 'rowNr')}, col ${indexPart(entry.keyIndex, 'colNr')}: key is not present on the target layout.`,
      );
      continue;
    }
    if (seen.has(key.hardCode)) {
      warnings.push(`Skipped a duplicate Wooting AKC entry on ${key.textCode}.`);
      continue;
    }
    const layer = typeof entry.layer === 'number' ? entry.layer : 0;
    if (layer !== 0) {
      warnings.push(
        `Skipped Wooting AKC on ${key.textCode} layer ${layer}: Zetsu advanced keys are not layer-scoped.`,
      );
      continue;
    }

    let feature: KeyboardConfigFeature | null = null;
    if (entry.socd !== undefined) {
      feature = convertSocd(entry, key, model, byTextCode, socdClaims, warnings);
    } else if (entry.modTap !== undefined) {
      feature = convertModTap(entry.modTap, key, warnings);
    } else if (entry.toggleKey !== undefined) {
      feature = convertToggle(entry.toggleKey, key, warnings);
    } else if (entry.rappySnappy !== undefined) {
      feature = convertRappySnappy(entry.rappySnappy, key, model, byTextCode, rsClaims, warnings);
    } else if (entry.dks !== undefined) {
      warnings.push(`Wooting DKS on ${key.textCode} cannot be written by this SDK and was skipped.`);
    } else {
      warnings.push(`Skipped unsupported Wooting AKC entry on ${key.textCode}.`);
    }
    if (feature !== null) {
      features.push(feature);
      seen.add(key.hardCode);
    }
  }
  return features;
}

function convertSocd(
  entry: WootingAkcEntry,
  key: KeyDef,
  model: WootingImportPlan['source']['model'],
  byTextCode: ReadonlyMap<string, KeyDef>,
  claims: PairClaims,
  warnings: string[],
): KeyboardConfigFeature | null {
  const socd = entry.socd;
  if (socd === undefined) return null;
  const second = resolveAkcKey(socd.secondaryKey, model, byTextCode);
  if (second === null) {
    warnings.push(
      `Skipped Wooting SOCD on ${key.textCode}: second key is not present on the target layout.`,
    );
    return null;
  }
  const mode = socd.socd;
  const priority = typeof mode === 'number' ? WOOTING_SOCD_PRIORITY[mode] : undefined;
  if (priority === undefined) {
    warnings.push(
      `Skipped Wooting SOCD on ${key.textCode}: mode ${String(mode)} is disabled or unsupported.`,
    );
    return null;
  }
  if (!claimPair(claims, 'SOCD', key, second, warnings)) return null;
  return {
    hardCode: key.hardCode,
    kind: 'socd',
    targetHardCodes: [second.hardCode],
    first1: priority.first1,
    first2: priority.first2,
    bottom: akcBottom(socd),
    pauseMs: 10,
  };
}

function convertModTap(
  modTap: NonNullable<WootingAkcEntry['modTap']>,
  key: KeyDef,
  warnings: string[],
): KeyboardConfigFeature | null {
  const hold = keybindUsage(modTap.holdKey);
  const tap = keybindUsage(modTap.tapKey);
  if (hold === null || tap === null) {
    warnings.push(
      `Skipped Wooting MT on ${key.textCode}: tap/hold target is not a known keycode.`,
    );
    return null;
  }
  return {
    hardCode: key.hardCode,
    kind: 'mt',
    targetHidCodes: [hold, tap],
    ...(typeof modTap.holdDuration === 'number' && modTap.holdDuration > 0
      ? { tapMs: Math.round(modTap.holdDuration) }
      : {}),
  };
}

function convertToggle(
  toggleKey: NonNullable<WootingAkcEntry['toggleKey']>,
  key: KeyDef,
  warnings: string[],
): KeyboardConfigFeature | null {
  const target = keybindUsage(toggleKey.keybind);
  if (target === null) {
    warnings.push(`Skipped Wooting TGL on ${key.textCode}: target is not a known keycode.`);
    return null;
  }
  return {
    hardCode: key.hardCode,
    kind: 'tgl',
    targetHidCodes: [target],
  };
}

function convertRappySnappy(
  rappySnappy: NonNullable<WootingAkcEntry['rappySnappy']>,
  key: KeyDef,
  model: WootingImportPlan['source']['model'],
  byTextCode: ReadonlyMap<string, KeyDef>,
  claims: PairClaims,
  warnings: string[],
): KeyboardConfigFeature | null {
  const second = resolveAkcKey(rappySnappy.secondaryKey, model, byTextCode);
  if (second === null) {
    warnings.push(
      `Skipped Wooting RS on ${key.textCode}: second key is not present on the target layout.`,
    );
    return null;
  }
  if (!claimPair(claims, 'RS', key, second, warnings)) return null;
  return {
    hardCode: key.hardCode,
    kind: 'rs',
    targetHardCodes: [second.hardCode],
    bottom: akcBottom(rappySnappy),
  };
}

function resolveAkcKey(
  index: { readonly rowNr?: unknown; readonly colNr?: unknown } | undefined,
  model: WootingImportPlan['source']['model'],
  byTextCode: ReadonlyMap<string, KeyDef>,
): KeyDef | null {
  if (
    index === undefined ||
    typeof index.rowNr !== 'number' ||
    typeof index.colNr !== 'number' ||
    !Number.isInteger(index.rowNr) ||
    !Number.isInteger(index.colNr)
  ) {
    return null;
  }
  const textCode = wootingCellTextCode(model, index.rowNr, index.colNr);
  if (textCode === null) return null;
  return byTextCode.get(textCode) ?? null;
}

function keybindUsage(value: unknown): number | null {
  const byte = keybindByte(value);
  return byte === null ? null : wootingKeycodeToUsage(byte);
}

function keybindByte(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record['byte'] === 'number' && Number.isInteger(record['byte'])) {
    return record['byte'];
  }
  return keybindByte(record['keybind']);
}

function akcBottom(setting: {
  readonly inputBothOnBottomOut?: boolean;
  readonly inputBothWhenBottomedOut?: boolean;
}): boolean {
  return setting.inputBothWhenBottomedOut ?? setting.inputBothOnBottomOut ?? false;
}

function indexPart(index: unknown, part: 'rowNr' | 'colNr'): string {
  if (index === null || typeof index !== 'object') return '?';
  const value = (index as Record<string, unknown>)[part];
  return typeof value === 'number' ? String(value) : '?';
}

function convertActuation(
  analog: WootingAnalog | undefined,
  customActuations: readonly WootingCustomActuation[],
  model: WootingImportPlan['source']['model'],
  byTextCode: ReadonlyMap<string, KeyDef>,
  warnings: string[],
  version: number | undefined,
): Record<number, TravelEntry> {
  const result: Record<number, TravelEntry> = {};
  const globalActPoint =
    analog !== undefined && typeof analog.actPoint === 'number' ? analog.actPoint : undefined;
  const hasGlobalActPoint = globalActPoint !== undefined;

  // Wootility profiles use several analog scales:
  //  - v12/v14 share responses use millimetres;
  //  - v15 local exports use 1/4096 mm integers;
  //  - v12 stores custom actuations in 0.1 mm steps while v14 stores mm.
  // Detect from the magnitude first; 4 mm is the hardware maximum, so a value
  // above it cannot be a millimetre value. `version` then disambiguates the
  // integer custom-actuation values (v12 `1` = 0.1 mm, v14 `1` = 1.0 mm).
  // With no global actPoint, use the mm path: `customActuationMm` still handles
  // the v15 integer scale by magnitude, and the v12/v14 rules stay intact.
  const mmScale = globalActPoint !== undefined ? isMillimetreScale(globalActPoint) : true;
  const globalPress =
    globalActPoint !== undefined
      ? clampPress(normalizeAnalogMm(globalActPoint, version), warnings, 'global actPoint')
      : undefined;
  // Wooting Split Sensitivity:
  //   primary `rapidTriggerSensitivity`          = KEY PRESS - ACTIVATE (`travel_down`)
  //   secondary `rapidTriggerSecondarySensitivity` = KEY RELEASE - DEACTIVATE (`travel_up`)
  // Zetsu's `travelDownMm` is the press/re-trigger travel and `travelUpMm`
  // is the release/reset travel, so the two Wooting values map straight across.
  const globalPressSensitivity =
    analog !== undefined && typeof analog.rapidTriggerSensitivity === 'number'
      ? normalizeAnalogMm(analog.rapidTriggerSensitivity, version)
      : DEFAULT_RT_SENSITIVITY_MM;
  const secondary = analog?.rapidTriggerSecondarySensitivity;
  const globalReleaseSensitivity =
    typeof secondary === 'number' && secondary > 0
      ? normalizeAnalogMm(secondary, version)
      : globalPressSensitivity;
  const globalRapidTrigger = analog?.rapidTrigger === true;
  // Wooting's strict actuation range limits RT to the first actuation window;
  // Zetsu expresses the opposite (full-range RT) as fastOut = 0. Version 0
  // predates the migration that inverted this flag, so its old boolean means
  // the opposite.
  const globalStrict =
    analog === undefined
      ? undefined
      : version === 0
        ? analog.rapidTriggerStrictActuationRange !== true
        : analog.rapidTriggerStrictActuationRange;

  const custom = new Map<string, number>();
  for (const entry of customActuations) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof entry.value === 'number' &&
      typeof entry.index?.rowNr === 'number' &&
      typeof entry.index?.colNr === 'number'
    ) {
      custom.set(cellId(entry.index.rowNr, entry.index.colNr), entry.value);
    } else {
      warnings.push('Skipped an invalid Wooting customActuations entry.');
    }
  }

  interface RtTravel {
    readonly down: number;
    readonly up: number;
    readonly strict?: boolean;
    readonly fast: boolean;
  }
  const perKey = new Map<string, RtTravel>();
  for (const entry of analogPerKey(analog)) {
    const id = cellId(entry.index.rowNr, entry.index.colNr);
    const setting = entry.value;
    // Older profiles store `true`/`false`; newer ones store
    // `{ sensitivity, secondarySensitivity, strictActuationRange }`.
    // `false` is an explicit per-key OFF and must win over global RT.
    if (setting === false) {
      perKey.set(id, {
        down: globalPressSensitivity,
        up: globalReleaseSensitivity,
        fast: false,
      });
      continue;
    }
    if (setting === null) continue;
    if (setting === true) {
      perKey.set(id, {
        down: globalPressSensitivity,
        up: globalReleaseSensitivity,
        fast: true,
      });
      continue;
    }
    if (typeof setting !== 'object') continue;
    const down =
      typeof setting.sensitivity === 'number' && setting.sensitivity >= 0
        ? normalizeAnalogMm(setting.sensitivity, version)
        : globalPressSensitivity;
    const up =
      typeof setting.secondarySensitivity === 'number' && setting.secondarySensitivity > 0
        ? normalizeAnalogMm(setting.secondarySensitivity, version)
        : globalReleaseSensitivity;
    perKey.set(id, {
      down,
      up,
      fast: true,
      ...(typeof setting.strictActuationRange === 'boolean'
        ? { strict: setting.strictActuationRange }
        : {}),
    });
  }

  if (!hasGlobalActPoint && custom.size > 0) {
    warnings.push(
      'The Wooting profile has no global actuation point; only per-key custom actuations were imported.',
    );
  }

  // A physical key can occupy several Wooting matrix cells (the 60HE Space is
  // five). Collect the explicit per-cell settings first so a custom actuation
  // or RT entry on a later cell is not swallowed by the first cell.
  interface KeySource {
    readonly key: KeyDef;
    customValue?: number;
    rt?: RtTravel;
  }
  const sources = new Map<number, KeySource>();
  const definition = WOOTING_MODELS[model];
  for (let row = 0; row < definition.cells.length; row += 1) {
    const cells = definition.cells[row] ?? [];
    for (let col = 0; col < cells.length; col += 1) {
      const textCode = cells[col];
      if (textCode === null) continue;
      const key = byTextCode.get(textCode);
      if (!key) continue;
      const source = sources.get(key.hardCode) ?? { key };
      const id = cellId(row, col);
      const customValue = custom.get(id);
      if (customValue !== undefined && source.customValue === undefined) {
        source.customValue = customValue;
      }
      const rt = perKey.get(id);
      if (rt !== undefined && source.rt === undefined) {
        source.rt = rt;
      }
      sources.set(key.hardCode, source);
    }
  }

  for (const source of sources.values()) {
    const { key, rt } = source;
    if (source.customValue === undefined && !hasGlobalActPoint) continue;
    const pressMm =
      source.customValue === undefined
        ? globalPress
        : clampPress(
            customActuationMm(source.customValue, mmScale, version),
            warnings,
            `${key.textCode} actuation`,
          );
    if (pressMm === undefined) continue;
    const fast = rt?.fast ?? globalRapidTrigger;
    const rtTravel = rt ?? {
      down: globalPressSensitivity,
      up: globalReleaseSensitivity,
      fast: false,
    };
    // A per-key strict value wins over the global one, including the legacy
    // version-0 inversion.
    const strict =
      version === 0 && rt?.strict !== undefined
        ? !rt.strict
        : (rt?.strict ?? globalStrict);
    const fastOutMm = strict === false ? 0 : pressMm;
    // Wooting has no Zetsu-style top/bottom anti-touch dead zones. Leaving
    // the 0.2 mm default here pushes the effective trigger deeper and makes
    // the minimum 0.1 mm actuation unusable; imported profiles therefore
    // always clear both zones.
    result[key.hardCode] = {
      hardCode: key.hardCode,
      pressMm,
      releaseMm: fast ? clampRelease(rtTravel.up) : pressMm,
      ...(fast
        ? {
            travelUpMm: clampRelease(rtTravel.up),
            travelDownMm: clampRelease(rtTravel.down),
          }
        : {}),
      deadDownMm: 0,
      deadUpMm: 0,
      fastOutMm,
      fast,
    };
  }
  return result;
}

function analogPerKey(
  analog: WootingAnalog | undefined,
): readonly WootingPerKeyRapidTrigger[] {
  return Array.isArray(analog?.perKeyRapidTrigger) ? analog.perKeyRapidTrigger : [];
}

/**
 * Wootility brightness (0..255) -> Zetsu light brightness (0..10), the same
 * scale the key-colour brightness uses. Exported for the backup builder, which
 * needs it for the `light` block (not only per-key colours).
 */
export function wootingBrightness(rgb: WootingRgb): number {
  if (typeof rgb.brightness !== 'number' || !Number.isFinite(rgb.brightness)) return 10;
  return Math.max(0, Math.min(10, Math.round(rgb.brightness / 25.5)));
}

/**
 * Local replacement for the SDK's internal `rgbToHex` (not on the public
 * surface): three channels as an upper-case `#RRGGBB` string.
 */
function rgbToHex(r: number, g: number, b: number): HexColor {
  const byte = (value: number): string => (value & 0xff).toString(16).padStart(2, '0').toUpperCase();
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

function clampPress(value: number, warnings: string[], label: string): number {
  if (!Number.isFinite(value)) return WOOTING_MIN_PRESS_MM;
  if (value < WOOTING_MIN_PRESS_MM) {
    warnings.push(`${label} ${value.toFixed(2)}mm is below 0.1mm; clamped to 0.1mm.`);
    return WOOTING_MIN_PRESS_MM;
  }
  if (value > ZETSU_MAX_PRESS_MM) {
    warnings.push(`${label} ${value.toFixed(2)}mm is above 4mm; clamped to 4mm.`);
    return ZETSU_MAX_PRESS_MM;
  }
  return Math.round(value * 100) / 100;
}

function clampRelease(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RT_SENSITIVITY_MM;
  return Math.max(0, Math.min(ZETSU_MAX_PRESS_MM, Math.round(value * 100) / 100));
}

/** True when the value is small enough to be a millimetre reading. */
function isMillimetreScale(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= ZETSU_MAX_PRESS_MM;
}

/**
 * Normalize a Wooting analog reading to millimetres.
 *
 * Profile versions 0..2 predate the "sensitivities into MM resolution"
 * migration and store the value as 8-bit 0..255 over the 0..4 mm range
 * (`255 = 4.0 mm`). Versions 3..8 store millimetres; newer devices may store
 * 14-bit integers (1/4096 mm). Magnitude detection covers the latter two.
 */
function normalizeAnalogMm(value: number, version: number | undefined): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (version !== undefined && version < 3) {
    if (value > 255) return value / WOOTING_UNITS_PER_MM;
    if (value > ZETSU_MAX_PRESS_MM) return (value / 255) * ZETSU_MAX_PRESS_MM;
    return value;
  }
  return isMillimetreScale(value) ? value : value / WOOTING_UNITS_PER_MM;
}

/**
 * Normalize a custom actuation value.
 *
 * v0..v2 use the old 8-bit analog scale for actuation as well; v12 share
 * responses use 0.1 mm steps (`1` = 0.1 mm), v14 share responses use
 * millimetres (`0.7`, `1`, `2`), and v15 exports use 1/4096 mm integers.
 */
function customActuationMm(value: number, mmScale: boolean, version: number | undefined): number {
  if (version !== undefined && version < 3) {
    if (value > 255) return value / WOOTING_UNITS_PER_MM;
    if (value > ZETSU_MAX_PRESS_MM) return (value / 255) * ZETSU_MAX_PRESS_MM;
    return value;
  }
  if (!mmScale) return value / WOOTING_UNITS_PER_MM;
  if (version !== undefined && version <= 12) {
    if (Number.isInteger(value) && value > 0 && value <= ZETSU_MAX_PRESS_MM * 10) {
      return value / 10;
    }
  }
  if (value > ZETSU_MAX_PRESS_MM) return value / WOOTING_UNITS_PER_MM;
  return value;
}

function wootingDksCount(dks: unknown): number {
  if (Array.isArray(dks)) return dks.length;
  if (dks !== null && typeof dks === 'object') {
    const array = (dks as { readonly dksArray?: unknown }).dksArray;
    if (Array.isArray(array)) return array.length;
  }
  return 0;
}

function cellId(row: number, col: number): string {
  return `${row},${col}`;
}
