import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAgentDefinition } from '../agent-definition.js';
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
import type { TypedEventBus } from '../../events/bus.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { ContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import { SessionStateStore } from '../session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../session-manager/session-status-coordinator.js';

type SandboxSessionManagerInternals = {
  stateStore: {
    agentDefs: Map<string, AgentDefinition>;
  };
};

function createMockContainerManager(): ContainerManager {
  return {
    extractWorkspaceDiff: vi.fn().mockResolvedValue(null),
  } as unknown as ContainerManager;
}

function createMockDb(): DatabaseRepository {
  let nextMessageSeq = 0;
  const canonicalMessages = new Map<string, Record<string, unknown>>();

  return {
    getAgent: vi.fn().mockResolvedValue(null),
    getTurn: vi.fn().mockResolvedValue({ status: 'running' }),
    getSandboxSession: vi.fn().mockResolvedValue(null),
    getResolvedInterruptsForSandboxSession: vi.fn().mockResolvedValue([]),
    getCheckpointV2: vi.fn().mockResolvedValue(null),
    finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
    addCanonicalMessage: vi.fn().mockImplementation(async (data: Record<string, unknown>) => {
      const id = typeof data.id === 'string' ? data.id : crypto.randomUUID();
      const existing = canonicalMessages.get(id);
      if (existing) {
        return existing;
      }

      const message = {
        id,
        createdAt: Date.now(),
        messageSeq: nextMessageSeq++,
        messageRevision: 0,
        publishedRevision: -1,
        ...data,
      };
      canonicalMessages.set(id, message);
      return message;
    }),
  } as unknown as DatabaseRepository;
}

