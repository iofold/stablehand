export interface TurnSample {
  runId?: string;
  stageName?: string;
  turnId: string;
  agentId: string;
  conversationId?: string;
  sandboxSessionId?: string;
  harness: 'langgraph' | 'pi-agent' | 'claude-agents';
  iteration?: number;
  lane?: number;
  outcome: 'completed' | 'error' | 'cancelled' | 'timeout';
  admissionMs?: number;
  timeToFirstEventMs?: number;
  timeToRunStartedMs?: number;
  timeToFirstTokenMs?: number;
  completionMs?: number;
  suspendMs?: number;
  restoreMs?: number;
  serverToClientFirstEventLagMs?: number;
  serverToClientTerminalLagMs?: number;
  eventCount: number;
  sseClientEventCounts?: number[];
  sseClientEventSequences?: string[][];
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelCallsObserved?: number;
  modelCallsCostKnown?: number;
  modelCallsExpected?: number | null;
  knownCostUsd?: number;
  totalCostUsd?: number;
  costCoverage?: 'pending' | 'complete' | 'partial' | 'unpriced';
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
  totalSseDeliveries: number;
  sseFanoutMismatches: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    knownCostUsd: number;
    totalCostUsd: number;
    pricedTurns: number;
    pendingTurns: number;
    partialTurns: number;
    unpricedTurns: number;
    modelCallsObserved: number;
    modelCallsCostKnown: number;
    modelCallsExpected: number;
  };
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
  'suspendMs',
  'restoreMs',
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
    totalSseDeliveries: samples.reduce(
      (total, sample) => total
        + (sample.sseClientEventCounts?.reduce(
          (subtotal, count) => subtotal + count,
          0,
        ) ?? sample.eventCount),
      0,
    ),
    sseFanoutMismatches: samples.filter((sample) => {
      const counts = sample.sseClientEventCounts ?? [];
      const sequences = sample.sseClientEventSequences ?? [];
      return (
        counts.length > 1 && new Set(counts).size > 1
      ) || (
        sequences.length > 1
        && new Set(sequences.map((sequence) => JSON.stringify(sequence))).size > 1
      );
    }).length,
    usage: {
      inputTokens: samples.reduce((total, sample) => total + (sample.inputTokens ?? 0), 0),
      outputTokens: samples.reduce((total, sample) => total + (sample.outputTokens ?? 0), 0),
      totalTokens: samples.reduce((total, sample) => total + (sample.totalTokens ?? 0), 0),
      knownCostUsd: samples.reduce((total, sample) => total + (sample.knownCostUsd ?? 0), 0),
      totalCostUsd: samples.reduce((total, sample) => total + (sample.totalCostUsd ?? 0), 0),
      pricedTurns: samples.filter((sample) => sample.costCoverage === 'complete').length,
      pendingTurns: samples.filter((sample) => sample.costCoverage === 'pending').length,
      partialTurns: samples.filter((sample) => sample.costCoverage === 'partial').length,
      unpricedTurns: samples.filter((sample) => sample.costCoverage === 'unpriced').length,
      modelCallsObserved: samples.reduce(
        (total, sample) => total + (sample.modelCallsObserved ?? 0),
        0,
      ),
      modelCallsCostKnown: samples.reduce(
        (total, sample) => total + (sample.modelCallsCostKnown ?? 0),
        0,
      ),
      modelCallsExpected: samples.reduce(
        (total, sample) => total + (sample.modelCallsExpected ?? 0),
        0,
      ),
    },
    timings,
  };
}
