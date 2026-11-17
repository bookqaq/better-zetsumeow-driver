#!/usr/bin/env node
/**
 * Zero-dependency bundler for the zetsumeow Tampermonkey userscript.
 *
 * It uses only Node built-ins plus the TypeScript compiler that is already
 * installed in this workspace, transpiles every reachable module to CommonJS
 * and wraps the whole graph in one IIFE with a tiny module registry.
 *
 * Usage:
 *   node build.mjs                          # builds debug AND release artifacts
 *   node build.mjs --mode=debug             # only dist/better-zmeow-driver.user.js
 *   node build.mjs --mode=release           # only dist/better-zmeow-driver.release.user.js
 *   node build.mjs --outdir /tmp/zmeow-build
 *   node build.mjs --entry src/main.ts --root . --outdir dist   # custom entry
 *
 * Build modes:
 *   - debug (default): two-step backup/restore, connect buttons visible.
 *   - release: one-step backup (auto download), restore via a pick+confirm
 *     dialog, connect buttons compiled out. The mode is a compile-time flag:
 *     `build.mjs` rewrites every `__ZMEOW_RELEASE__` reference to a literal and
 *     folds the dead branches, so neither artifact contains the other mode's
 *     code (see createModeFoldTransformer below).
 *
 * Resolution rules:
 *   - relative imports: `./x.ts`, `./x.js` (maps to `x.ts`), `./x`, `./x/index.ts`
 *   - package alias:    `@bookqaq/zmeow-sdk` -> packages/zmeow-sdk/src/index.ts
 *   - subpath alias:    `@bookqaq/zmeow-sdk/foo` -> packages/zmeow-sdk/src/foo.ts
 * Bare third-party imports and circular imports are rejected with readable errors.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SDK_SRC_ROOT = path.join(REPO_ROOT, 'packages', 'zmeow-sdk', 'src');
const SDK_ENTRY = path.join(SDK_SRC_ROOT, 'index.ts');
const SDK_ALIAS = '@bookqaq/zmeow-sdk';

const DEFAULT_ENTRY = path.join(PACKAGE_ROOT, 'src', 'main.ts');
const DEFAULT_OUTDIR = path.join(PACKAGE_ROOT, 'dist');
const FILE_BASE = 'better-zmeow-driver';
const BUILD_MODES = ['debug', 'release'];
const MODE_FLAG = '__ZMEOW_RELEASE__';
const FALLBACK_VERSION = '0.1.0';

/** Artifact filenames for one build mode. */
function artifactNames(mode) {
  const suffix = mode === 'release' ? '.release' : '';
  return {
    userScript: `${FILE_BASE}${suffix}.user.js`,
    meta: `${FILE_BASE}${suffix}.meta.js`,
  };
}

class BuildError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'BuildError';
    this.hint = hint;
  }
}

/** @type {import('typescript') | null} */
let ts = null;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  ts = loadTypeScript();

  const entry = options.entry ?? path.join(options.root, 'src', 'main.ts');
  const outdir = options.outdir ?? path.join(options.root, 'dist');
  const startedAt = Date.now();

  if (!isFile(entry)) {
    throw new BuildError(
      `Entry module not found: ${displayPath(entry)}`,
      'Pass --entry <file> or put the userscript entry at src/main.ts.',
    );
  }

  const modules = buildModuleGraph(entry);
  const entryId = toModuleId(entry);
  const sdkId = toModuleId(SDK_ENTRY);
  // No explicit --mode: build both artifacts so `pnpm check` / tests always see
  // a fresh release bundle next to the debug one.
  const modes = options.mode === null ? [...BUILD_MODES] : [options.mode];

  await mkdir(outdir, { recursive: true });
  for (const mode of modes) {
    const names = artifactNames(mode);
    const header = buildHeader(mode, options.updateBaseUrl);
    const bundle = assembleBundle(modules, entryId, sdkId, mode);
    if (bundle.includes(MODE_FLAG)) {
      throw new BuildError(
        `Unfolded ${MODE_FLAG} reference remains in the ${mode} bundle.`,
        'The mode-fold transformer must replace every flag reference with a literal before emitting.',
      );
    }
    const userScript = `${header}\n${bundle}`;
    const meta = header;
    const elapsed = Date.now() - startedAt;

    await writeFile(path.join(outdir, names.userScript), userScript, 'utf8');
    await writeFile(path.join(outdir, names.meta), meta, 'utf8');

    printBuilt(path.join(outdir, names.userScript), userScript, modules.size, elapsed);
    printBuilt(path.join(outdir, names.meta), meta, modules.size, elapsed);
  }
}

