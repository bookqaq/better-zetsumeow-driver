/**
 * Response decoding.
 *
 * Every decoder receives the raw 64-byte report and returns `null` when the
 * report does not belong to its command (or is too short to be meaningful), so
 * a single dispatcher can try each decoder in turn.
 *
 * Frame layout: `[0]=head, [1]=length, [2]=command, [3]=checksum, [4..]=payload`.
 * "payload index" below therefore equals `frame index - 4`.
 */
import type {
  FeatureConfig,
  FeatureKind,
  KeyColor,
  LightState,
  TravelEntry,
} from '../types.ts';
import { bytesToAscii, toHexByte } from '../codec/bytes.ts';
import { rgbToHex } from '../codec/color.ts';
import { byteToMs, travelBytesToMm } from '../codec/units.ts';
import { HidCommand } from './commands.ts';

const PAYLOAD_OFFSET = 4;

/**
 * Returns the payload of `bytes` when it belongs to `command`, otherwise null.
 *
 * The declared length is clamped to what the report actually contains; a
 * shorter-than-required payload makes the decoder return `null`.
 */
function framePayload(bytes: Uint8Array, command: number, minLength: number): Uint8Array | null {
  if (bytes.length < PAYLOAD_OFFSET) return null;
  if (bytes[2] !== command) return null;
  const available = bytes.length - PAYLOAD_OFFSET;
  const declared = Math.min(bytes[1], available);
  if (declared < minLength) return null;
  return bytes.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + declared);
}

/**
 * Raw report view for decoders that read fixed offsets.
 *
 * The firmware sometimes declares a shorter `[1]` than the fields it actually
 * writes: a `cmd 2` reply declares 2 payload bytes but stores its value at
 * frame byte 6, and a light reply declares 8 bytes while still writing the
 * colourful flag at frame byte 12 (verified on a ZetsuMeow Dimension Pro).
 * Fixed-offset decoders must therefore not clamp to `[1]`.
 */
function frameReport(
  bytes: Uint8Array,
  command: number,
  minFrameLength: number,
): Uint8Array | null {
  if (bytes.length < minFrameLength) return null;
  if (bytes[2] !== command) return null;
  return bytes;
}

/** Reads a big-endian 16-bit value at payload index `i`. */
function word(payload: Uint8Array, i: number): number {
  return (((payload[i] ?? 0) << 8) | (payload[i + 1] ?? 0)) & 0xffff;
}

/** `cmd 1`: identity + firmware + run mode. */
export interface DecodedDeviceInfo {
  readonly boardId: string;
  readonly sn: string;
  readonly firmwareVersion: string;
  readonly runMode: 'app' | 'boot';
  readonly runModeNum: number;
}

/**
 * `cmd 1`: device info.
 *
 * - `boardId` = frame bytes 5..8 as four 2-digit upper-case hex pairs
 *   (8 characters, including the run-mode byte).
 * - `sn` = frame bytes 6..26 as ASCII, NULs skipped.
 * - `firmwareVersion` = frame bytes 27..37 ASCII split on `.`,
 *   normalised to `major.minor.patch`.
 * - `runModeNum` = frame byte 5 (1 = app, 2 = boot, anything else = app).
 */
export function decodeDeviceInfo(bytes: Uint8Array): DecodedDeviceInfo | null {
  // The last field ends at frame index 37, i.e. payload index 33.
  const payload = framePayload(bytes, HidCommand.DeviceInfo, 34);
  if (!payload) return null;

  const boardId = `${toHexByte(bytes[5] ?? 0)}${toHexByte(bytes[6] ?? 0)}${toHexByte(
    bytes[7] ?? 0,
  )}${toHexByte(bytes[8] ?? 0)}`;
  const sn = bytesToAscii(payload.subarray(2, 23));
  const versionBytes = payload.subarray(23, 34);

  const [major = '0', minor = '0', patch = '0'] = bytesToAscii(versionBytes).split('.');
  const firmwareVersion = `${Number(major)}.${minor}.${patch}`;

  const runModeNum = bytes[5] ?? 0;
  return {
    boardId,
    sn,
    firmwareVersion,
    runMode: runModeNum === 2 ? 'boot' : 'app',
    runModeNum,
  };
}

