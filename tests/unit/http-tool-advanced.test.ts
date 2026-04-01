import { describe, it, expect, vi } from 'vitest';
import { HTTPToolProvider } from '../../packages/ctxmill/src/tool/providers/http.js';
import { createMockToolContext } from '../utils/event-bus-test-helpers.js';
import type { HttpEndpointConfig } from '../../packages/ctxmill/src/tool/providers/http.js';

const mockCtx = createMockToolContext();

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

// ---------- Concurrent execution ----------

describe('HTTPToolProvider – concurrent execution', () => {
  it('should handle 5 parallel tool executions without interference', async () => {
    const fetchFn = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      // Simulate variable response times
      const delay = Math.random() * 50;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const body = opts.body as string;
      const parsed = JSON.parse(body);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: vi.fn().mockResolvedValue(JSON.stringify({ input: parsed, processed: true })),
      };
    }) as unknown as typeof fetch;

    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const promises = Array.from({ length: 5 }, (_, i) =>
      provider.execute('test-tool', { id: i, data: `request-${i}` }, mockCtx),
    );

    const results = await Promise.all(promises);

    expect(results).toHaveLength(5);
    expect(fetchFn).toHaveBeenCalledTimes(5);

    // Verify each result contains the correct input
    results.forEach((result, i) => {
      const parsed = JSON.parse(result);
      expect(parsed.input.id).toBe(i);
      expect(parsed.input.data).toBe(`request-${i}`);
    });
  });
});

// ---------- Timeout via AbortController ----------

describe('HTTPToolProvider – timeout with AbortController', () => {
  it('should abort request after timeout and throw error', async () => {
    const fetchFn = vi.fn().mockImplementation(
      (_url: string, opts: RequestInit) => {
        return new Promise((_resolve, reject) => {
          // Listen for abort signal
          opts.signal?.addEventListener('abort', () => {
            const err = new DOMException('The operation was aborted.', 'AbortError');
            reject(err);
          });
          // Simulate a long-running request that never completes
          // (timeout will abort before this resolves)
        });
      },
    ) as unknown as typeof fetch;

    const provider = new HTTPToolProvider(
      [makeEndpoint({ timeout: 100 })],
      { fetchFn },
    );

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/timed out after 100ms/);
  });
});

// ---------- Network error handling ----------

describe('HTTPToolProvider – network error recovery', () => {
  it('should capture network error (fetch throws) and not suppress it', async () => {
    const networkError = new TypeError('Network request failed');
    const fetchFn = vi.fn().mockRejectedValue(networkError) as unknown as typeof fetch;

    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow('Network request failed');
  });

  it('should handle fetch error with custom message', async () => {
    const customError = new Error('ECONNREFUSED: Connection refused');
    const fetchFn = vi.fn().mockRejectedValue(customError) as unknown as typeof fetch;

    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow('ECONNREFUSED: Connection refused');
  });
});

// ---------- Non-JSON response body ----------

describe('HTTPToolProvider – non-JSON response handling', () => {
  it('should handle non-JSON response body gracefully', async () => {
    const fetchFn = mockFetch('<html><body>Not JSON</body></html>', 200, 'OK');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const result = await provider.execute('test-tool', {}, mockCtx);

    expect(result).toBe('<html><body>Not JSON</body></html>');
  });

  it('should handle plain text response', async () => {
    const fetchFn = mockFetch('Plain text response', 200, 'OK');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const result = await provider.execute('test-tool', {}, mockCtx);

    expect(result).toBe('Plain text response');
  });

  it('should handle XML response', async () => {
    const xmlBody = '<?xml version="1.0"?><root><item>test</item></root>';
    const fetchFn = mockFetch(xmlBody, 200, 'OK');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const result = await provider.execute('test-tool', {}, mockCtx);

    expect(result).toBe(xmlBody);
  });
});

// ---------- HTTP error responses ----------

describe('HTTPToolProvider – HTTP error response mapping', () => {
  it('should map HTTP 400 to error result', async () => {
    const fetchFn = mockFetch('{"error":"Bad request"}', 400, 'Bad Request');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/HTTP 400 Bad Request/);
  });

  it('should map HTTP 401 to error result', async () => {
    const fetchFn = mockFetch('{"error":"Unauthorized"}', 401, 'Unauthorized');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/HTTP 401 Unauthorized/);
  });

  it('should map HTTP 403 to error result', async () => {
    const fetchFn = mockFetch('{"error":"Forbidden"}', 403, 'Forbidden');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/HTTP 403 Forbidden/);
  });

  it('should map HTTP 404 to error result', async () => {
    const fetchFn = mockFetch('{"error":"Not found"}', 404, 'Not Found');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/HTTP 404 Not Found/);
  });

  it('should map HTTP 500 to error result', async () => {
    const fetchFn = mockFetch('Internal Server Error', 500, 'Internal Server Error');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/HTTP 500 Internal Server Error/);
  });

  it('should map HTTP 503 to error result', async () => {
    const fetchFn = mockFetch('Service Unavailable', 503, 'Service Unavailable');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(/HTTP 503 Service Unavailable/);
  });
});

