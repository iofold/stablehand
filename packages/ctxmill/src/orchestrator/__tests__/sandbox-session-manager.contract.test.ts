import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageCommittedSchema,
  SessionEventSchema,
  TurnCompletedSchema,
  type SessionCheckpoint,
  type SessionEvent as ProtoSessionEvent,
} from '@ctxmill/proto/sandbox/v1';

import { SandboxSessionManager, type SessionRecord } from '../sandbox-session-manager.js';
import type { SessionEvent } from '../session-turn-service.js';
import type { DatabaseRepository, SandboxSessionRow } from '../../database/repository.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { ContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { AgentDefinition, Message } from '../../types.js';
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

type TestChannel = {
  push: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
};

type SandboxSessionManagerInternals = {
  stateStore: {
    sessions: Map<string, SessionRecord>;
    turnQueues: Map<string, Array<{ messages: Message[]; turnId: string; channel: TestChannel }>>;
    activeTurns: Map<string, string>;
    agentDefs: Map<string, AgentDefinition>;
  };
  drainCoalescedQueue(sessionId: string): Promise<void>;
  executeDeliverTurn(
    sessionId: string,
    messages: Message[],
    turnId: string,
  ): AsyncGenerator<SessionEvent>;
};

function createMockContainerManager(): ContainerManager {
  return {
    createContainer: vi.fn().mockResolvedValue({
      containerId: 'c-1',
      containerName: 'ctxmill-run-sess-1',
    }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    extractWorkspaceDiff: vi.fn().mockResolvedValue(undefined),
    extractLogs: vi.fn().mockResolvedValue(undefined),
    getContainer: vi.fn().mockResolvedValue(undefined),
    listManagedContainers: vi.fn().mockResolvedValue([]),
    getContainerExitCode: vi.fn().mockResolvedValue(undefined),
    ensureNetwork: vi.fn().mockResolvedValue(undefined),
    cleanupOrphans: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContainerManager;
}

function createMockDb(): DatabaseRepository {
  return {
    getSandboxSessionByConversation: vi.fn().mockResolvedValue(null),
    getCheckpointV2: vi.fn().mockResolvedValue(null),
    updateSandboxSessionStatus: vi.fn().mockResolvedValue(undefined),
    updateTurn: vi.fn().mockResolvedValue(undefined),
    createSandboxSession: vi.fn().mockImplementation(async (session: {
      id?: string;
      conversationId: string;
      agentId: string;
      containerName?: string;
      containerId?: string;
      status?: string;
      harnessName: string;
    }) => ({
      id: session.id ?? 'generated-session',
      conversationId: session.conversationId,
      agentId: session.agentId,
      containerName: session.containerName ?? null,
      containerId: session.containerId ?? null,
      status: session.status ?? 'ACTIVE',
      harnessName: session.harnessName,
      checkpointRef: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
    })),
    deleteSandboxSession: vi.fn().mockResolvedValue(undefined),
    createCheckpointV2: vi.fn().mockResolvedValue({ id: 'ckpt-1' }),
    getActiveSandboxSessions: vi.fn().mockResolvedValue([]),
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
    deliverTurn: vi.fn().mockImplementation(() =>
      streamProtoEvents(protoCommittedEvent(), protoTurnCompletedEvent()),
    ),
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

function createAgentDef(): AgentDefinition {
  return {
    name: 'agent-1',
    harness: 'langgraph',
    systemPrompt: 'test system prompt',
    tools: [],
    harnessConfig: {},
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
  overrides?: Partial<SandboxSessionRow>,
): SandboxSessionRow {
  return {
    id: overrides?.id ?? 'sess-1',
    conversationId: overrides?.conversationId ?? 'conv-1',
    agentId: overrides?.agentId ?? 'agent-1',
    containerName: overrides?.containerName ?? 'ctxmill-run-sess-1',
    containerId: overrides?.containerId ?? 'c-1',
    status,
    harnessName: overrides?.harnessName ?? 'langgraph',
    checkpointRef: overrides?.checkpointRef ?? null,
    createdAt: overrides?.createdAt ?? Date.now(),
    updatedAt: overrides?.updatedAt ?? Date.now(),
    lastActivityAt: overrides?.lastActivityAt ?? Date.now(),
  };
}

function createCheckpoint(overrides?: { sessionId?: string; conversationId?: string; agentId?: string }) {
  return {
    id: 'ckpt-1',
    sessionId: overrides?.sessionId ?? 'sess-1',
    agentId: overrides?.agentId ?? 'agent-1',
    checkpointVersion: 2,
    checkpointData: {
      conversationId: overrides?.conversationId ?? 'conv-1',
      harnessName: 'langgraph',
      sessionId: overrides?.sessionId ?? 'sess-1',
    },
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createChannel(): TestChannel {
  return {
    push: vi.fn(),
    close: vi.fn(),
    fail: vi.fn(),
  };
}

function createManager(options?: { turnTimeoutMs?: number }) {
  const containerManager = createMockContainerManager();
  const db = createMockDb();
  const lifecyclePolicy = createMockLifecyclePolicy();
  const grpcClient = createMockGrpcClient();
  const resolveToolsForAgent = vi.fn().mockReturnValue([]);
  const logger = createLogger();
  const buildSandboxSecrets = vi.fn().mockResolvedValue({});
  const stateStore = new SessionStateStore();
  const statusCoordinator = new SessionStatusCoordinator({ db, logger, stateStore });

  connectMocks.createConnectTransportMock.mockReturnValue({});
  connectMocks.createClientMock.mockReturnValue(grpcClient);

  const manager = new SandboxSessionManager({
    containerManager,
    db,
    lifecyclePolicy,
    stateStore,
    statusCoordinator,
    workspaceDiffService: new WorkspaceDiffService({ containerManager }),
    buildSandboxSecrets,
    resolveToolsForAgent,
    logger,
    config: {
      idleTimeoutMs: 60_000,
      maxQueuedMessages: 200,
      ...(options?.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    },
  });

  return {
    manager,
    containerManager,
    db,
    lifecyclePolicy,
    grpcClient,
    logger,
    buildSandboxSecrets,
    resolveToolsForAgent,
    internals: manager as unknown as SandboxSessionManagerInternals,
  };
}

describe('SandboxSessionManager contract', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('ensure/create', () => {
    it('creates a fresh session, opens gRPC, and caches it when no DB row exists', async () => {
      const { manager, containerManager, db, grpcClient, internals, buildSandboxSecrets } = createManager();

      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
      expect(buildSandboxSecrets).toHaveBeenCalledWith('agent-1');
      expect(grpcClient.openSession).toHaveBeenCalledTimes(1);
      expect(db.createSandboxSession).toHaveBeenCalledTimes(1);
      expect(session).toMatchObject({
        conversationId: 'conv-1',
        agentId: 'agent-1',
        status: 'ACTIVE',
      });
      expect(internals.stateStore.sessions.get('conv-1')?.sessionId).toBe(session.sessionId);
      expect(internals.stateStore.agentDefs.get('conv-1')).toMatchObject({ name: 'agent-1' });
    });

    it('merges runtime sandbox secrets into fresh session containers', async () => {
      const { manager, containerManager, buildSandboxSecrets } = createManager();
      buildSandboxSecrets.mockResolvedValue({
        OPENAI_API_KEY: 'base-key',
        PILOT_SERVICE_TOKEN: 'stored-token',
      });

      await manager.ensureSession('conv-1', {
        ...createAgentDef(),
        runtimeSandboxSecrets: {
          PILOT_SERVICE_TOKEN: 'runtime-token',
          PILOT_API_BASE: 'http://api:3000',
        },
      } as unknown as AgentDefinition, 'agent-1');

      expect(containerManager.createContainer).toHaveBeenCalledWith(expect.objectContaining({
        secrets: {
          OPENAI_API_KEY: 'base-key',
          PILOT_SERVICE_TOKEN: 'runtime-token',
          PILOT_API_BASE: 'http://api:3000',
        },
      }));
    });

    it('injects session-scoped callback auth secrets into fresh session containers', async () => {
      vi.stubEnv('CTXMILL_API_TOKEN', 'api-token');
      const { manager, containerManager } = createManager();

      await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      const createContainer = vi.mocked(containerManager.createContainer);
      const createOpts = createContainer.mock.calls[0]?.[0];
      if (!createOpts) {
        throw new Error('expected createContainer to be called');
      }

      expect(createOpts.secrets).toMatchObject({
        [CALLBACK_SESSION_ENV]: createOpts.sessionId,
        [CALLBACK_AGENT_ENV]: 'agent-1',
        [CALLBACK_TOKEN_ENV]: mintGrpcCallbackToken(createOpts.sessionId, 'agent-1', 'api-token'),
      });
    });

    it('rolls back a fresh container when readiness fails before DB session creation', async () => {
      const { manager, containerManager, db, grpcClient } = createManager();
      grpcClient.killSession.mockRejectedValueOnce(new Error('probe failed'));

      await expect(manager.ensureSession('conv-1', createAgentDef(), 'agent-1')).rejects.toThrow('probe failed');

      expect(db.createSandboxSession).not.toHaveBeenCalled();
      expect(containerManager.stopContainer).toHaveBeenCalledWith('c-1', 10);
      expect(containerManager.removeContainer).toHaveBeenCalledWith('c-1', true);
    });

    it('rolls back a fresh container when OpenSession fails before DB session creation', async () => {
      const { manager, containerManager, db, grpcClient } = createManager();
      grpcClient.openSession.mockRejectedValueOnce(new Error('open failed'));

      await expect(manager.ensureSession('conv-1', createAgentDef(), 'agent-1')).rejects.toThrow('open failed');

      expect(db.createSandboxSession).not.toHaveBeenCalled();
      expect(containerManager.stopContainer).toHaveBeenCalledWith('c-1', 10);
      expect(containerManager.removeContainer).toHaveBeenCalledWith('c-1', true);
    });

    it('rolls back a fresh container when DB session creation fails', async () => {
      const { manager, containerManager, db } = createManager();
      (db.createSandboxSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db insert failed'));

      await expect(manager.ensureSession('conv-1', createAgentDef(), 'agent-1')).rejects.toThrow('db insert failed');

      expect(containerManager.stopContainer).toHaveBeenCalledWith('c-1', 10);
      expect(containerManager.removeContainer).toHaveBeenCalledWith('c-1', true);
    });

    it('logs cleanup failures during fresh startup rollback without hiding the original error', async () => {
      const { manager, containerManager, grpcClient, logger } = createManager();
      grpcClient.openSession.mockRejectedValueOnce(new Error('open failed'));
      (containerManager.stopContainer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('stop failed'));
      (containerManager.removeContainer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('remove failed'));

      await expect(manager.ensureSession('conv-1', createAgentDef(), 'agent-1')).rejects.toThrow('open failed');

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/startup rollback.*container stop failed/),
        expect.any(Error),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/startup rollback.*container removal failed/),
        expect.any(Error),
        expect.objectContaining({ stopError: expect.any(Error) }),
      );
    });

    it('reconnects to an ACTIVE DB session when the container is still alive', async () => {
      const { manager, containerManager, db, grpcClient, internals } = createManager();
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(
        createDbSession('ACTIVE'),
      );

      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      expect(containerManager.createContainer).not.toHaveBeenCalled();
      expect(grpcClient.openSession).not.toHaveBeenCalled();
      expect(session).toMatchObject({ sessionId: 'sess-1', status: 'ACTIVE' });
      expect(internals.stateStore.sessions.get('conv-1')?.sessionId).toBe('sess-1');
    });

    it('restores a CHECKPOINTED session from its checkpoint', async () => {
      const { manager, containerManager, db, buildSandboxSecrets } = createManager();
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(
        createDbSession('CHECKPOINTED'),
      );
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
      expect(buildSandboxSecrets).toHaveBeenCalledWith('agent-1');
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'sess-1',
        'RESTORING',
        undefined,
        { expectedFrom: 'CHECKPOINTED' },
      );
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'sess-1',
        'ACTIVE',
        expect.objectContaining({
          containerId: 'c-1',
          containerName: 'ctxmill-run-sess-1',
        }),
        { expectedFrom: 'RESTORING' },
      );
      expect(session).toMatchObject({ sessionId: 'sess-1', status: 'ACTIVE' });
    });

    it('recovers a dead ACTIVE session by restoring from checkpoint when one exists', async () => {
      vi.useFakeTimers();
      const { manager, db, grpcClient } = createManager();
      const failingClient = createMockGrpcClient();
      failingClient.killSession.mockRejectedValue(
        new Error('getaddrinfo ENOTFOUND ctxmill-run-sess-1'),
      );
      connectMocks.createClientMock.mockReturnValueOnce(failingClient).mockReturnValue(grpcClient);
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(
        createDbSession('ACTIVE'),
      );
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

      const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await vi.advanceTimersByTimeAsync(10_500);
      const session = await sessionPromise;

      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'sess-1',
        'CHECKPOINTED',
        expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
        { expectedFrom: 'ACTIVE' },
      );
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'sess-1',
        'RESTORING',
        undefined,
        { expectedFrom: 'CHECKPOINTED' },
      );
      expect(session).toMatchObject({ sessionId: 'sess-1', status: 'ACTIVE' });
    });

    it('recovers a dead ACTIVE session by creating a fresh one when no checkpoint exists', async () => {
      vi.useFakeTimers();
      const { manager, containerManager, db, grpcClient } = createManager();
      const failingClient = createMockGrpcClient();
      failingClient.killSession.mockRejectedValue(
        new Error('getaddrinfo ENOTFOUND ctxmill-run-sess-1'),
      );
      connectMocks.createClientMock.mockReturnValueOnce(failingClient).mockReturnValue(grpcClient);
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(
        createDbSession('ACTIVE'),
      );
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await vi.advanceTimersByTimeAsync(10_500);
      const session = await sessionPromise;

      expect(db.createSandboxSession).toHaveBeenCalledTimes(1);
      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
      expect(session.sessionId).not.toBe('sess-1');
      expect(session.status).toBe('ACTIVE');
    });

    it('creates a fresh session when the DB row is TERMINATED', async () => {
      const { manager, containerManager, db } = createManager();
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(
        createDbSession('TERMINATED'),
      );

      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
      expect(db.createSandboxSession).toHaveBeenCalledTimes(1);
      expect(session.sessionId).not.toBe('sess-1');
      expect(session.status).toBe('ACTIVE');
    });
  });

  describe('deliver/coalesce', () => {
    it('delivers a single turn and streams committed events back', async () => {
      const { manager, lifecyclePolicy, grpcClient } = createManager();
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      const events = await collectEvents(
        manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'),
      );

      expect(events).toEqual([
        expect.objectContaining({
          type: 'message_committed',
          content: 'assistant reply',
          turnId: 'turn-1',
        }),
      ]);
      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(1);
      expect(lifecyclePolicy.cancelIdleTimeout).toHaveBeenCalledWith(session.sessionId);
      expect(lifecyclePolicy.scheduleIdleTimeout).toHaveBeenCalledTimes(1);
    });

    it('queues a concurrent second turn until the first completes, then drains it', async () => {
      const { manager, grpcClient, internals } = createManager();
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      const firstStarted = deferred();
      const firstRelease = deferred();
      let callCount = 0;

      grpcClient.deliverTurn.mockImplementation((request: { turnId: string }) => {
        callCount += 1;
        if (callCount === 1) {
          return (async function* () {
            firstStarted.resolve();
            await firstRelease.promise;
            yield protoCommittedEvent('first-response', request.turnId);
            yield protoTurnCompletedEvent(request.turnId);
          })();
        }
        return streamProtoEvents(
          protoCommittedEvent('second-response', request.turnId),
          protoTurnCompletedEvent(request.turnId),
        );
      });

      const firstTurnPromise = collectEvents(
        manager.deliverTurn(session.sessionId, [createMessage('first')], 'turn-1'),
      );
      const secondTurnPromise = collectEvents(
        manager.deliverTurn(session.sessionId, [createMessage('second')], 'turn-2'),
      );

      await firstStarted.promise;
      await Promise.resolve();
      expect(internals.stateStore.activeTurns.has(session.sessionId)).toBe(true);
      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(1);

      firstRelease.resolve();
      const [firstEvents, secondEvents] = await Promise.all([firstTurnPromise, secondTurnPromise]);

      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(2);
      expect(firstEvents).toEqual([
        expect.objectContaining({ type: 'message_committed', content: 'first-response', turnId: 'turn-1' }),
      ]);
      expect(secondEvents).toEqual([
        expect.objectContaining({ type: 'message_committed', content: 'second-response' }),
      ]);
      expect(internals.stateStore.activeTurns.has(session.sessionId)).toBe(false);
      expect(internals.stateStore.turnQueues.get(session.sessionId) ?? []).toHaveLength(0);
    });

    it('stops draining queued turns at the MAX_DRAIN_ITERATIONS safety limit', async () => {
      const { manager, internals } = createManager();
      const sessionId = 'sess-limit';
      const logger = (manager as unknown as { logger: ReturnType<typeof createLogger> }).logger;
      let iterationCount = 0;

      const enqueue = (suffix: string) => {
        const queue = internals.stateStore.turnQueues.get(sessionId) ?? [];
        queue.push({
          messages: [createMessage(`queued-${suffix}`)],
          turnId: `queued-${suffix}`,
          channel: createChannel(),
        });
        internals.stateStore.turnQueues.set(sessionId, queue);
      };

      enqueue('initial');

      const executeDeliverTurnMock = vi.fn(async function* () {
        iterationCount += 1;
        enqueue(`loop-${iterationCount}`);
        yield {
          type: 'message_committed',
          role: 'assistant',
          content: `iteration-${iterationCount}`,
          turnId: `coalesced-${iterationCount}`,
          messageSeq: iterationCount,
        } satisfies SessionEvent;
      });

      (manager as unknown as SandboxSessionManagerInternals).executeDeliverTurn = executeDeliverTurnMock;

      await internals.drainCoalescedQueue(sessionId);

      expect(executeDeliverTurnMock).toHaveBeenCalledTimes(100);
      expect(iterationCount).toBe(100);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('drain loop hit safety limit (100)'));
      expect(internals.stateStore.activeTurns.has(sessionId)).toBe(false);
    });
  });

  describe('suspend/restore', () => {
    it('suspends an active session, stores a checkpoint, stops the container, and marks it CHECKPOINTED', async () => {
      const { manager, containerManager, db, lifecyclePolicy, grpcClient, internals } = createManager();
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      grpcClient.suspendSession.mockResolvedValueOnce({
        sessionCheckpoint: {
          checkpointVersion: 2,
          sessionId: session.sessionId,
          conversationId: session.conversationId,
          harnessName: session.harnessName,
          harnessState: {},
        } as unknown as SessionCheckpoint,
      });

      const checkpoint = await manager.suspendSession(session.sessionId, 'manual-checkpoint');

      expect(checkpoint.sessionId).toBe(session.sessionId);
      expect(grpcClient.suspendSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.sessionId, reason: 'manual-checkpoint' }),
      );
      expect(db.createCheckpointV2).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.sessionId, suspendReason: 'manual-checkpoint' }),
      );
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(
        session.sessionId,
        'CHECKPOINTED',
        expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
        { expectedFrom: 'ACTIVE' },
      );
      expect(lifecyclePolicy.cancelIdleTimeout).toHaveBeenCalledWith(session.sessionId);
      expect(containerManager.stopContainer).toHaveBeenCalledWith('c-1', 10);
      expect(containerManager.removeContainer).toHaveBeenCalledWith('c-1', true);
      expect(internals.stateStore.sessions.has('conv-1')).toBe(false);
      expect(internals.stateStore.agentDefs.has('conv-1')).toBe(false);
      expect(internals.stateStore.turnQueues.has(session.sessionId)).toBe(false);
      expect(internals.stateStore.activeTurns.has(session.sessionId)).toBe(false);
    });

    it('rejects API-style suspend while a turn is active without calling the sandbox', async () => {
      const { manager, db, containerManager, lifecyclePolicy, grpcClient, internals } = createManager();
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      internals.stateStore.markTurnActive(session.sessionId, 'turn-active');

      await expect(manager.suspendSession(session.sessionId, 'api_request')).rejects.toMatchObject({
        sessionId: session.sessionId,
        turnId: 'turn-active',
      });

      expect(grpcClient.suspendSession).not.toHaveBeenCalled();
      expect(db.createCheckpointV2).not.toHaveBeenCalled();
      expect(lifecyclePolicy.cancelIdleTimeout).not.toHaveBeenCalled();
      expect(containerManager.stopContainer).not.toHaveBeenCalled();
      expect(containerManager.removeContainer).not.toHaveBeenCalled();
      expect(internals.stateStore.activeTurns.get(session.sessionId)).toBe('turn-active');
    });

    it('allows internal safe-phase suspend while a turn is active', async () => {
      const { manager, grpcClient, internals } = createManager();
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      internals.stateStore.markTurnActive(session.sessionId, 'turn-active');

      grpcClient.suspendSession.mockResolvedValueOnce({
        sessionCheckpoint: {
          checkpointVersion: 2,
          sessionId: session.sessionId,
          conversationId: session.conversationId,
          harnessName: session.harnessName,
          harnessState: {},
        } as unknown as SessionCheckpoint,
      });

      await manager.suspendSession(session.sessionId, 'hitl-timeout', { allowActiveTurn: true });

      expect(grpcClient.suspendSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.sessionId, reason: 'hitl-timeout' }),
      );
    });

    it('throws when suspend is requested after the session has already been checkpointed and evicted', async () => {
      const { manager } = createManager();
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      await manager.suspendSession(session.sessionId, 'manual-checkpoint');

      await expect(manager.suspendSession(session.sessionId, 'manual-checkpoint')).rejects.toThrow(
        `Session ${session.sessionId} not found in active sessions`,
      );
    });

    it('restores a suspended session through RESTORING back to ACTIVE on the next ensureSession', async () => {
      const { manager, db, grpcClient } = createManager();
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      grpcClient.suspendSession.mockResolvedValueOnce({
        sessionCheckpoint: {
          checkpointVersion: 2,
          sessionId: session.sessionId,
          conversationId: session.conversationId,
          harnessName: session.harnessName,
          harnessState: {},
        } as unknown as SessionCheckpoint,
      });

      await manager.suspendSession(session.sessionId, 'manual-checkpoint');

      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(
        createDbSession('CHECKPOINTED', {
          id: session.sessionId,
          conversationId: session.conversationId,
          agentId: session.agentId,
        }),
      );
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(
        createCheckpoint({
          sessionId: session.sessionId,
          conversationId: session.conversationId,
          agentId: session.agentId,
        }),
      );

      const restored = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(
        session.sessionId,
        'RESTORING',
        undefined,
        { expectedFrom: 'CHECKPOINTED' },
      );
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(
        session.sessionId,
        'ACTIVE',
        expect.objectContaining({
          containerId: 'c-1',
          containerName: 'ctxmill-run-sess-1',
        }),
        { expectedFrom: 'RESTORING' },
      );
      expect(restored).toMatchObject({ sessionId: session.sessionId, status: 'ACTIVE' });
    });
  });

  describe('kill', () => {
    it('kills an active session, removes its container, and marks it TERMINATED', async () => {
      const { manager, containerManager, db, lifecyclePolicy, internals } = createManager();
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      await manager.killSession(session.sessionId);

      expect(lifecyclePolicy.cancelIdleTimeout).toHaveBeenCalledWith(session.sessionId);
      expect(containerManager.stopContainer).toHaveBeenCalledWith('c-1', 10);
      expect(containerManager.removeContainer).toHaveBeenCalledWith('c-1', true);
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(
        session.sessionId,
        'TERMINATED',
        expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
        { expectedFrom: 'ACTIVE' },
      );
      expect(internals.stateStore.sessions.has('conv-1')).toBe(false);
      expect(internals.stateStore.agentDefs.has('conv-1')).toBe(false);
      expect(internals.stateStore.turnQueues.has(session.sessionId)).toBe(false);
      expect(internals.stateStore.activeTurns.has(session.sessionId)).toBe(false);
    });

    it('is idempotent when killing an already terminated session', async () => {
      const { manager, containerManager, db } = createManager();
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      await manager.killSession(session.sessionId);
      await expect(manager.killSession(session.sessionId)).resolves.toBeUndefined();

      expect(containerManager.removeContainer).toHaveBeenCalledTimes(1);
      expect(db.updateSandboxSessionStatus).toHaveBeenNthCalledWith(
        1,
        session.sessionId,
        'TERMINATED',
        expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
        { expectedFrom: 'ACTIVE' },
      );
      expect(db.updateSandboxSessionStatus).toHaveBeenNthCalledWith(
        2,
        session.sessionId,
        'TERMINATED',
        expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
        { expectedFrom: 'ACTIVE' },
      );
    });
  });
});
