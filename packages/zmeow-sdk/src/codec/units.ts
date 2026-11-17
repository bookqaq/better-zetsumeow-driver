/**
 * Physical unit conversions used by the travel (actuation point) commands.
 *
 * The firmware stores millimetre values as integer micrometres in two
 * big-endian bytes, and MT/TGL/END/DKS timings as 10 ms ticks.
 */
import { numToUint8 } from './bytes.ts';

/**
 * Millimetres -> 2-byte big-endian micrometres.
 *
 * The firmware adopts travel values on a **0.01 mm grid** (the official
 * driver UI's step; Gateron magnetic switches span 0–4 mm), so the value is
 * quantised to 0.01 mm before encoding. Finer input would be rounded by the
 * device itself and then fail read-back verification.
 */
export function mmToTravelBytes(mm: number): [number, number] {
  const steps = Math.round(mm * 100); // 0.01 mm units
  const raw = (steps * 100) & 0xffff; // 0.0001 mm units, as stored on device
  return [(raw >>> 8) & 0xff, raw & 0xff];
}

/** 2-byte big-endian micrometres -> millimetres (`((hi << 8) | lo) / 10000`). */
export function travelBytesToMm(hi: number, lo: number): number {
  return ((((hi & 0xff) << 8) | (lo & 0xff)) >>> 0) / 10000;
}

/** Milliseconds -> one 10 ms tick byte (MT/TGL/END/RS/SOCD timings). */
export function msToByte(ms: number): number {
  return numToUint8(Math.round(ms / 10));
}

/** One 10 ms tick byte -> milliseconds. */
export function byteToMs(byte: number): number {
  return (byte & 0xff) * 10;
}

/**
 * Largest millimetre value that fits in the 2-byte micrometre field
 * (6.5535 mm — an encoding limit, not a physical one: the stock magnetic
 * switches only travel 0–4 mm; per-key limits live on the layout's
 * `minTravel`/`maxTravel`).
 */
export const MAX_TRAVEL_MM = 0xffff / 10000;
