import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../utils/test-db.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';

describe('DatabaseRepository', () => {
  let testDb: TestDb;
  let repo: DatabaseRepository;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = testDb.repo;
  });

  afterAll(async () => {
    await testDb?.close();
  });

  // --- Migrations ---

  describe('Migrations', () => {
    it('should create all expected tables', async () => {
      const tables = await testDb.conn.pgClient`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `;
      const tableNames = tables.map((t: any) => t.tablename).sort();
      expect(tableNames).toEqual([
        'agent_checkpoints',
        'agent_versions',
        'agents',
        'artifacts',
        'callback_outbox',
        'conversations',
        'ctxmill_schema_version',
        'event_store',
        'event_triggers',
        'execution_traces',
        'feedback_signals',
        'interrupt_resume_attempts',
        'knowledge_items',
        'messages',
        'pending_interrupts',
        'sandbox_sessions',
        'scheduled_events',
        'secrets',
        'suspended_sessions',
        'system_settings',
        'tool_request_dedup',
        'turns',
        'webhooks',
      ]);
    });

    it('CFG-08: should run migrations idempotently (twice without errors)', async () => {
      const { runMigrations } = await import('../../packages/ctxmill/src/database/migrations.js');
      // Migrations already ran in beforeAll; run again
      await expect(runMigrations(testDb.conn.pgClient)).resolves.not.toThrow();

      // Tables still exist
      const tables = await testDb.conn.pgClient`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `;
      expect(tables.length).toBeGreaterThanOrEqual(12);
    });

    it('creates agents table with harness_config and without legacy model columns', async () => {
      const columns = await testDb.conn.pgClient`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agents'
        ORDER BY column_name
      `;
      const columnNames = columns.map((column) => String(column.column_name));

      expect(columnNames).toContain('harness');
      expect(columnNames).toContain('harness_config');
      expect(columnNames).not.toContain('model');
      expect(columnNames).not.toContain('model_config');
    });

    it('initializes the current schema baseline marker', async () => {
      const [baseline] = await testDb.conn.pgClient`
        SELECT version, baseline FROM ctxmill_schema_version WHERE id = 'baseline'
      `;

      expect(Number(baseline.version)).toBe(1);
      expect(baseline.baseline).toBe('pre-release');
    });
  });

  // --- Agents CRUD (CFG-05) ---

  describe('CFG-05: Agent CRUD', () => {
    const agentData = {
      name: 'Test Agent',
      harness: 'claude-agents',
      harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      systemPrompt: 'You are a test agent.',
      tools: ['bash', 'read_file'],
    };

    it('should create an agent and assign an id', async () => {
      const agent = await repo.createAgent(agentData);
      expect(agent.id).toBeDefined();
      expect(typeof agent.id).toBe('string');
      expect(agent.name).toBe('Test Agent');
      expect(agent.harness).toBe('claude-agents');
      expect(JSON.parse(agent.harnessConfig)).toEqual({ model: 'claude-sonnet-4-6' });
      expect(agent.systemPrompt).toBe('You are a test agent.');
      expect(agent.tools).toEqual(['bash', 'read_file']);
      expect(agent.status).toBe('created');
      expect(agent.createdAt).toBeTypeOf('number');
      expect(agent.updatedAt).toBeTypeOf('number');
    });

    it('should read an agent by id', async () => {
      const created = await repo.createAgent(agentData);
      const fetched = await repo.getAgent(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe('Test Agent');
    });

    it('should return undefined for non-existent agent', async () => {
      const fetched = await repo.getAgent('non-existent-id');
      expect(fetched).toBeUndefined();
    });

    it('should list all agents', async () => {
      const agents = await repo.listAgents();
      expect(agents.length).toBeGreaterThanOrEqual(2);
    });

    it('should update an agent', async () => {
      const created = await repo.createAgent(agentData);
      const updated = await repo.updateAgent(created.id, { name: 'Updated Name' });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated Name');
      expect(updated!.harness).toBe('claude-agents');
      expect(JSON.parse(updated!.harnessConfig)).toEqual({ model: 'claude-sonnet-4-6' });
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it('should update harnessConfig', async () => {
      const created = await repo.createAgent(agentData);
      const updated = await repo.updateAgent(created.id, {
        harnessConfig: JSON.stringify({ model: 'claude-opus-4-6', maxTurns: 4 }),
      });

      expect(updated).toBeDefined();
      expect(JSON.parse(updated!.harnessConfig)).toEqual({ model: 'claude-opus-4-6', maxTurns: 4 });
    });

    it('should update agent status', async () => {
      const created = await repo.createAgent(agentData);
      expect(created.status).toBe('created');
      const updated = await repo.updateAgentStatus(created.id, 'running');
      expect(updated!.status).toBe('running');
    });

    it('should delete an agent', async () => {
      const created = await repo.createAgent({ ...agentData, name: 'To Delete' });
      await repo.deleteAgent(created.id);
      const fetched = await repo.getAgent(created.id);
      expect(fetched).toBeUndefined();
    });

    it('deleteAgentCascade cleans owned runtime state while preserving artifact metadata as global', async () => {
      const agent = await repo.createAgent({ ...agentData, name: 'Cascade Delete Owner' });
      const conversation = await repo.createConversation(agent.id);
      const sandboxSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId: agent.id,
        harnessName: 'claude-agents',
      });
      const turn = await repo.createTurn({
        id: 'delete-cascade-turn',
        sessionId: sandboxSession.id,
        agentId: agent.id,
        conversationId: conversation.id,
        mode: 'interactive',
      });

      await repo.createSuspendedSession({
        id: 'delete-cascade-suspended',
        agentSessionId: turn.id,
        agentId: agent.id,
        waitEventType: 'custom',
        waitSelector: '{}',
        snapshotState: '{}',
        createdAt: Date.now(),
      });
      await repo.createScheduledEvent({
        id: 'delete-cascade-scheduled',
        agentId: agent.id,
        type: 'turn.started',
        payload: '{}',
        wakeAt: Date.now(),
      });
      await repo.enqueueCallback({
        id: 'delete-cascade-callback',
        agentId: agent.id,
        sessionId: turn.id,
        callbackUrl: 'https://example.test/callback',
        eventType: 'turn.completed',
        payload: {},
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
      });
      await repo.savePendingInterrupt({
        id: 'delete-cascade-interrupt',
        agentSessionId: turn.id,
        agentId: agent.id,
        sessionId: sandboxSession.id,
        toolCallId: 'tool-call-1',
        toolName: 'bash',
        args: {},
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      const artifact = await repo.saveArtifact({
        id: 'delete-cascade-artifact',
        agentId: agent.id,
        sessionId: turn.id,
        conversationId: conversation.id,
        name: 'survives.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
        storageKey: 'agent/artifact/survives.txt',
        bucket: 'test-bucket',
        status: 'active',
      });
      await testDb.conn.pgClient`
        INSERT INTO secrets (id, agent_id, tool_id, key, iv, ciphertext, auth_tag)
        VALUES ('delete-cascade-secret', ${agent.id}, '', 'TOKEN', 'iv', 'ciphertext', 'tag')
      `;
      await testDb.conn.pgClient`
        INSERT INTO tool_request_dedup (request_id, session_id, tool_name, status, created_at)
        VALUES ('delete-cascade-dedup', ${sandboxSession.id}, 'bash', 'in_progress', ${Date.now()})
      `;

      await repo.deleteAgentCascade(agent.id);

      expect(await repo.getAgent(agent.id)).toBeUndefined();
      expect(await repo.getArtifact(artifact.id)).toMatchObject({
        id: artifact.id,
        agentId: null,
        sessionId: null,
        conversationId: null,
        status: 'active',
      });
      expect(await repo.getPendingInterrupt('delete-cascade-interrupt')).toBeUndefined();
      expect(await repo.getScheduledEventsDue(Date.now() + 1_000)).toEqual([]);

      const [suspendedCount] = await testDb.conn.pgClient`
        SELECT count(*)::int AS count FROM suspended_sessions WHERE agent_id = ${agent.id}
      `;
      const [callbackCount] = await testDb.conn.pgClient`
        SELECT count(*)::int AS count FROM callback_outbox WHERE agent_id = ${agent.id}
      `;
      const [secretCount] = await testDb.conn.pgClient`
        SELECT count(*)::int AS count FROM secrets WHERE agent_id = ${agent.id}
      `;
      const [dedupCount] = await testDb.conn.pgClient`
        SELECT count(*)::int AS count FROM tool_request_dedup WHERE request_id = 'delete-cascade-dedup'
      `;
      expect(suspendedCount.count).toBe(0);
      expect(callbackCount.count).toBe(0);
      expect(secretCount.count).toBe(0);
      expect(dedupCount.count).toBe(0);
    });
  });

  // --- Conversations & Messages (CFG-05) ---

  describe('CFG-05: Conversations and Messages', () => {
    let agentId: string;

    beforeAll(async () => {
      const agent = await repo.createAgent({
        name: 'Conv Agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'Test prompt',
        tools: [],
      });
      agentId = agent.id;
    });

    it('should create a conversation for an agent', async () => {
      const conv = await repo.createConversation(agentId);
      expect(conv.id).toBeDefined();
      expect(conv.agentId).toBe(agentId);
      expect(conv.createdAt).toBeTypeOf('number');
    });

    it('should get a conversation by id', async () => {
      const created = await repo.createConversation(agentId);
      const fetched = await repo.getConversation(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
    });

    it('should list conversations for an agent', async () => {
      const convos = await repo.getConversationsForAgent(agentId);
      expect(convos.length).toBeGreaterThanOrEqual(2);
    });

    it('should add messages to a conversation', async () => {
      const conv = await repo.createConversation(agentId);
      const msg = await repo.addMessage({
        conversationId: conv.id,
        agentId,
        role: 'user',
        content: 'Hello, agent!',
      });
      expect(msg.id).toBeDefined();
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello, agent!');
      expect(msg.conversationId).toBe(conv.id);
    });

    it('should retrieve messages for a conversation', async () => {
      const conv = await repo.createConversation(agentId);
      await repo.addMessage({ conversationId: conv.id, agentId, role: 'user', content: 'Message 1' });
      await repo.addMessage({ conversationId: conv.id, agentId, role: 'assistant', content: 'Reply 1' });
      await repo.addMessage({ conversationId: conv.id, agentId, role: 'user', content: 'Message 2' });

      const messages = await repo.getMessages(conv.id);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('Message 1');
      expect(messages[1].role).toBe('assistant');
    });

    it('should update conversation updatedAt when a message is added', async () => {
      const conv = await repo.createConversation(agentId);
      const originalUpdatedAt = conv.updatedAt;

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));

      await repo.addMessage({ conversationId: conv.id, agentId, role: 'user', content: 'Update trigger' });

      const updated = await repo.getConversation(conv.id);
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
    });

    it('should return empty array for conversation with no messages', async () => {
      const conv = await repo.createConversation(agentId);
      const messages = await repo.getMessages(conv.id);
      expect(messages).toEqual([]);
    });
  });

  // --- Knowledge Items ---

  describe('Knowledge Items', () => {
    it('should add and retrieve knowledge items', async () => {
      const item = await repo.addKnowledgeItem({
        agentId: 'agent-1',
        content: 'Always check input types',
        category: 'strategy',
        source: 'reflector',
      });
      expect(item.id).toBeDefined();
      expect(item.content).toBe('Always check input types');

      const items = await repo.getKnowledgeItems('agent-1');
      expect(items).toHaveLength(1);
    });

    it('should filter knowledge items by category', async () => {
      await repo.addKnowledgeItem({ agentId: 'a1', content: 'Strat 1', category: 'strategy', source: 'reflector' });
      await repo.addKnowledgeItem({ agentId: 'a1', content: 'Fact 1', category: 'fact', source: 'human' });

      const strategies = await repo.getKnowledgeItems('a1', 'strategy');
      expect(strategies).toHaveLength(1);
      expect(strategies[0].category).toBe('strategy');
    });
  });

  // --- Execution Traces ---

  describe('Execution Traces', () => {
    it('should save and retrieve execution traces', async () => {
      const trace = await repo.saveTrace({
        agentId: 'agent-1',
        sessionId: 'run-1',
        taskDescription: 'Test task',
        steps: [{ ordinal: 0, type: 'llm_call', content: 'hello', durationMs: 100 }],
        outcome: 'success',
      });
      expect(trace.id).toBeDefined();
      expect(trace.taskDescription).toBe('Test task');

      const traces = await repo.getTraces('agent-1');
      expect(traces).toHaveLength(1);
      expect(traces[0].sessionId).toBe('run-1');
    });
  });

  // --- Feedback Signals ---

  describe('Feedback Signals', () => {
    it('should save and retrieve feedback signals', async () => {
      const trace = await repo.saveTrace({
        agentId: 'agent-1',
        sessionId: 'run-1',
        taskDescription: 'Test',
        steps: [],
        outcome: 'success',
      });

      const feedback = await repo.saveFeedback({
        traceId: trace.id,
        agentId: 'agent-1',
        source: 'human',
        type: 'thumbs',
        value: { thumbs: 'up' },
      });
      expect(feedback.id).toBeDefined();
      expect(feedback.source).toBe('human');

      const feedbacks = await repo.getFeedbackForTrace(trace.id);
      expect(feedbacks).toHaveLength(1);
      expect(feedbacks[0].type).toBe('thumbs');
    });
  });

  describe('Sandbox Sessions', () => {
    let agentId: string;
    let conversationId: string;

    beforeAll(async () => {
      const agent = await repo.createAgent({
        name: 'Sandbox Session Agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'Session test prompt',
        tools: [],
      });
      agentId = agent.id;

      const conversation = await repo.createConversation(agentId);
      conversationId = conversation.id;
    });

    it('should create a sandbox session', async () => {
      const session = await repo.createSandboxSession({
        conversationId,
        agentId,
        containerName: 'ctxmill-session-1',
        containerId: 'container-1',
        harnessName: 'langgraph',
      });

      expect(session.id).toBeDefined();
      expect(session.conversationId).toBe(conversationId);
      expect(session.agentId).toBe(agentId);
      expect(session.status).toBe('ACTIVE');
      expect(session.containerName).toBe('ctxmill-session-1');
    });

    it('should fetch a sandbox session by id', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'claude-agents',
      });

      const fetched = await repo.getSandboxSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it('should fetch the latest sandbox session by conversation', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'claude',
      });

      const fetched = await repo.getSandboxSessionByConversation(conversationId);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it('should update sandbox session status and metadata', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'pi-agent',
      });

      await repo.updateSandboxSessionStatus(created.id, 'PAUSED', {
        containerName: 'paused-container',
        checkpointRef: 'checkpoint-ref-1',
        pausedReason: 'idle',
      });

      const fetched = await repo.getSandboxSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('PAUSED');
      expect(fetched!.containerName).toBe('paused-container');
      expect(fetched!.pausedReason).toBe('idle');
      expect(fetched!.checkpointRef).toBe('checkpoint-ref-1');
    });

    it('should throw when updating a missing sandbox session status', async () => {
      await expect(
        repo.updateSandboxSessionStatus('missing-session-id', 'ACTIVE'),
      ).rejects.toThrow('Sandbox session missing-session-id not found for status update');
    });

    it('should list active and paused sandbox sessions', async () => {
      const active = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
      });
      const paused = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'PAUSED',
        pausedReason: 'idle',
      });
      await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'TERMINATED',
      });

      const sessions = await repo.getActiveSandboxSessions();
      const sessionIds = new Set(sessions.map((session) => session.id));

      expect(sessionIds.has(active.id)).toBe(true);
      expect(sessionIds.has(paused.id)).toBe(true);
      expect(sessions.some((session) => session.status === 'TERMINATED')).toBe(false);
    });

    it('should list sandbox sessions by agent', async () => {
      await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'pi-agent',
      });

      const sessions = await repo.getSandboxSessionsByAgent(agentId);
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((session) => session.agentId === agentId)).toBe(true);
    });

    it('should delete a sandbox session', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
      });

      await repo.deleteSandboxSession(created.id);
      const fetched = await repo.getSandboxSession(created.id);
      expect(fetched).toBeNull();
    });
  });

  describe('Checkpoint v2', () => {
    let agentId: string;
    let sessionId: string;

    beforeAll(async () => {
      const agent = await repo.createAgent({
        name: 'Checkpoint V2 Agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'Checkpoint test prompt',
        tools: [],
      });
      agentId = agent.id;

      const conversation = await repo.createConversation(agentId);
      const session = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId,
        harnessName: 'langgraph',
      });
      sessionId = session.id;
    });

    it('should create a v2 checkpoint', async () => {
      const result = await repo.createCheckpointV2({
        sessionId,
        agentId,
        checkpointData: { cursor: 1, status: 'idle' },
        harnessState: { messages: [] },
        workspaceRef: 'workspace-ref-1',
        suspendReason: 'manual_suspend',
      });

      expect(result.id).toBeDefined();
    });

    it('should fetch the latest v2 checkpoint for a session', async () => {
      await repo.createCheckpointV2({
        sessionId,
        agentId,
        checkpointData: { cursor: 10 },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await repo.createCheckpointV2({
        sessionId,
        agentId,
        checkpointData: { cursor: 11 },
      });

      const checkpoint = await repo.getCheckpointV2(sessionId);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.checkpointData).toEqual({ cursor: 11 });
      expect(checkpoint!.checkpointVersion).toBe(2);
    });

    it('should round-trip checkpoint JSON payloads', async () => {
      const checkpointData = {
        cursor: { lastMessageId: 'msg-42' },
        runnerState: { status: 'WAITING', pending: ['approval'] },
      };
      const harnessState = {
        payload: {
          nested: {
            value: true,
          },
        },
      };

      await repo.createCheckpointV2({
        sessionId,
        agentId,
        checkpointData,
        harnessState,
      });

      const checkpoint = await repo.getCheckpointV2(sessionId);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.checkpointData).toEqual(checkpointData);
      expect(checkpoint!.harnessState).toEqual(harnessState);
    });

    it('coerces checkpoint BigInt values before JSONB persistence', async () => {
      await repo.createCheckpointV2({
        sessionId,
        agentId,
        checkpointData: {
          cursor: { nextMessageSeq: 9007199254740993n },
          runnerState: {
            pendingRequests: [
              {
                id: 'approval-1',
                payload: { sequence: 9007199254740995n },
              },
            ],
          },
        },
        harnessState: {
          payload: {
            checkpointSeq: 9007199254740997n,
          },
        },
      });

      const checkpoint = await repo.getCheckpointV2(sessionId);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.checkpointData).toEqual({
        cursor: { nextMessageSeq: '9007199254740993' },
        runnerState: {
          pendingRequests: [
            {
              id: 'approval-1',
              payload: { sequence: '9007199254740995' },
            },
          ],
        },
      });
      expect(checkpoint!.harnessState).toEqual({
        payload: {
          checkpointSeq: '9007199254740997',
        },
      });
    });

    it('should delete all v2 checkpoints for a session', async () => {
      const conversation = await repo.createConversation(agentId);
      const session = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId,
        harnessName: 'langgraph',
      });

      await repo.createCheckpointV2({
        sessionId: session.id,
        agentId,
        checkpointData: { step: 1 },
      });
      await repo.createCheckpointV2({
        sessionId: session.id,
        agentId,
        checkpointData: { step: 2 },
      });

      const deleted = await repo.deleteCheckpointsForSession(session.id);
      expect(deleted).toBe(2);

      const checkpoint = await repo.getCheckpointV2(session.id);
      expect(checkpoint).toBeNull();
    });
  });

  describe('Durable claims and HITL interrupts', () => {
    async function createRuntimeTurn(prefix: string) {
      const agent = await repo.createAgent({
        name: `${prefix} Agent`,
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'Persistence test prompt',
        tools: [],
      });
      const conversation = await repo.createConversation(agent.id);
      const sandboxSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId: agent.id,
        harnessName: 'claude-agents',
      });
      const turn = await repo.createTurn({
        sessionId: sandboxSession.id,
        agentId: agent.id,
        conversationId: conversation.id,
        mode: 'interactive',
      });
      return { agent, conversation, sandboxSession, turn };
    }

    it('atomically claims due scheduled events and reclaims expired leases', async () => {
      const { agent } = await createRuntimeTurn('Scheduled Claim');
      const now = Date.now();
      await repo.createScheduledEvent({
        id: 'scheduled-claim-1',
        agentId: agent.id,
        type: 'turn.started',
        payload: JSON.stringify({ runId: 'scheduled-claim-1' }),
        wakeAt: now - 1,
      });

      const firstClaim = await repo.getScheduledEventsDue(now, 10);
      expect(firstClaim.map((event) => event.id)).toEqual(['scheduled-claim-1']);
      expect(firstClaim[0].status).toBe('in_progress');
      expect(firstClaim[0].claimedAt).toBeTypeOf('number');

      const secondClaim = await repo.getScheduledEventsDue(now + 1, 10);
      expect(secondClaim).toEqual([]);

      await testDb.conn.pgClient`
        UPDATE scheduled_events
        SET claim_expires_at = ${now - 10_000}
        WHERE id = 'scheduled-claim-1'
      `;
      const reclaimed = await repo.getScheduledEventsDue(now + 2, 10);
      expect(reclaimed.map((event) => event.id)).toEqual(['scheduled-claim-1']);

      await repo.markScheduledEventCompleted(reclaimed[0].id, reclaimed[0].claimedAt);
      const afterComplete = await repo.getScheduledEventsDue(now + 3, 10);
      expect(afterComplete).toEqual([]);
    });

    it('atomically claims due callbacks and only the active claim can complete', async () => {
      const { agent, turn } = await createRuntimeTurn('Callback Claim');
      const now = Date.now();
      await repo.enqueueCallback({
        id: 'callback-claim-1',
        agentId: agent.id,
        sessionId: turn.id,
        callbackUrl: 'https://example.test/hook',
        eventType: 'turn.completed',
        payload: { ok: true },
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: now - 1,
        createdAt: now,
      });

      const firstClaim = await repo.getPendingCallbacks(10, now);
      expect(firstClaim.map((callback) => callback.id)).toEqual(['callback-claim-1']);
      expect(firstClaim[0].status).toBe('in_progress');
      const staleClaimedAt = firstClaim[0].claimedAt;

      const secondClaim = await repo.getPendingCallbacks(10, now + 1);
      expect(secondClaim).toEqual([]);

      await testDb.conn.pgClient`
        UPDATE callback_outbox
        SET claim_expires_at = ${now - 10_000}
        WHERE id = 'callback-claim-1'
      `;
      const reclaimed = await repo.getPendingCallbacks(10, now + 2);
      expect(reclaimed.map((callback) => callback.id)).toEqual(['callback-claim-1']);
      expect(reclaimed[0].claimedAt).not.toBe(staleClaimedAt);

      await repo.markCallbackDelivered('callback-claim-1', staleClaimedAt);
      expect((await repo.getCallbacksForAgent(agent.id))[0].status).toBe('in_progress');

      await repo.markCallbackDelivered('callback-claim-1', reclaimed[0].claimedAt);
      expect((await repo.getCallbacksForAgent(agent.id))[0].status).toBe('delivered');
    });

    it('uses compare-and-set for HITL resolution and clears stale resolved fields on pending upsert', async () => {
      const { agent, sandboxSession, turn } = await createRuntimeTurn('Interrupt CAS');
      const now = Date.now();
      await repo.savePendingInterrupt({
        id: 'interrupt-cas-1',
        agentSessionId: turn.id,
        agentId: agent.id,
        sessionId: sandboxSession.id,
        toolCallId: 'tool-call-1',
        toolName: 'bash',
        args: { cmd: 'ls' },
        timeoutMs: 60_000,
        createdAt: now,
        expiresAt: now + 60_000,
      });

      const resolved = await repo.resolveInterrupt('interrupt-cas-1', 'approve', { approved: true });
      expect(resolved?.status).toBe('resolved');

      const secondResolve = await repo.resolveInterrupt('interrupt-cas-1', 'reject', { approved: false });
      expect(secondResolve).toBeUndefined();

      const upserted = await repo.savePendingInterrupt({
        id: 'interrupt-cas-1',
        agentSessionId: turn.id,
        agentId: agent.id,
        sessionId: sandboxSession.id,
        toolCallId: 'tool-call-2',
        toolName: 'shell',
        args: { cmd: 'pwd' },
        timeoutMs: 120_000,
        createdAt: now + 1,
        expiresAt: now + 120_000,
        status: 'pending',
      });

      expect(upserted.status).toBe('pending');
      expect(upserted.resolvedAt).toBeNull();
      expect(upserted.resolvedAction).toBeNull();
      expect(upserted.resolvedData).toBeNull();
      expect(upserted.toolCallId).toBe('tool-call-2');
    });

    it('tracks timed-out interrupts and durable resume attempts', async () => {
      const { agent, sandboxSession, turn } = await createRuntimeTurn('Interrupt Resume Attempt');
      const now = Date.now();
      await repo.savePendingInterrupt({
        id: 'interrupt-resume-1',
        agentSessionId: turn.id,
        agentId: agent.id,
        sessionId: sandboxSession.id,
        toolCallId: 'tool-call-resume',
        toolName: 'bash',
        args: { cmd: 'cat report.md' },
        timeoutMs: 60_000,
        createdAt: now,
        expiresAt: now + 60_000,
      });

      const timedOut = await repo.markInterruptTimedOut('interrupt-resume-1', 'Approval expired');
      expect(timedOut?.status).toBe('timed_out');
      expect(timedOut?.resolvedAction).toBe('timeout');

      const resolved = await repo.resolveInterrupt('interrupt-resume-1', 'approve', { ok: true });
      expect(resolved?.status).toBe('resolved');

      const attempt = await repo.upsertInterruptResumeAttempt({
        interruptId: 'interrupt-resume-1',
        agentSessionId: turn.id,
        sessionId: sandboxSession.id,
        agentId: agent.id,
        status: 'pending',
      });
      expect(attempt.status).toBe('pending');

      const inProgress = await repo.markInterruptResumeAttemptInProgress(attempt.id);
      expect(inProgress?.status).toBe('in_progress');
      expect(inProgress?.attempts).toBe(1);

      const failed = await repo.markInterruptResumeAttemptFailed(attempt.id, 'restore failed');
      expect(failed?.status).toBe('failed');
      expect(failed?.lastError).toBe('restore failed');

      const actionable = await repo.getActionableInterruptsForAgent(agent.id);
      expect(actionable).toHaveLength(1);
      expect(actionable[0].interrupt.id).toBe('interrupt-resume-1');
      expect(actionable[0].resumeAttempt?.status).toBe('failed');

      const completed = await repo.markInterruptResumeAttemptCompleted(attempt.id);
      expect(completed?.status).toBe('completed');
      expect(completed?.completedAt).toBeTypeOf('number');
    });
  });
});
