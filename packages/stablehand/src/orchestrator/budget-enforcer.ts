import type { DatabaseRepository } from '../database/repository.js';
import type { EventMap, TypedEventBus } from '../events/bus.js';
import type { TurnUsage } from '@stablehand/contracts';
import {
  BudgetExceededError,
  TagNotProvisionedError,
  UNTAGGED_BUCKET,
  metricStatuses,
  parseBudgetPolicyDoc,
  selectorMatches,
  trippedAction,
  windowStartMs,
  type BudgetPolicyDoc,
  type BudgetSpend,
} from './budgets.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

type BudgetDb = Pick<DatabaseRepository, 'listBudgetPolicies' | 'getBudgetSpend' | 'getTurn'>;

interface BudgetEnforcerDeps {
  db: BudgetDb;
  eventBus?: Pick<TypedEventBus, 'emit'> | null;
  logger: Logger;
}

interface MatchedPolicy {
  policyId: string;
  policyName: string;
  doc: BudgetPolicyDoc;
  /** groupBy bucket for this run's tags; undefined when the policy has no groupBy. */
  bucket?: { key: string; value: string | null };
  bucketLabel?: string;
}

/** Remaining spend under the tightest blocking cost policy that matches a run. */
export interface PolicyCostHeadroom {
  remainingUsd: number;
  /** The policy's blocking point in USD (limit × block threshold). */
  limitUsd: number;
  spentUsd: number;
  policyId: string;
  policyName: string;
  bucket?: string;
}

const TAG = '[BudgetEnforcer]';

/**
 * Evaluates budget policies at turn admission (block) and turn completion
 * (threshold warnings). Policy-evaluation failures are fail-open — a broken
 * policy or a spend-query error must never take down all agents — but
 * BudgetExceededError and TagNotProvisionedError are deliberate outcomes and
 * propagate.
 */
export class BudgetEnforcer {
  constructor(private readonly deps: BudgetEnforcerDeps) {}

  /**
   * Throws BudgetExceededError when any matching bucket has hit a block
   * threshold, and TagNotProvisionedError when the run carries a groupBy tag
   * value the agent has not pre-provisioned (2026-07-15 decision: groupBy
   * buckets are enumerated in the agent definition, metadata.budgetDimensions).
   */
  async checkAdmission(params: {
    agentId: string;
    tags: Record<string, string>;
    budgetDimensions: Record<string, string[]>;
  }): Promise<void> {
    const matched = await this.matchPolicies(params.tags);

    for (const match of matched) {
      if (match.bucket && match.bucket.value !== null) {
        const provisioned = params.budgetDimensions[match.bucket.key];
        if (!provisioned || !provisioned.includes(match.bucket.value)) {
          throw new TagNotProvisionedError(match.bucket.key, match.bucket.value, params.agentId);
        }
      }

      let spend: BudgetSpend;
      try {
        spend = await this.deps.db.getBudgetSpend(
          match.doc.selector,
          windowStartMs(match.doc.window, Date.now()),
          match.bucket,
        );
      } catch (err) {
        this.deps.logger.error(`${TAG} spend query failed for policy ${match.policyId}; admitting turn (fail-open):`, err);
        continue;
      }

      const tripped = trippedAction(match.doc, spend);
      if (tripped?.action.action === 'block') {
        throw new BudgetExceededError(match.policyId, match.policyName, match.bucketLabel, tripped.status);
      }
    }
  }

  /**
   * The tightest remaining USD headroom across matching policies that block
   * on a `costUsd` limit, for capping a run mid-flight. Advisory snapshot:
   * the spend ledger lags reconciliation, and token/turn limits are not
   * converted to dollars. Fail-open like admission — a policy whose spend is
   * unknown or unreadable contributes no cap.
   */
  async costHeadroom(tags: Record<string, string>): Promise<PolicyCostHeadroom | null> {
    const matched = await this.matchPolicies(tags);
    let tightest: PolicyCostHeadroom | null = null;
    for (const match of matched) {
      const costLimit = match.doc.limits.costUsd;
      const blockAt = match.doc.actions
        .filter((action) => action.action === 'block')
        .reduce<number | null>(
          (lowest, action) => (lowest === null ? action.threshold : Math.min(lowest, action.threshold)),
          null,
        );
      if (costLimit === undefined || blockAt === null) continue;

      let spend: BudgetSpend;
      try {
        spend = await this.deps.db.getBudgetSpend(
          match.doc.selector,
          windowStartMs(match.doc.window, Date.now()),
          match.bucket,
        );
      } catch (err) {
        this.deps.logger.error(`${TAG} spend query failed for policy ${match.policyId}; no run cap from it (fail-open):`, err);
        continue;
      }
      if (spend.costUsd === null) continue;

      const limitUsd = costLimit * blockAt;
      const remainingUsd = Math.max(0, limitUsd - spend.costUsd);
      if (!tightest || remainingUsd < tightest.remainingUsd) {
        tightest = {
          remainingUsd,
          limitUsd,
          spentUsd: spend.costUsd,
          policyId: match.policyId,
          policyName: match.policyName,
          ...(match.bucketLabel ? { bucket: match.bucketLabel } : {}),
        };
      }
    }
    return tightest;
  }

