import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../utils/test-db.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import { isUniqueConstraintViolation } from '../../packages/ctxmill/src/database/errors.js';

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
        'interrupt_resume_attempts',
        'messages',
        'pending_interrupts',
        'sandbox_sessions',
        'secrets',
        'spine_cursors',
        'suspended_sessions',
        'system_settings',
        'tool_request_dedup',
        'trigger_firings',
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

    it('creates durable turn queue columns and open-status index', async () => {
      const columns = await testDb.conn.pgClient`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'turns'
        ORDER BY column_name
      `;
      const byName = new Map(columns.map((column) => [String(column.column_name), column]));
      expect(byName.get('status')?.is_nullable).toBe('NO');
      expect(String(byName.get('status')?.column_default)).toContain("'queued'");
      expect(byName.has('user_message_id')).toBe(true);

      const indexes = await testDb.conn.pgClient`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'turns' AND indexname = 'idx_turns_status_open'
      `;
      expect(String(indexes[0]?.indexdef)).toContain('WHERE (completed_at IS NULL)');
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

    it('leaves the vestigial status column at its default (derived at read, ctx-1xb)', async () => {
      const created = await repo.createAgent(agentData);
      expect(created.status).toBe('created');
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

      const [callbackCount] = await testDb.conn.pgClient`
        SELECT count(*)::int AS count FROM callback_outbox WHERE agent_id = ${agent.id}
      `;
      const [secretCount] = await testDb.conn.pgClient`
        SELECT count(*)::int AS count FROM secrets WHERE agent_id = ${agent.id}
      `;
      const [dedupCount] = await testDb.conn.pgClient`
        SELECT count(*)::int AS count FROM tool_request_dedup WHERE request_id = 'delete-cascade-dedup'
      `;
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

      await repo.updateSandboxSessionStatus(created.id, 'CHECKPOINTED', {
        containerName: 'checkpointed-container',
        checkpointRef: 'checkpoint-ref-1',
      });

      const fetched = await repo.getSandboxSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('CHECKPOINTED');
      expect(fetched!.containerName).toBe('checkpointed-container');
      expect(fetched!.checkpointRef).toBe('checkpoint-ref-1');
    });

    it('should throw when updating a missing sandbox session status', async () => {
      await expect(
        repo.updateSandboxSessionStatus('missing-session-id', 'ACTIVE'),
      ).rejects.toThrow('Sandbox session missing-session-id not found for status update');
    });

    it('compare-and-set status updates reject stale expectedFrom values without writing', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'pi-agent',
      });

      await expect(
        repo.updateSandboxSessionStatus(created.id, 'CHECKPOINTED', undefined, {
          expectedFrom: 'RESTORING',
        }),
      ).rejects.toMatchObject({ name: 'SandboxSessionStatusConflictError' });

      const afterStaleWrite = await repo.getSandboxSession(created.id);
      expect(afterStaleWrite?.status).toBe('ACTIVE');

      await expect(
        repo.updateSandboxSessionStatus(created.id, 'CHECKPOINTED', {
          checkpointRef: 'checkpoint-ref-cas',
        }, {
          expectedFrom: 'ACTIVE',
        }),
      ).resolves.toBeUndefined();

      const afterCasWrite = await repo.getSandboxSession(created.id);
      expect(afterCasWrite?.status).toBe('CHECKPOINTED');
      expect(afterCasWrite?.checkpointRef).toBe('checkpoint-ref-cas');
    });

    it('should list active sandbox sessions', async () => {
      const active = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
      });
      const restoring = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'RESTORING',
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
      expect(sessionIds.has(restoring.id)).toBe(false);
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

    it('enforces logical uniqueness for trigger agent, event type, and selector', async () => {
      const { agent } = await createRuntimeTurn('Trigger Signature');

      await repo.saveTrigger({
        id: 'trigger-signature-1',
        agentId: agent.id,
        eventType: 'custom.ready',
        selector: { b: 2, a: 1 },
        taskTemplate: 'First',
        enabled: true,
        createdAt: new Date().toISOString(),
      });

      await expect(repo.saveTrigger({
        id: 'trigger-signature-2',
        agentId: agent.id,
        eventType: 'custom.ready',
        selector: { a: 1, b: 2 },
        taskTemplate: 'Second',
        enabled: true,
        createdAt: new Date().toISOString(),
      })).rejects.toSatisfy((err: unknown) => isUniqueConstraintViolation(err, 'idx_event_triggers_signature'));

      await expect(repo.saveTrigger({
        id: 'trigger-signature-3',
        agentId: agent.id,
        eventType: 'custom.done',
        selector: { a: 1, b: 2 },
        taskTemplate: 'Third',
        enabled: true,
        createdAt: new Date().toISOString(),
      })).resolves.toMatchObject({
        id: 'trigger-signature-3',
      });
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

    it('deduplicates callback outbox inserts by callback URL, event type, and event seq', async () => {
      const { agent, turn } = await createRuntimeTurn('Callback Event Seq');
      const now = Date.now();
      const first = await repo.enqueueCallback({
        id: 'callback-event-seq-1',
        agentId: agent.id,
        sessionId: turn.id,
        callbackUrl: 'https://example.test/hook',
        eventType: 'turn.completed',
        eventSeq: 123,
        payload: { status: 'completed' },
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: now,
        createdAt: now,
      });

      const duplicate = await repo.enqueueCallback({
        id: 'callback-event-seq-2',
        agentId: agent.id,
        sessionId: turn.id,
        callbackUrl: 'https://example.test/hook',
        eventType: 'turn.completed',
        eventSeq: 123,
        payload: { status: 'completed', redelivered: true },
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: now + 1,
        createdAt: now + 1,
      });

      expect(duplicate.id).toBe(first.id);
      const rows = await repo.getCallbacksForAgent(agent.id);
      expect(rows.filter((row) =>
        row.callbackUrl === 'https://example.test/hook'
        && row.eventType === 'turn.completed'
        && row.eventSeq === 123,
      )).toHaveLength(1);
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

  describe('Turn finalization primitives (ADR-014)', () => {
    let agentId: string;

    beforeAll(async () => {
      const agent = await repo.createAgent({
        name: 'finalize-agent',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test',
        tools: [],
        status: 'created',
      });
      agentId = agent.id;
    });

    it('finalizeTurnIfOpen writes terminal state exactly once', async () => {
      const conversation = await repo.createConversation(agentId);
      const turn = await repo.createTurn({ agentId, conversationId: conversation.id, mode: 'interactive' });

      const first = await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: Date.now(),
        error: 'first writer wins',
        status: 'error',
      });
      const second = await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: Date.now(),
        error: 'second writer must lose',
        status: 'error',
      });

      expect(first).toBe(true);
      expect(second).toBe(false);
      const readback = await repo.getTurn(turn.id);
      expect(readback?.error).toBe('first writer wins');
      expect(readback?.status).toBe('error');
    });

    it('getOpenTurnsStartedBefore returns only open turns older than the cutoff', async () => {
      const conversation = await repo.createConversation(agentId);
      const oldOpen = await repo.createTurn({ agentId, conversationId: conversation.id, mode: 'interactive' });
      const oldClosed = await repo.createTurn({ agentId, conversationId: conversation.id, mode: 'interactive' });
      await repo.finalizeTurnIfOpen(oldClosed.id, { completedAt: Date.now(), error: null, status: 'completed' });

      const cutoff = Date.now() + 1_000;
      const stranded = await repo.getOpenTurnsStartedBefore(cutoff);
      const ids = stranded.map((turn) => turn.id);
      expect(ids).toContain(oldOpen.id);
      expect(ids).not.toContain(oldClosed.id);

      const noneBeforeEpoch = await repo.getOpenTurnsStartedBefore(oldOpen.startedAt);
      expect(noneBeforeEpoch.map((turn) => turn.id)).not.toContain(oldOpen.id);
    });

    it('updateMessageToolCallsAndParts repairs both projections', async () => {
      const conversation = await repo.createConversation(agentId);
      const message = await repo.addMessage({
        agentId,
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'bash', args: '{}', status: 'running' }],
        parts: [{ type: 'tool_call', id: 'tc-1', name: 'bash', args: '{}', status: 'running' }],
      });

      await repo.updateMessageToolCallsAndParts(
        message.id,
        [{ id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: 'interrupted' }],
        [{ type: 'tool_call', id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: 'interrupted' }],
      );

      const rows = await repo.getMessages(conversation.id);
      const repaired = rows.find((row) => row.id === message.id);
      expect(repaired?.toolCalls).toEqual([
        { id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: 'interrupted' },
      ]);
      expect(repaired?.parts).toEqual([
        { type: 'tool_call', id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: 'interrupted' },
      ]);
    });
  });

  describe('Canonical event frame primitives (ADR-015, Stage 4 A0)', () => {
    let agentId: string;

    beforeAll(async () => {
      const agent = await repo.createAgent({
        name: 'frames-agent',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test',
        tools: [],
        status: 'created',
      });
      agentId = agent.id;
    });

    it('saveEventBatch persists frames in one round trip and returns seqs in order', async () => {
      const seqs = await repo.saveEventBatch([
        {
          type: 'RUN_STARTED',
          agentId,
          payload: '{"a":1}',
          turnId: 'turn-f1',
          conversationId: 'conv-f1',
          channel: 'run',
          sourceType: 'turn.started',
          sourcePayload: '{"turnId":"turn-f1"}',
        },
        { type: 'TEXT_MESSAGE_CONTENT', agentId, payload: '{"a":2}', turnId: 'turn-f1', conversationId: 'conv-f1', channel: 'run' },
        { type: 'stress.langgraph.complete', agentId, payload: '{"schemaVersion":1}', channel: 'custom' },
      ]);

      expect(seqs).toHaveLength(3);
      expect(seqs[0]).toBeLessThan(seqs[1]!);
      expect(seqs[1]).toBeLessThan(seqs[2]!);
      expect(await repo.saveEventBatch([])).toEqual([]);
    });

    it('getFramesSince replays per agent, seq-ordered, with channel filtering', async () => {
      const all = await repo.getFramesSince(agentId, 0);
      expect(all.length).toBeGreaterThanOrEqual(3);
      expect(all.map((row) => row.seq)).toEqual([...all.map((row) => row.seq)].sort((a, b) => a - b));

      const runOnly = await repo.getFramesSince(agentId, 0, { channels: ['run'] });
      expect(runOnly.every((row) => row.channel === 'run')).toBe(true);
      expect(runOnly.map((row) => row.type)).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_CONTENT']);
      expect(runOnly[0]!.sourceType).toBe('turn.started');
      expect(runOnly[0]!.sourcePayload).toBe('{"turnId":"turn-f1"}');
      expect(runOnly[1]!.sourceType).toBeNull();

      const afterFirst = await repo.getFramesSince(agentId, runOnly[0]!.seq, { channels: ['run'] });
      expect(afterFirst.map((row) => row.type)).toEqual(['TEXT_MESSAGE_CONTENT']);
    });

    it('getTurnFrames returns a turn tail in seq order', async () => {
      const frames = await repo.getTurnFrames('turn-f1');
      expect(frames.map((row) => row.type)).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_CONTENT']);
      expect(frames.every((row) => row.conversationId === 'conv-f1')).toBe(true);

      const tail = await repo.getTurnFrames('turn-f1', frames[0]!.seq);
      expect(tail.map((row) => row.type)).toEqual(['TEXT_MESSAGE_CONTENT']);
    });

    it('tracks raw source rows and spine cursors for durable consumers', async () => {
      const [seq] = await repo.saveEventBatch([
        {
          type: 'RUN_STARTED',
          agentId,
          payload: '{"event":"cursor"}',
          turnId: 'turn-cursor',
          conversationId: 'conv-cursor',
          channel: 'run',
          sourceType: 'turn.started',
          sourcePayload: '{"turnId":"turn-cursor"}',
        },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId,
          payload: '{"event":"cursor-content"}',
          turnId: 'turn-cursor',
          conversationId: 'conv-cursor',
          channel: 'run',
        },
      ]);
      const sourceRows = await repo.getSourceEventsSince((seq ?? 0) - 1);
      expect(sourceRows.map((row) => row.type)).toContain('RUN_STARTED');
      expect(sourceRows.every((row) => row.sourceType)).toBe(true);

      const sourceSeq = sourceRows.find((row) => row.type === 'RUN_STARTED')!.seq;
      await repo.advanceSpineCursor('event-triggers', sourceSeq);
      await repo.advanceSpineCursor('event-triggers', 1);
      expect(await repo.getSpineCursor('event-triggers')).toBe(sourceSeq);
    });

    it('deduplicates trigger firings by trigger id and event seq', async () => {
      const trigger = await repo.saveTrigger({
        id: 'trigger-firing-test',
        agentId,
        eventType: 'turn.started',
        selector: null,
        taskTemplate: 'run',
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      const first = await repo.recordTriggerFiring(trigger.id, 123);
      const duplicate = await repo.recordTriggerFiring(trigger.id, 123);

      expect(first?.triggerId).toBe(trigger.id);
      expect(duplicate).toBeUndefined();
      expect(await repo.hasTriggerFiring(trigger.id, 123)).toBe(true);
      expect(await repo.hasTriggerFiring(trigger.id, 124)).toBe(false);
    });

  });
});
