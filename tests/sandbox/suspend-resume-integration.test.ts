import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ExecutionPhaseTracker } from '../../packages/ctxmill/src/sandbox/execution-phase.js';
import {
  serializeCheckpoint,
  deserializeCheckpoint,
  validateCheckpointSize,
  SessionStateCollector,
  type SessionCheckpoint,
  type WorkspaceRef,
} from '../../packages/ctxmill/src/sandbox/checkpoint.js';
import {
  sessionCheckpointToProto,
  protoSessionCheckpointToInternal,
} from '../../packages/ctxmill/src/sandbox/proto-convert.js';
import type { ContainerManager } from '../../packages/ctxmill/src/sandbox/container-manager.js';
import type { HarnessExportedState } from '../../packages/ctxmill/src/harness/types.js';

type ProtoCompatibleCheckpoint = Parameters<typeof sessionCheckpointToProto>[0];

type StoredToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type StoredMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: StoredToolCall[];
  toolCallId?: string;
};

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
};

const WORKSPACE_TAR: WorkspaceRef = {
  strategy: 'tar',
  reference: 'data/checkpoints/run-suspend-1/workspace.tar.gz',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function makeMessage(overrides?: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'Hello world',
    ...overrides,
  };
}

function makeToolCall(overrides?: Partial<StoredToolCall>): StoredToolCall {
  return {
    id: 'tc-1',
    name: 'read_file',
    arguments: { path: '/tmp/test.txt' },
    ...overrides,
  };
}

function makeHarnessState(payload?: Record<string, unknown>): HarnessExportedState {
  return {
    stateVersion: '1',
    payload: payload ?? {},
  };
}

function createTestCheckpointState(overrides?: Partial<SessionCheckpoint>): SessionCheckpoint {
  return {
    checkpointVersion: 2,
    sessionId: 'run-suspend-1',
    conversationId: 'conv-1',
    harnessName: 'langgraph',
    cursor: {
      nextMessageSeq: 2,
      lastCompletedTurnId: 'turn-1',
    },
    runnerState: {
      status: 'IDLE',
    },
    workspaceRef: WORKSPACE_TAR,
    harnessState: makeHarnessState({
      messages: [
        { id: 'msg-1', role: 'user', content: 'What is 2+2?' },
        { id: 'msg-2', role: 'assistant', content: 'Let me calculate that for you.' },
      ],
      accumulatedText: 'Let me calculate that for you.',
      tokenUsage: {
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
      },
    }),
    ...overrides,
  };
}

function getHarnessPayload(state: HarnessExportedState | Record<string, unknown>): Record<string, unknown> {
  if ('payload' in state && isRecord(state.payload)) {
    return state.payload;
  }

  throw new Error('Expected harnessState payload to be an object');
}

function toProtoCompatibleCheckpoint(checkpoint: SessionCheckpoint): ProtoCompatibleCheckpoint {
  return {
    checkpointVersion: checkpoint.checkpointVersion,
    sessionId: checkpoint.sessionId,
    conversationId: checkpoint.conversationId,
    harnessName: checkpoint.harnessName,
    cursor: {
      nextMessageSeq: checkpoint.cursor.nextMessageSeq,
      lastCompletedTurnId: checkpoint.cursor.lastCompletedTurnId,
    },
    runnerState: {
      status: checkpoint.runnerState.status,
      pendingRequests: (checkpoint.runnerState.pendingRequests ?? []).map((pending) => ({
        type: pending.type,
        id: pending.id,
        payloadJson: JSON.stringify(pending.payload),
      })),
    },
    workspaceRef: {
      strategy: checkpoint.workspaceRef.strategy,
      reference: checkpoint.workspaceRef.reference,
    },
    harnessState: {
      stateVersion: checkpoint.harnessState.stateVersion,
      payload: checkpoint.harnessState.payload,
    },
  };
}

