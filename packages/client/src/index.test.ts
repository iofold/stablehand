import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import * as clientModule from './index.js';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CtxmillControlClient', () => {
  it('exposes canonical schedule CRUD without embedding scheduler logic', async () => {
    const schedule = {
      id: 'schedule-1',
      agentId: 'agent-1',
      name: 'weekly-canary',
      cronExpression: '0 9 * * 1',
      timezone: 'UTC',
      eventType: 'custom.schedule.weekly-canary',
      payload: {},
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      lastFiredAt: null,
      nextRun: 2,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ schedules: [schedule] }))
      .mockResolvedValueOnce(jsonResponse(schedule))
      .mockResolvedValueOnce(jsonResponse(schedule))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.schedules.list()).resolves.toEqual({ schedules: [schedule] });
    await expect(client.schedules.create({
      agentId: 'agent-1',
      name: 'weekly-canary',
      cronExpression: '0 9 * * 1',
      eventType: 'custom.schedule.weekly-canary',
      payload: {},
    })).resolves.toEqual(schedule);
    await expect(client.schedules.update('schedule-1', { enabled: false })).resolves.toEqual(schedule);
    await expect(client.schedules.delete('schedule-1')).resolves.toBeUndefined();

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://ctxmill.test/api/schedules', 'GET'],
      ['https://ctxmill.test/api/schedules', 'POST'],
      ['https://ctxmill.test/api/schedules/schedule-1', 'PATCH'],
      ['https://ctxmill.test/api/schedules/schedule-1', 'DELETE'],
    ]);
  });

  it('patches agents through the canonical partial-update contract', async () => {
    const updatedAgent = {
      id: 'agent-1',
      name: 'Agent one',
      harness: 'claude-agents',
      harnessConfig: {},
      systemPrompt: 'Help.',
      tools: [],
      description: 'Updated description',
      workspaceDir: null,
      status: 'active',
      manifest: null,
      metadata: null,
      createdAt: 1,
      updatedAt: 2,
      builtinToolPolicy: null,
      nativeToolPolicy: null,
      httpTools: [],
      workspaceContent: null,
      mode: null,
      resourceLimits: null,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(updatedAgent));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.agents.update('agent-1', {
      description: 'Updated description',
    })).resolves.toMatchObject({ description: 'Updated description' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ctxmill.test/api/agents/agent-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ description: 'Updated description' }),
      }),
    );
  });

  it('rejects an empty agent patch before transport', async () => {
    const fetchImpl = vi.fn();
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.agents.update('agent-1', {})).rejects.toMatchObject({
      name: 'CtxmillContractError',
      direction: 'request',
      method: 'PATCH',
      path: '/agents/agent-1',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('loads a conversation snapshot with its exact SSE replay cursor', async () => {
    const snapshot = {
      conversationId: 'conversation-1',
      eventCursor: '000000000042',
      messages: [{
        id: 'message-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        turnId: 'turn-1',
        messageSeq: 0,
        messageRevision: 1,
        role: 'assistant',
        content: 'Complete',
        createdAt: 1,
      }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(snapshot));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.conversations.snapshot(
      'agent-1',
      'conversation-1',
    )).resolves.toEqual(snapshot);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ctxmill.test/api/agents/agent-1/conversations/conversation-1/snapshot',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(Reflect.has(client.conversations, 'messages')).toBe(false);
  });

  it('uses bearer auth, validates responses, and retries safe reads', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'temporarily unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse([]));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api/',
      token: async () => 'trusted-token',
      fetch: fetchImpl,
      retry: { maxAttempts: 2, baseDelayMs: 0 },
    });

    await expect(client.agents.list()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://ctxmill.test/api/agents',
      expect.objectContaining({
        method: 'GET',
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchImpl.mock.calls[1]?.[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer trusted-token');
  });

  it('never retries a mutation by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ code: 'unavailable', detail: 'try later' }, 503),
    );
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    await expect(client.turns.startBackground('agent-1', {
      task: 'close April',
      requestedTurnId: 'turn-request-1',
    }, { idempotencyKey: 'dispatch-attempt-1' })).rejects.toMatchObject({
      name: 'CtxmillApiError',
      status: 503,
      code: 'unavailable',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('forwards a canonical conversation identity when starting a background turn', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      sandboxSessionId: null,
    }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.turns.startBackground('agent-1', {
      task: 'continue April close',
      conversationId: 'conversation-1',
    })).resolves.toMatchObject({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ctxmill.test/api/agents/agent-1/turns',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          task: 'continue April close',
          conversationId: 'conversation-1',
        }),
      }),
    );
  });

  it('uses distinct create and partial PATCH contracts for webhooks', async () => {
    const webhook = {
      id: 'webhook-1',
      agentId: 'agent-1',
      url: 'https://example.test/hook',
      events: ['turn.completed'],
      active: true,
      hasSecret: true,
      createdAt: 1,
      updatedAt: 2,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(webhook))
      .mockResolvedValueOnce(jsonResponse(webhook));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.webhooks.create('agent-1', {
      url: 'https://example.test/hook',
      events: ['turn.completed'],
      secret: 'signing-secret',
    })).resolves.toMatchObject({ id: 'webhook-1' });
    await expect(client.webhooks.update('agent-1', 'webhook-1', {
      events: ['turn.completed'],
    })).resolves.toMatchObject({ id: 'webhook-1' });

    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        url: 'https://example.test/hook',
        events: ['turn.completed'],
        secret: 'signing-secret',
      }),
    });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ events: ['turn.completed'] }),
    });
  });

  it('exposes canonical budget policy, spend, and agent-status resources', async () => {
    const policy = {
      id: 'policy-1',
      name: 'Finance cap',
      enabled: true,
      doc: {
        selector: { department: 'finance' },
        window: 'rolling-24h',
        limits: { costUsd: 10 },
        actions: [{ threshold: 1, action: 'block' }],
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ policies: [policy] }))
      .mockResolvedValueOnce(jsonResponse({
        policyId: 'policy-1',
        window: 'rolling-24h',
        windowStart: 1,
        buckets: [],
      }))
      .mockResolvedValueOnce(jsonResponse({ statuses: [] }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.budgets.list()).resolves.toEqual({ policies: [policy] });
    await expect(client.budgets.spend('policy-1')).resolves.toMatchObject({
      policyId: 'policy-1',
    });
    await expect(client.budgets.agentStatuses()).resolves.toEqual({ statuses: [] });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://ctxmill.test/api/budgets', 'GET'],
      ['https://ctxmill.test/api/budgets/policy-1/spend', 'GET'],
      ['https://ctxmill.test/api/budgets/agents/status', 'GET'],
    ]);
  });

  it('exposes the sanitized model-gateway reconciliation status', async () => {
    const status = {
      enabled: true,
      profile: 'primary',
      revision: 'revision-1',
      state: 'healthy',
      watermarkAt: 10,
      lastAttemptAt: 11,
      lastSuccessAt: 11,
      lagMs: 1,
      lastError: null,
      pendingCalls: 0,
      unpricedCalls: 0,
      quarantinedTransactions: 0,
      orphanTransactions: 0,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.modelGateway.status()).resolves.toEqual(status);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ctxmill.test/api/model-gateway/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('exposes the canonical analytics overview with an optional window', async () => {
    const overview = {
      window: '7d',
      from: 1,
      to: 2,
      bucketSizeMs: 1,
      totals: {
        agents: 1,
        activeAgents: 1,
        turns: 1,
        completedTurns: 1,
        errorTurns: 0,
        cancelledTurns: 0,
        activeTurns: 0,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        tokenReportedTurns: 1,
        knownCostUsd: 0.001,
        costCoverage: {
          complete: 1,
          partial: 0,
          pending: 0,
          unpriced: 0,
        },
      },
      activity: [{
        from: 1,
        to: 2,
        turns: 1,
        completedTurns: 1,
        errorTurns: 0,
        cancelledTurns: 0,
        activeTurns: 0,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        tokenReportedTurns: 1,
        knownCostUsd: 0.001,
        costCoverage: {
          complete: 1,
          partial: 0,
          pending: 0,
          unpriced: 0,
        },
      }],
      agents: [{
        agentId: 'agent-1',
        name: 'Analyst',
        harness: 'langgraph',
        model: 'gpt-5.4-mini',
        lastActivityAt: 1,
        turns: 1,
        completedTurns: 1,
        errorTurns: 0,
        cancelledTurns: 0,
        activeTurns: 0,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        tokenReportedTurns: 1,
        knownCostUsd: 0.001,
        costCoverage: {
          complete: 1,
          partial: 0,
          pending: 0,
          unpriced: 0,
        },
      }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(overview));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.analytics.overview({ window: '7d' })).resolves.toEqual(overview);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ctxmill.test/api/analytics/overview?window=7d',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects an empty webhook patch before transport', async () => {
    const fetchImpl = vi.fn();
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.webhooks.update('agent-1', 'webhook-1', {})).rejects.toMatchObject({
      name: 'CtxmillContractError',
      direction: 'request',
      method: 'PATCH',
      path: '/agents/agent-1/webhooks/webhook-1',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when a successful response violates its contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ agents: [] }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.agents.list()).rejects.toMatchObject({
      name: 'CtxmillContractError',
      direction: 'response',
      method: 'GET',
      path: '/agents',
    });
  });

  it('returns structured API errors without leaking secret fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      code: 'invalid_secret',
      detail: 'Secret rejected',
      token: 'never-print-this',
      nested: { apiKey: 'also-secret' },
    }, 400));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    const error = await client.agents.list().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(clientModule.CtxmillApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid_secret',
      detail: 'Secret rejected',
      body: {
        code: 'invalid_secret',
        detail: 'Secret rejected',
        token: '[REDACTED]',
        nested: { apiKey: '[REDACTED]' },
      },
    });
    expect(String(error)).not.toContain('never-print-this');
    expect(String(error)).not.toContain('also-secret');
  });

  it('preserves SSE ids and heartbeats while carrying snapshot and reconnect cursors distinctly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(streamFromText([
      ': heartbeat',
      '',
      'id: 000000000041',
      'data: {"type":"CONNECTED","agentId":"agent-1","latestSeq":41,"timestamp":1}',
      '',
      'id: 000000000042',
      'data: {"type":"CUSTOM","name":"ctxmill.sandbox_session.snapshot","agentId":"agent-1","conversationId":"conversation-1","sandboxSessionId":"sandbox-1","activeTurnId":null,"status":"ACTIVE","harnessName":"claude-agents","containerName":"sandbox-1","timestamp":2}',
      '',
    ].join('\n')), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    const received = [];
    for await (const item of client.agentEvents.stream({
      agentId: 'agent-1',
      cursor: '000000000039',
      lastEventId: '000000000040',
    })) {
      received.push(item);
    }

    expect(received).toEqual([
      { id: null, event: null, heartbeat: 'heartbeat' },
      {
        id: '000000000041',
        event: {
          type: 'CONNECTED',
          agentId: 'agent-1',
          latestSeq: 41,
          timestamp: 1,
        },
      },
      {
        id: '000000000042',
        event: expect.objectContaining({
          type: 'CUSTOM',
          name: 'ctxmill.sandbox_session.snapshot',
          sandboxSessionId: 'sandbox-1',
        }),
      },
    ]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://ctxmill.test/api/agents/agent-1/stream?cursor=000000000039',
    );
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Last-Event-ID')).toBe('000000000040');
  });

  it('retries only the initial connection of a passive GET stream', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'temporarily unavailable' }, 503))
      .mockResolvedValueOnce(new Response(streamFromText([
        'data: {"type":"CONNECTED","agentId":"agent-1","latestSeq":0,"timestamp":1}',
        '',
      ].join('\n')), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 2, baseDelayMs: 0 },
    });

    const received = [];
    for await (const item of client.agentEvents.stream({ agentId: 'agent-1' })) {
      received.push(item);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(1);
  });

  it('keeps caller cancellation wired for the lifetime of a passive stream', async () => {
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      transportSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response(streamFromText([
        'data: {"type":"CONNECTED","agentId":"agent-1","latestSeq":0,"timestamp":1}',
        '',
      ].join('\n')), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    });
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl as typeof fetch,
      retry: { maxAttempts: 1 },
    });

    const stream = client.agentEvents.stream({
      agentId: 'agent-1',
      signal: caller.signal,
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { event: { type: 'CONNECTED' } },
    });
    caller.abort(new Error('disconnect'));

    expect(transportSignal?.aborted).toBe(true);
    await stream.return(undefined);
  });

  it('cancels the upstream body when a passive stream rejects a malformed frame', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'id: seq:42',
          'data: {"type":"TEXT_MESSAGE_END","runId":"turn-1","threadId":"conversation-1","messageId":"message-1","role":"assistant","timestamp":1}',
          '',
          '',
        ].join('\n')));
      },
      cancel,
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    try {
      const stream = client.agentEvents.stream({ agentId: 'agent-1' });
      await expect(stream.next()).rejects.toMatchObject({
        name: 'CtxmillContractError',
        direction: 'stream',
      });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      if (cancel.mock.calls.length === 0) {
        await body.cancel();
      }
    }
  });

  it('combines caller cancellation with a request timeout', async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        }, { once: true });
      }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl as typeof fetch,
      timeoutMs: 60_000,
      retry: { maxAttempts: 1 },
    });

    const request = client.health.get({ signal: caller.signal });
    caller.abort(new Error('caller stopped'));
    await expect(request).rejects.toThrow('caller stopped');
  });

  it('reads and replaces workspaces through one revision resource', async () => {
    const revision = {
      revision: 3,
      sha256: '8d7df0f0',
      fileCount: 12,
      totalBytes: 4096,
      appliedAt: 42,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(revision))
      .mockResolvedValueOnce(jsonResponse({ ...revision, revision: 4 }, 201));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.workspaces.getRevision('agent-1')).resolves.toEqual(revision);
    await expect(client.workspaces.replace(
      'agent-1',
      new Uint8Array([31, 139]),
    )).resolves.toMatchObject({ revision: 4 });

    expect(fetchImpl.mock.calls[0]?.[0])
      .toBe('https://ctxmill.test/api/agents/agent-1/workspace');
    expect(fetchImpl.mock.calls[1]?.[0])
      .toBe('https://ctxmill.test/api/agents/agent-1/workspace');
  });
});

