/*
 * Dependency-free fake official-driver page for the Better ZetsuMeow Driver simulator.
 *
 * This file is loaded BEFORE dist/better-zmeow-driver.user.js. It:
 *   1. fakes the WebHID / Web Serial objects the official driver talks to by
 *      replacing HIDDevice.prototype / SerialPort.prototype methods and the
 *      navigator.hid / navigator.serial objects;
 *   2. publishes the official driver's global `window.data` shape;
 *   3. runs a scripted HID flow (cmd 1 + cmd 2/19) and a serial flow (cmd 112),
 *      then exercises the userscript's active-connection entry points;
 *   4. mirrors the observed state into window.__ZMEOW_SIMULATOR__ and the visible
 *      <pre id="results"> element.
 *
 * No imports, no build step, no external dependencies. Chromium only: it needs
 * the real HIDDevice / SerialPort globals as the base for the fake prototypes.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Product / protocol constants (kept in sync with the generated SDK product).
  // ---------------------------------------------------------------------------

  var PRODUCT = {
    id: 10011,
    title: 'Zetsu63',
    vid: 14470,
    pid: 16385,
    pidScreen: 16385,
    usage: 1,
    usagePages: [65280, 255],
    headNum: 0xab,
    headNumScreen: 0xab,
  };

  var PRODUCT_RECORD = {
    id: PRODUCT.id,
    title: PRODUCT.title,
    vid: PRODUCT.vid,
    pid: PRODUCT.pid,
    pid_screen: PRODUCT.pidScreen,
    usage: PRODUCT.usage,
    usagePage: PRODUCT.usagePages.join(','),
    head_num: '0x' + PRODUCT.headNum.toString(16),
    head_num_screen: '0x' + PRODUCT.headNumScreen.toString(16),
    cate_id: 1,
    f_id: 0,
    fm_id: 9,
  };

  var HID_REPORT_SIZE = 64;
  var HID_HEAD = 0xab;
  var SERIAL_HEAD = 0xab;
  var SERIAL_HEADER_SIZE = 7;

  // Own-property keys used to keep fake state off the (brand-checked) real
  // WebIDL instances. The fake instances are Object.create(HIDDevice.prototype)
  // and Object.create(SerialPort.prototype), so prototype patches apply.
  var HID_STATE_KEY = '__zmeowFakeHidState';
  var SERIAL_STATE_KEY = '__zmeowFakeSerialState';

  // ---------------------------------------------------------------------------
  // Simulator result object (the deliverable contract).
  // ---------------------------------------------------------------------------

  var results = {
    // Contract fields.
    ready: false,
    hidOut: 0,
    hidIn: 0,
    serialOut: 0,
    serialIn: 0,
    pageInputOk: false,
    pageSerialOk: false,
    panelPresent: false,
    errors: [],

    // Extra evidence (safe to ignore; useful when debugging the simulator).
    readyAt: null,
    steps: [],
    environment: {},
    sdkNotes: [],
    targets: {},
    fakeHid: { requests: [], sent: [], replies: [], emits: 0 },
    fakeKeyboard: { remapWrites: 0, colorWrites: 0, travelWrites: 0 },
    fakeSerial: { requests: [], writes: [], pushes: [] },
    page: { inputFrames: [], serialFrames: [] },
    flow: { hid: null, serial: null },
    activeEntryPoints: null,
    active: { keyboard: null, screen: null, disconnect: null },
    panel: { buttons: [], state: null, phase: null, logLines: 0 },
    tap: { state: null, firmware: null, reasons: [] },
  };

  window.__ZMEOW_SIMULATOR__ = results;

  function recordError(step, error) {
    var message = error instanceof Error ? error.name + ': ' + error.message : String(error);
    results.errors.push(step + ': ' + message);
    try {
      console.warn('[simulator] ' + step, error);
    } catch (_ignored) {
      // console may be overridden by the page under test; never fail here.
    }
    render();
  }

  function note(step) {
    results.steps.push(step);
  }

  // ---------------------------------------------------------------------------
  // Small byte helpers (no SDK imports).
  // ---------------------------------------------------------------------------

  function copyBytes(value) {
    if (value instanceof Uint8Array) return value.slice();
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    }
    return null;
  }

  function hex(bytes) {
    var out = '';
    for (var index = 0; index < bytes.length; index += 1) {
      out += bytes[index].toString(16).padStart(2, '0');
    }
    return out;
  }

  function bytesEqual(left, right) {
    if (left.length !== right.length) return false;
    for (var index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  function asciiInto(target, offset, text) {
    for (var index = 0; index < text.length; index += 1) {
      target[offset + index] = text.charCodeAt(index) & 0xff;
    }
  }

  /** HID report: [head, length, command, checksum, payload..., zero pad]. */
  function buildHidFrame(command, payload) {
    var bytes = new Uint8Array(HID_REPORT_SIZE);
    bytes[0] = HID_HEAD;
    bytes[1] = payload.length;
    bytes[2] = command & 0xff;
    bytes.set(payload, 4);
    var last = payload.length > 0 ? payload[payload.length - 1] & 0xff : 0;
    bytes[3] = (payload.length + (command & 0xff) + last) & 0xff;
    return bytes;
  }

  /** cmd 1 reply: firmware 1.1.1, run mode app (frame byte 5 === 1). */
  function buildHidInfoResponse() {
    var payload = new Array(34).fill(0);
    payload[1] = 1;
    asciiInto(payload, 2, 'SIMULATOR0001');
    asciiInto(payload, 23, '1.1.1');
    return buildHidFrame(1, payload);
  }

  // ---------------------------------------------------------------------------
  // Fake keyboard protocol state.
  //
  // A minimal but faithful stand-in for the Zetsu63 firmware: it keeps the same
  // on-device tables the SDK reads and writes (remap layers, key colours,
  // travel, features, light, misc) and replies with the frame shapes documented
  // in docs/PROTOCOL.md §4 / §9.3 — multi-frame reads, shortened declared
  // length bytes (cmd 2 L=2, cmd 19 L=8), values at absolute frame offsets.
  // Writes are accepted silently (no ack frame), matching how the SDK treats
  // them as fire-and-forget and verifies by reading back.
  //
  // Base table: compact65 [hardCode, hidCode, hidCodeFn1] (0 = unassigned),
  // extracted from packages/zmeow-sdk/src/generated/product-zetsu63.ts. Every
  // key ships with the generated defaults: 2 mm travel, 0.2 mm dead zone.
  // ---------------------------------------------------------------------------

  var FAKE_KEYS = [
    [13,53,0], [14,30,0], [15,31,0], [16,32,0], [17,33,0],
    [18,34,0], [19,35,0], [20,36,0], [21,37,0], [22,38,0],
    [23,39,0], [24,45,0], [25,46,0], [26,42,0], [27,43,0],
    [28,20,0], [29,26,0], [30,8,0], [31,21,0], [32,23,0],
    [33,28,0], [34,24,4279], [35,12,4490], [36,18,4643], [37,19,4301],
    [38,47,26632], [39,48,4498], [40,49,4322], [41,57,0], [42,4,62240],
    [43,22,62241], [44,7,62242], [45,9,62243], [46,10,62244], [47,11,62245],
    [48,13,0], [49,14,0], [50,15,0], [51,51,0], [52,52,0],
    [53,40,0], [54,225,0], [55,29,62224], [56,27,62225], [57,6,0],
    [58,25,0], [59,5,0], [60,17,0], [61,16,0], [62,54,0],
    [63,55,0], [64,56,0], [65,229,0], [66,224,0], [67,227,62217],
    [68,226,0], [69,44,0], [70,230,0], [78,75,4329], [81,78,4330],
    [82,82,62226], [83,80,62229], [84,81,62227], [85,79,62228], [170,40961,0],
  ];

  var REMAP_PER_FRAME = 17;
  var KEY_COLOR_PER_FRAME = 11;
  var TRAVEL_PER_FRAME = 4;
  var FEATURE_PAIRS_PER_FRAME = 29;
  var TRAVEL_UM_PER_MM = 10000;
  var DEFAULT_TRAVEL_MM = 2;
  var DEFAULT_DEAD_MM = 0.2;

  var keyboardState = createKeyboardState();

  function createKeyboardState() {
    var state = {
      // layer index -> { hardCode -> hid usage (0 = unassigned) }
      layers: [{}, {}, {}],
      // hardCode -> [r, g, b, gray]
      colors: {},
      // hardCode -> { hardCode, type, dd, du, tr, fo, up, dn } (millimetres)
      travel: {},
      // hardCode -> feature command byte (0 = none)
      features: {},
      light: { mode: 1, speed: 3, turn: 0, brightness: 5, r: 255, g: 64, b: 0, colorful: 1 },
      winLock: 0,
      lightSleep: 30,
      pzNum: 1,
      fMode: 65,
      keyTestMode: 0,
    };
    FAKE_KEYS.forEach(function (entry) {
      var hardCode = entry[0];
      state.layers[0][hardCode] = entry[1];
      state.layers[1][hardCode] = entry[2];
      state.layers[2][hardCode] = 0;
      state.travel[hardCode] = {
        hardCode: hardCode,
        type: 1,
        dd: DEFAULT_DEAD_MM,
        du: DEFAULT_DEAD_MM,
        tr: DEFAULT_TRAVEL_MM,
        fo: 0,
        up: DEFAULT_TRAVEL_MM,
        dn: DEFAULT_TRAVEL_MM,
      };
    });
    // A few seeded colours so `getKeyColors()` has something to merge.
    var seeded = [
      [13, 255, 0, 0], [14, 255, 64, 0], [20, 255, 255, 0],
      [34, 0, 255, 0], [57, 0, 96, 255], [170, 128, 0, 255],
    ];
    seeded.forEach(function (color) {
      state.colors[color[0]] = [color[1], color[2], color[3], 5];
    });
    return state;
  }

  function chunked(values, size) {
    var out = [];
    for (var offset = 0; offset < values.length; offset += size) {
      out.push(values.slice(offset, offset + size));
    }
    return out;
  }

  function sortedHardCodes(table) {
    return Object.keys(table).map(Number).sort(function (left, right) {
      return left - right;
    });
  }

  function mmBytes(mm) {
    var micro = Math.round(mm * TRAVEL_UM_PER_MM);
    return [(micro >>> 8) & 0xff, micro & 0xff];
  }

  /**
   * Build a 64-byte input report with an explicit declared length byte.
   *
   * The real firmware reports shorter `[1]` values than the fields it writes
   * (cmd 2 declares 2 with the value at frame byte 6, cmd 19 declares 8 with
   * `colorful` at frame byte 12); decoders read absolute offsets, so the
   * checksum uses the declared length like `buildHidFrame` does.
   */
  function buildFakeFrame(command, declaredLength, fill) {
    var bytes = new Uint8Array(HID_REPORT_SIZE);
    bytes[0] = HID_HEAD;
    bytes[1] = declaredLength & 0xff;
    bytes[2] = command & 0xff;
    fill(bytes);
    var last = declaredLength > 0 ? bytes[3 + declaredLength] & 0xff : 0;
    bytes[3] = (declaredLength + (command & 0xff) + last) & 0xff;
    return bytes;
  }

  /** `cmd 2` misc reading: `[5]`=sub, `[6]`=value, declared length 2. */
  function buildMiscReply(sub, value) {
    return buildFakeFrame(2, 2, function (bytes) {
      bytes[4] = 0;
      bytes[5] = sub & 0xff;
      bytes[6] = value & 0xff;
    });
  }

  /** `cmd 19` light reading; `colorful` lives at frame byte 12 despite L=8. */
  function buildLightReply() {
    var light = keyboardState.light;
    return buildFakeFrame(19, 8, function (bytes) {
      bytes[5] = light.mode & 0xff;
      bytes[6] = light.speed & 0xff;
      bytes[7] = light.turn & 0xff;
      bytes[8] = light.brightness & 0xff;
      bytes[9] = light.r & 0xff;
      bytes[10] = light.g & 0xff;
      bytes[11] = light.b & 0xff;
      bytes[12] = light.colorful & 0xff;
    });
  }

  /** `cmd 20` per-key colours: up to 11 entries per frame starting at byte 5. */
  function buildKeyColorReplies() {
    var colors = keyboardState.colors;
    var replies = [];
    chunked(sortedHardCodes(colors), KEY_COLOR_PER_FRAME).forEach(function (group) {
      replies.push(buildFakeFrame(20, 1 + 5 * group.length, function (bytes) {
        group.forEach(function (hardCode, index) {
          var color = colors[hardCode];
          var base = 5 + index * 5;
          bytes[base] = hardCode & 0xff;
          bytes[base + 1] = color[0] & 0xff;
          bytes[base + 2] = color[1] & 0xff;
          bytes[base + 3] = color[2] & 0xff;
          bytes[base + 4] = color[3] & 0xff;
        });
      }));
    });
    return replies;
  }

  /** `cmd 35` one layer's key map: up to 17 `hardCode, hi, lo` triples per frame. */
  function buildRemapReplies(fnNum) {
    var layer = keyboardState.layers[fnNum] || keyboardState.layers[0];
    var replies = [];
    chunked(sortedHardCodes(layer), REMAP_PER_FRAME).forEach(function (group) {
      replies.push(buildFakeFrame(35, 1 + 3 * group.length, function (bytes) {
        bytes[4] = fnNum & 0xff;
        group.forEach(function (hardCode, index) {
          var usage = layer[hardCode] || 0;
          var base = 5 + index * 3;
          bytes[base] = hardCode & 0xff;
          bytes[base + 1] = (usage >>> 8) & 0xff;
          bytes[base + 2] = usage & 0xff;
        });
      }));
    });
    return replies;
  }

  /** `cmd 41` bulk travel config: up to 4 keys × 14 bytes per frame. */
  function buildTravelReplies() {
    var travel = keyboardState.travel;
    var replies = [];
    chunked(sortedHardCodes(travel), TRAVEL_PER_FRAME).forEach(function (group) {
      replies.push(buildFakeFrame(41, 1 + 14 * group.length, function (bytes) {
        group.forEach(function (hardCode, index) {
          var entry = travel[hardCode];
          var base = 5 + index * 14;
          bytes[base] = hardCode & 0xff;
          bytes[base + 1] = entry.type & 0xff;
          [entry.dd, entry.du, entry.tr, entry.fo, entry.up, entry.dn].forEach(
            function (mm, pairIndex) {
              var encoded = mmBytes(mm);
              bytes[base + 2 + pairIndex * 2] = encoded[0];
              bytes[base + 3 + pairIndex * 2] = encoded[1];
            },
          );
        });
      }));
    });
    return replies;
  }

  /** `cmd 47` feature list: up to 29 `hardCode, kindByte` pairs per frame. */
  function buildFeatureReplies() {
    var replies = [];
    chunked(
      FAKE_KEYS.map(function (entry) { return entry[0]; }),
      FEATURE_PAIRS_PER_FRAME,
    ).forEach(function (group) {
      replies.push(buildFakeFrame(47, 1 + 2 * group.length, function (bytes) {
        group.forEach(function (hardCode, index) {
          var base = 5 + index * 2;
          bytes[base] = hardCode & 0xff;
          bytes[base + 1] = (keyboardState.features[hardCode] || 0) & 0xff;
        });
      }));
    });
    return replies;
  }

  /** Serial screen frame: [head, uint32 payload length, command, checksum, payload]. */
  function buildSerialFrame(command, payload) {
    var bytes = new Uint8Array(SERIAL_HEADER_SIZE + payload.length);
    bytes[0] = SERIAL_HEAD;
    bytes[1] = (payload.length >>> 24) & 0xff;
    bytes[2] = (payload.length >>> 16) & 0xff;
    bytes[3] = (payload.length >>> 8) & 0xff;
    bytes[4] = payload.length & 0xff;
    bytes[5] = command & 0xff;
    bytes.set(payload, SERIAL_HEADER_SIZE);
    var last = payload.length > 0 ? payload[payload.length - 1] & 0xff : 0;
    bytes[6] = (payload.length + (command & 0xff) + last) & 0xff;
    return bytes;
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function waitFor(predicate, timeoutMs, label) {
    return new Promise(function (resolve, reject) {
      var startedAt = Date.now();
      function check() {
        var value;
        try {
          value = predicate();
        } catch (error) {
          reject(error);
          return;
        }
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('timed out after ' + timeoutMs + 'ms waiting for ' + label));
          return;
        }
        setTimeout(check, 20);
      }
      check();
    });
  }

  // ---------------------------------------------------------------------------
  // Fake prototype descriptors.
  //
  // Chromium exposes HIDDevice.prototype.sendReport/open/close and
  // SerialPort.prototype.readable/writable/open/close as configurable, so
  // replacing them is allowed. These replacements are installed BEFORE the
  // userscript runs, which means the SDK tap captures them as its "originals"
  // and wraps them like a real driver's calls.
  // ---------------------------------------------------------------------------

  var hidProto = window.HIDDevice && window.HIDDevice.prototype;
  var serialProto = window.SerialPort && window.SerialPort.prototype;

  results.environment = {
    href: window.location.href,
    secureContext: window.isSecureContext === true,
    hidDeviceGlobal: typeof window.HIDDevice,
    serialPortGlobal: typeof window.SerialPort,
    navigatorHid: typeof navigator.hid,
    navigatorSerial: typeof navigator.serial,
    hidProtoOwn: hidProto ? describeOwn(hidProto) : null,
    serialProtoOwn: serialProto ? describeOwn(serialProto) : null,
    navigatorOverride: null,
  };

  function describeOwn(proto) {
    var names = [
      'addEventListener',
      'removeEventListener',
      'sendReport',
      'open',
      'close',
      'oninputreport',
      'readable',
      'writable',
    ];
    var out = {};
    for (var index = 0; index < names.length; index += 1) {
      var name = names[index];
      var descriptor = Object.getOwnPropertyDescriptor(proto, name);
      out[name] = descriptor
        ? {
            configurable: descriptor.configurable === true,
            enumerable: descriptor.enumerable === true,
            accessor: typeof descriptor.get === 'function' || typeof descriptor.set === 'function',
          }
        : null;
    }
    return out;
  }

  // Chromium does NOT own addEventListener/removeEventListener on
  // HIDDevice.prototype; they are inherited from EventTarget.prototype. The SDK
  // no longer requires own descriptors (it patches add/remove per device in
  // HidTap.observe), so this is informational, not a failure. The simulator still
  // installs fake own listener methods on the prototype because its fake devices
  // are Object.create(HIDDevice.prototype) instances, not real EventTargets:
  // the inherited EventTarget methods would brand-check and throw.
  if (hidProto && !Object.getOwnPropertyDescriptor(hidProto, 'addEventListener')) {
    results.sdkNotes.push(
      'HIDDevice.prototype inherits addEventListener/removeEventListener from ' +
        'EventTarget.prototype in Chromium (no own descriptors). The current SDK ' +
        'patches listener methods per device, so installation succeeds; the simulator ' +
        'still defines fake prototype listeners only to avoid EventTarget brand ' +
        'checks on fake Object.create() devices.',
    );
  }
  if (!hidProto) {
    results.errors.push('environment: HIDDevice global is missing (Chromium is required)');
  }
  if (!serialProto) {
    results.errors.push('environment: SerialPort global is missing (Chromium is required)');
  }

  function tryDefine(target, name, descriptor, label) {
    try {
      Object.defineProperty(target, name, descriptor);
      return true;
    } catch (error) {
      results.errors.push(
        'define ' + label + ': ' + (error instanceof Error ? error.message : String(error)),
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // WebHID fakes.
  // ---------------------------------------------------------------------------

  function hidState(device) {
    return device && device[HID_STATE_KEY] ? device[HID_STATE_KEY] : null;
  }

  var hidFakes = {
    sendReport: async function (reportId, data) {
      var state = hidState(this);
      if (!state) throw new TypeError('fake HIDDevice.sendReport() called on a non-fake device');
      var bytes = copyBytes(data);
      if (!bytes) throw new TypeError('HIDDevice.sendReport() expects a binary report');
      state.sent.push({ reportId: reportId, bytes: bytes });
      results.fakeHid.sent.push(hex(bytes));
      if (typeof state.onSend === 'function') state.onSend(bytes, this);
    },
    open: async function () {
      var state = hidState(this);
      if (!state) throw new TypeError('fake HIDDevice.open() called on a non-fake device');
      state.openCalls += 1;
      if (!state.opened) {
        state.opened = true;
        this.opened = true;
      }
    },
    close: async function () {
      var state = hidState(this);
      if (!state) throw new TypeError('fake HIDDevice.close() called on a non-fake device');
      state.closeCalls += 1;
      state.opened = false;
      this.opened = false;
    },
    addEventListener: function (type, listener) {
      var state = hidState(this);
      if (!state || typeof listener !== 'function') return;
      var listeners = state.listeners.get(type);
      if (!listeners) {
        listeners = new Set();
        state.listeners.set(type, listeners);
      }
      listeners.add(listener);
    },
    removeEventListener: function (type, listener) {
      var state = hidState(this);
      if (!state) return;
      var listeners = state.listeners.get(type);
      if (listeners) listeners.delete(listener);
    },
  };

  if (hidProto) {
    Object.keys(hidFakes).forEach(function (name) {
      tryDefine(hidProto, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: hidFakes[name],
      }, 'HIDDevice.prototype.' + name);
    });

    tryDefine(hidProto, 'oninputreport', {
      configurable: true,
      enumerable: true,
      get: function () {
        var state = hidState(this);
        return state ? state.oninputreport : null;
      },
      set: function (value) {
        var state = hidState(this);
        if (state) state.oninputreport = typeof value === 'function' ? value : null;
      },
    }, 'HIDDevice.prototype.oninputreport');

    results.targets.hidDevice = { patched: true };
  }

  function createFakeHidDevice() {
    if (!hidProto) throw new Error('HIDDevice is unavailable in this browser');
    var device = Object.create(hidProto);
    var state = {
      opened: false,
      sent: [],
      listeners: new Map(),
      oninputreport: null,
      openCalls: 0,
      closeCalls: 0,
      onSend: null,
    };

    Object.defineProperties(device, {
      vendorId: { value: PRODUCT.vid, enumerable: true, configurable: false, writable: false },
      productId: { value: PRODUCT.pid, enumerable: true, configurable: false, writable: false },
      productName: {
        value: PRODUCT.title + ' (simulator fake)',
        enumerable: true,
        configurable: false,
        writable: false,
      },
      collections: {
        value: [
          {
            usagePage: 0xff00,
            usage: 0x01,
            type: 1,
            inputReports: [{ reportId: 0, reportCount: HID_REPORT_SIZE, reportSize: 512 }],
            outputReports: [{ reportId: 0, reportCount: HID_REPORT_SIZE, reportSize: 512 }],
            featureReports: [],
          },
        ],
        enumerable: true,
        configurable: false,
        writable: false,
      },
      // The real `opened`/`vendorId`/... accessors brand-check their receiver;
      // fake instances shadow them with own data properties.
      opened: { value: false, enumerable: true, configurable: true, writable: true },
      [HID_STATE_KEY]: { value: state, enumerable: false, configurable: false, writable: false },
    });

    state.onSend = function (bytes, source) {
      handleFakeHidSend(source, bytes);
    };
    return device;
  }

  /**
   * Fake firmware command dispatcher.
   *
   * Reads reply with the same frame shapes as the real device (multi-frame for
   * cmd 20/35/41/47); writes update the fake tables and stay silent — the SDK
   * never waits for a write ack and verifies by reading back instead.
   */
  function handleFakeHidSend(device, request) {
    var command = request[2] || 0;
    var replies = [];
    if (command === 1) {
      replies.push(buildHidInfoResponse());
    } else if (command === 2) {
      replies = handleFakeMisc(request);
    } else if (command === 19) {
      if ((request[4] || 0) === 0) replies.push(buildLightReply());
    } else if (command === 20) {
      if ((request[4] || 0) === 0) replies = buildKeyColorReplies();
      else writeFakeKeyColors(request);
    } else if (command === 35) {
      if ((request[4] || 0) === 0) replies = buildRemapReplies(request[5] || 0);
      else writeFakeRemap(request);
    } else if (command === 41) {
      if ((request[4] || 0) === 0) replies = buildTravelReplies();
      else writeFakeTravel(request);
    } else if (command === 47) {
      if ((request[4] || 0) === 0) replies = buildFeatureReplies();
      else if ((request[4] || 0) === 1) delete keyboardState.features[request[5] || 0];
    } else if (command >= 36 && command <= 45) {
      // Feature families (36/37/38/39/40/43/45) are never queried by the SDK
      // against this fake: every key reports feature "none". Warn in case the
      // caller restores a backup that carries advanced-key features.
      console.warn('[simulator] fake keyboard has no feature-family support (cmd ' + command + ')');
    }

    if (replies.length === 0) return;
    results.fakeHid.replies.push({
      command: command,
      frames: replies.length,
      hex: replies.map(function (frame) { return hex(frame); }),
    });
    queueMicrotask(function () {
      try {
        replies.forEach(function (frame) {
          emitHidInput(device, frame);
        });
      } catch (error) {
        recordError('fake HID reply', error);
      }
    });
  }

  /** `cmd 2` misc: read sub-commands reply; write sub-commands mutate state. */
  function handleFakeMisc(request) {
    var sub = request[4] || 0;
    var second = request[5] || 0;
    switch (sub) {
      case 2:
      case 3:
        keyboardState.keyTestMode = sub;
        return [];
      case 4: // TestEnd + 0xFF returns the firmware to normal typing.
        keyboardState.keyTestMode = 0;
        return [];
      case 5: // RestoreDefault wipes every table back to the seeded state.
        keyboardState = createKeyboardState();
        return [];
      case 7:
        keyboardState.winLock = second === 1 ? 1 : 0;
        return [];
      case 13:
        keyboardState.lightSleep = second & 0xff;
        return [];
      case 6:
        return [buildMiscReply(6, keyboardState.winLock)];
      case 9:
        return [buildMiscReply(9, 0)];
      case 12:
        return [buildMiscReply(12, keyboardState.pzNum)];
      case 14:
        return [buildMiscReply(14, keyboardState.lightSleep)];
      case 16:
        return [buildMiscReply(16, 0)];
      case 19:
        return [buildMiscReply(19, keyboardState.fMode)];
      default:
        return [];
    }
  }

  /** `cmd 35` write `[1, fnNum, hardCode, hidHi, hidLo]` → update the layer. */
  function writeFakeRemap(request) {
    var fnNum = request[5] || 0;
    var hardCode = request[6] || 0;
    var usage = (((request[7] || 0) << 8) | (request[8] || 0)) & 0xffff;
    var layer = keyboardState.layers[fnNum];
    if (!layer || !hardCode) return;
    layer[hardCode] = usage;
    results.fakeKeyboard.remapWrites += 1;
  }

  /**
   * `cmd 20` write `[1, total, (hardCode, r, g, b, gray) * n]` → update colours.
   * Entries start at frame byte 6; a zero hardCode is an empty slot.
   */
  function writeFakeKeyColors(request) {
    var end = Math.min(4 + (request[1] & 0xff), request.length);
    for (var base = 6; base + 4 < end; base += 5) {
      var hardCode = request[base] || 0;
      if (!hardCode) continue;
      keyboardState.colors[hardCode] = [
        request[base + 1] & 0xff,
        request[base + 2] & 0xff,
        request[base + 3] & 0xff,
        request[base + 4] & 0xff,
      ];
    }
    results.fakeKeyboard.colorWrites += 1;
  }

  /**
   * `cmd 41` write `[1, total, (hardCode, type, 6 × mm 2B) * n]` → upsert rows.
   * Millimetre values are big-endian micrometres, matching the read layout.
   */
  function writeFakeTravel(request) {
    var end = Math.min(4 + (request[1] & 0xff), request.length);
    for (var base = 6; base + 13 < end; base += 14) {
      var hardCode = request[base] || 0;
      if (!hardCode) continue;
      var read = function (offset) {
        return (((request[base + offset] << 8) | request[base + offset + 1]) & 0xffff) /
          TRAVEL_UM_PER_MM;
      };
      keyboardState.travel[hardCode] = {
        hardCode: hardCode,
        type: request[base + 1] & 0xff,
        dd: read(2),
        du: read(4),
        tr: read(6),
        fo: read(8),
        up: read(10),
        dn: read(12),
      };
    }
    results.fakeKeyboard.travelWrites += 1;
  }

  /**
   * Dispatch one input report through the properties the page registered.
   *
   * The tap's own `inputreport` listener (registered by HidTap.observe) and the
   * page's oninputreport wrapper are both stored on the fake device. Passing the
   * same event object to both lets the tap's processedEvents WeakSet de-dupe the
   * report, so tap counters increment once while the page handler still runs.
   */
  function emitHidInput(device, bytes) {
    var state = hidState(device);
    if (!state) throw new TypeError('emitHidInput() requires a fake HID device');
    var event = {
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      reportId: 0,
      device: device,
    };
    var handler = state.oninputreport;
    var listeners = state.listeners.has('inputreport')
      ? Array.from(state.listeners.get('inputreport'))
      : [];

    if (typeof handler === 'function') handler.call(device, event);
    for (var index = 0; index < listeners.length; index += 1) {
      listeners[index].call(device, event);
    }
    results.fakeHid.emits += 1;
  }

  var hidDevice = null;
  var fakeHidApi = {
    getDevices: async function () {
      return hidDevice ? [hidDevice] : [];
    },
    requestDevice: async function (options) {
      results.fakeHid.requests.push(options && options.filters ? options.filters : []);
      if (!hidDevice) hidDevice = createFakeHidDevice();
      return [hidDevice];
    },
    addEventListener: function () {},
    removeEventListener: function () {},
  };

  // ---------------------------------------------------------------------------
  // Web Serial fakes.
  // ---------------------------------------------------------------------------

  function serialState(port) {
    return port && port[SERIAL_STATE_KEY] ? port[SERIAL_STATE_KEY] : null;
  }

  var serialFakes = {
    open: async function (options) {
      var state = serialState(this);
      if (!state) throw new TypeError('fake SerialPort.open() called on a non-fake port');
      state.openCalls += 1;
      state.options = options || null;
      if (state.opened) return;
      state.opened = true;

      var port = this;
      state.readableStream = new ReadableStream({
        start: function (controller) {
          state.controller = controller;
        },
        cancel: function () {
          state.controller = null;
        },
      });
      state.writableStream = new WritableStream({
        write: function (chunk) {
          var bytes = copyBytes(chunk);
          if (!bytes) throw new TypeError('serial write expects a Uint8Array');
          state.writes.push(bytes);
          results.fakeSerial.writes.push(hex(bytes));
          if (typeof state.onWrite === 'function') state.onWrite(bytes, port);
        },
      });
    },
    close: async function () {
      var state = serialState(this);
      if (!state) throw new TypeError('fake SerialPort.close() called on a non-fake port');
      state.opened = false;
      var controller = state.controller;
      state.controller = null;
      if (controller) {
        try {
          controller.close();
        } catch (_ignored) {
          // Already errored/closed.
        }
      }
      state.readableStream = null;
      state.writableStream = null;
    },
  };

  if (serialProto) {
    tryDefine(serialProto, 'readable', {
      configurable: true,
      enumerable: true,
      get: function () {
        var state = serialState(this);
        return state ? state.readableStream : null;
      },
    }, 'SerialPort.prototype.readable');

    tryDefine(serialProto, 'writable', {
      configurable: true,
      enumerable: true,
      get: function () {
        var state = serialState(this);
        return state ? state.writableStream : null;
      },
    }, 'SerialPort.prototype.writable');

    tryDefine(serialProto, 'open', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: serialFakes.open,
    }, 'SerialPort.prototype.open');

    tryDefine(serialProto, 'close', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: serialFakes.close,
    }, 'SerialPort.prototype.close');

    results.targets.serialPort = { patched: true };
  }

  function createFakeSerialPort() {
    if (!serialProto) throw new Error('SerialPort is unavailable in this browser');
    var port = Object.create(serialProto);
    var state = {
      opened: false,
      openCalls: 0,
      options: null,
      readableStream: null,
      writableStream: null,
      controller: null,
      writes: [],
      pushes: [],
      onWrite: null,
    };

    Object.defineProperties(port, {
      // Keep the real accessors from brand-checking the fake receiver.
      [SERIAL_STATE_KEY]: { value: state, enumerable: false, configurable: false, writable: false },
      getInfo: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: function getInfo() {
          return { usbVendorId: PRODUCT.vid, usbProductId: PRODUCT.pidScreen };
        },
      },
      devicePush: {
        enumerable: false,
        configurable: true,
        writable: true,
        value: function devicePush(bytes) {
          var current = serialState(this);
          if (!current) throw new TypeError('devicePush() requires a fake serial port');
          if (!current.opened || !current.controller) {
            throw new Error('the fake serial port has no readable stream yet');
          }
          var chunk = copyBytes(bytes);
          if (!chunk) throw new TypeError('devicePush() expects binary data');
          current.pushes.push(chunk);
          results.fakeSerial.pushes.push(hex(chunk));
          current.controller.enqueue(chunk);
        },
      },
    });

    return port;
  }

  var serialPort = null;
  var fakeSerialApi = {
    getPorts: async function () {
      return serialPort ? [serialPort] : [];
    },
    requestPort: async function (options) {
      results.fakeSerial.requests.push(
        options && options.filters ? options.filters : [],
      );
      if (!serialPort) serialPort = createFakeSerialPort();
      return serialPort;
    },
    addEventListener: function () {},
    removeEventListener: function () {},
  };

  // ---------------------------------------------------------------------------
  // Replace navigator.hid / navigator.serial (before the userscript loads).
  // Preference: an own property on the navigator instance; fall back to the
  // Navigator.prototype getter. Both are configurable in Chromium.
  // ---------------------------------------------------------------------------

  function installNavigatorValue(name, value) {
    try {
      Object.defineProperty(navigator, name, {
        configurable: true,
        enumerable: true,
        value: value,
      });
      if (navigator[name] === value) return 'navigator';
    } catch (_ignored) {
      // Fall through to the prototype getter.
    }
    try {
      var proto = Object.getPrototypeOf(navigator);
      var previous = proto ? Object.getOwnPropertyDescriptor(proto, name) : null;
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: previous ? previous.enumerable : true,
        get: function () {
          return value;
        },
      });
      if (navigator[name] === value) return 'Navigator.prototype';
    } catch (_ignored) {
      // Reported below.
    }
    return null;
  }

  results.environment.navigatorOverride = {
    hid: installNavigatorValue('hid', fakeHidApi),
    serial: installNavigatorValue('serial', fakeSerialApi),
  };
  if (!results.environment.navigatorOverride.hid) {
    results.errors.push('environment: could not replace navigator.hid');
  }
  if (!results.environment.navigatorOverride.serial) {
    results.errors.push('environment: could not replace navigator.serial');
  }

  // ---------------------------------------------------------------------------
  // Official-driver global state (window.data).
  // ---------------------------------------------------------------------------

  var driverData = {
    keys_product_list: [PRODUCT_RECORD],
    select_product_list: [],
    serial_port: null,
  };
  try {
    Object.defineProperty(window, 'data', {
      configurable: true,
      writable: true,
      value: driverData,
    });
  } catch (error) {
    recordError('define window.data', error);
    window.data = driverData;
  }

  // ---------------------------------------------------------------------------
  // Rendering / result syncing.
  // ---------------------------------------------------------------------------

  function getTap() {
    var guard = window.__ZMEOW_TAP__;
    return guard && typeof guard === 'object' && guard.tap ? guard.tap : null;
  }

  function tapFrames() {
    var tap = getTap();
    if (!tap) return { hidOut: 0, hidIn: 0, serialOut: 0, serialIn: 0 };
    try {
      var status = tap.status;
      if (status && status.frames) return status.frames;
    } catch (_ignored) {
      // The status getter should be pure; a throw is reported by the panel.
    }
    return { hidOut: 0, hidIn: 0, serialOut: 0, serialIn: 0 };
  }

  function syncTap() {
    var tap = getTap();
    if (!tap) return;
    try {
      var status = tap.status;
      var frames = status.frames || {};
      results.hidOut = frames.hidOut || 0;
      results.hidIn = frames.hidIn || 0;
      results.serialOut = frames.serialOut || 0;
      results.serialIn = frames.serialIn || 0;
      results.tap.state = status.state || null;
      results.tap.firmware =
        status.fingerprint && status.fingerprint.firmwareVersion
          ? status.fingerprint.firmwareVersion
          : null;
      results.tap.reasons = Array.isArray(status.reasons) ? status.reasons.slice(0, 8) : [];
    } catch (error) {
      var message = error instanceof Error ? error.name + ': ' + error.message : String(error);
      if (results.errors.indexOf('tap.status: ' + message) === -1) {
        results.errors.push('tap.status: ' + message);
      }
    }
  }

  function syncPanel() {
    var root = document.getElementById('zmeow-tap-root');
    var shadow = root && root.shadowRoot ? root.shadowRoot : null;
    var panel = shadow ? shadow.querySelector('.panel') : null;
    var buttons = [];
    if (shadow) {
      var nodes = shadow.querySelectorAll('button[data-action]');
      for (var index = 0; index < nodes.length; index += 1) {
        var action = nodes[index].getAttribute('data-action');
        if (action && buttons.indexOf(action) === -1) buttons.push(action);
      }
    }
    var stateField = shadow ? shadow.querySelector('[data-field="state"]') : null;
    var phaseField = shadow ? shadow.querySelector('[data-field="phase"]') : null;
    var logField = shadow ? shadow.querySelector('[data-field="log"]') : null;

    results.panelPresent = !!(
      root &&
      shadow &&
      panel &&
      // ?variant=release loads the release bundle, which compiles the connect
      // buttons out and restores through the dialog; its panel is proven by the
      // dialog actions instead.
      (/[?&]variant=release/.test(location.search)
        ? buttons.indexOf('backup') !== -1 &&
          buttons.indexOf('restore') !== -1 &&
          buttons.indexOf('dialog-confirm') !== -1
        : (buttons.indexOf('keyboard') !== -1 &&
           buttons.indexOf('screen') !== -1 &&
           buttons.indexOf('disconnect') !== -1))
    );
    results.panel.buttons = buttons;
    results.panel.state = stateField ? stateField.textContent : null;
    results.panel.phase = phaseField ? phaseField.textContent : null;
    results.panel.logLines = logField ? logField.childElementCount : 0;
  }

  function render() {
    try {
      syncTap();
      syncPanel();
      var pre = document.getElementById('results');
      if (pre) pre.textContent = JSON.stringify(results, null, 2);
    } catch (error) {
      // Last-resort: never let rendering break the fake page.
      try {
        console.warn('[simulator] render failed', error);
      } catch (_ignored) {
        // Ignore.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HID flow: official-driver-like requestDevice -> open -> window.data -> input.
  // ---------------------------------------------------------------------------

  async function runHidFlow() {
    if (!hidProto) throw new Error('HID unavailable: HIDDevice.prototype is missing');

    note('hid: navigator.hid.requestDevice()');
    var devices = await navigator.hid.requestDevice({
      filters: [
        { vendorId: PRODUCT.vid, productId: PRODUCT.pid, usagePage: 0xff00, usage: 0x01 },
      ],
    });
    var device = Array.isArray(devices) ? devices[0] : devices;
    if (!device) throw new Error('navigator.hid.requestDevice() returned no device');

    note('hid: device.open()');
    await device.open();
    note('hid: window.data.select_product_list = [device]');
    window.data.select_product_list = [device];

    var pageInput = { info: false, fMode: false, frames: [] };
    device.oninputreport = function (event) {
      var raw = event && event.data ? copyBytes(event.data) : null;
      if (!raw) return;
      var command = raw[2] || 0;
      pageInput.frames.push({
        command: command,
        sub: command === 2 ? raw[5] || 0 : null,
        hex: hex(raw),
      });
      if (command === 1) pageInput.info = true;
      if (command === 2 && (raw[5] || 0) === 19) pageInput.fMode = true;
      results.page.inputFrames = pageInput.frames;
    };

    note('hid: send cmd 1 request');
    await device.sendReport(0, buildHidFrame(1, [0xff, 0xff]));
    note('hid: send cmd 2/19 request');
    await device.sendReport(0, buildHidFrame(2, [19, 0]));

    await waitFor(function () {
      var frames = tapFrames();
      return frames.hidIn >= 2 && pageInput.info && pageInput.fMode;
    }, 3000, 'HID replies (cmd 1 + cmd 2/19)');

    var frames = tapFrames();
    results.flow.hid = {
      out: frames.hidOut,
      in: frames.hidIn,
      pageInfo: pageInput.info,
      pageFMode: pageInput.fMode,
    };
    results.pageInputOk = pageInput.info && pageInput.fMode;
    note('hid: tap saw out=' + frames.hidOut + ' in=' + frames.hidIn);
  }

  // ---------------------------------------------------------------------------
  // Serial flow: requestPort -> open -> write cmd 112 -> read ACK.
  // ---------------------------------------------------------------------------

  async function runSerialFlow() {
    if (!serialProto) throw new Error('Serial unavailable: SerialPort.prototype is missing');

    note('serial: navigator.serial.requestPort()');
    var port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: PRODUCT.vid, usbProductId: PRODUCT.pidScreen }],
    });
    if (!port) throw new Error('navigator.serial.requestPort() returned no port');

    note('serial: port.open(115200 8N1)');
    await port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
    note('serial: window.data.serial_port = port');
    window.data.serial_port = port;

    var prepareFrame = buildSerialFrame(112, [0, 1, 103, 105, 102, 49]);
    var ackFrame = buildSerialFrame(112, [1]);

    var reader = port.readable.getReader();
    var pageSerialOk = false;
    var readPromise = reader.read().then(function (chunk) {
      if (chunk.done) throw new Error('serial readable ended before the ACK');
      var value = copyBytes(chunk.value);
      if (!value) throw new Error('serial read returned a non-binary chunk');
      results.page.serialFrames.push(hex(value));
      pageSerialOk = bytesEqual(value, ackFrame);
      results.pageSerialOk = pageSerialOk;
    });

    note('serial: write cmd 112 frame');
    var writer = port.writable.getWriter();
    await writer.write(prepareFrame);
    writer.releaseLock();

    // Give the tap's wrapped reader a chance to be the active reader before the
    // fake device pushes the ACK.
    await delay(10);
    note('serial: device pushes cmd 112 ACK');
    port.devicePush(ackFrame);
    await readPromise;
    reader.releaseLock();

    await waitFor(function () {
      var frames = tapFrames();
      return frames.serialOut >= 1 && frames.serialIn >= 1;
    }, 3000, 'serial tap counters');

    var frames = tapFrames();
    results.flow.serial = {
      out: frames.serialOut,
      in: frames.serialIn,
      pageAckOk: pageSerialOk,
      requestHex: hex(prepareFrame),
      ackHex: hex(ackFrame),
    };
    note('serial: tap saw out=' + frames.serialOut + ' in=' + frames.serialIn);
  }

  // ---------------------------------------------------------------------------
  // Active-connection entry points.
  // ---------------------------------------------------------------------------

  async function runActiveEntryPoints(tap) {
    var present = {
      connectKeyboard: typeof tap.connectKeyboard === 'function',
      connectScreen: typeof tap.connectScreen === 'function',
      disconnect: typeof tap.disconnect === 'function',
      stop: typeof tap.stop === 'function',
    };
    results.activeEntryPoints = {
      present: present,
      allPresent:
        present.connectKeyboard && present.connectScreen && present.disconnect && present.stop,
    };
    if (!results.activeEntryPoints.allPresent) {
      throw new Error('ZetsuTap active entry point(s) missing: ' + JSON.stringify(present));
    }

    note('active: tap.connectKeyboard()');
    var keyboard = await tap.connectKeyboard();
    results.active.keyboard = {
      connected: !!keyboard && keyboard.isConnected === true,
      firmware:
        keyboard && keyboard.info && keyboard.info.firmwareVersion
          ? keyboard.info.firmwareVersion
          : null,
    };

    note('active: tap.connectScreen()');
    var screen = await tap.connectScreen();
    results.active.screen = { open: !!screen && screen.isOpen === true };

    note('active: tap.disconnect()');
    await tap.disconnect();
    results.active.disconnect = true;
  }

  // ---------------------------------------------------------------------------
  // Simulator main loop.
  // ---------------------------------------------------------------------------

  async function main() {
    note('fake page loaded');
    render();

    var tap = null;
    try {
      tap = await waitFor(getTap, 5000, 'userscript tap install');
    } catch (error) {
      recordError('waitForTap', error);
      results.steps.push('tap install did not complete; HID/serial/active checks skipped');
    }

    if (tap) {
      // Let the async product-table fingerprint settle before the first frame.
      await delay(50);
      try {
        await runHidFlow();
      } catch (error) {
        recordError('HID flow', error);
      }
      try {
        await runSerialFlow();
      } catch (error) {
        recordError('serial flow', error);
      }
      try {
        await runActiveEntryPoints(tap);
      } catch (error) {
        recordError('active entry points', error);
      }
    }

    try {
      await waitFor(function () {
        syncPanel();
        return results.panelPresent;
      }, 2000, 'userscript panel');
    } catch (error) {
      recordError('panel', error);
    }

    // One last read after the panel has repainted.
    await delay(100);
    syncTap();
    syncPanel();
    render();

    results.ready = true;
    results.readyAt = new Date().toISOString();
    note('simulator ready');
    render();

    // Keep the visible result object live for manual inspection.
    setInterval(function () {
      syncTap();
      syncPanel();
      render();
    }, 500);
  }

  window.addEventListener('error', function (event) {
    recordError('window.error', event.error || event.message);
  });
  window.addEventListener('unhandledrejection', function (event) {
    recordError('unhandledrejection', event.reason);
  });

  void main();
})();
