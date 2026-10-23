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

describe('StablehandControlClient', () => {
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
  missedFireCount: 0,
      nextRunAt: 2,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ schedules: [schedule] }))
      .mockResolvedValueOnce(jsonResponse(schedule))
      .mockResolvedValueOnce(jsonResponse(schedule))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ ...schedule, lastFiredAt: 3 }));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
    await expect(client.schedules.fire('schedule-1')).resolves.toMatchObject({ lastFiredAt: 3 });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://stablehand.test/api/schedules', 'GET'],
      ['https://stablehand.test/api/schedules', 'POST'],
      ['https://stablehand.test/api/schedules/schedule-1', 'PATCH'],
      ['https://stablehand.test/api/schedules/schedule-1', 'DELETE'],
      ['https://stablehand.test/api/schedules/schedule-1/fire', 'POST'],
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
      status: 'idle',
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
      egress: null,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(updatedAgent));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.agents.update('agent-1', {
      description: 'Updated description',
    })).resolves.toMatchObject({ description: 'Updated description' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://stablehand.test/api/agents/agent-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ description: 'Updated description' }),
      }),
    );
  });

  it('rejects an empty agent patch before transport', async () => {
    const fetchImpl = vi.fn();
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.agents.update('agent-1', {})).rejects.toMatchObject({
      name: 'StablehandContractError',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.conversations.snapshot(
      'agent-1',
      'conversation-1',
    )).resolves.toEqual(snapshot);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://stablehand.test/api/agents/agent-1/conversations/conversation-1/snapshot',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(Reflect.has(client.conversations, 'messages')).toBe(false);
  });

  it('uses bearer auth, validates responses, and retries safe reads', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'temporarily unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse([]));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api/',
      token: async () => 'trusted-token',
      fetch: fetchImpl,
      retry: { maxAttempts: 2, baseDelayMs: 0 },
    });

    await expect(client.agents.list()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://stablehand.test/api/agents',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    await expect(client.turns.startBackground('agent-1', {
      task: 'close April',
      requestedTurnId: 'turn-request-1',
    }, { idempotencyKey: 'dispatch-attempt-1' })).rejects.toMatchObject({
      name: 'StablehandApiError',
      status: 503,
      code: 'unavailable',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('forwards a canonical conversation identity when starting a background turn', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
    }));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
      'https://stablehand.test/api/agents/agent-1/turns',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.budgets.list()).resolves.toEqual({ policies: [policy] });
    await expect(client.budgets.spend('policy-1')).resolves.toMatchObject({
      policyId: 'policy-1',
    });
    await expect(client.budgets.agentStatuses()).resolves.toEqual({ statuses: [] });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://stablehand.test/api/budgets', 'GET'],
      ['https://stablehand.test/api/budgets/policy-1/spend', 'GET'],
      ['https://stablehand.test/api/budgets/agents/status', 'GET'],
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
      awaitingTurns: 0,
      oldestAwaitingAt: null,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.modelGateway.status()).resolves.toEqual(status);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://stablehand.test/api/model-gateway/status',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.analytics.overview({ window: '7d' })).resolves.toEqual(overview);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://stablehand.test/api/analytics/overview?window=7d',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects an empty webhook patch before transport', async () => {
    const fetchImpl = vi.fn();
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.webhooks.update('agent-1', 'webhook-1', {})).rejects.toMatchObject({
      name: 'StablehandContractError',
      direction: 'request',
      method: 'PATCH',
      path: '/agents/agent-1/webhooks/webhook-1',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when a successful response violates its contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ agents: [] }));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.agents.list()).rejects.toMatchObject({
      name: 'StablehandContractError',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    const error = await client.agents.list().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(clientModule.StablehandApiError);
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

  it.each([
    ['events:read', 'events:read'],
    [null, null],
  ] as const)('surfaces the required capability from a 403 response (%s)', async (
    requiredCapability,
    expected,
  ) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      error: 'Forbidden',
      requiredCapability,
    }, 403));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.events.list()).rejects.toMatchObject({
      status: 403,
      requiredCapability: expected,
    });
  });

  it('preserves SSE ids and heartbeats while carrying snapshot and reconnect cursors distinctly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(streamFromText([
      ': heartbeat',
      '',
      'id: 000000000041',
      'data: {"type":"CONNECTED","agentId":"agent-1","latestSeq":41,"timestamp":1}',
      '',
      'id: 000000000042',
      'data: {"type":"CUSTOM","name":"stablehand.sandbox_session.snapshot","agentId":"agent-1","conversationId":"conversation-1","sandboxSessionId":"sandbox-1","activeTurnId":null,"status":"ACTIVE","harnessName":"claude-agents","containerName":"sandbox-1","timestamp":2}',
      '',
    ].join('\n')), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
          name: 'stablehand.sandbox_session.snapshot',
          sandboxSessionId: 'sandbox-1',
        }),
      },
    ]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://stablehand.test/api/agents/agent-1/stream?cursor=000000000039',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    try {
      const stream = client.agentEvents.stream({ agentId: 'agent-1' });
      await expect(stream.next()).rejects.toMatchObject({
        name: 'StablehandContractError',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.workspaces.getRevision('agent-1')).resolves.toEqual(revision);
    await expect(client.workspaces.replace(
      'agent-1',
      new Uint8Array([31, 139]),
    )).resolves.toMatchObject({ revision: 4 });

    expect(fetchImpl.mock.calls[0]?.[0])
      .toBe('https://stablehand.test/api/agents/agent-1/workspace');
    expect(fetchImpl.mock.calls[1]?.[0])
      .toBe('https://stablehand.test/api/agents/agent-1/workspace');
  });
});

