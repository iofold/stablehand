import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPToolProvider } from '../../packages/ctxmill/src/tool/providers/http.js';
import type { HttpEndpointConfig } from '../../packages/ctxmill/src/tool/providers/http.js';
import type { ToolContext } from '../../packages/ctxmill/src/tool/types.js';

const mockCtx: ToolContext = {
  agentId: 'test-agent',
  conversationId: 'test-conv',
  instanceId: 'run-123',
  workspaceDir: '/tmp/test',
  knowledge: {
    query: async () => ({ items: [] }),
  },
};

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
    const schema = tools[0].input;

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
    expect(tools[0].input.safeParse({}).success).toBe(true);
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

    const [url, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/run');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ input: 'data' });

    const headers = options.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Agent-Id']).toBe('test-agent');
    expect(headers['X-Conversation-Id']).toBe('test-conv');
    expect(headers['X-Instance-Id']).toBe('run-123');
  });

  it('should not include X-Instance-Id when instanceId is missing', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const ctxNoInstance: ToolContext = {
      ...mockCtx,
      instanceId: undefined,
    };

    await provider.execute('test-tool', {}, ctxNoInstance);

    const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['X-Instance-Id']).toBeUndefined();
  });

  it('should not send body for GET requests', async () => {
    const fetchFn = mockFetch('[]');
    const provider = new HTTPToolProvider(
      [makeEndpoint({ method: 'GET' })],
      { fetchFn },
    );

    await provider.execute('test-tool', { q: 'hello' }, mockCtx);

    const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('GET');
    expect(options.body).toBeUndefined();
  });

  it('should merge static headers from endpoint config', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [makeEndpoint({ headers: { 'X-Custom': 'value', Accept: 'text/plain' } })],
      { fetchFn },
    );

    await provider.execute('test-tool', {}, mockCtx);

    const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('value');
    expect(headers['Accept']).toBe('text/plain');
  });

  it('should send PUT requests with body', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [makeEndpoint({ method: 'PUT' })],
      { fetchFn },
    );

    await provider.execute('test-tool', { id: 1, name: 'test' }, mockCtx);

    const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body as string)).toEqual({ id: 1, name: 'test' });
  });

  it('should send DELETE requests with body', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [makeEndpoint({ method: 'DELETE' })],
      { fetchFn },
    );

    await provider.execute('test-tool', { id: 42 }, mockCtx);

    const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('DELETE');
    expect(JSON.parse(options.body as string)).toEqual({ id: 42 });
  });

  it('should send PATCH requests with body', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [makeEndpoint({ method: 'PATCH' })],
      { fetchFn },
    );

    await provider.execute('test-tool', { status: 'done' }, mockCtx);

    const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ status: 'done' });
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

    const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-jwt-token');
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

    const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('abc-123');
  });

  it('should fall back to process.env for secrets', async () => {
    const originalEnv = process.env.FALLBACK_SECRET;
    process.env.FALLBACK_SECRET = 'env-secret';

    try {
      const fetchFn = mockFetch();
      const provider = new HTTPToolProvider(
        [
          makeEndpoint({
            authentication: { type: 'bearer', secretName: 'FALLBACK_SECRET' },
          }),
        ],
        { fetchFn },
      );

      await provider.execute('test-tool', {}, mockCtx);

      const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer env-secret');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.FALLBACK_SECRET;
      } else {
        process.env.FALLBACK_SECRET = originalEnv;
      }
    }
  });

  it('should not set auth header when secret is not found', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [
        makeEndpoint({
          authentication: { type: 'bearer', secretName: 'MISSING_SECRET' },
        }),
      ],
      { fetchFn },
    );

    await provider.execute('test-tool', {}, mockCtx);

    const [, options] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
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
