/**
 * Better ZetsuMeow Driver userscript entry.
 *
 * Runs at `document-start` (see the generated metadata header), installs the tap
 * as early as possible so it can observe the driver's prototypes, then mounts a
 * small shadow-DOM panel once the body exists.
 *
 * All SDK access goes through `./sdk.ts`; this file only calls the structural
 * API and renders state. It must never patch WebHID/WebSerial itself.
 *
 * User-visible copy comes from `./i18n.ts`: internal state ids (e.g. `readonly`)
 * are mapped to localized labels — the raw id never reaches the panel.
 */

import {
  captureBackup,
  describeError,
  fetchWootingProfile,
  inspectSdk,
  installTap,
  isUserCancelled,
  parseBackupText,
  restoreBackup,
  setPageInputMuted,
  statusFingerprint,
  statusReasons,
  wootingImportErrorKind,
  wootingToBackup,
} from './sdk.ts';
import { localeLabel, onLocaleChange, resolveInitialLocale, t } from './i18n.ts';
import { enterSafeView, leaveSafeView, officialAppDetected } from './page-view.ts';
import { mountPanel } from './ui.ts';
import type { ConfigSummary, FrameCounts, Panel, PanelHandlers, PanelView } from './ui.ts';
import type { SafeViewLease } from './page-view.ts';
import type {
  KeyboardConfig,
  RestoreConfigOptions,
  RestoreConfigResult,
  TapFrameView,
  TapLike,
  TapStatusView,
} from './sdk.ts';

const VERSION = '0.2.0';
const GUARD_KEY = '__ZMEOW_TAP__';
const FRAME_LOG_EVERY = 100;
const FRAME_RENDER_MS = 250;
/**
 * Zetsu has a single Fn layer: Wooting imports bring the base layer plus the
 * first Fn layer (0/1). Layer 2 (Fn2) and any extra Wooting layers are
 * ignored (there is no UI option for this any more).
 */
const WOOTING_IMPORT_LAYERS = [0, 1] as const;

interface TapGuard {
  readonly version: string;
  readonly startedAt: number;
  tap: TapLike | null;
}

interface AppState {
  phase: 'installing' | 'ready' | 'error';
  state: string;
  fingerprint: string;
  sdkReady: boolean;
  error: string | null;
}

const page = window as unknown as Record<string, unknown>;

if (page[GUARD_KEY] !== undefined) {
  console.warn('[zmeow] Better ZetsuMeow Driver userscript is already installed; ignoring duplicate injection.');
} else {
  const guard: TapGuard = { version: VERSION, startedAt: Date.now(), tap: null };
  page[GUARD_KEY] = guard;
  void boot(guard);
}

