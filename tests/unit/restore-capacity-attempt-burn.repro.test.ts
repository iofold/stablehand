/**
 * ctx-2mm8 repro — restore attempts burned by capacity errors.
 *
 * `restoreFromCheckpointOnceMeasured` claims the restore lease (which
 * atomically does `restore_attempts + 1`, repository.ts:6926) at
 * session-recovery-coordinator.ts:388, but the global container slot is not
 * acquired until `createContainer` at :447 — inside the container runtime,
 * `runtime/core.ts:86` calls `accounting.acquireSlot()`, which rejects with
 * ContainerLimitError after queueTimeoutMs (60s default).
 *
 * ContainerLimitError falls through `classifyRestoreFailure`'s default arm
 * (restore-retry-policy.ts:91) to 'retryable', so a busy host consumes the
 * restore budget exactly as a corrupt checkpoint would. Three capacity
 * saturation events permanently poison a session whose checkpoint is fine,
 * and the poisoned state then surfaces as SessionRestoreInProgressError
 * ("still being restored by another worker"), which is factually wrong.
 *
 * ctx-vsf8 (94ccd889) reworked the adjacent *checkpoint* failure path
 * (checkpoint_failures / size-vs-transient classification). It did not touch
 * restore attempt accounting; this test pins that the defect survives at HEAD.
 *
 * Placed in tests/unit/ because that is where the Postgres-backed suites live;
 * packages/ctxmill/**\/__tests__ is pure-unit by convention.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import { DatabaseRepository, type SandboxSessionRow } from '../../packages/ctxmill/src/database/repository.js';
import {
  SessionRecoveryCoordinator,
  SessionRestoreBudgetExhaustedError,
} from '../../packages/ctxmill/src/orchestrator/session-manager/session-recovery-coordinator.js';
import {
  classifyRestoreFailure,
  InvalidCheckpointError,
  MAX_RESTORE_ATTEMPTS,
  RESTORE_BACKOFF_MS,
} from '../../packages/ctxmill/src/orchestrator/session-manager/restore-retry-policy.js';
import { SessionStateStore } from '../../packages/ctxmill/src/orchestrator/session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../../packages/ctxmill/src/orchestrator/session-manager/session-status-coordinator.js';
import { ContainerLimitError } from '../../packages/ctxmill/src/sandbox/container-semaphore.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

const MAX_CONTAINERS = 4;

const AGENT_DEF: AgentDefinition = {
  name: 'capacity-repro',
  harness: 'langgraph',
  harnessConfig: {},
  tools: [],
  systemPrompt: 'test',
} as unknown as AgentDefinition;

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Real repository for every restore-accounting call. `getCheckpointV2` is the
 * one stub: seeding a checkpoint row requires a lifecycle fence and is
 * orthogonal to the attempt accounting under test. A present, well-formed
 * checkpoint is exactly the "healthy session" premise of this bug.
 */
function wrapRepo(repo: DatabaseRepository) {
  return {
    getCheckpointV2: async () => ({
      checkpointVersion: 1,
      harnessState: {},
    }),
    getSandboxSession: repo.getSandboxSession.bind(repo),
    getLiveSandboxSessionByConversation:
      repo.getLiveSandboxSessionByConversation.bind(repo),
    claimSandboxSessionLifecycleOperation:
      repo.claimSandboxSessionLifecycleOperation.bind(repo),
    renewSandboxSessionLifecycleOperation:
      repo.renewSandboxSessionLifecycleOperation.bind(repo),
    markSandboxSessionLifecycleOperationExecuting:
      repo.markSandboxSessionLifecycleOperationExecuting.bind(repo),
    cancelSandboxSessionLifecycleOperation:
      repo.cancelSandboxSessionLifecycleOperation.bind(repo),
    claimSandboxSessionRestore: repo.claimSandboxSessionRestore.bind(repo),
    renewSandboxSessionRestoreLease:
      repo.renewSandboxSessionRestoreLease.bind(repo),
    completeSandboxSessionRestore:
      repo.completeSandboxSessionRestore.bind(repo),
    failSandboxSessionRestore: repo.failSandboxSessionRestore.bind(repo),
    reconcileExpiredSandboxSessionRestore:
      repo.reconcileExpiredSandboxSessionRestore.bind(repo),
  };
}

