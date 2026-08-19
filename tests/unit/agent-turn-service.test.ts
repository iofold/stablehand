import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTurnService } from '../../packages/ctxmill/src/orchestrator/agent-turn-service.js';
import type {
  AgentTurnServiceDeps,
  ExecuteTurnParams,
} from '../../packages/ctxmill/src/orchestrator/agent-turn-service.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import type { EventMap } from '../../packages/ctxmill/src/events/bus.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import type { SessionTurnExecutor } from '../../packages/ctxmill/src/orchestrator/session-turn-service.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import type { AgentSessionEvent, MessageCommittedEvent } from '../../packages/shared/src/events.js';
import { TURN_CANCELLED_MESSAGE } from '../../packages/ctxmill/src/orchestrator/turn-cancellation.js';
import { CanonicalLog } from '../../packages/ctxmill/src/orchestrator/canonical/canonical-log.js';
import {
  TestTurnRegistry,
  createTestSandboxSessionManager,
} from '../utils/test-turn-registry.js';
import type {
  PerformanceAttributes,
  PerformanceMeasurement,
  PerformancePhase,
} from '../../packages/ctxmill/src/observability/performance.js';

type StreamEvent = AgentSessionEvent | MessageCommittedEvent;

function expectedDeliveryFence() {
  return expect.objectContaining({
    ownerId: expect.any(String),
    fenceToken: 1,
  });
}

function expectedDeliveryPersistenceContext() {
  return {
    deliveryFence: expectedDeliveryFence(),
  };
}

async function* eventStream(events: readonly StreamEvent[]) {
  for (const event of events) {
    yield event;
  }
}

function collectEvents<K extends keyof EventMap>(bus: TypedEventBus, event: K): EventMap[K][] {
  const collected: EventMap[K][] = [];
  bus.on(event, (payload) => {
    collected.push(payload);
  });
  return collected;
}

type MockEventBus = TypedEventBus & {
  emit: ReturnType<typeof vi.fn>;
  emitAsync: ReturnType<typeof vi.fn>;
};

function createEventBusMock(): MockEventBus {
  const emit = vi.fn();
  return {
    emit,
    emitAsync: vi.fn(async (eventName: string, payload: unknown) => {
      emit(eventName, payload);
    }),
  } as unknown as MockEventBus;
}

function makeAgentDef(): AgentDefinition {
  return {
    name: 'test-agent',
    harness: 'claude-agents',
    harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
    systemPrompt: 'You are a test agent.',
    tools: [],
  };
}

function makeMessages(): Message[] {
  return [
    {
      id: 'user-msg-1',
      agentId: 'agent-1',
      role: 'user',
      content: 'Hello',
      createdAt: new Date('2026-03-21T00:00:00.000Z'),
    },
  ];
}

function makeParams(overrides: Partial<ExecuteTurnParams> = {}): ExecuteTurnParams {
  return {
    agentDef: makeAgentDef(),
    messages: makeMessages(),
    agentId: 'agent-1',
    conversationId: 'conv-1',
    turnId: 'run-1',
    mode: 'interactive',
    taskDescription: 'test task',
    ...overrides,
  };
}

type MockSessionManager = {
  ensureSession: ReturnType<typeof vi.fn>;
  findSessionById?: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  completeTurn: ReturnType<typeof vi.fn>;
  abandonTurnDelivery: ReturnType<typeof vi.fn>;
  getPendingSessionReset: ReturnType<typeof vi.fn>;
};

function makeCommittedEvent(
  overrides: Partial<MessageCommittedEvent> = {},
): MessageCommittedEvent {
  return {
    type: 'MESSAGE_COMMITTED',
    timestamp: 1,
    runId: 'run-1',
    role: 'assistant',
    content: 'Final response',
    turnId: 'run-1',
    messageSeq: 1,
    ...overrides,
  };
}

function createDeps(overrides: {
  sessionTurnService?: { executeSessionTurn: ReturnType<typeof vi.fn> };
  db?: {
    addMessage: ReturnType<typeof vi.fn>;
    addCanonicalMessage?: ReturnType<typeof vi.fn>;
    updateTurn: ReturnType<typeof vi.fn>;
    finalizeTurnIfOpen?: ReturnType<typeof vi.fn>;
    finalizeTurnAndMarkLifecycleDraining?: ReturnType<typeof vi.fn>;
    getTurn?: ReturnType<typeof vi.fn>;
    getMessage?: ReturnType<typeof vi.fn>;
    getMessages?: ReturnType<typeof vi.fn>;
    getMessagesPendingCanonicalPublish?: ReturnType<typeof vi.fn>;
    stageAssistantMessageUpdate?: ReturnType<typeof vi.fn>;
    claimTurnDeliveryLease?: ReturnType<typeof vi.fn>;
    renewTurnDeliveryLease?: ReturnType<typeof vi.fn>;
    releaseTurnDeliveryLease?: ReturnType<typeof vi.fn>;
    isTurnDeliveryFenceCurrent?: ReturnType<typeof vi.fn>;
  };
  sessionManager?: Partial<MockSessionManager>;
  eventBus?: TypedEventBus;
} = {}) {
  const sessionTurnService = overrides.sessionTurnService ?? {
    executeSessionTurn: vi.fn(),
  };
  let messageCounter = 0;
  const canonicalMessages = new Map<string, Record<string, unknown>>();
  const defaultAddCanonicalMessage = vi.fn().mockImplementation(async (
    data: Record<string, unknown>,
  ) => {
    messageCounter++;
    const message = {
      ...data,
      id: `msg-${messageCounter}`,
      messageSeq: messageCounter - 1,
      messageRevision: 0,
      publishedRevision: -1,
      createdAt: Date.now(),
    };
    canonicalMessages.set(message.id, message);
    return message;
  });
  const configuredAddCanonicalMessage = overrides.db?.addCanonicalMessage
    ?? overrides.db?.addMessage
    ?? defaultAddCanonicalMessage;
  const defaultStageAssistantMessageUpdate = vi.fn().mockImplementation(async (
    id: string,
    toolCalls: unknown[],
    parts: unknown[],
  ) => {
    const previous = canonicalMessages.get(id) ?? {
      id,
      agentId: 'agent-1',
      conversationId: 'conv-1',
      turnId: 'run-1',
      messageSeq: 0,
      role: 'assistant',
      content: '',
      messageRevision: 0,
      publishedRevision: 0,
      createdAt: Date.now(),
    };
    const updated = {
      ...previous,
      toolCalls,
      parts,
      messageRevision: Number(previous.messageRevision ?? 0) + 1,
      publishedRevision: Number(previous.publishedRevision ?? 0),
    };
    canonicalMessages.set(id, updated);
    return updated;
  });
  const db = {
    addMessage: configuredAddCanonicalMessage,
    addCanonicalMessage: configuredAddCanonicalMessage,
    updateTurn: vi.fn().mockResolvedValue(undefined),
    finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
    finalizeTurnAndMarkLifecycleDraining: vi.fn().mockResolvedValue(true),
    getTurn: vi.fn().mockResolvedValue({ id: 'run-1', sandboxSessionId: 'sandbox-1' }),
    getMessage: vi.fn().mockImplementation(async (id: string) => canonicalMessages.get(id)),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesPendingCanonicalPublish: vi.fn().mockResolvedValue([]),
    claimTurnDeliveryLease: vi.fn().mockImplementation(async (input: {
      turnId: string;
      ownerId: string;
      leaseDurationMs: number;
    }) => ({
      turnId: input.turnId,
      ownerId: input.ownerId,
      fenceToken: 1,
      leaseExpiresAt: Date.now() + input.leaseDurationMs,
      updatedAt: Date.now(),
    })),
    renewTurnDeliveryLease: vi.fn().mockImplementation(async (
      turnId: string,
      ownerId: string,
      fenceToken: number,
      leaseDurationMs: number,
    ) => ({
      turnId,
      ownerId,
      fenceToken,
      leaseExpiresAt: Date.now() + leaseDurationMs,
      updatedAt: Date.now(),
    })),
    releaseTurnDeliveryLease: vi.fn().mockResolvedValue(true),
    isTurnDeliveryFenceCurrent: vi.fn().mockResolvedValue(true),
    stageAssistantMessageUpdate: overrides.db?.stageAssistantMessageUpdate
      ?? defaultStageAssistantMessageUpdate,
    ...overrides.db,
  };
  const sessionManager = {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'sandbox-1' }),
    findSessionById: vi.fn().mockReturnValue({
      sessionId: 'sandbox-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      containerName: 'sandbox-1',
      containerId: 'container-1',
      status: 'ACTIVE',
      harnessName: 'claude-agents',
    }),
    startTurn: vi.fn().mockReturnValue(undefined),
    completeTurn: vi.fn().mockResolvedValue(undefined),
    abandonTurnDelivery: vi.fn().mockResolvedValue(undefined),
    getPendingSessionReset: vi.fn().mockReturnValue(undefined),
    ...overrides.sessionManager,
  };
  const eventBus = overrides.eventBus ?? new TypedEventBus();

  const deps: AgentTurnServiceDeps = {
    sessionTurnService: sessionTurnService as unknown as SessionTurnExecutor,
    db: db as unknown as DatabaseRepository,
    sessionManager: sessionManager as unknown as AgentTurnServiceDeps['sessionManager'],
    eventBus,
  };

  return { deps, sessionTurnService, db, sessionManager, eventBus };
}

