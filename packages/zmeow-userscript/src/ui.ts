/**
 * Minimal shadow-DOM panel for Better ZetsuMeow Driver. No framework, no globals,
 * no SDK imports: `main.ts` owns all state and all SDK calls.
 *
 * User-facing copy comes from `./i18n.ts`: static markup carries `data-i18n`
 * attributes that are re-applied whenever the locale changes, dynamic values
 * (state/phase labels, log lines) arrive already localized from `main.ts`.
 *
 * Build modes (compile-time flag declared in src/build-mode.d.ts, folded by
 * build.mjs — the identifier never reaches a bundle):
 *   - debug: two-step backup (Backup → Download) and restore (Load restore
 *     file → Restore), connect buttons visible.
 *   - release: one-step backup (download starts right after capture), restore
 *     behind a pick + confirm dialog (cancel never writes), connect buttons
 *     compiled out of the markup and the dispatch.
 */

import { getLocale, onLocaleChange, setLocale, t } from './i18n.ts';
import type { MessageKey } from './i18n.ts';

export interface FrameCounts {
  hid: number;
  serial: number;
  total: number;
}

export interface PanelView {
  phase: string;
  /** Localized phase text (e.g. 运行中) for the head badge. */
  phaseLabel: string;
  /** Raw tap state id (idle/active/readonly/disabled) — drives the dot style. */
  state: string;
  /** Localized state text; `readonly` renders as the tap-proxy wording. */
  stateLabel: string;
  fingerprint: string;
  sdk: string;
  frames: FrameCounts;
  error: string | null;
}

/** Numeric summary of a keyboard config, formatted through i18n. */
export type ConfigSummary = {
  layers: number;
  colors: number;
  travel: number;
  features: number;
};

/** Outcome of "Load restore file", shown on the panel until replaced/cleared. */
export interface LoadedFileInfo {
  name: string;
  ok: boolean;
  /** Numeric config summary (formatted via i18n) when `ok`. */
  summary?: ConfigSummary;
  /** Error text when `!ok`. */
  error?: string;
}

/** Layout mismatch details for the consent dialog (ui-local view type; restore and Wooting import). */
export interface MismatchInfo {
  readonly backupLayout: string;
  readonly deviceLayout: string;
  /** Keys present in both layouts — these are restored. */
  readonly sharedKeys: number;
  /** Backup keys the active layout does not know — these are skipped. */
  readonly skippedKeys: number;
}

export interface PanelHandlers {
  connectKeyboard(): void;
  connectScreen(): void;
  disconnect(): void;
  /** Capture the device config into memory (no download dialog). */
  backup(): void;
  /** Download the previously captured backup as a JSON file (debug only). */
  downloadBackup(): void;
  /** Read and validate a restore file into memory (no device writes). */
  loadRestore(file: File): void;
  /** Apply the previously loaded backup to the device. */
  restore(): void;
  /** Fetch and import a Wooting profile by its Wootility share code. */
  importWooting(code: string): void;
}

/**
 * Pre-localized override texts for the consent dialog. Restore passes nothing
 * (the dialog then renders its own i18n copy from `info`); the Wooting import
 * passes body/confirm copy worded for profiles instead of backups.
 */
export interface MismatchDialogText {
  readonly title?: string;
  readonly body: string;
  readonly confirm?: string;
}

export interface Panel {
  host: HTMLElement;
  update(view: PanelView): void;
  setBusy(label: string | null): void;
  /** Show a page-filling "transfer in progress" hint (backup/restore/import). */
  setTransferHint(text: string | null): void;
  /** Enable/disable a two-step action button (e.g. after backup/load). */
  setActionEnabled(action: 'download' | 'restore', enabled: boolean): void;
  /** Show/hide the loaded restore-file status line (panel or dialog). */
  setLoadedFile(info: LoadedFileInfo | null): void;
  /**
   * Ask the user to confirm restoring/importing across a layout mismatch.
   * Resolves `true` (write the overlapping keys) or `false` (cancel). `text`
   * replaces the default restore wording with pre-localized copy.
   */
  confirmLayoutMismatch(info: MismatchInfo, text?: MismatchDialogText): Promise<boolean>;
  /**
   * Ask whether to reload the driver page after a config-changing transfer.
   * Resolves `true` only when the user clicks the confirm button; cancelling,
   * pressing Esc or closing the dialog resolves `false` and must not reload.
   */
  confirmReload(): Promise<boolean>;
  log(message: string): void;
}

