import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { TurnDeliveryCapabilitySchema } from '@ctxmill/proto/sandbox/v1';
import { z } from 'zod';

import type { ToolContext, ToolDefinition } from '../../tool/types.js';
import { getSessionTools, getToolApiToken, setSessionTools, startToolApi } from '../daemon.js';
import {
  getTurnDeliveryContext,
  registerPtcTurnDeliveryContext,
  revokePtcTurnDeliveryContext,
  type TurnDeliveryContext,
} from '../turn-delivery-context.js';

interface MockBunServeOptions {
  hostname?: string;
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
  input: unknown = {},
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    input,
    programmatic: true,
    handler,
  };
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${getToolApiToken()}`,
  };
}

let activePtcContext: TurnDeliveryContext;
let activePtcToken: string;

function makeDeliveryContext(
  turnId = 'turn-1',
  ownerId = 'owner-1',
  fenceToken = 1,
): TurnDeliveryContext {
  const leaseExpiresAtMs = Date.now() + 60_000;
  return {
    identity: {
      turnId,
      sandboxSessionId: 'sandbox-session-1',
      agentId: 'agent-1',
      ownerId,
      fenceToken,
      restoreFenceToken: 0,
      containerId: 'container-1',
    },
    capability: create(TurnDeliveryCapabilitySchema, {
      ownerId,
      fenceToken: BigInt(fenceToken),
      leaseExpiresAtMs: BigInt(leaseExpiresAtMs),
      restoreFenceToken: 0n,
      containerId: 'container-1',
      agentId: 'agent-1',
      signature: 'ctxmill-open-turn-delivery-capability-v1',
    }),
    leaseExpiresAtMs,
    abortController: new AbortController(),
  };
}

function jsonHeaders(token = activePtcToken): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

function makeContext(): ToolContext {
  return {
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    sandboxSessionId: 'sandbox-session-1',
    workspaceDir: '/workspace/session',
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
  activePtcContext = makeDeliveryContext();
  activePtcToken = registerPtcTurnDeliveryContext(activePtcContext);
});

afterEach(() => {
  revokePtcTurnDeliveryContext(activePtcContext);
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
        hostname: '127.0.0.1',
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
      headers: authHeaders(),
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
      headers: authHeaders(),
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
      headers: jsonHeaders(),
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

  it('POST /tools/:name passes the current session context to handlers', async () => {
    const mockBun = installMockBun();
    const context = makeContext();
    const handler = vi.fn<ToolDefinition['handler']>().mockResolvedValue(JSON.stringify({ ok: true }));

    setSessionTools([makeTool('search', handler)], context);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ query: 'hello' }),
    }));

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      { query: 'hello' },
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        sandboxSessionId: 'sandbox-session-1',
        workspaceDir: '/workspace/session',
      }),
    );
  });

  it('rejects requests without the session bearer token', async () => {
    const mockBun = installMockBun();

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools', {
      method: 'GET',
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects the session-static bearer token for POST requests', async () => {
    const mockBun = installMockBun();
    setSessionTools([makeTool('search', async () => JSON.stringify({ ok: true }))]);
    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'must-not-run' }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('keeps an already-admitted A request bound to A when B becomes current', async () => {
    const mockBun = installMockBun();
    let releaseHandler!: () => void;
    const handlerMayFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerStarted!: () => void;
    const handlerDidStart = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const observedTurnIds: string[] = [];
    setSessionTools([
      makeTool('search', async () => {
        handlerStarted();
        await handlerMayFinish;
        observedTurnIds.push(getTurnDeliveryContext()?.identity.turnId ?? 'missing');
        return JSON.stringify({ ok: true });
      }),
    ]);
    startToolApi(8080, getSessionTools);

    const requestA = mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: jsonHeaders(activePtcToken),
      body: JSON.stringify({ query: 'from-a' }),
    }));
    await handlerDidStart;

    const contextB = makeDeliveryContext('turn-2', 'owner-2', 2);
    const tokenB = registerPtcTurnDeliveryContext(contextB);
    releaseHandler();
    const responseA = await requestA;

    expect(responseA.status).toBe(200);
    expect(observedTurnIds).toEqual(['turn-1']);

    revokePtcTurnDeliveryContext(activePtcContext);
    const staleA = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: jsonHeaders(activePtcToken),
      body: JSON.stringify({ query: 'late-a' }),
    }));
    expect(staleA.status).toBe(401);

    const liveB = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: jsonHeaders(tokenB),
      body: JSON.stringify({ query: 'from-b' }),
    }));
    expect(liveB.status).toBe(200);
    revokePtcTurnDeliveryContext(contextB);
  });

  it('validates tool input before calling the handler', async () => {
    const mockBun = installMockBun();
    const handler = vi.fn<ToolDefinition['handler']>().mockResolvedValue(JSON.stringify({ ok: true }));

    setSessionTools([makeTool('search', handler, z.object({ query: z.string() }))]);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ query: 123 }),
    }));

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    const payload = await response.json() as { error: string };
    expect(payload.error).toBe('Invalid tool input');
  });

  it('POST /tools/:name returns 404 for unknown tool', async () => {
    const mockBun = installMockBun();

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/missing-tool', {
      method: 'POST',
      headers: jsonHeaders(),
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
      headers: jsonHeaders(),
      body: JSON.stringify({ query: 'hello' }),
    }));

    const payload = await response.json() as { error: string };

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: 'Tool exploded' });
    expect(payload.error).not.toContain('Error: Tool exploded');
    expect(payload.error).not.toContain('at ');
  });

  it('logs method, path, status, and duration for each request', async () => {
    const mockBun = installMockBun();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setSessionTools([makeTool('search', async () => JSON.stringify({ ok: true }))]);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ query: 'hello' }),
    }));

    expect(response.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[sandbox\] tool API POST \/tools\/search -> 200 \(\d+ms\)$/),
    );
  });

  it('logs the tool name and error when a handler throws', async () => {
    const mockBun = installMockBun();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('Tool exploded');

    setSessionTools([
      makeTool('search', async () => {
        throw failure;
      }),
    ]);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ query: 'hello' }),
    }));

    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith('[sandbox] tool search failed:', failure);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[sandbox\] tool API POST \/tools\/search -> 500 \(\d+ms\)$/),
    );
  });

  it('POST /tools/:name returns raw string when handler returns non-JSON', async () => {
    const mockBun = installMockBun();

    setSessionTools([
      makeTool('search', async () => 'not-json'),
    ]);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/search', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ query: 'hello' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBe('not-json');
  });

  it('POST /tools/:name returns raw string when handler returns markdown', async () => {
    const mockBun = installMockBun();

    setSessionTools([
      makeTool('docs', async () => '# Heading\n\nSome **markdown** content.'),
    ]);

    startToolApi(8080, getSessionTools);

    const response = await mockBun.dispatch(new Request('http://localhost:8080/tools/docs', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBe('# Heading\n\nSome **markdown** content.');
  });
});
