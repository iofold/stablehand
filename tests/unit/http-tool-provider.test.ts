import { describe, it, expect, vi } from 'vitest';
import { HTTPToolProvider } from '../../packages/ctxmill/src/tool/providers/http.js';
import { createMockToolContext } from '../utils/event-bus-test-helpers.js';
import type { HttpEndpointConfig } from '../../packages/ctxmill/src/tool/providers/http.js';
import type { ToolContext } from '@ctxmill/sandbox-daemon';

const mockCtx: ToolContext = createMockToolContext({
  turnId: 'turn-123',
  sandboxSessionId: 'sandbox-456',
});

function makeEndpoint(overrides?: Partial<HttpEndpointConfig>): HttpEndpointConfig {
  return {
    name: 'test-tool',
    url: 'https://api.example.com/action',
    method: 'POST',
    description: 'A test HTTP tool',
    ...overrides,
  };
}

function mockFetch(
  body = '{"ok":true}',
  status = 200,
  statusText = 'OK',
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(body),
  }) as unknown as typeof fetch;
}

// ---------- Registration ----------

describe('HTTPToolProvider – registration', () => {
  it('should have a default name of "http"', () => {
    const provider = new HTTPToolProvider([]);
    expect(provider.name).toBe('http');
  });

  it('should accept a custom name', () => {
    const provider = new HTTPToolProvider([], { name: 'my-api' });
    expect(provider.name).toBe('my-api');
  });

  it('should convert endpoints to ToolDefinitions', async () => {
    const provider = new HTTPToolProvider([
      makeEndpoint({ name: 'alpha', description: 'First tool' }),
      makeEndpoint({ name: 'beta', description: 'Second tool' }),
    ], { fetchFn: mockFetch() });

    const tools = await provider.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('alpha');
    expect(tools[0].description).toBe('First tool');
    expect(tools[1].name).toBe('beta');
  });

  it('should cache tools after first listTools()', async () => {
    const provider = new HTTPToolProvider([makeEndpoint()], {
      fetchFn: mockFetch(),
    });

    const first = await provider.listTools();
    const second = await provider.listTools();
    expect(first).toBe(second);
  });

  it('should build a Zod schema from inputSchema', async () => {
    const provider = new HTTPToolProvider([
      makeEndpoint({
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      }),
    ], { fetchFn: mockFetch() });

    const tools = await provider.listTools();
    const schema = tools[0].input as { safeParse: (value: unknown) => { success: boolean } };

    // Valid input
    expect(schema.safeParse({ query: 'hello' }).success).toBe(true);
    expect(schema.safeParse({ query: 'hello', limit: 10 }).success).toBe(true);

    // Missing required field
    expect(schema.safeParse({ limit: 10 }).success).toBe(false);
  });

  it('should use z.object({}) when no inputSchema provided', async () => {
    const provider = new HTTPToolProvider([makeEndpoint()], {
      fetchFn: mockFetch(),
    });

    const tools = await provider.listTools();
    const schema = tools[0].input as { safeParse: (value: unknown) => { success: boolean } };
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('should set timeout from endpoint config', async () => {
    const provider = new HTTPToolProvider(
      [makeEndpoint({ timeout: 5000 })],
      { fetchFn: mockFetch() },
    );

    const tools = await provider.listTools();
    expect(tools[0].timeout).toBe(5000);
  });

  it('should default timeout to 30000', async () => {
    const provider = new HTTPToolProvider([makeEndpoint()], {
      fetchFn: mockFetch(),
    });

    const tools = await provider.listTools();
    expect(tools[0].timeout).toBe(30000);
  });
});

// ---------- Request building ----------

describe('HTTPToolProvider – request building', () => {
  it('should POST with JSON body and agent headers', async () => {
    const fetchFn = mockFetch('{"result":"ok"}');
    const provider = new HTTPToolProvider(
      [makeEndpoint({ method: 'POST', url: 'https://api.example.com/run' })],
      { fetchFn },
    );

    const result = await provider.execute(
      'test-tool',
      { input: 'data' },
      mockCtx,
    );

    expect(result).toBe('{"result":"ok"}');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/run',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ input: 'data' }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Agent-Id': 'test-agent',
          'X-Conversation-Id': 'test-conv',
          'X-Turn-Id': 'turn-123',
          'X-Sandbox-Session-Id': 'sandbox-456',
        }),
      }),
    );
  });

  it('should omit execution identity headers when their identifiers are missing', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const ctxWithoutExecutionIdentity: ToolContext = {
      ...mockCtx,
      turnId: undefined,
      sandboxSessionId: undefined,
    };

    await provider.execute('test-tool', {}, ctxWithoutExecutionIdentity);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.not.objectContaining({
          'X-Turn-Id': expect.anything(),
          'X-Sandbox-Session-Id': expect.anything(),
        }),
      }),
    );
  });

  it('should not send body for GET requests', async () => {
    const fetchFn = mockFetch('[]');
    const provider = new HTTPToolProvider(
      [makeEndpoint({ method: 'GET' })],
      { fetchFn },
    );

    await provider.execute('test-tool', { q: 'hello' }, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        method: 'GET',
      }),
    );
    expect(fetchFn).not.toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        body: expect.anything(),
      }),
    );
  });

  it('should merge static headers from endpoint config', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [makeEndpoint({ headers: { 'X-Custom': 'value', Accept: 'text/plain' } })],
      { fetchFn },
    );

    await provider.execute('test-tool', {}, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom': 'value',
          Accept: 'text/plain',
        }),
      }),
    );
  });

  it('should send PUT requests with body', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [makeEndpoint({ method: 'PUT' })],
      { fetchFn },
    );

    await provider.execute('test-tool', { id: 1, name: 'test' }, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ id: 1, name: 'test' }),
      }),
    );
  });

  it('should send DELETE requests with body', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [makeEndpoint({ method: 'DELETE' })],
      { fetchFn },
    );

    await provider.execute('test-tool', { id: 42 }, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ id: 42 }),
      }),
    );
  });

  it('should send PATCH requests with body', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [makeEndpoint({ method: 'PATCH' })],
      { fetchFn },
    );

    await provider.execute('test-tool', { status: 'done' }, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      }),
    );
  });
});

