/**
 * Wooting share profile -> Zetsu `KeyboardConfig` backup document.
 *
 * The extension no longer writes to the device itself: a profile is converted
 * into the SDK's portable backup JSON and applied through the standard
 * `restoreKeyboardConfig` path. That keeps one write pipeline (verify, pacing,
 * layout-mismatch filtering) for both real backups and Wooting imports.
 *
 * The conversion is pure and always targets the profile's native layout
 * (60HE -> `compact65`, 80HE -> `extended79`); restoring onto a different
 * layout is the restore path's job.
 */

import {
  KEYBOARD_CONFIG_FORMAT,
  KEYBOARD_CONFIG_VERSION,
  KEY_LAYOUTS,
  ZETSU63_PRODUCT,
  validateKeyboardConfig,
} from '@bookqaq/zmeow-sdk';
import type { KeyboardConfig, RestoreConfigOptions } from '@bookqaq/zmeow-sdk';
import { convertWootingProfile, wootingBrightness } from './convert.ts';
import { parseWootingShare } from './profile.ts';
import type { WootingProfile } from './types.ts';

export interface WootingBackupOptions {
  /** Remap layers to import. Defaults to the base layer (`[0]`). */
  readonly layers?: readonly (0 | 1 | 2)[];
  /** Import the per-key `rgb.kbdArray`. Default true. */
  readonly colors?: boolean;
  /** Import actuation points and Rapid Trigger settings. Default true. */
  readonly actuation?: boolean;
}

/**
 * Convert a Wootility share profile into a validated `KeyboardConfig` document.
 *
 * @param input raw response text, `{data}` wrapper, or the profile object
 */
export function wootingProfileToConfig(
  input: string | WootingProfile,
  options: WootingBackupOptions = {},
): KeyboardConfig {
  const profile = parseWootingShare(input);
  const plan = convertWootingProfile(profile, {
    layers: options.layers,
    colors: options.colors,
    actuation: options.actuation,
  });

  // Identity-remap filtering: drop every entry whose target usage equals the
  // key's own default usage. The firmware normalizes identity remaps away
  // (writing a key's default leaves no entry behind), so `restoreRemapSnapshot`
  // — which diffs against `current.get(hardCode)?.hidCode ?? 0` — would rewrite
  // them, the write would silently vanish (verified on hardware, fw 1.1.1), and
  // the verify pass would fail. A Wooting profile's identity entries carry no
  // information anyway: dropping them keeps the import a pure override patch.
  const layoutDef = KEY_LAYOUTS[plan.layout];
  const defaultUsageByHardCode = new Map(layoutDef.keys.map((key) => [key.hardCode, key.hidCode]));
  const layers: Record<number, Record<number, number>> = {};
  for (const [rawLayer, table] of Object.entries(plan.remap)) {
    const filtered: Record<number, number> = {};
    for (const [rawHardCode, usage] of Object.entries(table)) {
      const hardCode = Number(rawHardCode);
      const defaultUsage = defaultUsageByHardCode.get(hardCode);
      if (defaultUsage !== undefined && usage === defaultUsage) continue;
      filtered[hardCode] = usage;
    }
    if (Object.keys(filtered).length > 0) layers[Number(rawLayer)] = filtered;
  }

  const config: KeyboardConfig = {
    format: KEYBOARD_CONFIG_FORMAT,
    version: KEYBOARD_CONFIG_VERSION,
    createdAt: new Date().toISOString(),
    product: {
      id: ZETSU63_PRODUCT.id,
      title: ZETSU63_PRODUCT.title,
      vid: ZETSU63_PRODUCT.vid,
      pid: ZETSU63_PRODUCT.pid,
    },
    layout: plan.layout,
    firmwareVersion: null,
    remap: { layers },
    // mode 255 = per-key custom: restore writes light BEFORE colours, which
    // satisfies the documented colour-write precondition (the official driver
    // switches to mode 255 before every cmd 20 colour write).
    light: {
      mode: 255,
      speed: 80,
      turn: 0,
      brightness: wootingBrightness(profile.rgb ?? {}),
      colorful: 1,
      rgb: '#000000',
    },
    keyColors: plan.keyColors,
    travel: plan.travel,
    // Advanced keys are imported as a patch: callers restore with
    // `clearExtraFeatures: false`, so only the profile's SOCD/MT/TGL/RS
    // entries are written and unrelated device features stay untouched.
    features: plan.features,
    misc: { winLock: null, lightSleep: null },
    warnings: [
      `Generated from a Wooting profile: ${plan.source.modelTitle} "${plan.source.name}".`,
      ...plan.warnings,
    ],
  };
  validateKeyboardConfig(config);
  return config;
}

/**
 * Restore options for a converted Wooting backup.
 *
 * A profile without static per-key colours must not touch the device lighting:
 * the backup still has to carry a `light` block (the format requires it), but
 * restoring it would switch the board to per-key mode and could blank a board
 * that only received a remap/actuation profile. Features are a patch: only the
 * profile's advanced keys are written and unrelated device features stay.
 */
export function wootingRestoreOptions(config: KeyboardConfig): RestoreConfigOptions {
  const hasColors = Object.keys(config.keyColors).length > 0;
  const hasFeatures = config.features.length > 0;
  return {
    restoreLight: hasColors,
    restoreKeyColors: hasColors,
    restoreFeatures: hasFeatures,
    clearExtraFeatures: false,
  };
}
