/**
 * ZetsuMeow SDK Playground.
 *
 * Plain ES module, no bundler, no framework, no CDN. All SDK calls live in this
 * file so the page keeps working when the SDK signatures move: fix them here.
 *
 * Serve the repository root over HTTP, then open:
 *   http://localhost:8099/apps/playground/
 * The SDK is loaded from ../../packages/zmeow-sdk/dist/index.js.
 */

import { KEY_CATALOG } from './key-catalog.js';

const SDK_URL = '../../packages/zmeow-sdk/dist/index.js';
const SCREEN_WIDTH = 194;
const SCREEN_HEIGHT = 368;
const MAX_TRAVEL_MM = 4;
const MAX_EVENTS = 40;
const MAX_LOG_LINES = 500;
const KEY_UNIT_PX = 46;
const KEY_PITCH_UNITS = 1.1;

const $ = (id) => document.getElementById(id);

const els = {
  // connection
  btnConnect: $('btn-connect'),
  btnDiagnose: $('btn-diagnose'),
  btnDisconnect: $('btn-disconnect'),
  connState: $('conn-state'),
  hidSupport: $('hid-support'),
  sdkState: $('sdk-state'),
  sdkBanner: $('sdk-banner'),
  sdkBannerDetail: $('sdk-banner-detail'),
  deviceInfo: $('device-info'),
  // layout
  keyboard: $('keyboard'),
  layoutMode: $('layout-mode'),
  keyCount: $('key-count'),
  hasFRow: $('has-frow'),
  selectionInfo: $('selection-info'),
  btnClearSelection: $('btn-clear-selection'),
  // light
  lightMode: $('light-mode'),
  lightSpeed: $('light-speed'),
  lightSpeedOut: $('light-speed-out'),
  lightTurn: $('light-turn'),
  lightTurnOut: $('light-turn-out'),
  lightBrightness: $('light-brightness'),
  lightBrightnessOut: $('light-brightness-out'),
  lightColor: $('light-color'),
  lightColorful: $('light-colorful'),
  btnLightApply: $('btn-light-apply'),
  btnLightRead: $('btn-light-read'),
  lightOut: $('light-out'),
  keyColor: $('key-color'),
  btnKeyColor: $('btn-key-color'),
  btnKeyColorsRead: $('btn-key-colors-read'),
  keycolorOut: $('keycolor-out'),
  // key config
  targetSelect: $('target-select'),
  layerSelect: $('layer-select'),
  btnRemap: $('btn-remap'),
  btnRemapReset: $('btn-remap-reset'),
  btnRemapUndo: $('btn-remap-undo'),
  remapUndoHint: $('remap-undo-hint'),
  btnRs: $('btn-rs'),
  btnSocd: $('btn-socd'),
  btnClearFeature: $('btn-clear-feature'),
  mtHold: $('mt-hold'),
  mtTap: $('mt-tap'),
  mtMs: $('mt-ms'),
  tglTarget: $('tgl-target'),
  mptTarget1: $('mpt-target1'),
  mptTarget2: $('mpt-target2'),
  mptTarget3: $('mpt-target3'),
  mptMm1: $('mpt-mm1'),
  mptMm2: $('mpt-mm2'),
  mptMm3: $('mpt-mm3'),
  endTarget: $('end-target'),
  endMs: $('end-ms'),
  btnMt: $('btn-mt'),
  btnTgl: $('btn-tgl'),
  btnMpt: $('btn-mpt'),
  btnEnd: $('btn-end'),
  btnReadFeatures: $('btn-read-features'),
  featureOut: $('feature-out'),
  winlockValue: $('winlock-value'),
  btnWinlockSet: $('btn-winlock-set'),
  btnWinlockRead: $('btn-winlock-read'),
  winlockState: $('winlock-state'),
  lightSleep: $('light-sleep'),
  btnLightSleep: $('btn-light-sleep'),
  btnRestoreDefaults: $('btn-restore-defaults'),
  // travel
  travelPress: $('travel-press'),
  travelRelease: $('travel-release'),
  travelDeadDown: $('travel-dead-down'),
  travelDeadUp: $('travel-dead-up'),
  travelFastOut: $('travel-fast-out'),
  travelFast: $('travel-fast'),
  btnTravelApply: $('btn-travel-apply'),
  btnTravelRead: $('btn-travel-read'),
  travelReadback: $('travel-readback'),
  // test
  testMode: $('test-mode'),
  btnTestStart: $('btn-test-start'),
  btnTestStop: $('btn-test-stop'),
  btnTestClear: $('btn-test-clear'),
  testState: $('test-state'),
  inputCount: $('input-count'),
  travelBars: $('travel-bars'),
  eventList: $('event-list'),
  // screen
  screenSupported: $('screen-supported'),
  screenState: $('screen-state'),
  btnScreenOpen: $('btn-screen-open'),
  btnScreenClose: $('btn-screen-close'),
  screenFile: $('screen-file'),
  screenAutoSend: $('screen-auto-send'),
  btnScreenSend: $('btn-screen-send'),
  screenCanvas: $('screen-canvas'),
  screenProgress: $('screen-progress'),
  screenProgressText: $('screen-progress-text'),
  // log
  btnLogClear: $('btn-log-clear'),
  log: $('log'),
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let ZetsuKeyboard = null;
let isWebHidSupported = null;
let sdkError = null;
let kb = null;
let connecting = false;
let listenerOffs = [];
let selected = new Set();
let keysByHardCode = new Map();
let currentLayout = null;
let testRunning = false;
let inputFrames = 0;
let inputCmdCounts = new Map();
let loggedInputCmds = new Set();
let screenTimer = 0;
let screenOpen = false;
let screenImage = null;
let sendingScreen = false;
/**
 * Snapshots of the remap table taken right before each edit, newest last.
 * `{ layer, snapshot, action, at }` — the "restore to before this change" stack.
 */
const remapUndo = [];
const REMAP_UNDO_LIMIT = 20;
const screenCtx = els.screenCanvas.getContext('2d', { willReadFrequently: true });

// travel rendering state
const travelRows = new Map();
const travelOrder = [];
const travelEventState = new Map();
const pendingTravel = new Map();
let travelRaf = 0;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function log(message, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  const text = document.createElement('span');
  text.className = 'log-text';
  text.textContent = message;

  line.append(time, text);
  els.log.append(line);
  while (els.log.childElementCount > MAX_LOG_LINES) {
    els.log.firstElementChild?.remove();
  }
  els.log.scrollTop = els.log.scrollHeight;

  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn('[playground]', message);
}

function errorDetail(err) {
  if (err == null) return String(err);
  const parts = [];
  let current = err;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if (typeof current === 'object') {
      const label = [current.name, current.code, current.message]
        .filter((part) => typeof part === 'string' && part)
        .join(' · ');
      if (label) parts.push(depth === 0 ? label : `cause: ${label}`);
    } else {
      parts.push(String(current));
    }
    current = typeof current === 'object' ? current.cause : null;
  }
  return parts.length ? parts.join(' ⟵ ') : String(err);
}

function logError(context, err) {
  log(`${context}失败：${errorDetail(err)}`, 'error');
  if (err && typeof err === 'object' && err.stack) console.error(err);
}

async function diagnoseInterfaces() {
  if (!ZetsuKeyboard) return;
  try {
    const entries = await ZetsuKeyboard.listGrantedInterfaces();
    log(`已授权 HID 接口：${entries.length} 个`, entries.length ? 'ok' : 'warn');
    for (const entry of entries) {
      const name = entry.device.productName;
      const ids = `${hex(entry.device.vendorId, 4)}:${hex(entry.device.productId, 4)}`;
      for (const collection of entry.device.collections) {
        log(
          `${name} ${ids} · usagePage=${hex(collection.usagePage, 4)} usage=${hex(collection.usage, 2)} · output=${collection.outputReportBytes ?? '?'}B · input=${collection.inputReportBytes ?? '?'}B · score=${entry.score ?? '—'}`,
          'info',
        );
      }
      if (entry.device.collections.length === 0) {
        log(`${name} ${ids} · 没有 collection 信息`, 'warn');
      }
    }
    if (kb && typeof kb.interfaceInfo === 'object') {
      log(`当前使用接口：${JSON.stringify(kb.interfaceInfo)}`, 'info');
    }
    log('提示：若列表里只有键盘接口而没有 64 字节 output 的厂商接口，请在设备选择框中重新选择并授权全部接口。', 'info');
  } catch (err) {
    logError('诊断 HID 接口', err);
  }
}

