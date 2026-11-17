/**
 * Parser for Wootility share responses.
 *
 * The assets in `assets/wooting-share/` are raw response bodies shaped as
 * `{ "data": { ...profile... } }`. The parser also tolerates legacy `curl`
 * dumps, but no fixture stores request headers. This module deliberately
 * performs no network I/O: pass the response body (or the parsed object) to
 * {@link parseWootingShare}.
 */

import { UnsupportedError, ValidationError } from '@bookqaq/zmeow-sdk';
import { wootingDeviceTitle, wootingModelForDevice } from './layout.ts';
import type {
  WootingAnalog,
  WootingCustomActuation,
  WootingPerKeyRapidTrigger,
  WootingProfile,
  WootingProfileSummary,
  WootingRemapEntry,
  WootingRgb,
} from './types.ts';

/** Highest Wootility profile schema this extension understands (2026-11). */
export const WOOTING_PROFILE_VERSION_MAX = 15;
/**
 * Oldest schema whose share fields are imported without speculative migration.
 * v9 moved the analog scale / remap storage; older profiles are imported
 * best-effort with a warning instead of silently guessing.
 */
export const WOOTING_PROFILE_VERSION_MIN_FULL = 9;

/** A profile written by a newer Wootility schema than this extension supports. */
export class WootingProfileVersionError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'WootingProfileVersionError';
  }
}

/** Extract the JSON body from a raw curl dump / response text. */
export function extractWootingJson(input: string): unknown {
  const text = input.trim();
  if (text.length === 0) throw new ValidationError('The Wooting profile response is empty');

  const candidates: string[] = [];
  candidates.push(text);
  const dataAt = text.indexOf('{"data"');
  if (dataAt >= 0) candidates.push(text.slice(dataAt));
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  throw new ValidationError('The Wooting profile response does not contain valid JSON');
}

/** Parse and validate a Wooting share response. */
export function parseWootingShare(input: string | unknown): WootingProfile {
  let value = typeof input === 'string' ? extractWootingJson(input) : input;
  // The share endpoint normally returns `{data: {...}}`, but it can also wrap
  // the profile in a one-element array (`{data: [profile]}`) — Wootility's own
  // import component accepts that shape. Keep the parser tolerant, but never
  // silently pick one of several profiles.
  if (Array.isArray(value)) value = singleProfile(value, 'response');
  if (!isRecord(value)) throw new ValidationError('The Wooting profile must be a JSON object');

  const data = value['data'];
  const inner = Array.isArray(data) ? singleProfile(data, 'data') : isRecord(data) ? data : value;
  if (!isRecord(inner)) throw new ValidationError('The Wooting profile has no data object');

  const profile = inner as WootingProfile;
  if (
    profile.version !== undefined &&
    profile.version !== null &&
    !isNonNegativeInteger(profile.version)
  ) {
    throw new ValidationError('Wooting profile version must be a non-negative integer');
  }
  if (profile.remap !== undefined && profile.remap !== null) {
    if (!Array.isArray(profile.remap)) {
      throw new ValidationError('Wooting profile remap must be null or an array of layers');
    }
    for (const [layer, entries] of profile.remap.entries()) {
      if (!Array.isArray(entries)) {
        throw new ValidationError(`Wooting remap layer ${layer} must be an array`);
      }
      for (const [index, entry] of entries.entries()) {
        validateRemapEntry(entry, `remap[${layer}][${index}]`);
      }
    }
  }

  if (profile.analog !== undefined && profile.analog !== null) validateAnalog(profile.analog);
  if (profile.rgb !== undefined && profile.rgb !== null) validateRgb(profile.rgb);
  if (profile.akc !== undefined && profile.akc !== null && !Array.isArray(profile.akc)) {
    throw new ValidationError('Wooting profile akc must be an array');
  }
  if (profile.customActuations !== undefined && profile.customActuations !== null) {
    if (!Array.isArray(profile.customActuations)) {
      throw new ValidationError('Wooting profile customActuations must be an array');
    }
    for (const [index, entry] of profile.customActuations.entries()) {
      validateCustomActuationEntry(entry, `customActuations[${index}]`);
    }
  }
  return profile;
}

/** Summarize model/name/guid without converting it. */
export function summarizeWootingProfile(profile: WootingProfile): WootingProfileSummary {
  const version = typeof profile.version === 'number' ? profile.version : null;
  if (version !== null && version > WOOTING_PROFILE_VERSION_MAX) {
    throw new WootingProfileVersionError(
      `Unsupported Wooting profile schema version ${version}; ` +
        `this extension supports up to version ${WOOTING_PROFILE_VERSION_MAX}. ` +
        'Update the extension before importing this profile.',
    );
  }
  const rawDevice = profile.target?.device;
  if (typeof rawDevice !== 'number') {
    throw new UnsupportedError(
      `Unsupported Wooting target.device ${String(rawDevice)}` +
        ' (unknown id, possibly a new Wooting model);' +
        ` importable devices: ${SUPPORTED_DEVICES_TEXT}. ` +
        `${EXCLUDED_DEVICES_TEXT}`,
    );
  }
  const model = wootingModelForDevice(rawDevice);
  if (model === null) {
    const label = wootingDeviceTitle(rawDevice);
    throw new UnsupportedError(
      `Unsupported Wooting target.device ${rawDevice}` +
        `${label ? ` (${label})` : ' (unknown id, possibly a new Wooting model)'};` +
        ` importable devices: ${SUPPORTED_DEVICES_TEXT}. ` +
        `${EXCLUDED_DEVICES_TEXT}`,
    );
  }
  return {
    model,
    modelTitle: wootingDeviceTitle(rawDevice) ?? (model === '80he' ? 'Wooting 80HE' : 'Wooting 60HE'),
    targetDevice: rawDevice,
    targetLayout: typeof profile.target?.layout === 'number' ? profile.target.layout : null,
    name: typeof profile.name === 'string' ? profile.name : 'Wooting profile',
    guid: typeof profile.guid === 'string' ? profile.guid : null,
    version,
  };
}

