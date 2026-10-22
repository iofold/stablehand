/**
 * ctx-b3ky: a graceful orchestrator shutdown must not decide pending HITL
 * approvals. InterruptManager.shutdown() releases this process's in-memory
 * waiters only; the Postgres rows stay pending so the next process reloads
 * them and the human's eventual decision still resumes the turn.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InterruptManager } from '../../packages/stablehand/src/orchestrator/interrupt.js';
import type { DatabaseRepository } from '../../packages/stablehand/src/database/repository.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

async function createTurnFixture(repo: DatabaseRepository, name: string) {
  const agent = await repo.createAgent({
    name,
    harness: 'langgraph',
    harnessConfig: '{}',
    systemPrompt: 'test',
    tools: [],
  });
  const conversation = await repo.createConversation(agent.id);
  const sandboxSession = await repo.createSandboxSession({
    conversationId: conversation.id,
    agentId: agent.id,
    harnessName: 'langgraph',
  });
  const turn = await repo.createTurn({
    sandboxSessionId: sandboxSession.id,
    agentId: agent.id,
    conversationId: conversation.id,
    mode: 'interactive',
  });
  return { agentId: agent.id, sandboxSessionId: sandboxSession.id, turnId: turn.id };
}

describe('InterruptManager shutdown durability (ctx-b3ky)', () => {
  let testDb: TestDb;
  let repo: DatabaseRepository;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = testDb.repo;
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it('keeps pending approvals pending across shutdown and reloads them in a fresh manager', async () => {
    const rehydrated = await createTurnFixture(repo, 'Shutdown rehydrated agent');
    const live = await createTurnFixture(repo, 'Shutdown live agent');
    const now = Date.now();

    // Written by an earlier process; the booting manager rehydrates it.
    await repo.savePendingInterrupt({
      id: 'interrupt-shutdown-rehydrated',
      turnId: rehydrated.turnId,
      agentId: rehydrated.agentId,
      sandboxSessionId: rehydrated.sandboxSessionId,
      toolCallId: 'approval-rehydrated',
      toolName: 'request-approval',
      args: { reason: 'deploy' },
      timeoutMs: 300_000,
      createdAt: now,
      expiresAt: now + 300_000,
    });

    const firstProcess = new InterruptManager(undefined, repo);
    await firstProcess.loadFromDb();
    expect(firstProcess.hasPendingForTurn(rehydrated.turnId)).toBe(true);

    // A waiter created by this process (persisted via savePendingInterrupt).
    const liveWaiter = firstProcess.waitForApproval(
      live.turnId,
      live.agentId,
      'approval-live',
      'request-approval',
      { reason: 'send email' },
      300_000,
      live.sandboxSessionId,
    );
    await expect.poll(async () => {
      const rows = await repo.getAllPendingInterrupts();
      return rows.some((row) => row.turnId === live.turnId);
    }).toBe(true);

    firstProcess.shutdown();
    await expect(liveWaiter).resolves.toEqual({
      action: 'suspend',
      data: 'Server shutting down',
    });
    // Give any fire-and-forget write a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterShutdown = await repo.getAllPendingInterrupts();
    const byTurn = new Map(afterShutdown.map((row) => [row.turnId, row]));
    for (const turnId of [rehydrated.turnId, live.turnId]) {
      const row = byTurn.get(turnId);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        status: 'pending',
        resolvedAt: null,
        resolvedAction: null,
      });
    }

    const nextProcess = new InterruptManager(undefined, repo);
    await nextProcess.loadFromDb();
    expect(nextProcess.hasPendingForTurn(rehydrated.turnId)).toBe(true);
    expect(nextProcess.hasPendingForTurn(live.turnId)).toBe(true);
    expect(nextProcess.hasLiveWaiterForTurn(live.turnId)).toBe(false);

    nextProcess.shutdown();
  });
});
