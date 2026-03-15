import { z } from 'zod';
import type { AgentManifest } from './types.js';

const manifestMCPToolSchema = z.object({
  name: z.string().min(1),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
});

const manifestInlineToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  input: z.record(z.unknown()),
});

const manifestToolRefSchema = z.union([
  z.object({ ref: z.string().min(1) }),
  z.object({ mcp: manifestMCPToolSchema }),
  z.object({ inline: manifestInlineToolSchema }),
]);

const manifestScheduleSchema = z.object({
  cron: z.string().min(1),
  description: z.string().optional(),
});

const manifestTriggerSchema = z.object({
  event: z.string().optional(),
  filter: z.record(z.unknown()).optional(),
  input: z.record(z.string()).optional(),
  schedule: manifestScheduleSchema.optional(),
});

const manifestEmitSchema = z.object({
  event: z.string().min(1),
  schema: z.record(z.unknown()).optional(),
});

const manifestApprovalSchema = z.object({
  tool: z.string().min(1),
  when: z.record(z.unknown()).optional(),
  timeout: z.number().positive().optional(),
  fallback: z.enum(['approve', 'reject']).optional(),
});

const manifestHITLSchema = z.object({
  approvals: z.array(manifestApprovalSchema).optional(),
});

const manifestWorkspaceSchema = z.object({
  snapshotRef: z.string().optional(),
  maxSizeBytes: z.number().positive().optional(),
  readOnlyPaths: z.array(z.string()).optional(),
  writablePaths: z.array(z.string()).optional(),
});

const manifestResourcesSchema = z.object({
  maxRunDurationSeconds: z.number().positive().optional(),
  maxTokensPerRun: z.number().positive().optional(),
  maxToolCallsPerRun: z.number().positive().optional(),
  costLimitPerDay: z.number().positive().optional(),
});

const manifestModelConfigSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  apiKeyRef: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  reasoning: z.enum(['off', 'low', 'medium', 'high']).optional(),
  baseUrl: z.string().url().optional(),
});

const manifestSpecSchema = z.object({
  harness: z.string().min(1),
  model: manifestModelConfigSchema,
  instructions: z.string().min(1),
  tools: z.array(manifestToolRefSchema).optional(),
  triggers: z.array(manifestTriggerSchema).optional(),
  emits: z.array(manifestEmitSchema).optional(),
  hitl: manifestHITLSchema.optional(),
  workspace: manifestWorkspaceSchema.optional(),
  resources: manifestResourcesSchema.optional(),
  mode: z.enum(['interactive', 'background', 'both']).optional(),
});

const manifestMetadataSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().optional(),
  description: z.string().optional(),
  labels: z.record(z.string()).optional(),
});

export const agentManifestSchema = z.object({
  apiVersion: z.literal('ctxmill.io/v1'),
  kind: z.literal('Agent'),
  metadata: manifestMetadataSchema,
  spec: manifestSpecSchema,
});

export function validateManifest(data: unknown): AgentManifest {
  return agentManifestSchema.parse(data) as AgentManifest;
}

export function safeValidateManifest(
  data: unknown,
): { success: true; data: AgentManifest } | { success: false; errors: z.ZodError } {
  const result = agentManifestSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as AgentManifest };
  }
  return { success: false, errors: result.error };
}
