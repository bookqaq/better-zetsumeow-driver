/**
 * Driver-build fingerprinting and product-table validation.
 *
 * The official driver ships as built page resources: every rebuild changes
 * the content hashes in its entry, HID and screen chunks. Comparing those hashes
 * (or their bytes) is the cheapest reliable way to notice a driver update
 * before a single device command is sent.
 */

import type { ProductInfo } from '../types.ts';
import type { TapFingerprint } from './types.ts';

/** Hashes of the driver snapshot this SDK was generated against. */
export const KNOWN_DRIVER_HASHES = {
  index: 'ccd124898e70de5e5f0243f9a4d78248dcc79ee5daec8553cbcf9eadade42396',
  hid: '1cd39f45ae0a7f10132c089b51fd090a9ef6b759a75ac7cca79afdeb7c4e87ab',
  screen: '125f4951257039e483e7a4bfb0796a9e009b1bd9a10162986904fc79b9dc80f5',
} as const;

/** Firmware versions covered by the current protocol tables. */
export const KNOWN_FIRMWARE_VERSIONS: readonly string[] = ['1.1.1'];

/** Product table fields the tap layer depends on. */
export interface DriverProductRecord {
  readonly id: number;
  readonly title: string;
  readonly vid: number;
  readonly pid: number;
  readonly pidScreen: number;
  readonly usage: number;
  readonly usagePages: readonly number[];
  readonly headNum: number;
  readonly headNumScreen: number;
  readonly cateId: number;
  readonly fId: number;
  readonly fmId: number;
}

export interface AssetFingerprintResult {
  readonly indexHash: string | null;
  readonly hidHash: string | null;
  readonly screenHash: string | null;
  readonly checked: boolean;
  readonly hashKnown: boolean;
  readonly reasons: readonly string[];
}

interface DriverProductLike {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly vid?: unknown;
  readonly pid?: unknown;
  readonly pid_screen?: unknown;
  readonly usage?: unknown;
  readonly usagePage?: unknown;
  readonly head_num?: unknown;
  readonly head_num_screen?: unknown;
  readonly cate_id?: unknown;
  readonly f_id?: unknown;
  readonly fm_id?: unknown;
}

interface DriverDataLike {
  readonly keys_product_list?: readonly DriverProductLike[];
}

const hashCache = new Map<string, Promise<string | null>>();

/** Hex-encode a digest. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 of raw bytes, or `null` when SubtleCrypto is unavailable. */
export async function sha256Hex(
  bytes: ArrayBuffer | Uint8Array,
  cryptoImpl: Crypto | null = globalThis.crypto,
): Promise<string | null> {
  if (!cryptoImpl?.subtle) return null;
  try {
    let buffer: ArrayBuffer;
    if (bytes instanceof Uint8Array) {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      buffer = copy.buffer;
    } else {
      buffer = bytes;
    }
    const digest = await cryptoImpl.subtle.digest('SHA-256', buffer);
    return toHex(new Uint8Array(digest));
  } catch {
    return null;
  }
}

/** Fetch and hash one same-origin asset. Results are cached by URL. */
export function hashAssetUrl(
  url: string,
  fetchImpl: typeof fetch | null = globalThis.fetch,
  cryptoImpl: Crypto | null = globalThis.crypto,
): Promise<string | null> {
  const cached = hashCache.get(url);
  if (cached) return cached;
  const pending = (async () => {
    if (!fetchImpl) return null;
    try {
      const response = await fetchImpl(url, { credentials: 'same-origin' });
      if (!response.ok) return null;
      return await sha256Hex(await response.arrayBuffer(), cryptoImpl);
    } catch {
      return null;
    }
  })();
  hashCache.set(url, pending);
  return pending;
}

/** Test hook: clear the asset hash cache. */
export function clearFingerprintCache(): void {
  hashCache.clear();
}

function findUrl(doc: Document, selector: string): string | null {
  const element = doc.querySelector(selector) as { readonly src?: string; readonly href?: string } | null;
  if (!element) return null;
  return element.src ?? element.href ?? null;
}

function findScreenUrl(doc: Document): string | null {
  const direct = findUrl(doc, 'link[rel="modulepreload"][href*="/screen-"]');
  if (direct) return direct;
  const performanceLike = (globalThis as { performance?: Performance }).performance;
  const entries = performanceLike?.getEntriesByType?.('resource') ?? [];
  for (const entry of entries) {
    if (/\/screen-[^/]+\.js(?:\?|$)/.test(entry.name)) return entry.name;
  }
  return null;
}

/**
 * Hash the driver's entry and protocol resources.
 *
 * Missing URLs are not failures: `@require` users may strip `modulepreload`
 * links, and the lazy `screen-*` chunk only exists after the screen tab is
 * opened. `checked` says whether at least one protocol resource was compared.
 */
