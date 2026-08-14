import { randomUUID } from 'node:crypto';

import type { TurnUsage } from '@ctxmill/contracts';

import type { DatabaseRepository } from '../database/repository.js';
import { unrefTimer } from '../util/timing.js';
import type { LiteLLMSpendClient } from './litellm-spend-client.js';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_OVERLAP_MS = 60_000;
const DEFAULT_SETTLEMENT_DELAY_MS = 10_000;
const DEFAULT_INITIAL_LOOKBACK_MS = 15 * 60_000;
/**
 * Age past which a turn's missing spend evidence is treated as permanently
 * lost and the turn settles as unpriced (ctx-qqqp). Must stay below the
 * status route's awaiting-grace threshold (15 min) so a bounded per-turn loss
 * settles honestly instead of pinning the gateway state degraded forever;
 * systemic ingestion failure is still caught by the watermark-lag arm.
 */
const DEFAULT_ABANDONED_GRACE_MS = 10 * 60_000;
const TAG = '[ModelGatewayReconciler]';

type ModelGatewayReconciliationStore = Pick<
  DatabaseRepository,
  | 'claimModelGatewayReconciliationLease'
  | 'extendModelGatewayReconciliationLease'
  | 'recordModelGatewayReconciliationFailure'
  | 'reconcileModelGatewaySpend'
  | 'settleAbandonedGatewayTurns'
>;

interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface UsageChange {
  turnId: string;
  agentId: string;
  previousUsage: TurnUsage | null;
  usage: TurnUsage;
}

interface ModelGatewayReconcilerDeps {
  db: ModelGatewayReconciliationStore;
  spendClient: Pick<LiteLLMSpendClient, 'listSpend'>;
  onUsageReconciled?: (change: UsageChange) => Promise<void>;
  logger: Logger;
}

interface ModelGatewayReconcilerOptions {
  profile: string;
  revision: string;
  ownerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  pollIntervalMs?: number;
  overlapMs?: number;
  settlementDelayMs?: number;
  initialLookbackMs?: number;
  abandonedGraceMs?: number;
  now?: () => number;
}

export type ModelGatewayReconciliationResult =
  | { status: 'not_owner' }
  | { status: 'backed_off'; retryAtMs: number }
  | {
      status: 'success';
      attached: number;
      quarantined: number;
      settledUnpriced: number;
      affectedTurnIds: string[];
      watermarkMs: number;
      truncated: boolean;
    }
  | { status: 'failed'; error: string };

