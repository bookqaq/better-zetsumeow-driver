#!/usr/bin/env node
/**
 * Zero-dependency release packager for the Better ZetsuMeow Driver userscript.
 *
 * Local mode validates the workspace, runs the repository checks, produces a
 * release-mode bundle in a clean staging directory, verifies the metadata and
 * mode-specific traces, and writes checksums plus release notes.
 *
 * With `--publish` it also:
 *   1. publishes the userscript package to the npm registry, and
 *   2. creates a GitHub Release and uploads the same assets.
 *
 * `npm publish` runs with the terminal attached (inherited stdio) so npm can
 * complete its two-factor authentication: it prints the web-auth URL, waits for
 * ENTER, opens the browser and polls until the account owner finishes. The
 * script waits for npm instead of capturing output, so a 2FA challenge is never
 * skipped or bypassed.
 *
 * Auto-update metadata points at the jsDelivr npm CDN by default, and can be
 * overridden with ZMEOW_UPDATE_BASE_URL or --update-base-url.
 *
 * Usage:
 *   node scripts/release.mjs
 *   node scripts/release.mjs --publish
 *   node scripts/release.mjs --publish --dry-run
 *   node scripts/release.mjs --skip-check --allow-dirty   # local verification only
 *
 * Defaults:
 *   outdir  dist/release
 *   update  https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver
 *
 * The default run requires a clean git working tree and executes `pnpm check`
 * from the repository root. `--skip-check` and `--allow-dirty` exist for local
 * debugging; do not use them for a real release.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BUILD_SCRIPT = path.join(PACKAGE_ROOT, 'build.mjs');
const PACKAGE_JSON = path.join(PACKAGE_ROOT, 'package.json');
const PACKAGE_README = path.join(PACKAGE_ROOT, 'README.md');
const REPO_LICENSE = path.join(REPO_ROOT, 'LICENSE');
const SDK_PACKAGE_JSON = path.join(REPO_ROOT, 'packages', 'zmeow-sdk', 'package.json');
const DEFAULT_OUTDIR = path.join(PACKAGE_ROOT, 'dist', 'release');

const PACKAGE_NAME = '@bookqaq/better-zmeow-driver';
const DISPLAY_NAME = 'Better ZetsuMeow Driver';
const TAG_PREFIX = 'userscript-v';
const FILE_BASE = 'better-zmeow-driver';
const FINAL_USER = `${FILE_BASE}.user.js`;
const FINAL_META = `${FILE_BASE}.meta.js`;
const RELEASE_USER = `${FILE_BASE}.release.user.js`;
const RELEASE_META = `${FILE_BASE}.release.meta.js`;
const CHECKSUMS = 'SHA256SUMS.txt';
const NOTES = 'RELEASE-NOTES.md';

const DEFAULT_UPDATE_BASE_URL =
  'https://cdn.jsdelivr.net/npm/@bookqaq/better-zmeow-driver';
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const DEFAULT_GITHUB_UPLOAD_URL = 'https://uploads.github.com';
const DEFAULT_GITHUB_OWNER = 'bookqaq';
const DEFAULT_GITHUB_REPO = 'better-zetsumeow-driver';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
// npm publish may stop for a browser-based 2FA challenge (or a classic OTP
// prompt) and poll until the account owner finishes it. That is interactive by
// design, so npm runs with inherited stdio and this script waits for it.
const DEFAULT_PUBLISH_TIMEOUT_MS = 30 * 60 * 1000;

const DEBUG_TRACES = [
  'data-action="keyboard"',
  'data-action="screen"',
  'data-action="disconnect"',
  'data-action="download"',
  'data-action="load-restore"',
  'handlers.connectKeyboard',
];

const RELEASE_TRACES = [
  'data-field="restore-dialog"',
  'data-action="dialog-confirm"',
  'data-action="dialog-cancel"',
  'data-action="dialog-pick"',
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'));
  const version = validatePackage(pkg);
  const outdir = path.resolve(options.outdir ?? DEFAULT_OUTDIR);
  assertSafeOutdir(outdir);

  const publishPlan = options.publish ? resolvePublishPlan(options) : null;
  const updateBaseUrl =
    options.updateBaseUrl ??
    process.env['ZMEOW_UPDATE_BASE_URL'] ??
    DEFAULT_UPDATE_BASE_URL;

  if (!options.allowDirty) assertCleanTree();
  if (!options.skipCheck) runPnpmCheck();

  await mkdir(outdir, { recursive: true });
  runNode([
    BUILD_SCRIPT,
    '--mode=release',
    '--outdir',
    outdir,
    '--update-base-url',
    updateBaseUrl,
  ]);

  const builtUser = path.join(outdir, RELEASE_USER);
  const builtMeta = path.join(outdir, RELEASE_META);
  const finalUser = path.join(outdir, FINAL_USER);
  const finalMeta = path.join(outdir, FINAL_META);

  await copyFile(builtUser, finalUser);
  await copyFile(builtMeta, finalMeta);
  await rm(builtUser, { force: true });
  await rm(builtMeta, { force: true });

  const userScript = await readFile(finalUser, 'utf8');
  const metaScript = await readFile(finalMeta, 'utf8');
  const sdkVersion = readOptionalVersion(SDK_PACKAGE_JSON) ?? 'unknown';
  const commit = readCommit();
  const commitSha = readCommitSha();
  const dirty = gitStatus().length > 0;
  const changes = readChanges();

  validateArtifacts({ userScript, metaScript, version, userFile: finalUser, updateBaseUrl });

  const artifacts = [
    await describeArtifact(finalUser),
    await describeArtifact(finalMeta),
  ];
  const checksums = `${artifacts.map((artifact) => `${artifact.hash}  ${artifact.name}`).join('\n')}\n`;
  const notes = buildNotes({ version, sdkVersion, commit, dirty, artifacts, changes, updateBaseUrl });
  await writeFile(path.join(outdir, CHECKSUMS), checksums, 'utf8');
  await writeFile(path.join(outdir, NOTES), notes, 'utf8');

  let publishResult = null;
  if (publishPlan !== null) {
    publishResult = await publishRelease({
      plan: publishPlan,
      version,
      outdir,
      notes,
      commitSha,
      dryRun: options.dryRun,
    });
  }

  printSummary({ version, outdir, artifacts, dirty, updateBaseUrl, publishResult });
}

function parseArgs(argv) {
  const options = {
    outdir: null,
    skipCheck: false,
    allowDirty: false,
    publish: false,
    dryRun: false,
    skipNpm: false,
    skipGithub: false,
    updateBaseUrl: null,
    npmRegistry: null,
    githubApiUrl: null,
    githubUploadUrl: null,
    githubOwner: null,
    githubRepo: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // `pnpm run release -- --help` forwards the separator literally; accept it.
    if (arg === '--') continue;
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);

    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`Missing value for ${flag}`);
      index += 1;
      return next;
    };

    switch (flag) {
      case '--outdir':
        options.outdir = path.resolve(process.cwd(), value());
        break;
      case '--update-base-url':
        options.updateBaseUrl = normalizeBaseUrl(value(), '--update-base-url');
        break;
      case '--npm-registry':
        options.npmRegistry = normalizeBaseUrl(value(), '--npm-registry');
        break;
      case '--github-api-url':
        options.githubApiUrl = normalizeBaseUrl(value(), '--github-api-url');
        break;
      case '--github-upload-url':
        options.githubUploadUrl = normalizeBaseUrl(value(), '--github-upload-url');
        break;
      case '--github-owner':
        options.githubOwner = value();
        break;
      case '--github-repo':
        options.githubRepo = value();
        break;
      case '--publish':
        options.publish = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--skip-npm':
        options.skipNpm = true;
        break;
      case '--skip-github':
        options.skipGithub = true;
        break;
      case '--skip-check':
        options.skipCheck = true;
        break;
      case '--allow-dirty':
        options.allowDirty = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(
          `Unknown argument "${arg}". Usage: node scripts/release.mjs [--outdir <dir>] [--publish] [--dry-run] [options]`,
        );
    }
  }

  return options;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/release.mjs [--outdir <dir>] [--publish] [--dry-run] [options]',
      '',
      `Builds the ${DISPLAY_NAME} release bundle, validates its metadata and mode`,
      'traces, writes SHA256SUMS.txt and RELEASE-NOTES.md, and optionally publishes',
      'it to npm and GitHub Releases.',
      '',
      'Options:',
      '  --outdir <dir>          Staging directory (default: packages/zmeow-userscript/dist/release)',
      '  --update-base-url <u>   Stable @downloadURL / @updateURL base',
      '  --publish               Publish to npm and create the GitHub Release',
      '  --dry-run               Print the publish plan without running npm or the API',
      '  --skip-npm              Skip the npm publish step',
      '  --skip-github           Skip the GitHub Release step',
      '  --npm-registry <u>      npm registry (default: https://registry.npmjs.org/)',
      '  --github-api-url <u>    GitHub API base (default: https://api.github.com)',
      '  --github-upload-url <u> GitHub upload base (default: https://uploads.github.com)',
      '  --github-owner <owner>  GitHub owner (default: bookqaq)',
      '  --github-repo <repo>    GitHub repo (default: better-zetsumeow-driver)',
      '  --skip-check            Skip `pnpm check` (local debugging only)',
      '  --allow-dirty           Allow an unclean git tree (local debugging only)',
      '  -h, --help              Show this help',
      '',
      'Env: ZMEOW_NPM_TOKEN / NPM_TOKEN, ZMEOW_GITHUB_TOKEN / GITHUB_TOKEN,',
      '  ZMEOW_UPDATE_BASE_URL, ZMEOW_NPM_REGISTRY, ZMEOW_GITHUB_API_URL,',
      '  ZMEOW_GITHUB_UPLOAD_URL, ZMEOW_GITHUB_OWNER, ZMEOW_GITHUB_REPO,',
      '  ZMEOW_PUBLISH_TIMEOUT_MS (default 1800000, npm 2FA wait).',
      '  GitHub Actions: GITHUB_REPOSITORY and GITHUB_TOKEN are also accepted.',
      '',
      'npm publish inherits the terminal so a web 2FA page or OTP prompt can be',
      'completed; the script waits until npm finishes. Run it from a terminal,',
      'not through a pipe, when the npm account requires two-factor auth.',
    ].join('\n'),
  );
}

function normalizeBaseUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL, got "${value}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} must use http:// or https://, got "${value}".`);
  }
  return value.replace(/\/+$/, '');
}

function resolvePublishPlan(options) {
  if (options.skipNpm && options.skipGithub) {
    throw new Error('--skip-npm and --skip-github cannot both be set.');
  }

  const npmRegistry = normalizeBaseUrl(
    options.npmRegistry ?? process.env['ZMEOW_NPM_REGISTRY'] ?? DEFAULT_NPM_REGISTRY,
    'npm registry (--npm-registry / ZMEOW_NPM_REGISTRY)',
  );
  const githubApiUrl = normalizeBaseUrl(
    options.githubApiUrl ?? process.env['ZMEOW_GITHUB_API_URL'] ?? DEFAULT_GITHUB_API_URL,
    'GitHub API URL (--github-api-url / ZMEOW_GITHUB_API_URL)',
  );
  const githubUploadUrl = normalizeBaseUrl(
    options.githubUploadUrl ?? process.env['ZMEOW_GITHUB_UPLOAD_URL'] ?? DEFAULT_GITHUB_UPLOAD_URL,
    'GitHub upload URL (--github-upload-url / ZMEOW_GITHUB_UPLOAD_URL)',
  );

  const repository = (process.env['GITHUB_REPOSITORY'] ?? '')
    .split('/')
    .filter(Boolean);
  const githubOwner =
    options.githubOwner ??
    process.env['ZMEOW_GITHUB_OWNER'] ??
    repository[0] ??
    DEFAULT_GITHUB_OWNER;
  const githubRepo =
    options.githubRepo ??
    process.env['ZMEOW_GITHUB_REPO'] ??
    repository[1] ??
    DEFAULT_GITHUB_REPO;
  if (!/^[A-Za-z0-9_.-]+$/.test(githubOwner) || !/^[A-Za-z0-9_.-]+$/.test(githubRepo)) {
    throw new Error(`Invalid GitHub repository "${githubOwner}/${githubRepo}".`);
  }

  return {
    skipNpm: options.skipNpm,
    skipGithub: options.skipGithub,
    npm: {
      registry: npmRegistry,
      token: process.env['ZMEOW_NPM_TOKEN'] ?? process.env['NPM_TOKEN'] ?? null,
    },
    github: {
      apiUrl: githubApiUrl,
      uploadUrl: githubUploadUrl,
      owner: githubOwner,
      repo: githubRepo,
      token: process.env['ZMEOW_GITHUB_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? null,
    },
  };
}

function validatePackage(pkg) {
  if (pkg.name !== PACKAGE_NAME) {
    throw new Error(`Unexpected package name "${pkg.name}", expected "${PACKAGE_NAME}".`);
  }
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json version "${version}" is not a valid release version.`);
  }
  return version;
}

function assertSafeOutdir(outdir) {
  const forbidden = new Set([path.parse(outdir).root, REPO_ROOT, PACKAGE_ROOT]);
  if (forbidden.has(outdir)) {
    throw new Error(`Refusing to use ${outdir} as the release output directory.`);
  }
}

function assertCleanTree() {
  const status = gitStatus();
  if (status.length > 0) {
    throw new Error(
      [
        'Git working tree is not clean:',
        ...status.map((line) => `  ${line}`),
        'Commit or stash the changes before releasing, or pass --allow-dirty for local verification only.',
      ].join('\n'),
    );
  }
}

function runPnpmCheck() {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, ['check'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.error !== undefined) {
    throw new Error(
      `Cannot run "pnpm check": ${result.error.message}\nInstall pnpm or run with --skip-check for a local-only build.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`pnpm check failed with exit code ${result.status}.`);
  }
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: PACKAGE_ROOT, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: node ${args.join(' ')}`);
  }
}

function validateArtifacts({ userScript, metaScript, version, userFile, updateBaseUrl }) {
  assert(userScript.startsWith('// ==UserScript==\n'), `${FINAL_USER} must start with the metadata header.`);
  assert(metaScript.startsWith('// ==UserScript==\n'), `${FINAL_META} must start with the metadata header.`);
  assert(metaScript.trimEnd().endsWith('// ==/UserScript=='), `${FINAL_META} must end with ==/UserScript==.`);
  assert(
    userScript.startsWith(metaScript),
    `${FINAL_USER} must reuse the exact ${FINAL_META} header.`,
  );

  assert(
    new RegExp(`^// @name\\s+${escapeRegExp(DISPLAY_NAME)}$`, 'm').test(userScript),
    `@name must be exactly "${DISPLAY_NAME}".`,
  );
  assert(
    new RegExp(`^// @version\\s+${escapeRegExp(version)}$`, 'm').test(userScript),
    `@version must match packages/zmeow-userscript/package.json (${version}).`,
  );
  assert(
    /^\/\/ @author\s+\S+/m.test(userScript),
    'Release artifact must declare @author.',
  );
  assert(
    /^\/\/ @license\s+MIT$/m.test(userScript),
    'Release artifact must declare @license MIT.',
  );
  assert(
    new RegExp(
      `^// @downloadURL\\s+${escapeRegExp(`${updateBaseUrl}/${FINAL_USER}`)}$`,
      'm',
    ).test(userScript),
    `@downloadURL must be ${updateBaseUrl}/${FINAL_USER}.`,
  );
  assert(
    new RegExp(
      `^// @updateURL\\s+${escapeRegExp(`${updateBaseUrl}/${FINAL_META}`)}$`,
      'm',
    ).test(userScript),
    `@updateURL must be ${updateBaseUrl}/${FINAL_META}.`,
  );
  assert(
    !userScript.includes('PRODUCTION ORIGIN PLACEHOLDER'),
    'The production-origin placeholder must not ship in a release.',
  );

  const matches = Array.from(userScript.matchAll(/^\/\/ @match\s+(\S+)$/gm), (match) => match[1]);
  assert(
    matches.some((pattern) => pattern.startsWith('https://') && !isLocalOrigin(pattern)),
    'At least one non-local https:// @match is required for a release.',
  );
  assert(
    !matches.some((pattern) => /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(pattern)),
    'Release artifact must not match localhost or 127.0.0.1.',
  );

  assert(!userScript.includes('__ZMEOW_RELEASE__'), 'Release bundle still contains the compile-time mode flag.');
  for (const marker of RELEASE_TRACES) {
    assert(userScript.includes(marker), `Release bundle must contain ${marker}.`);
  }
  for (const marker of DEBUG_TRACES) {
    assert(!userScript.includes(marker), `Release bundle must not contain debug marker ${marker}.`);
  }

  const check = spawnSync(process.execPath, ['--check', userFile], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  if (check.status !== 0) {
    throw new Error(`node --check failed for ${FINAL_USER}:\n${check.stderr || check.stdout}`);
  }
}

function isLocalOrigin(pattern) {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(pattern);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function describeArtifact(file) {
  const contents = await readFile(file);
  return {
    name: path.basename(file),
    hash: createHash('sha256').update(contents).digest('hex'),
    size: contents.byteLength,
  };
}

function buildNotes({ version, sdkVersion, commit, dirty, artifacts, changes, updateBaseUrl }) {
  const builtAt = new Date().toISOString();
  const tag = `${TAG_PREFIX}${version}`;
  const changeLines =
    changes.commits.length > 0
      ? changes.commits.map((line) => `- ${line}`).join('\n')
      : '- 请手动补充本次发布说明。';

  return [
    `# ${DISPLAY_NAME} v${version}`,
    '',
    `- Tag: \`${tag}\``,
    `- Commit: \`${commit ?? 'unknown'}\`${dirty ? ' (dirty working tree)' : ''}`,
    `- Built: ${builtAt}`,
    `- Build mode: release`,
    `- SDK: ${sdkVersion}`,
    '- License: MIT',
    '',
    '## Artifacts',
    '',
    '| File | Size | SHA-256 |',
    '| --- | --- | --- |',
    ...artifacts.map(
      (artifact) => `| \`${artifact.name}\` | ${formatBytes(artifact.size)} | \`${artifact.hash}\` |`,
    ),
    '',
    '## Install',
    '',
    '1. Install Tampermonkey (or a compatible userscript manager) in a Chromium-based browser.',
    `2. Open \`${FINAL_USER}\` from the release assets and confirm the install.`,
    `3. Open the ZetsuMeow driver page; the **${DISPLAY_NAME}** panel appears in the bottom-right corner.`,
    '',
    '## Release mode',
    '',
    '- Backup captures the config and downloads the JSON in one step.',
    '- Restore opens a pick + confirm dialog; Cancel never writes to the device.',
    '- Connect keyboard / Connect screen / Disconnect are compiled out of this build.',
    '',
    '## Auto-update',
    '',
    `- \`@downloadURL\`: \`${updateBaseUrl}/${FINAL_USER}\``,
    `- \`@updateURL\`: \`${updateBaseUrl}/${FINAL_META}\``,
    '',
    '## Changes',
    '',
    changes.previousTag === null
      ? '本次未找到上一个 `userscript-v*` tag，以下为最近提交，发布前请整理：'
      : `自 \`${changes.previousTag}\` 以来的提交：`,
    '',
    changeLines,
    '',
    '## Checksums',
    '',
    `See \`${CHECKSUMS}\`.`,
    '',
  ].join('\n');
}

async function publishRelease({ plan, version, outdir, notes, commitSha, dryRun }) {
  const tag = `${TAG_PREFIX}${version}`;
  const assetNames = [FINAL_USER, FINAL_META, CHECKSUMS, NOTES];

  if (dryRun) {
    console.log('');
    console.log('[publish] dry-run — no npm publish and no GitHub API requests.');
    if (plan.skipNpm) {
      console.log('[publish] npm: skipped');
    } else {
      console.log(`[publish] npm: ${PACKAGE_NAME}@${version} -> ${plan.npm.registry}`);
    }
    if (plan.skipGithub) {
      console.log('[publish] GitHub: skipped');
    } else {
      console.log(`[publish] GitHub: ${plan.github.owner}/${plan.github.repo} ${tag}`);
      console.log(`[publish] assets: ${assetNames.join(', ')}`);
    }
    return {
      dryRun: true,
      npmUrl: plan.skipNpm ? null : npmPackageUrl(version),
      githubUrl: plan.skipGithub
        ? null
        : `https://github.com/${plan.github.owner}/${plan.github.repo}/releases/tag/${tag}`,
    };
  }

  if (!plan.skipGithub && plan.github.token === null) {
    throw new Error('Publishing to GitHub requires ZMEOW_GITHUB_TOKEN or GITHUB_TOKEN.');
  }
  if (!plan.skipGithub && commitSha === null) {
    throw new Error('Cannot read HEAD; publish the GitHub release from a git checkout.');
  }
  if (!plan.skipGithub) {
    await assertGithubReleaseAbsent(plan, tag);
  }

  let npmResult = null;
  if (!plan.skipNpm) {
    npmResult = await publishNpm({ plan, version, outdir });
  }
  let githubResult = null;
  if (!plan.skipGithub) {
    githubResult = await publishGithub({
      plan,
      version,
      outdir,
      notes,
      commitSha,
      assetNames,
    });
  }

  return {
    dryRun: false,
    npmUrl: npmResult?.url ?? null,
    githubUrl: githubResult?.url ?? null,
  };
}

async function publishNpm({ plan, version, outdir }) {
  const npmDir = await mkdtemp(path.join(tmpdir(), 'zmd-npm-'));
  const npmrcDir =
    plan.npm.token === null ? null : await mkdtemp(path.join(tmpdir(), 'zmd-npmrc-'));
  try {
    await stageNpmPackage({ npmDir, plan, version, outdir });
    const userconfig = npmrcDir === null ? null : await writeNpmrc(npmrcDir, plan.npm);
    const args = [
      'publish',
      npmDir,
      '--access',
      'public',
      '--tag',
      'latest',
      '--ignore-scripts',
      '--registry',
      plan.npm.registry,
    ];
    if (userconfig !== null) args.push('--userconfig', userconfig);

    // npm's 2FA handling (web page or classic OTP prompt) is gated on
    // process.stdin.isTTY && process.stdout.isTTY in npm's otplease(). Inherit
    // both streams and stdin so npm can print the auth URL, wait for ENTER,
    // open the browser and poll until the account owner completes the challenge.
    // Never capture stdio here: that silently disables the interactive flow.
    const timeout = publishTimeoutMs();
    if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log(
        `[publish] npm may open a 2FA page or ask for an OTP; finish it in the browser/terminal, this script waits up to ${formatDuration(timeout)}.`,
      );
    } else {
      console.warn(
        '[publish] warning: no TTY for npm; interactive 2FA (web page or OTP prompt) cannot be completed. Run from a terminal if npm asks for authentication.',
      );
    }

    const result = spawnSync(npmCommand(), args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      timeout,
    });
    if (result.error !== undefined) {
      if (result.error.code === 'ETIMEDOUT') {
        throw new Error(
          `npm publish was still waiting after ${formatDuration(timeout)}; if a web/OTP authentication page was open, complete it and retry, or raise ZMEOW_PUBLISH_TIMEOUT_MS.`,
        );
      }
      throw new Error(
        `Cannot run npm: ${result.error.message}\nInstall npm or use --skip-npm.`,
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `npm publish failed with exit code ${result.status}. See the npm output above; 2FA failures require a terminal so npm can prompt.`,
      );
    }
    console.log(`[publish] npm: ${PACKAGE_NAME}@${version} -> ${plan.npm.registry}`);
    return { url: npmPackageUrl(version) };
  } finally {
    await rm(npmDir, { recursive: true, force: true });
    if (npmrcDir !== null) await rm(npmrcDir, { recursive: true, force: true });
  }
}

async function stageNpmPackage({ npmDir, plan, version, outdir }) {
  for (const name of [FINAL_USER, FINAL_META, CHECKSUMS, NOTES]) {
    await copyFile(path.join(outdir, name), path.join(npmDir, name));
  }
  await copyFile(PACKAGE_README, path.join(npmDir, 'README.md'));
  await copyFile(REPO_LICENSE, path.join(npmDir, 'LICENSE'));

  const repositoryUrl = `https://github.com/${plan.github.owner}/${plan.github.repo}`;
  const packageJson = {
    name: PACKAGE_NAME,
    version,
    description: `${DISPLAY_NAME}: Tampermonkey userscript for ZetsuMeow driver tap, JSON config backup/restore and Wooting profile import`,
    license: 'MIT',
    repository: { type: 'git', url: `git+${repositoryUrl}.git` },
    homepage: `${repositoryUrl}#readme`,
    bugs: { url: `${repositoryUrl}/issues` },
    keywords: ['tampermonkey', 'userscript', 'zetsumeow', 'keyboard'],
    files: [FINAL_USER, FINAL_META, CHECKSUMS, NOTES, 'README.md', 'LICENSE'],
  };
  await writeFile(
    path.join(npmDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );
}

async function writeNpmrc(dir, npm) {
  if (npm.token === null) return null;
  const url = new URL(npm.registry);
  const authPath = `${url.host}${url.pathname.replace(/\/?$/, '/')}`;
  const file = path.join(dir, '.npmrc');
  await writeFile(
    file,
    `registry=${npm.registry}\n//${authPath}:_authToken=${npm.token}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(file, 0o600);
  return file;
}

function npmCommand() {
  if (process.env['ZMEOW_NPM_BIN'] !== undefined) return process.env['ZMEOW_NPM_BIN'];
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmPackageUrl(version) {
  return `https://www.npmjs.com/package/${PACKAGE_NAME}/v/${version}`;
}

function publishTimeoutMs() {
  const raw = process.env['ZMEOW_PUBLISH_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_PUBLISH_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `ZMEOW_PUBLISH_TIMEOUT_MS must be a positive number of milliseconds, got "${raw}".`,
    );
  }
  return value;
}

function formatDuration(ms) {
  if (ms >= 60000) {
    const minutes = ms / 60000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
  }
  return `${Math.round(ms / 1000)} s`;
}

async function assertGithubReleaseAbsent(plan, tag) {
  const repoPath = `/repos/${plan.github.owner}/${plan.github.repo}`;
  const existing = await githubRequest(
    plan,
    'GET',
    `${repoPath}/releases/tags/${tag}`,
    undefined,
    { allow404: true },
  );
  if (existing !== null) {
    throw new Error(
      `GitHub release ${tag} already exists. Bump packages/zmeow-userscript/package.json or edit the existing release manually.`,
    );
  }
}

async function publishGithub({ plan, version, outdir, notes, commitSha, assetNames }) {
  const tag = `${TAG_PREFIX}${version}`;
  const repoPath = `/repos/${plan.github.owner}/${plan.github.repo}`;
  const release = await githubRequest(plan, 'POST', `${repoPath}/releases`, {
    tag_name: tag,
    target_commitish: commitSha,
    name: `${DISPLAY_NAME} v${version}`,
    body: notes,
    draft: false,
    prerelease: false,
  });
  if (release === null || typeof release.id !== 'number') {
    throw new Error(`GitHub did not return a release id for ${tag}.`);
  }

  for (const name of assetNames) {
    await uploadGithubAsset(plan, release.id, path.join(outdir, name), name);
  }
  console.log(`[publish] GitHub: ${plan.github.owner}/${plan.github.repo} ${tag}`);
  return {
    url: release.html_url ?? `https://github.com/${plan.github.owner}/${plan.github.repo}/releases/tag/${tag}`,
  };
}

async function uploadGithubAsset(plan, releaseId, file, name) {
  const body = await readFile(file);
  const response = await fetch(
    `${plan.github.uploadUrl}/repos/${plan.github.owner}/${plan.github.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: githubHeaders(plan, 'application/octet-stream'),
      body,
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub upload ${name} failed: HTTP ${response.status} ${truncate(await response.text())}`,
    );
  }
}

async function githubRequest(plan, method, path, body = undefined, { allow404 = false } = {}) {
  const headers = githubHeaders(plan, body === undefined ? undefined : 'application/json');
  let response;
  try {
    response = await fetch(`${plan.github.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    throw new Error(
      `GitHub API request ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (allow404 && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${path} failed: HTTP ${response.status} ${truncate(await response.text())}`,
    );
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

function githubHeaders(plan, contentType) {
  const headers = {
    Authorization: `Bearer ${plan.github.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (contentType !== undefined) headers['Content-Type'] = contentType;
  return headers;
}

function truncate(text, limit = 500) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function readOptionalVersion(file) {
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readCommit() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function readCommitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function gitStatus() {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function readChanges() {
  const tags = spawnSync('git', ['tag', '--list', `${TAG_PREFIX}*`, '--sort=-creatordate'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const previousTag = tags.status === 0 ? tags.stdout.split('\n').filter(Boolean)[0] ?? null : null;
  const range = previousTag === null ? '-20' : `${previousTag}..HEAD`;
  const log = spawnSync('git', ['log', '--oneline', range], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const commits =
    log.status === 0
      ? log.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
  return { previousTag, commits };
}

function printSummary({ version, outdir, artifacts, dirty, updateBaseUrl, publishResult }) {
  const tag = `${TAG_PREFIX}${version}`;
  console.log('');
  console.log(`[release] ${DISPLAY_NAME} v${version}${dirty ? ' (dirty working tree)' : ''}`);
  console.log(`[release] ${outdir}`);
  for (const artifact of artifacts) {
    console.log(`[release]   ${artifact.name}  ${formatBytes(artifact.size)}  sha256=${artifact.hash}`);
  }
  console.log(`[release]   ${CHECKSUMS}`);
  console.log(`[release]   ${NOTES}`);
  console.log(`[release] @downloadURL ${updateBaseUrl}/${FINAL_USER}`);
  console.log(`[release] @updateURL   ${updateBaseUrl}/${FINAL_META}`);

  if (publishResult !== null) {
    console.log('');
    if (publishResult.dryRun) {
      console.log('[release] Dry run only: no npm publish and no GitHub release.');
    } else {
      if (publishResult.npmUrl !== null) console.log(`[release] npm: ${publishResult.npmUrl}`);
      if (publishResult.githubUrl !== null) console.log(`[release] GitHub: ${publishResult.githubUrl}`);
      console.log('[release] Installed scripts auto-update from the jsDelivr metadata URL.');
    }
    return;
  }

  console.log('');
  console.log('[release] Manual next steps:');
  console.log('  1. Review RELEASE-NOTES.md and the metadata header.');
  console.log('  2. Commit the version bump / release changes and push HEAD to GitHub.');
  console.log('  3. Run with --publish to publish to npm and create the GitHub Release/tag.');
  console.log(`  4. To upload manually instead, tag ${tag} and upload the four assets.`);
  console.log('');
  console.log('[release] This script did not commit, tag, push or publish anything.');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

async function run() {
  try {
    await main();
  } catch (error) {
    console.error(`\n[release] failed\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

void run();
