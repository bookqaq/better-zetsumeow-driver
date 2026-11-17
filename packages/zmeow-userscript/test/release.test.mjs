import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'release.mjs');
const DISPLAY_NAME = 'Better ZetsuMeow Driver';
const USER_SCRIPT = 'better-zmeow-driver.user.js';
const META_SCRIPT = 'better-zmeow-driver.meta.js';
const CHECKSUMS = 'SHA256SUMS.txt';
const NOTES = 'RELEASE-NOTES.md';

const DEBUG_TRACES = [
  'data-action="keyboard"',
  'data-action="screen"',
  'data-action="disconnect"',
  'data-action="download"',
  'data-action="load-restore"',
  'handlers.connectKeyboard',
];

let workspace;
let outdir;
let version;
let userScript;
let metaScript;
let checksums;
let notes;

before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'better-zmeow-driver-release-test-'));
  outdir = path.join(workspace, 'release');

  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  version = pkg.version;

  const result = spawnSync(
    process.execPath,
    [RELEASE_SCRIPT, '--skip-check', '--allow-dirty', '--outdir', outdir],
    { cwd: PACKAGE_ROOT, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `release.mjs failed\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
  );

  userScript = await readFile(path.join(outdir, USER_SCRIPT), 'utf8');
  metaScript = await readFile(path.join(outdir, META_SCRIPT), 'utf8');
  checksums = await readFile(path.join(outdir, CHECKSUMS), 'utf8');
  notes = await readFile(path.join(outdir, NOTES), 'utf8');
});

after(async () => {
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

test('writes the release-mode userscript, metadata, checksums and notes', () => {
  assert.ok(userScript.length > 0, 'release userscript must not be empty');
  assert.ok(metaScript.length > 0, 'meta.js must not be empty');
  assert.ok(checksums.length > 0, 'checksums must not be empty');
  assert.ok(notes.length > 0, 'release notes must not be empty');
  assert.ok(userScript.startsWith('// ==UserScript==\n'), 'release userscript must start with metadata');
  assert.ok(metaScript.endsWith('// ==/UserScript==\n'), 'meta.js must contain only the header');
});

test('release artifact uses the exact display name and package version', () => {
  assert.match(
    userScript,
    new RegExp(`^// @name\\s+${escapeRegExp(DISPLAY_NAME)}$`, 'm'),
    `@name must be ${DISPLAY_NAME}`,
  );
  assert.match(
    userScript,
    new RegExp(`^// @version\\s+${escapeRegExp(version)}$`, 'm'),
    `@version must match package.json (${version})`,
  );
  assert.match(userScript, /^\/\/ @license\s+MIT$/m, '@license MIT must be present');
  assert.match(
    userScript,
    /^\/\/ @match\s+https:\/\/driver\.zetsumeow\.com\/\*$/m,
    'production driver @match must be present',
  );
  for (const pattern of [
    /^\/\/ @match\s+http:\/\/localhost\/\*$/m,
    /^\/\/ @match\s+http:\/\/127\.0\.0\.1(?::\d+)?\/\*$/m,
  ]) {
    assert.doesNotMatch(userScript, pattern, 'release must not match local development origins');
  }
  assert.ok(
    !userScript.includes('PRODUCTION ORIGIN PLACEHOLDER'),
    'release artifact must not ship the placeholder',
  );
});

test('release artifact reuses the meta header and contains release-only traces', () => {
  assert.ok(userScript.startsWith(metaScript), 'user.js must start with the exact meta header');
  for (const marker of [
    'data-field="restore-dialog"',
    'data-action="dialog-confirm"',
    'data-action="dialog-cancel"',
    'data-action="dialog-pick"',
  ]) {
    assert.ok(userScript.includes(marker), `release artifact must contain ${marker}`);
  }
  for (const marker of DEBUG_TRACES) {
    assert.ok(!userScript.includes(marker), `release artifact must not contain ${marker}`);
  }
  assert.ok(!userScript.includes('__ZMEOW_RELEASE__'), 'mode flag must be folded away');
});

