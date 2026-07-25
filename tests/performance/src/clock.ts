import { percentile } from './stats.js';

export interface ClockProbe {
  sentAtMs: number;
  receivedAtMs: number;
  serverAtMs: number;
}

export interface ClockOffsetEstimate {
  /** Add this value to the load-generator clock to estimate server time. */
  offsetMs: number;
  /** Median half-round-trip uncertainty in milliseconds. */
  uncertaintyMs: number;
  samples: number;
}

export function estimateClockOffset(
  probes: readonly ClockProbe[],
): ClockOffsetEstimate {
  if (probes.length === 0) {
    throw new Error('At least one clock probe is required');
  }

  const offsets = probes.map((probe) =>
    probe.serverAtMs - (probe.sentAtMs + probe.receivedAtMs) / 2,
  );
  const uncertainties = probes.map((probe) =>
    Math.max(0, probe.receivedAtMs - probe.sentAtMs) / 2,
  );

  return {
    offsetMs: percentile(offsets, 0.5)!,
    uncertaintyMs: percentile(uncertainties, 0.5)!,
    samples: probes.length,
  };
}