function createMockEventBus(): Pick<TypedEventBus, 'emit' | 'emitAsync'> {
  return {
    emit: vi.fn(),
    emitAsync: vi.fn().mockResolvedValue(undefined),
  };
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
    containerName: 'ctxmill-sandbox-sess-1',
    containerId: 'c-1',
    status: 'CHECKPOINTED',
    harnessName: 'langgraph',
    checkpointRef: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function createResolvedInterrupt(overrides?: Partial<InterruptRow>): InterruptRow {
  return {
    id: 'interrupt-1',
    turnId: 'turn-1',
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
    sandboxSessionId: 'sess-1',
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
    containerName: 'ctxmill-sandbox-sess-1',
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

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('SandboxSessionManager interrupt resume characterization', () => {
  let containerManager: ContainerManager;
  let db: DatabaseRepository;
  let lifecyclePolicy: ContainerLifecyclePolicy;
  let logger: ReturnType<typeof createLogger>;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let manager: SandboxSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    containerManager = createMockContainerManager();
    db = createMockDb();
    lifecyclePolicy = createMockLifecyclePolicy();
    logger = createLogger();
    eventBus = createMockEventBus();
    const stateStore = new SessionStateStore();
    const statusCoordinator = new SessionStatusCoordinator({ db, logger, stateStore });

    manager = new SandboxSessionManager({
      containerManager,
      db,
      lifecyclePolicy,
      stateStore,
      statusCoordinator,
      eventBus: eventBus as TypedEventBus,
      workspaceDiffService: new WorkspaceDiffService({ containerManager }),
      buildSandboxSecrets: async () => ({}),
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
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    const ensureSessionSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

    expect(ensureSessionSpy).toHaveBeenCalledWith('conv-1', agentDef, 'agent-1');
    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: 'hitl-assistant-c5e9836414e46aa056f5d09c',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      turnId: 'turn-1',
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
    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: 'hitl-tool-dec742707c485e12fd0900dd',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      role: 'tool',
      content: 'APPROVED',
      toolCallId: 'approval-1',
    }));
    expect(eventBus.emitAsync).toHaveBeenNthCalledWith(
      1,
      'message.committed',
      expect.objectContaining({
        messageId: 'hitl-assistant-c5e9836414e46aa056f5d09c',
        messageSeq: 0,
        role: 'assistant',
      }),
    );
    expect(eventBus.emitAsync).toHaveBeenNthCalledWith(
      2,
      'message.committed',
      expect.objectContaining({
        messageId: 'hitl-tool-dec742707c485e12fd0900dd',
        messageSeq: 1,
        role: 'tool',
      }),
    );

    expect(deliverTurnSpy).toHaveBeenCalledTimes(1);
    const [sessionId, continuationMessages, continuationTurnId] = deliverTurnSpy.mock.calls[0] ?? [];
    expect(sessionId).toBe('sess-1');
    expect(continuationTurnId).toBe('hitl-resume-d718a80a945f45badc81fb3dc779eb89');
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

  it('scenario 2: fails the attempt when its exact resolved interrupt is unavailable', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt({ turnId: 'different-turn' }),
    ]);

    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await expect(
      manager.resumeWithInterruptResolution(
        'sess-1',
        'turn-1',
        'agent-1',
        'interrupt-1',
      ),
    ).rejects.toThrow(/Resolved interrupt interrupt-1 does not match continuation ownership/);

    expect(db.addCanonicalMessage).not.toHaveBeenCalled();
    expect(deliverTurnSpy).not.toHaveBeenCalled();
  });

  it('selects the claimed interrupt exactly when a turn has multiple resolutions', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt({
        id: 'interrupt-wrong',
        resolvedAction: 'reject',
        toolCallId: 'wrong-tool-call',
      }),
      createResolvedInterrupt({
        id: 'interrupt-1',
        resolvedAction: 'approve',
        toolCallId: 'approval-1',
      }),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await manager.resumeWithInterruptResolution(
      'sess-1',
      'turn-1',
      'agent-1',
      'interrupt-1',
    );

    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      content: 'APPROVED',
      toolCallId: 'approval-1',
    }));
    expect(deliverTurnSpy).toHaveBeenCalledWith(
      'sess-1',
      expect.any(Array),
      'hitl-resume-d718a80a945f45badc81fb3dc779eb89',
      undefined,
    );
  });

  it('uses the same interrupt-derived continuation turn and message identities on every retry', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');
    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

    expect(deliverTurnSpy).toHaveBeenCalledTimes(2);
    expect(deliverTurnSpy.mock.calls.map((call) => call[2])).toEqual([
      'hitl-resume-d718a80a945f45badc81fb3dc779eb89',
      'hitl-resume-d718a80a945f45badc81fb3dc779eb89',
    ]);
    expect(deliverTurnSpy.mock.calls.map((call) => call[1].map((message) => message.id))).toEqual([
      [
        'hitl-assistant-c5e9836414e46aa056f5d09c',
        'hitl-tool-dec742707c485e12fd0900dd',
      ],
      [
        'hitl-assistant-c5e9836414e46aa056f5d09c',
        'hitl-tool-dec742707c485e12fd0900dd',
      ],
    ]);
  });

  it('returns without restoring or redelivering when the original turn is already terminal', async () => {
    (db.getTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'completed',
      completedAt: Date.now(),
    });
    const ensureSessionSpy = vi.spyOn(manager, 'ensureSession');
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn');

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

    expect(db.getSandboxSession).not.toHaveBeenCalled();
    expect(db.getResolvedInterruptsForSandboxSession).not.toHaveBeenCalled();
    expect(db.addCanonicalMessage).not.toHaveBeenCalled();
    expect(ensureSessionSpy).not.toHaveBeenCalled();
    expect(deliverTurnSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('turn turn-1 is already terminal'),
    );
  });

  it('does not finalize the original turn when the continuation delivery reports failure', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );
    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents({
        type: 'turn_failed',
        turnId: 'hitl-resume-d718a80a945f45badc81fb3dc779eb89',
        errorMessage: 'duplicate delivery is still active',
      }),
    );

    await expect(
      manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1'),
    ).rejects.toThrow('duplicate delivery is still active');

    expect(db.finalizeTurnIfOpen).not.toHaveBeenCalled();
  });

  it('scenario 3: falls back when checkpoint requests do not yield approval continuations', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
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

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      role: 'assistant',
      toolCalls: [expect.objectContaining({
        id: 'interrupt-tool-call',
        args: JSON.stringify({
          tool: 'delete_file',
          args: { path: '/tmp/demo.txt' },
        }),
      })],
    }));
    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
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
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
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

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      role: 'assistant',
      toolCalls: [expect.objectContaining({ id: 'stale-tool-call' })],
    }));
    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
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
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
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
      manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1'),
    ).rejects.toThrow(/Malformed HITL checkpoint pending request payload JSON/);

    expect(ensureSessionSpy).not.toHaveBeenCalled();
    expect(db.addCanonicalMessage).not.toHaveBeenCalled();
    expect(deliverTurnSpy).not.toHaveBeenCalled();
  });

  it('fails visibly instead of using a degraded stub when an agent definition cannot be resolved', async () => {
    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
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
      manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1'),
    ).rejects.toThrow(/missing agent definition/);

    expect(ensureSessionSpy).not.toHaveBeenCalled();
    expect(db.addCanonicalMessage).not.toHaveBeenCalled();
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
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt({ resolvedAction: 'approve' }),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    const ensureSessionSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    vi.spyOn(manager, 'deliverTurn').mockImplementation(() => streamSessionEvents());

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

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
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt({ resolvedAction: 'reject' }),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    const deliverTurnSpy = vi.spyOn(manager, 'deliverTurn').mockImplementation(() =>
      streamSessionEvents(),
    );

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
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

  it('resume parity: DB-resolved definition deep-equals the canonical shaper output (ctx-8l4)', async () => {
    const storedAgent = {
      id: 'agent-1',
      name: 'test-agent',
      harness: 'langgraph',
      harnessConfig: '{"model":"gpt-5.4-mini"}',
      systemPrompt: 'follow the system prompt',
      tools: ['search-docs'],
      description: 'desc',
      workspaceDir: '/data/agents/agent-1',
      status: 'created',
      manifest: {
        resourceLimits: { cpus: 2, memoryMb: 1024 },
        spec: {
          nativeTools: { allowlist: ['bash'] },
          workspace: { content: { files: [{ src: 'seed.md', dest: 'seed.md' }] } },
        },
      },
      version: 1,
      metadata: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    (db.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(storedAgent);
    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );

    const ensureSessionSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    vi.spyOn(manager, 'deliverTurn').mockImplementation(() => streamSessionEvents());

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

    // Continuation ≡ fresh start: the resume path must produce exactly what the
    // startup path would build for the same stored row.
    expect(ensureSessionSpy.mock.calls[0]?.[1]).toEqual(
      buildAgentDefinition(storedAgent as Parameters<typeof buildAgentDefinition>[0]),
    );
  });

  it('checkpoint fallback preserves resourceLimits, nativeTools, and workspaceContent', async () => {
    (db.getAgent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint({
      agentDefinition: {
        name: 'test-agent',
        harness: 'langgraph',
        harnessConfig: { model: 'gpt-5.4-mini' },
        tools: ['search-docs'],
        systemPrompt: 'follow the system prompt',
        resourceLimits: { cpus: 1.5, memoryMb: 512 },
        nativeTools: { blocklist: ['bash'] },
        workspaceContent: { files: [{ src: 'a.txt', dest: 'b.txt' }] },
      },
      runnerState: { pendingRequests: [createPendingApproval('approval-1')] },
    }));

    const ensureSessionSpy = vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    vi.spyOn(manager, 'deliverTurn').mockImplementation(() => streamSessionEvents());

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

    expect(ensureSessionSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      resourceLimits: { cpus: 1.5, memoryMb: 512 },
      nativeTools: { blocklist: ['bash'] },
      workspaceContent: { files: [{ src: 'a.txt', dest: 'b.txt' }] },
    }));
  });

  it('terminalizes the original turn after a successful durable continuation (ctx-8nnu)', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );
    const finalizeTurnIfOpen = vi.fn().mockResolvedValue(true);
    (db as unknown as Record<string, unknown>).finalizeTurnIfOpen = finalizeTurnIfOpen;

    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());
    vi.spyOn(manager, 'deliverTurn').mockImplementation(() => streamSessionEvents());

    await manager.resumeWithInterruptResolution('sess-1', 'turn-1', 'agent-1', 'interrupt-1');

    expect(finalizeTurnIfOpen).toHaveBeenCalledWith('turn-1', expect.objectContaining({
      completedAt: expect.any(Number),
      error: null,
    }));
  });

  it('propagates lease cancellation into continuation delivery without finalizing the original turn', async () => {
    const internals = manager as unknown as SandboxSessionManagerInternals;
    internals.stateStore.agentDefs.set('conv-1', createAgentDef());

    (db.getSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession());
    (db.getResolvedInterruptsForSandboxSession as ReturnType<typeof vi.fn>).mockResolvedValue([
      createResolvedInterrupt(),
    ]);
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
      createCheckpointWithPendingRequests([createPendingApproval('approval-1')]),
    );
    vi.spyOn(manager, 'ensureSession').mockResolvedValue(createSessionRecord());

    const deliveryStarted = createDeferred();
    let deliveredSignal: AbortSignal | undefined;
    vi.spyOn(manager, 'deliverTurn').mockImplementation(async function* (
      _sessionId: string,
      _messages: Message[],
      _turnId: string,
      signal?: AbortSignal,
    ) {
      deliveredSignal = signal;
      deliveryStarted.resolve();
      if (!signal) {
        return;
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield* streamSessionEvents();
    });

    const controller = new AbortController();
    const resume = manager.resumeWithInterruptResolution(
      'sess-1',
      'turn-1',
      'agent-1',
      'interrupt-1',
      controller.signal,
    );
    await deliveryStarted.promise;
    controller.abort(new Error('interrupt resume lease lost'));

    await expect(resume).rejects.toThrow('interrupt resume lease lost');
    expect(deliveredSignal).toBe(controller.signal);
    expect(db.finalizeTurnIfOpen).not.toHaveBeenCalled();
  });
});