async function run() {
  try {
    await main();
  } catch (error) {
    if (error instanceof BuildError) {
      console.error(`\n[zmeow-userscript] build failed\n  ${indent(error.message)}`);
      if (error.hint) console.error(`\n${indent(error.hint)}`);
    } else {
      console.error('\n[zmeow-userscript] build failed with an unexpected error');
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

void run();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    root: PACKAGE_ROOT,
    entry: null,
    outdir: null,
    mode: null,
    updateBaseUrl: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);

    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined) throw new BuildError(`Missing value for ${flag}`);
      index += 1;
      return next;
    };

    switch (flag) {
      case '--root':
        options.root = path.resolve(process.cwd(), value());
        break;
      case '--entry':
        options.entry = path.resolve(process.cwd(), value());
        break;
      case '--outdir':
        options.outdir = path.resolve(process.cwd(), value());
        break;
      case '--update-base-url':
        options.updateBaseUrl = normalizeUpdateBaseUrl(value());
        break;
      case '--mode': {
        const requested = value();
        if (!BUILD_MODES.includes(requested)) {
          throw new BuildError(
            `Unknown build mode "${requested}"`,
            `Supported modes: ${BUILD_MODES.join(', ')}. Omit --mode to build both.`,
          );
        }
        options.mode = requested;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new BuildError(
          `Unknown argument "${arg}"`,
          'Usage: node build.mjs [--entry <file>] [--outdir <dir>] [--root <dir>] [--update-base-url <url>]',
        );
    }
  }

  return options;
}

function normalizeUpdateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BuildError(
      `Invalid --update-base-url "${value}"`,
      'Pass an absolute http(s) URL, e.g. https://example.com/better-zmeow-driver.',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BuildError(
      `Unsupported --update-base-url protocol "${url.protocol}"`,
      'Only http:// and https:// URLs are supported.',
    );
  }
  return value.replace(/\/+$/, '');
}