export async function fingerprintDriverAssets(
  doc: Document | null,
  fetchImpl: typeof fetch | null = globalThis.fetch,
  cryptoImpl: Crypto | null = globalThis.crypto,
): Promise<AssetFingerprintResult> {
  if (!doc) {
    return {
      indexHash: null,
      hidHash: null,
      screenHash: null,
      checked: false,
      hashKnown: true,
      reasons: ['no document available for asset fingerprinting'],
    };
  }

  const indexUrl = findUrl(doc, 'script[type="module"][src]');
  const hidUrl = findUrl(doc, 'link[rel="modulepreload"][href*="/hid-"]');
  const screenUrl = findScreenUrl(doc);

  const [indexHash, hidHash, screenHash] = await Promise.all([
    indexUrl ? hashAssetUrl(indexUrl, fetchImpl, cryptoImpl) : null,
    hidUrl ? hashAssetUrl(hidUrl, fetchImpl, cryptoImpl) : null,
    screenUrl ? hashAssetUrl(screenUrl, fetchImpl, cryptoImpl) : null,
  ]);

  const reasons: string[] = [];
  if (hidHash && hidHash !== KNOWN_DRIVER_HASHES.hid) {
    reasons.push('hid protocol resource hash changed');
  }
  if (screenHash && screenHash !== KNOWN_DRIVER_HASHES.screen) {
    reasons.push('screen protocol resource hash changed');
  }
  if (indexHash && indexHash !== KNOWN_DRIVER_HASHES.index) {
    reasons.push('driver entry resource hash changed');
  }

  const protocolHashes = [hidHash, screenHash].filter((value): value is string => value !== null);
  const checked = protocolHashes.length > 0;
  const hashKnown =
    protocolHashes.length === 0 ||
    (hidHash === null || hidHash === KNOWN_DRIVER_HASHES.hid) &&
      (screenHash === null || screenHash === KNOWN_DRIVER_HASHES.screen);

  return { indexHash, hidHash, screenHash, checked, hashKnown, reasons };
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse `data.keys_product_list` from the official page's global state. */
export function readProductRecord(
  globalObject: unknown,
  productId: number,
): DriverProductRecord | null {
  const data = (globalObject as { data?: DriverDataLike } | null)?.data;
  const list = data?.keys_product_list;
  if (!Array.isArray(list)) return null;

  for (const raw of list) {
    if (asNumber(raw.id) !== productId) continue;
    const vid = asNumber(raw.vid);
    const pid = asNumber(raw.pid);
    const pidScreen = asNumber(raw.pid_screen) ?? pid;
    const usage = asNumber(raw.usage);
    const headNum =
      typeof raw.head_num === 'string' && raw.head_num.startsWith('0x')
        ? Number.parseInt(raw.head_num, 16)
        : asNumber(raw.head_num);
    const headNumScreen =
      typeof raw.head_num_screen === 'string' && raw.head_num_screen.startsWith('0x')
        ? Number.parseInt(raw.head_num_screen, 16)
        : asNumber(raw.head_num_screen) ?? headNum;
    const usagePage =
      typeof raw.usagePage === 'string'
        ? raw.usagePage
            .split(',')
            .map((part: string) => Number.parseInt(part.trim(), 10))
            .filter((value: number) => Number.isFinite(value))
        : [];
    if (
      vid === null ||
      pid === null ||
      pidScreen === null ||
      usage === null ||
      headNum === null ||
      headNumScreen === null
    ) {
      return null;
    }
    return {
      id: productId,
      title: typeof raw.title === 'string' ? raw.title : '',
      vid,
      pid,
      pidScreen,
      usage,
      usagePages: usagePage,
      headNum,
      headNumScreen,
      cateId: asNumber(raw.cate_id) ?? 0,
      fId: asNumber(raw.f_id) ?? 0,
      fmId: asNumber(raw.fm_id) ?? 0,
    };
  }
  return null;
}

/** True when the page's product table still matches the compiled SDK product. */
export function productRecordMatches(
  record: DriverProductRecord | null,
  product: ProductInfo,
): boolean {
  if (!record) return false;
  return (
    record.id === product.id &&
    record.vid === product.vid &&
    record.pid === product.pid &&
    record.pidScreen === product.pidScreen &&
    record.usage === product.usage &&
    record.headNum === product.headNum &&
    record.headNumScreen === product.headNumScreen &&
    record.usagePages.length === product.usagePages.length &&
    record.usagePages.every((page, index) => page === product.usagePages[index])
  );
}

/** Build the public fingerprint object from the pieces known so far. */
export function makeFingerprint(input: {
  readonly assets: AssetFingerprintResult;
  readonly productOk: boolean;
  readonly firmwareVersion: string | null;
  readonly protocolOk: boolean;
  readonly extraReasons?: readonly string[];
}): TapFingerprint {
  const reasons = [...input.assets.reasons, ...(input.extraReasons ?? [])];
  if (!input.productOk) reasons.push('product table no longer matches the SDK');
  if (!input.protocolOk) reasons.push('a captured protocol frame failed to decode');
  if (
    input.firmwareVersion !== null &&
    !KNOWN_FIRMWARE_VERSIONS.includes(input.firmwareVersion)
  ) {
    reasons.push(`firmware ${input.firmwareVersion} is not in the tested list`);
  }
  return {
    indexHash: input.assets.indexHash,
    hidHash: input.assets.hidHash,
    screenHash: input.assets.screenHash,
    productOk: input.productOk,
    firmwareVersion: input.firmwareVersion,
    protocolOk: input.protocolOk,
    hashKnown: input.assets.hashKnown,
    checked: input.assets.checked,
    reasons,
  };
}
