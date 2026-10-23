/**
 * ctx-2jp0: an approved turn must never sit RUNNING after its resume fails.
 *
 * Observed on dev1: a reviewer turn parked on request-approval, the
 * orchestrator was redeployed twice, and the late approval's continuation was
 * acknowledged by the sandbox as a duplicate ("completed without emitting any
 * events"). The attempt was marked failed and the turn stayed RUNNING: the
 * recovery scan selected the failed attempt for a retry but the claim refused
 * failed rows, and nothing ever closed the turn.
 *
 * These tests drive the real repository and resume worker with a stand-in
 * session manager and assert the terminal state is honest in every branch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import {
  MAX_INTERRUPT_RESUME_ATTEMPTS,
  type DatabaseRepository,
} from '../../packages/stablehand/src/database/repository.js';
import { TypedEventBus } from '../../packages/stablehand/src/events/bus.js';
import { InterruptContinuationUnrecoverableError } from '../../packages/stablehand/src/orchestrator/interrupt-continuation-error.js';
import {
  InterruptResumeAttemptWorker,
  createParkedTurnCloser,
} from '../../packages/stablehand/src/orchestrator/interrupt-resume-attempt-worker.js';
import type { PreparedInterruptContinuationReady } from '../../packages/stablehand/src/orchestrator/session-manager/interrupt-resume-service.js';
import {
  APPROVAL_RESUME_SANDBOX_ENDED_RUN,
  TURN_ERROR_SANDBOX_ALREADY_ENDED_TURN,
  turnErrorApprovalNotResumed,
} from '../../packages/stablehand/src/orchestrator/turn-finalizer.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

const AGENT_DEF: AgentDefinition = {
  name: 'reviewer',
  harness: 'langgraph',
  harnessConfig: {},
  tools: [],
  systemPrompt: 'Ask for approval, then reply.',
};

interface ParkedTurn {
  agentId: string;
  conversationId: string;
  sandboxSessionId: string;
  turnId: string;
  interruptId: string;
  attemptId: string;
}

/** A turn parked on request-approval and approved: its resume attempt is pending. */
async function seedApprovedTurn(repo: DatabaseRepository, label: string): Promise<ParkedTurn> {
  const agent = await repo.createAgent({
    name: `give-up-${label}`,
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
    mode: 'background',
  });
  const delivery = await repo.claimTurnDeliveryLease({
    turnId: turn.id,
    ownerId: `dead-orchestrator-${label}`,
    leaseDurationMs: 60_000,
  });
  await repo.activateTurnDelivery({
    turnId: turn.id,
    sandboxSessionId: sandboxSession.id,
    ownerId: delivery!.ownerId,
    fenceToken: delivery!.fenceToken,
    expectedActiveGeneration: {
      restoreFenceToken: sandboxSession.restoreFenceToken,
      containerId: sandboxSession.containerId,
    },
  });
  const interruptId = `interrupt-${label}`;
  await repo.savePendingInterrupt({
    id: interruptId,
    turnId: turn.id,
    agentId: agent.id,
    sandboxSessionId: sandboxSession.id,
    toolCallId: `approval-${label}`,
    toolName: 'request-approval',
    args: { reason: 'promote the winner' },
    timeoutMs: 300_000,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
  });
  // The orchestrator that held the parked delivery died: its lease lapses.
  await expireTurnLease(turn.id);
  const resolution = await repo.resolveInterruptWithResumeAttempt(interruptId, 'approve');
  const attempt = resolution?.kind === 'ready' ? resolution.resumeAttempt : undefined;
  expect(attempt).toBeDefined();
  return {
    agentId: agent.id,
    conversationId: conversation.id,
    sandboxSessionId: sandboxSession.id,
    turnId: turn.id,
    interruptId,
    attemptId: attempt!.id,
  };
}

let testDb: TestDb;
let repo: DatabaseRepository;

async function expireTurnLease(turnId: string): Promise<void> {
  await testDb.conn.pgClient`
    UPDATE turn_delivery_leases
    SET lease_expires_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1
    WHERE turn_id = ${turnId}
  `;
}

/** Let the per-attempt retry backoff pass. */
async function skipBackoff(attemptId: string): Promise<void> {
  await testDb.conn.pgClient`
    UPDATE interrupt_resume_attempts
    SET updated_at = updated_at - 600000
    WHERE id = ${attemptId}
  `;
}

function sessionManagerFor(
  parked: ParkedTurn,
  execute: (attemptId: string) => Promise<void>,
) {
  return {
    prepareInterruptContinuation: vi.fn(async (): Promise<PreparedInterruptContinuationReady> => ({
      kind: 'ready',
      sandboxSessionId: parked.sandboxSessionId,
      turnId: parked.turnId,
      agentId: parked.agentId,
      interruptId: parked.interruptId,
      conversationId: parked.conversationId,
      mode: 'background',
      taskDescription: '',
      agentDef: AGENT_DEF,
      pendingApprovals: [],
      fallbackToolCallId: 'approval-call',
      fallbackArgs: {},
      resolutionContent: 'APPROVED',
      turnSecrets: {},
    })),
    executeInterruptContinuation: vi.fn(
      async (_prepared: PreparedInterruptContinuationReady, attemptId: string) => execute(attemptId),
    ),
  };
}

function quietLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function workerFor(sessionManager: ReturnType<typeof sessionManagerFor>) {
  const logger = quietLogger();
  return new InterruptResumeAttemptWorker({
    db: repo,
    sessionManager,
    logger,
    turnCloser: createParkedTurnCloser({ db: repo, eventBus: new TypedEventBus(), logger }),
  }, { leaseMs: 5_000, heartbeatMs: 1_000 });
}

describe('approved turns never stay RUNNING after their resume fails (ctx-2jp0)', () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    repo = testDb.repo;
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it('closes the turn with clear copy when the sandbox had already ended the parked run', async () => {
    const parked = await seedApprovedTurn(repo, 'already-ended');
    const sessionManager = sessionManagerFor(parked, async () => {
      throw new InterruptContinuationUnrecoverableError(
        parked.turnId,
        APPROVAL_RESUME_SANDBOX_ENDED_RUN,
        TURN_ERROR_SANDBOX_ALREADY_ENDED_TURN,
      );
    });
    const worker = workerFor(sessionManager);

    const attempt = await repo.getInterruptResumeAttemptForInterrupt(parked.interruptId);
    worker.enqueue(attempt!);
    await worker.drain();

    const turn = await repo.getTurn(parked.turnId);
    expect(turn).toMatchObject({
      status: 'error',
      error: turnErrorApprovalNotResumed(APPROVAL_RESUME_SANDBOX_ENDED_RUN),
    });
    expect(turn?.completedAt).not.toBeNull();
    const settled = await repo.getInterruptResumeAttemptForInterrupt(parked.interruptId);
    expect(settled).toMatchObject({ status: 'failed' });
    expect(settled!.attempts).toBeGreaterThanOrEqual(MAX_INTERRUPT_RESUME_ATTEMPTS);

    // Nothing retries it: the next scans do not redeliver.
    await skipBackoff(parked.attemptId);
    await worker.recoverNow();
    await worker.drain();
    expect(sessionManager.executeInterruptContinuation).toHaveBeenCalledTimes(1);
  });

  it('retries a failed resume automatically and closes the turn once the budget is spent', async () => {
    const parked = await seedApprovedTurn(repo, 'keeps-failing');
    const sessionManager = sessionManagerFor(parked, async () => {
      throw new Error('[unavailable] connect ECONNREFUSED 172.18.0.9:50051');
    });
    const worker = workerFor(sessionManager);

    for (let scan = 0; scan < MAX_INTERRUPT_RESUME_ATTEMPTS + 2; scan += 1) {
      await skipBackoff(parked.attemptId);
      await expireTurnLease(parked.turnId);
      await worker.recoverNow();
      await worker.drain();
    }

    // Each attempt really ran: failed attempts are claimable again.
    expect(sessionManager.executeInterruptContinuation)
      .toHaveBeenCalledTimes(MAX_INTERRUPT_RESUME_ATTEMPTS);
    const turn = await repo.getTurn(parked.turnId);
    expect(turn?.status).toBe('error');
    expect(turn?.completedAt).not.toBeNull();
    expect(turn?.error).toContain('The approval was recorded, but this run could not continue');
    expect(turn?.error).toContain(`resuming it failed ${MAX_INTERRUPT_RESUME_ATTEMPTS} times`);
    expect(turn?.error).toContain('ECONNREFUSED');
  });

  it('closes the turn of an attempt whose worker died during its last try', async () => {
    const parked = await seedApprovedTurn(repo, 'worker-died');
    await testDb.conn.pgClient`
      UPDATE interrupt_resume_attempts
      SET status = 'in_progress', attempts = ${MAX_INTERRUPT_RESUME_ATTEMPTS},
          last_error = 'orchestrator restarted mid-resume'
      WHERE id = ${parked.attemptId}
    `;
    const sessionManager = sessionManagerFor(parked, async () => undefined);
    const worker = workerFor(sessionManager);

    await worker.recoverNow();
    await worker.drain();

    expect(sessionManager.prepareInterruptContinuation).not.toHaveBeenCalled();
    const turn = await repo.getTurn(parked.turnId);
    expect(turn?.status).toBe('error');
    expect(turn?.error).toContain('orchestrator restarted mid-resume');
    const settled = await repo.getInterruptResumeAttemptForInterrupt(parked.interruptId);
    expect(settled?.status).toBe('failed');
  });

  it('settles a failed attempt whose turn was cancelled instead of repairing it forever', async () => {
    const parked = await seedApprovedTurn(repo, 'cancelled');
    expect(await repo.failUnclaimedInterruptResumeAttempt(parked.attemptId, 'restore failed'))
      .toBeDefined();
    await repo.finalizeTurnIfOpen(parked.turnId, {
      completedAt: Date.now(),
      status: 'cancelled',
      error: 'Turn cancelled',
    });
    const sessionManager = sessionManagerFor(parked, async () => undefined);
    const worker = workerFor(sessionManager);

    await skipBackoff(parked.attemptId);
    await worker.recoverNow();
    await worker.drain();

    expect(sessionManager.prepareInterruptContinuation).not.toHaveBeenCalled();
    const settled = await repo.getInterruptResumeAttemptForInterrupt(parked.interruptId);
    expect(settled?.status).toBe('completed');
    expect((await repo.getTurn(parked.turnId))?.status).toBe('cancelled');
  });
});
