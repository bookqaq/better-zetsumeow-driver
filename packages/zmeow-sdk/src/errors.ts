/** Error hierarchy of the ZetsuMeow SDK. */
export type ZmeowErrorCode =
  | 'UNSUPPORTED'
  | 'USER_CANCELLED'
  | 'DEVICE_OPEN'
  | 'NOT_CONNECTED'
  | 'UNKNOWN_KEY'
  | 'UNKNOWN_LAYOUT'
  | 'VALIDATION'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'SCREEN_NOT_CONNECTED'
  | 'SCREEN_PERMISSION_REQUIRED'
  | 'UNSUPPORTED_FEATURE'
  | 'SERIAL_PERMISSION';

export class ZmeowError extends Error {
  readonly code: ZmeowErrorCode;

  constructor(code: ZmeowErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ZmeowError';
    this.code = code;
  }
}

/** The runtime cannot talk to the device at all (no WebHID/Web Serial, insecure context). */
export class UnsupportedError extends ZmeowError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('UNSUPPORTED', message, options);
    this.name = 'UnsupportedError';
  }
}

/** The user dismissed the chooser dialog. */
export class UserCancelledError extends ZmeowError {
  constructor(message = 'The user cancelled the device chooser', options?: { cause?: unknown }) {
    super('USER_CANCELLED', message, options);
    this.name = 'UserCancelledError';
  }
}

/** `HIDDevice.open()` / `SerialPort.open()` failed. */
export class DeviceOpenError extends ZmeowError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('DEVICE_OPEN', message, options);
    this.name = 'DeviceOpenError';
  }
}

export class NotConnectedError extends ZmeowError {
  constructor(message = 'The keyboard is not connected', options?: { cause?: unknown }) {
    super('NOT_CONNECTED', message, options);
    this.name = 'NotConnectedError';
  }
}

/** A key reference is not part of the currently active layout. */
export class UnknownKeyError extends ZmeowError {
  readonly key: unknown;

  constructor(message: string, key?: unknown, options?: { cause?: unknown }) {
    super('UNKNOWN_KEY', message, options);
    this.name = 'UnknownKeyError';
    this.key = key;
  }
}

/** `cmd 2/19` could not be decoded, so key-level features are unavailable. */
export class UnknownLayoutError extends ZmeowError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('UNKNOWN_LAYOUT', message, options);
    this.name = 'UnknownLayoutError';
  }
}

export class ValidationError extends ZmeowError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('VALIDATION', message, options);
    this.name = 'ValidationError';
  }
}

export class TimeoutError extends ZmeowError {
  readonly command: number | null;
  readonly subCommand: number | null;

  constructor(
    message: string,
    details?: { command?: number | null; subCommand?: number | null; cause?: unknown },
  ) {
    super('TIMEOUT', message, { cause: details?.cause });
    this.name = 'TimeoutError';
    this.command = details?.command ?? null;
    this.subCommand = details?.subCommand ?? null;
  }
}

/** A report could not be delivered / the device rejected it. */
export class TransportError extends ZmeowError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('TRANSPORT', message, options);
    this.name = 'TransportError';
  }
}

export class SerialPermissionError extends ZmeowError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('SERIAL_PERMISSION', message, options);
    this.name = 'SerialPermissionError';
  }
}

/** Screen (serial) link is not open yet. */
export class ScreenNotConnectedError extends ZmeowError {
  constructor(message = 'The screen link is not open. Call openScreen() from a user gesture first.', options?: { cause?: unknown }) {
    super('SCREEN_NOT_CONNECTED', message, options);
    this.name = 'ScreenNotConnectedError';
  }
}

/**
 * Opening the screen link needs a user gesture (Web Serial `requestPort`).
 * Thrown by screen operations that were not preceded by an explicit open.
 */
export class ScreenPermissionRequiredError extends ZmeowError {
  constructor(
    message = 'Web Serial requires a user gesture: call keyboard.openScreen() from a click handler, or construct the screen handle with { reuseGrantedPort: true }.',
    options?: { cause?: unknown },
  ) {
    super('SCREEN_PERMISSION_REQUIRED', message, options);
    this.name = 'ScreenPermissionRequiredError';
  }
}

/** The product does not expose this feature (e.g. no screen, no side light). */
export class UnsupportedFeatureError extends ZmeowError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('UNSUPPORTED_FEATURE', message, options);
    this.name = 'UnsupportedFeatureError';
  }
}
