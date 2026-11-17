/**
 * Safe-view navigation for the official ZetsuMeow driver page.
 *
 * The app is Vue 3 + vue-router and uses an in-memory history, so the address
 * bar never changes; navigation must go through the router instance. Vue 3
 * exposes the mounted app on `#app.__vue_app__`, and vue-router installs
 * `$router` on `app.config.globalProperties`.
 *
 * The `/other` settings route renders device info, language, win-lock and
 * firmware-update controls that only act on clicks. Unlike `/keys` (remap
 * editor) or `/light` (colour editor), it has no reactive UI wired to device
 * frames, which makes it the safe view during config transfers.
 *
 * The candidate path is verified against `router.getRoutes()` before pushing;
 * no DOM selectors are guessed.
 */

const APP_SELECTOR = '#app';
/** Route paths that are safe during config transfers, most preferred first. */
const SAFE_VIEW_PATHS: readonly string[] = ['/other'];

export type SafeViewSkipReason =
  | 'router-not-found'
  | 'safe-route-missing'
  | 'already-on-safe-view'
  | 'push-failed';

/** Result of entering the safe view; kept as a lease so it can be undone. */
export interface SafeViewLease {
  readonly navigated: boolean;
  /** Path to return to after the operation (null when navigation did not happen). */
  readonly originalPath: string | null;
  readonly safePath: string | null;
  readonly skipReason: SafeViewSkipReason | null;
}

export interface LeaveSafeViewResult {
  readonly returned: boolean;
  readonly error: string | null;
}

interface RouterLike {
  push(path: string): unknown;
  getRoutes?(): ReadonlyArray<{ readonly path?: unknown }>;
  currentRoute?: { readonly value?: { readonly fullPath?: unknown } };
}

/**
 * Move the driver page to the safe view before a config transfer.
 *
 * Never throws: when the official app (or its router) cannot be found the lease
 * records why and the caller continues without navigation.
 */
export async function enterSafeView(): Promise<SafeViewLease> {
  const router = findRouter();
  if (router === null) {
    return { navigated: false, originalPath: null, safePath: null, skipReason: 'router-not-found' };
  }

  const originalPath = readCurrentPath(router);
  const safePath = pickSafePath(router);
  if (safePath === null) {
    return { navigated: false, originalPath, safePath: null, skipReason: 'safe-route-missing' };
  }
  if (originalPath !== null && originalPath === safePath) {
    return { navigated: false, originalPath, safePath: null, skipReason: 'already-on-safe-view' };
  }

  try {
    await router.push(safePath);
  } catch {
    return { navigated: false, originalPath, safePath: null, skipReason: 'push-failed' };
  }
  return { navigated: true, originalPath, safePath, skipReason: null };
}

/**
 * Whether the lease proves the official Vue app is present (its route table was
 * seen or navigation happened). Used to gate post-transfer page recovery.
 */
export function officialAppDetected(lease: SafeViewLease): boolean {
  return lease.skipReason !== 'router-not-found';
}

/** Return the driver page to the view it was on before {@link enterSafeView}. */
export async function leaveSafeView(lease: SafeViewLease): Promise<LeaveSafeViewResult> {
  if (!lease.navigated || lease.originalPath === null) return { returned: false, error: null };
  const router = findRouter();
  if (router === null) return { returned: false, error: 'router-not-found' };
  try {
    await router.push(lease.originalPath);
    return { returned: true, error: null };
  } catch (error) {
    return { returned: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function findRouter(): RouterLike | null {
  try {
    const host = document.querySelector(APP_SELECTOR) as (Element & Record<string, unknown>) | null;
    if (host === null) return null;
    const app = host['__vue_app__'] as
      | { config?: { globalProperties?: Record<string, unknown> } }
      | undefined;
    const router = app?.config?.globalProperties?.['$router'] as RouterLike | undefined;
    if (router === null || router === undefined || typeof router.push !== 'function') return null;
    return router;
  } catch {
    return null;
  }
}

function readCurrentPath(router: RouterLike): string | null {
  const fullPath = router.currentRoute?.value?.fullPath;
  return typeof fullPath === 'string' && fullPath.length > 0 ? fullPath : null;
}

function pickSafePath(router: RouterLike): string | null {
  if (typeof router.getRoutes !== 'function') return null;
  let routes: ReadonlyArray<{ readonly path?: unknown }>;
  try {
    routes = router.getRoutes() ?? [];
  } catch {
    return null;
  }
  const known = new Set(routes.map((route) => (typeof route.path === 'string' ? route.path : '')));
  for (const candidate of SAFE_VIEW_PATHS) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}
