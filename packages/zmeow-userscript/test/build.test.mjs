import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SCRIPT = path.join(PACKAGE_ROOT, 'build.mjs');
const USER_SCRIPT = 'better-zmeow-driver.user.js';
const META_SCRIPT = 'better-zmeow-driver.meta.js';
const RELEASE_USER_SCRIPT = 'better-zmeow-driver.release.user.js';
const RELEASE_META_SCRIPT = 'better-zmeow-driver.release.meta.js';
const MODE_FLAG = '__ZMEOW_RELEASE__';
const DISPLAY_NAME = 'Better ZetsuMeow Driver';

let workspace;
let outdir;
let packageVersion;
let userScript;
let metaScript;
let releaseUserScript;
let releaseMetaScript;

before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'zmeow-userscript-test-'));
  outdir = path.join(workspace, 'dist');
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  packageVersion = pkg.version;

  const result = spawnSync(process.execPath, [BUILD_SCRIPT, '--outdir', outdir], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `build.mjs failed\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );

  userScript = await readFile(path.join(outdir, USER_SCRIPT), 'utf8');
  metaScript = await readFile(path.join(outdir, META_SCRIPT), 'utf8');
  // The default (mode-less) build emits both artifacts so the assertions below
  // always run against fresh output of each mode.
  releaseUserScript = await readFile(path.join(outdir, RELEASE_USER_SCRIPT), 'utf8');
  releaseMetaScript = await readFile(path.join(outdir, RELEASE_META_SCRIPT), 'utf8');
});

after(async () => {
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

test('emits a Tampermonkey metadata header', () => {
  assert.ok(userScript.startsWith('// ==UserScript==\n'), 'must start with the metadata header');

  const required = [
    [new RegExp(`^// @name\\s+${escapeRegExp(DISPLAY_NAME)}$`, 'm'), `@name ${DISPLAY_NAME}`],
    [/^\/\/ @namespace\s+\S+/m, '@namespace'],
    [new RegExp(`^// @version\\s+${escapeRegExp(packageVersion)}$`, 'm'), `@version ${packageVersion}`],
    [/^\/\/ @description\s+\S+/m, '@description'],
    [/^\/\/ @license\s+MIT$/m, '@license MIT'],
    [/^\/\/ @run-at\s+document-start$/m, '@run-at document-start'],
    [/^\/\/ @grant\s+GM_xmlhttpRequest$/m, '@grant GM_xmlhttpRequest'],
    [/^\/\/ @grant\s+GM\.xmlHttpRequest$/m, '@grant GM.xmlHttpRequest'],
    [/^\/\/ @grant\s+unsafeWindow$/m, '@grant unsafeWindow'],
    [/^\/\/ @sandbox\s+JavaScript$/m, '@sandbox JavaScript'],
    [/^\/\/ @connect\s+api\.wooting\.io$/m, '@connect api.wooting.io'],
    [/^\/\/ @noframes$/m, '@noframes'],
    [/^\/\/ @match\s+http:\/\/localhost\/\*$/m, 'localhost @match'],
    [/^\/\/ @match\s+http:\/\/127\.0\.0\.1\/\*$/m, '127.0.0.1 @match'],
    [/^\/\/ @match\s+https:\/\/driver\.zetsumeow\.com\/\*$/m, 'production driver @match'],
  ];

  for (const [pattern, label] of required) assert.match(userScript, pattern, `missing ${label}`);
  assert.ok(
    !userScript.includes('PRODUCTION ORIGIN PLACEHOLDER'),
    'must not ship the production-origin placeholder',
  );
  assert.ok(userScript.trimEnd().endsWith('})();'), 'bundle must end with the IIFE');
});

test('local development origins are debug-only and absent from the release metadata', () => {
  for (const pattern of [
    /^\/\/ @match\s+http:\/\/localhost\/\*$/m,
    /^\/\/ @match\s+http:\/\/127\.0\.0\.1\/\*$/m,
  ]) {
    assert.match(userScript, pattern, 'debug must include local development origins');
    assert.doesNotMatch(releaseUserScript, pattern, 'release must not include local development origins');
  }
});

