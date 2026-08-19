import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { z } from 'zod';

import { DefaultToolRegistry } from '../../packages/ctxmill/src/tool/registry.js';
import { LocalFunctionExecutor } from '../../packages/ctxmill/src/tool/executor.js';
import { LocalToolProvider } from '../../packages/ctxmill/src/tool/providers/local.js';
import { emitEventTool } from '../../packages/ctxmill/src/tool/builtin/emit-event.js';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

interface ToolTestSuccessResponse {
  success: true;
  result: string;
  durationMs: number;
}

interface ToolTestErrorResponse {
  success: false;
  error: string;
  durationMs: number;
}

describe('POST /api/catalogs/tools/test', () => {
  let app: TestAppHandle['app'];
  let testApp: TestAppHandle | undefined;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    const toolExecutor = new LocalFunctionExecutor();
    toolExecutor.register(emitEventTool);
    toolExecutor.register({
      name: 'empty-input-tool',
      description: 'Test tool with optional empty object input.',
      input: z.object({}),
      handler: async (input) => `received ${Object.keys(input as Record<string, unknown>).length} keys`,
    });

    const toolRegistry = new DefaultToolRegistry();
    toolRegistry.addProvider(new LocalToolProvider(toolExecutor));
    await toolRegistry.refresh();

    testApp = await createTestApp({
      dirPrefix: 'ctxmill-tool-tester-',
      serverOptions: { toolDefinitionRegistry: toolRegistry },
    });
    app = testApp.app;
  });

  afterAll(async () => {
    await testApp?.close();
  });

  it('returns success with result and durationMs for a valid tool', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/catalogs/tools/test',
      payload: {
        toolName: 'emit-event',
        input: {
          type: 'tool.tester.event',
          payload: { ok: true },
        },
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as ToolTestSuccessResponse;
    expect(body.success).toBe(true);
    expect(typeof body.result).toBe('string');
    expect(body.result.length).toBeGreaterThan(0);
    expect(typeof body.durationMs).toBe('number');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns Tool not found for unknown tool names', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/catalogs/tools/test',
      payload: {
        toolName: 'missing-tool',
        input: {},
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as ToolTestErrorResponse;
    expect(body).toEqual({
      success: false,
      error: 'Tool not found: missing-tool',
      durationMs: 0,
    });
  });

  it('returns 400 for missing toolName', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/catalogs/tools/test',
      payload: { input: {} },
    });

    expect(res.statusCode).toBe(400);

    const body = res.json() as { error: string; code: string };
    expect(body.code).toBe('invalid_tool_test_request');
    expect(body.error).toContain('Invalid request body');
  });

  it('returns 400 for an empty request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/catalogs/tools/test',
      payload: {},
    });

    expect(res.statusCode).toBe(400);

    // ctx-iqzy S12: rejected requests use the standard error envelope.
    const body = res.json() as { error: string; code: string };
    expect(body.code).toBe('invalid_tool_test_request');
    expect(body.error).toContain('Invalid request body');
  });

  it('uses an empty object default when input is omitted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/catalogs/tools/test',
      payload: {
        toolName: 'empty-input-tool',
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as ToolTestSuccessResponse;
    expect(body.success).toBe(true);
    expect(body.result).toBe('received 0 keys');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns the expected success response shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/catalogs/tools/test',
      payload: {
        toolName: 'empty-input-tool',
        input: {},
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as ToolTestSuccessResponse;
    expect(body).toEqual({
      success: true,
      result: 'received 0 keys',
      durationMs: expect.any(Number),
    });
  });

  it('returns the expected error response shape when tool execution fails', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/catalogs/tools/test',
      payload: {
        toolName: 'emit-event',
        input: {},
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json() as ToolTestErrorResponse;
    expect(body.success).toBe(false);
    expect(body.error).toContain('input validation failed');
    expect(typeof body.durationMs).toBe('number');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });
});