function fromProtoCompatibleCheckpoint(checkpoint: ProtoCompatibleCheckpoint): SessionCheckpoint {
  const workspaceStrategy =
    checkpoint.workspaceRef.strategy === 'git' || checkpoint.workspaceRef.strategy === 'none'
      ? checkpoint.workspaceRef.strategy
      : 'tar';

  const harnessStateRecord = checkpoint.harnessState;
  const stateVersion =
    typeof harnessStateRecord.stateVersion === 'string' ? harnessStateRecord.stateVersion : '1';
  const payload = getHarnessPayload(harnessStateRecord);
  const pendingRequests: NonNullable<SessionCheckpoint['runnerState']['pendingRequests']> = checkpoint.runnerState.pendingRequests.map((pending) => ({
    type: pending.type === 'approval' ? 'approval' : 'tool_call',
    id: pending.id,
    payload: JSON.parse(pending.payloadJson) as Record<string, unknown>,
  }));

  return {
    checkpointVersion: 2,
    sessionId: checkpoint.sessionId,
    conversationId: checkpoint.conversationId,
    harnessName: checkpoint.harnessName,
    cursor: {
      nextMessageSeq: checkpoint.cursor.nextMessageSeq,
      lastCompletedTurnId: checkpoint.cursor.lastCompletedTurnId,
    },
    runnerState: {
      status: checkpoint.runnerState.status === 'WAITING_INPUT' ? 'WAITING_INPUT' : 'IDLE',
      pendingRequests: pendingRequests.length > 0 ? pendingRequests : undefined,
    },
    workspaceRef: {
      strategy: workspaceStrategy,
      reference: checkpoint.workspaceRef.reference,
    },
    harnessState: {
      stateVersion,
      payload,
    },
  };
}

function roundTripProto(checkpoint: SessionCheckpoint): SessionCheckpoint {
  const proto = sessionCheckpointToProto(toProtoCompatibleCheckpoint(checkpoint));
  return fromProtoCompatibleCheckpoint(protoSessionCheckpointToInternal(proto));
}

function createCheckpointFromCollector(options: {
  collector: SessionStateCollector;
  sessionId: string;
  conversationId: string;
  harnessName: string;
  payload?: Record<string, unknown>;
  workspaceRef?: WorkspaceRef;
}): SessionCheckpoint {
  return options.collector.getCheckpointSnapshot(
    options.sessionId,
    options.conversationId,
    options.harnessName,
    makeHarnessState(options.payload),
    options.workspaceRef ?? WORKSPACE_TAR,
  );
}

function createMockContainerManager(): ContainerManager {
  return {
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    stopContainer: vi.fn(),
    removeContainer: vi.fn(),
    extractContainerDiff: vi.fn(),
    extractWorkspaceDiff: vi.fn(),
    extractLogs: vi.fn(),
    getContainer: vi.fn(),
    listManagedContainers: vi.fn(),
    getContainerExitCode: vi.fn(),
    ensureNetwork: vi.fn(),
  } as unknown as ContainerManager;
}

describe('Suspend at after_llm phase', () => {
  it('phase tracker accepts immediately, checkpoint contains messages and text', async () => {
    const tracker = new ExecutionPhaseTracker();
    const collector = new SessionStateCollector();

    collector.startTurn('turn-1');
    collector.processTurnEvent({
      type: 'message_committed',
      role: 'user',
      content: 'Tell me about TypeScript',
      turnId: 'turn-1',
      messageSeq: 0,
    });
    tracker.setPhase('after_llm');

    await tracker.requestSuspend();
    expect(tracker.isSuspendRequested()).toBe(true);
    expect(tracker.isSuspendSafe()).toBe(true);

    const checkpoint = createCheckpointFromCollector({
      collector,
      sessionId: 'run-1',
      conversationId: 'conv-1',
      harnessName: 'langgraph',
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-1/workspace.tar.gz' },
      payload: {
        messages: [makeMessage({ id: 'msg-1', content: 'Tell me about TypeScript' })],
        accumulatedText: 'TypeScript is great!',
      },
    });

    const payload = getHarnessPayload(checkpoint.harnessState);
    expect(Array.isArray(payload.messages)).toBe(true);
    expect((payload.messages as StoredMessage[])).toHaveLength(1);
    expect((payload.messages as StoredMessage[])[0].content).toBe('Tell me about TypeScript');
    expect(payload.accumulatedText).toBe('TypeScript is great!');
    expect(checkpoint.checkpointVersion).toBe(2);
    expect(checkpoint.cursor.nextMessageSeq).toBe(1);
    expect(checkpoint.runnerState.status).toBe('IDLE');
  });

  it('checkpoint can be serialized, stored in mock DB, and deserialized back', async () => {
    const tracker = new ExecutionPhaseTracker();
    tracker.setPhase('after_llm');

    const collector = new SessionStateCollector();
    collector.startTurn('turn-db');
    collector.processTurnEvent({
      type: 'message_committed',
      role: 'user',
      content: 'Hello',
      turnId: 'turn-db',
      messageSeq: 0,
    });

    await tracker.requestSuspend();

    const checkpoint = createCheckpointFromCollector({
      collector,
      sessionId: 'run-db',
      conversationId: 'conv-db',
      harnessName: 'pi-agent',
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-db/workspace.tar.gz' },
      payload: {
        messages: [makeMessage({ id: 'msg-1', content: 'Hello' })],
        accumulatedText: 'World',
      },
    });

    const json = serializeCheckpoint(checkpoint);
    const dbRow = { checkpointData: JSON.parse(json) };
    const retrieved = deserializeCheckpoint(JSON.stringify(dbRow.checkpointData));
    const payload = getHarnessPayload(retrieved.harnessState);

    expect(retrieved.sessionId).toBe('run-db');
    expect(retrieved.harnessName).toBe('pi-agent');
    expect(payload.accumulatedText).toBe('World');
    expect(retrieved.cursor.lastCompletedTurnId).toBe('turn-db');
  });
});