function hex(value, width = 2) {
  if (!Number.isFinite(Number(value))) return '—';
  return `0x${Number(value).toString(16).toUpperCase().padStart(width, '0')}`;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function num(input, fallback = 0) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function setOutput(el, visible) {
  if (!el) return;
  el.hidden = !visible;
}

function toSerializable(value) {
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, item]) => [key, toSerializable(item)]));
  }
  if (value instanceof Set) return [...value].map(toSerializable);
  if (Array.isArray(value)) return value.map(toSerializable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = toSerializable(item);
    return out;
  }
  return value;
}

function showJson(el, value, limit = 4000) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(toSerializable(value), null, 2);
  } catch {
    text = String(value);
  }
  if (!text) text = '(空)';
  if (text.length > limit) text = `${text.slice(0, limit)}\n…（已截断）`;
  el.textContent = text;
  setOutput(el, true);
}

function normalizeHex(rgb, fallback = '#00e5ff') {
  if (typeof rgb !== 'string') return fallback;
  const value = rgb.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase();
  }
  return fallback;
}

function titleOfKey(hardCode) {
  const key = keysByHardCode.get(hardCode);
  return key?.title || key?.textCode || `#${hardCode}`;
}

function hardCodesOfSelection() {
  return [...selected];
}

function requireSelection(count) {
  if (selected.size !== count) {
    throw new Error(`需要正好选中 ${count} 个键（当前 ${selected.size} 个）`);
  }
  return [...selected];
}

// ---------------------------------------------------------------------------
// SDK loading
// ---------------------------------------------------------------------------

async function loadSdk() {
  try {
    const sdk = await import(SDK_URL);
    if (typeof sdk.ZetsuKeyboard !== 'function') {
      throw new Error(`模块未导出 ZetsuKeyboard（实际导出：${Object.keys(sdk).join(', ') || '无'}）`);
    }
    ZetsuKeyboard = sdk.ZetsuKeyboard;
    isWebHidSupported = typeof sdk.isWebHidSupported === 'function' ? sdk.isWebHidSupported : null;
    if (Array.isArray(sdk.KEY_CATALOG) && sdk.KEY_CATALOG.length) {
      populateTargetSelects(sdk.KEY_CATALOG);
    }
    els.sdkState.textContent = 'SDK 已加载';
    els.sdkState.className = 'badge badge-ok';
    log(`SDK 已加载：${SDK_URL}`, 'ok');
  } catch (err) {
    sdkError = err;
    els.sdkState.textContent = 'SDK 未加载';
    els.sdkState.className = 'badge badge-bad';
    els.sdkBanner.hidden = false;
    els.sdkBannerDetail.textContent =
      `无法导入 ${SDK_URL}。请先在仓库根执行 “pnpm -F @bookqaq/zmeow-sdk build”，` +
      '并通过 http://localhost:8099/apps/playground/ 访问（不要直接双击 HTML）。';
    logError('加载 SDK', err);
  }
}

function updateHidSupport() {
  let supported = false;
  try {
    if (typeof isWebHidSupported === 'function') supported = Boolean(isWebHidSupported());
    else if (typeof navigator !== 'undefined' && 'hid' in navigator) supported = true;
  } catch (err) {
    logError('检测 WebHID', err);
  }

  if (!window.isSecureContext) {
    els.hidSupport.textContent = '非安全上下文';
    els.hidSupport.className = 'badge badge-bad';
    log(
      '当前不是安全上下文：WebHID/Web Serial 只在 https:// 或 http://localhost 下可用。',
      'warn',
    );
    return;
  }

  if (supported) {
    els.hidSupport.textContent = 'WebHID 可用';
    els.hidSupport.className = 'badge badge-ok';
  } else {
    els.hidSupport.textContent = 'WebHID 不可用';
    els.hidSupport.className = 'badge badge-bad';
    log('浏览器不支持 WebHID：请使用 Chrome / Edge（桌面版）。', 'warn');
  }
}

// ---------------------------------------------------------------------------
// controls state
// ---------------------------------------------------------------------------

function screenSupported() {
  if (!kb) return false;
  const info = kb.screen;
  return !info || info.supported !== false;
}

function isScreenOpen() {
  if (!kb) return false;
  if (typeof kb.screen?.isOpen === 'boolean') return kb.screen.isOpen;
  return screenOpen;
}

