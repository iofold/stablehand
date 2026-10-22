import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { LocalFunctionExecutor } from '../../packages/stablehand/src/tool/executor.js';
import { LocalToolProvider } from '../../packages/stablehand/src/tool/providers/local.js';
import type { ToolDefinition, ToolContext } from '@stablehand/sandbox-daemon';

const mockCtx: ToolContext = {
  agentId: 'test-agent',
  conversationId: 'test-conv',
  workspaceDir: '/tmp/test',
};

function createTool(name: string, description = 'A test tool'): ToolDefinition {
  return {
    name,
    description,
    input: z.object({ value: z.string() }),
    handler: async (input: { value: string }) => `echo:${input.value}`,
  };
}

// ---------- LocalToolProvider ----------

describe('LocalToolProvider', () => {
  let executor: LocalFunctionExecutor;
  let provider: LocalToolProvider;

  beforeEach(() => {
    executor = new LocalFunctionExecutor();
    provider = new LocalToolProvider(executor);
  });

  it('should have name "local"', () => {
    expect(provider.name).toBe('local');
  });

  it('should list tools from the underlying executor', async () => {
    executor.register(createTool('tool-a'));
    executor.register(createTool('tool-b'));

    const tools = await provider.listTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['tool-a', 'tool-b']),
    );
  });

  it('should return empty array when no tools registered', async () => {
    const tools = await provider.listTools();
    expect(tools).toHaveLength(0);
  });

  it('should execute a tool by name', async () => {
    executor.register(createTool('my-tool'));

    const result = await provider.execute('my-tool', { value: 'hello' }, mockCtx);
    expect(result).toBe('echo:hello');
  });

  it('should throw when executing unknown tool', async () => {
    await expect(
      provider.execute('nonexistent', { value: 'x' }, mockCtx),
    ).rejects.toThrow(/unknown tool/i);
  });

  it('should throw when handler errors', async () => {
    executor.register({
      name: 'failing-tool',
      description: 'Fails',
      input: z.object({ value: z.string() }),
      handler: async () => {
        throw new Error('Boom');
      },
    });

    await expect(
      provider.execute('failing-tool', { value: 'x' }, mockCtx),
    ).rejects.toThrow('Boom');
  });
});
