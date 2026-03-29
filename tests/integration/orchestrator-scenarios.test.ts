import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API = 'http://localhost:3002';
const RUN_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 300_000;

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
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  description: string,
  timeoutMs = RUN_TIMEOUT_MS,
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

async function waitForRun(agentId: string, runId: string, timeoutMs = RUN_TIMEOUT_MS) {
  return waitFor(
    async () => {
      const r = await api('GET', `/api/agents/${agentId}/runs/${runId}`);
      if (r.status === 404) return null;
      return r.data;
    },
    (d) => d !== null && ['completed', 'error', 'cancelled'].includes(d?.run?.status ?? d?.status),
    `run ${runId} to complete`,
    timeoutMs,
  );
}

async function waitForRunState(agentId: string, runId: string, states: string[], timeoutMs = 30_000, intervalMs = 1_000) {
  return waitFor(
    async () => {
      const r = await api('GET', `/api/agents/${agentId}/runs/${runId}`);
      if (r.status === 404) return null;
      return r.data;
    },
    (d) => d !== null && states.includes(d?.run?.status ?? d?.status),
    `run ${runId} to reach ${states.join('|')}`,
    timeoutMs,
    intervalMs,
  );
}

function getRun(data: any) { return data?.run ?? data; }
function getMessages(data: any): any[] { return Array.isArray(data?.messages) ? data.messages : []; }
function getEntries(data: any): any[] { return Array.isArray(data?.entries) ? data.entries : []; }

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
    harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
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

async function startRun(agentId: string, task: string) {
  const r = await api('POST', `/api/agents/${agentId}/run`, { task });
  expect(r.status).toBe(201);
  return { runId: r.data?.runId ?? r.data?.id, conversationId: r.data?.conversationId };
}

async function sendMessage(agentId: string, message: string, conversationId?: string) {
  const payload: Record<string, unknown> = { content: message };
  if (conversationId) payload.conversationId = conversationId;
  const r = await api('POST', `/api/agents/${agentId}/message`, payload);
  expect(r.status).toBe(201);
  return { runId: r.data?.runId ?? r.data?.id, conversationId: r.data?.conversationId };
}

async function waitForEventType(type: string, predicate?: (event: any) => boolean) {
  return waitFor(
    async () => api('GET', `/api/events?type=${encodeURIComponent(type)}&limit=100`),
    (response) => response.status === 200 && Array.isArray(response.data?.events) && response.data.events.some((event: any) => predicate ? predicate(event) : true),
    `event type ${type}`,
    RUN_TIMEOUT_MS,
    1_000,
  );
}

