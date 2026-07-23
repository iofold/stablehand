import { z } from 'zod';

export const CTXMILL_HARNESS_NAMES = [
  'claude-agents',
  'langgraph',
  'pi-agent',
] as const;

export const CtxmillHarnessNameSchema = z.enum(CTXMILL_HARNESS_NAMES);
export const CtxmillLlmProviderSchema = z.enum(['openai', 'anthropic', 'google']);

const NativeToolNamesSchema = z.array(z.string().trim().min(1)).min(1).superRefine(
  (names, context) => {
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        message: 'names must not contain duplicate tool names',
      });
    }
  },
);

/**
 * One exact policy for harness-owned tools.
 *
 * `all` and `none` intentionally carry no names. `allow` and `deny` require a
 * non-empty, unique list. This avoids the absent-vs-empty ambiguity that
 * repeated protobuf fields introduced with independent allow/block lists.
 */
function createToolPolicySchema() {
  return z.discriminatedUnion('policy', [
    z.strictObject({ policy: z.literal('all') }),
    z.strictObject({ policy: z.literal('allow'), names: NativeToolNamesSchema }),
    z.strictObject({ policy: z.literal('deny'), names: NativeToolNamesSchema }),
    z.strictObject({ policy: z.literal('none') }),
  ]);
}

export const NativeToolPolicySchema = createToolPolicySchema();
export const BuiltinToolPolicySchema = createToolPolicySchema();

const UrlSchema = z.string().refine(
  (value) => URL.canParse(value),
  'Expected an absolute URL',
);

export const WorkspaceRelativePathSchema = z.string().min(1).refine((value) => {
  const hasControlOrBackslash = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return character === '\\'
      || codePoint === undefined
      || codePoint <= 0x1f
      || codePoint === 0x7f;
  });
  if (hasControlOrBackslash || value.startsWith('/')) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}, 'Expected a contained workspace-relative path without traversal or control characters');

const SymlinkSchema = z.strictObject({
  src: WorkspaceRelativePathSchema,
  dest: WorkspaceRelativePathSchema,
});

const HarnessSetupSchema = z.strictObject({
  symlinks: z.array(SymlinkSchema).optional(),
});

const LangGraphSubagentSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string(),
  provider: CtxmillLlmProviderSchema.optional(),
  model: z.string().min(1).optional(),
  apiKeyRef: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const LangGraphConfigSchema = z.strictObject({
  provider: CtxmillLlmProviderSchema.default('openai'),
  model: z.string().min(1),
  apiKeyRef: z.string().min(1).optional(),
  baseUrl: UrlSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  reasoning: z.enum(['off', 'low', 'medium', 'high']).optional(),
  setup: HarnessSetupSchema.optional(),
  subagents: z.array(LangGraphSubagentSchema).optional(),
  middleware: z.array(z.string().min(1)).optional(),
}).superRefine((config, context) => {
  if (config.reasoning !== undefined && config.provider !== 'openai') {
    context.addIssue({
      code: 'custom',
      path: ['reasoning'],
      message: 'reasoning is supported only by the OpenAI LangGraph provider',
    });
  }

  if (config.baseUrl && config.provider === 'google') {
    context.addIssue({
      code: 'custom',
      path: ['baseUrl'],
      message: 'baseUrl is not supported by the Google LangGraph provider',
    });
  }

  if (config.baseUrl) {
    config.subagents?.forEach((subagent, index) => {
      if (subagent.provider && subagent.provider !== config.provider) {
        context.addIssue({
          code: 'custom',
          path: ['subagents', index, 'provider'],
          message: 'subagent provider must match the parent provider when baseUrl is set',
        });
      }
    });
  }
});

const ClaudeAgentDefinitionSchema = z.strictObject({
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string().min(1)).optional(),
  disallowedTools: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
});

export const ClaudeAgentsConfigSchema = z.strictObject({
  provider: z.literal('anthropic').optional(),
  model: z.string().min(1),
  apiKeyRef: z.string().min(1).optional(),
  baseUrl: UrlSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  setup: HarnessSetupSchema.optional(),
  subagents: z.record(z.string().min(1), ClaudeAgentDefinitionSchema).optional(),
});

export const PIAgentConfigSchema = z.strictObject({
  provider: CtxmillLlmProviderSchema.default('openai'),
  model: z.string().min(1),
  apiKeyRef: z.string().min(1).optional(),
  baseUrl: UrlSchema.optional(),
  extensions: z.array(WorkspaceRelativePathSchema).optional(),
});

export type LangGraphConfig = z.infer<typeof LangGraphConfigSchema>;
export type ClaudeAgentsConfig = z.infer<typeof ClaudeAgentsConfigSchema>;
export type PIAgentConfig = z.infer<typeof PIAgentConfigSchema>;
export type CtxmillHarnessName = z.infer<typeof CtxmillHarnessNameSchema>;
export type NativeToolPolicy = z.infer<typeof NativeToolPolicySchema>;
export type BuiltinToolPolicy = z.infer<typeof BuiltinToolPolicySchema>;

export const HARNESS_CONFIG_SCHEMAS = {
  'claude-agents': ClaudeAgentsConfigSchema,
  langgraph: LangGraphConfigSchema,
  'pi-agent': PIAgentConfigSchema,
} as const satisfies Readonly<Record<CtxmillHarnessName, z.ZodType>>;

export type HarnessConfigSchemas = Readonly<Record<string, z.ZodType>>;
