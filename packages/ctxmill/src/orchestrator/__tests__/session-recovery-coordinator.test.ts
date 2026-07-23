import { create } from '@bufbuild/protobuf';
import { ConnectError, Code } from '@connectrpc/connect';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import { SessionStateStore } from '../session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../session-manager/session-status-coordinator.js';

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
      containerName: 'ctxmill-sandbox-sess-2',
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
    getSandboxSession: vi.fn().mockImplementation(async () => restoreRow),
    getCheckpointV2: vi.fn().mockResolvedValue(null),
    updateSandboxSessionMetadata: vi.fn().mockResolvedValue(undefined),
    completeSandboxSessionLifecycleOperation: vi.fn().mockResolvedValue(true),
    claimSandboxSessionLifecycleOperation: vi.fn().mockImplementation(async (input) => ({
      sandboxSessionId: input.sandboxSessionId,
      operation: input.operation,
      operationId: 'recovery-operation-1',
      phase: 'reserved',
      ownerId: input.ownerId,
      fenceToken: 1,
      allowedTurnId: null,
      allowedDeliveryOwnerId: null,
      allowedDeliveryFenceToken: null,
      leaseExpiresAt: Date.now() + input.leaseDurationMs,
      updatedAt: Date.now(),
    })),
    renewSandboxSessionLifecycleOperation: vi.fn().mockResolvedValue(true),
    markSandboxSessionLifecycleOperationExecuting: vi.fn().mockResolvedValue(true),
    cancelSandboxSessionLifecycleOperation: vi.fn().mockResolvedValue(true),
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

