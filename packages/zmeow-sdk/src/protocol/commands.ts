/**
 * Command ids and payload builders.
 *
 * Each builder returns the payload only; wrap it with {@link buildFrame} to get
 * a 64-byte report. Payload lengths are part of the contract — the frame's
 * length byte (`[1]`) is derived from them, and the firmware validates it.
 *
 */
import { ValidationError } from '../errors.ts';
import { numToUint8 } from '../codec/bytes.ts';
import { hidCodeToBytes } from '../codec/keys.ts';
import { MAX_TRAVEL_MM, mmToTravelBytes } from '../codec/units.ts';

/** `cmd` field values. */
export const HidCommand = {
  DeviceInfo: 1,
  Misc: 2,
  SideLight: 17,
  Light: 19,
  KeyColor: 20,
  ScreenEnd: 22,
  Macro: 32,
  Remap: 35,
  Mt: 36,
  Tgl: 37,
  Dks: 38,
  Mpt: 39,
  End: 40,
  Travel: 41,
  Socd: 43,
  Rs: 45,
  Feature: 47,
  JzColor: 52,
} as const;

/** Second byte (`e[4]` on write, `e[5]` on read) of the `cmd 2` family. */
export const MiscSubCommand = {
  HandTestStart: 2,
  StrokeTestStart: 3,
  TestEnd: 4,
  RestoreDefault: 5,
  GetWinLock: 6,
  SetWinLock: 7,
  GetHighPrecision: 9,
  GetPzNum: 12,
  /** Write the light-sleep delay; the value is the second payload byte. */
  SetLightSleep: 13,
  GetLightSleep: 14,
  SetStatus: 15,
  GetStatus: 16,
  GetMacMode: 18,
  GetFMode: 19,
} as const;

/** One key colour entry for {@link keyColorSetPayloads}. */
export interface KeyColorEntry {
  readonly hardCode: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly brightness: number;
}

/** Light state to write with {@link lightSetPayload}. */
export interface LightSetConfig {
  readonly mode: number;
  readonly speed: number;
  readonly turn: number;
  readonly brightness: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly colorful: number;
}

/** One key travel entry for {@link travelSetPayloads}. */
export interface TravelSetEntry {
  readonly hardCode: number;
  /** 1 = normal actuation, 2 = fast trigger. */
  readonly type: number;
  readonly deadDownMm: number;
  readonly deadUpMm: number;
  readonly travelMm: number;
  readonly fastOutMm: number;
  readonly travelUpMm: number;
  readonly travelDownMm: number;
}

/** Per-report entry caps derived from the 60-byte payload limit. */
export const KEY_COLOR_PER_REPORT = 11;
export const TRAVEL_PER_REPORT = 4;

function mmBytes(mm: number, label: string): [number, number] {
  if (!Number.isFinite(mm) || mm < 0 || mm > MAX_TRAVEL_MM) {
    throw new ValidationError(
      `${label} must be within 0..${MAX_TRAVEL_MM} mm (got ${String(mm)})`,
    );
  }
  return mmToTravelBytes(mm);
}

/** `cmd 1`: device info request, the payload is two 0xFF bytes. */
export function deviceInfoPayload(): readonly number[] {
  return [0xff, 0xff];
}

/**
 * `cmd 2`: misc command. The command-family payload is always **2 bytes**
 * (the driver hard-codes `[1] = 2`); the second byte is the argument or 0.
 */
export function miscPayload(sub: number, second = 0): readonly number[] {
  return [numToUint8(sub), numToUint8(second)];
}

/** `cmd 19`: read the light state. */
export function lightGetPayload(): readonly number[] {
  return [0, 0xff];
}

/** `cmd 19`: write the light state (9 bytes). */
export function lightSetPayload(config: LightSetConfig): readonly number[] {
  return [
    1,
    numToUint8(config.mode),
    numToUint8(config.speed),
    numToUint8(config.turn),
    numToUint8(config.brightness),
    numToUint8(config.r),
    numToUint8(config.g),
    numToUint8(config.b),
    numToUint8(config.colorful),
  ];
}