describe('CtxmillAgUiClient', () => {
  it('parses every server-emitted canonical fixture frame', () => {
    const fixture = JSON.parse(readFileSync(
      new URL('../../contracts/test-fixtures/canonical-stream-events.json', import.meta.url),
      'utf8',
    )) as unknown[];

    expect(fixture.map(clientModule.parseCanonicalStreamEvent)).toHaveLength(19);
  });

  it('streams strict AG-UI frames and extracts canonical interrupt requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(streamFromText([
      'data: {"type":"RUN_STARTED","runId":"turn-1","threadId":"conversation-1","timestamp":1}',
      '',
      'data: {"type":"CUSTOM","name":"ctxmill.interrupt.requested","agentId":"agent-1","turnId":"turn-1","conversationId":"conversation-1","interruptId":"interrupt-1","toolCallId":"tool-call-1","toolCallName":"request-approval","args":{"reason":"publish"},"timestamp":2}',
      '',
    ].join('\n')), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const client = new clientModule.CtxmillAgUiClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
    });

    const events = [];
    for await (const event of client.streamAgentRun({
      agentId: 'agent-1',
      runId: 'turn-1',
      threadId: 'conversation-1',
      messages: [{ id: 'message-1', role: 'user', content: 'publish' }],
    })) {
      events.push(event);
    }

    expect(clientModule.getInterruptRequest(events[1]!)).toEqual({
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      toolCallId: 'tool-call-1',
      toolCallName: 'request-approval',
      args: { reason: 'publish' },
    });
  });

  it('keeps interrupt resolution and turn cancellation as separate operations', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ resolved: true, action: 'approve' }))
      .mockResolvedValueOnce(jsonResponse({ cancelled: true, turnId: 'turn-1' }));
    const client = new clientModule.CtxmillAgUiClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
    });

    await client.resolveInterrupt({
      agentId: 'agent-1',
      interruptId: 'interrupt-1',
      action: 'approve',
    });
    await client.cancelTurn({ agentId: 'agent-1', turnId: 'turn-1' });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://ctxmill.test/api/agents/agent-1/interrupt');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://ctxmill.test/api/agents/agent-1/turns/turn-1/cancel');
  });

  it('lists durable interrupts across agents through the control client', async () => {
    const response = {
      interrupts: [{
        interruptId: 'interrupt-1',
        agentId: 'agent-1',
        turnId: 'turn-1',
        sandboxSessionId: 'session-1',
        toolCallId: 'tool-call-1',
        toolName: 'request-approval',
        args: { reason: 'publish' },
        status: 'pending',
        createdAt: 100,
        expiresAt: 200,
        resolvedAt: null,
        resolvedAction: null,
      }],
      nextBefore: 100,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(response));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.interrupts.listAll({
      status: 'resolved',
      agentId: 'agent-1',
      limit: 25,
      before: 123,
    })).resolves.toEqual(response);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ctxmill.test/api/interrupts?status=resolved&agentId=agent-1&limit=25&before=123',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses canonical artifact registration and read contracts', async () => {
    const artifact = {
      id: 'artifact-1',
      agentId: 'agent-1',
      turnId: null,
      conversationId: null,
      name: 'report.json',
      mimeType: 'application/json',
      sizeBytes: 42,
      storageKey: 'artifacts/artifact-1/report.json',
      bucket: 'artifacts',
      kind: 'eval_report',
      metadata: { suite: 'smoke' },
      status: 'active',
      expiresAt: null,
      createdAt: 1,
      updatedAt: 2,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        artifactId: 'artifact-1',
        uploadUrl: 'https://storage.test/upload',
        storageKey: artifact.storageKey,
        expiresIn: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(artifact));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await client.artifacts.requestUploadUrl({
      agentId: 'agent-1',
      name: 'report.json',
      mimeType: 'application/json',
      sizeBytes: 42,
      kind: 'eval_report',
      metadata: { suite: 'smoke' },
    });
    await expect(client.artifacts.get('artifact-1')).resolves.toEqual(artifact);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://ctxmill.test/api/artifacts/upload-url');
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-1',
        name: 'report.json',
        mimeType: 'application/json',
        sizeBytes: 42,
        kind: 'eval_report',
        metadata: { suite: 'smoke' },
      }),
    }));
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://ctxmill.test/api/artifacts/artifact-1');
  });

  it('lists persisted events through canonical correlation filters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      events: [{
        seq: 12,
        type: 'custom.eval.verdict',
        agentId: 'agent-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        payload: '{"verdict":"pass"}',
        createdAt: 123,
      }],
      nextCursor: 11,
    }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.events.list({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      limit: 25,
    })).resolves.toMatchObject({
      events: [{ turnId: 'turn-1', conversationId: 'conversation-1' }],
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://ctxmill.test/api/events?limit=25&turnId=turn-1&conversationId=conversation-1',
    );
  });

  it('emits externally composable custom events through the canonical contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      type: 'custom.eval.verdict',
    }));
    const client = new clientModule.CtxmillControlClient({
      apiBase: 'https://ctxmill.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.events.emitCustom({
      type: 'custom.eval.verdict',
      agentId: 'agent-1',
      payload: { verdict: 'pass' },
    })).resolves.toEqual({ ok: true, type: 'custom.eval.verdict' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://ctxmill.test/api/triggers/emit');
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        type: 'custom.eval.verdict',
        agentId: 'agent-1',
        payload: { verdict: 'pass' },
      }),
    }));

    await expect(client.events.emitCustom({
      type: 'eval.verdict',
      payload: {},
    })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects legacy custom-event aliases instead of normalizing them', () => {
    expect(() => clientModule.parseCanonicalStreamEvent({
      type: 'CUSTOM',
      name: 'ctxmill.hitl.requested',
      subtype: 'hitl_pause',
      runId: 'turn-1',
      interruptId: 'interrupt-1',
      toolCallId: 'tool-call-1',
      toolName: 'request-approval',
      args: {},
      timestamp: 1,
    })).toThrow();
  });
});
