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
    await testDb.close();
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
        'agent_runs',
        'agent_versions',
        'agents',
        'callback_outbox',
        'conversations',
        'event_store',
        'event_triggers',
        'execution_traces',
        'feedback_signals',
        'knowledge_items',
        'messages',
        'pending_interrupts',
        'sandbox_sessions',
        'scheduled_events',
        'secrets',
        'suspended_runs',
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
      const columnNames = columns.map((column: { column_name: string }) => column.column_name);

      expect(columnNames).toContain('harness');
      expect(columnNames).toContain('harness_config');
      expect(columnNames).not.toContain('model');
      expect(columnNames).not.toContain('model_config');
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
        runId: 'run-1',
        taskDescription: 'Test task',
        steps: [{ ordinal: 0, type: 'llm_call', content: 'hello', durationMs: 100 }],
        outcome: 'success',
      });
      expect(trace.id).toBeDefined();
      expect(trace.taskDescription).toBe('Test task');

      const traces = await repo.getTraces('agent-1');
      expect(traces).toHaveLength(1);
      expect(traces[0].runId).toBe('run-1');
    });
  });

  // --- Feedback Signals ---

  describe('Feedback Signals', () => {
    it('should save and retrieve feedback signals', async () => {
      const trace = await repo.saveTrace({
        agentId: 'agent-1',
        runId: 'run-1',
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

      await repo.updateSandboxSessionStatus(created.id, 'FROZEN', {
        containerName: 'frozen-container',
        checkpointRef: 'checkpoint-ref-1',
      });

      const fetched = await repo.getSandboxSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('FROZEN');
      expect(fetched!.containerName).toBe('frozen-container');
      expect(fetched!.checkpointRef).toBe('checkpoint-ref-1');
    });

    it('should list active and frozen sandbox sessions', async () => {
      const active = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
      });
      const frozen = await repo.createSandboxSession({
        conversationId,
        agentId,
        harnessName: 'langgraph',
        status: 'FROZEN',
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
      expect(sessionIds.has(frozen.id)).toBe(true);
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
});
