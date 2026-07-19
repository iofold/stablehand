import { create } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageCommittedSchema,
  SessionEventSchema,
  TurnCompletedSchema,
  type SessionEvent as ProtoSessionEvent,
} from '@ctxmill/proto/sandbox/v1';

import {
  SandboxSessionManager,
  type SessionRecord,
} from '../sandbox-session-manager.js';
import type { SessionEvent } from '../session-turn-service.js';
import type { DatabaseRepository } from '../../database/repository.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { ContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import { SessionStateStore } from '../session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../session-manager/session-status-coordinator.js';

type MockGrpcClient = {
  deliverTurn: ReturnType<typeof vi.fn>;
};

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
    extractWorkspaceDiff: vi.fn().mockResolvedValue(null),
  } as unknown as ContainerManager;
}

function createMockDb(): DatabaseRepository {
  return {
    updateSandboxSessionStatus: vi.fn().mockResolvedValue(undefined),
    updateTurn: vi.fn().mockResolvedValue(undefined),
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

function protoCommittedEvent(content: string, turnId: string): ProtoSessionEvent {
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

function protoTurnCompletedEvent(turnId: string): ProtoSessionEvent {
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
  const logger = createLogger();
  const stateStore = new SessionStateStore();
  const statusCoordinator = new SessionStatusCoordinator({ db, logger, stateStore });

  const manager = new SandboxSessionManager({
    containerManager,
    db,
    lifecyclePolicy,
    stateStore,
    statusCoordinator,
    workspaceDiffService: new WorkspaceDiffService({ containerManager }),
    buildSandboxSecrets: async () => ({}),
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
    logger,
    internals: manager as unknown as SandboxSessionManagerInternals,
  };
}

function seedSession(
  internals: SandboxSessionManagerInternals,
  grpcClient: MockGrpcClient,
  overrides?: Partial<SessionRecord>,
): SessionRecord {
  const record: SessionRecord = {
    sessionId: overrides?.sessionId ?? 'sess-1',
    conversationId: overrides?.conversationId ?? 'conv-1',
    agentId: overrides?.agentId ?? 'agent-1',
    containerName: overrides?.containerName ?? 'ctxmill-sandbox-sess-1',
    containerId: overrides?.containerId ?? 'c-1',
    status: overrides?.status ?? 'ACTIVE',
    harnessName: overrides?.harnessName ?? 'langgraph',
    sessionWorkspaceDir: overrides?.sessionWorkspaceDir,
    grpcClient: grpcClient as unknown as SessionRecord['grpcClient'],
  };

  internals.stateStore.sessions.set(record.conversationId, record);
  internals.stateStore.agentDefs.set(record.conversationId, createAgentDef());
  return record;
}

describe('SandboxSessionManager concurrency', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains queued follow-up turns one queued turn at a time without recursive re-entry', async () => {
    const { manager, logger, internals } = createManager();
    const firstRelease = deferred();
    const secondStarted = deferred();
    const secondRelease = deferred();
    let grpcCallCount = 0;

    const grpcClient: MockGrpcClient = {
      deliverTurn: vi.fn().mockImplementation((request: { turnId: string }) => {
        grpcCallCount += 1;

        if (grpcCallCount === 1) {
          return (async function* () {
            await firstRelease.promise;
            yield protoCommittedEvent('direct-response', request.turnId);
            yield protoTurnCompletedEvent(request.turnId);
          })();
        }

        if (grpcCallCount === 2) {
          return (async function* () {
            secondStarted.resolve();
            await secondRelease.promise;
            yield protoCommittedEvent('queued-response-1', request.turnId);
            yield protoTurnCompletedEvent(request.turnId);
          })();
        }

        return streamProtoEvents(
          protoCommittedEvent(`queued-response-${grpcCallCount - 1}`, request.turnId),
          protoTurnCompletedEvent(request.turnId),
        );
      }),
    };

    const record = seedSession(internals, grpcClient);

    const firstTurnPromise = collectEvents(
      manager.deliverTurn(record.sessionId, [createMessage('direct')], 'turn-direct'),
    );

    const batchOnePromises = Array.from({ length: 2 }, (_, index) =>
      collectEvents(manager.deliverTurn(record.sessionId, [createMessage(`batch-one-${index}`)], `turn-b1-${index}`)),
    );

    firstRelease.resolve();
    await secondStarted.promise;

    const batchTwoPromises = Array.from({ length: 3 }, (_, index) =>
      collectEvents(manager.deliverTurn(record.sessionId, [createMessage(`batch-two-${index}`)], `turn-b2-${index}`)),
    );

    secondRelease.resolve();

    const [firstTurnEvents, ...queuedResults] = await Promise.all([
      firstTurnPromise,
      ...batchOnePromises,
      ...batchTwoPromises,
    ]);

    expect(firstTurnEvents).toHaveLength(1);
    expect(firstTurnEvents[0]).toMatchObject({
      type: 'message_committed',
      content: 'direct-response',
      turnId: 'turn-direct',
    });

    for (const [index, events] of queuedResults.entries()) {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'message_committed' });
      const committedEvent = events[0] as Extract<SessionEvent, { type: 'message_committed' }>;
      expect(committedEvent.turnId).toMatch(/^turn-/);
      expect(committedEvent.content).toBe(`queued-response-${index + 1}`);
    }

    expect(grpcClient.deliverTurn).toHaveBeenCalledTimes(6);
    expect(internals.stateStore.activeTurns.has(record.sessionId)).toBe(false);
    expect(internals.stateStore.turnQueues.get(record.sessionId) ?? []).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stops draining at MAX_DRAIN_ITERATIONS', async () => {
    const { manager, logger, internals } = createManager();
    const sessionId = 'sess-limit';
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
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('drain loop hit safety limit (100)'),
    );
    expect(internals.stateStore.activeTurns.has(sessionId)).toBe(false);
  });

  it('fails remaining queued entries when drain safety limit is reached', async () => {
    const { manager, internals } = createManager();
    const sessionId = 'sess-overflow';
    let lastQueuedChannel = createChannel();

    const enqueue = (suffix: string) => {
      lastQueuedChannel = createChannel();
      const queue = internals.stateStore.turnQueues.get(sessionId) ?? [];
      queue.push({
        messages: [createMessage(`queued-${suffix}`)],
        turnId: `queued-${suffix}`,
        channel: lastQueuedChannel,
      });
      internals.stateStore.turnQueues.set(sessionId, queue);
      return lastQueuedChannel;
    };

    enqueue('initial');

    (manager as unknown as SandboxSessionManagerInternals).executeDeliverTurn = vi.fn(async function* () {
      enqueue(`loop-${Date.now()}`);
      yield {
        type: 'message_committed',
        role: 'assistant',
        content: 'loop',
        turnId: 'loop-turn',
        messageSeq: 1,
      } satisfies SessionEvent;
    });

    await internals.drainCoalescedQueue(sessionId);

    expect(lastQueuedChannel.fail).toHaveBeenCalledTimes(1);
    expect(lastQueuedChannel.fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Turn queue drain exceeded 100 iterations' }),
    );
    expect(internals.stateStore.turnQueues.get(sessionId) ?? []).toHaveLength(0);
  });

  it('times out hung gRPC deliverTurn streams', async () => {
    vi.useFakeTimers();
    const { manager, internals } = createManager({ turnTimeoutMs: 100 });
    const grpcClient: MockGrpcClient = {
      deliverTurn: vi.fn().mockImplementation(() =>
        // eslint-disable-next-line require-yield
        (async function* () {
          await new Promise(() => undefined);
        })(),
      ),
    };

    const record = seedSession(internals, grpcClient, { sessionId: 'sess-timeout', conversationId: 'conv-timeout' });
    const turnPromise = collectEvents(
      manager.deliverTurn(record.sessionId, [createMessage('timeout')], 'turn-timeout'),
    );

    await vi.advanceTimersByTimeAsync(101);

    await expect(turnPromise).resolves.toEqual([
      expect.objectContaining({
        type: 'turn_failed',
        turnId: 'turn-timeout',
        errorMessage: expect.stringContaining('Turn turn-timeout timed out after 100ms for session sess-timeout'),
      }),
    ]);
  });

  it('allows gRPC deliverTurn streams to complete within the timeout', async () => {
    const { manager, internals } = createManager({ turnTimeoutMs: 100 });
    const grpcClient: MockGrpcClient = {
      deliverTurn: vi.fn().mockImplementation((request: { turnId: string }) =>
        streamProtoEvents(
          protoCommittedEvent('chunk-1', request.turnId),
          protoCommittedEvent('chunk-2', request.turnId),
          protoCommittedEvent('chunk-3', request.turnId),
          protoTurnCompletedEvent(request.turnId),
        ),
      ),
    };

    const record = seedSession(internals, grpcClient, { sessionId: 'sess-fast', conversationId: 'conv-fast' });
    const events = await collectEvents(
      manager.deliverTurn(record.sessionId, [createMessage('ok')], 'turn-fast'),
    );

    expect(events).toHaveLength(3);
    expect(events).toEqual([
      expect.objectContaining({ type: 'message_committed', content: 'chunk-1' }),
      expect.objectContaining({ type: 'message_committed', content: 'chunk-2' }),
      expect.objectContaining({ type: 'message_committed', content: 'chunk-3' }),
    ]);
  });
});