/** Decoded `cmd 2` reading, discriminated by `kind`. */
export type MiscDecode =
  | { kind: 'winLock'; value: boolean }
  | { kind: 'highPrecision'; value: boolean }
  | { kind: 'pzNum'; value: number }
  | { kind: 'lightSleep'; value: number }
  | { kind: 'isLock'; value: number }
  | { kind: 'macMode'; value: boolean }
  | { kind: 'fMode'; value: number };

/**
 * `cmd 2`: misc readings. The sub-command is frame byte 5 and its argument
 * frame byte 6 — one byte later than the *request* layout.
 */
export function decodeMisc(bytes: Uint8Array): MiscDecode | null {
  const frame = frameReport(bytes, HidCommand.Misc, 7);
  if (!frame) return null;

  const sub = frame[5] ?? 0;
  const value = frame[6] ?? 0;
  switch (sub) {
    case 6:
      return { kind: 'winLock', value: value === 1 };
    case 9:
      return { kind: 'highPrecision', value: value === 1 };
    case 12:
      return { kind: 'pzNum', value };
    case 14:
      return { kind: 'lightSleep', value };
    case 16:
      return { kind: 'isLock', value };
    case 18:
      return { kind: 'macMode', value: value === 1 };
    case 19:
      return { kind: 'fMode', value };
    default:
      return null;
  }
}

/**
 * `cmd 19`: light state.
 *
 * Payload: `[?, mode, speed, turn, brightness, r, g, b, colorful]`.
 */
export function decodeLight(bytes: Uint8Array): LightState | null {
  const frame = frameReport(bytes, HidCommand.Light, 13);
  if (!frame) return null;

  return {
    mode: frame[5] ?? 0,
    speed: frame[6] ?? 0,
    turn: frame[7] ?? 0,
    brightness: frame[8] ?? 0,
    colorful: frame[12] ?? 0,
    rgb: rgbToHex(frame[9] ?? 0, frame[10] ?? 0, frame[11] ?? 0),
  };
}

/**
 * `cmd 20`: per-key colours.
 *
 * Up to 11 entries, each 5 bytes starting at payload index `1 + n * 5`:
 * `hardCode, r, g, b, brightness`. Entries with `hardCode === 0` are empty
 * slots and are skipped.
 */
export function decodeKeyColors(bytes: Uint8Array): Map<number, KeyColor> | null {
  const payload = framePayload(bytes, HidCommand.KeyColor, 2);
  if (!payload) return null;

  const colors = new Map<number, KeyColor>();
  for (let n = 0; n < 11; n += 1) {
    const base = 1 + n * 5;
    if (base + 4 >= payload.length) break;
    const hardCode = payload[base] ?? 0;
    if (hardCode === 0) continue;
    colors.set(hardCode, {
      rgb: rgbToHex(payload[base + 1] ?? 0, payload[base + 2] ?? 0, payload[base + 3] ?? 0),
      brightness: payload[base + 4] ?? 0,
    });
  }
  return colors;
}

/**
 * `cmd 35`: key map of one layer.
 *
 * Only reports longer than 3 payload bytes carry a key map. Values are triples
 * starting at payload index 1: `hardCode, usageHi, usageLo`. Both usage bytes
 * zero means the key is unassigned.
 */
export function decodeKeyMap(bytes: Uint8Array): Map<number, { usage: number; assigned: boolean }> | null {
  const payload = framePayload(bytes, HidCommand.Remap, 1);
  if (!payload) return null;
  // A 3-byte payload is the single-key remap acknowledgement, not a key map.
  if ((bytes[1] ?? 0) <= 3) return null;

  const map = new Map<number, { usage: number; assigned: boolean }>();
  for (let i = 1; i + 2 < payload.length; i += 3) {
    const hardCode = payload[i] ?? 0;
    const usageHi = payload[i + 1] ?? 0;
    const usageLo = payload[i + 2] ?? 0;
    map.set(hardCode, {
      usage: (usageHi << 8) | usageLo,
      assigned: !(usageHi === 0 && usageLo === 0),
    });
  }
  return map;
}

/** `cmd 47` feature-list byte -> {@link FeatureKind}. */
function featureKindOf(value: number): FeatureKind {
  switch (value) {
    case 44:
    case 43:
      return 'socd';
    case 45:
      return 'rs';
    case 40:
      return 'end';
    case 36:
      return 'mt';
    case 37:
      return 'tgl';
    case 38:
      return 'dks';
    case 39:
      return 'mpt';
    default:
      return 'none';
  }
}

/**
 * `cmd 47`: which advanced feature each key uses.
 *
 * Pairs start at payload index 1 and step by 2: `hardCode, featureByte`.
 */
