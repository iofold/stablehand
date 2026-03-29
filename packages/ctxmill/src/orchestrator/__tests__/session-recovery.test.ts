import { create } from '@bufbuild/protobuf';
import { ConnectError, Code } from '@connectrpc/connect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageCommittedSchema,
  SessionEventSchema,
  type SessionEvent as ProtoSessionEvent,
  type SessionCheckpoint,
} from '@ctxmill/proto/sandbox/v1';

import { SandboxSessionManager, type SessionRecord } from '../sandbox-session-manager.js';
import type { SessionEvent } from '../sandbox-run-service.js';
import type { DatabaseRepository, SandboxSessionRow } from '../../database/repository.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { ContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { AgentDefinition, Message } from '../../types.js';

const connectMocks = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  createGrpcTransportMock: vi.fn(),
}));

vi.mock('@connectrpc/connect', async () => {
  const actual = await vi.importActual<typeof import('@connectrpc/connect')>('@connectrpc/connect');
  return {
    ...actual,
    createClient: connectMocks.createClientMock,
  };
});

vi.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: connectMocks.createGrpcTransportMock,
}));

type MockGrpcClient = ReturnType<typeof createMockGrpcClient>;

function createMockContainerManager(): ContainerManager {
  return {
    createContainer: vi.fn().mockResolvedValue({
      containerId: 'c-1',
      containerName: 'ctxmill-run-sess-1',
    }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    pauseContainer: vi.fn().mockResolvedValue(undefined),
    unpauseContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    injectSecrets: vi.fn().mockResolvedValue(undefined),
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
    createSandboxSession: vi.fn().mockImplementation(async (session: { id?: string; conversationId: string; agentId: string; containerName?: string; containerId?: string; status?: string; harnessName: string; checkpointRef?: string }) => ({
      id: session.id ?? 'generated-session',
      conversationId: session.conversationId,
      agentId: session.agentId,
      containerName: session.containerName ?? null,
      containerId: session.containerId ?? null,
      status: session.status ?? 'ACTIVE',
      harnessName: session.harnessName,
      checkpointRef: session.checkpointRef ?? null,
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
    cancelPause: vi.fn().mockResolvedValue(undefined),
    cancelIdleTimeout: vi.fn().mockResolvedValue(undefined),
    schedulePause: vi.fn(),
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

function createDbSession(status: SandboxSessionRow['status']): SandboxSessionRow {
  return {
    id: 'sess-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    containerName: 'ctxmill-run-sess-1',
    containerId: 'c-1',
    status,
    harnessName: 'langgraph',
    checkpointRef: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
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
  sessions: Map<string, SessionRecord>;
  isStaleContainerError(err: unknown): boolean;
};

describe('SandboxSessionManager session recovery', () => {
  let containerManager: ContainerManager;
  let db: DatabaseRepository;
  let lifecyclePolicy: ContainerLifecyclePolicy;
  let grpcClient: MockGrpcClient;
  let manager: SandboxSessionManager;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    containerManager = createMockContainerManager();
    db = createMockDb();
    lifecyclePolicy = createMockLifecyclePolicy();
    grpcClient = createMockGrpcClient();
    connectMocks.createGrpcTransportMock.mockReturnValue({});
    connectMocks.createClientMock.mockReturnValue(grpcClient);
    manager = new SandboxSessionManager({
      containerManager,
      db,
      lifecyclePolicy,
      workspaceDiffService: new WorkspaceDiffService({ containerManager }),
      logger: createLogger(),
      config: { idleTimeoutMs: 60_000, maxQueuedMessages: 10 },
    });
  });

  describe('ensureSession — dead container recovery', () => {
    it('ACTIVE + reconnect fails + checkpoint exists → restores from checkpoint', async () => {
      vi.useFakeTimers();
      const failingClient = createMockGrpcClient();
      failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-run-sess-1'));
      connectMocks.createClientMock
        .mockReturnValueOnce(failingClient)
        .mockReturnValue(grpcClient);
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

      const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await vi.advanceTimersByTimeAsync(10_500);
      const session = await sessionPromise;

      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith('sess-1', 'CHECKPOINTED');
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith('sess-1', 'RESTORING');
      expect(session.sessionId).toBe('sess-1');
      expect(session.status).toBe('ACTIVE');
      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
    });

    it('ACTIVE + reconnect fails + no checkpoint → creates fresh session', async () => {
      vi.useFakeTimers();
      const failingClient = createMockGrpcClient();
      failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-run-sess-1'));
      connectMocks.createClientMock
        .mockReturnValueOnce(failingClient)
        .mockReturnValue(grpcClient);
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await vi.advanceTimersByTimeAsync(10_500);
      const session = await sessionPromise;

      expect(db.updateSandboxSessionStatus).not.toHaveBeenCalledWith('sess-1', 'CHECKPOINTED');
      expect(db.createSandboxSession).toHaveBeenCalledTimes(1);
      expect(session.sessionId).not.toBe('sess-1');
      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
    });

    it('FROZEN + unfreeze fails + checkpoint exists → restores from checkpoint', async () => {
      vi.useFakeTimers();
      const failingClient = createMockGrpcClient();
      failingClient.killSession.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:50051'));
      connectMocks.createClientMock
        .mockReturnValueOnce(failingClient)
        .mockReturnValue(grpcClient);
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('FROZEN'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

      const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await vi.advanceTimersByTimeAsync(10_500);
      const session = await sessionPromise;

      expect(containerManager.unpauseContainer).toHaveBeenCalledWith('c-1');
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith('sess-1', 'ACTIVE');
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith('sess-1', 'CHECKPOINTED');
      expect(session.sessionId).toBe('sess-1');
      expect(session.status).toBe('ACTIVE');
    });

    it('FROZEN + unfreeze fails + no checkpoint → creates fresh session', async () => {
      vi.useFakeTimers();
      const failingClient = createMockGrpcClient();
      failingClient.killSession.mockRejectedValue(new Error('socket hang up ECONNRESET'));
      connectMocks.createClientMock
        .mockReturnValueOnce(failingClient)
        .mockReturnValue(grpcClient);
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('FROZEN'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await vi.advanceTimersByTimeAsync(10_500);
      const session = await sessionPromise;

      expect(containerManager.unpauseContainer).toHaveBeenCalledWith('c-1');
      expect(db.createSandboxSession).toHaveBeenCalledTimes(1);
      expect(session.sessionId).not.toBe('sess-1');
      expect(session.status).toBe('ACTIVE');
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
  });

  describe('executeDeliverTurn — stale container recovery', () => {
    it('ConnectError(Unavailable) during stream → retries via ensureSession', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn
        .mockImplementationOnce(() => {
          throw new ConnectError('unavailable', Code.Unavailable);
        })
        .mockImplementationOnce(() => streamProtoEvents(protoCommittedEvent('recovered')));

      const events = await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(2);
      expect(containerManager.createContainer).toHaveBeenCalledTimes(2);
      expect(events).toEqual([
        expect.objectContaining({ type: 'message_committed', content: 'recovered' }),
      ]);
    });

    it('ENOTFOUND error during stream → retries via ensureSession', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn
        .mockImplementationOnce(() => {
          throw new Error('getaddrinfo ENOTFOUND ctxmill-run-sess-1');
        })
        .mockImplementationOnce(() => streamProtoEvents(protoCommittedEvent('retried after dns failure')));

      const events = await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(2);
      expect(events[0]).toEqual(expect.objectContaining({ type: 'message_committed', content: 'retried after dns failure' }));
    });

    it('ConnectError(InvalidArgument) → rethrown without retry', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn.mockImplementationOnce(() => {
        throw new ConnectError('invalid', Code.InvalidArgument);
      });

      await expect(collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1')))
        .rejects.toThrow('invalid');
      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(1);
      expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
    });

    it('retry limited to once — second failure throws', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      grpcClient.deliverTurn
        .mockImplementationOnce(() => {
          throw new ConnectError('unavailable-1', Code.Unavailable);
        })
        .mockImplementationOnce(() => {
          throw new ConnectError('unavailable-2', Code.Unavailable);
        });

      await expect(collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1')))
        .rejects.toThrow('unavailable-2');
      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(2);
    });

    it('no cached agentDef → error rethrown without retry', async () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      privateManager.sessions.set('conv-1', {
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        agentId: 'agent-1',
        containerName: 'ctxmill-run-sess-1',
        containerId: 'c-1',
        status: 'ACTIVE',
        harnessName: 'langgraph',
        grpcClient,
      });
      grpcClient.deliverTurn.mockImplementationOnce(() => {
        throw new ConnectError('unavailable', Code.Unavailable);
      });

      await expect(collectEvents(manager.deliverTurn('sess-1', [createMessage('hello')], 'turn-1')))
        .rejects.toThrow('unavailable');
      expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(1);
      expect(containerManager.createContainer).not.toHaveBeenCalled();
    });
  });

  describe('idle timeout scheduling', () => {
    it('scheduleIdleTimeout called after turn completion (not schedulePause)', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      expect(lifecyclePolicy.scheduleIdleTimeout).toHaveBeenCalledTimes(1);
      expect(lifecyclePolicy.schedulePause).not.toHaveBeenCalled();
    });

    it('cancelIdleTimeout called at turn start', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

      await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      expect(lifecyclePolicy.cancelIdleTimeout).toHaveBeenCalledWith(session.sessionId);
      expect(lifecyclePolicy.cancelPause).toHaveBeenCalledWith(session.sessionId);
    });

    it('onFreeze callback calls freezeSession', async () => {
      const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
      await collectEvents(manager.deliverTurn(session.sessionId, [createMessage('hello')], 'turn-1'));

      const callbacks = (lifecyclePolicy.scheduleIdleTimeout as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as {
        onFreeze: (sessionId: string) => Promise<void>;
      };
      await callbacks.onFreeze(session.sessionId);

      expect(containerManager.pauseContainer).toHaveBeenCalledWith('c-1');
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(session.sessionId, 'FROZEN');
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
      expect(db.createCheckpointV2).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        suspendReason: 'idle-checkpoint',
      }));
      expect(db.updateSandboxSessionStatus).toHaveBeenCalledWith(session.sessionId, 'CHECKPOINTED');
    });
  });

  describe('isStaleContainerError', () => {
    it('ConnectError with Code.Unavailable → true', () => {
      const privateManager = manager as unknown as SandboxSessionManagerInternals;
      expect(privateManager.isStaleContainerError(new ConnectError('unavailable', Code.Unavailable))).toBe(true);
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
