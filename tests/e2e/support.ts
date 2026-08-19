import { expect, type APIRequestContext } from '@playwright/test';
import { join } from 'node:path';
import { loadManifestProject } from '@ctxmill/manifest/node';

export const API_BASE =
  process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://localhost:3002';

export interface TestAgent {
  id: string;
  name: string;
  workspaceDir?: string | null;
  harness?: string | null;
  harnessConfig?: Record<string, unknown> | null;
}

interface CreateAgentOptions {
  name?: string;
  systemPrompt?: string;
  tools?: string[];
  description?: string;
  metadata?: Record<string, unknown>;
  harness?: string;
  harnessConfig?: Record<string, unknown> | null;
}

export async function createTestAgent(
  request: APIRequestContext,
  options: CreateAgentOptions = {},
): Promise<TestAgent> {
  const response = await request.post(`${API_BASE}/api/agents`, {
    data: {
      name: options.name ?? `e2e-agent-${Date.now()}`,
      harness: options.harness ?? 'langgraph',
      harnessConfig: options.harnessConfig ?? { provider: 'openai', model: 'gpt-5.4-mini' },
      systemPrompt:
        options.systemPrompt ??
        'You are a deterministic end-to-end test agent. Respond concisely.',
      tools: options.tools ?? [],
      description: options.description,
      metadata: options.metadata,
    },
  });

  expect(response.ok()).toBeTruthy();
  return (await response.json()) as TestAgent;
}

export async function deleteTestAgent(
  request: APIRequestContext,
  agentId: string,
): Promise<void> {
  const response = await request.delete(`${API_BASE}/api/agents/${agentId}`);
  expect([204, 404]).toContain(response.status());
}

