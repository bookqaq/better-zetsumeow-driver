# Better ZetsuMeow Driver

Workspace package: `@bookqaq/better-zmeow-driver`.

Tampermonkey userscript build for the ZetsuMeow driver tap. It bundles the
TypeScript sources and the workspace SDK into **one dependency-free IIFE**
(`better-zmeow-driver.user.js`), installs the page tap at `document-start`, and
renders a small shadow-DOM panel with state, fingerprint, active connection
buttons, JSON backup/restore and Wooting profile import.

All SDK calls live in [`src/sdk.ts`](src/sdk.ts); `src/main.ts` / `src/ui.ts`
only consume the small structural contract defined there.

## Build

```bash
cd packages/zmeow-userscript
node build.mjs                # builds debug AND release artifacts
node build.mjs --mode=debug   # only the debug bundle
node build.mjs --mode=release # only the release bundle
# or, from the repo root once pnpm links the package:
pnpm -F @bookqaq/better-zmeow-driver build            # both
pnpm -F @bookqaq/better-zmeow-driver build:debug      # debug only
pnpm -F @bookqaq/better-zmeow-driver build:release    # release only
```

The build uses only Node built-ins and the TypeScript compiler already installed
in the workspace (`node_modules/typescript` or `../../node_modules/typescript`).
It resolves the `@bookqaq/zmeow-sdk` alias to `../zmeow-sdk/src/index.ts`
directly, so no `pnpm install` is required just to bundle.

Outputs (not committed, `dist/` is git-ignored):

| File | Purpose |
| --- | --- |
| `dist/better-zmeow-driver.user.js` | Debug userscript (metadata header + IIFE bundle) — default |
| `dist/better-zmeow-driver.meta.js` | Debug metadata header only (for update checks / inspection) |
| `dist/better-zmeow-driver.release.user.js` | Release userscript (same header, release behavior) |
| `dist/better-zmeow-driver.release.meta.js` | Release metadata header only |

### Build modes

The mode is a **compile-time** flag (`__ZMEOW_RELEASE__`, see
`src/build-mode.d.ts`): `build.mjs` rewrites every flag reference to a literal
and folds the dead branches, so each artifact contains only its own mode's code
— there is no runtime switching.

- **debug** (default): two-step backup (**Backup** → **Download**) and restore
  (**Load restore file** → **Restore**); **Connect keyboard / Connect screen /
  Disconnect** buttons visible.
- **release**: **Backup** captures the config and immediately starts the JSON
  download (one step); **Restore** opens a pick + confirm dialog — choosing a
  file validates it inside the dialog and **确认还原 / Restore now** applies it,
  **取消 / Cancel** never writes anything; the connect buttons are compiled out
  of the markup and the action dispatch. Wooting import, the settings page and
  i18n behave identically in both modes.

The keyboard simulator can load either artifact: `?variant=release` on the simulator
URL switches to the release bundle (see [`apps/simulator/`](../../apps/simulator/)).

## Install

1. Run `node build.mjs` for the debug build, or
   `pnpm -F @bookqaq/better-zmeow-driver release` for the user-facing release
   package (`dist/release/`).
2. Open the Tampermonkey dashboard → **Create a new script**.
3. Replace the template with the contents of `dist/better-zmeow-driver.user.js`
   (debug) or `dist/release/better-zmeow-driver.user.js` (release), or drag the
   file into the browser.
4. Save. The header matches:
   - `http://localhost/*` (debug only)
   - `http://127.0.0.1/*` (debug only)
   - `https://driver.zetsumeow.com/*` (debug + release)
5. Open the local driver page and use the **Better ZetsuMeow Driver** panel in the bottom-right
   corner. Buttons must be clicked (user gesture) because WebHID / Web Serial
   permission prompts require one.