const LOG_LIMIT = 8;

/**
 * Theme palette matching the official ZetsuMeow driver page:
 *   theme #ff4570 · text #000 · border #bababa · page #fff ·
 *   button fill #e3e4e5 · hover #c6c6c6 · soft fill #d8d8d8.
 * Status colours (green/amber/red) are our own, tuned for white backgrounds.
 */
const THEME = {
  accent: '#ff4570',
  text: '#000',
  textMuted: '#666',
  textDim: '#999',
  border: '#bababa',
  borderSoft: '#d8d8d8',
  page: '#fff',
  fill: '#e3e4e5',
  fillHover: '#c6c6c6',
  fillSoft: 'rgba(216, 216, 216, 0.46)',
  fillHoverSoft: 'rgba(216, 216, 216, 0.75)',
  overlaySoft: 'rgba(0, 0, 0, 0.06)',
  ok: '#27ba6b',
  okText: '#15803d',
  warn: '#f59e0b',
};

const STYLE = `
  :host { color-scheme: light; }
  .panel {
    width: 360px;
    overflow: hidden;
    border: 1px solid ${THEME.borderSoft};
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
    color: ${THEME.text};
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    backdrop-filter: blur(8px);
  }
  .panel.collapsed .body { display: none; }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid ${THEME.borderSoft};
    background: ${THEME.page};
  }
  .panel.collapsed .head { border-bottom: 0; }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${THEME.fillHover};
    flex: none;
  }
  .dot[data-state="active"] { background: ${THEME.ok}; box-shadow: 0 0 8px ${THEME.ok}; }
  .dot[data-state="readonly"] { background: ${THEME.warn}; }
  .dot[data-state="disabled"] { background: ${THEME.accent}; }
  .dot[data-state="error"] { background: ${THEME.accent}; }
  .title { font-weight: 700; letter-spacing: 0.04em; }
  .phase {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 999px;
    background: ${THEME.overlaySoft};
    color: ${THEME.textMuted};
    font-size: 10px;
    text-transform: uppercase;
  }
  .ghost {
    flex: none;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: ${THEME.textMuted};
    font: inherit;
    cursor: pointer;
  }
  .ghost:hover { background: ${THEME.overlaySoft}; color: ${THEME.text}; }
  .body { padding: 10px 12px; }
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 9px;
  }
  .tab {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid ${THEME.borderSoft};
    border-radius: 6px;
    background: ${THEME.fillSoft};
    color: ${THEME.textMuted};
    font: inherit;
    cursor: pointer;
  }
  .tab:hover { background: ${THEME.fillHoverSoft}; }
  .tab.active { border-color: ${THEME.accent}; background: ${THEME.accent}; color: #fff; }
  .grid {
    display: grid;
    grid-template-columns: 70px minmax(0, 1fr);
    gap: 3px 8px;
    margin: 0 0 9px;
  }
  .grid dt { color: ${THEME.textDim}; }
  .grid dd {
    margin: 0;
    overflow: hidden;
    color: ${THEME.text};
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .error, .busy {
    margin: 0 0 8px;
    padding: 6px 7px;
    border-radius: 6px;
    font-size: 11px;
    word-break: break-word;
  }
  .error { border: 1px solid rgba(255, 69, 112, 0.5); background: rgba(255, 69, 112, 0.08); color: #d92650; }
  .busy { border: 1px solid rgba(39, 186, 107, 0.4); background: rgba(39, 186, 107, 0.08); color: ${THEME.okText}; }
  .transfer-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.28);
    backdrop-filter: blur(2px);
  }
  .transfer-overlay[hidden] { display: none; }
  .transfer-card {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 360px;
    padding: 14px 18px;
    border: 1px solid ${THEME.borderSoft};
    border-radius: 10px;
    background: ${THEME.page};
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
    color: ${THEME.text};
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    text-align: left;
  }
  .spinner {
    width: 16px;
    height: 16px;
    flex: none;
    border: 2px solid ${THEME.borderSoft};
    border-top-color: ${THEME.accent};
    border-radius: 50%;
    animation: zmeow-spin 0.8s linear infinite;
  }
  @keyframes zmeow-spin { to { transform: rotate(360deg); } }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 5px;
    margin-bottom: 9px;
  }
  .actions button {
    padding: 6px 8px;
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    background: ${THEME.fill};
    color: ${THEME.text};
    font: inherit;
    cursor: pointer;
  }
  .actions button:hover:not(:disabled) { background: ${THEME.fillHover}; }
  .actions button.secondary { grid-column: 1 / -1; color: ${THEME.textMuted}; }
  .actions button:disabled { cursor: default; opacity: 0.45; }
  .group { margin-bottom: 9px; }
  .group .actions { margin-bottom: 0; }
  .group-title {
    margin: 0 0 4px;
    color: ${THEME.textDim};
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .loaded {
    margin: 6px 0 0;
    padding: 5px 7px;
    border-radius: 6px;
    font-size: 11px;
    word-break: break-word;
    border: 1px solid rgba(39, 186, 107, 0.4);
    background: rgba(39, 186, 107, 0.08);
    color: ${THEME.okText};
  }
  .loaded[data-ok="false"] {
    border-color: rgba(255, 69, 112, 0.5);
    background: rgba(255, 69, 112, 0.08);
    color: #d92650;
  }
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 9px;
  }
  .setting-row label { color: ${THEME.textMuted}; }
  .setting-row select {
    min-width: 140px;
    padding: 4px 6px;
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    background: ${THEME.page};
    color: ${THEME.text};
    font: inherit;
    cursor: pointer;
  }
  .setting-row select option { background: ${THEME.page}; color: ${THEME.text}; }
  /* Wooting share-code row: text input + Import button on one line. */
  .wooting-row {
    display: flex;
    gap: 5px;
  }
  .wooting-row input {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    background: ${THEME.page};
    color: ${THEME.text};
    font: inherit;
  }
  .wooting-row button {
    flex: none;
    padding: 4px 10px;
    border: 1px solid ${THEME.border};
    border-radius: 6px;
    background: ${THEME.fill};
    color: ${THEME.text};
    font: inherit;
    cursor: pointer;
  }
  .wooting-row button:hover:not(:disabled) { background: ${THEME.fillHover}; }
  .wooting-row button:disabled { cursor: default; opacity: 0.45; }
  .hint { margin: 0; color: ${THEME.textDim}; font-size: 11px; line-height: 1.5; }
  .log {
    max-height: 120px;
    overflow: auto;
    padding: 6px 7px;
    border-radius: 6px;
    background: ${THEME.overlaySoft};
    color: #444;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .log:empty::before { content: attr(data-empty); color: #b0b0b0; }
  /* Layout-mismatch consent dialog: shipped in both build modes. */
  .mismatch-dialog {
    padding: 14px;
    width: 320px;
    border: 1px solid ${THEME.borderSoft};
    border-radius: 10px;
    background: ${THEME.page};
    color: ${THEME.text};
    font: inherit;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
  }
  .mismatch-dialog::backdrop { background: rgba(0, 0, 0, 0.35); }
  .mismatch-dialog-title { margin: 0 0 6px; font-weight: 700; }
  .mismatch-dialog-body { margin: 0 0 9px; color: ${THEME.textMuted}; font-size: 11px; line-height: 1.5; }
  /* Post-restore/import reload confirmation: shared by both build modes. */
  .reload-dialog {
    padding: 14px;
    width: 320px;
    border: 1px solid ${THEME.borderSoft};
    border-radius: 10px;
    background: ${THEME.page};
    color: ${THEME.text};
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
  }
  .reload-dialog::backdrop { background: rgba(0, 0, 0, 0.35); }
  .reload-dialog-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 6px;
  }
  .reload-dialog-title { font-weight: 700; }
  .reload-dialog-close {
    width: 20px;
    height: 20px;
    margin-left: auto;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: ${THEME.textMuted};
    font: inherit;
    line-height: 1;
    cursor: pointer;
  }
  .reload-dialog-close:hover { background: ${THEME.overlaySoft}; color: ${THEME.text}; }
  .reload-dialog-body {
    margin: 0 0 9px;
    color: ${THEME.textMuted};
    font-size: 11px;
    line-height: 1.5;
  }
  .reload-dialog .actions { margin-bottom: 0; }
`;

