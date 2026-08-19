import { unrefTimer } from '../util/timing.js';

/**
 * Durable turn dispatcher (ctx-z5k0). The queue is `turns.status='queued'`
 * rows; this loop is the codebase's second dequeue primitive (after the
 * callback outbox), applying its lessons: real single-flight, claim-time
 * lane classification, and no in-process waiter list anywhere.
 *
 * Temperature is a claim-time predicate, never stored: a candidate whose
 * conversation has an ACTIVE session dispatches on the warm lane regardless
 * of container slots; everything else needs slot headroom. Fairness is
 * oldest-turn-of-least-recently-served-agent. Authoritative claiming stays
 * with the delivery lease inside `dispatchTurn` — a stale candidate simply
 * fails its claim and is skipped, so this loop never needs row locks.
 */

export interface DispatchCandidate {
  turnId: string;
  agentId: string;
  conversationId: string | null;
  queuedAt: number;
  sessionStatus: string | null;
}

export type DispatchResult = 'dispatched' | 'no_capacity' | 'skipped';

export interface TurnDispatcherDeps {
  db: {
    getDispatchableQueuedTurns(limit: number): Promise<DispatchCandidate[]>;
    getExpiredQueuedTurns(cutoffMs: number, limit?: number): Promise<Array<{ turnId: string; agentId: string; conversationId: string | null }>>;
  };
  /** Claims (delivery lease + concurrency reservation) and launches without awaiting execution. */
  dispatchTurn(candidate: DispatchCandidate): Promise<DispatchResult>;
  /** Finalizes an expired queued turn as turn.failed reason=queue_expired. */
  expireTurn(turn: { turnId: string; agentId: string; conversationId: string | null }): Promise<void>;
  /** True while a cold/restore dispatch may take a container slot. */
  hasSlotHeadroom(): boolean;
  queuedTurnTimeoutMs(): Promise<number>;
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string, err?: unknown): void };
  pollIntervalMs?: number;
  batchLimit?: number;
  now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_LIMIT = 32;
/** A pass this stale while work is queued reads as dispatch_stalled (503). */
export const DISPATCHER_STALL_MS = 30_000;
/** Re-dispatch grace for launched-but-not-yet-activated turns. */
export const DISPATCH_COOLDOWN_MS = 30_000;

export class TurnDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private passActive = false;
  private kickPending = false;
  private lastPassCompletedAt = 0;
  private startedAt = 0;
  private serveSeq = 0;
  private readonly lastServedByAgent = new Map<string, number>();
  /**
   * Turns launched but possibly not yet activated (queued→running is async):
   * without this, a candidate re-selects within the same pass and the loop
   * double-dispatches. The delivery lease arbitrates correctness; this map
   * just stops the waste. Stuck-queued rows retry after the cooldown and are
   * ultimately owned by the expiry sweep.
   */
  private readonly recentlyDispatched = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: TurnDispatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    this.timer = setInterval(() => void this.runPass(), this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    unrefTimer(this.timer);
    void this.runPass();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Low-latency nudge from enqueue paths; coalesces into the active pass. */
  kick(): void {
    if (!this.timer) return;
    if (this.passActive) {
      this.kickPending = true;
      return;
    }
    void this.runPass();
  }

  /** For the 503 dispatch_stalled arm: stalled = no recent completed pass. */
  isStalled(staleMs = DISPATCHER_STALL_MS): boolean {
    if (!this.startedAt && !this.lastPassCompletedAt) return true;
    const reference = Math.max(this.lastPassCompletedAt, this.startedAt);
    return this.now() - reference > staleMs;
  }

  getLastPassCompletedAt(): number {
    return this.lastPassCompletedAt;
  }

  async runPass(): Promise<void> {
    if (this.passActive) {
      this.kickPending = true;
      return;
    }
    this.passActive = true;
    try {
      do {
        this.kickPending = false;
        await this.expireStaleQueuedTurns();
        await this.dispatchEligible();
      } while (this.kickPending);
      this.lastPassCompletedAt = this.now();
    } catch (err) {
      this.deps.logger.error('[TurnDispatcher] pass failed', err);
    } finally {
      this.passActive = false;
    }
  }

  private async expireStaleQueuedTurns(): Promise<void> {
    const timeoutMs = await this.deps.queuedTurnTimeoutMs();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    const expired = await this.deps.db.getExpiredQueuedTurns(this.now() - timeoutMs);
    for (const turn of expired) {
      try {
        await this.deps.expireTurn(turn);
        this.deps.logger.warn(`[TurnDispatcher] expired queued turn ${turn.turnId} (queue_expired)`);
      } catch (err) {
        this.deps.logger.error(`[TurnDispatcher] failed to expire turn ${turn.turnId}`, err);
      }
    }
  }

  private async dispatchEligible(): Promise<void> {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const candidates = await this.deps.db.getDispatchableQueuedTurns(
        this.deps.batchLimit ?? DEFAULT_BATCH_LIMIT,
      );
      if (candidates.length === 0) return;

      // Fairness: least-recently-served agent first; enqueue order within.
      const ordered = [...candidates].sort((a, b) => {
        const servedA = this.lastServedByAgent.get(a.agentId) ?? 0;
        const servedB = this.lastServedByAgent.get(b.agentId) ?? 0;
        if (servedA !== servedB) return servedA - servedB;
        return a.queuedAt - b.queuedAt || a.turnId.localeCompare(b.turnId);
      });

      const now = this.now();
      for (const [turnId, dispatchedAt] of this.recentlyDispatched) {
        if (now - dispatchedAt >= DISPATCH_COOLDOWN_MS) this.recentlyDispatched.delete(turnId);
      }

      for (const candidate of ordered) {
        if (this.recentlyDispatched.has(candidate.turnId)) {
          continue; // launched; waiting on queued→running activation
        }
        const warm = candidate.sessionStatus === 'ACTIVE';
        if (!warm && !this.deps.hasSlotHeadroom()) {
          continue; // slot lane blocked; warm candidates later in the batch still flow
        }
        try {
          const result = await this.deps.dispatchTurn(candidate);
          if (result === 'dispatched') {
            this.recentlyDispatched.set(candidate.turnId, this.now());
            this.serveSeq += 1;
            this.lastServedByAgent.set(candidate.agentId, this.serveSeq);
            progressed = true;
          }
        } catch (err) {
          this.deps.logger.error(`[TurnDispatcher] dispatch failed for turn ${candidate.turnId}`, err);
        }
      }
    }
  }
}
