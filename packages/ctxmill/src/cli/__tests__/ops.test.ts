import { spawnSync } from 'node:child_process';
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
      JSON.stringify({
        status: 'ok',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
          tokenReportedTurnCount: 1,
          modelCallCount: 2,
        },
        apiToken: 'response-secret',
        authorization: 'Bearer response-secret',
        clientSecret: 'response-secret',
      }),
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
      data: {
        status: 'ok',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
          tokenReportedTurnCount: 1,
          modelCallCount: 2,
        },
        apiToken: '[REDACTED]',
        authorization: '[REDACTED]',
        clientSecret: '[REDACTED]',
      },
      warnings: [],
    });
  });

  it('forwards event correlation filters without payload parsing', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ events: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const exitCode = await runOpsCli([
      'events',
      'list',
      '--turn',
      'turn-1',
      '--conversation',
      'conversation-1',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:3002/api/events?turnId=turn-1&conversationId=conversation-1&limit=50',
    );
  });

  it('validates custom event names locally and defaults the payload to an object', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const accepted = await runOpsCli([
      'triggers',
      'emit',
      '--type',
      'custom.eval.verdict',
      '--dry-run',
      '--json',
    ]);
    expect(accepted).toBe(0);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      data: {
        endpoint: '/api/triggers/emit',
        body: { type: 'custom.eval.verdict', payload: {} },
      },
    });

    const rejected = await runOpsCli([
      'triggers',
      'emit',
      '--type',
      'eval.verdict',
      '--dry-run',
      '--json',
    ]);
    expect(rejected).toBe(2);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0])))
      .toMatchObject({ error: 'usage_error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates canonical schedule mutations locally', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const accepted = await runOpsCli([
      'schedules',
      'create',
      '--data',
      JSON.stringify({
        agentId: 'agent-1',
        name: 'weekly-canary',
        cronExpression: '0 9 * * 1',
        eventType: 'custom.schedule.weekly-canary',
        payload: {},
      }),
      '--dry-run',
      '--json',
    ]);
    expect(accepted).toBe(0);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      data: {
        endpoint: '/api/schedules',
        body: {
          agentId: 'agent-1',
          name: 'weekly-canary',
          cronExpression: '0 9 * * 1',
          eventType: 'custom.schedule.weekly-canary',
          payload: {},
        },
      },
    });

    const rejected = await runOpsCli([
      'schedules',
      'create',
      '--data',
      JSON.stringify({
        agentId: 'agent-1',
        name: 'invalid',
        cronExpression: '* * * * *',
        eventType: 'schedule.invalid',
        payload: {},
      }),
      '--dry-run',
      '--json',
    ]);
    expect(rejected).toBe(2);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({ error: 'usage_error' });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('rejects a contract-invalid agent create during dry-run without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const exitCode = await runOpsCli([
      'agents',
      'create',
      '--data',
      JSON.stringify({ name: 'missing-required-agent-fields' }),
      '--dry-run',
      '--json',
    ]);

    expect(exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      error: 'usage_error',
      retryable: false,
    });
  });

  it('previews an agent patch using the canonical PATCH contract', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const exitCode = await runOpsCli([
      'agents',
      'update',
      'agent-1',
      '--data',
      JSON.stringify({ description: 'Canonical patch' }),
      '--dry-run',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      data: {
        dryRun: true,
        method: 'PATCH',
        endpoint: '/api/agents/agent-1',
        body: { description: 'Canonical patch' },
      },
    });
  });

  it.each([
    [
      'a reserved sandbox secret',
      ['turns', 'start', 'agent-1', '--task', 'test', '--sandbox-secrets', JSON.stringify({ CTXMILL_API_TOKEN: 'forbidden' })],
    ],
    [
      'a webhook without its required signing secret',
      ['webhooks', 'add', 'agent-1', '--url', 'https://example.test/hook', '--events', 'turn.completed'],
    ],
  ])('rejects %s during canonical dry-run validation', async (_caseName, command) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const exitCode = await runOpsCli([...command, '--dry-run', '--json']);

    expect(exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('previews a partial webhook update through the canonical PATCH contract', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const exitCode = await runOpsCli([
      'webhooks',
      'update',
      'agent-1',
      'webhook-1',
      '--data',
      JSON.stringify({ events: ['turn.completed'] }),
      '--dry-run',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      data: {
        dryRun: true,
        method: 'PATCH',
        endpoint: '/api/agents/agent-1/webhooks/webhook-1',
        body: { events: ['turn.completed'] },
      },
    });
  });

  it.each([
    ['feedback', 'stats', 'agent-1'],
    ['traces', 'list', 'agent-1'],
    ['knowledge', 'search', 'agent-1'],
    ['agents', 'versions', 'agent-1'],
  ])('rejects the removed %s %s command without making a request', async (...command) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const exitCode = await runOpsCli([...command, '--json']);

    expect(exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('documents only the implemented exit codes and commands', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const exitCode = await runOpsCli(['help']);

    expect(exitCode).toBe(0);
    const help = String(stdout.mock.calls[0]?.[0]);
    expect(help).toContain('Exit codes: 0=ok 1=api/runtime 2=usage 3=timeout 4=unsafe-blocked');
    expect(help).not.toContain('5=unexpected-shape');
    expect(help).not.toContain('feedback stats');
    expect(help).not.toContain('traces list');
    expect(help).not.toContain('knowledge search');
    expect(help).not.toContain('agents versions');
  });

  it('uses the bundled skill invocation in its help without accepting an ops alias', () => {
    const script = '.codex/skills/ctxmill-cli/scripts/ctxmill.ts';
    const help = spawnSync('bun', [script, 'help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('Usage:\n  bun scripts/ctxmill.ts <command>');
    expect(help.stdout).toContain('bun scripts/ctxmill.ts health --json');
    expect(help.stdout).not.toContain('ctxmill ops');

    const rejectedAlias = spawnSync(
      'bun',
      [script, 'ops', 'health', '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    expect(rejectedAlias.status).toBe(2);
    expect(rejectedAlias.stdout).toBe('');
    expect(JSON.parse(rejectedAlias.stderr)).toMatchObject({
      error: 'usage_error',
      hint: 'Run `bun scripts/ctxmill.ts help` to inspect commands and required arguments.',
    });
    expect(rejectedAlias.stderr).not.toContain('ctxmill ops');
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
