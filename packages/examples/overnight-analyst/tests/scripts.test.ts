import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const seedPath = fileURLToPath(new URL('../seed.ts', import.meta.url));
const runOncePath = fileURLToPath(new URL('../run-once.ts', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const MASTER = 'master-test-token';
const GOOD_GALLERY_KEY = 'cmk_good_gallery_key';
const NEW_GALLERY_TOKEN = `cmk_${'n'.repeat(40)}`;

interface Recorded {
  method: string;
  path: string;
  authorization?: string;
  body: unknown;
}

interface ApiKeyRow {
  id: string;
  name: string;
  status: 'active' | 'expired' | 'revoked';
}

interface MockAgent {
  id: string;
  name: string;
  harnessConfig?: Record<string, unknown>;
  tools?: string[];
  systemPrompt?: string;
}

interface MockState {
  agents: MockAgent[];
  schedules: Array<{ name: string }>;
  triggers: Array<{ agentId: string; eventType: string }>;
  keys: ApiKeyRow[];
  artifacts: Array<{ id: string; name: string; agentId: string; turnId?: string }>;
  /** Turn states returned in order on each poll after the event fires. */
  turnStates: Array<Record<string, unknown>>;
}

function freshState(): MockState {
  return { agents: [], schedules: [], triggers: [], keys: [], artifacts: [], turnStates: [] };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) as unknown : null;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function runScript(
  script: string,
  state: MockState,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  let emittedAt = 0;
  let polls = 0;
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const body = await readJson(request);
    const authorization = request.headers.authorization;
    requests.push({ method, path: `${path}${url.search}`, ...(authorization ? { authorization } : {}), body });

    if (path === '/api/artifacts' && authorization === `Bearer ${GOOD_GALLERY_KEY}`) {
      send(response, 200, { artifacts: [], total: 0 });
      return;
    }
    if (authorization !== `Bearer ${MASTER}`) {
      send(response, 401, { error: 'Unauthorized' });
      return;
    }
    if (method === 'GET' && path === '/api/agents') return send(response, 200, state.agents);
    if (method === 'POST' && path === '/api/agents') {
      const created = { id: 'agent-1', ...(body as Omit<MockAgent, 'id'>) };
      state.agents.push(created);
      return send(response, 201, created);
    }
    if (method === 'PATCH' && path.startsWith('/api/agents/')) {
      const agent = state.agents.find((candidate) => candidate.id === path.slice('/api/agents/'.length));
      if (!agent) return send(response, 404, { error: 'Agent not found' });
      Object.assign(agent, body as Partial<MockAgent>);
      return send(response, 200, agent);
    }
    if (method === 'GET' && path === '/api/schedules') return send(response, 200, { schedules: state.schedules });
    if (method === 'POST' && path === '/api/schedules') {
      state.schedules.push(body as { name: string });
      return send(response, 201, body);
    }
    if (method === 'GET' && path === '/api/triggers') return send(response, 200, state.triggers);
    if (method === 'POST' && path === '/api/triggers') {
      state.triggers.push(body as { agentId: string; eventType: string });
      return send(response, 201, body);
    }
    if (method === 'GET' && path === '/api/keys') return send(response, 200, { keys: state.keys });
    if (method === 'POST' && path === '/api/keys') {
      const row = { id: `key-${state.keys.length + 1}`, name: (body as { name: string }).name, status: 'active' as const };
      state.keys.push(row);
      return send(response, 201, { ...row, token: NEW_GALLERY_TOKEN });
    }
    if (method === 'DELETE' && path.startsWith('/api/keys/')) {
      const row = state.keys.find((key) => key.id === path.slice('/api/keys/'.length));
      if (row) row.status = 'revoked';
      return send(response, row ? 200 : 404, row ?? { error: 'Unknown api key' });
    }
    if (method === 'POST' && path === '/api/triggers/emit') {
      emittedAt = Date.now();
      return send(response, 202, { accepted: true });
    }
    if (method === 'GET' && /^\/api\/agents\/[^/]+\/turns$/.test(path)) {
      return send(response, 200, { turns: emittedAt ? [{ id: 'turn-1', status: 'QUEUED', queuedAt: emittedAt }] : [] });
    }
    if (method === 'GET' && /^\/api\/agents\/[^/]+\/turns\/turn-1$/.test(path)) {
      const turnState = state.turnStates[Math.min(polls, state.turnStates.length - 1)];
      polls += 1;
      return send(response, 200, { turn: { id: 'turn-1', queuedAt: emittedAt, startedAt: emittedAt, ...turnState }, messages: [] });
    }
    if (method === 'GET' && path === '/api/artifacts') {
      const turnId = url.searchParams.get('turnId');
      const agentId = url.searchParams.get('agentId');
      const artifacts = state.artifacts.filter((artifact) =>
        (!turnId || artifact.turnId === turnId) && (!agentId || artifact.agentId === agentId));
      return send(response, 200, { artifacts, total: artifacts.length });
    }
    send(response, 404, { error: `Unhandled ${method} ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');

  try {
    return await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--experimental-strip-types', script],
        {
          cwd: workspaceRoot,
          env: {
            PATH: process.env.PATH ?? '',
            API_URL: `http://127.0.0.1:${address.port}`,
            STABLEHAND_API_TOKEN: MASTER,
            POLL_MS: '10',
            ...env,
          },
          timeout: 30_000,
        },
        (error, stdout) => {
          const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
          resolve({ code, stdout, requests });
        },
      );
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function galleryKeyLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith('GALLERY_API_KEY='));
}

