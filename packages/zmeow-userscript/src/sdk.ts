/**
 * Thin adapter around `@bookqaq/zmeow-sdk`.
 *
 * This is the only file in the userscript that imports the SDK. The app shell
 * (`main.ts` / `ui.ts`) only talks to the small structural contracts below, so
 * the Lead can adjust a single file when the SDK API settles.
 *
 * Contract this adapter is written against (see packages/zmeow-sdk/src/tap):
 *   ZetsuTap.install({ product }) -> Promise<ZetsuTap>
 *   tap.status: TapStatus { state, fingerprint, hid, serial, frames, reasons }
 *   tap.on('status' | 'frame', listener)
 *   tap.connectKeyboard() / tap.connectScreen() / tap.disconnect() / tap.stop()
 */

import {
  ZETSU63_PRODUCT,
  ZetsuTap,
  ZmeowError,
  captureKeyboardConfig,
  layoutOverlapInfo,
  parseKeyboardConfig,
  restoreKeyboardConfig,
  stringifyKeyboardConfig,
} from '@bookqaq/zmeow-sdk';
import type {
  ConfigKeyboard,
  KeyboardConfig,
  RestoreConfigOptions,
  RestoreConfigResult,
  TapEnvironment,
} from '@bookqaq/zmeow-sdk';
export type {
  KeyboardConfig,
  RestoreConfigOptions,
  RestoreConfigResult,
} from '@bookqaq/zmeow-sdk';
import {
  WOOTING_SHARE_ENDPOINT,
  WootingProfileVersionError,
  fetchWootingShare,
  parseWootingShare,
  summarizeWootingProfile,
  wootingProfileToConfig,
  wootingRestoreOptions,
} from './wooting/index.ts';
import type {
  WootingImportOptions,
  WootingProfile,
  WootingProfileSummary,
} from './wooting/index.ts';
export type { WootingProfile, WootingImportOptions } from './wooting/index.ts';

export type TapState = 'idle' | 'active' | 'readonly' | 'disabled' | (string & {});

/**
 * Loose view of `TapStatus`. The SDK's fingerprint is a structured
 * `TapFingerprint` object today; older/experimental shapes may return a string,
 * so both are accepted and normalised by {@link statusFingerprint}.
 */
export interface TapStatusView {
  state: TapState;
  fingerprint?: unknown;
  reasons?: unknown;
  frames?: unknown;
  adapterId?: string | null;
  [key: string]: unknown;
}

export interface TapFrameView {
  kind: 'hid' | 'serial' | (string & {});
  direction?: string;
  command?: string | number;
  [key: string]: unknown;
}

/**
 * Minimal view of the SDK's `TapHooks`. The userscript only ever installs the
 * input-muting hook; every other member is passed through untouched.
 */
export interface TapHooksView {
  onHidIn?(frame: unknown, device: unknown): unknown;
  [key: string]: unknown;
}

export interface TapLike {
  readonly status?: TapStatusView;
  on(event: 'status', listener: (status: TapStatusView) => void): unknown;
  on(event: 'frame', listener: (frame: TapFrameView) => void): unknown;
  connectKeyboard(): Promise<unknown>;
  connectScreen(): Promise<unknown>;
  disconnect(): Promise<void>;
  stop(): Promise<void> | void;
  /**
   * Optional actual-SDK extra (`ZetsuTap.setHooks`). Used to mute page-visible
   * replies while a backup/restore transfer runs; remove this if the contract
   * drops it.
   */
  setHooks?(hooks: TapHooksView): void;
  /**
   * Optional actual-SDK extra (`ZetsuTap.refreshFingerprint`). Used after page
   * load because the driver's asset links are not always parsed at
   * `document-start`; remove this if the contract drops it.
   */
  refreshFingerprint?(): Promise<unknown>;
}

export interface SdkAvailability {
  hasTap: boolean;
  summary: string;
}

export class SdkApiMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SdkApiMismatchError';
  }
}

const REQUIRED_TAP_METHODS = [
  'on',
  'connectKeyboard',
  'connectScreen',
  'disconnect',
  'stop',
] as const;

