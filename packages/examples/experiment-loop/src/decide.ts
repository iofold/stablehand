import type { Comparison } from './types.js';

const EPSILON = 1e-9;

export const mean = (values: readonly number[]): number => (
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
);

/** Mean of each task's scores across repeats. */
export function averageByTask(runs: ReadonlyArray<{ taskId: string; score: number }>): Map<string, number> {
  const grouped = new Map<string, number[]>();
  for (const run of runs) grouped.set(run.taskId, [...(grouped.get(run.taskId) ?? []), run.score]);
  return new Map([...grouped].map(([taskId, scores]) => [taskId, mean(scores)]));
}

/**
 * Run-to-run noise of one configuration: how far a task's score moves between
 * repeats, averaged over tasks. Zero when there is only one repeat.
 */
export function measureNoise(runs: ReadonlyArray<{ taskId: string; score: number }>): number {
  const grouped = new Map<string, number[]>();
  for (const run of runs) grouped.set(run.taskId, [...(grouped.get(run.taskId) ?? []), run.score]);
  const spreads = [...grouped.values()]
    .filter((scores) => scores.length > 1)
    .map((scores) => Math.max(...scores) - Math.min(...scores));
  return mean(spreads);
}

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;

/**
 * Paired comparison on the same tasks. A change is kept when its mean
 * per-task gain beats the noise margin and it wins more tasks than it loses.
 * This is a margin rule, not a significance test: five tasks are too few
 * for a test to say much, so the held-out check before promotion matters.
 */
export function decide(
  best: ReadonlyMap<string, number>,
  candidate: ReadonlyMap<string, number>,
  margin: number,
): { keep: boolean; reason: string; comparison: Comparison } {
  const diffs: number[] = [];
  for (const [taskId, score] of candidate) {
    const before = best.get(taskId);
    if (before !== undefined) diffs.push(score - before);
  }
  const wins = diffs.filter((d) => d > EPSILON).length;
  const losses = diffs.filter((d) => d < -EPSILON).length;
  const comparison: Comparison = {
    pairs: diffs.length,
    meanGain: mean(diffs),
    wins,
    losses,
    ties: diffs.length - wins - losses,
    margin,
  };
  const gain = signed(comparison.meanGain);
  const counts = `${wins} better, ${losses} worse, ${comparison.ties} unchanged`;
  if (diffs.length === 0) {
    return { keep: false, reason: 'discarded: no tasks to compare', comparison };
  }
  if (comparison.meanGain < -EPSILON) {
    return { keep: false, reason: `discarded: mean change ${gain} per task, worse than the best configuration (${counts})`, comparison };
  }
  if (comparison.meanGain <= margin + EPSILON) {
    return {
      keep: false,
      reason: `discarded: mean gain ${gain} per task is within the ${margin.toFixed(3)} noise margin (${counts})`,
      comparison,
    };
  }
  if (wins <= losses) {
    return { keep: false, reason: `discarded: mean gain ${gain} but as many tasks got worse as better (${counts})`, comparison };
  }
  return {
    keep: true,
    reason: `kept: mean gain ${gain} per task over ${diffs.length} paired tasks beats the ${margin.toFixed(3)} noise margin (${counts})`,
    comparison,
  };
}