describe('Suspend at hitl_wait phase', () => {
  it('creates checkpoint containing the pending interrupt ID', async () => {
    const tracker = new ExecutionPhaseTracker();
    const collector = new SessionStateCollector();

    collector.startTurn('turn-hitl');
    collector.processTurnEvent({
      type: 'message_committed',
      role: 'user',
      content: 'Run dangerous command',
      turnId: 'turn-hitl',
      messageSeq: 0,
    });
    collector.processTurnEvent({
      type: 'approval_needed',
      id: 'int-42',
      tool: 'bash',
      args: { command: 'rm -rf /' },
    });
    tracker.setPhase('hitl_wait');

    await tracker.requestSuspend();
    expect(tracker.isSuspendSafe()).toBe(true);

    const checkpoint = createCheckpointFromCollector({
      collector,
      sessionId: 'run-hitl',
      conversationId: 'conv-hitl',
      harnessName: 'claude-agents',
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-hitl/workspace.tar.gz' },
      payload: {
        messages: [makeMessage({ id: 'msg-1', content: 'Run dangerous command' })],
      },
    });

    expect(checkpoint.runnerState.status).toBe('WAITING_INPUT');
    expect(checkpoint.runnerState.pendingRequests).toHaveLength(1);
    expect(checkpoint.runnerState.pendingRequests?.[0].id).toBe('int-42');
    expect(checkpoint.runnerState.pendingRequests?.[0].type).toBe('approval');
  });
});

describe('Suspend at after_tool phase', () => {
  it('checkpoint has empty pendingToolCalls and incremented loopIteration', async () => {
    const tracker = new ExecutionPhaseTracker();
    const collector = new SessionStateCollector();

    collector.startTurn('turn-tool');
    collector.processTurnEvent({
      type: 'message_committed',
      role: 'user',
      content: 'Read the file',
      turnId: 'turn-tool',
      messageSeq: 0,
    });
    collector.processTurnEvent({
      type: 'tool_call_start',
      id: 'tc-1',
      name: 'read_file',
      args: { path: '/tmp/test' },
    });
    collector.processTurnEvent({
      type: 'tool_call_end',
      id: 'tc-1',
      result: 'file contents here',
      durationMs: 50,
    });
    tracker.setPhase('after_tool');

    await tracker.requestSuspend();
    expect(tracker.isSuspendSafe()).toBe(true);

    const checkpoint = createCheckpointFromCollector({
      collector,
      sessionId: 'run-tool',
      conversationId: 'conv-tool',
      harnessName: 'pi-agent',
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-tool/workspace.tar.gz' },
      payload: {
        messages: [makeMessage({ id: 'msg-1', content: 'Read the file' })],
      },
    });

    expect(checkpoint.runnerState.pendingRequests).toBeUndefined();
    expect(checkpoint.runnerState.status).toBe('IDLE');
    expect(checkpoint.cursor.nextMessageSeq).toBe(1);
    expect(checkpoint.cursor.lastCompletedTurnId).toBe('turn-tool');
  });
});

