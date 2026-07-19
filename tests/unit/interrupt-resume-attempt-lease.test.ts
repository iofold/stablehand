import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

describe('interrupt resume attempt leases', () => {
  let testDb: TestDb;
  let repo: DatabaseRepository;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = testDb.repo;
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it('claims and reclaims with status-plus-updatedAt compare-and-set ownership', async () => {
    const agent = await repo.createAgent({
      name: 'Interrupt lease agent',
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
    await repo.savePendingInterrupt({
      id: 'interrupt-lease-1',
      turnId: turn.id,
      agentId: agent.id,
      sandboxSessionId: sandboxSession.id,
      toolCallId: 'approval-1',
      toolName: 'request-approval',
      args: {},
      timeoutMs: 60_000,
      createdAt: 500,
      expiresAt: 60_500,
    });
    const resolution = await repo.resolveInterruptWithResumeAttempt(
      'interrupt-lease-1',
      'approve',
    );
    const pending = resolution?.kind === 'ready' ? resolution.resumeAttempt : undefined;
    expect(pending).toBeDefined();

    expect(await repo.getRecoverableInterruptResumeAttempts(pending!.updatedAt - 1, 10))
      .toEqual([expect.objectContaining({ id: pending!.id, status: 'pending' })]);

    const competingClaims = await Promise.all([
      repo.claimInterruptResumeAttempt({
        id: pending!.id,
        expectedUpdatedAt: pending!.updatedAt,
        staleBefore: pending!.updatedAt - 1,
        claimedAt: pending!.updatedAt + 1,
      }),
      repo.claimInterruptResumeAttempt({
        id: pending!.id,
        expectedUpdatedAt: pending!.updatedAt,
        staleBefore: pending!.updatedAt - 1,
        claimedAt: pending!.updatedAt + 2,
      }),
    ]);
    const firstOwner = competingClaims.find((row) => row !== undefined);
    expect(competingClaims.filter((row) => row !== undefined)).toHaveLength(1);
    expect(firstOwner).toMatchObject({ status: 'in_progress', attempts: 1 });
    expect(await repo.getRecoverableInterruptResumeAttempts(firstOwner!.updatedAt - 1, 10))
      .toEqual([]);

    const wrongRenewal = await repo.renewInterruptResumeAttemptLease(
      pending!.id,
      pending!.updatedAt,
      firstOwner!.updatedAt + 1,
    );
    expect(wrongRenewal).toBeUndefined();

    const renewed = await repo.renewInterruptResumeAttemptLease(
      pending!.id,
      firstOwner!.updatedAt,
      firstOwner!.updatedAt + 1,
    );
    expect(renewed).toMatchObject({
      status: 'in_progress',
      updatedAt: firstOwner!.updatedAt + 1,
    });

    const tooFreshToReclaim = await repo.claimInterruptResumeAttempt({
      id: pending!.id,
      expectedUpdatedAt: renewed!.updatedAt,
      staleBefore: renewed!.updatedAt - 1,
      claimedAt: renewed!.updatedAt + 1,
    });
    expect(tooFreshToReclaim).toBeUndefined();

    const recoveredAfterCrash = await repo.claimInterruptResumeAttempt({
      id: pending!.id,
      expectedUpdatedAt: renewed!.updatedAt,
      staleBefore: renewed!.updatedAt,
      claimedAt: renewed!.updatedAt + 2,
    });
    expect(recoveredAfterCrash).toMatchObject({
      status: 'in_progress',
      attempts: 2,
      updatedAt: renewed!.updatedAt + 2,
    });

    const staleOwnerCompletion = await repo.completeInterruptResumeAttempt(
      pending!.id,
      renewed!.updatedAt,
      recoveredAfterCrash!.updatedAt + 1,
    );
    expect(staleOwnerCompletion).toBeUndefined();

    const completed = await repo.completeInterruptResumeAttempt(
      pending!.id,
      recoveredAfterCrash!.updatedAt,
      recoveredAfterCrash!.updatedAt + 1,
    );
    expect(completed).toMatchObject({
      status: 'completed',
      completedAt: recoveredAfterCrash!.updatedAt + 1,
      updatedAt: recoveredAfterCrash!.updatedAt + 1,
    });
    expect(await repo.getRecoverableInterruptResumeAttempts(
      recoveredAfterCrash!.updatedAt + 2,
      10,
    )).toEqual([]);
  });

  it('atomically resolves an interrupt and creates exactly one resume attempt', async () => {
    const agent = await repo.createAgent({
      name: 'Atomic interrupt resolution agent',
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
    await repo.savePendingInterrupt({
      id: 'interrupt-atomic-resolution',
      turnId: turn.id,
      agentId: agent.id,
      sandboxSessionId: sandboxSession.id,
      toolCallId: 'approval-atomic',
      toolName: 'request-approval',
      args: {},
      timeoutMs: 60_000,
      createdAt: 1_000,
      expiresAt: 61_000,
    });

    const resolutions = await Promise.all([
      repo.resolveInterruptWithResumeAttempt(
        'interrupt-atomic-resolution',
        'approve',
        { approved: true },
      ),
      repo.resolveInterruptWithResumeAttempt(
        'interrupt-atomic-resolution',
        'approve',
        { approved: true },
      ),
    ]);

    expect(resolutions).toEqual([
      expect.objectContaining({
        kind: 'ready',
        interrupt: expect.objectContaining({ status: 'resolved', resolvedAction: 'approve' }),
        resumeAttempt: expect.objectContaining({ status: 'pending' }),
      }),
      expect.objectContaining({
        kind: 'ready',
        interrupt: expect.objectContaining({ status: 'resolved', resolvedAction: 'approve' }),
        resumeAttempt: expect.objectContaining({ status: 'pending' }),
      }),
    ]);
    expect(resolutions[0]?.resumeAttempt?.id).toBe(resolutions[1]?.resumeAttempt?.id);
  });

  it('rolls back the interrupt resolution when attempt creation crashes', async () => {
    const agent = await repo.createAgent({
      name: 'Atomic rollback agent',
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
    await repo.savePendingInterrupt({
      id: 'interrupt-atomic-rollback',
      turnId: turn.id,
      agentId: agent.id,
      sandboxSessionId: sandboxSession.id,
      toolCallId: 'approval-rollback',
      toolName: 'request-approval',
      args: {},
      timeoutMs: 60_000,
      createdAt: 1_500,
      expiresAt: 61_500,
    });

    await testDb.conn.pgClient.unsafe(`
      CREATE OR REPLACE FUNCTION fail_interrupt_resume_attempt_insert()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected attempt insert crash';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_interrupt_resume_attempt_insert_trigger
      BEFORE INSERT ON interrupt_resume_attempts
      FOR EACH ROW EXECUTE FUNCTION fail_interrupt_resume_attempt_insert();
    `);
    try {
      await expect(
        repo.resolveInterruptWithResumeAttempt(
          'interrupt-atomic-rollback',
          'approve',
          { approved: true },
        ),
      ).rejects.toThrow(/Failed query: insert into "interrupt_resume_attempts"/);
    } finally {
      await testDb.conn.pgClient.unsafe(`
        DROP TRIGGER IF EXISTS fail_interrupt_resume_attempt_insert_trigger
          ON interrupt_resume_attempts;
        DROP FUNCTION IF EXISTS fail_interrupt_resume_attempt_insert();
      `);
    }

    expect(await repo.getPendingInterrupt('interrupt-atomic-rollback'))
      .toMatchObject({
        status: 'pending',
        resolvedAction: null,
        resolvedData: null,
      });
    expect(
      await repo.getInterruptResumeAttemptForInterrupt('interrupt-atomic-rollback'),
    ).toBeUndefined();
  });

  it('uses failed-to-pending CAS so a concurrent retry cannot reset an active lease', async () => {
    const agent = await repo.createAgent({
      name: 'Concurrent retry agent',
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
    await repo.savePendingInterrupt({
      id: 'interrupt-concurrent-retry',
      turnId: turn.id,
      agentId: agent.id,
      sandboxSessionId: sandboxSession.id,
      toolCallId: 'approval-concurrent',
      toolName: 'request-approval',
      args: {},
      timeoutMs: 60_000,
      createdAt: 2_000,
      expiresAt: 62_000,
    });
    const resolution = await repo.resolveInterruptWithResumeAttempt(
      'interrupt-concurrent-retry',
      'approve',
    );
    const pending = resolution?.kind === 'ready' ? resolution.resumeAttempt : undefined;
    expect(pending).toBeDefined();
    const claimed = await repo.claimInterruptResumeAttempt({
      id: pending!.id,
      expectedUpdatedAt: pending!.updatedAt,
      staleBefore: pending!.updatedAt - 1,
      claimedAt: pending!.updatedAt + 1,
    });
    const failed = await repo.failInterruptResumeAttempt(
      pending!.id,
      claimed!.updatedAt,
      claimed!.updatedAt + 1,
      'restore failed',
    );
    expect(failed?.status).toBe('failed');

    const retries = await Promise.all([
      repo.retryFailedInterruptResumeAttempt(
        failed!.id,
        failed!.updatedAt,
        failed!.updatedAt + 1,
      ),
      repo.retryFailedInterruptResumeAttempt(
        failed!.id,
        failed!.updatedAt,
        failed!.updatedAt + 2,
      ),
    ]);
    const retryOwner = retries.find((row) => row !== undefined);
    expect(retries.filter((row) => row !== undefined)).toHaveLength(1);
    expect(retryOwner?.status).toBe('pending');

    const active = await repo.claimInterruptResumeAttempt({
      id: retryOwner!.id,
      expectedUpdatedAt: retryOwner!.updatedAt,
      staleBefore: retryOwner!.updatedAt - 1,
      claimedAt: retryOwner!.updatedAt + 1,
    });
    expect(active?.status).toBe('in_progress');

    const staleRetry = await repo.retryFailedInterruptResumeAttempt(
      failed!.id,
      failed!.updatedAt,
      active!.updatedAt + 1,
    );
    expect(staleRetry).toBeUndefined();
    expect(await repo.getInterruptResumeAttemptForInterrupt('interrupt-concurrent-retry'))
      .toMatchObject({
        id: active!.id,
        status: 'in_progress',
        updatedAt: active!.updatedAt,
      });
  });
});
