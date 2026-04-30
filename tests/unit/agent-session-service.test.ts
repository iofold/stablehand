import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSessionService } from '../../packages/ctxmill/src/orchestrator/agent-session-service.js';
import type {
  AgentSessionServiceDeps,
  ExecuteSessionParams,
} from '../../packages/ctxmill/src/orchestrator/agent-session-service.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import type { EventMap } from '../../packages/ctxmill/src/events/bus.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import type { SSEManager } from '../../packages/ctxmill/src/orchestrator/sse.js';
import type { SessionTurnService } from '../../packages/ctxmill/src/orchestrator/session-turn-service.js';
import type { AgentDefinition, Message } from '../../packages/ctxmill/src/types.js';
import type { AGUIEvent, MessageCommittedEvent } from '../../packages/shared/src/events.js';
import { TestSessionRegistry, createTestSessionManager } from '../utils/test-session-registry.js';

type StreamEvent = AGUIEvent | MessageCommittedEvent;

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
};

function createEventBusMock(): MockEventBus {
  return {
    emit: vi.fn(),
  } as unknown as MockEventBus;
}

function makeAgentDef(): AgentDefinition {
  return {
    name: 'test-agent',
    harness: 'claude-agents',
    harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
    systemPrompt: 'You are a test agent. {{knowledge}}',
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

function makeParams(overrides: Partial<ExecuteSessionParams> = {}): ExecuteSessionParams {
  return {
    agentDef: makeAgentDef(),
    messages: makeMessages(),
    agentId: 'agent-1',
    conversationId: 'conv-1',
    sessionId: 'run-1',
    mode: 'interactive',
    taskDescription: 'test task',
    ...overrides,
  };
}

type MockSessionManager = {
  ensureSession: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  completeTurn: ReturnType<typeof vi.fn>;
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
  sse?: { broadcast: ReturnType<typeof vi.fn> };
  db?: {
    addMessage: ReturnType<typeof vi.fn>;
    updateTurn: ReturnType<typeof vi.fn>;
    updateMessageToolCalls?: ReturnType<typeof vi.fn>;
  };
  sessionManager?: MockSessionManager;
  eventBus?: TypedEventBus;
} = {}) {
  const sessionTurnService = overrides.sessionTurnService ?? {
    executeSessionTurn: vi.fn(),
  };
  const sse = overrides.sse ?? {
    broadcast: vi.fn(),
  };
  const db = {
    addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    updateTurn: vi.fn().mockResolvedValue(undefined),
    updateMessageToolCalls: vi.fn().mockResolvedValue(undefined),
    ...overrides.db,
  };
  const sessionManager = overrides.sessionManager ?? {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'sandbox-1' }),
    startTurn: vi.fn().mockReturnValue(undefined),
    completeTurn: vi.fn().mockResolvedValue(undefined),
  };
  const eventBus = overrides.eventBus;

  const deps: AgentSessionServiceDeps = {
    sessionTurnService: sessionTurnService as unknown as SessionTurnService,
    sse: sse as unknown as SSEManager,
    db: db as unknown as DatabaseRepository,
    sessionManager: sessionManager as unknown as AgentSessionServiceDeps['sessionManager'],
    eventBus,
  };

  return { deps, sessionTurnService, sse, db, sessionManager, eventBus };
}

type ExecuteEventsOptions = {
  deps?: Parameters<typeof createDeps>[0];
  params?: Partial<ExecuteSessionParams>;
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
  const service = new AgentSessionService(ctx.deps);
  await service.executeSession(params);
  return { ...ctx, params, service };
}

