/**
 * Wooting Wootility share-profile import, as a userscript-side extension of
 * the SDK: parse -> convert -> backup-format JSON -> apply via the SDK's
 * `restoreKeyboardConfig` path. Layout-overlap numbers come from the SDK's
 * neutral `layoutOverlapInfo`, not from this module.
 */

export {
  WOOTING_DEVICE_TITLES,
  WOOTING_MODELS,
  defaultLayoutForWooting,
  wootingCellTextCode,
  wootingDeviceTitle,
  wootingModel,
  wootingModelForDevice,
} from './layout.ts';
export {
  WOOTING_SHARE_ENDPOINT,
  fetchWootingShare,
} from './share.ts';
export type { FetchWootingShareOptions } from './share.ts';
export {
  WOOTING_KEYCODE_USAGE_TABLE,
  isKnownWootingKeycode,
  wootingKeycodeToUsage,
} from './keycodes.ts';
export {
  WOOTING_PROFILE_VERSION_MAX,
  WOOTING_PROFILE_VERSION_MIN_FULL,
  WootingProfileVersionError,
  extractWootingJson,
  parseWootingShare,
  summarizeWootingProfile,
} from './profile.ts';
export { convertWootingProfile, wootingBrightness } from './convert.ts';
export { wootingProfileToConfig, wootingRestoreOptions } from './backup.ts';
export type { WootingBackupOptions } from './backup.ts';
export type { WootingModelDefinition } from './layout.ts';
export type {
  WootingAnalog,
  WootingConversionStats,
  WootingCustomActuation,
  WootingImportOptions,
  WootingImportPlan,
  WootingIndex,
  WootingModel,
  WootingPerKeyRapidTrigger,
  WootingProfile,
  WootingProfileSummary,
  WootingRemapEntry,
  WootingRgb,
  WootingRgbColor,
  WootingTarget,
} from './types.ts';
