import {
  BudgetExceededResponseSchema,
  type BudgetExceededResponse,
} from '@ctxmill/contracts';

import { ApiError } from './api';

export type BudgetBlock = BudgetExceededResponse;

/**
 * Recognize a turn-start rejection caused by a budget policy so the UI can
 * explain which policy blocked the run instead of showing a generic error.
 */
export function parseBudgetBlock(err: unknown): BudgetBlock | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const parsed = BudgetExceededResponseSchema.safeParse(err.body);
  return parsed.success ? parsed.data : null;
}

const METRIC_LABELS: Record<BudgetBlock['metric'], string> = {
  totalTokens: 'tokens',
  costUsd: 'spend',
  turns: 'runs',
};

export function formatBudgetMetricValue(
  metric: BudgetBlock['metric'],
  value: number,
): string {
  if (metric === 'costUsd') return `$${value.toFixed(2)}`;
  return value.toLocaleString();
}

export function describeBudgetBlock(block: BudgetBlock): {
  summary: string;
  detail: string;
} {
  const metricLabel = METRIC_LABELS[block.metric] ?? block.metric;
  const spent = formatBudgetMetricValue(block.metric, block.spent);
  const limit = formatBudgetMetricValue(block.metric, block.limit);
  const bucket = block.bucket.kind === 'tag'
    ? ` for ${block.bucket.key}=${block.bucket.value}`
    : block.bucket.kind === 'untagged'
      ? ` for runs without a ${block.bucket.key} tag`
      : '';
  return {
    summary: `Run blocked by the "${block.policyName}" budget`,
    detail: `${spent} of the ${limit} ${metricLabel} limit${bucket} is already used this window.`,
  };
}
