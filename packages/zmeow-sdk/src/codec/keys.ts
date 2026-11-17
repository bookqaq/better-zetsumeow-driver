/**
 * HID usage code encoding.
 *
 * HID usages above 255 need two bytes. The arithmetic version below always
 * produces the big-endian pair the firmware expects.
 */
import { numToUint8_2B } from './bytes.ts';

/**
 * Encodes a HID usage as 2 bytes.
 *
 * `hidCode <= 255` becomes `[0, code]`; anything
 * larger becomes big-endian `[hi, lo]`.
 */
export function hidCodeToBytes(hidCode: number): [number, number] {
  if (hidCode <= 0xff) return [0, hidCode & 0xff];
  return numToUint8_2B(hidCode);
}

/** Decodes a big-endian `[hi, lo]` HID usage pair back to a number. */
export function bytesToHidCode(hi: number, lo: number): number {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}
