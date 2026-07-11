import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { LocalFunctionExecutor } from '../../packages/ctxmill/src/tool/executor.js';
import { createMockToolContext } from '../utils/event-bus-test-helpers.js';
import type { ToolDefinition } from '@ctxmill/sandbox-daemon';

const mockCtx = createMockToolContext();

function getValueInput(input: unknown): { value: string } {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('value' in input) ||
    typeof input.value !== 'string'
  ) {
    throw new Error('Expected { value: string } input');
  }
  return { value: input.value };
}

function getComplexInput(input: unknown): { name: string; count: number; tags?: string[] } {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('name' in input) ||
    typeof input.name !== 'string' ||
    !('count' in input) ||
    typeof input.count !== 'number'
  ) {
    throw new Error('Expected complex tool input');
  }

  if ('tags' in input && input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string')) {
      throw new Error('Expected tags to be string[]');
    }
    return { name: input.name, count: input.count, tags: input.tags };
  }

  return { name: input.name, count: input.count };
}

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test-tool',
    description: 'A test tool',
    input: z.object({
      value: z.string().describe('A string value'),
    }),
    handler: async (input: unknown) => {
      const parsed = getValueInput(input);
      return JSON.stringify({ echo: parsed.value });
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

  it('should measure execution duration', async () => {
    executor.register(
      createTool({
        handler: async (input: unknown) => {
          const parsed = getValueInput(input);
          // Simulate slight delay
          await new Promise((r) => setTimeout(r, 10));
          return JSON.stringify({ value: parsed.value });
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
      handler: async (input: unknown) => {
        const parsed = getComplexInput(input);
        return JSON.stringify({ processed: true, name: parsed.name, count: parsed.count });
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
