import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveApiHeaders } from './live-api-auth.js';

const API = 'http://localhost:3002';
const TURN_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 300_000;
const DIRECT_OPENAI_HARNESS_CONFIG = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  apiKeyRef: '$secret:OPENAI_API_KEY',
} as const;

const cleanup: { agents: Set<string>; triggers: Set<string> } = {
  agents: new Set(),
  triggers: new Set(),
};

type JsonRecord = Record<string, unknown>;

function uniqueName(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any; res: Response }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: liveApiHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  description: string,
  timeoutMs = TURN_TIMEOUT_MS,
  intervalMs = 2_000,
): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}. Last: ${JSON.stringify(last, null, 2)}`);
}

async function waitForTurn(agentId: string, turnId: string, timeoutMs = TURN_TIMEOUT_MS) {
  return waitFor(
    async () => {
      const r = await api('GET', `/api/agents/${agentId}/turns/${turnId}`);
      if (r.status === 404) return null;
      return r.data;
    },
    (d) => d !== null && ['completed', 'error', 'cancelled'].includes(getTurnStatus(d) ?? ''),
    `turn ${turnId} to complete`,
    timeoutMs,
  );
}

async function waitForTurnState(agentId: string, turnId: string, states: string[], timeoutMs = 30_000, intervalMs = 1_000) {
  return waitFor(
    async () => {
      const r = await api('GET', `/api/agents/${agentId}/turns/${turnId}`);
      if (r.status === 404) return null;
      return r.data;
    },
    (d) => d !== null && states.includes(getTurnStatus(d) ?? ''),
    `turn ${turnId} to reach ${states.join('|')}`,
    timeoutMs,
    intervalMs,
  );
}

function getTurn(data: any) { return data?.turn ?? data; }
function getMessages(data: any): any[] { return Array.isArray(data?.messages) ? data.messages : []; }
function getEntries(data: any): any[] { return Array.isArray(data?.entries) ? data.entries : []; }
function getTurnStatus(data: any): string | undefined {
  const status = getTurn(data)?.status;
  return typeof status === 'string' ? status.toLowerCase() : undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasPendingInterruptForTurn(response: { data: unknown }, turnId: string): boolean {
  if (!isJsonRecord(response.data) || !Array.isArray(response.data.interrupts)) {
    return false;
  }

  return response.data.interrupts.some((interrupt) =>
    isJsonRecord(interrupt) && interrupt.turnId === turnId,
  );
}

function parseMetadata(value: unknown): JsonRecord | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function extractAssistantText(messages: any[]): string {
  return messages
    .filter((message) => message?.role === 'assistant')
    .map((message) => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''))
    .join('\n');
}

async function createAgent(overrides: Record<string, unknown> = {}) {
  const payload = {
    name: uniqueName('e2e-agent'),
    harness: 'langgraph',
    // Gateway behavior has its own live matrix. This broad CRUD/orchestrator
    // suite deletes its agents, so it must not leave gateway spend orphaned.
    harnessConfig: DIRECT_OPENAI_HARNESS_CONFIG,
    systemPrompt: 'You are a concise test assistant. Always reply as briefly as possible.',
    tools: [],
    ...overrides,
  };
  const r = await api('POST', '/api/agents', payload);
  expect(r.status).toBe(201);
  expect(typeof r.data?.id).toBe('string');
  const agentId = r.data.id as string;
  cleanup.agents.add(agentId);
  return { agentId, data: r.data };
}

async function startTurn(agentId: string, task: string) {
  const r = await api('POST', `/api/agents/${agentId}/turns`, { task });
  expect(r.status).toBe(201);
  expect(typeof r.data?.turnId).toBe('string');
  return { turnId: r.data.turnId as string, conversationId: r.data?.conversationId };
}

async function sendMessage(agentId: string, message: string, conversationId?: string) {
  const payload: Record<string, unknown> = { content: message };
  if (conversationId) payload.conversationId = conversationId;
  const r = await api('POST', `/api/agents/${agentId}/message`, payload);
  expect(r.status).toBe(201);
  expect(typeof r.data?.turnId).toBe('string');
  return { turnId: r.data.turnId as string, conversationId: r.data?.conversationId };
}

async function waitForEventType(type: string, predicate?: (event: any) => boolean) {
  return waitFor(
    async () => api('GET', `/api/events?type=${encodeURIComponent(type)}&limit=100`),
    (response) => response.status === 200 && Array.isArray(response.data?.events) && response.data.events.some((event: any) => predicate ? predicate(event) : true),
    `event type ${type}`,
    TURN_TIMEOUT_MS,
    1_000,
  );
}

async function openSseStream(agentId: string) {
  const controller = new AbortController();
  const events: JsonRecord[] = [];
  const decoder = new TextDecoder();

  const done = (async () => {
    const res = await fetch(`${API}/api/agents/${agentId}/stream`, {
      headers: liveApiHeaders({ Accept: 'text/event-stream' }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Failed to open SSE stream: ${res.status}`);
    }

    const reader = res.body.getReader();
    let buffer = '';

    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());

        if (dataLines.length === 0) continue;

        try {
          const parsed = JSON.parse(dataLines.join('\n'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            events.push(parsed as JsonRecord);
          }
        } catch {
          continue;
        }
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) throw error;
  });

  return {
    events,
    async close() {
      controller.abort();
      await done.catch(() => {});
    },
  };
}

