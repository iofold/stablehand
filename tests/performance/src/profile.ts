import { z } from 'zod';
import {
  HARNESS_CONFIG_SCHEMAS,
  type ModelGatewayStatus,
} from '../../../packages/contracts/src/index.js';

const SafetySchema = z.strictObject({
  maxConcurrency: z.number().int().positive().default(5),
  maxTurns: z.number().int().positive().default(250),
  maxEstimatedModelCalls: z.number().int().positive().default(500),
  abortErrorRate: z.number().min(0).max(1).default(0.05),
  maxNodeCpuPercent: z.number().positive().max(100).default(85),
  maxNodeMemoryPercent: z.number().positive().max(100).default(85),
}).default({
  maxConcurrency: 5,
  maxTurns: 250,
  maxEstimatedModelCalls: 500,
  abortErrorRate: 0.05,
  maxNodeCpuPercent: 85,
  maxNodeMemoryPercent: 85,
});

const RequirementsSchema = z.strictObject({
  modelGateway: z.enum(['optional', 'required']).default('optional'),
  minGlobalContainers: z.number().int().positive().optional(),
}).default({ modelGateway: 'optional' });

const StageSchema = z.strictObject({
  name: z.string().trim().min(1),
  harness: z.enum(['langgraph', 'pi-agent', 'claude-agents']),
  agentPrefix: z.string().trim().min(1),
  topology: z.enum(['unique-agents', 'hot-agent']),
  sessionMode: z.enum(['cold', 'warm', 'resume']),
  concurrency: z.number().int().positive(),
  iterations: z.number().int().positive(),
  sseClientsPerAgent: z.number().int().positive().default(1),
  prompt: z.string().trim().min(1),
  warmupTurns: z.number().int().nonnegative().default(0),
  expectedModelCallsPerTurn: z.number().int().positive().default(1),
  timeoutMs: z.number().int().positive().default(120_000),
  settleMs: z.number().int().nonnegative().default(2_000),
  harnessConfig: z.record(z.string(), z.unknown()),
  /**
   * Consecutive stages sharing a parallelGroup run simultaneously instead of
   * sequentially — the only way to certify mixed simultaneous harness
   * traffic (ctx-31w1). Groups still run in profile order.
   */
  parallelGroup: z.string().trim().min(1).optional(),
  systemPrompt: z.string().trim().min(1).default(
    'You are a performance-test agent. Follow the user request directly and respond concisely.',
  ),
});

const PerformanceProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1),
  expectedOutput: z.string().trim().min(1).optional(),
  target: z.strictObject({
    apiBase: z.url(),
    kubernetesNamespace: z.string().trim().min(1).default('stablehand'),
  }),
  requirements: RequirementsSchema,
  safety: SafetySchema,
  stages: z.array(StageSchema).min(1),
});

export type PerformanceProfile = z.infer<typeof PerformanceProfileSchema>;
export type PerformanceStage = z.infer<typeof StageSchema>;

export interface PerformanceStagePlan {
  name: string;
  harness: PerformanceStage['harness'];
  modelRoutes: Array<{
    provider: string;
    model: string;
  }>;
  concurrency: number;
  measuredTurns: number;
  warmupTurns: number;
  totalTurns: number;
  estimatedModelCalls: number;
  sseConnections: number;
}

export interface PerformancePlan {
  stages: PerformanceStagePlan[];
  measuredTurns: number;
  warmupTurns: number;
  totalTurns: number;
  estimatedModelCalls: number;
  peakConcurrency: number;
  peakSseConnections: number;
}

function configuredModelRoutes(
  stage: PerformanceStage,
): PerformanceStagePlan['modelRoutes'] {
  const routes: PerformanceStagePlan['modelRoutes'] = [];
  const configuredProvider = stage.harnessConfig['provider'];
  const primaryProvider = typeof configuredProvider === 'string'
    ? configuredProvider
    : stage.harness === 'claude-agents'
      ? 'anthropic'
      : 'openai';
  const addRoute = (provider: string, model: string): void => {
    if (!routes.some((route) =>
      route.provider === provider && route.model === model)) {
      routes.push({ provider, model });
    }
  };
  const primary = stage.harnessConfig['model'];
  if (typeof primary === 'string' && primary.trim()) {
    addRoute(primaryProvider, primary);
  }
  const subagents = stage.harnessConfig['subagents'];
  if (Array.isArray(subagents)) {
    for (const subagent of subagents) {
      if (typeof subagent !== 'object' || subagent === null) continue;
      const model = (subagent as Record<string, unknown>)['model'];
      if (typeof model === 'string' && model.trim()) {
        const provider = (subagent as Record<string, unknown>)['provider'];
        addRoute(
          typeof provider === 'string' ? provider : primaryProvider,
          model,
        );
      }
    }
  }
  return routes;
}