/** `cmd 20`: read all key colours. */
export function keyColorGetPayload(): readonly number[] {
  return [0, 0xff];
}

/**
 * `cmd 20`: write key colours, split into reports of at most `perReport`
 * entries. Each payload is `[1, count, (hardCode, r, g, b, brightness) * n]`,
 * i.e. `5n + 2` bytes.
 *
 * Note: `count` is the total number of entries, not the number in one report.
 */
export function keyColorSetPayloads(
  entries: readonly KeyColorEntry[],
  perReport: number = KEY_COLOR_PER_REPORT,
): readonly (readonly number[])[] {
  if (!Number.isInteger(perReport) || perReport < 1 || perReport > KEY_COLOR_PER_REPORT) {
    throw new ValidationError(`perReport must be 1..${KEY_COLOR_PER_REPORT} (got ${perReport})`);
  }
  const payloads: (readonly number[])[] = [];
  for (let offset = 0; offset < entries.length; offset += perReport) {
    const group = entries.slice(offset, offset + perReport);
    const payload: number[] = [1, numToUint8(entries.length)];
    for (const entry of group) {
      payload.push(
        numToUint8(entry.hardCode),
        numToUint8(entry.r),
        numToUint8(entry.g),
        numToUint8(entry.b),
        numToUint8(entry.brightness),
      );
    }
    payloads.push(payload);
  }
  return payloads;
}

/**
 * `cmd 35`: read the key map of one layer.
 *
 * `fnNum` is the (Fn) layer index; the read payload is `[0, fnNum, 0xFF]`.
 */
export function remapGetPayload(fnNum: number): readonly number[] {
  return [0, numToUint8(fnNum), 0xff];
}

/** `cmd 35`: remap one key to a HID usage (5 bytes). */
export function remapSetPayload(fnNum: number, hardCode: number, hidCode: number): readonly number[] {
  return [1, numToUint8(fnNum), numToUint8(hardCode), ...hidCodeToBytes(hidCode)];
}

/** `cmd 45`: RS (rapid stop) configuration, 5 bytes. */
export function rsSetPayload(
  key1: number,
  key2: number,
  bottom: number,
  pauseByte: number,
): readonly number[] {
  return [1, numToUint8(key1), numToUint8(key2), numToUint8(bottom), numToUint8(pauseByte)];
}

/** `cmd 43`: SOCD configuration, 7 bytes. */
export function socdSetPayload(
  key1: number,
  first1: number,
  key2: number,
  first2: number,
  bottom: number,
  pauseByte: number,
): readonly number[] {
  return [
    1,
    numToUint8(key1),
    numToUint8(first1),
    numToUint8(key2),
    numToUint8(first2),
    numToUint8(bottom),
    numToUint8(pauseByte),
  ];
}

/** `cmd 36`: MT (mod-tap) configuration, 7 bytes. */
export function mtSetPayload(
  hardCode: number,
  hid1: number,
  hid2: number,
  timeByte: number,
): readonly number[] {
  return [
    1,
    numToUint8(hardCode),
    ...hidCodeToBytes(hid1),
    ...hidCodeToBytes(hid2),
    numToUint8(timeByte),
  ];
}

/** `cmd 37`: TGL (toggle) configuration, 5 bytes. */
export function tglSetPayload(hardCode: number, hid: number, timeByte: number): readonly number[] {
  return [1, numToUint8(hardCode), ...hidCodeToBytes(hid), numToUint8(timeByte)];
}

/**
 * `cmd 39`: MPT (multi-press) configuration, 14 bytes.
 *
 * Layout per tap: `mm (2 bytes big-endian), HID usage (2 bytes)`, repeated three
 * times after `[1, hardCode]`.
 *
 * @throws ValidationError when a travel value exceeds 6.5535 mm.
 */
