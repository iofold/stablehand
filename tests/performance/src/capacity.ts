import { z } from 'zod';

import {
  parsePerformanceProfile,
  type PerformanceProfile,
} from './profile.js';
import type { KubernetesResourceSummary } from './kubernetes.js';
import {
  summarizeTurnSamples,
  type TurnSample,
} from './stats.js';

const CapacityGateSchema = z.strictObject({
  maxErrorRate: z.number().min(0).max(1).default(0.02),
  maxTimeToFirstTokenP95Ms: z.number().int().positive().default(30_000),
  maxCompletionP95Ms: z.number().int().positive().default(90_000),
  maxNodeCpuPercent: z.number().positive().max(100).default(75),
  maxNodeMemoryPercent: z.number().positive().max(100).default(75),
  minTraceTurnCoverage: z.number().min(0).max(1).default(0.95),
}).default({
  maxErrorRate: 0.02,
  maxTimeToFirstTokenP95Ms: 30_000,
  maxCompletionP95Ms: 90_000,
  maxNodeCpuPercent: 75,
  maxNodeMemoryPercent: 75,
  minTraceTurnCoverage: 0.95,
});

const CapacityHarnessSchema = z.strictObject({
  name: z.string().trim().min(1),
  harness: z.enum(['langgraph', 'pi-agent']),
  agentPrefix: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().default(180_000),
  harnessConfig: z.record(z.string(), z.unknown()),
});

const CapacityRampSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1),
  target: z.strictObject({
    apiBase: z.url(),
    kubernetesNamespace: z.string().trim().min(1).default('ctxmill'),
  }),
  levels: z.array(z.number().int().positive().max(100)).min(1),
  maxGlobalContainers: z.number().int().positive().max(100),
  discoveryRuns: z.number().int().positive().default(1),
  confirmationRuns: z.number().int().min(3).default(3),
  sseClientsPerAgent: z.number().int().positive().default(2),
  settleMs: z.number().int().nonnegative().default(5_000),
  pendingPodGraceSeconds: z.number().int().positive().default(30),
  prompt: z.string().trim().min(1),
  gates: CapacityGateSchema,
  harnesses: z.array(CapacityHarnessSchema).min(1),
});

export type CapacityRamp = z.infer<typeof CapacityRampSchema>;
export type CapacityGates = z.infer<typeof CapacityGateSchema>;

export interface CapacityWaveObservation {
  errorRate: number;
  sseFanoutMismatches: number;
  timeToFirstTokenP95Ms: number | null;
  completionP95Ms: number | null;
  traceTurnCoverage: number;
  peakNodeCpuPercent: number;
  peakNodeMemoryPercent: number;
  peakPendingSandboxPods: number;
  activeSandboxJobsAfterSettle: number;
  podRestartDelta: number;
  oomKilledContainers: number;
  criticalLogMatches: number;
  criticalEventMatches: number;
  gatewayState: string;
  gatewayPendingCalls: number;
  gatewayUnpricedCalls: number;
  gatewayQuarantinedTransactions: number;
  gatewayOrphanTransactions: number;
}

export interface CapacityWaveDecision {
  decision: 'advance' | 'stop';
  violations: string[];
}

export function parseCapacityRamp(value: unknown): CapacityRamp {
  const ramp = CapacityRampSchema.parse(value);
  for (let index = 0; index < ramp.levels.length; index++) {
    const level = ramp.levels[index]!;
    if (index > 0 && level <= ramp.levels[index - 1]!) {
      throw new Error('Capacity ramp levels must be strictly increasing');
    }
    if (level > ramp.maxGlobalContainers) {
      throw new Error(
        `Capacity level ${level} exceeds maxGlobalContainers ${ramp.maxGlobalContainers}`,
      );
    }
  }
  return ramp;
}

export function buildCapacityWaveProfile(
  ramp: CapacityRamp,
  concurrency: number,
  runOrdinal: number,
): PerformanceProfile {
  if (!ramp.levels.includes(concurrency)) {
    throw new Error(`Concurrency ${concurrency} is not present in ramp ${ramp.name}`);
  }
  const stages = ramp.harnesses.map((template) => ({
    name: `${template.name}-c${concurrency}-r${runOrdinal}`,
    harness: template.harness,
    agentPrefix: template.agentPrefix,
    topology: 'unique-agents' as const,
    sessionMode: 'cold' as const,
    concurrency,
    iterations: 1,
    sseClientsPerAgent: ramp.sseClientsPerAgent,
    prompt: ramp.prompt,
    timeoutMs: template.timeoutMs,
    settleMs: ramp.settleMs,
    harnessConfig: template.harnessConfig,
  }));
  const turns = stages.length * concurrency;
  return parsePerformanceProfile({
    schemaVersion: 1,
    name: `${ramp.name}-c${concurrency}-r${runOrdinal}`,
    target: ramp.target,
    requirements: {
      modelGateway: 'required',
      minGlobalContainers: concurrency,
    },
    safety: {
      maxConcurrency: concurrency,
      maxTurns: turns,
      maxEstimatedModelCalls: turns,
      abortErrorRate: ramp.gates.maxErrorRate,
      maxNodeCpuPercent: ramp.gates.maxNodeCpuPercent,
      maxNodeMemoryPercent: ramp.gates.maxNodeMemoryPercent,
    },
    stages,
  });
}

