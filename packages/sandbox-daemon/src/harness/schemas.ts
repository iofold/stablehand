import { z } from 'zod';
import { CanonicalProviderSchema } from './shared.js';

export const LangGraphConfigSchema = z.object({
  provider: CanonicalProviderSchema.default('openai'),
  model: z.string().min(1),
  apiKeyRef: z.string().optional(),
  baseUrl: z.string().refine((value) => URL.canParse(value)).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  reasoning: z.enum(['off', 'low', 'medium', 'high']).optional(),
  setup: z.object({
    symlinks: z.array(z.object({ src: z.string(), dest: z.string() })).optional(),
  }).optional(),
  subagents: z.array(z.object({
    name: z.string(),
    description: z.string(),
    systemPrompt: z.string(),
    provider: CanonicalProviderSchema.optional(),
    model: z.string().min(1).optional(),
    apiKeyRef: z.string().optional(),
    tools: z.array(z.string()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  })).optional(),
  middleware: z.array(z.string()).optional(),
});

export type LangGraphConfig = z.infer<typeof LangGraphConfigSchema>;

const ClaudeAgentDefinitionSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
});

export const ClaudeAgentsConfigSchema = z.object({
  provider: CanonicalProviderSchema.optional(),
  model: z.string().min(1),
  apiKeyRef: z.string().optional(),
  baseUrl: z.string().refine((value) => URL.canParse(value)).optional(),
  maxTurns: z.number().int().positive().optional(),
  setup: z.object({
    symlinks: z.array(z.object({ src: z.string(), dest: z.string() })).optional(),
  }).optional(),
  subagents: z.record(z.string(), ClaudeAgentDefinitionSchema).optional(),
  nativeTools: z.object({
    allowlist: z.array(z.string()).optional(),
    blocklist: z.array(z.string()).optional(),
  }).optional(),
});

export type ClaudeAgentsConfig = z.infer<typeof ClaudeAgentsConfigSchema>;

export const PIAgentConfigSchema = z.object({
  provider: CanonicalProviderSchema.default('openai'),
  model: z.string().min(1),
  apiKeyRef: z.string().optional(),
  baseUrl: z.string().refine((value) => URL.canParse(value)).optional(),
  extensions: z.array(z.string()).optional(),
});

export type PIAgentConfig = z.infer<typeof PIAgentConfigSchema>;

export const HARNESS_CONFIG_SCHEMAS = {
  'claude-agents': ClaudeAgentsConfigSchema,
  langgraph: LangGraphConfigSchema,
  'pi-agent': PIAgentConfigSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;

export type HarnessConfigSchemas = Readonly<Record<string, z.ZodType>>;
