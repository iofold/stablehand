/**
 * Ownership Guards — Unit Tests
 *
 * Verifies that cancel, interrupt, and messages routes enforce
 * ownership: accessing resources belonging to a different agent
 * returns 404 (not 403) to avoid leaking resource existence.
 *
 * Kodak Audit Finding #3 (IDOR).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { resolveTestDatabaseUrl } from '../utils/test-db.js';

const AGENT_PAYLOAD = {
  name: 'ownership-test',
  harness: 'claude-agents',
  harnessConfig: { model: 'claude-sonnet-4-6' },
  systemPrompt: 'You are a test agent.',
  tools: [],
};

describe('Ownership enforcement on routes', () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let container: AppContainer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-ownership-'));

    container = await createContainer(
      {
        database: { url: resolveTestDatabaseUrl() },
      },
      dataDir,
    );

    app = await createServer({
      db: container.db,
      agentSessionService: container.agentSessionService,
      eventBus: container.eventBus,
      harnessSchemas: container.harnessSchemas,
      sse: container.sseManager,
      interrupts: container.interruptManager,
      toolDefinitionRegistry: container.toolRegistry,
      runStartupService: container.runStartupService,
      dataDir,
    });

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function createAgent(name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { ...AGENT_PAYLOAD, name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  describe('POST /agents/:id/message', () => {
    it('returns 404 when conversationId belongs to a different agent', async () => {
      const agentAId = await createAgent('message-owner-A');
      const agentBId = await createAgent('message-owner-B');

      const conversation = await container.db.createConversation(agentAId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentBId}/message`,
        payload: { content: 'hello', conversationId: conversation.id },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatch(/Conversation .* not found for agent/);
    });
  });

  // ── POST /agents/:id/sessions/:runId/cancel ──────────────────

  describe('POST /agents/:id/sessions/:runId/cancel', () => {
    it('returns 404 when runId belongs to a different agent', async () => {
      const agentAId = await createAgent('cancel-owner-A');
      const agentBId = await createAgent('cancel-owner-B');

      const conv = await container.db.createConversation(agentAId);
      const session = await container.db.createSandboxSession({
        agentId: agentAId,
        conversationId: conv.id,
        containerName: 'test-container',
        containerId: 'test-id',
        harnessName: 'claude-agents',
      });
      const turn = await container.db.createTurn({
        agentId: agentAId,
        conversationId: conv.id,
        sessionId: session.id,
        mode: 'interactive',
        taskDescription: 'test',
      });

      const cancel = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentBId}/sessions/${turn.id}/cancel`,
      });
      expect(cancel.statusCode).toBe(404);
      expect(cancel.json().error).toBe('Session not found');
    });

    it('returns 404 for a non-existent runId', async () => {
      const agentId = await createAgent('cancel-nonexistent');

      const cancel = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/sessions/non-existent-run-id/cancel`,
      });
      expect(cancel.statusCode).toBe(404);
    });
  });

  // ── POST /agents/:id/interrupt ──────────────────────────────

  describe('POST /agents/:id/interrupt', () => {
    it('returns 404 when runId in body belongs to a different agent', async () => {
      const agentAId = await createAgent('interrupt-owner-A');
      const agentBId = await createAgent('interrupt-owner-B');

      // Start a run on Agent A
      const conv = await container.db.createConversation(agentAId);
      const session = await container.db.createSandboxSession({
        agentId: agentAId,
        conversationId: conv.id,
        containerName: 'test-container',
        containerId: 'test-id',
        harnessName: 'claude-agents',
      });
      const turn = await container.db.createTurn({
        agentId: agentAId,
        conversationId: conv.id,
        sessionId: session.id,
        mode: 'interactive',
        taskDescription: 'test',
      });

      const result = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentBId}/interrupt`,
        payload: { action: 'approve', sessionId: turn.id },
      });
      expect(result.statusCode).toBe(404);
      expect(result.json().error).toBe('No pending interrupt for agent');
    });

    it('returns 404 when runId does not exist at all', async () => {
      const agentId = await createAgent('interrupt-nonexistent');

      const result = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/interrupt`,
        payload: { action: 'approve', sessionId: 'totally-fake-run-id' },
      });
      expect(result.statusCode).toBe(404);
      expect(result.json().error).toBe('No pending interrupt for agent');
    });
  });

  // ── GET /agents/:id/conversations/:convId/messages ──────────

  describe('GET /agents/:id/conversations/:convId/messages', () => {
    it('returns 404 when conversation belongs to a different agent', async () => {
      const agentAId = await createAgent('msg-owner-A');
      const agentBId = await createAgent('msg-owner-B');

      // Create a conversation for Agent A via the DB directly
      const conversation = await container.db.createConversation(agentAId);

      // Try to access Agent A's conversation via Agent B's endpoint
      const messages = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentBId}/conversations/${conversation.id}/messages`,
      });
      expect(messages.statusCode).toBe(404);
      expect(messages.json().error).toBe('Conversation not found');
    });

    it('succeeds when conversation belongs to the correct agent', async () => {
      const agentId = await createAgent('msg-owner-ok');

      const conversation = await container.db.createConversation(agentId);

      const messages = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/conversations/${conversation.id}/messages`,
      });
      expect(messages.statusCode).toBe(200);
      expect(Array.isArray(messages.json())).toBe(true);
    });

    it('returns raw persisted message payloads in chronological order', async () => {
      const agentId = await createAgent('msg-format-ok');
      const conversation = await container.db.createConversation(agentId);

      await container.db.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'search', arguments: { query: 'ctxmill' } }],
        createdAt: 2,
      });
      await container.db.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'user',
        content: 'first',
        createdAt: 1,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/conversations/${conversation.id}/messages`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          role: 'user',
          content: 'first',
          toolCalls: null,
          createdAt: 1,
        }),
        expect.objectContaining({
          role: 'assistant',
          content: '',
          createdAt: 2,
          toolCalls: [
            expect.objectContaining({
              id: 'tc-1',
              name: 'search',
              arguments: { query: 'ctxmill' },
            }),
          ],
        }),
      ]);
    });

    it('returns 404 for a non-existent conversation', async () => {
      const agentId = await createAgent('msg-nonexistent');

      const messages = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/conversations/fake-conv-id/messages`,
      });
      expect(messages.statusCode).toBe(404);
    });
  });
});
