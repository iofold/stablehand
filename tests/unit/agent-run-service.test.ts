import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunService } from '../../packages/ctxmill/src/orchestrator/agent-run-service.js';
import type {
  AgentRunServiceDeps,
  ExecuteRunParams,
} from '../../packages/ctxmill/src/orchestrator/agent-run-service.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { RunRegistry } from '../../packages/ctxmill/src/orchestrator/run-registry.js';
import type { EventMap } from '../../packages/ctxmill/src/events/bus.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import type { LearningPipeline } from '../../packages/ctxmill/src/learning/types.js';
import type { SSEManager } from '../../packages/ctxmill/src/orchestrator/sse.js';
import type { SandboxRunService } from '../../packages/ctxmill/src/orchestrator/sandbox-run-service.js';
import type { AgentDefinition, Message } from '../../packages/ctxmill/src/types.js';
import type { AGUIEvent, MessageCommittedEvent } from '../../packages/shared/src/events.js';

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

function makeAgentDef(): AgentDefinition {
  return {
    name: 'test-agent',
    model: 'gpt-5-mini',
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

function makeParams(overrides: Partial<ExecuteRunParams> = {}): ExecuteRunParams {
  return {
    agentDef: makeAgentDef(),
    messages: makeMessages(),
    agentId: 'agent-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    taskDescription: 'test task',
    ...overrides,
  };
}

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
  sandboxRunService?: { executeSessionTurn: ReturnType<typeof vi.fn> };
  sse?: { broadcast: ReturnType<typeof vi.fn> };
  db?: { addMessage: ReturnType<typeof vi.fn> };
  runRegistry?: RunRegistry | {
    completeRun: ReturnType<typeof vi.fn>;
    getAbortSignal: ReturnType<typeof vi.fn>;
    pauseRun: ReturnType<typeof vi.fn>;
  };
  learningPipeline?: { process: ReturnType<typeof vi.fn> };
  eventBus?: TypedEventBus;
} = {}) {
  const sandboxRunService = overrides.sandboxRunService ?? {
    executeSessionTurn: vi.fn(),
  };
  const sse = overrides.sse ?? {
    broadcast: vi.fn(),
  };
  const db = overrides.db ?? {
    addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  };
  const runRegistry = overrides.runRegistry ?? {
    completeRun: vi.fn().mockResolvedValue(undefined),
    getAbortSignal: vi.fn().mockReturnValue(undefined),
    pauseRun: vi.fn().mockResolvedValue(undefined),
  };
  const learningPipeline = overrides.learningPipeline;
  const eventBus = overrides.eventBus;

  const deps: AgentRunServiceDeps = {
    sandboxRunService: sandboxRunService as unknown as SandboxRunService,
    sse: sse as unknown as SSEManager,
    db: db as unknown as DatabaseRepository,
    runRegistry: runRegistry as unknown as RunRegistry,
    learningPipeline: learningPipeline as LearningPipeline | undefined,
    eventBus,
  };

  return { deps, sandboxRunService, sse, db, runRegistry, learningPipeline, eventBus };
}

