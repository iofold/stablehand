import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@stablehand/proto/sandbox/v1';

/**
 * Append-only record of one turn delivery's SessionEvents (ADR 025).
 *
 * The harness pump appends; any number of consumers (the original
 * DeliverTurn stream, or an AttachTurn after an orchestrator takeover) read
 * from a cursor. Every appended event is stamped with this journal's id and
 * its 1-based position, so the orchestrator can tell which events it already
 * made durable and never applies one twice.
 */
export class TurnDeliveryJournal {
  readonly deliveryId: string;
  private readonly entries: SessionEvent[] = [];
  private finishedFlag = false;
  private failure: unknown;
  private waiters = new Set<() => void>();

  constructor(
    readonly turnId: string,
    deliveryId: string = randomUUID(),
  ) {
    this.deliveryId = deliveryId;
  }

  get lastSeq(): number {
    return this.entries.length;
  }

  get finished(): boolean {
    return this.finishedFlag;
  }

  append(event: SessionEvent): SessionEvent {
    if (this.finishedFlag) {
      throw new Error(`Turn delivery journal ${this.deliveryId} is already finished`);
    }
    event.deliveryId = this.deliveryId;
    event.deliverySeq = BigInt(this.entries.length + 1);
    this.entries.push(event);
    this.wake();
    return event;
  }

  /** Mark the journal complete. Readers drain what is left and stop. */
  finish(): void {
    if (this.finishedFlag) return;
    this.finishedFlag = true;
    this.wake();
  }

  /** Complete the journal with an error readers rethrow after draining. */
  fail(error: unknown): void {
    if (this.finishedFlag) return;
    this.failure = error;
    this.finish();
  }

  /**
   * Yield every event after `afterSeq`, waiting for new ones until the
   * journal finishes. Aborting `signal` ends the read by throwing its reason.
   */
  async *read(afterSeq: number, signal: AbortSignal): AsyncGenerator<SessionEvent> {
    let next = Math.max(0, Math.floor(afterSeq));
    while (true) {
      if (signal.aborted) {
        throw signal.reason;
      }
      if (next < this.entries.length) {
        const event = this.entries[next]!;
        next += 1;
        yield event;
        continue;
      }
      if (this.finishedFlag) {
        if (this.failure !== undefined) {
          throw this.failure;
        }
        return;
      }
      await this.waitForChange(signal);
    }
  }

  private waitForChange(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.waiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const waiter of waiters) waiter();
  }
}

export const DEFAULT_TURN_ORPHAN_GRACE_MS = 120_000;
export const TURN_ORPHAN_GRACE_ENV = 'STABLEHAND_TURN_ORPHAN_GRACE_MS';

/**
 * How long a turn keeps running after its orchestrator disappears. `0`
 * restores the pre-ADR-025 behaviour: a dropped stream or an expired
 * capability aborts the turn at once.
 */
export function resolveTurnOrphanGraceMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[TURN_ORPHAN_GRACE_ENV]?.trim();
  if (!raw) return DEFAULT_TURN_ORPHAN_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(
      `[sandbox] ignoring invalid ${TURN_ORPHAN_GRACE_ENV}=${raw}; using ${DEFAULT_TURN_ORPHAN_GRACE_MS}ms`,
    );
    return DEFAULT_TURN_ORPHAN_GRACE_MS;
  }
  return Math.floor(parsed);
}