const SDK_NAME = '@bookqaq/zmeow-sdk';

export function inspectSdk(): SdkAvailability {
  const hasTap = typeof (ZetsuTap as unknown as { install?: unknown }).install === 'function';
  return {
    hasTap,
    summary: hasTap
      ? 'ZetsuTap available'
      : `ZetsuTap missing in ${SDK_NAME} (rebuild the SDK)`,
  };
}

/**
 * Resolve the HOST page's realm for the tap.
 *
 * Under Tampermonkey's `@sandbox JavaScript` the bundle runs in the manager's
 * isolated world, whose own `HIDDevice` / `SerialPort` / `navigator` bindings
 * are NOT the ones the driver page uses — the page's globals are only reachable
 * through `unsafeWindow`, so the SDK's `environment` injection anchors every
 * tap patch to the page realm. Without a manager (tests, the simulator page, a
 * page-main-world injection) `globalThis` already is the page window and no
 * injection is needed.
 *
 * Every value is cast through `unknown`: the page realm's objects are
 * structurally identical, but they belong to another JS world.
 */
function resolvePageEnvironment(): TapEnvironment | undefined {
  if (typeof unsafeWindow === 'undefined' || unsafeWindow === null) return undefined;
  const pageWindow: Record<string, unknown> = unsafeWindow;
  const pageNavigator = pageWindow['navigator'] as
    | { hid?: unknown; serial?: unknown }
    | undefined;
  return {
    hid: (pageNavigator?.hid ?? null) as unknown as TapEnvironment['hid'],
    serial: (pageNavigator?.serial ?? null) as unknown as TapEnvironment['serial'],
    hidDevice: (pageWindow['HIDDevice'] ?? null) as unknown as TapEnvironment['hidDevice'],
    serialPort: (pageWindow['SerialPort'] ?? null) as unknown as TapEnvironment['serialPort'],
    window: pageWindow,
  };
}

export async function installTap(): Promise<TapLike> {
  if (!inspectSdk().hasTap) {
    throw new SdkApiMismatchError(
      `${SDK_NAME} does not export ZetsuTap.install(). Rebuild the SDK package after the tap API lands in src/index.ts.`,
    );
  }

  const environment = resolvePageEnvironment();
  const tap: unknown = await ZetsuTap.install({
    product: ZETSU63_PRODUCT,
    ...(environment === undefined ? {} : { environment }),
  });
  const record = asRecord(tap);
  const missing =
    record === null
      ? [...REQUIRED_TAP_METHODS]
      : REQUIRED_TAP_METHODS.filter((method) => typeof record[method] !== 'function');

  if (record === null || missing.length > 0) {
    throw new SdkApiMismatchError(
      `ZetsuTap.install() returned an incompatible tap object (missing methods: ${
        missing.length > 0 ? missing.join(', ') : 'object'
      }).`,
    );
  }

  return tap as TapLike;
}

/**
 * Human-readable fingerprint row.
 *
 * Handles the current `TapFingerprint` object (firmware + short asset hashes),
 * a plain string fingerprint, and an absent/unchecked fingerprint.
 */
export function statusFingerprint(status: TapStatusView | null | undefined): string {
  if (!status) return '—';

  const raw = status.fingerprint;
  if (typeof raw === 'string') return raw;

  const fingerprint = asRecord(raw);
  if (fingerprint !== null) {
    const parts: string[] = [];

    const firmware = fingerprint['firmwareVersion'];
    if (typeof firmware === 'string' && firmware.length > 0) parts.push(`fw ${firmware}`);

    const hashLabels: ReadonlyArray<readonly [string, string]> = [
      ['idx', 'indexHash'],
      ['hid', 'hidHash'],
      ['scr', 'screenHash'],
    ];
    for (const [label, key] of hashLabels) {
      const value = fingerprint[key];
      if (typeof value === 'string' && value.length > 0) parts.push(`${label} ${value.slice(0, 8)}`);
    }

    if (parts.length > 0) return parts.join(' · ');
    if (fingerprint['checked'] === false) return 'not checked';
    if (fingerprint['productOk'] === false) return 'product mismatch';
    if (fingerprint['protocolOk'] === false) return 'protocol mismatch';
    return 'unavailable';
  }

  return '—';
}

