import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolDefinition } from '../../tool/types.js';
import { getSessionTools, setSessionTools, startToolApi } from '../daemon.js';

interface MockBunServeOptions {
  port: number;
  fetch(request: Request): Response | Promise<Response>;
}

interface MockBunController {
  serveSpy: ReturnType<typeof vi.fn>;
  stopSpy: ReturnType<typeof vi.fn>;
  dispatch(request: Request): Promise<Response>;
}

function makeTool(
  name: string,
  handler: ToolDefinition['handler'],
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    input: {},
    programmatic: true,
    handler,
  };
}

function installMockBun(): MockBunController {
  let fetchHandler: MockBunServeOptions['fetch'] | null = null;
  const stopSpy = vi.fn();
  const serveSpy = vi.fn((options: MockBunServeOptions) => {
    fetchHandler = options.fetch;
    return {
      stop: stopSpy,
    };
  });

  vi.stubGlobal('Bun', {
    serve: serveSpy,
  });

  return {
    serveSpy,
    stopSpy,
    async dispatch(request: Request): Promise<Response> {
      if (!fetchHandler) {
        throw new Error('Mock Bun fetch handler was not installed');
      }

      return await fetchHandler(request);
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setSessionTools([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSessionTools([]);
});

describe('startToolApi', () => {
  it('returns server with stop method', () => {
    const mockBun = installMockBun();

    const server = startToolApi(9090, getSessionTools);

    expect(typeof server.stop).toBe('function');
    expect(mockBun.serveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 9090,
        fetch: expect.any(Function),
      }),
    );

    server.stop();

    expect(mockBun.stopSpy).toHaveBeenCalledTimes(1);
  });

  it('GET /tools returns empty array when no session tools set', async () => {
    const mockBun = installMockBun();

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools', {
      method: 'GET',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it('GET /tools returns tool names after setSessionTools', async () => {
    const mockBun = installMockBun();

    setSessionTools([
      makeTool('search', async () => JSON.stringify({ ok: true })),
      makeTool('emit-event', async () => JSON.stringify({ ok: true })),
    ]);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools', {
      method: 'GET',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(['search', 'emit-event']);
  });

  it('POST /tools/:name calls handler and returns result', async () => {
    const mockBun = installMockBun();
    const handler = vi.fn<ToolDefinition['handler']>().mockResolvedValue(JSON.stringify({
      ok: true,
      echoed: 'hello',
    }));

    setSessionTools([makeTool('search', handler)]);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'hello' }),
    }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      { query: 'hello' },
      expect.objectContaining({
        agentId: 'sandbox-daemon',
        conversationId: 'sandbox-daemon',
        workspaceDir: '/workspace',
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, echoed: 'hello' });
  });

  it('POST /tools/:name returns 404 for unknown tool', async () => {
    const mockBun = installMockBun();

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/missing-tool', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Tool not found: missing-tool' });
  });

  it('POST /tools/:name returns 500 on handler error', async () => {
    const mockBun = installMockBun();

    setSessionTools([
      makeTool('search', async () => {
        throw new Error('Tool exploded');
      }),
    ]);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'hello' }),
    }));

    const payload = await response.json() as { error: string };

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: 'Tool exploded' });
    expect(payload.error).not.toContain('Error: Tool exploded');
    expect(payload.error).not.toContain('at ');
  });

  it('POST /tools/:name returns 500 when handler returns invalid JSON', async () => {
    const mockBun = installMockBun();

    setSessionTools([
      makeTool('search', async () => 'not-json'),
    ]);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'hello' }),
    }));

    const payload = await response.json() as { error: string };

    expect(response.status).toBe(500);
    expect(payload.error).toContain('Tool returned invalid JSON');
  });
});
