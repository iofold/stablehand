import { create } from '@bufbuild/protobuf';
import { ConnectError, Code } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageCommittedSchema,
  SessionEventSchema,
  ToolLocation,
  ToolMetadataSchema,
  TurnCompletedSchema,
  type SessionEvent as ProtoSessionEvent,
  type SessionCheckpoint,
} from '@stablehand/proto/sandbox/v1';

import { SandboxSessionManager, type SessionRecord } from '../sandbox-session-manager.js';
import type { SessionEvent } from '../session-turn-service.js';
import type { DatabaseRepository, SandboxSessionRow } from '../../database/repository.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { ContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { AgentDefinition, Message } from '@stablehand/sandbox-daemon';
import { SessionStateStore } from '../session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../session-manager/session-status-coordinator.js';
import {
  CALLBACK_AGENT_ENV,
  CALLBACK_SESSION_ENV,
  CALLBACK_TOKEN_ENV,
  mintGrpcCallbackToken,
} from '../grpc/callback-auth.js';

const connectMocks = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  createConnectTransportMock: vi.fn(),
}));

vi.mock('@connectrpc/connect', async () => {
  const actual = await vi.importActual<typeof import('@connectrpc/connect')>('@connectrpc/connect');
  return {
    ...actual,
    createClient: connectMocks.createClientMock,
  };
});

vi.mock('@connectrpc/connect-node', () => ({
  createConnectTransport: connectMocks.createConnectTransportMock,
}));

type MockGrpcClient = ReturnType<typeof createMockGrpcClient>;

