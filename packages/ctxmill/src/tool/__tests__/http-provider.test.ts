import { describe, expect, it, vi } from 'vitest';
import { HTTPToolProvider, type HttpEndpointConfig } from '../providers/http.js';
import type { ToolContext } from '../types.js';

function makeCtx(): ToolContext {
  return {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    workspaceDir: '/tmp',
  };
}

describe('HTTPToolProvider', () => {
  it('requires explicit scoped secrets by default instead of falling back to process.env', async () => {
    process.env.REMOTE_API_KEY = 'ambient-secret';
    const fetchFn = vi.fn();
    const provider = new HTTPToolProvider([{
      name: 'remote-search',
      description: 'Search remote API',
      url: 'https://api.example.com/search',
      method: 'POST',
      authentication: { type: 'bearer', secretName: 'REMOTE_API_KEY' },
    }], { fetchFn: fetchFn as unknown as typeof fetch });

    await expect(provider.execute('remote-search', {}, makeCtx())).rejects.toThrow(
      'missing secret "REMOTE_API_KEY"',
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows ambient env fallback only when endpoint config opts in', async () => {
    process.env.REMOTE_API_KEY = 'ambient-secret';
    const fetchFn = vi.fn(async () => new Response('ok'));
    const provider = new HTTPToolProvider([{
      name: 'remote-search',
      description: 'Search remote API',
      url: 'https://api.example.com/search',
      method: 'POST',
      authentication: { type: 'bearer', secretName: 'REMOTE_API_KEY', allowEnvFallback: true },
    }], { fetchFn: fetchFn as unknown as typeof fetch });

    await expect(provider.execute('remote-search', { q: 'ctxmill' }, makeCtx())).resolves.toBe('ok');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/search',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer ambient-secret' }),
      }),
    );
  });
});

describe('HTTPToolProvider – fail-closed config validation', () => {
  function validEndpoint(overrides?: Partial<HttpEndpointConfig>): HttpEndpointConfig {
    return {
      name: 'remote-search',
      description: 'Search remote API',
      url: 'https://api.example.com/search',
      method: 'POST',
      ...overrides,
    };
  }

  it('rejects non-array endpoints input at construction time', () => {
    expect(() => new HTTPToolProvider(undefined as unknown as HttpEndpointConfig[])).toThrow(
      /endpoints must be an array/,
    );
    expect(() => new HTTPToolProvider({} as unknown as HttpEndpointConfig[])).toThrow(
      /endpoints must be an array/,
    );
  });

  it('rejects an invalid HTTP method instead of silently coercing it', () => {
    expect(() => new HTTPToolProvider([
      validEndpoint({ method: 'TRACE' as unknown as HttpEndpointConfig['method'] }),
    ])).toThrow(/invalid HTTP method "TRACE"/);
  });

  it('rejects a missing HTTP method (no implicit POST default)', () => {
    expect(() => new HTTPToolProvider([
      // method intentionally omitted to simulate ambiguous config
      { name: 'x', url: 'https://example.com', description: 'd' } as unknown as HttpEndpointConfig,
    ])).toThrow(/invalid HTTP method "undefined"/);
  });

  it('rejects an empty name', () => {
    expect(() => new HTTPToolProvider([
      validEndpoint({ name: '' }),
    ])).toThrow(/requires a non-empty "name"/);
  });

  it('rejects a missing url', () => {
    expect(() => new HTTPToolProvider([
      validEndpoint({ url: '' }),
    ])).toThrow(/requires a non-empty "url"/);
  });

  it('rejects a missing description', () => {
    expect(() => new HTTPToolProvider([
      validEndpoint({ description: '' }),
    ])).toThrow(/requires a non-empty "description"/);
  });

  it('rejects malformed authentication config', () => {
    expect(() => new HTTPToolProvider([
      validEndpoint({
        authentication: { type: 'oauth' as 'bearer', secretName: 'X' },
      }),
    ])).toThrow(/authentication.type must be "bearer" or "api-key"/);

    expect(() => new HTTPToolProvider([
      validEndpoint({
        authentication: { type: 'bearer', secretName: '' },
      }),
    ])).toThrow(/authentication.secretName must be a non-empty string/);
  });

  it('rejects non-positive timeout values', () => {
    expect(() => new HTTPToolProvider([
      validEndpoint({ timeout: 0 }),
    ])).toThrow(/"timeout" must be a positive finite number/);

    expect(() => new HTTPToolProvider([
      validEndpoint({ timeout: -1 }),
    ])).toThrow(/"timeout" must be a positive finite number/);
  });

  it('rejects malformed headers (non-string values)', () => {
    expect(() => new HTTPToolProvider([
      validEndpoint({ headers: { 'X-Bad': 1 } as unknown as Record<string, string> }),
    ])).toThrow(/header "X-Bad" must be a string/);
  });

  it('rejects duplicate endpoint names within the same provider', () => {
    expect(() => new HTTPToolProvider([
      validEndpoint({ name: 'dup' }),
      validEndpoint({ name: 'dup' }),
    ])).toThrow(/duplicate endpoint name "dup"/);
  });

  it('accepts a fully valid endpoint without error', () => {
    expect(() => new HTTPToolProvider([
      validEndpoint({
        method: 'PATCH',
        timeout: 5000,
        headers: { 'X-Custom': 'value' },
        authentication: { type: 'api-key', secretName: 'API_KEY' },
      }),
    ])).not.toThrow();
  });
});
