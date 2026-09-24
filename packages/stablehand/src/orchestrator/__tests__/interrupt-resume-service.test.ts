import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import type {
  CheckpointV2,
  DatabaseRepository,
  InterruptRow,
  SandboxSessionRow,
} from '../../database/repository.js';
import type { TypedEventBus } from '../../events/bus.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import {
  SandboxSessionManager,
  type SessionRecord,
} from '../sandbox-session-manager.js';
import { SessionStateStore } from '../session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../session-manager/session-status-coordinator.js';
import type { TurnDeliveryFence } from '../turn-delivery-fence.js';
import type { ContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';

const FENCE: TurnDeliveryFence = {
  ownerId: 'resume-worker',
  fenceToken: 6,
};

function createAgentDef(
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    name: 'test-agent',
    harness: 'langgraph',
    harnessConfig: {},
    tools: ['search-docs'],
    systemPrompt: 'follow the system prompt',
    ...overrides,
  };
}

function createDbSession(
  overrides: Partial<SandboxSessionRow> = {},
): SandboxSessionRow {
  return {
    id: 'sandbox-old',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    containerName: 'sandbox-old',
    containerId: 'container-old',
    status: 'CHECKPOINTED',
    harnessName: 'langgraph',
    checkpointRef: 'checkpoint-1',
    createdAt: 1_000,
    updatedAt: 1_000,
    lastActivityAt: 1_000,
    ...overrides,
  };
}

function createResolvedInterrupt(
  overrides: Partial<InterruptRow> = {},
): InterruptRow {
  return {
    id: 'interrupt-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    sandboxSessionId: 'sandbox-old',
    toolCallId: 'approval-1',
    toolName: 'request-approval',
    args: {
      tool: 'send_email',
      args: { to: 'person@example.com', body: 'hello' },
    },
    timeoutMs: 300_000,
    createdAt: 1_000,
    expiresAt: 301_000,
    resolvedAt: 2_000,
    resolvedAction: 'approve',
    resolvedData: { reason: 'ok' },
    status: 'resolved',
    ...overrides,
  };
}

function createCheckpoint(
  pendingRequests: Array<Record<string, unknown>> = [],
  overrides: Record<string, unknown> = {},
): CheckpointV2 {
  return {
    id: 'checkpoint-1',
    sandboxSessionId: 'sandbox-old',
    agentId: 'agent-1',
    checkpointVersion: 2,
    checkpointData: {
      runnerState: { pendingRequests },
      ...overrides,
    },
    harnessState: {},
    workspaceRef: null,
    suspendReason: 'hitl-wait',
    createdAt: 1_000,
  };
}

function createApproval(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'approval',
    id: 'approval-1',
    payload: {
      tool: 'send_email',
      args: { to: 'person@example.com', body: 'hello' },
    },
    ...overrides,
  };
}

function createSessionRecord(): SessionRecord {
  return {
    sessionId: 'sandbox-restored',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    containerName: 'sandbox-restored',
    containerId: 'container-restored',
    status: 'ACTIVE',
    harnessName: 'langgraph',
  };
}

