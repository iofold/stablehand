import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SandboxSessionManager,
  type SessionRecord,
} from '../sandbox-session-manager.js';
import type { SessionEvent } from '../session-turn-service.js';
import type {
  CheckpointV2,
  DatabaseRepository,
  InterruptRow,
  SandboxSessionRow,
} from '../../database/repository.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { ContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { AgentDefinition } from '../../types.js';

type SandboxSessionManagerInternals = {
  stateStore: {
    agentDefs: Map<string, AgentDefinition>;
  };
};

function createMockContainerManager(): ContainerManager {
  return {
    extractContainerDiff: vi.fn().mockResolvedValue(null),
    extractWorkspaceDiff: vi.fn().mockResolvedValue(null),
  } as unknown as ContainerManager;
}

function createMockDb(): DatabaseRepository {
  return {
    getAgent: vi.fn().mockResolvedValue(null),
    getSandboxSession: vi.fn().mockResolvedValue(null),
    getResolvedInterruptsForSession: vi.fn().mockResolvedValue([]),
    getCheckpointV2: vi.fn().mockResolvedValue(null),
    addMessage: vi.fn().mockImplementation(async (data: Record<string, unknown>) => ({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...data,
    })),
  } as unknown as DatabaseRepository;
}

function createMockLifecyclePolicy(): ContainerLifecyclePolicy {
  return {
    cancelIdleTimeout: vi.fn().mockResolvedValue(undefined),
    scheduleIdleTimeout: vi.fn(),
  } as unknown as ContainerLifecyclePolicy;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createAgentDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'test-agent',
    harness: 'langgraph',
    harnessConfig: {},
    tools: ['search-docs'],
    systemPrompt: 'follow the system prompt',
    ...overrides,
  } as unknown as AgentDefinition;
}

function createDbSession(overrides?: Partial<SandboxSessionRow>): SandboxSessionRow {
  return {
    id: 'sess-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    containerName: 'ctxmill-run-sess-1',
    containerId: 'c-1',
    status: 'CHECKPOINTED',
    harnessName: 'langgraph',
    checkpointRef: 'ckpt-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    pausedAt: null,
    pausedReason: null,
    ...overrides,
  };
}

function createResolvedInterrupt(overrides?: Partial<InterruptRow>): InterruptRow {
  return {
    id: 'interrupt-1',
    agentSessionId: 'turn-1',
    agentId: 'agent-1',
    toolCallId: 'approval-1',
    toolName: 'request-approval',
    args: {
      tool: 'send_email',
      args: { to: 'person@example.com', body: 'hello' },
    },
    timeoutMs: 300_000,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    status: 'resolved',
    resolvedAction: 'approve',
    resolvedData: { reason: 'ok' },
    sessionId: 'sess-1',
    ...overrides,
  } as InterruptRow;
}

function createCheckpoint(checkpointData?: Record<string, unknown>): CheckpointV2 {
  return {
    id: 'ckpt-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    checkpointVersion: 2,
    checkpointData: checkpointData ?? {},
    harnessState: {},
    workspaceRef: null,
    suspendReason: 'hitl-wait',
    createdAt: Date.now(),
  };
}

function createCheckpointWithPendingRequests(
  pendingRequests: Array<Record<string, unknown>>,
): CheckpointV2 {
  return createCheckpoint({
    runnerState: {
      pendingRequests,
    },
  });
}

function createPendingApproval(
  id: string,
  payload?: { tool?: unknown; args?: unknown },
): Record<string, unknown> {
  return {
    type: 'approval',
    id,
    payload: payload ?? {
      tool: 'send_email',
      args: { to: 'person@example.com', body: 'hello' },
    },
  };
}

function createSessionRecord(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    sessionId: 'sess-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    containerName: 'ctxmill-run-sess-1',
    containerId: 'c-1',
    status: 'ACTIVE',
    harnessName: 'langgraph',
    ...overrides,
  };
}

