import type { DatabaseRepository } from '../database/repository.js';
import type { EventMap, TypedEventBus } from '../events/bus.js';
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
   * turn.completed listener: emit budget.threshold when this turn's recorded
   * usage crossed a warn/block threshold (spend before this turn was below
   * it, spend including it is at/above). Crossing-only keeps webhooks from
   * firing on every turn while over threshold.
   */
  async onTurnCompleted(payload: EventMap['turn.completed']): Promise<void> {
    try {
      const turn = await this.deps.db.getTurn(payload.turnId);
      if (!turn) return;
      const tags = turn.tags ?? {};
      const contribution: BudgetSpend = {
        totalTokens: payload.usage?.totalTokens ?? 0,
        costUsd: payload.usage?.costUsd ?? 0,
        turns: 1,
      };

      const matched = await this.matchPolicies(tags);
      for (const match of matched) {
        const spendAfter = await this.deps.db.getBudgetSpend(
          match.doc.selector,
          windowStartMs(match.doc.window, Date.now()),
          match.bucket,
        );
        const statusesAfter = metricStatuses(match.doc.limits, spendAfter);

        for (const action of match.doc.actions) {
          const crossing = statusesAfter.find((after) => {
            const before = after.spent - (
              after.metric === 'totalTokens' ? contribution.totalTokens
              : after.metric === 'costUsd' ? contribution.costUsd
              : contribution.turns
            );
            return before < action.threshold * after.limit && after.ratio >= action.threshold;
          });
          if (!crossing) continue;

          this.deps.eventBus?.emit('budget.threshold', {
            policyId: match.policyId,
            policyName: match.policyName,
            bucket: match.bucketLabel,
            action: action.action,
            threshold: action.threshold,
            metric: crossing.metric,
            spent: crossing.spent,
            limit: crossing.limit,
            agentId: payload.agentId,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      this.deps.logger.error(`${TAG} threshold check failed for turn ${payload.turnId}:`, err);
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
