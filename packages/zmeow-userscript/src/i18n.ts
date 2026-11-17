/**
 * Panel i18n: locale resolution, persistence and the zh-CN / en dictionary.
 *
 * The userscript runs with the GM grants declared in `build.mjs` and
 * `@sandbox JavaScript`: tap patches are anchored to the host page realm via
 * `unsafeWindow`, while `localStorage` is still the official driver page's
 * storage. Every key therefore carries the `zmeow-tap.` prefix to stay
 * independent of whatever the host page stores.
 *
 * Locale rules (per product decision):
 *   1. A previously stored choice always wins (manual switch or first-run pick).
 *   2. On first run the locale is `en` only when `navigator.languages` prefers
 *      English before any Chinese tag; anything else defaults to `zh-CN`.
 *   3. The first decision is persisted immediately so later runs stay stable.
 */

export type Locale = 'zh-CN' | 'en';

const LOCALES: readonly Locale[] = ['zh-CN', 'en'];
export const LOCALE_STORAGE_KEY = 'zmeow-tap.locale';

const zhCN = {
  // Head & tabs
  panelTitle: 'Better ZetsuMeow Driver',
  panelAria: 'Better ZetsuMeow Driver',
  tabMain: '主面板',
  tabSettings: '设置',
  collapsePanel: '收起面板',
  expandPanel: '展开面板',

  // Info grid
  dtState: '状态',
  dtFingerprint: '指纹',
  dtFrames: '帧数',
  dtSdk: 'SDK',

  // Phase badge
  phaseInstalling: '启动中',
  phaseReady: '运行中',
  phaseError: '错误',

  // Connection states. `readonly` is surfaced as the tap-proxy mode wording;
  // the raw state id never reaches the user.
  stateIdle: '未连接（等待设备）',
  stateActive: '已连接',
  stateReadonly: '通过 tap 代理连接',
  stateDisabled: '已禁用',
  stateUnknown: '未知',

  // Actions (shared by buttons and log labels)
  actionKeyboard: '连接键盘',
  actionScreen: '连接屏幕',
  actionDisconnect: '断开连接',
  actionBackup: '备份',
  actionRestore: '还原',
  actionWooting: '导入 Wooting 配置',
  actionWootingFile: '从文件导入…',
  btnWootingImport: '导入',
  wootingCodePlaceholder: 'Wooting 分享码',
  btnDownload: '下载备份',
  btnLoadRestore: '载入还原文件',
  titleDownload: '下载已捕获的备份 JSON',
  titleRestore: '将已载入的备份写回设备',

  // Groups
  groupBackup: '备份',
  groupRestore: '还原',
  groupWooting: 'Wooting 导入',

  // Settings
  settingLanguage: '语言',
  settingHint: '语言在首次运行时按浏览器语言自动选择；在此手动切换会立即生效并保存。',

  // Misc UI
  busyInProgress: '正在{label}…',
  transferInProgress: '正在{label}，请勿关闭页面…',
  busyFetchingWooting: '正在获取并转换 Wooting 配置…',
  logEmpty: '暂无事件',
  loadedOk: '已载入 {name}',
  loadValidated: '解析与校验通过',
  loadedFailed: '载入失败：{name}',

  // Config summary
  configSummary: '{layers} 个重映射层、{colors} 个键色、{travel} 个行程键、{features} 项特性',

  // SDK availability
  sdkAvailable: 'ZetsuTap 可用',
  sdkMissing: 'SDK 中缺少 ZetsuTap（请重新构建 SDK）',

  // Logs
  logStatus: '状态：{state}',
  logReasons: '原因：{reasons}',
  logTapNotReady: '{action}：tap API 尚未就绪',
  logBusy: '{action}：忙碌中（{busy}）',
  logRequesting: '{action}：请求中…',
  logOk: '{action}：完成{result}',
  logFailed: '{action}：失败 — {error}',
  logBackupReady: '备份完成：{summary} — 点击“下载备份”保存 JSON',
  logNoBackup: '内存中没有备份 — 请先执行“备份”',
  logDownloaded: '备份 JSON 已保存',
  logLoadedReady: '已载入 {name} — {summary} — 可以还原',
  logLoadFailed: '载入 {name} 失败：{error}',
  logNoRestore: '尚未载入还原文件 — 请先“载入还原文件”',
  logRestoreDone: '还原完成：重映射 {remap}、键色 {colors}、行程 {travel}、特性 {features}（已清除 {cleared}）',
  logWarnings: '警告：{warnings}',
  logWootingCodeEmpty: '请先输入 Wooting 分享码',
  logWootingFetched: '已获取 Wooting 配置 {model}：{name}，开始写入',
  logWootingConverted: 'Wooting 配置已转换为备份文档：{summary}，开始还原',
  logWootingRestored: 'Wooting 配置还原完成：重映射 {remap}、键色 {colors}、行程 {travel}',
  logWootingBackupDownloaded: '已开始下载转换后的备份 JSON（调试）',
  logWootingNetworkFailed:
    '无法获取分享配置：{error}。可能是网络不通，或当前页面被浏览器 CORS 拦截（仅 wootility.io 页面可直连该接口）；可改用「从文件导入」。',
  logWootingCodeInvalid: '分享码无效或配置不存在：{error}',
  logWootingModelUnsupported: '该 Wooting 型号不支持导入：{error}',
  logWootingSchemaTooNew: '该 Wooting 配置版本过新，请更新扩展后再导入：{error}',
  logWootingWarnings: 'Wooting 配置转换提示：{warnings}',
  logSdk: 'SDK：{summary}',
  logFingerprintRefreshed: '指纹已刷新',
  logFingerprintFailed: '指纹刷新失败：{error}',
  logTapInstalled: 'tap 已安装（状态：{state}）',
  logInstallFailed: '安装失败：{error}',

  // Config-transfer protection (safe view + page-input muting + page reload)
  logSafeViewEnter: '已把官方页切换到安全视图（设置页），开始 {action}',
  logSafeViewSkip: '未找到可用的官方页路由（{reason}），跳过安全视图切换',
  logSafeViewReturn: '已返回官方页原视图',
  logSafeViewReturnFailed: '返回官方页原视图失败：{error}',
  logPageMuted: '已隔离官方页收包：本次传输的回包不会进入官方页面',
  logPageUnmuted: '官方页收包已恢复',
  logMuteUnsupported: '当前 tap 不支持收包隔离，官方页面会看到本次传输的回包',
  logReloadAsk: '官方页面缓存已过期，等待确认是否刷新页面',
  logReloadCancelled: '已取消刷新页面；官方页面数据可能不是最新，建议稍后手动刷新',
  logReloadSkipped: '未检测到官方驱动应用，跳过刷新页面提示；建议手动刷新页面同步数据',

  // Post-transfer reload confirmation (dialog)
  reloadDialogTitle: '刷新页面',
  reloadDialogBody:
    '还原/导入已改动设备配置，官方页面的缓存数据已过期。刷新页面后需要重新选择设备；取消、关闭或按 Esc 都不会刷新页面。',
  reloadDialogLater: '取消',
  reloadDialogNow: '立即刷新',
  reloadDialogClose: '关闭',

  // Release-mode one-step flows / restore dialog
  restoreDialogTitle: '还原设备配置',
  dialogHint: '选择备份 JSON 文件并确认后，会立即写入设备',
  dialogCancel: '取消',
  dialogConfirm: '确认还原',
  logBackupDownloaded: '备份完成，已开始下载 JSON（{summary}）',

  // Layout-mismatch consent dialog (shared by debug and release builds)
  mismatchTitle: '布局不一致',
  mismatchBody:
    '备份文件使用 {backup} 布局，当前键盘是 {device} 布局。点击「同意还原」只写入两者重叠的 {shared} 个按键，其余 {skipped} 个按键的设置将被跳过。',
  mismatchBodySubset:
    '备份文件使用 {backup} 布局，当前键盘是 {device} 布局。备份中的 {shared} 个按键在当前键盘上都存在，点击「同意还原」即可还原。',
  mismatchConfirm: '同意还原',
  // Wooting import reuses the same dialog with profile-worded copy.
  wootingMismatchBody:
    'Wooting 配置使用 {backup} 布局，当前键盘是 {device} 布局。点击「同意导入」只写入两者重叠的 {shared} 个按键，其余 {skipped} 个按键的设置将被跳过。',
  wootingMismatchBodySubset:
    'Wooting 配置使用 {backup} 布局，当前键盘是 {device} 布局。配置中的 {shared} 个按键在当前键盘上都存在，点击「同意导入」即可导入。',
  wootingMismatchConfirm: '同意导入',
  logMismatchAsk: '布局不一致：备份 {backup} → 设备 {device}，等待确认',
  logMismatchAgreed: '已同意布局不一致还原：写入重叠按键，其余跳过',
  logCancelled: '{action}：已取消',

  logLocaleSwitched: '语言已切换为 {locale}',
} as const;