type ExecuteEventsOptions = {
  deps?: Parameters<typeof createDeps>[0];
  params?: Partial<ExecuteTurnParams>;
  configure?: (ctx: ReturnType<typeof createDeps>) => void;
};

async function executeEvents(
  events: readonly StreamEvent[],
  options: ExecuteEventsOptions = {},
) {
  const ctx = createDeps(options.deps);
  ctx.sessionTurnService.executeSessionTurn.mockReturnValue(eventStream(events));
  options.configure?.(ctx);
  const params = makeParams(options.params);
  const service = new AgentTurnService(ctx.deps);
  await service.executeTurn(params);
  return { ...ctx, params, service };
}

describe('AgentTurnService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('measures session admission, first event, first token, and turn delivery', async () => {
    const observations: Array<{
      phase: PerformancePhase;
      attributes: PerformanceAttributes;
      outcome?: string;
    }> = [];
    const performance = {
      start: vi.fn((
        phase: PerformancePhase,
        attributes: PerformanceAttributes,
      ): PerformanceMeasurement => {
        const observation = { phase, attributes, outcome: undefined as string | undefined };
        observations.push(observation);
        return {
          setAttribute: vi.fn(),
          end: vi.fn((outcome = 'ok') => {
            observation.outcome = outcome;
            return { phase, durationMs: 1, outcome };
          }),
        };
      }),
      measure: vi.fn(async <T>(
        phase: PerformancePhase,
        attributes: PerformanceAttributes,
        operation: () => Promise<T>,
      ): Promise<T> => {
        observations.push({ phase, attributes, outcome: 'ok' });
        return operation();
      }),
    };
    const ctx = createDeps();
    ctx.sessionTurnService.executeSessionTurn.mockReturnValue(eventStream([
      {
        type: 'RUN_STARTED',
        runId: 'run-1',
        threadId: 'conv-1',
      },
      {
        type: 'TEXT_MESSAGE_CONTENT',
        runId: 'run-1',
        threadId: 'conv-1',
        messageId: 'message-1',
        delta: 'hello',
      },
      makeCommittedEvent({ content: 'hello' }),
      {
        type: 'RUN_FINISHED',
        runId: 'run-1',
        threadId: 'conv-1',
      },
    ]));

    await new AgentTurnService({
      ...ctx.deps,
      performance,
    }).executeTurn(makeParams());

    expect(observations.map((observation) => observation.phase)).toEqual(
      expect.arrayContaining([
        'turn.execute',
        'session.ensure',
        'turn.delivery',
        'turn.first_event',
        'turn.first_token',
      ]),
    );
    expect(observations.find(({ phase }) => phase === 'turn.first_token'))
      .toMatchObject({
        attributes: expect.objectContaining({
          'ctxmill.turn.id': 'run-1',
          'ctxmill.harness': 'claude-agents',
        }),
        outcome: 'ok',
      });
  });

  it('calls executeSessionTurn with conversation turn inputs and abort signal', async () => {
    const abortController = new AbortController();
    const { params, sessionTurnService, db } = await executeEvents([], {
      configure: ({ sessionManager }) => {
        sessionManager.startTurn.mockReturnValue(abortController.signal);
      },
    });

    expect(db.updateTurn).not.toHaveBeenCalled();

    expect(sessionTurnService.executeSessionTurn).toHaveBeenCalledWith(
      params.agentDef,
      params.conversationId,
      params.messages,
      params.turnId,
      {
        signal: expect.any(AbortSignal),
        agentId: params.agentId,
        existingSessionId: 'sandbox-1',
      },
    );
  });

  it('performs no sandbox, message, event, or terminal mutation when delivery admission is lost', async () => {
    const eventBus = createEventBusMock();
    const releaseReservation = vi.fn();
    const ctx = createDeps({
      eventBus,
      db: {
        addMessage: vi.fn(),
        updateTurn: vi.fn(),
        finalizeTurnIfOpen: vi.fn(),
        claimTurnDeliveryLease: vi.fn().mockResolvedValue(undefined),
      },
    });
    const service = new AgentTurnService(ctx.deps);

    await service.executeTurn(makeParams({
      concurrencyReservation: {
        agentId: 'agent-1',
        id: 'reservation-1',
        release: releaseReservation,
      },
    }));

    expect(ctx.db.claimTurnDeliveryLease).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(ctx.sessionManager.ensureSession).not.toHaveBeenCalled();
    expect(ctx.sessionManager.startTurn).not.toHaveBeenCalled();
    expect(ctx.sessionTurnService.executeSessionTurn).not.toHaveBeenCalled();
    expect(ctx.db.addCanonicalMessage).not.toHaveBeenCalled();
    expect(ctx.db.stageAssistantMessageUpdate).not.toHaveBeenCalled();
    expect(ctx.db.finalizeTurnIfOpen).not.toHaveBeenCalled();
    expect(ctx.sessionManager.completeTurn).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(eventBus.emitAsync).not.toHaveBeenCalled();
  });

  it('propagates an external recovery lease abort into the active session turn', async () => {
    const internalController = new AbortController();
    const leaseController = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let streamStartedResolve: (() => void) | undefined;
    const streamStarted = new Promise<void>((resolve) => {
      streamStartedResolve = resolve;
    });
    async function* waitForAbort(
      _agentDef: AgentDefinition,
      _conversationId: string,
      _messages: Message[],
      _turnId: string,
      options?: { signal?: AbortSignal },
    ) {
      const signal = options?.signal;
      observedSignal = signal;
      streamStartedResolve?.();
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      if (!signal?.aborted) {
        yield makeCommittedEvent();
      }
    }
    const ctx = createDeps({
      sessionManager: {
        ensureSession: vi.fn().mockResolvedValue({ sessionId: 'sandbox-1' }),
        startTurn: vi.fn().mockReturnValue(internalController.signal),
        completeTurn: vi.fn(),
      },
      sessionTurnService: {
        executeSessionTurn: vi.fn().mockImplementation(waitForAbort),
      },
    });
    const service = new AgentTurnService(ctx.deps);
    const turnPromise = service.executeTurn(makeParams({ signal: leaseController.signal }));

    await streamStarted;
    leaseController.abort(new Error('delivery lease lost'));
    await turnPromise;

    expect(observedSignal).toBeDefined();
    expect(observedSignal).not.toBe(internalController.signal);
    expect(observedSignal?.aborted).toBe(true);
    expect(ctx.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'cancelled' }),
      expectedDeliveryFence(),
    );
  });

  it('passes replay suppression to startTurn when requested', async () => {
    const abortController = new AbortController();
    const { sessionManager } = await executeEvents([], {
      params: { suppressTurnStartedEvent: true },
      configure: ({ sessionManager }) => {
        sessionManager.startTurn.mockReturnValue(abortController.signal);
      },
    });

    expect(sessionManager.startTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'interactive',
      'test task',
      {
        suppressEvent: true,
        deliveryContext: {
          fence: expect.objectContaining({
            ownerId: expect.any(String),
            fenceToken: 1,
          }),
        },
      },
    );
  });

  it('continues the original HITL turn on its prepared sandbox and existing fence', async () => {
    const fence = { ownerId: 'resume-worker', fenceToken: 8 };
    const { db, sessionManager } = await executeEvents([
      makeCommittedEvent({ content: 'continued answer' }),
      { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
    ], {
      params: {
        sandboxSessionId: 'sandbox-1',
        continuationAttemptId: 'attempt-1',
        deliveryContext: { fence },
      },
    });

    expect(sessionManager.ensureSession).not.toHaveBeenCalled();
    expect(sessionManager.findSessionById).toHaveBeenCalledWith('sandbox-1');
    expect(sessionManager.startTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'interactive',
      'test task',
      {
        suppressEvent: true,
        deliveryContext: { fence },
        deliveryAdmission: 'continuation',
      },
    );
    expect(db.addCanonicalMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'canonical-run-1-resume-attempt-1-0',
        turnId: 'run-1',
        content: 'continued answer',
      }),
      fence,
    );
    expect(db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        sandboxSessionId: 'sandbox-1',
        status: 'completed',
      }),
      fence,
    );
  });

  it('keeps the original HITL turn open when continuation execution fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fence = { ownerId: 'resume-worker', fenceToken: 8 };
    const ctx = createDeps();
    ctx.sessionTurnService.executeSessionTurn.mockReturnValue(eventStream([
      {
        type: 'RUN_ERROR',
        timestamp: 1,
        runId: 'run-1',
        error: 'continuation failed',
      },
    ]));

    await expect(new AgentTurnService(ctx.deps).executeTurn(makeParams({
      sandboxSessionId: 'sandbox-1',
      continuationAttemptId: 'attempt-1',
      deliveryContext: { fence },
    }))).rejects.toThrow('continuation failed');

    expect(ctx.db.finalizeTurnIfOpen).not.toHaveBeenCalled();
    expect(ctx.sessionManager.abandonTurnDelivery).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
    );
  });

  it('atomically drains a reserved session reset with the owned terminal turn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deliveryFence = { ownerId: 'delivery-owner', fenceToken: 5 };
    const lifecycleReset = {
      sandboxSessionId: 'sandbox-1',
      fence: { ownerId: 'reset-owner', fenceToken: 3 },
    };
    const ctx = createDeps({
      sessionManager: {
        getPendingSessionReset: vi.fn().mockReturnValue(lifecycleReset),
      },
    });
    ctx.sessionTurnService.executeSessionTurn.mockReturnValue(eventStream([
      {
        type: 'RUN_ERROR',
        timestamp: 1,
        runId: 'run-1',
        error: 'sandbox transport failed',
      },
    ]));

    await new AgentTurnService(ctx.deps).executeTurn(makeParams({
      deliveryContext: { fence: deliveryFence },
    }));

    expect(ctx.db.finalizeTurnIfOpen).not.toHaveBeenCalled();
    expect(ctx.db.finalizeTurnAndMarkLifecycleDraining).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        sandboxSessionId: 'sandbox-1',
        status: 'error',
        error: 'sandbox transport failed',
      }),
      deliveryFence,
      {
        sandboxSessionId: 'sandbox-1',
        ownerId: 'reset-owner',
        fenceToken: 3,
      },
    );
    expect(ctx.sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'error',
      expect.any(Number),
      'sandbox transport failed',
      undefined,
    );
  });

  it('does not flush or finalize after a recovery owner loses its durable fence', async () => {
    const addCanonicalMessage = vi.fn().mockResolvedValue({ id: 'should-not-write' });
    const { db, sessionManager } = await executeEvents([
      {
        type: 'TEXT_MESSAGE_CONTENT',
        timestamp: 1,
        runId: 'run-1',
        messageId: 'streamed-1',
        delta: 'partial text',
      },
    ], {
      params: {
        deliveryContext: {
          fence: {
            ownerId: 'stale-owner',
            fenceToken: 4,
          },
        },
      },
      deps: {
        db: {
          addMessage: addCanonicalMessage,
          addCanonicalMessage,
          updateTurn: vi.fn(),
          finalizeTurnIfOpen: vi.fn(),
          isTurnDeliveryFenceCurrent: vi.fn().mockResolvedValue(false),
        },
      },
    });

    expect(db.updateTurn).not.toHaveBeenCalled();
    expect(addCanonicalMessage).not.toHaveBeenCalled();
    expect(db.finalizeTurnIfOpen).not.toHaveBeenCalled();
    expect(sessionManager.abandonTurnDelivery).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
    );
  });

  it('completes the current rebound sandbox session when the turn row was rebound during delivery', async () => {
    const { db, sessionManager } = await executeEvents([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', delta: 'ok' },
      { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
    ], {
      deps: {
        db: {
          addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
          updateTurn: vi.fn().mockResolvedValue(undefined),
          finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
          getTurn: vi.fn().mockResolvedValue({ id: 'run-1', sandboxSessionId: 'sandbox-2' }),
        },
      },
    });

    expect(db.getTurn).toHaveBeenCalledWith('run-1');
    expect(db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'run-1',
      {
        sandboxSessionId: 'sandbox-2',
        completedAt: expect.any(Number),
        error: null,
        status: 'completed',
      },
      expectedDeliveryFence(),
    );
    expect(sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-2',
      'run-1',
      'agent-1',
      'conv-1',
      'completed',
      expect.any(Number),
      undefined,
      undefined,
    );
  });

  it('does not start sandbox work when the turn was durably cancelled before delivery', async () => {
    const eventBus = createEventBusMock();
    const { db, sessionManager, sessionTurnService } = await executeEvents([], {
      deps: {
        eventBus,
        db: {
          addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
          updateTurn: vi.fn().mockResolvedValue(undefined),
          finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
          getTurn: vi.fn().mockResolvedValue({
            id: 'run-1',
            sandboxSessionId: null,
            completedAt: 1,
            error: TURN_CANCELLED_MESSAGE,
          }),
        },
      },
    });

    expect(sessionManager.ensureSession).not.toHaveBeenCalled();
    expect(sessionManager.startTurn).not.toHaveBeenCalled();
    expect(sessionTurnService.executeSessionTurn).not.toHaveBeenCalled();
    expect(db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'run-1',
      {
        completedAt: expect.any(Number),
        error: TURN_CANCELLED_MESSAGE,
        status: 'cancelled',
      },
      expectedDeliveryFence(),
    );
    expect(eventBus.emit).toHaveBeenCalledWith('turn.completed', expect.objectContaining({
      turnId: 'run-1',
      status: 'cancelled',
      error: TURN_CANCELLED_MESSAGE,
    }));
  });

  it('emits ag_ui.event for streamed events not handled individually', async () => {
    const events: StreamEvent[] = [
      { type: 'RUN_STARTED', timestamp: 1, runId: 'run-1' },
      { type: 'TEXT_MESSAGE_START', timestamp: 2, runId: 'run-1', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'run-1', messageId: 'm1', delta: 'Hi' },
      makeCommittedEvent({ timestamp: 4, content: 'Hi' }),
      { type: 'INTERRUPT_REQUESTED', timestamp: 5, runId: 'run-1', reason: 'approval_required' },
      { type: 'RUN_FINISHED', timestamp: 6, runId: 'run-1' },
    ];

    const individuallyHandled = new Set(['TEXT_MESSAGE_CONTENT', 'TOOL_CALL_START', 'TOOL_CALL_RESULT', 'MESSAGE_COMMITTED', 'RUN_ERROR', 'RUN_FINISHED', 'INTERRUPT_REQUESTED']);
    const forwardedEvents = events.filter((event) => !individuallyHandled.has(event.type));

    const eventBus = createEventBusMock();
    await executeEvents(events, { deps: { eventBus } });

    const agUiEventCalls = eventBus.emit.mock.calls.filter(([eventName]) => eventName === 'ag_ui.event');
    expect(agUiEventCalls).toHaveLength(forwardedEvents.length);
    for (const [index, event] of forwardedEvents.entries()) {
      expect(agUiEventCalls[index]).toEqual([
        'ag_ui.event',
        expect.objectContaining({
          turnId: 'run-1',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          event,
          timestamp: expect.any(Number),
        }),
        expectedDeliveryPersistenceContext(),
      ]);
    }
  });

  it('keeps consuming sandbox deltas while canonical persistence serializes them exactly', async () => {
    let releaseFirstPersist!: () => void;
    const firstPersistReleased = new Promise<void>((resolve) => {
      releaseFirstPersist = resolve;
    });
    let markSecondYield!: () => void;
    const secondYielded = new Promise<void>((resolve) => {
      markSecondYield = resolve;
    });
    let yielded = 0;
    let nextSeq = 0;
    const durableOrder: string[] = [];
    const persist = async (
      frames: Array<{ sourceType?: string | null }>,
      waitForGate = false,
    ) => {
      if (waitForGate) {
        await firstPersistReleased;
      }
      durableOrder.push(String(frames[0]?.sourceType));
      return frames.map(() => ++nextSeq);
    };
    let fencedPersistCount = 0;
    const canonicalLog = new CanonicalLog({
      db: {
        saveEventBatch: vi.fn(async (frames) => persist(frames)),
        saveFencedEventBatch: vi.fn(async (frames) => {
          fencedPersistCount++;
          return persist(frames, fencedPersistCount === 1);
        }),
        saveRecoveryEventBatch: vi.fn(async (frames) => persist(frames)),
        saveMessageEventBatch: vi.fn(async (frames) => persist(frames)),
        saveTerminalEventBatch: vi.fn(async (frames) => persist(frames)),
        getFramesSince: vi.fn(async () => []),
        getTurnFrames: vi.fn(async () => []),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const eventBus = new TypedEventBus({
      persistEvent: (eventName, _agentId, _payload, parsedPayload, context) =>
        canonicalLog.ingest(eventName, parsedPayload ?? {}, context),
    });
    async function* streamingDeltas(): AsyncGenerator<AgentSessionEvent> {
      yielded++;
      yield {
        type: 'TEXT_MESSAGE_CONTENT',
        timestamp: 1,
        runId: 'run-1',
        messageId: 'stream-1',
        delta: 'A',
      };
      yielded++;
      markSecondYield();
      yield {
        type: 'TEXT_MESSAGE_CONTENT',
        timestamp: 2,
        runId: 'run-1',
        messageId: 'stream-1',
        delta: 'B',
      };
      yield { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' };
    }
    const ctx = createDeps({
      eventBus,
      sessionTurnService: {
        executeSessionTurn: vi.fn().mockImplementation(streamingDeltas),
      },
    });
    const execution = new AgentTurnService(ctx.deps).executeTurn(makeParams());

    await secondYielded;
    expect(yielded).toBe(2);
    expect(durableOrder).toEqual([]);

    releaseFirstPersist();
    await execution;
    await canonicalLog.drain();
    expect(durableOrder).toEqual([
      'message.delta',
      'message.delta',
      'message.committed',
      'turn.completed',
    ]);
  });

  it('persists assistant MESSAGE_COMMITTED events to the database', async () => {
    const committed = makeCommittedEvent({
      role: 'assistant',
      content: 'Hello world',
      timestamp: 10,
      messageSeq: 2,
    });

    const { db } = await executeEvents([committed]);

    expect(db.addMessage).toHaveBeenCalledTimes(1);
    expect(db.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello world',
        toolCalls: undefined,
        toolCallId: undefined,
      }),
      expectedDeliveryFence(),
    );
  });

  it('persists tool MESSAGE_COMMITTED events with tool metadata', async () => {
    const committed = makeCommittedEvent({
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'tool-call-1',
      toolCalls: [],
      messageSeq: 3,
    });

    const { db } = await executeEvents([committed]);

    expect(db.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'tool',
        content: '{"ok":true}',
        toolCalls: [],
        toolCallId: 'tool-call-1',
      }),
      expectedDeliveryFence(),
    );
  });

  it('flushes accumulated assistant text when the stream ends without MESSAGE_COMMITTED', async () => {
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'Hello ' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'run-1', messageId: 'm1', delta: 'world' },
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
    ];

    const { db } = await executeEvents(events);

    expect(db.addMessage).toHaveBeenCalledTimes(1);
    expect(db.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello world',
        toolCalls: undefined,
        toolCallId: undefined,
        parts: [{ type: 'text', content: 'Hello world' }],
      }),
      expectedDeliveryFence(),
    );
  });

  it('flushes pending tool-call state when the stream ends before a result arrives', async () => {
    const events: StreamEvent[] = [
      { type: 'TOOL_CALL_START', timestamp: 1, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search' },
      { type: 'TOOL_CALL_END', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1' },
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
    ];

    const { db } = await executeEvents(events);

    expect(db.addMessage).toHaveBeenCalledTimes(1);
    expect(db.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: '',
        toolCallId: undefined,
        parts: [{ type: 'tool_call', id: 'tc-1', name: 'search', args: '', status: 'complete' }],
        toolCalls: [{ id: 'tc-1', name: 'search', args: '', status: 'complete' }],
      }),
      expectedDeliveryFence(),
    );
  });

  it('persists assistant and tool messages separately for tool-use turns', async () => {
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'Let me check.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search' },
      { type: 'TOOL_CALL_ARGS', timestamp: 3, runId: 'run-1', toolCallId: 'tc-1', args: '{"q":"test"}' },
      { type: 'TOOL_CALL_END', timestamp: 4, runId: 'run-1', toolCallId: 'tc-1' },
      { type: 'TOOL_CALL_RESULT', timestamp: 5, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search', result: 'Found 3 results', durationMs: 42 },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 6, runId: 'run-1', messageId: 'm1', delta: 'Based on the results:' },
      makeCommittedEvent({ timestamp: 7, content: 'Based on the results:' }),
      { type: 'RUN_FINISHED', timestamp: 8, runId: 'run-1' },
    ];

    const { db } = await executeEvents(events);

    expect(db.addMessage).toHaveBeenCalledTimes(3);
    expect(db.addMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [
          {
            id: 'tc-1',
            name: 'search',
            args: '{"q":"test"}',
            status: 'complete',
          },
        ],
      }),
      expectedDeliveryFence(),
    );
    const firstCall = (db.addMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCall.parts).toHaveLength(2);
    expect(firstCall.parts[0]).toEqual({ type: 'text', content: 'Let me check.' });
    expect(firstCall.parts[1]).toMatchObject({ type: 'tool_call', id: 'tc-1', name: 'search', status: 'complete' });
    expect(db.addMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        turnId: 'run-1',
        role: 'tool',
        content: 'Found 3 results',
        toolCallId: 'tc-1',
      }),
      expectedDeliveryFence(),
    );
    expect(db.addMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Based on the results:',
      }),
      expectedDeliveryFence(),
    );
  });

  it('updates both persisted assistant tool-call projections after later tool results', async () => {
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'Checking.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search' },
      { type: 'TOOL_CALL_RESULT', timestamp: 3, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search', result: 'first', durationMs: 1 },
      { type: 'TOOL_CALL_START', timestamp: 4, runId: 'run-1', toolCallId: 'tc-2', toolName: 'lookup' },
      { type: 'TOOL_CALL_RESULT', timestamp: 5, runId: 'run-1', toolCallId: 'tc-2', toolName: 'lookup', result: 'second', durationMs: 1 },
      { type: 'RUN_FINISHED', timestamp: 6, runId: 'run-1' },
    ];

    const { db } = await executeEvents(events);

    expect(db.stageAssistantMessageUpdate).toHaveBeenCalledWith(
      'msg-1',
      [
        { id: 'tc-1', name: 'search', args: '', status: 'complete' },
        { id: 'tc-2', name: 'lookup', args: '', status: 'complete' },
      ],
      [
        { type: 'text', content: 'Checking.' },
        { type: 'tool_call', id: 'tc-1', name: 'search', args: '', result: 'first', error: undefined, status: 'complete' },
        { type: 'tool_call', id: 'tc-2', name: 'lookup', args: '', result: 'second', error: undefined, status: 'complete' },
      ],
      expectedDeliveryFence(),
    );
  });

  it('emits an authoritative message.updated after mutating a persisted assistant message', async () => {
    const eventBus = createEventBusMock();
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'Checking.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search' },
      { type: 'TOOL_CALL_RESULT', timestamp: 3, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search', result: 'first', durationMs: 1 },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 4, runId: 'run-1', messageId: 'm2', delta: 'Need one more check.' },
      { type: 'TOOL_CALL_START', timestamp: 5, runId: 'run-1', toolCallId: 'tc-2', toolName: 'lookup' },
      { type: 'TOOL_CALL_RESULT', timestamp: 6, runId: 'run-1', toolCallId: 'tc-2', toolName: 'lookup', result: 'second', durationMs: 1 },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 7, runId: 'run-1', messageId: 'm3', delta: 'Final check.' },
      { type: 'TOOL_CALL_START', timestamp: 8, runId: 'run-1', toolCallId: 'tc-3', toolName: 'read' },
      { type: 'TOOL_CALL_RESULT', timestamp: 9, runId: 'run-1', toolCallId: 'tc-3', toolName: 'read', result: 'third', durationMs: 1 },
      { type: 'RUN_FINISHED', timestamp: 10, runId: 'run-1' },
    ];

    await executeEvents(events, { deps: { eventBus } });

    const updates = eventBus.emit.mock.calls
      .filter(([eventName]) => eventName === 'message.updated')
      .map(([, payload]) => payload as Record<string, unknown>);
    expect(updates).toHaveLength(2);
    expect(updates.map((update) => update.messageRevision)).toEqual([1, 2]);
    expect(updates[0]).toMatchObject({
      turnId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      messageSeq: 0,
      role: 'assistant',
      content: 'Checking.',
      parts: [
        { type: 'text', content: 'Checking.' },
        { type: 'tool_call', id: 'tc-1', name: 'search', args: '', result: 'first', status: 'complete' },
        { type: 'text', content: 'Need one more check.' },
        { type: 'tool_call', id: 'tc-2', name: 'lookup', args: '', result: 'second', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tc-1', name: 'search', args: '', status: 'complete' },
        { id: 'tc-2', name: 'lookup', args: '', status: 'complete' },
      ],
      timestamp: expect.any(Number),
    });
    expect(updates[1]).toMatchObject({
      messageId: 'msg-1',
      messageSeq: 0,
      messageRevision: 2,
      parts: [
        { type: 'text', content: 'Checking.' },
        { type: 'tool_call', id: 'tc-1', name: 'search', args: '', result: 'first', status: 'complete' },
        { type: 'text', content: 'Need one more check.' },
        { type: 'tool_call', id: 'tc-2', name: 'lookup', args: '', result: 'second', status: 'complete' },
        { type: 'text', content: 'Final check.' },
        { type: 'tool_call', id: 'tc-3', name: 'read', args: '', result: 'third', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tc-1', name: 'search', args: '', status: 'complete' },
        { id: 'tc-2', name: 'lookup', args: '', status: 'complete' },
        { id: 'tc-3', name: 'read', args: '', status: 'complete' },
      ],
    });
  });

  it('propagates harness-reported usage from RUN_FINISHED into finalize and completeTurn', async () => {
    const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150, costUsd: 0.0021 };
    const { sessionManager, db } = await executeEvents([
      { type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1', usage },
    ]);

    expect(db.finalizeTurnIfOpen).toHaveBeenCalledWith('run-1', expect.objectContaining({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      costUsd: 0.0021,
    }), expectedDeliveryFence());
    expect(sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'completed',
      expect.any(Number),
      undefined,
      usage,
    );
  });

  it('calls completeSession after a successful turn', async () => {
    const { sessionManager } = await executeEvents([
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', delta: 'ok' },
      { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
    ]);

    expect(sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'completed',
      expect.any(Number),
      undefined,
      undefined,
    );
  });

  it('marks the run as errored when a RUN_ERROR event is streamed', async () => {
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', delta: 'partial' },
      { type: 'RUN_ERROR', timestamp: 2, runId: 'run-1', error: 'tool execution failed' },
      { type: 'RUN_ERROR', timestamp: 3, runId: 'run-1' },
    ];

    const { sessionManager } = await executeEvents(events);

    expect(sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'error',
      expect.any(Number),
      'tool execution failed',
      undefined,
    );
  });

  it('uses a fallback error message when RUN_ERROR is streamed without detail', async () => {
    const { sessionManager } = await executeEvents([{ type: 'RUN_ERROR', timestamp: 1, runId: 'run-1' }]);

    expect(sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'error',
      expect.any(Number),
      'Turn completed with errors (no detail captured)',
      undefined,
    );
  });

  it('keeps the session active on INTERRUPT_REQUESTED and completes normally', async () => {
    const { sessionManager } = await executeEvents([
      { type: 'INTERRUPT_REQUESTED', timestamp: 1, runId: 'run-1', reason: 'approval_required' },
      { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
    ]);

    expect(sessionManager.completeTurn).toHaveBeenCalled();
  });

  it('completes successfully without an in-process learner', async () => {
    const { sessionManager } = await executeEvents([{ type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1' }]);

    expect(sessionManager.completeTurn).toHaveBeenCalled();
  });

  it('does not complete a turn when the stream ends with a running tool call', async () => {
    const { db, sessionManager } = await executeEvents([
      {
        type: 'TOOL_CALL_START',
        timestamp: 1,
        runId: 'run-1',
        toolCallId: 'tc-running',
        toolName: 'bash',
        args: { command: 'sleep 300' },
      },
    ]);

    expect(db.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        toolCalls: [
          expect.objectContaining({
            id: 'tc-running',
            status: 'error',
            error: expect.stringContaining('still running'),
          }),
        ],
        parts: [
          expect.objectContaining({
            type: 'tool_call',
            id: 'tc-running',
            status: 'error',
            error: expect.stringContaining('still running'),
          }),
        ],
      }),
      expectedDeliveryFence(),
    );
    expect(db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        error: expect.stringContaining('running tool call'),
      }),
      expectedDeliveryFence(),
    );
    expect(sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'error',
      expect.any(Number),
      expect.stringContaining('running tool call'),
      undefined,
    );
  });

  it('repairs already-persisted running tool calls when a later error ends the turn', async () => {
    const runningToolCalls = [
      { id: 'tc-persisted', name: 'bash', args: '{}', status: 'running' },
    ];
    const runningParts = [
      { type: 'tool_call', id: 'tc-persisted', name: 'bash', args: '{}', status: 'running' },
    ];
    const db = {
      addMessage: vi.fn().mockResolvedValue({ id: 'msg-persisted' }),
      updateTurn: vi.fn().mockResolvedValue(undefined),
      finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
      getTurn: vi.fn().mockResolvedValue({ id: 'run-1', sandboxSessionId: 'sandbox-1' }),
      getMessages: vi.fn().mockResolvedValue([
        {
          id: 'msg-persisted',
          turnId: 'run-1',
          toolCalls: runningToolCalls,
          parts: runningParts,
        },
      ]),
      stageAssistantMessageUpdate: vi.fn().mockResolvedValue({
        id: 'msg-persisted',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        turnId: 'run-1',
        messageSeq: 0,
        messageRevision: 1,
        publishedRevision: 0,
        role: 'assistant',
        content: 'Final response',
        toolCallId: null,
        toolCalls: runningToolCalls,
        parts: runningParts,
        createdAt: 1,
      }),
    };

    await executeEvents([
      makeCommittedEvent({
        toolCalls: runningToolCalls,
        parts: runningParts,
      }),
      { type: 'RUN_ERROR', timestamp: 2, runId: 'run-1', error: 'stream ended without terminal frame' },
    ], { deps: { db } });

    expect(db.stageAssistantMessageUpdate).toHaveBeenCalledWith(
      'msg-persisted',
      [
        expect.objectContaining({
          id: 'tc-persisted',
          status: 'error',
          error: expect.stringContaining('still running'),
        }),
      ],
      [
        expect.objectContaining({
          type: 'tool_call',
          id: 'tc-persisted',
          status: 'error',
          error: expect.stringContaining('still running'),
        }),
      ],
      expectedDeliveryFence(),
    );
  });

  it('completes the run with error status when sandbox streaming throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const thrown = new TypeError('Cannot read properties of undefined');
    async function* failingStream() {
      yield* eventStream([]);
      throw thrown;
    }

    const eventBus = createEventBusMock();
    const { deps, sessionTurnService, sessionManager } = createDeps({ eventBus });
    sessionTurnService.executeSessionTurn.mockReturnValue(failingStream());

    const service = new AgentTurnService(deps);
    await service.executeTurn(makeParams());

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'error',
      expect.any(Number),
      'Cannot read properties of undefined',
      undefined,
    );
    expect(eventBus.emit).not.toHaveBeenCalledWith('ag_ui.event', expect.anything());
  });

  describe('empty successful streams (ctx-w03u)', () => {
    it('closes a provably empty successful stream as an error, never a completed turn', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const ctx = await executeEvents([
        { type: 'RUN_STARTED', timestamp: 1, runId: 'run-1' },
        { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
      ]);

      expect(ctx.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          status: 'error',
          error: expect.stringContaining('without any assistant output'),
        }),
        expectedDeliveryFence(),
      );
      expect(ctx.db.addCanonicalMessage).not.toHaveBeenCalled();
    });

    it('does not flag a stream whose RUN_FINISHED reported real usage', async () => {
      const ctx = await executeEvents([
        { type: 'RUN_STARTED', timestamp: 1, runId: 'run-1' },
        {
          type: 'RUN_FINISHED',
          timestamp: 2,
          runId: 'run-1',
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        },
      ]);

      expect(ctx.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'completed' }),
        expectedDeliveryFence(),
      );
    });

    it('keeps a text-producing stream completing normally', async () => {
      const ctx = await executeEvents([
        { type: 'RUN_STARTED', timestamp: 1, runId: 'run-1' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'run-1', delta: 'hello' },
        makeCommittedEvent({ content: 'hello' }),
        { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
      ]);

      expect(ctx.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'completed' }),
        expectedDeliveryFence(),
      );
    });

    it('refuses to persist a committed message with an unknown role and errors the turn', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const ctx = await executeEvents([
        { type: 'RUN_STARTED', timestamp: 1, runId: 'run-1' },
        makeCommittedEvent({ role: 'narrator' as never, content: 'not yours to say' }),
        { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
      ]);

      expect(ctx.db.addCanonicalMessage).not.toHaveBeenCalled();
      expect(ctx.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          status: 'error',
          error: expect.stringContaining("unknown role 'narrator'"),
        }),
        expectedDeliveryFence(),
      );
      // The original payload must survive in telemetry, not be coerced.
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('original payload preserved'),
        expect.stringContaining('not yours to say'),
      );
    });
  });

  describe('event bus integration', () => {
    it('does not forward streamed RUN_FINISHED as ag_ui.event because turn completion is emitted canonically after finalize', async () => {
      const eventBus = createEventBusMock();
      const { sessionManager } = await executeEvents(
        [
          { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', delta: 'ok' },
          { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
        ],
        { deps: { eventBus } },
      );

      expect(eventBus.emit).not.toHaveBeenCalledWith('ag_ui.event', expect.objectContaining({
        event: expect.objectContaining({ type: 'RUN_FINISHED' }),
      }));
      expect(sessionManager.completeTurn).toHaveBeenCalledWith(
        'sandbox-1',
        'run-1',
        'agent-1',
        'conv-1',
        'completed',
        expect.any(Number),
        undefined,
        undefined,
      );
    });

    it('emits message.committed when assistant text is flushed at RUN_FINISHED without a sandbox commit event', async () => {
      const eventBus = createEventBusMock();
      await executeEvents([
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'msg-1', delta: 'Hello ' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'run-1', messageId: 'msg-1', delta: 'world' },
        { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
      ], { deps: { eventBus } });

      expect(eventBus.emit).toHaveBeenCalledWith('message.committed', expect.objectContaining({
        turnId: 'run-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello world',
        parts: [{ type: 'text', content: 'Hello world' }],
      }));
    });

    it('retries the same inserted message before terminal finalization when canonical persistence fails once', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const order: string[] = [];
      const row = {
        id: 'stable-message-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        turnId: 'run-1',
        messageSeq: 0,
        messageRevision: 0,
        publishedRevision: -1,
        role: 'assistant',
        content: 'Final response',
        parts: [],
        toolCalls: null,
        toolCallId: null,
        createdAt: 1,
      };
      let attempts = 0;
      const eventBus = new TypedEventBus({
        persistEvent: vi.fn(async (eventName) => {
          if (eventName !== 'message.committed') return;
          attempts++;
          order.push(`message-${attempts}`);
          if (attempts === 1) {
            throw new Error('injected event-store failure');
          }
          row.publishedRevision = 0;
        }),
      });
      const addCanonicalMessage = vi.fn().mockResolvedValue(row);
      const finalizeTurnIfOpen = vi.fn().mockImplementation(async () => {
        order.push('terminal');
        return true;
      });

      const { db } = await executeEvents([
        makeCommittedEvent(),
        { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
      ], {
        deps: {
          eventBus,
          db: {
            addMessage: addCanonicalMessage,
            addCanonicalMessage,
            updateTurn: vi.fn().mockResolvedValue(undefined),
            finalizeTurnIfOpen,
            getMessage: vi.fn().mockImplementation(async () => row),
            getMessagesPendingCanonicalPublish: vi.fn().mockImplementation(
              async () => row.publishedRevision < row.messageRevision ? [row] : [],
            ),
          },
        },
      });

      expect(db.addCanonicalMessage).toHaveBeenCalledTimes(1);
      expect(attempts).toBe(2);
      expect(order).toEqual(['message-1', 'message-2', 'terminal']);
      expect(finalizeTurnIfOpen).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'completed', error: null }),
        expectedDeliveryFence(),
      );
    });

    it('leaves the turn open when a canonical message still cannot publish', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const row = {
        id: 'stable-message-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        turnId: 'run-1',
        messageSeq: 0,
        messageRevision: 0,
        publishedRevision: -1,
        role: 'assistant',
        content: 'Final response',
        parts: [],
        toolCalls: null,
        toolCallId: null,
        createdAt: 1,
      };
      const eventBus = new TypedEventBus({
        persistEvent: vi.fn(async (eventName) => {
          if (eventName === 'message.committed') {
            throw new Error('persistent event-store failure');
          }
        }),
      });
      const addCanonicalMessage = vi.fn().mockResolvedValue(row);
      const finalizeTurnIfOpen = vi.fn().mockResolvedValue(true);

      const { db, sessionManager } = await executeEvents([
        makeCommittedEvent(),
        { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
      ], {
        deps: {
          eventBus,
          db: {
            addMessage: addCanonicalMessage,
            addCanonicalMessage,
            updateTurn: vi.fn().mockResolvedValue(undefined),
            finalizeTurnIfOpen,
            getMessage: vi.fn().mockImplementation(async () => row),
            getMessagesPendingCanonicalPublish: vi.fn().mockResolvedValue([row]),
          },
        },
      });

      expect(db.addCanonicalMessage).toHaveBeenCalledTimes(1);
      expect(finalizeTurnIfOpen).not.toHaveBeenCalled();
      expect(sessionManager.completeTurn).not.toHaveBeenCalled();
    });

    it('emits message.committed when assistant/tool preview state is flushed before final completion', async () => {
      const eventBus = new TypedEventBus();
      const committedMessages = collectEvents(eventBus, 'message.committed');

      await executeEvents([
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', delta: 'Let me check.' },
        { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search' },
        { type: 'TOOL_CALL_ARGS', timestamp: 3, runId: 'run-1', toolCallId: 'tc-1', args: '{"q":"test"}' },
        { type: 'TOOL_CALL_END', timestamp: 4, runId: 'run-1', toolCallId: 'tc-1' },
        { type: 'TOOL_CALL_RESULT', timestamp: 5, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search', result: 'Found 3 results', durationMs: 42 },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 6, runId: 'run-1', messageId: 'm1', delta: 'Based on the results:' },
        makeCommittedEvent({ timestamp: 7, content: 'Based on the results:' }),
        { type: 'RUN_FINISHED', timestamp: 8, runId: 'run-1' },
      ], { deps: { eventBus } });

      expect(committedMessages).toHaveLength(3);
      expect(committedMessages[0]).toMatchObject({
        role: 'assistant',
        content: 'Let me check.',
      });
      expect(committedMessages[1]).toMatchObject({
        role: 'tool',
        content: 'Found 3 results',
        toolCallId: 'tc-1',
      });
      expect(committedMessages[2]).toMatchObject({
        role: 'assistant',
        content: 'Based on the results:',
      });
    });

    it('emits message.delta for each TEXT_MESSAGE_CONTENT event', async () => {
      const eventBus = new TypedEventBus();
      const textChunks = collectEvents(eventBus, 'message.delta');
      const events: StreamEvent[] = [
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'msg-1', delta: 'chunk1' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'run-1', messageId: 'msg-1', delta: 'chunk2' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'run-1', messageId: 'msg-1', delta: 'chunk3' },
      ];

      await executeEvents(events, { deps: { eventBus } });

      expect(textChunks).toHaveLength(3);
      expect(textChunks.map((chunk) => chunk.delta)).toEqual(['chunk1', 'chunk2', 'chunk3']);
      expect(textChunks.map((chunk) => chunk.messageId)).toEqual(['msg-1', 'msg-1', 'msg-1']);
      for (const chunk of textChunks) {
        expect(chunk.turnId).toBe('run-1');
        expect(chunk.agentId).toBe('agent-1');
        expect(typeof chunk.timestamp).toBe('number');
      }
    });

    it('synthesizes a canonical message.delta messageId when the harness omits it', async () => {
      const eventBus = new TypedEventBus();
      const textChunks = collectEvents(eventBus, 'message.delta');

      await executeEvents(
        [{ type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', delta: 'no-id' }],
        { deps: { eventBus } },
      );

      expect(textChunks).toHaveLength(1);
      expect(textChunks[0].messageId).toBe('run-1-m1');
    });

    it('emits tool_call.started for TOOL_CALL_START events', async () => {
      const eventBus = new TypedEventBus();
      const toolStarted = collectEvents(eventBus, 'tool_call.started');

      await executeEvents([
        {
          type: 'TOOL_CALL_START',
          timestamp: 1,
          runId: 'run-1',
          toolCallId: 'tc-1',
          toolName: 'search',
          args: { query: 'alpha' },
        },
      ], { deps: { eventBus } });

      expect(toolStarted).toEqual([
        expect.objectContaining({
          turnId: 'run-1',
          agentId: 'agent-1',
          toolCallId: 'tc-1',
          toolName: 'search',
          args: { query: 'alpha' },
        }),
      ]);
    });

    it('emits truncated tool_call.completed payloads for TOOL_CALL_RESULT events', async () => {
      const eventBus = new TypedEventBus();
      const toolResults = collectEvents(eventBus, 'tool_call.completed');
      const longResult = 'x'.repeat(1000);

      await executeEvents([
        {
          type: 'TOOL_CALL_RESULT',
          timestamp: 1,
          runId: 'run-1',
          toolCallId: 'tc-1',
          toolName: 'search',
          result: longResult,
          durationMs: 25,
        },
      ], { deps: { eventBus } });

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).toMatchObject({
        toolCallId: 'tc-1',
        toolName: 'search',
        durationMs: 25,
      });
      expect(toolResults[0].result).toHaveLength(500);
      expect(toolResults[0].result).toBe('x'.repeat(500));
    });

    it('backfills tool_call.completed toolName from the matching TOOL_CALL_START event', async () => {
      const eventBus = new TypedEventBus();
      const toolResults = collectEvents(eventBus, 'tool_call.completed');

      await executeEvents([
        {
          type: 'TOOL_CALL_START',
          timestamp: 1,
          runId: 'run-1',
          toolCallId: 'tc-1',
          toolName: 'search',
          args: { query: 'alpha' },
        },
        {
          type: 'TOOL_CALL_RESULT',
          timestamp: 2,
          runId: 'run-1',
          toolCallId: 'tc-1',
          result: 'ok',
          durationMs: 12,
        },
      ], { deps: { eventBus } });

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolName).toBe('search');
    });

    it('uses an empty string for tool_call.completed toolName when no start event is available', async () => {
      const eventBus = new TypedEventBus();
      const toolResults = collectEvents(eventBus, 'tool_call.completed');

      await executeEvents([
        {
          type: 'TOOL_CALL_RESULT',
          timestamp: 1,
          runId: 'run-1',
          toolCallId: 'tc-missing',
          result: 'ok',
          durationMs: 12,
        },
      ], { deps: { eventBus } });

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolName).toBe('');
    });

    it('does not throw when eventBus is not provided', async () => {
      const events: StreamEvent[] = [
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', delta: 'hi' },
        { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'x' },
        { type: 'TOOL_CALL_RESULT', timestamp: 3, runId: 'run-1', toolCallId: 'tc-1', result: 'y', durationMs: 1 },
      ];

      await expect(executeEvents(events)).resolves.toBeDefined();
    });
  });

  describe('AbortSignal cancellation', () => {
    it('stops streaming when the real turn registry aborts the turn and skips completion', async () => {
      const eventBus = new TypedEventBus();
      const registry = new TestTurnRegistry(eventBus);
      const completeTurnSpy = vi.spyOn(registry, 'completeTurn');
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive', 'test task');

      let yieldCount = 0;
      let gateResolve: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        gateResolve = resolve;
      });

      async function* cancellableStream(
        _agentDef: AgentDefinition,
        _conversationId: string,
        _messages: Message[],
        _turnId: string,
        options?: { signal?: AbortSignal },
      ) {
        const signal = options?.signal;
        const chunks = ['one', 'two', 'three'];
        for (const [index, chunk] of chunks.entries()) {
          if (signal?.aborted) {
            return;
          }
          yieldCount += 1;
          yield {
            type: 'TEXT_MESSAGE_CONTENT',
            timestamp: Date.now(),
            runId: turn.turnId,
            messageId: 'm1',
            delta: chunk,
          } satisfies AgentSessionEvent;
          if (index === 1) {
            await gate;
          }
        }
      }

      const service = new AgentTurnService(createDeps({
        eventBus,
        sessionManager: createTestSandboxSessionManager(registry) as unknown as MockSessionManager,
        sessionTurnService: {
          executeSessionTurn: vi.fn().mockImplementation(cancellableStream),
        },
      }).deps);

      const turnPromise = service.executeTurn(makeParams({ turnId: turn.turnId }));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await registry.cancelTurn(turn.turnId);
      gateResolve?.();
      await turnPromise;

      expect(yieldCount).toBe(2);
      expect(completeTurnSpy).not.toHaveBeenCalled();
      expect(registry.getTurn(turn.turnId)?.status).toBe('cancelled');
    });

     it('persists committed messages that arrive before cancellation', async () => {
       const eventBus = new TypedEventBus();
       const registry = new TestTurnRegistry(eventBus);
       const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive', 'test task');
       const db = {
         addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
         updateTurn: vi.fn().mockResolvedValue(undefined),
         finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
       };

      let gateResolve: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        gateResolve = resolve;
      });

      async function* committedThenWait(
        _agentDef: AgentDefinition,
        _conversationId: string,
        _messages: Message[],
        _turnId: string,
        options?: { signal?: AbortSignal },
      ) {
        const signal = options?.signal;
        yield makeCommittedEvent({
          runId: turn.turnId,
          turnId: turn.turnId,
          content: 'Committed before cancel',
        });
        await gate;
        if (signal?.aborted) {
          return;
        }
        yield makeCommittedEvent({
          runId: turn.turnId,
          turnId: turn.turnId,
          content: 'Should not persist',
          messageSeq: 2,
        });
      }

      const service = new AgentTurnService(createDeps({
        db,
        eventBus,
        sessionManager: createTestSandboxSessionManager(registry) as unknown as MockSessionManager,
        sessionTurnService: {
          executeSessionTurn: vi.fn().mockImplementation(committedThenWait),
        },
      }).deps);

      const turnPromise = service.executeTurn(makeParams({ turnId: turn.turnId }));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await registry.cancelTurn(turn.turnId);
      gateResolve?.();
      await turnPromise;

      expect(db.addMessage).toHaveBeenCalledTimes(1);
      expect(db.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'Committed before cancel',
          toolCalls: undefined,
          toolCallId: undefined,
        }),
        expectedDeliveryFence(),
      );
    });

    it('emits turn.completed with cancelled status when TestTurnRegistry.cancelTurn is called', async () => {
      const eventBus = new TypedEventBus();
      const completedEvents = collectEvents(eventBus, 'turn.completed');
      const registry = new TestTurnRegistry(eventBus);
      const turn = await registry.startTurn('agent-1', 'conv-1', 'interactive', 'test');

      await registry.cancelTurn(turn.turnId);

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({
        turnId: turn.turnId,
        sandboxSessionId: turn.sandboxSessionId,
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'cancelled',
      });
      expect(typeof completedEvents[0].durationMs).toBe('number');
    });
  });

  describe('AG-UI event payload shape', () => {
    it('turn.completed payload contains required fields when no sandbox session exists', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const eventBus = createEventBusMock();
      const sessionManager = {
        ensureSession: vi.fn().mockResolvedValue({ sessionId: undefined }),
        startTurn: vi.fn().mockReturnValue(undefined),
        completeTurn: vi.fn().mockResolvedValue(undefined),
      };

      await executeEvents([
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', delta: 'ok' },
        { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
      ], {
        deps: { eventBus, sessionManager },
      });

      expect(eventBus.emit).toHaveBeenCalledWith(
        'turn.completed',
        expect.objectContaining({
          turnId: 'run-1',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          status: 'completed',
          error: undefined,
          durationMs: expect.any(Number),
          timestamp: expect.any(Number),
        }),
      );
      expect(sessionManager.completeTurn).not.toHaveBeenCalled();
    });

    it('preserves original event fields when emitting ag_ui.event', async () => {
      const originalEvent = {
        type: 'RUN_STARTED',
        timestamp: 12345,
        runId: 'run-1',
        customField: 'should-be-preserved',
      } satisfies AgentSessionEvent;

      const eventBus = createEventBusMock();
      await executeEvents([originalEvent], { deps: { eventBus } });

      const forwardedPayload = eventBus.emit.mock.calls.find(([eventName]) => eventName === 'ag_ui.event')?.[1] as {
        event: Record<string, unknown>;
      };
      expect(forwardedPayload.event.customField).toBe('should-be-preserved');
      expect(forwardedPayload.event.timestamp).toBe(12345);
    });
  });
});
