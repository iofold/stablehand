import { describe, expect, it, vi } from 'vitest';
import { HTTPToolProvider, type HttpEndpointConfig } from '../providers/http.js';
import * as httpProvider from '../providers/http.js';
import type { ToolContext } from '@stablehand/sandbox-daemon';

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

    await expect(provider.execute('remote-search', { q: 'stablehand' }, makeCtx())).resolves.toBe('ok');
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
      validEndpoint({ timeoutMs: 0 }),
    ])).toThrow(/"timeoutMs" must be a positive finite number/);

    expect(() => new HTTPToolProvider([
      validEndpoint({ timeoutMs: -1 }),
    ])).toThrow(/"timeoutMs" must be a positive finite number/);
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


describe('HTTP provider configuration grants', () => {
  const endpoint = (): HttpEndpointConfig => ({
    name: 'remote', description: 'Remote tool', url: 'https://api.example.com/tool', method: 'POST',
    headers: { 'X-Tool-Secret': 'synthetic-only' },
    authentication: { type: 'bearer', secretName: 'TOOL_TOKEN' },
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  });

  it('exposes only a stable hash of the cached declaration and ignores object key order', () => {
    expect(httpProvider.httpEndpointConfigFingerprint).toBeTypeOf('function');
    const original = endpoint();
    const reordered = {
      ...original,
      authentication: { secretName: 'TOOL_TOKEN', type: 'bearer' as const },
      inputSchema: { properties: { message: { type: 'string' } }, type: 'object' },
      timeoutMs: 30_000, requiresApproval: false, programmatic: false,
    };
    const provider = new HTTPToolProvider([original]);
    expect(provider.configurationFingerprint('remote')).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.configurationFingerprint('remote')).toBe(httpProvider.httpEndpointConfigFingerprint(reordered));
    expect(provider.configurationFingerprint('missing')).toBeUndefined();
  });

  it.each([
    { url: 'https://api.example.com/other' },
    { method: 'DELETE' as const },
    { authentication: { type: 'api-key' as const, secretName: 'TOOL_TOKEN' } },
    { authentication: { type: 'bearer' as const, secretName: 'OTHER_TOKEN' } },
    { headers: { 'X-Tool-Secret': 'changed-synthetic-only' } },
    { requiresApproval: true },
    { inputSchema: { type: 'object', properties: { message: { type: 'number' } } } },
    { programmatic: true },
    { timeoutMs: 12_000 },
  ])('detects an execution-relevant declaration change %j', (change) => {
    expect(httpProvider.httpEndpointConfigFingerprint).toBeTypeOf('function');
    const original = endpoint();
    expect(httpProvider.httpEndpointConfigFingerprint({ ...original, ...change }))
      .not.toBe(httpProvider.httpEndpointConfigFingerprint(original));
  });

  it('keeps the cached executable declaration separate from caller-owned objects', async () => {
    const original = endpoint();
    const fetchFn = vi.fn(async () => new Response('ok'));
    const provider = new HTTPToolProvider([original], { fetchFn, secrets: { TOOL_TOKEN: 'synthetic' } });
    expect(provider.configurationFingerprint).toBeTypeOf('function');
    const fingerprint = provider.configurationFingerprint('remote');
    await provider.listTools();
    original.url = 'https://changed.example.com/tool';
    original.requiresApproval = true;
    original.headers!['X-Tool-Secret'] = 'mutated';
    await provider.execute('remote', {}, makeCtx());
    expect(provider.configurationFingerprint('remote')).toBe(fingerprint);
    expect(fetchFn).toHaveBeenCalledWith('https://api.example.com/tool', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Tool-Secret': 'synthetic-only' }),
    }));
  });
});
