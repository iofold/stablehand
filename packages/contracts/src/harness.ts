import { z } from 'zod';

export const CTXMILL_HARNESS_NAMES = [
  'claude-agents',
  'langgraph',
  'pi-agent',
] as const;

export const CtxmillHarnessNameSchema = z.enum(CTXMILL_HARNESS_NAMES);
export const CtxmillLlmProviderSchema = z.enum(['openai', 'anthropic', 'google']);

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
  provider: CtxmillLlmProviderSchema.optional(),
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

export const HARNESS_CONFIG_SCHEMAS = {
  'claude-agents': ClaudeAgentsConfigSchema,
  langgraph: LangGraphConfigSchema,
  'pi-agent': PIAgentConfigSchema,
} as const satisfies Readonly<Record<CtxmillHarnessName, z.ZodType>>;

export type HarnessConfigSchemas = Readonly<Record<string, z.ZodType>>;
