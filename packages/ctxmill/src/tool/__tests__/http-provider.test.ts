import { describe, expect, it, vi } from 'vitest';
import { HTTPToolProvider } from '../providers/http.js';
import type { ToolContext } from '../types.js';

function makeCtx(): ToolContext {
  return {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    workspaceDir: '/tmp',
    knowledge: {
      query: async () => ({ items: [] }),
    },
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
