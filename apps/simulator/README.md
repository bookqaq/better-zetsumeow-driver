# Better ZetsuMeow Driver keyboard simulator

Static Chromium keyboard simulator for
`packages/zmeow-userscript/dist/better-zmeow-driver.user.js`. It proves the
userscript, unmodified, in a real browser page:

1. renders the **Better ZetsuMeow Driver** shadow-DOM panel;
2. taps an official-driver-like **WebHID** flow (`requestDevice` → `open` →
   `window.data.select_product_list` → `cmd 1` / `cmd 2/19` requests + replies);
3. taps a **Web Serial** flow (`requestPort` → `open` → `cmd 112` write + ACK);
4. exposes the active-connection entry points (`connectKeyboard`,
   `connectScreen`, `disconnect`, `stop`) and calls them against the fake handle
   without touching a real device;
5. simulates a **stateful Zetsu63 firmware**: the fake device answers the config
   read/write commands (remap `cmd 35`, light `cmd 19`, key colours `cmd 20`,
   travel `cmd 41`, features `cmd 47`, misc `cmd 2`), so the panel's **Backup
   JSON / Restore JSON** buttons run end-to-end against device-shaped tables.

Everything is dependency-free: `fake-page.js` is a plain script, and the
userscript is loaded with a normal `<script src>`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Loads `./fake-page.js` first, then `../../packages/zmeow-userscript/dist/better-zmeow-driver.user.js`; shows the live result JSON in `<pre id="results">`. |
| `fake-page.js` | Fake `HIDDevice` / `SerialPort` prototypes, fake `navigator.hid` / `navigator.serial`, fake `window.data`, scripted HID + serial flows, result publisher. |
| `simulator-result.png` | Playwright screenshot captured after the backup/download half of the drill (results + panel + log). |
| `README.md` | This file. |

The simulator writes the same object to `window.__ZMEOW_SIMULATOR__` and to the
visible `<pre>`. The required shape is:

```js
{
  hidOut, hidIn, serialOut, serialIn,
  pageInputOk, pageSerialOk, panelPresent,
  errors: [],
  ready: true,            // set when the scripted run is complete
  // plus evidence fields: flow, activeEntryPoints, active, panel, tap,
  // fakeKeyboard: { remapWrites, colorWrites, travelWrites }, sdkNotes, ...
}
```

## Build, serve, open

```bash
# 1. Build the userscript bundle (writes dist/better-zmeow-driver.user.js).
pnpm -F @bookqaq/better-zmeow-driver build

# 2. Serve the repository root. The existing root static server is enough.
pnpm serve
# -> http://127.0.0.1:8099/apps/playground/ (default URL), port 8099

# 3. Open the simulator in Chromium (NOT file://):
#    http://127.0.0.1:8099/apps/simulator/
```

Append `?variant=release` to load the release bundle
(`dist/better-zmeow-driver.release.user.js`) instead of the debug bundle. The
release variant hides the connect buttons and exposes the restore dialog, so
its expected panel differs from the debug drill below.

If port 8099 is already in use, reuse that server or start another port:

```bash
PORT=8100 pnpm serve
# http://127.0.0.1:8100/apps/simulator/
```

`pnpm serve` serves the whole repository root, so the simulator can reach both
`apps/simulator/fake-page.js` and `packages/zmeow-userscript/dist/better-zmeow-driver.user.js`. No extra server or
npm install is needed.

> **`file://` warning:** WebHID and Web Serial are secure-context features.
> Opening `index.html` directly from disk leaves `navigator.hid` /
> `navigator.serial` undefined (and `isSecureContext === false`), so the simulator
> cannot install or exercise anything. Always use `http://127.0.0.1:8099` or
> `http://localhost:8099`.

## Verify

Open the URL, wait for `ready`, then inspect the object in DevTools:

```js
window.__ZMEOW_SIMULATOR__.ready === true
window.__ZMEOW_SIMULATOR__
```

### Config backup/restore drill

The fake keyboard keeps writable state, so the panel's two-step flows run for
real: **Backup** captures a config document into memory, **Download** saves it,
**Load restore file** validates a JSON document, and **Restore** writes it back
onto the fake tables. Automated drill (the captured screenshot shows the
backup/download half):