function printUsage() {
  console.log(
    [
      'Usage: node build.mjs [--mode <debug|release>] [--entry <file>] [--outdir <dir>] [--root <dir>] [--update-base-url <url>]',
      '',
      'Modes:',
      '  debug    two-step backup/restore, connect buttons visible',
      '  release  one-step backup download, restore dialog, connect buttons compiled out',
      '  (omit --mode to build both artifacts)',
      '',
      'Options:',
      '  --update-base-url <url>  Release-only @downloadURL / @updateURL base',
      '',
      'Defaults:',
      `  entry  ${displayPath(DEFAULT_ENTRY)}`,
      `  outdir ${displayPath(DEFAULT_OUTDIR)}`,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// TypeScript compiler
// ---------------------------------------------------------------------------

/**
 * Compile-time mode folding for `__ZMEOW_RELEASE__` (see src/build-mode.d.ts).
 *
 * The visitor runs bottom-up: the flag identifier is replaced with the literal
 * for the requested mode, then `if (<literal>) … else …` statements and
 * `<literal> ? a : b` expressions collapse to the taken branch and `!` over a
 * literal inverts. Untaken branches — including their template literals and
 * comments — never reach the emitter, so neither artifact contains the other
 * mode's code. Only constructs that are safe to fold syntactically are
 * handled; the sources keep the flag in whole-condition `if`s and ternaries.
 *
 * @param {string} mode "debug" | "release"
 */
function createModeFoldTransformer(mode) {
  const release = mode === 'release';

  const literalOf = (node) => {
    if (node === undefined || node === null) return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isParenthesizedExpression(node)) return literalOf(node.expression);
    return null;
  };

  const fold = (node) => {
    if (ts.isIdentifier(node) && node.text === MODE_FLAG) {
      return release ? ts.factory.createTrue() : ts.factory.createFalse();
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = literalOf(node.operand);
      if (operand !== null) return operand ? ts.factory.createFalse() : ts.factory.createTrue();
    }
    if (ts.isParenthesizedExpression(node)) {
      const inner = literalOf(node.expression);
      if (inner !== null) return inner ? ts.factory.createTrue() : ts.factory.createFalse();
    }
    if (ts.isIfStatement(node)) {
      const condition = literalOf(node.expression);
      if (condition !== null) {
        const taken = condition ? node.thenStatement : node.elseStatement;
        if (taken === undefined) return ts.factory.createEmptyStatement();
        if (ts.isBlock(taken)) {
          return taken.statements.length > 0
            ? Array.from(taken.statements)
            : ts.factory.createEmptyStatement();
        }
        return taken;
      }
    }
    if (ts.isConditionalExpression(node)) {
      const condition = literalOf(node.condition);
      if (condition !== null) return condition ? node.whenTrue : node.whenFalse;
    }
    return node;
  };

  return (context) => {
    const visit = (node) => fold(ts.visitEachChild(node, visit, context));
    return (sourceFile) => ts.visitEachChild(sourceFile, visit, context);
  };
}

function loadTypeScript() {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(PACKAGE_ROOT, 'node_modules', 'typescript'),
    path.join(REPO_ROOT, 'node_modules', 'typescript'),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'package.json'))) return require(candidate);
  }

  try {
    return require('typescript');
  } catch {
    // Fall through to the readable error below.
  }

  throw new BuildError(
    'Cannot load the TypeScript compiler.',
    [
      'Looked in:',
      ...candidates.map((candidate) => `  - ${displayPath(candidate)}`),
      'Run "pnpm install" at the repository root, or make typescript resolvable.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Module graph
// ---------------------------------------------------------------------------

function buildModuleGraph(entry) {
  const modules = new Map();
  const stack = [];
  const stackIndex = new Map();
  const completed = new Set();

  const visit = (absolutePath) => {
    const id = toModuleId(absolutePath);
    if (completed.has(id)) return;

    const cycleStart = stackIndex.get(id);
    if (cycleStart !== undefined) {
      const cycle = [...stack.slice(cycleStart), id].map((moduleId) =>
        displayPath(fromModuleId(moduleId)),
      );
      throw new BuildError(
        `Circular import detected:\n${cycle.join('\n  -> ')}`,
        'CommonJS evaluation cannot guarantee a safe initialisation order for cycles. Break the cycle before bundling.',
      );
    }

    if (!isFile(absolutePath)) {
      throw new BuildError(`Module not found: ${displayPath(absolutePath)}`);
    }

    stack.push(id);
    stackIndex.set(id, stack.length - 1);

    const source = readFileSync(absolutePath, 'utf8');
    const parsed = ts.preProcessFile(source, true, true);
    const imports = [];

    for (const imported of parsed.importedFiles) {
      const resolved = resolveSpecifier(imported.fileName, absolutePath);
      imports.push({ specifier: imported.fileName, id: toModuleId(resolved) });
      visit(resolved);
    }

    if (parsed.referencedFiles.length > 0 || parsed.libReferenceDirectives.length > 0) {
      throw new BuildError(
        `Triple-slash references are not supported (${displayPath(absolutePath)}).`,
        'Replace /// <reference ... /> directives with normal imports before bundling.',
      );
    }

    stack.pop();
    stackIndex.delete(id);
    completed.add(id);
    modules.set(id, { id, absolutePath, source, imports });
  };

  visit(entry);
  return modules;
}

function resolveSpecifier(specifier, importer) {
  if (specifier === SDK_ALIAS) return SDK_ENTRY;

  if (specifier.startsWith(`${SDK_ALIAS}/`)) {
    const subpath = specifier.slice(SDK_ALIAS.length + 1);
    const resolved = resolveFile(path.join(SDK_SRC_ROOT, subpath));
    if (resolved !== null) return resolved;
    throw new BuildError(
      `Cannot resolve SDK submodule "${specifier}" imported from ${displayPath(importer)}`,
      `Looked under ${displayPath(SDK_SRC_ROOT)}.`,
    );
  }

  if (specifier.startsWith('.')) {
    const resolved = resolveFile(path.resolve(path.dirname(importer), specifier));
    if (resolved !== null) return resolved;
    throw new BuildError(
      `Cannot resolve module "${specifier}" imported from ${displayPath(importer)}`,
      'The userscript bundle only understands relative imports and the "@bookqaq/zmeow-sdk" alias.',
    );
  }

  throw new BuildError(
    `Unsupported bare import "${specifier}" in ${displayPath(importer)}`,
    'This userscript must stay dependency-free. Use relative imports or "@bookqaq/zmeow-sdk".',
  );
}

function resolveFile(candidate) {
  const attempts = [];

  if (candidate.endsWith('.ts')) {
    attempts.push(candidate);
  } else if (candidate.endsWith('.js')) {
    attempts.push(`${candidate.slice(0, -3)}.ts`);
  } else if (candidate.endsWith('.mjs')) {
    attempts.push(`${candidate.slice(0, -4)}.ts`);
  } else {
    attempts.push(`${candidate}.ts`, path.join(candidate, 'index.ts'));
  }

  for (const attempt of attempts) {
    if (isFile(attempt)) return attempt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bundle generation
// ---------------------------------------------------------------------------

function assembleBundle(modules, entryId, sdkId, mode) {
  const registry = [];

  for (const [id, module] of modules) {
    registry.push(
      [
        `  ${JSON.stringify(id)}: function (module, exports, require) {`,
        transpileModule(module, mode),
        '  },',
      ].join('\n'),
    );
  }

  const sdkExpose = modules.has(sdkId)
    ? [
        '  try {',
        '    window.ZmeowSDK = __load(__SDK_ID);',
        "  } catch (error) {",
        "    console.warn('[zmeow] could not expose window.ZmeowSDK', error);",
        '  }',
        '',
      ].join('\n')
    : '';

  return [
    '/* Generated by packages/zmeow-userscript/build.mjs. Do not edit directly. */',
    '(function () {',
    "  'use strict';",
    '',
    '  var __modules = {',
    registry.join('\n'),
    '  };',
    '  var __cache = Object.create(null);',
    '',
    `  var __SDK_ID = ${JSON.stringify(sdkId)};`,
    `  var __SDK_ALIAS = ${JSON.stringify(SDK_ALIAS)};`,
    `  var __ENTRY_ID = ${JSON.stringify(entryId)};`,
    '',
    '  function __has(id) {',
    '    return Object.prototype.hasOwnProperty.call(__modules, id);',
    '  }',
    '',
    '  function __dirOf(id) {',
    "    var slash = id.lastIndexOf('/');",
    "    return slash === -1 ? '' : id.slice(0, slash);",
    '  }',
    '',
    '  function __normalize(base, specifier) {',
    "    var combined = (base ? base + '/' : '') + specifier;",
    "    var isAbsolute = combined.charAt(0) === '/';",
    "    var parts = combined.split('/');",
    '    var output = [];',
    '',
    '    for (var index = 0; index < parts.length; index += 1) {',
    '      var part = parts[index];',
    "      if (part === '' || part === '.') continue;",
    "      if (part === '..') {",
    "        if (output.length > 0 && output[output.length - 1] !== '..') output.pop();",
    "        else if (!isAbsolute) output.push('..');",
    '      } else {',
    '        output.push(part);',
    '      }',
    '    }',
    '',
    "    return (isAbsolute ? '/' : '') + output.join('/');",
    '  }',
    '',
    '  function __lookup(id, specifier, fromId) {',
    '    if (__has(id)) return id;',
    "    if (id.slice(-3) === '.js') {",
    "      var jsToTs = id.slice(0, -3) + '.ts';",
    '      if (__has(jsToTs)) return jsToTs;',
    '    }',
    "    if (__has(id + '.ts')) return id + '.ts';",
    "    if (__has(id + '/index.ts')) return id + '/index.ts';",
    "    throw new Error('[zmeow] module not found: \"' + specifier + '\" (from ' + fromId + ', resolved ' + id + ')');",
    '  }',
    '',
    '  function __resolve(specifier, fromId) {',
    '    if (specifier === __SDK_ALIAS) return __SDK_ID;',
    '    if (specifier.indexOf(__SDK_ALIAS + "/") === 0) {',
    '      var subpath = specifier.slice(__SDK_ALIAS.length + 1);',
    '      return __lookup(__normalize(__dirOf(__SDK_ID), subpath), specifier, fromId);',
    '    }',
    "    if (specifier.charAt(0) !== '.') {",
    "      throw new Error('[zmeow] unsupported module \"' + specifier + '\" required from ' + fromId);",
    '    }',
    '    return __lookup(__normalize(__dirOf(fromId), specifier), specifier, fromId);',
    '  }',
    '',
    '  function __load(id) {',
    '    if (__cache[id]) return __cache[id].exports;',
    '    if (!__has(id)) throw new Error("[zmeow] module missing from bundle: " + id);',
    '    var module = { exports: {} };',
    '    __cache[id] = module;',
    '    try {',
    '      __modules[id](module, module.exports, function (specifier) {',
    '        return __load(__resolve(specifier, id));',
    '      });',
    '    } catch (error) {',
    '      delete __cache[id];',
    '      throw error;',
    '    }',
    '    return module.exports;',
    '  }',
    '',
    sdkExpose + '  __load(__ENTRY_ID);',
    '})();',
    '',
  ].join('\n');
}

function transpileModule(module, mode) {
  const result = ts.transpileModule(module.source, {
    fileName: module.absolutePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      importHelpers: false,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
    transformers: { before: [createModeFoldTransformer(mode)] },
  });

  const diagnostics = result.diagnostics ?? [];
  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => REPO_ROOT,
      getNewLine: () => '\n',
    });
    throw new BuildError(
      `TypeScript failed to transpile ${displayPath(module.absolutePath)}:\n${indent(formatted)}`,
    );
  }

  return stripSourceMapComments(result.outputText).trim();
}

function stripSourceMapComments(code) {
  return code
    .replace(/^\/\/[#@]\s*sourceMappingURL=.*$/gm, '')
    .replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------------
// Tampermonkey metadata
// ---------------------------------------------------------------------------

/**
 * Metadata for the merged driver tap.
 *
 * The script runs in Tampermonkey's granted sandbox (`@sandbox JavaScript`):
 * the GM grants power the Wootility share fetch (`@connect api.wooting.io` —
 * the API only echoes `access-control-allow-origin` for
 * `origin: https://wootility.io`, so a plain page fetch is CORS-blocked), and
 * `unsafeWindow` hands the tap the HOST page's realm so every
 * `HIDDevice.prototype` / `SerialPort.prototype` patch lands where the driver
 * page sees it (SDK `environment` injection — see `resolvePageEnvironment`).
 *
 * `localhost` and `127.0.0.1` are developer-only conveniences for the debug
 * build; release artifacts intentionally match only the production driver
 * origin.
 */
function buildHeader(mode, updateBaseUrl = null) {
  return [
    '// ==UserScript==',
    '// @name         Better ZetsuMeow Driver',
    '// @namespace    https://github.com/bookqaq/zmeow-tools',
    `// @version      ${readVersion()}`,
    '// @description  Better ZetsuMeow Driver — ZetsuMeow driver tap, JSON config backup/restore and Wooting profile import.',
    '// @license      MIT',
    ...(mode === 'release' && updateBaseUrl !== null
      ? [
          `// @downloadURL  ${updateBaseUrl}/${FILE_BASE}.user.js`,
          `// @updateURL    ${updateBaseUrl}/${FILE_BASE}.meta.js`,
        ]
      : []),
    '// @run-at       document-start',
    '// @grant        GM_xmlhttpRequest',
    '// @grant        GM.xmlHttpRequest',
    '// @grant        unsafeWindow',
    '// @sandbox      JavaScript',
    '// @connect      api.wooting.io',
    '// @noframes',
    ...(mode === 'release'
      ? []
      : ['// @match        http://localhost/*', '// @match        http://127.0.0.1/*']),
    '// @match        https://driver.zetsumeow.com/*',
    '//',
    '// Deployment origins are maintained as @match lines above. Add one line per',
    '// origin that must run the driver page (see docs/RELEASE.md).',
    '// ==/UserScript==',
    '',
  ].join('\n');
}

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) return pkg.version;
  } catch {
    // Fall through to the fallback version.
  }
  return FALLBACK_VERSION;
}

// ---------------------------------------------------------------------------
// Filesystem / output helpers
// ---------------------------------------------------------------------------

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function toModuleId(file) {
  const absolute = path.resolve(file);
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return absolute.split(path.sep).join('/');
  }
  return relative.split(path.sep).join('/');
}

function fromModuleId(id) {
  return path.isAbsolute(id) ? id : path.join(REPO_ROOT, id);
}

function displayPath(file) {
  const absolute = path.resolve(file);
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolute;
  return relative.split(path.sep).join('/');
}

function printBuilt(file, contents, moduleCount, elapsedMs) {
  console.log(
    `[zmeow-userscript] ${displayPath(file)}  ${formatBytes(Buffer.byteLength(contents, 'utf8'))}  (${moduleCount} modules, ${elapsedMs} ms)`,
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