export function evaluateCapacityWave(
  observation: CapacityWaveObservation,
  gates: CapacityGates,
): CapacityWaveDecision {
  const violations: string[] = [];
  if (observation.errorRate > gates.maxErrorRate) {
    violations.push(
      `turn error rate ${observation.errorRate} exceeds ${gates.maxErrorRate}`,
    );
  }
  if (observation.sseFanoutMismatches > 0) {
    violations.push(`SSE fanout mismatches: ${observation.sseFanoutMismatches}`);
  }
  if (
    observation.timeToFirstTokenP95Ms === null
    || observation.timeToFirstTokenP95Ms > gates.maxTimeToFirstTokenP95Ms
  ) {
    violations.push(
      `TTFT p95 ${observation.timeToFirstTokenP95Ms ?? 'missing'} exceeds `
      + `${gates.maxTimeToFirstTokenP95Ms} ms`,
    );
  }
  if (
    observation.completionP95Ms === null
    || observation.completionP95Ms > gates.maxCompletionP95Ms
  ) {
    violations.push(
      `completion p95 ${observation.completionP95Ms ?? 'missing'} exceeds `
      + `${gates.maxCompletionP95Ms} ms`,
    );
  }
  if (observation.traceTurnCoverage < gates.minTraceTurnCoverage) {
    violations.push(
      `trace coverage ${observation.traceTurnCoverage} is below `
      + gates.minTraceTurnCoverage,
    );
  }
  if (observation.peakNodeCpuPercent > gates.maxNodeCpuPercent) {
    violations.push(
      `node CPU ${observation.peakNodeCpuPercent}% exceeds ${gates.maxNodeCpuPercent}%`,
    );
  }
  if (observation.peakNodeMemoryPercent > gates.maxNodeMemoryPercent) {
    violations.push(
      `node memory ${observation.peakNodeMemoryPercent}% exceeds `
      + `${gates.maxNodeMemoryPercent}%`,
    );
  }
  if (observation.peakPendingSandboxPods > 0) {
    violations.push(
      `Pending sandbox pods observed after grace: ${observation.peakPendingSandboxPods}`,
    );
  }
  if (observation.activeSandboxJobsAfterSettle > 0) {
    violations.push(
      `active sandbox jobs remain after settle: ${observation.activeSandboxJobsAfterSettle}`,
    );
  }
  if (observation.podRestartDelta > 0) {
    violations.push(`pod restart delta: ${observation.podRestartDelta}`);
  }
  if (observation.oomKilledContainers > 0) {
    violations.push(`OOM-killed containers: ${observation.oomKilledContainers}`);
  }
  if (observation.criticalLogMatches > 0) {
    violations.push(`critical log matches: ${observation.criticalLogMatches}`);
  }
  if (observation.criticalEventMatches > 0) {
    violations.push(
      `critical Kubernetes event matches: ${observation.criticalEventMatches}`,
    );
  }
  if (observation.gatewayState !== 'healthy') {
    violations.push(`gateway state is ${observation.gatewayState}`);
  }
  if (observation.gatewayPendingCalls > 0) {
    violations.push(`pending gateway calls: ${observation.gatewayPendingCalls}`);
  }
  if (observation.gatewayUnpricedCalls > 0) {
    violations.push(`unpriced gateway calls: ${observation.gatewayUnpricedCalls}`);
  }
  if (observation.gatewayQuarantinedTransactions > 0) {
    violations.push(
      `quarantined gateway transactions: ${observation.gatewayQuarantinedTransactions}`,
    );
  }
  if (observation.gatewayOrphanTransactions > 0) {
    violations.push(
      `orphan gateway transactions: ${observation.gatewayOrphanTransactions}`,
    );
  }
  return {
    decision: violations.length === 0 ? 'advance' : 'stop',
    violations,
  };
}

interface KubernetesList {
  items?: Array<Record<string, unknown>>;
}

interface CapacityTrace {
  turn_id?: string;
  name?: string;
}

interface CapacityGatewayEvidence {
  state?: string;
  pendingCalls?: number;
  unpricedCalls?: number;
  quarantinedTransactions?: number;
  orphanTransactions?: number;
}

export interface CapacityEvidenceInput {
  turns: TurnSample[];
  kubernetes: KubernetesResourceSummary;
  traces: CapacityTrace[];
  beforePods: KubernetesList;
  afterPods: KubernetesList;
  afterJobs: KubernetesList;
  beforeEvents?: KubernetesList;
  events: KubernetesList;
  logs: string;
  gateway: CapacityGatewayEvidence;
}

function statusRecords(item: Record<string, unknown>): Array<Record<string, unknown>> {
  const status = item['status'];
  if (!status || typeof status !== 'object') return [];
  const typed = status as Record<string, unknown>;
  return [typed['containerStatuses'], typed['initContainerStatuses']]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((value): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null);
}