```js
// 1. Capture + download a backup: hook the blob URL, click Backup, then Download.
URL.createObjectURL = ((original) => (blob) =>
  (window.__capturedBlobs ??= []).push(blob) && original(blob))(URL.createObjectURL.bind(URL));
shadow.querySelector('button[data-action="backup"]').click();
shadow.querySelector('button[data-action="download"]').click();
const backup = JSON.parse(await window.__capturedBlobs.at(-1).text());

// 2. Mutate the parsed backup (remap Digit1 → Digit2, recolour a key,
//    change a travel press point — 4 mm is the full switch travel now that
//    the old 3.1 mm UI cap is gone — and set the light-sleep delay), then
//    feed it through the restore file input (Load step, no device writes):
const input = shadow.querySelector('[data-field="restore-file"]');
const dt = new DataTransfer();
dt.items.add(new File([json], 'backup.json', { type: 'application/json' }));
input.files = dt.files;
input.dispatchEvent(new Event('change', { bubbles: true }));
// 3. Apply it (Restore step, device writes):
shadow.querySelector('button[data-action="restore"]').click();

// 4. Backup + Download again and compare: the mutated values must come back
//    (1.2345 mm quantises to 1.23 mm on the firmware's 0.01 mm grid).
// Expected evidence: log "restore: remap 1, colours 7, travel 65",
// __ZMEOW_SIMULATOR__.fakeKeyboard { remapWrites: 1, colorWrites: 1, travelWrites: 17 }.
```

The panel log only records `status: <state>` when the state actually changes
(the bridge re-publishes status after every frame, but main.ts de-duplicates it),
so a full backup/restore drill adds no repeated `status: active` lines.

Expected on a working build (observed with Chromium + the current `dist/`,
right after the scripted run — the config drill is exercised separately):

```json
{
  "ready": true,
  "hidOut": 5,
  "hidIn": 5,
  "serialOut": 1,
  "serialIn": 1,
  "pageInputOk": true,
  "pageSerialOk": true,
  "panelPresent": true,
  "errors": [],
  "flow": {
    "hid": { "out": 2, "in": 2, "pageInfo": true, "pageFMode": true },
    "serial": { "out": 1, "in": 1, "pageAckOk": true }
  },
  "tap": { "state": "active", "firmware": "1.1.1", "reasons": [] },
  "activeEntryPoints": { "allPresent": true },
  "active": {
    "keyboard": { "connected": true, "firmware": "1.1.1" },
    "screen": { "open": true },
    "disconnect": true
  },
  "panel": { "state": "active", "phase": "ready" }
}
```

Notes on the counts:

- `hidOut` / `hidIn` are the live tap totals. The initial driver-like HID flow
  is exactly `2` / `2` (`cmd 1` and `cmd 2/19`); the later
  `tap.connectKeyboard()` call adds three more request/reply pairs, hence the
  final `5` / `5`. `flow.hid` records the initial `2` / `2`.
- `serialOut` / `serialIn` stay at `1` / `1` (one `cmd 112` write, one ACK).
- The panel's own `frames` line counts tap frame **events** (both directions), so
  after the active keyboard flow it reads `12 (hid 10 / serial 2)`. That is the
  panel's display total; the simulator object keeps directional counters
  (`hidOut` / `hidIn` / `serialOut` / `serialIn`) separately.
- `panelPresent` requires the host `#zmeow-tap-root`, its open shadow root, the
  `.panel` element, and the keyboard/screen/disconnect/backup/restore buttons
  plus the Wooting share-code input.
- `pageInputOk` is true only if the page's own `device.oninputreport` handler
  still received both the `cmd 1` info frame and the `cmd 2/19` fMode frame
  after the tap wrapped the prototype accessor.
- `pageSerialOk` is true only if the page's read loop still received the exact
  `cmd 112` ACK bytes through the tap-wrapped `readable` stream.
- `errors` must stay empty. Unexpected exceptions (including
  `unhandledrejection`) are appended as strings.

A quick headless check with Playwright (same steps as the manual browser
verification):

```bash
# Terminal 1 (from the repository root)
pnpm serve

# Terminal 2 — any Playwright runner, e.g. the MCP browser:
# browser_navigate http://127.0.0.1:8099/apps/simulator/
# browser_evaluate () => window.__ZMEOW_SIMULATOR__
```

## How the fake page works

`fake-page.js` runs before the userscript, so the tap captures the fakes as its
"originals":

- `HIDDevice.prototype.sendReport/open/close` are replaced with fakes and
  `oninputreport` is replaced with a fake accessor.
  `addEventListener/removeEventListener` are installed as **own** prototype
  methods because the fake devices are not real `EventTarget`s (not because the
  SDK requires own descriptors — see the note below).
- `SerialPort.prototype.readable/writable` getters and `open/close` are
  replaced with fakes backed by in-memory `ReadableStream` / `WritableStream`.
- `navigator.hid` / `navigator.serial` are replaced with fake objects via
  `Object.defineProperty` on the navigator instance (verified working in
  Chromium; the simulator records `navigator` vs `Navigator.prototype`).
- `window.data` matches the official driver shape:
  `keys_product_list` contains the Zetsu63 record (`id 10011`, `vid 14470`,
  `pid 16385`, `usage 1`, `usagePage "65280,255"`, `head_num "0xab"`);
  `select_product_list` starts empty and receives the HID device after open;
  `serial_port` starts `null` and receives the serial port after open.