export function decodeFeatureList(bytes: Uint8Array): Map<number, FeatureKind> | null {
  const payload = framePayload(bytes, HidCommand.Feature, 2);
  if (!payload) return null;

  const map = new Map<number, FeatureKind>();
  for (let i = 1; i + 1 < payload.length; i += 2) {
    map.set(payload[i] ?? 0, featureKindOf(payload[i + 1] ?? 0));
  }
  return map;
}

/**
 * `cmd 36/37/38/39/40/43/45`: one key's advanced configuration.
 *
 * These replies are decoded from fixed frame offsets exactly like the driver:
 * the declared `[1]` on a real device can be shorter than the fields actually
 * written (same quirk family as `cmd 2` / `cmd 19` / `cmd 48`), and clamping
 * to it made the per-feature read return `null` — a captured backup then kept
 * the feature kind but none of its parameters, so nothing could be restored.
 * Frame index = payload index + 4; only the fields the firmware actually
 * reports are filled in; the caller decides how to present the rest.
 */
export function decodeFeature(bytes: Uint8Array): FeatureConfig | null {
  switch (bytes[2]) {
    case HidCommand.Mt: {
      const frame = frameReport(bytes, HidCommand.Mt, 11);
      if (!frame) return null;
      return {
        hardCode: frame[5] ?? 0,
        kind: 'mt',
        targetHidCodes: [word(frame, 6), word(frame, 8)],
        tapMs: byteToMs(frame[10] ?? 0),
      };
    }
    case HidCommand.Tgl: {
      const frame = frameReport(bytes, HidCommand.Tgl, 9);
      if (!frame) return null;
      return {
        hardCode: frame[5] ?? 0,
        kind: 'tgl',
        targetHidCodes: [word(frame, 6)],
        tapMs: byteToMs(frame[8] ?? 0),
      };
    }
    case HidCommand.Dks: {
      const frame = frameReport(bytes, HidCommand.Dks, 6);
      if (!frame) return null;
      // The response layout implies seven HID usages (frame bytes 6..19) from
      // a command whose request payload is only 5 bytes long — the layouts
      // contradict each other and this response is effectively dead code.
      // Only the key id can be trusted, so only it is decoded.
      return { hardCode: frame[5] ?? 0, kind: 'dks' };
    }
    case HidCommand.Mpt: {
      const frame = frameReport(bytes, HidCommand.Mpt, 18);
      if (!frame) return null;
      return {
        hardCode: frame[5] ?? 0,
        kind: 'mpt',
        travelMm: [
          travelBytesToMm(frame[6] ?? 0, frame[7] ?? 0),
          travelBytesToMm(frame[10] ?? 0, frame[11] ?? 0),
          travelBytesToMm(frame[14] ?? 0, frame[15] ?? 0),
        ],
        targetHidCodes: [word(frame, 8), word(frame, 12), word(frame, 16)],
      };
    }
    case HidCommand.End: {
      const frame = frameReport(bytes, HidCommand.End, 9);
      if (!frame) return null;
      return {
        hardCode: frame[5] ?? 0,
        kind: 'end',
        targetHidCodes: [word(frame, 6)],
        tapMs: byteToMs(frame[8] ?? 0),
      };
    }
    case HidCommand.Socd: {
      const frame = frameReport(bytes, HidCommand.Socd, 11);
      if (!frame) return null;
      return {
        hardCode: frame[5] ?? 0,
        kind: 'socd',
        targetHardCodes: [frame[7] ?? 0],
        first1: frame[6] === 0 ? 0 : 1,
        first2: frame[8] === 0 ? 0 : 1,
        bottom: frame[9] === 1,
        pauseMs: byteToMs(frame[10] ?? 0),
      };
    }
    case HidCommand.Rs: {
      const frame = frameReport(bytes, HidCommand.Rs, 9);
      if (!frame) return null;
      return {
        hardCode: frame[5] ?? 0,
        kind: 'rs',
        targetHardCodes: [frame[6] ?? 0],
        bottom: frame[7] === 1,
        pauseMs: byteToMs(frame[8] ?? 0),
      };
    }
    default:
      return null;
  }
}

/** Decoded `cmd 48` / `cmd 102` key-travel event. */
export type KeyTravelDecode =
  | { kind: 'single'; hardCode: number; mm: number }
  | { kind: 'release'; hardCode: number }
  | { kind: 'batch'; entries: { hardCode: number; mm: number; adc: number }[] };