/**
 * Supported device ids. The product requirement is explicit: Wooting One,
 * the Wooting Two series (Two / Two HE / Two HE ARM) and UwU are deliberately
 * excluded, and no partial (overlapping-key) migration is performed for them.
 */
const SUPPORTED_DEVICES_TEXT = '4/5/9/11 (60HE family), 10/12 (80HE family)';
const EXCLUDED_DEVICES_TEXT =
  'Wooting One, the Wooting Two series (including Two HE) and Wooting UwU are not supported; ' +
  'no partial migration is performed for them.';

function singleProfile(list: readonly unknown[], label: string): unknown {
  if (list.length === 0) {
    throw new ValidationError(`The Wooting ${label} contains no profile`);
  }
  if (list.length > 1) {
    throw new ValidationError(
      `The Wooting ${label} contains ${list.length} profiles; import one at a time`,
    );
  }
  return list[0];
}

function validateRemapEntry(value: unknown, path: string): asserts value is WootingRemapEntry {
  if (!isRecord(value)) throw new ValidationError(`${path} must be an object`);
  const index = value['index'];
  if (!isRecord(index) || !isInteger(index['rowNr']) || !isInteger(index['colNr'])) {
    throw new ValidationError(`${path}.index must contain rowNr/colNr`);
  }
  if (!isInteger(value['value'])) {
    throw new ValidationError(`${path}.value must be an integer`);
  }
}

function validateAnalog(value: unknown): asserts value is WootingAnalog {
  if (!isRecord(value)) throw new ValidationError('Wooting profile analog must be an object');
  for (const field of [
    'actPoint',
    'rapidTriggerSensitivity',
    'rapidTriggerSecondarySensitivity',
  ]) {
    const candidate = value[field];
    if (candidate !== undefined && candidate !== null && typeof candidate !== 'number') {
      throw new ValidationError(`analog.${field} must be a number when present`);
    }
  }
  if (
    value['perKeyRapidTrigger'] !== undefined &&
    !Array.isArray(value['perKeyRapidTrigger'])
  ) {
    throw new ValidationError('analog.perKeyRapidTrigger must be an array');
  }
  if (Array.isArray(value['perKeyRapidTrigger'])) {
    for (const [index, entry] of value['perKeyRapidTrigger'].entries()) {
      validatePerKeyRapidTrigger(entry, `analog.perKeyRapidTrigger[${index}]`);
    }
  }
}

function validateCustomActuationEntry(
  value: unknown,
  path: string,
): asserts value is WootingCustomActuation {
  if (!isRecord(value)) throw new ValidationError(`${path} must be an object`);
  const index = value['index'];
  if (!isRecord(index) || !isInteger(index['rowNr']) || !isInteger(index['colNr'])) {
    throw new ValidationError(`${path}.index must contain rowNr/colNr`);
  }
  // v14 share profiles store actuation in millimetres (0.7, 1, 2), so this
  // value is deliberately not restricted to integers. Remap entries still are.
  if (typeof value['value'] !== 'number' || !Number.isFinite(value['value'])) {
    throw new ValidationError(`${path}.value must be a finite number`);
  }
}

function validatePerKeyRapidTrigger(
  value: unknown,
  path: string,
): asserts value is WootingPerKeyRapidTrigger {
  if (!isRecord(value)) throw new ValidationError(`${path} must be an object`);
  const index = value['index'];
  if (!isRecord(index) || !isInteger(index['rowNr']) || !isInteger(index['colNr'])) {
    throw new ValidationError(`${path}.index must contain rowNr/colNr`);
  }
  const setting = value['value'];
  if (setting === null || typeof setting === 'boolean') return;
  if (!isRecord(setting)) {
    throw new ValidationError(`${path}.value must be boolean, null or an object`);
  }
  for (const field of ['sensitivity', 'secondarySensitivity']) {
    const candidate = setting[field];
    if (candidate !== undefined && candidate !== null && typeof candidate !== 'number') {
      throw new ValidationError(`${path}.value.${field} must be a number when present`);
    }
  }
  if (
    setting['strictActuationRange'] !== undefined &&
    typeof setting['strictActuationRange'] !== 'boolean'
  ) {
    throw new ValidationError(`${path}.value.strictActuationRange must be a boolean`);
  }
}

function validateRgb(value: unknown): asserts value is WootingRgb {
  if (!isRecord(value)) throw new ValidationError('Wooting profile rgb must be an object');
  if (value['kbdArray'] !== undefined && !Array.isArray(value['kbdArray'])) {
    throw new ValidationError('rgb.kbdArray must be an array');
  }
  if (
    value['brightness'] !== undefined &&
    (typeof value['brightness'] !== 'number' || !Number.isFinite(value['brightness']))
  ) {
    throw new ValidationError('rgb.brightness must be a finite number when present');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