describe('AgentSessionService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls executeSessionTurn with conversation turn inputs and abort signal', async () => {
    const abortController = new AbortController();
    const { params, sessionTurnService, db } = await executeEvents([], {
      configure: ({ sessionManager }) => {
        sessionManager.startTurn.mockReturnValue(abortController.signal);
      },
    });

    expect(db.updateTurn).toHaveBeenCalledWith('run-1', { sessionId: 'sandbox-1' });

    expect(sessionTurnService.executeSessionTurn).toHaveBeenCalledWith(
      params.agentDef,
      params.conversationId,
      params.messages,
      params.sessionId,
      abortController.signal,
      params.agentId,
      'sandbox-1',
    );
  });

  it('emits run.ag_ui_event for streamed events not handled individually', async () => {
    const events: StreamEvent[] = [
      { type: 'RUN_STARTED', timestamp: 1, runId: 'run-1' },
      { type: 'TEXT_MESSAGE_START', timestamp: 2, runId: 'run-1', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'run-1', messageId: 'm1', content: 'Hi' },
      makeCommittedEvent({ timestamp: 4, content: 'Hi' }),
      { type: 'RUN_FINISHED', timestamp: 5, runId: 'run-1' },
    ];

    const individuallyHandled = new Set(['TEXT_MESSAGE_CONTENT', 'TOOL_CALL_START', 'TOOL_CALL_RESULT', 'MESSAGE_COMMITTED', 'RUN_ERROR', 'RUN_FINISHED']);
    const forwardedEvents = events.filter((event) => !individuallyHandled.has(event.type));

    const eventBus = createEventBusMock();
    await executeEvents(events, { deps: { eventBus } });

    const agUiEventCalls = eventBus.emit.mock.calls.filter(([eventName]) => eventName === 'run.ag_ui_event');
    expect(agUiEventCalls).toHaveLength(forwardedEvents.length);
    for (const [index, event] of forwardedEvents.entries()) {
      expect(agUiEventCalls[index]).toEqual([
        'run.ag_ui_event',
        expect.objectContaining({
          turnId: 'run-1',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          event,
          timestamp: expect.any(Number),
        }),
      ]);
    }
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
    expect(db.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Hello world',
      toolCalls: undefined,
      toolCallId: undefined,
    }));
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

    expect(db.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'tool',
      content: '{"ok":true}',
      toolCalls: [],
      toolCallId: 'tool-call-1',
    }));
  });

  it('flushes accumulated assistant text when the stream ends without MESSAGE_COMMITTED', async () => {
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', content: 'Hello ' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'run-1', messageId: 'm1', content: 'world' },
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
    ];

    const { db } = await executeEvents(events);

    expect(db.addMessage).toHaveBeenCalledTimes(1);
    expect(db.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Hello world',
      toolCalls: undefined,
      toolCallId: undefined,
      parts: [{ type: 'text', content: 'Hello world' }],
    }));
  });

  it('flushes pending tool-call state when the stream ends before a result arrives', async () => {
    const events: StreamEvent[] = [
      { type: 'TOOL_CALL_START', timestamp: 1, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search' },
      { type: 'TOOL_CALL_END', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1' },
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
    ];

    const { db } = await executeEvents(events);

    expect(db.addMessage).toHaveBeenCalledTimes(1);
    expect(db.addMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: '',
      toolCallId: undefined,
      parts: [{ type: 'tool_call', id: 'tc-1', name: 'search', args: '', status: 'complete' }],
      toolCalls: [{ id: 'tc-1', name: 'search', args: '', status: 'complete' }],
    }));
  });

  it('persists assistant and tool messages separately for tool-use turns', async () => {
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', content: 'Let me check.' },
      { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search' },
      { type: 'TOOL_CALL_ARGS', timestamp: 3, runId: 'run-1', toolCallId: 'tc-1', args: '{"q":"test"}' },
      { type: 'TOOL_CALL_END', timestamp: 4, runId: 'run-1', toolCallId: 'tc-1' },
      { type: 'TOOL_CALL_RESULT', timestamp: 5, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search', result: 'Found 3 results', durationMs: 42 },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 6, runId: 'run-1', messageId: 'm1', content: 'Based on the results:' },
      makeCommittedEvent({ timestamp: 7, content: 'Based on the results:' }),
      { type: 'RUN_FINISHED', timestamp: 8, runId: 'run-1' },
    ];

    const { db } = await executeEvents(events);

    expect(db.addMessage).toHaveBeenCalledTimes(3);
    expect(db.addMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
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
    }));
    const firstCall = (db.addMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCall.parts).toHaveLength(2);
    expect(firstCall.parts[0]).toEqual({ type: 'text', content: 'Let me check.' });
    expect(firstCall.parts[1]).toMatchObject({ type: 'tool_call', id: 'tc-1', name: 'search', status: 'complete' });
    expect(db.addMessage).toHaveBeenNthCalledWith(2, {
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'tool',
      content: 'Found 3 results',
      toolCalls: undefined,
      toolCallId: 'tc-1',
    });
    expect(db.addMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Based on the results:',
    }));
  });

  it('calls completeSession after a successful turn', async () => {
    const { sessionManager } = await executeEvents([{ type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1' }]);

    expect(sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'completed',
      expect.any(Number),
      undefined,
    );
  });

  it('marks the run as errored when a RUN_ERROR event is streamed', async () => {
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', content: 'partial' },
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
      'Session completed with errors (no detail captured)',
    );
  });

  it('keeps the session active on HITL_PAUSE and completes normally', async () => {
    const { sessionManager } = await executeEvents([
      { type: 'HITL_PAUSE', timestamp: 1, runId: 'run-1', reason: 'approval_required' },
      { type: 'RUN_FINISHED', timestamp: 2, runId: 'run-1' },
    ]);

    expect(sessionManager.completeTurn).toHaveBeenCalled();
  });

  it('completes successfully without an in-process learner', async () => {
    const { sessionManager } = await executeEvents([{ type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1' }]);

    expect(sessionManager.completeTurn).toHaveBeenCalled();
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

    const service = new AgentSessionService(deps);
    await service.executeSession(makeParams());

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(sessionManager.completeTurn).toHaveBeenCalledWith(
      'sandbox-1',
      'run-1',
      'agent-1',
      'conv-1',
      'error',
      expect.any(Number),
      'Cannot read properties of undefined',
    );
    expect(eventBus.emit).not.toHaveBeenCalledWith('run.ag_ui_event', expect.anything());
  });

  describe('event bus integration', () => {
    it('does not forward streamed RUN_FINISHED as run.ag_ui_event because turn completion is emitted canonically after finalize', async () => {
      const eventBus = createEventBusMock();
      const { sessionManager } = await executeEvents(
        [{ type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1' }],
        { deps: { eventBus } },
      );

      expect(eventBus.emit).not.toHaveBeenCalledWith('run.ag_ui_event', expect.objectContaining({
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
      );
    });

    it('emits message.committed when assistant text is flushed at RUN_FINISHED without a sandbox commit event', async () => {
      const eventBus = createEventBusMock();
      await executeEvents([
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'msg-1', content: 'Hello ' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'run-1', messageId: 'msg-1', content: 'world' },
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

    it('emits message.committed when assistant/tool preview state is flushed before final completion', async () => {
      const eventBus = new TypedEventBus();
      const committedMessages = collectEvents(eventBus, 'message.committed');

      await executeEvents([
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', content: 'Let me check.' },
        { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search' },
        { type: 'TOOL_CALL_ARGS', timestamp: 3, runId: 'run-1', toolCallId: 'tc-1', args: '{"q":"test"}' },
        { type: 'TOOL_CALL_END', timestamp: 4, runId: 'run-1', toolCallId: 'tc-1' },
        { type: 'TOOL_CALL_RESULT', timestamp: 5, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search', result: 'Found 3 results', durationMs: 42 },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 6, runId: 'run-1', messageId: 'm1', content: 'Based on the results:' },
        makeCommittedEvent({ timestamp: 7, content: 'Based on the results:' }),
        { type: 'RUN_FINISHED', timestamp: 8, runId: 'run-1' },
      ], { deps: { eventBus } });

      expect(committedMessages).toHaveLength(2);
      expect(committedMessages[0]).toMatchObject({
        role: 'assistant',
        content: 'Let me check.',
      });
      expect(committedMessages[1]).toMatchObject({
        role: 'assistant',
        content: 'Based on the results:',
      });
    });

    it('emits run.text_chunk for each TEXT_MESSAGE_CONTENT event', async () => {
      const eventBus = new TypedEventBus();
      const textChunks = collectEvents(eventBus, 'run.text_chunk');
      const events: StreamEvent[] = [
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'msg-1', content: 'chunk1' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'run-1', messageId: 'msg-1', content: 'chunk2' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'run-1', messageId: 'msg-1', content: 'chunk3' },
      ];

      await executeEvents(events, { deps: { eventBus } });

      expect(textChunks).toHaveLength(3);
      expect(textChunks.map((chunk) => chunk.content)).toEqual(['chunk1', 'chunk2', 'chunk3']);
      expect(textChunks.map((chunk) => chunk.messageId)).toEqual(['msg-1', 'msg-1', 'msg-1']);
      for (const chunk of textChunks) {
        expect(chunk.turnId).toBe('run-1');
        expect(chunk.agentId).toBe('agent-1');
        expect(typeof chunk.timestamp).toBe('number');
      }
    });

    it('uses an empty string for run.text_chunk messageId when absent', async () => {
      const eventBus = new TypedEventBus();
      const textChunks = collectEvents(eventBus, 'run.text_chunk');

      await executeEvents(
        [{ type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', content: 'no-id' }],
        { deps: { eventBus } },
      );

      expect(textChunks).toHaveLength(1);
      expect(textChunks[0].messageId).toBe('');
    });

    it('emits run.tool_started for TOOL_CALL_START events', async () => {
      const eventBus = new TypedEventBus();
      const toolStarted = collectEvents(eventBus, 'run.tool_started');

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

    it('emits truncated run.tool_result payloads for TOOL_CALL_RESULT events', async () => {
      const eventBus = new TypedEventBus();
      const toolResults = collectEvents(eventBus, 'run.tool_result');
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

    it('uses an empty string for run.tool_result toolName when absent', async () => {
      const eventBus = new TypedEventBus();
      const toolResults = collectEvents(eventBus, 'run.tool_result');

      await executeEvents([
        {
          type: 'TOOL_CALL_RESULT',
          timestamp: 1,
          runId: 'run-1',
          toolCallId: 'tc-1',
          result: 'ok',
          durationMs: 12,
        },
      ], { deps: { eventBus } });

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolName).toBe('');
    });

    it('does not throw when eventBus is not provided', async () => {
      const events: StreamEvent[] = [
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', content: 'hi' },
        { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'x' },
        { type: 'TOOL_CALL_RESULT', timestamp: 3, runId: 'run-1', toolCallId: 'tc-1', result: 'y', durationMs: 1 },
      ];

      await expect(executeEvents(events)).resolves.toBeDefined();
    });
  });

  describe('AbortSignal cancellation', () => {
    it('stops streaming when the real SessionRegistry aborts the run and skips completion', async () => {
      const eventBus = new TypedEventBus();
      const registry = new TestSessionRegistry(undefined, eventBus);
      const completeRunSpy = vi.spyOn(registry, 'completeSession');
      const run = await registry.startSession('agent-1', 'conv-1', 'interactive', 'test task');

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
        signal?: AbortSignal,
      ) {
        const chunks = ['one', 'two', 'three'];
        for (const [index, chunk] of chunks.entries()) {
          if (signal?.aborted) {
            return;
          }
          yieldCount += 1;
          yield {
            type: 'TEXT_MESSAGE_CONTENT',
            timestamp: Date.now(),
            runId: run.id,
            messageId: 'm1',
            content: chunk,
          } satisfies AGUIEvent;
          if (index === 1) {
            await gate;
          }
        }
      }

      const service = new AgentSessionService(createDeps({
        eventBus,
        sessionManager: createTestSessionManager(registry) as unknown as MockSessionManager,
        sessionTurnService: {
          executeSessionTurn: vi.fn().mockImplementation(cancellableStream),
        },
      }).deps);

      const runPromise = service.executeSession(makeParams({ sessionId: run.id }));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await registry.cancelSession(run.id);
      gateResolve?.();
      await runPromise;

      expect(yieldCount).toBe(2);
      expect(completeRunSpy).not.toHaveBeenCalled();
      expect(registry.getSession(run.id)?.status).toBe('cancelled');
    });

     it('persists committed messages that arrive before cancellation', async () => {
       const eventBus = new TypedEventBus();
       const registry = new TestSessionRegistry(undefined, eventBus);
       const run = await registry.startSession('agent-1', 'conv-1', 'interactive', 'test task');
       const db = {
         addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
         updateTurn: vi.fn().mockResolvedValue(undefined),
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
        signal?: AbortSignal,
      ) {
        yield makeCommittedEvent({
          runId: run.id,
          turnId: run.id,
          content: 'Committed before cancel',
        });
        await gate;
        if (signal?.aborted) {
          return;
        }
        yield makeCommittedEvent({
          runId: run.id,
          turnId: run.id,
          content: 'Should not persist',
          messageSeq: 2,
        });
      }

      const service = new AgentSessionService(createDeps({
        db,
        eventBus,
        sessionManager: createTestSessionManager(registry) as unknown as MockSessionManager,
        sessionTurnService: {
          executeSessionTurn: vi.fn().mockImplementation(committedThenWait),
        },
      }).deps);

      const runPromise = service.executeSession(makeParams({ sessionId: run.id }));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await registry.cancelSession(run.id);
      gateResolve?.();
      await runPromise;

      expect(db.addMessage).toHaveBeenCalledTimes(1);
      expect(db.addMessage).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Committed before cancel',
        toolCalls: undefined,
        toolCallId: undefined,
      }));
    });

    it('emits turn.completed with cancelled status when SessionRegistry.cancelSession is called', async () => {
      const eventBus = new TypedEventBus();
      const completedEvents = collectEvents(eventBus, 'turn.completed');
      const registry = new TestSessionRegistry(undefined, eventBus);
      const run = await registry.startSession('agent-1', 'conv-1', 'interactive', 'test');

      await registry.cancelSession(run.id);

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({
        sessionId: run.id,
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

      await executeEvents([{ type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1' }], {
        deps: { eventBus, sessionManager },
      });

      expect(eventBus.emit).toHaveBeenCalledWith(
        'turn.completed',
        expect.objectContaining({
          turnId: 'run-1',
          sessionId: '',
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

    it('preserves original event fields when emitting run.ag_ui_event', async () => {
      const originalEvent = {
        type: 'RUN_STARTED',
        timestamp: 12345,
        runId: 'run-1',
        customField: 'should-be-preserved',
      } satisfies AGUIEvent;

      const eventBus = createEventBusMock();
      await executeEvents([originalEvent], { deps: { eventBus } });

      const forwardedPayload = eventBus.emit.mock.calls.find(([eventName]) => eventName === 'run.ag_ui_event')?.[1] as {
        event: Record<string, unknown>;
      };
      expect(forwardedPayload.event.customField).toBe('should-be-preserved');
      expect(forwardedPayload.event.timestamp).toBe(12345);
    });
  });
});
