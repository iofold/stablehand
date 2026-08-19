import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InterruptManager } from '../../interrupt.js';
import { interruptRoutes } from '../agents/interrupts.js';
import type { AgentSubRouteOptions, StoredAgent } from '../agents/types.js';

const agent = { id: 'agent-1', name: 'agent' } as unknown as StoredAgent;

function createInterruptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'interrupt-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    toolCallId: 'tc-1',
    toolName: 'send_email',
    args: { to: 'a@example.com' },
    timeoutMs: 300_000,
    createdAt: Date.now() - 1_000,
    expiresAt: Date.now() + 300_000,
    status: 'pending',
    resolvedAction: null,
    resolvedData: null,
    sandboxSessionId: 'sess-1',
    ...overrides,
  };
}

function createRouteDb(overrides: Record<string, unknown> = {}) {
  const defaultAttempt = {
    id: 'attempt-1',
    interruptId: 'interrupt-1',
    turnId: 'turn-1',
    sandboxSessionId: 'sess-1',
    agentId: 'agent-1',
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
  };
  return {
    getInterruptById: vi.fn().mockResolvedValue(undefined),
    getTurn: vi.fn().mockResolvedValue({
      id: 'turn-1',
      status: 'running',
      completedAt: null,
    }),
    getSandboxSession: vi.fn().mockResolvedValue({
      id: 'sess-1',
      status: 'ACTIVE',
    }),
    getInterruptResumeAttemptForInterrupt: vi.fn().mockResolvedValue(undefined),
    getActionableInterruptsForAgent: vi.fn().mockResolvedValue([]),
    resolveInterrupt: vi.fn().mockResolvedValue(createInterruptRow({ status: 'resolved' })),
    resolveInterruptWithResumeAttempt: vi.fn().mockResolvedValue({
      kind: 'ready',
      interrupt: createInterruptRow({ status: 'resolved', resolvedAction: 'approve' }),
      resumeAttempt: defaultAttempt,
    }),
    retryFailedInterruptResumeAttempt: vi.fn().mockResolvedValue(defaultAttempt),
    getExhaustedInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
    getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
    claimInterruptResumeDelivery: vi.fn().mockImplementation(async (input: {
      sandboxSessionId: string;
      ownerId: string;
    }) => ({
      attempt: {
        ...defaultAttempt,
        sandboxSessionId: input.sandboxSessionId,
        status: 'in_progress',
        attempts: 1,
      },
      lease: {
        turnId: defaultAttempt.turnId,
        ownerId: input.ownerId,
        fenceToken: 1,
        leaseExpiresAt: Date.now() + 60_000,
        updatedAt: Date.now(),
      },
    })),
    renewTurnDeliveryLease: vi.fn().mockImplementation(async (
      turnId: string,
      ownerId: string,
      fenceToken: number,
      leaseDurationMs: number,
    ) => ({
      turnId,
      ownerId,
      fenceToken,
      leaseExpiresAt: Date.now() + leaseDurationMs,
      updatedAt: Date.now(),
    })),
    releaseTurnDeliveryLease: vi.fn().mockResolvedValue(true),
    completeInterruptResumeDelivery: vi.fn().mockResolvedValue({
      ...defaultAttempt,
      status: 'completed',
    }),
    failInterruptResumeDelivery: vi.fn().mockResolvedValue(undefined),
    completeTerminalInterruptResumeAttempt: vi.fn().mockResolvedValue(undefined),
    failUnclaimedInterruptResumeAttempt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** InterruptStore mock for the manager itself (persistence inside resolve()). */
function createManagerStore(pendingRows: Array<Record<string, unknown>> = []) {
  return {
    cleanupExpiredInterrupts: vi.fn().mockResolvedValue(undefined),
    getAllPendingInterrupts: vi.fn().mockResolvedValue(pendingRows),
    savePendingInterrupt: vi.fn().mockResolvedValue(undefined),
    resolveInterrupt: vi.fn().mockResolvedValue(createInterruptRow({ status: 'resolved' })),
    markInterruptTimedOut: vi.fn().mockResolvedValue(true),
  };
}

async function buildApp(options: {
  db: ReturnType<typeof createRouteDb>;
  interrupts: InterruptManager;
  sessionManager?: ReturnType<typeof createResumeSessionManager>;
}) {
  const app = Fastify({ logger: false });
  const loadAgent = async (request: FastifyRequest) => {
    Object.assign(request, { agent });
  };
  await app.register(interruptRoutes, {
    prefix: '/api/agents',
    db: options.db,
    interrupts: options.interrupts,
    sessionManager: options.sessionManager,
    loadAgent,
  } as unknown as AgentSubRouteOptions);
  await app.ready();
  return app;
}

function createResumeSessionManager() {
  return {
    prepareInterruptContinuation: vi.fn().mockResolvedValue({
      kind: 'ready',
      sandboxSessionId: 'sess-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      interruptId: 'interrupt-1',
    }),
    executeInterruptContinuation: vi.fn().mockResolvedValue(undefined),
  };
}

async function flushAsyncResume() {
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
}

describe('interrupt resolution route (ctx-8nnu, ctx-qjnz, ctx-aac)', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.clearAllMocks();
  });

  it('resolves a live-waiter interrupt in memory without a durable resume', async () => {
    const store = createManagerStore();
    const interrupts = new InterruptManager(undefined, store);
    const waiter = interrupts.waitForApproval('turn-1', 'agent-1', 'tc-1', 'send_email', {}, 0, 'sess-1');
    await Promise.resolve();
    const interruptId = interrupts.getPendingForAgent('agent-1')[0]?.info.interruptId;
    const db = createRouteDb({ getInterruptById: vi.fn().mockResolvedValue(createInterruptRow()) });
    const sessionManager = createResumeSessionManager();
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', interruptId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ resolved: true, action: 'approve' });
    await expect(waiter).resolves.toEqual({ action: 'approve', data: undefined });
    expect(sessionManager.executeInterruptContinuation).not.toHaveBeenCalled();
  });

  it('falls through to the durable resume when the rehydrated entry has no live waiter (ctx-8nnu)', async () => {
    const row = createInterruptRow();
    const store = createManagerStore([row]);
    const interrupts = new InterruptManager(undefined, store);
    await interrupts.loadFromDb();
    expect(interrupts.hasPendingForTurn('turn-1')).toBe(true);
    expect(interrupts.hasLiveWaiterForTurn('turn-1')).toBe(false);

    const db = createRouteDb({ getInterruptById: vi.fn().mockResolvedValue(row) });
    const sessionManager = createResumeSessionManager();
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', interruptId: 'interrupt-1' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(expect.objectContaining({
      accepted: true,
      resuming: true,
      action: 'approve',
      resumeAttemptId: 'attempt-1',
    }));
    // Rehydrated entries have no live waiter. Resolution and durable attempt
    // creation happen in one repository transaction, then the in-memory
    // projection is settled without a second DB mutation.
    expect(db.resolveInterruptWithResumeAttempt).toHaveBeenCalledTimes(1);
    expect(store.resolveInterrupt).not.toHaveBeenCalled();
    expect(db.resolveInterrupt).not.toHaveBeenCalled();
    expect(interrupts.hasPendingForTurn('turn-1')).toBe(false);

    await flushAsyncResume();
    expect(sessionManager.prepareInterruptContinuation).toHaveBeenCalledWith(
      'sess-1',
      'turn-1',
      'agent-1',
      'interrupt-1',
      {
        attemptId: 'attempt-1',
        fence: expect.objectContaining({
          ownerId: expect.any(String),
          fenceToken: 1,
        }),
      },
    );
    expect(sessionManager.executeInterruptContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn-1' }),
      'attempt-1',
      expect.objectContaining({ fenceToken: 1 }),
      expect.any(AbortSignal),
    );
    expect(db.completeInterruptResumeDelivery).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ fenceToken: 1 }),
    );
  });

  it('enqueues a durable continuation for reject as well (ctx-qjnz)', async () => {
    const row = createInterruptRow();
    const store = createManagerStore([row]);
    const interrupts = new InterruptManager(undefined, store);
    await interrupts.loadFromDb();

    const db = createRouteDb({ getInterruptById: vi.fn().mockResolvedValue(row) });
    const sessionManager = createResumeSessionManager();
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'reject', interruptId: 'interrupt-1', data: 'not allowed' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(expect.objectContaining({ accepted: true, action: 'reject' }));
    await flushAsyncResume();
    expect(sessionManager.prepareInterruptContinuation).toHaveBeenCalledWith(
      'sess-1',
      'turn-1',
      'agent-1',
      'interrupt-1',
      {
        attemptId: 'attempt-1',
        fence: expect.objectContaining({
          ownerId: expect.any(String),
          fenceToken: 1,
        }),
      },
    );
  });

  it('rejects resolution of another agent\'s live interrupt (ctx-aac)', async () => {
    const store = createManagerStore();
    const interrupts = new InterruptManager(undefined, store);
    void interrupts.waitForApproval('turn-other', 'agent-2', 'tc-9', 'send_email', {}, 0, 'sess-9');

    const db = createRouteDb();
    const app = await buildApp({ db, interrupts });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: {
        action: 'approve',
        interruptId: interrupts.getPendingForAgent('agent-2')[0]?.info.interruptId,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(interrupts.hasPendingForTurn('turn-other')).toBe(true);
    expect(store.resolveInterrupt).not.toHaveBeenCalled();
  });

  it('retries a failed durable resume for reject resolutions too', async () => {
    const row = createInterruptRow({ status: 'resolved', resolvedAction: 'reject' });
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const db = createRouteDb({
      getInterruptById: vi.fn().mockResolvedValue(row),
      getInterruptResumeAttemptForInterrupt: vi.fn().mockResolvedValue({ id: 'attempt-0', status: 'failed' }),
    });
    const sessionManager = createResumeSessionManager();
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'reject', interruptId: 'interrupt-1' },
    });

    expect(response.statusCode).toBe(202);
    await flushAsyncResume();
    expect(sessionManager.executeInterruptContinuation).toHaveBeenCalled();
  });

  it('reports alreadyResolved for a resolved interrupt with a completed resume attempt', async () => {
    const row = createInterruptRow({ status: 'resolved', resolvedAction: 'approve' });
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const db = createRouteDb({
      getInterruptById: vi.fn().mockResolvedValue(row),
      getInterruptResumeAttemptForInterrupt: vi.fn().mockResolvedValue({ id: 'attempt-0', status: 'completed' }),
    });
    const app = await buildApp({ db, interrupts });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', interruptId: 'interrupt-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ alreadyResolved: true, action: 'approve' });
  });

  it('recovers a stale in-progress resume attempt when the route plugin starts', async () => {
    const staleAttempt = {
      id: 'attempt-stale',
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      sandboxSessionId: 'sess-1',
      agentId: 'agent-1',
      status: 'in_progress',
      attempts: 1,
      lastError: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      completedAt: null,
    };
    const claimedAttempt = {
      ...staleAttempt,
      status: 'in_progress',
      attempts: 2,
      updatedAt: Date.now(),
    };
    const db = createRouteDb({
      getExhaustedInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
      getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([staleAttempt]),
      claimInterruptResumeDelivery: vi.fn().mockImplementation(async (input: {
        ownerId: string;
      }) => ({
        attempt: claimedAttempt,
        lease: {
          turnId: 'turn-1',
          ownerId: input.ownerId,
          fenceToken: 2,
          leaseExpiresAt: Date.now() + 60_000,
          updatedAt: Date.now(),
        },
      })),
      completeInterruptResumeDelivery: vi.fn().mockResolvedValue({
        ...claimedAttempt,
        status: 'completed',
      }),
    });
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const sessionManager = createResumeSessionManager();

    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);
    await flushAsyncResume();

    expect(db.claimInterruptResumeDelivery).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-stale',
      sandboxSessionId: 'sess-1',
      ownerId: expect.any(String),
      leaseDurationMs: expect.any(Number),
    }));
    expect(sessionManager.prepareInterruptContinuation).toHaveBeenCalledWith(
      'sess-1',
      'turn-1',
      'agent-1',
      'interrupt-1',
      {
        attemptId: 'attempt-stale',
        fence: expect.objectContaining({
          ownerId: expect.any(String),
          fenceToken: 2,
        }),
      },
    );
    expect(db.completeInterruptResumeDelivery).toHaveBeenCalledWith(
      'attempt-stale',
      expect.objectContaining({ fenceToken: 2 }),
    );
  });

  it('keeps a resolved interrupt with an active resume attempt actionable', async () => {
    const row = createInterruptRow({ status: 'resolved', resolvedAction: 'approve' });
    const activeAttempt = {
      id: 'attempt-active',
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      sandboxSessionId: 'sess-1',
      agentId: 'agent-1',
      status: 'in_progress',
      attempts: 1,
      lastError: null,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
      completedAt: null,
    };
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const db = createRouteDb({
      getInterruptById: vi.fn().mockResolvedValue(row),
      getInterruptResumeAttemptForInterrupt: vi.fn().mockResolvedValue(activeAttempt),
    });
    const sessionManager = createResumeSessionManager();
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', interruptId: 'interrupt-1' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: true,
      resuming: true,
      action: 'approve',
      resumeAttemptId: 'attempt-active',
    });
    expect(db.resolveInterruptWithResumeAttempt).not.toHaveBeenCalled();
  });

  it('repairs a resolved interrupt that has no resume attempt instead of returning 409', async () => {
    const row = createInterruptRow({
      status: 'resolved',
      resolvedAction: 'approve',
      resolvedData: { approved: true },
    });
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const db = createRouteDb({
      getInterruptById: vi.fn().mockResolvedValue(row),
      getInterruptResumeAttemptForInterrupt: vi.fn().mockResolvedValue(undefined),
    });
    const sessionManager = createResumeSessionManager();
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', interruptId: 'interrupt-1' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(expect.objectContaining({
      accepted: true,
      resuming: true,
      action: 'approve',
      resumeAttemptId: 'attempt-1',
    }));
    expect(db.resolveInterruptWithResumeAttempt).toHaveBeenCalledWith(
      'interrupt-1',
      'approve',
      { approved: true },
    );
  });

  it('rejects a retry action that conflicts with the persisted resolution', async () => {
    const row = createInterruptRow({
      status: 'resolved',
      resolvedAction: 'reject',
      resolvedData: 'not allowed',
    });
    const failedAttempt = {
      id: 'attempt-failed',
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      sandboxSessionId: 'sess-1',
      agentId: 'agent-1',
      status: 'failed',
      attempts: 1,
      lastError: 'restore failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      completedAt: null,
    };
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const db = createRouteDb({
      getInterruptById: vi.fn().mockResolvedValue(row),
      getInterruptResumeAttemptForInterrupt: vi.fn().mockResolvedValue(failedAttempt),
    });
    const sessionManager = createResumeSessionManager();
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', interruptId: 'interrupt-1' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Interrupt was already resolved with a different action',
      action: 'reject',
    });
    expect(db.retryFailedInterruptResumeAttempt).not.toHaveBeenCalled();
    expect(sessionManager.executeInterruptContinuation).not.toHaveBeenCalled();
  });

  it('404s when no interrupt exists anywhere', async () => {
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const app = await buildApp({ db: createRouteDb(), interrupts });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', interruptId: 'missing-interrupt' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('marks the attempt failed when the resume service is unavailable', async () => {
    const row = createInterruptRow();
    const store = createManagerStore([row]);
    const interrupts = new InterruptManager(undefined, store);
    await interrupts.loadFromDb();

    const db = createRouteDb({ getInterruptById: vi.fn().mockResolvedValue(row) });
    const app = await buildApp({ db, interrupts, sessionManager: undefined });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', interruptId: 'interrupt-1' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(expect.objectContaining({
      accepted: true,
      resuming: false,
      resumeAttemptId: 'attempt-1',
    }));
    expect(db.failUnclaimedInterruptResumeAttempt).toHaveBeenCalledWith(
      'attempt-1',
      'Session resume service is not available',
    );
  });

  it('loads actionable interrupt rows once and filters resolved rows by default', async () => {
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const getActionableInterruptsForAgent = vi.fn().mockResolvedValue([
      { interrupt: createInterruptRow({ id: 'pending-1', turnId: 'turn-pending-1' }), resumeAttempt: undefined },
      { interrupt: createInterruptRow({ id: 'resolved-1', turnId: 'turn-resolved-1', status: 'resolved' }), resumeAttempt: undefined },
      {
        interrupt: createInterruptRow({ id: 'failed-1', turnId: 'turn-failed-1', status: 'resolved' }),
        resumeAttempt: { status: 'failed', lastError: 'resume failed' },
      },
    ]);
    const db = createRouteDb({ getActionableInterruptsForAgent });
    const app = await buildApp({ db, interrupts });
    apps.push(app);

    const defaultResponse = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/interrupts',
    });

    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.json().interrupts).toEqual([
      expect.objectContaining({
        id: 'pending-1',
        turnId: 'turn-pending-1',
        sandboxSessionId: 'sess-1',
        toolName: 'send_email',
        status: 'pending',
      }),
      expect.objectContaining({
        id: 'failed-1',
        turnId: 'turn-failed-1',
        sandboxSessionId: 'sess-1',
        status: 'resume_failed',
        resumeError: 'resume failed',
      }),
    ]);
    expect(defaultResponse.json().interrupts[0]).not.toHaveProperty('sessionId');
    expect(defaultResponse.json().interrupts[0]).not.toHaveProperty('toolCallName');
    expect(getActionableInterruptsForAgent).toHaveBeenCalledTimes(1);
    expect(getActionableInterruptsForAgent).toHaveBeenLastCalledWith('agent-1');

    const includeResolvedResponse = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/interrupts?include_resolved=true',
    });

    expect(includeResolvedResponse.statusCode).toBe(200);
    expect(includeResolvedResponse.json().interrupts.map((row) => row.id)).toEqual([
      'pending-1',
      'resolved-1',
      'failed-1',
    ]);
    expect(getActionableInterruptsForAgent).toHaveBeenCalledTimes(2);
  });
});