export type MessageKey = keyof typeof zhCN;

/** English mirror; `Record<MessageKey, string>` makes a missing key a type error. */
const en: Record<MessageKey, string> = {
  panelTitle: 'Better ZetsuMeow Driver',
  panelAria: 'Better ZetsuMeow Driver panel',
  tabMain: 'Main',
  tabSettings: 'Settings',
  collapsePanel: 'Collapse panel',
  expandPanel: 'Expand panel',

  dtState: 'State',
  dtFingerprint: 'Fingerprint',
  dtFrames: 'Frames',
  dtSdk: 'SDK',

  phaseInstalling: 'starting',
  phaseReady: 'ready',
  phaseError: 'error',

  stateIdle: 'Idle — waiting for device',
  stateActive: 'Connected',
  stateReadonly: 'Connected via tap proxy',
  stateDisabled: 'Disabled',
  stateUnknown: 'Unknown',

  actionKeyboard: 'Connect keyboard',
  actionScreen: 'Connect screen',
  actionDisconnect: 'Disconnect',
  actionBackup: 'Backup',
  actionRestore: 'Restore',
  actionWooting: 'Import Wooting profile',
  actionWootingFile: 'Import from file…',
  btnWootingImport: 'Import',
  wootingCodePlaceholder: 'Wooting share code',
  btnDownload: 'Download',
  btnLoadRestore: 'Load restore file',
  titleDownload: 'Download the captured backup JSON',
  titleRestore: 'Apply the loaded backup to the device',

  groupBackup: 'Backup',
  groupRestore: 'Restore',
  groupWooting: 'Wooting import',

  settingLanguage: 'Language',
  settingHint:
    'The language is picked automatically from your browser languages on first run; switching here takes effect immediately and is saved.',

  busyInProgress: '{label} in progress…',
  transferInProgress: '{label} in progress — do not close this page…',
  busyFetchingWooting: 'Fetching and converting the Wooting profile…',
  logEmpty: 'no events yet',
  loadedOk: 'Loaded {name}',
  loadValidated: 'parsed & validated',
  loadedFailed: 'Failed to load {name}',

  configSummary: '{layers} remap layer(s), {colors} colours, {travel} travel keys, {features} features',

  sdkAvailable: 'ZetsuTap available',
  sdkMissing: 'ZetsuTap missing in the SDK (rebuild the SDK)',

  logStatus: 'status: {state}',
  logReasons: 'reasons: {reasons}',
  logTapNotReady: '{action}: tap API is not ready',
  logBusy: '{action}: busy ({busy})',
  logRequesting: '{action}: requesting…',
  logOk: '{action}: ok{result}',
  logFailed: '{action}: failed — {error}',
  logBackupReady: 'backup captured: {summary} — use “Download” to save the JSON',
  logNoBackup: 'no backup in memory — run Backup first',
  logDownloaded: 'backup JSON saved',
  logLoadedReady: 'loaded {name} — {summary} — ready to restore',
  logLoadFailed: 'load {name} failed: {error}',
  logNoRestore: 'no backup loaded — use “Load restore file” first',
  logRestoreDone: 'restore done: remap {remap}, colours {colors}, travel {travel}, features {features} (+{cleared} cleared)',
  logWarnings: 'warnings: {warnings}',
  logWootingCodeEmpty: 'Enter a Wooting share code first',
  logWootingFetched: 'Fetched Wooting {model}: {name}; writing…',
  logWootingConverted: 'Wooting profile converted to a backup document: {summary}; restoring…',
  logWootingRestored: 'Wooting profile restored: remap {remap}, colours {colors}, travel {travel}',
  logWootingBackupDownloaded: 'Converted backup JSON download started (debug)',
  logWootingNetworkFailed:
    'Could not fetch the shared profile: {error}. The network may be down, or the browser blocked the request by CORS (only the wootility.io page can call the endpoint directly); use "Import from file" instead.',
  logWootingCodeInvalid: 'Invalid share code or profile not found: {error}',
  logWootingModelUnsupported: 'This Wooting model is not supported for import: {error}',
  logWootingSchemaTooNew: 'This Wooting profile schema is newer than the extension supports; update the extension first: {error}',
  logWootingWarnings: 'Wooting conversion notes: {warnings}',
  logSdk: 'SDK: {summary}',
  logFingerprintRefreshed: 'fingerprint refreshed',
  logFingerprintFailed: 'fingerprint refresh failed: {error}',
  logTapInstalled: 'tap installed (state: {state})',
  logInstallFailed: 'install failed: {error}',

  logSafeViewEnter: 'Driver page moved to the safe view (settings) before {action}',
  logSafeViewSkip: 'Driver page router not available ({reason}); safe-view switch skipped',
  logSafeViewReturn: 'Driver page returned to its original view',
  logSafeViewReturnFailed: 'Failed to return the driver page to its original view: {error}',
  logPageMuted: 'Driver page replies muted: this transfer will not be visible to the page',
  logPageUnmuted: 'Driver page replies restored',
  logMuteUnsupported: 'The current tap cannot mute replies; the driver page will observe this transfer',
  logReloadAsk: 'Driver page cache is stale; waiting for reload confirmation',
  logReloadCancelled: 'Reload cancelled; the driver page data may be out of date — refresh it manually later',
  logReloadSkipped: 'Official driver app not detected; reload prompt skipped — refresh the page manually to resync',

  reloadDialogTitle: 'Reload page',
  reloadDialogBody:
    'The restore/import changed the device config and the driver page cache is stale. Reloading requires reselecting the device; cancel, close or pressing Esc keeps the current page.',
  reloadDialogLater: 'Cancel',
  reloadDialogNow: 'Reload now',
  reloadDialogClose: 'Close',

  restoreDialogTitle: 'Restore device config',
  dialogHint: 'Pick a backup JSON file and confirm to write it to the device',
  dialogCancel: 'Cancel',
  dialogConfirm: 'Restore now',
  logBackupDownloaded: 'Backup captured; JSON download started ({summary})',

  mismatchTitle: 'Layout mismatch',
  mismatchBody:
    'The backup was captured on {backup}, but this keyboard reports {device}. Agreeing writes only the {shared} overlapping keys; settings for the other {skipped} keys will be skipped.',
  mismatchBodySubset:
    'The backup was captured on {backup}, but this keyboard reports {device}. All {shared} backed-up keys exist on this keyboard; agree to restore them.',
  mismatchConfirm: 'Agree & restore',
  // Wooting import reuses the same dialog with profile-worded copy.
  wootingMismatchBody:
    'The Wooting profile uses the {backup} layout, but this keyboard reports {device}. Agreeing writes only the {shared} overlapping keys; settings for the other {skipped} keys will be skipped.',
  wootingMismatchBodySubset:
    'The Wooting profile uses the {backup} layout, but this keyboard reports {device}. All {shared} keys of the profile exist on this keyboard; agree to import them.',
  wootingMismatchConfirm: 'Agree & import',
  logMismatchAsk: 'layout mismatch: backup {backup} → device {device}; waiting for confirmation',
  logMismatchAgreed: 'layout-mismatch restore agreed: overlapping keys will be written, the rest skipped',
  logCancelled: '{action}: cancelled',

  logLocaleSwitched: 'Language switched to {locale}',
};

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zhCN, en };