function createHarness(options: {
  terminal?: boolean;
  interrupt?: InterruptRow;
  session?: SandboxSessionRow;
  checkpoint?: CheckpointV2 | null;
  loseFenceOnMessage?: boolean;
  cachedAgentDef?: AgentDefinition;
  agentRow?: Record<string, unknown> | null;
} = {}) {
  let messageSeq = 0;
  const messages = new Map<string, Record<string, unknown>>();
  const db = {
    getAgent: vi.fn().mockResolvedValue(options.agentRow ?? null),
    getTurn: vi.fn().mockResolvedValue({
      id: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      status: options.terminal ? 'completed' : 'running',
      completedAt: options.terminal ? 3_000 : null,
      mode: 'interactive',
      taskDescription: 'original task',
    }),
    getSandboxSession: vi.fn().mockResolvedValue(
      options.session ?? createDbSession(),
    ),
    getInterruptById: vi.fn().mockResolvedValue(
      options.interrupt ?? createResolvedInterrupt(),
    ),
    getCheckpointV2: vi.fn().mockResolvedValue(
      options.checkpoint === undefined
        ? createCheckpoint([createApproval()])
        : options.checkpoint,
    ),
    isTurnDeliveryFenceCurrent: vi.fn().mockResolvedValue(true),
    addCanonicalMessage: vi.fn().mockImplementation(async (
      input: Record<string, unknown>,
    ) => {
      if (options.loseFenceOnMessage) {
        return undefined;
      }
      const id = String(input.id);
      const existing = messages.get(id);
      if (existing) {
        return existing;
      }
      const row = {
        ...input,
        id,
        messageSeq: messageSeq++,
        messageRevision: 0,
        publishedRevision: -1,
        createdAt: 2_000,
      };
      messages.set(id, row);
      return row;
    }),
  };
  const eventBus = {
    emit: vi.fn(),
    emitAsync: vi.fn().mockResolvedValue(undefined),
  };
  const executeInterruptContinuation = vi.fn().mockResolvedValue(undefined);
  const containerManager = {
    extractWorkspaceDiff: vi.fn().mockResolvedValue(null),
  } as unknown as ContainerManager;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const stateStore = new SessionStateStore();
  if (options.cachedAgentDef) {
    stateStore.setAgentDef('conversation-1', options.cachedAgentDef);
  }
  const manager = new SandboxSessionManager({
    containerManager,
    db: db as unknown as DatabaseRepository,
    lifecyclePolicy: {
      cancelIdleTimeout: vi.fn().mockResolvedValue(undefined),
      scheduleIdleTimeout: vi.fn(),
    } as unknown as ContainerLifecyclePolicy,
    stateStore,
    statusCoordinator: new SessionStatusCoordinator({
      db: db as unknown as DatabaseRepository,
      logger,
      stateStore,
    }),
    eventBus: eventBus as unknown as TypedEventBus,
    workspaceDiffService: new WorkspaceDiffService({ containerManager }),
    buildSandboxSecrets: async () => ({}),
    resolveTurnSecrets: async () => ({}),
    executeInterruptContinuation,
    logger,
    config: {
      idleTimeoutMs: 60_000,
      maxQueuedMessages: 10,
    },
  });
  const ensureSession = vi.spyOn(manager, 'ensureSession')
    .mockResolvedValue(createSessionRecord());

  const prepareAndExecute = async (
    attemptId = 'attempt-1',
    signal?: AbortSignal,
  ) => {
    const prepared = await manager.prepareInterruptContinuation(
      'sandbox-old',
      'turn-1',
      'agent-1',
      'interrupt-1',
    );
    if (prepared.kind === 'ready') {
      await manager.executeInterruptContinuation(
        prepared,
        attemptId,
        FENCE,
        signal,
      );
    }
    return prepared;
  };

  return {
    db,
    eventBus,
    executeInterruptContinuation,
    ensureSession,
    manager,
    prepareAndExecute,
  };
}

