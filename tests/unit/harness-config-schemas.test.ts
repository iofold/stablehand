import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DefaultHarnessRegistry } from '../../packages/ctxmill/src/harness/registry.js';
import { LangGraphConfigSchema } from '../../packages/ctxmill/src/harness/langgraph.js';
import { ClaudeAgentsConfigSchema } from '../../packages/ctxmill/src/harness/claude-agents.js';
import { PIAgentConfigSchema } from '../../packages/ctxmill/src/harness/pi-agent.js';
import type { AgentHarness, HarnessSession } from '../../packages/ctxmill/src/harness/types.js';

function stubHarness(name: string, configSchema: z.ZodType): AgentHarness {
  return {
    name,
    configSchema,
    async openSession(): Promise<HarnessSession> {
      throw new Error('not implemented');
    },
  };
}

describe('harness config schemas', () => {
  describe('LangGraphConfigSchema', () => {
    it('parses a valid config with explicit provider', () => {
      expect(LangGraphConfigSchema.parse({ provider: 'openai', model: 'gpt-5-mini' })).toEqual({
        provider: 'openai',
        model: 'gpt-5-mini',
      });
    });

    it('defaults provider to openai', () => {
      expect(LangGraphConfigSchema.parse({ model: 'gpt-5-mini' })).toEqual({
        provider: 'openai',
        model: 'gpt-5-mini',
      });
    });

    it('requires model', () => {
      expect(() => LangGraphConfigSchema.parse({})).toThrow();
    });

    it('accepts subagents', () => {
      expect(LangGraphConfigSchema.parse({
        model: 'gpt-5-mini',
        subagents: [{ role: 'researcher', enabled: true }],
      })).toEqual({
        provider: 'openai',
        model: 'gpt-5-mini',
        subagents: [{ role: 'researcher', enabled: true }],
      });
    });

    it('rejects temperature above 2', () => {
      expect(() => LangGraphConfigSchema.parse({
        model: 'gpt-5-mini',
        temperature: 3,
      })).toThrow();
    });
  });

  describe('ClaudeAgentsConfigSchema', () => {
    it('parses a valid config', () => {
      expect(ClaudeAgentsConfigSchema.parse({ model: 'claude-sonnet-4-6' })).toEqual({
        model: 'claude-sonnet-4-6',
      });
    });

    it('requires model', () => {
      expect(() => ClaudeAgentsConfigSchema.parse({})).toThrow();
    });

    it('accepts maxTurns', () => {
      expect(ClaudeAgentsConfigSchema.parse({ model: 'claude-sonnet-4-6', maxTurns: 4 })).toEqual({
        model: 'claude-sonnet-4-6',
        maxTurns: 4,
      });
    });

    it('rejects negative maxTurns', () => {
      expect(() => ClaudeAgentsConfigSchema.parse({
        model: 'claude-sonnet-4-6',
        maxTurns: -1,
      })).toThrow();
    });
  });

  describe('PIAgentConfigSchema', () => {
    it('parses a valid config with explicit provider', () => {
      expect(PIAgentConfigSchema.parse({ provider: 'openai', model: 'gpt-5-mini' })).toEqual({
        provider: 'openai',
        model: 'gpt-5-mini',
      });
    });

    it('requires model', () => {
      expect(() => PIAgentConfigSchema.parse({})).toThrow();
    });

    it('rejects invalid provider', () => {
      expect(() => PIAgentConfigSchema.parse({
        provider: 'invalid',
        model: 'gpt-5-mini',
      })).toThrow();
    });
  });

  describe('DefaultHarnessRegistry.getConfigSchema', () => {
    it('returns the registered langgraph schema', () => {
      const registry = new DefaultHarnessRegistry();
      registry.register(stubHarness('langgraph', LangGraphConfigSchema));

      expect(registry.getConfigSchema('langgraph')).toBe(LangGraphConfigSchema);
    });

    it('throws for an unknown harness', () => {
      const registry = new DefaultHarnessRegistry();

      expect(() => registry.getConfigSchema('unknown')).toThrow('Unknown harness: unknown');
    });
  });
});