/** Reasons reported by the SDK for the current state, capped for the panel. */
export function statusReasons(status: TapStatusView | null | undefined): string[] {
  const reasons = status?.reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 4);
}

/**
 * Mute (or unmute) page-visible HID replies while a config transfer runs.
 *
 * The SDK tap feeds the active client's transport from the raw input report
 * *before* the `onHidIn` hook decides, so a hook returning `null` hides the
 * replies from the page's own `oninputreport` handler (and its global frame
 * dispatchers) without starving the backup/restore client sharing the handle.
 * Outgoing frames are untouched: muting `onHidOut` would also drop the active
 * client's own writes.
 *
 * Returns false when the tap does not expose `setHooks` (older SDK builds) or
 * the call throws — callers should log that the page will observe the transfer.
 */
export function setPageInputMuted(tap: TapLike, muted: boolean): boolean {
  const setHooks = tap.setHooks;
  if (typeof setHooks !== 'function') return false;
  try {
    setHooks.call(tap, { onHidIn: muted ? () => null : undefined });
    return true;
  } catch {
    return false;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message.length > 0 && cause.message !== error.message) {
      return `${error.name}: ${error.message} (cause: ${cause.message})`;
    }
    return error.message.length > 0 ? `${error.name}: ${error.message}` : error.name;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}


export interface BackupResult {
  readonly json: string;
  readonly config: KeyboardConfig;
}

function asConfigKeyboard(value: unknown): ConfigKeyboard {
  const record = asRecord(value);
  if (record === null) {
    throw new SdkApiMismatchError('The active keyboard handle is not available.');
  }
  return record as unknown as ConfigKeyboard;
}

/** Capture the active keyboard's current settings as a JSON backup. */
export async function captureBackup(tap: TapLike): Promise<BackupResult> {
  const keyboard = asConfigKeyboard(await tap.connectKeyboard());
  const config = await captureKeyboardConfig(keyboard);
  return { json: stringifyKeyboardConfig(config), config };
}

/**
 * Parse and validate a backup JSON document without touching a device.
 *
 * The "load file" half of the restore flow calls this so an invalid document is
 * rejected before the user can trigger a device write.
 */
export function parseBackupText(text: string): KeyboardConfig {
  return parseKeyboardConfig(text);
}

/** Layout mismatch details handed to the restore consent dialog. */
export interface LayoutMismatchInfo {
  readonly backupLayout: 'compact65' | 'extended79';
  readonly deviceLayout: 'compact65' | 'extended79';
  /** Keys present in both layouts — these are restored. */
  readonly sharedKeys: number;
  /** Backup keys the active layout does not know — these are skipped. */
  readonly skippedKeys: number;
}

export interface RestoreBackupOptions {
  /**
   * Called after connecting, when the backup's layout differs from the
   * device's — before anything is written. Resolve `true` to restore the
   * overlapping keys (`allowLayoutMismatch`), `false` to abort with
   * `USER_CANCELLED`. When omitted, the SDK's documented `ValidationError`
   * is thrown unchanged.
   */
  readonly onLayoutMismatch?: (info: LayoutMismatchInfo) => Promise<boolean> | boolean;
  /**
   * Extra options passed through to the SDK's `restoreKeyboardConfig` on both
   * restore paths (e.g. `clearExtraFeatures: false` to keep the restore a patch).
   */
  readonly restoreOptions?: RestoreConfigOptions;
}

/** Whether the error is the userscript's own "user declined" abort. */
export function isUserCancelled(error: unknown): boolean {
  return error instanceof ZmeowError && error.code === 'USER_CANCELLED';
}