describe('overnight-analyst seed', () => {
  it('creates the agent without a direct key, with a spend cap, plus a scoped gallery key', async () => {
    const state = freshState();
    const { code, stdout, requests } = await runScript(seedPath, state);

    expect(code).toBe(0);
    const agent = requests.find((request) => request.method === 'POST' && request.path === '/api/agents');
    const harnessConfig = (agent?.body as { harnessConfig: Record<string, unknown> }).harnessConfig;
    expect(harnessConfig.apiKeyRef).toBeUndefined();
    expect(harnessConfig.limits).toEqual({ maxCostUsd: 0.5 });

    const schedule = requests.find((request) => request.method === 'POST' && request.path === '/api/schedules');
    expect(schedule?.body).toMatchObject({ timezone: 'UTC', eventType: 'custom.overnight.brief' });

    const key = requests.find((request) => request.method === 'POST' && request.path === '/api/keys');
    expect(key?.body).toMatchObject({
      name: 'artifact-gallery',
      capabilities: ['artifacts:read', 'webhooks:manage'],
      agentId: 'agent-1',
    });
    expect(galleryKeyLines(stdout)).toEqual([`GALLERY_API_KEY=${NEW_GALLERY_TOKEN}`]);
  });

  it('changes nothing on a re-run whose gallery key still works', async () => {
    const state = freshState();
    await runScript(seedPath, state);
    const { code, stdout, requests } = await runScript(seedPath, state, { GALLERY_API_KEY: GOOD_GALLERY_KEY });

    expect(code).toBe(0);
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(galleryKeyLines(stdout)).toEqual([]);
  });

  it('replaces a refused gallery key under a new name and revokes the old one', async () => {
    const state = freshState();
    await runScript(seedPath, state);
    const { stdout, requests } = await runScript(seedPath, state, { GALLERY_API_KEY: 'cmk_revoked_key' });

    const created = requests.filter((request) => request.method === 'POST' && request.path === '/api/keys');
    expect(created).toHaveLength(1);
    expect((created[0].body as { name: string }).name).toMatch(/^artifact-gallery-\d+$/);
    expect(requests.some((request) => request.method === 'DELETE' && request.path === '/api/keys/key-1')).toBe(true);
    expect(galleryKeyLines(stdout)).toHaveLength(1);
  });

  it('keeps an existing key it cannot see the secret of, unless told to rotate', async () => {
    const state = freshState();
    await runScript(seedPath, state);

    const kept = await runScript(seedPath, state);
    expect(kept.requests.some((request) => request.method === 'POST' && request.path === '/api/keys')).toBe(false);
    expect(galleryKeyLines(kept.stdout)).toEqual([]);

    const rotated = await runScript(seedPath, state, { ANALYST_GALLERY: 'rotate' });
    expect(galleryKeyLines(rotated.stdout)).toHaveLength(1);
  });
});