function syncControls() {
  const connected = Boolean(kb);
  const selectedCount = selected.size;

  for (const el of document.querySelectorAll('[data-requires]')) {
    const requirement = el.dataset.requires;
    let enabled = false;

    switch (requirement) {
      case 'sdk':
        enabled = Boolean(ZetsuKeyboard) && !connected && !connecting;
        break;
      case 'sdk-any':
        enabled = Boolean(ZetsuKeyboard);
        break;
      case 'connected':
        enabled = connected;
        break;
      case 'selection':
        enabled = connected && selectedCount > 0;
        break;
      case 'two-selection':
        enabled = connected && selectedCount === 2;
        break;
      case 'screen-supported':
        enabled = connected && screenSupported() && !isScreenOpen();
        break;
      case 'screen-open':
        enabled = connected && isScreenOpen();
        break;
      case 'screen-image':
        enabled = connected && isScreenOpen() && Boolean(screenImage) && !sendingScreen;
        break;
      default:
        enabled = false;
    }

    if (el === els.btnTestStart) enabled = connected && !testRunning;
    if (el === els.btnTestStop) enabled = connected && testRunning;
    if (el === els.btnRemapUndo) enabled = connected && remapUndo.length > 0;
    el.disabled = !enabled;
  }

  els.screenFile.disabled = !(connected && isScreenOpen());
  els.screenAutoSend.disabled = !(connected && isScreenOpen());
  if (els.btnScreenOpen) {
    els.btnScreenOpen.textContent = isScreenOpen() ? '屏幕已连接' : '连接屏幕';
  }
  updateRemapUndoHint();
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

async function connectKeyboard() {
  if (!ZetsuKeyboard || connecting || kb) return;
  connecting = true;
  syncControls();
  els.connState.textContent = '连接中…';
  els.connState.className = 'state state-muted';
  log('请求 HID 设备…');

  let handle = null;
  try {
    handle = await ZetsuKeyboard.requestDevice();
    if (!handle) throw new Error('requestDevice() 未返回键盘实例');
    log('设备已选择，正在打开 HID 接口…');
    await handle.connect();
    kb = handle;
    bindKeyboardEvents(handle);
    log(`键盘已连接：${kb.info?.boardId ?? '未知 boardId'}`, 'ok');
  } catch (err) {
    kb = null;
    if (handle) {
      const close = handle.disconnect ?? handle.close;
      if (typeof close === 'function') {
        try {
          await close.call(handle);
        } catch {
          /* best effort */
        }
      }
    }
    logError('连接键盘', err);
    if (err && typeof err === 'object' && err.name === 'NotFoundError') {
      log('提示：未选择设备（用户取消），不是错误。', 'warn');
    } else {
      await diagnoseInterfaces();
    }
    refreshConnectionUI();
    connecting = false;
    syncControls();
    return;
  }

  connecting = false;
  refreshConnectionUI();
  await afterConnect();
}

function bindKeyboardEvents(handle) {
  for (const name of ['disconnect', 'input', 'keyTravel', 'keyRelease', 'error', 'screen:disconnect']) {
    try {
      if (typeof handle.on !== 'function') break;
      const off = handle.on(name, (payload) => {
        try {
          handleKeyboardEvent(name, payload);
        } catch (err) {
          logError(`处理 ${name} 事件`, err);
        }
      });
      if (typeof off === 'function') listenerOffs.push(off);
    } catch (err) {
      logError(`订阅 ${name} 事件`, err);
    }
  }
}

async function afterConnect() {
  refreshConnectionUI();
  startScreenPolling();

  if (kb) {
    try {
      await kb.getDeviceInfo();
    } catch (err) {
      log(`getDeviceInfo() 未成功（kb.info 仍可用）：${errorDetail(err)}`, 'warn');
    }
  }

  if (kb) {
    try {
      const light = await kb.getLight();
      if (light && typeof light === 'object') {
        applyLightToForm(light);
        log('已读取当前灯效', 'ok');
      }
    } catch (err) {
      log(`读取初始灯效失败，可手动点「读取灯效」：${errorDetail(err)}`, 'warn');
    }
  }

  refreshScreenStatus();
  syncControls();
}

function handleKeyboardEvent(name, payload) {
  switch (name) {
    case 'disconnect': {
      log('键盘已断开（disconnect 事件）', 'warn');
      resetSession('键盘已断开');
      break;
    }
    case 'input': {
      inputFrames += 1;
      const bytes = payload?.frame instanceof Uint8Array ? payload.frame : null;
      if (bytes) {
        const cmd = bytes[2];
        inputCmdCounts.set(cmd, (inputCmdCounts.get(cmd) ?? 0) + 1);
        // Log the first report of each command so the console is diagnostic
        // without being flooded at ~50 reports/second during a key test.
        if (!loggedInputCmds.has(cmd)) {
          loggedInputCmds.add(cmd);
          log(
            `收到 HID 命令 ${hex(cmd)}（${cmd}）len=${bytes[1]}：` +
              [...bytes.slice(0, 10)].map((b) => hex(b)).join(' '),
          );
        }
      }
      const summary = [...inputCmdCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([cmd, count]) => `${cmd}×${count}`)
        .join(' ');
      els.inputCount.textContent = `input 帧：${inputFrames}${summary ? `（${summary}）` : ''}`;
      break;
    }
    case 'keyTravel': {
      handleKeyTravel(payload);
      break;
    }
    case 'keyRelease': {
      handleKeyRelease(payload);
      break;
    }
    case 'error': {
      logError('设备错误', payload);
      break;
    }
    case 'screen:disconnect': {
      screenOpen = false;
      refreshScreenStatus();
      log('屏幕已断开（screen:disconnect 事件）', 'warn');
      break;
    }
    default:
      break;
  }
}

async function disconnectKeyboard() {
  if (!kb) return;
  const handle = kb;
  els.btnDisconnect.disabled = true;
  try {
    if (testRunning) {
      // Never leave the firmware in the cmd 48 stream: it keeps reporting
      // travel instead of typing until the end command arrives.
      try {
        await handle.stopKeyTest();
        log('断开前已结束按键测试', 'warn');
      } catch (err) {
        log(`断开前结束按键测试失败：${errorDetail(err)}`, 'warn');
      }
      testRunning = false;
    }
    if (isScreenOpen() && typeof handle.closeScreen === 'function') {
      try {
        await handle.closeScreen();
      } catch (err) {
        log(`关闭屏幕时出错：${errorDetail(err)}`, 'warn');
      }
    }
    if (typeof handle.disconnect === 'function') {
      await handle.disconnect();
    } else if (typeof handle.close === 'function') {
      await handle.close();
    } else {
      log('SDK 实例没有 disconnect()/close()，仅清理页面状态。', 'warn');
    }
    log('已断开键盘', 'ok');
  } catch (err) {
    logError('断开键盘', err);
  } finally {
    // A disconnect event may already have reset the session.
    if (kb) resetSession('已断开');
    else syncControls();
  }
}

function resetSession(reason) {
  for (const off of listenerOffs) {
    try {
      off();
    } catch {
      /* ignore */
    }
  }
  listenerOffs = [];
  stopScreenPolling();

  kb = null;
  connecting = false;
  selected.clear();
  keysByHardCode = new Map();
  currentLayout = null;
  testRunning = false;
  inputFrames = 0;
  screenOpen = false;
  screenImage = null;
  sendingScreen = false;
  remapUndo.length = 0;
  travelRows.clear();
  travelOrder.length = 0;
  travelEventState.clear();
  pendingTravel.clear();
  if (travelRaf) {
    cancelAnimationFrame(travelRaf);
    travelRaf = 0;
  }

  els.keyboard.textContent = '';
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = '连接键盘后显示布局。';
  els.keyboard.append(empty);
  els.travelBars.innerHTML = '<p class="empty">开始测试并按压键盘后显示。</p>';
  els.eventList.innerHTML = '<li class="empty">暂无事件</li>';
  els.inputCount.textContent = 'input 帧：0';
  els.testState.textContent = '未运行';
  els.testState.className = 'state state-off';
  els.featureOut.hidden = true;
  els.travelReadback.hidden = true;
  els.keycolorOut.hidden = true;
  els.lightOut.hidden = true;
  screenCtx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  setProgress(0, '等待图片…');

  refreshConnectionUI();
  syncControls();
  if (reason) log(`会话已重置：${reason}`);
}

// ---------------------------------------------------------------------------
// connection UI
// ---------------------------------------------------------------------------

function setInfo(name, value) {
  const el = els.deviceInfo.querySelector(`[data-info="${name}"]`);
  if (el) el.textContent = value == null || value === '' ? '—' : String(value);
}

function refreshConnectionUI() {
  const connected = Boolean(kb);

  els.connState.textContent = connected ? '已连接' : connecting ? '连接中…' : '未连接';
  els.connState.className = `state ${connected ? 'state-on' : connecting ? 'state-muted' : 'state-off'}`;

  if (!connected) {
    for (const name of ['boardId', 'sn', 'firmwareVersion', 'runMode', 'fMode', 'layout', 'keyCount', 'hasFRow']) {
      setInfo(name, '—');
    }
    els.layoutMode.textContent = '布局：—';
    els.keyCount.textContent = '键数：—';
    els.hasFRow.textContent = 'F 区：—';
    els.selectionInfo.textContent = '未选中任何键';
    refreshScreenStatus();
    return;
  }

  const info = kb.info ?? {};
  setInfo('boardId', info.boardId);
  setInfo('sn', info.sn);
  setInfo('firmwareVersion', info.firmwareVersion);
  setInfo('runMode', info.runMode);
  setInfo('fMode', info.fMode);

  currentLayout = kb.layout ?? null;
  const mode = currentLayout?.mode ?? info.layoutMode ?? 'unknown';
  const count = currentLayout?.keyCount ?? (Array.isArray(kb.keys) ? kb.keys.length : '—');
  const hasFRow = currentLayout?.hasFRow;
  setInfo('layout', mode);
  setInfo('keyCount', count);
  setInfo('hasFRow', hasFRow == null ? '—' : hasFRow ? '是' : '否');

  els.layoutMode.textContent = `布局：${mode}`;
  els.layoutMode.className = `badge ${mode === 'extended79' ? 'badge-ok' : ''}`;
  els.keyCount.textContent = `键数：${count}`;
  els.hasFRow.textContent = `F 区：${hasFRow == null ? '—' : hasFRow ? '已安装' : '未安装'}`;

  const keys = getLayoutKeys();
  if (keys.length) renderLayout(keys);
  updateSelectionUI();
  refreshScreenStatus();
}

function getLayoutKeys() {
  const fromInstance = kb?.keys;
  if (Array.isArray(fromInstance) && fromInstance.length) return fromInstance;
  const fromLayout = kb?.layout?.keys;
  return Array.isArray(fromLayout) ? fromLayout : [];
}

// ---------------------------------------------------------------------------
// layout rendering
// ---------------------------------------------------------------------------

function geometryOf(key) {
  const g = key?.geometry;
  if (!g) return null;
  const x = Number(g.x);
  const y = Number(g.y);
  const w = Number(g.w);
  const h = Number(g.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x, y, w: Math.max(w, 0.5), h: Math.max(h, 0.5) };
}

function groupRows(keys, unit) {
  // The reference layout tables put the optional F-row at y≈0.2 while the main
  // key rows start at y≈0.5, so a plain y*unit transform overlaps. Group rows
  // by their reported y (0.15u tolerance) and stack them in that order instead.
  const anchors = [];
  for (const key of keys) {
    const y = key.geometry.y;
    if (!anchors.some((anchor) => Math.abs(anchor - y) <= 0.15)) anchors.push(y);
  }
  anchors.sort((a, b) => a - b);
  return (y) => {
    let best = 0;
    let bestDelta = Infinity;
    anchors.forEach((anchor, index) => {
      const delta = Math.abs(anchor - y);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = index;
      }
    });
    return best;
  };
}

