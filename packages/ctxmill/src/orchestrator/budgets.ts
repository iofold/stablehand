import {
  BudgetPolicyDocSchema,
  BudgetWindowSchema,
  type BudgetAction,
  type BudgetLimits,
  type BudgetMetricStatus,
  type BudgetPolicyDoc,
  type BudgetWindow,
} from '@ctxmill/contracts';

/**
 * Declarative tag-based budget policy behavior. All data validation and public
 * types live in @ctxmill/contracts; this module only owns runtime evaluation.
 */

export const BUDGET_WINDOWS = BudgetWindowSchema.options;
export type {
  BudgetAction,
  BudgetLimits,
  BudgetPolicyDoc,
  BudgetWindow,
};

export type EvaluatedBudgetMetricStatus = Omit<BudgetMetricStatus, 'spent' | 'ratio'> & {
  spent: number;
  ratio: number;
};

export interface BudgetSpend {
  totalTokens: number | null;
  costUsd: number | null;
  turns: number;
}

/** Sentinel bucket for runs matching a groupBy policy without that tag. */
export const UNTAGGED_BUCKET = '(untagged)';

const ROLLING_WINDOW_MS: Record<Exclude<BudgetWindow, 'month-to-date'>, number> = {
  'rolling-1h': 60 * 60 * 1000,
  'rolling-24h': 24 * 60 * 60 * 1000,
  'rolling-7d': 7 * 24 * 60 * 60 * 1000,
  'rolling-30d': 30 * 24 * 60 * 60 * 1000,
};

/** Window start in epoch ms. Calendar windows are UTC by decision (2026-07-15). */
export function windowStartMs(window: BudgetWindow, nowMs: number): number {
  if (window === 'month-to-date') {
    const now = new Date(nowMs);
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  }
  return nowMs - ROLLING_WINDOW_MS[window];
}

export function selectorMatches(selector: Record<string, string>, tags: Record<string, string>): boolean {
  return Object.entries(selector).every(([key, value]) => tags[key] === value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.entries(value).every(([k, v]) => typeof k === 'string' && typeof v === 'string')
  );
}

const LIMIT_KEYS = ['totalTokens', 'costUsd', 'turns'] as const;

/** Validate an untrusted policy document. Returns the typed doc or an error message. */
export function parseBudgetPolicyDoc(doc: unknown): { doc: BudgetPolicyDoc } | { error: string } {
  const parsed = BudgetPolicyDocSchema.safeParse(doc);
  if (parsed.success) return { doc: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return { error: `${path}${issue?.message ?? 'invalid policy document'}` };
}

/** Per-metric status for a bucket's spend against a policy's limits. */
export function metricStatuses(
  limits: BudgetLimits,
  spend: BudgetSpend,
  actions: BudgetAction[] = [],
): BudgetMetricStatus[] {
  const spentByMetric: Record<keyof BudgetLimits, number | null> = {
    totalTokens: spend.totalTokens,
    costUsd: spend.costUsd,
    turns: spend.turns,
  };
  const statuses: BudgetMetricStatus[] = [];
  for (const metric of LIMIT_KEYS) {
    const limit = limits[metric];
    if (limit === undefined) continue;
    const spent = spentByMetric[metric];
    if (spent === null) {
      statuses.push({
        metric,
        spent: null,
        limit,
        ratio: null,
        state: 'ok',
        action: null,
      });
      continue;
    }
    const ratio = spent / limit;
    const crossed = actions
      .filter((action) => ratio >= action.threshold)
      .sort((a, b) => {
        if (a.action !== b.action) return a.action === 'block' ? -1 : 1;
        return b.threshold - a.threshold;
      })[0] ?? null;
    statuses.push({
      metric,
      spent,
      limit,
      ratio,
      state: crossed?.action === 'block'
        ? 'blocked'
        : crossed?.action === 'warn'
          ? 'warning'
          : 'ok',
      action: crossed,
    });
  }
  return statuses;
}

/**
 * The highest-threshold action tripped by this spend, if any. "Tripped" is
 * ratio >= threshold on any limited metric.
 */
export function trippedAction(
  doc: BudgetPolicyDoc,
  spend: BudgetSpend,
): { action: BudgetAction; status: EvaluatedBudgetMetricStatus } | undefined {
  const statuses = metricStatuses(doc.limits, spend, doc.actions);
  const sorted = [...doc.actions].sort((a, b) => {
    if (a.action !== b.action) return a.action === 'block' ? -1 : 1;
    return b.threshold - a.threshold;
  });
  for (const action of sorted) {
    const status = statuses.find(
      (candidate): candidate is EvaluatedBudgetMetricStatus => (
        candidate.ratio !== null
        && candidate.spent !== null
        && candidate.ratio >= action.threshold
      ),
    );
    if (status) return { action, status };
  }
  return undefined;
}

/** Thrown at turn admission when a matching bucket has hit a block threshold. */
export class BudgetExceededError extends Error {
  readonly statusCode = 429;
  readonly code = 'budget_exceeded';

  constructor(
    readonly policyId: string,
    readonly policyName: string,
    readonly bucket: string | undefined,
    readonly status: EvaluatedBudgetMetricStatus,
  ) {
    super(
      `Budget "${policyName}" exhausted${bucket ? ` for ${bucket}` : ''}: `
      + `${Math.round(status.spent)}/${status.limit} ${status.metric} in window. `
      + 'New turns are blocked until the window rolls over or the policy is raised.',
    );
    this.name = 'BudgetExceededError';
  }
}

/** Thrown when caller tags conflict with the conversation's immutable tags. */
export class TagConflictError extends Error {
  readonly statusCode = 400;
  readonly code = 'tag_conflict';

  constructor(conversationId: string, key: string, existing: string, requested: string) {
    super(
      `Tags are fixed at conversation creation: conversation ${conversationId} has ${key}="${existing}" `
      + `but the request specified ${key}="${requested}". Start a new conversation to change attribution.`,
    );
    this.name = 'TagConflictError';
  }
}

/**
 * Thrown when a run's groupBy tag value is not pre-provisioned in the agent
 * definition (metadata.budgetDimensions, 2026-07-15 decision).
 */
export class TagNotProvisionedError extends Error {
  readonly statusCode = 400;
  readonly code = 'tag_not_provisioned';

  constructor(key: string, value: string, agentId: string) {
    super(
      `Tag ${key}="${value}" is not provisioned for agent ${agentId}. `
      + `Add it to the agent's metadata.budgetDimensions.${key} list to budget for it.`,
    );
    this.name = 'TagNotProvisionedError';
  }
}

/** Pre-provisioned bucket values per tag key, from agent metadata.budgetDimensions. */
export function readBudgetDimensions(metadata: Record<string, unknown> | null | undefined): Record<string, string[]> {
  const raw = metadata?.budgetDimensions;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const dimensions: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      dimensions[key] = value;
    }
  }
  return dimensions;
}

/** Default attribution tags from agent metadata.defaultTags. */
export function readDefaultTags(metadata: Record<string, unknown> | null | undefined): Record<string, string> {
  const raw = metadata?.defaultTags;
  return isStringMap(raw) ? raw : {};
}