6. The **debug** build splits the backup/restore flow into two steps each so
   automation does not need a download dialog or a user-gesture file picker
   mid-flow: **Backup** captures the config into memory, **Download** saves the
   captured JSON; **Load restore file** reads and validates a backup file into
   memory, **Restore** writes it to the device. The **release** build merges
   these: **Backup** downloads right away and **Restore** opens a pick + confirm
   dialog (see *Build modes* above). **Import Wooting profile** applies a
   Wootility share response (`.txt` curl dump or `.json`) in one step in both
   modes.
   Restore verifies remaps after writing (dropped writes are rewritten once,
   matching the official driver's write pacing) and re-checks the advanced-key
   list; anything the device did not adopt shows up in the `restore warnings`
   log line. A layer the device refuses to read during Backup is skipped and
   reported in `warnings` instead of failing the whole backup.

> **Match-pattern note:** Chrome match patterns ignore the port, so
> `http://localhost/*` also matches `http://localhost:8099/...`.
> The script uses `@sandbox JavaScript` plus `unsafeWindow`: the GM grants power
> the Wootility share fetch, while `unsafeWindow` hands the tap the host page's
> realm so WebHID / Web Serial patches land where the driver page sees them.

### Production origin

The release metadata matches only `https://driver.zetsumeow.com/*`.
`http://localhost/*` and `http://127.0.0.1/*` are included only in the debug
build and are deliberately absent from release artifacts. Add every additional
deployment origin as a new `// @match` line in `buildHeader()` (`build.mjs`),
then rebuild and rerun the release check. Do not ship a placeholder or a
commented-out origin.

The release packager (`pnpm -F @bookqaq/better-zmeow-driver release`) fails when
no non-local `https://` match exists or when the obsolete placeholder text is
still present.

## Release

See [`docs/RELEASE.md`](../../docs/RELEASE.md) for the full checklist
(versioning, tag format, packaging, upload, verification and rollback).

```bash
pnpm -F @bookqaq/better-zmeow-driver release
# -> dist/release/better-zmeow-driver.user.js
#    dist/release/better-zmeow-driver.meta.js
#    dist/release/SHA256SUMS.txt
#    dist/release/RELEASE-NOTES.md

# Publish to npm and create the GitHub Release
pnpm -F @bookqaq/better-zmeow-driver release -- --publish
```

The packager runs `pnpm check`, validates the release metadata and mode traces,
injects `@downloadURL` / `@updateURL`, writes checksums and release notes, and
(`--publish`) pushes a staged npm package plus a GitHub Release. Auto-update
defaults to the jsDelivr npm CDN; see [`docs/RELEASE.md`](../../docs/RELEASE.md)
for tokens, mirrors and rollback.

## Test

```bash
cd packages/zmeow-userscript
node --test "test/**/*.test.mjs" "test/**/*.test.ts"
pnpm -F @bookqaq/better-zmeow-driver typecheck
```

## Keyboard simulator

[`apps/simulator/`](../../apps/simulator/) loads the built userscript against fake `HIDDevice` /
`SerialPort` prototypes and a fake official-driver `window.data`. It verifies
tap counts, the page's own HID/serial handlers, the panel, and the active
`connectKeyboard()` / `connectScreen()` entry points without hardware.

```bash
pnpm serve
# open http://127.0.0.1:8099/apps/simulator/
```

See [`apps/simulator/README.md`](../../apps/simulator/README.md) for the expected result JSON and the
`file://` secure-context warning.

The build test compiles to a temp directory and checks the metadata directives,
`node --check` syntax validity, the absence of bare `import`/`export`, and
readable failures for missing and circular imports.

## Design notes

- **No new dependencies.** Node built-ins plus the existing TypeScript compiler.
  The SDK is bundled from source by path, not from `node_modules`.
- **No minification.** The bundle stays debuggable; source-map comments are
  stripped and `//# sourceMappingURL` lines are removed.
- **CommonJS registry.** Each module is transpiled with
  `ts.transpileModule(..., { module: CommonJS, target: ES2022 })` and wrapped in a
  tiny registry inside one IIFE. The SDK namespace is exposed as
  `window.ZmeowSDK` for console debugging.
- **Double-install guard.** `window.__ZMEOW_TAP__` is claimed before the async
  install starts; a second injection logs a warning and exits.
- **Frame logging.** Frame events only bump counters; the panel is repainted at
  most every 250 ms and the console logs a summary every 100 frames. Per-frame
  logging is intentionally avoided.
- **Fingerprint refresh.** `ZetsuTap.install()` fingerprints the driver assets
  during `start()`, but at `document-start` the page's `modulepreload` links may
  not be parsed yet. If the SDK exposes its optional `refreshFingerprint()`, the
  app calls it once after `load` and re-renders; otherwise the row stays
  `not checked`.
- **SDK isolation.** See [`src/sdk.ts`](src/sdk.ts). If the SDK's tap surface
  changes, only that file should need edits. The current adapter normalises
  `TapStatus.fingerprint` (today a structured `TapFingerprint`, possibly a string
  in future shapes) for display.

## Limitations

- The bundle includes the whole SDK entry (no tree shaking): ~300 KiB unminified.
- Active connections reuse the page's HID handle / serial port when the tap has
  captured one; otherwise the normal device chooser appears.
- The release userscript matches only `driver.zetsumeow.com`; `localhost` and
  `127.0.0.1` are debug-only. Additional deployment origins must be added to
  `buildHeader()` before release.
- Automatic updates use jsDelivr:
  `https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver`;
  `ZMEOW_UPDATE_BASE_URL` / `--update-base-url` exist only for a self-hosted
  static directory.
