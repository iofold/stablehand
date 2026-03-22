import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { LocalFunctionExecutor } from '../executor.js';
import type { ToolDefinition, ToolContext } from '../types.js';

function makeCtx(): ToolContext {
  return {
    agentId: 'test-agent',
    conversationId: 'test-conv',
    workspaceDir: '/tmp',
    knowledge: {
      query: async () => ({ items: [] }),
    },
  };
}

function makeTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'echo',
    description: 'Echo back the input',
    input: z.object({ text: z.string() }),
    handler: async (input: unknown) => (input as { text: string }).text,
    ...overrides,
  };
}

describe('LocalFunctionExecutor', () => {
  it('throws for unknown tools', async () => {
    const executor = new LocalFunctionExecutor();
    await expect(
      executor.execute(
        { id: 'call-1', name: 'nonexistent', arguments: {} },
        makeCtx(),
      ),
    ).rejects.toThrow(/unknown tool/i);
  });

  it('includes available tool names in unknown tool error', async () => {
    const executor = new LocalFunctionExecutor();
    executor.register(makeTool({ name: 'foo' }));
    executor.register(makeTool({ name: 'bar' }));
    await expect(
      executor.execute(
        { id: 'call-1', name: 'nonexistent', arguments: {} },
        makeCtx(),
      ),
    ).rejects.toThrow(/foo.*bar|bar.*foo/);
  });

  it('throws on Zod validation failure', async () => {
    const executor = new LocalFunctionExecutor();
    executor.register(makeTool());
    await expect(
      executor.execute(
        { id: 'call-1', name: 'echo', arguments: { text: 123 } },
        makeCtx(),
      ),
    ).rejects.toThrow(/input validation failed/i);
  });

  it('returns error result for handler runtime errors', async () => {
    const executor = new LocalFunctionExecutor();
    executor.register(
      makeTool({
        handler: async () => {
          throw new Error('handler boom');
        },
      }),
    );
    const result = await executor.execute(
      { id: 'call-1', name: 'echo', arguments: { text: 'hi' } },
      makeCtx(),
    );
    expect(result.error).toMatch(/handler boom/);
    expect(result.result).toBe('');
  });

  it('returns successful result for valid calls', async () => {
    const executor = new LocalFunctionExecutor();
    executor.register(makeTool());
    const result = await executor.execute(
      { id: 'call-1', name: 'echo', arguments: { text: 'hello' } },
      makeCtx(),
    );
    expect(result.result).toBe('hello');
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