/** Restore a backup JSON document onto the active keyboard. */
export async function restoreBackup(
  tap: TapLike,
  json: string,
  options: RestoreBackupOptions = {},
): Promise<RestoreConfigResult> {
  const keyboard = asConfigKeyboard(await tap.connectKeyboard());
  const config = parseKeyboardConfig(json);
  const backupLayout = config.layout;
  const deviceLayout = keyboard.layout?.mode;
  if (
    options.onLayoutMismatch !== undefined &&
    (backupLayout === 'compact65' || backupLayout === 'extended79') &&
    (deviceLayout === 'compact65' || deviceLayout === 'extended79') &&
    backupLayout !== deviceLayout
  ) {
    const agreed = await options.onLayoutMismatch(layoutMismatchInfo(backupLayout, deviceLayout));
    if (!agreed) {
      throw new ZmeowError('USER_CANCELLED', 'Layout-mismatch restore cancelled by the user.');
    }
    // The SDK filters every write against the active layout and records the
    // skipped keys in `warnings`, so the overlapping keys restore cleanly.
    return restoreKeyboardConfig(keyboard, config, {
      allowLayoutMismatch: true,
      ...options.restoreOptions,
    });
  }
  return restoreKeyboardConfig(keyboard, config, options.restoreOptions ?? {});
}

/** Overlap between two layouts of the generated product data. */
function layoutMismatchInfo(
  backupLayout: 'compact65' | 'extended79',
  deviceLayout: 'compact65' | 'extended79',
): LayoutMismatchInfo {
  // Single source of truth for the overlap count is the SDK's neutral
  // `layoutOverlapInfo` — the config restore and the Wooting import feed the
  // same counts into the same consent dialog.
  const overlap = layoutOverlapInfo(backupLayout, deviceLayout);
  return {
    backupLayout: overlap.sourceLayout,
    deviceLayout: overlap.targetLayout,
    sharedKeys: overlap.sharedKeys,
    skippedKeys: overlap.skippedKeys,
  };
}

/** A fetched Wootility share profile plus its device-independent summary. */
export interface WootingFetchResult {
  readonly profile: WootingProfile;
  readonly summary: WootingProfileSummary;
}

/** The subset of GM_xmlhttpRequest's callback-style API the share fetch needs. */
type GmRequest = (details: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  onload?: (response: { status: number; responseText: string }) => void;
  onerror?: (response: { error?: string; status?: number }) => void;
  ontimeout?: () => void;
}) => unknown;

const SHARE_REQUEST_TIMEOUT_MS = 15000;

/**
 * Resolve the manager's request function. `GM_xmlhttpRequest` is the classic
 * global; `GM.xmlHttpRequest` is the Promise variant managers may expose
 * instead — wrapped back into the callback shape so callers see one API.
 */
