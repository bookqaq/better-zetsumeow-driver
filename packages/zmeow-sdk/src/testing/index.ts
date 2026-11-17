/**
 * Public testing entry point (`@bookqaq/zmeow-sdk/testing`).
 *
 * Exposes the WebHID and Web Serial fakes used by the test suite and by
 * downstream consumers that want to drive the SDK without hardware.
 */

export * from './fake-hid.ts';
export * from './fake-serial.ts';
