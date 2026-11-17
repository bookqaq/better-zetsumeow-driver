/**
 * Public surface of `@bookqaq/zmeow-sdk`.
 *
 * Everything is dependency free and free of side effects: importing this module
 * never touches `navigator.hid` / `navigator.serial`.
 */

// High level client
export { PRODUCTS, ZetsuKeyboard } from './keyboard.ts';
export type {
  ConnectOptions,
  DisconnectOptions,
  EndKeyOptions,
  KeyColorInput,
  KeyTravelPatch,
  MTKeyOptions,
  MptKeyOptions,
  OpenScreenOptions,
  RSKeyOptions,
  Rgb,
  SetKeyColorOptions,
  SetLightPatch,
  SetRemapOptions,
  ResetRemapOptions,
  RemapSnapshot,
  RemapSnapshotOptions,
  RemapRestoreEntry,
  RemapRestoreResult,
  RestoreRemapOptions,
  SocdKeyOptions,
  TglKeyOptions,
  TravelConfigEntry,
} from './keyboard.ts';

// JSON backup / restore
export {
  KEYBOARD_CONFIG_FORMAT,
  KEYBOARD_CONFIG_LAYERS,
  KEYBOARD_CONFIG_VERSION,
  backupKeyboardConfig,
  captureKeyboardConfig,
  layoutOverlapInfo,
  parseKeyboardConfig,
  restoreKeyboardConfig,
  restoreKeyboardConfigFromJson,
  stringifyKeyboardConfig,
  validateKeyboardConfig,
} from './config/index.ts';
export type {
  CaptureConfigOptions,
  ConfigKeyboard,
  FeatureRestoreSummary,
  KeyboardConfig,
  KeyboardConfigFeature,
  KeyboardConfigMisc,
  KeyboardConfigProduct,
  LayoutOverlapInfo,
  RestoreConfigOptions,
  RestoreConfigResult,
} from './config/index.ts';

// Screen (Web Serial)
export { ZetsuScreen, encodeRgb565, encodeScreenName } from './screen.ts';
export type { ScreenFrame, ScreenSendOptions, ZetsuScreenOptions } from './screen.ts';

// Transports
export {
  HidTransport,
  describeHidDevice,
  describeInterface,
  getGrantedHidDevices,
  getHidApi,
  isWebHidSupported,
  outputReportBytes,
  rankHidInterfaces,
  requestHidDevice,
  requestHidDevices,
} from './transport/webhid.ts';
export type {
  HidInterfaceCandidate,
  HidInterfaceDescription,
  HidTransportOptions,
} from './transport/webhid.ts';
export {
  DEFAULT_BAUD_RATE,
  SerialTransport,
  decodeSerialFrames,
  encodeSerialFrame,
  getSerialApi,
  isWebSerialSupported,
} from './transport/webserial.ts';
export type { SerialFrame, SerialTransportOptions } from './transport/webserial.ts';
export { MockTransport } from './transport/mock.ts';
export type { MockTransportOptions } from './transport/mock.ts';
export type {
  FrameListener,
  HidCollectionInfo,
  HidDeviceFilter,
  HidDeviceLike,
  HidLike,
  HidReportInfo,
  SerialLike,
  SerialOpenOptions,
  SerialPortFilter,
  SerialPortLike,
  Transport,
  TransportKind,
} from './transport/types.ts';


// Driver tap layer (observe/rewrite an existing page, optional active link)
export {
  HidTap,
  SerialTap,
  ZetsuTap,
  installZetsuTap,
  listGrantedKeyboards,
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
} from './tap/index.ts';
export type {
  ActiveScreenOptions,
  AssetFingerprintResult,
  DriverProductRecord,
  HidDeviceConstructorLike,
  HidTapFrame,
  HidTapOptions,
  SerialPortConstructorLike,
  SerialTapFrame,
  SerialTapOptions,
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
} from './tap/index.ts';

// Types + errors
export * from './types.ts';
export * from './errors.ts';

// Protocol primitives (useful for tooling / debugging)
export { REPORT_HEAD, REPORT_SIZE, buildFrame, computeChecksum, parseFrame } from './protocol/frame.ts';
export type { ParsedFrame } from './protocol/frame.ts';
export { HidCommand, MiscSubCommand } from './protocol/commands.ts';
export type { KeyColorEntry, LightSetConfig, TravelSetEntry } from './protocol/commands.ts';
export {
  decodeDeviceInfo,
  decodeFeature,
  decodeFeatureList,
  decodeKeyColors,
  decodeKeyMap,
  decodeKeyTravel,
  decodeLight,
  decodeMisc,
  decodeTravelConfig,
} from './protocol/response.ts';
export type { DecodedDeviceInfo, KeyTravelDecode, MiscDecode } from './protocol/response.ts';

// Generated reference data
export { KEY_LAYOUTS, ZETSU63_PRODUCT } from './generated/product-zetsu63.ts';
export { KEY_CATALOG, KEY_CATALOG_CATEGORIES } from './generated/key-catalog.ts';
export type { KeyCatalogEntry } from './generated/key-catalog.ts';
export { LIGHT_BRIGHTNESS_MAX, LIGHT_MODES } from './generated/light-modes.ts';
export type { LightModeDefinition } from './generated/light-modes.ts';