function resolveGmRequest(): GmRequest | null {
  if (typeof GM_xmlhttpRequest !== 'undefined' && typeof GM_xmlhttpRequest === 'function') {
    return GM_xmlhttpRequest;
  }
  if (
    typeof GM !== 'undefined' &&
    GM !== null &&
    typeof GM.xmlHttpRequest === 'function'
  ) {
    const promiseVersion = GM.xmlHttpRequest;
    return (details) => {
      void promiseVersion(details)
        .then((response) => {
          details.onload?.({ status: response.status, responseText: response.responseText });
        })
        .catch((error: unknown) => {
          details.onerror?.({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return undefined;
    };
  }
  return null;
}

/**
 * Adapt the GM request to a `fetch`-like function so all HTTP status mapping
 * and parse errors stay inside `fetchWootingShare`: a GM-level failure surfaces
 * as `TypeError` (mapped to TRANSPORT), any completed HTTP status keeps its
 * meaning. The request is dispatched from the manager's background context —
 * page CORS does not apply, and the pinned `origin: https://wootility.io`
 * header mirrors the official Wootility request (`api.wooting.io` only echoes
 * `access-control-allow-origin` for that origin).
 */
function gmRequestToFetch(gm: GmRequest, code: string): typeof fetch {
  return async () => {
    const result = await new Promise<{ status: number; text: string }>((resolve) => {
      let settled = false;
      const finish = (outcome: { status: number; text: string }): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      gm({
        method: 'GET',
        url: `${WOOTING_SHARE_ENDPOINT}?code=${encodeURIComponent(code)}`,
        headers: { accept: 'application/json', origin: 'https://wootility.io' },
        timeout: SHARE_REQUEST_TIMEOUT_MS,
        onload: (response) => finish({ status: response.status, text: response.responseText }),
        onerror: (response) =>
          finish({ status: 0, text: response.error ?? 'GM_xmlhttpRequest network error' }),
        ontimeout: () =>
          finish({
            status: 0,
            text: `GM_xmlhttpRequest timed out after ${SHARE_REQUEST_TIMEOUT_MS} ms`,
          }),
      });
    });
    if (result.status === 0) {
      throw new TypeError(result.text || 'Wooting share request failed');
    }
    return new Response(result.text, {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/**
 * Fetch a Wootility share profile and summarize it — no device involved.
 *
 * Prefers `GM_xmlhttpRequest` (the script carries the grants itself, so no
 * companion script is needed); without a manager it falls back to plain
 * `fetch`, which still works from Node / same-origin hosts but is CORS-blocked
 * on the driver page. Summarizing here (instead of after the transfer starts)
 * means an unsupported model surfaces as `UnsupportedError` before the caller
 * enters a protected transfer, so the failure never flips the driver page into
 * its safe view.
 */
export async function fetchWootingProfile(code: string): Promise<WootingFetchResult> {
  const gm = resolveGmRequest();
  const profile = await fetchWootingShare(
    code,
    gm === null ? undefined : { fetch: gmRequestToFetch(gm, code) },
  );
  return { profile, summary: summarizeWootingProfile(profile) };
}

/**
 * Parse and summarize a Wooting profile document without touching a device.
 *
 * The "load file" half of the Wooting import flow calls this so a malformed
 * document or an unsupported model is rejected before the user can trigger a
 * device write — the same pre-flight the share-code path gets from
 * {@link fetchWootingProfile}.
 */
export function parseWootingProfileText(text: string): WootingFetchResult {
  const profile = parseWootingShare(text);
  return { profile, summary: summarizeWootingProfile(profile) };
}

/** A Wooting profile converted into a ready-to-restore backup document. */
export interface WootingBackupResult {
  readonly json: string;
  readonly config: KeyboardConfig;
  /**
   * Restore options matching what the profile actually carries: a profile
   * without static per-key colours must not rewrite the device lighting, and
   * a profile without advanced keys must not enter the feature phase.
   */
  readonly restoreOptions: RestoreConfigOptions;
}

/**
 * Convert a Wootility share profile into the SDK's backup format — no device
 * involved. The conversion always targets the profile's native layout; the
 * restore path handles a layout mismatch (with the consent dialog) and every
 * actual device write.
 */
export function wootingToBackup(
  input: string | WootingProfile,
  options: WootingImportOptions = {},
): WootingBackupResult {
  const config = wootingProfileToConfig(input, options);
  return {
    json: stringifyKeyboardConfig(config),
    config,
    restoreOptions: wootingRestoreOptions(config),
  };
}

/** Why a Wooting import failed, for the panel's classified error message. */
export type WootingImportErrorKind = 'network' | 'code' | 'model' | 'schema';

/**
 * Classify an import-pipeline failure: `fetchWootingShare` maps network
 * failures / HTTP 5xx (and rate limits) to `TRANSPORT`, an empty code / HTTP 4xx
 * / an unparseable body to `VALIDATION`, the summarizer maps unknown devices to
 * `UNSUPPORTED`, and a newer profile schema to `schema`. Anything else (device
 * errors etc.) is not one of these.
 */
export function wootingImportErrorKind(error: unknown): WootingImportErrorKind | null {
  if (error instanceof WootingProfileVersionError) return 'schema';
  if (!(error instanceof ZmeowError)) return null;
  if (error.code === 'TRANSPORT') return 'network';
  if (error.code === 'VALIDATION') return 'code';
  if (error.code === 'UNSUPPORTED') return 'model';
  return null;
}
