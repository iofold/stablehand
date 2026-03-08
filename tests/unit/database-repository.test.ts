import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../../packages/ctxmill/src/database/connection.js';
import { runMigrations } from '../../packages/ctxmill/src/database/migrations.js';
import { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';

describe('DatabaseRepository', () => {
  let sqliteClose: () => void;
  let repo: DatabaseRepository;
  let sqliteRaw: import('better-sqlite3').Database;

  beforeEach(() => {
    const { db, sqlite } = createDatabase(':memory:');
    sqliteRaw = sqlite;
    runMigrations(sqlite);
    repo = new DatabaseRepository(db);
    sqliteClose = () => sqlite.close();
  });

  afterEach(() => {
    sqliteClose();
  });

  // --- Migrations ---

  describe('Migrations', () => {
    it('should create all expected tables', () => {
      const tables = sqliteRaw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name).sort();
      expect(tableNames).toEqual([
        'agent_runs',
        'agents',
        'conversations',
        'execution_traces',
        'feedback_signals',
        'knowledge_items',
        'messages',
      ]);
    });

    it('CFG-08: should run migrations idempotently (twice without errors)', () => {
      // Migrations already ran in beforeEach; run again
      expect(() => runMigrations(sqliteRaw)).not.toThrow();

      // Tables still exist and work
      const tables = sqliteRaw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      expect(tables.length).toBe(7);
    });
  });

  // --- Agents CRUD (CFG-05) ---

  describe('CFG-05: Agent CRUD', () => {
    const agentData = {
      name: 'Test Agent',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a test agent.',
      tools: ['bash', 'read_file'],
    };

    it('should create an agent and assign an id', async () => {
      const agent = await repo.createAgent(agentData);
      expect(agent.id).toBeDefined();
      expect(typeof agent.id).toBe('string');
      expect(agent.name).toBe('Test Agent');
      expect(agent.model).toBe('claude-sonnet-4-6');
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
      await repo.createAgent(agentData);
      await repo.createAgent({ ...agentData, name: 'Agent 2' });
      const agents = await repo.listAgents();
      expect(agents).toHaveLength(2);
    });

    it('should update an agent', async () => {
      const created = await repo.createAgent(agentData);
      const updated = await repo.updateAgent(created.id, { name: 'Updated Name' });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated Name');
      expect(updated!.model).toBe('claude-sonnet-4-6'); // unchanged
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it('should update agent status', async () => {
      const created = await repo.createAgent(agentData);
      expect(created.status).toBe('created');
      const updated = await repo.updateAgentStatus(created.id, 'running');
      expect(updated!.status).toBe('running');
    });

    it('should delete an agent', async () => {
      const created = await repo.createAgent(agentData);
      await repo.deleteAgent(created.id);
      const fetched = await repo.getAgent(created.id);
      expect(fetched).toBeUndefined();
    });
  });

  // --- Conversations & Messages (CFG-05) ---

  describe('CFG-05: Conversations and Messages', () => {
    let agentId: string;

    beforeEach(async () => {
      const agent = await repo.createAgent({
        name: 'Conv Agent',
        model: 'claude-sonnet-4-6',
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
      await repo.createConversation(agentId);
      await repo.createConversation(agentId);
      const convos = await repo.getConversationsForAgent(agentId);
      expect(convos).toHaveLength(2);
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
});