function renderLayout(keys) {
  keysByHardCode = new Map(
    keys
      .filter((key) => Number.isFinite(Number(key.hardCode)))
      .map((key) => [Number(key.hardCode), key]),
  );
  const prepared = keys
    .map((key) => ({ key, geometry: geometryOf(key) }))
    .filter((entry) => entry.geometry);
  if (!prepared.length) {
    els.keyboard.textContent = '';
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'kb.keys 为空或缺少 geometry，无法渲染布局。';
    els.keyboard.append(empty);
    return;
  }

  const unit = KEY_UNIT_PX;
  const pitch = unit * KEY_PITCH_UNITS;
  const minX = Math.min(...prepared.map((entry) => entry.geometry.x));
  const maxX = Math.max(...prepared.map((entry) => entry.geometry.x + entry.geometry.w));
  const maxH = Math.max(...prepared.map((entry) => entry.geometry.h));
  const rowOf = groupRows(prepared.map((entry) => entry.key), unit);
  const maxRow = Math.max(...prepared.map((entry) => rowOf(entry.geometry.y)));

  els.keyboard.textContent = '';
  els.keyboard.style.width = `${Math.ceil((maxX - minX) * unit)}px`;
  els.keyboard.style.height = `${Math.ceil(maxRow * pitch + maxH * unit)}px`;

  const fragment = document.createDocumentFragment();
  const sorted = [...prepared].sort((a, b) => {
    const rowA = rowOf(a.geometry.y);
    const rowB = rowOf(b.geometry.y);
    if (rowA !== rowB) return rowA - rowB;
    return a.geometry.x - b.geometry.x;
  });

  for (const { key, geometry } of sorted) {
    const hardCode = Number(key.hardCode);
    const cap = document.createElement('button');
    cap.type = 'button';
    cap.className = 'keycap';
    if (key.isFRow) cap.classList.add('is-frow');
    if (selected.has(hardCode)) cap.classList.add('is-selected');
    cap.dataset.hardCode = String(hardCode);
    cap.dataset.textCode = key.textCode ?? '';
    cap.style.left = `${((geometry.x - minX) * unit).toFixed(1)}px`;
    cap.style.top = `${(rowOf(geometry.y) * pitch).toFixed(1)}px`;
    cap.style.width = `${Math.max(geometry.w * unit - 3, 16).toFixed(1)}px`;
    cap.style.height = `${Math.max(geometry.h * unit - 3, 16).toFixed(1)}px`;
    cap.title = [
      key.title || key.textCode || 'unknown',
      `textCode: ${key.textCode ?? '—'}`,
      `hardCode: ${hardCode} (${hex(hardCode)})`,
      `hidCode: ${key.hidCode == null ? '—' : `${key.hidCode} (${hex(key.hidCode)})`}`,
      key.hidCodeFn1 == null ? null : `hidCodeFn1: ${key.hidCodeFn1} (${hex(key.hidCodeFn1)})`,
      key.isFRow ? 'F 区模块键' : null,
    ]
      .filter(Boolean)
      .join('\n');
    cap.setAttribute('aria-pressed', selected.has(hardCode) ? 'true' : 'false');

    const title = document.createElement('span');
    title.className = 'cap-title';
    title.textContent = key.title || key.textCode || '?';

    const code = document.createElement('span');
    code.className = 'cap-code';
    code.textContent = key.hidCode == null ? '' : hex(key.hidCode);

    cap.append(title, code);
    fragment.append(cap);
  }

  els.keyboard.append(fragment);
  updateSelectionUI();
}

function toggleSelection(hardCode) {
  if (!Number.isFinite(hardCode)) return;
  if (selected.has(hardCode)) selected.delete(hardCode);
  else selected.add(hardCode);
  updateSelectionUI();
  syncControls();
}

function updateSelectionUI() {
  for (const cap of els.keyboard.querySelectorAll('.keycap')) {
    const hardCode = Number(cap.dataset.hardCode);
    const isSelected = selected.has(hardCode);
    cap.classList.toggle('is-selected', isSelected);
    cap.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  }

  const titles = hardCodesOfSelection().map(titleOfKey);
  if (!titles.length) {
    els.selectionInfo.textContent = '未选中任何键';
    els.selectionInfo.className = 'state state-muted';
    return;
  }

  const shown = titles.slice(0, 8).join('、');
  const suffix = titles.length > 8 ? ` 等 ${titles.length} 个` : '';
  els.selectionInfo.textContent = `已选 ${titles.length}：${shown}${suffix}`;
  els.selectionInfo.className = 'state state-on';

  if (selected.size === 1) {
    const key = keysByHardCode.get([...selected][0]);
    if (key) {
      if (Number.isFinite(key.travel)) els.travelPress.value = String(key.travel);
      if (Number.isFinite(key.travelUp) && key.travelUp > 0) els.travelRelease.value = String(key.travelUp);
      els.travelFast.checked = Boolean(key.isFast);
    }
    // Replace the static defaults with the values the device actually reports.
    scheduleTravelPrefill();
  }
}

// ---------------------------------------------------------------------------
// light
// ---------------------------------------------------------------------------

function applyLightToForm(light) {
  if (light.mode != null) els.lightMode.value = String(Math.max(0, Math.min(9, Number(light.mode) || 0)));
  if (light.speed != null) {
    els.lightSpeed.value = String(Math.max(0, Math.min(100, Number(light.speed) || 0)));
    els.lightSpeedOut.textContent = els.lightSpeed.value;
  }
  if (light.turn != null) {
    els.lightTurn.value = String(Number(light.turn) ? 1 : 0);
    els.lightTurnOut.textContent = els.lightTurn.value === '1' ? '反向' : '正向';
  }
  if (light.brightness != null) {
    els.lightBrightness.value = String(Math.max(0, Math.min(10, Number(light.brightness) || 0)));
    els.lightBrightnessOut.textContent = els.lightBrightness.value;
  }
  if (light.rgb) els.lightColor.value = normalizeHex(light.rgb, els.lightColor.value);
  if (light.colorful != null) els.lightColorful.checked = Boolean(Number(light.colorful));
}

async function applyLight() {
  const payload = {
    mode: Number(els.lightMode.value),
    speed: num(els.lightSpeed, 80),
    turn: Number(els.lightTurn.value),
    brightness: num(els.lightBrightness, 8),
    rgb: normalizeHex(els.lightColor.value).toUpperCase(),
    colorful: els.lightColorful.checked ? 1 : 0,
  };
  await kb.setLight(payload);
  log(
    `灯效已应用：mode=${payload.mode} speed=${payload.speed} turn=${payload.turn} ` +
      `brightness=${payload.brightness} rgb=${payload.rgb} colorful=${payload.colorful}`,
    'ok',
  );
}

async function readLight() {
  const light = await kb.getLight();
  applyLightToForm(light ?? {});
  showJson(els.lightOut, light, 2000);
  log('灯效已读取', 'ok');
}

async function applyKeyColor() {
  const hardCodes = hardCodesOfSelection();
  if (!hardCodes.length) throw new Error('请先选中至少一个键');
  const color = normalizeHex(els.keyColor.value).toUpperCase();
  await kb.setKeyColor(hardCodes, color);
  log(`已设置 ${hardCodes.length} 个键的颜色：${hardCodes.map((hc) => `${titleOfKey(hc)}=${color}`).join('、')}`, 'ok');
}

async function readKeyColors() {
  const colors = await kb.getKeyColors();
  showJson(els.keycolorOut, colors, 6000);
  log('键色已读取', 'ok');
}

// ---------------------------------------------------------------------------
// key configuration
// ---------------------------------------------------------------------------