describe('Suspend at unsafe phase (queued)', () => {
  it('queues suspend during llm_call_in_flight and resolves when transitioning to after_llm', async () => {
    const tracker = new ExecutionPhaseTracker();
    tracker.setPhase('llm_call_in_flight');

    let resolved = false;
    const suspendPromise = tracker.requestSuspend().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(tracker.isSuspendRequested()).toBe(true);

    tracker.setPhase('after_llm');

    await suspendPromise;
    expect(resolved).toBe(true);

    const collector = new SessionStateCollector();
    collector.startTurn('turn-queued');
    collector.processTurnEvent({
      type: 'message_committed',
      role: 'user',
      content: 'Compute something',
      turnId: 'turn-queued',
      messageSeq: 0,
    });

    const checkpoint = createCheckpointFromCollector({
      collector,
      sessionId: 'run-queued',
      conversationId: 'conv-queued',
      harnessName: 'pi-agent',
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-queued/workspace.tar.gz' },
      payload: {
        messages: [makeMessage({ id: 'msg-1', content: 'Compute something' })],
        accumulatedText: 'Computing...',
      },
    });

    expect(tracker.getPhase()).toBe('after_llm');
    expect(getHarnessPayload(checkpoint.harnessState).accumulatedText).toBe('Computing...');
  });

  it('queues suspend during tool_execution and resolves at after_tool', async () => {
    const tracker = new ExecutionPhaseTracker();
    tracker.setPhase('tool_execution');

    let resolved = false;
    const suspendPromise = tracker.requestSuspend().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    tracker.setPhase('before_tool');
    await Promise.resolve();
    expect(resolved).toBe(false);

    tracker.setPhase('tool_execution');
    await Promise.resolve();
    expect(resolved).toBe(false);

    tracker.setPhase('after_tool');
    await suspendPromise;
    expect(resolved).toBe(true);
  });
});

describe('Resume from checkpoint (component-level)', () => {
  it('checkpoint messages and state are correctly loaded for resume', () => {
    const checkpoint = createTestCheckpointState({
      harnessName: 'langgraph',
      harnessState: makeHarnessState({
        messages: [
          { id: 'msg-1', role: 'user', content: 'Turn 1' },
          { id: 'msg-2', role: 'assistant', content: 'Response 1' },
          { id: 'msg-3', role: 'user', content: 'Turn 2' },
          { id: 'msg-4', role: 'assistant', content: 'Response 2' },
          { id: 'msg-5', role: 'user', content: 'Turn 3' },
        ],
        tokenUsage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      }),
    });

    const json = serializeCheckpoint(checkpoint);
    const retrieved = deserializeCheckpoint(json);
    const payload = getHarnessPayload(retrieved.harnessState);
    const messages = payload.messages as StoredMessage[];
    const tokenUsage = payload.tokenUsage as TokenUsage;

    expect(messages).toHaveLength(5);
    expect(messages[0].content).toBe('Turn 1');
    expect(messages[4].content).toBe('Turn 3');
    expect(retrieved.harnessName).toBe('langgraph');
    expect(tokenUsage.inputTokens).toBe(200);
    expect(tokenUsage.outputTokens).toBe(100);
    expect(tokenUsage.totalTokens).toBe(300);

    const protoRoundTrip = roundTripProto(retrieved);
    const roundTripPayload = getHarnessPayload(protoRoundTrip.harnessState);
    expect(protoRoundTrip.harnessName).toBe('langgraph');
    expect((roundTripPayload.messages as StoredMessage[])).toHaveLength(5);
    expect(roundTripPayload.tokenUsage).toMatchObject({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    });
  });

  it('workspace ref is preserved through checkpoint round-trip', () => {
    const checkpoint = createTestCheckpointState({
      workspaceRef: {
        strategy: 'tar',
        reference: 'data/checkpoints/run-42/workspace.tar.gz',
      },
    });

    const json = serializeCheckpoint(checkpoint);
    const restored = deserializeCheckpoint(json);

    expect(restored.workspaceRef.reference).toBe('data/checkpoints/run-42/workspace.tar.gz');
    expect(restored.workspaceRef.strategy).toBe('tar');
  });
});

