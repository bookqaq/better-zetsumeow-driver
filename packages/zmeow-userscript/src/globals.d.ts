/**
 * Tampermonkey globals available under `@sandbox JavaScript` with grants.
 *
 * Declared ambient so the bundle can reference them with plain identifiers.
 * Every use MUST be guarded with a `typeof … !== 'undefined'` check: the same
 * sources also run under plain Node (unit tests) and in the page main world
 * (simulator without Tampermonkey), where none of these bindings exist and a
 * bare reference would throw.
 */

/**
 * The HOST page's real window. The tap patches must land here (page realm);
 * the sandbox's own `window`/`globalThis` is a separate realm whose
 * `HIDDevice`/`SerialPort`/`navigator` bindings are not the ones the driver
 * page uses.
 */
declare const unsafeWindow: Record<string, unknown> | undefined;

/** Classic GM callback-style cross-origin request (dispatched by the manager). */
declare const GM_xmlhttpRequest:
  | ((details: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      timeout?: number;
      onload?: (response: { status: number; responseText: string }) => void;
      onerror?: (response: { error?: string; status?: number }) => void;
      ontimeout?: () => void;
    }) => unknown)
  | undefined;

/** Promise-style GM request some managers expose instead of the global. */
declare const GM:
  | {
      readonly xmlHttpRequest?: (details: Parameters<NonNullable<typeof GM_xmlhttpRequest>>[0]) => Promise<{
        status: number;
        responseText: string;
      }>;
    }
  | undefined;