function groupForTarget(entry) {
  const code = entry.textCode;
  if (/^Key[A-Z]$/.test(code)) return '字母';
  if (/^Digit\d$/.test(code)) return '数字';
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return '功能键';
  if (code.startsWith('Numpad') || code === 'NumLock') return '小键盘';
  if (/^(Control|Shift|Alt|Meta)/.test(code)) return '修饰键';
  if (/^(Arrow|Insert|Home|PageUp|Delete|End|PageDown|PrintScreen|ScrollLock|Pause)/.test(code)) {
    return '导航';
  }
  if (['Escape', 'Tab', 'CapsLock', 'Enter', 'Backspace', 'Space'].includes(code)) return '控制';
  return '符号';
}

const TARGET_GROUP_ORDER = ['字母', '数字', '功能键', '控制', '符号', '导航', '小键盘', '修饰键'];
const TARGET_DEFAULTS = {
  'target-select': 'F1',
  'tgl-target': 'F1',
  'mt-hold': 'F1',
  'mt-tap': 'KeyA',
  'mpt-target1': 'KeyA',
  'mpt-target2': 'KeyB',
  'mpt-target3': 'KeyC',
  'end-target': 'F1',
};

let targetEntries = normalizeTargetEntries(KEY_CATALOG);

function normalizeTargetEntries(rawEntries) {
  return rawEntries
    .map((entry) => {
      const usage = Number(entry.usage ?? entry.hidCode);
      return {
        title: entry.title || entry.textCode || `0x${usage.toString(16).toUpperCase()}`,
        textCode: entry.textCode || '',
        usage,
        category: entry.cateTitle || null,
      };
    })
    .filter((entry) => Number.isInteger(entry.usage) && entry.usage >= 0 && entry.usage <= 0xffff);
}

/**
 * The SDK's `resolveTargetUsage()` treats numbers as HID usages, so every
 * target option carries a HID usage as its value. This also exposes the media /
 * system / mouse / device entries that have no `textCode`.
 */
function populateTargetSelects(rawEntries = KEY_CATALOG) {
  targetEntries = normalizeTargetEntries(rawEntries);
  const grouped = new Map();

  if (targetEntries.some((entry) => entry.category)) {
    for (const entry of targetEntries) {
      const group = entry.category || '其他';
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(entry);
    }
  } else {
    for (const name of TARGET_GROUP_ORDER) grouped.set(name, []);
    for (const entry of targetEntries) {
      const group = groupForTarget(entry);
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(entry);
    }
  }

  for (const select of document.querySelectorAll('select[data-key-target]')) {
    const previous = select.value;
    select.textContent = '';
    for (const [label, entries] of grouped) {
      if (!entries.length) continue;
      const optgroup = document.createElement('optgroup');
      optgroup.label = label;
      for (const entry of entries) {
        const option = document.createElement('option');
        option.value = String(entry.usage);
        option.textContent = `${entry.title}${entry.textCode ? ` · ${entry.textCode}` : ''} · ${hex(entry.usage)}`;
        optgroup.append(option);
      }
      select.append(optgroup);
    }

    const options = [...select.options];
    const hasPrevious = previous !== '' && options.some((option) => option.value === previous);
    if (hasPrevious) {
      select.value = previous;
      continue;
    }
    const defaultCode = TARGET_DEFAULTS[select.id];
    const defaultEntry = targetEntries.find((entry) => entry.textCode === defaultCode);
    select.value = String(defaultEntry?.usage ?? targetEntries[0]?.usage ?? 0);
  }
}

function resolveTarget(input) {
  if (!input) throw new Error('目标键不存在');
  const usage = Number(input.value);
  if (!Number.isInteger(usage) || usage < 0 || usage > 0xffff) {
    throw new Error('目标键必须是 0..65535 的 HID usage');
  }
  return usage;
}

function targetLabel(usage) {
  const entry = targetEntries.find((item) => item.usage === usage);
  if (!entry) return `HID ${usage} (${hex(usage)})`;
  return entry.textCode ? `${entry.title} (${entry.textCode})` : entry.title;
}

async function remapSelection() {
  const hardCodes = hardCodesOfSelection();
  if (!hardCodes.length) throw new Error('请先选中至少一个键');
  const target = resolveTarget(els.targetSelect);
  const layer = Number(els.layerSelect.value);
  await captureRemapBeforeChange(layer, '重映射');
  for (const hardCode of hardCodes) {
    // verify: read the layer back and rewrite once if the firmware dropped the
    // report — a dropped write looks exactly like "重映射没有生效".
    await kb.setKeyRemap(hardCode, target, { layer, verify: true, settleMs: 250 });
    log(`重映射：${titleOfKey(hardCode)} → ${targetLabel(target)}（layer ${layer}，读回确认 ${hex(target, 4)}）`, 'ok');
  }
}

async function resetRemapSelection() {
  const hardCodes = hardCodesOfSelection();
  if (!hardCodes.length) throw new Error('请先选中至少一个键');
  const layer = Number(els.layerSelect.value) || 0;
  await captureRemapBeforeChange(layer, '恢复默认映射');
  const written = await kb.resetKeyRemap(hardCodes, { layer, settleMs: 300, verify: true });
  let map = new Map();
  try {
    map = await kb.getKeyMap(layer);
  } catch {
    // Read-back is best effort; the write itself already succeeded.
  }
  const details = written.map((hardCode) => {
    const current = map.get(hardCode)?.hidCode ?? 0;
    const fallback = keysByHardCode.get(hardCode)?.hidCode ?? 0;
    return `${titleOfKey(hardCode)}→0x${hex(current, 4)}${current === fallback ? '（默认）' : ''}`;
  });
  log(`已恢复 ${written.length} 个键的重映射（layer ${layer}）：${details.join('、')}`, 'ok');
}

/**
 * Record the layer's current remap before a write, so "恢复到本次修改前" can put
 * it back. Best effort: a failed snapshot must not block the edit itself.
 */
async function captureRemapBeforeChange(layer, action) {
  try {
    const snapshot = await kb.captureRemapSnapshot({ layers: [layer] });
    remapUndo.push({ layer, snapshot, action, at: new Date() });
    while (remapUndo.length > REMAP_UNDO_LIMIT) remapUndo.shift();
    log(`已记录 layer ${layer} 的「本次修改前」快照（可回退 ${remapUndo.length} 次）`);
  } catch (err) {
    log(`记录「本次修改前」快照失败：${errorDetail(err)}`, 'warn');
  }
  updateRemapUndoHint();
}

function updateRemapUndoHint() {
  const hint = els.remapUndoHint;
  if (!hint) return;
  if (!kb) {
    hint.textContent = '本次修改前：连接键盘后可用。';
    return;
  }
  if (!remapUndo.length) {
    hint.textContent = '本次修改前：暂无记录，先做一次重映射或恢复默认映射。';
    return;
  }
  const entry = remapUndo.at(-1);
  const time = entry.at.toLocaleTimeString('zh-CN', { hour12: false });
  const layers = Object.keys(entry.snapshot.layers).join(' / ');
  hint.textContent = `本次修改前：可回退 ${remapUndo.length} 次 · 最近一次在 ${time}（${entry.action}，layer ${layers}）。`;
}

async function undoRemapSelection() {
  const entry = remapUndo.at(-1);
  if (!entry) throw new Error('没有「本次修改前」的记录，请先修改一次映射');
  remapUndo.pop();
  updateRemapUndoHint();
  let result;
  try {
    result = await kb.restoreRemapSnapshot(entry.snapshot, { settleMs: 300, verify: true });
  } catch (err) {
    remapUndo.push(entry);
    updateRemapUndoHint();
    throw err;
  }
  if (!result.written) {
    log('已恢复到本次修改前：当前映射与快照一致，未写入任何键', 'ok');
    return;
  }
  const details = result.entries.map(
    (item) => `${item.title} ${hex(item.from, 4)}→${hex(item.to, 4)}`,
  );
  const parts = [`已恢复到本次修改前（layer ${entry.layer}）：写入 ${result.written} 个键并已回读确认`];
  if (result.unchanged) parts.push(`${result.unchanged} 个键已一致`);
  if (result.skipped) parts.push(`${result.skipped} 个键不在当前布局`);
  log(`${parts.join('，')}；${details.join('、')}`, 'ok');
}