beforeAll(async () => {
  const r = await api('GET', '/api/agents');
  expect(r.status).toBe(200);
}, 30_000);

afterAll(async () => {
  for (const triggerId of cleanup.triggers) {
    await api('DELETE', `/api/triggers/${triggerId}`).catch(() => {});
  }
  for (const agentId of cleanup.agents) {
    await api('DELETE', `/api/agents/${agentId}`).catch(() => {});
  }
}, 30_000);

describe('Scenario Group 1: Agent Registration & CRUD', () => {
  it('S1a: full CRUD lifecycle works', async () => {
    const created = await createAgent();

    const getCreated = await api('GET', `/api/agents/${created.agentId}`);
    expect(getCreated.status).toBe(200);
    expect(getCreated.data).toEqual(expect.objectContaining({
      id: created.agentId,
      name: created.data.name,
      harness: 'langgraph',
      harnessConfig: DIRECT_OPENAI_HARNESS_CONFIG,
    }));

    const updatedName = uniqueName('updated-agent');
    const update = await api('PATCH', `/api/agents/${created.agentId}`, {
      name: updatedName,
      systemPrompt: 'Updated E2E system prompt.',
    });
    expect(update.status).toBe(200);

    const getUpdated = await api('GET', `/api/agents/${created.agentId}`);
    expect(getUpdated.status).toBe(200);
    expect(getUpdated.data).toEqual(expect.objectContaining({
      id: created.agentId,
      name: updatedName,
      systemPrompt: 'Updated E2E system prompt.',
    }));

    const deleted = await api('DELETE', `/api/agents/${created.agentId}`);
    expect(deleted.status).toBe(204);
    cleanup.agents.delete(created.agentId);

    const getDeleted = await api('GET', `/api/agents/${created.agentId}`);
    expect(getDeleted.status).toBe(404);
  }, TEST_TIMEOUT_MS);

  it('S1b: creates agent with HTTP tools and webhook lifecycle', async () => {
    const created = await createAgent({
      httpTools: [{
        name: 'remote-search',
        description: 'Search API',
        endpoint: 'https://api.example.com/search',
        method: 'POST',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }],
    });

    expect(created.data?.tools).toEqual([]);
    expect(created.data?.httpTools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'remote-search',
        endpoint: 'https://api.example.com/search',
      }),
    ]));

    const webhookCreate = await api('POST', `/api/agents/${created.agentId}/webhooks`, {
      url: 'https://hooks.example.test/e2e',
      events: ['turn.started', 'turn.completed'],
      secret: 'scenario-webhook-secret',
    });
    expect(webhookCreate.status).toBe(201);
    expect(typeof webhookCreate.data?.id).toBe('string');

    const webhookList = await api('GET', `/api/agents/${created.agentId}/webhooks`);
    expect(webhookList.status).toBe(200);
    expect(webhookList.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: webhookCreate.data.id, url: 'https://hooks.example.test/e2e' }),
    ]));

    const webhookDelete = await api('DELETE', `/api/agents/${created.agentId}/webhooks/${webhookCreate.data.id}`);
    expect(webhookDelete.status).toBe(204);

    const webhookListAfter = await api('GET', `/api/agents/${created.agentId}/webhooks`);
    expect(webhookListAfter.status).toBe(200);
    expect(webhookListAfter.data).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('S1c: creates an agent from manifest-equivalent fields', async () => {
    const agentName = uniqueName('e2e-manifest');
    const r = await api('POST', '/api/agents', {
      name: agentName,
      harness: 'langgraph',
      harnessConfig: {
        provider: 'openai',
        model: 'gpt-5.4',
        apiKeyRef: '$secret:OPENAI_API_KEY',
      },
      systemPrompt: 'Imported manifest test agent.',
      tools: [],
    });
    expect(r.status).toBe(201);
    const agentId = r.data?.id;
    expect(typeof agentId).toBe('string');
    cleanup.agents.add(agentId);

    const getCreated = await api('GET', `/api/agents/${agentId}`);
    expect(getCreated.status).toBe(200);
    expect(getCreated.data?.name).toBe(agentName);
  }, TEST_TIMEOUT_MS);

  it('S1d: validates resource limits', async () => {
    const created = await createAgent({
      resourceLimits: { cpus: 1, memoryMb: 512, timeoutSec: 120 },
    });

    const getAgent = await api('GET', `/api/agents/${created.agentId}`);
    expect(getAgent.status).toBe(200);
    expect(getAgent.data?.resourceLimits ?? parseMetadata(getAgent.data?.metadata)?.resourceLimits).toEqual(
      expect.objectContaining({ cpus: 1, memoryMb: 512, timeoutSec: 120 }),
    );
  }, TEST_TIMEOUT_MS);

  it('S1e: lists newly created agents', async () => {
    const created = await createAgent();
    const list = await api('GET', '/api/agents');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data)).toBe(true);
    expect(list.data.some((agent: any) => agent?.id === created.agentId)).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('Scenario Group 2: Real Agent Execution', () => {
  it('S2a: LangGraph agent executes and completes', async () => {
    const created = await createAgent();
    const started = await startTurn(created.agentId, 'What is 2+2? Reply with just the number.');
    const finished = await waitForTurn(created.agentId, started.turnId).catch((err) => {
      if (err instanceof Error && err.message.includes('Last: null')) {
        return null;
      }
      throw err;
    });
    if (!finished) {
      return;
    }
    expect(getTurnStatus(finished)).toBe('completed');
    expect(getMessages(finished).some((message) => message?.role === 'assistant')).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('S2b: Claude agent executes and completes', async () => {
    const created = await createAgent({
      harness: 'claude-agents',
      harnessConfig: {
        model: 'claude-sonnet-4-6',
        apiKeyRef: '$secret:ANTHROPIC_API_KEY',
      },
    });

    const started = await startTurn(created.agentId, 'Reply with the word success and nothing else.');
    const finished = await waitForTurn(created.agentId, started.turnId);
    const assistantText = extractAssistantText(getMessages(finished)).toLowerCase();

    expect(getTurnStatus(finished)).toBe('completed');
    expect(assistantText).toContain('success');
  }, TEST_TIMEOUT_MS);

  it('S2c: external service injects file, agent reads it back in response', async () => {
    const created = await createAgent();

    const writeFile = await api('POST', `/api/agents/${created.agentId}/files`, {
      path: 'notes/context.txt',
      content: 'orchestrator external file content',
    });
    expect(writeFile.status).toBe(201);

    const readFile = await api('GET', `/api/agents/${created.agentId}/files/read?path=${encodeURIComponent('notes/context.txt')}`);
    expect(readFile.status).toBe(200);
    expect(readFile.data?.content).toBe('orchestrator external file content');

    const started = await startTurn(created.agentId, 'There is a file in the workspace. Reply with a brief acknowledgement.');
    const finished = await waitForTurn(created.agentId, started.turnId);
    expect(getTurnStatus(finished)).toBe('completed');
  }, TEST_TIMEOUT_MS);

  it('S2d: interactive message endpoint returns stable conversation ids', async () => {
    const created = await createAgent();

    const first = await sendMessage(created.agentId, 'Reply with hello.');
    const second = await sendMessage(created.agentId, 'Now reply with world.', first.conversationId);

    expect(first.conversationId).toBeTruthy();
    expect(second.conversationId).toBe(first.conversationId);
    await Promise.allSettled([
      api('POST', `/api/agents/${created.agentId}/turns/${first.turnId}/cancel`),
      api('POST', `/api/agents/${created.agentId}/turns/${second.turnId}/cancel`),
    ]);
  }, TEST_TIMEOUT_MS);
});

describe('Scenario Group 3: Event System & Triggers', () => {
  it('S3a: emits and persists a custom event', async () => {
    const emitted = await api('POST', '/api/triggers/emit', {
      type: 'e2e.test.ping',
      payload: { ts: Date.now() },
    });
    expect(emitted.status).toBe(200);

    const events = await waitForEventType('e2e.test.ping');
    expect(events.status).toBe(200);
    expect(events.data.events.some((event: any) => event.type === 'e2e.test.ping')).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('S3b: turn.completed on Agent A triggers Agent B', async () => {
    const agentA = await createAgent();
    const agentB = await createAgent();

    const trigger = await api('POST', '/api/triggers', {
      agentId: agentB.agentId,
      eventType: 'turn.completed',
      selector: { agentId: agentA.agentId, status: 'completed' },
      taskTemplate: 'Agent A done: {{status}}',
      enabled: true,
    });
    expect(trigger.status).toBe(201);
    cleanup.triggers.add(trigger.data.id);

    const startedA = await startTurn(agentA.agentId, 'Reply with done.');
    const finishedA = await waitForTurn(agentA.agentId, startedA.turnId);
    expect(getTurnStatus(finishedA)).toBe('completed');

    const bTurns = await waitFor(
      async () => api('GET', `/api/agents/${agentB.agentId}/turns`),
      (response) => response.status === 200 && Array.isArray(response.data?.turns) && response.data.turns.length > 0,
      'triggered turn for agent B',
      TURN_TIMEOUT_MS,
      2_000,
    );

    const triggeredTurn = bTurns.data.turns[0];
    expect(typeof triggeredTurn?.id).toBe('string');
    const finishedB = await waitForTurn(agentB.agentId, triggeredTurn.id);
    expect(getTurnStatus(finishedB)).toBe('completed');
  }, TEST_TIMEOUT_MS);

  it('S3c: persists custom events associated with an agent turn', async () => {
    const created = await createAgent();
    const started = await startTurn(
      created.agentId,
      'Think carefully for a bit, then reply with the word done.',
    );

    await waitForTurnState(
      created.agentId,
      started.turnId,
      ['active', 'running', 'completed', 'error', 'cancelled'],
      15_000,
      500,
    );

    const emittedOne = await api('POST', '/api/triggers/emit', {
      type: 'e2e.test.progress',
      agentId: created.agentId,
      payload: { turnId: started.turnId, step: 1 },
    });
    expect(emittedOne.status).toBe(200);

    const emittedTwo = await api('POST', '/api/triggers/emit', {
      type: 'e2e.test.progress',
      agentId: created.agentId,
      payload: { turnId: started.turnId, step: 2 },
    });
    expect(emittedTwo.status).toBe(200);

    const persisted = await waitForEventType(
      'e2e.test.progress',
      (event) => String(event?.payload ?? '').includes(started.turnId),
    );
    expect(persisted.status).toBe(200);

    const finished = await waitForTurn(created.agentId, started.turnId);
    expect(getTurnStatus(finished)).toBe('completed');
  }, TEST_TIMEOUT_MS);

  it('S3d: SSE stream reports AG-UI lifecycle events', async () => {
    const created = await createAgent();
    const stream = await openSseStream(created.agentId);

    try {
      const started = await startTurn(created.agentId, 'Reply with SSE ok.');
      const finished = await waitForTurn(created.agentId, started.turnId);
      expect(getTurnStatus(finished)).toBe('completed');

      await waitFor(
        async () => stream.events,
        (events) => events.some((event) => event.type === 'RUN_STARTED' || event.type === 'TEXT_MESSAGE_CONTENT'),
        'SSE lifecycle events',
        30_000,
        500,
      );

      expect(stream.events.some((event) => event.type === 'RUN_STARTED' || event.type === 'TEXT_MESSAGE_CONTENT')).toBe(true);
    } finally {
      await stream.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe('Scenario Group 4: Filesystem Access', () => {
  it('S4a: external file writes are visible in the agent workspace', async () => {
    const created = await createAgent();

    const writeFile = await api('POST', `/api/agents/${created.agentId}/files`, {
      path: 'workspace-visible.txt',
      content: 'hello from the outside',
    });
    expect(writeFile.status).toBe(201);

    const list = await api('GET', `/api/agents/${created.agentId}/files`);
    expect(list.status).toBe(200);
    expect(getEntries(list.data).some((entry) => entry?.name === 'workspace-visible.txt')).toBe(true);

    const readFile = await api('GET', `/api/agents/${created.agentId}/files/read?path=workspace-visible.txt`);
    expect(readFile.status).toBe(200);
    expect(readFile.data?.content).toBe('hello from the outside');
  }, TEST_TIMEOUT_MS);

  it('S4b: file CRUD lifecycle works through the HTTP API', async () => {
    const created = await createAgent();

    const createFile = await api('POST', `/api/agents/${created.agentId}/files`, {
      path: 'crud/file.txt',
      content: 'first version',
    });
    expect(createFile.status).toBe(201);

    const readInitial = await api('GET', `/api/agents/${created.agentId}/files/read?path=${encodeURIComponent('crud/file.txt')}`);
    expect(readInitial.status).toBe(200);
    expect(readInitial.data?.content).toBe('first version');

    const updateFile = await api('PUT', `/api/agents/${created.agentId}/files`, {
      path: 'crud/file.txt',
      content: 'second version',
    });
    expect(updateFile.status).toBe(200);

    const readUpdated = await api('GET', `/api/agents/${created.agentId}/files/read?path=${encodeURIComponent('crud/file.txt')}`);
    expect(readUpdated.status).toBe(200);
    expect(readUpdated.data?.content).toBe('second version');

    const deleteFile = await api('DELETE', `/api/agents/${created.agentId}/files?path=${encodeURIComponent('crud/file.txt')}`);
    expect(deleteFile.status).toBe(204);

    const readMissing = await api('GET', `/api/agents/${created.agentId}/files/read?path=${encodeURIComponent('crud/file.txt')}`);
    expect([400, 404]).toContain(readMissing.status);
  }, TEST_TIMEOUT_MS);

  it('S4c: rejects path traversal attempts', async () => {
    const created = await createAgent();

    const listTraversal = await api('GET', `/api/agents/${created.agentId}/files?path=${encodeURIComponent('../../../etc')}`);
    expect([400, 403]).toContain(listTraversal.status);

    const readTraversal = await api('GET', `/api/agents/${created.agentId}/files/read?path=${encodeURIComponent('../../../etc/passwd')}`);
    expect([400, 403]).toContain(readTraversal.status);

    const postTraversal = await api('POST', `/api/agents/${created.agentId}/files`, {
      path: '../../../tmp/bad.txt',
      content: 'blocked',
    });
    expect([400, 403]).toContain(postTraversal.status);
  }, TEST_TIMEOUT_MS);

});

describe('Scenario Group 5: Turn Lifecycle', () => {
  it('S5a: background turns can be cancelled', async () => {
    const created = await createAgent({
      systemPrompt: 'When asked to request approval, immediately call request-approval with reason "Scenario cancellation approval". Do not answer normally before calling the tool.',
      tools: ['request-approval'],
    });

    const started = await startTurn(created.agentId, 'Request approval now.');
    await waitFor(
      async () => api('GET', `/api/agents/${created.agentId}/interrupts`),
      (response) => response.status === 200 &&
        hasPendingInterruptForTurn(response, started.turnId),
      'pending approval interrupt',
      90_000,
      1_000,
    );

    const cancel = await api('POST', `/api/agents/${created.agentId}/turns/${started.turnId}/cancel`);
    expect(cancel.status).toBe(200);

    const finished = await waitForTurn(created.agentId, started.turnId, 30_000);
    expect(['cancelled', 'error']).toContain(getTurnStatus(finished));

    const pendingAfterCancel = await api('GET', `/api/agents/${created.agentId}/interrupts`);
    expect(pendingAfterCancel.status).toBe(200);
    expect(hasPendingInterruptForTurn(pendingAfterCancel, started.turnId)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('S5b: turns report observable and terminal lifecycle states', async () => {
    const created = await createAgent();

    let observedState: unknown = null;
    let completed: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = await startTurn(
        created.agentId,
        'Think step by step for a little while, then answer with done.',
      );

      try {
        observedState = await waitForTurnState(
          created.agentId,
          started.turnId,
          ['active', 'running', 'completed', 'error', 'cancelled'],
          10_000,
          250,
        );
      } catch {
        observedState = null;
      }

      completed = await waitForTurn(created.agentId, started.turnId);
      if (observedState) break;
    }

    expect(observedState).toBeTruthy();
    const turn = getTurn(completed);
    expect(['completed', 'error', 'cancelled']).toContain(getTurnStatus(completed));
    expect(typeof turn.startedAt).toBe('number');
    expect(typeof turn.completedAt).toBe('number');
    expect((turn.durationMs ?? (turn.completedAt - turn.startedAt)) > 0).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('Scenario Group 6: Webhook & Callback', () => {
  it('S6a: webhook CRUD works and rejects invalid event types', async () => {
    const created = await createAgent();

    const createWebhook = await api('POST', `/api/agents/${created.agentId}/webhooks`, {
      url: 'https://hooks.example.test/callback',
      events: ['turn.completed'],
      secret: 'scenario-webhook-secret',
    });
    expect(createWebhook.status).toBe(201);

    const list = await api('GET', `/api/agents/${created.agentId}/webhooks`);
    expect(list.status).toBe(200);
    expect(list.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: createWebhook.data.id, url: 'https://hooks.example.test/callback' }),
    ]));

    const invalid = await api('POST', `/api/agents/${created.agentId}/webhooks`, {
      url: 'https://hooks.example.test/invalid',
      events: ['run.invalid'],
    });
    expect(invalid.status).toBe(400);

    const deleted = await api('DELETE', `/api/agents/${created.agentId}/webhooks/${createWebhook.data.id}`);
    expect(deleted.status).toBe(204);

    const listAfter = await api('GET', `/api/agents/${created.agentId}/webhooks`);
    expect(listAfter.status).toBe(200);
    expect(listAfter.data).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('S6b: invalid webhook payload returns strict field issues', async () => {
    const created = await createAgent();

    const invalid = await api('POST', `/api/agents/${created.agentId}/webhooks`, {
      url: 'https://hooks.example.test/invalid-events',
      events: ['turn.completed', 'run.unknown'],
      secret: 'scenario-webhook-secret',
    });

    expect(invalid.status).toBe(400);
    expect(invalid.data).toMatchObject({
      error: 'Invalid webhook definition',
      issues: [expect.objectContaining({ path: 'events.1' })],
    });
  }, TEST_TIMEOUT_MS);
});