describe('AgentRunService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls executeSessionTurn with conversation turn inputs and abort signal', async () => {
    const abortController = new AbortController();
    const params = makeParams();
    const { deps, sandboxRunService, runRegistry } = createDeps();

    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream([]));
    if (!(runRegistry instanceof RunRegistry)) {
      runRegistry.getAbortSignal.mockReturnValue(abortController.signal);
    }

    const service = new AgentRunService(deps);
    await service.executeRun(params);

    expect(sandboxRunService.executeSessionTurn).toHaveBeenCalledWith(
      params.agentDef,
      params.conversationId,
      params.messages,
      params.runId,
      abortController.signal,
      params.agentId,
    );
  });

  it('broadcasts each streamed event to SSE', async () => {
    const events: StreamEvent[] = [
      { type: 'RUN_STARTED', timestamp: 1, runId: 'run-1' },
      { type: 'TEXT_MESSAGE_START', timestamp: 2, runId: 'run-1', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'run-1', messageId: 'm1', content: 'Hi' },
      makeCommittedEvent({ timestamp: 4, content: 'Hi' }),
      { type: 'RUN_FINISHED', timestamp: 5, runId: 'run-1' },
    ];

    const { deps, sandboxRunService, sse } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream(events));

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    expect(sse.broadcast).toHaveBeenCalledTimes(events.length);
    for (const [index, event] of events.entries()) {
      expect(sse.broadcast).toHaveBeenNthCalledWith(index + 1, 'agent-1', event);
    }
  });

  it('persists assistant MESSAGE_COMMITTED events to the database', async () => {
    const committed = makeCommittedEvent({
      role: 'assistant',
      content: 'Hello world',
      timestamp: 10,
      messageSeq: 2,
    });

    const { deps, sandboxRunService, db } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream([committed]));

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    expect(db.addMessage).toHaveBeenCalledTimes(1);
    expect(db.addMessage).toHaveBeenCalledWith({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Hello world',
      toolCalls: undefined,
      toolCallId: undefined,
    });
  });

  it('persists tool MESSAGE_COMMITTED events with tool metadata', async () => {
    const committed = makeCommittedEvent({
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'tool-call-1',
      toolCalls: [],
      messageSeq: 3,
    });

    const { deps, sandboxRunService, db } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream([committed]));

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    expect(db.addMessage).toHaveBeenCalledWith({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'tool',
      content: '{"ok":true}',
      toolCalls: [],
      toolCallId: 'tool-call-1',
    });
  });

  it('does not persist TEXT_MESSAGE_CONTENT events without MESSAGE_COMMITTED', async () => {
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'm1', content: 'Hello ' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'run-1', messageId: 'm1', content: 'world' },
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
    ];

    const { deps, sandboxRunService, db } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream(events));

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    expect(db.addMessage).not.toHaveBeenCalled();
  });

  it('does not persist TOOL_CALL lifecycle events without MESSAGE_COMMITTED', async () => {
    const events: StreamEvent[] = [
      { type: 'TOOL_CALL_START', timestamp: 1, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search' },
      { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'search', result: 'found', durationMs: 42 },
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
    ];

    const { deps, sandboxRunService, db } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream(events));

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    expect(db.addMessage).not.toHaveBeenCalled();
  });

  it('calls completeRun after a successful turn', async () => {
    const { deps, sandboxRunService, runRegistry } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream([{ type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1' }]));

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    if (runRegistry instanceof RunRegistry) {
      expect(runRegistry.getRun('run-1')).toBeUndefined();
      return;
    }
    expect(runRegistry.completeRun).toHaveBeenCalledWith('run-1');
  });

  it('marks the run as errored when a RUN_ERROR event is streamed', async () => {
    const events: StreamEvent[] = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', content: 'partial' },
      { type: 'RUN_ERROR', timestamp: 2, runId: 'run-1', error: 'tool execution failed' },
      { type: 'RUN_FAILED', timestamp: 3, runId: 'run-1' },
    ];

    const { deps, sandboxRunService, runRegistry } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream(events));

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    if (!(runRegistry instanceof RunRegistry)) {
      expect(runRegistry.completeRun).toHaveBeenCalledWith('run-1', 'tool execution failed');
    }
  });

  it('uses a fallback error message when RUN_FAILED is streamed without detail', async () => {
    const { deps, sandboxRunService, runRegistry } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(
      eventStream([{ type: 'RUN_FAILED', timestamp: 1, runId: 'run-1' }]),
    );

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    if (!(runRegistry instanceof RunRegistry)) {
      expect(runRegistry.completeRun).toHaveBeenCalledWith(
        'run-1',
        'Run completed with errors (no detail captured)',
      );
    }
  });

  it('pauses the run on HITL_PAUSE and does not complete it', async () => {
    const { deps, sandboxRunService, runRegistry } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(
      eventStream([{ type: 'HITL_PAUSE', timestamp: 1, runId: 'run-1', reason: 'approval_required' }]),
    );

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    if (!(runRegistry instanceof RunRegistry)) {
      expect(runRegistry.pauseRun).toHaveBeenCalledWith('run-1', 'approval_required');
      expect(runRegistry.completeRun).not.toHaveBeenCalled();
    }
  });

  it('calls the learning pipeline after a successful run', async () => {
    const learningPipeline = {
      process: vi.fn().mockResolvedValue([]),
    };
    const { deps, sandboxRunService } = createDeps({ learningPipeline });
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream([{ type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1' }]));

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    expect(learningPipeline.process).toHaveBeenCalledTimes(1);
    expect(learningPipeline.process).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        runId: 'run-1',
        taskDescription: 'test task',
        outcome: 'success',
        steps: [],
      }),
    );
  });

  it('does not call the learning pipeline when none is provided', async () => {
    const { deps, sandboxRunService, runRegistry } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream([{ type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1' }]));

    const service = new AgentRunService(deps);
    await expect(service.executeRun(makeParams())).resolves.toBeUndefined();

    if (!(runRegistry instanceof RunRegistry)) {
      expect(runRegistry.completeRun).toHaveBeenCalledWith('run-1');
    }
  });

  it('swallows learning pipeline errors after success', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const learningPipeline = {
      process: vi.fn().mockRejectedValue(new Error('pipeline crash')),
    };
    const { deps, sandboxRunService, runRegistry } = createDeps({ learningPipeline });
    sandboxRunService.executeSessionTurn.mockReturnValue(eventStream([{ type: 'RUN_FINISHED', timestamp: 1, runId: 'run-1' }]));

    const service = new AgentRunService(deps);
    await expect(service.executeRun(makeParams())).resolves.toBeUndefined();

    expect(learningPipeline.process).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Learning pipeline error:', expect.any(Error));
    if (!(runRegistry instanceof RunRegistry)) {
      expect(runRegistry.completeRun).toHaveBeenCalledWith('run-1');
    }
  });

  it('broadcasts RUN_ERROR and completes the run when sandbox streaming throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const thrown = new TypeError('Cannot read properties of undefined');
    async function* failingStream() {
      yield* eventStream([]);
      throw thrown;
    }

    const { deps, sandboxRunService, sse, runRegistry } = createDeps();
    sandboxRunService.executeSessionTurn.mockReturnValue(failingStream());

    const service = new AgentRunService(deps);
    await service.executeRun(makeParams());

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(sse.broadcast).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        type: 'RUN_ERROR',
        runId: 'run-1',
        error: 'TypeError: Cannot read properties of undefined',
      }),
    );
    if (!(runRegistry instanceof RunRegistry)) {
      expect(runRegistry.completeRun).toHaveBeenCalledWith(
        'run-1',
        'TypeError: Cannot read properties of undefined',
      );
    }
  });

  describe('event bus integration', () => {
    it('emits run.text_chunk for each TEXT_MESSAGE_CONTENT event', async () => {
      const eventBus = new TypedEventBus();
      const textChunks = collectEvents(eventBus, 'run.text_chunk');
      const events: StreamEvent[] = [
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', messageId: 'msg-1', content: 'chunk1' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'run-1', messageId: 'msg-1', content: 'chunk2' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'run-1', messageId: 'msg-1', content: 'chunk3' },
      ];

      const { deps, sandboxRunService } = createDeps({ eventBus });
      sandboxRunService.executeSessionTurn.mockReturnValue(eventStream(events));

      const service = new AgentRunService(deps);
      await service.executeRun(makeParams());

      expect(textChunks).toHaveLength(3);
      expect(textChunks.map((chunk) => chunk.content)).toEqual(['chunk1', 'chunk2', 'chunk3']);
      expect(textChunks.map((chunk) => chunk.messageId)).toEqual(['msg-1', 'msg-1', 'msg-1']);
      for (const chunk of textChunks) {
        expect(chunk.runId).toBe('run-1');
        expect(chunk.agentId).toBe('agent-1');
        expect(typeof chunk.timestamp).toBe('number');
      }
    });

    it('uses an empty string for run.text_chunk messageId when absent', async () => {
      const eventBus = new TypedEventBus();
      const textChunks = collectEvents(eventBus, 'run.text_chunk');

      const { deps, sandboxRunService } = createDeps({ eventBus });
      sandboxRunService.executeSessionTurn.mockReturnValue(
        eventStream([{ type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', content: 'no-id' }]),
      );

      const service = new AgentRunService(deps);
      await service.executeRun(makeParams());

      expect(textChunks).toHaveLength(1);
      expect(textChunks[0].messageId).toBe('');
    });

    it('emits run.tool_started for TOOL_CALL_START events', async () => {
      const eventBus = new TypedEventBus();
      const toolStarted = collectEvents(eventBus, 'run.tool_started');

      const { deps, sandboxRunService } = createDeps({ eventBus });
      sandboxRunService.executeSessionTurn.mockReturnValue(
        eventStream([
          {
            type: 'TOOL_CALL_START',
            timestamp: 1,
            runId: 'run-1',
            toolCallId: 'tc-1',
            toolName: 'search',
            args: { query: 'alpha' },
          },
        ]),
      );

      const service = new AgentRunService(deps);
      await service.executeRun(makeParams());

      expect(toolStarted).toEqual([
        expect.objectContaining({
          runId: 'run-1',
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

      const { deps, sandboxRunService } = createDeps({ eventBus });
      sandboxRunService.executeSessionTurn.mockReturnValue(
        eventStream([
          {
            type: 'TOOL_CALL_RESULT',
            timestamp: 1,
            runId: 'run-1',
            toolCallId: 'tc-1',
            toolName: 'search',
            result: longResult,
            durationMs: 25,
          },
        ]),
      );

      const service = new AgentRunService(deps);
      await service.executeRun(makeParams());

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

      const { deps, sandboxRunService } = createDeps({ eventBus });
      sandboxRunService.executeSessionTurn.mockReturnValue(
        eventStream([
          {
            type: 'TOOL_CALL_RESULT',
            timestamp: 1,
            runId: 'run-1',
            toolCallId: 'tc-1',
            result: 'ok',
            durationMs: 12,
          },
        ]),
      );

      const service = new AgentRunService(deps);
      await service.executeRun(makeParams());

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].toolName).toBe('');
    });

    it('does not throw when eventBus is not provided', async () => {
      const events: StreamEvent[] = [
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'run-1', content: 'hi' },
        { type: 'TOOL_CALL_START', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'x' },
        { type: 'TOOL_CALL_RESULT', timestamp: 3, runId: 'run-1', toolCallId: 'tc-1', result: 'y', durationMs: 1 },
      ];

      const { deps, sandboxRunService } = createDeps();
      sandboxRunService.executeSessionTurn.mockReturnValue(eventStream(events));

      const service = new AgentRunService(deps);
      await expect(service.executeRun(makeParams())).resolves.toBeUndefined();
    });
  });

  describe('trace collection', () => {
    it('collects tool lifecycle steps for the learning pipeline', async () => {
      const learningPipeline = {
        process: vi.fn().mockResolvedValue([]),
      };
      const events: StreamEvent[] = [
        { type: 'TOOL_CALL_START', timestamp: 1, runId: 'run-1', toolCallId: 'tc-1', toolName: 'get-data' },
        { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', toolName: 'get-data', result: 'data-result', durationMs: 42 },
        { type: 'RUN_FINISHED', timestamp: 3, runId: 'run-1' },
      ];

      const { deps, sandboxRunService } = createDeps({ learningPipeline });
      sandboxRunService.executeSessionTurn.mockReturnValue(eventStream(events));

      const service = new AgentRunService(deps);
      await service.executeRun(makeParams());

      expect(learningPipeline.process).toHaveBeenCalledTimes(1);
      const trace = learningPipeline.process.mock.calls[0][0];
      expect(trace.steps).toHaveLength(2);
      expect(trace.steps[0]).toMatchObject({
        ordinal: 0,
        type: 'tool_call',
        content: 'get-data',
        metadata: { toolCallId: 'tc-1' },
      });
      expect(trace.steps[1]).toMatchObject({
        ordinal: 1,
        type: 'tool_result',
        content: 'data-result',
        durationMs: 42,
        metadata: { toolCallId: 'tc-1' },
      });
    });

    it('preserves trace step ordering across multiple tool calls', async () => {
      const learningPipeline = {
        process: vi.fn().mockResolvedValue([]),
      };
      const events: StreamEvent[] = [
        { type: 'TOOL_CALL_START', timestamp: 1, runId: 'run-1', toolCallId: 'tc-1', toolName: 'alpha' },
        { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'run-1', toolCallId: 'tc-1', result: 'a-result', durationMs: 10 },
        { type: 'TOOL_CALL_START', timestamp: 3, runId: 'run-1', toolCallId: 'tc-2', toolName: 'beta' },
        { type: 'TOOL_CALL_RESULT', timestamp: 4, runId: 'run-1', toolCallId: 'tc-2', result: 'b-result', durationMs: 20 },
      ];

      const { deps, sandboxRunService } = createDeps({ learningPipeline });
      sandboxRunService.executeSessionTurn.mockReturnValue(eventStream(events));

      const service = new AgentRunService(deps);
      await service.executeRun(makeParams());

      const trace = learningPipeline.process.mock.calls[0][0];
      expect(trace.steps).toHaveLength(4);
      expect(trace.steps.map((step: { type: string; content: string }) => [step.type, step.content])).toEqual([
        ['tool_call', 'alpha'],
        ['tool_result', 'a-result'],
        ['tool_call', 'beta'],
        ['tool_result', 'b-result'],
      ]);
    });
  });

  describe('AbortSignal cancellation', () => {
    it('stops streaming when the real RunRegistry aborts the run and skips completion', async () => {
      const eventBus = new TypedEventBus();
      const registry = new RunRegistry(undefined, eventBus);
      const completeRunSpy = vi.spyOn(registry, 'completeRun');
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test task');

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

      const service = new AgentRunService(createDeps({
        eventBus,
        runRegistry: registry,
        sandboxRunService: {
          executeSessionTurn: vi.fn().mockImplementation(cancellableStream),
        },
      }).deps);

      const runPromise = service.executeRun(makeParams({ runId: run.id }));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await registry.cancelRun(run.id);
      gateResolve?.();
      await runPromise;

      expect(yieldCount).toBe(2);
      expect(completeRunSpy).not.toHaveBeenCalled();
      expect(registry.getRun(run.id)?.status).toBe('cancelled');
    });

    it('persists committed messages that arrive before cancellation', async () => {
      const eventBus = new TypedEventBus();
      const registry = new RunRegistry(undefined, eventBus);
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test task');
      const db = {
        addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
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

      const service = new AgentRunService(createDeps({
        db,
        eventBus,
        runRegistry: registry,
        sandboxRunService: {
          executeSessionTurn: vi.fn().mockImplementation(committedThenWait),
        },
      }).deps);

      const runPromise = service.executeRun(makeParams({ runId: run.id }));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await registry.cancelRun(run.id);
      gateResolve?.();
      await runPromise;

      expect(db.addMessage).toHaveBeenCalledTimes(1);
      expect(db.addMessage).toHaveBeenCalledWith({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Committed before cancel',
        toolCalls: undefined,
        toolCallId: undefined,
      });
    });

    it('emits run.completed with cancelled status when RunRegistry.cancelRun is called', async () => {
      const eventBus = new TypedEventBus();
      const completedEvents = collectEvents(eventBus, 'run.completed');
      const registry = new RunRegistry(undefined, eventBus);
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test');

      await registry.cancelRun(run.id);

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({
        runId: run.id,
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'cancelled',
      });
      expect(typeof completedEvents[0].durationMs).toBe('number');
    });
  });

  describe('AG-UI event payload shape', () => {
    it('RUN_ERROR payload contains required fields when sandbox streaming throws', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      async function* failingStream() {
        yield* eventStream([]);
        throw new Error('connection refused');
      }

      const { deps, sandboxRunService, sse } = createDeps();
      sandboxRunService.executeSessionTurn.mockReturnValue(failingStream());

      const service = new AgentRunService(deps);
      await service.executeRun(makeParams());

      expect(sse.broadcast).toHaveBeenCalledTimes(1);
      expect(sse.broadcast).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          type: 'RUN_ERROR',
          runId: 'run-1',
          error: 'Error: connection refused',
          timestamp: expect.any(Number),
        }),
      );
    });

    it('preserves original event fields when broadcasting', async () => {
      const originalEvent = {
        type: 'TEXT_MESSAGE_CONTENT',
        timestamp: 12345,
        runId: 'run-1',
        messageId: 'msg-1',
        content: 'test',
        customField: 'should-be-preserved',
      } satisfies AGUIEvent;

      const { deps, sandboxRunService, sse } = createDeps();
      sandboxRunService.executeSessionTurn.mockReturnValue(eventStream([originalEvent]));

      const service = new AgentRunService(deps);
      await service.executeRun(makeParams());

      expect(sse.broadcast).toHaveBeenCalledWith('agent-1', originalEvent);
      const broadcastPayload = sse.broadcast.mock.calls[0][1] as Record<string, unknown>;
      expect(broadcastPayload.customField).toBe('should-be-preserved');
      expect(broadcastPayload.timestamp).toBe(12345);
    });
  });
});
