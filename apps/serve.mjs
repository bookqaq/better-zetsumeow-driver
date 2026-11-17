#!/usr/bin/env node
/**
 * Zero-dependency static server for the playground.
 *
 * `python3 -m http.server` is single threaded and drops connections when the
 * browser requests ~20 ES modules in parallel (`ERR_CONNECTION_RESET` shows up
 * as "Failed to fetch dynamically imported module"). Node's HTTP server handles
 * those requests concurrently and sends `no-cache`, so a rebuilt `dist/` is
 * always picked up after a refresh.
 *
 * Serves the whole repository root, so both `apps/playground/` and
 * `apps/simulator/` can be reached (the simulator needs the userscript `dist/` too).
 *
 * Usage (from the repo root):
 *   node apps/serve.mjs
 *   PORT=8100 node apps/serve.mjs
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: this file lives in <root>/apps/. */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8099);
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Resolve a URL path to a file inside ROOT, or null when it escapes. */
function resolveTarget(pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0] ?? '/');
  const withIndex = clean.endsWith('/') ? `${clean}index.html` : clean;
  const target = normalize(join(ROOT, withIndex));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
    const pathname = url.pathname === '/' ? '/apps/playground/' : url.pathname;
    const target = resolveTarget(pathname);
    if (!target) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`Not found: ${pathname}`);
      return;
    }
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': body.byteLength,
      // Always revalidate so a rebuilt dist/ is never served stale.
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`Server error: ${String(error)}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ZetsuMeow playground: http://localhost:${PORT}/apps/playground/`);
  console.log(`Better ZetsuMeow Driver simulator: http://localhost:${PORT}/apps/simulator/`);
  console.log('Press Ctrl+C to stop.');
});