async function boot(guard: TapGuard): Promise<void> {
  // Resolve (and on first run persist) the locale before anything renders.
  resolveInitialLocale();
  const availability = inspectSdk();
  const counts: FrameCounts = { hid: 0, serial: 0, total: 0 };
  const state: AppState = {
    phase: 'installing',
    state: 'idle',
    fingerprint: '—',
    sdkReady: availability.hasTap,
    error: null,
  };

  let panel: Panel | null = null;
  let busy: string | null = null;
  let frameRenderTimer: number | null = null;
  let framesSinceLog = 0;
  let lastLoggedState: string | null = null;
  const pendingLogs: string[] = [];
  // Captured backup / loaded restore documents for the two-step flows:
  // Backup → Download, Load restore file → Restore.
  let backupJson: string | null = null;
  let restoreJson: string | null = null;

  const log = (message: string): void => {
    if (panel !== null) panel.log(message);
    else if (pendingLogs.length < 12) pendingLogs.push(message);
  };

  const buildView = (): PanelView => ({
    phase: state.phase,
    phaseLabel: phaseLabel(state.phase),
    state: state.state,
    stateLabel: stateLabel(state.state),
    fingerprint: state.fingerprint,
    sdk: sdkSummary(state.sdkReady),
    frames: { ...counts },
    error: state.error,
  });

  const render = (): void => {
    if (panel === null) return;
    panel.update(buildView());
  };

  const scheduleFrameRender = (): void => {
    if (frameRenderTimer !== null) return;
    frameRenderTimer = window.setTimeout(() => {
      frameRenderTimer = null;
      render();
    }, FRAME_RENDER_MS);
  };

  const onStatus = (status: TapStatusView): void => {
    state.state = tapState(status);
    state.fingerprint = statusFingerprint(status);
    // The bridge re-publishes status after every frame; only log actual state
    // changes so a busy config transfer does not flood the panel log with
    // repeated "status: active" lines.
    if (state.state !== lastLoggedState) {
      lastLoggedState = state.state;
      log(t('logStatus', { state: stateLabel(state.state) }));
      const reasons = statusReasons(status);
      if (reasons.length > 0) log(t('logReasons', { reasons: reasons.join('; ') }));
    }
    render();
  };

  const onFrame = (frame: TapFrameView): void => {
    counts.total += 1;
    if (frame.kind === 'hid') counts.hid += 1;
    else if (frame.kind === 'serial') counts.serial += 1;

    framesSinceLog += 1;
    if (framesSinceLog >= FRAME_LOG_EVERY) {
      framesSinceLog = 0;
      console.info(
        `[zmeow] frames total=${counts.total} hid=${counts.hid} serial=${counts.serial}`,
      );
    }

    // The UI is throttled, the console only sees summaries: never log every frame.
    scheduleFrameRender();
  };

  /**
   * Run a panel action with the shared busy/log scaffolding.
   *
   * `protectedTransfer` marks config transfers (backup / restore / Wooting
   * import): the driver page is moved to its safe view and its input replies
   * are muted for the duration, because the page's own global reply dispatchers
   * rewrite `data.my_keyboard.product.keys` etc. from ANY incoming frame and
   * even reload themselves (window.app_reload) on stray travel frames. See
   * `afterProtectedSuccess` for the post-op page recovery.
   */
  const runAction = (
    label: string,
    opts: { readonly protectedTransfer?: boolean; readonly reloadAfter?: boolean },
    action: (tap: TapLike) => Promise<unknown>,
  ): void => {
    const tap = guard.tap;
    if (tap === null) {
      log(t('logTapNotReady', { action: label }));
      return;
    }
    if (busy !== null) {
      log(t('logBusy', { action: label, busy }));
      return;
    }

    busy = label;
    panel?.setBusy(label);
    if (opts.protectedTransfer === true) {
      panel?.setTransferHint(t('transferInProgress', { label }));
    }
    log(t('logRequesting', { action: label }));

    // Kept outside the async body so the catch below can return the page from
    // the safe view when the user cancels the action mid-transfer.
    let lease: SafeViewLease | null = null;
    let muted = false;

    void (async (): Promise<unknown> => {
      try {
        if (opts.protectedTransfer === true) {
          lease = await enterSafeView();
          log(
            lease.navigated
              ? t('logSafeViewEnter', { action: label })
              : t('logSafeViewSkip', { reason: lease.skipReason ?? 'unknown' }),
          );
          muted = setPageInputMuted(tap, true);
          log(muted ? t('logPageMuted') : t('logMuteUnsupported'));
        }
        return await action(tap);
      } finally {
        if (muted) {
          // Always unmute, even when the transfer failed.
          setPageInputMuted(tap, false);
          log(t('logPageUnmuted'));
        }
      }
    })()
      .then((result) => {
        state.phase = 'ready';
        state.state = tapState(tap.status);
        state.fingerprint = statusFingerprint(tap.status);
        state.error = null;
        log(t('logOk', { action: label, result: summarizeResult(result) }));
        if (lease !== null) afterProtectedSuccess(lease, opts.reloadAfter === true);
      })
      .catch((error: unknown) => {
        if (isUserCancelled(error)) {
          // Declined inside the action (e.g. the layout-mismatch consent
          // dialog): nothing was written, so the page's cached data is still
          // valid — return it to where it was instead of showing an error.
          log(t('logCancelled', { action: label }));
          if (lease !== null) afterProtectedSuccess(lease, false);
          return;
        }
        state.error = describeError(error);
        log(t('logFailed', { action: label, error: state.error }));
        console.error(`[zmeow] ${label} failed`, error);
        // On failure the page stays on the safe view so the user can retry or
        // navigate away with the page's own menu; muting is already cleared.
      })
      .finally(() => {
        busy = null;
        panel?.setBusy(null);
        panel?.setTransferHint(null);
        render();
      });
  };

  const runTapAction = (label: string, action: (tap: TapLike) => Promise<unknown>): void => {
    runAction(label, {}, action);
  };

  /**
   * Post-op page recovery for protected transfers.
   *
   * Backup only reads the device, so the page data stays valid — navigate back.
   * Restore/Wooting mutate the device, so the page's cached config is stale
   * afterwards; the page cannot re-read it in code (its read chain is
   * module-internal, views only render the cached `window.data` state), and
   * the page's own recovery for unexpected frames is `window.app_reload` =
   * `location.reload()`. So: ask before reloading, gated on the official app
   * actually being present (the simulator has no router). Closing the dialog
   * in any way cancels the reload — the page is left as-is.
   */
  const afterProtectedSuccess = (lease: SafeViewLease, reloadAfter: boolean): void => {
    if (reloadAfter) {
      if (!officialAppDetected(lease)) {
        log(t('logReloadSkipped'));
        return;
      }
      log(t('logReloadAsk'));
      // Defer a tick so runAction's `finally` has cleared the busy state and
      // the transfer overlay before the modal dialog opens.
      window.setTimeout(() => {
        if (panel === null) return;
        void panel.confirmReload().then((confirmed) => {
          if (confirmed) window.location.reload();
          else log(t('logReloadCancelled'));
        });
      }, 0);
      return;
    }
    if (!lease.navigated) return;
    void leaveSafeView(lease).then((result) => {
      if (result.returned) log(t('logSafeViewReturn'));
      else if (result.error !== null) log(t('logSafeViewReturnFailed', { error: result.error }));
    });
  };

  const configSummary = (config: KeyboardConfig): ConfigSummary => ({
    layers: Object.keys(config.remap.layers).length,
    colors: Object.keys(config.keyColors).length,
    travel: Object.keys(config.travel).length,
    features: config.features.length,
  });

  const formatConfigSummary = (summary: ConfigSummary): string => t('configSummary', summary);

  const logWootingConversionWarnings = (config: KeyboardConfig): void => {
    const warnings = (config.warnings ?? []).filter(
      (line) => !line.startsWith('Generated from a Wooting profile:'),
    );
    if (warnings.length > 0) {
      log(t('logWootingWarnings', { warnings: warnings.slice(0, 3).join('; ') }));
    }
  };

  /**
   * Shared Wooting write segment for the share-code and file import paths.
   *
   * The import is a two-step pipeline: the extension first converts the
   * profile into a plain `KeyboardConfig` backup document (pure, no device),
   * then this restores it through the SDK's standard backup path — one write
   * pipeline with verify, pacing and layout filtering for both real backups
   * and Wooting imports. The layout-mismatch consent dialog reuses the shared
   * restore dialog with Wooting wording. The converted document's
   * `restoreOptions` keep the import a patch: no static colours means the
   * device lighting is left untouched, no advanced keys means the feature
   * phase is skipped, and `clearExtraFeatures: false` protects unrelated
   * device features.
   */
  const restoreWootingBackupWithConsent = async (
    tap: TapLike,
    json: string,
    restoreOptions: RestoreConfigOptions,
  ): Promise<RestoreConfigResult> => {
    const result = await restoreBackup(tap, json, {
      restoreOptions,
      onLayoutMismatch: async (info) => {
        log(t('logMismatchAsk', { backup: info.backupLayout, device: info.deviceLayout }));
        if (panel === null) return false;
        const agreed = await panel.confirmLayoutMismatch(info, {
          body:
            info.skippedKeys > 0
              ? t('wootingMismatchBody', {
                  backup: info.backupLayout,
                  device: info.deviceLayout,
                  shared: info.sharedKeys,
                  skipped: info.skippedKeys,
                })
              : t('wootingMismatchBodySubset', {
                  backup: info.backupLayout,
                  device: info.deviceLayout,
                  shared: info.sharedKeys,
                }),
          confirm: t('wootingMismatchConfirm'),
        });
        if (agreed) log(t('logMismatchAgreed'));
        return agreed;
      },
    });
    log(
      t('logWootingRestored', {
        remap: result.remap?.written ?? 0,
        colors: result.colors,
        travel: result.travel,
      }),
    );
    if (result.warnings.length > 0) {
      log(t('logWarnings', { warnings: result.warnings.slice(0, 3).join('; ') }));
    }
    return result;
  };

  const handlers: PanelHandlers = {
    connectKeyboard: () => runTapAction(t('actionKeyboard'), (tap) => tap.connectKeyboard()),
    connectScreen: () => runTapAction(t('actionScreen'), (tap) => tap.connectScreen()),
    disconnect: () => runTapAction(t('actionDisconnect'), (tap) => tap.disconnect()),
    backup: () =>
      runAction(t('actionBackup'), { protectedTransfer: true }, async (tap) => {
        const result = await captureBackup(tap);
        backupJson = result.json;
        if (__ZMEOW_RELEASE__) {
          // One-step backup: the download starts as soon as the capture is in
          // memory (no separate Download step in the release UI).
          downloadJson(backupJson, `zmeow-config-${fileStamp()}.json`);
          log(
            t('logBackupDownloaded', {
              summary: formatConfigSummary(configSummary(result.config)),
            }),
          );
        } else {
          panel?.setActionEnabled('download', true);
          log(
            t('logBackupReady', { summary: formatConfigSummary(configSummary(result.config)) }),
          );
        }
        return result.config;
      }),
    downloadBackup: () => {
      if (backupJson === null) {
        log(t('logNoBackup'));
        return;
      }
      downloadJson(backupJson, `zmeow-config-${fileStamp()}.json`);
      log(t('logDownloaded'));
    },
    loadRestore: (file) => {
      // Pure front-end step: read + validate, no device access, so an invalid
      // document is rejected before any write can be triggered.
      void file
        .text()
        .then((text) => {
          const config = parseBackupText(text);
          const summary = configSummary(config);
          restoreJson = text;
          panel?.setActionEnabled('restore', true);
          panel?.setLoadedFile({ name: file.name, ok: true, summary });
          log(
            t('logLoadedReady', { name: file.name, summary: formatConfigSummary(summary) }),
          );
        })
        .catch((error: unknown) => {
          state.error = describeError(error);
          panel?.setLoadedFile({ name: file.name, ok: false, error: state.error });
          log(t('logLoadFailed', { name: file.name, error: state.error }));
          console.error('[zmeow] load restore file failed', error);
        });
    },
    restore: () => {
      if (restoreJson === null) {
        log(t('logNoRestore'));
        return;
      }
      const json = restoreJson;
      runAction(t('actionRestore'), { protectedTransfer: true, reloadAfter: true }, async (tap) => {
        const result = await restoreBackup(tap, json, {
          onLayoutMismatch: async (info) => {
            log(t('logMismatchAsk', { backup: info.backupLayout, device: info.deviceLayout }));
            if (panel === null) return false;
            const agreed = await panel.confirmLayoutMismatch(info);
            if (agreed) log(t('logMismatchAgreed'));
            return agreed;
          },
        });
        log(
          t('logRestoreDone', {
            remap: result.remap?.written ?? 0,
            colors: result.colors,
            travel: result.travel,
            features: result.features.written,
            cleared: result.features.cleared,
          }),
        );
        if (result.warnings.length > 0) {
          log(t('logWarnings', { warnings: result.warnings.slice(0, 3).join('; ') }));
        }
        return result;
      });
    },
    importWooting: (code) => {
      const trimmed = code.trim();
      if (trimmed.length === 0) {
        log(t('logWootingCodeEmpty'));
        return;
      }
      // The fetch runs outside runAction (loadRestore's shape): no device is
      // involved, so a failed fetch must not flip the driver page into its
      // safe view. The protected transfer only starts once the profile is in
      // memory and its model is known to be supported.
      panel?.setTransferHint(t('busyFetchingWooting'));
      void fetchWootingProfile(trimmed)
        .then(({ profile, summary }) => {
          panel?.setTransferHint(null);
          log(t('logWootingFetched', { model: summary.modelTitle, name: summary.name }));
          const backup = wootingToBackup(profile, { layers: WOOTING_IMPORT_LAYERS });
          log(
            t('logWootingConverted', {
              summary: formatConfigSummary(configSummary(backup.config)),
            }),
          );
          logWootingConversionWarnings(backup.config);
          if (!__ZMEOW_RELEASE__) {
            downloadJson(backup.json, `wooting-import-${fileStamp()}.json`);
            log(t('logWootingBackupDownloaded'));
          }
          runAction(t('actionWooting'), { protectedTransfer: true, reloadAfter: true }, (tap) =>
            restoreWootingBackupWithConsent(tap, backup.json, backup.restoreOptions),
          );
        })
        .catch((error: unknown) => {
          panel?.setTransferHint(null);
          state.error = describeError(error);
          render();
          const kind = wootingImportErrorKind(error);
          log(
            t(
              kind === 'network'
                ? 'logWootingNetworkFailed'
                : kind === 'schema'
                  ? 'logWootingSchemaTooNew'
                  : kind === 'model'
                    ? 'logWootingModelUnsupported'
                    : 'logWootingCodeInvalid',
              { error: state.error },
            ),
          );
          console.error('[zmeow] wooting share import failed', error);
        });
    },
  };

  const mount = (): void => {
    if (panel !== null) return;
    panel = mountPanel(handlers, buildView());
    for (const line of pendingLogs.splice(0)) panel.log(line);
    render();
  };

  if (document.body !== null) mount();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else window.setTimeout(mount, 0);

  // The panel re-applies its own static labels on locale changes; here we
  // refresh the localized dynamic fields and note the switch in the log.
  onLocaleChange((locale) => {
    log(t('logLocaleSwitched', { locale: localeLabel(locale) }));
    render();
  });

  log(t('logSdk', { summary: sdkSummary(availability.hasTap) }));

  try {
    const tap = await installTap();
    guard.tap = tap;
    state.phase = 'ready';
    state.state = tapState(tap.status);
    state.fingerprint = statusFingerprint(tap.status);
    state.error = null;

    tap.on('status', onStatus);
    tap.on('frame', onFrame);

    // At document-start the driver's modulepreload links may not exist yet, so
    // the automatic fingerprint pass can end up as "not checked". Re-run it once
    // the page has loaded when the actual SDK exposes the optional helper.
    const refreshFingerprint = tap.refreshFingerprint;
    if (typeof refreshFingerprint === 'function') {
      const runRefresh = (): void => {
        try {
          void Promise.resolve(refreshFingerprint.call(tap))
            .then(() => {
              state.fingerprint = statusFingerprint(tap.status);
              log(t('logFingerprintRefreshed'));
              render();
            })
            .catch((error: unknown) => {
              log(t('logFingerprintFailed', { error: describeError(error) }));
            });
        } catch (error) {
          log(t('logFingerprintFailed', { error: describeError(error) }));
        }
      };

      if (document.readyState === 'complete') window.setTimeout(runRefresh, 0);
      else window.addEventListener('load', runRefresh, { once: true });
    }

    log(t('logTapInstalled', { state: stateLabel(state.state) }));
    render();
  } catch (error) {
    state.phase = 'error';
    state.error = describeError(error);
    log(t('logInstallFailed', { error: state.error }));
    console.error('[zmeow] install failed', error);
    render();
  }
}

function fileStamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function tapState(status: TapStatusView | null | undefined): string {
  const value = status?.state;
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

/** Localized label for a raw tap state id; `readonly` renders as tap-proxy mode. */
function stateLabel(state: string): string {
  switch (state) {
    case 'idle': return t('stateIdle');
    case 'active': return t('stateActive');
    case 'readonly': return t('stateReadonly');
    case 'disabled': return t('stateDisabled');
    case 'unknown': return t('stateUnknown');
    default: return state;
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'ready': return t('phaseReady');
    case 'error': return t('phaseError');
    default: return t('phaseInstalling');
  }
}

function sdkSummary(hasTap: boolean): string {
  return hasTap ? t('sdkAvailable') : t('sdkMissing');
}

function summarizeResult(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return ' (null)';
  if (typeof value !== 'object') return ` (${String(value)})`;

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['name', 'id', 'layout', 'product', 'model', 'mode']) {
    const entry = record[key];
    if (typeof entry === 'string' || typeof entry === 'number') parts.push(`${key}=${entry}`);
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
