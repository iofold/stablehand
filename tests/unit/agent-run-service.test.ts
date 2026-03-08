import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunService } from '../../packages/ctxmill/src/orchestrator/agent-run-service.js';
import type { AgentDefinition, Message } from '../../packages/ctxmill/src/types.js';

/** Helper to build an async generator from an array of events */
async function* mockEventStream(events: Array<Record<string, unknown>>) {
  for (const e of events) {
    yield e;
  }
}

function makeDeps(overrides: Record<string, any> = {}) {
  return {
    executor: {
      run: vi.fn(),
      resolveInterrupt: vi.fn(),
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
      ...overrides.runRegistry,
    },
    learningPipeline: overrides.learningPipeline ?? undefined,
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
    const events = [
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', messageId: 'm1', content: 'Hello ' },
      { type: 'TEXT_MESSAGE_CONTENT', timestamp: 2, runId: 'r1', messageId: 'm1', content: 'world' },
      { type: 'RUN_FINISHED', timestamp: 3, runId: 'r1' },
    ];

    const deps = makeDeps();
    deps.executor.run.mockReturnValue(mockEventStream(events));

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    expect(deps.db.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello world',
      }),
    );
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
    async function* failingStream() {
      yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, runId: 'r1', content: 'partial' };
      throw new Error('LLM timeout');
    }

    const mockPipeline = {
      process: vi.fn().mockResolvedValue([]),
      getKnowledge: vi.fn(),
    };

    const deps = makeDeps({ learningPipeline: mockPipeline });
    deps.executor.run.mockReturnValue(failingStream());

    const service = new AgentRunService(deps as any);
    await service.executeRun(makeParams());

    // Should broadcast the partial content event + the RUN_ERROR
    expect(deps.sse.broadcast).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ type: 'RUN_ERROR', error: 'Error: LLM timeout' }),
    );

    // completeRun called with error string
    expect(deps.runRegistry.completeRun).toHaveBeenCalledWith('run-1', 'Error: LLM timeout');

    // Learning pipeline should still be called with failure outcome
    expect(mockPipeline.process).toHaveBeenCalledTimes(1);
    const trace = mockPipeline.process.mock.calls[0][0];
    expect(trace.outcome).toBe('failure');
  });

  it('collects trace steps from TOOL_CALL_START and TOOL_CALL_RESULT events', async () => {
    const events = [
      { type: 'TOOL_CALL_START', timestamp: 1, runId: 'r1', toolCallId: 'tc-1', toolName: 'get-data' },
      { type: 'TOOL_CALL_RESULT', timestamp: 2, runId: 'r1', toolCallId: 'tc-1', result: 'data-result', durationMs: 42 },
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
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0]).toMatchObject({ type: 'tool_call', content: 'get-data' });
    expect(trace.steps[1]).toMatchObject({ type: 'tool_result', content: 'data-result', durationMs: 42 });
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
});
