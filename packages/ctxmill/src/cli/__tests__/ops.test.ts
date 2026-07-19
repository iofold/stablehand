import { afterEach, describe, expect, it, vi } from 'vitest';

import { runOpsCli } from '../ops.js';

describe('versioned operational CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.CTXMILL_API_TOKEN;
  });

  it('emits a stable JSON envelope and applies Bearer auth', async () => {
    process.env.CTXMILL_API_TOKEN = 'operator-token';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify({ status: 'ok' }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const exitCode = await runOpsCli([
      'health',
      '--base-url',
      'https://platform.example.test',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://platform.example.test/api/health');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer operator-token');
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      command: 'health',
      baseUrl: 'https://platform.example.test',
      endpoint: 'GET /api/health',
      data: { status: 'ok' },
      warnings: [],
    });
  });

  it('blocks destructive operations without an explicit confirmation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const exitCode = await runOpsCli([
      'agents',
      'delete',
      'agent-123',
      '--json',
    ]);

    expect(exitCode).toBe(4);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      error: 'unsafe_operation_blocked',
      retryable: false,
    });
  });

  it('validates and describes a mutation without making a request in dry-run mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const exitCode = await runOpsCli([
      'agents',
      'delete',
      'agent-123',
      '--dry-run',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      command: 'agents delete (dry-run)',
      data: {
        dryRun: true,
        method: 'DELETE',
        endpoint: '/api/agents/agent-123',
      },
    });
  });

  it('reads conversation snapshots and removes the unbounded messages command', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      conversationId: 'conversation-1',
      eventCursor: '000000000042',
      messages: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runOpsCli([
      'conversations',
      'snapshot',
      'agent-1',
      'conversation-1',
      '--json',
    ])).resolves.toBe(0);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:3002/api/agents/agent-1/conversations/conversation-1/snapshot',
    );
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      command: 'conversations snapshot',
      data: {
        conversationId: 'conversation-1',
        eventCursor: '000000000042',
        messages: [],
      },
    });

    fetchMock.mockClear();
    await expect(runOpsCli([
      'conversations',
      'messages',
      'agent-1',
      'conversation-1',
      '--json',
    ])).resolves.toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  });
});
