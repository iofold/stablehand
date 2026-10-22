import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { LiteLLMKeyAdminError, LiteLLMKeyClient } from './litellm-key-client.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return new LiteLLMKeyClient({
    baseUrl: 'http://litellm:4000/',
    adminKey: 'admin-secret',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function call(fetchImpl: ReturnType<typeof vi.fn>, index = 0): { url: string; init: RequestInit; body: unknown } {
  const [url, init] = fetchImpl.mock.calls[index] as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

describe('LiteLLMKeyClient', () => {
  it('generates a session key with alias, model scope, budget and expiry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      key: 'sk-session-secret',
      token: 'hash-1',
      key_alias: 'stablehand-session-s1',
    }));

    const minted = await makeClient(fetchImpl).generateKey({
      keyAlias: 'stablehand-session-s1',
      models: ['gpt-5.4-mini', 'claude-haiku-4-5'],
      maxBudgetUsd: null,
      duration: '24h',
      metadata: { stablehand_session_id: 's1' },
    });

    expect(minted).toEqual({ key: 'sk-session-secret', tokenHash: 'hash-1' });
    const { url, init, body } = call(fetchImpl);
    expect(url).toBe('http://litellm:4000/key/generate');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer admin-secret');
    expect(body).toEqual({
      key_alias: 'stablehand-session-s1',
      models: ['gpt-5.4-mini', 'claude-haiku-4-5'],
      max_budget: null,
      duration: '24h',
      metadata: { stablehand_session_id: 's1' },
    });
  });

  it('resets spend together with the new budget on update', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ key: 'hash-1', max_budget: 0.05, spend: 0 }));

    await makeClient(fetchImpl).updateKey({
      key: 'hash-1',
      maxBudgetUsd: 0.05,
      resetSpend: true,
      duration: '24h',
    });

    expect(call(fetchImpl)).toMatchObject({
      url: 'http://litellm:4000/key/update',
      body: { key: 'hash-1', max_budget: 0.05, duration: '24h', spend: 0 },
    });
  });

  it('deletes by alias and treats an already-deleted key as success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ deleted_keys: ['stablehand-session-s1'] }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Key not found' } }, 404));
    const client = makeClient(fetchImpl);

    await client.deleteKeysByAlias(['stablehand-session-s1']);
    await client.deleteKeysByAlias(['stablehand-session-s1']);
    await client.deleteKeysByAlias([]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(call(fetchImpl).body).toEqual({ key_aliases: ['stablehand-session-s1'] });
  });

  it('reads the model allowlist of the shared runtime key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      key: 'hash-runtime',
      info: { models: ['gpt-5.4-mini'], key_alias: 'stablehand-runtime' },
    }));

    await expect(makeClient(fetchImpl).getKeyModels('sk-runtime')).resolves.toEqual(['gpt-5.4-mini']);
    // The secret travels as LiteLLM's token hash, never in the URL.
    const sent = new URL(call(fetchImpl).url).searchParams.get('key');
    expect(sent).toBe(createHash('sha256').update('sk-runtime').digest('hex'));
    expect(call(fetchImpl).url).not.toContain('sk-runtime');
  });

  it('finds a key hash by alias', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      keys: [{ token: 'hash-9', key_alias: 'stablehand-session-s9' }],
      total_count: 1,
    }));

    await expect(makeClient(fetchImpl).findKeyHashByAlias('stablehand-session-s9')).resolves.toBe('hash-9');
    const url = new URL(call(fetchImpl).url);
    expect(url.pathname).toBe('/key/list');
    expect(url.searchParams.get('key_alias')).toBe('stablehand-session-s9');
    expect(url.searchParams.get('return_full_object')).toBe('true');
  });

  it('reports failures without echoing key material', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      error: { message: "Key with alias 'x' already exists for sk-abcdef123456 hash 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
    }, 400));

    const failure = await makeClient(fetchImpl).generateKey({
      keyAlias: 'x',
      models: [],
      maxBudgetUsd: null,
      duration: '24h',
      metadata: {},
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(LiteLLMKeyAdminError);
    const message = (failure as Error).message;
    expect(message).toContain('HTTP 400');
    expect(message).toContain('already exists');
    expect(message).not.toContain('sk-abcdef123456');
    expect(message).not.toContain('0123456789abcdef0123456789abcdef');
    expect(message).not.toContain('admin-secret');
  });

  it('wraps network failures', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(makeClient(fetchImpl).updateKey({
      key: 'hash-1',
      maxBudgetUsd: null,
      resetSpend: false,
      duration: '24h',
    })).rejects.toThrow(/LiteLLM key\/update failed: fetch failed/);
  });
});