/**
 * `cmd 48`: single-key travel report (`0xFF 0xFF` = key released).
 * `cmd 102`: batch report of up to 12 keys, each 5 payload bytes
 * (`hardCode, adc 2B, travel 2B`); `hardCode === 0` slots are skipped.
 */
export function decodeKeyTravel(bytes: Uint8Array): KeyTravelDecode | null {
  // Both reports are decoded from absolute offsets: the firmware declares
  // `[1] = 3` for `cmd 48` even though the travel bytes live at frame[6..7]
  // (verified on a Dimension Pro), so clamping to `[1]` would drop every event.
  if (bytes[2] === 48) {
    if (bytes.length < 8) return null;
    const hardCode = bytes[5] ?? 0;
    // Idle frames carry hardCode 0; they are not tied to any physical key.
    if (hardCode === 0) return null;
    const hi = bytes[6] ?? 0;
    const lo = bytes[7] ?? 0;
    if (hi === 0xff && lo === 0xff) return { kind: 'release', hardCode };
    return { kind: 'single', hardCode, mm: travelBytesToMm(hi, lo) };
  }
  if (bytes[2] === 102) {
    const entries: { hardCode: number; mm: number; adc: number }[] = [];
    for (let n = 0; n < 12; n += 1) {
      const base = PAYLOAD_OFFSET + n * 5;
      if (base + 4 >= bytes.length) break;
      const hardCode = bytes[base] ?? 0;
      if (hardCode === 0) continue;
      entries.push({
        hardCode,
        mm: travelBytesToMm(bytes[base + 3] ?? 0, bytes[base + 4] ?? 0),
        adc: word(bytes, base + 1),
      });
    }
    return entries.length > 0 ? { kind: 'batch', entries } : null;
  }
  return null;
}

/**
 * `cmd 41`: bulk travel configuration read-back.
 *
 * The response uses the same 14-byte-per-key layout as the write:
 * 4 slots starting at payload index `1 + n * 14`
 * (`hardCode, type, deadDown, deadUp, travel, fastOut, travelUp, travelDown`,
 * all millimetre values stored as big-endian micrometres). Slots whose
 * `hardCode` is 0 are empty and skipped.
 *
 * `releaseMm` is a legacy alias for the travel-down value. Both split values
 * are reported as `travelDownMm` / `travelUpMm`; when the device reports 0 for
 * either direction the press point is used as a fallback.
 */
export function decodeTravelConfig(bytes: Uint8Array): Map<number, TravelEntry> | null {
  const payload = framePayload(bytes, HidCommand.Travel, 2);
  if (!payload) return null;

  const entries = new Map<number, TravelEntry>();
  for (let n = 0; n < 4; n += 1) {
    const base = 1 + n * 14;
    if (base + 13 >= payload.length) break;
    const hardCode = payload[base] ?? 0;
    if (hardCode === 0) continue;

    const type = payload[base + 1] ?? 0;
    const pressMm = travelBytesToMm(payload[base + 6] ?? 0, payload[base + 7] ?? 0);
    // travelUp / travelDown are rapid-trigger sensitivities and are only
    // meaningful for fast (type 2) keys. For normal keys, report the actuation
    // point as the release value.
    const fast = type === 2;
    const fastOutMm = fast
      ? travelBytesToMm(payload[base + 8] ?? 0, payload[base + 9] ?? 0)
      : 0;
    const reportedUp = fast
      ? travelBytesToMm(payload[base + 10] ?? 0, payload[base + 11] ?? 0)
      : 0;
    const reportedDown = fast
      ? travelBytesToMm(payload[base + 12] ?? 0, payload[base + 13] ?? 0)
      : 0;
    const travelUpMm = reportedUp === 0 ? pressMm : reportedUp;
    const travelDownMm = reportedDown === 0 ? pressMm : reportedDown;

    entries.set(hardCode, {
      hardCode,
      pressMm,
      // Legacy alias: travel_down is the release point.
      releaseMm: travelDownMm,
      travelDownMm,
      travelUpMm,
      deadDownMm: travelBytesToMm(payload[base + 2] ?? 0, payload[base + 3] ?? 0),
      deadUpMm: travelBytesToMm(payload[base + 4] ?? 0, payload[base + 5] ?? 0),
      fastOutMm,
      fast,
    });
  }
  return entries;
}