describe('Resume with rotated API key', () => {
  it('checkpoint has no secret fields at any point', () => {
    const checkpoint = createTestCheckpointState();
    const checkpointKeys = Object.keys(checkpoint);

    expect(checkpointKeys).not.toContain('secrets');
    expect(checkpointKeys).not.toContain('apiKey');
    expect(checkpointKeys).not.toContain('resolvedSecrets');
    expect(checkpointKeys).not.toContain('apiKeys');
    expect(checkpointKeys).not.toContain('envSecrets');

    const json = serializeCheckpoint(checkpoint);
    expect(json).not.toContain('sk-');
    expect(json).not.toContain('sk_');
    expect(json).not.toContain('API_KEY');

    const proto = sessionCheckpointToProto(toProtoCompatibleCheckpoint(checkpoint));
    const protoJson = JSON.stringify(proto, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    expect(protoJson).not.toContain('sk-');
    expect(protoJson).not.toContain('sk_');
    expect(protoJson).not.toContain('API_KEY');
  });

  it('tokenUsage is a metric field, not a secret', () => {
    const checkpoint = createTestCheckpointState();
    const payload = getHarnessPayload(checkpoint.harnessState);
    const tokenUsage = payload.tokenUsage as TokenUsage;

    expect(tokenUsage).toBeDefined();
    expect(typeof tokenUsage.inputTokens).toBe('number');
    expect(typeof tokenUsage.outputTokens).toBe('number');
    expect(typeof tokenUsage.totalTokens).toBe('number');
  });
});

describe('Resume with unavailable secret', () => {
  it('checkpoint deserialization succeeds regardless of secret availability', () => {
    const checkpoint = createTestCheckpointState();
    const json = serializeCheckpoint(checkpoint);
    const restored = deserializeCheckpoint(json);

    expect(restored.sessionId).toBe(checkpoint.sessionId);
    expect(restored.harnessName).toBe(checkpoint.harnessName);
  });

  it('checkpoint proto conversion does not require any secrets', () => {
    const checkpoint = createTestCheckpointState();
    const restored = roundTripProto(checkpoint);

    expect(restored.sessionId).toBe(checkpoint.sessionId);
    expect(restored.harnessName).toBe(checkpoint.harnessName);
  });
});

describe('Checkpoint size limits', () => {
  it('rejects checkpoint > 5 MB with error', () => {
    const hugeContent = 'x'.repeat(5.5 * 1024 * 1024);
    const largeCheckpoint = createTestCheckpointState({
      sessionId: 'run-large',
      conversationId: 'conv-large',
      harnessState: makeHarnessState({ blob: hugeContent }),
    });

    const json = serializeCheckpoint(largeCheckpoint);
    const result = validateCheckpointSize(json);

    expect(result.ok).toBe(false);
    expect(result.sizeBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('5 MB');
  });

  it('allows checkpoint under 5 MB', () => {
    const checkpoint = createTestCheckpointState({
      sessionId: 'run-ok',
      conversationId: 'conv-ok',
      harnessState: makeHarnessState({ accumulatedText: 'small text' }),
    });

    const json = serializeCheckpoint(checkpoint);
    const result = validateCheckpointSize(json);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('warns for checkpoint > 1 MB but still passes', () => {
    const mediumContent = 'y'.repeat(1.5 * 1024 * 1024);
    const medCheckpoint = createTestCheckpointState({
      sessionId: 'run-med',
      conversationId: 'conv-med',
      harnessState: makeHarnessState({ blob: mediumContent }),
    });

    const json = serializeCheckpoint(medCheckpoint);
    const result = validateCheckpointSize(json);

    expect(result.ok).toBe(true);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain('warning threshold');
  });
});

describe('Workspace diff size limits', () => {
  it('rejects workspace diff > 100 MB with workspace_diff_too_large', async () => {
    const { WorkspaceDiffService } = await import(
      '../../packages/ctxmill/src/sandbox/workspace-diff.js'
    );
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-size-test-'));

    try {
      const mockCm = {
        extractWorkspaceDiff: vi.fn(async () => ({ archive: Buffer.alloc(101 * 1024 * 1024, 'x'), deletedPaths: [] })),
      } as unknown as ContainerManager;

      const wds = new WorkspaceDiffService({
        containerManager: mockCm,
        checkpointDir: tmpDir,
      });

      await expect(wds.capture('run-ws-large', 'container-ws')).rejects.toMatchObject({
        code: 'workspace_diff_too_large',
        message: expect.stringContaining('100 MB'),
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts workspace diff under 100 MB', async () => {
    const { WorkspaceDiffService } = await import(
      '../../packages/ctxmill/src/sandbox/workspace-diff.js'
    );
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ok-test-'));

    try {
      const mockCm = {
        extractWorkspaceDiff: vi.fn(async () => ({ archive: Buffer.from('small-workspace-data'), deletedPaths: [] })),
      } as unknown as ContainerManager;

      const wds = new WorkspaceDiffService({
        containerManager: mockCm,
        checkpointDir: tmpDir,
      });

      const result = await wds.capture('run-ws-ok', 'container-ok');
      expect(result).not.toBe('none');

      const expectedPath = path.join(tmpDir, 'run-ws-ok', 'workspace.tar.gz');
      const stat = await fs.stat(expectedPath);
      expect(stat.size).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Checkpoint round-trip fidelity', () => {
  it('serialize -> store -> retrieve -> deserialize preserves all fields', () => {
    const complexCheckpoint = createTestCheckpointState({
      sessionId: 'run-roundtrip',
      conversationId: 'conv-roundtrip',
      harnessName: 'claude-agents',
      cursor: { nextMessageSeq: 6, lastCompletedTurnId: 'turn-4' },
      runnerState: {
        status: 'WAITING_INPUT',
        pendingRequests: [
          {
            type: 'tool_call',
            id: 'tc-pending',
            payload: { name: 'write_file', args: { path: '/tmp/out', content: 'hello' } },
          },
          {
            type: 'approval',
            id: 'int-99',
            payload: { tool: 'bash', args: { command: 'rm -rf /' } },
          },
        ],
      },
      harnessState: makeHarnessState({
        messages: [
          makeMessage({ id: 'msg-1', role: 'user', content: 'First question' }),
          makeMessage({
            id: 'msg-2',
            role: 'assistant',
            content: 'Let me search.',
            toolCalls: [makeToolCall({ id: 'tc-1', name: 'search', arguments: { query: 'TypeScript' } })],
          }),
          makeMessage({ id: 'msg-3', role: 'tool', content: 'TypeScript docs', toolCallId: 'tc-1' }),
          makeMessage({ id: 'msg-4', role: 'assistant', content: 'Here is the answer.' }),
          makeMessage({ id: 'msg-5', role: 'user', content: 'Follow-up question' }),
          makeMessage({
            id: 'msg-6',
            role: 'assistant',
            content: '',
            toolCalls: [
              makeToolCall({ id: 'tc-2', name: 'bash', arguments: { command: 'ls -la' } }),
              makeToolCall({ id: 'tc-3', name: 'read_file', arguments: { path: '/etc/hosts' } }),
            ],
          }),
        ],
        accumulatedText: 'Here is the answer.',
        tokenUsage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, cost: 0.007 },
      }),
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-roundtrip/workspace.tar.gz' },
    });

    const json = serializeCheckpoint(complexCheckpoint);
    const dbRow = JSON.parse(json);
    const restored = deserializeCheckpoint(JSON.stringify(dbRow));

    expect(restored).toEqual(complexCheckpoint);
  });

  it('serialize -> proto -> back preserves all fields', () => {
    const checkpoint = createTestCheckpointState({
      sessionId: 'run-proto-rt',
      conversationId: 'conv-proto-rt',
      harnessName: 'claude-agents',
      cursor: { nextMessageSeq: 2, lastCompletedTurnId: 'turn-proto' },
      runnerState: {
        status: 'WAITING_INPUT',
        pendingRequests: [
          {
            type: 'approval',
            id: 'int-proto-1',
            payload: { tool: 'bash', args: { cmd: 'ls' } },
          },
        ],
      },
      harnessState: makeHarnessState({
        messages: [
          makeMessage({ id: 'm1', role: 'user', content: 'Hello' }),
          makeMessage({
            id: 'm2',
            role: 'assistant',
            content: 'Response',
            toolCalls: [makeToolCall({ id: 'tc-1', name: 'bash', arguments: { cmd: 'ls' } })],
          }),
        ],
        accumulatedText: 'Response',
        tokenUsage: { inputTokens: 300, outputTokens: 150, totalTokens: 450, cost: 0.005 },
      }),
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-proto-rt/workspace.tar.gz' },
    });

    const restored = roundTripProto(checkpoint);

    expect(restored).toEqual(checkpoint);
  });

  it('JSON -> proto -> JSON -> deserialize preserves complex state', () => {
    const checkpoint = createTestCheckpointState({
      sessionId: 'run-full-rt',
      conversationId: 'conv-full-rt',
      harnessName: 'pi-agent',
      cursor: { nextMessageSeq: 3, lastCompletedTurnId: 'turn-full' },
      runnerState: {
        status: 'WAITING_INPUT',
        pendingRequests: [
          {
            type: 'tool_call',
            id: 'tc-b',
            payload: { name: 'create_chart', args: { type: 'bar', data: [1, 2, 3] } },
          },
        ],
      },
      harnessState: makeHarnessState({
        messages: [
          makeMessage({ id: 'm1', role: 'user', content: 'Build a chart' }),
          makeMessage({
            id: 'm2',
            role: 'assistant',
            content: 'I will run some tools',
            toolCalls: [
              makeToolCall({ id: 'tc-a', name: 'query_db', arguments: { sql: 'SELECT * FROM metrics' } }),
            ],
          }),
          makeMessage({ id: 'm3', role: 'tool', content: '{"rows": [1,2,3]}', toolCallId: 'tc-a' }),
        ],
        accumulatedText: 'I will run some tools',
        tokenUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.015 },
      }),
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-full-rt/workspace.tar.gz' },
    });

    const json1 = serializeCheckpoint(checkpoint);
    const fromJson = deserializeCheckpoint(json1);
    const fromProto = roundTripProto(fromJson);
    const json2 = serializeCheckpoint(fromProto);
    const final = deserializeCheckpoint(json2);
    const payload = getHarnessPayload(final.harnessState);
    const messages = payload.messages as StoredMessage[];
    const tokenUsage = payload.tokenUsage as TokenUsage;

    expect(final.sessionId).toBe('run-full-rt');
    expect(messages).toHaveLength(3);
    expect(messages[1].toolCalls).toHaveLength(1);
    expect(messages[1].toolCalls?.[0].name).toBe('query_db');
    expect(final.runnerState.pendingRequests).toHaveLength(1);
    expect(final.runnerState.pendingRequests?.[0].id).toBe('tc-b');
    expect(tokenUsage.cost).toBe(0.015);
    expect(final.cursor.nextMessageSeq).toBe(3);
  });
});

describe('Resume after orchestrator restart (component-level)', () => {
  it('checkpoint loaded from DB by new service instances works correctly', () => {
    const storedCheckpoint = createTestCheckpointState({
      cursor: { nextMessageSeq: 3, lastCompletedTurnId: 'turn-2' },
      harnessState: makeHarnessState({
        messages: [
          { id: 'msg-1', role: 'user', content: 'Before restart' },
          { id: 'msg-2', role: 'assistant', content: 'Processing...' },
          { id: 'msg-3', role: 'user', content: 'Continue please' },
        ],
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    });

    const dbJson = serializeCheckpoint(storedCheckpoint);
    const restored = deserializeCheckpoint(dbJson);
    const payload = getHarnessPayload(restored.harnessState);
    const messages = payload.messages as StoredMessage[];
    const tokenUsage = payload.tokenUsage as TokenUsage;

    expect(messages).toHaveLength(3);
    expect(messages[2].content).toBe('Continue please');
    expect(restored.harnessName).toBe('langgraph');

    const protoRoundTrip = roundTripProto(restored);
    expect(protoRoundTrip.harnessName).toBe('langgraph');
    expect(protoRoundTrip.workspaceRef.reference).toBe('data/checkpoints/run-suspend-1/workspace.tar.gz');
    expect(protoRoundTrip.workspaceRef.strategy).toBe('tar');
    expect(tokenUsage.inputTokens).toBe(100);
    expect(tokenUsage.outputTokens).toBe(50);
    expect(tokenUsage.totalTokens).toBe(150);
    expect(restored.cursor.nextMessageSeq).toBe(3);
    expect(restored.cursor.lastCompletedTurnId).toBe('turn-2');
  });
});

describe('Cross-component integration', () => {
  it('full pipeline: events -> phase tracking -> state collection -> checkpoint -> proto -> back', () => {
    const tracker = new ExecutionPhaseTracker();
    const collector = new SessionStateCollector();

    collector.startTurn('turn-full');
    collector.processTurnEvent({
      type: 'message_committed',
      role: 'user',
      content: 'Hello',
      turnId: 'turn-full',
      messageSeq: 0,
    });

    tracker.setPhase('before_llm');
    tracker.setPhase('llm_call_in_flight');
    tracker.setPhase('after_llm');

    tracker.setPhase('before_tool');
    tracker.setPhase('tool_execution');
    collector.processTurnEvent({
      type: 'tool_call_start',
      id: 'tc-1',
      name: 'search',
      args: { q: 'test' },
    });
    tracker.setPhase('after_tool');
    collector.processTurnEvent({
      type: 'tool_call_end',
      id: 'tc-1',
      result: 'Found results',
      durationMs: 200,
    });

    tracker.setPhase('before_llm');
    tracker.setPhase('llm_call_in_flight');
    tracker.setPhase('after_llm');
    tracker.setPhase('hitl_wait');
    collector.processTurnEvent({
      type: 'approval_needed',
      id: 'int-1',
      tool: 'write',
      args: { path: '/tmp' },
    });

    expect(tracker.isSuspendSafe()).toBe(true);

    const checkpoint = createCheckpointFromCollector({
      collector,
      sessionId: 'run-full',
      conversationId: 'conv-full',
      harnessName: 'langgraph',
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-full/workspace.tar.gz' },
      payload: {
        messages: [makeMessage({ id: 'msg-1', role: 'user', content: 'Hello' })],
        accumulatedText: 'Let me search that. The answer is 42.',
      },
    });

    expect(getHarnessPayload(checkpoint.harnessState).accumulatedText).toBe(
      'Let me search that. The answer is 42.',
    );
    expect(checkpoint.runnerState.status).toBe('WAITING_INPUT');
    expect(checkpoint.runnerState.pendingRequests?.[0].id).toBe('int-1');
    expect(checkpoint.runnerState.pendingRequests).toHaveLength(1);

    const json = serializeCheckpoint(checkpoint);
    const deserialized = deserializeCheckpoint(json);
    expect(deserialized).toEqual(checkpoint);

    const fromProto = roundTripProto(checkpoint);
    expect(fromProto.sessionId).toBe('run-full');
    expect(getHarnessPayload(fromProto.harnessState).accumulatedText).toBe(
      'Let me search that. The answer is 42.',
    );
    expect(fromProto.runnerState.status).toBe('WAITING_INPUT');
    expect(fromProto.runnerState.pendingRequests?.[0].id).toBe('int-1');
  });

  it('multiple suspend-resume cycles produce valid checkpoints each time', () => {
    const collector1 = new SessionStateCollector();
    collector1.startTurn('turn-1');
    collector1.processTurnEvent({
      type: 'message_committed',
      role: 'user',
      content: 'Start',
      turnId: 'turn-1',
      messageSeq: 0,
    });

    const cp1 = createCheckpointFromCollector({
      collector: collector1,
      sessionId: 'run-multi',
      conversationId: 'conv-multi',
      harnessName: 'langgraph',
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-multi-1/workspace.tar.gz' },
      payload: {
        messages: [makeMessage({ id: 'msg-1', content: 'Start' })],
        accumulatedText: 'First response',
        tokenUsage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      },
    });

    expect(validateCheckpointSize(serializeCheckpoint(cp1)).ok).toBe(true);

    const collector2 = new SessionStateCollector();
    collector2.startTurn('turn-2');
    collector2.processTurnEvent({
      type: 'message_committed',
      role: 'user',
      content: 'Continue',
      turnId: 'turn-2',
      messageSeq: 1,
    });
    collector2.processTurnEvent({
      type: 'tool_call_start',
      id: 'tc-1',
      name: 'bash',
      args: { cmd: 'ls' },
    });
    collector2.processTurnEvent({
      type: 'tool_call_end',
      id: 'tc-1',
      result: 'files',
      durationMs: 100,
    });

    const cp2 = createCheckpointFromCollector({
      collector: collector2,
      sessionId: 'run-multi',
      conversationId: 'conv-multi',
      harnessName: 'langgraph',
      workspaceRef: { strategy: 'tar', reference: 'data/checkpoints/run-multi-2/workspace.tar.gz' },
      payload: {
        messages: [
          makeMessage({ id: 'msg-1', content: 'Start' }),
          makeMessage({ id: 'msg-2', content: 'Continue' }),
        ],
        accumulatedText: 'Second response',
        tokenUsage: { inputTokens: 125, outputTokens: 65, totalTokens: 190 },
      },
    });

    expect(validateCheckpointSize(serializeCheckpoint(cp2)).ok).toBe(true);

    const payload2 = getHarnessPayload(cp2.harnessState);
    expect((payload2.messages as StoredMessage[])).toHaveLength(2);
    expect(cp2.cursor.nextMessageSeq).toBe(2);
    expect((payload2.tokenUsage as TokenUsage).totalTokens).toBe(190);
    expect(cp2.runnerState.status).toBe('IDLE');

    const restored1 = deserializeCheckpoint(serializeCheckpoint(cp1));
    const restored2 = deserializeCheckpoint(serializeCheckpoint(cp2));
    expect(getHarnessPayload(restored1.harnessState).accumulatedText).toBe('First response');
    expect(getHarnessPayload(restored2.harnessState).accumulatedText).toBe('Second response');
  });
});
