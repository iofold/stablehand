import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { LocalFunctionExecutor } from '../../packages/ctxmill/src/tool/executor.js';
import type { ToolDefinition, ToolContext } from '@ctxmill/sandbox-daemon';

const mockCtx: ToolContext = {
  agentId: 'test-agent',
  conversationId: 'test-conv',
  knowledge: {
    query: async () => ({ items: [] }),
  },
};

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test-tool',
    description: 'A test tool',
    input: z.object({
      value: z.string().describe('A string value'),
    }),
    handler: async (input: { value: string }) => {
      return JSON.stringify({ echo: input.value });
    },
    ...overrides,
  };
}

describe('LocalFunctionExecutor', () => {
  let executor: LocalFunctionExecutor;

  beforeEach(() => {
    executor = new LocalFunctionExecutor();
  });

  it('should register and list tools', () => {
    executor.register(createTool({ name: 'tool-a' }));
    executor.register(createTool({ name: 'tool-b' }));

    const tools = executor.list();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain('tool-a');
    expect(tools.map((t) => t.name)).toContain('tool-b');
  });

  it('should get a tool by name', () => {
    executor.register(createTool({ name: 'my-tool' }));

    const tool = executor.get('my-tool');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('my-tool');

    const missing = executor.get('non-existent');
    expect(missing).toBeUndefined();
  });

  it('should execute a tool with valid input', async () => {
    executor.register(createTool());

    const result = await executor.execute(
      { id: 'call-1', name: 'test-tool', arguments: { value: 'hello' } },
      mockCtx,
    );

    expect(result.callId).toBe('call-1');
    expect(result.name).toBe('test-tool');
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const parsed = JSON.parse(result.result);
    expect(parsed.echo).toBe('hello');
  });

  it('should throw for unknown tool', async () => {
    await expect(
      executor.execute(
        { id: 'call-1', name: 'unknown-tool', arguments: {} },
        mockCtx,
      ),
    ).rejects.toThrow(/unknown tool/i);
  });

  it('should throw for invalid input (Zod validation)', async () => {
    executor.register(createTool());

    await expect(
      executor.execute(
        { id: 'call-1', name: 'test-tool', arguments: { value: 123 } }, // value should be string
        mockCtx,
      ),
    ).rejects.toThrow(/input validation failed/i);
  });

  it('should return error when handler throws', async () => {
    executor.register(
      createTool({
        handler: async () => {
          throw new Error('Handler explosion');
        },
      }),
    );

    const result = await executor.execute(
      { id: 'call-1', name: 'test-tool', arguments: { value: 'test' } },
      mockCtx,
    );

    expect(result.error).toContain('Handler explosion');
    expect(result.result).toBe('');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should measure execution duration', async () => {
    executor.register(
      createTool({
        handler: async (input: { value: string }) => {
          // Simulate slight delay
          await new Promise((r) => setTimeout(r, 10));
          return JSON.stringify({ value: input.value });
        },
      }),
    );

    const result = await executor.execute(
      { id: 'call-1', name: 'test-tool', arguments: { value: 'timing' } },
      mockCtx,
    );

    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  it('should handle tool with complex Zod schema', async () => {
    const complexTool = createTool({
      name: 'complex-tool',
      input: z.object({
        name: z.string(),
        count: z.number().positive(),
        tags: z.array(z.string()).optional(),
      }),
      handler: async (input: { name: string; count: number; tags?: string[] }) => {
        return JSON.stringify({ processed: true, name: input.name, count: input.count });
      },
    });

    executor.register(complexTool);

    // Valid input
    const valid = await executor.execute(
      { id: 'c1', name: 'complex-tool', arguments: { name: 'test', count: 5, tags: ['a', 'b'] } },
      mockCtx,
    );
    expect(valid.error).toBeUndefined();

    // Invalid: negative count — should throw
    await expect(
      executor.execute(
        { id: 'c2', name: 'complex-tool', arguments: { name: 'test', count: -1 } },
        mockCtx,
      ),
    ).rejects.toThrow(/input validation failed/i);
  });

  it('should replace tools when registered with same name', () => {
    executor.register(createTool({ name: 'dup', description: 'First' }));
    executor.register(createTool({ name: 'dup', description: 'Second' }));

    const tools = executor.list();
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe('Second');
  });
});