function createMockContainerManager(): ContainerManager {
  return {
    createContainer: vi.fn().mockResolvedValue({
      containerId: 'c-1',
      containerName: 'stablehand-sandbox-sess-1',
    }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    extractWorkspaceDiff: vi.fn().mockResolvedValue(undefined),
    extractLogs: vi.fn().mockResolvedValue(undefined),
    getContainer: vi.fn().mockResolvedValue(undefined),
    getRuntimeInstanceToken: vi.fn().mockResolvedValue('runtime-instance-token-1'),
    listManagedContainers: vi.fn().mockResolvedValue([]),
    getContainerExitCode: vi.fn().mockResolvedValue(undefined),
    ensureNetwork: vi.fn().mockResolvedValue(undefined),
    cleanupOrphans: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContainerManager;
}

function createMockDb(): DatabaseRepository {
  let restoreFenceToken = 0;
  let restoreAttempts = 0;
  let restoreRow: SandboxSessionRow | null = null;
  return {
    getSandboxSessionByConversation: vi.fn().mockResolvedValue(null),
    getLiveSandboxSessionByConversation: vi.fn().mockResolvedValue(null),
    getSandboxSession: vi.fn().mockImplementation(async () =>
      restoreRow ?? createDbSession('TERMINATED')
    ),
    getCheckpointV2: vi.fn().mockResolvedValue(null),
    updateTurn: vi.fn().mockResolvedValue(undefined),
    updateSandboxSessionMetadata: vi.fn().mockImplementation(
      async (_sessionId, status, extra) => {
        restoreRow = createDbSession(status, {
          ...(restoreRow ?? {}),
          ...(extra ?? {}),
          status,
        });
      },
    ),
    completeSandboxSessionLifecycleOperation: vi.fn().mockImplementation(
      async (input) => {
        restoreRow = createDbSession(input.toStatus, {
          ...(restoreRow ?? {}),
          ...(input.extra ?? {}),
          status: input.toStatus,
        });
        return true;
      },
    ),
    claimSandboxSessionLifecycleOperation: vi.fn().mockImplementation(async (input) => ({
      sandboxSessionId: input.sandboxSessionId,
      operation: input.operation,
      operationId: 'lifecycle-operation-1',
      phase: 'reserved',
      ownerId: input.ownerId,
      fenceToken: 1,
      allowedTurnId: input.allowedTurnDelivery?.turnId ?? null,
      allowedDeliveryOwnerId: input.allowedTurnDelivery?.ownerId ?? null,
      allowedDeliveryFenceToken: input.allowedTurnDelivery?.fenceToken ?? null,
      leaseExpiresAt: Date.now() + input.leaseDurationMs,
      updatedAt: Date.now(),
    })),
    renewSandboxSessionLifecycleOperation: vi.fn().mockImplementation(async (
      sandboxSessionId,
      ownerId,
      fenceToken,
    ) => ({
      sandboxSessionId,
      operation: 'checkpoint',
      operationId: 'lifecycle-operation-1',
      phase: 'reserved',
      ownerId,
      fenceToken,
      allowedTurnId: null,
      allowedDeliveryOwnerId: null,
      allowedDeliveryFenceToken: null,
      leaseExpiresAt: Date.now() + 60_000,
      updatedAt: Date.now(),
    })),
    markSandboxSessionLifecycleOperationExecuting: vi.fn().mockResolvedValue(true),
    cancelSandboxSessionLifecycleOperation: vi.fn().mockResolvedValue(true),
    activateTurnIfOpen: vi.fn().mockResolvedValue(true),
    createSandboxSession: vi.fn().mockImplementation(async (session: {
      id?: string;
      conversationId: string;
      agentId: string;
      containerName?: string;
      containerId?: string;
      status?: SandboxSessionRow['status'];
      harnessName: string;
    }) => {
      restoreRow = createDbSession(session.status ?? 'ACTIVE', {
        id: session.id ?? 'generated-session',
        conversationId: session.conversationId,
        agentId: session.agentId,
        containerName: session.containerName ?? null,
        containerId: session.containerId ?? null,
        harnessName: session.harnessName,
      });
      return restoreRow;
    }),
    deleteSandboxSession: vi.fn().mockResolvedValue(undefined),
    createCheckpointV2: vi.fn().mockResolvedValue({ id: 'ckpt-1' }),
    getActiveSandboxSessions: vi.fn().mockResolvedValue([]),
    getRestoringSandboxSessions: vi.fn().mockResolvedValue([]),
    getExpiredSandboxSessionRestores: vi.fn().mockResolvedValue([]),
    claimSandboxSessionRestore: vi.fn().mockImplementation(async (input) => {
      restoreFenceToken += 1;
      restoreAttempts += 1;
      restoreRow = createDbSession('RESTORING', {
        id: input.sandboxSessionId,
        restoreOwnerId: input.ownerId,
        restoreFenceToken,
        restoreLeaseExpiresAt: Date.now() + input.leaseDurationMs,
        restoreAttempts,
      });
      return restoreRow;
    }),
    renewSandboxSessionRestoreLease: vi.fn().mockImplementation(async () =>
      restoreRow
    ),
    completeSandboxSessionRestore: vi.fn().mockImplementation(
      async (_sessionId, _fence, runtime) => {
        restoreAttempts = 0;
        restoreRow = createDbSession('ACTIVE', {
          containerName: runtime.containerName,
          containerId: runtime.containerId,
          restoreFenceToken,
          restoreAttempts,
        });
        return restoreRow;
      },
    ),
    failSandboxSessionRestore: vi.fn().mockImplementation(
      async (_sessionId, _fence, failure) => {
        restoreRow = createDbSession(failure.toStatus, {
          restoreFenceToken,
          restoreAttempts,
          lastRestoreError: failure.error,
        });
        return restoreRow;
      },
    ),
    reconcileExpiredSandboxSessionRestore: vi.fn().mockResolvedValue(undefined),
    getSandboxSessionsByAgent: vi.fn().mockResolvedValue([]),
  } as unknown as DatabaseRepository;
}

function createMockLifecyclePolicy(): ContainerLifecyclePolicy {
  return {
    cancelIdleTimeout: vi.fn().mockResolvedValue(undefined),
    scheduleIdleTimeout: vi.fn(),
    cleanupAll: vi.fn(),
    cleanup: vi.fn(),
    getState: vi.fn().mockReturnValue('none'),
    activeCount: 0,
  } as unknown as ContainerLifecyclePolicy;
}

function createMockGrpcClient() {
  return {
    deliverTurn: vi.fn().mockImplementation(() => streamProtoEvents(protoCommittedEvent())),
    openSession: vi.fn().mockResolvedValue({}),
    suspendSession: vi.fn().mockResolvedValue({
      sessionCheckpoint: {
        checkpointVersion: 2,
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        harnessName: 'langgraph',
        harnessState: {},
      } as unknown as SessionCheckpoint,
    }),
    killSession: vi.fn().mockRejectedValue(new ConnectError('probe', Code.NotFound)),
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createAgentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'agent-1',
    harness: 'langgraph',
    systemPrompt: 'test system prompt',
    tools: [],
    harnessConfig: {},
    ...overrides,
  } as unknown as AgentDefinition;
}

function createMessage(content: string): Message {
  return {
    id: `msg-${content}`,
    role: 'user',
    content,
    agentId: 'agent-1',
    createdAt: Date.now(),
  } as unknown as Message;
}

function createDbSession(
  status: SandboxSessionRow['status'],
  overrides: Partial<SandboxSessionRow> = {},
): SandboxSessionRow {
  return {
    id: overrides.id ?? 'sess-1',
    conversationId: overrides.conversationId ?? 'conv-1',
    agentId: overrides.agentId ?? 'agent-1',
    containerName: overrides.containerName ?? 'stablehand-sandbox-sess-1',
    containerId: overrides.containerId ?? 'c-1',
    status,
    harnessName: overrides.harnessName ?? 'langgraph',
    checkpointRef: overrides.checkpointRef ?? null,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    lastActivityAt: overrides.lastActivityAt ?? Date.now(),
    restoreAttempts: overrides.restoreAttempts ?? 0,
    lastRestoreError: overrides.lastRestoreError ?? null,
    restoreOwnerId:
      overrides.restoreOwnerId
      ?? (status === 'RESTORING' ? 'restore-owner' : null),
    restoreFenceToken:
      overrides.restoreFenceToken
      ?? (status === 'RESTORING' ? 1 : 0),
    restoreLeaseExpiresAt:
      overrides.restoreLeaseExpiresAt
      ?? (status === 'RESTORING' ? Date.now() + 60_000 : null),
  };
}

function createCheckpoint() {
  return {
    id: 'ckpt-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    checkpointVersion: 2,
    checkpointData: { conversationId: 'conv-1', harnessName: 'langgraph', sessionId: 'sess-1' },
    harnessState: {},
    workspaceRef: null,
    suspendReason: null,
    createdAt: Date.now(),
  };
}

function protoCommittedEvent(content = 'assistant reply', turnId = 'turn-1'): ProtoSessionEvent {
  return create(SessionEventSchema, {
    payload: {
      case: 'messageCommitted',
      value: create(MessageCommittedSchema, {
        role: 'assistant',
        content,
        toolCalls: [],
        turnId,
        messageSeq: 1n,
      }),
    },
  });
}

function protoTurnCompletedEvent(turnId = 'turn-1'): ProtoSessionEvent {
  return create(SessionEventSchema, {
    payload: {
      case: 'turnCompleted',
      value: create(TurnCompletedSchema, { turnId }),
    },
  });
}

async function* streamProtoEvents(...events: ProtoSessionEvent[]): AsyncGenerator<ProtoSessionEvent> {
  for (const event of events) {
    yield event;
  }
}

async function collectEvents(stream: AsyncGenerator<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

type SandboxSessionManagerInternals = {
  stateStore: {
    sessions: Map<string, SessionRecord>;
    agentDefs: Map<string, AgentDefinition>;
    turnQueues: Map<string, unknown[]>;
    activeTurns: Map<string, string>;
  };
  isStaleContainerError(err: unknown): boolean;
};

describe('SandboxSessionManager session recovery', () => {
  let containerManager: ContainerManager;
  let db: DatabaseRepository;
  let lifecyclePolicy: ContainerLifecyclePolicy;
  let grpcClient: MockGrpcClient;
  let manager: SandboxSessionManager;
  let resolveToolsForAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    containerManager = createMockContainerManager();
    db = createMockDb();
    lifecyclePolicy = createMockLifecyclePolicy();
    grpcClient = createMockGrpcClient();
    resolveToolsForAgent = vi.fn().mockReturnValue([
      create(ToolMetadataSchema, {
        name: 'search',
        description: 'Search docs',
        inputSchemaJson: '{"type":"object"}',
        location: ToolLocation.ORCHESTRATOR,
        programmatic: true,
      }),
    ]);
    connectMocks.createConnectTransportMock.mockReturnValue({});
    connectMocks.createClientMock.mockReturnValue(grpcClient);
    const logger = createLogger();
    const stateStore = new SessionStateStore();
    const statusCoordinator = new SessionStatusCoordinator({ db, logger, stateStore });
    manager = new SandboxSessionManager({
      containerManager,
      db,
      lifecyclePolicy,
      stateStore,
      statusCoordinator,
      workspaceDiffService: new WorkspaceDiffService({ containerManager }),
      buildSandboxSecrets: async () => ({}),
      resolveTurnSecrets: async () => ({}),
      resolveToolsForAgent,
      logger,
      config: { idleTimeoutMs: 60_000, maxQueuedMessages: 10 },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('ensureSession — dead container recovery', () => {
    it('ACTIVE + reconnect fails + checkpoint exists → restores from checkpoint', async () => {
      vi.useFakeTimers();
      const failingClient = createMockGrpcClient();
      failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND stablehand-sandbox-sess-1'));
      connectMocks.createClientMock
        .mockReturnValueOnce(failingClient)
        .mockReturnValue(grpcClient);
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

      const builtinToolPolicy = { policy: 'deny', names: ['request-approval'] } as const;
      const sessionPromise = manager.ensureSession('conv-1', createAgentDef({
        tools: ['search'],
        builtinToolPolicy,
        metadata: {
          httpTools: [
            { name: 'weather', description: 'Weather', endpoint: 'https://example.test/weather' },
          ],
        },
      }), 'agent-1');
      await vi.advanceTimersByTimeAsync(10_500);
      const session = await sessionPromise;

      expect(db.completeSandboxSessionLifecycleOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSessionId: 'sess-1',
          fromStatus: 'ACTIVE',
          toStatus: 'CHECKPOINTED',
          extra: expect.objectContaining({
            containerId: null,
            containerName: null,
          }),
        }),
      );
      expect(db.claimSandboxSessionRestore).toHaveBeenCalledWith({
        sandboxSessionId: 'sess-1',
        ownerId: expect.any(String),
        leaseDurationMs: expect.any(Number),
        maxAttempts: expect.any(Number),
      });
      expect(db.completeSandboxSessionRestore).toHaveBeenCalledWith(
        'sess-1',
        {
          ownerId: expect.any(String),
          fenceToken: 1,
        },
        expect.objectContaining({
          containerId: 'c-1',
          containerName: 'stablehand-sandbox-sess-1',
        }),
      );
      expect(session.sessionId).toBe('sess-1');
      expect(session.status).toBe('ACTIVE');
      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
      expect(resolveToolsForAgent).toHaveBeenCalledWith(
        ['search', 'weather'],
        builtinToolPolicy,
        'agent-1',
      );
      expect(grpcClient.openSession).toHaveBeenCalledWith(
        expect.objectContaining({
          bootstrap: {
            case: 'restore',
            value: expect.objectContaining({
              agentId: 'agent-1',
              harnessConfigJson: '{}',
              systemPrompt: 'test system prompt',
              tools: [expect.objectContaining({ name: 'search', programmatic: true })],
            }),
          },
        }),
        expect.objectContaining({ signal: expect.anything() }),
      );
    });

    it('CHECKPOINTED restore retries openSession on transient unavailable errors', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('CHECKPOINTED'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

      const retryingClient = createMockGrpcClient();
      retryingClient.openSession
        .mockRejectedValueOnce(new ConnectError('unavailable', Code.Unavailable))
        .mockResolvedValueOnce({});
      connectMocks.createClientMock.mockReturnValue(retryingClient);

      const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await vi.runAllTimersAsync();
      const session = await sessionPromise;

      expect(retryingClient.openSession).toHaveBeenCalledTimes(2);
      expect(session.sessionId).toBe('sess-1');
      expect(session.status).toBe('ACTIVE');
    });

    it('CHECKPOINTED restore uses stored agent id instead of display name for runtime identity', async () => {
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('CHECKPOINTED'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

      const session = await manager.ensureSession(
        'conv-1',
        createAgentDef({ name: 'Claude Suspend Restore Probe dev2' }),
        'agent-1',
      );

      expect(session.sessionId).toBe('sess-1');
      expect(containerManager.createContainer).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-1',
      }));
      expect(grpcClient.openSession).toHaveBeenCalledWith(
        expect.objectContaining({
          bootstrap: {
            case: 'restore',
            value: expect.objectContaining({
              agentId: 'agent-1',
            }),
          },
        }),
        expect.objectContaining({ signal: expect.anything() }),
      );
    });

    it('injects session-scoped callback auth secrets into restored session containers', async () => {
      vi.stubEnv('STABLEHAND_API_TOKEN', 'api-token');
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('CHECKPOINTED'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

      await manager.ensureSession('conv-1', createAgentDef({ name: 'Display Name' }), 'agent-1');

      const createContainer = vi.mocked(containerManager.createContainer);
      const createOpts = createContainer.mock.calls[0]?.[0];
      if (!createOpts) {
        throw new Error('expected createContainer to be called');
      }

      expect(createOpts).toMatchObject({
        sessionId: 'sess-1',
        agentId: 'agent-1',
      });
      expect(createOpts.secrets).toMatchObject({
        [CALLBACK_SESSION_ENV]: 'sess-1',
        [CALLBACK_AGENT_ENV]: 'agent-1',
        [CALLBACK_TOKEN_ENV]: mintGrpcCallbackToken('sess-1', 'agent-1', 'api-token'),
      });
    });

    it('binds the restore gRPC client to the exact replacement container instance token', async () => {
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>)
        .mockResolvedValue(createDbSession('CHECKPOINTED'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>)
        .mockResolvedValue(createCheckpoint());

      await manager.ensureSession(
        'conv-1',
        createAgentDef({ name: 'Display Name' }),
        'agent-1',
      );

      const createOpts = vi.mocked(containerManager.createContainer).mock.calls[0]?.[0];
      if (!createOpts) {
        throw new Error('expected createContainer to be called');
      }
      const runtimeInstanceToken =
        createOpts.secrets?.STABLEHAND_RUNTIME_INSTANCE_TOKEN;
      expect(runtimeInstanceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const transportOptions =
        connectMocks.createConnectTransportMock.mock.calls[0]?.[0];
      const interceptor = transportOptions?.interceptors?.[0];
      if (!interceptor) {
        throw new Error('expected runtime-instance authentication interceptor');
      }
      const request = { header: new Headers() };
      await interceptor(vi.fn(async () => ({})))(request);

      expect(
        request.header.get('x-stablehand-runtime-instance-token'),
      ).toBe(runtimeInstanceToken);
    });

    it('ACTIVE + reconnect fails + no checkpoint → creates fresh session', async () => {
      vi.useFakeTimers();
      const failingClient = createMockGrpcClient();
      failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND stablehand-sandbox-sess-1'));
      connectMocks.createClientMock
        .mockReturnValueOnce(failingClient)
        .mockReturnValue(grpcClient);
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await vi.advanceTimersByTimeAsync(10_500);
      const session = await sessionPromise;

      expect(db.updateSandboxSessionMetadata).not.toHaveBeenCalledWith('sess-1', 'CHECKPOINTED');
      expect(db.completeSandboxSessionLifecycleOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSessionId: 'sess-1',
          fromStatus: 'ACTIVE',
          toStatus: 'TERMINATED',
          extra: expect.objectContaining({
            containerId: null,
            containerName: null,
          }),
        }),
      );
      expect(db.createSandboxSession).toHaveBeenCalledTimes(1);
      expect(session.sessionId).not.toBe('sess-1');
      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
    });

    it('ACTIVE + working container → reconnects normally (no regression)', async () => {
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));

      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      expect(connectMocks.createClientMock).toHaveBeenCalledTimes(1);
      expect(db.createSandboxSession).not.toHaveBeenCalled();
      expect(db.getCheckpointV2).not.toHaveBeenCalled();
      expect(session.sessionId).toBe('sess-1');
      expect(session.status).toBe('ACTIVE');
    });

    it('revalidates a cached ACTIVE session for an authoritative HITL recovery', async () => {
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>)
        .mockResolvedValue(createDbSession('ACTIVE'));
      await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      vi.mocked(db.getSandboxSessionByConversation).mockClear();
      connectMocks.createClientMock.mockClear();

      const session = await manager.ensureSession(
        'conv-1',
        createAgentDef(),
        'agent-1',
        {
          recoveryAuthority: {
            attemptId: 'attempt-1',
            turnId: 'turn-1',
            fence: {
              ownerId: 'resume-worker',
              fenceToken: 7,
            },
          },
        },
      );

      expect(db.getSandboxSessionByConversation).toHaveBeenCalledWith('conv-1');
      expect(connectMocks.createClientMock).toHaveBeenCalledOnce();
      expect(session.sessionId).toBe('sess-1');
    });
  });

  describe('executeDeliverTurn — stale container recovery', () => {
    it('ConnectError(Unavailable) during stream fails closed without transparent redelivery', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn
        .mockImplementationOnce(() => {
          throw new ConnectError('unavailable', Code.Unavailable);
        })
        .mockImplementationOnce(() =>
          streamProtoEvents(protoCommittedEvent('recovered'), protoTurnCompletedEvent('turn-1')),
        );

      const events = await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(1);
      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'turn_failed',
          errorMessage: '[unavailable] unavailable',
        }),
      ]);
    });

    it('does not terminate a stale session through an unfenced status write', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn
        .mockImplementationOnce(() => {
          throw new ConnectError('unavailable', Code.Unavailable);
        })
        .mockImplementationOnce(() =>
          streamProtoEvents(protoCommittedEvent('recovered'), protoTurnCompletedEvent('turn-1')),
        );

      await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      expect(db.updateSandboxSessionMetadata).not.toHaveBeenCalledWith(
        session.sessionId,
        'TERMINATED',
        expect.anything(),
        expect.anything(),
      );
    });

    it('zero-event sandbox completion emits turn_failed instead of false success', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn.mockImplementationOnce(() => streamProtoEvents(protoTurnCompletedEvent('turn-empty')));

      const events = await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-empty'));

      expect(events).toEqual([
        expect.objectContaining({
          type: 'turn_failed',
          errorMessage: expect.stringContaining('completed without emitting any events'),
        }),
      ]);
      expect(lifecyclePolicy.scheduleIdleTimeout).toHaveBeenCalledWith(
        session.sessionId,
        expect.any(String),
        expect.any(Object),
        undefined,
      );
    });

    it('ENOTFOUND during stream fails closed without transparent redelivery', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn
        .mockImplementationOnce(() => {
          throw new Error('getaddrinfo ENOTFOUND stablehand-sandbox-sess-1');
        })
        .mockImplementationOnce(() =>
          streamProtoEvents(protoCommittedEvent('retried after dns failure'), protoTurnCompletedEvent('turn-1')),
        );

      const events = await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(1);
      expect(events[0]).toEqual(expect.objectContaining({
        type: 'turn_failed',
        errorMessage: expect.stringContaining('ENOTFOUND'),
      }));
    });

    it('ConnectError(InvalidArgument) → emits turn_failed without retry', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn.mockImplementationOnce(() => {
        throw new ConnectError('invalid', Code.InvalidArgument);
      });

      await expect(collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1')))
        .resolves.toEqual([
          expect.objectContaining({ type: 'turn_failed', errorMessage: '[invalid_argument] invalid' }),
        ]);
      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(1);
      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
    });

    it('does not invoke a second delivery after a stale first failure', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn
        .mockImplementationOnce(() => {
          throw new ConnectError('unavailable-1', Code.Unavailable);
        })
        .mockImplementationOnce(() => {
          throw new ConnectError('unavailable-2', Code.Unavailable);
        });

      await expect(collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1')))
        .resolves.toEqual([
          expect.objectContaining({ type: 'turn_failed', errorMessage: '[unavailable] unavailable-1' }),
        ]);
      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(1);
    });

    it('no cached agentDef → emits turn_failed without retry', async () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      privateManager.stateStore.sessions.set('conv-1', {
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        agentId: 'agent-1',
        containerName: 'stablehand-sandbox-sess-1',
        containerId: 'c-1',
        status: 'ACTIVE',
        harnessName: 'langgraph',
        grpcClient,
      });
      grpcClient.deliverTurn.mockImplementationOnce(() => {
        throw new ConnectError('unavailable', Code.Unavailable);
      });

      await expect(collectEvents(manager.deliverTurn('sess-1', [createMessage('hello')], 'turn-1')))
        .resolves.toEqual([
          expect.objectContaining({ type: 'turn_failed', errorMessage: '[unavailable] unavailable' }),
        ]);
      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(1);
      expect(containerManager.createContainer).not.toHaveBeenCalled();
    });
  });

  describe('idle timeout scheduling', () => {
    it('scheduleIdleTimeout called after turn completion', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      expect(lifecyclePolicy.scheduleIdleTimeout).toHaveBeenCalledTimes(1);
    });

    it('cancelIdleTimeout called at turn start', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      expect(lifecyclePolicy.cancelIdleTimeout).toHaveBeenCalledWith(session.sessionId);
    });



    it('onCheckpoint callback calls suspendSession with idle-checkpoint reason', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      const callbacks = (lifecyclePolicy.scheduleIdleTimeout as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as {
        onCheckpoint: (sessionId: string) => Promise<void>;
      };
      await callbacks.onCheckpoint(session.sessionId);

      expect(grpcClient.suspendSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        reason: 'idle-checkpoint',
      }));
      expect(db.createCheckpointV2).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSessionId: session.sessionId,
          suspendReason: 'idle-checkpoint',
        }),
        expect.objectContaining({
          ownerId: expect.any(String),
          fenceToken: expect.any(Number),
        }),
      );
      expect(db.completeSandboxSessionLifecycleOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSessionId: session.sessionId,
          fromStatus: 'ACTIVE',
          toStatus: 'CHECKPOINTED',
          extra: expect.objectContaining({
            containerId: null,
            containerName: null,
          }),
        }),
      );
    });

    it('suspendSession checkpoints, cleans runtime state, and removes the old container', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      const privateManager = manager as unknown as SandboxSessionManagerInternals;

      privateManager.stateStore.turnQueues.set(session.sessionId, []);
      privateManager.stateStore.activeTurns.set(session.sessionId, 'turn-active');

      await manager.suspendSession(session.sessionId, 'manual-checkpoint', { allowActiveTurn: true });

      expect(grpcClient.suspendSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        reason: 'manual-checkpoint',
      }));
      expect(db.completeSandboxSessionLifecycleOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSessionId: session.sessionId,
          fromStatus: 'ACTIVE',
          toStatus: 'CHECKPOINTED',
          extra: expect.objectContaining({
            containerId: null,
            containerName: null,
          }),
        }),
      );
      expect(db.updateSandboxSessionMetadata).not.toHaveBeenCalledWith(session.sessionId, 'TERMINATED');
      expect(lifecyclePolicy.cancelIdleTimeout).toHaveBeenCalledWith(session.sessionId);
      expect(containerManager.stopContainer).toHaveBeenCalledWith('c-1', 10);
      expect(containerManager.removeContainer).toHaveBeenCalledWith('c-1', true);
      expect(privateManager.stateStore.sessions.has('conv-1')).toBe(false);
      expect(privateManager.stateStore.agentDefs.has('conv-1')).toBe(false);
      expect(privateManager.stateStore.turnQueues.has(session.sessionId)).toBe(false);
      expect(privateManager.stateStore.activeTurns.has(session.sessionId)).toBe(false);
    });

    it('fails closed when workspace capture fails during suspend', async () => {
      const captureSpy = vi
        .spyOn(WorkspaceDiffService.prototype, 'capture')
        .mockRejectedValueOnce(new Error('workspace capture failed'));
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      await expect(manager.suspendSession(session.sessionId, 'manual-checkpoint')).rejects.toThrow(
        'workspace capture failed',
      );

      expect(grpcClient.suspendSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        reason: 'manual-checkpoint',
      }));
      expect(db.createCheckpointV2).not.toHaveBeenCalled();
      expect(db.completeSandboxSessionLifecycleOperation).not.toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSessionId: session.sessionId,
          toStatus: 'CHECKPOINTED',
        }),
      );
      expect(containerManager.stopContainer).not.toHaveBeenCalled();
      expect(containerManager.removeContainer).not.toHaveBeenCalled();

      captureSpy.mockRestore();
    });
  });

  describe('isStaleContainerError', () => {
    it('ConnectError with Code.Unavailable → true', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError(new ConnectError('unavailable', Code.Unavailable))).toBe(true);
    });

    it('ConnectError with generic Code.Internal → false', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError(new ConnectError('internal error', Code.Internal))).toBe(false);
    });

    it('ConnectError with Code.Internal and a transport message → true', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError(new ConnectError('read ECONNRESET', Code.Internal))).toBe(true);
    });

    it('ConnectError with Code.InvalidArgument → false', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError(new ConnectError('invalid', Code.InvalidArgument))).toBe(false);
    });

    it('Error with ENOTFOUND in message → true', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError(new Error('getaddrinfo ENOTFOUND sandbox'))).toBe(true);
    });

    it('Error with ECONNREFUSED in message → true', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError(new Error('connect ECONNREFUSED 127.0.0.1'))).toBe(true);
    });

    it('Error with ECONNRESET in message → true', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError(new Error('socket hang up ECONNRESET'))).toBe(true);
    });

    it('generic Error without network message → false', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError(new Error('boom'))).toBe(false);
    });

    it('non-Error value → false', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError('ECONNRESET')).toBe(false);
    });
  });
});
