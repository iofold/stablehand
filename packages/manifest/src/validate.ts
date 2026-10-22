import {
  AgentResourceLimitsSchema,
  BuiltinToolPolicySchema,
  ClaudeAgentsConfigSchema,
  LangGraphConfigSchema,
  McpServerListSchema,
  NativeToolPolicySchema,
  PIAgentConfigSchema,
} from '@stablehand/contracts';
import { z } from 'zod';

import type { AgentManifest } from './types.js';

function containsControlOrBackslash(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character === '\\' || codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isCanonicalRelativePath(value: string): boolean {
  if (
    value.length === 0
    || value === '.'
    || value.startsWith('/')
    || containsControlOrBackslash(value)
  ) {
    return false;
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }

  return true;
}

const canonicalRelativePathSchema = z.string().refine(
  isCanonicalRelativePath,
  'Expected a canonical workspace-relative POSIX path',
);

const nonEmptyNameSchema = z.string().trim().min(1);

const manifestMCPToolSchema = z.strictObject({
  name: nonEmptyNameSchema,
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).optional(),
  url: z.url().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const manifestInlineToolSchema = z.strictObject({
  name: nonEmptyNameSchema,
  description: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
});

const manifestToolRefSchema = z.union([
  z.strictObject({ ref: nonEmptyNameSchema }),
  z.strictObject({ mcp: manifestMCPToolSchema }),
  z.strictObject({ inline: manifestInlineToolSchema }),
]);

const manifestTriggerSchema = z.strictObject({
  event: z.string().trim().min(1).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  input: z.record(z.string(), z.string()).optional(),
});

const manifestEmitSchema = z.strictObject({
  event: z.string().trim().min(1),
  schema: z.record(z.string(), z.unknown()).optional(),
});

const manifestApprovalSchema = z.strictObject({
  tool: nonEmptyNameSchema,
  when: z.record(z.string(), z.unknown()).optional(),
  timeout: z.number().positive().optional(),
  fallback: z.enum(['approve', 'reject']).optional(),
});

const manifestHITLSchema = z.strictObject({
  approvals: z.array(manifestApprovalSchema).optional(),
});

const manifestFileCopySchema = z.strictObject({
  src: canonicalRelativePathSchema,
  dest: canonicalRelativePathSchema,
});

const manifestWorkspaceContentSchema = z.strictObject({
  files: z.array(manifestFileCopySchema).optional(),
});

const manifestWorkspaceSchema = z.strictObject({
  content: manifestWorkspaceContentSchema.optional(),
});

const manifestResourcesSchema = z.strictObject({
  sandbox: AgentResourceLimitsSchema.optional(),
});

const manifestMetadataSchema = z.strictObject({
  name: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

const manifestSpecCommon = {
  instructions: z.string().min(1),
  tools: z.array(manifestToolRefSchema).optional(),
  mcpServers: McpServerListSchema.optional(),
  builtinToolPolicy: BuiltinToolPolicySchema.optional(),
  nativeToolPolicy: NativeToolPolicySchema.optional(),
  triggers: z.array(manifestTriggerSchema).optional(),
  emits: z.array(manifestEmitSchema).optional(),
  hitl: manifestHITLSchema.optional(),
  workspace: manifestWorkspaceSchema.optional(),
  resources: manifestResourcesSchema.optional(),
  mode: z.enum(['interactive', 'background', 'both']).optional(),
} as const;

const langGraphManifestSchema = z.strictObject({
  apiVersion: z.literal('stablehand.io/v1'),
  kind: z.literal('Agent'),
  metadata: manifestMetadataSchema,
  spec: z.strictObject({
    harness: z.literal('langgraph'),
    harnessConfig: LangGraphConfigSchema,
    ...manifestSpecCommon,
  }),
});

const claudeAgentsManifestSchema = z.strictObject({
  apiVersion: z.literal('stablehand.io/v1'),
  kind: z.literal('Agent'),
  metadata: manifestMetadataSchema,
  spec: z.strictObject({
    harness: z.literal('claude-agents'),
    harnessConfig: ClaudeAgentsConfigSchema,
    ...manifestSpecCommon,
  }),
});

const piAgentManifestSchema = z.strictObject({
  apiVersion: z.literal('stablehand.io/v1'),
  kind: z.literal('Agent'),
  metadata: manifestMetadataSchema,
  spec: z.strictObject({
    harness: z.literal('pi-agent'),
    harnessConfig: PIAgentConfigSchema,
    ...manifestSpecCommon,
  }),
});

export const agentManifestSchema = z.union([
  langGraphManifestSchema,
  claudeAgentsManifestSchema,
  piAgentManifestSchema,
]);

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
