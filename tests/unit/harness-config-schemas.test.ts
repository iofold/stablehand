import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DefaultHarnessRegistry } from '../../packages/ctxmill/src/harness/registry.js';
import {
  LangGraphConfigSchema,
  ClaudeAgentsConfigSchema,
  PIAgentConfigSchema,
} from '../../packages/sandbox-daemon/src/index.ts';
import type { AgentHarness, HarnessSession } from '../../packages/sandbox-daemon/src/index.ts';

function stubHarness(name: string, configSchema: z.ZodType): AgentHarness {
  return {
    name,
    configSchema,
    async openSession(): Promise<HarnessSession> {
      throw new Error('stubHarness.openSession not implemented');
    },
  };
}

describe('harness config schemas', () => {
  describe('LangGraphConfigSchema', () => {
    it('parses a valid config with explicit provider', () => {
      expect(LangGraphConfigSchema.parse({ provider: 'openai', model: 'gpt-5.4-mini' })).toEqual({
        provider: 'openai',
        model: 'gpt-5.4-mini',
      });
    });

    it('defaults provider to openai', () => {
      expect(LangGraphConfigSchema.parse({ model: 'gpt-5.4-mini' })).toEqual({
        provider: 'openai',
        model: 'gpt-5.4-mini',
      });
    });

    it('normalizes gemini provider alias to google', () => {
      expect(LangGraphConfigSchema.parse({ provider: 'gemini', model: 'gemini-2.5-flash' })).toEqual({
        provider: 'google',
        model: 'gemini-2.5-flash',
      });
    });

    it('requires model', () => {
      expect(() => LangGraphConfigSchema.parse({})).toThrow();
    });

    it('accepts subagents', () => {
      expect(LangGraphConfigSchema.parse({
        model: 'gpt-5.4-mini',
        subagents: [{
          name: 'researcher',
          description: 'Researches topics',
          systemPrompt: 'You are a researcher.',
        }],
      })).toEqual({
        provider: 'openai',
        model: 'gpt-5.4-mini',
        subagents: [{
          name: 'researcher',
          description: 'Researches topics',
          systemPrompt: 'You are a researcher.',
        }],
      });
    });

    it('normalizes subagent provider aliases', () => {
      expect(LangGraphConfigSchema.parse({
        model: 'gpt-5.4-mini',
        subagents: [{
          name: 'researcher',
          description: 'Researches topics',
          systemPrompt: 'You are a researcher.',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
        }],
      }).subagents?.[0]?.provider).toBe('google');
    });

    it('rejects temperature above 2', () => {
      expect(() => LangGraphConfigSchema.parse({
        model: 'gpt-5.4-mini',
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

    it('normalizes optional provider aliases', () => {
      expect(ClaudeAgentsConfigSchema.parse({ provider: 'gemini', model: 'claude-sonnet-4-6' })).toEqual({
        provider: 'google',
        model: 'claude-sonnet-4-6',
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
      expect(PIAgentConfigSchema.parse({ provider: 'openai', model: 'gpt-5.4-mini' })).toEqual({
        provider: 'openai',
        model: 'gpt-5.4-mini',
      });
    });

    it('requires model', () => {
      expect(() => PIAgentConfigSchema.parse({})).toThrow();
    });

    it('normalizes gemini provider alias to google', () => {
      expect(PIAgentConfigSchema.parse({ provider: 'gemini', model: 'gemini-2.5-flash' })).toEqual({
        provider: 'google',
        model: 'gemini-2.5-flash',
      });
    });

    it('rejects invalid provider', () => {
      expect(() => PIAgentConfigSchema.parse({
        provider: 'invalid',
        model: 'gpt-5.4-mini',
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
