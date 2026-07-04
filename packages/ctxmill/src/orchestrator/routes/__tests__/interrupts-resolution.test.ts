import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InterruptManager } from '../../interrupt.js';
import { interruptRoutes } from '../agents/interrupts.js';
import type { AgentSubRouteOptions, StoredAgent } from '../agents/types.js';

const agent = { id: 'agent-1', name: 'agent' } as unknown as StoredAgent;

function createInterruptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'turn-1',
    agentSessionId: 'turn-1',
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
    sessionId: 'sess-1',
    ...overrides,
  };
}

function createRouteDb(overrides: Record<string, unknown> = {}) {
  return {
    getPendingInterrupt: vi.fn().mockResolvedValue(undefined),
    getInterruptResumeAttemptForInterrupt: vi.fn().mockResolvedValue(undefined),
    getActionableInterruptsForAgent: vi.fn().mockResolvedValue([]),
    resolveInterrupt: vi.fn().mockResolvedValue(createInterruptRow({ status: 'resolved' })),
    upsertInterruptResumeAttempt: vi.fn().mockResolvedValue({ id: 'attempt-1', status: 'pending' }),
    markInterruptResumeAttemptInProgress: vi.fn().mockResolvedValue(undefined),
    markInterruptResumeAttemptCompleted: vi.fn().mockResolvedValue(undefined),
    markInterruptResumeAttemptFailed: vi.fn().mockResolvedValue(undefined),
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
  sessionManager?: { resumeWithInterruptResolution: ReturnType<typeof vi.fn> };
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
    const db = createRouteDb({ getPendingInterrupt: vi.fn().mockResolvedValue(createInterruptRow()) });
    const sessionManager = { resumeWithInterruptResolution: vi.fn().mockResolvedValue(undefined) };
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', sessionId: 'turn-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ resolved: true, action: 'approve' });
    await expect(waiter).resolves.toEqual({ action: 'approve', data: undefined });
    expect(sessionManager.resumeWithInterruptResolution).not.toHaveBeenCalled();
  });

  it('falls through to the durable resume when the rehydrated entry has no live waiter (ctx-8nnu)', async () => {
    const row = createInterruptRow();
    const store = createManagerStore([row]);
    const interrupts = new InterruptManager(undefined, store);
    await interrupts.loadFromDb();
    expect(interrupts.hasPending('turn-1')).toBe(true);
    expect(interrupts.hasLiveWaiter('turn-1')).toBe(false);

    const db = createRouteDb({ getPendingInterrupt: vi.fn().mockResolvedValue(row) });
    const sessionManager = { resumeWithInterruptResolution: vi.fn().mockResolvedValue(undefined) };
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', sessionId: 'turn-1' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(expect.objectContaining({
      accepted: true,
      resuming: true,
      action: 'approve',
      resumeAttemptId: 'attempt-1',
    }));
    // resolve() persisted through the manager's store; the route must not
    // double-call its own db.resolveInterrupt (would 409 on the resolved row).
    expect(store.resolveInterrupt).toHaveBeenCalledTimes(1);
    expect(db.resolveInterrupt).not.toHaveBeenCalled();

    await flushAsyncResume();
    expect(sessionManager.resumeWithInterruptResolution).toHaveBeenCalledWith('sess-1', 'turn-1', 'agent-1');
    expect(db.markInterruptResumeAttemptCompleted).toHaveBeenCalledWith('attempt-1');
  });

  it('enqueues a durable continuation for reject as well (ctx-qjnz)', async () => {
    const row = createInterruptRow();
    const store = createManagerStore([row]);
    const interrupts = new InterruptManager(undefined, store);
    await interrupts.loadFromDb();

    const db = createRouteDb({ getPendingInterrupt: vi.fn().mockResolvedValue(row) });
    const sessionManager = { resumeWithInterruptResolution: vi.fn().mockResolvedValue(undefined) };
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'reject', sessionId: 'turn-1', data: 'not allowed' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(expect.objectContaining({ accepted: true, action: 'reject' }));
    await flushAsyncResume();
    expect(sessionManager.resumeWithInterruptResolution).toHaveBeenCalledWith('sess-1', 'turn-1', 'agent-1');
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
      payload: { action: 'approve', sessionId: 'turn-other' },
    });

    expect(response.statusCode).toBe(404);
    expect(interrupts.hasPending('turn-other')).toBe(true);
    expect(store.resolveInterrupt).not.toHaveBeenCalled();
  });

  it('retries a failed durable resume for reject resolutions too', async () => {
    const row = createInterruptRow({ status: 'resolved', resolvedAction: 'reject' });
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const db = createRouteDb({
      getPendingInterrupt: vi.fn().mockResolvedValue(row),
      getInterruptResumeAttemptForInterrupt: vi.fn().mockResolvedValue({ id: 'attempt-0', status: 'failed' }),
    });
    const sessionManager = { resumeWithInterruptResolution: vi.fn().mockResolvedValue(undefined) };
    const app = await buildApp({ db, interrupts, sessionManager });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'reject', sessionId: 'turn-1' },
    });

    expect(response.statusCode).toBe(202);
    await flushAsyncResume();
    expect(sessionManager.resumeWithInterruptResolution).toHaveBeenCalled();
  });

  it('reports alreadyResolved for a resolved interrupt with a completed resume attempt', async () => {
    const row = createInterruptRow({ status: 'resolved', resolvedAction: 'approve' });
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const db = createRouteDb({
      getPendingInterrupt: vi.fn().mockResolvedValue(row),
      getInterruptResumeAttemptForInterrupt: vi.fn().mockResolvedValue({ id: 'attempt-0', status: 'completed' }),
    });
    const app = await buildApp({ db, interrupts });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', sessionId: 'turn-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ alreadyResolved: true, action: 'approve' });
  });

  it('404s when no interrupt exists anywhere', async () => {
    const interrupts = new InterruptManager(undefined, createManagerStore());
    const app = await buildApp({ db: createRouteDb(), interrupts });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', sessionId: 'missing-turn' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('marks the attempt failed when the resume service is unavailable', async () => {
    const row = createInterruptRow();
    const store = createManagerStore([row]);
    const interrupts = new InterruptManager(undefined, store);
    await interrupts.loadFromDb();

    const db = createRouteDb({ getPendingInterrupt: vi.fn().mockResolvedValue(row) });
    const app = await buildApp({ db, interrupts, sessionManager: undefined });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/interrupt',
      payload: { action: 'approve', sessionId: 'turn-1' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(expect.objectContaining({
      accepted: true,
      resuming: false,
      resumeAttemptId: 'attempt-1',
    }));
    expect(db.markInterruptResumeAttemptFailed).toHaveBeenCalledWith('attempt-1', 'Session resume service is not available');
  });
});