test('release artifact parses with node --check', () => {
  const result = spawnSync(process.execPath, ['--check', path.join(outdir, USER_SCRIPT)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `node --check failed\n${result.stderr}`);
});

test('SHA256SUMS.txt matches the generated artifacts', async () => {
  const lines = checksums
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  assert.equal(lines.length, 2, 'checksums must cover the userscript and meta header');

  for (const line of lines) {
    const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
    assert.ok(match, `invalid checksum line: ${line}`);
    const [, expected, file] = match;
    assert.ok([USER_SCRIPT, META_SCRIPT].includes(file), `unexpected checksum file: ${file}`);
    const contents = await readFile(path.join(outdir, file));
    const actual = createHash('sha256').update(contents).digest('hex');
    assert.equal(actual, expected, `checksum mismatch for ${file}`);
  }
});

test('release notes describe the release and never mention debug artifacts', () => {
  assert.ok(notes.includes(`# ${DISPLAY_NAME} v${version}`), 'notes must include the display name and version');
  assert.ok(notes.includes(`userscript-v${version}`), 'notes must include the suggested tag');
  assert.ok(notes.includes(USER_SCRIPT), 'notes must list the userscript');
  assert.ok(notes.includes(META_SCRIPT), 'notes must list the meta header');
  assert.ok(notes.includes(CHECKSUMS), 'notes must point at the checksum file');
  assert.ok(notes.includes('License: MIT'), 'notes must state the license');
  for (const marker of DEBUG_TRACES) {
    assert.ok(!notes.includes(marker), `notes must not mention debug marker ${marker}`);
  }
});

test('--publish uploads npm and GitHub release assets', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, raw });

    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && url.pathname.includes('/releases/tags/')) {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/repos/bookqaq/zmeow-tools/releases') {
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          id: 101,
          html_url: `https://github.com/bookqaq/zmeow-tools/releases/tag/userscript-v${version}`,
        }),
      );
      return;
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/uploads/repos/bookqaq/zmeow-tools/releases/101/assets'
    ) {
      response.statusCode = 201;
      response.end(JSON.stringify({ id: 1, name: url.searchParams.get('name') }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });

  const publishOutdir = path.join(workspace, 'publish');
  const npmLog = path.join(workspace, 'npm-publish.json');
  const npmSnapshot = path.join(workspace, 'npm-package');
  const fakeNpm = path.join(workspace, 'fake-npm.mjs');
  await writeFile(
    fakeNpm,
    [
      '#!/usr/bin/env node',
      "import { cp, writeFile } from 'node:fs/promises';",
      'const args = process.argv.slice(2);',
      'await writeFile(process.env.ZMEOW_TEST_NPM_LOG, JSON.stringify(args));',
      'await cp(args[1], process.env.ZMEOW_TEST_NPM_SNAPSHOT, { recursive: true });',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(fakeNpm, 0o755);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  try {
    const child = spawn(
      process.execPath,
      [
        RELEASE_SCRIPT,
        '--publish',
        '--skip-check',
        '--allow-dirty',
        '--github-api-url',
        `http://127.0.0.1:${address.port}/api`,
        '--github-upload-url',
        `http://127.0.0.1:${address.port}/uploads`,
        '--github-owner',
        'bookqaq',
        '--github-repo',
        'zmeow-tools',
        '--npm-registry',
        'https://registry.npmjs.org/',
        '--outdir',
        publishOutdir,
      ],
      {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          ZMEOW_GITHUB_TOKEN: 'test-github-token',
          ZMEOW_NPM_TOKEN: 'test-npm-token',
          ZMEOW_NPM_BIN: fakeNpm,
          ZMEOW_TEST_NPM_LOG: npmLog,
          ZMEOW_TEST_NPM_SNAPSHOT: npmSnapshot,
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    const [code] = await once(child, 'close');
    clearTimeout(timer);
    assert.equal(
      code,
      0,
      `release.mjs --publish failed\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );

    const publishedMeta = await readFile(path.join(publishOutdir, META_SCRIPT), 'utf8');
    assert.match(
      publishedMeta,
      /^\/\/ @downloadURL\s+https:\/\/registry\.npmmirror\.com\/@bookqaq\/better-zmeow-driver\/latest\/files\/better-zmeow-driver\.user\.js$/m,
    );
    assert.match(
      publishedMeta,
      /^\/\/ @updateURL\s+https:\/\/registry\.npmmirror\.com\/@bookqaq\/better-zmeow-driver\/latest\/files\/better-zmeow-driver\.meta\.js$/m,
    );

    const npmArgs = JSON.parse(await readFile(npmLog, 'utf8'));
    assert.equal(npmArgs[0], 'publish');
    assert.ok(npmArgs.includes('--access'));
    assert.ok(npmArgs.includes('public'));
    assert.ok(npmArgs.includes('--registry'));
    assert.ok(npmArgs.includes('https://registry.npmjs.org'));
    const npmPackage = JSON.parse(await readFile(path.join(npmSnapshot, 'package.json'), 'utf8'));
    assert.equal(npmPackage.name, '@bookqaq/better-zmeow-driver');
    assert.equal(npmPackage.version, version);
    for (const file of [USER_SCRIPT, META_SCRIPT, CHECKSUMS, NOTES, 'README.md', 'LICENSE']) {
      const contents = await readFile(path.join(npmSnapshot, file));
      assert.ok(contents.byteLength > 0, `${file} must be present in the npm package`);
    }

    const releasePosts = requests.filter(
      (entry) =>
        entry.method === 'POST' &&
        entry.pathname === '/api/repos/bookqaq/zmeow-tools/releases',
    );
    assert.equal(releasePosts.length, 1, 'must create one GitHub release');
    const uploads = requests.filter(
      (entry) =>
        entry.method === 'POST' &&
        entry.pathname === '/uploads/repos/bookqaq/zmeow-tools/releases/101/assets',
    );
    assert.equal(uploads.length, 4, 'must upload four assets to the GitHub release');
    assert.ok(
      requests.some(
        (entry) =>
          entry.pathname ===
          `/api/repos/bookqaq/zmeow-tools/releases/tags/userscript-v${version}`,
      ),
      'must check for an existing GitHub release',
    );
    const releaseBody = JSON.parse(releasePosts[0].raw.toString());
    assert.equal(releaseBody.tag_name, `userscript-v${version}`);
    assert.equal(releaseBody.target_commitish.length, 40);
    assert.ok(uploads.every((entry) => entry.raw.byteLength > 0));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('--publish runs npm with inherited stdio so 2FA prompts can be answered', async () => {
  const interactiveLog = path.join(workspace, 'interactive-npm.json');
  const fakeNpm = path.join(workspace, 'interactive-npm.mjs');
  await writeFile(
    fakeNpm,
    [
      '#!/usr/bin/env node',
      "import { writeFile } from 'node:fs/promises';",
      "console.log('fake-npm: Press ENTER to open in the browser...');",
      'const timer = setTimeout(async () => {',
      "  await writeFile(process.env.ZMEOW_TEST_TTY_LOG, JSON.stringify({ input: null }));",
      '  process.exit(2);',
      '}, 10000);',
      "process.stdin.setEncoding('utf8');",
      "process.stdin.once('data', async (chunk) => {",
      '  clearTimeout(timer);',
      '  await writeFile(process.env.ZMEOW_TEST_TTY_LOG, JSON.stringify({ input: chunk }));',
      '  process.exit(0);',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(fakeNpm, 0o755);

  const child = spawn(
    process.execPath,
    [
      RELEASE_SCRIPT,
      '--publish',
      '--skip-github',
      '--skip-check',
      '--allow-dirty',
      '--outdir',
      path.join(workspace, 'interactive-release'),
    ],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        ZMEOW_NPM_TOKEN: 'test-npm-token',
        ZMEOW_NPM_BIN: fakeNpm,
        ZMEOW_TEST_TTY_LOG: interactiveLog,
      },
    },
  );

  let stdout = '';
  let stderr = '';
  let answered = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!answered && stdout.includes('Press ENTER to open in the browser')) {
      answered = true;
      child.stdin.write('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const killTimer = setTimeout(() => child.kill('SIGKILL'), 60000);
  const [code] = await once(child, 'close');
  clearTimeout(killTimer);
  assert.equal(code, 0, `release.mjs --publish failed\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  assert.ok(answered, 'the fake npm prompt must reach the terminal through inherited stdout');

  const result = JSON.parse(await readFile(interactiveLog, 'utf8'));
  assert.ok(
    typeof result.input === 'string' && result.input.includes('\n'),
    'npm must receive stdin through inherited stdio for web 2FA / OTP prompts',
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
