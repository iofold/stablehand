import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import { LocalFunctionExecutor } from '../../packages/ctxmill/src/tool/executor.js';
import { DefaultToolRegistry } from '../../packages/ctxmill/src/tool/registry.js';
import type { ToolProvider } from '../../packages/ctxmill/src/tool/provider.js';
import type { ToolCall, ToolContext, ToolDefinition } from '@ctxmill/sandbox-daemon';
import {
  mapAgentHttpToolsToConfigs,
  registerAgentHttpTools,
} from '../../packages/ctxmill/src/orchestrator/http-tools.js';

const mockCtx: ToolContext = {
  agentId: 'test-agent',
  conversationId: 'test-conv',
  knowledge: {
    query: async () => ({ items: [] }),
  },
  workspaceDir: '/tmp/test',
};

function createMockProvider(
  name: string,
  tools: ToolDefinition[],
): ToolProvider {
  return {
    name,
    listTools: vi.fn().mockResolvedValue(tools),
    execute: vi.fn().mockResolvedValue('ok'),
  };
}

function createToolDef(name: string, description = 'test'): ToolDefinition {
  return {
    name,
    description,
    input: z.object({}),
    handler: async () => 'result',
  };
}

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test-tool',
    description: 'A test tool',
    input: z.object({
      value: z.string(),
    }),
    handler: async (input: { value: string }) => {
      return JSON.stringify({ echo: input.value });
    },
    ...overrides,
  };
}

function createHttpTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'search-api',
    description: 'Search external API',
    endpoint: 'https://example.com/search',
    method: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    headers: {
      'X-Test': 'true',
    },
    timeout: 5000,
    authentication: {
      type: 'bearer',
      secretName: 'API_TOKEN',
    },
    ...overrides,
  };
}

function createAgentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'Search Agent',
    model: 'gpt-5.4-mini',
    harness: 'langgraph',
    systemPrompt: 'You are helpful.',
    tools: [],
    metadata: {
      httpTools: [createHttpTool()],
    },
    ...overrides,
  };
}

type RegistrationAgent = Parameters<typeof registerAgentHttpTools>[1];

function createRegistrationAgent(overrides: Partial<RegistrationAgent> = {}): RegistrationAgent {
  return {
    id: 'agent-1',
    name: 'Search Agent',
    metadata: {
      httpTools: [createHttpTool()],
    },
    ...overrides,
  };
}

