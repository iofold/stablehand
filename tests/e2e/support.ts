import { expect, type APIRequestContext } from '@playwright/test';

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
      harnessConfig: options.harnessConfig ?? { provider: 'openai', model: 'gpt-5-mini' },
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
): Promise<{ runId: string; conversationId: string }> {
  const response = await request.post(`${API_BASE}/api/agents/${agentId}/run`, {
    data: { task, mode: 'background' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { runId: string; conversationId: string };
}

export async function sendAgentMessage(
  request: APIRequestContext,
  agentId: string,
  content: string,
  conversationId?: string,
): Promise<{ messageId: string; conversationId: string; runId: string }> {
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
    runId: string;
  };
}

export async function waitForRunStatus(
  request: APIRequestContext,
  agentId: string,
  runId: string,
  statuses: string[],
  timeoutMs = 60_000,
): Promise<{ id: string; status: string; conversationId: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await request.get(`${API_BASE}/api/agents/${agentId}/runs`);
    expect(response.ok()).toBeTruthy();
    const runs = (await response.json()) as Array<{
      id: string;
      status: string;
      conversationId: string;
    }>;
    const run = runs.find((entry) => entry.id === runId);
    if (run && statuses.includes(run.status)) {
      return run;
    }
    await delay(1_000);
  }

  throw new Error(
    `Timed out waiting for run ${runId} to reach one of: ${statuses.join(', ')}`,
  );
}

export async function getConversationMessages(
  request: APIRequestContext,
  agentId: string,
  conversationId: string,
): Promise<Array<{ id: string; role: string; content: string }>> {
  const response = await request.get(
    `${API_BASE}/api/agents/${agentId}/conversations/${conversationId}/messages`,
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Array<{
    id: string;
    role: string;
    content: string;
  }>;
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

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

type FsModule = {
  readFileSync(path: string, encoding: string): string;
};

type PathModule = {
  join(...paths: string[]): string;
};

const loadFs = new Function('return import("node:fs")') as () => Promise<FsModule>;
const loadPath = new Function('return import("node:path")') as () => Promise<PathModule>;
const loadYaml = new Function('return import("yaml")') as () => Promise<{ parse(s: string): unknown }>;

export async function importStressAgent(
  request: APIRequestContext,
  agentDir: string,
): Promise<TestAgent> {
  const fs = await loadFs();
  const path = await loadPath();
  const yamlLib = await loadYaml();
  const manifestPath = path.join(process.cwd(), 'tests', 'stress', 'agents', agentDir, 'agent.yaml');
  const raw = yamlLib.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  const meta = (raw.metadata ?? {}) as Record<string, unknown>;
  const spec = (raw.spec ?? {}) as Record<string, unknown>;
  const tools = (spec.tools as Array<{ ref?: string }> | undefined) ?? [];

  const response = await request.post(`${API_BASE}/api/agents`, {
    data: {
      name: meta.name as string,
      harness: spec.harness as string,
      harnessConfig: (spec.harnessConfig ?? {}) as Record<string, unknown>,
      systemPrompt: (spec.instructions ?? '') as string,
      tools: tools.map((t) => t.ref).filter(Boolean),
      description: (meta.description ?? null) as string | null,
    },
  });
  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  return { id: result.id, name: result.name } as TestAgent;
}

export async function getInterrupts(
  request: APIRequestContext,
  agentId: string,
): Promise<Array<{ id: string; runId: string; toolName: string; args: Record<string, unknown> }>> {
  const response = await request.get(`${API_BASE}/api/agents/${agentId}/interrupts`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.interrupts ?? [];
}

export async function resolveInterrupt(
  request: APIRequestContext,
  agentId: string,
  runId: string,
  action: 'approve' | 'reject',
): Promise<{ resolved: boolean; action: string }> {
  const response = await request.post(`${API_BASE}/api/agents/${agentId}/interrupt`, {
    data: { action, runId },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { resolved: boolean; action: string };
}

export async function getEvents(
  request: APIRequestContext,
  filters: { type?: string; agentId?: string; limit?: number } = {},
): Promise<Array<{ id: string; type: string; payload: string; agentId?: string; createdAt: string }>> {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.agentId) params.set('agentId', filters.agentId);
  if (filters.limit) params.set('limit', String(filters.limit));
  const response = await request.get(`${API_BASE}/api/events?${params.toString()}`);
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.events ?? [];
}

export async function cancelRun(
  request: APIRequestContext,
  agentId: string,
  runId: string,
): Promise<void> {
  await request.post(`${API_BASE}/api/agents/${agentId}/runs/${runId}/cancel`);
}