export function mountPanel(handlers: PanelHandlers, initial: PanelView): Panel {
  const host = document.createElement('div');
  host.id = 'zmeow-tap-root';
  host.style.position = 'fixed';
  host.style.right = '16px';
  host.style.bottom = '16px';
  host.style.zIndex = '2147483647';

  const shadow = host.attachShadow({ mode: 'open' });
  // Mode-conditional markup is inlined into this template as ternaries: the
  // build folds the untaken branch (and its template literal) away entirely.
  shadow.innerHTML = `
    <style>${STYLE}${__ZMEOW_RELEASE__ ? `
  .restore-dialog {
    padding: 14px;
    width: 320px;
    border: 1px solid ${THEME.borderSoft};
    border-radius: 10px;
    background: ${THEME.page};
    color: ${THEME.text};
    font: inherit;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
  }
  .restore-dialog::backdrop { background: rgba(0, 0, 0, 0.35); }
  .dialog-title { margin: 0 0 6px; font-weight: 700; }
  .dialog-hint { margin: 0 0 9px; color: ${THEME.textDim}; font-size: 11px; line-height: 1.5; }
  .restore-dialog .actions { margin-bottom: 9px; }
  .restore-dialog .loaded { margin: 0 0 9px; }
` : ''}</style>
    <div class="transfer-overlay" data-field="transfer" hidden>
      <div class="transfer-card" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <span data-field="transfer-text"></span>
      </div>
    </div>
    <dialog class="reload-dialog" data-field="reload-dialog">
      <div class="reload-dialog-head">
        <span class="reload-dialog-title" data-i18n="reloadDialogTitle">刷新页面</span>
        <button type="button" class="reload-dialog-close" data-action="reload-close" data-i18n-title="reloadDialogClose" data-i18n-aria="reloadDialogClose" title="关闭" aria-label="关闭">×</button>
      </div>
      <p class="reload-dialog-body" data-i18n="reloadDialogBody">还原/导入已改动设备配置，官方页面的缓存数据已过期。刷新页面后需要重新选择设备；取消或关闭则保持当前页面。</p>
      <div class="actions">
        <button type="button" data-action="reload-cancel" data-i18n="reloadDialogLater">取消</button>
        <button type="button" data-action="reload-confirm" data-i18n="reloadDialogNow">立即刷新</button>
      </div>
    </dialog>
    <section class="panel" data-i18n-aria="panelAria" aria-label="Better ZetsuMeow Driver">
      <header class="head">
        <span class="dot" data-state="idle"></span>
        <span class="title" data-i18n="panelTitle">Better ZetsuMeow Driver</span>
        <span class="phase" data-field="phase">启动中</span>
        <button class="ghost" type="button" data-action="collapse" aria-expanded="true" data-i18n-title="collapsePanel" title="收起面板">−</button>
      </header>
      <div class="body">
        <nav class="tabs">
          <button type="button" class="tab active" data-action="tab-main" data-i18n="tabMain">主面板</button>
          <button type="button" class="tab" data-action="tab-settings" data-i18n="tabSettings">设置</button>
        </nav>
        <div data-view="main">
          <dl class="grid">
            <dt data-i18n="dtState">状态</dt><dd data-field="state">—</dd>
            <dt data-i18n="dtFingerprint">指纹</dt><dd data-field="fingerprint">—</dd>
            <dt data-i18n="dtFrames">帧数</dt><dd data-field="frames">0 (hid 0 / serial 0)</dd>
            <dt data-i18n="dtSdk">SDK</dt><dd data-field="sdk">…</dd>
          </dl>
          <p class="error" data-field="error" hidden></p>
          <p class="busy" data-field="busy" hidden></p>
          ${__ZMEOW_RELEASE__ ? '' : `
          <div class="actions">
            <button type="button" data-action="keyboard" data-i18n="actionKeyboard">连接键盘</button>
            <button type="button" data-action="screen" data-i18n="actionScreen">连接屏幕</button>
            <button type="button" data-action="disconnect" class="secondary" data-i18n="actionDisconnect">断开连接</button>
          </div>`}
          <div class="group">
            <div class="group-title" data-i18n="groupBackup">备份</div>
            ${__ZMEOW_RELEASE__ ? `
            <div class="actions">
              <button type="button" data-action="backup" data-i18n="actionBackup">备份</button>
            </div>` : `
            <div class="actions">
              <button type="button" data-action="backup" data-i18n="actionBackup">备份</button>
              <button type="button" data-action="download" disabled data-i18n="btnDownload" data-i18n-title="titleDownload" title="下载已捕获的备份 JSON">下载备份</button>
            </div>`}
          </div>
          ${__ZMEOW_RELEASE__ ? `
          <div class="group">
            <div class="group-title" data-i18n="groupRestore">还原</div>
            <div class="actions">
              <button type="button" data-action="restore" data-i18n="actionRestore">还原</button>
            </div>
          </div>
          <dialog class="restore-dialog" data-field="restore-dialog">
            <div class="dialog-title" data-i18n="restoreDialogTitle">还原设备配置</div>
            <p class="dialog-hint" data-i18n="dialogHint">选择备份 JSON 文件并确认后，会立即写入设备</p>
            <div class="actions">
              <button type="button" data-action="dialog-pick" data-i18n="btnLoadRestore">载入还原文件</button>
            </div>
            <input type="file" data-field="restore-file" accept="application/json,.json" hidden />
            <p class="loaded" data-field="loaded" hidden></p>
            <div class="actions">
              <button type="button" data-action="dialog-cancel" data-i18n="dialogCancel">取消</button>
              <button type="button" data-action="dialog-confirm" data-i18n="dialogConfirm" disabled>确认还原</button>
            </div>
          </dialog>` : `
          <div class="group">
            <div class="group-title" data-i18n="groupRestore">还原</div>
            <div class="actions">
              <button type="button" data-action="load-restore" data-i18n="btnLoadRestore">载入还原文件</button>
              <button type="button" data-action="restore" disabled data-i18n="actionRestore" data-i18n-title="titleRestore" title="将已载入的备份写回设备">还原</button>
            </div>
            <input type="file" data-field="restore-file" accept="application/json,.json" hidden />
            <p class="loaded" data-field="loaded" hidden></p>
          </div>`}
          <div class="group">
            <div class="group-title" data-i18n="groupWooting">Wooting 导入</div>
            <div class="wooting-row">
              <input type="text" data-field="wooting-code" data-i18n-placeholder="wootingCodePlaceholder" placeholder="Wooting 分享码" />
              <button type="button" data-action="wooting" data-i18n="btnWootingImport">导入</button>
            </div>
          </div>
          <div class="log" data-field="log" role="log" aria-live="polite"></div>
        </div>
        <div data-view="settings" hidden>
          <div class="setting-row">
            <label for="zmeow-locale" data-i18n="settingLanguage">语言</label>
            <select id="zmeow-locale" data-field="locale">
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </select>
          </div>
          <p class="hint" data-i18n="settingHint">语言在首次运行时按浏览器语言自动选择；在此手动切换会立即生效并保存。</p>
        </div>
        <dialog class="mismatch-dialog" data-field="mismatch-dialog">
          <div class="mismatch-dialog-title" data-field="mismatch-title" data-i18n="mismatchTitle">布局不一致</div>
          <p class="mismatch-dialog-body" data-field="mismatch-body"></p>
          <div class="actions">
            <button type="button" data-action="mismatch-cancel" data-i18n="dialogCancel">取消</button>
            <button type="button" data-action="mismatch-confirm" data-i18n="mismatchConfirm">同意还原</button>
          </div>
        </dialog>
      </div>
    </section>
  `;

  const panel = requireElement<HTMLElement>(shadow, '.panel');
  const stateField = requireElement<HTMLElement>(shadow, '[data-field="state"]');
  const fingerprintField = requireElement<HTMLElement>(shadow, '[data-field="fingerprint"]');
  const framesField = requireElement<HTMLElement>(shadow, '[data-field="frames"]');
  const sdkField = requireElement<HTMLElement>(shadow, '[data-field="sdk"]');
  const phaseField = requireElement<HTMLElement>(shadow, '[data-field="phase"]');
  const errorField = requireElement<HTMLElement>(shadow, '[data-field="error"]');
  const busyField = requireElement<HTMLElement>(shadow, '[data-field="busy"]');
  const transferField = requireElement<HTMLElement>(shadow, '[data-field="transfer"]');
  const transferTextField = requireElement<HTMLElement>(shadow, '[data-field="transfer-text"]');
  const loadedField = requireElement<HTMLElement>(shadow, '[data-field="loaded"]');
  const logField = requireElement<HTMLElement>(shadow, '[data-field="log"]');
  const dot = requireElement<HTMLElement>(shadow, '.dot');
  const mainView = requireElement<HTMLElement>(shadow, '[data-view="main"]');
  const settingsView = requireElement<HTMLElement>(shadow, '[data-view="settings"]');
  const localeSelect = requireElement<HTMLSelectElement>(shadow, '[data-field="locale"]');
  // Same data-field name in both modes: outer input (debug) vs dialog input
  // (release); exactly one exists per template.
  const restoreFile = requireElement<HTMLInputElement>(shadow, '[data-field="restore-file"]');
  const wootingCodeInput = requireElement<HTMLInputElement>(shadow, '[data-field="wooting-code"]');
  const restoreDialog = __ZMEOW_RELEASE__
    ? requireElement<HTMLDialogElement>(shadow, '[data-field="restore-dialog"]')
    : null;
  const reloadDialog = requireElement<HTMLDialogElement>(shadow, '[data-field="reload-dialog"]');
  const mismatchDialog = requireElement<HTMLDialogElement>(shadow, '[data-field="mismatch-dialog"]');
  const mismatchTitle = requireElement<HTMLElement>(shadow, '[data-field="mismatch-title"]');
  const mismatchBody = requireElement<HTMLElement>(shadow, '[data-field="mismatch-body"]');
  const mismatchConfirmButton = requireElement<HTMLButtonElement>(
    shadow,
    'button[data-action="mismatch-confirm"]',
  );

  // Tab buttons switch views and must never be disabled by setBusy; the
  // mismatch/reload dialog buttons must stay clickable too — they open during
  // (or right after) a busy transfer, and disabling them would deadlock it.
  const actionButtons = Array.from(
    shadow.querySelectorAll<HTMLButtonElement>(
      'button[data-action]:not([data-action="collapse"]):not([data-action^="tab-"]):not([data-action^="mismatch-"]):not([data-action^="reload-"])',
    ),
  );

  // Two-step action readiness (Backup → Download, Load file → Restore); kept
  // here so setBusy's global disable can restore the correct enabled state.
  let stateBackupReady = false;
  let stateRestoreReady = false;
  // Last "Load restore file" outcome, re-rendered on locale changes.
  let lastLoaded: LoadedFileInfo | null = null;

  const applyStaticI18n = (): void => {
    for (const element of shadow.querySelectorAll<HTMLElement>('[data-i18n]')) {
      const key = element.dataset['i18n'];
      if (typeof key === 'string' && key.length > 0) element.textContent = t(key as MessageKey);
    }
    for (const element of shadow.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
      const key = element.dataset['i18nTitle'];
      if (typeof key === 'string' && key.length > 0) element.title = t(key as MessageKey);
    }
    for (const element of shadow.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
      const key = element.dataset['i18nPlaceholder'];
      if (typeof key === 'string' && key.length > 0) element.setAttribute('placeholder', t(key as MessageKey));
    }
    for (const element of shadow.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
      const key = element.dataset['i18nAria'];
      if (typeof key === 'string' && key.length > 0) element.setAttribute('aria-label', t(key as MessageKey));
    }
    logField.dataset['empty'] = t('logEmpty');
  };

  const renderLoaded = (): void => {
    const info = lastLoaded;
    if (info === null) {
      loadedField.hidden = true;
      loadedField.textContent = '';
    } else {
      loadedField.hidden = false;
      loadedField.dataset['ok'] = String(info.ok);
      if (info.ok) {
        const parts: string[] = [`✓ ${t('loadedOk', { name: info.name })}`, t('loadValidated')];
        if (info.summary !== undefined) {
          parts.push(
            t('configSummary', {
              layers: info.summary.layers,
              colors: info.summary.colors,
              travel: info.summary.travel,
              features: info.summary.features,
            }),
          );
        }
        loadedField.textContent = parts.join(' · ');
      } else {
        const error = info.error ?? '';
        const head = `✕ ${t('loadedFailed', { name: info.name })}`;
        loadedField.textContent = error.length > 0 ? `${head} · ${error}` : head;
      }
    }
    if (__ZMEOW_RELEASE__) {
      // The dialog's confirm button is the actual readiness signal: it may only
      // be pressed once a file parsed and validated successfully.
      const confirmButton = shadow.querySelector<HTMLButtonElement>('button[data-action="dialog-confirm"]');
      if (confirmButton !== null) confirmButton.disabled = !(info !== null && info.ok);
    }
  };

  const setCollapsed = (collapsed: boolean): void => {
    panel.classList.toggle('collapsed', collapsed);
    const toggle = shadow.querySelector<HTMLButtonElement>('[data-action="collapse"]');
    if (toggle !== null) {
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.textContent = collapsed ? '+' : '−';
      toggle.title = collapsed ? t('expandPanel') : t('collapsePanel');
    }
  };

  const setView = (name: 'main' | 'settings'): void => {
    mainView.hidden = name !== 'main';
    settingsView.hidden = name !== 'settings';
    for (const tab of shadow.querySelectorAll<HTMLButtonElement>('button[data-action^="tab-"]')) {
      tab.classList.toggle('active', tab.dataset['action'] === `tab-${name}`);
    }
  };

  // One dispatch table per mode: the release build only learns about actions
  // that exist in its markup (no connect buttons, no two-step entries); the
  // debug build never sees the dialog actions.
  const actionHandlers = new Map<string, () => void>();
  const bindAction = (action: string, run: () => void): void => {
    actionHandlers.set(action, run);
  };

  bindAction('backup', () => handlers.backup());
  bindAction('wooting', () => handlers.importWooting(wootingCodeInput.value));
  bindAction('tab-main', () => setView('main'));
  bindAction('tab-settings', () => setView('settings'));
  bindAction('collapse', () => setCollapsed(!panel.classList.contains('collapsed')));
  if (__ZMEOW_RELEASE__) {
    bindAction('restore', () => restoreDialog?.showModal());
    bindAction('dialog-pick', () => restoreFile.click());
    bindAction('dialog-cancel', () => restoreDialog?.close());
    bindAction('dialog-confirm', () => {
      restoreDialog?.close();
      handlers.restore();
    });
  } else {
    bindAction('keyboard', () => handlers.connectKeyboard());
    bindAction('screen', () => handlers.connectScreen());
    bindAction('disconnect', () => handlers.disconnect());
    bindAction('download', () => handlers.downloadBackup());
    bindAction('load-restore', () => restoreFile.click());
    bindAction('restore', () => handlers.restore());
  }

  // Layout-mismatch consent (both modes): the promise from
  // confirmLayoutMismatch resolves via the dialog buttons or any dialog close
  // (Esc key); settling is idempotent, the close event is the safety net.
  let mismatchSettle: ((agreed: boolean) => void) | null = null;
  const settleMismatch = (agreed: boolean): void => {
    const settle = mismatchSettle;
    mismatchSettle = null;
    if (settle !== null) {
      mismatchDialog.close();
      settle(agreed);
    }
  };
  bindAction('mismatch-confirm', () => settleMismatch(true));
  bindAction('mismatch-cancel', () => settleMismatch(false));
  mismatchDialog.addEventListener('close', () => settleMismatch(false));

  // Post-transfer reload confirmation (both modes): every dismissal path —
  // cancel, the × button, Esc or a backdrop click — resolves `false`; only the
  // explicit "reload now" button resolves `true`, so a closed dialog never
  // reloads the driver page.
  let reloadSettle: ((confirmed: boolean) => void) | null = null;
  const settleReload = (confirmed: boolean): void => {
    const settle = reloadSettle;
    reloadSettle = null;
    if (settle === null) return;
    if (reloadDialog.open) reloadDialog.close();
    settle(confirmed);
  };
  bindAction('reload-confirm', () => settleReload(true));
  bindAction('reload-cancel', () => settleReload(false));
  bindAction('reload-close', () => settleReload(false));
  reloadDialog.addEventListener('close', () => settleReload(false));
  reloadDialog.addEventListener('click', (event) => {
    if (event.target === reloadDialog) settleReload(false);
  });

  for (const button of shadow.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset['action'];
      if (action !== undefined) actionHandlers.get(action)?.();
    });
  }

  const pickFile = (input: HTMLInputElement, handler: (file: File) => void): void => {
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) handler(file);
    });
  };
  pickFile(restoreFile, handlers.loadRestore);

  // Enter in the share-code field triggers the same action as the Import
  // button (the dispatch respects the busy state; an empty code is reported
  // by main.ts). The isComposing check keeps an IME's confirm-Enter (key is
  // also "Enter" while composing) from submitting unfinished candidate text.
  wootingCodeInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      actionHandlers.get('wooting')?.();
    }
  });

  localeSelect.value = getLocale();
  localeSelect.addEventListener('change', () => {
    const value = localeSelect.value;
    if (value === 'zh-CN' || value === 'en') setLocale(value);
  });

  // Re-apply static labels (incl. the collapse button title, which setCollapsed
  // overrides) and the loaded-file line whenever the locale changes; the
  // dynamic state/phase labels are refreshed by main.ts via update().
  onLocaleChange(() => {
    applyStaticI18n();
    localeSelect.value = getLocale();
    const collapsed = panel.classList.contains('collapsed');
    const toggle = shadow.querySelector<HTMLButtonElement>('[data-action="collapse"]');
    if (toggle !== null) toggle.title = collapsed ? t('expandPanel') : t('collapsePanel');
    renderLoaded();
  });

  const render = (view: PanelView): void => {
    stateField.textContent = view.stateLabel;
    dot.dataset['state'] = view.phase === 'error' ? 'error' : view.state;
    dot.title = view.stateLabel;
    fingerprintField.textContent = view.fingerprint;
    fingerprintField.title = view.fingerprint;
    framesField.textContent = `${view.frames.total} (hid ${view.frames.hid} / serial ${view.frames.serial})`;
    sdkField.textContent = view.sdk;
    sdkField.title = view.sdk;
    phaseField.textContent = view.phaseLabel;
    errorField.hidden = view.error === null;
    errorField.textContent = view.error ?? '';
  };

  applyStaticI18n();
  render(initial);
  renderLoaded();

  document.body.append(host);

  const applyActionEnabled = (action: 'download' | 'restore', enabled: boolean): void => {
    if (action === 'restore' && __ZMEOW_RELEASE__) {
      // Release: the Restore button is the dialog opener (always available);
      // readiness is expressed by the dialog's confirm button instead.
      return;
    }
    if (action === 'download') stateBackupReady = enabled;
    else stateRestoreReady = enabled;
    const button = shadow.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
    if (button !== null) button.disabled = !enabled;
  };

  return {
    host,
    update: render,
    setBusy(label: string | null): void {
      busyField.hidden = label === null;
      busyField.textContent = label === null ? '' : t('busyInProgress', { label });
      for (const button of actionButtons) button.disabled = label !== null;
      // The two-step buttons depend on captured state, not just busy-ness;
      // main.ts re-applies their enabled state via setActionEnabled.
      if (label !== null) return;
      applyActionEnabled('download', stateBackupReady);
      applyActionEnabled('restore', stateRestoreReady);
      if (__ZMEOW_RELEASE__) {
        // The busy loop re-enabled every action button, including the dialog's
        // confirm; re-derive its state from the loaded-file info instead.
        renderLoaded();
      }
    },
    setTransferHint(text: string | null): void {
      transferField.hidden = text === null;
      transferTextField.textContent = text ?? '';
    },
    setActionEnabled(action: 'download' | 'restore', enabled: boolean): void {
      applyActionEnabled(action, enabled);
    },
    setLoadedFile(info: LoadedFileInfo | null): void {
      lastLoaded = info;
      renderLoaded();
    },
    confirmLayoutMismatch(info: MismatchInfo, text?: MismatchDialogText): Promise<boolean> {
      // One shared <dialog>: restore renders its own i18n copy from `info`,
      // the Wooting import renders caller-supplied pre-localized copy. All
      // three fields are always set so a previous dialog cannot leak through.
      mismatchTitle.textContent = text?.title ?? t('mismatchTitle');
      mismatchBody.textContent =
        text !== undefined
          ? text.body
          : info.skippedKeys > 0
            ? t('mismatchBody', {
                backup: info.backupLayout,
                device: info.deviceLayout,
                shared: info.sharedKeys,
                skipped: info.skippedKeys,
              })
            : t('mismatchBodySubset', {
                backup: info.backupLayout,
                device: info.deviceLayout,
                shared: info.sharedKeys,
              });
      mismatchConfirmButton.textContent = text?.confirm ?? t('mismatchConfirm');
      // A stale waiter (should not exist — the close event settles it) counts
      // as cancelled so the new question always owns the dialog.
      settleMismatch(false);
      mismatchDialog.showModal();
      return new Promise<boolean>((resolve) => {
        mismatchSettle = resolve;
      });
    },
    confirmReload(): Promise<boolean> {
      // A stale waiter (should not exist — the close event settles it) counts
      // as cancelled so the new question always owns the dialog.
      settleReload(false);
      reloadDialog.showModal();
      return new Promise<boolean>((resolve) => {
        reloadSettle = resolve;
      });
    },
    log(message: string): void {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
      logField.append(line);
      while (logField.childElementCount > LOG_LIMIT) logField.firstElementChild?.remove();
      logField.scrollTop = logField.scrollHeight;
    },
  };
}

function requireElement<T extends Element>(root: ShadowRoot, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`[zmeow] panel is missing ${selector}`);
  return element;
}
