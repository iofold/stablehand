import { randomUUID } from 'node:crypto';

import type { TurnUsage } from '@ctxmill/contracts';

import type { DatabaseRepository } from '../database/repository.js';
import { unrefTimer } from '../util/timing.js';
import type { LiteLLMSpendClient } from './litellm-spend-client.js';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_OVERLAP_MS = 60_000;
const DEFAULT_SETTLEMENT_DELAY_MS = 10_000;
const DEFAULT_INITIAL_LOOKBACK_MS = 15 * 60_000;
const TAG = '[ModelGatewayReconciler]';

type ModelGatewayReconciliationStore = Pick<
  DatabaseRepository,
  | 'claimModelGatewayReconciliationLease'
  | 'recordModelGatewayReconciliationFailure'
  | 'reconcileModelGatewaySpend'
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
  pollIntervalMs?: number;
  overlapMs?: number;
  settlementDelayMs?: number;
  initialLookbackMs?: number;
  now?: () => number;
}

export type ModelGatewayReconciliationResult =
  | { status: 'not_owner' }
  | {
      status: 'success';
      attached: number;
      quarantined: number;
      affectedTurnIds: string[];
      watermarkMs: number;
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

  private readonly now: () => number;

  private timer?: ReturnType<typeof setInterval>;

  private activeRun?: Promise<ModelGatewayReconciliationResult>;

  private stopping = false;

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

    try {
      const processedThroughMs = Math.max(0, nowMs - this.settlementDelayMs);
      const startMs = lease.watermarkMs > 0
        ? Math.max(0, lease.watermarkMs - this.overlapMs)
        : Math.max(0, processedThroughMs - this.initialLookbackMs);
      const spend = await this.deps.spendClient.listSpend({
        startMs,
        endMs: processedThroughMs,
      });
      const committed = await this.deps.db.reconcileModelGatewaySpend({
        gatewayProfile: this.options.profile,
        gatewayRevision: this.options.revision,
        ownerId: this.ownerId,
        fenceToken: lease.fenceToken,
        nowMs,
        processedThroughMs,
        settleBeforeMs: processedThroughMs,
        records: spend.records,
        invalid: spend.invalid,
      });

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
      return {
        status: 'success',
        attached: committed.attached,
        quarantined: committed.quarantined,
        affectedTurnIds: committed.affectedTurnIds,
        watermarkMs: committed.watermarkMs,
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
    }
  }
}