async function* streamSessionEvents(...events: SessionEvent[]): AsyncGenerator<SessionEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('SandboxSessionManager interrupt resume characterization', () => {
  let containerManager: ContainerManager;
  let db: DatabaseRepository;
  let lifecyclePolicy: ContainerLifecyclePolicy;
  let logger: ReturnType<typeof createLogger>;
  let manager: SandboxSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    containerManager = createMockContainerManager();
    db = createMockDb();
    lifecyclePolicy = createMockLifecyclePolicy();
    logger = createLogger();

    manager = new SandboxSessionManager({
      containerManager,
      db,
      lifecyclePolicy,
      workspaceDiffService: new WorkspaceDiffService({ containerManager }),
      buildSandboxSecrets: () => ({}),
      logger,
      config: {
        idleTimeoutMs: 60_000,
        maxQueuedMessages: 10,
      },
    });
  });

  it('scenario 1: resumes with checkpoint-backed pending approvals', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    const agentDef = createAgentDef();
    internals.stateStore.agentDefs.set('conv-1', agentDef);

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    const ensureSessionSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1');

    expect(ensureSessionSpy).toHaveBeenCalledWith('conv-1', agentDef, 'agent-1');
    expect(db.addMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: '',
      toolCalls: [expect.objectContaining({
        id: 'approval-1',
        name: 'request-approval',
        args: JSON.stringify({
          tool: 'send_email',
          args: { to: 'person@example.com', body: 'hello' },
        }),
        status: 'complete',
      })],
    }));
    expect(db.addMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'tool',
      content: 'APPROVED',
      toolCallId: 'approval-1',
    }));

    expect(deliverTurnSpy).toHaveBeenCalledTimes(1);
    const [sessionId, continuationMessages, continuationTurnId] = deliverTurnSpy.mock.calls[0] ?? [];
    expect(sessionId).toBe('sess-1');
    expect(continuationTurnId).toMatch(/^hitl-resume-turn-1-/);
    expect(continuationMessages).toEqual([
      expect.objectContaining({
        agentId: 'agent-1',
        role: 'assistant',
        content: '',
        toolCalls: [expect.objectContaining({
          id: 'approval-1',
          name: 'request-approval',
          arguments: {
            tool: 'send_email',
            args: { to: 'person@example.com', body: 'hello' },
          },
        })],
      }),
      expect.objectContaining({
        agentId: 'agent-1',
        role: 'tool',
        content: 'APPROVED',
        toolCallId: 'approval-1',
      }),
    ]);
  });

  it('scenario 2: returns early when no resolved interrupt matches turnId', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt({ agentSessionId: 'different-turn' }),
    ]);

    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no resolved interrupt matching turnId=turn-1'),
    );
    expect(db.addMessage).not.toHaveBeenCalled();
    expect(deliverTurnSpy).not.toHaveBeenCalled();
  });

  it('scenario 3: falls back when checkpoint requests do not yield approval continuations', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt({
        toolCallId: 'interrupt-tool-call',
        args: { tool: 'delete_file', args: { path: '/tmp/demo.txt' } },
      }),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([
        {
          type: 'needs-review',
          id: 'different-tool-call',
          payload: {
            tool: 'delete_file',
            args: { path: '/tmp/ignored.txt' },
          },
        },
      ]),
    );

    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1');

    expect(db.addMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      role: 'assistant',
      toolCalls: [expect.objectContaining({
        id: 'interrupt-tool-call',
        args: JSON.stringify({
          tool: 'delete_file',
          args: { path: '/tmp/demo.txt' },
        }),
      })],
    }));
    expect(db.addMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      role: 'tool',
      content: 'APPROVED',
      toolCallId: 'interrupt-tool-call',
    }));

    expect(deliverTurnSpy).toHaveBeenCalledTimes(1);
    const continuationMessages = deliverTurnSpy.mock.calls[0]?.[1];
    expect(continuationMessages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: [expect.objectContaining({
          id: 'interrupt-tool-call',
          arguments: {
            tool: 'delete_file',
            args: { path: '/tmp/demo.txt' },
          },
        })],
      }),
      expect.objectContaining({
        role: 'tool',
        content: 'APPROVED',
        toolCallId: 'interrupt-tool-call',
      }),
    ]);
  });

  it('scenario 4: falls back when checkpoint is stale and has no pending approval requests', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt({
        toolCallId: 'stale-tool-call',
        args: { tool: 'send_email', args: { to: 'fallback@example.com' } },
      }),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpoint({ runnerState: { status: 'HITL_WAIT' } }),
    );

    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1');

    expect(db.addMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      role: 'assistant',
      toolCalls: [expect.objectContaining({ id: 'stale-tool-call' })],
    }));
    expect(db.addMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      role: 'tool',
      content: 'APPROVED',
      toolCallId: 'stale-tool-call',
    }));

    const continuationMessages = deliverTurnSpy.mock.calls[0]?.[1];
    expect(continuationMessages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: [expect.objectContaining({ id: 'stale-tool-call' })],
      }),
      expect.objectContaining({
        role: 'tool',
        content: 'APPROVED',
        toolCallId: 'stale-tool-call',
      }),
    ]);
  });

  it('fails visibly when a checkpoint pending request payload is malformed', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([
        {
          type: 'approval',
          id: 'approval-1',
          payload: '{"tool":',
        },
      ]),
    );

    const ensureSessionSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await expect(
      manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1'),
    ).rejects.toThrow(/Malformed HITL checkpoint pending request payload JSON/);

    expect(ensureSessionSpy).not.toHaveBeenCalled();
    expect(db.addMessage).not.toHaveBeenCalled();
    expect(deliverTurnSpy).not.toHaveBeenCalled();
  });

  it('fails visibly instead of using a degraded stub when an agent definition cannot be resolved', async () => {
    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (db.getResolvedInterruptsForSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    const ensureSessionSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await expect(
      manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1'),
    ).rejects.toThrow(/missing agent definition/);

    expect(ensureSessionSpy).not.toHaveBeenCalled();
    expect(db.addMessage).not.toHaveBeenCalled();
    expect(deliverTurnSpy).not.toHaveBeenCalled();
  });

  it('scenario 5: resolves agent definition from the database on cache miss', async () => {
    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      createDbSession({ harnessName: 'claude' }),
    );
    (db.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'agent-1',
      name: 'db-agent',
      harness: 'claude',
      harnessConfig: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
      tools: ['search-docs', 'send-email'],
      systemPrompt: 'db-backed system prompt',
      description: 'db description',
      metadata: { team: 'ops' },
      workspaceDir: '/tmp/agents/agent-1/workspace',
      manifest: null,
    });
    (db.getResolvedInterruptsForSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt({ resolvedAction: 'approve' }),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    const ensureSessionSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    vi.spyOn(manager, 'deliverTurn').mockImplementation(() => streamSessionEvents());

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1');

    const resolvedAgentDef = ensureSessionSpy.mock.calls[0]?.[1];
    expect(db.getAgent).toHaveBeenCalledWith('agent-1');
    expect(resolvedAgentDef).toMatchObject({
      name: 'db-agent',
      harness: 'claude',
      harnessConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      tools: ['search-docs', 'send-email'],
      systemPrompt: 'db-backed system prompt',
      description: 'db description',
      metadata: { team: 'ops' },
      workspaceDir: '/tmp/agents/agent-1/workspace',
      projectDir: '/tmp/agents/agent-1',
    });

    expect(resolvedAgentDef?.tools).toEqual(['search-docs', 'send-email']);
    expect(resolvedAgentDef?.systemPrompt).toBe('db-backed system prompt');

    const internals = manager as unknown as SandboxSessionManagerInternals;
    expect(internals.stateStore.agentDefs.get('conv-1')).toMatchObject({
      name: 'db-agent',
      harness: 'claude',
      tools: ['search-docs', 'send-email'],
      systemPrompt: 'db-backed system prompt',
    });
  });

  it('scenario 6: writes REJECTED tool responses for rejection resolutions', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt({ resolvedAction: 'reject' }),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1');

    expect(db.addMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      role: 'tool',
      content: 'REJECTED',
      toolCallId: 'approval-1',
    }));
    expect(deliverTurnSpy.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: [expect.objectContaining({ id: 'approval-1' })],
      }),
      expect.objectContaining({
        role: 'tool',
        content: 'REJECTED',
        toolCallId: 'approval-1',
      }),
    ]);
  });
});