export function summarizePerformancePlan(
  profile: PerformanceProfile,
): PerformancePlan {
  const stages = profile.stages.map((stage): PerformanceStagePlan => {
    const measuredTurns = stage.concurrency * stage.iterations;
    const warmupTurns = stage.concurrency * stage.warmupTurns;
    const totalTurns = measuredTurns + warmupTurns;
    return {
      name: stage.name,
      harness: stage.harness,
      modelRoutes: configuredModelRoutes(stage),
      concurrency: stage.concurrency,
      measuredTurns,
      warmupTurns,
      totalTurns,
      estimatedModelCalls: totalTurns * stage.expectedModelCallsPerTurn,
      sseConnections: (stage.topology === 'hot-agent' ? 1 : stage.concurrency)
        * stage.sseClientsPerAgent,
    };
  });
  return {
    stages,
    measuredTurns: stages.reduce((total, stage) => total + stage.measuredTurns, 0),
    warmupTurns: stages.reduce((total, stage) => total + stage.warmupTurns, 0),
    totalTurns: stages.reduce((total, stage) => total + stage.totalTurns, 0),
    estimatedModelCalls: stages.reduce(
      (total, stage) => total + stage.estimatedModelCalls,
      0,
    ),
    peakConcurrency: Math.max(...stages.map((stage) => stage.concurrency)),
    peakSseConnections: Math.max(...stages.map((stage) => stage.sseConnections)),
  };
}

export function assertModelGatewayRequirement(
  profile: PerformanceProfile,
  gateway: ModelGatewayStatus | null,
): void {
  if (
    profile.requirements.modelGateway === 'required'
    && (!gateway?.enabled || gateway.state !== 'healthy')
  ) {
    throw new Error(
      `Profile "${profile.name}" requires a healthy model gateway; `
      + `current state is ${gateway?.state ?? 'unavailable'}`,
    );
  }
}

export function parsePerformanceProfile(value: unknown): PerformanceProfile {
  const profile = PerformanceProfileSchema.parse(value);
  for (const stage of profile.stages) {
    const harnessConfig = HARNESS_CONFIG_SCHEMAS[stage.harness].safeParse(
      stage.harnessConfig,
    );
    if (!harnessConfig.success) {
      const detail = harnessConfig.error.issues.map((issue) =>
        `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
      throw new Error(
        `Invalid harnessConfig for stage "${stage.name}" (${stage.harness}): ${detail}`,
      );
    }
    if (stage.concurrency > profile.safety.maxConcurrency) {
      throw new Error(
        `Stage "${stage.name}" concurrency ${stage.concurrency} exceeds `
        + `safety.maxConcurrency ${profile.safety.maxConcurrency}`,
      );
    }
    if (stage.sessionMode !== 'cold' && stage.warmupTurns < 1) {
      throw new Error(
        `Stage "${stage.name}" uses ${stage.sessionMode} sessions and requires `
        + 'warmupTurns >= 1',
      );
    }
  }
  const plan = summarizePerformancePlan(profile);
  if (plan.totalTurns > profile.safety.maxTurns) {
    throw new Error(
      `Profile "${profile.name}" planned turns ${plan.totalTurns} exceeds `
      + `safety.maxTurns ${profile.safety.maxTurns}`,
    );
  }
  if (plan.estimatedModelCalls > profile.safety.maxEstimatedModelCalls) {
    throw new Error(
      `Profile "${profile.name}" estimated model calls ${plan.estimatedModelCalls} `
      + 'exceeds safety.maxEstimatedModelCalls '
      + profile.safety.maxEstimatedModelCalls,
    );
  }
  return profile;
}

/** Environment variable that retargets a profile or ramp at another API. */
export const PERFORMANCE_API_BASE_ENV = 'STABLEHAND_PERF_API_BASE';

/**
 * Checked-in profiles target the local Docker stack. A remote deployment is
 * only load-tested when the operator names it in STABLEHAND_PERF_API_BASE,
 * which replaces `target.apiBase` on a parsed profile or capacity ramp.
 */
export function withApiBaseOverride<T extends { target: { apiBase: string } }>(
  value: T,
  override: string | undefined,
): T {
  const apiBase = override?.trim();
  if (!apiBase) return value;
  if (!z.url().safeParse(apiBase).success) {
    throw new Error(`${PERFORMANCE_API_BASE_ENV} must be an absolute URL, got "${apiBase}"`);
  }
  return { ...value, target: { ...value.target, apiBase } };
}