async function setRSSelection() {
  const [key1, key2] = requireSelection(2);
  await kb.setRS({ key1, key2 });
  log(`RS：${titleOfKey(key1)} / ${titleOfKey(key2)}`, 'ok');
}

async function setSOCDSelection() {
  const [key1, key2] = requireSelection(2);
  await kb.setSOCD({ key1, key2 });
  log(`SOCD：${titleOfKey(key1)} / ${titleOfKey(key2)}`, 'ok');
}

async function setMTSelection() {
  const [key] = requireSelection(1);
  const hold = resolveTarget(els.mtHold);
  const tap = resolveTarget(els.mtTap);
  const ms = num(els.mtMs, 200);
  await kb.setMT({ key, hold, tap, ms });
  log(`MT：${titleOfKey(key)} hold=${targetLabel(hold)} tap=${targetLabel(tap)} ms=${ms}`, 'ok');
}

async function setTGLSelection() {
  const [key] = requireSelection(1);
  const target = resolveTarget(els.tglTarget);
  await kb.setTGL({ key, target });
  log(`TGL：${titleOfKey(key)} → ${targetLabel(target)}`, 'ok');
}

async function setMPTSelection() {
  const [key] = requireSelection(1);
  const targets = [els.mptTarget1, els.mptTarget2, els.mptTarget3].map(resolveTarget);
  const mm = [num(els.mptMm1, 0.1), num(els.mptMm2, 0.2), num(els.mptMm3, 0.3)];
  if (!(mm[0] < mm[1] && mm[1] < mm[2])) {
    throw new Error('MPT 三个行程点必须严格递增');
  }
  await kb.setMPT({ key, targets, mm });
  log(`MPT：${titleOfKey(key)} → ${targets.map(targetLabel).join(' / ')} @ ${mm.join(' / ')}mm`, 'ok');
}

async function setENDSelection() {
  const [key] = requireSelection(1);
  const target = resolveTarget(els.endTarget);
  const ms = num(els.endMs, 10);
  await kb.setEND({ key, target, ms });
  log(`END：${titleOfKey(key)} → ${targetLabel(target)} @ ${ms}ms`, 'ok');
}

async function clearFeatures() {
  const hardCodes = hardCodesOfSelection();
  if (!hardCodes.length) throw new Error('请先选中至少一个键');
  for (const hardCode of hardCodes) {
    await kb.clearFeature(hardCode);
    log(`已清除 ${titleOfKey(hardCode)} 的高级功能`, 'ok');
  }
}

async function readFeatures() {
  const hardCodes = hardCodesOfSelection();
  if (!hardCodes.length) throw new Error('请先选中至少一个键');
  const result =
    typeof kb.getFeature === 'function'
      ? await kb.getFeature(hardCodes[0])
      : await kb.getFeatures();
  showJson(els.featureOut, result, 6000);
  log(`已读取 ${titleOfKey(hardCodes[0])} 的高级功能`, 'ok');
}

async function readWinLock() {
  const value = await kb.getWinLock();
  els.winlockValue.checked = Boolean(value);
  els.winlockState.textContent = `锁 Win：${value ? '开' : '关'}`;
  els.winlockState.className = 'state state-on';
  log(`锁 Win：${value ? '开' : '关'}`, 'ok');
}

async function setWinLock() {
  const value = els.winlockValue.checked;
  await kb.setWinLock(value);
  els.winlockState.textContent = `锁 Win：${value ? '开' : '关'}`;
  els.winlockState.className = 'state state-on';
  log(`锁 Win 已设置为 ${value ? '开' : '关'}`, 'ok');
}

async function setLightSleep() {
  const minutes = num(els.lightSleep, 10);
  await kb.setLightSleep(minutes);
  log(`灯效休眠已设置为 ${minutes} 分钟`, 'ok');
}

async function restoreDefaults() {
  if (!window.confirm('恢复出厂默认会覆盖当前灯效/按键/行程配置，确定继续？')) {
    log('已取消恢复默认。', 'warn');
    return;
  }
  await kb.restoreDefaults();
  log('已请求恢复默认配置', 'ok');
}

// ---------------------------------------------------------------------------
// travel
// ---------------------------------------------------------------------------

let travelPrefillTimer = 0;

/** Load the selected key's current travel config into the form. */
async function prefillSelectedTravel() {
  if (!kb || selected.size !== 1) return;
  const hardCode = [...selected][0];
  try {
    const entry = await kb.getKeyTravel(hardCode);
    if (!entry || selected.size !== 1) return;
    els.travelPress.value = String(entry.pressMm);
    els.travelDeadDown.value = String(entry.deadDownMm);
    els.travelDeadUp.value = String(entry.deadUpMm);
    els.travelFast.checked = Boolean(entry.fast);
    if (entry.fast) {
      els.travelRelease.value = String(entry.releaseMm);
      els.travelFastOut.value = String(entry.fastOutMm);
    }
    els.travelReadback.hidden = false;
    els.travelReadback.textContent =
      `${titleOfKey(hardCode)}（hardCode ${hardCode}）当前行程：\n` +
      JSON.stringify(entry, null, 2);
  } catch {
    // Reading travel is best effort; the form keeps its current values.
  }
}

function scheduleTravelPrefill() {
  if (!kb || selected.size !== 1) return;
  clearTimeout(travelPrefillTimer);
  travelPrefillTimer = setTimeout(() => {
    void prefillSelectedTravel();
  }, 200);
}

async function applyTravel() {
  const hardCodes = hardCodesOfSelection();
  if (!hardCodes.length) throw new Error('请先选中至少一个键');
  const entry = {
    pressMm: num(els.travelPress, 2),
    releaseMm: num(els.travelRelease, 1.8),
    deadDownMm: num(els.travelDeadDown, 0.2),
    deadUpMm: num(els.travelDeadUp, 0.2),
    fastOutMm: num(els.travelFastOut, 0.1),
    fast: els.travelFast.checked,
  };

  if (hardCodes.length === 1) {
    // Single-key path: only this key is touched.
    const hardCode = hardCodes[0];
    await kb.setKeyTravel(hardCode, entry);
    log(
      `已单独设置 ${titleOfKey(hardCode)}（hardCode ${hardCode}）行程：press=${entry.pressMm} ` +
        `dead=${entry.deadDownMm}/${entry.deadUpMm} fast=${entry.fast}` +
        (entry.fast ? ` release=${entry.releaseMm} fastOut=${entry.fastOutMm}` : ''),
      'ok',
    );
  } else {
    const config = hardCodes.map((key) => ({ key, ...entry }));
    await kb.setTravelConfig(config);
    log(`行程已批量应用（${hardCodes.length} 键）：press=${entry.pressMm} release=${entry.releaseMm}`, 'ok');
  }

  await sleepMs(250);
  await prefillSelectedTravel();
}

async function readTravelConfig() {
  if (selected.size === 1) {
    await prefillSelectedTravel();
    log('已读取选中键的行程配置', 'ok');
    return;
  }
  const config = await kb.getTravelConfig();
  showJson(els.travelReadback, config, 6000);
  log('行程配置已读取（全部键）', 'ok');
}

// ---------------------------------------------------------------------------
// key test + travel visualization
// ---------------------------------------------------------------------------

function ensureTravelRow(hardCode, key) {
  let row = travelRows.get(hardCode);
  if (row) return row;

  const rowEl = document.createElement('div');
  rowEl.className = 'travel-row';

  const title = document.createElement('span');
  title.className = 'travel-title';
  title.textContent = key?.title ?? key?.textCode ?? `#${hardCode}`;
  title.title = `${title.textContent} (hardCode ${hardCode})`;

  const track = document.createElement('div');
  track.className = 'travel-track';
  const fill = document.createElement('div');
  fill.className = 'travel-fill';
  track.append(fill);

  const value = document.createElement('span');
  value.className = 'travel-value';
  value.textContent = '0.00';

  rowEl.append(title, track, value);

  if (els.travelBars.querySelector('.empty')) els.travelBars.textContent = '';
  els.travelBars.append(rowEl);

  row = { rowEl, fill, value };
  travelRows.set(hardCode, row);
  travelOrder.push(hardCode);
  while (travelOrder.length > 40) {
    const oldest = travelOrder.shift();
    travelRows.get(oldest)?.rowEl.remove();
    travelRows.delete(oldest);
  }
  els.travelBars.scrollTop = els.travelBars.scrollHeight;
  return row;
}