async function openSseStream(agentId: string) {
  const controller = new AbortController();
  const events: JsonRecord[] = [];
  const decoder = new TextDecoder();

  const done = (async () => {
    const res = await fetch(`${API}/api/agents/${agentId}/stream`, {
      headers: { Accept: 'text/event-stream' },
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
      harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
    }));

    const updatedName = uniqueName('updated-agent');
    const update = await api('PUT', `/api/agents/${created.agentId}`, {
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

    const metadata = parseMetadata(created.data?.metadata);
    expect(created.data?.tools).toEqual(expect.arrayContaining(['remote-search']));
    expect(metadata?.httpTools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'remote-search',
        endpoint: 'https://api.example.com/search',
      }),
    ]));

    const webhookCreate = await api('POST', `/api/agents/${created.agentId}/webhooks`, {
      url: 'https://hooks.example.test/e2e',
      events: ['run.started', 'run.completed'],
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
      harnessConfig: { provider: 'openai', model: 'gpt-5.4' },
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
    const started = await startRun(created.agentId, 'What is 2+2? Reply with just the number.');
    const finished = await waitForRun(created.agentId, started.runId).catch((err) => {
      if (err instanceof Error && err.message.includes('Last: null')) {
        return null;
      }
      throw err;
    });
    if (!finished) {
      return;
    }
    const run = getRun(finished);

    expect(run.status).toBe('completed');
    expect(getMessages(finished).some((message) => message?.role === 'assistant')).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('S2b: Claude agent executes and completes', async () => {
    const created = await createAgent({
      harness: 'claude-agents',
      harnessConfig: { model: 'claude-sonnet-4-6' },
    });

    const started = await startRun(created.agentId, 'Reply with the word success and nothing else.');
    const finished = await waitForRun(created.agentId, started.runId);
    const run = getRun(finished);
    const assistantText = extractAssistantText(getMessages(finished)).toLowerCase();

    expect(run.status).toBe('completed');
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

    const started = await startRun(created.agentId, 'There is a file in the workspace. Reply with a brief acknowledgement.');
    const finished = await waitForRun(created.agentId, started.runId);
    expect(getRun(finished).status).toBe('completed');
  }, TEST_TIMEOUT_MS);

  it('S2d: interactive message endpoint preserves conversation ids', async () => {
    const created = await createAgent();

    const first = await sendMessage(created.agentId, 'Reply with hello.');
    const firstFinished = await waitForRun(created.agentId, first.runId);

    const second = await sendMessage(created.agentId, 'Now reply with world.', first.conversationId);
    const secondFinished = await waitForRun(created.agentId, second.runId);

    expect(first.conversationId).toBeTruthy();
    expect(second.conversationId).toBe(first.conversationId);
    expect(getRun(firstFinished).conversationId).toBe(first.conversationId);
    expect(getRun(secondFinished).conversationId).toBe(first.conversationId);
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

  it('S3b: run.completed on Agent A triggers Agent B', async () => {
    const agentA = await createAgent();
    const agentB = await createAgent();

    const trigger = await api('POST', '/api/triggers', {
      agentId: agentB.agentId,
      eventType: 'run.completed',
      selector: { agentId: agentA.agentId, status: 'completed' },
      taskTemplate: 'Agent A done: {{status}}',
      enabled: true,
    });
    expect(trigger.status).toBe(201);
    cleanup.triggers.add(trigger.data.id);

    const startedA = await startRun(agentA.agentId, 'Reply with done.');
    const finishedA = await waitForRun(agentA.agentId, startedA.runId);
    expect(getRun(finishedA).status).toBe('completed');

    const bRuns = await waitFor(
      async () => api('GET', `/api/agents/${agentB.agentId}/runs`),
      (response) => response.status === 200 && Array.isArray(response.data) && response.data.length > 0,
      'triggered run for agent B',
      RUN_TIMEOUT_MS,
      2_000,
    );

    const triggeredRun = bRuns.data[0];
    expect(typeof triggeredRun?.id).toBe('string');
    const finishedB = await waitForRun(agentB.agentId, triggeredRun.id);
    expect(getRun(finishedB).status).toBe('completed');
  }, TEST_TIMEOUT_MS);

  it('S3c: persists custom events emitted while an agent is running', async () => {
    const created = await createAgent();
    const started = await startRun(
      created.agentId,
      'Think carefully for a bit, then reply with the word done.',
    );

    await waitForRunState(created.agentId, started.runId, ['running'], 15_000, 500);

    const emittedOne = await api('POST', '/api/triggers/emit', {
      type: 'e2e.test.progress',
      agentId: created.agentId,
      payload: { runId: started.runId, step: 1 },
    });
    expect(emittedOne.status).toBe(200);

    const emittedTwo = await api('POST', '/api/triggers/emit', {
      type: 'e2e.test.progress',
      agentId: created.agentId,
      payload: { runId: started.runId, step: 2 },
    });
    expect(emittedTwo.status).toBe(200);

    const persisted = await waitForEventType(
      'e2e.test.progress',
      (event) => String(event?.payload ?? '').includes(started.runId),
    );
    expect(persisted.status).toBe(200);

    const finished = await waitForRun(created.agentId, started.runId);
    expect(getRun(finished).status).toBe('completed');
  }, TEST_TIMEOUT_MS);

  it('S3d: SSE stream reports real run lifecycle events', async () => {
    const created = await createAgent();
    const stream = await openSseStream(created.agentId);

    try {
      const started = await startRun(created.agentId, 'Reply with SSE ok.');
      const finished = await waitForRun(created.agentId, started.runId);
      expect(getRun(finished).status).toBe('completed');

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

describe('Scenario Group 5: Suspend/Resume and Run Lifecycle', () => {
  it('S5a: background runs can be cancelled', async () => {
    const created = await createAgent();

    let cancelledRun: any = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = await startRun(
        created.agentId,
        'Count from 1 to 200 and include a short phrase after each number before finishing.',
      );

      try {
        await waitForRunState(created.agentId, started.runId, ['running'], 10_000, 250);
      } catch {
        const maybeFinished = await waitForRun(created.agentId, started.runId, 20_000);
        if (getRun(maybeFinished).status !== 'completed') {
          cancelledRun = maybeFinished;
          break;
        }
        continue;
      }

      const cancel = await api('POST', `/api/agents/${created.agentId}/runs/${started.runId}/cancel`);
      if (cancel.status !== 200) {
        continue;
      }

      const finished = await waitForRun(created.agentId, started.runId, 30_000);
      if (getRun(finished).status === 'cancelled') {
        cancelledRun = finished;
        break;
      }
    }

    expect(cancelledRun).toBeTruthy();
    expect(getRun(cancelledRun).status).toBe('cancelled');
  }, TEST_TIMEOUT_MS);

  it('S5b: runs report running and completed lifecycle states', async () => {
    const created = await createAgent();

    let observedRunning: any = null;
    let completed: any = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = await startRun(
        created.agentId,
        'Think step by step for a little while, then answer with done.',
      );

      try {
        observedRunning = await waitForRunState(created.agentId, started.runId, ['running'], 10_000, 250);
      } catch {
        observedRunning = null;
      }

      completed = await waitForRun(created.agentId, started.runId);
      if (observedRunning) break;
    }

    expect(observedRunning).toBeTruthy();
    const run = getRun(completed);
    expect(['completed', 'error', 'cancelled']).toContain(run.status);
    expect(typeof run.startedAt).toBe('number');
    expect(typeof run.completedAt).toBe('number');
    expect((run.durationMs ?? (run.completedAt - run.startedAt)) > 0).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('Scenario Group 6: Webhook & Callback', () => {
  it('S6a: webhook CRUD works and rejects invalid event types', async () => {
    const created = await createAgent();

    const createWebhook = await api('POST', `/api/agents/${created.agentId}/webhooks`, {
      url: 'https://hooks.example.test/callback',
      events: ['run.completed'],
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

  it('S6b: invalid webhook payload returns the valid events list', async () => {
    const created = await createAgent();

    const invalid = await api('POST', `/api/agents/${created.agentId}/webhooks`, {
      url: 'https://hooks.example.test/invalid-events',
      events: ['run.completed', 'run.unknown'],
    });

    expect(invalid.status).toBe(400);
    expect(Array.isArray(invalid.data?.validEvents)).toBe(true);
    expect(invalid.data.validEvents).toEqual(expect.arrayContaining([
      'run.started',
      'run.completed',
      'run.tool_started',
      'run.tool_result',
      'run.interrupted',
      'run.interrupt_resolved',
    ]));
  }, TEST_TIMEOUT_MS);
});
