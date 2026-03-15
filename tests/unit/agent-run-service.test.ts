import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunService } from '../../packages/ctxmill/src/orchestrator/agent-run-service.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { RunRegistry } from '../../packages/ctxmill/src/orchestrator/run-registry.js';
import type { EventMap } from '../../packages/ctxmill/src/events/bus.js';
import type { AgentDefinition, Message } from '../../packages/ctxmill/src/types.js';

/** Helper to build an async generator from an array of events */
async function* mockEventStream(events: Array<Record<string, unknown>>) {
  for (const e of events) {
    yield e;
  }
}

/** Async generator that yields events with delays, useful for cancellation tests */
async function* slowEventStream(
  events: Array<Record<string, unknown>>,
  delayMs: number,
  signal?: AbortSignal,
) {
  for (const e of events) {
    if (signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (signal?.aborted) return;
    yield e;
  }
}

/** Collect all emissions of a given event type from an EventBus */
function collectEvents<K extends keyof EventMap>(bus: TypedEventBus, event: K): EventMap[K][] {
  const collected: EventMap[K][] = [];
  bus.on(event, (payload) => {
    collected.push(payload);
  });
  return collected;
}

function makeDeps(overrides: Record<string, any> = {}) {
  return {
    executor: {
      run: vi.fn(),
      resolveInterrupt: vi.fn(),
      getEnvironmentFactory: vi.fn().mockReturnValue(null),
      ...overrides.executor,
    },
    sse: {
      broadcast: vi.fn(),
      ...overrides.sse,
    },
    db: {
      addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
      ...overrides.db,
    },
    runRegistry: {
      completeRun: vi.fn(),
      getAbortSignal: vi.fn().mockReturnValue(undefined),
      updateSessionDir: vi.fn(),
      ...overrides.runRegistry,
    },
    learningPipeline: overrides.learningPipeline ?? undefined,
    eventBus: overrides.eventBus ?? undefined,
  };
}

function makeAgentDef(): AgentDefinition {
  return {
    name: 'test-agent',
    systemPrompt: 'You are a test agent. {{knowledge}}',
    tools: [],
  } as unknown as AgentDefinition;
}

function makeMessages(): Message[] {
  return [
    {
      id: 'user-msg-1',
      agentId: 'agent-1',
      role: 'user',
      content: 'Hello',
      createdAt: new Date(),
    },
  ];
}

function makeParams(overrides: Record<string, any> = {}) {
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

describe('AgentRunService', () => {
  // ─── Existing tests (preserved, with strengthened assertions) ───

  it('broadcasts each event from executor to SSE', async () => {
    const events = [
      { type: 'RUN_STARTED', timestamp: 1, runId: 'r1' },
      { type: 'TEXT_MESSAGE_START', timestamp: 2, runId: 'r1', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'r1', messageId: 'm1', content: 'Hi' },
      { type: 'TEXT_MESSAGE_END', timestamp: 4, runId: 'r1', messageId: 'm1' },
      { type: 'RUN_FINISHED', timestamp: 5, runId: 'r1' },
    ];

    const deps = makeDeps();
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    // All 5 events should be broadcast
    expect(deps.sse.broadcast).toHaveBeenCalledTimes(5);
    for (let i = 0; i < events.length; i++) {
      expect(deps.sse.broadcast).toHaveBeenNthCalledWith(i + 1, 'agent-1', events[i]);
    }
  });

  it('accumulates TEXT_MESSAGE_CONTENT and saves assistant message', async () => {
    const eventBus = new TypedEventBus();
    const textChunks = collectEvents(eventBus, 'run.text_chunk');

    const events = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', messageId: 'm1', content: 'Hello ' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'r1', messageId: 'm1', content: 'world' },
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'r1' },
    ];

    const deps = makeDeps({ eventBus });
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    // Verify the persisted message has correctly accumulated content
    expect(deps.db.addMessage).toHaveBeenCalledTimes(1);
    const savedMessage = deps.db.addMessage.mock.calls[0][0];
    expect(savedMessage).toMatchObject({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Hello world',
    });

    // Verify text_chunk events were emitted on the bus with correct payloads
    expect(textChunks).toHaveLength(2);
    expect(textChunks[0]).toMatchObject({
      runId: 'run-1',
      agentId: 'agent-1',
      content: 'Hello ',
    });
    expect(textChunks[1]).toMatchObject({
      runId: 'run-1',
      agentId: 'agent-1',
      content: 'world',
    });
    // Verify timestamps are numbers (AG-UI spec)
    expect(typeof textChunks[0].timestamp).toBe('number');
    expect(typeof textChunks[1].timestamp).toBe('number');
  });

  it('does not save message when no text content is produced', async () => {
    const events = [
      { type: 'RUN_STARTED', timestamp: 1, runId: 'r1' },
      { type: 'RUN_FINISHED', timestamp: 2, runId: 'r1' },
    ];

    const deps = makeDeps();
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    expect(deps.db.addMessage).not.toHaveBeenCalled();
  });

  it('calls runRegistry.completeRun after successful run', async () => {
    const events = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', content: 'ok' },
    ];

    const deps = makeDeps();
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    expect(deps.runRegistry.completeRun).toHaveBeenCalledWith('run-1');
  });

  it('calls learning pipeline after successful run with content', async () => {
    const events = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', content: 'response text' },
    ];

    const mockPipeline = {
      process: vi.fn().mockResolvedValue([]),
      getKnowledge: vi.fn(),
    };

    const deps = makeDeps({ learningPipeline: mockPipeline });
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    expect(mockPipeline.process).toHaveBeenCalledTimes(1);
    const trace = mockPipeline.process.mock.calls[0][0];
    expect(trace.agentId).toBe('agent-1');
    expect(trace.outcome).toBe('success');
  });

  it('does not call learning pipeline when no learningPipeline provided', async () => {
    const events = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', content: 'some text' },
    ];

    const deps = makeDeps(); // no learningPipeline
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    // Just confirm it doesn't throw — no pipeline to call
    expect(deps.runRegistry.completeRun).toHaveBeenCalledWith('run-1');
  });

  it('handles executor errors: broadcasts RUN_ERROR, completes run with error', async () => {
    const eventBus = new TypedEventBus();

    async function* failingStream() {
      yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', content: 'partial' };
      throw new Error('LLM timeout');
    }

    const mockPipeline = {
      process: vi.fn().mockResolvedValue([]),
      getKnowledge: vi.fn(),
    };

    const deps = makeDeps({ learningPipeline: mockPipeline, eventBus });
    deps.executor.run.mockReturnValue(failingStream());

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    // Should broadcast the partial content event + the RUN_ERROR
    const broadcastCalls = deps.sse.broadcast.mock.calls;
    expect(broadcastCalls).toHaveLength(2);

    // First call: the partial text chunk
    expect(broadcastCalls[0][1]).toMatchObject({ type: 'TEXT_MESSAGE_CONTENT', content: 'partial' });

    // Second call: the RUN_ERROR event with AG-UI compliant shape
    const errorEvent = broadcastCalls[1][1];
    expect(errorEvent).toMatchObject({
      type: 'RUN_ERROR',
      runId: 'run-1',
      error: 'Error: LLM timeout',
    });
    expect(typeof errorEvent.timestamp).toBe('number');

    // completeRun called with error string
    expect(deps.runRegistry.completeRun).toHaveBeenCalledWith('run-1', 'Error: LLM timeout');

    // Learning pipeline should still be called with failure outcome
    expect(mockPipeline.process).toHaveBeenCalledTimes(1);
    const trace = mockPipeline.process.mock.calls[0][0];
    expect(trace.outcome).toBe('failure');
  });

  it('collects trace steps from TOOL_CALL_START and TOOL_CALL_RESULT events', async () => {
    const eventBus = new TypedEventBus();
    const toolStartedEvents = collectEvents(eventBus, 'run.tool_started');
    const toolResultEvents = collectEvents(eventBus, 'run.tool_result');

    const events = [
      { type: 'TOOL_CALL_START', timestamp: 1, runId: 'r1', toolCallId: 'tc-1', toolName: 'get-data' },
      { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'r1', toolCallId: 'tc-1', toolName: 'get-data', result: 'data-result', durationMs: 42 },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'r1', content: 'done' },
    ];

    const mockPipeline = {
      process: vi.fn().mockResolvedValue([]),
      getKnowledge: vi.fn(),
    };

    const deps = makeDeps({ learningPipeline: mockPipeline, eventBus });
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    // Verify trace steps collected for learning pipeline
    const trace = mockPipeline.process.mock.calls[0][0];
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0]).toMatchObject({ type: 'tool_call', content: 'get-data' });
    expect(trace.steps[1]).toMatchObject({ type: 'tool_result', content: 'data-result', durationMs: 42 });

    // Verify event bus received tool events with correct payloads
    expect(toolStartedEvents).toHaveLength(1);
    expect(toolStartedEvents[0]).toMatchObject({
      runId: 'run-1',
      agentId: 'agent-1',
      toolCallId: 'tc-1',
      toolName: 'get-data',
      args: {},
    });
    expect(typeof toolStartedEvents[0].timestamp).toBe('number');

    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0]).toMatchObject({
      runId: 'run-1',
      agentId: 'agent-1',
      toolCallId: 'tc-1',
      toolName: 'get-data',
      result: 'data-result',
      durationMs: 42,
    });
    expect(typeof toolResultEvents[0].timestamp).toBe('number');
  });

  it('persists assistant text that arrives after a tool result', async () => {
    const events = [
      { type: 'TOOL_CALL_START', timestamp: 1, runId: 'r1', toolCallId: 'tc-1', toolName: 'get-portfolio' },
      { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'r1', toolCallId: 'tc-1', result: '{"ok":true}', durationMs: 42 },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'r1', messageId: 'm1', content: 'Current portfolio loaded.' },
      { type: 'RUN_FINISHED', timestamp: 4, runId: 'r1' },
    ];

    const deps = makeDeps();
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    expect(deps.db.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: 'Current portfolio loaded.',
      }),
    );
  });

  it('learning pipeline error does not propagate', async () => {
    const events = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', content: 'text' },
    ];

    const mockPipeline = {
      process: vi.fn().mockRejectedValue(new Error('pipeline crash')),
      getKnowledge: vi.fn(),
    };

    const deps = makeDeps({ learningPipeline: mockPipeline });
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    // Should not throw
    await expect(service.executeRun(makeParams())).resolves.toBeUndefined();

    // Run should still be completed successfully
    expect(deps.runRegistry.completeRun).toHaveBeenCalledWith('run-1');
  });

  // ─── New: Event bus emission verification tests ───

  describe('event bus integration', () => {
    it('emits run.text_chunk for each TEXT_MESSAGE_CONTENT event', async () => {
      const eventBus = new TypedEventBus();
      const textChunks = collectEvents(eventBus, 'run.text_chunk');

      const events = [
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', messageId: 'msg-1', content: 'chunk1' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'r1', messageId: 'msg-1', content: 'chunk2' },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'r1', messageId: 'msg-1', content: 'chunk3' },
        { type: 'RUN_FINISHED', timestamp: 4, runId: 'r1' },
      ];

      const deps = makeDeps({ eventBus });
      deps.executor.run.mockReturnValue(mockEventStream(events));

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      expect(textChunks).toHaveLength(3);
      expect(textChunks.map((c) => c.content)).toEqual(['chunk1', 'chunk2', 'chunk3']);
      // All chunks share the same runId and agentId
      for (const chunk of textChunks) {
        expect(chunk.runId).toBe('run-1');
        expect(chunk.agentId).toBe('agent-1');
        expect(chunk.messageId).toBe('msg-1');
      }
    });

    it('emits run.tool_started and run.tool_result for tool lifecycle', async () => {
      const eventBus = new TypedEventBus();
      const toolStarted = collectEvents(eventBus, 'run.tool_started');
      const toolResult = collectEvents(eventBus, 'run.tool_result');

      const events = [
        { type: 'TOOL_CALL_START', timestamp: 1, runId: 'r1', toolCallId: 'tc-1', toolName: 'search', args: { query: 'test' } },
        { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'r1', toolCallId: 'tc-1', toolName: 'search', result: 'found it', durationMs: 100 },
        { type: 'TOOL_CALL_START', timestamp: 3, runId: 'r1', toolCallId: 'tc-2', toolName: 'fetch', args: { url: 'http://x' } },
        { type: 'TOOL_CALL_RESULT', timestamp: 4, runId: 'r1', toolCallId: 'tc-2', toolName: 'fetch', result: '<html>', durationMs: 200 },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 5, runId: 'r1', content: 'done' },
      ];

      const deps = makeDeps({ eventBus });
      deps.executor.run.mockReturnValue(mockEventStream(events));

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      // Two tool invocations should produce two started + two result events
      expect(toolStarted).toHaveLength(2);
      expect(toolResult).toHaveLength(2);

      // First tool
      expect(toolStarted[0]).toMatchObject({
        toolCallId: 'tc-1',
        toolName: 'search',
        args: { query: 'test' },
      });
      expect(toolResult[0]).toMatchObject({
        toolCallId: 'tc-1',
        toolName: 'search',
        result: 'found it',
        durationMs: 100,
      });

      // Second tool
      expect(toolStarted[1]).toMatchObject({
        toolCallId: 'tc-2',
        toolName: 'fetch',
        args: { url: 'http://x' },
      });
      expect(toolResult[1]).toMatchObject({
        toolCallId: 'tc-2',
        toolName: 'fetch',
        result: '<html>',
        durationMs: 200,
      });
    });

    it('does not emit events when eventBus is not provided', async () => {
      // This confirms no crash when eventBus is undefined
      const events = [
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', content: 'hi' },
        { type: 'TOOL_CALL_START', timestamp: 2, runId: 'r1', toolCallId: 'tc-1', toolName: 'x' },
        { type: 'TOOL_CALL_RESULT', timestamp: 3, runId: 'r1', toolCallId: 'tc-1', result: 'y', durationMs: 1 },
        { type: 'RUN_FINISHED', timestamp: 4, runId: 'r1' },
      ];

      const deps = makeDeps(); // no eventBus
      deps.executor.run.mockReturnValue(mockEventStream(events));

      const service = new AgentRunService(deps as any);
      // Should complete without error
      await expect(service.executeRun(makeParams())).resolves.toBeUndefined();
    });

    it('text_chunk events have correct messageId (empty string when absent)', async () => {
      const eventBus = new TypedEventBus();
      const textChunks = collectEvents(eventBus, 'run.text_chunk');

      const events = [
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', content: 'no-msg-id' },
        { type: 'RUN_FINISHED', timestamp: 2, runId: 'r1' },
      ];

      const deps = makeDeps({ eventBus });
      deps.executor.run.mockReturnValue(mockEventStream(events));

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      expect(textChunks).toHaveLength(1);
      expect(textChunks[0].messageId).toBe('');
    });
  });

  // ─── New: AbortSignal cancellation tests ───

  describe('AbortSignal cancellation', () => {
    it('terminates executor loop when run is cancelled via real RunRegistry', async () => {
      const eventBus = new TypedEventBus();
      const registry = new RunRegistry(undefined, eventBus);

      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test task');
      const runId = run.id;

      let yieldCount = 0;
      // Gate: the generator yields 2 chunks, then waits for this to resolve before continuing
      let gateResolve: () => void;
      const gate = new Promise<void>((resolve) => { gateResolve = resolve; });

      async function* cancellableStream(
        _agentDef: any,
        _messages: any,
        _agentId: string,
        _runId: string,
        signal?: AbortSignal,
      ) {
        const chunks = ['Hello ', 'world ', 'this ', 'should ', 'be ', 'cut ', 'short'];
        for (let i = 0; i < chunks.length; i++) {
          if (signal?.aborted) return;
          yieldCount++;
          yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: _runId, messageId: 'm1', content: chunks[i] };
          // After yielding 2 chunks, wait on the gate (we'll cancel during this wait)
          if (i === 1) await gate;
        }
      }

      const mockExecutor = { run: vi.fn().mockImplementation(cancellableStream), getEnvironmentFactory: vi.fn().mockReturnValue(null) };
      const mockDb = { addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
      const mockSse = { broadcast: vi.fn() };

      // Pass real RunRegistry directly (not via makeDeps spread which loses prototype methods)
      const service = new AgentRunService({
        executor: mockExecutor,
        sse: mockSse,
        db: mockDb,
        runRegistry: registry,
        eventBus,
      } as any);

      const runPromise = service.executeRun(makeParams({ runId }));

      // Let the first 2 yields get consumed
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Cancel the run while generator is blocked on the gate
      await registry.cancelRun(runId);

      // Release the gate — generator will check signal and return
      gateResolve!();

      await runPromise;

      // Only 2 chunks should have been yielded before cancellation
      expect(yieldCount).toBe(2);

      // Partial content should have been persisted
      expect(mockDb.addMessage).toHaveBeenCalledTimes(1);
      const savedMessage = mockDb.addMessage.mock.calls[0][0];
      expect(savedMessage.role).toBe('assistant');
      expect(savedMessage.content).toBe('Hello world ');
    });

    it('persists partial assistant content on cancellation', async () => {
      const eventBus = new TypedEventBus();
      const registry = new RunRegistry(undefined, eventBus);
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test');
      const runId = run.id;

      let gateResolve: () => void;
      const gate = new Promise<void>((resolve) => { gateResolve = resolve; });

      async function* twoChunksThenWait(
        _agentDef: any,
        _messages: any,
        _agentId: string,
        _runId: string,
        signal?: AbortSignal,
      ) {
        yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: _runId, content: 'First ' };
        yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: _runId, content: 'Second ' };
        await gate;
        if (signal?.aborted) return;
        yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: _runId, content: 'Third' };
      }

      const mockDb = { addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }) };

      const service = new AgentRunService({
        executor: { run: vi.fn().mockImplementation(twoChunksThenWait), getEnvironmentFactory: vi.fn().mockReturnValue(null) },
        sse: { broadcast: vi.fn() },
        db: mockDb,
        runRegistry: registry,
        eventBus,
      } as any);

      const runPromise = service.executeRun(makeParams({ runId }));

      // Wait for the two quick yields to be consumed
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Cancel the run (sets abort signal)
      await registry.cancelRun(runId);

      // Release the gate so the generator can check the signal
      gateResolve!();

      await runPromise;

      // Partial content persisted: "First Second " (not "First Second Third")
      expect(mockDb.addMessage).toHaveBeenCalledTimes(1);
      const savedMessage = mockDb.addMessage.mock.calls[0][0];
      expect(savedMessage.content).toBe('First Second ');

      // The run was already marked cancelled by registry.cancelRun()
      const registryRun = registry.getRun(runId);
      expect(registryRun?.status).toBe('cancelled');
    });

    it('does not call completeRun when cancelled (avoids overwriting cancelled status)', async () => {
      const eventBus = new TypedEventBus();
      const registry = new RunRegistry(undefined, eventBus);
      const completeRunSpy = vi.spyOn(registry, 'completeRun');

      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test');
      const runId = run.id;

      let gateResolve: () => void;
      const gate = new Promise<void>((resolve) => { gateResolve = resolve; });

      async function* quickThenHang(
        _ad: any, _m: any, _aid: string, _rid: string, signal?: AbortSignal,
      ) {
        yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: _rid, content: 'hi' };
        await gate;
        if (signal?.aborted) return;
        yield { type: 'RUN_FINISHED', timestamp: Date.now(), runId: _rid };
      }

      const service = new AgentRunService({
        executor: { run: vi.fn().mockImplementation(quickThenHang), getEnvironmentFactory: vi.fn().mockReturnValue(null) },
        sse: { broadcast: vi.fn() },
        db: { addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }) },
        runRegistry: registry,
        eventBus,
      } as any);

      const runPromise = service.executeRun(makeParams({ runId }));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await registry.cancelRun(runId);
      gateResolve!();
      await runPromise;

      // cancelRun doesn't go through completeRun — it has its own path
      // AgentRunService should NOT call completeRun after abort (it returns early)
      expect(completeRunSpy).not.toHaveBeenCalled();
    });

    it('run.completed event is emitted by RunRegistry.cancelRun with cancelled status', async () => {
      const eventBus = new TypedEventBus();
      const completedEvents = collectEvents(eventBus, 'run.completed');

      const registry = new RunRegistry(undefined, eventBus);
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test');

      await registry.cancelRun(run.id);

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({
        runId: run.id,
        agentId: 'agent-1',
        status: 'cancelled',
      });
      expect(typeof completedEvents[0].durationMs).toBe('number');
    });
  });

  // ─── New: AG-UI event payload shape verification ───

  describe('AG-UI event payload shape', () => {
    it('RUN_ERROR payload contains required AG-UI fields', async () => {
      async function* failingStream() {
        throw new Error('connection refused');
      }

      const deps = makeDeps();
      deps.executor.run.mockReturnValue(failingStream());

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      const errorBroadcast = deps.sse.broadcast.mock.calls[0];
      expect(errorBroadcast[0]).toBe('agent-1'); // correct agent routing
      const payload = errorBroadcast[1];
      expect(payload).toHaveProperty('type', 'RUN_ERROR');
      expect(payload).toHaveProperty('runId', 'run-1');
      expect(payload).toHaveProperty('error');
      expect(payload).toHaveProperty('timestamp');
      expect(typeof payload.timestamp).toBe('number');
    });

    it('broadcast events preserve original event fields (no mutation)', async () => {
      const originalEvent = {
        type: 'TEXT_MESSAGE_CONTENT',
        timestamp: 12345,
        runId: 'r1',
        messageId: 'msg-1',
        content: 'test',
        customField: 'should-be-preserved',
      };

      const deps = makeDeps();
      deps.executor.run.mockReturnValue(mockEventStream([originalEvent]));

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      const broadcastPayload = deps.sse.broadcast.mock.calls[0][1];
      // The broadcast should pass through the exact event object
      expect(broadcastPayload.customField).toBe('should-be-preserved');
      expect(broadcastPayload.timestamp).toBe(12345);
    });
  });

  // ─── New: Behavioral verification (not just mock contract) ───

  describe('behavioral assertions', () => {
    it('accumulated content matches concatenation of all TEXT_MESSAGE_CONTENT events', async () => {
      const chunks = ['The ', 'quick ', 'brown ', 'fox'];
      const events = chunks.map((content, i) => ({
        type: 'TEXT_MESSAGE_CONTENT',
        timestamp: i + 1,
        runId: 'r1',
        messageId: 'm1',
        content,
      }));

      const deps = makeDeps();
      deps.executor.run.mockReturnValue(mockEventStream(events));

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      const savedContent = deps.db.addMessage.mock.calls[0][0].content;
      expect(savedContent).toBe('The quick brown fox');
      // Verify it's the exact concatenation, not truncated or modified
      expect(savedContent).toBe(chunks.join(''));
    });

    it('tool result content is truncated to 500 chars in trace', async () => {
      const longResult = 'x'.repeat(1000);
      const events = [
        { type: 'TOOL_CALL_START', timestamp: 1, runId: 'r1', toolCallId: 'tc-1', toolName: 'big-tool' },
        { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'r1', toolCallId: 'tc-1', result: longResult, durationMs: 10 },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'r1', content: 'done' },
      ];

      const mockPipeline = {
        process: vi.fn().mockResolvedValue([]),
        getKnowledge: vi.fn(),
      };

      const deps = makeDeps({ learningPipeline: mockPipeline });
      deps.executor.run.mockReturnValue(mockEventStream(events));

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      const trace = mockPipeline.process.mock.calls[0][0];
      // The tool_result step content should be truncated to 500 chars
      expect(trace.steps[1].content).toHaveLength(500);
      expect(trace.steps[1].content).toBe('x'.repeat(500));
    });

    it('tool result in event bus is also truncated to 500 chars', async () => {
      const eventBus = new TypedEventBus();
      const toolResults = collectEvents(eventBus, 'run.tool_result');

      const longResult = 'y'.repeat(1000);
      const events = [
        { type: 'TOOL_CALL_START', timestamp: 1, runId: 'r1', toolCallId: 'tc-1', toolName: 'big-tool' },
        { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'r1', toolCallId: 'tc-1', result: longResult, durationMs: 10 },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 3, runId: 'r1', content: 'done' },
      ];

      const deps = makeDeps({ eventBus });
      deps.executor.run.mockReturnValue(mockEventStream(events));

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].result).toHaveLength(500);
    });

    it('multiple tool calls produce correct trace step ordering', async () => {
      const events = [
        { type: 'TOOL_CALL_START', timestamp: 1, runId: 'r1', toolCallId: 'tc-1', toolName: 'alpha' },
        { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'r1', toolCallId: 'tc-1', result: 'a-result', durationMs: 10 },
        { type: 'TOOL_CALL_START', timestamp: 3, runId: 'r1', toolCallId: 'tc-2', toolName: 'beta' },
        { type: 'TOOL_CALL_RESULT', timestamp: 4, runId: 'r1', toolCallId: 'tc-2', result: 'b-result', durationMs: 20 },
        { type: 'TEXT_MESSAGE_CONTENT', timestamp: 5, runId: 'r1', content: 'final' },
      ];

      const mockPipeline = {
        process: vi.fn().mockResolvedValue([]),
        getKnowledge: vi.fn(),
      };

      const deps = makeDeps({ learningPipeline: mockPipeline });
      deps.executor.run.mockReturnValue(mockEventStream(events));

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      const trace = mockPipeline.process.mock.calls[0][0];
      expect(trace.steps).toHaveLength(4);
      // Steps should be in chronological order
      expect(trace.steps[0]).toMatchObject({ type: 'tool_call', content: 'alpha' });
      expect(trace.steps[1]).toMatchObject({ type: 'tool_result', content: 'a-result' });
      expect(trace.steps[2]).toMatchObject({ type: 'tool_call', content: 'beta' });
      expect(trace.steps[3]).toMatchObject({ type: 'tool_result', content: 'b-result' });
    });

    it('error during executor still saves error to run registry with correct string', async () => {
      const customError = new TypeError('Cannot read properties of undefined');

      async function* errorStream() {
        throw customError;
      }

      const deps = makeDeps();
      deps.executor.run.mockReturnValue(errorStream());

      const service = new AgentRunService(deps as any);
      await service.executeRun(makeParams());

      // Verify the error string passed to completeRun matches String(err) format
      expect(deps.runRegistry.completeRun).toHaveBeenCalledWith(
        'run-1',
        'TypeError: Cannot read properties of undefined',
      );
    });
  });
});