describe('StablehandAgUiClient', () => {
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
      'data: {"type":"CUSTOM","name":"stablehand.interrupt.requested","agentId":"agent-1","turnId":"turn-1","conversationId":"conversation-1","interruptId":"interrupt-1","toolCallId":"tool-call-1","toolName":"request-approval","args":{"reason":"publish"},"timestamp":2}',
      '',
    ].join('\n')), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const client = new clientModule.StablehandAgUiClient({
      apiBase: 'https://stablehand.test/api',
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
      toolName: 'request-approval',
      args: { reason: 'publish' },
    });
  });

  it('keeps interrupt resolution and turn cancellation as separate operations', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ resolved: true, action: 'approve' }))
      .mockResolvedValueOnce(jsonResponse({ cancelled: true, turnId: 'turn-1' }));
    const client = new clientModule.StablehandAgUiClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
    });

    await client.resolveInterrupt({
      agentId: 'agent-1',
      interruptId: 'interrupt-1',
      action: 'approve',
    });
    await client.cancelTurn({ agentId: 'agent-1', turnId: 'turn-1' });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://stablehand.test/api/agents/agent-1/interrupt');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://stablehand.test/api/agents/agent-1/turns/turn-1/cancel');
  });

  it('lists durable interrupts across agents through the control client', async () => {
    const response = {
      interrupts: [{
        id: 'interrupt-1',
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
        resolvedBy: null,
        resolvedReason: null,
      }],
      nextBefore: 100,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(response));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
      'https://stablehand.test/api/interrupts?status=resolved&agentId=agent-1&limit=25&before=123',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('reads one approval with who resolved it, and asks for resolved ones by the right name (ctx-lhr0)', async () => {
    const detail = {
      id: 'interrupt-1',
      agentId: 'agent-1',
      turnId: 'turn-1',
      sandboxSessionId: null,
      toolCallId: 'tool-call-1',
      toolName: 'request-approval',
      args: {},
      status: 'resolved',
      createdAt: 100,
      expiresAt: 200,
      resolvedAt: 150,
      resolvedAction: 'approve',
      resolvedBy: { type: 'api_key', keyId: 'key_phone', keyName: 'phone-approver' },
      resolvedReason: 'Receipts reconcile',
      resolvedData: { publishTo: 'hub' },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(jsonResponse({ interrupts: [] }))
      .mockResolvedValueOnce(jsonResponse({
        resolved: true,
        action: 'reject',
        resolvedAt: 160,
        resolvedBy: { type: 'master_token' },
        resolvedReason: 'Leaks the fix',
      }));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.interrupts.get('interrupt-1')).resolves.toEqual(detail);
    await client.interrupts.list('agent-1', { includeResolved: true });
    await expect(client.interrupts.resolve('agent-1', {
      interruptId: 'interrupt-2',
      action: 'reject',
      reason: 'Leaks the fix',
    })).resolves.toMatchObject({ resolvedBy: { type: 'master_token' }, resolvedReason: 'Leaks the fix' });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://stablehand.test/api/interrupts/interrupt-1',
      'https://stablehand.test/api/agents/agent-1/interrupts?includeResolved=true',
      'https://stablehand.test/api/agents/agent-1/interrupt',
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({
      interruptId: 'interrupt-2',
      action: 'reject',
      reason: 'Leaks the fix',
    });
  });

  it('uses canonical artifact registration and read contracts', async () => {
    const sha256 = 'a'.repeat(64);
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
      sha256,
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
        expiresInSec: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(artifact));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
      sha256,
    });
    await expect(client.artifacts.get('artifact-1')).resolves.toEqual(artifact);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://stablehand.test/api/artifacts/upload-url');
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agent-1',
        name: 'report.json',
        mimeType: 'application/json',
        sizeBytes: 42,
        kind: 'eval_report',
        metadata: { suite: 'smoke' },
        sha256,
      }),
    }));
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://stablehand.test/api/artifacts/artifact-1');
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
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
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
      'https://stablehand.test/api/events?limit=25&turnId=turn-1&conversationId=conversation-1',
    );
  });

  it('emits externally composable custom events through the canonical contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      type: 'custom.eval.verdict',
    }));
    const client = new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl,
      retry: { maxAttempts: 1 },
    });

    await expect(client.events.emitCustom({
      type: 'custom.eval.verdict',
      agentId: 'agent-1',
      payload: { verdict: 'pass' },
    })).resolves.toEqual({ ok: true, type: 'custom.eval.verdict' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://stablehand.test/api/triggers/emit');
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
      name: 'stablehand.hitl.requested',
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

describe('turn search and waitForTurn (ctx-89id)', () => {
  function apiTurn(status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'ERROR' | 'CANCELLED', overrides: Record<string, unknown> = {}) {
    const done = status === 'COMPLETED' || status === 'ERROR' || status === 'CANCELLED';
    return {
      id: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      sandboxSessionId: null,
      status,
      mode: 'background',
      queuedAt: 1,
      startedAt: 2,
      completedAt: done ? 3 : null,
      error: status === 'ERROR' ? 'boom' : null,
      taskDescription: 'Scout',
      usage: null,
      tags: { campaign: 'bugfarm-1' },
      ...overrides,
    };
  }

  function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
    return new clientModule.StablehandControlClient({
      apiBase: 'https://stablehand.test/api',
      fetch: fetchImpl as unknown as typeof fetch,
      retry: { maxAttempts: 1 },
    });
  }

  it('searches turns by tag and status across agents and pages with the cursor', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      turns: [apiTurn('COMPLETED')],
      nextCursor: 'next-page',
    }));
    const client = makeClient(fetchImpl);

    await expect(client.turns.search({
      tags: { campaign: 'bugfarm-1', repo: 'rich:main' },
      status: ['COMPLETED', 'ERROR'],
      limit: 25,
      cursor: 'page-2',
    })).resolves.toMatchObject({ nextCursor: 'next-page', turns: [{ id: 'turn-1' }] });

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/turns');
    expect(url.searchParams.getAll('tag')).toEqual(['campaign:bugfarm-1', 'repo:rich:main']);
    expect(url.searchParams.getAll('status')).toEqual(['COMPLETED', 'ERROR']);
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('cursor')).toBe('page-2');
  });

  it('rejects a tag key containing ":" before any request', () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    expect(() => client.turns.search({ tags: { 'a:b': 'c' } })).toThrow(clientModule.StablehandContractError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('looks a turn up by id alone', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ turn: apiTurn('RUNNING') }));
    const client = makeClient(fetchImpl);
    await expect(client.turns.lookup('turn-1')).resolves.toMatchObject({ turn: { status: 'RUNNING' } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://stablehand.test/api/turns/turn-1');
  });

  it('polls with backoff until the turn finishes and returns it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ turn: apiTurn('QUEUED') }))
      .mockResolvedValueOnce(jsonResponse({ turn: apiTurn('RUNNING') }))
      .mockResolvedValueOnce(jsonResponse({ turn: apiTurn('ERROR') }));
    const client = makeClient(fetchImpl);

    const turn = await client.waitForTurn('turn-1', { pollIntervalMs: 1, useStream: false });

    expect(turn).toMatchObject({ id: 'turn-1', status: 'ERROR', error: 'boom' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns as soon as the agent stream reports the turn ended', async () => {
    let lookups = 0;
    let streamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/agents/agent-1/stream')) {
        streamSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => controller.enqueue(new TextEncoder().encode([
              'id: 000000000007',
              'data: {"type":"RUN_FINISHED","runId":"turn-other","threadId":"c","timestamp":2,"usage":null}',
              '',
              'id: 000000000008',
              'data: {"type":"RUN_FINISHED","runId":"turn-1","threadId":"conversation-1","timestamp":3,"usage":null}',
              '',
              '',
            ].join('\n'))), 20);
          },
        });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }));
      }
      lookups += 1;
      return Promise.resolve(jsonResponse({ turn: apiTurn(lookups === 1 ? 'RUNNING' : 'COMPLETED') }));
    });
    const client = makeClient(fetchImpl);

    const started = Date.now();
    // Without the stream the next check would be a minute away.
    const turn = await client.waitForTurn('turn-1', { pollIntervalMs: 60_000, timeoutMs: 120_000 });

    expect(turn.status).toBe('COMPLETED');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(lookups).toBe(2);
    expect(streamSignal?.aborted).toBe(true);
  });

  it('keeps checking through brief outages but fails at once on a missing turn', async () => {
    const recovering = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'restarting' }, 503))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ turn: apiTurn('COMPLETED') }));
    await expect(makeClient(recovering).waitForTurn('turn-1', { pollIntervalMs: 1, useStream: false }))
      .resolves.toMatchObject({ status: 'COMPLETED' });

    const missing = vi.fn().mockResolvedValue(jsonResponse({ error: 'Turn not found' }, 404));
    await expect(makeClient(missing).waitForTurn('turn-1', { pollIntervalMs: 1, useStream: false }))
      .rejects.toMatchObject({ name: 'StablehandApiError', status: 404 });
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('times out with a clear error and honours the caller signal', async () => {
    const running = vi.fn(() => Promise.resolve(jsonResponse({ turn: apiTurn('RUNNING') })));
    await expect(makeClient(running).waitForTurn('turn-1', {
      timeoutMs: 40,
      pollIntervalMs: 5,
      useStream: false,
    })).rejects.toMatchObject({
      name: 'StablehandTimeoutError',
      message: 'Turn turn-1 did not finish within 40ms',
    });

    const caller = new AbortController();
    const waiting = makeClient(running).waitForTurn('turn-1', {
      pollIntervalMs: 60_000,
      useStream: false,
      signal: caller.signal,
    });
    setTimeout(() => caller.abort(new Error('worker stopping')), 10);
    await expect(waiting).rejects.toThrow('worker stopping');
  });
});
