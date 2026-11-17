/**
 * Fetch a Wootility share profile from the official public endpoint.
 *
 * The rest of the Wooting pipeline (`parseWootingShare` /
 * `convertWootingProfile` / `wootingProfileToConfig`) is offline; this module is
 * the only place that performs network I/O, and the caller can inject a custom
 * `fetch` (tests use a stub, so the suite never touches the network).
 */

import { TransportError, ValidationError } from '@bookqaq/zmeow-sdk';
import { parseWootingShare } from './profile.ts';
import type { WootingProfile } from './types.ts';

export const WOOTING_SHARE_ENDPOINT = 'https://api.wooting.io/public/wootility/profiles';

export interface FetchWootingShareOptions {
  /** Custom `fetch` implementation; defaults to the global one. */
  readonly fetch?: typeof fetch;
  /** Request timeout in milliseconds. Default 15000 (`AbortSignal.timeout`). */
  readonly timeoutMs?: number;
}

/**
 * GET `<endpoint>?code=<share code>` and parse the response body.
 *
 * The fixed `origin: https://wootility.io` header mirrors the official
 * Wootility request. Note that `Origin` is a forbidden header name in
 * browsers: `fetch` silently ignores it and sends the page's own origin
 * instead. Keeping it is harmless in the browser and makes Node scripts /
 * non-browser hosts match the official request; the server was observed
 * returning 200 even without any `origin` header.
 *
 * Errors:
 * - empty share code or an HTTP 4xx response -> `ValidationError`
 * - network failure (TypeError / CORS / abort) or HTTP 5xx -> `TransportError`
 * - a 200 body that does not parse -> `ValidationError` (from the parser)
 */
export async function fetchWootingShare(
  code: string,
  options: FetchWootingShareOptions = {},
): Promise<WootingProfile> {
  const shareCode = code.trim();
  if (shareCode.length === 0) {
    throw new ValidationError('The Wooting share code is empty');
  }

  const doFetch = options.fetch ?? fetch;
  const url = `${WOOTING_SHARE_ENDPOINT}?code=${encodeURIComponent(shareCode)}`;
  const init: RequestInit = {
    method: 'GET',
    headers: { accept: 'application/json', origin: 'https://wootility.io' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
  };

  let response: Response;
  try {
    response = await doFetch(url, init);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new TransportError(
      `Failed to fetch the Wooting share profile: ${detail}`,
      { cause },
    );
  }

  if (!response.ok) {
    const detail = serverDetail(await response.text().catch(() => ''));
    const message = `Wooting share request failed with HTTP ${response.status}: ${detail}`;
    // The public share endpoint rate-limits bursts (about 40 requests / 10 s).
    // Treat 429 like a transport failure so the panel does not tell the user
    // their share code is invalid.
    if (response.status === 429 || response.status >= 500) {
      throw new TransportError(message);
    }
    throw new ValidationError(message);
  }

  return parseWootingShare(await response.text());
}

/** Human-readable server message: the JSON `error` field, else the trimmed body. */
function serverDetail(body: string): string {
  const text = body.trim();
  if (text.length === 0) return '(empty response body)';
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const message = (parsed as { readonly error?: unknown }).error;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  } catch {
    // not JSON — fall through to the raw body
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
