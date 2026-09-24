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
      dirPrefix: 'stablehand-failure-inj-',
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

  // ── 1. Wrong-agent conversationId returns 404 for file operations ──

  it('returns 404 when conversationId belongs to a different agent', async () => {
    const conv = await container.db.createConversation(agentAId);

    // Try listing files on agent B using agent A's conversationId
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentBId}/files?conversationId=${conv.id}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Conversation not found');
  });

  it('returns 404 when conversationId belongs to a different agent (read endpoint)', async () => {
    const conv = await container.db.createConversation(agentAId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentBId}/files/read?path=foo.txt&conversationId=${conv.id}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Conversation not found');
  });

  // ── 2. Non-existent conversationId returns 404 for file operations ──

  it('returns 404 for completely non-existent conversationId on file list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentAId}/files?conversationId=nonexistent-conversation-id`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Conversation not found');
  });

  it('returns 404 for completely non-existent conversationId on file read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentAId}/files/read?path=foo.txt&conversationId=nonexistent-conversation-id`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Conversation not found');
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

  it('returns 404 for stale conversation dir with no matching conversation', async () => {
    const staleConversationId = 'stale-fake-conversation-id-12345';

    const staleWorkspaceDir = join(dataDir, 'agents', agentAId, 'conversations', staleConversationId);
    mkdirSync(staleWorkspaceDir, { recursive: true });
    writeFileSync(join(staleWorkspaceDir, 'stale-file.txt'), 'should not be accessible');

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentAId}/files?conversationId=${staleConversationId}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Conversation not found');
  });

  it('returns 404 for stale conversation dir on file read', async () => {
    const staleConversationId = 'stale-fake-conversation-id-67890';

    const staleWorkspaceDir = join(dataDir, 'agents', agentAId, 'conversations', staleConversationId);
    mkdirSync(staleWorkspaceDir, { recursive: true });
    writeFileSync(join(staleWorkspaceDir, 'stale-secret.txt'), 'should not be readable');

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentAId}/files/read?path=stale-secret.txt&conversationId=${staleConversationId}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Conversation not found');
  });

  it('returns 404 when cancelling a non-existent turn', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentAId}/turns/nonexistent-turn/cancel`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Turn not found');
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
    const cascadeTurn = await container.db.createTurn({
      agentId: cascadeAgentId,
      conversationId: conv.id,
      mode: 'background',
      taskDescription: 'cascade test',
    });
    await container.db.finalizeTurnIfOpen(cascadeTurn.id, {
      status: 'completed',
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