// ---------- Empty response body ----------

describe('HTTPToolProvider – empty response body handling', () => {
  it('should handle empty response body gracefully', async () => {
    const fetchFn = mockFetch('', 200, 'OK');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const result = await provider.execute('test-tool', {}, mockCtx);

    expect(result).toBe('');
  });

  it('should handle whitespace-only response body', async () => {
    const fetchFn = mockFetch('   \n\t  ', 200, 'OK');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const result = await provider.execute('test-tool', {}, mockCtx);

    expect(result).toBe('   \n\t  ');
  });
});

// ---------- Custom headers merging ----------

describe('HTTPToolProvider – custom headers merging', () => {
  it('should merge custom headers with auto-injected headers', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [
        makeEndpoint({
          headers: {
            'X-Custom-Header': 'custom-value',
            'X-Request-Id': 'req-12345',
          },
        }),
      ],
      { fetchFn },
    );

    await provider.execute('test-tool', {}, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Agent-Id': 'test-agent',
          'X-Conversation-Id': 'test-conv',
          'X-Instance-Id': 'run-123',
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
          'X-Request-Id': 'req-12345',
        }),
      }),
    );
  });

  it('should allow custom headers to override Content-Type', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [
        makeEndpoint({
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }),
      ],
      { fetchFn },
    );

    await provider.execute('test-tool', {}, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );
  });
});

// ---------- Bearer vs API-key auth header format ----------

describe('HTTPToolProvider – auth header format verification', () => {
  it('should format Bearer token as "Bearer <token>"', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [
        makeEndpoint({
          authentication: { type: 'bearer', secretName: 'AUTH_TOKEN' },
        }),
      ],
      { fetchFn, secrets: { AUTH_TOKEN: 'my-jwt-token-xyz' } },
    );

    await provider.execute('test-tool', {}, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-jwt-token-xyz',
        }),
      }),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.not.objectContaining({
          'X-API-Key': expect.anything(),
        }),
      }),
    );
  });

  it('should format API-key as X-API-Key header', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [
        makeEndpoint({
          authentication: { type: 'api-key', secretName: 'API_KEY' },
        }),
      ],
      { fetchFn, secrets: { API_KEY: 'sk-1234567890' } },
    );

    await provider.execute('test-tool', {}, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'sk-1234567890',
        }),
      }),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
        }),
      }),
    );
  });

  it('should not mix Bearer and API-key headers', async () => {
    const fetchFn = mockFetch();
    const provider = new HTTPToolProvider(
      [
        makeEndpoint({
          authentication: { type: 'bearer', secretName: 'TOKEN' },
        }),
      ],
      { fetchFn, secrets: { TOKEN: 'token-value' } },
    );

    await provider.execute('test-tool', {}, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-value',
        }),
      }),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        headers: expect.not.objectContaining({
          'X-API-Key': expect.anything(),
        }),
      }),
    );
  });
});

// ---------- Tool with no input schema ----------

describe('HTTPToolProvider – tool with no input schema', () => {
  it('should accept calls to tool with no input schema', async () => {
    const fetchFn = mockFetch('{"status":"ok"}');
    const provider = new HTTPToolProvider(
      [makeEndpoint({ inputSchema: undefined })],
      { fetchFn },
    );

    const tools = await provider.listTools();
    const schema = tools[0].input as { safeParse: (value: unknown) => { success: boolean } };
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ anyKey: 'anyValue' }).success).toBe(true);

    const result = await provider.execute('test-tool', {}, mockCtx);
    expect(result).toBe('{"status":"ok"}');
  });

  it('should accept arbitrary input when no schema defined', async () => {
    const fetchFn = mockFetch('{"result":"processed"}');
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const tools = await provider.listTools();
    const schema = tools[0].input as { safeParse: (value: unknown) => { success: boolean } };

    // Should accept empty object
    expect(schema.safeParse({}).success).toBe(true);

    // Should accept any object
    expect(
      schema.safeParse({
        foo: 'bar',
        nested: { key: 'value' },
        array: [1, 2, 3],
      }).success,
    ).toBe(true);
  });

  it('should pass arbitrary input to handler when no schema', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('{"ok":true}'),
    }) as unknown as typeof fetch;

    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    const arbitraryInput = {
      custom: 'data',
      nested: { value: 42 },
    };

    await provider.execute('test-tool', arbitraryInput, mockCtx);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/action',
      expect.objectContaining({
        body: JSON.stringify(arbitraryInput),
      }),
    );
  });
});
