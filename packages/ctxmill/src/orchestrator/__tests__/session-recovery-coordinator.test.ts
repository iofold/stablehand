import { create } from '@bufbuild/protobuf';
import { ConnectError, Code } from '@connectrpc/connect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageCommittedSchema,
  SessionEventSchema,
  ToolLocation,
  ToolMetadataSchema,
  type SessionCheckpoint,
  type SessionEvent as ProtoSessionEvent,
} from '@ctxmill/proto/sandbox/v1';

import { SandboxSessionManager, type SessionRecord } from '../sandbox-session-manager.js';
import type { DatabaseRepository, SandboxSessionRow } from '../../database/repository.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { ContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { AgentDefinition } from '../../types.js';

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

type ManagerInternals = {
  stateStore: {
    sessions: Map<string, SessionRecord>;
    agentDefs: Map<string, AgentDefinition>;
  };
};

function createMockContainerManager(): ContainerManager {
  return {
    createContainer: vi.fn().mockResolvedValue({
      containerId: 'c-2',
      containerName: 'ctxmill-run-sess-2',
    }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    extractContainerDiff: vi.fn().mockResolvedValue(undefined),
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
    createSandboxSession: vi.fn().mockImplementation(async (session: {
      id?: string;
      conversationId: string;
      agentId: string;
      containerName?: string;
      containerId?: string;
      status?: string;
      harnessName: string;
      checkpointRef?: string;
    }) => ({
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

function createAgentDef(): AgentDefinition {
  return {
    name: 'agent-1',
    harness: 'langgraph',
    systemPrompt: 'test system prompt',
    tools: [],
    harnessConfig: {},
  } as unknown as AgentDefinition;
}

function createWorkspaceAgentDef(): AgentDefinition {
  return {
    ...createAgentDef(),
    workspaceDir: '/repo/base',
  } as AgentDefinition;
}

function createDbSession(
  status: SandboxSessionRow['status'],
  overrides: Partial<SandboxSessionRow> = {},
): SandboxSessionRow {
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
    ...overrides,
  };
}

function createCheckpoint() {
  return {
    id: 'ckpt-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    checkpointVersion: 2,
    checkpointData: { conversationId: 'conv-1', harnessName: 'langgraph', sessionId: 'sess-1' },
    harnessState: { foo: 'bar' },
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

function statusTransitions(db: DatabaseRepository): string[] {
  return (db.updateSandboxSessionStatus as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => call[1] as string);
}

function createManager() {
  const containerManager = createMockContainerManager();
  const db = createMockDb();
  const lifecyclePolicy = createMockLifecyclePolicy();
  const logger = createLogger();
  const grpcClient = createMockGrpcClient();
  const resolveToolsForAgent = vi.fn().mockReturnValue([
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

  const manager = new SandboxSessionManager({
    containerManager,
    db,
    lifecyclePolicy,
    workspaceDiffService: new WorkspaceDiffService({ containerManager }),
    buildSandboxSecrets: () => ({}),
    resolveToolsForAgent,
    logger,
    config: { idleTimeoutMs: 60_000, maxQueuedMessages: 200 },
  });

  return { manager, containerManager, db, lifecyclePolicy, logger, grpcClient, resolveToolsForAgent };
}

describe('SandboxSessionManager recovery coordinator characterization', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reconnects a live ACTIVE session and caches the session record', async () => {
    const { manager, containerManager, db, grpcClient } = createManager();
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));

    const session = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

    expect(connectMocks.createClientMock).toHaveBeenCalledTimes(1);
    expect(containerManager.createContainer).not.toHaveBeenCalled();
    expect(db.getCheckpointV2).not.toHaveBeenCalled();
    expect(db.updateSandboxSessionStatus).not.toHaveBeenCalled();
    expect(grpcClient.openSession).not.toHaveBeenCalled();
    expect(session.sessionId).toBe('sess-1');
    expect(session.status).toBe('ACTIVE');
    expect(manager.findSessionById('sess-1')).toBe(session);
  });

  it('checkpoints and restores an unreachable ACTIVE session when a checkpoint exists', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();
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

    expect(statusTransitions(db)).toEqual(['CHECKPOINTED', 'RESTORING', 'ACTIVE']);
    expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
    expect(grpcClient.openSession).toHaveBeenCalledWith(expect.objectContaining({
      bootstrap: {
        case: 'restore',
        value: expect.objectContaining({
          agentId: 'agent-1',
          harnessConfigJson: '{}',
          systemPrompt: 'test system prompt',
          sessionCheckpoint: expect.objectContaining({
            sessionId: 'sess-1',
            conversationId: 'conv-1',
            harnessName: 'langgraph',
          }),
        }),
      },
    }));
    expect(session).toEqual(expect.objectContaining({
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      containerId: 'c-2',
      containerName: 'ctxmill-run-sess-2',
      status: 'ACTIVE',
    }));
    expect(manager.findSessionById('sess-1')).toBe(session);
  });

  it('fails closed and removes the newly-created container when workspace restore fails', async () => {
    vi.useFakeTimers();
    const restoreSpy = vi
      .spyOn(WorkspaceDiffService.prototype, 'restore')
      .mockRejectedValueOnce(new Error('workspace restore failed'));
    const { manager, containerManager, db, grpcClient } = createManager();
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-run-sess-1'));

    connectMocks.createClientMock
      .mockReturnValueOnce(failingClient)
      .mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

    const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
    const rejection = expect(sessionPromise).rejects.toThrow('workspace restore failed');
    await vi.advanceTimersByTimeAsync(10_500);
    await rejection;

    expect(statusTransitions(db)).toEqual(['CHECKPOINTED', 'RESTORING', 'CHECKPOINTED']);
    expect(containerManager.startContainer).toHaveBeenCalledWith('c-2');
    expect(containerManager.stopContainer).toHaveBeenCalledWith('c-2', 10);
    expect(containerManager.removeContainer).toHaveBeenCalledWith('c-2', true);
    expect(grpcClient.openSession).not.toHaveBeenCalled();
    expect(manager.findSessionById('sess-1')).toBeUndefined();

    restoreSpy.mockRestore();
  });

  it('reuses the persisted session workspace during checkpoint restore', async () => {
    vi.useFakeTimers();
    const restoreSpy = vi.spyOn(WorkspaceDiffService.prototype, 'restore');
    const { manager, containerManager, db, grpcClient } = createManager();
    vi.spyOn(manager, 'getExistingSessionWorkspaceDir').mockResolvedValue('/tmp/data/sessions/sess-1/workspace');
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-run-sess-1'));

    connectMocks.createClientMock
      .mockReturnValueOnce(failingClient)
      .mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

    const sessionPromise = manager.ensureSession('conv-1', createWorkspaceAgentDef(), 'agent-1');
    await vi.advanceTimersByTimeAsync(10_500);
    const session = await sessionPromise;

    expect(containerManager.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDir: expect.stringContaining('/sessions/sess-1/workspace'),
    }));
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(session.sessionWorkspaceDir).toMatch(/\/sessions\/sess-1\/workspace$/);
  });

  it('fails checkpoint restore when a session workspace was expected but is missing', async () => {
    vi.useFakeTimers();
    const restoreSpy = vi.spyOn(WorkspaceDiffService.prototype, 'restore');
    const { manager, containerManager, db, grpcClient } = createManager();
    vi.spyOn(manager, 'getExistingSessionWorkspaceDir').mockResolvedValue(undefined);
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-run-sess-1'));

    connectMocks.createClientMock
      .mockReturnValueOnce(failingClient)
      .mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

    const sessionPromise = manager.ensureSession('conv-1', createWorkspaceAgentDef(), 'agent-1');
    const rejection = expect(sessionPromise).rejects.toThrow(/missing persisted session workspace/i);
    await vi.advanceTimersByTimeAsync(10_500);
    await rejection;

    expect(containerManager.createContainer).not.toHaveBeenCalled();
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(statusTransitions(db)).toEqual(['CHECKPOINTED', 'RESTORING', 'TERMINATED']);
  });

  it('terminates RESTORING when the checkpoint row is missing', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();

    connectMocks.createClientMock.mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('CHECKPOINTED'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
    const rejection = expect(sessionPromise).rejects.toThrow('No checkpoint found for session sess-1');
    await vi.advanceTimersByTimeAsync(10_500);
    await rejection;

    expect(containerManager.createContainer).not.toHaveBeenCalled();
    expect(statusTransitions(db)).toEqual(['RESTORING', 'TERMINATED']);
  });

  it('evicts an unreachable ACTIVE session with no checkpoint by creating a fresh replacement session', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();
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

    expect(statusTransitions(db)).toEqual([]);
    expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
    expect(db.createSandboxSession).toHaveBeenCalledTimes(1);
    expect(grpcClient.openSession).toHaveBeenCalledWith(expect.objectContaining({
      bootstrap: {
        case: 'fresh',
        value: expect.objectContaining({
          agentId: 'agent-1',
          conversationId: 'conv-1',
          harnessName: 'langgraph',
          workspaceDir: '/workspace',
        }),
      },
    }));
    expect(session.sessionId).not.toBe('sess-1');
    expect(session.containerId).toBe('c-2');
    expect(session.containerName).toBe('ctxmill-run-sess-2');
    expect(session.status).toBe('ACTIVE');
  });

  it('restores once and then serves the same session from the in-memory cache', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-run-sess-1'));

    connectMocks.createClientMock
      .mockReturnValueOnce(failingClient)
      .mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

    const firstPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
    await vi.advanceTimersByTimeAsync(10_500);
    const first = await firstPromise;
    const second = await manager.ensureSession('conv-1', createAgentDef(), 'agent-1');

    expect(first).toBe(second);
    expect(first.sessionId).toBe('sess-1');
    expect(statusTransitions(db)).toEqual(['CHECKPOINTED', 'RESTORING', 'ACTIVE']);
    expect(db.getSandboxSessionByConversation).toHaveBeenCalledTimes(1);
    expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
    expect(grpcClient.openSession).toHaveBeenCalledTimes(1);
  });

  it('serializes ensureSession and onSessionEvicted for the same conversation with withConversationLock', async () => {
    const { manager, db, grpcClient } = createManager();
    const internals = manager as unknown as ManagerInternals;
    const events: string[] = [];
    let releaseCreateFreshSession!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreateFreshSession = resolve;
    });

    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    Reflect.set(
      manager,
      'createFreshSession',
      vi.fn(async (conversationId: string, agentDef: AgentDefinition, agentId?: string): Promise<SessionRecord> => {
        events.push('ensure-entered-createFreshSession');
        await createGate;
        events.push('ensure-returning-session');

        const record: SessionRecord = {
          sessionId: 'sess-locked',
          conversationId,
          agentId: agentId ?? agentDef.name,
          containerId: 'c-locked',
          containerName: 'ctxmill-run-sess-locked',
          status: 'ACTIVE',
          harnessName: agentDef.harness,
          grpcClient: grpcClient as SessionRecord['grpcClient'],
        };

        internals.stateStore.sessions.set(conversationId, record);
        return record;
      }),
    );

    const ensurePromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
    await Promise.resolve();

    let evicted = false;
    const evictPromise = manager.onSessionEvicted('sess-locked', 'conv-1').then(() => {
      evicted = true;
      events.push('eviction-finished');
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(['ensure-entered-createFreshSession']);
    expect(evicted).toBe(false);

    releaseCreateFreshSession();

    const session = await ensurePromise;
    await evictPromise;

    expect(session.sessionId).toBe('sess-locked');
    expect(events).toEqual([
      'ensure-entered-createFreshSession',
      'ensure-returning-session',
      'eviction-finished',
    ]);
    expect(manager.findSessionById('sess-locked')).toBeUndefined();
    expect(internals.stateStore.agentDefs.has('conv-1')).toBe(false);
  });
});
