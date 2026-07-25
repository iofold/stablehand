import { z } from 'zod';

const SafetySchema = z.strictObject({
  maxConcurrency: z.number().int().positive().default(5),
  abortErrorRate: z.number().min(0).max(1).default(0.05),
  maxNodeCpuPercent: z.number().positive().max(100).default(85),
  maxNodeMemoryPercent: z.number().positive().max(100).default(85),
}).default({
  maxConcurrency: 5,
  abortErrorRate: 0.05,
  maxNodeCpuPercent: 85,
  maxNodeMemoryPercent: 85,
});

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
  timeoutMs: z.number().int().positive().default(120_000),
  settleMs: z.number().int().nonnegative().default(2_000),
});

const PerformanceProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1),
  target: z.strictObject({
    apiBase: z.url(),
    kubernetesNamespace: z.string().trim().min(1).default('ctxmill'),
  }),
  safety: SafetySchema,
  stages: z.array(StageSchema).min(1),
});

export type PerformanceProfile = z.infer<typeof PerformanceProfileSchema>;
export type PerformanceStage = z.infer<typeof StageSchema>;

export function parsePerformanceProfile(value: unknown): PerformanceProfile {
  const profile = PerformanceProfileSchema.parse(value);
  for (const stage of profile.stages) {
    if (stage.concurrency > profile.safety.maxConcurrency) {
      throw new Error(
        `Stage "${stage.name}" concurrency ${stage.concurrency} exceeds `
        + `safety.maxConcurrency ${profile.safety.maxConcurrency}`,
      );
    }
  }
  return profile;
}
