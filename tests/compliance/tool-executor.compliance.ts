/**
 * ToolExecutor Compliance Test Suite
 *
 * Validates that any implementation of the ToolExecutor interface
 * (currently LocalFunctionExecutor) satisfies the behavioral contract:
 *
 *   - register() adds tools to the executor
 *   - list() enumerates all registered tools
 *   - get() retrieves a tool by name (or undefined)
 *   - execute() runs a ToolCall against a ToolContext and returns a ToolResult
 *   - Zod-based input validation rejects bad arguments
 *   - Handler errors are caught and surfaced in ToolResult.error
 *   - Duration tracking via ToolResult.durationMs
 *   - toJsonSchemaFormat() converts tools to provider-agnostic JSON Schema
 *
 * Usage: import `runToolExecutorCompliance(factory)` and call it inside
 *        a `describe()` block. The factory must return a fresh executor instance.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolContext,
} from '@ctxmill/sandbox-daemon';

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/** Minimal ToolContext stub for compliance tests. */
export function createMockContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'compliance-agent',
    conversationId: 'compliance-conv',
    ...overrides,
  };
}

/** Build a simple echo tool for quick registration. */
export function createEchoTool(
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name: 'echo',
    description: 'Echoes the input value back as JSON',
    input: z.object({ value: z.string() }),
    handler: async (input: { value: string }) => JSON.stringify({ echo: input.value }),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Interface contract expected from any ToolExecutor implementation    */
/* ------------------------------------------------------------------ */

export interface ToolExecutorContract {
  register(tool: ToolDefinition): void;
  list(): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  toJsonSchemaFormat(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
}

/* ------------------------------------------------------------------ */
/*  Compliance suite                                                   */
/* ------------------------------------------------------------------ */

export function runToolExecutorCompliance(
  factory: () => ToolExecutorContract,
): void {
  let executor: ToolExecutorContract;
  const ctx = createMockContext();

  beforeEach(() => {
    executor = factory();
  });

  /* ---------- register + list ---------- */

  describe('register / list', () => {
    it('list() returns empty array when nothing registered', () => {
      expect(executor.list()).toEqual([]);
    });

    it('registers a tool and returns it via list()', () => {
      executor.register(createEchoTool());
      const tools = executor.list();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('echo');
    });

    it('registers multiple tools', () => {
      executor.register(createEchoTool({ name: 'tool-a' }));
      executor.register(createEchoTool({ name: 'tool-b' }));
      executor.register(createEchoTool({ name: 'tool-c' }));
      expect(executor.list()).toHaveLength(3);
    });

    it('replaces a tool when registered with the same name', () => {
      executor.register(createEchoTool({ name: 'dup', description: 'First' }));
      executor.register(createEchoTool({ name: 'dup', description: 'Second' }));
      const tools = executor.list();
      expect(tools).toHaveLength(1);
      expect(tools[0].description).toBe('Second');
    });
  });

  /* ---------- get ---------- */

  describe('get', () => {
    it('returns the tool when it exists', () => {
      executor.register(createEchoTool({ name: 'findme' }));
      const tool = executor.get('findme');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('findme');
    });

    it('returns undefined for an unregistered name', () => {
      expect(executor.get('no-such-tool')).toBeUndefined();
    });
  });

  /* ---------- execute – happy path ---------- */

  describe('execute – happy path', () => {
    it('runs a tool and returns a ToolResult with callId, name, result', async () => {
      executor.register(createEchoTool());
      const result = await executor.execute(
        { id: 'call-1', name: 'echo', arguments: { value: 'hello' } },
        ctx,
      );
      expect(result.callId).toBe('call-1');
      expect(result.name).toBe('echo');
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.result)).toEqual({ echo: 'hello' });
    });

    it('measures durationMs >= 0', async () => {
      executor.register(createEchoTool());
      const result = await executor.execute(
        { id: 'call-2', name: 'echo', arguments: { value: 'timing' } },
        ctx,
      );
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('reports positive durationMs for slow handlers', async () => {
      executor.register(
        createEchoTool({
          name: 'slow',
          handler: async (input: { value: string }) => {
            await new Promise((r) => setTimeout(r, 15));
            return JSON.stringify({ value: input.value });
          },
        }),
      );
      const result = await executor.execute(
        { id: 'call-3', name: 'slow', arguments: { value: 'wait' } },
        ctx,
      );
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
    });

    it('passes the ToolContext to the handler', async () => {
      let receivedCtx: ToolContext | undefined;
      executor.register(
        createEchoTool({
          name: 'ctx-spy',
          handler: async (_input: { value: string }, c: ToolContext) => {
            receivedCtx = c;
            return 'ok';
          },
        }),
      );
      const customCtx = createMockContext({ agentId: 'spy-agent' });
      await executor.execute(
        { id: 'call-4', name: 'ctx-spy', arguments: { value: 'x' } },
        customCtx,
      );
      expect(receivedCtx).toBeDefined();
      expect(receivedCtx!.agentId).toBe('spy-agent');
    });
  });

  /* ---------- execute – unknown tool ---------- */

  describe('execute – unknown tool', () => {
    it('throws for a tool that is not registered', async () => {
      await expect(
        executor.execute(
          { id: 'call-miss', name: 'nonexistent', arguments: {} },
          ctx,
        ),
      ).rejects.toThrow(/unknown tool/i);
    });
  });

  /* ---------- execute – validation errors ---------- */

  describe('execute – input validation', () => {
    it('throws on input that fails Zod validation', async () => {
      executor.register(createEchoTool());
      await expect(
        executor.execute(
          { id: 'call-bad', name: 'echo', arguments: { value: 42 } },
          ctx,
        ),
      ).rejects.toThrow(/input validation failed/i);
    });

    it('throws on missing required fields', async () => {
      executor.register(createEchoTool());
      await expect(
        executor.execute(
          { id: 'call-missing', name: 'echo', arguments: {} },
          ctx,
        ),
      ).rejects.toThrow(/input validation failed/i);
    });

    it('validates complex schemas (nested objects, arrays)', async () => {
      executor.register(
        createEchoTool({
          name: 'complex',
          input: z.object({
            name: z.string(),
            count: z.number().positive(),
            tags: z.array(z.string()).optional(),
          }),
          handler: async (input: { name: string; count: number }) =>
            JSON.stringify({ ok: true, name: input.name }),
        }),
      );

      // Valid
      const good = await executor.execute(
        { id: 'c-ok', name: 'complex', arguments: { name: 'test', count: 5, tags: ['a'] } },
        ctx,
      );
      expect(good.error).toBeUndefined();

      // Invalid: negative count — should throw
      await expect(
        executor.execute(
          { id: 'c-bad', name: 'complex', arguments: { name: 'test', count: -1 } },
          ctx,
        ),
      ).rejects.toThrow(/input validation failed/i);
    });
  });

  /* ---------- execute – handler errors ---------- */

  describe('execute – handler errors', () => {
    it('catches thrown errors and surfaces them in ToolResult.error', async () => {
      executor.register(
        createEchoTool({
          name: 'boom',
          handler: async () => {
            throw new Error('Handler explosion');
          },
        }),
      );
      const result = await executor.execute(
        { id: 'call-err', name: 'boom', arguments: { value: 'x' } },
        ctx,
      );
      expect(result.error).toContain('Handler explosion');
      expect(result.result).toBe('');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('catches non-Error throws (strings, numbers)', async () => {
      executor.register(
        createEchoTool({
          name: 'str-throw',
          handler: async () => {
            throw 'raw string error';
          },
        }),
      );
      const result = await executor.execute(
        { id: 'call-str', name: 'str-throw', arguments: { value: 'x' } },
        ctx,
      );
      expect(result.error).toBeDefined();
      expect(result.result).toBe('');
    });
  });

  /* ---------- toJsonSchemaFormat ---------- */

  describe('toJsonSchemaFormat', () => {
    it('returns empty array when no tools registered', () => {
      expect(executor.toJsonSchemaFormat()).toEqual([]);
    });

    it('returns JSON-schema representations of registered tools', () => {
      executor.register(createEchoTool());
      const schemas = executor.toJsonSchemaFormat();
      expect(schemas).toHaveLength(1);
      expect(schemas[0].name).toBe('echo');
      expect(schemas[0].description).toBe('Echoes the input value back as JSON');
      expect(schemas[0].input_schema).toBeDefined();
      expect(typeof schemas[0].input_schema).toBe('object');
    });

    it('includes all registered tools', () => {
      executor.register(createEchoTool({ name: 'a', description: 'Tool A' }));
      executor.register(createEchoTool({ name: 'b', description: 'Tool B' }));
      const schemas = executor.toJsonSchemaFormat();
      expect(schemas).toHaveLength(2);
      const names = schemas.map((s) => s.name);
      expect(names).toContain('a');
      expect(names).toContain('b');
    });
  });
}