// ---------- Authentication ----------

describe('HTTPToolProvider – authentication', () => {
  it('should inject Bearer token from secrets', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [
        makeEndpoint({
          authentication: { type: 'bearer', secretName: 'MY_TOKEN' },
        }),
      ],
      { fetchFn, secrets: { MY_TOKEN: 'secret-jwt-token' } },
    );

    await provider.execute('test-tool', {}, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-jwt-token',
        }),
      }),
    );
  });

  it('should inject API key as X-API-Key header', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [
        makeEndpoint({
          authentication: { type: 'api-key', secretName: 'SERVICE_KEY' },
        }),
      ],
      { fetchFn, secrets: { SERVICE_KEY: 'abc-123' } },
    );

    await provider.execute('test-tool', {}, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'abc-123',
        }),
      }),
    );
  });

  it('should fall back to process.env for secrets only when explicitly allowed', async () => {
    const originalEnv = process.env.FALLBACK_SECRET;
    process.env.FALLBACK_SECRET = 'env-secret';

    try {
      const fetchFn = mockFetch();
      const provider = new HTTPToolProvider(
        [
          makeEndpoint({
            authentication: { type: 'bearer', secretName: 'FALLBACK_SECRET', allowEnvFallback: true },
          }),
        ],
        { fetchFn },
      );

      await provider.execute('test-tool', {}, mockCtx);

      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.example.com/action',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer env-secret',
          }),
        }),
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.FALLBACK_SECRET;
      } else {
        process.env.FALLBACK_SECRET = originalEnv;
      }
    }
  });

  it('should fail deterministically when a configured secret is not found', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [
        makeEndpoint({
          authentication: { type: 'bearer', secretName: 'MISSING_SECRET' },
        }),
      ],
      { fetchFn },
    );

    await expect(provider.execute('test-tool', {}, mockCtx)).rejects.toThrow(
      'missing secret "MISSING_SECRET"',
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------- Timeout ----------

describe('HTTPToolProvider – timeout handling', () => {
  it('should abort request after timeout', async () => {
    const fetchFn = vi.fn().mockImplementation(
      (_url: string, opts: RequestInit) => {
        return new Promise((_resolve, reject) => {
          // Listen for abort
          opts.signal?.addEventListener('abort', () => {
            const err = new DOMException('The operation was aborted.', 'AbortError');
            reject(err);
          });
        });
      },
    ) as unknown as typeof fetch;

    const provider = new HTTPToolProvider(
      [makeEndpoint({ timeout: 50 })],
      { fetchFn },
    );

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/timed out after 50ms/);
  });
});

// ---------- Error handling ----------

describe('HTTPToolProvider – error handling', () => {
  it('should throw on non-200 response', async () => {
    const fetchFn = mockFetch('{"error":"not found"}', 404, 'Not Found');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/HTTP 404 Not Found/);
  });

  it('should include response body in error message', async () => {
    const fetchFn = mockFetch('{"message":"Forbidden access"}', 403, 'Forbidden');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/Forbidden access/);
  });

  it('should throw on 500 server error', async () => {
    const fetchFn = mockFetch('Internal Server Error', 500, 'Internal Server Error');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('should throw for unknown tool name', async () => {
    const provider = new HTTPToolProvider([makeEndpoint()], {
      fetchFn: mockFetch(),
    });

    await expect(
      provider.execute('nonexistent', {}, mockCtx),
    ).rejects.toThrow(/unknown tool "nonexistent"/);
  });

  it('should propagate network errors', async () => {
    const fetchFn = vi.fn().mockRejectedValue(
      new TypeError('fetch failed'),
    ) as unknown as typeof fetch;

    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow('fetch failed');
  });
});

// ---------- Handler integration ----------

describe('HTTPToolProvider – handler integration', () => {
  it('tool handler from listTools() should delegate to execute()', async () => {
    const fetchFn = mockFetch('{"data":"from-handler"}');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const tools = await provider.listTools();
    const result = await tools[0].handler({ key: 'val' }, mockCtx);

    expect(result).toBe('{"data":"from-handler"}');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
