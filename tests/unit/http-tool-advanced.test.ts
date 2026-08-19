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
      const body = opts.body as string;
      const parsed = JSON.parse(body);
      // Reverse-order completion deterministically exercises interleaving.
      const delay = (4 - (parsed.id as number)) * 10;
      await new Promise((resolve) => setTimeout(resolve, delay));
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
      [makeEndpoint({ timeoutMs: 100 })],
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
  it.each([
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
    [500, 'Internal Server Error'],
    [503, 'Service Unavailable'],
  ])('maps HTTP %i to the shared error branch', async (status, statusText) => {
    const fetchFn = mockFetch('error response', status, statusText);
    const provider = new HTTPToolProvider([makeEndpoint()], { fetchFn });

    await expect(
      provider.execute('test-tool', {}, mockCtx),
    ).rejects.toThrow(`HTTP ${status} ${statusText}`);
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