function positiveOption(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeOption(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

export class ModelGatewayReconciler {
  private readonly ownerId: string;

  private readonly leaseMs: number;

  private readonly pollIntervalMs: number;

  private readonly overlapMs: number;

  private readonly settlementDelayMs: number;

  private readonly initialLookbackMs: number;

  private readonly abandonedGraceMs: number;

  private readonly now: () => number;

  private readonly heartbeatMs: number;

  private timer?: ReturnType<typeof setInterval>;

  private activeRun?: Promise<ModelGatewayReconciliationResult>;

  private stopping = false;

  private consecutiveFailures = 0;

  private backoffUntilMs = 0;

  constructor(
    private readonly deps: ModelGatewayReconcilerDeps,
    private readonly options: ModelGatewayReconcilerOptions,
  ) {
    if (!options.profile.trim() || !options.revision.trim()) {
      throw new Error('Model gateway reconciliation profile and revision are required');
    }
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseMs = positiveOption(
      'Model gateway reconciliation lease',
      options.leaseMs ?? DEFAULT_LEASE_MS,
    );
    this.heartbeatMs = positiveOption(
      'Model gateway reconciliation heartbeat',
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    );
    if (this.heartbeatMs >= this.leaseMs) {
      throw new Error('Model gateway reconciliation heartbeat must be shorter than the lease');
    }
    this.pollIntervalMs = positiveOption(
      'Model gateway reconciliation poll interval',
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    this.overlapMs = nonnegativeOption(
      'Model gateway reconciliation overlap',
      options.overlapMs ?? DEFAULT_OVERLAP_MS,
    );
    this.settlementDelayMs = nonnegativeOption(
      'Model gateway reconciliation settlement delay',
      options.settlementDelayMs ?? DEFAULT_SETTLEMENT_DELAY_MS,
    );
    this.initialLookbackMs = positiveOption(
      'Model gateway reconciliation initial lookback',
      options.initialLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS,
    );
    this.abandonedGraceMs = positiveOption(
      'Model gateway reconciliation abandoned grace',
      options.abandonedGraceMs ?? DEFAULT_ABANDONED_GRACE_MS,
    );
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopping) {
      return;
    }
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollIntervalMs);
    unrefTimer(this.timer);
    this.deps.logger.info(
      `${TAG} started profile ${this.options.profile} revision ${this.options.revision}`,
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activeRun;
  }

  runOnce(): Promise<ModelGatewayReconciliationResult> {
    if (this.activeRun) {
      return this.activeRun;
    }
    const run = this.reconcile();
    this.activeRun = run;
    const clear = () => {
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
    };
    void run.then(clear, clear);
    return run;
  }

  private async reconcile(): Promise<ModelGatewayReconciliationResult> {
    const nowMs = this.now();
    // (a) Exponential backoff: during a LiteLLM outage every poll used to
    // re-fetch the full growing window from page 1. Failures now widen the
    // retry gap up to MAX_BACKOFF_MS; any success resets it.
    if (nowMs < this.backoffUntilMs) {
      return { status: 'backed_off', retryAtMs: this.backoffUntilMs };
    }
    const result = await this.reconcileOnce(nowMs);
    if (result.status === 'failed') {
      this.consecutiveFailures += 1;
      const backoffMs = Math.min(
        this.pollIntervalMs * 2 ** this.consecutiveFailures,
        MAX_BACKOFF_MS,
      );
      this.backoffUntilMs = this.now() + backoffMs;
      this.deps.logger.warn(
        `${TAG} backing off ${backoffMs}ms after ${this.consecutiveFailures} consecutive failure(s)`,
      );
    } else {
      this.consecutiveFailures = 0;
      this.backoffUntilMs = 0;
    }
    return result;
  }

  private async reconcileOnce(nowMs: number): Promise<ModelGatewayReconciliationResult> {
    let lease: Awaited<
      ReturnType<ModelGatewayReconciliationStore['claimModelGatewayReconciliationLease']>
    >;
    try {
      lease = await this.deps.db.claimModelGatewayReconciliationLease({
        gatewayProfile: this.options.profile,
        gatewayRevision: this.options.revision,
        ownerId: this.ownerId,
        nowMs,
        leaseMs: this.leaseMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`${TAG} failed to claim reconciliation lease:`, error);
      return { status: 'failed', error: message };
    }
    if (!lease) {
      return { status: 'not_owner' };
    }

    // (e) Heartbeat: a run longer than the lease used to expire underneath
    // itself and roll back all work — sustained backlog livelocked. Extend
    // the lease on a cadence; losing it aborts the in-flight fetch.
    const runAbort = new AbortController();
    const heartbeat = setInterval(() => {
      void this.deps.db.extendModelGatewayReconciliationLease({
        gatewayProfile: this.options.profile,
        ownerId: this.ownerId,
        fenceToken: lease.fenceToken,
        nowMs: this.now(),
        leaseMs: this.leaseMs,
      }).then((extended) => {
        if (!extended) {
          this.deps.logger.warn(`${TAG} lost reconciliation lease mid-run; aborting`);
          runAbort.abort(new Error('reconciliation lease lost mid-run'));
        }
      }).catch((error) => {
        this.deps.logger.warn(`${TAG} lease heartbeat failed:`, error);
      });
    }, this.heartbeatMs);
    unrefTimer(heartbeat);
    // (d) A hung spend fetch used to park activeRun (and stop()) forever.
    // Bound every fetch by the lease duration — past that the lease is gone
    // and the work would roll back anyway.
    const fetchTimeout = setTimeout(() => {
      runAbort.abort(new Error(`spend fetch exceeded ${this.leaseMs}ms`));
    }, this.leaseMs);
    unrefTimer(fetchTimeout);

    try {
      const processedThroughMs = Math.max(0, nowMs - this.settlementDelayMs);
      const startMs = lease.watermarkMs > 0
        ? Math.max(0, lease.watermarkMs - this.overlapMs)
        : Math.max(0, processedThroughMs - this.initialLookbackMs);
      const spend = await this.deps.spendClient.listSpend({
        startMs,
        endMs: processedThroughMs,
        signal: runAbort.signal,
      });
      // (b) Truncated pagination commits the safe prefix: the watermark
      // advances to the fetch boundary instead of stalling forever once the
      // backlog outgrows one window. Settlement must not outrun coverage.
      const effectiveThroughMs = spend.truncatedAtMs !== undefined
        ? Math.max(lease.watermarkMs, Math.min(processedThroughMs, spend.truncatedAtMs))
        : processedThroughMs;
      if (spend.truncatedAtMs !== undefined) {
        this.deps.logger.warn(
          `${TAG} spend backlog exceeds one fetch window;`
          + ` committing partial progress through ${new Date(effectiveThroughMs).toISOString()}`,
        );
      }
      const committed = await this.deps.db.reconcileModelGatewaySpend({
        gatewayProfile: this.options.profile,
        gatewayRevision: this.options.revision,
        ownerId: this.ownerId,
        fenceToken: lease.fenceToken,
        nowMs,
        processedThroughMs: effectiveThroughMs,
        settleBeforeMs: effectiveThroughMs,
        records: spend.records,
        invalid: spend.invalid,
      });
      for (const anomaly of committed.anomalies) {
        this.deps.logger.error(
          `${TAG} skipped inconsistent turn ${anomaly.turnId} (${anomaly.reason});`
          + ' spend batch continued without it',
        );
      }

      for (const change of committed.usageChanges) {
        try {
          await this.deps.onUsageReconciled?.(change);
        } catch (error) {
          this.deps.logger.error(
            `${TAG} late usage callback failed for turn ${change.turnId}:`,
            error,
          );
        }
      }

      // ctx-qqqp: turns whose spend evidence never arrived settle as unpriced
      // once the read window can no longer recover them. Each loss is logged
      // individually — settlement keeps the gateway state honest without
      // making the loss silent.
      const settled = await this.deps.db.settleAbandonedGatewayTurns({
        nowMs,
        abandonedBeforeMs: nowMs - this.abandonedGraceMs,
      });
      for (const turn of settled) {
        this.deps.logger.warn(
          `${TAG} spend evidence never arrived for turn ${turn.turnId}`
          + ` (correlation ${turn.correlationId ?? 'none'}); settled as unpriced`,
        );
      }

      return {
        status: 'success',
        attached: committed.attached,
        quarantined: committed.quarantined,
        settledUnpriced: settled.length,
        affectedTurnIds: committed.affectedTurnIds,
        watermarkMs: committed.watermarkMs,
        truncated: spend.truncatedAtMs !== undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.deps.db.recordModelGatewayReconciliationFailure({
          gatewayProfile: this.options.profile,
          ownerId: this.ownerId,
          fenceToken: lease.fenceToken,
          nowMs: this.now(),
          error: message,
        });
      } catch (releaseError) {
        this.deps.logger.error(
          `${TAG} failed to release reconciliation lease after error:`,
          releaseError,
        );
      }
      this.deps.logger.error(
        `${TAG} reconciliation failed for profile ${this.options.profile}:`,
        error,
      );
      return { status: 'failed', error: message };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(fetchTimeout);
    }
  }
}
