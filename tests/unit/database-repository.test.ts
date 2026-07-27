import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { CanonicalStreamEventSchema } from '@ctxmill/contracts';
import type { SandboxSessionStatus } from '@ctxmill/shared';
import {
  createTestDb,
  resolveTestDatabaseUrl,
  type TestDb,
} from '../utils/test-db.js';
import { createDatabase } from '../../packages/ctxmill/src/database/connection.js';
import { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import { isUniqueConstraintViolation } from '../../packages/ctxmill/src/database/errors.js';
import {
  createInitialChatState,
  reduceCtxmillChatState,
} from '../../packages/react/src/state.js';

async function waitForCondition(
  predicate: () => Promise<boolean>,
  failureMessage: string,
  timeoutMs = 1_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(failureMessage);
}

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

  async function expireTurnDeliveryLease(turnId: string): Promise<void> {
    await testDb.conn.pgClient`
      UPDATE turn_delivery_leases
      SET
        lease_expires_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1,
        updated_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      WHERE turn_id = ${turnId}
    `;
  }

  async function expireSandboxSessionLifecycleOperation(
    sandboxSessionId: string,
  ): Promise<void> {
    await testDb.conn.pgClient`
      UPDATE sandbox_session_lifecycle_operations
      SET
        lease_expires_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1,
        updated_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      WHERE sandbox_session_id = ${sandboxSessionId}
    `;
  }

  function activeGenerationOf(session: {
    restoreFenceToken: number;
    containerId: string | null;
  }): {
    restoreFenceToken: number;
    containerId: string | null;
  } {
    return {
      restoreFenceToken: session.restoreFenceToken,
      containerId: session.containerId,
    };
  }

  async function currentActiveGeneration(
    sandboxSessionId: string,
  ): Promise<{
    restoreFenceToken: number;
    containerId: string | null;
  }> {
    const session = await repo.getSandboxSession(sandboxSessionId);
    if (!session || session.status !== 'ACTIVE') {
      throw new Error(
        `Sandbox session ${sandboxSessionId} is not ACTIVE`,
      );
    }
    return activeGenerationOf(session);
  }

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
        'agent_event_heads',
        'agent_workspace_state',
        'agents',
        'artifacts',
        'budget_policies',
        'callback_outbox',
        'conversations',
        'ctxmill_schema_version',
        'event_store',
        'event_triggers',
        'interrupt_resume_attempts',
        'messages',
        'model_call_attempt_usage',
        'model_call_usage',
        'model_gateway_reconciliation_state',
        'model_gateway_spend_quarantine',
        'pending_interrupts',
        'sandbox_session_lifecycle_operations',
        'sandbox_sessions',
        'schedules',
        'secrets',
        'spine_cursors',
        'suspended_sessions',
        'system_settings',
        'tool_request_dedup',
        'trigger_firings',
        'turn_delivery_leases',
        'turn_secret_envelopes',
        'turn_start_requests',
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

    it('backfills lifecycle-independent heads for orphaned deletion events', async () => {
      const { runMigrations } = await import('../../packages/ctxmill/src/database/migrations.js');
      const orphanAgentId = 'deleted-legacy-agent';
      const orphanPayload = 'orphaned-before-agent-heads';
      const [orphanEvent] = await testDb.conn.pgClient`
        INSERT INTO event_store (type, agent_id, payload, created_at)
        VALUES ('RUN_FINISHED', ${orphanAgentId}, ${orphanPayload}, 1)
        RETURNING seq
      `;

      try {
        await expect(runMigrations(testDb.conn.pgClient)).resolves.not.toThrow();
        const orphanHeads = await testDb.conn.pgClient`
          SELECT agent_id, committed_seq::int
          FROM agent_event_heads
          WHERE agent_id = ${orphanAgentId}
        `;
        expect(orphanHeads).toEqual([{
          agent_id: orphanAgentId,
          committed_seq: orphanEvent.seq,
        }]);

        const foreignKeys = await testDb.conn.pgClient`
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'agent_event_heads'::regclass
            AND contype = 'f'
        `;
        expect(foreignKeys).toEqual([]);
      } finally {
        await testDb.conn.pgClient`
          DELETE FROM event_store WHERE payload = ${orphanPayload}
        `;
        await testDb.conn.pgClient`
          DELETE FROM agent_event_heads WHERE agent_id = ${orphanAgentId}
        `;
      }
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
      expect(byName.has('terminal_published_seq')).toBe(true);
      expect(byName.get('delivery_owner_id')?.is_nullable).toBe('YES');
      expect(byName.get('delivery_fence_token')?.is_nullable).toBe('YES');

      const leaseColumns = await testDb.conn.pgClient`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'turn_delivery_leases'
        ORDER BY column_name
      `;
      const leaseByName = new Map(
        leaseColumns.map((column) => [String(column.column_name), column]),
      );
      expect(leaseByName.get('fence_token')?.is_nullable).toBe('NO');
      expect(String(leaseByName.get('fence_token')?.column_default)).toContain('0');
      const lifecycleOperationColumns = await testDb.conn.pgClient`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'sandbox_session_lifecycle_operations'
        ORDER BY column_name
      `;
      const lifecycleOperationByName = new Map(
        lifecycleOperationColumns.map((column) => [String(column.column_name), column]),
      );
      expect(lifecycleOperationByName.get('sandbox_session_id')?.is_nullable).toBe('NO');
      expect(lifecycleOperationByName.get('operation')?.is_nullable).toBe('NO');
      expect(lifecycleOperationByName.get('operation_id')?.is_nullable).toBe('NO');
      expect(lifecycleOperationByName.get('phase')?.is_nullable).toBe('NO');
      expect(lifecycleOperationByName.get('fence_token')?.is_nullable).toBe('NO');
      expect(
        lifecycleOperationByName.get(
          'allowed_interrupt_resume_attempt_id',
        )?.is_nullable,
      ).toBe('YES');
      expect(byName.has('reconciliation_owner_id')).toBe(false);
      expect(byName.has('reconciliation_fence_token')).toBe(false);

      const restoreColumns = await testDb.conn.pgClient`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'sandbox_sessions'
          AND column_name IN (
            'restore_owner_id',
            'restore_fence_token',
            'restore_lease_expires_at'
          )
        ORDER BY column_name
      `;
      const restoreByName = new Map(
        restoreColumns.map((column) => [String(column.column_name), column]),
      );
      expect(restoreByName.get('restore_owner_id')?.is_nullable).toBe('YES');
      expect(restoreByName.get('restore_fence_token')?.is_nullable).toBe('NO');
      expect(String(
        restoreByName.get('restore_fence_token')?.column_default,
      )).toContain('0');
      expect(
        restoreByName.get('restore_lease_expires_at')?.is_nullable,
      ).toBe('YES');
      const sandboxConstraints = await testDb.conn.pgClient`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'sandbox_sessions'::regclass
          AND conname IN (
            'sandbox_sessions_status_check',
            'sandbox_sessions_restore_ownership_check'
          )
        ORDER BY conname
      `;
      expect(sandboxConstraints.map(({ conname }) => conname)).toEqual([
        'sandbox_sessions_restore_ownership_check',
        'sandbox_sessions_status_check',
      ]);
      expect(
        String(sandboxConstraints[0]?.definition),
      ).toContain('restore_lease_expires_at IS NOT NULL');
      expect(
        String(sandboxConstraints[1]?.definition),
      ).toContain("'RESTORING'::text");

      const indexes = await testDb.conn.pgClient`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'turns' AND indexname = 'idx_turns_status_open'
      `;
      expect(String(indexes[0]?.indexdef)).toContain('WHERE (completed_at IS NULL)');
      const conversationAdmissionIndexes = await testDb.conn.pgClient`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'idx_sandbox_sessions_conversation_live',
            'idx_turns_conversation_running'
          )
        ORDER BY indexname
      `;
      expect(conversationAdmissionIndexes.map(({ indexname }) => indexname)).toEqual([
        'idx_sandbox_sessions_conversation_live',
        'idx_turns_conversation_running',
      ]);
      expect(String(conversationAdmissionIndexes[0]?.indexdef)).toContain('UNIQUE');
      expect(String(conversationAdmissionIndexes[0]?.indexdef)).toContain(
        "status = ANY (ARRAY['ACTIVE'::text, 'RESTORING'::text])",
      );
      expect(String(conversationAdmissionIndexes[1]?.indexdef)).toContain('UNIQUE');
      expect(String(conversationAdmissionIndexes[1]?.indexdef)).toContain(
        "(status = 'running'::text)",
      );

      const staleNames = await testDb.conn.pgClient`
        SELECT indexname AS name
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname LIKE '%turn_reconciliation%'
        UNION ALL
        SELECT conname AS name
        FROM pg_constraint
        WHERE conname LIKE '%turn_reconciliation%'
      `;
      expect(staleNames).toEqual([]);
    });
  });

  // --- Agents CRUD (CFG-05) ---

  describe('CFG-05: Agent CRUD', () => {
    const agentData = (name: string) => ({
      name,
      harness: 'claude-agents',
      harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      systemPrompt: 'You are a test agent.',
      tools: ['bash', 'read_file'],
    });

    it('should create an agent and assign an id', async () => {
      const agent = await repo.createAgent(agentData('Test Agent'));
      expect(agent.id).toBeDefined();
      expect(typeof agent.id).toBe('string');
      expect(agent.name).toBe('Test Agent');
      expect(agent.harness).toBe('claude-agents');
      expect(JSON.parse(agent.harnessConfig)).toEqual({ model: 'claude-sonnet-4-6' });
      expect(agent.systemPrompt).toBe('You are a test agent.');
      expect(agent.tools).toEqual(['bash', 'read_file']);
      expect(agent.createdAt).toBeTypeOf('number');
      expect(agent.updatedAt).toBeTypeOf('number');
    });

    it('should read an agent by id', async () => {
      const created = await repo.createAgent(agentData('Read Agent'));
      const fetched = await repo.getAgent(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe('Read Agent');
    });

    it('should return undefined for non-existent agent', async () => {
      const fetched = await repo.getAgent('non-existent-id');
      expect(fetched).toBeUndefined();
    });

    it('should list all agents', async () => {
      await repo.createAgent(agentData('List Agent One'));
      await repo.createAgent(agentData('List Agent Two'));
      const agents = await repo.listAgents();
      expect(agents.length).toBeGreaterThanOrEqual(2);
    });

    it('should update an agent', async () => {
      const created = await repo.createAgent(agentData('Update Agent'));
      const updated = await repo.updateAgent(created.id, { name: 'Updated Name' });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated Name');
      expect(updated!.harness).toBe('claude-agents');
      expect(JSON.parse(updated!.harnessConfig)).toEqual({ model: 'claude-sonnet-4-6' });
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it('should update harnessConfig', async () => {
      const created = await repo.createAgent(agentData('Harness Config Agent'));
      const updated = await repo.updateAgent(created.id, {
        harnessConfig: JSON.stringify({ model: 'claude-opus-4-6', maxTurns: 4 }),
      });

      expect(updated).toBeDefined();
      expect(JSON.parse(updated!.harnessConfig)).toEqual({ model: 'claude-opus-4-6', maxTurns: 4 });
    });

    it('should delete an agent', async () => {
      const created = await repo.createAgent(agentData('To Delete'));
      await repo.deleteAgent(created.id);
      const fetched = await repo.getAgent(created.id);
      expect(fetched).toBeUndefined();
    });

    it('deleteAgentCascade cleans owned runtime state while preserving artifact metadata as global', async () => {
      const agent = await repo.createAgent(agentData('Cascade Delete Owner'));
      const conversation = await repo.createConversation(agent.id);
      const sandboxSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId: agent.id,
        harnessName: 'claude-agents',
      });
      const turn = await repo.createTurn({
        id: 'delete-cascade-turn',
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        conversationId: conversation.id,
        mode: 'interactive',
      });

      await repo.enqueueCallback({
        id: 'delete-cascade-callback',
        agentId: agent.id,
        turnId: turn.id,
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
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
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
        turnId: turn.id,
        conversationId: conversation.id,
        name: 'survives.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
        storageKey: 'agent/artifact/survives.txt',
        bucket: 'test-bucket',
        kind: 'eval_report',
        metadata: { suite: 'cascade' },
        status: 'active',
      });
      await testDb.conn.pgClient`
        INSERT INTO secrets (id, agent_id, tool_id, key, iv, ciphertext, auth_tag)
        VALUES ('delete-cascade-secret', ${agent.id}, '', 'TOKEN', 'iv', 'ciphertext', 'tag')
      `;
      await testDb.conn.pgClient`
        INSERT INTO tool_request_dedup (request_id, turn_id, tool_name, status, created_at)
        VALUES ('delete-cascade-dedup', ${turn.id}, 'bash', 'in_progress', ${Date.now()})
      `;

      await repo.deleteAgentCascade(agent.id);

      expect(await repo.getAgent(agent.id)).toBeUndefined();
      expect(await repo.getArtifact(artifact.id)).toMatchObject({
        id: artifact.id,
        agentId: null,
        turnId: null,
        conversationId: null,
        kind: 'eval_report',
        metadata: { suite: 'cascade' },
        status: 'active',
      });
      expect(await repo.getInterruptById('delete-cascade-interrupt')).toBeUndefined();

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

    it('reads ordered messages and the agent event boundary in one conversation snapshot', async () => {
      const conv = await repo.createConversation(agentId);
      await repo.addMessage({
        conversationId: conv.id,
        agentId,
        role: 'user',
        content: 'Snapshot message',
      });
      const [ownedSeq] = await repo.saveEventBatch([{
        type: 'RUN_STARTED',
        agentId,
        conversationId: conv.id,
        payload: JSON.stringify({ type: 'RUN_STARTED' }),
        channel: 'run',
      }]);
      const otherAgent = await repo.createAgent({
        name: 'Other Snapshot Agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'Other snapshot prompt',
        tools: [],
      });
      await repo.saveEventBatch([{
        type: 'RUN_STARTED',
        agentId: otherAgent.id,
        payload: JSON.stringify({ type: 'RUN_STARTED' }),
        channel: 'run',
      }]);

      const snapshot = await repo.getConversationSnapshot(
        conv.id,
        agentId,
      );

      expect(snapshot.eventCursorSeq).toBe(ownedSeq);
      expect(snapshot.messages.map((message) => message.content)).toEqual([
        'Snapshot message',
      ]);
    });

    it('reconstructs an active user message exactly once when the snapshot lands mid-text', async () => {
      const conversation = await repo.createConversation(agentId);
      const userMessage = await repo.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'user',
        content: 'stream some text',
      });
      const turn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        userMessageId: userMessage.id,
      });
      const seqs = await repo.saveEventBatch([
        {
          type: 'TEXT_MESSAGE_START',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_START',
            runId: turn.id,
            threadId: conversation.id,
            messageId: userMessage.id,
            role: 'user',
            timestamp: 1,
          }),
        },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_CONTENT',
            runId: turn.id,
            threadId: conversation.id,
            messageId: userMessage.id,
            delta: userMessage.content,
            timestamp: 2,
          }),
        },
        {
          type: 'TEXT_MESSAGE_END',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_END',
            runId: turn.id,
            threadId: conversation.id,
            messageId: userMessage.id,
            timestamp: 3,
          }),
        },
        {
          type: 'RUN_STARTED',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'RUN_STARTED',
            runId: turn.id,
            threadId: conversation.id,
            timestamp: 4,
          }),
        },
        {
          type: 'TEXT_MESSAGE_START',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_START',
            runId: turn.id,
            threadId: conversation.id,
            messageId: `${turn.id}-m1`,
            role: 'assistant',
            timestamp: 5,
          }),
        },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_CONTENT',
            runId: turn.id,
            threadId: conversation.id,
            messageId: `${turn.id}-m1`,
            delta: 'partial',
            timestamp: 6,
          }),
        },
      ]);

      const snapshot = await repo.getConversationSnapshot(
        conversation.id,
        agentId,
      );
      const replay = await repo.getFramesSince(
        agentId,
        snapshot.eventCursorSeq,
        { channels: ['run'] },
      );

      expect(snapshot.eventCursorSeq).toBe(seqs[0]! - 1);
      expect(snapshot.messages.map(({ id }) => id)).not.toContain(userMessage.id);
      expect(replay.map(({ type }) => type)).toEqual([
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_END',
        'RUN_STARTED',
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
      ]);
      let chatState = reduceCtxmillChatState(
        createInitialChatState(conversation.id),
        {
          type: 'load_messages',
          threadId: conversation.id,
          messages: snapshot.messages.map((message) => ({
            id: message.id,
            role: message.role as 'user' | 'assistant' | 'system' | 'tool',
            content: message.content,
            messageRevision: message.messageRevision,
          })),
        },
      );
      for (const frame of replay) {
        chatState = reduceCtxmillChatState(chatState, {
          type: 'stream_event',
          event: CanonicalStreamEventSchema.parse(JSON.parse(frame.payload)),
        });
      }
      expect(
        chatState.messages.filter(({ id }) => id === userMessage.id),
      ).toEqual([
        expect.objectContaining({
          id: userMessage.id,
          role: 'user',
          content: userMessage.content,
        }),
      ]);
    });

    it('omits an active user projection before its first frame and replays it once later', async () => {
      const conversation = await repo.createConversation(agentId);
      const userMessage = await repo.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'user',
        content: 'race the first canonical frame',
      });
      const turn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        userMessageId: userMessage.id,
      });
      const headBeforeFrames = await repo.getLatestEventSeq(agentId);

      const snapshot = await repo.getConversationSnapshot(
        conversation.id,
        agentId,
      );

      expect(snapshot.eventCursorSeq).toBe(headBeforeFrames);
      expect(snapshot.messages.map(({ id }) => id)).not.toContain(userMessage.id);

      await repo.saveEventBatch([
        {
          type: 'TEXT_MESSAGE_START',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_START',
            runId: turn.id,
            threadId: conversation.id,
            messageId: userMessage.id,
            role: 'user',
            timestamp: 1,
          }),
        },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_CONTENT',
            runId: turn.id,
            threadId: conversation.id,
            messageId: userMessage.id,
            delta: userMessage.content,
            timestamp: 2,
          }),
        },
        {
          type: 'TEXT_MESSAGE_END',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_END',
            runId: turn.id,
            threadId: conversation.id,
            messageId: userMessage.id,
            timestamp: 3,
          }),
        },
      ]);
      const replay = await repo.getFramesSince(
        agentId,
        snapshot.eventCursorSeq,
        { channels: ['run'] },
      );
      let chatState = reduceCtxmillChatState(
        createInitialChatState(conversation.id),
        {
          type: 'load_messages',
          threadId: conversation.id,
          messages: snapshot.messages.map((message) => ({
            id: message.id,
            role: message.role as 'user' | 'assistant' | 'system' | 'tool',
            content: message.content,
            messageRevision: message.messageRevision,
          })),
        },
      );
      for (const frame of replay) {
        chatState = reduceCtxmillChatState(chatState, {
          type: 'stream_event',
          event: CanonicalStreamEventSchema.parse(JSON.parse(frame.payload)),
        });
      }

      expect(
        chatState.messages.filter(({ id }) => id === userMessage.id),
      ).toEqual([
        expect.objectContaining({
          id: userMessage.id,
          role: 'user',
          content: userMessage.content,
        }),
      ]);
    });

    it('keeps a zero-frame background user projection because background turns never publish user.message', async () => {
      const conversation = await repo.createConversation(agentId);
      const backgroundMessage = await repo.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'user',
        content: 'trigger payload',
      });
      await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'background',
        status: 'queued',
        userMessageId: backgroundMessage.id,
      });
      const headBeforeFrames = await repo.getLatestEventSeq(agentId);

      const snapshot = await repo.getConversationSnapshot(
        conversation.id,
        agentId,
      );

      expect(snapshot.eventCursorSeq).toBe(headBeforeFrames);
      expect(snapshot.messages.map(({ id }) => id)).toContain(backgroundMessage.id);
    });

    it('rewinds and omits turn-owned projections when the snapshot lands mid-tool', async () => {
      const conversation = await repo.createConversation(agentId);
      const userMessage = await repo.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'user',
        content: 'use a tool',
      });
      const turn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        userMessageId: userMessage.id,
      });
      const assistantProjection = await repo.addMessage({
        agentId,
        conversationId: conversation.id,
        turnId: turn.id,
        role: 'assistant',
        content: 'tool preview',
      });
      const seqs = await repo.saveEventBatch([
        {
          type: 'RUN_STARTED',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({ type: 'RUN_STARTED' }),
        },
        {
          type: 'TOOL_CALL_START',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TOOL_CALL_START',
            toolCallId: 'tool-1',
          }),
        },
        {
          type: 'TOOL_CALL_ARGS',
          agentId,
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TOOL_CALL_ARGS',
            toolCallId: 'tool-1',
            delta: '{"path":',
          }),
        },
      ]);

      const snapshot = await repo.getConversationSnapshot(
        conversation.id,
        agentId,
      );
      const replay = await repo.getFramesSince(
        agentId,
        snapshot.eventCursorSeq,
        { channels: ['run'] },
      );

      expect(snapshot.eventCursorSeq).toBe(seqs[0]! - 1);
      expect(snapshot.messages.map(({ id }) => id)).not.toContain(userMessage.id);
      expect(snapshot.messages.map(({ id }) => id))
        .not.toContain(assistantProjection.id);
      expect(replay.map(({ type }) => type)).toEqual([
        'RUN_STARTED',
        'TOOL_CALL_START',
        'TOOL_CALL_ARGS',
      ]);
    });

    it('omits later completed projections when an earlier open turn rewinds the cursor', async () => {
      const conversation = await repo.createConversation(agentId);
      const openUserMessage = await repo.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'user',
        content: 'long running prompt',
        createdAt: 1,
      });
      const openTurn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        userMessageId: openUserMessage.id,
        startedAt: 2,
      });
      const [openSeq] = await repo.saveEventBatch([{
        type: 'RUN_STARTED',
        agentId,
        turnId: openTurn.id,
        conversationId: conversation.id,
        channel: 'run',
        payload: JSON.stringify({
          type: 'RUN_STARTED',
          runId: openTurn.id,
          threadId: conversation.id,
          timestamp: 2,
        }),
      }]);

      const completedUserMessage = await repo.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'user',
        content: 'later prompt',
        createdAt: 3,
      });
      const completedTurn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        status: 'completed',
        userMessageId: completedUserMessage.id,
        startedAt: 4,
        completedAt: 6,
      });
      const completedAssistant = await repo.addMessage({
        agentId,
        conversationId: conversation.id,
        turnId: completedTurn.id,
        role: 'assistant',
        content: 'later answer',
        createdAt: 5,
      });
      await repo.saveEventBatch([
        {
          type: 'TEXT_MESSAGE_START',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_START',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedUserMessage.id,
            role: 'user',
            timestamp: 3,
          }),
        },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_CONTENT',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedUserMessage.id,
            delta: completedUserMessage.content,
            timestamp: 3,
          }),
        },
        {
          type: 'TEXT_MESSAGE_END',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_END',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedUserMessage.id,
            timestamp: 3,
          }),
        },
        {
          type: 'TEXT_MESSAGE_START',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_START',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedAssistant.id,
            role: 'assistant',
            timestamp: 5,
          }),
        },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_CONTENT',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedAssistant.id,
            delta: completedAssistant.content,
            timestamp: 5,
          }),
        },
        {
          type: 'TEXT_MESSAGE_END',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_END',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedAssistant.id,
            timestamp: 5,
          }),
        },
      ]);

      const snapshot = await repo.getConversationSnapshot(
        conversation.id,
        agentId,
      );

      expect(snapshot.eventCursorSeq).toBe(openSeq! - 1);
      expect(snapshot.messages.map(({ id }) => id)).not.toContain(openUserMessage.id);
      expect(snapshot.messages.map(({ id }) => id)).not.toContain(completedUserMessage.id);
      expect(snapshot.messages.map(({ id }) => id)).not.toContain(completedAssistant.id);

      const replay = await repo.getFramesSince(
        agentId,
        snapshot.eventCursorSeq,
        { channels: ['run'] },
      );
      let chatState = reduceCtxmillChatState(
        createInitialChatState(conversation.id),
        {
          type: 'load_messages',
          threadId: conversation.id,
          messages: snapshot.messages.map((message) => ({
            id: message.id,
            role: message.role as 'user' | 'assistant' | 'system' | 'tool',
            content: message.content,
            messageRevision: message.messageRevision,
          })),
        },
      );
      for (const frame of replay) {
        chatState = reduceCtxmillChatState(chatState, {
          type: 'stream_event',
          event: CanonicalStreamEventSchema.parse(JSON.parse(frame.payload)),
        });
      }
      expect(
        chatState.messages.filter(({ id }) => id === completedUserMessage.id),
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          content: completedUserMessage.content,
        }),
      ]);
      expect(
        chatState.messages.filter(({ id }) => id === completedAssistant.id),
      ).toEqual([
        expect.objectContaining({
          role: 'assistant',
          content: completedAssistant.content,
        }),
      ]);
    });

    it('transitively rewinds across a completed turn that overlaps the open-turn boundary', async () => {
      const conversation = await repo.createConversation(agentId);
      const completedUserMessage = await repo.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'user',
        content: 'overlapping completed prompt',
        createdAt: 1,
      });
      const completedTurn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        status: 'completed',
        userMessageId: completedUserMessage.id,
        startedAt: 2,
        completedAt: 8,
      });
      const completedAssistant = await repo.addMessage({
        agentId,
        conversationId: conversation.id,
        turnId: completedTurn.id,
        role: 'assistant',
        content: 'first second',
        createdAt: 7,
      });
      const [completedFirstSeq] = await repo.saveEventBatch([
        {
          type: 'TEXT_MESSAGE_START',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_START',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedUserMessage.id,
            role: 'user',
            timestamp: 1,
          }),
        },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_CONTENT',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedUserMessage.id,
            delta: completedUserMessage.content,
            timestamp: 1,
          }),
        },
        {
          type: 'TEXT_MESSAGE_END',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_END',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedUserMessage.id,
            timestamp: 1,
          }),
        },
        {
          type: 'TEXT_MESSAGE_START',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_START',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedAssistant.id,
            role: 'assistant',
            timestamp: 2,
          }),
        },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_CONTENT',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedAssistant.id,
            delta: 'first ',
            timestamp: 2,
          }),
        },
      ]);

      const openUserMessage = await repo.addMessage({
        conversationId: conversation.id,
        agentId,
        role: 'user',
        content: 'open prompt',
        createdAt: 3,
      });
      const openTurn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        userMessageId: openUserMessage.id,
        startedAt: 4,
      });
      await repo.saveEventBatch([{
        type: 'RUN_STARTED',
        agentId,
        turnId: openTurn.id,
        conversationId: conversation.id,
        channel: 'run',
        payload: JSON.stringify({
          type: 'RUN_STARTED',
          runId: openTurn.id,
          threadId: conversation.id,
          timestamp: 4,
        }),
      }]);
      await repo.saveEventBatch([
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_CONTENT',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedAssistant.id,
            delta: 'second',
            timestamp: 7,
          }),
        },
        {
          type: 'TEXT_MESSAGE_END',
          agentId,
          turnId: completedTurn.id,
          conversationId: conversation.id,
          channel: 'run',
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_END',
            runId: completedTurn.id,
            threadId: conversation.id,
            messageId: completedAssistant.id,
            timestamp: 7,
          }),
        },
      ]);

      const snapshot = await repo.getConversationSnapshot(
        conversation.id,
        agentId,
      );

      expect(snapshot.eventCursorSeq).toBe(completedFirstSeq! - 1);
      expect(snapshot.messages.map(({ id }) => id)).not.toContain(completedUserMessage.id);
      expect(snapshot.messages.map(({ id }) => id)).not.toContain(completedAssistant.id);
      expect(snapshot.messages.map(({ id }) => id)).not.toContain(openUserMessage.id);

      const replay = await repo.getFramesSince(
        agentId,
        snapshot.eventCursorSeq,
        { channels: ['run'] },
      );
      let chatState = reduceCtxmillChatState(
        createInitialChatState(conversation.id),
        {
          type: 'load_messages',
          threadId: conversation.id,
          messages: snapshot.messages.map((message) => ({
            id: message.id,
            role: message.role as 'user' | 'assistant' | 'system' | 'tool',
            content: message.content,
            messageRevision: message.messageRevision,
          })),
        },
      );
      for (const frame of replay) {
        chatState = reduceCtxmillChatState(chatState, {
          type: 'stream_event',
          event: CanonicalStreamEventSchema.parse(JSON.parse(frame.payload)),
        });
      }
      expect(
        chatState.messages.filter(({ id }) => id === completedUserMessage.id),
      ).toEqual([
        expect.objectContaining({
          role: 'user',
          content: completedUserMessage.content,
        }),
      ]);
      expect(
        chatState.messages.filter(({ id }) => id === completedAssistant.id),
      ).toEqual([
        expect.objectContaining({
          role: 'assistant',
          content: completedAssistant.content,
        }),
      ]);
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

  describe('Conversation summaries', () => {
    let agentId: string;

    beforeAll(async () => {
      const agent = await repo.createAgent({
        name: 'Summary Agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'Summary test prompt',
        tools: [],
      });
      agentId = agent.id;
    });

    it('reports completedAt when the latest turn finished successfully', async () => {
      const conv = await repo.createConversation(agentId);
      const startedAt = Date.now() - 60_000;
      const completedAt = startedAt + 4_300;
      await repo.createTurn({
        agentId,
        conversationId: conv.id,
        taskDescription: 'Short completed run',
        status: 'completed',
        startedAt,
        completedAt,
      });

      const summaries = await repo.getConversationSummaries(agentId);
      const summary = summaries.find((s) => s.id === conv.id);
      expect(summary).toBeDefined();
      expect(summary!.status).toBe('COMPLETED');
      expect(summary!.startedAt).toBe(startedAt);
      expect(summary!.completedAt).toBe(completedAt);
    });

    it('reports completedAt from the latest turn when it errored', async () => {
      const conv = await repo.createConversation(agentId);
      const firstStartedAt = Date.now() - 120_000;
      await repo.createTurn({
        agentId,
        conversationId: conv.id,
        status: 'completed',
        startedAt: firstStartedAt,
        completedAt: firstStartedAt + 1_000,
      });
      const secondStartedAt = firstStartedAt + 30_000;
      const secondCompletedAt = secondStartedAt + 2_500;
      await repo.createTurn({
        agentId,
        conversationId: conv.id,
        status: 'error',
        startedAt: secondStartedAt,
        completedAt: secondCompletedAt,
        error: 'boom',
      });

      const summaries = await repo.getConversationSummaries(agentId);
      const summary = summaries.find((s) => s.id === conv.id);
      expect(summary!.status).toBe('ERROR');
      expect(summary!.startedAt).toBe(firstStartedAt);
      expect(summary!.completedAt).toBe(secondCompletedAt);
    });

    it('leaves completedAt null while the latest turn is open', async () => {
      const conv = await repo.createConversation(agentId);
      await repo.createTurn({
        agentId,
        conversationId: conv.id,
        status: 'running',
        startedAt: Date.now(),
      });

      const summaries = await repo.getConversationSummaries(agentId);
      const summary = summaries.find((s) => s.id === conv.id);
      expect(summary!.completedAt).toBeNull();
    });

    it('rolls up known cost and incomplete-cost turn counts', async () => {
      const conv = await repo.createConversation(agentId);
      const startedAt = Date.now() - 60_000;
      await repo.createTurn({
        agentId,
        conversationId: conv.id,
        status: 'completed',
        startedAt,
        completedAt: startedAt + 1_000,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 0.01,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          modelCalls: { observed: 1, costKnown: 1, expected: 1 },
          cost: { totalUsd: 0.01, knownUsd: 0.01, coverage: 'complete' },
        },
      });
      await repo.createTurn({
        agentId,
        conversationId: conv.id,
        status: 'completed',
        startedAt: startedAt + 2_000,
        completedAt: startedAt + 3_000,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        gatewayMode: 'gateway_only',
      });
      await repo.createTurn({
        agentId,
        conversationId: conv.id,
        status: 'completed',
        startedAt: startedAt + 4_000,
        completedAt: startedAt + 5_000,
      });

      const summaries = await repo.getConversationSummaries(agentId);
      const summary = summaries.find((s) => s.id === conv.id);
      expect(summary!.knownCostUsd).toBeCloseTo(0.01, 6);
      expect(summary!.incompleteCostTurnCount).toBe(2);

      const bareConv = await repo.createConversation(agentId);
      await repo.createTurn({
        agentId,
        conversationId: bareConv.id,
        status: 'completed',
        startedAt: startedAt + 6_000,
        completedAt: startedAt + 7_000,
      });
      const bareSummary = (await repo.getConversationSummaries(agentId))
        .find((s) => s.id === bareConv.id);
      expect(bareSummary!.knownCostUsd).toBeNull();
      expect(bareSummary!.incompleteCostTurnCount).toBe(1);
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
    });

    beforeEach(async () => {
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
        runtimeDefinitionHash: 'runtime-definition-1',
      });

      expect(session.id).toBeDefined();
      expect(session.conversationId).toBe(conversationId);
      expect(session.agentId).toBe(agentId);
      expect(session.status).toBe('ACTIVE');
      expect(session.containerName).toBe('ctxmill-session-1');
      expect(session.runtimeDefinitionHash).toBe(
        'runtime-definition-1',
      );
    });

    it('rejects non-canonical and unowned RESTORING statuses at the repository boundary', async () => {
      await expect(repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'active' as SandboxSessionStatus,
      })).rejects.toThrow('Unsupported sandbox session status: active');
      await expect(repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'RESTORING',
      })).rejects.toThrow(
        'RESTORING sandbox sessions must be entered through claimSandboxSessionRestore',
      );
    });

    it('enforces canonical sandbox status values in PostgreSQL', async () => {
      await expect(testDb.conn.pgClient`
        INSERT INTO sandbox_sessions (
          id,
          conversation_id,
          agent_id,
          status,
          harness_name,
          created_at,
          updated_at,
          last_activity_at
        )
        VALUES (
          ${`invalid-status-${conversationId}`},
          ${conversationId},
          ${agentId},
          'active',
          'langgraph',
          ${Date.now()},
          ${Date.now()},
          ${Date.now()}
        )
      `).rejects.toMatchObject({ code: '23514' });
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

    it('should update sandbox session metadata without changing status', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'pi-agent',
      });

      await repo.updateSandboxSessionMetadata(created.id, 'ACTIVE', {
        containerName: 'checkpointed-container',
      }, activeGenerationOf(created));

      const fetched = await repo.getSandboxSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('ACTIVE');
      expect(fetched!.containerName).toBe('checkpointed-container');
    });

    it('should throw when updating missing sandbox session metadata', async () => {
      await expect(
        repo.updateSandboxSessionMetadata(
          'missing-session-id',
          'ACTIVE',
          {},
          { restoreFenceToken: 0, containerId: null },
        ),
      ).rejects.toMatchObject({
        name: 'SandboxSessionStatusConflictError',
      });
    });

    it('metadata updates reject a stale expected status without writing', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'pi-agent',
      });

      await expect(
        repo.updateSandboxSessionMetadata(
          created.id,
          'CHECKPOINTED',
          { containerName: 'stale-container' },
          undefined,
        ),
      ).rejects.toMatchObject({ name: 'SandboxSessionStatusConflictError' });

      const afterStaleWrite = await repo.getSandboxSession(created.id);
      expect(afterStaleWrite?.status).toBe('ACTIVE');
      expect(afterStaleWrite?.containerName).toBeNull();

      await expect(
        repo.updateSandboxSessionMetadata(
          created.id,
          'ACTIVE',
          { containerName: 'current-container' },
          activeGenerationOf(created),
        ),
      ).resolves.toBeUndefined();

      const afterCasWrite = await repo.getSandboxSession(created.id);
      expect(afterCasWrite?.status).toBe('ACTIVE');
      expect(afterCasWrite?.containerName).toBe('current-container');
    });

    it('ACTIVE metadata updates reject a stale restore generation or container binding', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'pi-agent',
        containerName: 'generation-one',
        containerId: 'container-generation-one',
      });

      await expect(repo.updateSandboxSessionMetadata(
        created.id,
        'ACTIVE',
        {
          containerName: 'generation-two',
          containerId: 'container-generation-two',
        },
        activeGenerationOf(created),
      )).resolves.toBeUndefined();

      await expect(repo.updateSandboxSessionMetadata(
        created.id,
        'ACTIVE',
        {
          containerName: 'stale-overwrite',
          containerId: 'container-stale',
        },
        activeGenerationOf(created),
      )).rejects.toMatchObject({ name: 'SandboxSessionStatusConflictError' });

      expect(await repo.getSandboxSession(created.id)).toMatchObject({
        status: 'ACTIVE',
        containerName: 'generation-two',
        containerId: 'container-generation-two',
      });
    });

    it('ACTIVE metadata updates cannot cross an admitted lifecycle operation', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'pi-agent',
        containerName: 'lifecycle-owned',
        containerId: 'container-lifecycle-owned',
      });
      const lifecycleOperation =
        await repo.claimSandboxSessionLifecycleOperation({
          sandboxSessionId: created.id,
          operation: 'reset',
          ownerId: 'lifecycle-owner',
          leaseDurationMs: 60_000,
          expectedActiveGeneration: activeGenerationOf(created),
        });
      expect(lifecycleOperation).toBeDefined();

      await expect(repo.updateSandboxSessionMetadata(
        created.id,
        'ACTIVE',
        {
          containerName: 'stale-startup-repair',
          containerId: 'container-stale-startup-repair',
        },
        activeGenerationOf(created),
      )).rejects.toMatchObject({ name: 'SandboxSessionStatusConflictError' });

      expect(await repo.getSandboxSession(created.id)).toMatchObject({
        status: 'ACTIVE',
        containerName: 'lifecycle-owned',
        containerId: 'container-lifecycle-owned',
      });
    });

    it('serializes ACTIVE metadata repair against lifecycle admission across replicas', async () => {
      const created = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'pi-agent',
        containerName: 'generation-one',
        containerId: 'container-generation-one',
      });
      const secondConnection = await createDatabase(resolveTestDatabaseUrl());
      const secondRepository = new DatabaseRepository(secondConnection.db);
      try {
        const [metadataUpdated, lifecycleOperation] = await Promise.all([
          repo.updateSandboxSessionMetadata(
            created.id,
            'ACTIVE',
            {
              containerName: 'generation-two',
              containerId: 'container-generation-two',
            },
            activeGenerationOf(created),
          ).then(
            () => true,
            (error: unknown) => {
              expect(error).toMatchObject({
                name: 'SandboxSessionStatusConflictError',
              });
              return false;
            },
          ),
          secondRepository.claimSandboxSessionLifecycleOperation({
            sandboxSessionId: created.id,
            operation: 'reset',
            ownerId: 'racing-lifecycle-owner',
            leaseDurationMs: 60_000,
            expectedActiveGeneration: activeGenerationOf(created),
          }),
        ]);

        expect(Number(metadataUpdated) + Number(lifecycleOperation !== undefined))
          .toBe(1);
        expect(await repo.getSandboxSession(created.id)).toMatchObject(
          metadataUpdated
            ? {
                containerName: 'generation-two',
                containerId: 'container-generation-two',
              }
            : {
                containerName: 'generation-one',
                containerId: 'container-generation-one',
              },
        );
      } finally {
        await secondConnection.close();
      }
    });

    it('should list active sandbox sessions', async () => {
      const active = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
      });
      const restoringConversation = await repo.createConversation(agentId);
      const restoring = await repo.createSandboxSession({
        conversationId: restoringConversation.id,
        agentId,
        harnessName: 'langgraph',
        status: 'CHECKPOINTED',
      });
      const restoringClaim = await repo.claimSandboxSessionRestore({
        sandboxSessionId: restoring.id,
        ownerId: 'active-list-restore-owner',
        leaseDurationMs: 60_000,
        maxAttempts: 3,
      });
      expect(restoringClaim?.status).toBe('RESTORING');
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

    it('admits exactly one live sandbox session per conversation across replicas', async () => {
      const secondConnection = await createDatabase(resolveTestDatabaseUrl());
      const secondRepository = new DatabaseRepository(secondConnection.db);
      try {
        const first = await repo.createSandboxSession({
          id: `live-session-a-${conversationId}`,
          conversationId,
          agentId,
          harnessName: 'langgraph',
          status: 'CHECKPOINTED',
        });
        const second = await secondRepository.createSandboxSession({
          id: `live-session-b-${conversationId}`,
          conversationId,
          agentId,
          harnessName: 'langgraph',
          status: 'CHECKPOINTED',
        });
        const sessions = await Promise.allSettled([
          repo.claimSandboxSessionRestore({
            sandboxSessionId: first.id,
            ownerId: 'restore-replica-a',
            leaseDurationMs: 60_000,
            maxAttempts: 3,
          }),
          secondRepository.claimSandboxSessionRestore({
            sandboxSessionId: second.id,
            ownerId: 'restore-replica-b',
            leaseDurationMs: 60_000,
            maxAttempts: 3,
          }),
        ]);

        expect(sessions.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(sessions.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        const liveRows = await testDb.conn.pgClient`
          SELECT id, status
          FROM sandbox_sessions
          WHERE conversation_id = ${conversationId}
            AND status IN ('ACTIVE', 'RESTORING')
        `;
        expect(liveRows).toHaveLength(1);
      } finally {
        await secondConnection.close();
      }
    });

    it('surfaces restore admission conflicts with the canonical live-session error', async () => {
      const first = await repo.createSandboxSession({
        id: `restore-session-a-${conversationId}`,
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'CHECKPOINTED',
      });
      const second = await repo.createSandboxSession({
        id: `restore-session-b-${conversationId}`,
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'CHECKPOINTED',
      });

      await repo.claimSandboxSessionRestore({
        sandboxSessionId: first.id,
        ownerId: 'restore-owner-a',
        leaseDurationMs: 60_000,
        maxAttempts: 3,
      });
      await expect(repo.claimSandboxSessionRestore({
        sandboxSessionId: second.id,
        ownerId: 'restore-owner-b',
        leaseDurationMs: 60_000,
        maxAttempts: 3,
      })).rejects.toMatchObject({
        name: 'LiveSandboxSessionConflictError',
        conversationId,
      });

      expect((await repo.getSandboxSession(first.id))?.status).toBe('RESTORING');
      expect((await repo.getSandboxSession(second.id))?.status).toBe('CHECKPOINTED');
    });

    it('fences restore generations across renewal, expiry, reconciliation, and ABA', async () => {
      const session = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'CHECKPOINTED',
      });
      await testDb.conn.pgClient`
        INSERT INTO agent_checkpoints (
          id,
          sandbox_session_id,
          agent_id,
          checkpoint_version,
          checkpoint_data,
          created_at
        )
        VALUES (
          ${`restore-checkpoint-${session.id}`},
          ${session.id},
          ${agentId},
          2,
          ${JSON.stringify({})}::jsonb,
          ${Date.now()}
        )
      `;

      const generationA = await repo.claimSandboxSessionRestore({
        sandboxSessionId: session.id,
        ownerId: 'restore-generation-a',
        leaseDurationMs: 60_000,
        maxAttempts: 3,
      });
      expect(generationA).toMatchObject({
        status: 'RESTORING',
        restoreOwnerId: 'restore-generation-a',
        restoreFenceToken: 1,
        restoreAttempts: 1,
      });
      expect(await repo.renewSandboxSessionRestoreLease(
        session.id,
        { ownerId: 'restore-generation-a', fenceToken: 2 },
        60_000,
      )).toBeUndefined();
      expect(await repo.renewSandboxSessionRestoreLease(
        session.id,
        {
          ownerId: 'restore-generation-a',
          fenceToken: generationA!.restoreFenceToken,
        },
        60_000,
      )).toMatchObject({
        restoreFenceToken: generationA!.restoreFenceToken,
      });
      await expect(repo.updateSandboxSessionMetadata(
        session.id,
        'TERMINATED',
        {},
        undefined,
      )).rejects.toMatchObject({
        name: 'SandboxSessionStatusConflictError',
      });
      await expect(repo.updateSandboxSessionMetadata(
        session.id,
        'RESTORING',
        {},
        undefined,
      )).rejects.toThrow(/restore-fenced method/);

      await testDb.conn.pgClient`
        UPDATE sandbox_sessions
        SET restore_lease_expires_at =
          floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1
        WHERE id = ${session.id}
      `;
      const [expiredGeneration] = (
        await repo.getExpiredSandboxSessionRestores()
      ).filter((row) => row.id === session.id);
      expect(expiredGeneration).toMatchObject({
        id: session.id,
        restoreFenceToken: generationA!.restoreFenceToken,
      });
      const reconciled = await repo.reconcileExpiredSandboxSessionRestore(
        session.id,
        generationA!.restoreFenceToken,
      );
      expect(reconciled).toMatchObject({
        outcome: 'CHECKPOINTED',
        session: {
          status: 'CHECKPOINTED',
          restoreFenceToken: generationA!.restoreFenceToken + 1,
          restoreOwnerId: null,
          restoreLeaseExpiresAt: null,
        },
      });

      const generationB = await repo.claimSandboxSessionRestore({
        sandboxSessionId: session.id,
        ownerId: 'restore-generation-b',
        leaseDurationMs: 60_000,
        maxAttempts: 3,
      });
      expect(generationB).toMatchObject({
        status: 'RESTORING',
        restoreOwnerId: 'restore-generation-b',
        restoreFenceToken: generationA!.restoreFenceToken + 2,
        restoreAttempts: 2,
      });
      expect(await repo.completeSandboxSessionRestore(
        session.id,
        {
          ownerId: 'restore-generation-a',
          fenceToken: generationA!.restoreFenceToken,
        },
        {
          containerName: 'stale-container',
          containerId: 'stale-container',
        },
      )).toBeUndefined();
      expect(await repo.failSandboxSessionRestore(
        session.id,
        {
          ownerId: 'restore-generation-a',
          fenceToken: generationA!.restoreFenceToken,
        },
        {
          toStatus: 'TERMINATED',
          error: 'stale generation failure',
        },
      )).toBeUndefined();
      expect(await repo.getSandboxSession(session.id)).toMatchObject({
        status: 'RESTORING',
        restoreOwnerId: 'restore-generation-b',
        restoreFenceToken: generationB!.restoreFenceToken,
      });

      expect(await repo.completeSandboxSessionRestore(
        session.id,
        {
          ownerId: 'restore-generation-b',
          fenceToken: generationB!.restoreFenceToken,
        },
        {
          containerName: 'live-container',
          containerId: 'live-container-id',
        },
      )).toMatchObject({
        status: 'ACTIVE',
        containerName: 'live-container',
        containerId: 'live-container-id',
        restoreAttempts: 0,
        restoreOwnerId: null,
        restoreLeaseExpiresAt: null,
      });
    });

    it('records failure only for the current restore generation', async () => {
      const session = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'CHECKPOINTED',
      });
      const restore = await repo.claimSandboxSessionRestore({
        sandboxSessionId: session.id,
        ownerId: 'restore-failure-owner',
        leaseDurationMs: 60_000,
        maxAttempts: 3,
      });
      expect(await repo.failSandboxSessionRestore(
        session.id,
        {
          ownerId: restore!.restoreOwnerId!,
          fenceToken: restore!.restoreFenceToken,
        },
        {
          toStatus: 'CHECKPOINTED',
          error: 'retryable restore failure',
        },
      )).toMatchObject({
        status: 'CHECKPOINTED',
        restoreAttempts: 1,
        lastRestoreError: 'retryable restore failure',
        restoreOwnerId: null,
        restoreLeaseExpiresAt: null,
      });
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
    let lifecycleFence: { ownerId: string; fenceToken: number };

    async function beginCheckpointOperation(
      sandboxSessionId: string,
    ): Promise<{ ownerId: string; fenceToken: number }> {
      const operation = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId,
        operation: 'checkpoint',
        ownerId: `checkpoint-owner-${sandboxSessionId}`,
        leaseDurationMs: 600_000,
        expectedActiveGeneration:
          await currentActiveGeneration(sandboxSessionId),
      });
      if (!operation) {
        throw new Error(`Failed to claim checkpoint lifecycle for ${sandboxSessionId}`);
      }
      const executing = await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSessionId,
        operation.ownerId,
        operation.fenceToken,
      );
      if (!executing) {
        throw new Error(`Failed to execute checkpoint lifecycle for ${sandboxSessionId}`);
      }
      return {
        ownerId: operation.ownerId,
        fenceToken: operation.fenceToken,
      };
    }

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
      lifecycleFence = await beginCheckpointOperation(sessionId);
    });

    it('should create a v2 checkpoint', async () => {
      const result = await repo.createCheckpointV2({
        sandboxSessionId: sessionId,
        agentId,
        checkpointData: { cursor: 1, status: 'idle' },
        harnessState: { messages: [] },
        workspaceRef: 'workspace-ref-1',
        suspendReason: 'manual_suspend',
      }, lifecycleFence);

      expect(result?.id).toBeDefined();
    });

    it('should fetch the latest v2 checkpoint for a session', async () => {
      await repo.createCheckpointV2({
        sandboxSessionId: sessionId,
        agentId,
        checkpointData: { cursor: 10 },
      }, lifecycleFence);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await repo.createCheckpointV2({
        sandboxSessionId: sessionId,
        agentId,
        checkpointData: { cursor: 11 },
      }, lifecycleFence);

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
        sandboxSessionId: sessionId,
        agentId,
        checkpointData,
        harnessState,
      }, lifecycleFence);

      const checkpoint = await repo.getCheckpointV2(sessionId);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.checkpointData).toEqual(checkpointData);
      expect(checkpoint!.harnessState).toEqual(harnessState);
    });

    it('coerces checkpoint BigInt values before JSONB persistence', async () => {
      await repo.createCheckpointV2({
        sandboxSessionId: sessionId,
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
      }, lifecycleFence);

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
      const deleteTestFence = await beginCheckpointOperation(session.id);

      await repo.createCheckpointV2({
        sandboxSessionId: session.id,
        agentId,
        checkpointData: { step: 1 },
      }, deleteTestFence);
      await repo.createCheckpointV2({
        sandboxSessionId: session.id,
        agentId,
        checkpointData: { step: 2 },
      }, deleteTestFence);

      const deleted = await repo.deleteCheckpointsForSandboxSession(session.id);
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
      const turn = await repo.createTurnWithSecretEnvelope({
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        conversationId: conversation.id,
        mode: 'interactive',
      }, {
        iv: 'test-turn-iv',
        ciphertext: 'test-turn-ciphertext',
        authTag: 'test-turn-auth-tag',
      });
      return { agent, conversation, sandboxSession, turn };
    }

    async function snapshotDeliveryCapabilityState(
      turnId: string,
      sandboxSessionId: string,
    ) {
      const [lease] = await testDb.conn.pgClient`
        SELECT turn_id, owner_id, fence_token, lease_expires_at, updated_at
        FROM turn_delivery_leases
        WHERE turn_id = ${turnId}
      `;
      return {
        turn: await repo.getTurn(turnId),
        sandboxSession: await repo.getSandboxSession(sandboxSessionId),
        lease,
      };
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

    it('persists schedule CRUD, firing timestamps, and unique names', async () => {
      const agent = await repo.createAgent({
        name: 'Schedule Repository Agent',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-5.4-mini' }),
        systemPrompt: 'Schedule persistence test',
        tools: [],
      });
      const created = await repo.createSchedule({
        agentId: agent.id,
        name: 'repository-weekly-canary',
        cronExpression: '0 9 * * 1',
        timezone: 'UTC',
        eventType: 'custom.schedule.repository-weekly-canary',
        payload: { source: 'repository-test' },
        enabled: true,
      });

      expect(await repo.getSchedule(created.id)).toMatchObject({
        agentId: agent.id,
        name: 'repository-weekly-canary',
        lastFiredAt: null,
      });
      expect(await repo.listSchedules()).toContainEqual(created);

      const global = await repo.createSchedule({
        name: 'repository-global-clock',
        cronExpression: '0 * * * *',
        timezone: 'UTC',
        eventType: 'custom.schedule.repository-global-clock',
        payload: {},
        enabled: true,
      });
      expect(global.agentId).toBeNull();

      await expect(repo.createSchedule({
        agentId: agent.id,
        name: 'repository-weekly-canary',
        cronExpression: '0 10 * * 1',
        timezone: 'UTC',
        eventType: 'custom.schedule.duplicate',
        payload: {},
        enabled: true,
      })).rejects.toSatisfy((error: unknown) => (
        isUniqueConstraintViolation(error, 'idx_schedules_name')
      ));

      const updated = await repo.updateSchedule(created.id, {
        enabled: false,
        payload: { source: 'updated' },
      });
      expect(updated).toMatchObject({
        enabled: false,
        payload: { source: 'updated' },
      });

      await repo.markScheduleFired(created.id, 1234);
      expect(await repo.getSchedule(created.id)).toMatchObject({ lastFiredAt: 1234 });
      await expect(repo.deleteSchedule(created.id)).resolves.toBe(true);
      await expect(repo.deleteSchedule(global.id)).resolves.toBe(true);
      await expect(repo.getSchedule(created.id)).resolves.toBeUndefined();
    });

    it('atomically claims due callbacks and only the active claim can complete', async () => {
      const { agent, turn } = await createRuntimeTurn('Callback Claim');
      const now = Date.now();
      await repo.enqueueCallback({
        id: 'callback-claim-1',
        agentId: agent.id,
        turnId: turn.id,
        callbackUrl: 'https://example.test/hook',
        eventType: 'turn.completed',
        payload: { ok: true },
        status: 'pending',
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: now - 1,
        createdAt: now,
      });

      const firstClaim = await repo.claimPendingCallbacks(10, now);
      expect(firstClaim.map((callback) => callback.id)).toEqual(['callback-claim-1']);
      expect(firstClaim[0].status).toBe('in_progress');
      const staleClaimedAt = firstClaim[0].claimedAt;

      const secondClaim = await repo.claimPendingCallbacks(10, now + 1);
      expect(secondClaim).toEqual([]);

      await testDb.conn.pgClient`
        UPDATE callback_outbox
        SET claim_expires_at = ${now - 10_000}
        WHERE id = 'callback-claim-1'
      `;
      const reclaimed = await repo.claimPendingCallbacks(10, now + 2);
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
        turnId: turn.id,
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
        turnId: turn.id,
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
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
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
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
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
      await repo.resolveInterrupt('interrupt-cas-1', 'reject');
    });

    it('lists durable interrupts newest-first with cross-agent filters and cursor pagination', async () => {
      const first = await createRuntimeTurn('Interrupt List First');
      const second = await createRuntimeTurn('Interrupt List Second');
      const base = Date.now();

      await repo.savePendingInterrupt({
        id: 'interrupt-list-old',
        turnId: first.turn.id,
        agentId: first.agent.id,
        sandboxSessionId: first.sandboxSession.id,
        toolCallId: 'tool-call-old',
        toolName: 'request-approval',
        args: { order: 1 },
        timeoutMs: 60_000,
        createdAt: base,
        expiresAt: base + 60_000,
      });
      await repo.savePendingInterrupt({
        id: 'interrupt-list-new',
        turnId: second.turn.id,
        agentId: second.agent.id,
        sandboxSessionId: second.sandboxSession.id,
        toolCallId: 'tool-call-new',
        toolName: 'request-approval',
        args: { order: 2 },
        timeoutMs: 60_000,
        createdAt: base + 2,
        expiresAt: base + 60_002,
      });
      await repo.savePendingInterrupt({
        id: 'interrupt-list-middle',
        turnId: first.turn.id,
        agentId: first.agent.id,
        sandboxSessionId: first.sandboxSession.id,
        toolCallId: 'tool-call-middle',
        toolName: 'request-approval',
        args: { order: 1.5 },
        timeoutMs: 60_000,
        createdAt: base + 1,
        expiresAt: base + 60_001,
      });
      await repo.markInterruptTimedOut('interrupt-list-middle', 'Approval expired');
      await repo.resolveInterrupt('interrupt-list-old', 'approve');

      const actionable = await repo.listInterrupts({ status: 'pending' });
      expect(actionable.interrupts.map((row) => row.id)).toEqual([
        'interrupt-list-new',
        'interrupt-list-middle',
      ]);

      const firstAgent = await repo.listInterrupts({
        status: 'all',
        agentId: first.agent.id,
        before: base + 2,
        limit: 1,
      });
      expect(firstAgent.interrupts.map((row) => row.id)).toEqual(['interrupt-list-middle']);
      expect(firstAgent.hasMore).toBe(true);

      const resolved = await repo.listInterrupts({ status: 'resolved' });
      expect(resolved.interrupts.map((row) => row.id)).toContain('interrupt-list-old');
    });

    it('tracks timed-out interrupts and durable resume attempts', async () => {
      const { agent, sandboxSession, turn } = await createRuntimeTurn('Interrupt Resume Attempt');
      const now = Date.now();
      await repo.savePendingInterrupt({
        id: 'interrupt-resume-1',
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
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

      const resolved = await repo.resolveInterruptWithResumeAttempt(
        'interrupt-resume-1',
        'approve',
        { ok: true },
      );
      expect(resolved?.kind).toBe('ready');
      expect(resolved?.interrupt.status).toBe('resolved');
      const attempt = resolved?.kind === 'ready' ? resolved.resumeAttempt : undefined;
      expect(attempt).toBeDefined();
      expect(attempt!.status).toBe('pending');

      const failed = await repo.failUnclaimedInterruptResumeAttempt(
        attempt!.id,
        'restore failed',
      );
      expect(failed?.status).toBe('failed');
      expect(failed?.lastError).toBe('restore failed');

      const actionable = await repo.getActionableInterruptsForAgent(agent.id);
      expect(actionable).toHaveLength(1);
      expect(actionable[0].interrupt.id).toBe('interrupt-resume-1');
      expect(actionable[0].resumeAttempt?.status).toBe('failed');

      const retried = await repo.retryFailedInterruptResumeAttempt(failed!.id);
      expect(retried).toMatchObject({
        status: 'pending',
        lastError: null,
      });
    });

    it('atomically leases turn delivery and permits takeover only after expiry', async () => {
      const { turn } = await createRuntimeTurn('Turn Delivery Lease');
      const secondConnection = await createDatabase(resolveTestDatabaseUrl());
      const secondRepository = new DatabaseRepository(secondConnection.db);
      try {
        const claims = await Promise.all([
          repo.claimTurnDeliveryLease({
            turnId: turn.id,
            ownerId: 'reconciler-a',
            leaseDurationMs: 60_000,
          }),
          secondRepository.claimTurnDeliveryLease({
            turnId: turn.id,
            ownerId: 'reconciler-b',
            leaseDurationMs: 60_000,
          }),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const winner = claims.find((claim) => claim !== undefined)!;
        const takeoverOwner = winner.ownerId === 'reconciler-a'
          ? 'reconciler-b'
          : 'reconciler-a';

        expect(await repo.claimTurnDeliveryLease({
          turnId: turn.id,
          ownerId: takeoverOwner,
          leaseDurationMs: 60_000,
        })).toBeUndefined();

        await expireTurnDeliveryLease(turn.id);
        const takeover = await repo.claimTurnDeliveryLease({
          turnId: turn.id,
          ownerId: takeoverOwner,
          leaseDurationMs: 60_000,
        });
        expect(takeover).toMatchObject({
          turnId: turn.id,
          ownerId: takeoverOwner,
        });
        expect(takeover!.leaseExpiresAt).toBeGreaterThan(Date.now());
        expect(await repo.renewTurnDeliveryLease(
          turn.id,
          takeoverOwner,
          takeover!.fenceToken - 1,
          60_000,
        )).toBeUndefined();
        expect(await repo.renewTurnDeliveryLease(
          turn.id,
          takeoverOwner,
          takeover!.fenceToken,
          60_000,
        )).toMatchObject({
          fenceToken: takeover!.fenceToken,
        });
        expect(await repo.releaseTurnDeliveryLease(
          turn.id,
          winner.ownerId,
          winner.fenceToken,
        )).toBe(false);
        expect(await repo.releaseTurnDeliveryLease(
          turn.id,
          takeoverOwner,
          takeover!.fenceToken - 1,
        )).toBe(false);
        expect(await repo.releaseTurnDeliveryLease(
          turn.id,
          takeoverOwner,
          takeover!.fenceToken,
        )).toBe(true);
        const reclaimed = await repo.claimTurnDeliveryLease({
          turnId: turn.id,
          ownerId: takeoverOwner,
          leaseDurationMs: 60_000,
        });
        expect(reclaimed?.fenceToken).toBe(takeover!.fenceToken + 1);
      } finally {
        await secondConnection.close();
      }
    });

    it('uses the database clock for takeover even when replica clocks are skewed', async () => {
      const { turn } = await createRuntimeTurn('Database-clock Delivery Lease');
      const processClock = vi.spyOn(Date, 'now');
      try {
        processClock.mockReturnValue(Number.MAX_SAFE_INTEGER - 1);
        const first = await repo.claimTurnDeliveryLease({
          turnId: turn.id,
          ownerId: 'clock-skew-a',
          leaseDurationMs: 60_000,
        });
        expect(first?.fenceToken).toBe(1);

        expect(await repo.claimTurnDeliveryLease({
          turnId: turn.id,
          ownerId: 'clock-skew-b',
          leaseDurationMs: 60_000,
        })).toBeUndefined();

        await expireTurnDeliveryLease(turn.id);
        processClock.mockReturnValue(0);
        expect(await repo.claimTurnDeliveryLease({
          turnId: turn.id,
          ownerId: 'clock-skew-b',
          leaseDurationMs: 60_000,
        })).toMatchObject({
          ownerId: 'clock-skew-b',
          fenceToken: 2,
        });
      } finally {
        processClock.mockRestore();
      }
    });

    it('admits exactly one open running turn per sandbox session across replicas', async () => {
      const {
        agent,
        conversation,
        sandboxSession,
        turn: firstTurn,
      } = await createRuntimeTurn('Single Sandbox Stream');
      const secondTurn = await repo.createTurn({
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        conversationId: conversation.id,
        mode: 'interactive',
      });
      const firstLease = await repo.claimTurnDeliveryLease({
        turnId: firstTurn.id,
        ownerId: 'single-stream-owner-a',
        leaseDurationMs: 60_000,
      });
      const secondLease = await repo.claimTurnDeliveryLease({
        turnId: secondTurn.id,
        ownerId: 'single-stream-owner-b',
        leaseDurationMs: 60_000,
      });
      expect(firstLease).toBeDefined();
      expect(secondLease).toBeDefined();

      const secondConnection = await createDatabase(resolveTestDatabaseUrl());
      const secondRepository = new DatabaseRepository(secondConnection.db);
      try {
        const activations = await Promise.all([
          repo.activateTurnDelivery({
            turnId: firstTurn.id,
            sandboxSessionId: sandboxSession.id,
            ownerId: firstLease!.ownerId,
            fenceToken: firstLease!.fenceToken,
            expectedActiveGeneration: activeGenerationOf(sandboxSession),
          }),
          secondRepository.activateTurnDelivery({
            turnId: secondTurn.id,
            sandboxSessionId: sandboxSession.id,
            ownerId: secondLease!.ownerId,
            fenceToken: secondLease!.fenceToken,
            expectedActiveGeneration: activeGenerationOf(sandboxSession),
          }),
        ]);
        expect(activations.filter(Boolean)).toHaveLength(1);

        const first = await repo.getTurn(firstTurn.id);
        const second = await repo.getTurn(secondTurn.id);
        expect([first?.status, second?.status].sort()).toEqual([
          'queued',
          'running',
        ]);

        const runningTurn = first?.status === 'running' ? firstTurn : secondTurn;
        const queuedTurn = first?.status === 'queued' ? firstTurn : secondTurn;
        const queuedLease = queuedTurn.id === firstTurn.id
          ? firstLease!
          : secondLease!;
        await expireTurnDeliveryLease(runningTurn.id);
        expect(await secondRepository.activateTurnDelivery({
          turnId: queuedTurn.id,
          sandboxSessionId: sandboxSession.id,
          ownerId: queuedLease.ownerId,
          fenceToken: queuedLease.fenceToken,
          expectedActiveGeneration: activeGenerationOf(sandboxSession),
        })).toBe(false);
      } finally {
        await secondConnection.close();
      }
    });

    it('serializes turn activation against lifecycle reservation across replicas', async () => {
      const {
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Activation Lifecycle Race');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'activation-owner',
        leaseDurationMs: 60_000,
      });
      expect(delivery).toBeDefined();

      const secondConnection = await createDatabase(resolveTestDatabaseUrl());
      const secondRepository = new DatabaseRepository(secondConnection.db);
      try {
        const [activated, lifecycleOperation] = await Promise.all([
          repo.activateTurnDelivery({
            turnId: turn.id,
            sandboxSessionId: sandboxSession.id,
            ownerId: delivery!.ownerId,
            fenceToken: delivery!.fenceToken,
            expectedActiveGeneration: activeGenerationOf(sandboxSession),
          }),
          secondRepository.claimSandboxSessionLifecycleOperation({
            sandboxSessionId: sandboxSession.id,
            operation: 'reset',
            ownerId: 'lifecycle-owner',
            leaseDurationMs: 60_000,
            expectedActiveGeneration: activeGenerationOf(sandboxSession),
          }),
        ]);
        expect(Number(activated) + Number(lifecycleOperation !== undefined)).toBe(1);
        expect(await repo.getTurn(turn.id)).toMatchObject({
          status: activated ? 'running' : 'queued',
        });
        if (lifecycleOperation) {
          expect(lifecycleOperation).toMatchObject({
            operation: 'reset',
            phase: 'reserved',
          });
        }
      } finally {
        await secondConnection.close();
      }
    });

    it('rejects turn activation from a stale cached ACTIVE generation', async () => {
      const {
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Stale Active Generation Delivery');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'stale-generation-owner',
        leaseDurationMs: 60_000,
      });
      expect(delivery).toBeDefined();

      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: {
          restoreFenceToken: sandboxSession.restoreFenceToken + 1,
          containerId: sandboxSession.containerId,
        },
      })).toBe(false);
      expect(await repo.getTurn(turn.id)).toMatchObject({ status: 'queued' });

      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);
    });

    it('holds startup adoption as a non-destructive turn and lifecycle barrier', async () => {
      const {
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Startup Adoption Barrier');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'blocked-by-adoption',
        leaseDurationMs: 60_000,
      });
      expect(delivery).toBeDefined();
      const adoption = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'adopt',
        ownerId: 'startup-adoption-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      });
      expect(adoption).toMatchObject({
        operation: 'adopt',
        phase: 'reserved',
      });
      expect(await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSession.id,
        adoption!.ownerId,
        adoption!.fenceToken,
      )).toBe(false);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(false);
      expect(await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'blocked-reset-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBeUndefined();

      expect(await repo.cancelSandboxSessionLifecycleOperation(
        sandboxSession.id,
        adoption!.ownerId,
        adoption!.fenceToken,
      )).toBe(true);
      expect(await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'admitted-reset-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toMatchObject({ operation: 'reset' });
    });

    it('rejects lifecycle admission from a stale ACTIVE restore generation', async () => {
      const agent = await repo.createAgent({
        name: 'Lifecycle Active Generation Agent',
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
        status: 'CHECKPOINTED',
      });
      const restore = await repo.claimSandboxSessionRestore({
        sandboxSessionId: sandboxSession.id,
        ownerId: 'active-generation-restore',
        leaseDurationMs: 60_000,
        maxAttempts: 3,
      });
      expect(restore).toBeDefined();
      const active = await repo.completeSandboxSessionRestore(
        sandboxSession.id,
        {
          ownerId: restore!.restoreOwnerId!,
          fenceToken: restore!.restoreFenceToken,
        },
        {
          containerName: 'active-generation-container',
          containerId: 'container-generation-2',
        },
      );
      expect(active).toMatchObject({
        status: 'ACTIVE',
        containerId: 'container-generation-2',
        restoreFenceToken: restore!.restoreFenceToken,
      });

      const staleClaim = {
        sandboxSessionId: sandboxSession.id,
        operation: 'reset' as const,
        ownerId: 'stale-active-generation-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: {
          restoreFenceToken: 0,
          containerId: active!.containerId,
        },
      };
      expect(
        await repo.claimSandboxSessionLifecycleOperation(staleClaim),
      ).toBeUndefined();
      expect(
        await repo.hasUnfinishedSandboxSessionLifecycleOperation(
          sandboxSession.id,
        ),
      ).toBe(false);

      const wrongContainerClaim = {
        ...staleClaim,
        ownerId: 'wrong-container-generation-owner',
        expectedActiveGeneration: {
          restoreFenceToken: active!.restoreFenceToken,
          containerId: 'container-generation-1',
        },
      };
      expect(
        await repo.claimSandboxSessionLifecycleOperation(wrongContainerClaim),
      ).toBeUndefined();
      expect(
        await repo.hasUnfinishedSandboxSessionLifecycleOperation(
          sandboxSession.id,
        ),
      ).toBe(false);

      const currentClaim = {
        ...staleClaim,
        ownerId: 'current-active-generation-owner',
        expectedActiveGeneration: {
          restoreFenceToken: active!.restoreFenceToken,
          containerId: active!.containerId,
        },
      };
      expect(
        await repo.claimSandboxSessionLifecycleOperation(currentClaim),
      ).toMatchObject({
        operation: 'reset',
        ownerId: 'current-active-generation-owner',
      });
    });

    it('matches an explicitly null ACTIVE container binding', async () => {
      const { sandboxSession } = await createRuntimeTurn(
        'Lifecycle Null Active Container',
      );
      expect(sandboxSession).toMatchObject({
        status: 'ACTIVE',
        containerId: null,
        restoreFenceToken: 0,
      });
      const claim = {
        sandboxSessionId: sandboxSession.id,
        operation: 'checkpoint' as const,
        ownerId: 'null-container-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: {
          restoreFenceToken: sandboxSession.restoreFenceToken,
          containerId: null,
        },
      };

      expect(await repo.claimSandboxSessionLifecycleOperation({
        ...claim,
        ownerId: 'non-null-container-owner',
        expectedActiveGeneration: {
          restoreFenceToken: sandboxSession.restoreFenceToken,
          containerId: 'unexpected-container',
        },
      })).toBeUndefined();
      expect(
        await repo.claimSandboxSessionLifecycleOperation(claim),
      ).toMatchObject({
        operation: 'checkpoint',
        ownerId: 'null-container-owner',
      });
    });

    it('does not mutate an expired lifecycle intent for a stale ACTIVE generation takeover', async () => {
      const agent = await repo.createAgent({
        name: 'Lifecycle Generation Takeover Agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'Persistence test prompt',
        tools: [],
      });
      const conversation = await repo.createConversation(agent.id);
      const sandboxSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId: agent.id,
        containerName: 'generation-takeover-a',
        containerId: 'container-takeover-a',
        harnessName: 'claude-agents',
      });
      const generationA = {
        restoreFenceToken: sandboxSession.restoreFenceToken,
        containerId: sandboxSession.containerId,
      };
      const firstClaim = {
        sandboxSessionId: sandboxSession.id,
        operation: 'reset' as const,
        ownerId: 'generation-takeover-owner-a',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: generationA,
      };
      const firstOperation =
        await repo.claimSandboxSessionLifecycleOperation(firstClaim);
      expect(firstOperation).toBeDefined();
      await expireSandboxSessionLifecycleOperation(sandboxSession.id);
      await testDb.conn.pgClient`
        UPDATE sandbox_sessions
        SET
          container_name = 'generation-takeover-b',
          container_id = 'container-takeover-b',
          restore_fence_token = restore_fence_token + 1
        WHERE id = ${sandboxSession.id}
      `;

      expect(await repo.claimSandboxSessionLifecycleOperation({
        ...firstClaim,
        ownerId: 'stale-generation-takeover-owner',
      })).toBeUndefined();
      const afterStaleClaim = (
        await repo.getRecoverableSandboxSessionLifecycleOperations()
      ).find((candidate) =>
        candidate.sandboxSessionId === sandboxSession.id
      );
      expect(afterStaleClaim).toMatchObject({
        operationId: firstOperation!.operationId,
        ownerId: firstOperation!.ownerId,
        fenceToken: firstOperation!.fenceToken,
      });

      expect(await repo.claimSandboxSessionLifecycleOperation({
        ...firstClaim,
        ownerId: 'current-generation-takeover-owner',
        expectedActiveGeneration: {
          restoreFenceToken: generationA.restoreFenceToken + 1,
          containerId: 'container-takeover-b',
        },
      })).toMatchObject({
        operationId: firstOperation!.operationId,
        ownerId: 'current-generation-takeover-owner',
        fenceToken: firstOperation!.fenceToken + 1,
      });
    });

    it('keeps unfinished sandbox lifecycle intent as an activation barrier after lease expiry', async () => {
      const {
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Lifecycle Intent Activation Barrier');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'delivery-owner',
        leaseDurationMs: 60_000,
      });
      expect(
        await repo.hasUnfinishedSandboxSessionLifecycleOperation(
          sandboxSession.id,
        ),
      ).toBe(false);
      const firstOperation = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'checkpoint',
        ownerId: 'lifecycle-owner-a',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      });
      expect(firstOperation).toMatchObject({
        sandboxSessionId: sandboxSession.id,
        operation: 'checkpoint',
        phase: 'reserved',
        ownerId: 'lifecycle-owner-a',
        fenceToken: 1,
      });
      expect(
        await repo.hasUnfinishedSandboxSessionLifecycleOperation(
          sandboxSession.id,
        ),
      ).toBe(true);
      expect(await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSession.id,
        firstOperation!.ownerId,
        firstOperation!.fenceToken,
      )).toBe(true);

      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(false);

      await expireSandboxSessionLifecycleOperation(sandboxSession.id);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(false);

      const takeover = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'checkpoint',
        ownerId: 'lifecycle-owner-b',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      });
      expect(takeover).toMatchObject({
        ownerId: 'lifecycle-owner-b',
        fenceToken: 2,
        phase: 'executing',
      });
      expect(await repo.completeSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        ownerId: firstOperation!.ownerId,
        fenceToken: firstOperation!.fenceToken,
        fromStatus: 'ACTIVE',
        toStatus: 'CHECKPOINTED',
      })).toBe(false);
      expect(await repo.completeSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        ownerId: takeover!.ownerId,
        fenceToken: takeover!.fenceToken,
        fromStatus: 'ACTIVE',
        toStatus: 'CHECKPOINTED',
      })).toBe(true);
      expect(await repo.getSandboxSession(sandboxSession.id)).toMatchObject({
        status: 'CHECKPOINTED',
      });
      expect(
        await repo.hasUnfinishedSandboxSessionLifecycleOperation(
          sandboxSession.id,
        ),
      ).toBe(false);
    });

    it('does not mutate an expired lifecycle intent when takeover requests a different operation', async () => {
      const { sandboxSession } = await createRuntimeTurn(
        'Lifecycle Intent Operation Mismatch',
      );
      const checkpoint = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'checkpoint',
        ownerId: 'checkpoint-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      });
      expect(checkpoint).toBeDefined();

      await expireSandboxSessionLifecycleOperation(sandboxSession.id);
      const before = (
        await repo.getRecoverableSandboxSessionLifecycleOperations()
      ).find((operation) =>
        operation.sandboxSessionId === sandboxSession.id
      );
      expect(before).toMatchObject({
        operation: 'checkpoint',
        phase: 'reserved',
        ownerId: 'checkpoint-owner',
        fenceToken: checkpoint!.fenceToken,
      });

      expect(await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'reset-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBeUndefined();

      const after = (
        await repo.getRecoverableSandboxSessionLifecycleOperations()
      ).find((operation) =>
        operation.sandboxSessionId === sandboxSession.id
      );
      expect(after).toEqual(before);
    });

    it('persists checkpoints only for the current executing lifecycle owner', async () => {
      const {
        agent,
        sandboxSession,
      } = await createRuntimeTurn('Lifecycle-owned Checkpoint');
      const firstOperation = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'checkpoint',
        ownerId: 'checkpoint-owner-a',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      });
      expect(firstOperation).toBeDefined();
      expect(await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSession.id,
        firstOperation!.ownerId,
        firstOperation!.fenceToken,
      )).toBe(true);

      expect(await repo.createCheckpointV2({
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        checkpointData: { generation: 1 },
      }, {
        ownerId: firstOperation!.ownerId,
        fenceToken: firstOperation!.fenceToken,
      })).toBeDefined();

      await expireSandboxSessionLifecycleOperation(sandboxSession.id);
      const takeover = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'checkpoint',
        ownerId: 'checkpoint-owner-b',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      });
      expect(takeover).toMatchObject({
        operationId: firstOperation!.operationId,
        phase: 'executing',
        ownerId: 'checkpoint-owner-b',
        fenceToken: firstOperation!.fenceToken + 1,
      });
      expect(await repo.getCheckpointV2ForLifecycleOperation(
        sandboxSession.id,
        takeover!.operationId,
      )).toMatchObject({
        checkpointData: { generation: 1 },
        lifecycleOwnerId: firstOperation!.ownerId,
      });

      expect(await repo.createCheckpointV2({
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        checkpointData: { generation: 'stale' },
      }, {
        ownerId: firstOperation!.ownerId,
        fenceToken: firstOperation!.fenceToken,
      })).toBeUndefined();
      expect(await repo.createCheckpointV2({
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        checkpointData: { generation: 2 },
      }, {
        ownerId: takeover!.ownerId,
        fenceToken: takeover!.fenceToken,
      })).toBeDefined();

      expect(await repo.getCheckpointV2(sandboxSession.id)).toMatchObject({
        checkpointData: { generation: 2 },
        lifecycleOperationId: firstOperation!.operationId,
        lifecycleOwnerId: takeover!.ownerId,
        lifecycleFenceToken: takeover!.fenceToken,
      });
      const checkpointRows = await testDb.conn.pgClient`
        SELECT
          checkpoint_data,
          lifecycle_operation_id,
          lifecycle_owner_id,
          lifecycle_fence_token
        FROM agent_checkpoints
        WHERE sandbox_session_id = ${sandboxSession.id}
        ORDER BY created_at, id
      `;
      expect(checkpointRows).toHaveLength(2);
      expect(checkpointRows.map((row) => row.lifecycle_owner_id)).toEqual([
        firstOperation!.ownerId,
        takeover!.ownerId,
      ]);
      expect(checkpointRows.map((row) => row.lifecycle_operation_id)).toEqual([
        firstOperation!.operationId,
        firstOperation!.operationId,
      ]);

      expect(await repo.completeSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        ownerId: takeover!.ownerId,
        fenceToken: takeover!.fenceToken,
        fromStatus: 'ACTIVE',
        toStatus: 'CHECKPOINTED',
      })).toBe(true);
      const restore = await repo.claimSandboxSessionRestore({
        sandboxSessionId: sandboxSession.id,
        ownerId: 'restore-owner-after-checkpoint',
        leaseDurationMs: 60_000,
        maxAttempts: 3,
      });
      expect(restore).toBeDefined();
      expect(await repo.completeSandboxSessionRestore(
        sandboxSession.id,
        {
          ownerId: 'restore-owner-after-checkpoint',
          fenceToken: restore!.restoreFenceToken,
        },
        {
          containerName: 'restored-container',
          containerId: 'restored-container-id',
        },
      )).toBeDefined();
      const nextOperation = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'checkpoint',
        ownerId: 'checkpoint-owner-c',
        leaseDurationMs: 60_000,
        expectedActiveGeneration:
          await currentActiveGeneration(sandboxSession.id),
      });
      expect(nextOperation).toBeDefined();
      expect(nextOperation!.operationId).not.toBe(firstOperation!.operationId);
      expect(await repo.getCheckpointV2ForLifecycleOperation(
        sandboxSession.id,
        nextOperation!.operationId,
      )).toBeNull();
    });

    it('does not begin destructive lifecycle work over an expired stranded turn', async () => {
      const {
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Lifecycle Stranded Turn Barrier');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'stranded-owner',
        leaseDurationMs: 60_000,
      });
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);

      await expireTurnDeliveryLease(turn.id);
      expect(await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'terminate',
        ownerId: 'unsafe-terminator',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBeUndefined();
      expect(
        await repo.hasUnfinishedSandboxSessionLifecycleOperation(
          sandboxSession.id,
        ),
      ).toBe(false);
    });

    it('allows lifecycle intent to fence the exact stranded delivery before reset', async () => {
      const {
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Lifecycle Intent Stranded Delivery');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'recovery-owner',
        leaseDurationMs: 60_000,
      });
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);

      expect(await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'lifecycle-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBeUndefined();

      const lifecycleOperation = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'lifecycle-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
        allowedTurnDelivery: {
          turnId: turn.id,
          ownerId: delivery!.ownerId,
          fenceToken: delivery!.fenceToken,
        },
      });
      expect(lifecycleOperation).toMatchObject({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'lifecycle-owner',
      });
      expect(await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSession.id,
        lifecycleOperation!.ownerId,
        lifecycleOperation!.fenceToken,
      )).toBe(false);
      expect(await repo.isTurnDeliveryFenceCurrent(turn.id, {
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);
      expect(await repo.finalizeTurnAndMarkLifecycleDraining(turn.id, {
        status: 'error',
        completedAt: Date.now(),
        error: 'orchestrator restarted',
      }, {
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
      }, {
        sandboxSessionId: sandboxSession.id,
        ownerId: lifecycleOperation!.ownerId,
        fenceToken: lifecycleOperation!.fenceToken,
      })).toBe(true);
      expect(await repo.getTurnSecretEnvelope(turn.id)).toBeUndefined();
      await expireSandboxSessionLifecycleOperation(sandboxSession.id);
      const resetTakeover = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'lifecycle-owner-takeover',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      });
      expect(resetTakeover).toMatchObject({
        operationId: lifecycleOperation!.operationId,
        operation: 'reset',
        phase: 'draining',
        ownerId: 'lifecycle-owner-takeover',
        fenceToken: lifecycleOperation!.fenceToken + 1,
      });
      expect(await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSession.id,
        lifecycleOperation!.ownerId,
        lifecycleOperation!.fenceToken,
      )).toBe(false);
      expect(await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSession.id,
        resetTakeover!.ownerId,
        resetTakeover!.fenceToken,
      )).toBe(true);
      expect(await repo.renewTurnDeliveryLease(
        turn.id,
        delivery!.ownerId,
        delivery!.fenceToken,
        60_000,
      )).toBeUndefined();
      expect(await repo.isTurnDeliveryFenceCurrent(turn.id, {
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
      })).toBe(false);
      expect(await repo.updateTurnIfDeliveryOwned(turn.id, {
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
      }, {
        error: 'stale delivery mutation',
      })).toBeUndefined();
      expect(await repo.cancelSandboxSessionLifecycleOperation(
        sandboxSession.id,
        resetTakeover!.ownerId,
        resetTakeover!.fenceToken,
      )).toBe(false);
      expect(await repo.completeSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        ownerId: resetTakeover!.ownerId,
        fenceToken: resetTakeover!.fenceToken,
        fromStatus: 'ACTIVE',
        toStatus: 'TERMINATED',
      })).toBe(true);
    });

    it('invalidates the exact parked HITL delivery at checkpoint execution', async () => {
      const {
        agent,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Lifecycle Intent HITL Checkpoint');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'hitl-delivery-owner',
        leaseDurationMs: 60_000,
      });
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);
      await repo.savePendingInterrupt({
        id: `interrupt-${turn.id}`,
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'tool-call-hitl',
        toolName: 'bash',
        args: { cmd: 'echo approval' },
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });

      const checkpoint = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'checkpoint',
        ownerId: 'checkpoint-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
        allowedTurnDelivery: {
          turnId: turn.id,
          ownerId: delivery!.ownerId,
          fenceToken: delivery!.fenceToken,
        },
      });
      expect(checkpoint).toBeDefined();
      expect(await repo.isTurnDeliveryFenceCurrent(turn.id, {
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
      })).toBe(true);

      expect(await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSession.id,
        checkpoint!.ownerId,
        checkpoint!.fenceToken,
      )).toBe(true);
      expect(await repo.renewTurnDeliveryLease(
        turn.id,
        delivery!.ownerId,
        delivery!.fenceToken,
        60_000,
      )).toBeUndefined();
      expect(await repo.isTurnDeliveryFenceCurrent(turn.id, {
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
      })).toBe(false);
      expect(await repo.completeSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        ownerId: checkpoint!.ownerId,
        fenceToken: checkpoint!.fenceToken,
        fromStatus: 'ACTIVE',
        toStatus: 'CHECKPOINTED',
      })).toBe(true);
      expect(await repo.getTurn(turn.id)).toMatchObject({
        status: 'running',
        completedAt: null,
      });
      expect(await repo.getSandboxSession(sandboxSession.id)).toMatchObject({
        status: 'CHECKPOINTED',
      });
    });

    it('allows reset only for the exact resolved HITL resume delivery and preserves it on takeover', async () => {
      const {
        agent,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Lifecycle Intent HITL Recovery Reset');
      const initialDelivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'initial-hitl-owner',
        leaseDurationMs: 60_000,
      });
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: initialDelivery!.ownerId,
        fenceToken: initialDelivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);
      await repo.savePendingInterrupt({
        id: `interrupt-${turn.id}`,
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'tool-call-hitl-recovery',
        toolName: 'bash',
        args: { cmd: 'echo recovered' },
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      const resolution = await repo.resolveInterruptWithResumeAttempt(
        `interrupt-${turn.id}`,
        'approve',
      );
      expect(resolution?.kind).toBe('ready');
      const attempt = resolution?.kind === 'ready'
        ? resolution.resumeAttempt
        : undefined;
      expect(attempt).toBeDefined();

      await expireTurnDeliveryLease(turn.id);
      const resumeDelivery = await repo.claimInterruptResumeDelivery({
        attemptId: attempt!.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: 'resume-owner',
        leaseDurationMs: 60_000,
      });
      expect(resumeDelivery).toBeDefined();

      expect(await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'wrong-fence-reset-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
        allowedTurnDelivery: {
          turnId: turn.id,
          ownerId: resumeDelivery!.lease.ownerId,
          fenceToken: resumeDelivery!.lease.fenceToken + 1,
          interruptResumeAttemptId: attempt!.id,
        },
      })).toBeUndefined();
      expect(await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'wrong-attempt-reset-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
        allowedTurnDelivery: {
          turnId: turn.id,
          ownerId: resumeDelivery!.lease.ownerId,
          fenceToken: resumeDelivery!.lease.fenceToken,
          interruptResumeAttemptId: `wrong-${attempt!.id}`,
        },
      })).toBeUndefined();

      const reset = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'hitl-reset-owner',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
        allowedTurnDelivery: {
          turnId: turn.id,
          ownerId: resumeDelivery!.lease.ownerId,
          fenceToken: resumeDelivery!.lease.fenceToken,
          interruptResumeAttemptId: attempt!.id,
        },
      });
      expect(reset).toMatchObject({
        operation: 'reset',
        allowedTurnId: turn.id,
        allowedDeliveryOwnerId: resumeDelivery!.lease.ownerId,
        allowedDeliveryFenceToken: resumeDelivery!.lease.fenceToken,
        allowedInterruptResumeAttemptId: attempt!.id,
      });
      expect(await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSession.id,
        reset!.ownerId,
        reset!.fenceToken,
      )).toBe(true);
      expect(await repo.isTurnDeliveryFenceCurrent(turn.id, {
        ownerId: resumeDelivery!.lease.ownerId,
        fenceToken: resumeDelivery!.lease.fenceToken,
      })).toBe(false);

      await expireSandboxSessionLifecycleOperation(sandboxSession.id);
      const takeover = await repo.claimSandboxSessionLifecycleOperation({
        sandboxSessionId: sandboxSession.id,
        operation: 'reset',
        ownerId: 'hitl-reset-takeover',
        leaseDurationMs: 60_000,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      });
      expect(takeover).toMatchObject({
        operationId: reset!.operationId,
        phase: 'executing',
        ownerId: 'hitl-reset-takeover',
        fenceToken: reset!.fenceToken + 1,
        allowedTurnId: turn.id,
        allowedDeliveryOwnerId: resumeDelivery!.lease.ownerId,
        allowedDeliveryFenceToken: resumeDelivery!.lease.fenceToken,
        allowedInterruptResumeAttemptId: attempt!.id,
      });
      expect(await repo.markSandboxSessionLifecycleOperationExecuting(
        sandboxSession.id,
        takeover!.ownerId,
        takeover!.fenceToken,
      )).toBe(true);
    });

    it('activates a normal turn only while it remains open', async () => {
      const {
        agent,
        conversation,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Normal Turn Activation');
      const replacementSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId: agent.id,
        harnessName: 'claude-agents',
        status: 'TERMINATED',
      });

      expect(await repo.activateTurnIfOpen(
        turn.id,
        sandboxSession.id,
        activeGenerationOf(sandboxSession),
      )).toBe(true);
      expect(await repo.activateTurnIfOpen(
        turn.id,
        replacementSession.id,
        activeGenerationOf(replacementSession),
      )).toBe(false);
      await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: 40_000,
        error: 'Turn cancelled',
        status: 'cancelled',
      });
      expect(await repo.activateTurnIfOpen(
        turn.id,
        sandboxSession.id,
        activeGenerationOf(sandboxSession),
      )).toBe(false);
      expect(await repo.getTurn(turn.id)).toMatchObject({
        status: 'cancelled',
        sandboxSessionId: sandboxSession.id,
      });
    });

    it('fences activation, mutation, and finalization across lease takeover', async () => {
      const {
        agent,
        conversation,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Turn Delivery Fence');
      const takeoverSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId: agent.id,
        harnessName: 'claude-agents',
        status: 'TERMINATED',
      });
      const baseTime = Date.now();
      const first = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'reconciler-a',
        leaseDurationMs: 60_000,
      });
      expect(first?.fenceToken).toBe(1);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: 'reconciler-a',
        fenceToken: first!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);
      expect(await repo.getTurn(turn.id)).toMatchObject({
        status: 'running',
        sandboxSessionId: sandboxSession.id,
        deliveryOwnerId: 'reconciler-a',
        deliveryFenceToken: first!.fenceToken,
      });

      expect(await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'reconciler-b',
        leaseDurationMs: 60_000,
      })).toBeUndefined();

      await expireTurnDeliveryLease(turn.id);
      const second = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'reconciler-b',
        leaseDurationMs: 60_000,
      });
      expect(second?.fenceToken).toBe(2);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: takeoverSession.id,
        ownerId: 'reconciler-b',
        fenceToken: second!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(takeoverSession),
      })).toBe(false);

      expect(await repo.isTurnDeliveryFenceCurrent(
        turn.id,
        {
          ownerId: 'reconciler-a',
          fenceToken: first!.fenceToken,
        },
      )).toBe(false);
      expect(await repo.updateTurnIfDeliveryOwned(
        turn.id,
        {
          ownerId: 'reconciler-a',
          fenceToken: first!.fenceToken,
        },
        { sandboxSessionId: sandboxSession.id },
      )).toBeUndefined();
      expect(await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: baseTime + 10_002,
        error: 'stale owner',
        status: 'error',
      }, {
        ownerId: 'reconciler-a',
        fenceToken: first!.fenceToken,
      })).toBe(false);
      expect(await repo.getTurnSecretEnvelope(turn.id)).toBeDefined();

      expect(await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: baseTime + 10_003,
        error: null,
        status: 'completed',
      }, {
        ownerId: 'reconciler-b',
        fenceToken: second!.fenceToken,
      })).toBe(true);
      expect(await repo.getTurnSecretEnvelope(turn.id)).toBeUndefined();
      expect(await repo.getTurn(turn.id)).toMatchObject({
        status: 'completed',
        sandboxSessionId: sandboxSession.id,
        error: null,
      });
    });

    it('reports whether a sandbox session still has a live turn delivery', async () => {
      const {
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Exact Delivery Callback Guard');
      const lease = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'callback-owner',
        leaseDurationMs: 60_000,
      });
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: lease!.ownerId,
        fenceToken: lease!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);

      expect(await repo.hasLiveTurnDeliveryForSandboxSession(sandboxSession.id)).toBe(true);

      await expireTurnDeliveryLease(turn.id);
      expect(await repo.hasLiveTurnDeliveryForSandboxSession(sandboxSession.id)).toBe(false);
    });

    it('returns claims for the exact immutable delivery capability tuple', async () => {
      const {
        agent,
        conversation,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Exact Delivery Capability');
      await repo.updateSandboxSessionMetadata(
        sandboxSession.id,
        'ACTIVE',
        {
          containerName: 'capability-container',
          containerId: 'capability-container-id',
        },
        activeGenerationOf(sandboxSession),
      );
      const activeSession = await repo.getSandboxSession(sandboxSession.id);
      expect(activeSession).toBeDefined();
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'capability-owner',
        leaseDurationMs: 60_000,
      });
      expect(delivery).toBeDefined();
      const expectedActiveGeneration = activeGenerationOf(activeSession!);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration,
      })).toBe(true);

      await expect(repo.getTurnDeliveryCapabilityClaims({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        expectedDeliveryFence: {
          ownerId: delivery!.ownerId,
          fenceToken: delivery!.fenceToken,
        },
        expectedActiveGeneration,
      })).resolves.toEqual({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        conversationId: conversation.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        leaseExpiresAtMs: delivery!.leaseExpiresAt,
        restoreFenceToken: activeSession!.restoreFenceToken,
        containerId: 'capability-container-id',
      });
    });

    it('rejects every delivery capability tuple mismatch without mutating state', async () => {
      const {
        agent,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Mismatched Delivery Capability');
      await repo.updateSandboxSessionMetadata(
        sandboxSession.id,
        'ACTIVE',
        {
          containerName: 'capability-container',
          containerId: 'capability-container-id',
        },
        activeGenerationOf(sandboxSession),
      );
      const activeSession = await repo.getSandboxSession(sandboxSession.id);
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'capability-owner',
        leaseDurationMs: 60_000,
      });
      const expectedActiveGeneration = activeGenerationOf(activeSession!);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration,
      })).toBe(true);
      const exactInput = {
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        expectedDeliveryFence: {
          ownerId: delivery!.ownerId,
          fenceToken: delivery!.fenceToken,
        },
        expectedActiveGeneration,
      };
      const mismatches = [
        { ...exactInput, turnId: `wrong-${turn.id}` },
        { ...exactInput, sandboxSessionId: `wrong-${sandboxSession.id}` },
        { ...exactInput, agentId: `wrong-${agent.id}` },
        {
          ...exactInput,
          expectedDeliveryFence: {
            ...exactInput.expectedDeliveryFence,
            ownerId: 'wrong-capability-owner',
          },
        },
        {
          ...exactInput,
          expectedDeliveryFence: {
            ...exactInput.expectedDeliveryFence,
            fenceToken: exactInput.expectedDeliveryFence.fenceToken + 1,
          },
        },
        {
          ...exactInput,
          expectedActiveGeneration: {
            ...exactInput.expectedActiveGeneration,
            restoreFenceToken:
              exactInput.expectedActiveGeneration.restoreFenceToken + 1,
          },
        },
        {
          ...exactInput,
          expectedActiveGeneration: {
            ...exactInput.expectedActiveGeneration,
            containerId: 'wrong-container-id',
          },
        },
      ];
      const before = await snapshotDeliveryCapabilityState(
        turn.id,
        sandboxSession.id,
      );

      for (const mismatch of mismatches) {
        await expect(
          repo.getTurnDeliveryCapabilityClaims(mismatch),
        ).resolves.toBeUndefined();
      }

      expect(await snapshotDeliveryCapabilityState(
        turn.id,
        sandboxSession.id,
      )).toEqual(before);
    });

    it('rejects inactive-session and expired-lease capabilities without mutation', async () => {
      const inactiveRuntime = await createRuntimeTurn(
        'Inactive Delivery Capability',
      );
      const inactiveDelivery = await repo.claimTurnDeliveryLease({
        turnId: inactiveRuntime.turn.id,
        ownerId: 'inactive-capability-owner',
        leaseDurationMs: 60_000,
      });
      const inactiveGeneration = activeGenerationOf(
        inactiveRuntime.sandboxSession,
      );
      expect(await repo.activateTurnDelivery({
        turnId: inactiveRuntime.turn.id,
        sandboxSessionId: inactiveRuntime.sandboxSession.id,
        ownerId: inactiveDelivery!.ownerId,
        fenceToken: inactiveDelivery!.fenceToken,
        expectedActiveGeneration: inactiveGeneration,
      })).toBe(true);
      await testDb.conn.pgClient`
        UPDATE sandbox_sessions
        SET status = 'CHECKPOINTED'
        WHERE id = ${inactiveRuntime.sandboxSession.id}
      `;
      const inactiveBefore = await snapshotDeliveryCapabilityState(
        inactiveRuntime.turn.id,
        inactiveRuntime.sandboxSession.id,
      );
      await expect(repo.getTurnDeliveryCapabilityClaims({
        turnId: inactiveRuntime.turn.id,
        sandboxSessionId: inactiveRuntime.sandboxSession.id,
        agentId: inactiveRuntime.agent.id,
        expectedDeliveryFence: {
          ownerId: inactiveDelivery!.ownerId,
          fenceToken: inactiveDelivery!.fenceToken,
        },
        expectedActiveGeneration: inactiveGeneration,
      })).resolves.toBeUndefined();
      expect(await snapshotDeliveryCapabilityState(
        inactiveRuntime.turn.id,
        inactiveRuntime.sandboxSession.id,
      )).toEqual(inactiveBefore);

      const expiredRuntime = await createRuntimeTurn(
        'Expired Delivery Capability',
      );
      const expiredDelivery = await repo.claimTurnDeliveryLease({
        turnId: expiredRuntime.turn.id,
        ownerId: 'expired-capability-owner',
        leaseDurationMs: 60_000,
      });
      const expiredGeneration = activeGenerationOf(
        expiredRuntime.sandboxSession,
      );
      expect(await repo.activateTurnDelivery({
        turnId: expiredRuntime.turn.id,
        sandboxSessionId: expiredRuntime.sandboxSession.id,
        ownerId: expiredDelivery!.ownerId,
        fenceToken: expiredDelivery!.fenceToken,
        expectedActiveGeneration: expiredGeneration,
      })).toBe(true);
      await expireTurnDeliveryLease(expiredRuntime.turn.id);
      const expiredBefore = await snapshotDeliveryCapabilityState(
        expiredRuntime.turn.id,
        expiredRuntime.sandboxSession.id,
      );
      await expect(repo.getTurnDeliveryCapabilityClaims({
        turnId: expiredRuntime.turn.id,
        sandboxSessionId: expiredRuntime.sandboxSession.id,
        agentId: expiredRuntime.agent.id,
        expectedDeliveryFence: {
          ownerId: expiredDelivery!.ownerId,
          fenceToken: expiredDelivery!.fenceToken,
        },
        expectedActiveGeneration: expiredGeneration,
      })).resolves.toBeUndefined();
      expect(await snapshotDeliveryCapabilityState(
        expiredRuntime.turn.id,
        expiredRuntime.sandboxSession.id,
      )).toEqual(expiredBefore);
    });

    it('rejects pending-interrupt replacement after delivery-fence takeover without writes', async () => {
      const {
        agent,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Stale Interrupt Delivery Fence');
      const originalDelivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'interrupt-owner-a',
        leaseDurationMs: 60_000,
      });
      const expectedActiveGeneration = activeGenerationOf(sandboxSession);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: originalDelivery!.ownerId,
        fenceToken: originalDelivery!.fenceToken,
        expectedActiveGeneration,
      })).toBe(true);

      await expireTurnDeliveryLease(turn.id);
      const successorDelivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'interrupt-owner-b',
        leaseDurationMs: 60_000,
      });
      expect(successorDelivery?.fenceToken).toBe(
        originalDelivery!.fenceToken + 1,
      );
      const replacementId = `replacement-${turn.id}`;

      await expect(repo.installPendingInterruptIfSandboxCallbackCurrent({
        id: replacementId,
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'replacement-tool-call',
        toolName: 'request-approval',
        args: { reason: 'replacement' },
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }, {
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        expectedDeliveryFence: {
          ownerId: originalDelivery!.ownerId,
          fenceToken: originalDelivery!.fenceToken,
        },
        expectedActiveGeneration,
      })).resolves.toBeUndefined();
      expect(await repo.getInterruptById(replacementId)).toBeUndefined();
    });

    it('rejects pending-interrupt installation after lease expiry without writes', async () => {
      const {
        agent,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Expired Interrupt Delivery Lease');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'expired-interrupt-owner',
        leaseDurationMs: 60_000,
      });
      const expectedActiveGeneration = activeGenerationOf(sandboxSession);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration,
      })).toBe(true);
      await expireTurnDeliveryLease(turn.id);
      const interruptId = `expired-${turn.id}`;

      await expect(repo.installPendingInterruptIfSandboxCallbackCurrent({
        id: interruptId,
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'expired-tool-call',
        toolName: 'request-approval',
        args: { reason: 'expired' },
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }, {
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        expectedDeliveryFence: {
          ownerId: delivery!.ownerId,
          fenceToken: delivery!.fenceToken,
        },
        expectedActiveGeneration,
      })).resolves.toBeUndefined();
      expect(await repo.getInterruptById(interruptId)).toBeUndefined();
    });

    it('rejects pending-interrupt installation after active-generation change without writes', async () => {
      const {
        agent,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Stale Interrupt Active Generation');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'generation-interrupt-owner',
        leaseDurationMs: 60_000,
      });
      const expectedActiveGeneration = activeGenerationOf(sandboxSession);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration,
      })).toBe(true);
      await testDb.conn.pgClient`
        UPDATE sandbox_sessions
        SET
          restore_fence_token = restore_fence_token + 1,
          container_id = 'successor-interrupt-container'
        WHERE id = ${sandboxSession.id}
      `;
      const interruptId = `stale-generation-${turn.id}`;

      await expect(repo.installPendingInterruptIfSandboxCallbackCurrent({
        id: interruptId,
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'stale-generation-tool-call',
        toolName: 'request-approval',
        args: { reason: 'stale generation' },
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }, {
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        expectedDeliveryFence: {
          ownerId: delivery!.ownerId,
          fenceToken: delivery!.fenceToken,
        },
        expectedActiveGeneration,
      })).resolves.toBeUndefined();
      expect(await repo.getInterruptById(interruptId)).toBeUndefined();
    });

    it('admits only one concurrent pending-interrupt installation across replicas', async () => {
      const {
        agent,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Concurrent Interrupt Installation');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'concurrent-interrupt-owner',
        leaseDurationMs: 60_000,
      });
      const expectedActiveGeneration = activeGenerationOf(sandboxSession);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration,
      })).toBe(true);
      const authority = {
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        expectedDeliveryFence: {
          ownerId: delivery!.ownerId,
          fenceToken: delivery!.fenceToken,
        },
        expectedActiveGeneration,
      };
      const connectionA = await createDatabase(resolveTestDatabaseUrl());
      const connectionB = await createDatabase(resolveTestDatabaseUrl());
      const repositoryA = new DatabaseRepository(connectionA.db);
      const repositoryB = new DatabaseRepository(connectionB.db);
      const interruptIds = [
        `concurrent-a-${turn.id}`,
        `concurrent-b-${turn.id}`,
      ];

      try {
        const installations = await Promise.all([
          repositoryA.installPendingInterruptIfSandboxCallbackCurrent({
            id: interruptIds[0],
            turnId: turn.id,
            agentId: agent.id,
            sandboxSessionId: sandboxSession.id,
            toolCallId: 'concurrent-tool-call-a',
            toolName: 'request-approval',
            args: { reason: 'concurrent A' },
            timeoutMs: 60_000,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          }, authority),
          repositoryB.installPendingInterruptIfSandboxCallbackCurrent({
            id: interruptIds[1],
            turnId: turn.id,
            agentId: agent.id,
            sandboxSessionId: sandboxSession.id,
            toolCallId: 'concurrent-tool-call-b',
            toolName: 'request-approval',
            args: { reason: 'concurrent B' },
            timeoutMs: 60_000,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          }, authority),
        ]);

        expect(installations.filter(
          (interrupt) => interrupt !== undefined,
        )).toHaveLength(1);
        expect(installations.filter(
          (interrupt) => interrupt === undefined,
        )).toHaveLength(1);
        const actionableRows = await testDb.conn.pgClient`
          SELECT id, status
          FROM pending_interrupts
          WHERE
            turn_id = ${turn.id}
            AND status IN ('pending', 'timed_out')
        `;
        expect(actionableRows).toHaveLength(1);
        expect(interruptIds).toContain(String(actionableRows[0]!.id));
      } finally {
        await connectionA.close();
        await connectionB.close();
      }
    });

    it('atomically supersedes a pending interrupt and installs its replacement', async () => {
      const {
        agent,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Atomic Interrupt Replacement');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'live-interrupt-owner',
        leaseDurationMs: 60_000,
      });
      const expectedActiveGeneration = activeGenerationOf(sandboxSession);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration,
      })).toBe(true);
      const existingId = `superseded-${turn.id}`;
      await repo.savePendingInterrupt({
        id: existingId,
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'superseded-tool-call',
        toolName: 'request-approval',
        args: { reason: 'superseded' },
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      const replacementId = `installed-${turn.id}`;

      const result = await repo.installPendingInterruptIfSandboxCallbackCurrent({
        id: replacementId,
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'installed-tool-call',
        toolName: 'request-approval',
        args: { reason: 'installed' },
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }, {
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        expectedDeliveryFence: {
          ownerId: delivery!.ownerId,
          fenceToken: delivery!.fenceToken,
        },
        expectedActiveGeneration,
      }, existingId);

      expect(result).toMatchObject({
        id: replacementId,
        status: 'pending',
      });
      expect(await repo.getInterruptById(existingId)).toMatchObject({
        status: 'resolved',
        resolvedAction: 'reject',
        resolvedData: 'Superseded by new interrupt',
      });
      expect(await repo.getInterruptById(replacementId)).toMatchObject({
        status: 'pending',
        resolvedAt: null,
        resolvedAction: null,
      });
    });

    it('compensates only the exact unchanged pending-interrupt installation', async () => {
      const {
        agent,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Exact Interrupt Compensation');
      const supersededId = `compensation-superseded-${turn.id}`;
      await repo.savePendingInterrupt({
        id: supersededId,
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'superseded-compensation-tool-call',
        toolName: 'request-approval',
        args: { reason: 'superseded' },
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      await repo.resolveInterrupt(
        supersededId,
        'reject',
        'Superseded by new interrupt',
      );
      const installedId = `compensation-installed-${turn.id}`;
      await repo.savePendingInterrupt({
        id: installedId,
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'installed-compensation-tool-call',
        toolName: 'request-approval',
        args: { reason: 'installed' },
        timeoutMs: 60_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });

      expect(await repo.deletePendingInterruptInstallation(
        supersededId,
        turn.id,
        'superseded-compensation-tool-call',
      )).toBe(false);
      expect(await repo.deletePendingInterruptInstallation(
        installedId,
        turn.id,
        'wrong-tool-call',
      )).toBe(false);
      expect(await repo.getInterruptById(installedId)).toMatchObject({
        status: 'pending',
        toolCallId: 'installed-compensation-tool-call',
      });

      expect(await repo.deletePendingInterruptInstallation(
        installedId,
        turn.id,
        'installed-compensation-tool-call',
      )).toBe(true);
      expect(await repo.getInterruptById(installedId)).toBeUndefined();
      expect(await repo.getInterruptById(supersededId)).toMatchObject({
        status: 'resolved',
      });
    });

    it('atomically fences tool admission and artifact persistence to the exact callback delivery', async () => {
      const {
        agent,
        conversation,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Atomic Callback Persistence');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'callback-owner',
        leaseDurationMs: 60_000,
      });
      expect(delivery).toBeDefined();
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);
      const expectedDeliveryFence = {
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
      };
      const expectedActiveGeneration = activeGenerationOf(sandboxSession);

      expect(await repo.tryAdmitToolRequest({
        requestId: `tool-${turn.id}`,
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        toolName: 'lookup',
        expectedDeliveryFence,
        expectedActiveGeneration,
      })).toBe('inserted');
      expect(await repo.tryAdmitToolRequest({
        requestId: `tool-${turn.id}`,
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        toolName: 'lookup',
        expectedDeliveryFence,
        expectedActiveGeneration,
      })).toBe('duplicate');
      expect(await repo.completeToolDedup(
        `tool-${turn.id}`,
        'lookup-result',
        null,
        {
          turnId: turn.id,
          sandboxSessionId: sandboxSession.id,
          agentId: agent.id,
          expectedDeliveryFence,
          expectedActiveGeneration,
        },
      )).toBe(true);
      expect(await repo.getToolDedup(`tool-${turn.id}`)).toMatchObject({
        status: 'completed',
        result: 'lookup-result',
        error: null,
      });

      const artifact = await repo.saveArtifactIfDeliveryOwned({
        id: `artifact-${turn.id}`,
        agentId: agent.id,
        turnId: turn.id,
        conversationId: conversation.id,
        name: 'proof.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        storageKey: `proof/${turn.id}`,
        bucket: 'artifacts',
        kind: 'eval_report',
        metadata: { suite: 'delivery-fence' },
        sha256: 'a'.repeat(64),
      }, {
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        expectedDeliveryFence,
        expectedActiveGeneration,
      });
      expect(artifact).toMatchObject({
        id: `artifact-${turn.id}`,
        turnId: turn.id,
        kind: 'eval_report',
        metadata: { suite: 'delivery-fence' },
        sha256: 'a'.repeat(64),
      });

      await expireTurnDeliveryLease(turn.id);
      expect(await repo.tryAdmitToolRequest({
        requestId: `stale-tool-${turn.id}`,
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        toolName: 'lookup',
        expectedDeliveryFence,
        expectedActiveGeneration,
      })).toBe('stale');
      expect(await repo.saveArtifactIfDeliveryOwned({
        id: `stale-artifact-${turn.id}`,
        agentId: agent.id,
        turnId: turn.id,
        conversationId: conversation.id,
        name: 'stale.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        storageKey: `proof/stale-${turn.id}`,
        bucket: 'artifacts',
      }, {
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        expectedDeliveryFence,
        expectedActiveGeneration,
      })).toBeUndefined();
      expect(await repo.getArtifact(`stale-artifact-${turn.id}`)).toBeUndefined();
    });

    it('rejects stale active generations at every callback mutation sink without side effects', async () => {
      const {
        agent,
        conversation,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Stale Callback Generation');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'stale-generation-owner',
        leaseDurationMs: 60_000,
      });
      const expectedDeliveryFence = {
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
      };
      const expectedActiveGeneration = activeGenerationOf(sandboxSession);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration,
      })).toBe(true);

      const admittedRequestId = `in-progress-${turn.id}`;
      expect(await repo.tryAdmitToolRequest({
        requestId: admittedRequestId,
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        toolName: 'lookup',
        expectedDeliveryFence,
        expectedActiveGeneration,
      })).toBe('inserted');

      const staleGenerations = [
        {
          ...expectedActiveGeneration,
          restoreFenceToken: expectedActiveGeneration.restoreFenceToken + 1,
        },
        {
          ...expectedActiveGeneration,
          containerId: 'stale-callback-container',
        },
      ];

      for (const [index, staleGeneration] of staleGenerations.entries()) {
        const staleRequestId = `stale-${index}-${turn.id}`;
        expect(await repo.tryAdmitToolRequest({
          requestId: staleRequestId,
          turnId: turn.id,
          sandboxSessionId: sandboxSession.id,
          agentId: agent.id,
          toolName: 'lookup',
          expectedDeliveryFence,
          expectedActiveGeneration: staleGeneration,
        })).toBe('stale');
        expect(await repo.completeToolDedup(
          admittedRequestId,
          'must-not-commit',
          null,
          {
            turnId: turn.id,
            sandboxSessionId: sandboxSession.id,
            agentId: agent.id,
            expectedDeliveryFence,
            expectedActiveGeneration: staleGeneration,
          },
        )).toBe(false);
        expect(await repo.saveArtifactIfDeliveryOwned({
          id: `stale-generation-artifact-${index}-${turn.id}`,
          agentId: agent.id,
          turnId: turn.id,
          conversationId: conversation.id,
          name: 'stale.txt',
          mimeType: 'text/plain',
          sizeBytes: 5,
          storageKey: `proof/stale-generation-${index}-${turn.id}`,
          bucket: 'artifacts',
        }, {
          turnId: turn.id,
          sandboxSessionId: sandboxSession.id,
          agentId: agent.id,
          expectedDeliveryFence,
          expectedActiveGeneration: staleGeneration,
        })).toBeUndefined();
        expect(await repo.saveFencedEventBatch([{
          type: 'callback.stale-generation',
          agentId: agent.id,
          payload: JSON.stringify({ index }),
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'tool',
          sourceType: 'callback.stale-generation',
          sourcePayload: JSON.stringify({ index }),
        }], expectedDeliveryFence, {
          sandboxSessionId: sandboxSession.id,
          expectedActiveGeneration: staleGeneration,
        })).toEqual([]);

        expect(await repo.getToolDedup(staleRequestId)).toBeUndefined();
        expect(await repo.getArtifact(
          `stale-generation-artifact-${index}-${turn.id}`,
        )).toBeUndefined();
      }

      expect(await repo.getToolDedup(admittedRequestId)).toMatchObject({
        status: 'in_progress',
        result: null,
        error: null,
      });
      expect(await repo.getTurnFrames(turn.id)).toEqual([]);
      const [eventHead] = await testDb.conn.pgClient`
        SELECT agent_id
        FROM agent_event_heads
        WHERE agent_id = ${agent.id}
      `;
      expect(eventHead).toBeUndefined();
    });

    it('loses callback mutation races cleanly when the active generation changes first', async () => {
      const {
        agent,
        conversation,
        sandboxSession,
        turn,
      } = await createRuntimeTurn('Callback Generation Race');
      const delivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'generation-race-owner',
        leaseDurationMs: 60_000,
      });
      const expectedDeliveryFence = {
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
      };
      const expectedActiveGeneration = activeGenerationOf(sandboxSession);
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: delivery!.ownerId,
        fenceToken: delivery!.fenceToken,
        expectedActiveGeneration,
      })).toBe(true);
      const admittedRequestId = `race-in-progress-${turn.id}`;
      expect(await repo.tryAdmitToolRequest({
        requestId: admittedRequestId,
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        agentId: agent.id,
        toolName: 'lookup',
        expectedDeliveryFence,
        expectedActiveGeneration,
      })).toBe('inserted');

      const delayedConnection = await createDatabase(resolveTestDatabaseUrl());
      const delayedRepository = new DatabaseRepository(delayedConnection.db);
      const gateConnection = await testDb.conn.pgClient.reserve();
      let gateTransactionOpen = false;
      let mutations: Promise<unknown[]> | undefined;
      try {
        await gateConnection`BEGIN`;
        gateTransactionOpen = true;
        await gateConnection`
          UPDATE sandbox_sessions
          SET
            restore_fence_token = restore_fence_token + 1,
            container_id = 'successor-container'
          WHERE id = ${sandboxSession.id}
        `;
        const [waitersBefore] = await testDb.conn.pgClient`
          SELECT count(*)::int AS count
          FROM pg_locks
          WHERE granted = false
        `;

        mutations = Promise.all([
          delayedRepository.tryAdmitToolRequest({
            requestId: `race-stale-${turn.id}`,
            turnId: turn.id,
            sandboxSessionId: sandboxSession.id,
            agentId: agent.id,
            toolName: 'lookup',
            expectedDeliveryFence,
            expectedActiveGeneration,
          }),
          delayedRepository.completeToolDedup(
            admittedRequestId,
            'must-not-commit',
            null,
            {
              turnId: turn.id,
              sandboxSessionId: sandboxSession.id,
              agentId: agent.id,
              expectedDeliveryFence,
              expectedActiveGeneration,
            },
          ),
          delayedRepository.saveArtifactIfDeliveryOwned({
            id: `race-stale-artifact-${turn.id}`,
            agentId: agent.id,
            turnId: turn.id,
            conversationId: conversation.id,
            name: 'stale.txt',
            mimeType: 'text/plain',
            sizeBytes: 5,
            storageKey: `proof/race-stale-${turn.id}`,
            bucket: 'artifacts',
          }, {
            turnId: turn.id,
            sandboxSessionId: sandboxSession.id,
            agentId: agent.id,
            expectedDeliveryFence,
            expectedActiveGeneration,
          }),
          delayedRepository.saveFencedEventBatch([{
            type: 'callback.generation-race',
            agentId: agent.id,
            payload: '{"stale":true}',
            turnId: turn.id,
            conversationId: conversation.id,
            channel: 'tool',
            sourceType: 'callback.generation-race',
            sourcePayload: '{"stale":true}',
          }], expectedDeliveryFence, {
            sandboxSessionId: sandboxSession.id,
            expectedActiveGeneration,
          }),
        ]);

        await waitForCondition(
          async () => {
            const [waiters] = await testDb.conn.pgClient`
              SELECT count(*)::int AS count
              FROM pg_locks
              WHERE granted = false
            `;
            return Number(waiters.count) > Number(waitersBefore.count);
          },
          'callback mutations did not wait for the active-generation lock',
        );

        await gateConnection`COMMIT`;
        gateTransactionOpen = false;
        expect(await mutations).toEqual(['stale', false, undefined, []]);
      } finally {
        if (gateTransactionOpen) {
          await gateConnection`ROLLBACK`;
        }
        await Promise.allSettled([mutations ?? Promise.resolve([])]);
        gateConnection.release();
        await delayedConnection.close();
      }

      expect(await repo.getToolDedup(`race-stale-${turn.id}`)).toBeUndefined();
      expect(await repo.getToolDedup(admittedRequestId)).toMatchObject({
        status: 'in_progress',
        result: null,
        error: null,
      });
      expect(await repo.getArtifact(`race-stale-artifact-${turn.id}`)).toBeUndefined();
      expect(await repo.getTurnFrames(turn.id)).toEqual([]);
      const [eventHead] = await testDb.conn.pgClient`
        SELECT agent_id
        FROM agent_event_heads
        WHERE agent_id = ${agent.id}
      `;
      expect(eventHead).toBeUndefined();
    });

    it('lets the live lease owner finalize a stranded turn before delivery activation', async () => {
      const { turn } = await createRuntimeTurn('Fenced Stranded Finalization');
      const baseTime = Date.now();
      const lease = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'stranded-reconciler',
        leaseDurationMs: 60_000,
      });

      expect(await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: baseTime + 1,
        error: 'Interrupted by orchestrator restart',
        status: 'error',
      }, {
        ownerId: lease!.ownerId,
        fenceToken: lease!.fenceToken,
      })).toBe(true);
    });

    it('does not claim a turn owned by a durable HITL resume workflow', async () => {
      const { agent, sandboxSession, turn } = await createRuntimeTurn('HITL Delivery Lease');
      const now = 30_000;
      const initialDelivery = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'initial-delivery',
        leaseDurationMs: 60_000,
      });
      expect(initialDelivery).toBeDefined();
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: initialDelivery!.ownerId,
        fenceToken: initialDelivery!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);
      await repo.savePendingInterrupt({
        id: 'interrupt-reconciliation-lease',
        turnId: turn.id,
        agentId: agent.id,
        sandboxSessionId: sandboxSession.id,
        toolCallId: 'tool-call-reconciliation-lease',
        toolName: 'bash',
        args: { cmd: 'pwd' },
        timeoutMs: 60_000,
        createdAt: now,
        expiresAt: now + 60_000,
      });

      const resolution = await repo.resolveInterruptWithResumeAttempt(
        'interrupt-reconciliation-lease',
        'approve',
      );
      expect(resolution?.kind).toBe('ready');
      const attempt = resolution?.kind === 'ready'
        ? resolution.resumeAttempt
        : undefined;
      expect(attempt).toBeDefined();
      expect(await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'startup-reconciler',
        leaseDurationMs: 60_000,
      })).toBeUndefined();

      await expireTurnDeliveryLease(turn.id);
      const inProgress = await repo.claimInterruptResumeDelivery({
        attemptId: attempt!.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: 'resume-owner',
        leaseDurationMs: 60_000,
      });
      expect(inProgress).toBeDefined();
      expect(inProgress?.attempt.status).toBe('in_progress');
      expect(await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'startup-reconciler',
        leaseDurationMs: 60_000,
      })).toBeUndefined();

      const failed = await repo.failInterruptResumeDelivery(
        attempt!.id,
        {
          ownerId: inProgress!.lease.ownerId,
          fenceToken: inProgress!.lease.fenceToken,
        },
        'resume failed',
      );
      expect(failed?.status).toBe('failed');
      expect(await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'startup-reconciler',
        leaseDurationMs: 60_000,
      })).toBeUndefined();
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
      expect(readback?.terminalPublishedSeq).toBeNull();
    });

    it('retains encrypted turn credentials until terminal finalization wins', async () => {
      const conversation = await repo.createConversation(agentId);
      const turn = await repo.createTurnWithSecretEnvelope({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
      }, {
        iv: 'turn-envelope-iv',
        ciphertext: 'turn-envelope-ciphertext',
        authTag: 'turn-envelope-auth-tag',
      });

      expect(await repo.getTurnSecretEnvelope(turn.id)).toMatchObject({
        turnId: turn.id,
        iv: 'turn-envelope-iv',
        ciphertext: 'turn-envelope-ciphertext',
        authTag: 'turn-envelope-auth-tag',
      });
      expect(await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: Date.now(),
        error: 'stale owner',
        status: 'error',
      }, {
        ownerId: 'not-the-owner',
        fenceToken: 1,
      })).toBe(false);
      expect(await repo.getTurnSecretEnvelope(turn.id)).toBeDefined();

      expect(await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: Date.now(),
        error: null,
        status: 'completed',
      })).toBe(true);
      expect(await repo.getTurnSecretEnvelope(turn.id)).toBeUndefined();
    });

    it('atomically publishes terminal frames with their turn watermark and is idempotent', async () => {
      const conversation = await repo.createConversation(agentId);
      const turn = await repo.createTurn({ agentId, conversationId: conversation.id, mode: 'interactive' });
      await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: 200,
        error: null,
        status: 'completed',
      });
      const frames = [{
        type: 'RUN_FINISHED',
        agentId,
        payload: JSON.stringify({
          type: 'RUN_FINISHED',
          runId: turn.id,
          threadId: conversation.id,
          status: 'completed',
          timestamp: 200,
        }),
        turnId: turn.id,
        conversationId: conversation.id,
        channel: 'run' as const,
        sourceType: 'turn.completed',
        sourcePayload: '{}',
      }];

      const publications = await Promise.all([
        repo.saveTerminalEventBatch(frames, { turnId: turn.id }),
        repo.saveTerminalEventBatch(frames, { turnId: turn.id }),
      ]);
      const seqs = publications.flat();
      const retry = await repo.saveTerminalEventBatch(frames, { turnId: turn.id });

      expect(seqs).toHaveLength(1);
      expect(publications.map((publication) => publication.length).sort()).toEqual([0, 1]);
      expect(retry).toEqual([]);
      expect((await repo.getTurn(turn.id))?.terminalPublishedSeq).toBe(seqs[0]);
      expect((await repo.getTurnFrames(turn.id)).filter((frame) => frame.type === 'RUN_FINISHED'))
        .toHaveLength(1);
    });

    it('refuses to publish terminal frames ahead of pending canonical messages', async () => {
      const conversation = await repo.createConversation(agentId);
      const turn = await repo.createTurn({ agentId, conversationId: conversation.id, mode: 'interactive' });
      const message = await repo.addCanonicalMessage({
        id: `canonical-${turn.id}-0`,
        agentId,
        conversationId: conversation.id,
        turnId: turn.id,
        role: 'assistant',
        content: 'must publish first',
      });
      await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: 200,
        error: null,
        status: 'completed',
      });
      const terminalFrames = [{
        type: 'RUN_FINISHED',
        agentId,
        payload: JSON.stringify({
          type: 'RUN_FINISHED',
          runId: turn.id,
          threadId: conversation.id,
          status: 'completed',
          timestamp: 200,
        }),
        turnId: turn.id,
        conversationId: conversation.id,
        channel: 'run' as const,
        sourceType: 'turn.completed',
        sourcePayload: '{}',
      }];

      await expect(repo.saveTerminalEventBatch(
        terminalFrames,
        { turnId: turn.id },
      )).rejects.toThrow(/pending canonical message/);
      expect((await repo.getTurn(turn.id))?.terminalPublishedSeq).toBeNull();
      expect((await repo.getTurnFrames(turn.id)).filter((frame) => frame.type === 'RUN_FINISHED'))
        .toEqual([]);

      await repo.saveMessageEventBatch([{
        type: 'CUSTOM',
        agentId,
        payload: JSON.stringify({
          type: 'CUSTOM',
          name: 'ctxmill.message.committed',
          runId: turn.id,
          threadId: conversation.id,
          messageId: message.id,
          messageSeq: message.messageSeq,
          role: 'assistant',
          content: message.content,
          timestamp: message.createdAt,
        }),
        turnId: turn.id,
        conversationId: conversation.id,
        channel: 'run',
        sourceType: 'message.committed',
        sourcePayload: '{}',
      }], {
        messageId: message.id,
        targetRevision: 0,
      });

      await expect(repo.saveTerminalEventBatch(
        terminalFrames,
        { turnId: turn.id },
      )).resolves.toHaveLength(1);
    });

    it('rolls terminal frames back when the publication watermark cannot advance', async () => {
      const conversation = await repo.createConversation(agentId);
      const turn = await repo.createTurn({ agentId, conversationId: conversation.id, mode: 'interactive' });
      await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: 200,
        error: null,
        status: 'completed',
      });
      const triggerName = `reject_terminal_${turn.id.replaceAll('-', '_')}`;
      await testDb.conn.pgClient.unsafe(`
        CREATE FUNCTION ${triggerName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.type = 'RUN_FINISHED' THEN
            RAISE EXCEPTION 'injected terminal insert failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON event_store
        FOR EACH ROW EXECUTE FUNCTION ${triggerName}();
      `);

      try {
        await expect(repo.saveTerminalEventBatch([{
          type: 'RUN_FINISHED',
          agentId,
          payload: JSON.stringify({
            type: 'RUN_FINISHED',
            runId: turn.id,
            threadId: conversation.id,
            status: 'completed',
            timestamp: 200,
          }),
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          sourceType: 'turn.completed',
          sourcePayload: '{}',
        }], { turnId: turn.id })).rejects.toThrow();
      } finally {
        await testDb.conn.pgClient.unsafe(`
          DROP TRIGGER IF EXISTS ${triggerName} ON event_store;
          DROP FUNCTION IF EXISTS ${triggerName}();
        `);
      }

      expect((await repo.getTurn(turn.id))?.terminalPublishedSeq).toBeNull();
      expect((await repo.getTurnFrames(turn.id)).filter((frame) => frame.type === 'RUN_FINISHED'))
        .toEqual([]);
    });

    it('requires error terminals to include both RUN_ERROR and RUN_FINISHED', async () => {
      const conversation = await repo.createConversation(agentId);
      const turn = await repo.createTurn({ agentId, conversationId: conversation.id, mode: 'interactive' });
      await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: 200,
        error: 'boom',
        status: 'error',
      });

      await expect(repo.saveTerminalEventBatch([{
        type: 'RUN_FINISHED',
        agentId,
        payload: '{}',
        turnId: turn.id,
        conversationId: conversation.id,
        channel: 'run',
        sourceType: 'turn.completed',
        sourcePayload: '{}',
      }], { turnId: turn.id })).rejects.toThrow(/RUN_ERROR/);
      expect((await repo.getTurn(turn.id))?.terminalPublishedSeq).toBeNull();
    });

    it('rejects new canonical message state after a turn is finalized', async () => {
      const conversation = await repo.createConversation(agentId);
      const turn = await repo.createTurn({ agentId, conversationId: conversation.id, mode: 'interactive' });
      const message = await repo.addMessage({
        agentId,
        conversationId: conversation.id,
        turnId: turn.id,
        messageSeq: 0,
        messageRevision: 0,
        publishedRevision: 0,
        role: 'assistant',
        content: 'settled',
      });
      await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: 200,
        error: null,
        status: 'completed',
      });

      await expect(repo.stageAssistantMessageUpdate(
        message.id,
        [{ id: 'late-tool', name: 'bash', args: '{}', status: 'running' }],
        null,
      )).rejects.toThrow(/terminal turn/);
      await expect(repo.addCanonicalMessage({
        id: `canonical-${turn.id}-late`,
        agentId,
        conversationId: conversation.id,
        turnId: turn.id,
        role: 'tool',
        content: 'late',
        toolCallId: 'late-tool',
      })).rejects.toThrow(/terminal turn/);
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

    it('stages assistant projection revisions until their canonical frame is durably published', async () => {
      const conversation = await repo.createConversation(agentId);
      const turn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
      });
      const message = await repo.addMessage({
        agentId,
        conversationId: conversation.id,
        turnId: turn.id,
        messageSeq: 0,
        publishedRevision: 0,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'bash', args: '{}', status: 'running' }],
        parts: [{ type: 'tool_call', id: 'tc-1', name: 'bash', args: '{}', status: 'running' }],
      });

      const staged = await repo.stageAssistantMessageUpdate(
        message.id,
        [{ id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: 'interrupted' }],
        [{ type: 'tool_call', id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: 'interrupted' }],
      );

      expect(staged).toMatchObject({
        id: message.id,
        turnId: turn.id,
        messageSeq: 0,
        messageRevision: 1,
        publishedRevision: 0,
      });
      expect(staged?.toolCalls).toEqual([
        { id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: 'interrupted' },
      ]);
      expect(staged?.parts).toEqual([
        { type: 'tool_call', id: 'tc-1', name: 'bash', args: '{}', status: 'error', error: 'interrupted' },
      ]);

      expect(await repo.getMessagesPendingCanonicalPublish()).toEqual([
        expect.objectContaining({
          id: message.id,
          messageRevision: 1,
          publishedRevision: 0,
        }),
      ]);

      await repo.saveMessageEventBatch(
        [{
          type: 'CUSTOM',
          agentId,
          payload: JSON.stringify({
            type: 'CUSTOM',
            name: 'ctxmill.message.updated',
            agentId,
            turnId: turn.id,
            conversationId: conversation.id,
            messageId: message.id,
            messageSeq: 0,
            messageRevision: 1,
            role: 'assistant',
            content: '',
            parts: staged?.parts,
            toolCalls: staged?.toolCalls,
            timestamp: 10,
          }),
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          sourceType: 'message.updated',
          sourcePayload: '{}',
        }],
        {
          messageId: message.id,
          targetRevision: 1,
        },
      );

      expect(await repo.getMessagesPendingCanonicalPublish()).toEqual([]);
      expect((await repo.getMessages(conversation.id))[0]).toMatchObject({
        messageRevision: 1,
        publishedRevision: 1,
      });
    });

    it('reuses a caller-stable canonical message id without allocating another sequence', async () => {
      const conversation = await repo.createConversation(agentId);
      const turn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
      });
      const input = {
        id: `canonical-${turn.id}-0`,
        agentId,
        conversationId: conversation.id,
        turnId: turn.id,
        role: 'assistant' as const,
        content: 'durable once',
      };

      const first = await repo.addCanonicalMessage(input);
      const retry = await repo.addCanonicalMessage(input);
      await expect(repo.addCanonicalMessage({
        ...input,
        content: 'different request',
      })).rejects.toThrow(/idempotency conflict/);
      const next = await repo.addCanonicalMessage({
        id: `canonical-${turn.id}-1`,
        agentId,
        conversationId: conversation.id,
        turnId: turn.id,
        role: 'tool',
        content: 'next',
        toolCallId: 'tc-1',
      });

      expect(retry).toEqual(first);
      expect(first.messageSeq).toBe(0);
      expect(next.messageSeq).toBe(1);
      expect((await repo.getTurn(turn.id))?.nextMessageSeq).toBe(2);
    });

    it('atomically fences canonical message mutations across lease takeover', async () => {
      const conversation = await repo.createConversation(agentId);
      const sandboxSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId,
        harnessName: 'claude-agents',
      });
      const turn = await repo.createTurn({
        agentId,
        conversationId: conversation.id,
        sandboxSessionId: sandboxSession.id,
        mode: 'interactive',
      });
      const firstLease = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'message-writer-a',
        leaseDurationMs: 60_000,
      });
      await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: firstLease!.ownerId,
        fenceToken: firstLease!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      });

      const delayedConnection = await createDatabase(resolveTestDatabaseUrl());
      const takeoverConnection = await createDatabase(resolveTestDatabaseUrl());
      const delayedRepository = new DatabaseRepository(delayedConnection.db);
      const takeoverRepository = new DatabaseRepository(takeoverConnection.db);
      const reservations = await Promise.all(
        Array.from({ length: 10 }, () => delayedConnection.pgClient.reserve()),
      );
      const messageId = `canonical-${turn.id}-0`;
      let staleWrite: ReturnType<typeof delayedRepository.addCanonicalMessage> | undefined;

      try {
        staleWrite = delayedRepository.addCanonicalMessage({
          id: messageId,
          agentId,
          conversationId: conversation.id,
          turnId: turn.id,
          role: 'assistant',
          content: 'stale owner content',
        }, {
          ownerId: firstLease!.ownerId,
          fenceToken: firstLease!.fenceToken,
        });
        let staleSettled = false;
        void staleWrite.then(
          () => { staleSettled = true; },
          () => { staleSettled = true; },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(staleSettled).toBe(false);

        await expireTurnDeliveryLease(turn.id);
        const secondLease = await takeoverRepository.claimTurnDeliveryLease({
          turnId: turn.id,
          ownerId: 'message-writer-b',
          leaseDurationMs: 60_000,
        });
        expect(secondLease?.fenceToken).toBe(firstLease!.fenceToken + 1);
        const winner = await takeoverRepository.addCanonicalMessage({
          id: messageId,
          agentId,
          conversationId: conversation.id,
          turnId: turn.id,
          role: 'assistant',
          content: 'takeover owner content',
        }, {
          ownerId: secondLease!.ownerId,
          fenceToken: secondLease!.fenceToken,
        });
        expect(winner).toMatchObject({
          id: messageId,
          messageSeq: 0,
          content: 'takeover owner content',
        });

        for (const reservation of reservations.splice(0)) {
          reservation.release();
        }
        await expect(staleWrite).resolves.toBeUndefined();
        expect((await repo.getMessages(conversation.id)).filter(({ id }) => id === messageId))
          .toEqual([expect.objectContaining({
            messageSeq: 0,
            messageRevision: 0,
            content: 'takeover owner content',
          })]);
        expect((await repo.getTurn(turn.id))?.nextMessageSeq).toBe(1);

        expect(await delayedRepository.stageAssistantMessageUpdate(
          messageId,
          [{ id: 'stale-tool', name: 'bash', args: '{}', status: 'error' }],
          null,
          {
            ownerId: firstLease!.ownerId,
            fenceToken: firstLease!.fenceToken,
          },
        )).toBeUndefined();
        expect((await repo.getMessage(messageId))?.messageRevision).toBe(0);

        expect(await takeoverRepository.stageAssistantMessageUpdate(
          messageId,
          [{ id: 'winner-tool', name: 'bash', args: '{}', status: 'complete' }],
          null,
          {
            ownerId: secondLease!.ownerId,
            fenceToken: secondLease!.fenceToken,
          },
        )).toMatchObject({
          id: messageId,
          messageRevision: 1,
          toolCalls: [
            { id: 'winner-tool', name: 'bash', args: '{}', status: 'complete' },
          ],
        });
      } finally {
        for (const reservation of reservations) {
          reservation.release();
        }
        await Promise.allSettled(staleWrite ? [staleWrite] : []);
        await delayedConnection.close();
        await takeoverConnection.close();
      }
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

    it('deduplicates only explicit recovery startup publications', async () => {
      const secondConnection = await createDatabase(resolveTestDatabaseUrl());
      const secondRepository = new DatabaseRepository(secondConnection.db);
      const baseTime = Date.now();
      const recoveryAgent = await repo.createAgent({
        name: 'recovery-startup-publications',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test recovery startup publication idempotency',
        tools: [],
      });
      const recoveryAgentId = recoveryAgent.id;
      const conversation = await repo.createConversation(recoveryAgentId);
      const firstSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId: recoveryAgentId,
        harnessName: 'langgraph',
      });
      const turn = await repo.createTurn({
        agentId: recoveryAgentId,
        conversationId: conversation.id,
        mode: 'interactive',
      });
      const turnId = turn.id;
      const firstLease = await repo.claimTurnDeliveryLease({
        turnId,
        ownerId: 'recovery-publisher-a',
        leaseDurationMs: 60_000,
      });
      await repo.activateTurnDelivery({
        turnId,
        sandboxSessionId: firstSession.id,
        ownerId: firstLease!.ownerId,
        fenceToken: firstLease!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(firstSession),
      });
      const userFrames = [
        {
          type: 'TEXT_MESSAGE_START',
          agentId: recoveryAgentId,
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_START',
            runId: turnId,
            threadId: conversation.id,
            messageId: 'message-once',
            role: 'user',
            timestamp: baseTime + 2,
          }),
          turnId,
          conversationId: conversation.id,
          channel: 'run',
          sourceType: 'user.message',
          sourcePayload: JSON.stringify({
            turnId,
            agentId: recoveryAgentId,
            conversationId: conversation.id,
            messageId: 'message-once',
            content: 'hello',
            timestamp: baseTime + 2,
          }),
        },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          agentId: recoveryAgentId,
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_CONTENT',
            runId: turnId,
            threadId: conversation.id,
            messageId: 'message-once',
            delta: 'hello',
            timestamp: baseTime + 2,
          }),
          turnId,
          conversationId: conversation.id,
          channel: 'run',
        },
        {
          type: 'TEXT_MESSAGE_END',
          agentId: recoveryAgentId,
          payload: JSON.stringify({
            type: 'TEXT_MESSAGE_END',
            runId: turnId,
            threadId: conversation.id,
            messageId: 'message-once',
            timestamp: baseTime + 2,
          }),
          turnId,
          conversationId: conversation.id,
          channel: 'run',
        },
      ];

      try {
        const attempts = await Promise.all([
          repo.saveRecoveryEventBatch(userFrames, {
            turnId,
            sourceType: 'user.message',
            ownerId: firstLease!.ownerId,
            fenceToken: firstLease!.fenceToken,
          }),
          secondRepository.saveRecoveryEventBatch(userFrames, {
            turnId,
            sourceType: 'user.message',
            ownerId: firstLease!.ownerId,
            fenceToken: firstLease!.fenceToken,
          }),
        ]);
        expect(attempts.map((seqs) => seqs.length).sort()).toEqual([0, 3]);
        expect((await repo.getTurnFrames(turnId)).map(({ type }) => type)).toEqual([
          'TEXT_MESSAGE_START',
          'TEXT_MESSAGE_CONTENT',
          'TEXT_MESSAGE_END',
        ]);

        const runStartedFrames = [{
          type: 'RUN_STARTED',
          agentId: recoveryAgentId,
          payload: JSON.stringify({
            type: 'RUN_STARTED',
            runId: turnId,
            threadId: conversation.id,
            timestamp: baseTime + 10_002,
          }),
          turnId,
          conversationId: conversation.id,
          channel: 'run',
          sourceType: 'turn.started',
          sourcePayload: `{"turnId":"${turnId}"}`,
        }];
        await expireTurnDeliveryLease(turnId);
        const secondLease = await secondRepository.claimTurnDeliveryLease({
          turnId,
          ownerId: 'recovery-publisher-b',
          leaseDurationMs: 60_000,
        });

        expect(await repo.saveRecoveryEventBatch(runStartedFrames, {
          turnId,
          sourceType: 'turn.started',
          ownerId: firstLease!.ownerId,
          fenceToken: firstLease!.fenceToken,
        })).toEqual([]);
        expect(await secondRepository.saveRecoveryEventBatch(runStartedFrames, {
          turnId,
          sourceType: 'turn.started',
          ownerId: secondLease!.ownerId,
          fenceToken: secondLease!.fenceToken,
        })).toHaveLength(1);
        expect(await repo.saveRecoveryEventBatch(runStartedFrames, {
          turnId,
          sourceType: 'turn.started',
          ownerId: secondLease!.ownerId,
          fenceToken: secondLease!.fenceToken,
        })).toEqual([]);

        const repeatedCustom = {
          type: 'custom.repeated',
          agentId: recoveryAgentId,
          payload: '{"value":1}',
          turnId,
          conversationId: 'conv-recovery-once',
          channel: 'custom',
          sourceType: 'custom.repeated',
          sourcePayload: '{"value":1}',
        };
        await expect(secondRepository.saveRecoveryEventBatch([repeatedCustom], {
          turnId,
          sourceType: 'custom.repeated' as never,
          ownerId: secondLease!.ownerId,
          fenceToken: secondLease!.fenceToken,
        })).rejects.toThrow(/only supports user\.message and turn\.started/);
        expect(await repo.saveEventBatch([repeatedCustom])).toHaveLength(1);
        expect(await repo.saveEventBatch([repeatedCustom])).toHaveLength(1);
      } finally {
        await secondConnection.close();
      }
    });

    it('rejects a recovery publication whose lease expires while waiting for the event head', async () => {
      const expiringAgent = await repo.createAgent({
        name: 'expiring-recovery-publisher',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test recovery publication fencing',
        tools: [],
      });
      const conversation = await repo.createConversation(expiringAgent.id);
      const sandboxSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId: expiringAgent.id,
        harnessName: 'langgraph',
      });
      const turn = await repo.createTurn({
        agentId: expiringAgent.id,
        conversationId: conversation.id,
        mode: 'interactive',
      });
      const claimedAt = Date.now();
      const lease = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'expiring-reconciler',
        leaseDurationMs: 250,
      });
      expect(await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: lease!.ownerId,
        fenceToken: lease!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(sandboxSession),
      })).toBe(true);
      await repo.saveEventBatch([{
        type: 'recovery.head.created',
        agentId: expiringAgent.id,
        payload: '{"created":true}',
        channel: 'system',
      }]);

      const delayedConnection = await createDatabase(resolveTestDatabaseUrl());
      const delayedRepository = new DatabaseRepository(delayedConnection.db);
      const gateConnection = await testDb.conn.pgClient.reserve();
      let publication: Promise<number[]> | undefined;
      let gateTransactionOpen = false;
      try {
        await gateConnection`BEGIN`;
        gateTransactionOpen = true;
        await gateConnection`
          SELECT agent_id
          FROM agent_event_heads
          WHERE agent_id = ${expiringAgent.id}
          FOR UPDATE
        `;
        const [waitersBefore] = await testDb.conn.pgClient`
          SELECT count(*)::int AS count
          FROM pg_locks
          WHERE granted = false
        `;

        publication = delayedRepository.saveRecoveryEventBatch([{
          type: 'RUN_STARTED',
          agentId: expiringAgent.id,
          payload: JSON.stringify({
            type: 'RUN_STARTED',
            runId: turn.id,
            threadId: conversation.id,
            timestamp: claimedAt + 1,
          }),
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'run',
          sourceType: 'turn.started',
          sourcePayload: `{"turnId":"${turn.id}"}`,
        }], {
          turnId: turn.id,
          sourceType: 'turn.started',
          ownerId: lease!.ownerId,
          fenceToken: lease!.fenceToken,
        });
        await waitForCondition(
          async () => {
            const [waiters] = await testDb.conn.pgClient`
              SELECT count(*)::int AS count
              FROM pg_locks
              WHERE granted = false
            `;
            return Number(waiters.count) > Number(waitersBefore.count);
          },
          'recovery publication did not wait for the agent event head',
        );
        await waitForCondition(
          async () => Date.now() >= lease!.leaseExpiresAt,
          'recovery publication lease did not expire',
        );

        await gateConnection`COMMIT`;
        gateTransactionOpen = false;
        expect(await publication).toEqual([]);
        expect(await repo.getTurnFrames(turn.id)).toEqual([]);
      } finally {
        if (gateTransactionOpen) {
          await gateConnection`ROLLBACK`;
        }
        await Promise.allSettled([publication ?? Promise.resolve([])]);
        gateConnection.release();
        await delayedConnection.close();
      }
    });

    it('atomically fences message and repeatable event publication across lease takeover', async () => {
      const deliveryAgent = await repo.createAgent({
        name: 'fenced-delivery-publications',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test atomic delivery publication fencing',
        tools: [],
      });
      const conversation = await repo.createConversation(deliveryAgent.id);
      const firstSession = await repo.createSandboxSession({
        conversationId: conversation.id,
        agentId: deliveryAgent.id,
        harnessName: 'langgraph',
      });
      const turn = await repo.createTurn({
        agentId: deliveryAgent.id,
        conversationId: conversation.id,
        mode: 'interactive',
      });
      const firstLease = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'publication-writer-a',
        leaseDurationMs: 60_000,
      });
      await repo.activateTurnDelivery({
        turnId: turn.id,
        sandboxSessionId: firstSession.id,
        ownerId: firstLease!.ownerId,
        fenceToken: firstLease!.fenceToken,
        expectedActiveGeneration: activeGenerationOf(firstSession),
      });
      const message = await repo.addCanonicalMessage({
        id: `canonical-${turn.id}-0`,
        agentId: deliveryAgent.id,
        conversationId: conversation.id,
        turnId: turn.id,
        role: 'assistant',
        content: 'publish me once',
      }, {
        ownerId: firstLease!.ownerId,
        fenceToken: firstLease!.fenceToken,
      });
      await repo.saveEventBatch([{
        type: 'delivery.head.created',
        agentId: deliveryAgent.id,
        payload: '{"created":true}',
        channel: 'system',
      }]);

      const delayedConnection = await createDatabase(resolveTestDatabaseUrl());
      const takeoverConnection = await createDatabase(resolveTestDatabaseUrl());
      const delayedRepository = new DatabaseRepository(delayedConnection.db);
      const takeoverRepository = new DatabaseRepository(takeoverConnection.db);
      const gateConnection = await testDb.conn.pgClient.reserve();
      const messageFrame = {
        type: 'CUSTOM',
        agentId: deliveryAgent.id,
        payload: JSON.stringify({
          type: 'CUSTOM',
          name: 'ctxmill.message.committed',
          runId: turn.id,
          threadId: conversation.id,
          messageId: message!.id,
          messageSeq: message!.messageSeq,
          role: 'assistant',
          content: message!.content,
          timestamp: message!.createdAt,
        }),
        turnId: turn.id,
        conversationId: conversation.id,
        channel: 'run' as const,
        sourceType: 'message.committed',
        sourcePayload: '{}',
      };
      let stalePublication: Promise<number[]> | undefined;
      let gateTransactionOpen = false;

      try {
        await gateConnection`BEGIN`;
        gateTransactionOpen = true;
        await gateConnection`
          SELECT agent_id
          FROM agent_event_heads
          WHERE agent_id = ${deliveryAgent.id}
          FOR UPDATE
        `;
        const [waitersBefore] = await testDb.conn.pgClient`
          SELECT count(*)::int AS count
          FROM pg_locks
          WHERE granted = false
        `;
        stalePublication = delayedRepository.saveMessageEventBatch(
          [messageFrame],
          {
            messageId: message!.id,
            targetRevision: 0,
          },
          {
            ownerId: firstLease!.ownerId,
            fenceToken: firstLease!.fenceToken,
          },
        );
        await waitForCondition(
          async () => {
            const [waiters] = await testDb.conn.pgClient`
              SELECT count(*)::int AS count
              FROM pg_locks
              WHERE granted = false
            `;
            return Number(waiters.count) > Number(waitersBefore.count);
          },
          'fenced message publication did not wait for the event head',
        );

        await expireTurnDeliveryLease(turn.id);
        const secondLease = await takeoverRepository.claimTurnDeliveryLease({
          turnId: turn.id,
          ownerId: 'publication-writer-b',
          leaseDurationMs: 60_000,
        });

        await gateConnection`COMMIT`;
        gateTransactionOpen = false;
        expect(await stalePublication).toEqual([]);
        expect((await repo.getMessage(message!.id))?.publishedRevision).toBe(-1);
        expect((await repo.getTurnFrames(turn.id)).filter(
          ({ sourceType }) => sourceType === 'message.committed',
        )).toEqual([]);

        expect(await takeoverRepository.saveMessageEventBatch(
          [messageFrame],
          {
            messageId: message!.id,
            targetRevision: 0,
          },
          {
            ownerId: secondLease!.ownerId,
            fenceToken: secondLease!.fenceToken,
          },
        )).toHaveLength(1);

        const repeatableFrame = {
          type: 'tool.progress',
          agentId: deliveryAgent.id,
          payload: '{"progress":1}',
          turnId: turn.id,
          conversationId: conversation.id,
          channel: 'tool' as const,
          sourceType: 'tool.progress',
          sourcePayload: '{"progress":1}',
        };
        expect(await delayedRepository.saveFencedEventBatch([repeatableFrame], {
          ownerId: firstLease!.ownerId,
          fenceToken: firstLease!.fenceToken,
        })).toEqual([]);
        expect(await takeoverRepository.saveFencedEventBatch([repeatableFrame], {
          ownerId: secondLease!.ownerId,
          fenceToken: secondLease!.fenceToken,
        })).toHaveLength(1);
        expect(await takeoverRepository.saveFencedEventBatch([repeatableFrame], {
          ownerId: secondLease!.ownerId,
          fenceToken: secondLease!.fenceToken,
        })).toHaveLength(1);
        expect((await repo.getTurnFrames(turn.id)).filter(
          ({ sourceType }) => sourceType === 'tool.progress',
        )).toHaveLength(2);
      } finally {
        if (gateTransactionOpen) {
          await gateConnection`ROLLBACK`;
        }
        await Promise.allSettled([stalePublication ?? Promise.resolve([])]);
        gateConnection.release();
        await delayedConnection.close();
        await takeoverConnection.close();
      }
    });

    it('accepts fenced event writes only after the turn adopts the claimed owner token', async () => {
      const deliveryAgent = await repo.createAgent({
        name: 'unbound-fenced-delivery',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test unbound delivery fence',
        tools: [],
      });
      const conversation = await repo.createConversation(deliveryAgent.id);
      const turn = await repo.createTurn({
        agentId: deliveryAgent.id,
        conversationId: conversation.id,
        mode: 'background',
      });
      const lease = await repo.claimTurnDeliveryLease({
        turnId: turn.id,
        ownerId: 'unbound-delivery-owner',
        leaseDurationMs: 60_000,
      });

      expect(await repo.saveFencedEventBatch([{
        type: 'delivery.before.activation',
        agentId: deliveryAgent.id,
        payload: '{"allowed":true}',
        turnId: turn.id,
        conversationId: conversation.id,
        channel: 'run',
        sourceType: 'delivery.before.activation',
        sourcePayload: '{"allowed":true}',
      }], {
        ownerId: lease!.ownerId,
        fenceToken: lease!.fenceToken,
      })).toHaveLength(1);
    });

    it('serializes same-agent sequence allocation through commit across PostgreSQL connections', async () => {
      const concurrentAgent = await repo.createAgent({
        name: 'concurrent-frame-writers',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test concurrent event serialization',
        tools: [],
      });
      const writerAgentId = concurrentAgent.id;
      const url = resolveTestDatabaseUrl();
      const connectionA = await createDatabase(url);
      const connectionB = await createDatabase(url);
      const repositoryA = new DatabaseRepository(connectionA.db);
      const repositoryB = new DatabaseRepository(connectionB.db);
      const gateConnection = await testDb.conn.pgClient.reserve();
      const delayedPayload = JSON.stringify({
        type: 'RUN_STARTED',
        runId: `delayed-lower-${writerAgentId}`,
        threadId: `writer-ordering-${writerAgentId}`,
        timestamp: 1,
      });
      const followingPayload = JSON.stringify({
        type: 'RUN_STARTED',
        runId: `following-higher-${writerAgentId}`,
        threadId: `writer-ordering-${writerAgentId}`,
        timestamp: 2,
      });
      let delayedWrite: Promise<number[]> | undefined;
      let followingWrite: Promise<number[]> | undefined;
      let gateTransactionOpen = false;

      await testDb.conn.pgClient.unsafe(`
        CREATE TABLE event_writer_test_gate (
          id INTEGER PRIMARY KEY
        );
        INSERT INTO event_writer_test_gate (id) VALUES (1);
        CREATE FUNCTION block_delayed_event_writer() RETURNS trigger AS $$
        BEGIN
          IF NEW.payload = '${delayedPayload}' THEN
            PERFORM id FROM event_writer_test_gate WHERE id = 1 FOR UPDATE;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER block_delayed_event_writer
        BEFORE INSERT ON event_store
        FOR EACH ROW EXECUTE FUNCTION block_delayed_event_writer();
      `);

      try {
        await gateConnection`BEGIN`;
        gateTransactionOpen = true;
        await gateConnection`
          SELECT id FROM event_writer_test_gate WHERE id = 1 FOR UPDATE
        `;
        const [before] = await testDb.conn.pgClient`
          SELECT last_value::int AS last_value, is_called FROM event_store_seq_seq
        `;

        delayedWrite = repositoryA.saveEventBatch([{
          type: 'RUN_STARTED',
          agentId: writerAgentId,
          payload: delayedPayload,
          channel: 'run',
        }]);
        await waitForCondition(
          async () => {
            const [sequence] = await testDb.conn.pgClient`
              SELECT last_value::int AS last_value, is_called FROM event_store_seq_seq
            `;
            return Number(sequence.last_value) > Number(before.last_value)
              || (!before.is_called && sequence.is_called);
          },
          'delayed writer never allocated its lower sequence',
        );
        const [waitersBeforeFollowingWriter] = await testDb.conn.pgClient`
          SELECT count(*)::int AS count
          FROM pg_locks
          WHERE granted = false
        `;

        followingWrite = repositoryB.saveEventBatch([{
          type: 'RUN_STARTED',
          agentId: writerAgentId,
          payload: followingPayload,
          channel: 'run',
        }]);
        await waitForCondition(
          async () => {
            const [waiters] = await testDb.conn.pgClient`
              SELECT count(*)::int AS count
              FROM pg_locks
              WHERE granted = false
            `;
            return Number(waiters.count)
              > Number(waitersBeforeFollowingWriter.count);
          },
          'higher-sequence writer did not wait for the lower-sequence transaction',
        );

        const committedBeforeRelease = await testDb.conn.pgClient`
          SELECT payload FROM event_store
          WHERE payload IN (${delayedPayload}, ${followingPayload})
        `;
        expect(committedBeforeRelease).toEqual([]);

        await gateConnection`COMMIT`;
        gateTransactionOpen = false;
        const [lowerSeqs, higherSeqs] = await Promise.all([
          delayedWrite,
          followingWrite,
        ]);

        expect(lowerSeqs[0]).toBeLessThan(higherSeqs[0]!);
        expect(
          (await repo.getFramesSince(writerAgentId, lowerSeqs[0]! - 1))
            .filter(({ payload }) =>
              payload === delayedPayload || payload === followingPayload)
            .map(({ payload }) => payload),
        ).toEqual([delayedPayload, followingPayload]);
      } finally {
        if (gateTransactionOpen) {
          await gateConnection`ROLLBACK`;
        }
        await Promise.allSettled([
          delayedWrite ?? Promise.resolve([]),
          followingWrite ?? Promise.resolve([]),
        ]);
        gateConnection.release();
        await testDb.conn.pgClient.unsafe(`
          DROP TRIGGER IF EXISTS block_delayed_event_writer ON event_store;
          DROP FUNCTION IF EXISTS block_delayed_event_writer();
          DROP TABLE IF EXISTS event_writer_test_gate;
        `);
        await connectionA.close();
        await connectionB.close();
      }
    });

    it('does not advance the committed head when a writer aborts after sequence allocation', async () => {
      const abortingAgent = await repo.createAgent({
        name: 'aborting-frame-writer',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test aborted event serialization',
        tools: [],
      });
      const baselinePayload = JSON.stringify({
        type: 'RUN_STARTED',
        runId: `abort-baseline-${abortingAgent.id}`,
        threadId: `writer-abort-${abortingAgent.id}`,
        timestamp: 1,
      });
      const [baselineSeq] = await repo.saveEventBatch([{
        type: 'RUN_STARTED',
        agentId: abortingAgent.id,
        payload: baselinePayload,
        channel: 'run',
      }]);
      const rejectedPayload = JSON.stringify({
        type: 'TEXT_MESSAGE_CONTENT',
        runId: `abort-after-sequence-${abortingAgent.id}`,
        threadId: `writer-abort-${abortingAgent.id}`,
        messageId: `message-${abortingAgent.id}`,
        delta: 'must roll back',
        timestamp: 2,
      });
      const committedBeforeAbort = await repo.getLatestEventSeq(abortingAgent.id);
      const [sequenceBeforeAbort] = await testDb.conn.pgClient`
        SELECT last_value::int AS last_value FROM event_store_seq_seq
      `;

      await testDb.conn.pgClient.unsafe(`
        CREATE FUNCTION reject_aborted_event_writer() RETURNS trigger AS $$
        BEGIN
          IF NEW.payload = '${rejectedPayload}' THEN
            RAISE EXCEPTION 'intentional event writer abort';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_aborted_event_writer
        BEFORE INSERT ON event_store
        FOR EACH ROW EXECUTE FUNCTION reject_aborted_event_writer();
      `);

      try {
        await expect(repo.saveEventBatch([{
          type: 'TEXT_MESSAGE_CONTENT',
          agentId: abortingAgent.id,
          payload: rejectedPayload,
          channel: 'run',
        }])).rejects.toThrow();

        const [sequenceAfterAbort] = await testDb.conn.pgClient`
          SELECT last_value::int AS last_value FROM event_store_seq_seq
        `;
        expect(Number(sequenceAfterAbort.last_value))
          .toBeGreaterThan(Number(sequenceBeforeAbort.last_value));
        expect(await repo.getLatestEventSeq(abortingAgent.id))
          .toBe(committedBeforeAbort);
        expect(committedBeforeAbort).toBe(baselineSeq);
        expect(
          (await repo.getFramesSince(abortingAgent.id, 0))
            .map(({ payload }) => payload),
        ).not.toContain(rejectedPayload);
      } finally {
        await testDb.conn.pgClient.unsafe(`
          DROP TRIGGER IF EXISTS reject_aborted_event_writer ON event_store;
          DROP FUNCTION IF EXISTS reject_aborted_event_writer();
        `);
      }

      const recoveryPayload = JSON.stringify({
        type: 'RUN_FINISHED',
        runId: `abort-recovery-${abortingAgent.id}`,
        threadId: `writer-abort-${abortingAgent.id}`,
        timestamp: 3,
      });
      const [recoverySeq] = await repo.saveEventBatch([{
        type: 'RUN_FINISHED',
        agentId: abortingAgent.id,
        payload: recoveryPayload,
        channel: 'run',
      }]);
      expect(recoverySeq).toBeGreaterThan(committedBeforeAbort);
      expect(await repo.getLatestEventSeq(abortingAgent.id)).toBe(recoverySeq);
    });

    it('does not block another agent behind a delayed per-agent writer', async () => {
      const delayedAgent = await repo.createAgent({
        name: 'delayed-agent-writer',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test per-agent event serialization',
        tools: [],
      });
      const parallelAgent = await repo.createAgent({
        name: 'parallel-agent-writer',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-test' }),
        systemPrompt: 'test independent event serialization',
        tools: [],
      });
      const url = resolveTestDatabaseUrl();
      const delayedConnection = await createDatabase(url);
      const parallelConnection = await createDatabase(url);
      const delayedRepository = new DatabaseRepository(delayedConnection.db);
      const parallelRepository = new DatabaseRepository(parallelConnection.db);
      const gateConnection = await testDb.conn.pgClient.reserve();
      const delayedPayload = JSON.stringify({
        type: 'RUN_STARTED',
        runId: `delayed-agent-${delayedAgent.id}`,
        threadId: `per-agent-writer-${delayedAgent.id}`,
        timestamp: 1,
      });
      const parallelPayload = JSON.stringify({
        type: 'RUN_STARTED',
        runId: `parallel-agent-${parallelAgent.id}`,
        threadId: `per-agent-writer-${parallelAgent.id}`,
        timestamp: 1,
      });
      let delayedWrite: Promise<number[]> | undefined;
      let parallelWrite: Promise<number[]> | undefined;
      let gateTransactionOpen = false;

      await testDb.conn.pgClient.unsafe(`
        CREATE TABLE per_agent_writer_test_gate (
          id INTEGER PRIMARY KEY
        );
        INSERT INTO per_agent_writer_test_gate (id) VALUES (1);
        CREATE FUNCTION block_one_agent_writer() RETURNS trigger AS $$
        BEGIN
          IF NEW.payload = '${delayedPayload}' THEN
            PERFORM id FROM per_agent_writer_test_gate WHERE id = 1 FOR UPDATE;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER block_one_agent_writer
        BEFORE INSERT ON event_store
        FOR EACH ROW EXECUTE FUNCTION block_one_agent_writer();
      `);

      try {
        await gateConnection`BEGIN`;
        gateTransactionOpen = true;
        await gateConnection`
          SELECT id FROM per_agent_writer_test_gate WHERE id = 1 FOR UPDATE
        `;
        const [sequenceBeforeDelayedWrite] = await testDb.conn.pgClient`
          SELECT last_value::int AS last_value, is_called FROM event_store_seq_seq
        `;

        delayedWrite = delayedRepository.saveEventBatch([{
          type: 'RUN_STARTED',
          agentId: delayedAgent.id,
          payload: delayedPayload,
          channel: 'run',
        }]);
        await waitForCondition(
          async () => {
            const [sequence] = await testDb.conn.pgClient`
              SELECT last_value::int AS last_value, is_called FROM event_store_seq_seq
            `;
            return Number(sequence.last_value)
              > Number(sequenceBeforeDelayedWrite.last_value)
              || (
                !sequenceBeforeDelayedWrite.is_called
                && sequence.is_called
              );
          },
          'delayed agent writer never reached the insert gate',
        );

        parallelWrite = parallelRepository.saveEventBatch([{
          type: 'RUN_STARTED',
          agentId: parallelAgent.id,
          payload: parallelPayload,
          channel: 'run',
        }]);
        await waitForCondition(
          async () => {
            const [committed] = await testDb.conn.pgClient`
              SELECT count(*)::int AS count
              FROM event_store
              WHERE payload = ${parallelPayload}
            `;
            return Number(committed.count) === 1;
          },
          'another agent was blocked behind the delayed per-agent writer',
        );
        const [parallelSeq] = await parallelWrite;

        expect(await parallelRepository.getLatestEventSeq(parallelAgent.id))
          .toBe(parallelSeq);
        expect(await delayedRepository.getLatestEventSeq(delayedAgent.id))
          .toBe(0);

        await gateConnection`COMMIT`;
        gateTransactionOpen = false;
        const [delayedSeq] = await delayedWrite;
        expect(await delayedRepository.getLatestEventSeq(delayedAgent.id))
          .toBe(delayedSeq);
      } finally {
        if (gateTransactionOpen) {
          await gateConnection`ROLLBACK`;
        }
        await Promise.allSettled([
          delayedWrite ?? Promise.resolve([]),
          parallelWrite ?? Promise.resolve([]),
        ]);
        gateConnection.release();
        await testDb.conn.pgClient.unsafe(`
          DROP TRIGGER IF EXISTS block_one_agent_writer ON event_store;
          DROP FUNCTION IF EXISTS block_one_agent_writer();
          DROP TABLE IF EXISTS per_agent_writer_test_gate;
        `);
        await delayedConnection.close();
        await parallelConnection.close();
      }
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

      const fixedBoundary = await repo.getFramesSince(agentId, 0, {
        channels: ['run'],
        throughSeq: runOnly[0]!.seq,
      });
      expect(fixedBoundary.map((row) => row.type)).toEqual(['RUN_STARTED']);
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

  // --- Budget spend aggregation ---

  describe('Model gateway reconciliation', () => {
    it('leases, attaches, projects, and deduplicates spend transactions atomically', async () => {
      const agent = await repo.createAgent({
        name: 'Gateway Reconciliation Agent',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.4-mini',
        }),
        systemPrompt: 'test',
        tools: [],
      });
      const conversation = await repo.createConversation(agent.id);
      const correlationId = 'ct_0123456789abcdef0123456789abcdef';
      const now = Date.now();
      const turn = await repo.createTurn({
        agentId: agent.id,
        conversationId: conversation.id,
        mode: 'interactive',
        status: 'running',
        startedAt: now - 10_000,
        gatewayCorrelationId: correlationId,
        gatewayProfile: 'default',
        gatewayRevision: 'dev1-r1',
        gatewayMode: 'gateway_only',
      });
      await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: now - 5_000,
        error: null,
        status: 'completed',
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
        usage: {
          inputTokens: 9,
          outputTokens: 4,
          totalTokens: 13,
          modelCalls: { observed: 0, costKnown: 0, expected: null },
          cost: {
            totalUsd: null,
            knownUsd: 0,
            coverage: 'pending',
          },
        },
      });

      const lease = await repo.claimModelGatewayReconciliationLease({
        gatewayProfile: 'default',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-a',
        nowMs: now,
        leaseMs: 30_000,
      });
      expect(lease).toEqual({ fenceToken: 1, watermarkMs: 0 });
      await expect(repo.claimModelGatewayReconciliationLease({
        gatewayProfile: 'default',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-b',
        nowMs: now + 1,
        leaseMs: 30_000,
      })).resolves.toBeUndefined();

      const spend = {
        transactionId: 'gateway-tx-1',
        correlationId,
        requestedModel: 'gpt-5.4-mini',
        resolvedModel: 'openai/gpt-5.4-mini',
        provider: 'openai',
        status: 'success',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 2,
        reasoningTokens: 1,
        costUsd: 0.02,
        costState: 'priced' as const,
        startedAt: now - 9_000,
        endedAt: now - 8_000,
      };
      const first = await repo.reconcileModelGatewaySpend({
        gatewayProfile: 'default',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-a',
        fenceToken: lease!.fenceToken,
        nowMs: now + 100,
        processedThroughMs: now,
        settleBeforeMs: now,
        records: [spend],
        invalid: [],
      });
      expect(first).toEqual({
        attached: 1,
        quarantined: 0,
        affectedTurnIds: [turn.id],
        usageChanges: [{
          turnId: turn.id,
          agentId: agent.id,
          previousUsage: {
            inputTokens: 9,
            outputTokens: 4,
            totalTokens: 13,
            modelCalls: { observed: 0, costKnown: 0, expected: null },
            cost: {
              totalUsd: null,
              knownUsd: 0,
              coverage: 'pending',
            },
          },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            modelCalls: { observed: 1, costKnown: 1, expected: null },
            cost: {
              totalUsd: 0.02,
              knownUsd: 0.02,
              coverage: 'complete',
            },
          },
        }],
        watermarkMs: now,
      });
      expect(await repo.getTurn(turn.id)).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 0.02,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          modelCalls: { observed: 1, costKnown: 1, expected: null },
          cost: {
            totalUsd: 0.02,
            knownUsd: 0.02,
            coverage: 'complete',
          },
        },
      });

      const secondLease = await repo.claimModelGatewayReconciliationLease({
        gatewayProfile: 'default',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-b',
        nowMs: now + 200,
        leaseMs: 30_000,
      });
      const second = await repo.reconcileModelGatewaySpend({
        gatewayProfile: 'default',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-b',
        fenceToken: secondLease!.fenceToken,
        nowMs: now + 300,
        processedThroughMs: now + 200,
        settleBeforeMs: now,
        records: [spend],
        invalid: [],
      });
      expect(second.attached).toBe(1);
      expect(second.usageChanges).toEqual([]);
      expect(await repo.getTurn(turn.id)).toMatchObject({
        costUsd: 0.02,
        usage: {
          cost: { totalUsd: 0.02, knownUsd: 0.02, coverage: 'complete' },
        },
      });
      const attempts = await testDb.conn.pgClient`
        SELECT count(*)::int AS count
        FROM model_call_attempt_usage
        WHERE gateway_transaction_id = 'gateway-tx-1'
      `;
      expect(attempts).toEqual([{ count: 1 }]);
    });

    it('quarantines unknown correlations and attaches them when the turn appears later', async () => {
      const correlationId = 'ct_fedcba9876543210fedcba9876543210';
      const now = Date.now();
      const spend = {
        transactionId: 'gateway-orphan-tx',
        correlationId,
        requestedModel: 'gpt-5.4-mini',
        status: 'success',
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        costUsd: 0.001,
        costState: 'priced' as const,
        startedAt: now - 100,
        endedAt: now - 50,
      };
      const firstLease = await repo.claimModelGatewayReconciliationLease({
        gatewayProfile: 'orphan-profile',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-a',
        nowMs: now,
        leaseMs: 30_000,
      });
      const first = await repo.reconcileModelGatewaySpend({
        gatewayProfile: 'orphan-profile',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-a',
        fenceToken: firstLease!.fenceToken,
        nowMs: now + 1,
        processedThroughMs: now,
        settleBeforeMs: now,
        records: [spend],
        invalid: [],
      });
      expect(first.quarantined).toBe(1);

      const agent = await repo.createAgent({
        name: 'Gateway Orphan Recovery Agent',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.4-mini',
        }),
        systemPrompt: 'test',
        tools: [],
      });
      const conversation = await repo.createConversation(agent.id);
      const turn = await repo.createTurn({
        agentId: agent.id,
        conversationId: conversation.id,
        mode: 'interactive',
        status: 'running',
        gatewayCorrelationId: correlationId,
        gatewayProfile: 'orphan-profile',
        gatewayRevision: 'dev1-r1',
        gatewayMode: 'gateway_only',
      });
      await repo.finalizeTurnIfOpen(turn.id, {
        completedAt: now,
        error: null,
        status: 'completed',
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
      });
      const secondLease = await repo.claimModelGatewayReconciliationLease({
        gatewayProfile: 'orphan-profile',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-b',
        nowMs: now + 2,
        leaseMs: 30_000,
      });
      await repo.reconcileModelGatewaySpend({
        gatewayProfile: 'orphan-profile',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-b',
        fenceToken: secondLease!.fenceToken,
        nowMs: now + 3,
        processedThroughMs: now + 2,
        settleBeforeMs: now + 1,
        records: [spend],
        invalid: [],
      });
      const quarantine = await testDb.conn.pgClient`
        SELECT count(*)::int AS count
        FROM model_gateway_spend_quarantine
        WHERE gateway_transaction_id = 'gateway-orphan-tx'
      `;
      expect(quarantine).toEqual([{ count: 0 }]);
      expect(await repo.getTurn(turn.id)).toMatchObject({
        costUsd: 0.001,
      });
    });

    it('summarizes quarantined transactions by reason with recency', async () => {
      const now = Date.now();
      const profile = 'quarantine-summary-profile';
      const lease = await repo.claimModelGatewayReconciliationLease({
        gatewayProfile: profile,
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-q',
        nowMs: now,
        leaseMs: 30_000,
      });
      await repo.reconcileModelGatewaySpend({
        gatewayProfile: profile,
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-q',
        fenceToken: lease!.fenceToken,
        nowMs: now + 1,
        processedThroughMs: now,
        settleBeforeMs: now,
        records: [{
          transactionId: 'summary-orphan-tx',
          correlationId: 'ct_0123456789abcdef0123456789abcdef',
          requestedModel: 'gpt-5.4-mini',
          status: 'success',
          inputTokens: 2,
          outputTokens: 1,
          totalTokens: 3,
          costUsd: 0.001,
          costState: 'priced' as const,
          startedAt: now - 100,
          endedAt: now - 50,
        }],
        invalid: [
          {
            transactionId: 'summary-invalid-tx-1',
            reason: 'missing_correlation',
            safeFields: { model: 'gpt-5.4-mini', status: 'success' },
          },
          {
            transactionId: 'summary-invalid-tx-2',
            reason: 'missing_correlation',
            safeFields: { status: 'success' },
          },
        ],
      });

      const summary = await repo.getModelGatewayQuarantineSummary(profile, {
        recentSinceMs: now - 1_000,
        limit: 2,
      });
      expect(summary.reasons).toEqual([
        expect.objectContaining({
          reason: 'missing_correlation',
          total: 2,
          recentTotal: 2,
        }),
        expect.objectContaining({
          reason: 'unknown_turn',
          total: 1,
          recentTotal: 1,
        }),
      ]);
      expect(summary.recent).toHaveLength(2);
      expect(summary.recent[0]).toMatchObject({
        occurrences: 1,
        sanitizedPayload: expect.objectContaining({ status: 'success' }),
      });

      const stale = await repo.getModelGatewayQuarantineSummary(profile, {
        recentSinceMs: now + 60_000,
        limit: 10,
      });
      expect(stale.reasons.map((row) => row.recentTotal)).toEqual([0, 0]);
    });
  });

  describe('Budget spend queries', () => {
    it('aggregates spend per bucket and for single buckets via tag containment', async () => {
      const agent = await repo.createAgent({
        name: 'Budget Spend Agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'test',
        tools: [],
      });
      const conversation = await repo.createConversation(agent.id, undefined, { bu: 'spendtest' });
      expect(conversation.tags).toEqual({ bu: 'spendtest' });

      const now = Date.now();
      const mkTurn = async (user: string | undefined, tokens: number) => {
        const turn = await repo.createTurn({
          agentId: agent.id,
          conversationId: conversation.id,
          mode: 'background',
          status: 'completed',
          startedAt: now,
          tags: { bu: 'spendtest', ...(user ? { user } : {}) },
        });
        await repo.finalizeTurnIfOpen(turn.id, {
          completedAt: now,
          error: null,
          status: 'completed',
          inputTokens: tokens - 5,
          outputTokens: 5,
          totalTokens: tokens,
          costUsd: tokens / 1000,
        });
      };
      await mkTurn('alice', 100);
      await mkTurn('alice', 50);
      await mkTurn('bob', 30);
      await mkTurn(undefined, 7);

      // Grouped query (the GROUP BY alias regression found on dev2).
      const buckets = await repo.getBudgetSpendBuckets({ bu: 'spendtest' }, now - 1000, 'user');
      const byBucket = new Map(buckets.map((b) => [b.bucket, b]));
      expect(byBucket.get('alice')?.totalTokens).toBe(150);
      expect(byBucket.get('alice')?.turns).toBe(2);
      expect(byBucket.get('bob')?.totalTokens).toBe(30);
      expect(byBucket.get(null)?.totalTokens).toBe(7);

      // Single-bucket queries used at admission.
      const alice = await repo.getBudgetSpend({ bu: 'spendtest' }, now - 1000, { key: 'user', value: 'alice' });
      expect(alice.totalTokens).toBe(150);
      expect(alice.turns).toBe(2);
      expect(alice.costUsd).toBeCloseTo(0.15, 10);
      const untagged = await repo.getBudgetSpend({ bu: 'spendtest' }, now - 1000, { key: 'user', value: null });
      expect(untagged.totalTokens).toBe(7);
      // Window boundary: nothing before the turns started.
      const later = await repo.getBudgetSpend({ bu: 'spendtest' }, now + 1000);
      expect(later.turns).toBe(0);
      expect(later.totalTokens).toBeNull();
      expect(later.costUsd).toBeNull();
      expect(later.tokenReportedTurnCount).toBe(0);
      expect(later.costReportedTurnCount).toBe(0);
    });

    it('distinguishes reported zero, all missing, and partial coverage', async () => {
      const agent = await repo.createAgent({
        name: 'Budget Coverage Agent',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'test',
        tools: [],
      });
      const conversation = await repo.createConversation(agent.id);
      const now = Date.now();
      const create = async (
        bucket: string,
        usage?: { totalTokens: number; costUsd: number | null },
      ) => {
        const turn = await repo.createTurn({
          agentId: agent.id,
          conversationId: conversation.id,
          mode: 'background',
          status: 'completed',
          startedAt: now,
          tags: { coverage: 'budget', bucket },
        });
        if (usage) {
          await repo.finalizeTurnIfOpen(turn.id, {
            completedAt: now,
            error: null,
            status: 'completed',
            inputTokens: usage.totalTokens,
            outputTokens: 0,
            totalTokens: usage.totalTokens,
            costUsd: usage.costUsd,
          });
        }
      };

      await create('zero', { totalTokens: 0, costUsd: 0 });
      await create('missing');
      await create('partial', { totalTokens: 25, costUsd: null });
      await create('partial');

      const buckets = await repo.getBudgetSpendBuckets(
        { coverage: 'budget' },
        now - 1000,
        'bucket',
      );
      const byBucket = new Map(buckets.map((row) => [row.bucket, row]));

      expect(byBucket.get('zero')).toMatchObject({
        totalTokens: 0,
        costUsd: 0,
        turns: 1,
        tokenReportedTurnCount: 1,
        costReportedTurnCount: 1,
      });
      expect(byBucket.get('missing')).toMatchObject({
        totalTokens: null,
        costUsd: null,
        turns: 1,
        tokenReportedTurnCount: 0,
        costReportedTurnCount: 0,
      });
      expect(byBucket.get('partial')).toMatchObject({
        totalTokens: 25,
        costUsd: null,
        turns: 2,
        tokenReportedTurnCount: 1,
        costReportedTurnCount: 0,
      });
    });
  });
});
