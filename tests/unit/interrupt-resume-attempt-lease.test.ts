import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../packages/stablehand/src/database/connection.js';
import { DatabaseRepository } from '../../packages/stablehand/src/database/repository.js';
import {
  createTestDb,
  resolveTestDatabaseUrl,
  type TestDb,
} from '../utils/test-db.js';

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

  it('claims and reclaims the original turn with a DB-fenced delivery across replicas', async () => {
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
    const originalDelivery = await repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'original-owner',
      leaseDurationMs: 60_000,
    });
    expect(await repo.activateTurnDelivery({
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      ownerId: originalDelivery!.ownerId,
      fenceToken: originalDelivery!.fenceToken,
      expectedActiveGeneration: {
        restoreFenceToken: sandboxSession.restoreFenceToken,
        containerId: sandboxSession.containerId,
      },
    })).toBe(true);
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

    expect(await repo.getRecoverableInterruptResumeAttempts(10))
      .toEqual([expect.objectContaining({ id: pending!.id, status: 'pending' })]);

    // This test needs a non-live source session while retaining the original
    // running turn. Canonical lifecycle admission intentionally rejects that
    // synthetic combination, so establish the fixture directly.
    await testDb.conn.pgClient`
      UPDATE sandbox_sessions
      SET status = 'CHECKPOINTED',
          container_id = NULL,
          container_name = NULL
      WHERE id = ${sandboxSession.id}
    `;
    await testDb.conn.pgClient`
      UPDATE turn_delivery_leases
      SET lease_expires_at =
        floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1
      WHERE turn_id = ${turn.id}
    `;
    const targetSession = await repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: 'langgraph',
    });
    const secondConnection = await createDatabase(resolveTestDatabaseUrl());
    const secondRepository = new DatabaseRepository(secondConnection.db);
    try {
      const competingClaims = await Promise.all([
        repo.claimInterruptResumeDelivery({
          attemptId: pending!.id,
          sandboxSessionId: targetSession.id,
          ownerId: 'resume-owner-a',
          leaseDurationMs: 60_000,
        }),
        secondRepository.claimInterruptResumeDelivery({
          attemptId: pending!.id,
          sandboxSessionId: targetSession.id,
          ownerId: 'resume-owner-b',
          leaseDurationMs: 60_000,
        }),
      ]);
      const firstOwner = competingClaims.find(
        (claim) => claim !== undefined,
      )!;
      expect(competingClaims.filter(Boolean)).toHaveLength(1);
      expect(firstOwner.attempt).toMatchObject({
        status: 'in_progress',
        attempts: 1,
        sandboxSessionId: targetSession.id,
      });
      expect(firstOwner.lease.fenceToken).toBe(
        originalDelivery!.fenceToken + 1,
      );
      expect(await repo.getRecoverableInterruptResumeAttempts(10)).toEqual([]);

      const idempotentClaim = await repo.claimInterruptResumeDelivery({
        attemptId: pending!.id,
        sandboxSessionId: targetSession.id,
        ownerId: firstOwner.lease.ownerId,
        leaseDurationMs: 60_000,
      });
      expect(idempotentClaim).toMatchObject({
        attempt: { attempts: 1 },
        lease: { fenceToken: firstOwner.lease.fenceToken },
      });

      await testDb.conn.pgClient`
        UPDATE turn_delivery_leases
        SET lease_expires_at =
          floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1
        WHERE turn_id = ${turn.id}
      `;
      expect(await repo.getRecoverableInterruptResumeAttempts(10))
        .toEqual([expect.objectContaining({
          id: pending!.id,
          status: 'in_progress',
        })]);

      const takeoverOwner = firstOwner.lease.ownerId === 'resume-owner-a'
        ? 'resume-owner-b'
        : 'resume-owner-a';
      const takeover = await secondRepository.claimInterruptResumeDelivery({
        attemptId: pending!.id,
        sandboxSessionId: targetSession.id,
        ownerId: takeoverOwner,
        leaseDurationMs: 60_000,
      });
      expect(takeover).toMatchObject({
        attempt: { status: 'in_progress', attempts: 2 },
        lease: {
          ownerId: takeoverOwner,
          fenceToken: firstOwner.lease.fenceToken + 1,
        },
      });
      expect(await repo.completeInterruptResumeDelivery(
        pending!.id,
        {
          ownerId: firstOwner.lease.ownerId,
          fenceToken: firstOwner.lease.fenceToken,
        },
      )).toBeUndefined();

      expect(await repo.finalizeTurnIfOpen(turn.id, {
        status: 'completed',
        completedAt: Date.now(),
        error: null,
      }, {
        ownerId: takeover!.lease.ownerId,
        fenceToken: takeover!.lease.fenceToken,
      })).toBe(true);
      expect(await repo.completeInterruptResumeDelivery(
        pending!.id,
        {
          ownerId: takeover!.lease.ownerId,
          fenceToken: takeover!.lease.fenceToken,
        },
      )).toMatchObject({
        status: 'completed',
        completedAt: expect.any(Number),
      });
      expect(await repo.getRecoverableInterruptResumeAttempts(10)).toEqual([]);
    } finally {
      await secondConnection.close();
    }
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

    expect(await repo.getInterruptById('interrupt-atomic-rollback'))
      .toMatchObject({
        status: 'pending',
        resolvedAction: null,
        resolvedData: null,
      });
    expect(
      await repo.getInterruptResumeAttemptForInterrupt('interrupt-atomic-rollback'),
    ).toBeUndefined();
  });

  it('repairs a crash gap only after the original turn is terminal', async () => {
    const agent = await repo.createAgent({
      name: 'Terminal repair agent',
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
      id: 'interrupt-terminal-repair',
      turnId: turn.id,
      agentId: agent.id,
      sandboxSessionId: sandboxSession.id,
      toolCallId: 'approval-terminal-repair',
      toolName: 'request-approval',
      args: {},
      timeoutMs: 60_000,
      createdAt: 1_700,
      expiresAt: 61_700,
    });
    const resolution = await repo.resolveInterruptWithResumeAttempt(
      'interrupt-terminal-repair',
      'approve',
    );
    const pending = resolution?.kind === 'ready'
      ? resolution.resumeAttempt
      : undefined;
    expect(pending).toBeDefined();
    expect(
      await repo.completeTerminalInterruptResumeAttempt(pending!.id),
    ).toBeUndefined();

    await repo.finalizeTurnIfOpen(turn.id, {
      status: 'completed',
      completedAt: Date.now(),
      error: null,
    });
    expect(
      await repo.completeTerminalInterruptResumeAttempt(pending!.id),
    ).toMatchObject({
      status: 'completed',
      completedAt: expect.any(Number),
    });
  });

  it('uses failed-to-pending CAS so a concurrent retry cannot reset an active delivery', async () => {
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
    const originalDelivery = await repo.claimTurnDeliveryLease({
      turnId: turn.id,
      ownerId: 'retry-original-owner',
      leaseDurationMs: 60_000,
    });
    expect(await repo.activateTurnDelivery({
      turnId: turn.id,
      sandboxSessionId: sandboxSession.id,
      ownerId: originalDelivery!.ownerId,
      fenceToken: originalDelivery!.fenceToken,
      expectedActiveGeneration: {
        restoreFenceToken: sandboxSession.restoreFenceToken,
        containerId: sandboxSession.containerId,
      },
    })).toBe(true);
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
    const failed = await repo.failUnclaimedInterruptResumeAttempt(
      pending!.id,
      'restore failed',
    );
    expect(failed?.status).toBe('failed');

    const secondConnection = await createDatabase(resolveTestDatabaseUrl());
    const secondRepository = new DatabaseRepository(secondConnection.db);
    try {
      const retries = await Promise.all([
        repo.retryFailedInterruptResumeAttempt(failed!.id),
        secondRepository.retryFailedInterruptResumeAttempt(failed!.id),
      ]);
      const retryOwner = retries.find((row) => row !== undefined);
      expect(retries.filter(Boolean)).toHaveLength(1);
      expect(retryOwner?.status).toBe('pending');

      await testDb.conn.pgClient`
        UPDATE turn_delivery_leases
        SET lease_expires_at =
          floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1
        WHERE turn_id = ${turn.id}
      `;
      const active = await repo.claimInterruptResumeDelivery({
        attemptId: retryOwner!.id,
        sandboxSessionId: sandboxSession.id,
        ownerId: 'retry-resume-owner',
        leaseDurationMs: 60_000,
      });
      // The failed restore counted against the budget (ctx-2jp0), and the
      // claim counts this delivery.
      expect(active).toMatchObject({
        attempt: { status: 'in_progress', attempts: 2 },
      });

      expect(
        await secondRepository.retryFailedInterruptResumeAttempt(failed!.id),
      ).toBeUndefined();
      expect(
        await repo.getInterruptResumeAttemptForInterrupt(
          'interrupt-concurrent-retry',
        ),
      ).toMatchObject({
        id: active!.attempt.id,
        status: 'in_progress',
        attempts: 2,
      });
    } finally {
      await secondConnection.close();
    }
  });
});
