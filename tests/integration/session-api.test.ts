import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

describe('Session API lifecycle', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;
  let agentId: string;
  let runId: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-session-test-'));

    container = await createContainer(
      {
        preset: 'local',
        database: {
          url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill',
        },
        llm: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          apiKey: 'test-key-not-used',
        },
      },
      dataDir,
    );

    const envFactory = new MockOverlayFactory();

    app = await createServer({
      db: container.db,
      agentRunService: container.agentRunService,
      runRegistry: container.runRegistry,
      eventBus: container.eventBus,
      dataDir,
      envFactory,
    });

    await app.ready();

    // Create a test agent
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'session-test-agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
        systemPrompt: 'You are a test agent.',
        tools: [],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const agentBody = createRes.json();
    agentId = agentBody.id;

    // Verify agent has workspace dir with base/ layout
    const agent = await container.db.getAgent(agentId);
    expect(agent).toBeDefined();
    expect(agent!.workspaceDir).toBeDefined();
    expect(agent!.workspaceDir).toContain('base');

    // Create a run manually (since we can't actually run LLM in tests)
    const conv = await container.db.createConversation(agentId);
    const run = await container.runRegistry.startRun(agentId, conv.id, 'background', 'test task');
    runId = run.id;

    // Set up a mock session environment by writing to the sessions dir
    const workspaceDir = agent!.workspaceDir!;
    const sessionsDir = resolve(join(workspaceDir, '..', '..', 'sessions'));
    mkdirSync(sessionsDir, { recursive: true });

    // Write a base file for diff testing
    writeFileSync(join(workspaceDir, 'base-file.txt'), 'base content');

    // Create environment, setup, write session file, then leave it active
    const env = envFactory.create(workspaceDir, runId, sessionsDir);
    await env.setup();
    // Write a new file in the session
    writeFileSync(join(env.workspacePath, 'session-file.txt'), 'session content');
    // Modify an existing base file
    writeFileSync(join(env.workspacePath, 'base-file.txt'), 'modified content');

    // Record sessionDir on the run
    const sessionDir = join(sessionsDir, runId);
    await container.runRegistry.updateSessionDir(runId, sessionDir);
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET /api/agents/:id/runs/:runId/diff returns session changes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/runs/${runId}/diff`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.changes).toBeDefined();
    expect(Array.isArray(body.changes)).toBe(true);

    // Should see added and modified files
    const added = body.changes.find((c: any) => c.path === 'session-file.txt');
    const modified = body.changes.find((c: any) => c.path === 'base-file.txt');
    expect(added).toBeDefined();
    expect(added.type).toBe('added');
    expect(modified).toBeDefined();
    expect(modified.type).toBe('modified');
  });

  it('GET /api/agents/:id/runs/:runId/diff returns empty for run without session', async () => {
    // Create a run without a session
    const conv2 = await container.db.createConversation(agentId);
    const noSessionRun = await container.runRegistry.startRun(agentId, conv2.id, 'background', 'no session');

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/runs/${noSessionRun.id}/diff`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.changes).toEqual([]);

    // Complete the run so it doesn't count against the concurrent run limit
    await container.runRegistry.completeRun(noSessionRun.id);
  });

  it('POST /api/agents/:id/runs/:runId/promote merges session changes to base', async () => {
    const agent = await container.db.getAgent(agentId);
    const workspaceDir = agent!.workspaceDir!;

    // Before promote, base should not have the session file
    expect(existsSync(join(workspaceDir, 'session-file.txt'))).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/runs/${runId}/promote`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.added).toBeGreaterThanOrEqual(1);

    // After promote, base should have the session file
    expect(existsSync(join(workspaceDir, 'session-file.txt'))).toBe(true);
    expect(readFileSync(join(workspaceDir, 'session-file.txt'), 'utf-8')).toBe('session content');
    // Base file should be modified
    expect(readFileSync(join(workspaceDir, 'base-file.txt'), 'utf-8')).toBe('modified content');
  });

  it('POST /api/agents/:id/runs/:runId/fork creates a new agent with session state', async () => {
    // Create a fresh run with a session for fork testing
    const agent = await container.db.getAgent(agentId);
    const workspaceDir = agent!.workspaceDir!;
    const sessionsDir = resolve(join(workspaceDir, '..', '..', 'sessions'));
    const envFactory = new MockOverlayFactory();

    const convFork = await container.db.createConversation(agentId);
    const forkRun = await container.runRegistry.startRun(agentId, convFork.id, 'background', 'fork test');
    const forkEnv = envFactory.create(workspaceDir, forkRun.id, sessionsDir);
    await forkEnv.setup();
    writeFileSync(join(forkEnv.workspacePath, 'fork-file.txt'), 'forked content');
    await container.runRegistry.updateSessionDir(forkRun.id, join(sessionsDir, forkRun.id));

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/runs/${forkRun.id}/fork`,
      payload: { name: 'forked-agent' },
    });

    // Complete the fork run so it doesn't count against the concurrent run limit
    await container.runRegistry.completeRun(forkRun.id);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.agentId).toBeDefined();
    expect(body.name).toBe('forked-agent');

    // Verify the new agent exists
    const newAgent = await container.db.getAgent(body.agentId);
    expect(newAgent).toBeDefined();
    expect(newAgent!.name).toBe('forked-agent');
  });

  it('POST /api/agents/:id/runs/:runId/fork requires name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/runs/${runId}/fork`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/agents/:id/runs/:runId/session discards the session', async () => {
    // Create a run with a session for discard testing
    const agent = await container.db.getAgent(agentId);
    const workspaceDir = agent!.workspaceDir!;
    const sessionsDir = resolve(join(workspaceDir, '..', '..', 'sessions'));
    const envFactory = new MockOverlayFactory();

    const convDiscard = await container.db.createConversation(agentId);
    const discardRun = await container.runRegistry.startRun(agentId, convDiscard.id, 'background', 'discard test');
    const discardEnv = envFactory.create(workspaceDir, discardRun.id, sessionsDir);
    await discardEnv.setup();
    writeFileSync(join(discardEnv.workspacePath, 'temp-file.txt'), 'temp content');
    await container.runRegistry.updateSessionDir(discardRun.id, join(sessionsDir, discardRun.id));

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/runs/${discardRun.id}/session`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.discarded).toBe(true);
  });

  it('returns 404 for non-existent agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/nonexistent/runs/${runId}/diff`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for non-existent run', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/runs/nonexistent/diff`,
    });
    expect(res.statusCode).toBe(404);
  });
});
