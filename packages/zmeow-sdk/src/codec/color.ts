/**
 * RGB / RGB565 colour helpers.
 *
 * `#RRGGBB` is the public colour format (see {@link HexColor}); RGB565 is what
 * the QMK-style light and key-colour payloads store.
 */
import { ValidationError } from '../errors.ts';
import { numToUint8, toHexByte } from './bytes.ts';
import type { HexColor } from '../types.ts';

const HEX_COLOUR = /^#?([0-9a-fA-F]{6})$/;

/**
 * Parses a `#RRGGBB` colour. The leading `#` is optional, the six digits are
 * not. Throws {@link ValidationError} for anything else.
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = HEX_COLOUR.exec(hex.trim());
  if (!match?.[1]) {
    throw new ValidationError(`Invalid hex colour "${hex}": expected #RRGGBB`);
  }
  const digits = match[1];
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

/** Formats three channels as an upper-case `#RRGGBB` string. */
export function rgbToHex(r: number, g: number, b: number): HexColor {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

/** Packs RGB888 into a 16-bit RGB565 value: `(r>>3)<<11 | (g>>2)<<5 | (b>>3)`. */
export function rgbToRgb565(r: number, g: number, b: number): number {
  return (((r & 0xff) >>> 3) << 11) | (((g & 0xff) >>> 2) << 5) | ((b & 0xff) >>> 3);
}

/** RGB565 -> 2-byte big-endian representation. */
export function rgb565ToBytes(value: number): [number, number] {
  const v = value & 0xffff;
  return [(v >>> 8) & 0xff, v & 0xff];
}

/** Convenience: `#RRGGBB` -> 2-byte big-endian RGB565 payload bytes. */
export function hexToRgb565Bytes(hex: string): [number, number] {
  const { r, g, b } = hexToRgb(hex);
  return rgb565ToBytes(rgbToRgb565(r, g, b));
}

/** Clamps a channel value into 0..255. */
export function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return numToUint8(Math.max(0, Math.min(255, Math.round(value))));
}