function restartCount(pods: KubernetesList): number {
  return (pods.items ?? []).reduce(
    (total, item) => total + statusRecords(item).reduce(
      (subtotal, status) => subtotal
        + (typeof status['restartCount'] === 'number' ? status['restartCount'] : 0),
      0,
    ),
    0,
  );
}

function terminationReason(
  status: Record<string, unknown>,
  stateName: 'state' | 'lastState',
): string | undefined {
  const state = status[stateName];
  if (!state || typeof state !== 'object') return undefined;
  const terminated = (state as Record<string, unknown>)['terminated'];
  if (!terminated || typeof terminated !== 'object') return undefined;
  const reason = (terminated as Record<string, unknown>)['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

function countOomKilled(pods: KubernetesList): number {
  return (pods.items ?? []).reduce(
    (total, item) => total + statusRecords(item).filter((status) =>
      terminationReason(status, 'state') === 'OOMKilled'
      || terminationReason(status, 'lastState') === 'OOMKilled').length,
    0,
  );
}

function activeSandboxJobs(jobs: KubernetesList): number {
  return (jobs.items ?? []).filter((item) => {
    const metadata = item['metadata'];
    const status = item['status'];
    if (!metadata || typeof metadata !== 'object') return false;
    if (!status || typeof status !== 'object') return false;
    const labels = (metadata as Record<string, unknown>)['labels'];
    return Boolean(
      labels
      && typeof labels === 'object'
      && (labels as Record<string, unknown>)['ctxmill.sandbox-session-id'],
    ) && Number((status as Record<string, unknown>)['active'] ?? 0) > 0;
  }).length;
}

const CRITICAL_EVENT_REASONS: ReadonlySet<string> = new Set([
  'BackOff',
  'Evicted',
  'Failed',
  'FailedScheduling',
  'OOMKilling',
]);

function resourceUid(resource: Record<string, unknown>): string | undefined {
  const metadata = resource['metadata'];
  if (!metadata || typeof metadata !== 'object') return undefined;
  const uid = (metadata as Record<string, unknown>)['uid'];
  return typeof uid === 'string' ? uid : undefined;
}

function criticalEventCount(
  before: KubernetesList | undefined,
  after: KubernetesList,
): number {
  const existing = new Set(
    (before?.items ?? []).map(resourceUid).filter((uid): uid is string => Boolean(uid)),
  );
  return (after.items ?? []).filter((event) =>
    !existing.has(resourceUid(event) ?? '')
    && typeof event['reason'] === 'string'
    && CRITICAL_EVENT_REASONS.has(event['reason'])).length;
}

function criticalLogCount(logs: string): number {
  const pattern = /\b(?:fatal|panic|oomkilled|out of memory|unhandled rejection|crashloopbackoff)\b/i;
  return logs.split('\n').filter((line) => pattern.test(line)).length;
}

function traceCoverage(
  turns: readonly TurnSample[],
  traces: readonly CapacityTrace[],
): number {
  if (turns.length === 0) return 0;
  const spans = new Map<string, Set<string>>();
  for (const trace of traces) {
    if (!trace.turn_id || !trace.name) continue;
    const names = spans.get(trace.turn_id) ?? new Set<string>();
    names.add(trace.name);
    spans.set(trace.turn_id, names);
  }
  const covered = turns.filter((turn) => {
    const names = spans.get(turn.turnId);
    return names?.has('ctxmill.turn.execute')
      && names.has('ctxmill.turn.delivery');
  }).length;
  return covered / turns.length;
}

export function summarizeCapacityEvidence(
  input: CapacityEvidenceInput,
): CapacityWaveObservation {
  const turns = summarizeTurnSamples(input.turns);
  return {
    errorRate: turns.errorRate,
    sseFanoutMismatches: turns.sseFanoutMismatches,
    timeToFirstTokenP95Ms: turns.timings.timeToFirstTokenMs?.p95 ?? null,
    completionP95Ms: turns.timings.completionMs?.p95 ?? null,
    traceTurnCoverage: traceCoverage(input.turns, input.traces),
    peakNodeCpuPercent: input.kubernetes.peakNodeCpuPercent,
    peakNodeMemoryPercent: input.kubernetes.peakNodeMemoryPercent,
    peakPendingSandboxPods:
      input.kubernetes.peakPendingSandboxPodsAfterGrace,
    activeSandboxJobsAfterSettle: activeSandboxJobs(input.afterJobs),
    podRestartDelta: Math.max(
      0,
      restartCount(input.afterPods) - restartCount(input.beforePods),
    ),
    oomKilledContainers: countOomKilled(input.afterPods),
    criticalLogMatches: criticalLogCount(input.logs),
    criticalEventMatches: criticalEventCount(input.beforeEvents, input.events),
    gatewayState: input.gateway.state ?? 'unavailable',
    gatewayPendingCalls: input.gateway.pendingCalls ?? 0,
    gatewayUnpricedCalls: input.gateway.unpricedCalls ?? 0,
    gatewayQuarantinedTransactions:
      input.gateway.quarantinedTransactions ?? 0,
    gatewayOrphanTransactions: input.gateway.orphanTransactions ?? 0,
  };
}