export async function startBackgroundRun(
  request: APIRequestContext,
  agentId: string,
  task: string,
): Promise<{ turnId: string; conversationId: string }> {
  const response = await request.post(`${API_BASE}/api/agents/${agentId}/turns`, {
    data: { task },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { turnId: string; conversationId: string };
}

export async function sendAgentMessage(
  request: APIRequestContext,
  agentId: string,
  content: string,
  conversationId?: string,
): Promise<{ messageId: string; conversationId: string; turnId: string }> {
  const response = await request.post(
    `${API_BASE}/api/agents/${agentId}/message`,
    {
      data: conversationId ? { content, conversationId } : { content },
    },
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    messageId: string;
    conversationId: string;
    turnId: string;
  };
}

export async function waitForRunStatus(
  request: APIRequestContext,
  agentId: string,
  turnId: string,
  statuses: string[],
  timeoutMs = 60_000,
): Promise<{ id: string; sandboxSessionId?: string; status: string; conversationId: string }> {
  const deadline = Date.now() + timeoutMs;
  const expectedStatuses = new Set(statuses.map((status) => status.toLowerCase()));

  while (Date.now() < deadline) {
    const response = await request.get(`${API_BASE}/api/agents/${agentId}/turns`);
    if (!response.ok()) {
      await delay(1_000);
      continue;
    }
    const body = await response.json() as { turns?: Array<Record<string, unknown>> };
    const turns = body.turns ?? [];
    const turn = turns.find((t: Record<string, unknown>) =>
      t.id === turnId,
    );
    if (turn) {
      const derivedStatus = normalizeTurnStatus(String(turn.status ?? ''));
      if (expectedStatuses.has(derivedStatus)) {
        return { ...turn, status: derivedStatus } as {
          id: string;
          sandboxSessionId?: string;
          status: string;
          conversationId: string;
        };
      }
    }
    await delay(1_000);
  }

  throw new Error(
    `Timed out waiting for turn ${turnId} to reach one of: ${statuses.join(', ')}`,
  );
}

function normalizeTurnStatus(status: string): string {
  switch (status.toUpperCase()) {
    case 'QUEUED':
      return 'queued';
    case 'ACTIVE':
    case 'RESTORING':
      return 'running';
    case 'CHECKPOINTED':
      return 'paused';
    case 'TERMINATED':
    case 'COMPLETED':
      return 'completed';
    case 'ERROR':
      return 'error';
    case 'CANCELLED':
      return 'cancelled';
    case 'IDLE':
      return 'idle';
    default:
      return status.toLowerCase();
  }
}

export async function getConversationMessages(
  request: APIRequestContext,
  agentId: string,
  conversationId: string,
): Promise<Array<{ id: string; role: string; content: string }>> {
  const response = await request.get(
    `${API_BASE}/api/agents/${agentId}/conversations/${conversationId}/snapshot`,
  );
  expect(response.ok()).toBeTruthy();
  const snapshot = (await response.json()) as {
    messages: Array<{
    id: string;
    role: string;
    content: string;
    }>;
  };
  return snapshot.messages;
}

export async function waitForNonUserMessage(
  request: APIRequestContext,
  agentId: string,
  conversationId: string,
  timeoutMs = 60_000,
): Promise<{ id: string; role: string; content: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = await getConversationMessages(request, agentId, conversationId);
    const candidate = messages.find((message) => message.role !== 'user');
    if (candidate) return candidate;
    await delay(1_000);
  }

  throw new Error(
    `Timed out waiting for a non-user message in conversation ${conversationId}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function importStressAgent(
  request: APIRequestContext,
  agentDir: string,
): Promise<TestAgent> {
  const manifestPath = join(
    process.cwd(),
    'tests',
    'stress',
    'agents',
    agentDir,
    'agent.yaml',
  );
  const payload = (await loadManifestProject(manifestPath)).agentCreateInput;

  const existingAgentsResponse = await request.get(`${API_BASE}/api/agents`);
  expect(existingAgentsResponse.ok()).toBeTruthy();
  const existingAgents = await existingAgentsResponse.json() as Array<{ id: string; name: string }>;
  const sameNameAgents = existingAgents.filter((agent) => agent.name === payload.name);
  for (const agent of sameNameAgents) {
    await deleteTestAgent(request, agent.id);
  }

  const response = await request.post(`${API_BASE}/api/agents`, {
    data: payload,
  });
  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  return { id: result.id, name: result.name } as TestAgent;
}

export async function getInterrupts(
  request: APIRequestContext,
  agentId: string,
): Promise<Array<{
  interruptId: string;
  turnId: string;
  sandboxSessionId?: string;
  toolName: string;
  args: Record<string, unknown>;
}>> {
  const response = await request.get(`${API_BASE}/api/agents/${agentId}/interrupts`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.interrupts ?? [];
}

export async function resolveInterrupt(
  request: APIRequestContext,
  agentId: string,
  interruptId: string,
  action: 'approve' | 'reject',
): Promise<{ resolved: boolean; action: string }> {
  const response = await request.post(`${API_BASE}/api/agents/${agentId}/interrupt`, {
    data: { action, interruptId },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { resolved: boolean; action: string };
}

export async function getEvents(
  request: APIRequestContext,
  filters: { type?: string; agentId?: string; limit?: number } = {},
): Promise<Array<{ id: string; type: string; payload: string; agentId?: string; createdAt: number }>> {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.agentId) params.set('agentId', filters.agentId);
  if (filters.limit) params.set('limit', String(filters.limit));
  const response = await request.get(`${API_BASE}/api/events?${params.toString()}`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.events ?? [];
}

export async function cancelTurn(
  request: APIRequestContext,
  agentId: string,
  turnId: string,
): Promise<void> {
  await request.post(`${API_BASE}/api/agents/${agentId}/turns/${turnId}/cancel`);
}

export async function releaseAgentSandboxes(
  request: APIRequestContext,
  agentIds: Iterable<string>,
): Promise<void> {
  const ids = new Set(agentIds);
  const response = await request.get(`${API_BASE}/api/sandbox-sessions?status=active`);
  if (!response.ok()) return;
  const sessions = (await response.json()) as Array<{ id: string; agentId: string; status: string }>;
  for (const session of sessions) {
    if (session.status !== 'ACTIVE' || !ids.has(session.agentId)) continue;
    await request.post(`${API_BASE}/api/agents/${session.agentId}/sandbox-sessions/${session.id}/kill`);
  }
}