function createAgentDef(): AgentDefinition {
  return {
    name: 'agent-1',
    harness: 'langgraph',
    systemPrompt: 'test system prompt',
    tools: [],
    harnessConfig: {},
    nativeToolPolicy: {
      policy: 'deny',
      names: ['Bash'],
    },
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
    containerName: 'ctxmill-sandbox-sess-1',
    containerId: 'c-1',
    status,
    harnessName: 'langgraph',
    checkpointRef: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    restoreAttempts: 0,
    lastRestoreError: null,
    restoreOwnerId: status === 'RESTORING' ? 'restore-owner' : null,
    restoreFenceToken: status === 'RESTORING' ? 1 : 0,
    restoreLeaseExpiresAt:
      status === 'RESTORING' ? Date.now() + 60_000 : null,
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
  const direct = (db.updateSandboxSessionMetadata as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[], index: number) => ({
      status: call[1] as string,
      order: (db.updateSandboxSessionMetadata as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[index] ?? Number.MAX_SAFE_INTEGER,
    }));
  const fenced = (
    db.completeSandboxSessionLifecycleOperation as ReturnType<typeof vi.fn>
  ).mock.calls.map((call: unknown[], index: number) => ({
    status: (call[0] as { toStatus: string }).toStatus,
    order: (
      db.completeSandboxSessionLifecycleOperation as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[index] ?? Number.MAX_SAFE_INTEGER,
  }));
  return [...direct, ...fenced]
    .sort((left, right) => left.order - right.order)
    .map(({ status }) => status);
}

function createManager(options?: { dataDir?: string }) {
  const containerManager = createMockContainerManager();
  const db = createMockDb();
  const lifecyclePolicy = createMockLifecyclePolicy();
  const logger = createLogger();
  const stateStore = new SessionStateStore();
  const statusCoordinator = new SessionStatusCoordinator({ db, logger, stateStore });
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
    stateStore,
    statusCoordinator,
    workspaceDiffService: new WorkspaceDiffService({ containerManager }),
    buildSandboxSecrets: async () => ({}),
    resolveTurnSecrets: async () => ({}),
    resolveToolsForAgent,
    logger,
    config: { idleTimeoutMs: 60_000, maxQueuedMessages: 200 },
    dataDir: options?.dataDir,
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
    expect(db.updateSandboxSessionMetadata).not.toHaveBeenCalled();
    expect(grpcClient.openSession).not.toHaveBeenCalled();
    expect(session.sessionId).toBe('sess-1');
    expect(session.status).toBe('ACTIVE');
    expect(manager.findSessionById('sess-1')).toBe(session);
  });

  it('repairs a host-absolute setup symlink before reconnecting an ACTIVE session', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'ctxmill-reconnect-symlink-repair-'));
    try {
      const dataDir = join(tempDir, '.ctxmill');
      const baseWorkspaceDir = join(tempDir, 'base', 'workspace');
      await fs.mkdir(join(baseWorkspaceDir, 'skills'), { recursive: true });
      await fs.writeFile(join(baseWorkspaceDir, 'skills', 'SKILL.md'), '# Reconnected skill');
      const agentDef = {
        ...createAgentDef(),
        workspaceDir: baseWorkspaceDir,
        harnessConfig: {
          setup: {
            symlinks: [{ src: 'skills', dest: '.claude/skills' }],
          },
        },
      } as AgentDefinition;

      const firstManager = createManager({ dataDir }).manager;
      const first = await firstManager.createFreshSession(
        'conv-1',
        agentDef,
        'agent-1',
      );
      const skillLink = join(first.sessionWorkspaceDir!, '.claude', 'skills');
      await fs.unlink(skillLink);
      await fs.symlink(join(first.sessionWorkspaceDir!, 'skills'), skillLink);

      const { manager, db } = createManager({ dataDir });
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>)
        .mockResolvedValue(createDbSession('ACTIVE'));
      await expect(
        manager.getExistingConversationWorkspaceDir('agent-1', 'conv-1'),
      ).resolves.toBe(first.sessionWorkspaceDir);

      const reconnected = await manager.ensureSession(
        'conv-1',
        agentDef,
        'agent-1',
      );

      expect(reconnected.sessionWorkspaceDir).toBe(first.sessionWorkspaceDir);
      await expect(fs.readlink(skillLink)).resolves.toBe('../skills');
      await expect(fs.readFile(join(skillLink, 'SKILL.md'), 'utf8'))
        .resolves.toBe('# Reconnected skill');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not recover or remove a healthy ACTIVE container for a workspace setup conflict', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'ctxmill-reconnect-symlink-conflict-'));
    try {
      const dataDir = join(tempDir, '.ctxmill');
      const baseWorkspaceDir = join(tempDir, 'base', 'workspace');
      await fs.mkdir(join(baseWorkspaceDir, 'skills'), { recursive: true });
      const agentDef = {
        ...createAgentDef(),
        workspaceDir: baseWorkspaceDir,
        harnessConfig: {
          setup: {
            symlinks: [{ src: 'skills', dest: '.claude/skills' }],
          },
        },
      } as AgentDefinition;

      const firstManager = createManager({ dataDir }).manager;
      const first = await firstManager.createFreshSession(
        'conv-1',
        agentDef,
        'agent-1',
      );
      const skillLink = join(first.sessionWorkspaceDir!, '.claude', 'skills');
      await fs.unlink(skillLink);
      await fs.writeFile(skillLink, 'user-owned');

      const { manager, containerManager, db } = createManager({ dataDir });
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>)
        .mockResolvedValue(createDbSession('ACTIVE'));

      await expect(
        manager.ensureSession('conv-1', agentDef, 'agent-1'),
      ).rejects.toThrow(/workspace|symlink|destination/i);

      expect(containerManager.stopContainer).not.toHaveBeenCalled();
      expect(containerManager.removeContainer).not.toHaveBeenCalled();
      expect(db.claimSandboxSessionLifecycleOperation).not.toHaveBeenCalled();
      expect(statusTransitions(db)).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reuses the conversation workspace across fresh replacement sandbox sessions', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'ctxmill-conversation-workspace-'));
    try {
      const dataDir = join(tempDir, '.ctxmill');
      const baseWorkspaceDir = join(tempDir, 'base');
      await fs.mkdir(baseWorkspaceDir, { recursive: true });
      await fs.writeFile(join(baseWorkspaceDir, 'root.txt'), 'base');

      const { manager, containerManager } = createManager({ dataDir });
      const agentDef = {
        ...createAgentDef(),
        workspaceDir: baseWorkspaceDir,
      } as AgentDefinition;

      const first = await manager.createFreshSession('conv-1', agentDef, 'agent-1');
      expect(first.sessionWorkspaceDir).toBeDefined();
      await fs.writeFile(join(first.sessionWorkspaceDir!, 'root.txt'), 'runtime edit');
      await fs.writeFile(join(first.sessionWorkspaceDir!, 'runtime-only.txt'), 'kept');
      await fs.writeFile(join(baseWorkspaceDir, 'new-base.txt'), 'new base');

      const second = await manager.createFreshSession('conv-1', agentDef, 'agent-1');

      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.sessionWorkspaceDir).toBe(first.sessionWorkspaceDir);
      expect(containerManager.createContainer).toHaveBeenNthCalledWith(1, expect.objectContaining({
        conversationId: 'conv-1',
        workspaceDir: first.sessionWorkspaceDir,
      }));
      expect(containerManager.createContainer).toHaveBeenNthCalledWith(2, expect.objectContaining({
        conversationId: 'conv-1',
        workspaceDir: first.sessionWorkspaceDir,
      }));
      await expect(fs.readFile(join(second.sessionWorkspaceDir!, 'root.txt'), 'utf8')).resolves.toBe('runtime edit');
      await expect(fs.readFile(join(second.sessionWorkspaceDir!, 'runtime-only.txt'), 'utf8')).resolves.toBe('kept');
      await expect(fs.access(join(second.sessionWorkspaceDir!, 'new-base.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    'accruals',
    'bank-reconciliation',
    'pilot-assistant',
    'flux-variance',
    'freeform-reconciliation',
    'schedule-parsing',
  ])(
    'uses the materialized workspace for Pilot %s sessions without replaying upload sources',
    async (manifestSourceDir) => {
      const tempDir = await fs.mkdtemp(join(tmpdir(), 'ctxmill-materialized-workspace-'));
      try {
        const dataDir = join(tempDir, '.ctxmill');
        const projectDir = join(tempDir, 'base');
        const baseWorkspaceDir = join(projectDir, 'workspace');
        await fs.mkdir(join(baseWorkspaceDir, 'skills'), { recursive: true });
        await fs.writeFile(join(baseWorkspaceDir, 'skills', 'SKILL.md'), '# Materialized skill');

        await expect(
          fs.access(join(projectDir, manifestSourceDir, 'skills')),
        ).rejects.toMatchObject({ code: 'ENOENT' });

        const { manager, containerManager } = createManager({ dataDir });
        const agentDef = {
          ...createAgentDef(),
          workspaceDir: baseWorkspaceDir,
          projectDir,
          workspaceContent: {
            files: [{ src: `${manifestSourceDir}/skills`, dest: 'skills' }],
          },
          harnessConfig: {
            setup: {
              symlinks: [{ src: 'skills', dest: '.claude/skills' }],
            },
          },
        } as AgentDefinition;

        const session = await manager.createFreshSession('conv-1', agentDef, 'agent-1');
        const conversationWorkspace = session.sessionWorkspaceDir!;
        const skillLink = join(conversationWorkspace, '.claude', 'skills');

        expect(containerManager.createContainer).toHaveBeenCalledWith(expect.objectContaining({
          workspaceDir: conversationWorkspace,
        }));
        await expect(fs.readlink(skillLink)).resolves.toBe('../skills');
        await expect(fs.readFile(join(skillLink, 'SKILL.md'), 'utf8')).resolves.toBe('# Materialized skill');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('repairs a host-absolute setup symlink when reusing a materialized conversation workspace', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'ctxmill-materialized-symlink-repair-'));
    try {
      const dataDir = join(tempDir, '.ctxmill');
      const baseWorkspaceDir = join(tempDir, 'base', 'workspace');
      await fs.mkdir(join(baseWorkspaceDir, 'skills'), { recursive: true });
      await fs.writeFile(join(baseWorkspaceDir, 'skills', 'SKILL.md'), '# Portable skill');

      const { manager } = createManager({ dataDir });
      const agentDef = {
        ...createAgentDef(),
        workspaceDir: baseWorkspaceDir,
        harnessConfig: {
          setup: {
            symlinks: [{ src: 'skills', dest: '.claude/skills' }],
          },
        },
      } as AgentDefinition;

      const first = await manager.createFreshSession('conv-1', agentDef, 'agent-1');
      const skillLink = join(first.sessionWorkspaceDir!, '.claude', 'skills');
      await fs.unlink(skillLink);
      await fs.symlink(
        join(first.sessionWorkspaceDir!, 'skills'),
        skillLink,
      );

      const second = await manager.createFreshSession('conv-1', agentDef, 'agent-1');

      expect(second.sessionWorkspaceDir).toBe(first.sessionWorkspaceDir);
      await expect(fs.readlink(skillLink)).resolves.toBe('../skills');
      await expect(fs.readFile(join(skillLink, 'SKILL.md'), 'utf8')).resolves.toBe('# Portable skill');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('repairs a host-absolute setup symlink before checkpoint restore creates a container', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'ctxmill-restore-symlink-repair-'));
    try {
      const dataDir = join(tempDir, '.ctxmill');
      const baseWorkspaceDir = join(tempDir, 'base', 'workspace');
      await fs.mkdir(join(baseWorkspaceDir, 'skills'), { recursive: true });
      await fs.writeFile(join(baseWorkspaceDir, 'skills', 'SKILL.md'), '# Restored skill');
      const agentDef = {
        ...createAgentDef(),
        workspaceDir: baseWorkspaceDir,
        harnessConfig: {
          setup: {
            symlinks: [{ src: 'skills', dest: '.claude/skills' }],
          },
        },
      } as AgentDefinition;

      const firstManager = createManager({ dataDir }).manager;
      const first = await firstManager.createFreshSession(
        'conv-1',
        agentDef,
        'agent-1',
      );
      const skillLink = join(first.sessionWorkspaceDir!, '.claude', 'skills');
      await fs.unlink(skillLink);
      await fs.symlink(first.sessionWorkspaceDir! + '/skills', skillLink);

      const { manager, containerManager, db } = createManager({ dataDir });
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>)
        .mockResolvedValue(createDbSession('CHECKPOINTED'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>)
        .mockResolvedValue(createCheckpoint());

      await manager.ensureSession('conv-1', agentDef, 'agent-1');

      await expect(fs.readlink(skillLink)).resolves.toBe('../skills');
      await expect(fs.readFile(join(skillLink, 'SKILL.md'), 'utf8'))
        .resolves.toBe('# Restored skill');
      expect(containerManager.createContainer).toHaveBeenCalledOnce();
      expect(db.claimSandboxSessionRestore).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps a setup-blocked checkpoint CHECKPOINTED without creating or retrying a container', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'ctxmill-restore-symlink-conflict-'));
    try {
      const dataDir = join(tempDir, '.ctxmill');
      const baseWorkspaceDir = join(tempDir, 'base', 'workspace');
      await fs.mkdir(join(baseWorkspaceDir, 'skills'), { recursive: true });
      const agentDef = {
        ...createAgentDef(),
        workspaceDir: baseWorkspaceDir,
        harnessConfig: {
          setup: {
            symlinks: [{ src: 'skills', dest: '.claude/skills' }],
          },
        },
      } as AgentDefinition;

      const firstManager = createManager({ dataDir }).manager;
      const first = await firstManager.createFreshSession(
        'conv-1',
        agentDef,
        'agent-1',
      );
      const skillLink = join(first.sessionWorkspaceDir!, '.claude', 'skills');
      await fs.unlink(skillLink);
      await fs.writeFile(skillLink, 'user-owned');

      const { manager, containerManager, db } = createManager({ dataDir });
      (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>)
        .mockResolvedValue(createDbSession('CHECKPOINTED'));
      (db.getCheckpointV2 as ReturnType<typeof vi.fn>)
        .mockResolvedValue(createCheckpoint());

      await expect(
        manager.ensureSession('conv-1', agentDef, 'agent-1'),
      ).rejects.toThrow(/destination is not a symlink/i);

      expect(db.claimSandboxSessionRestore).toHaveBeenCalledOnce();
      expect(db.failSandboxSessionRestore).toHaveBeenCalledOnce();
      expect(db.failSandboxSessionRestore).toHaveBeenCalledWith(
        'sess-1',
        expect.anything(),
        {
          toStatus: 'CHECKPOINTED',
          error: expect.stringMatching(/destination is not a symlink/i),
        },
      );
      expect(containerManager.createContainer).not.toHaveBeenCalled();
      expect(containerManager.stopContainer).not.toHaveBeenCalled();
      expect(containerManager.removeContainer).not.toHaveBeenCalled();
      await expect(fs.readFile(skillLink, 'utf8')).resolves.toBe('user-owned');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prepares workspace content from a source checkout when no server dataDir is configured', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'ctxmill-direct-workspace-'));
    try {
      const projectDir = join(tempDir, 'project');
      const workspaceDir = join(tempDir, 'workspace');
      await fs.mkdir(join(projectDir, 'agent-source'), { recursive: true });
      await fs.writeFile(join(projectDir, 'agent-source', 'AGENTS.md'), '# Direct source');

      const { manager, containerManager } = createManager();
      const agentDef = {
        ...createAgentDef(),
        projectDir,
        workspaceDir,
        workspaceContent: {
          files: [{ src: 'agent-source/AGENTS.md', dest: 'AGENTS.md' }],
        },
      } as AgentDefinition;

      await manager.createFreshSession('conv-1', agentDef, 'agent-1');

      expect(containerManager.createContainer).toHaveBeenCalledWith(expect.objectContaining({
        workspaceDir,
      }));
      await expect(fs.readFile(join(workspaceDir, 'AGENTS.md'), 'utf8')).resolves.toBe('# Direct source');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('checkpoints and restores an unreachable ACTIVE session when a checkpoint exists', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-sandbox-sess-1'));

    connectMocks.createClientMock
      .mockReturnValueOnce(failingClient)
      .mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

    const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
    await vi.advanceTimersByTimeAsync(10_500);
    const session = await sessionPromise;

    expect(statusTransitions(db)).toEqual(['CHECKPOINTED']);
    expect(db.claimSandboxSessionLifecycleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxSessionId: 'sess-1',
        operation: 'reset',
        expectedActiveGeneration: {
          restoreFenceToken: 0,
          containerId: 'c-1',
        },
      }),
    );
    expect(
      (
        containerManager.removeContainer as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0],
    ).toBeLessThan(
      (
        db.completeSandboxSessionLifecycleOperation as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0]!,
    );
    expect(db.claimSandboxSessionRestore).toHaveBeenCalledOnce();
    expect(db.completeSandboxSessionRestore).toHaveBeenCalledOnce();
    expect(containerManager.createContainer).toHaveBeenCalledTimes(1);
    expect(grpcClient.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrap: {
          case: 'restore',
          value: expect.objectContaining({
            agentId: 'agent-1',
            harnessConfigJson: '{}',
            systemPrompt: 'test system prompt',
            nativeToolPolicy: expect.objectContaining({
              policy: 3,
              names: ['Bash'],
            }),
            sessionCheckpoint: expect.objectContaining({
              sessionId: 'sess-1',
              conversationId: 'conv-1',
              harnessName: 'langgraph',
            }),
          }),
        },
      }),
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(session).toEqual(expect.objectContaining({
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      containerId: 'c-2',
      containerName: 'ctxmill-sandbox-sess-2',
      status: 'ACTIVE',
    }));
    expect(manager.findSessionById('sess-1')).toBe(session);
  });

  it('fails closed and removes the newly-created container when workspace restore fails (retries exhausted)', async () => {
    vi.useFakeTimers();
    // Always fail the workspace restore so the retry loop exhausts its
    // budget and the session ends up in CHECKPOINTED with the container
    // cleaned up. Make `getSandboxSession` return a row reflecting the
    // post-failure attempts counter so the retry loop reads the latest state.
    const restoreSpy = vi
      .spyOn(WorkspaceDiffService.prototype, 'restore')
      .mockRejectedValue(new Error('workspace restore failed'));
    const { manager, containerManager, db, grpcClient } = createManager();
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-sandbox-sess-1'));

    connectMocks.createClientMock
      .mockReturnValueOnce(failingClient)
      .mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());
    const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
    const rejection = expect(sessionPromise).rejects.toThrow('workspace restore failed');
    // Advance past the retry backoff schedule (5s + 15s = 20s, plus container
    // wait latency). 70_000ms covers the full budget.
    await vi.advanceTimersByTimeAsync(70_000);
    await rejection;

    const transitions = statusTransitions(db);
    expect(transitions).toEqual(['CHECKPOINTED']);
    expect(db.claimSandboxSessionRestore).toHaveBeenCalledTimes(3);
    expect(db.failSandboxSessionRestore).toHaveBeenCalledTimes(3);
    expect(db.failSandboxSessionRestore).toHaveBeenLastCalledWith(
      'sess-1',
      expect.anything(),
      {
        toStatus: 'CHECKPOINTED',
        error: expect.stringContaining('workspace restore failed'),
      },
    );

    expect(containerManager.startContainer).toHaveBeenCalledWith('c-2');
    expect(containerManager.stopContainer).toHaveBeenCalledWith('c-2', 10);
    expect(containerManager.removeContainer).toHaveBeenCalledWith('c-2', true);
    expect(grpcClient.openSession).not.toHaveBeenCalled();
    expect(manager.findSessionById('sess-1')).toBeUndefined();

    restoreSpy.mockRestore();
  });

  it('reuses the persisted conversation workspace during checkpoint restore', async () => {
    vi.useFakeTimers();
    const restoreSpy = vi.spyOn(WorkspaceDiffService.prototype, 'restore');
    const { manager, containerManager, db, grpcClient } = createManager();
    vi.spyOn(manager, 'getExistingConversationWorkspaceDir').mockResolvedValue('/tmp/data/conversations/conv-1/workspace');
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-sandbox-sess-1'));

    connectMocks.createClientMock
      .mockReturnValueOnce(failingClient)
      .mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

    const sessionPromise = manager.ensureSession('conv-1', createWorkspaceAgentDef(), 'agent-1');
    await vi.advanceTimersByTimeAsync(10_500);
    const session = await sessionPromise;

    expect(containerManager.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      workspaceDir: expect.stringContaining('/conversations/conv-1/workspace'),
    }));
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(session.sessionWorkspaceDir).toMatch(/\/conversations\/conv-1\/workspace$/);
  });

  it('fails checkpoint restore when a conversation workspace was expected but is missing', async () => {
    vi.useFakeTimers();
    const restoreSpy = vi.spyOn(WorkspaceDiffService.prototype, 'restore');
    const { manager, containerManager, db, grpcClient } = createManager();
    vi.spyOn(manager, 'getExistingConversationWorkspaceDir').mockResolvedValue(undefined);
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-sandbox-sess-1'));

    connectMocks.createClientMock
      .mockReturnValueOnce(failingClient)
      .mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(createCheckpoint());

    const sessionPromise = manager.ensureSession('conv-1', createWorkspaceAgentDef(), 'agent-1');
    const rejection = expect(sessionPromise).rejects.toThrow(/missing persisted conversation workspace/i);
    await vi.advanceTimersByTimeAsync(10_500);
    await rejection;

    expect(containerManager.createContainer).not.toHaveBeenCalled();
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(statusTransitions(db)).toEqual(['CHECKPOINTED']);
    expect(db.claimSandboxSessionRestore).toHaveBeenCalledOnce();
    expect(db.failSandboxSessionRestore).toHaveBeenCalledWith(
      'sess-1',
      expect.anything(),
      {
        toStatus: 'TERMINATED',
        error: expect.stringContaining('Missing persisted conversation workspace'),
      },
    );
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
    expect(db.createSandboxSession).not.toHaveBeenCalled();
    expect(statusTransitions(db)).toEqual([]);
    expect(db.claimSandboxSessionRestore).toHaveBeenCalledOnce();
    expect(db.failSandboxSessionRestore).toHaveBeenCalledWith(
      'sess-1',
      expect.anything(),
      {
        toStatus: 'TERMINATED',
        error: expect.stringContaining('No checkpoint found'),
      },
    );
  });

  it('removes an abandoned restore runtime before creating the next generation container', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();
    (
      containerManager.getContainer as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      containerId: 'abandoned-container',
      containerName: 'ctxmill-sandbox-abandoned',
    });
    connectMocks.createClientMock.mockReturnValue(grpcClient);
    (
      db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>
    ).mockResolvedValue(createDbSession('CHECKPOINTED'));
    (
      db.getCheckpointV2 as ReturnType<typeof vi.fn>
    ).mockResolvedValue(createCheckpoint());

    const restorePromise = manager.ensureSession(
      'conv-1',
      createAgentDef(),
      'agent-1',
    );
    await vi.advanceTimersByTimeAsync(10_500);
    const restored = await restorePromise;

    expect(containerManager.stopContainer).toHaveBeenCalledWith(
      'abandoned-container',
      10,
    );
    expect(containerManager.removeContainer).toHaveBeenCalledWith(
      'abandoned-container',
      true,
    );
    expect(
      (
        containerManager.removeContainer as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0],
    ).toBeLessThan(
      (
        containerManager.createContainer as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0]!,
    );
    expect(restored).toEqual(expect.objectContaining({
      sessionId: 'sess-1',
      status: 'ACTIVE',
      containerId: 'c-2',
    }));
  });

  it('preserves and reconnects a runtime when restore completion committed but its response was lost', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();
    let committedRow: SandboxSessionRow | undefined;
    (
      db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>
    ).mockResolvedValue(createDbSession('CHECKPOINTED'));
    (
      db.getCheckpointV2 as ReturnType<typeof vi.fn>
    ).mockResolvedValue(createCheckpoint());
    (
      db.completeSandboxSessionRestore as ReturnType<typeof vi.fn>
    ).mockImplementation(async (
      _sessionId,
      _fence,
      runtime: { containerName: string; containerId: string },
    ) => {
      committedRow = createDbSession('ACTIVE', {
        containerName: runtime.containerName,
        containerId: runtime.containerId,
        restoreFenceToken: 1,
      });
      throw new Error('database response lost after commit');
    });
    (
      db.failSandboxSessionRestore as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);
    (
      db.getSandboxSession as ReturnType<typeof vi.fn>
    ).mockImplementation(async () =>
      committedRow ?? createDbSession('RESTORING', {
        restoreOwnerId: 'restore-owner',
        restoreFenceToken: 1,
      })
    );
    connectMocks.createClientMock.mockReturnValue(grpcClient);

    const restoredPromise = manager.ensureSession(
      'conv-1',
      createAgentDef(),
      'agent-1',
    );
    await vi.advanceTimersByTimeAsync(10_500);
    const restored = await restoredPromise;

    expect(restored).toEqual(expect.objectContaining({
      sessionId: 'sess-1',
      status: 'ACTIVE',
      containerId: 'c-2',
    }));
    expect(containerManager.stopContainer).not.toHaveBeenCalledWith('c-2', 10);
    expect(containerManager.removeContainer).not.toHaveBeenCalledWith(
      'c-2',
      true,
    );
    expect(
      db.getSandboxSession as ReturnType<typeof vi.fn>
    ).toHaveBeenCalled();
  });

  it('does not create a fresh session after a terminal restore failure commit response is lost', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();
    let terminatedRow: SandboxSessionRow | undefined;
    (
      db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>
    ).mockResolvedValue(createDbSession('CHECKPOINTED'));
    (
      db.getCheckpointV2 as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    (
      db.failSandboxSessionRestore as ReturnType<typeof vi.fn>
    ).mockImplementation(async (_sessionId, _fence, failure) => {
      terminatedRow = createDbSession(failure.toStatus, {
        restoreFenceToken: 1,
        restoreAttempts: 1,
        lastRestoreError: failure.error,
      });
      throw new Error('database response lost after terminal failure commit');
    });
    (
      db.getSandboxSession as ReturnType<typeof vi.fn>
    ).mockImplementation(async () =>
      terminatedRow ?? createDbSession('RESTORING', {
        restoreOwnerId: 'restore-owner',
        restoreFenceToken: 1,
        restoreAttempts: 1,
      })
    );
    connectMocks.createClientMock.mockReturnValue(grpcClient);

    const restorePromise = manager.ensureSession(
      'conv-1',
      createAgentDef(),
      'agent-1',
    );
    const rejection = expect(restorePromise).rejects.toThrow(
      'No checkpoint found for session sess-1',
    );
    await vi.advanceTimersByTimeAsync(10_500);
    await rejection;

    expect(terminatedRow?.status).toBe('TERMINATED');
    expect(db.createSandboxSession).not.toHaveBeenCalled();
    expect(containerManager.createContainer).not.toHaveBeenCalled();
  });

  it('evicts an unreachable ACTIVE session with no checkpoint by creating a fresh replacement session', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-sandbox-sess-1'));

    connectMocks.createClientMock
      .mockReturnValueOnce(failingClient)
      .mockReturnValue(grpcClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>).mockResolvedValue(createDbSession('ACTIVE'));
    (db.getCheckpointV2 as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const sessionPromise = manager.ensureSession('conv-1', createAgentDef(), 'agent-1');
    await vi.advanceTimersByTimeAsync(10_500);
    const session = await sessionPromise;

    expect(statusTransitions(db)).toEqual(['TERMINATED']);
    expect(db.claimSandboxSessionLifecycleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxSessionId: 'sess-1',
        operation: 'reset',
      }),
    );
    expect(db.completeSandboxSessionLifecycleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxSessionId: 'sess-1',
        fromStatus: 'ACTIVE',
        toStatus: 'TERMINATED',
        extra: expect.objectContaining({
          containerId: null,
          containerName: null,
          lastRestoreError: expect.stringContaining('reconnect failed'),
        }),
      }),
    );
    const demotionOrder = (
      db.completeSandboxSessionLifecycleOperation as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    const replacementOrder = (
      db.createSandboxSession as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    expect(demotionOrder).toBeLessThan(replacementOrder!);
    expect(containerManager.stopContainer).toHaveBeenCalledWith('c-1', 10);
    expect(containerManager.removeContainer).toHaveBeenCalledWith('c-1', true);
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
    expect(session.containerName).toBe('ctxmill-sandbox-sess-2');
    expect(session.status).toBe('ACTIVE');
  });

  it('fails closed without creating a replacement when dead-session lifecycle ownership is unavailable', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db } = createManager();
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND ctxmill-sandbox-sess-1'),
    );

    connectMocks.createClientMock.mockReturnValue(failingClient);
    (db.getSandboxSessionByConversation as ReturnType<typeof vi.fn>)
      .mockResolvedValue(createDbSession('ACTIVE'));
    (db.claimSandboxSessionLifecycleOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);

    const sessionPromise = manager.ensureSession(
      'conv-1',
      createAgentDef(),
      'agent-1',
    );
    const rejection = expect(sessionPromise).rejects.toThrow(
      /recovery ownership.*sess-1/i,
    );
    await vi.advanceTimersByTimeAsync(10_500);
    await rejection;

    expect(db.completeSandboxSessionLifecycleOperation).not.toHaveBeenCalled();
    expect(db.createSandboxSession).not.toHaveBeenCalled();
    expect(containerManager.createContainer).not.toHaveBeenCalled();
    expect(containerManager.stopContainer).not.toHaveBeenCalled();
    expect(containerManager.removeContainer).not.toHaveBeenCalled();
  });

  it('restores once and then serves the same session from the in-memory cache', async () => {
    vi.useFakeTimers();
    const { manager, containerManager, db, grpcClient } = createManager();
    const failingClient = createMockGrpcClient();
    failingClient.killSession.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ctxmill-sandbox-sess-1'));

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
    expect(statusTransitions(db)).toEqual(['CHECKPOINTED']);
    expect(db.claimSandboxSessionRestore).toHaveBeenCalledOnce();
    expect(db.completeSandboxSessionRestore).toHaveBeenCalledOnce();
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
          containerName: 'ctxmill-sandbox-sess-locked',
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
