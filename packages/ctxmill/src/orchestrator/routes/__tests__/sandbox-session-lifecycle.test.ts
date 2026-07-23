import Fastify, { type FastifyRequest } from 'fastify';
import { SandboxSessionListResponseSchema } from '@ctxmill/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActiveTurnSuspendError,
  RestoreConflictError,
} from '../../session-manager/session-lifecycle-service.js';
import { InvalidCheckpointError } from '../../session-manager/restore-retry-policy.js';
import { activeSandboxSessionRoutes } from '../agents/active-lifecycle.js';
import { turnRoutes } from '../agents/turns.js';
import type { ActiveLifecycleRouteOptions, AgentSubRouteOptions, StoredAgent } from '../agents/types.js';
import { createTestTurnStartupService } from '../../__tests__/turn-startup-test-helper.js';

const agent = {
  id: 'agent-1',
  name: 'agent',
  harness: 'claude-agents',
  harnessConfig: '{}',
  systemPrompt: 'system',
  tools: [],
  metadata: {},
  manifest: null,
} as unknown as StoredAgent;

function createAgentRoutesApp(overrides: Partial<AgentSubRouteOptions>) {
  const app = Fastify({ logger: false });
  const loadAgent = async (request: FastifyRequest) => {
    Object.assign(request, { agent });
  };

  void app.register(turnRoutes, {
    prefix: '/api/agents',
    db: {},
    sse: {},
    interrupts: {},
    harnessSchemas: {},
    turnStartupService: createTestTurnStartupService(),
    loadAgent,
    ...overrides,
  } as unknown as AgentSubRouteOptions);

  return app;
}

function createActiveSandboxSessionsApp(overrides: ActiveLifecycleRouteOptions) {
  const app = Fastify({ logger: false });
  void app.register(activeSandboxSessionRoutes, {
    prefix: '/api/sandbox-sessions',
    ...overrides,
  } as unknown as ActiveLifecycleRouteOptions);
  return app;
}