export function mptSetPayload(
  hardCode: number,
  hids: readonly [number, number, number],
  mms: readonly [number, number, number],
): readonly number[] {
  return [
    1,
    numToUint8(hardCode),
    ...mmBytes(mms[0], 'mptMm[0]'),
    ...hidCodeToBytes(hids[0]),
    ...mmBytes(mms[1], 'mptMm[1]'),
    ...hidCodeToBytes(hids[1]),
    ...mmBytes(mms[2], 'mptMm[2]'),
    ...hidCodeToBytes(hids[2]),
  ];
}

/** `cmd 40`: END configuration, 5 bytes. */
export function endSetPayload(hardCode: number, hid: number, timeByte: number): readonly number[] {
  return [1, numToUint8(hardCode), ...hidCodeToBytes(hid), numToUint8(timeByte)];
}

/** `cmd 41`: read the travel configuration of every configured key. */
export function travelGetPayload(): readonly number[] {
  return [0, 0xff];
}

/**
 * `cmd 41`: write travel configuration, split into reports of at most
 * `perReport` keys (4 by default — `14 * 4 + 2 = 58 <= 60`).
 *
 * Each payload is `[1, totalCount, (hardCode, type, 6 x mm 2B) * n]`.
 *
 * @throws ValidationError when a travel value exceeds 6.5535 mm.
 */
export function travelSetPayloads(
  entries: readonly TravelSetEntry[],
  totalCount: number,
  perReport: number = TRAVEL_PER_REPORT,
): readonly (readonly number[])[] {
  if (!Number.isInteger(perReport) || perReport < 1 || perReport > TRAVEL_PER_REPORT) {
    throw new ValidationError(`perReport must be 1..${TRAVEL_PER_REPORT} (got ${perReport})`);
  }
  if (!Number.isInteger(totalCount) || totalCount < 0 || totalCount > 0xff) {
    throw new ValidationError(`totalCount must be 0..255 (got ${totalCount})`);
  }
  if (entries.length > totalCount) {
    throw new ValidationError(
      `entries (${entries.length}) cannot exceed totalCount (${totalCount})`,
    );
  }

  const payloads: (readonly number[])[] = [];
  for (let offset = 0; offset < entries.length; offset += perReport) {
    const group = entries.slice(offset, offset + perReport);
    const payload: number[] = [1, numToUint8(totalCount)];
    for (const entry of group) {
      payload.push(
        numToUint8(entry.hardCode),
        numToUint8(entry.type),
        ...mmBytes(entry.deadDownMm, 'deadDownMm'),
        ...mmBytes(entry.deadUpMm, 'deadUpMm'),
        ...mmBytes(entry.travelMm, 'travelMm'),
        ...mmBytes(entry.fastOutMm, 'fastOutMm'),
        ...mmBytes(entry.travelUpMm, 'travelUpMm'),
        ...mmBytes(entry.travelDownMm, 'travelDownMm'),
      );
    }
    payloads.push(payload);
  }
  return payloads;
}

/** `cmd 47`: read the feature (advanced key) list. */
export function featureGetPayload(): readonly number[] {
  return [0, 0xff];
}

/** `cmd 47`: clear / reset one key's advanced feature (2 bytes). */
export function featureClearPayload(hardCode: number): readonly number[] {
  return [1, numToUint8(hardCode)];
}

/**
 * Read one key's advanced configuration for the family `featureCmd`
 * (36/37/38/39/40/43/45).
 *
 * 5 bytes for every family except SOCD, which uses 7.
 */
export function featureGetOnePayload(featureCmd: number, hardCode: number): readonly number[] {
  const key = numToUint8(hardCode);
  if (featureCmd === HidCommand.Socd) return [0, key, 0, 0, 0, 0, 0];
  return [0, key, 0, 0, 0];
}

/** `cmd 52`: read the JZ (top-row) colour, 7 bytes. */
export function jzColorGetPayload(): readonly number[] {
  return [0, 0, 0, 0, 0, 0, 0];
}

/** `cmd 32`: read the macro slot (5 bytes, `[0, 0, 0, 0xFF, 0xFF]`). */
export function macroGetPayload(): readonly number[] {
  return [0, 0, 0, 0xff, 0xff];
}
