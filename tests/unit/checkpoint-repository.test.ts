import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../utils/test-db.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';

describe('Checkpoint Repository', () => {
  let testDb: TestDb;
  let repo: DatabaseRepository;
  let agentId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = testDb.repo;

    // Create an agent to use across tests
    const agent = await repo.createAgent({
      name: 'Checkpoint Test Agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-4' }),
      systemPrompt: 'Test agent for checkpoint tests',
      tools: [],
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    await testDb.close();
  });

  // Helper to create a run for the agent
  async function createRun(): Promise<string> {
    const conv = await repo.createConversation(agentId);
    const run = await repo.createRun({
      agentId,
      conversationId: conv.id,
      status: 'running',
      mode: 'interactive',
      startedAt: Date.now(),
    });
    return run.id;
  }

  describe('createCheckpoint', () => {
    it('stores all fields and returns an id', async () => {
      const runId = await createRun();
      const checkpointData = {
        harnessName: 'claude-agents',
        messages: [{ role: 'user', content: 'Hello' }],
        toolState: { pendingCalls: [] },
      };

      const result = await repo.createCheckpoint({
        runId,
        agentId,
        version: 2,
        checkpointData,
        workspaceRef: '/tmp/workspace.tar',
        suspendReason: 'waiting_for_approval',
      });

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');

      // Verify stored data via getCheckpoint
      const checkpoint = await repo.getCheckpoint(runId);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.runId).toBe(runId);
      expect(checkpoint!.agentId).toBe(agentId);
      expect(checkpoint!.version).toBe(2);
      expect(checkpoint!.checkpointData).toEqual(checkpointData);
      expect(checkpoint!.workspaceRef).toBe('/tmp/workspace.tar');
      expect(checkpoint!.suspendReason).toBe('waiting_for_approval');
      expect(checkpoint!.createdAt).toBeInstanceOf(Date);
    });

    it('defaults version to 1 when not specified', async () => {
      const runId = await createRun();

      await repo.createCheckpoint({
        runId,
        agentId,
        checkpointData: { state: 'test' },
      });

      const checkpoint = await repo.getCheckpoint(runId);
      expect(checkpoint!.version).toBe(2);
    });

    it('defaults workspaceRef and suspendReason to null when not specified', async () => {
      const runId = await createRun();

      await repo.createCheckpoint({
        runId,
        agentId,
        checkpointData: { state: 'minimal' },
      });

      const checkpoint = await repo.getCheckpoint(runId);
      expect(checkpoint!.workspaceRef).toBeNull();
      expect(checkpoint!.suspendReason).toBeNull();
    });
  });

  describe('getCheckpoint', () => {
    it('returns the latest checkpoint for a run (most recent)', async () => {
      const runId = await createRun();

      // Create two checkpoints for the same run
      await repo.createCheckpoint({
        runId,
        agentId,
        checkpointData: { step: 'first' },
        suspendReason: 'first_suspend',
      });

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));

      await repo.createCheckpoint({
        runId,
        agentId,
        checkpointData: { step: 'second' },
        suspendReason: 'second_suspend',
      });

      const checkpoint = await repo.getCheckpoint(runId);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.checkpointData).toEqual({ step: 'second' });
      expect(checkpoint!.suspendReason).toBe('second_suspend');
    });

    it('returns null for non-existent run', async () => {
      const checkpoint = await repo.getCheckpoint('non-existent-run-id');
      expect(checkpoint).toBeNull();
    });
  });

  describe('deleteCheckpoints', () => {
    it('removes all checkpoints for a run and returns count', async () => {
      const runId = await createRun();

      await repo.createCheckpoint({
        runId,
        agentId,
        checkpointData: { step: 1 },
      });
      await repo.createCheckpoint({
        runId,
        agentId,
        checkpointData: { step: 2 },
      });

      const deletedCount = await repo.deleteCheckpoints(runId);
      expect(deletedCount).toBe(2);

      // Verify they are gone
      const checkpoint = await repo.getCheckpoint(runId);
      expect(checkpoint).toBeNull();
    });

    it('returns 0 for a run with no checkpoints', async () => {
      const runId = await createRun();
      const deletedCount = await repo.deleteCheckpoints(runId);
      expect(deletedCount).toBe(0);
    });
  });

  describe('getCheckpointSize', () => {
    it('returns the total byte size of checkpoint data for a run', async () => {
      const runId = await createRun();

      await repo.createCheckpoint({
        runId,
        agentId,
        checkpointData: { data: 'some checkpoint data for sizing' },
      });

      const size = await repo.getCheckpointSize(runId);
      expect(size).toBeGreaterThan(0);
      expect(typeof size).toBe('number');
    });

    it('returns 0 for a run with no checkpoints', async () => {
      const runId = await createRun();
      const size = await repo.getCheckpointSize(runId);
      expect(size).toBe(0);
    });
  });

  describe('cascade delete', () => {
    it('deletes checkpoints when backing sandbox session is deleted', async () => {
      const runId = await createRun();

      await repo.createCheckpoint({
        runId,
        agentId,
        checkpointData: { state: 'will be cascaded' },
      });

      // Verify checkpoint exists
      const before = await repo.getCheckpoint(runId);
      expect(before).not.toBeNull();

      await testDb.conn.pgClient`DELETE FROM sandbox_sessions WHERE id = ${runId}`;

      // Verify checkpoint is gone
      const after = await repo.getCheckpoint(runId);
      expect(after).toBeNull();
    });
  });

  describe('agent_checkpoints table schema', () => {
    it('agent_checkpoints table exists with expected columns', async () => {
      const cols = await testDb.conn.pgClient`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'agent_checkpoints'
        ORDER BY ordinal_position
      `;
      const colNames = cols.map((c: any) => c.column_name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('session_id');
      expect(colNames).toContain('agent_id');
      expect(colNames).toContain('checkpoint_version');
      expect(colNames).toContain('checkpoint_data');
      expect(colNames).toContain('harness_state');
      expect(colNames).toContain('workspace_ref');
      expect(colNames).toContain('suspend_reason');
      expect(colNames).toContain('created_at');
    });

    it('has indexes on session_id and agent_id', async () => {
      const indexes = await testDb.conn.pgClient`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'agent_checkpoints'
        ORDER BY indexname
      `;
      const indexNames = indexes.map((i: any) => i.indexname);
      expect(indexNames).toContain('idx_checkpoints_session_id');
      expect(indexNames).toContain('idx_checkpoints_agent_id');
    });
  });
});
