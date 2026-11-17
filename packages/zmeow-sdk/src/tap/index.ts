/**
 * Driver tap layer: observe/rewrite the official page's WebHID and Web Serial
 * traffic, and optionally open an active SDK connection on the same handles.
 */

export { HidTap } from './hid-tap.ts';
export type { HidTapOptions } from './hid-tap.ts';
export { SerialTap } from './serial-tap.ts';
export type { SerialTapOptions } from './serial-tap.ts';
export {
  ZetsuTap,
  installZetsuTap,
  listGrantedKeyboards,
} from './bridge.ts';
export type { ActiveScreenOptions } from './bridge.ts';
export {
  KNOWN_DRIVER_HASHES,
  KNOWN_FIRMWARE_VERSIONS,
  clearFingerprintCache,
  fingerprintDriverAssets,
  hashAssetUrl,
  makeFingerprint,
  productRecordMatches,
  readProductRecord,
  sha256Hex,
  toHex,
} from './fingerprint.ts';
export type {
  AssetFingerprintResult,
  DriverProductRecord,
} from './fingerprint.ts';
export type {
  HidDeviceConstructorLike,
  HidTapFrame,
  SerialPortConstructorLike,
  SerialTapFrame,
  TapAdapter,
  TapCounters,
  TapDecision,
  TapDirection,
  TapEnvironment,
  TapEvents,
  TapFingerprint,
  TapFrame,
  TapHidStatus,
  TapHooks,
  TapMode,
  TapSerialStatus,
  TapState,
  TapStatus,
  ZetsuTapOptions,
} from './types.ts';