  /**
   * turn.completed listener: emit budget.threshold when this turn's recorded
   * usage crossed a warn/block threshold (spend before this turn was below
   * it, spend including it is at/above). Crossing-only keeps webhooks from
   * firing on every turn while over threshold.
   */
  async onTurnCompleted(payload: EventMap['turn.completed']): Promise<void> {
    try {
      const turn = await this.deps.db.getTurn(payload.turnId);
      if (!turn) return;
      await this.evaluateThresholdCrossings({
        agentId: payload.agentId,
        tags: turn.tags ?? {},
        contribution: {
          totalTokens: payload.usage?.totalTokens ?? null,
          costUsd: payload.usage?.cost.totalUsd ?? null,
          turns: 1,
        },
      });
    } catch (err) {
      this.deps.logger.error(`${TAG} threshold check failed for turn ${payload.turnId}:`, err);
    }
  }

  /**
   * Re-run the crossing evaluator when asynchronous gateway reconciliation
   * changes the durable usage projection. Only the persisted delta
   * contributes: turn count was already charged at completion.
   */
  async onTurnUsageReconciled(params: {
    turnId: string;
    agentId: string;
    previousUsage: TurnUsage | null;
    usage: TurnUsage;
  }): Promise<void> {
    try {
      const turn = await this.deps.db.getTurn(params.turnId);
      if (!turn) return;
      const previousCost = params.previousUsage?.cost.totalUsd ?? null;
      const costDelta = params.usage.cost.totalUsd === null
        ? null
        : params.usage.cost.totalUsd - (previousCost ?? 0);
      await this.evaluateThresholdCrossings({
        agentId: params.agentId,
        tags: turn.tags ?? {},
        contribution: {
          totalTokens:
            params.usage.totalTokens - (params.previousUsage?.totalTokens ?? 0),
          costUsd: costDelta,
          turns: 0,
        },
      });
    } catch (err) {
      this.deps.logger.error(
        `${TAG} reconciled threshold check failed for turn ${params.turnId}:`,
        err,
      );
    }
  }

  private async evaluateThresholdCrossings(params: {
    agentId: string;
    tags: Record<string, string>;
    contribution: BudgetSpend;
  }): Promise<void> {
    const matched = await this.matchPolicies(params.tags);
    for (const match of matched) {
      const spendAfter = await this.deps.db.getBudgetSpend(
        match.doc.selector,
        windowStartMs(match.doc.window, Date.now()),
        match.bucket,
      );
      const statusesAfter = metricStatuses(
        match.doc.limits,
        spendAfter,
        match.doc.actions,
      );

      for (const action of match.doc.actions) {
        const crossing = statusesAfter.find((after) => {
          if (after.spent === null || after.ratio === null) return false;
          const turnContribution = after.metric === 'totalTokens'
            ? params.contribution.totalTokens
            : after.metric === 'costUsd'
              ? params.contribution.costUsd
              : params.contribution.turns;
          if (turnContribution === null || turnContribution <= 0) return false;
          const before = after.spent - turnContribution;
          return before < action.threshold * after.limit
            && after.ratio >= action.threshold;
        });
        if (!crossing || crossing.spent === null) continue;

        this.deps.eventBus?.emit('budget.threshold', {
          policyId: match.policyId,
          policyName: match.policyName,
          bucket: match.bucketLabel,
          action: action.action,
          threshold: action.threshold,
          metric: crossing.metric,
          spent: crossing.spent,
          limit: crossing.limit,
          agentId: params.agentId,
          timestamp: Date.now(),
        });
      }
    }
  }

  private async matchPolicies(tags: Record<string, string>): Promise<MatchedPolicy[]> {
    let policies: Awaited<ReturnType<BudgetDb['listBudgetPolicies']>>;
    try {
      policies = await this.deps.db.listBudgetPolicies();
    } catch (err) {
      this.deps.logger.error(`${TAG} failed to list policies; treating as none (fail-open):`, err);
      return [];
    }

    const matched: MatchedPolicy[] = [];
    for (const policy of policies) {
      if (!policy.enabled) continue;
      const parsed = parseBudgetPolicyDoc(policy.doc);
      if ('error' in parsed) {
        this.deps.logger.warn(`${TAG} skipping invalid policy ${policy.id} (${policy.name}): ${parsed.error}`);
        continue;
      }
      const doc = parsed.doc;
      if (!selectorMatches(doc.selector, tags)) continue;

      if (doc.groupBy) {
        const value = tags[doc.groupBy];
        matched.push({
          policyId: policy.id,
          policyName: policy.name,
          doc,
          bucket: { key: doc.groupBy, value: value ?? null },
          bucketLabel: value !== undefined ? `${doc.groupBy}=${value}` : UNTAGGED_BUCKET,
        });
      } else {
        matched.push({ policyId: policy.id, policyName: policy.name, doc });
      }
    }
    return matched;
  }
}
