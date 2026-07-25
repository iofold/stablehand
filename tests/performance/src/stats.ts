export interface TurnSample {
  turnId: string;
  agentId: string;
  harness: 'langgraph' | 'pi-agent' | 'claude-agents';
  outcome: 'completed' | 'error' | 'cancelled' | 'timeout';
  admissionMs?: number;
  timeToFirstEventMs?: number;
  timeToRunStartedMs?: number;
  timeToFirstTokenMs?: number;
  completionMs?: number;
  serverToClientFirstEventLagMs?: number;
  serverToClientTerminalLagMs?: number;
  eventCount: number;
  error?: string;
}

export interface DistributionSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface TurnSampleSummary {
  turns: number;
  completed: number;
  failed: number;
  errorRate: number;
  totalEvents: number;
  timings: Record<string, DistributionSummary>;
}

export function percentile(
  values: readonly number[],
  quantile: number,
): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error('quantile must be between 0 and 1');
  }
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function summarizeDistribution(
  values: readonly number[],
): DistributionSummary | undefined {
  if (values.length === 0) return undefined;
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    p50: percentile(values, 0.5)!,
    p95: percentile(values, 0.95)!,
    p99: percentile(values, 0.99)!,
  };
}

const TIMING_FIELDS = [
  'admissionMs',
  'timeToFirstEventMs',
  'timeToRunStartedMs',
  'timeToFirstTokenMs',
  'completionMs',
  'serverToClientFirstEventLagMs',
  'serverToClientTerminalLagMs',
] as const satisfies readonly (keyof TurnSample)[];

export function summarizeTurnSamples(
  samples: readonly TurnSample[],
): TurnSampleSummary {
  const timings: Record<string, DistributionSummary> = {};
  for (const field of TIMING_FIELDS) {
    const values = samples
      .map((sample) => sample[field])
      .filter((value): value is number => typeof value === 'number');
    const distribution = summarizeDistribution(values);
    if (distribution) timings[field] = distribution;
  }
  const completed = samples.filter((sample) => sample.outcome === 'completed').length;
  const failed = samples.length - completed;
  return {
    turns: samples.length,
    completed,
    failed,
    errorRate: samples.length === 0 ? 0 : failed / samples.length,
    totalEvents: samples.reduce((total, sample) => total + sample.eventCount, 0),
    timings,
  };
}
