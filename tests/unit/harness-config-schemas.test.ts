import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DefaultHarnessRegistry } from '../../packages/ctxmill/src/harness/registry.js';
import {
  HARNESS_CONFIG_SCHEMAS,
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

    it('rejects the retired gemini provider alias', () => {
      expect(() => LangGraphConfigSchema.parse({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      })).toThrow();
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

    it('rejects retired subagent provider aliases', () => {
      expect(() => LangGraphConfigSchema.parse({
        model: 'gpt-5.4-mini',
        subagents: [{
          name: 'researcher',
          description: 'Researches topics',
          systemPrompt: 'You are a researcher.',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
        }],
      })).toThrow();
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

    it('rejects retired optional provider aliases', () => {
      expect(() => ClaudeAgentsConfigSchema.parse({
        provider: 'gemini',
        model: 'claude-sonnet-4-6',
      })).toThrow();
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

    it('rejects the retired gemini provider alias', () => {
      expect(() => PIAgentConfigSchema.parse({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      })).toThrow();
    });

    it('rejects invalid provider', () => {
      expect(() => PIAgentConfigSchema.parse({
        provider: 'invalid',
        model: 'gpt-5.4-mini',
      })).toThrow();
    });
  });

  it('uses one exported schema instance for the daemon registry', () => {
    expect(HARNESS_CONFIG_SCHEMAS.langgraph).toBe(LangGraphConfigSchema);
    expect(HARNESS_CONFIG_SCHEMAS['claude-agents']).toBe(ClaudeAgentsConfigSchema);
    expect(HARNESS_CONFIG_SCHEMAS['pi-agent']).toBe(PIAgentConfigSchema);
  });

  it.each([
    LangGraphConfigSchema,
    ClaudeAgentsConfigSchema,
    PIAgentConfigSchema,
  ])('rejects unknown harness config fields', (schema) => {
    expect(() => schema.parse({
      model: 'model-id',
      retiredField: true,
    })).toThrow();
  });

  it('rejects setup symlinks that can escape the workspace', () => {
    expect(() => LangGraphConfigSchema.parse({
      model: 'gpt-5.4-mini',
      setup: {
        symlinks: [{ src: '../outside', dest: '.claude/skills' }],
      },
    })).toThrow();
    expect(() => ClaudeAgentsConfigSchema.parse({
      model: 'claude-sonnet-4-6',
      setup: {
        symlinks: [{ src: 'skills', dest: '/tmp/skills' }],
      },
    })).toThrow();
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
