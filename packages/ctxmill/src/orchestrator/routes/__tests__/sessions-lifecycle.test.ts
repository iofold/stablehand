import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActiveTurnSuspendError } from '../../session-manager/session-lifecycle-service.js';
import { globalSessionsRoutes } from '../agents/global-sessions.js';
import { sessionRoutes } from '../agents/sessions.js';
import type { AgentSubRouteOptions, SessionsRouteOptions, StoredAgent } from '../agents/types.js';

const agent = {
  id: 'agent-1',
  name: 'agent',
  harness: 'claude-agents',
  harnessConfig: {},
  metadata: {},
  manifest: null,
} as unknown as StoredAgent;

function createAgentRoutesApp(overrides: Partial<AgentSubRouteOptions>) {
  const app = Fastify({ logger: false });
  const loadAgent = async (request: FastifyRequest) => {
    Object.assign(request, { agent });
  };

  void app.register(sessionRoutes, {
    prefix: '/api/agents',
    db: {},
    sse: {},
    interrupts: {},
    harnessRegistry: {},
    agentSessionService: {},
    runStartupService: {},
    loadAgent,
    ...overrides,
  } as unknown as AgentSubRouteOptions);

  return app;
}

function createGlobalSessionsApp(overrides: SessionsRouteOptions) {
  const app = Fastify({ logger: false });
  void app.register(globalSessionsRoutes, {
    prefix: '/api/sessions',
    ...overrides,
  } as unknown as SessionsRouteOptions);
  return app;
}

describe('session lifecycle routes', () => {
  const apps: ReturnType<typeof createAgentRoutesApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns the active-turn suspend conflict body from the public sandbox suspend endpoint', async () => {
    const db = {
      getSandboxSessionsByAgent: vi.fn().mockResolvedValue([
        { id: 'sandbox-1', conversationId: 'conversation-1' },
      ]),
      getLatestTurnForConversation: vi.fn().mockResolvedValue({
        id: 'turn-1',
        completedAt: null,
        error: null,
      }),
    };
    const sessionManager = {
      suspendSession: vi.fn().mockRejectedValue(new ActiveTurnSuspendError('sandbox-1', 'turn-1')),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/suspend',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Session has active turn',
      status: 'ACTIVE',
      sessionId: 'sandbox-1',
      turnId: 'turn-1',
    });
    expect(sessionManager.suspendSession).toHaveBeenCalledWith('sandbox-1', 'api_request');
  });
});

describe('global sandbox session readback route', () => {
  const apps: ReturnType<typeof createGlobalSessionsApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('uses lifecycle readback and defers active-turn sessions instead of raw DB rows', async () => {
    const row = {
      id: 'sandbox-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      status: 'ACTIVE',
    };
    let shouldDefer: ((session: typeof row) => boolean) | undefined;
    const lifecyclePolicy = {
      getActiveSandboxSessionsForReadback: vi.fn(async (options) => {
        shouldDefer = options.shouldDefer;
        return [row];
      }),
    };
    const db = {
      getActiveSandboxSessions: vi.fn().mockResolvedValue([]),
    };
    const sessionManager = {
      getActiveTurnId: vi.fn((sessionId: string) => (sessionId === 'sandbox-1' ? 'turn-1' : undefined)),
    };
    const app = createGlobalSessionsApp({
      db: db as never,
      lifecyclePolicy: lifecyclePolicy as never,
      sessionManager: sessionManager as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions?format=sandbox',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([row]);
    expect(lifecyclePolicy.getActiveSandboxSessionsForReadback).toHaveBeenCalledTimes(1);
    expect(db.getActiveSandboxSessions).not.toHaveBeenCalled();
    expect(shouldDefer?.(row)).toBe(true);
    expect(sessionManager.getActiveTurnId).toHaveBeenCalledWith('sandbox-1');
  });
});