- Fake devices are `Object.create(HIDDevice.prototype)` /
  `Object.create(SerialPort.prototype)` with own `vendorId`, `productId`,
  `opened`, `collections` / `getInfo` properties. This bypasses the real
  WebIDL accessor brand checks while still flowing through the patched
  prototype methods.
- Replies are scheduled with `queueMicrotask` just like the SDK unit tests, and
  the dispatcher answers every config command the SDK uses, not only the
  scripted-flow pair.
- Request bytes use the SDK checksum formula `(length + command + lastPayloadByte) & 0xff`:
  `cmd 1` is `ab 02 01 02 ff ff` + zero padding and `cmd 2/19` is
  `ab 02 02 04 13 00` + zero padding. (The `ab 02 01 03 ff ff` form quoted in
  some notes has a wrong checksum byte; the firmware/SDK computes `02`.)

### Fake keyboard state simulation

`fake-page.js` also stands in for the firmware's writable tables, which is what
makes the backup/restore drill meaningful instead of a canned replay:

- Base table `FAKE_KEYS` is the compact65 layout `[hardCode, hidCode,
  hidCodeFn1]` extracted from `packages/zmeow-sdk/src/generated/product-zetsu63.ts`;
  every key seeds a 2 mm travel / 0.2 mm dead zone, and a handful of keys seed
  colours so `getKeyColors()` has something to merge.
- Reads reply with the real firmware's frame shapes (docs/PROTOCOL.md §4/§9.3):
  `cmd 35` remap 17 triples per frame (65 keys → 4 frames), `cmd 47` features
  29 pairs per frame (3 frames), `cmd 20` colours 11 entries per frame,
  `cmd 41` travel 4 keys × 14 bytes per frame; `cmd 2` declares `L=2` with the
  value at frame byte 6 and `cmd 19` declares `L=8` with `colorful` at frame
  byte 12.
- Writes are accepted silently — no ack frame — matching the SDK, which treats
  writes as fire-and-forget and verifies by reading back. `cmd 35` upserts the
  layer table, `cmd 20`/`cmd 41` upsert colours/travel rows, `cmd 2/7` and
  `cmd 2/13` set win-lock and light sleep, `cmd 2/5` resets everything to the
  seeded state.
- Feature families (36/37/38/39/40/43/45) are not simulated: every feature
  reports as `none`, so the SDK never queries them. Restoring a backup that
  carries advanced-key features logs a console warning instead of a reply.
- `window.__ZMEOW_SIMULATOR__.fakeKeyboard` counts accepted write frames
  (`remapWrites` / `colorWrites` / `travelWrites`) as drill evidence.
- The serial read loop and write go through the patched getters, so the tap
  counts both directions and the page still receives the ACK.
- The scripted run calls `tap.connectKeyboard()`, `tap.connectScreen()` and
  `tap.disconnect()` only after the fake handles are known, so no permission
  prompt or real hardware is involved.

## Chromium descriptor note (SDK already fixed)

The simulator records this in `window.__ZMEOW_SIMULATOR__.sdkNotes` as
informational context, not as a failure:

> `HIDDevice.prototype` does **not** own `addEventListener` /
> `removeEventListener` in Chromium; those methods are inherited from
> `EventTarget.prototype`.

An earlier SDK build required own descriptors on `HIDDevice.prototype`, which
made `HidTap.install()` throw `UnsupportedError: HIDDevice.prototype is missing
required methods` on a real Chromium page. The current SDK no longer does this:
`HidTap.install()` only requires `sendReport/open/close` (and optionally
`oninputreport`), and `HidTap.observe(device)` installs bound per-device
`addEventListener` / `removeEventListener` wrappers instead. The real-page smoke
test now reports both `hid.attached=true` and `serial.attached=true`.

`fake-page.js` still defines fake **own** prototype listener methods because its
fake devices are `Object.create(HIDDevice.prototype)` objects, not real
`EventTarget`s: the inherited `EventTarget` methods would brand-check and throw,
and the tap needs a place to register its native `inputreport` listener. That is
a property of the fake, not a workaround for the SDK.

## Result screenshot

`simulator-result.png` in this directory was captured with Playwright after the
scripted run reached `ready: true` and a backup was captured and downloaded
through a stubbed anchor: the blob was confirmed to be a complete
`zmeow.keyboard-config` JSON document. It shows the visible result `<pre>` and
the userscript panel in the bottom-right corner with the backup log lines. Run
the restore half of the drill above to verify device writes as well.

## Limitations

- Chromium/Edge only: the simulator relies on the real `HIDDevice` and
  `SerialPort` globals existing so their prototypes can be patched. Firefox and
  Safari do not expose WebHID / Web Serial and are out of scope.
- Secure context required (`http://127.0.0.1`, `http://localhost`, or HTTPS).
- Fake devices only: this proves the userscript/tap wiring, not firmware
  behavior. Use the Playground and a real device for hardware validation.
- The simulator does not test Tampermonkey injection itself; it loads the built
  bundle as a normal page script so the panel/tap code paths run unmodified.