describe('tool validation edge cases', () => {
  describe('DefaultToolRegistry', () => {
    let registry: DefaultToolRegistry;

    beforeEach(() => {
      registry = new DefaultToolRegistry();
    });

    it('should keep tools with empty-string names when a provider returns them', async () => {
      registry.addProvider(createMockProvider('local', [createToolDef('')])) ;
      await registry.refresh();

      expect(registry.listAll()).toHaveLength(1);
      expect(registry.listAll()[0].name).toBe('');
      expect(registry.getTool('')?.name).toBe('');
      expect(registry.getProvider('')?.name).toBe('local');
    });

    it('should let the last provider win for duplicate tool names', async () => {
      registry.addProvider(createMockProvider('provider-1', [
        createToolDef('shared-tool', 'from provider 1'),
      ]));
      registry.addProvider(createMockProvider('provider-2', [
        createToolDef('shared-tool', 'from provider 2'),
      ]));
      await registry.refresh();

      expect(registry.listAll()).toHaveLength(1);
      expect(registry.getTool('shared-tool')?.description).toBe('from provider 2');
      expect(registry.getProvider('shared-tool')?.name).toBe('provider-2');
    });

    it('should return only builtin tools when listForAgent receives an empty tools array', async () => {
      registry.addProvider(createMockProvider('local', [
        createToolDef('custom-tool'),
        createToolDef('emit-event', 'builtin tool'),
      ]));
      await registry.refresh();

      const tools = registry.listForAgent([]);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('emit-event');
    });
  });

  describe('LocalFunctionExecutor', () => {
    let executor: LocalFunctionExecutor;

    beforeEach(() => {
      executor = new LocalFunctionExecutor();
    });

    it('should include available tool names when execution targets an unknown tool', async () => {
      executor.register(createTool({ name: 'tool-a' }));
      executor.register(createTool({ name: 'tool-b' }));

      await expect(
        executor.execute(
          { id: 'call-1', name: 'missing-tool', arguments: {} },
          mockCtx,
        ),
      ).rejects.toThrow('Available tools: tool-a, tool-b');
    });

    it('should throw a validation error when arguments are null', async () => {
      executor.register(createTool());

      const call: ToolCall = { id: 'call-1', name: 'test-tool', arguments: {} };
      Object.defineProperty(call, 'arguments', { value: null });

      await expect(executor.execute(call, mockCtx)).rejects.toThrow(/input validation failed/i);
    });

    it('should throw a validation error when arguments are undefined', async () => {
      executor.register(createTool());

      const call: ToolCall = { id: 'call-1', name: 'test-tool', arguments: {} };
      Object.defineProperty(call, 'arguments', { value: undefined });

      await expect(executor.execute(call, mockCtx)).rejects.toThrow(/input validation failed/i);
    });

    it('should capture non-Error throws as stringified ToolResult errors', async () => {
      executor.register(createTool({
        handler: async () => {
          throw 'string failure';
        },
      }));

      const result = await executor.execute(
        { id: 'call-1', name: 'test-tool', arguments: { value: 'hello' } },
        mockCtx,
      );

      expect(result.callId).toBe('call-1');
      expect(result.name).toBe('test-tool');
      expect(result.result).toBe('');
      expect(result.error).toBe('string failure');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('HTTP tool metadata validation', () => {
    let registry: DefaultToolRegistry;

    beforeEach(() => {
      registry = new DefaultToolRegistry();
    });

    it('should return no configs when an http tool is missing its endpoint', () => {
      const configs = mapAgentHttpToolsToConfigs(createAgentDefinition({
        metadata: {
          httpTools: [createHttpTool({ endpoint: undefined })],
        },
      }));

      expect(configs).toEqual([]);
    });

    it('should return no configs when an http tool has an empty name', () => {
      const configs = mapAgentHttpToolsToConfigs(createAgentDefinition({
        metadata: {
          httpTools: [createHttpTool({ name: '' })],
        },
      }));

      expect(configs).toEqual([]);
    });

    it('should reject invalid HTTP methods instead of defaulting to POST', () => {
      expect(() => mapAgentHttpToolsToConfigs(createAgentDefinition({
        metadata: {
          httpTools: [createHttpTool({ method: 'TRACE' })],
        },
      }))).toThrow('Invalid HTTP tool method: TRACE');
    });

    it('should skip malformed metadata entries and keep valid http tools', () => {
      const configs = mapAgentHttpToolsToConfigs(createAgentDefinition({
        metadata: {
          httpTools: [
            null,
            'bad-tool',
            { name: '', description: 'missing name', endpoint: 'https://example.com/skip' },
            createHttpTool({ name: 'valid-tool' }),
          ],
        },
      }));

      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe('valid-tool');
    });

    it('should drop malformed optional fields while preserving the base config', () => {
      const configs = mapAgentHttpToolsToConfigs(createAgentDefinition({
        metadata: {
          httpTools: [createHttpTool({
            headers: { Authorization: 123 },
            timeout: 'fast',
            authentication: { type: 'oauth2', secretName: '' },
            inputSchema: null,
          })],
        },
      }));

      expect(configs).toEqual([
        {
          name: 'search-api',
          url: 'https://example.com/search',
          method: 'POST',
          description: 'Search external API',
        },
      ]);
    });

    it('should make registerAgentHttpTools a no-op when the agent has no httpTools', async () => {
      const addProviderSpy = vi.spyOn(registry, 'addProvider');
      const refreshSpy = vi.spyOn(registry, 'refresh');

      await registerAgentHttpTools(registry, createRegistrationAgent({ metadata: {} }));

      expect(addProviderSpy).not.toHaveBeenCalled();
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(registry.listAll()).toHaveLength(0);
    });

    it('should make registerAgentHttpTools a no-op when metadata is malformed', async () => {
      const addProviderSpy = vi.spyOn(registry, 'addProvider');

      await registerAgentHttpTools(registry, createRegistrationAgent({ metadata: null }));

      expect(addProviderSpy).not.toHaveBeenCalled();
      expect(registry.listAll()).toHaveLength(0);
    });
  });
});
