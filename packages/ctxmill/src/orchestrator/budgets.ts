/**
 * Declarative tag-based budget policies (docs/plans/proposals/
 * 2026-07-15-tag-based-budget-policies.md).
 *
 * A policy is a stored document: which runs count (tag selector), how they
 * bucket (groupBy tag), the accounting window (UTC for calendar windows),
 * the limits, and the threshold actions. Runs count against every matching
 * policy; admission is denied when ANY matching bucket is exhausted.
 */

export const BUDGET_WINDOWS = [
  'rolling-1h',
  'rolling-24h',
  'rolling-7d',
  'rolling-30d',
  'month-to-date',
] as const;
export type BudgetWindow = typeof BUDGET_WINDOWS[number];

export interface BudgetLimits {
  totalTokens?: number;
  costUsd?: number;
  turns?: number;
}

export interface BudgetAction {
  /** Fraction of the limit (0 < threshold <= 1). */
  threshold: number;
  action: 'warn' | 'block';
}

export interface BudgetPolicyDoc {
  /** Exact-match AND across keys; empty object matches every run. */
  selector: Record<string, string>;
  /** One bucket per distinct value of this tag, each with the full limits. */
  groupBy?: string;
  window: BudgetWindow;
  limits: BudgetLimits;
  actions: BudgetAction[];
}

export interface BudgetSpend {
  totalTokens: number;
  costUsd: number;
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
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { error: 'policy doc must be an object' };
  }
  const d = doc as Record<string, unknown>;

  if (!isStringMap(d.selector)) {
    return { error: 'selector must be a string→string map (use {} to match all runs)' };
  }
  if (d.groupBy !== undefined && (typeof d.groupBy !== 'string' || d.groupBy.length === 0)) {
    return { error: 'groupBy must be a non-empty tag key' };
  }
  if (typeof d.window !== 'string' || !BUDGET_WINDOWS.includes(d.window as BudgetWindow)) {
    return { error: `window must be one of: ${BUDGET_WINDOWS.join(', ')}` };
  }
  if (typeof d.limits !== 'object' || d.limits === null || Array.isArray(d.limits)) {
    return { error: 'limits must be an object' };
  }
  const limits = d.limits as Record<string, unknown>;
  const parsedLimits: BudgetLimits = {};
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return { error: `limits.${key} must be a positive number` };
    }
    parsedLimits[key] = value;
  }
  if (Object.keys(parsedLimits).length === 0) {
    return { error: `limits must set at least one of: ${LIMIT_KEYS.join(', ')}` };
  }
  if (!Array.isArray(d.actions) || d.actions.length === 0) {
    return { error: 'actions must be a non-empty array of { threshold, action }' };
  }
  const actions: BudgetAction[] = [];
  for (const entry of d.actions) {
    if (typeof entry !== 'object' || entry === null) {
      return { error: 'each action must be an object { threshold, action }' };
    }
    const a = entry as Record<string, unknown>;
    if (typeof a.threshold !== 'number' || !(a.threshold > 0) || a.threshold > 1) {
      return { error: 'action.threshold must be in (0, 1]' };
    }
    if (a.action !== 'warn' && a.action !== 'block') {
      return { error: 'action.action must be "warn" or "block"' };
    }
    actions.push({ threshold: a.threshold, action: a.action });
  }

  return {
    doc: {
      selector: d.selector,
      ...(d.groupBy !== undefined ? { groupBy: d.groupBy as string } : {}),
      window: d.window as BudgetWindow,
      limits: parsedLimits,
      actions,
    },
  };
}

export interface BudgetMetricStatus {
  metric: keyof BudgetLimits;
  spent: number;
  limit: number;
  /** spent / limit, uncapped. */
  ratio: number;
}

/** Per-metric status for a bucket's spend against a policy's limits. */
export function metricStatuses(limits: BudgetLimits, spend: BudgetSpend): BudgetMetricStatus[] {
  const spentByMetric: Record<keyof BudgetLimits, number> = {
    totalTokens: spend.totalTokens,
    costUsd: spend.costUsd,
    turns: spend.turns,
  };
  return LIMIT_KEYS.flatMap((metric) => {
    const limit = limits[metric];
    if (limit === undefined) return [];
    const spent = spentByMetric[metric];
    return [{ metric, spent, limit, ratio: spent / limit }];
  });
}

/**
 * The highest-threshold action tripped by this spend, if any. "Tripped" is
 * ratio >= threshold on any limited metric.
 */
export function trippedAction(
  doc: BudgetPolicyDoc,
  spend: BudgetSpend,
): { action: BudgetAction; status: BudgetMetricStatus } | undefined {
  const statuses = metricStatuses(doc.limits, spend);
  const sorted = [...doc.actions].sort((a, b) => b.threshold - a.threshold);
  for (const action of sorted) {
    const status = statuses.find((s) => s.ratio >= action.threshold);
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
    readonly status: BudgetMetricStatus,
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
