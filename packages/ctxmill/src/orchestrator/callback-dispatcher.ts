import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseRepository, CallbackOutboxRow } from '../database/repository.js';

/** Retry delay schedule in milliseconds: attempt 1 -> immediate, 2 -> 5s, 3 -> 30s, 4 -> 5min, 5 -> 30min. */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 5 * 60_000, 30 * 60_000];

/** Per-row claim lease renewed at the top of each delivery (ctx-4p34); mirrors DEFAULT_CLAIM_LEASE_MS. */
const CLAIM_LEASE_MS = 60_000;

/** Compute the delay for a given attempt number (1-based). */
export function getRetryDelay(attempt: number): number {
  if (attempt <= 0) return 0;
  const idx = Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[idx];
}

interface EnqueueCallbackOpts {
  agentId: string;
  turnId?: string;
  webhookId?: string;
  callbackUrl: string;
  eventType: string;
  eventSeq?: number;
  payload: Record<string, unknown>;
}

/**
 * Durable callback/webhook outbox dispatcher.
 *
 * Enqueues callbacks into a persistent outbox table and delivers them via
 * HTTP POST with exponential-backoff retry. Failed deliveries are retried
 * up to `maxAttempts` times before being marked as permanently failed.
 */
export class CallbackDispatcher {
  private db: DatabaseRepository;
  private pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** ctx-4p34: single-flight guard — a tick that fires while a pass is still
   * in flight returns immediately instead of starting an overlapping scan. */
  private passActive = false;

  /** Pluggable fetch for testing. Defaults to global fetch. */
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;

  /** ctx-4p34: optional operator hook fired when a delivery is dead-lettered. */
  onDeadLetter?: (entry: CallbackOutboxRow) => void;

  constructor(
    db: DatabaseRepository,
    pollIntervalMs = 5000,
    fetchFn?: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    this.db = db;
    this.pollIntervalMs = pollIntervalMs;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Enqueue a callback for delivery.
   * Returns the outbox entry ID.
   */
  async enqueue(opts: EnqueueCallbackOpts): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    await this.db.enqueueCallback({
      id,
      agentId: opts.agentId,
      turnId: opts.turnId ?? null,
      webhookId: opts.webhookId ?? null,
      callbackUrl: opts.callbackUrl,
      eventType: opts.eventType,
      eventSeq: opts.eventSeq ?? null,
      payload: opts.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: now,
      lastAttemptAt: null,
      lastError: null,
      createdAt: now,
      deliveredAt: null,
    });
    return id;
  }

  /**
   * Start the background polling loop that processes pending callbacks.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processPending().catch((err) =>
        console.error('[CallbackDispatcher] poll error:', err),
      );
    }, this.pollIntervalMs);
    console.log(`[CallbackDispatcher] started (poll every ${this.pollIntervalMs}ms)`);
  }

  /**
   * Stop the background polling loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[CallbackDispatcher] stopped');
  }

  /**
   * Process all pending callbacks whose next_attempt_at is in the past.
   * Returns the number of entries processed.
   */
  async processPending(): Promise<number> {
    // ctx-4p34: single-flight. Without this, every poll tick starts a fresh
    // overlapping scan while a slow batch is still delivering, and the same
    // process re-claims and re-delivers a row whose lease lapsed mid-batch.
    if (this.passActive) return 0;
    this.passActive = true;
    try {
      const now = Date.now();
      const pending = await this.db.claimPendingCallbacks(50, now);
      let processed = 0;

      for (const entry of pending) {
        await this.deliver(entry);
        processed++;
      }

      return processed;
    } finally {
      this.passActive = false;
    }
  }

  /**
   * Attempt to deliver a single callback entry.
   * On success: marks as delivered.
   * On failure: increments attempts and schedules next retry (or marks as failed).
   */
  private async deliver(entry: CallbackOutboxRow): Promise<boolean> {
    // ctx-4p34: renew the claim before spending the ~10s delivery window on it.
    // If a re-claimer has taken the row (lease lapsed earlier in the batch),
    // bow out without re-POSTing — the new owner delivers it exactly once.
    if (entry.claimedAt != null) {
      const held = await this.db.renewCallbackClaim(entry.id, entry.claimedAt, CLAIM_LEASE_MS);
      if (!held) return false;
    }
    try {
      const body = JSON.stringify(entry.payload);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Agent-Id': entry.agentId,
        'X-Event-Type': entry.eventType,
        'X-Delivery-Id': entry.id,
      };

      if (entry.webhookId) {
        const webhook = await this.db.getWebhookForAgent(entry.webhookId, entry.agentId);
        if (!webhook?.secret) {
          throw new Error(`Webhook signing secret unavailable for delivery ${entry.id}`);
        }
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = createHmac('sha256', webhook.secret)
          .update(`${timestamp}.${body}`)
          .digest('hex');
        headers['X-Webhook-Timestamp'] = timestamp;
        headers['X-Webhook-Signature'] = `v1=${signature}`;
      }

      const response = await this.fetchFn(entry.callbackUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        await this.db.markCallbackDelivered(entry.id, entry.claimedAt);
        return true;
      }

      // Non-2xx response
      const errorText = `HTTP ${response.status}: ${response.statusText}`;
      await this.recordFailure(entry, errorText);
      return false;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.recordFailure(entry, errorMsg);
      return false;
    }
  }

  /**
   * Persist a failed attempt and, when it is terminal, make the dead-letter
   * visible (ctx-4p34) — previously a row hit status='failed' with no log,
   * event, or route, violating the "degraded, never silent" promise.
   */
  private async recordFailure(entry: CallbackOutboxRow, errorText: string): Promise<void> {
    const nextAttempt = entry.attempts + 1;
    const isFinal = nextAttempt >= entry.maxAttempts;
    const delay = getRetryDelay(nextAttempt + 1);
    await this.db.markCallbackFailed(entry.id, errorText, Date.now() + delay, entry.claimedAt);
    if (isFinal) {
      this.onDeadLetter?.(entry);
      console.error(
        `[CallbackDispatcher] dead-letter: delivery ${entry.id} to ${entry.callbackUrl} `
        + `permanently failed after ${nextAttempt} attempts: ${errorText}`,
      );
    }
  }
}