describe('overnight-analyst seed: approval before publishing', () => {
  const posted = (requests: Recorded[]) => requests.find(
    (request) => request.method === 'POST' && request.path === '/api/agents',
  )?.body as { tools: string[]; systemPrompt: string; manifest: { spec: { tools: Array<{ ref: string }> } } };

  it('publishes without asking by default', async () => {
    const { code, requests } = await runScript(seedPath, freshState());

    expect(code).toBe(0);
    const agent = posted(requests);
    expect(agent.tools).toEqual(['browse', 'screenshot', 'artifact_upload']);
    expect(agent.systemPrompt).not.toContain('request-approval');
  });

  it('asks for approval before uploading the brief when ANALYST_APPROVE_BEFORE_PUBLISH=1', async () => {
    const { code, stdout, requests } = await runScript(seedPath, freshState(), { ANALYST_APPROVE_BEFORE_PUBLISH: '1' });

    expect(code).toBe(0);
    const agent = posted(requests);
    expect(agent.tools).toEqual(['browse', 'screenshot', 'artifact_upload', 'request-approval']);
    expect(agent.manifest.spec.tools.map((tool) => tool.ref)).toContain('request-approval');
    expect(agent.systemPrompt).toContain('before you upload it (step 3), call request-approval once');
    expect(agent.systemPrompt).toContain('Upload the brief only if the request\nis approved.');
    expect(stdout).toContain('asking for approval before publishing');
  });

  it('turns the step on and off for an existing agent, and leaves it alone when unset', async () => {
    const state = freshState();
    await runScript(seedPath, state);

    const on = await runScript(seedPath, state, { ANALYST_APPROVE_BEFORE_PUBLISH: '1', ANALYST_GALLERY: 'off' });
    const patch = on.requests.filter((request) => request.method === 'PATCH');
    expect(patch.map((request) => request.path)).toEqual(['/api/agents/agent-1']);
    expect((patch[0].body as { tools: string[] }).tools).toContain('request-approval');
    expect((patch[0].body as { manifest: unknown }).manifest).toBeDefined();
    expect(on.stdout).toContain('now asks for approval before publishing');

    const again = await runScript(seedPath, state, { ANALYST_APPROVE_BEFORE_PUBLISH: '1', ANALYST_GALLERY: 'off' });
    expect(again.requests.filter((request) => request.method !== 'GET')).toEqual([]);

    const unset = await runScript(seedPath, state, { ANALYST_GALLERY: 'off' });
    expect(unset.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(state.agents[0].tools).toContain('request-approval');

    const off = await runScript(seedPath, state, { ANALYST_APPROVE_BEFORE_PUBLISH: '0', ANALYST_GALLERY: 'off' });
    const removed = off.requests.find((request) => request.method === 'PATCH')?.body as { tools: string[]; systemPrompt: string };
    expect(removed.tools).toEqual(['browse', 'screenshot', 'artifact_upload']);
    expect(removed.systemPrompt).not.toContain('request-approval');
  });

  it('refuses a switch value it does not understand', async () => {
    const { code, requests } = await runScript(seedPath, freshState(), { ANALYST_APPROVE_BEFORE_PUBLISH: 'maybe' });

    expect(code).not.toBe(0);
    expect(requests).toEqual([]);
  });
});

describe('overnight-analyst run-once', () => {
  function seededState(): MockState {
    const state = freshState();
    state.agents.push({ id: 'agent-1', name: 'overnight-analyst', harnessConfig: { model: 'gpt-5.4-mini' } });
    return state;
  }

  const usage = (coverage: string, totalUsd: number | null, knownUsd: number) => ({
    inputTokens: 1200,
    outputTokens: 300,
    totalTokens: 1500,
    modelCalls: { observed: 4 },
    cost: { totalUsd, knownUsd, coverage },
  });

  it('fires the event, follows the run and prints a priced receipt', async () => {
    const state = seededState();
    state.artifacts.push({ id: 'brief-1', name: 'overnight-brief.html', agentId: 'agent-1', turnId: 'turn-1' });
    state.turnStates = [
      { status: 'RUNNING', completedAt: null, error: null, usage: null, gatewayMode: null },
      { status: 'COMPLETED', completedAt: Date.now(), error: null, usage: usage('pending', null, 0), gatewayMode: 'gateway_only' },
      { status: 'COMPLETED', completedAt: Date.now(), error: null, usage: usage('complete', 0.0123, 0.0123), gatewayMode: 'gateway_only' },
    ];
    const { code, stdout, requests } = await runScript(runOncePath, state);

    expect(code).toBe(0);
    expect(requests.find((request) => request.path === '/api/triggers/emit')?.body).toEqual({
      type: 'custom.overnight.brief',
      payload: { sources: 'https://news.ycombinator.com' },
    });
    expect(stdout).toContain('cost     $0.0123');
    expect(stdout).toContain('RESULT status=COMPLETED turn=turn-1 brief=brief-1 cost_usd=0.0123 coverage=complete gallery=none');
  });

  it('starts nothing when asked to skip and a brief exists', async () => {
    const state = seededState();
    state.artifacts.push({ id: 'brief-0', name: 'overnight-brief.html', agentId: 'agent-1' });
    const { code, stdout, requests } = await runScript(runOncePath, state, { ANALYST_SKIP_IF_BRIEF: '1' });

    expect(code).toBe(0);
    expect(requests.some((request) => request.path === '/api/triggers/emit')).toBe(false);
    expect(stdout).toContain('RESULT status=SKIPPED');
  });

  it('exits non-zero when the run stops at its spend cap', async () => {
    const state = seededState();
    state.turnStates = [{
      status: 'ERROR',
      completedAt: Date.now(),
      error: 'Spend cap reached',
      stopReason: { code: 'budget_reached', capUsd: 0.5, spentUsd: 0.51 },
      usage: usage('complete', 0.51, 0.51),
      gatewayMode: 'gateway_only',
    }];
    const { code, stdout } = await runScript(runOncePath, state);

    expect(code).toBe(1);
    expect(stdout).toContain('status   ERROR (budget_reached)');
    expect(stdout).toContain('RESULT status=ERROR');
  });
});