function handleKeyTravel(payload) {
  const hardCode = Number(payload?.hardCode);
  if (!Number.isFinite(hardCode)) return;
  const mm = Number(payload?.mm);
  const key = payload?.key ?? keysByHardCode.get(hardCode) ?? null;
  pendingTravel.set(hardCode, { mm: Number.isFinite(mm) ? mm : 0, key });

  if (!travelRaf) {
    travelRaf = requestAnimationFrame(flushTravel);
  }
}

function flushTravel() {
  travelRaf = 0;
  for (const [hardCode, { mm, key }] of pendingTravel) {
    const row = ensureTravelRow(hardCode, key);
    const percent = Math.max(0, Math.min(100, (mm / MAX_TRAVEL_MM) * 100));
    row.fill.style.width = `${percent.toFixed(1)}%`;
    row.value.textContent = mm.toFixed(2);
    row.rowEl.classList.remove('is-released');

    // Do not append an event for every animation frame: log the press edge and
    // then at most ~5 events/second per key.
    const now = performance.now();
    const last = travelEventState.get(hardCode);
    const pressed = last ? last.mm <= 0.05 && mm > 0.05 : mm > 0.05;
    if (!last || pressed || now - last.at >= 180) {
      addEvent(`${key?.title || key?.textCode || `#${hardCode}`} 行程`, `${mm.toFixed(2)} mm`);
      travelEventState.set(hardCode, { at: now, mm });
    } else {
      last.mm = mm;
    }
  }
  pendingTravel.clear();
}

function handleKeyRelease(payload) {
  const hardCode = Number(payload?.hardCode);
  if (!Number.isFinite(hardCode)) return;
  const key = payload?.key ?? keysByHardCode.get(hardCode) ?? null;
  const row = ensureTravelRow(hardCode, key);
  row.rowEl.classList.add('is-released');
  addEvent(`${key?.title || key?.textCode || `#${hardCode}`} 抬起`, 'release');
  travelEventState.set(hardCode, { at: performance.now(), mm: 0 });
}

function addEvent(name, value) {
  if (els.eventList.querySelector('.empty')) els.eventList.textContent = '';
  const li = document.createElement('li');
  const nameEl = document.createElement('span');
  nameEl.className = 'ev-name';
  nameEl.textContent = name;
  const valueEl = document.createElement('span');
  valueEl.className = 'ev-value';
  valueEl.textContent = value;
  li.append(nameEl, valueEl);
  els.eventList.prepend(li);
  while (els.eventList.childElementCount > MAX_EVENTS) {
    els.eventList.lastElementChild?.remove();
  }
}

async function startKeyTest() {
  const mode = els.testMode.value;
  await kb.startKeyTest({ mode });
  testRunning = true;
  els.testState.textContent = `运行中（${mode}）`;
  els.testState.className = 'state state-on';
  log(`按键测试已开始（${mode}）`, 'ok');
  syncControls();
}

async function stopKeyTest() {
  await kb.stopKeyTest();
  testRunning = false;
  els.testState.textContent = '已停止';
  els.testState.className = 'state state-muted';
  log('按键测试已停止', 'ok');
  syncControls();
}

function clearTestOutput() {
  travelRows.clear();
  travelOrder.length = 0;
  travelEventState.clear();
  pendingTravel.clear();
  els.travelBars.innerHTML = '<p class="empty">开始测试并按压键盘后显示。</p>';
  els.eventList.innerHTML = '<li class="empty">暂无事件</li>';
  inputFrames = 0;
  inputCmdCounts = new Map();
  loggedInputCmds = new Set();
  els.inputCount.textContent = 'input 帧：0';
  log('测试输出已清空');
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

function refreshScreenStatus() {
  if (!kb) {
    els.screenSupported.textContent = '屏幕：未知';
    els.screenSupported.className = 'badge badge-muted';
    els.screenState.textContent = '未连接';
    els.screenState.className = 'state state-off';
    syncControls();
    return;
  }

  const supported = screenSupported();
  els.screenSupported.textContent = supported ? '屏幕：支持' : '屏幕：不支持';
  els.screenSupported.className = `badge ${supported ? 'badge-ok' : 'badge-bad'}`;

  screenOpen = isScreenOpen();
  els.screenState.textContent = screenOpen ? '已连接' : '未连接';
  els.screenState.className = `state ${screenOpen ? 'state-on' : 'state-off'}`;
  syncControls();
}

async function openScreenLink() {
  if (!kb) return;
  if (!screenSupported()) throw new Error('该设备未报告屏幕支持（kb.screen.supported === false）');
  log('请求串口授权并打开屏幕…（Web Serial 需要用户手势）');
  try {
    await kb.openScreen();
  } finally {
    screenOpen = isScreenOpen();
    refreshScreenStatus();
  }
  log(`屏幕已连接：${screenOpen ? '是' : '状态未知'}`, 'ok');
}

async function closeScreenLink() {
  if (!kb) return;
  await kb.closeScreen();
  screenOpen = false;
  refreshScreenStatus();
  log('屏幕已断开', 'ok');
}

function startScreenPolling() {
  stopScreenPolling();
  screenTimer = window.setInterval(() => {
    if (!kb) {
      stopScreenPolling();
      return;
    }
    if (typeof kb.screen?.isOpen !== 'boolean') return;
    if (kb.screen.isOpen !== screenOpen) {
      screenOpen = kb.screen.isOpen;
      refreshScreenStatus();
      log(`屏幕状态变化：${screenOpen ? '已连接' : '已断开'}`, screenOpen ? 'ok' : 'warn');
    }
  }, 1000);
}

function stopScreenPolling() {
  if (screenTimer) {
    clearInterval(screenTimer);
    screenTimer = 0;
  }
}

async function fileToBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch (err) {
      log(`createImageBitmap() 失败，回退到 <img>：${errorDetail(err)}`, 'warn');
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function prepareScreenImage(file) {
  const bitmap = await fileToBitmap(file);
  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  if (!width || !height) throw new Error('无法读取图片尺寸');

  const ctx = screenCtx;
  ctx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

  const scale = Math.max(SCREEN_WIDTH / width, SCREEN_HEIGHT / height);
  const drawW = width * scale;
  const drawH = height * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (SCREEN_WIDTH - drawW) / 2, (SCREEN_HEIGHT - drawH) / 2, drawW, drawH);

  if (typeof bitmap.close === 'function') bitmap.close();

  const imageData = ctx.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  return {
    fileName: file.name,
    sourceWidth: width,
    sourceHeight: height,
    imageData,
  };
}

function setProgress(percent, text) {
  els.screenProgress.value = Math.max(0, Math.min(100, percent));
  if (text != null) els.screenProgressText.textContent = text;
}

async function sendScreenImage() {
  if (!kb) throw new Error('键盘未连接');
  if (!screenImage) throw new Error('请先选择 PNG/JPEG 图片');
  if (!screenSupported()) throw new Error('该设备不支持屏幕');
  if (!isScreenOpen()) throw new Error('屏幕未连接，请先点击「连接屏幕」');

  const { imageData, fileName } = screenImage;
  const payload = {
    frames: [{ data: imageData.data, width: SCREEN_WIDTH, height: SCREEN_HEIGHT }],
    name: (fileName.replace(/\.[^.]+$/, '').replace(/[^\x20-\x7e]/g, '') || 'zmeow').slice(0, 15),
    onProgress: (progress) => {
      const percent = Number(progress?.percent);
      if (!Number.isFinite(percent)) return;
      const sent = Number(progress?.sentBytes);
      const total = Number(progress?.totalBytes);
      const suffix =
        Number.isFinite(sent) && Number.isFinite(total) ? `（${sent}/${total} 字节）` : '';
      setProgress(percent, `${progress?.phase ?? '传输'} ${percent.toFixed(1)}%${suffix}`);
    },
  };
  const started = performance.now();
  sendingScreen = true;
  syncControls();
  setProgress(0, `准备发送 ${fileName}…`);
  log(`开始发送屏幕图像：${fileName} → ${SCREEN_WIDTH}×${SCREEN_HEIGHT}（RGBA ${imageData.data.length} 字节）`);

  try {
    await kb.screen.sendImage(payload);
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);
    setProgress(100, `发送完成 · ${fileName} · ${elapsed}s`);
    log(`屏幕图像发送完成（${elapsed}s）`, 'ok');
  } catch (err) {
    setProgress(0, `发送失败：${errorDetail(err)}`);
    throw err;
  } finally {
    sendingScreen = false;
    syncControls();
  }
}

// ---------------------------------------------------------------------------
// event wiring
// ---------------------------------------------------------------------------

/**
 * End a running key test before a configuration write.
 *
 * A device left in the `cmd 48` stream keeps reporting travel instead of typing,
 * so every write button calls this first and says so in the log. Reads and the
 * test buttons themselves pass `{ write: false }`.
 */
async function ensureTestStopped(actionLabel) {
  if (!kb || !testRunning) return;
  try {
    await kb.stopKeyTest();
    // Give the firmware a moment to leave the cmd 48 stream before any write:
    // config reads issued too early after test-end can time out.
    await sleepMs(400);
    log(`写配置前已自动结束按键测试（${actionLabel}）`, 'warn');
  } catch (err) {
    log(`自动结束按键测试失败：${errorDetail(err)}`, 'warn');
  } finally {
    testRunning = false;
    els.testState.textContent = '已停止';
    els.testState.className = 'state state-muted';
  }
}

function runAction(button, label, fn, options = {}) {
  button.addEventListener('click', async () => {
    if (!kb) {
      log('键盘未连接', 'warn');
      return;
    }
    button.disabled = true;
    try {
      if (options.write !== false) await ensureTestStopped(label);
      await fn();
    } catch (err) {
      logError(label, err);
    } finally {
      syncControls();
    }
  });
}

function wireEvents() {
  els.btnConnect.addEventListener('click', () => {
    void connectKeyboard();
  });
  els.btnDisconnect.addEventListener('click', () => {
    void disconnectKeyboard();
  });
  // Reload / tab close during a key test would otherwise leave the firmware in
  // its cmd 48 stream. Chrome may not flush the report during unload, which is
  // why disconnect() and the write guards also send the end command.
  window.addEventListener('pagehide', () => {
    if (!kb || !testRunning) return;
    try {
      void kb.stopKeyTest().catch(() => undefined);
    } catch {
      // ignore
    }
  });
  if (els.btnDiagnose) {
    els.btnDiagnose.addEventListener('click', () => {
      void diagnoseInterfaces();
    });
  }

  els.keyboard.addEventListener('click', (event) => {
    const cap = event.target.closest('.keycap');
    if (!cap) return;
    toggleSelection(Number(cap.dataset.hardCode));
  });

  els.btnClearSelection.addEventListener('click', () => {
    selected.clear();
    updateSelectionUI();
    syncControls();
    log('已清空选择');
  });

  els.lightSpeed.addEventListener('input', () => {
    els.lightSpeedOut.textContent = els.lightSpeed.value;
  });
  els.lightTurn.addEventListener('input', () => {
    els.lightTurnOut.textContent = els.lightTurn.value === '1' ? '反向' : '正向';
  });
  els.lightBrightness.addEventListener('input', () => {
    els.lightBrightnessOut.textContent = els.lightBrightness.value;
  });

  runAction(els.btnLightApply, '应用灯效', applyLight);
  runAction(els.btnLightRead, '读取灯效', readLight, { write: false });
  runAction(els.btnKeyColor, '设置单键颜色', applyKeyColor);
  runAction(els.btnKeyColorsRead, '读取键色', readKeyColors, { write: false });

  runAction(els.btnRemap, '重映射', remapSelection);
  runAction(els.btnRemapReset, '恢复默认映射', resetRemapSelection);
  runAction(els.btnRemapUndo, '恢复到本次修改前', undoRemapSelection);
  runAction(els.btnRs, '设置 RS', setRSSelection);
  runAction(els.btnSocd, '设置 SOCD', setSOCDSelection);
  runAction(els.btnClearFeature, '清除高级功能', clearFeatures);
  runAction(els.btnMt, '设置 MT', setMTSelection);
  runAction(els.btnTgl, '设置 TGL', setTGLSelection);
  runAction(els.btnMpt, '设置 MPT', setMPTSelection);
  runAction(els.btnEnd, '设置 END', setENDSelection);
  runAction(els.btnReadFeatures, '读取高级功能', readFeatures, { write: false });
  runAction(els.btnWinlockRead, '读取锁 Win', readWinLock, { write: false });
  runAction(els.btnWinlockSet, '设置锁 Win', setWinLock);
  runAction(els.btnLightSleep, '设置灯效休眠', setLightSleep);
  runAction(els.btnRestoreDefaults, '恢复默认', restoreDefaults);

  runAction(els.btnTravelApply, '应用行程', applyTravel);
  runAction(els.btnTravelRead, '读取行程配置', readTravelConfig, { write: false });

  runAction(els.btnTestStart, '开始按键测试', startKeyTest, { write: false });
  runAction(els.btnTestStop, '停止按键测试', stopKeyTest, { write: false });
  els.btnTestClear.addEventListener('click', clearTestOutput);

  // Screen open MUST be invoked synchronously from the click handler so Web
  // Serial still sees a user gesture. openScreenLink() calls openScreen() before
  // its first await, so this is safe.
  els.btnScreenOpen.addEventListener('click', async () => {
    if (!kb) {
      log('键盘未连接', 'warn');
      return;
    }
    els.btnScreenOpen.disabled = true;
    try {
      await openScreenLink();
    } catch (err) {
      logError('连接屏幕', err);
    } finally {
      refreshScreenStatus();
      syncControls();
    }
  });

  els.btnScreenClose.addEventListener('click', async () => {
    if (!kb) return;
    els.btnScreenClose.disabled = true;
    try {
      await closeScreenLink();
    } catch (err) {
      logError('断开屏幕', err);
    } finally {
      refreshScreenStatus();
      syncControls();
    }
  });

  els.screenFile.addEventListener('change', async () => {
    const file = els.screenFile.files?.[0];
    if (!file) return;
    try {
      if (!/^image\/(png|jpeg)$/.test(file.type)) {
        throw new Error('只支持 PNG / JPEG 图片');
      }
      screenImage = await prepareScreenImage(file);
      const { sourceWidth, sourceHeight, imageData } = screenImage;
      setProgress(0, `${file.name} · ${sourceWidth}×${sourceHeight} → ${SCREEN_WIDTH}×${SCREEN_HEIGHT} · ${(imageData.data.length / 1024).toFixed(0)} KiB`);
      log(`图片已处理：${file.name}（${sourceWidth}×${sourceHeight} → 194×368）`, 'ok');
      // Allow picking the same file again after a send.
      els.screenFile.value = '';
      syncControls();
      if (els.screenAutoSend.checked) {
        await sendScreenImage();
      }
    } catch (err) {
      logError('处理屏幕图片', err);
      screenImage = null;
      setProgress(0, '等待图片…');
      syncControls();
    }
  });

  els.btnScreenSend.addEventListener('click', async () => {
    els.btnScreenSend.disabled = true;
    try {
      await sendScreenImage();
    } catch (err) {
      logError('发送屏幕图像', err);
    } finally {
      syncControls();
    }
  });

  els.btnLogClear.addEventListener('click', () => {
    els.log.textContent = '';
    log('日志已清空');
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  populateTargetSelects();
  wireEvents();
  await loadSdk();
  updateHidSupport();
  syncControls();

  log('Playground 已就绪。连接键盘后即可读取设备信息。');
  if (sdkError) {
    log('SDK 未就绪：页面 UI 可用，但连接按钮会保持禁用，直到 dist/index.js 构建完成。', 'warn');
  }
}

void boot();
