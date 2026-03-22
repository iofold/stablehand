/**
 * Ownership Guards — Unit Tests
 *
 * Verifies that cancel, interrupt, and messages routes enforce
 * ownership: accessing resources belonging to a different agent
 * returns 404 (not 403) to avoid leaking resource existence.
 *
 * Kodak Audit Finding #3 (IDOR).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

const AGENT_PAYLOAD = {
  name: 'ownership-test',
  harness: 'claude-agents',
  harnessConfig: { model: 'claude-sonnet-4-6' },
  systemPrompt: 'You are a test agent.',
  tools: [],
};

describe('Ownership enforcement on routes', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-ownership-'));

    container = await createContainer(
      {
        preset: 'local',
        database: { url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill' },
        llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'test-key-not-used' },
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
  });

  afterAll(async () => {
    await app.close();
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

  // ── POST /agents/:id/runs/:runId/cancel ─────────────────────

  describe('POST /agents/:id/runs/:runId/cancel', () => {
    it('returns 404 when runId belongs to a different agent', async () => {
      const agentAId = await createAgent('cancel-owner-A');
      const agentBId = await createAgent('cancel-owner-B');

      // Start a run on Agent A via the run registry directly
      const run = await container.runRegistry.startRun(agentAId, 'conv-1', 'interactive', 'test');

      // Try to cancel Agent A's run via Agent B's endpoint
      const cancel = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentBId}/runs/${run.id}/cancel`,
      });
      expect(cancel.statusCode).toBe(404);
      expect(cancel.json().error).toBe('Run not found');
    });

    it('succeeds when runId belongs to the correct agent', async () => {
      const agentId = await createAgent('cancel-owner-ok');

      const run = await container.runRegistry.startRun(agentId, 'conv-2', 'interactive', 'test');

      const cancel = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/runs/${run.id}/cancel`,
      });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json().cancelled).toBe(true);
    });

    it('returns 404 for a non-existent runId', async () => {
      const agentId = await createAgent('cancel-nonexistent');

      const cancel = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/runs/non-existent-run-id/cancel`,
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
      const run = await container.runRegistry.startRun(agentAId, 'conv-3', 'interactive', 'test');

      // Try to resolve an interrupt with Agent A's runId via Agent B's endpoint
      const result = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentBId}/interrupt`,
        payload: { action: 'approve', runId: run.id },
      });
      expect(result.statusCode).toBe(404);
      expect(result.json().error).toBe('Run not found');
    });

    it('returns 404 when runId does not exist at all', async () => {
      const agentId = await createAgent('interrupt-nonexistent');

      const result = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/interrupt`,
        payload: { action: 'approve', runId: 'totally-fake-run-id' },
      });
      expect(result.statusCode).toBe(404);
      expect(result.json().error).toBe('Run not found');
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
