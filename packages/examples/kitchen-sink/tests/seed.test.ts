import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const seedPath = fileURLToPath(new URL('../seed.ts', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));

interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  body: Buffer;
}

interface MockTrigger {
  id: string;
  agentId: string;
  eventType: string;
  taskTemplate: string;
  enabled: boolean;
}

interface MockApiOptions {
  agentListStatus?: number;
  existingAgents?: Array<{ id: string; name: string }>;
  existingTriggers?: MockTrigger[];
  failAgentName?: string;
  triggerStatus?: number;
  env?: Record<string, string>;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function runSeeder(options: MockApiOptions = {}): Promise<{
  requests: RecordedRequest[];
  stdout: string;
}> {
  const requests: RecordedRequest[] = [];
  const triggers = structuredClone(options.existingTriggers ?? []);
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const body = await readBody(request);
    requests.push({
      method,
      path,
      ...(typeof request.headers.authorization === 'string'
        ? { authorization: request.headers.authorization }
        : {}),
      body,
    });

    if (method === 'GET' && path === '/api/agents') {
      const status = options.agentListStatus ?? 200;
      sendJson(
        response,
        status,
        status === 200 ? options.existingAgents ?? [] : { error: 'agent list seed test failure' },
      );
      return;
    }

    if (method === 'PATCH' && path.startsWith('/api/agents/')) {
      const id = path.slice('/api/agents/'.length);
      const existing = options.existingAgents?.find((agent) => agent.id === id);
      if (!existing) {
        sendJson(response, 404, { error: 'Agent not found' });
        return;
      }
      sendJson(response, 200, existing);
      return;
    }

    if (method === 'POST' && path === '/api/agents') {
      const payload = JSON.parse(body.toString('utf8')) as { name: string };
      if (payload.name === options.failAgentName) {
        sendJson(response, 500, { error: 'seed test failure' });
        return;
      }
      sendJson(response, 201, { id: `agent-${payload.name}`, name: payload.name });
      return;
    }

    if (method === 'POST' && path.startsWith('/api/agents/') && path.endsWith('/workspace')) {
      sendJson(response, 201, {
        revision: 1,
        sha256: 'seed-test',
        fileCount: 1,
        totalBytes: body.byteLength,
        appliedAt: Date.now(),
      });
      return;
    }

    if (method === 'GET' && path === '/api/triggers') {
      sendJson(response, 200, triggers);
      return;
    }

    if (method === 'POST' && path === '/api/triggers') {
      const status = options.triggerStatus ?? 201;
      const payload = JSON.parse(body.toString('utf8')) as Omit<MockTrigger, 'id'>;
      const existing = triggers.find(
        (trigger) => trigger.agentId === payload.agentId && trigger.eventType === payload.eventType,
      );
      if (status === 201 && existing) {
        sendJson(response, status, existing);
        return;
      }
      const created = { id: `trigger-${requests.length}`, ...payload };
      if (status === 201) {
        triggers.push(created);
      }
      sendJson(
        response,
        status,
        status === 201
          ? created
          : { error: 'trigger seed test failure' },
      );
      return;
    }

    if (method === 'PUT' && path.startsWith('/api/triggers/')) {
      const id = path.slice('/api/triggers/'.length);
      const trigger = triggers.find((candidate) => candidate.id === id);
      if (!trigger) {
        sendJson(response, 404, { error: 'Trigger not found' });
        return;
      }
      Object.assign(trigger, JSON.parse(body.toString('utf8')) as Partial<MockTrigger>);
      sendJson(response, 200, trigger);
      return;
    }

    sendJson(response, 404, { error: `Unhandled ${method} ${path}` });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected mock API TCP address');
  }

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', seedPath],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          API_URL: `http://127.0.0.1:${address.port}`,
          STABLEHAND_API_TOKEN: 'seed-test-token',
          KITCHEN_SINK_TEST_AGENTS: '',
          ...options.env,
        },
        timeout: 30_000,
      },
    );
    return { requests, stdout };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function expectSeederFailure(options: MockApiOptions): Promise<void> {
  let failure: unknown;
  try {
    await runSeeder(options);
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 1 });
}

