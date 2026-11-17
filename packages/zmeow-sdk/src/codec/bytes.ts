/**
 * Byte-level helpers shared by every protocol payload builder.
 *
 * Numbers are written into payloads as plain `number[]`; the helpers below
 * produce the same byte values the firmware expects without an intermediate
 * hexadecimal string round-trip.
 *
 * Everything here is pure: no DOM, no transport, no module state.
 */

/** Truncates `n` to a single byte (`n & 0xff`). */
export function numToUint8(n: number): number {
  return n & 0xff;
}

/**
 * Big-endian 2-byte encoding, `[hi, lo]`.
 */
export function numToUint8_2B(n: number): [number, number] {
  const value = n & 0xffff;
  return [(value >>> 8) & 0xff, value & 0xff];
}

/**
 * Big-endian 4-byte encoding, `[b3, b2, b1, b0]`.
 */
export function numToUint8_4B(n: number): [number, number, number, number] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** ASCII/UTF-16 code units -> one byte per character (low 8 bits). */
export function asciiToBytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) out.push(s.charCodeAt(i) & 0xff);
  return out;
}

/**
 * Bytes -> ASCII string. NUL bytes are skipped: the firmware pads fixed-width
 * string fields with `0`.
 */
export function bytesToAscii(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte !== 0) out += String.fromCharCode(byte & 0xff);
  }
  return out;
}

/** One byte as exactly two upper-case hex digits. */
export function toHexByte(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0').toUpperCase();
}

/** Concatenated upper-case hex dump of `bytes`, no separators. */
export function bytesToHex(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += toHexByte(bytes[i] ?? 0);
  return out;
}

/**
 * Splits `items` into consecutive groups of at most `size` items.
 * A non-positive / non-integer size yields no groups.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
