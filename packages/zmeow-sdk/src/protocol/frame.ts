/**
 * HID report framing.
 *
 * Every command is a fixed 64-byte report:
 *
 * ```
 * [0] = head (0xAB)
 * [1] = payload length (1..60)
 * [2] = command id
 * [3] = checksum
 * [4..4+len) = payload
 * [4+len..64) = zero padding
 * ```
 *
 * Checksum: `(length + command + lastPayloadByte) & 0xff`.
 */
import { ValidationError } from '../errors.ts';

/** Size of a HID output report, in bytes. */
export const REPORT_SIZE = 64;
/** First byte of every frame. */
export const REPORT_HEAD = 0xab;
/** Bytes reserved for the header (`head`, `length`, `command`, `checksum`). */
export const REPORT_HEADER_SIZE = 4;
/** A payload must contain at least one byte (the command family's first arg). */
export const MIN_PAYLOAD_LENGTH = 1;
/** 64-byte report minus the 4-byte header. */
export const MAX_PAYLOAD_LENGTH = REPORT_SIZE - REPORT_HEADER_SIZE;

export interface ParsedFrame {
  readonly head: number;
  readonly length: number;
  readonly command: number;
  readonly checksum: number;
  readonly payload: Uint8Array;
  /** The whole report the frame was parsed from. */
  readonly bytes: Uint8Array;
}

/**
 * `(length + command + lastPayloadByte) & 0xff`.
 *
 * The last payload byte lives at index `length + 3`.
 */
export function computeChecksum(length: number, command: number, lastPayloadByte: number): number {
  return (length + command + lastPayloadByte) & 0xff;
}

export interface BuildFrameOptions {
  /** Overrides {@link REPORT_HEAD}; used by diagnostics / alternate products. */
  readonly head?: number;
  /** Total report size, defaults to {@link REPORT_SIZE}. */
  readonly size?: number;
}

/**
 * Builds a complete report for `command`.
 *
 * The checksum is written automatically; the remaining bytes stay zero.
 *
 * @throws ValidationError when the payload is empty, longer than 60 bytes or
 * does not fit into the requested report size.
 */
export function buildFrame(
  command: number,
  payload: readonly number[],
  options?: BuildFrameOptions,
): Uint8Array {
  const size = options?.size ?? REPORT_SIZE;
  if (!Number.isInteger(size) || size < REPORT_HEADER_SIZE + MIN_PAYLOAD_LENGTH) {
    throw new ValidationError(`Invalid report size ${size}`);
  }
  const length = payload.length;
  if (length < MIN_PAYLOAD_LENGTH || length > MAX_PAYLOAD_LENGTH) {
    throw new ValidationError(
      `Command ${command} needs a payload of ${MIN_PAYLOAD_LENGTH}..${MAX_PAYLOAD_LENGTH} bytes, got ${length}`,
    );
  }
  if (length + REPORT_HEADER_SIZE > size) {
    throw new ValidationError(`Payload of ${length} bytes does not fit into a ${size}-byte report`);
  }

  const bytes = new Uint8Array(size);
  bytes[0] = (options?.head ?? REPORT_HEAD) & 0xff;
  bytes[1] = length;
  bytes[2] = command & 0xff;
  bytes.set(payload, REPORT_HEADER_SIZE);
  bytes[3] = computeChecksum(length, bytes[2], payload[length - 1] ?? 0);
  return bytes;
}

/**
 * Parses a raw report.
 *
 * Returns `null` when the head byte is not {@link REPORT_HEAD}, when the
 * declared length is impossible (`length < 1` or the payload runs past the end
 * of `bytes`). The checksum is exposed but not enforced: callers may want to
 * log corrupted reports rather than drop them.
 */
export function parseFrame(bytes: Uint8Array): ParsedFrame | null {
  if (bytes.length < REPORT_HEADER_SIZE) return null;
  const head = bytes[0] ?? 0;
  if (head !== REPORT_HEAD) return null;

  const length = bytes[1] ?? 0;
  if (length < MIN_PAYLOAD_LENGTH) return null;
  if (length + REPORT_HEADER_SIZE > bytes.length) return null;

  return {
    head,
    length,
    command: bytes[2] ?? 0,
    checksum: bytes[3] ?? 0,
    payload: bytes.slice(REPORT_HEADER_SIZE, REPORT_HEADER_SIZE + length),
    bytes,
  };
}