test('release metadata carries auto-update URLs when a base URL is supplied', async () => {
  const updateOutdir = path.join(workspace, 'dist-update');
  const result = spawnSync(
    process.execPath,
    [
      BUILD_SCRIPT,
      '--update-base-url',
      'https://updates.example/zmeow',
      '--outdir',
      updateOutdir,
    ],
    { cwd: PACKAGE_ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `build failed\n${result.stdout}\n${result.stderr}`);

  const releaseMeta = await readFile(path.join(updateOutdir, RELEASE_META_SCRIPT), 'utf8');
  const debugMeta = await readFile(path.join(updateOutdir, META_SCRIPT), 'utf8');
  assert.match(
    releaseMeta,
    /^\/\/ @downloadURL\s+https:\/\/updates\.example\/zmeow\/better-zmeow-driver\.user\.js$/m,
  );
  assert.match(
    releaseMeta,
    /^\/\/ @updateURL\s+https:\/\/updates\.example\/zmeow\/better-zmeow-driver\.meta\.js$/m,
  );
  assert.doesNotMatch(debugMeta, /^\/\/ @(?:downloadURL|updateURL)\s/m);
});

test('meta.js contains only the metadata header', () => {
  assert.ok(metaScript.startsWith('// ==UserScript==\n'));
  assert.ok(metaScript.trimEnd().endsWith('// ==/UserScript=='));
  assert.equal((metaScript.match(/==\/?UserScript==/g) ?? []).length, 2);
  assert.ok(!metaScript.includes('Generated by'), 'meta.js must not include the bundle');
  assert.ok(userScript.startsWith(`${metaScript.trimEnd()}\n`), 'user.js must reuse the header');
});

test('generated script parses with node --check', () => {
  const result = spawnSync(process.execPath, ['--check', path.join(outdir, USER_SCRIPT)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `node --check failed\n${result.stderr}`);
});

test('bundle is self-contained and references the SDK tap', () => {
  assert.match(userScript, /ZetsuTap/, 'bundle must reference ZetsuTap');
  assert.match(userScript, /window\.ZmeowSDK/, 'bundle must expose window.ZmeowSDK');
  assert.match(userScript, /function \(module, exports, require\)/);
  assert.ok(userScript.includes('transfer-overlay'), 'transfer overlay must ship in both modes');
  assert.ok(userScript.includes('setTransferHint'), 'transfer hint API must ship in both modes');
  assert.doesNotMatch(userScript, /^\s*(?:import|export)\s/m, 'no bare ESM statements allowed');
  assert.doesNotMatch(userScript, /sourceMappingURL=/, 'source maps must be stripped');
  assert.doesNotMatch(userScript, /PAGE_RELOAD_DELAY_MS/, 'the countdown reload must be gone');
});

test('post-transfer reload asks for confirmation in both modes', () => {
  for (const bundle of [userScript, releaseUserScript]) {
    for (const marker of [
      'data-field="reload-dialog"',
      'data-action="reload-confirm"',
      'data-action="reload-cancel"',
      'data-action="reload-close"',
      'confirmReload',
    ]) {
      assert.ok(bundle.includes(marker), `bundle must contain ${marker}`);
    }
    assert.doesNotMatch(bundle, /PAGE_RELOAD_DELAY_MS/);
  }
});

test('Wooting import always uses the base + Fn layers without a selector', () => {
  for (const bundle of [userScript, releaseUserScript]) {
    assert.match(bundle, /const WOOTING_IMPORT_LAYERS = \[0, 1\]/);
    assert.ok(
      bundle.includes('layers: WOOTING_IMPORT_LAYERS'),
      'Wooting import must pass the fixed layer selection',
    );
    assert.doesNotMatch(bundle, /data-field="wooting-layers"/, 'the layer selector must be gone');
    assert.doesNotMatch(bundle, /readWootingLayers/, 'the layer reader must be gone');
  }
});

test('debug bundle keeps the two-step flow, connect buttons and dispatch', () => {
  for (const marker of [
    'data-action="keyboard"',
    'data-action="screen"',
    'data-action="disconnect"',
    'data-action="download"',
    'data-action="load-restore"',
    'handlers.connectKeyboard',
  ]) {
    assert.ok(userScript.includes(marker), `debug bundle must contain ${marker}`);
  }
  // The debug-only branch of the backup handler (enable the Download button).
  assert.match(userScript, /setActionEnabled\(['"]download['"]/);
});

test('debug bundle contains no release-only traces', () => {
  for (const marker of [
    'data-field="restore-dialog"',
    'data-action="dialog-confirm"',
    'data-action="dialog-cancel"',
    'data-action="dialog-pick"',
  ]) {
    assert.ok(!userScript.includes(marker), `debug bundle must not contain ${marker}`);
  }
  // The compile-time flag must be folded to a literal, never shipped.
  assert.doesNotMatch(userScript, new RegExp(MODE_FLAG));
});

test('release bundle compiles out connect buttons and the two-step flow', () => {
  for (const marker of [
    'data-action="keyboard"',
    'data-action="screen"',
    'data-action="disconnect"',
    'data-action="download"',
    'data-action="load-restore"',
    'handlers.connectKeyboard',
  ]) {
    assert.ok(!releaseUserScript.includes(marker), `release bundle must not contain ${marker}`);
  }
  assert.doesNotMatch(releaseUserScript, /setActionEnabled\(['"]download['"]/);
  assert.doesNotMatch(releaseUserScript, new RegExp(MODE_FLAG));
});

test('layout-mismatch consent dialog ships in both modes', () => {
  for (const bundle of [userScript, releaseUserScript]) {
    for (const marker of [
      'data-field="mismatch-dialog"',
      'data-field="mismatch-body"',
      'data-action="mismatch-confirm"',
      'data-action="mismatch-cancel"',
    ]) {
      assert.ok(bundle.includes(marker), `bundle must contain ${marker}`);
    }
  }
});

test('wooting share fetch is built in (GM direct, no companion script)', () => {
  for (const bundle of [userScript, releaseUserScript]) {
    for (const marker of [
      'data-field="wooting-code"',
      'data-action="wooting"',
      'data-action="wooting-file"',
      'data-field="wooting-file"',
      // The share fetch is merged into the tap: it dispatches GM_xmlhttpRequest
      // directly with the pinned official origin, and falls back to plain
      // fetch when no manager provides the GM bindings.
      'api.wooting.io/public/wootility/profiles',
      'origin: https://wootility.io',
      'unsafeWindow',
    ]) {
      assert.ok(bundle.includes(marker), `bundle must contain ${marker}`);
    }
    assert.match(
      bundle,
      /typeof GM_xmlhttpRequest !== 'undefined'/,
      'bundle must resolve the manager request function at runtime',
    );
    assert.match(
      bundle,
      /GM\.xmlHttpRequest/,
      'bundle must support the promise-style GM request variant',
    );
    assert.ok(
      !bundle.includes('__zmeowShareFetch'),
      'the companion-bridge handoff must be gone',
    );
  }
});

test('release bundle wires the one-step backup and the restore dialog', () => {
  for (const marker of [
    'data-field="restore-dialog"',
    'data-action="dialog-confirm"',
    'data-action="dialog-cancel"',
    'data-action="dialog-pick"',
    // One-step backup: the release branch downloads right after capture.
    /zmeow-config-/,
    // Dialog confirm button starts disabled until a file validates.
    /data-action="dialog-confirm"[^>]*disabled/,
  ]) {
    if (typeof marker === 'string') {
      assert.ok(releaseUserScript.includes(marker), `release bundle must contain ${marker}`);
    } else {
      assert.match(releaseUserScript, marker);
    }
  }
});

test('release artifact has its own metadata header and parses', () => {
  assert.ok(releaseMetaScript.startsWith('// ==UserScript==\n'));
  assert.ok(releaseMetaScript.trimEnd().endsWith('// ==/UserScript=='));
  assert.ok(!releaseMetaScript.includes('Generated by'), 'release meta.js must not include the bundle');
  assert.ok(
    releaseUserScript.startsWith(`${releaseMetaScript.trimEnd()}\n`),
    'release user.js must reuse the header',
  );

  const result = spawnSync(process.execPath, ['--check', path.join(outdir, RELEASE_USER_SCRIPT)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `node --check failed for the release bundle\n${result.stderr}`);
});

test('bundle executes through the CommonJS registry', async () => {
  const fixture = path.join(workspace, 'smoke');
  await mkdir(path.join(fixture, 'src'), { recursive: true });
  await writeFile(
    path.join(fixture, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    'utf8',
  );
  await writeFile(
    path.join(fixture, 'src', 'main.ts'),
    [
      "import { add } from './math.js';",
      '(window as any).__SMOKE__ = { total: add(20, 22) };',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = runBuild(fixture);
  assert.equal(result.status, 0, `build failed\n${result.stdout}\n${result.stderr}`);

  const bundle = await readFile(path.join(fixture, 'dist', USER_SCRIPT), 'utf8');
  const context = { window: {}, console };
  runInNewContext(bundle, context);
  assert.equal(context.window.__SMOKE__.total, 42);
});

test('build reports missing modules readably', async () => {
  const fixture = path.join(workspace, 'missing');
  await mkdir(path.join(fixture, 'src'), { recursive: true });
  await writeFile(
    path.join(fixture, 'src', 'main.ts'),
    "import { value } from './does-not-exist.ts';\nconsole.log(value);\n",
    'utf8',
  );

  const result = runBuild(fixture);
  assert.equal(result.status, 1, 'missing import must fail the build');
  assert.match(`${result.stdout}\n${result.stderr}`, /Cannot resolve module "\.\/does-not-exist\.ts"/);
});

test('build rejects circular imports with the cycle chain', async () => {
  const fixture = path.join(workspace, 'cycle');
  await mkdir(path.join(fixture, 'src'), { recursive: true });
  await writeFile(
    path.join(fixture, 'src', 'a.ts'),
    "import { b } from './b.ts';\nexport const a = b + 1;\n",
    'utf8',
  );
  await writeFile(
    path.join(fixture, 'src', 'b.ts'),
    "import { a } from './a.ts';\nexport const b = a + 1;\n",
    'utf8',
  );

  const result = runBuild(fixture, 'a.ts');
  assert.equal(result.status, 1, 'circular import must fail the build');
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /Circular import detected/);
  assert.match(output, /a\.ts/);
  assert.match(output, /b\.ts/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runBuild(fixture, entry = 'main.ts') {
  return spawnSync(
    process.execPath,
    [
      BUILD_SCRIPT,
      '--entry',
      path.join(fixture, 'src', entry),
      '--outdir',
      path.join(fixture, 'dist'),
    ],
    { cwd: PACKAGE_ROOT, encoding: 'utf8' },
  );
}