function createdAgentNames(requests: RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.method === 'POST' && request.path === '/api/agents')
    .map((request) => (JSON.parse(request.body.toString('utf8')) as { name: string }).name)
    .sort();
}

describe('kitchen-sink seeder', () => {
  it('seeds the example chain and leaves the feature-test agents out by default', async () => {
    const { requests, stdout } = await runSeeder();

    expect(stdout).toContain('Seed complete');
    expect(createdAgentNames(requests)).toEqual(['claude-writer', 'langgraph-analyst', 'pi-auditor']);
  });

  it('uploads declared manifest workspaces through authenticated API calls', async () => {
    const { requests, stdout } = await runSeeder({ env: { KITCHEN_SINK_TEST_AGENTS: '1' } });
    expect(createdAgentNames(requests)).toEqual([
      'claude-writer',
      'langgraph-analyst',
      'pi-auditor',
      'test-claude-features',
      'test-lg-features',
    ]);

    expect(stdout).toContain('Seed complete');
    const workspaceUpload = requests.find(
      (request) => request.method === 'POST'
        && request.path === '/api/agents/agent-test-claude-features/workspace',
    );
    expect(workspaceUpload, 'test-claude-features workspace upload').toBeDefined();
    expect(workspaceUpload?.body.byteLength).toBeGreaterThan(0);
    expect(requests.every(
      (request) => request.authorization === 'Bearer seed-test-token',
    )).toBe(true);

    const triggerSignatures = requests
      .filter((request) => request.method === 'POST' && request.path === '/api/triggers')
      .map((request) => {
        const trigger = JSON.parse(request.body.toString('utf8')) as {
          agentId: string;
          eventType: string;
        };
        return `${trigger.agentId}:${trigger.eventType}`;
      });
    expect(new Set(triggerSignatures).size).toBe(triggerSignatures.length);
  });

  it('exits nonzero when any agent cannot be seeded', async () => {
    await expectSeederFailure({ failAgentName: 'langgraph-analyst' });
  });

  it('exits nonzero when a trigger cannot be seeded', async () => {
    await expectSeederFailure({ triggerStatus: 500 });
  });

  it('reconciles stale trigger configuration instead of reporting it as current', async () => {
    const { requests } = await runSeeder({
      existingTriggers: [{
        id: 'stale-trigger',
        agentId: 'agent-claude-writer',
        eventType: 'analysis.complete',
        taskTemplate: 'stale template',
        enabled: false,
      }],
    });

    const update = requests.find(
      (request) => request.method === 'PUT'
        && request.path === '/api/triggers/stale-trigger',
    );
    expect(update, 'stale trigger update').toBeDefined();
    expect(JSON.parse(update?.body.toString('utf8') ?? '{}')).toEqual({
      taskTemplate: 'Write a polished final report based on this analysis:\n\n{{payload.analysis}}',
      enabled: true,
    });
  });

  it('updates already-seeded agents in place with PATCH', async () => {
    const existingAgents = [
      { id: 'existing-writer', name: 'claude-writer' },
      { id: 'existing-auditor', name: 'pi-auditor' },
    ];
    const { requests, stdout } = await runSeeder({ existingAgents });

    expect(stdout).toContain('Seed complete');
    const updates = requests
      .filter((request) => request.path === '/api/agents/existing-writer'
        || request.path === '/api/agents/existing-auditor')
      .map((request) => `${request.method} ${request.path}`)
      .sort();
    expect(updates).toEqual([
      'PATCH /api/agents/existing-auditor',
      'PATCH /api/agents/existing-writer',
    ]);
    const writerUpdate = requests.find((request) => request.path === '/api/agents/existing-writer');
    expect(JSON.parse(writerUpdate?.body.toString('utf8') ?? '{}')).toMatchObject({
      name: 'claude-writer',
      mode: 'both',
    });
  });

  it('exits nonzero before writes when existing agents cannot be listed', async () => {
    await expectSeederFailure({ agentListStatus: 500 });
  });
});
