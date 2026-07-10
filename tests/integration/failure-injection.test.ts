import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

describe('Failure injection — rollback and cleanup', () => {
  let app: TestAppHandle['app'];
  let container: TestAppHandle['container'];
  let testApp: TestAppHandle | undefined;
  let dataDir: string;
  let agentAId: string;
  let agentBId: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'ctxmill-failure-inj-',
      preset: 'docker',
      containerRetriesOnAlreadyExists: 3,
    });
    app = testApp.app;
    container = testApp.container;
    dataDir = testApp.dataDir;

    // Create agent A
    const resA = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'failure-agent-A',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'Agent A.',
        tools: [],
      },
    });
    expect(resA.statusCode).toBe(201);
    agentAId = resA.json().id;

    // Create agent B
    const resB = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'failure-agent-B',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'Agent B.',
        tools: [],
      },
    });
    expect(resB.statusCode).toBe(201);
    agentBId = resB.json().id;
  });

  afterAll(async () => {
    await testApp?.close();
  });

  // ── 1. Wrong-agent sessionId returns 404 for file operations ──

  it('returns 404 when sessionId belongs to a different agent', async () => {
    // Create a conversation and run for agent A
    const conv = await container.db.createConversation(agentAId);
    const run = await container.db.createTurn({
      agentId: agentAId,
      conversationId: conv.id,
      mode: 'background',
      taskDescription: 'test',
    });

    // Try listing files on agent B using agent A's sessionId
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentBId}/files?sessionId=${run.id}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Session not found');
  });

  it('returns 404 when sessionId belongs to a different agent (read endpoint)', async () => {
    const conv = await container.db.createConversation(agentAId);
    const run = await container.db.createTurn({
      agentId: agentAId,
      conversationId: conv.id,
      mode: 'background',
      taskDescription: 'test',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentBId}/files/read?path=foo.txt&sessionId=${run.id}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Session not found');
  });

  // ── 2. Non-existent sessionId returns 404 for file operations ──

  it('returns 404 for completely non-existent sessionId on file list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentAId}/files?sessionId=nonexistent-run-id`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Session not found');
  });

  it('returns 404 for completely non-existent sessionId on file read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentAId}/files/read?path=foo.txt&sessionId=nonexistent-run-id`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Session not found');
  });

  // ── 3. Agent with no workspaceDir returns 500 for file operations ──

  it('returns 500 when agent has no workspace configured (list)', async () => {
    // Create agent directly via DB without calling ensureAgentWorkspace
    const noWsAgent = await container.db.createAgent({
      name: 'no-workspace-agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }),
      systemPrompt: 'No workspace.',
      tools: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${noWsAgent.id}/files`,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('Agent has no workspace configured');
  });

  it('returns 500 when agent has no workspace configured (read)', async () => {
    const noWsAgent = await container.db.createAgent({
      name: 'no-workspace-agent-read',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }),
      systemPrompt: 'No workspace.',
      tools: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${noWsAgent.id}/files/read?path=foo.txt`,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('Agent has no workspace configured');
  });

  it('returns 404 for stale session dir with no matching run in registry', async () => {
    const staleRunId = 'stale-fake-run-id-12345';

    // Create fake session directory on disk
    const sessionMergedDir = join(dataDir, 'agents', agentAId, 'sessions', staleRunId, 'merged');
    mkdirSync(sessionMergedDir, { recursive: true });
    writeFileSync(join(sessionMergedDir, 'stale-file.txt'), 'should not be accessible');

    // Request with the stale sessionId — should be rejected at the registry check
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentAId}/files?sessionId=${staleRunId}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Session not found');
  });

  it('returns 404 for stale session dir on file read', async () => {
    const staleRunId = 'stale-fake-run-id-67890';

    const sessionMergedDir = join(dataDir, 'agents', agentAId, 'sessions', staleRunId, 'merged');
    mkdirSync(sessionMergedDir, { recursive: true });
    writeFileSync(join(sessionMergedDir, 'stale-secret.txt'), 'should not be readable');

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentAId}/files/read?path=stale-secret.txt&sessionId=${staleRunId}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Session not found');
  });

  it('returns 404 when cancelling a non-existent session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentAId}/sessions/nonexistent-run/cancel`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Session not found');
  });

  it('delete cascade removes agent, conversations, and completed runs', async () => {
    // Create a fresh agent with conversation and run
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'cascade-delete-agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'Will be deleted.',
        tools: [],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const cascadeAgentId = createRes.json().id;

    // Create conversation and run, then complete the run so FK order doesn't block
    const conv = await container.db.createConversation(cascadeAgentId);
    await container.db.createTurn({
      agentId: cascadeAgentId,
      conversationId: conv.id,
      mode: 'background',
      taskDescription: 'cascade test',
      completedAt: Date.now(),
      error: null,
    });

    // Verify agent and conv exist
    const agentBefore = await container.db.getAgent(cascadeAgentId);
    expect(agentBefore).toBeDefined();

    // Delete the agent via API
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${cascadeAgentId}`,
    });
    expect(delRes.statusCode).toBe(204);

    // Agent should be gone from API
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/agents/${cascadeAgentId}`,
    });
    expect(getRes.statusCode).toBe(404);

    // Agent should not be in DB
    const agentAfter = await container.db.getAgent(cascadeAgentId);
    expect(agentAfter).toBeUndefined();

    // Conversations should be gone
    const convs = await container.db.getConversationsForAgent(cascadeAgentId);
    expect(convs.length).toBe(0);
  });

  it('delete cascade succeeds even when agent has active runs', async () => {
    // Verifies that deleteAgentCascade correctly deletes agentRuns before
    // conversations (respecting the FK from agentRuns.conversationId to conversations.id)
     const createRes = await app.inject({
       method: 'POST',
       url: '/api/agents',
       payload: {
         name: 'cascade-active-run-agent',
         harness: 'langgraph',
         harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
         systemPrompt: 'Active run should not block delete.',
         tools: [],
       },
     });
    expect(createRes.statusCode).toBe(201);
    const activeRunAgentId = createRes.json().id;

    // Create conversation and run — leave run active
    const conv = await container.db.createConversation(activeRunAgentId);
    await container.db.createTurn({
      agentId: activeRunAgentId,
      conversationId: conv.id,
      mode: 'background',
      taskDescription: 'active run',
    });

    // Delete should succeed — FK ordering is correct
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${activeRunAgentId}`,
    });
    expect(delRes.statusCode).toBe(204);

    // Agent should be gone
    const agentAfter = await container.db.getAgent(activeRunAgentId);
    expect(agentAfter).toBeUndefined();
  });
});
