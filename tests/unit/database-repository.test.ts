import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CanonicalStreamEventSchema } from '@ctxmill/contracts';
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
        'agent_versions',
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
        'pending_interrupts',
        'sandbox_sessions',
        'secrets',
        'spine_cursors',
        'suspended_sessions',
        'system_settings',
        'tool_request_dedup',
        'trigger_firings',
        'turn_reconciliation_leases',
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

    it('backfills committed heads without failing on orphaned legacy events', async () => {
      const { runMigrations } = await import('../../packages/ctxmill/src/database/migrations.js');
      const orphanAgentId = 'deleted-legacy-agent';
      const orphanPayload = 'orphaned-before-agent-heads';
      await testDb.conn.pgClient`
        INSERT INTO event_store (type, agent_id, payload, created_at)
        VALUES ('RUN_FINISHED', ${orphanAgentId}, ${orphanPayload}, 1)
      `;

      try {
        await expect(runMigrations(testDb.conn.pgClient)).resolves.not.toThrow();
        const orphanHeads = await testDb.conn.pgClient`
          SELECT agent_id
          FROM agent_event_heads
          WHERE agent_id = ${orphanAgentId}
        `;
        expect(orphanHeads).toEqual([]);
      } finally {
        await testDb.conn.pgClient`
          DELETE FROM event_store WHERE payload = ${orphanPayload}
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
      });

      const fetched = await repo.getSandboxSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('CHECKPOINTED');
      expect(fetched!.containerName).toBe('checkpointed-container');
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
        repo.updateSandboxSessionStatus(created.id, 'CHECKPOINTED', undefined, {
          expectedFrom: 'ACTIVE',
        }),
      ).resolves.toBeUndefined();

      const afterCasWrite = await repo.getSandboxSession(created.id);
      expect(afterCasWrite?.status).toBe('CHECKPOINTED');
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
        sandboxSessionId: sessionId,
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
        sandboxSessionId: sessionId,
        agentId,
        checkpointData: { cursor: 10 },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await repo.createCheckpointV2({
        sandboxSessionId: sessionId,
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
        sandboxSessionId: sessionId,
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
        sandboxSessionId: session.id,
        agentId,
        checkpointData: { step: 1 },
      });
      await repo.createCheckpointV2({
        sandboxSessionId: session.id,
        agentId,
        checkpointData: { step: 2 },
      });

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
      const turn = await repo.createTurn({
        sandboxSessionId: sandboxSession.id,
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

      const inProgress = await repo.claimInterruptResumeAttempt({
        id: attempt!.id,
        expectedUpdatedAt: attempt!.updatedAt,
        staleBefore: attempt!.updatedAt - 1,
        claimedAt: attempt!.updatedAt + 1,
      });
      expect(inProgress?.status).toBe('in_progress');
      expect(inProgress?.attempts).toBe(1);

      const failed = await repo.failInterruptResumeAttempt(
        attempt!.id,
        inProgress!.updatedAt,
        inProgress!.updatedAt + 1,
        'restore failed',
      );
      expect(failed?.status).toBe('failed');
      expect(failed?.lastError).toBe('restore failed');

      const actionable = await repo.getActionableInterruptsForAgent(agent.id);
      expect(actionable).toHaveLength(1);
      expect(actionable[0].interrupt.id).toBe('interrupt-resume-1');
      expect(actionable[0].resumeAttempt?.status).toBe('failed');

      const retried = await repo.retryFailedInterruptResumeAttempt(
        failed!.id,
        failed!.updatedAt,
        failed!.updatedAt + 1,
      );
      expect(retried).toBeDefined();
      const retryClaim = await repo.claimInterruptResumeAttempt({
        id: retried!.id,
        expectedUpdatedAt: retried!.updatedAt,
        staleBefore: retried!.updatedAt - 1,
        claimedAt: retried!.updatedAt + 1,
      });
      const completed = await repo.completeInterruptResumeAttempt(
        attempt!.id,
        retryClaim!.updatedAt,
        retryClaim!.updatedAt + 1,
      );
      expect(completed?.status).toBe('completed');
      expect(completed?.completedAt).toBeTypeOf('number');
    });

    it('atomically leases turn reconciliation and permits takeover only after expiry', async () => {
      const { turn } = await createRuntimeTurn('Turn Reconciliation Lease');
      const secondConnection = await createDatabase(resolveTestDatabaseUrl());
      const secondRepository = new DatabaseRepository(secondConnection.db);
      const claimedAt = 10_000;
      const leaseExpiresAt = 20_000;

      try {
        const claims = await Promise.all([
          repo.claimTurnReconciliationLease({
            turnId: turn.id,
            ownerId: 'reconciler-a',
            claimedAt,
            leaseExpiresAt,
          }),
          secondRepository.claimTurnReconciliationLease({
            turnId: turn.id,
            ownerId: 'reconciler-b',
            claimedAt,
            leaseExpiresAt,
          }),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const winner = claims.find((claim) => claim !== undefined)!;
        const takeoverOwner = winner.ownerId === 'reconciler-a'
          ? 'reconciler-b'
          : 'reconciler-a';

        expect(await repo.claimTurnReconciliationLease({
          turnId: turn.id,
          ownerId: takeoverOwner,
          claimedAt: leaseExpiresAt - 1,
          leaseExpiresAt: leaseExpiresAt + 10_000,
        })).toBeUndefined();

        const takeover = await repo.claimTurnReconciliationLease({
          turnId: turn.id,
          ownerId: takeoverOwner,
          claimedAt: leaseExpiresAt,
          leaseExpiresAt: leaseExpiresAt + 10_000,
        });
        expect(takeover).toMatchObject({
          turnId: turn.id,
          ownerId: takeoverOwner,
          leaseExpiresAt: leaseExpiresAt + 10_000,
        });
        expect(await repo.releaseTurnReconciliationLease(
          turn.id,
          winner.ownerId,
        )).toBe(false);
        expect(await repo.releaseTurnReconciliationLease(
          turn.id,
          takeoverOwner,
        )).toBe(true);
      } finally {
        await secondConnection.close();
      }
    });

    it('authorizes queued-turn redispatch only for the live lease owner', async () => {
      const { turn } = await createRuntimeTurn('Turn Reconciliation Admission');
      const claimedAt = 40_000;
      const leaseExpiresAt = 50_000;
      await repo.claimTurnReconciliationLease({
        turnId: turn.id,
        ownerId: 'reconciler-a',
        claimedAt,
        leaseExpiresAt,
      });

      expect(await repo.authorizeQueuedTurnRedispatch(
        turn.id,
        'reconciler-b',
        claimedAt + 1,
      )).toBe(false);
      expect((await repo.getTurn(turn.id))?.status).toBe('queued');

      expect(await repo.authorizeQueuedTurnRedispatch(
        turn.id,
        'reconciler-a',
        claimedAt + 1,
      )).toBe(true);
      expect((await repo.getTurn(turn.id))?.status).toBe('queued');

      expect(await repo.authorizeQueuedTurnRedispatch(
        turn.id,
        'reconciler-a',
        claimedAt + 2,
      )).toBe(true);
    });

    it('does not claim a turn owned by a durable HITL resume workflow', async () => {
      const { agent, sandboxSession, turn } = await createRuntimeTurn('HITL Reconciliation Lease');
      const now = 30_000;
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

      expect(await repo.claimTurnReconciliationLease({
        turnId: turn.id,
        ownerId: 'startup-reconciler',
        claimedAt: now,
        leaseExpiresAt: now + 60_000,
      })).toBeUndefined();

      const resolution = await repo.resolveInterruptWithResumeAttempt(
        'interrupt-reconciliation-lease',
        'approve',
      );
      expect(resolution?.kind).toBe('ready');
      const attempt = resolution?.kind === 'ready'
        ? resolution.resumeAttempt
        : undefined;
      expect(attempt).toBeDefined();
      expect(await repo.claimTurnReconciliationLease({
        turnId: turn.id,
        ownerId: 'startup-reconciler',
        claimedAt: now + 1,
        leaseExpiresAt: now + 60_001,
      })).toBeUndefined();

      const inProgress = await repo.claimInterruptResumeAttempt({
        id: attempt!.id,
        expectedUpdatedAt: attempt!.updatedAt,
        staleBefore: attempt!.updatedAt - 1,
        claimedAt: attempt!.updatedAt + 1,
      });
      expect(inProgress).toBeDefined();
      expect(await repo.claimTurnReconciliationLease({
        turnId: turn.id,
        ownerId: 'startup-reconciler',
        claimedAt: now + 2,
        leaseExpiresAt: now + 60_002,
      })).toBeUndefined();

      const completed = await repo.completeInterruptResumeAttempt(
        attempt!.id,
        inProgress!.updatedAt,
        inProgress!.updatedAt + 1,
      );
      expect(completed?.status).toBe('completed');
      expect(await repo.claimTurnReconciliationLease({
        turnId: turn.id,
        ownerId: 'startup-reconciler',
        claimedAt: now + 3,
        leaseExpiresAt: now + 60_003,
      })).toMatchObject({
        turnId: turn.id,
        ownerId: 'startup-reconciler',
      });
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
      const delayedPayload = `delayed-lower-${writerAgentId}`;
      const followingPayload = `following-higher-${writerAgentId}`;
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
      const [baselineSeq] = await repo.saveEventBatch([{
        type: 'RUN_STARTED',
        agentId: abortingAgent.id,
        payload: `abort-baseline-${abortingAgent.id}`,
        channel: 'run',
      }]);
      const rejectedPayload = `abort-after-sequence-${abortingAgent.id}`;
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

      const [recoverySeq] = await repo.saveEventBatch([{
        type: 'RUN_FINISHED',
        agentId: abortingAgent.id,
        payload: `abort-recovery-${abortingAgent.id}`,
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
      const delayedPayload = `delayed-agent-${delayedAgent.id}`;
      const parallelPayload = `parallel-agent-${parallelAgent.id}`;
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
    });
  });
});
