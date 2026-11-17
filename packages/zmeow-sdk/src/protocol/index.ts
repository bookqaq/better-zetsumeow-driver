/**
 * Public entry point of the protocol layer.
 *
 * Pure functions only: framing, command payload builders and response
 * decoders. No DOM, no transports, no global state.
 */
export * from './frame.ts';
export * from './commands.ts';
export * from './response.ts';

// Byte / unit / colour codecs are re-exported for advanced consumers; the
// client layer imports them from `src/codec` directly.
export * from '../codec/bytes.ts';
export * from '../codec/keys.ts';
export * from '../codec/units.ts';
export * from '../codec/color.ts';