describe('SandboxSessionManager interrupt continuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores first, then delivers checkpoint-backed approval on the original turn and fence', async () => {
    const agentDef = createAgentDef();
    const {
      db,
      ensureSession,
      executeInterruptContinuation,
      prepareAndExecute,
    } = createHarness({ cachedAgentDef: agentDef });

    const prepared = await prepareAndExecute();

    expect(prepared).toMatchObject({
      kind: 'ready',
      sandboxSessionId: 'sandbox-restored',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
    });
    expect(ensureSession).toHaveBeenCalledWith(
      'conversation-1',
      agentDef,
      'agent-1',
      undefined,
    );
    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        turnId: 'turn-1',
        role: 'assistant',
      }),
      FENCE,
    );
    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        turnId: 'turn-1',
        role: 'tool',
        content: 'APPROVED',
      }),
      FENCE,
    );
    expect(executeInterruptContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-1',
        sandboxSessionId: 'sandbox-restored',
        continuationAttemptId: 'attempt-1',
        deliveryContext: { fence: FENCE },
      }),
    );
  });

  it('returns terminal without restoring or executing', async () => {
    const {
      ensureSession,
      executeInterruptContinuation,
      prepareAndExecute,
    } = createHarness({ terminal: true, cachedAgentDef: createAgentDef() });

    await expect(prepareAndExecute()).resolves.toEqual({
      kind: 'terminal',
      turnId: 'turn-1',
    });
    expect(ensureSession).not.toHaveBeenCalled();
    expect(executeInterruptContinuation).not.toHaveBeenCalled();
  });

  it('forwards exact resume recovery authority through the manager adapter', async () => {
    const agentDef = createAgentDef();
    const { ensureSession, manager } = createHarness({
      cachedAgentDef: agentDef,
    });

    await manager.prepareInterruptContinuation(
      'sandbox-old',
      'turn-1',
      'agent-1',
      'interrupt-1',
      {
        attemptId: 'attempt-1',
        fence: FENCE,
      },
    );

    expect(ensureSession).toHaveBeenCalledWith(
      'conversation-1',
      agentDef,
      'agent-1',
      {
        recoveryAuthority: {
          attemptId: 'attempt-1',
          turnId: 'turn-1',
          fence: FENCE,
        },
      },
    );
  });

  it('requires the exact resolved interrupt ownership tuple', async () => {
    const { manager } = createHarness({
      cachedAgentDef: createAgentDef(),
      interrupt: createResolvedInterrupt({ turnId: 'other-turn' }),
    });

    await expect(manager.prepareInterruptContinuation(
      'sandbox-old',
      'turn-1',
      'agent-1',
      'interrupt-1',
    )).rejects.toThrow(/does not match continuation ownership/);
  });

  it('uses immutable interrupt provenance after the execution session is replaced', async () => {
    const { db, manager } = createHarness({
      cachedAgentDef: createAgentDef(),
      session: createDbSession({
        id: 'sandbox-restored',
        status: 'ACTIVE',
        containerId: 'container-restored',
        containerName: 'sandbox-restored',
      }),
      interrupt: createResolvedInterrupt({
        sandboxSessionId: 'sandbox-old',
      }),
    });

    await expect(manager.prepareInterruptContinuation(
      'sandbox-restored',
      'turn-1',
      'agent-1',
      'interrupt-1',
    )).resolves.toMatchObject({
      kind: 'ready',
      sandboxSessionId: 'sandbox-restored',
      interruptId: 'interrupt-1',
    });
    expect(db.getInterruptById).toHaveBeenCalledWith('interrupt-1');
  });

  it('uses deterministic canonical approval rows across retries', async () => {
    const { db, prepareAndExecute } = createHarness({
      cachedAgentDef: createAgentDef(),
    });

    await prepareAndExecute('attempt-1');
    await prepareAndExecute('attempt-1');

    const messageIds = db.addCanonicalMessage.mock.calls.map(
      ([input]) => input.id,
    );
    expect(messageIds.slice(0, 2)).toEqual(messageIds.slice(2));
  });

  it('falls back to the resolved interrupt when checkpoint requests are absent', async () => {
    const { executeInterruptContinuation, prepareAndExecute } = createHarness({
      cachedAgentDef: createAgentDef(),
      checkpoint: createCheckpoint([]),
    });

    await prepareAndExecute();

    expect(executeInterruptContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'assistant',
            toolCalls: [
              expect.objectContaining({
                id: 'approval-1',
                arguments: {
                  tool: 'send_email',
                  args: { to: 'person@example.com', body: 'hello' },
                },
              }),
            ],
          }),
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'approval-1',
            content: 'APPROVED',
          }),
        ],
      }),
    );
  });

  it('persists REJECTED for a rejected resolution', async () => {
    const { db, prepareAndExecute } = createHarness({
      cachedAgentDef: createAgentDef(),
      interrupt: createResolvedInterrupt({ resolvedAction: 'reject' }),
    });

    await prepareAndExecute();

    expect(db.addCanonicalMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ role: 'tool', content: 'REJECTED' }),
      FENCE,
    );
  });

  it('rejects malformed checkpoint approval payloads before restoring', async () => {
    const { ensureSession, manager } = createHarness({
      cachedAgentDef: createAgentDef(),
      checkpoint: createCheckpoint([
        createApproval({ payload: '{not-json' }),
      ]),
    });

    await expect(manager.prepareInterruptContinuation(
      'sandbox-old',
      'turn-1',
      'agent-1',
      'interrupt-1',
    )).rejects.toThrow(/Malformed HITL checkpoint pending request payload JSON/);
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it('resolves the canonical agent definition from the database on cache miss', async () => {
    const agentRow = {
      id: 'agent-1',
      name: 'database-agent',
      harness: 'langgraph',
      harnessConfig: '{}',
      tools: ['search-docs'],
      systemPrompt: 'database prompt',
      description: null,
      metadata: {},
      manifest: null,
      workspaceDir: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const { ensureSession, prepareAndExecute } = createHarness({ agentRow });

    await prepareAndExecute();

    expect(ensureSession).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        name: 'database-agent',
        systemPrompt: 'database prompt',
      }),
      'agent-1',
      undefined,
    );
  });

  it('preserves runtime-enforced fields from a checkpoint definition fallback', async () => {
    const checkpointAgentDef = createAgentDef({
      resourceLimits: { memoryMb: 512 },
      nativeToolPolicy: { policy: 'deny', names: ['bash'] },
      workspaceContent: { files: { 'README.md': 'seed' } },
    });
    const { ensureSession, prepareAndExecute } = createHarness({
      checkpoint: createCheckpoint([], {
        agentDefinition: checkpointAgentDef,
      }),
    });

    await prepareAndExecute();

    expect(ensureSession).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        resourceLimits: { memoryMb: 512 },
        nativeToolPolicy: { policy: 'deny', names: ['bash'] },
        workspaceContent: { files: { 'README.md': 'seed' } },
      }),
      'agent-1',
      undefined,
    );
  });

  it('rejects a stale owner before publication or execution', async () => {
    const {
      eventBus,
      executeInterruptContinuation,
      prepareAndExecute,
    } = createHarness({
      cachedAgentDef: createAgentDef(),
      loseFenceOnMessage: true,
    });

    await expect(prepareAndExecute()).rejects.toThrow(/lost delivery ownership/);
    expect(eventBus.emitAsync).not.toHaveBeenCalled();
    expect(executeInterruptContinuation).not.toHaveBeenCalled();
  });
});