describe('ctx-2mm8: capacity errors burn the restore budget', () => {
  let testDb: TestDb;
  let repo: DatabaseRepository;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = testDb.repo;
  });

  afterAll(async () => {
    await testDb?.close();
  });

  /** A CHECKPOINTED session with an intact checkpoint and a fresh budget. */
  async function seedCheckpointedSession(label: string): Promise<SandboxSessionRow> {
    const agent = await repo.createAgent({
      name: `capacity-${label}`,
      harness: 'langgraph',
      harnessConfig: '{}',
      systemPrompt: 'test',
      tools: [],
    });
    const conversation = await repo.createConversation(agent.id);
    const session = await repo.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      harnessName: 'langgraph',
    });
    await testDb.conn.pgClient`
      UPDATE sandbox_sessions
      SET status = 'CHECKPOINTED', container_id = NULL, container_name = NULL
      WHERE id = ${session.id}
    `;
    return (await repo.getSandboxSession(session.id))!;
  }

  function createCoordinator(
    createContainer: () => Promise<never> | Promise<unknown>,
    sleeps: number[],
  ): SessionRecoveryCoordinator {
    const logger = createLogger();
    const db = wrapRepo(repo);
    return new SessionRecoveryCoordinator({
      containerManager: {
        createContainer: vi.fn().mockImplementation(createContainer),
        startContainer: vi.fn(),
        stopContainer: vi.fn(),
        removeContainer: vi.fn(),
        getContainer: vi.fn().mockResolvedValue(undefined),
        getRuntimeInstanceToken: vi.fn().mockResolvedValue('token'),
      },
      db,
      statusCoordinator: new SessionStatusCoordinator({ db: repo, logger }),
      stateStore: new SessionStateStore(),
      buildSandboxSecrets: async () => ({}),
      resolveToolsForAgent: () => [],
      workspaceDiffService: { restore: vi.fn() },
      logger,
      createFreshSession: vi.fn(),
      getExistingConversationWorkspaceDir: async () => undefined,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    } as never);
  }

  it('refunds the budget on capacity refusals (a full host never poisons a healthy session)', async () => {
    const session = await seedCheckpointedSession('burn');
    const sleeps: number[] = [];
    const capacityError = new ContainerLimitError(MAX_CONTAINERS);
    const coordinator = createCoordinator(
      async () => { throw capacityError; },
      sleeps,
    );

    await expect(
      coordinator.restoreFromCheckpointWithRetry(session, AGENT_DEF),
    ).rejects.toBeInstanceOf(ContainerLimitError);

    const notPoisoned = (await repo.getSandboxSession(session.id))!;

    expect(notPoisoned.status).toBe('CHECKPOINTED');
    expect(notPoisoned.lastRestoreError).toBe(
      `Maximum container limit (${MAX_CONTAINERS}) reached. Try again later.`,
    );

    // Capacity is now its own category — the attempt is refunded, not spent.
    expect(classifyRestoreFailure(capacityError).category).toBe('capacity');
    expect(classifyRestoreFailure(new InvalidCheckpointError('corrupt')).category)
      .toBe('non_retryable');

    // All three ADR-013 backoff steps are now reachable (parity fixed).
    expect(sleeps).toEqual([...RESTORE_BACKOFF_MS]);

    // The budget was never spent: the healthy checkpoint is not poisoned.
    expect(notPoisoned.restoreAttempts).toBe(0);
  });

  it('names budget exhaustion distinctly instead of blaming a phantom peer', async () => {
    const session = await seedCheckpointedSession('exhausted');

    // A genuinely exhausted budget (e.g. from repeated real restore failures).
    await testDb.conn.pgClient`
      UPDATE sandbox_sessions SET restore_attempts = ${MAX_RESTORE_ATTEMPTS}
      WHERE id = ${session.id}
    `;
    const maxed = (await repo.getSandboxSession(session.id))!;

    const healthy = createCoordinator(
      async () => ({ containerId: 'c-1', containerName: 'ctxmill-c-1' }),
      [],
    );

    const onceError = await healthy
      .restoreFromCheckpointOnce(maxed, AGENT_DEF)
      .then(() => undefined, (err: unknown) => err);
    const retryError = await healthy
      .restoreFromCheckpointWithRetry(maxed, AGENT_DEF)
      .then(() => undefined, (err: unknown) => err);

    // No peer owns this restore — the budget ran out. Both entry points say so.
    expect(onceError).toBeInstanceOf(SessionRestoreBudgetExhaustedError);
    expect(retryError).toBeInstanceOf(SessionRestoreBudgetExhaustedError);
    expect((onceError as Error).message).not.toContain('another worker');
    expect((onceError as Error).message).toMatch(/budget|capacity/i);

    // Prove the session itself is healthy: clearing only the burned counter
    // makes the very same claim succeed against the very same row.
    await testDb.conn.pgClient`
      UPDATE sandbox_sessions SET restore_attempts = 0 WHERE id = ${session.id}
    `;
    expect(await repo.claimSandboxSessionRestore({
      sandboxSessionId: session.id,
      ownerId: 'unpoison-probe',
      leaseDurationMs: 60_000,
      maxAttempts: MAX_RESTORE_ATTEMPTS,
    })).toBeDefined();
  });

  it('accepts an unbounded maxAttempts claim against the real int4 column (ctx-cn9c kill path)', async () => {
    // The checkpointed-kill path claims with Number.MAX_SAFE_INTEGER so a kill
    // is never gated by restore exhaustion. Found live: the raw value overflows
    // the prepared-statement parameter type inferred from the INTEGER column;
    // the repository clamps to int4 max. This exercises the real SQL.
    const session = await seedCheckpointedSession('unbounded-claim');
    await testDb.conn.pgClient`
      UPDATE sandbox_sessions SET restore_attempts = ${MAX_RESTORE_ATTEMPTS}
      WHERE id = ${session.id}
    `;
    expect(await repo.claimSandboxSessionRestore({
      sandboxSessionId: session.id,
      ownerId: 'kill-probe',
      leaseDurationMs: 60_000,
      maxAttempts: Number.MAX_SAFE_INTEGER,
    })).toBeDefined();
  });
});
