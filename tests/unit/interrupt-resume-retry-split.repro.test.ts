/**
 * ctx-eu6a repro (DB half) — the split retry guarantee.
 *
 * `getRecoverableInterruptResumeAttempts` (repository.ts:5388-5420) selects
 * 'pending' rows and unleased 'in_progress' rows. It never selects 'failed'.
 * Combined with the worker having no max-attempts predicate, that produces two
 * opposite wrong behaviours from one queue:
 *
 *   - pending: re-driven by every 15s scan forever, no cap, no backoff.
 *   - failed:  terminal and invisible; the only way back is a human re-hitting
 *              the resolve endpoint (retryFailedInterruptResumeAttempt).
 *
 * The worker-side half of this bug is in
 * packages/stablehand/src/orchestrator/__tests__/interrupt-resume-attempt-worker.repro.test.ts
 *
 * Placed in tests/unit/ because that is where the Postgres-backed suites live
 * (see interrupt-resume-attempt-lease.test.ts); packages/stablehand/**\/__tests__
 * is pure-unit by convention.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DatabaseRepository } from '../../packages/stablehand/src/database/repository.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

/** A bounded retry budget in the shape the turn reconciler already uses. */
const EXPECTED_MAX_RESUME_ATTEMPTS = 3;

/** How many recovery polls we simulate (15s apart in production). */
const SCANS = 12;

interface ResumeFixture {
  attemptId: string;
}

async function seedResumeAttempt(
  repo: DatabaseRepository,
  label: string,
): Promise<ResumeFixture> {
  const agent = await repo.createAgent({
    name: `resume-split-${label}`,
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
  const delivery = await repo.claimTurnDeliveryLease({
    turnId: turn.id,
    ownerId: `owner-${label}`,
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
  await repo.savePendingInterrupt({
    id: `interrupt-${label}`,
    turnId: turn.id,
    agentId: agent.id,
    sandboxSessionId: sandboxSession.id,
    toolCallId: `approval-${label}`,
    toolName: 'request-approval',
    args: {},
    timeoutMs: 60_000,
    createdAt: 500,
    expiresAt: 60_500,
  });
  const resolution = await repo.resolveInterruptWithResumeAttempt(
    `interrupt-${label}`,
    'approve',
  );
  const attempt = resolution?.kind === 'ready' ? resolution.resumeAttempt : undefined;
  expect(attempt).toBeDefined();
  return { attemptId: attempt!.id };
}

describe('ctx-eu6a: interrupt resume recovery scan retry split', () => {
  let testDb: TestDb;
  let repo: DatabaseRepository;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = testDb.repo;
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it('retries a pending attempt without bound and never retries a failed one', async () => {
    const stuck = await seedResumeAttempt(repo, 'stuck');
    const broken = await seedResumeAttempt(repo, 'broken');

    // A delivery failure marks the attempt 'failed' — this is the exact call
    // the worker makes from handlePreparationFailure when it has no lease.
    const failed = await repo.failUnclaimedInterruptResumeAttempt(
      broken.attemptId,
      'malformed checkpoint',
    );
    expect(failed?.status).toBe('failed');

    // The pending row has already burned a large attempt count; nothing in the
    // query or the worker consults it.
    await testDb.conn.pgClient`
      UPDATE interrupt_resume_attempts
      SET attempts = 10000
      WHERE id = ${stuck.attemptId}
    `;

    let pendingScanCount = 0;
    let failedScanCount = 0;
    for (let scan = 0; scan < SCANS; scan += 1) {
      const scanned = await repo.getRecoverableInterruptResumeAttempts(50);
      const ids = scanned.map((row) => row.id);
      if (ids.includes(stuck.attemptId)) pendingScanCount += 1;
      if (ids.includes(broken.attemptId)) failedScanCount += 1;
    }

    // The failed row's only route back is a human re-hitting the resolve
    // endpoint. Confirm that manual escape hatch is the sole one.
    const manuallyRevived = await repo.retryFailedInterruptResumeAttempt(
      broken.attemptId,
    );
    expect(manuallyRevived?.status).toBe('pending');

    // Soft so both halves of the split report in one run.

    // FAILS at HEAD: 12 — a pending attempt is re-driven by every poll with no
    // cap and no backoff, even at attempts=10000.
    expect.soft(pendingScanCount).toBeLessThanOrEqual(EXPECTED_MAX_RESUME_ATTEMPTS);

    // FAILS at HEAD: 0 — a failed attempt is silently terminal; the recovery
    // scan cannot see it at all, so it is never retried and never surfaced.
    expect.soft(failedScanCount).toBeGreaterThan(0);
  });
});