export type MessageParams = Record<string, string | number>;

let current: Locale = 'zh-CN';
let resolved = false;
const listeners: Array<(locale: Locale) => void> = [];

/**
 * Determine the locale for this run: stored choice first, otherwise the
 * browser-language detection, whose result is persisted on first use.
 */
export function resolveInitialLocale(): Locale {
  if (resolved) return current;
  resolved = true;

  const stored = readStoredLocale();
  current = stored ?? detectLocale();
  if (stored === null) writeStoredLocale(current);
  return current;
}

export function getLocale(): Locale {
  return current;
}

/** Switch the locale, persist it and notify listeners. No-op when unchanged. */
export function setLocale(locale: Locale): void {
  if (!LOCALES.includes(locale) || locale === current) return;
  current = locale;
  writeStoredLocale(locale);
  for (const listener of [...listeners]) listener(locale);
}

export function onLocaleChange(listener: (locale: Locale) => void): void {
  listeners.push(listener);
}

/** Native name of a locale (identical in both dictionaries). */
export function localeLabel(locale: Locale): string {
  return locale === 'en' ? 'English' : '简体中文';
}

/** Look up a message in the current locale and interpolate `{name}` params. */
export function t(key: MessageKey, params?: MessageParams): string {
  const template = DICTIONARIES[current][key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

function readStoredLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return value !== null && LOCALES.includes(value as Locale) ? (value as Locale) : null;
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage unavailable (privacy mode etc.): the choice just does not persist.
  }
}

/**
 * First-run detection: walk `navigator.languages` in order and take the first
 * Chinese or English tag; English only wins when it outranks every Chinese
 * preference. Everything else falls back to the zh-CN default.
 */
function detectLocale(): Locale {
  const languages = typeof navigator !== 'undefined' ? navigator.languages : undefined;
  if (languages === undefined || languages.length === 0) return 'zh-CN';
  for (const tag of languages) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return 'zh-CN';
    if (lower.startsWith('en')) return 'en';
  }
  return 'zh-CN';
}