describe('sandbox session lifecycle routes', () => {
  const apps: ReturnType<typeof createAgentRoutesApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns the active-turn suspend conflict body from the public sandbox suspend endpoint', async () => {
    const db = {
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        status: 'ACTIVE',
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
      error: 'Sandbox session has active turn',
      status: 'ACTIVE',
      sandboxSessionId: 'sandbox-1',
      turnId: 'turn-1',
    });
    expect(sessionManager.suspendSession).toHaveBeenCalledWith('sandbox-1', 'api_request');
  });

  it('suspends an idle ACTIVE sandbox even when the latest turn already completed (ctx-jgb5)', async () => {
    const db = {
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        status: 'ACTIVE',
      }),
    };
    const sessionManager = {
      suspendSession: vi.fn().mockResolvedValue(undefined),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/suspend',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sandboxSessionId: 'sandbox-1', status: 'CHECKPOINTED' });
  });

  it('rejects suspend with the real sandbox status when the row is not ACTIVE', async () => {
    const db = {
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        status: 'CHECKPOINTED',
      }),
    };
    const sessionManager = {
      suspendSession: vi.fn(),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/suspend',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Sandbox session not active',
      status: 'CHECKPOINTED',
      sandboxSessionId: 'sandbox-1',
    });
    expect(sessionManager.suspendSession).not.toHaveBeenCalled();
  });

  it('restores a checkpointed sandbox session through the public restore endpoint', async () => {
    const db = {
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        status: 'CHECKPOINTED',
      }),
    };
    const sessionManager = {
      restoreSession: vi.fn().mockResolvedValue({ sessionId: 'sandbox-1', status: 'ACTIVE' }),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/restore',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sandboxSessionId: 'sandbox-1',
      status: 'ACTIVE',
      restoreAttempts: 0,
    });
    expect(sessionManager.restoreSession).toHaveBeenCalledWith(
      'sandbox-1',
      expect.objectContaining({ name: agent.name }),
      'agent-1',
    );
  });

  it('starts async restore through the public restore endpoint when requested', async () => {
    const db = {
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        status: 'CHECKPOINTED',
      }),
    };
    const sessionManager = {
      restoreSession: vi.fn().mockResolvedValue({
        sandboxSessionId: 'sandbox-1',
        status: 'RESTORING',
        restoreAttempts: 0,
      }),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/restore?async=true',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      sandboxSessionId: 'sandbox-1',
      status: 'RESTORING',
      restoreAttempts: 0,
    });
    expect(sessionManager.restoreSession).toHaveBeenCalledWith(
      'sandbox-1',
      expect.objectContaining({ name: agent.name }),
      'agent-1',
      { background: true },
    );
  });

  it('returns 404 for restore when the sandbox session does not belong to the agent', async () => {
    const db = {
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-1',
        conversationId: 'conversation-1',
        agentId: 'other-agent',
        status: 'CHECKPOINTED',
      }),
    };
    const sessionManager = { restoreSession: vi.fn() };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/restore',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Sandbox session not found',
      sandboxSessionId: 'sandbox-1',
    });
    expect(sessionManager.restoreSession).not.toHaveBeenCalled();
  });

  it.each(['ACTIVE', 'RESTORING', 'TERMINATED'])(
    'returns 409 for restore when sandbox status is %s before invoking lifecycle service',
    async (status) => {
      const db = {
        getSandboxSession: vi.fn().mockResolvedValue({
          id: 'sandbox-1',
          conversationId: 'conversation-1',
          agentId: 'agent-1',
          status,
        }),
      };
      const sessionManager = { restoreSession: vi.fn() };
      const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
      apps.push(app);

      const response = await app.inject({
        method: 'POST',
        url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/restore',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Sandbox session not checkpointed',
        status,
        sandboxSessionId: 'sandbox-1',
      });
      expect(sessionManager.restoreSession).not.toHaveBeenCalled();
    },
  );

  it('returns 409 when restore loses the checkpointed race inside the lifecycle lock', async () => {
    const db = {
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        status: 'CHECKPOINTED',
      }),
    };
    const sessionManager = {
      restoreSession: vi.fn().mockRejectedValue(new RestoreConflictError('sandbox-1', 'ACTIVE')),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/restore',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Sandbox session not checkpointed',
      status: 'ACTIVE',
      sandboxSessionId: 'sandbox-1',
    });
  });

  it('returns retryable 502 restore failure details', async () => {
    const db = {
      getSandboxSession: vi.fn()
        .mockResolvedValueOnce({
          id: 'sandbox-1',
          conversationId: 'conversation-1',
          agentId: 'agent-1',
          status: 'CHECKPOINTED',
        })
        .mockResolvedValueOnce({
          id: 'sandbox-1',
          conversationId: 'conversation-1',
          agentId: 'agent-1',
          status: 'CHECKPOINTED',
          restoreAttempts: 1,
          lastRestoreError: 'connect ECONNREFUSED',
        }),
    };
    const sessionManager = {
      restoreSession: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/restore',
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual(expect.objectContaining({
      error: 'Restore failed',
      code: 'restore_failed',
      category: 'retryable',
      detail: 'connect ECONNREFUSED',
      status: 'CHECKPOINTED',
      restoreAttempts: 1,
      sandboxSessionId: 'sandbox-1',
    }));
  });

  it('returns non-retryable 502 restore failure details for invalid checkpoints', async () => {
    const db = {
      getSandboxSession: vi.fn()
        .mockResolvedValueOnce({
          id: 'sandbox-1',
          conversationId: 'conversation-1',
          agentId: 'agent-1',
          status: 'CHECKPOINTED',
        })
        .mockResolvedValueOnce({
          id: 'sandbox-1',
          conversationId: 'conversation-1',
          agentId: 'agent-1',
          status: 'TERMINATED',
          restoreAttempts: 1,
          lastRestoreError: 'No checkpoint found',
        }),
    };
    const sessionManager = {
      restoreSession: vi.fn().mockRejectedValue(new InvalidCheckpointError('No checkpoint found')),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/restore',
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual(expect.objectContaining({
      error: 'Restore failed',
      code: 'restore_failed',
      category: 'non_retryable',
      detail: 'No checkpoint found',
      status: 'TERMINATED',
      restoreAttempts: 1,
      sandboxSessionId: 'sandbox-1',
    }));
  });

  it('kills an owned sandbox session through the public kill endpoint', async () => {
    const db = {
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-1',
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        status: 'ACTIVE',
      }),
    };
    const sessionManager = {
      killSession: vi.fn().mockResolvedValue(undefined),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/kill',
    });

    expect(response.statusCode).toBe(204);
    expect(db.getSandboxSession).toHaveBeenCalledWith('sandbox-1');
    expect(sessionManager.killSession).toHaveBeenCalledWith('sandbox-1');
  });

  it('returns 404 for kill when the sandbox session does not belong to the agent', async () => {
    const db = {
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-1',
        conversationId: 'conversation-1',
        agentId: 'other-agent',
        status: 'ACTIVE',
      }),
    };
    const sessionManager = {
      killSession: vi.fn(),
    };
    const app = createAgentRoutesApp({ db, sessionManager } as unknown as Partial<AgentSubRouteOptions>);
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/sandbox-sessions/sandbox-1/kill',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Sandbox session not found',
      sandboxSessionId: 'sandbox-1',
    });
    expect(sessionManager.killSession).not.toHaveBeenCalled();
  });

});

describe('global sandbox session readback route', () => {
  const apps: ReturnType<typeof createActiveSandboxSessionsApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('uses lifecycle readback and defers active-turn sessions instead of raw DB rows', async () => {
    const row = {
      id: 'sandbox-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      containerName: 'ctxmill-sandbox-1',
      containerId: 'container-1',
      status: 'ACTIVE',
      harnessName: 'claude-agents',
      checkpointRef: null,
      createdAt: 1,
      updatedAt: 2,
      lastActivityAt: 3,
      restoreAttempts: 1,
      lastRestoreError: null,
      restoreOwnerId: null,
      restoreFenceToken: 2,
      restoreLeaseExpiresAt: null,
      runtimeDefinitionHash: 'internal-runtime-definition',
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
    const app = createActiveSandboxSessionsApp({
      db: db as never,
      lifecyclePolicy: lifecyclePolicy as never,
      sessionManager: sessionManager as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/sandbox-sessions?status=active',
    });

    expect(response.statusCode).toBe(200);
    const publicRow = Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => key !== 'runtimeDefinitionHash',
      ),
    );
    expect(SandboxSessionListResponseSchema.parse(response.json())).toEqual([
      publicRow,
    ]);
    expect(response.json()[0]).not.toHaveProperty(
      'runtimeDefinitionHash',
    );
    expect(lifecyclePolicy.getActiveSandboxSessionsForReadback).toHaveBeenCalledTimes(1);
    expect(db.getActiveSandboxSessions).not.toHaveBeenCalled();
    expect(shouldDefer?.(row)).toBe(true);
    expect(sessionManager.getActiveTurnId).toHaveBeenCalledWith('sandbox-1');
  });
});
