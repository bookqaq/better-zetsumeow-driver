/**
 * In-memory {@link Transport} used by tests and by consumers that want to drive
 * the SDK without hardware.
 */

import { NotConnectedError, TransportError } from '../errors.ts';
import type { FrameListener, Transport } from './types.ts';

/** Every keyboard report is one full 64-byte HID packet. */
const REPORT_SIZE = 64;

/** Options accepted by {@link MockTransport}. */
export interface MockTransportOptions {
  /** Start already open. Defaults to `false`. */
  readonly autoOpen?: boolean;
  /** Initial artificial delay applied to every {@link MockTransport.send}. */
  readonly sendDelayMs?: number;
}

/**
 * Loopback transport: outgoing frames are recorded in {@link sent}, incoming
 * frames are injected with {@link emit}.
 */
export class MockTransport implements Transport {
  readonly kind = 'mock' as const;

  /** Copies of every frame that was sent successfully, in order. */
  readonly sent: Uint8Array[] = [];

  private readonly listeners = new Set<FrameListener>();
  private openState: boolean;
  private pendingFailure: { readonly error: unknown } | null = null;
  private sendDelayMs: number;

  constructor(options: MockTransportOptions = {}) {
    this.openState = options.autoOpen ?? false;
    this.sendDelayMs = Math.max(0, options.sendDelayMs ?? 0);
  }

  get isOpen(): boolean {
    return this.openState;
  }

  async open(): Promise<void> {
    this.openState = true;
  }

  async close(): Promise<void> {
    this.openState = false;
    this.pendingFailure = null;
  }

  async send(frame: Uint8Array): Promise<void> {
    if (!this.openState) throw new NotConnectedError('MockTransport is not open');
    if (frame.length !== REPORT_SIZE) {
      throw new TransportError(`Expected a ${REPORT_SIZE}-byte report, received ${frame.length} bytes`);
    }

    const failure = this.pendingFailure;
    this.pendingFailure = null;
    if (failure) throw failure.error;

    if (this.sendDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.sendDelayMs);
      });
    }
    this.sent.push(frame.slice());
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Simulate an inbound frame. Every listener receives its own copy. */
  emit(frame: Uint8Array): void {
    const report = frame.slice();
    for (const listener of [...this.listeners]) {
      listener(report.slice());
    }
  }

  /** Make the next {@link send} reject with `error` (exactly once). */
  failNextSend(error: unknown): void {
    this.pendingFailure = { error };
  }

  /** Delay every subsequent {@link send} by `ms` milliseconds (0 disables it). */
  setSendDelay(ms: number): void {
    this.sendDelayMs = Math.max(0, ms);
  }
}
