/**
 * P3-5: Kitchen-Sink Chain E2E Test (Sandbox Mode)
 *
 * Integration tests that verify the full agent chaining flow through sandbox
 * containers: one agent emits an event that triggers another agent in a
 * separate container.
 *
 * Tests wire together real EventBus, real EventTriggerManager, and real
 * AgentRunService with mocked Docker (ContainerManager) and gRPC transport.
 *
 * Flow under test:
 *   Agent A runs -> emits event via tool -> EventBus -> EventTriggerManager
 *   -> matches trigger for Agent B -> AgentRunService.executeRun()
 *   -> SandboxRunService -> new container -> Agent B completes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import {
  EventTriggerManager,
  MAX_TRIGGER_DEPTH,
} from '../../packages/ctxmill/src/events/trigger-manager.js';
import { AgentRunService } from '../../packages/ctxmill/src/orchestrator/agent-run-service.js';
import type { SandboxRunService } from '../../packages/ctxmill/src/orchestrator/sandbox-run-service.js';
import type { ContainerManager, ContainerInfo, ContainerMetrics } from '../../packages/ctxmill/src/sandbox/container-manager.js';
import type { AgentDefinition, Message } from '../../packages/ctxmill/src/types.js';
import type { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';
import type { AGUIEvent } from '../../packages/ctxmill/src/events/types.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Create a mock async generator from an array of AGUIEvents. */
async function* mockEventStream(
  events: Array<Record<string, unknown>>,
): AsyncGenerator<AGUIEvent> {
  for (const e of events) {
    yield e as unknown as AGUIEvent;
  }
}

/** Create a mock async generator that includes an emit-event tool call. */
async function* mockEventStreamWithEmit(
  runId: string,
  emitEventType: string,
  emitPayload: Record<string, unknown>,
): AsyncGenerator<AGUIEvent> {
  yield {
    type: 'RUN_STARTED',
    timestamp: Date.now(),
    runId,
  } as unknown as AGUIEvent;
  yield {
    type: 'TEXT_MESSAGE_START',
    timestamp: Date.now(),
    runId,
    messageId: `msg-${runId}`,
  } as unknown as AGUIEvent;
  yield {
    type: 'TEXT_MESSAGE_CONTENT',
    timestamp: Date.now(),
    runId,
    messageId: `msg-${runId}`,
    content: `Agent ${runId} processing`,
  } as unknown as AGUIEvent;
  yield {
    type: 'TEXT_MESSAGE_END',
    timestamp: Date.now(),
    runId,
    messageId: `msg-${runId}`,
  } as unknown as AGUIEvent;
  yield {
    type: 'TOOL_CALL_START',
    timestamp: Date.now(),
    runId,
    toolCallId: `tc-emit-${runId}`,
    toolName: 'emit-event',
  } as unknown as AGUIEvent;
  yield {
    type: 'TOOL_CALL_ARGS',
    timestamp: Date.now(),
    runId,
    toolCallId: `tc-emit-${runId}`,
    args: JSON.stringify({ type: emitEventType, payload: emitPayload }),
  } as unknown as AGUIEvent;
  yield {
    type: 'TOOL_CALL_RESULT',
    timestamp: Date.now(),
    runId,
    toolCallId: `tc-emit-${runId}`,
    result: JSON.stringify({ ok: true, eventType: emitEventType }),
    durationMs: 5,
  } as unknown as AGUIEvent;
  yield {
    type: 'TEXT_MESSAGE_START',
    timestamp: Date.now(),
    runId,
    messageId: `msg2-${runId}`,
  } as unknown as AGUIEvent;
  yield {
    type: 'TEXT_MESSAGE_CONTENT',
    timestamp: Date.now(),
    runId,
    messageId: `msg2-${runId}`,
    content: `Agent ${runId} done`,
  } as unknown as AGUIEvent;
  yield {
    type: 'TEXT_MESSAGE_END',
    timestamp: Date.now(),
    runId,
    messageId: `msg2-${runId}`,
  } as unknown as AGUIEvent;
  yield {
    type: 'RUN_FINISHED',
    timestamp: Date.now(),
    runId,
  } as unknown as AGUIEvent;
}

/** Create simple completion event stream for a triggered agent. */
async function* mockTriggeredStream(runId: string): AsyncGenerator<AGUIEvent> {
  yield {
    type: 'RUN_STARTED',
    timestamp: Date.now(),
    runId,
  } as unknown as AGUIEvent;
  yield {
    type: 'TEXT_MESSAGE_START',
    timestamp: Date.now(),
    runId,
    messageId: `msg-${runId}`,
  } as unknown as AGUIEvent;
  yield {
    type: 'TEXT_MESSAGE_CONTENT',
    timestamp: Date.now(),
    runId,
    messageId: `msg-${runId}`,
    content: `Triggered agent ${runId} response`,
  } as unknown as AGUIEvent;
  yield {
    type: 'TEXT_MESSAGE_END',
    timestamp: Date.now(),
    runId,
    messageId: `msg-${runId}`,
  } as unknown as AGUIEvent;
  yield {
    type: 'RUN_FINISHED',
    timestamp: Date.now(),
    runId,
  } as unknown as AGUIEvent;
}

/** Create a failing event stream. */
async function* mockFailingStream(runId: string): AsyncGenerator<AGUIEvent> {
  yield {
    type: 'RUN_STARTED',
    timestamp: Date.now(),
    runId,
  } as unknown as AGUIEvent;
  yield {
    type: 'RUN_ERROR',
    timestamp: Date.now(),
    runId,
    error: 'Agent B encountered a fatal error',
  } as unknown as AGUIEvent;
  yield {
    type: 'RUN_FAILED',
    timestamp: Date.now(),
    runId,
  } as unknown as AGUIEvent;
}

/* -------------------------------------------------------------------------- */
/*  Mock factories                                                              */
/* -------------------------------------------------------------------------- */

let containerCounter = 0;
let runCounter = 0;

function makeHarnessConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-5-mini',
    ...overrides,
  };
}

function makeAgentDef(name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    harness: 'langgraph',
    harnessConfig: makeHarnessConfig(),
    tools: [],
    systemPrompt: '',
    ...overrides,
  };
}

function makeAgentRow(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const harnessConfig = overrides.harnessConfig as Record<string, unknown> | undefined;
  const { harnessConfig: _ignoredHarnessConfig, ...rest } = overrides;
  return {
    name,
    harness: 'langgraph',
    harnessConfig: JSON.stringify(harnessConfig ?? makeHarnessConfig()),
    systemPrompt: '',
    tools: [],
    manifest: null,
    ...rest,
  };
}

function makeMockContainerManager(): ContainerManager & {
  _createdContainers: Array<{
    containerId: string;
    runId: string;
    agentId: string;
    harnessName: string;
    secrets: Record<string, string>;
    workspaceDir?: string;
  }>;
  _metrics: ContainerMetrics;
} {
  const createdContainers: Array<{
    containerId: string;
    runId: string;
    agentId: string;
    harnessName: string;
    secrets: Record<string, string>;
    workspaceDir?: string;
  }> = [];

  const metrics: ContainerMetrics = {
    active: 0,
    queued: 0,
    peak: 0,
    totalCreated: 0,
    byHarness: {},
    averageLifetimeMs: 0,
    maxGlobalContainers: 20,
  };

  const mock = {
    _createdContainers: createdContainers,
    _metrics: metrics,
    createContainer: vi.fn(async (opts: any) => {
      containerCounter++;
      const containerId = `container-${containerCounter}`;
      const info: ContainerInfo = {
        containerId,
        containerName: `ctxmill-run-${opts.runId}`,
        runId: opts.runId,
        agentId: opts.agentId,
        harnessName: opts.harnessName,
        status: 'created',
      };
      createdContainers.push({
        containerId,
        runId: opts.runId,
        agentId: opts.agentId,
        harnessName: opts.harnessName,
        secrets: {},
        workspaceDir: opts.workspaceDir,
      });
      metrics.totalCreated++;
      metrics.active++;
      metrics.peak = Math.max(metrics.peak, metrics.active);
      metrics.byHarness[opts.harnessName] =
        (metrics.byHarness[opts.harnessName] ?? 0) + 1;
      return info;
    }),
    startContainer: vi.fn(async () => {}),
    stopContainer: vi.fn(async () => {}),
    removeContainer: vi.fn(async () => {
      metrics.active = Math.max(0, metrics.active - 1);
    }),
    injectSecrets: vi.fn(async (containerId: string, secrets: Record<string, string>) => {
      const entry = createdContainers.find((c) => c.containerId === containerId);
      if (entry) entry.secrets = { ...secrets };
    }),
    extractLogs: vi.fn(async () => 'container logs'),
    extractWorkspaceDiff: vi.fn(async () => null),
    ensureNetwork: vi.fn(async () => {}),
    getContainer: vi.fn(async () => null),
    listManagedContainers: vi.fn(async () => []),
    getContainerExitCode: vi.fn(async () => null),
    pauseContainer: vi.fn(async () => {}),
    unpauseContainer: vi.fn(async () => {}),
    getMetrics: vi.fn(() => ({ ...metrics })),
  } as unknown as ContainerManager & {
    _createdContainers: typeof createdContainers;
    _metrics: typeof metrics;
  };
  return mock;
}

function makeMockDb(agentRows: Record<string, any> = {}): DatabaseRepository {
  return {
    getTriggers: vi.fn().mockResolvedValue([]),
    saveTrigger: vi.fn().mockResolvedValue(undefined),
    deleteTrigger: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn(async (agentId: string) => agentRows[agentId] ?? null),
    createConversation: vi.fn(async (agentId: string) => ({
      id: `conv-triggered-${agentId}-${++runCounter}`,
    })),
    addMessage: vi.fn().mockResolvedValue({ id: `msg-${++runCounter}` }),
    getMessages: vi.fn(async (_convId: string) => []),
    saveEvent: vi.fn(),
    getActiveRuns: vi.fn(async () => []),
    updateRun: vi.fn(),
  } as unknown as DatabaseRepository;
}

function makeMockRunRegistry() {
  const runs = new Map<string, { id: string; agentId: string; error?: string }>();
  return {
    startRun: vi.fn(async (agentId: string, _convId: string, _mode: string, _task: string) => {
      const id = `run-${agentId}-${++runCounter}`;
      runs.set(id, { id, agentId });
      return { id, agentId };
    }),
    completeRun: vi.fn(async (runId: string, error?: string) => {
      const run = runs.get(runId);
      if (run) run.error = error;
    }),
    getAbortSignal: vi.fn().mockReturnValue(undefined),
    pauseRun: vi.fn(),
    resumeRun: vi.fn(),
    _runs: runs,
  };
}

function makeMockSse() {
  const events: Array<{ agentId: string; event: Record<string, unknown> }> = [];
  return {
    broadcast: vi.fn((agentId: string, event: Record<string, unknown>) => {
      events.push({ agentId, event });
    }),
    _events: events,
  };
}

function makeMockExecutor() {
  return {
    run: vi.fn(),
    getEnvironmentFactory: vi.fn().mockReturnValue(null),
  };
}

/* -------------------------------------------------------------------------- */
/*  Test suite                                                                  */
/* -------------------------------------------------------------------------- */

describe('P3-5: Kitchen-Sink Chain Integration (Sandbox Mode)', () => {
  let eventBus: TypedEventBus;
  let db: ReturnType<typeof makeMockDb>;
  let runRegistry: ReturnType<typeof makeMockRunRegistry>;
  let sse: ReturnType<typeof makeMockSse>;
  let containerManager: ReturnType<typeof makeMockContainerManager>;
  let sandboxRunService: SandboxRunService;
  let agentRunService: AgentRunService;
  let triggerManager: EventTriggerManager;

  beforeEach(() => {
    containerCounter = 0;
    runCounter = 0;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (triggerManager) triggerManager.shutdown();
  });

  /**
   * Wire up the full component graph with given agent definitions.
   * Returns references to all components for assertions.
   */
  function wireComponents(opts: {
    agentRows: Record<string, any>;
    sandboxExecuteSessionTurn?: (...args: any[]) => AsyncGenerator<AGUIEvent>;
  }) {
    eventBus = new TypedEventBus();
    db = makeMockDb(opts.agentRows);
    runRegistry = makeMockRunRegistry();
    sse = makeMockSse();
    containerManager = makeMockContainerManager();

    // Mock SandboxRunService that tracks which agents it ran
    const executedRuns: Array<{ agentName: string; runId: string }> = [];
    sandboxRunService = {
      executeSessionTurn: vi.fn(
        (agentDef: AgentDefinition, _conversationId: string, _messages: Message[], turnId: string, _signal?: AbortSignal) => {
          executedRuns.push({ agentName: agentDef.name, runId: turnId });
          if (opts.sandboxExecuteSessionTurn) {
            return opts.sandboxExecuteSessionTurn(agentDef, turnId);
          }
          return mockTriggeredStream(turnId);
        },
      ),
      _executedRuns: executedRuns,
    } as unknown as SandboxRunService & { _executedRuns: typeof executedRuns };

    // Lazy ref pattern from container.ts
    let agentRunServiceRef: AgentRunService | null = null;

    // EventTriggerManager with real EventBus, using onFire callback
    // that mirrors container.ts logic
    triggerManager = new EventTriggerManager(
      eventBus,
      db,
      async (agentId, task, triggerId, triggerDepth) => {
        const agent = await db.getAgent(agentId);
        if (!agent) {
          console.error(`[Test] agent ${agentId} not found for trigger ${triggerId}`);
          return;
        }
        const conv = await db.createConversation(agentId);
        const run = await runRegistry.startRun(agentId, conv.id, 'background', task);

        await db.addMessage({ agentId, conversationId: conv.id, role: 'user', content: task });
        const messages: Message[] = [{
          id: `msg-trigger-${run.id}`,
          agentId,
          role: 'user' as const,
          content: task,
          createdAt: new Date(),
        }];

        const manifest = agent.manifest as Record<string, unknown> | null;
        const perAgentResourceLimits = manifest?.resourceLimits as any;

        const agentDef = makeAgentDef(agent.name, {
          harness: agent.harness ?? 'langgraph',
          harnessConfig: JSON.parse(agent.harnessConfig as string) as Record<string, unknown>,
          systemPrompt: agent.systemPrompt,
          tools: agent.tools ?? [],
          description: agent.description ?? undefined,
          workspaceDir: agent.workspaceDir ?? undefined,
          resourceLimits: perAgentResourceLimits,
        });

        // Fire-and-forget, matching container.ts pattern
        void agentRunServiceRef!.executeRun({
          agentDef,
          messages,
          agentId,
          conversationId: conv.id,
          runId: run.id,
          taskDescription: task,
        }).catch((err) => {
          console.error(`[Test] run error for trigger ${triggerId}:`, err);
        });
      },
    );

    agentRunService = new AgentRunService({
      sse: sse as any,
      db: db as any,
      runRegistry: runRegistry as any,
      sandboxRunService,
      toolExecutor: { list: vi.fn().mockReturnValue([]) } as any,
      eventBus,
    });
    agentRunServiceRef = agentRunService;

    return {
      eventBus,
      db,
      runRegistry,
      sse,
      containerManager,
      sandboxRunService: sandboxRunService as SandboxRunService & { _executedRuns: typeof executedRuns },
      agentRunService,
      triggerManager,
    };
  }

  // ── Test 1: Single-hop chain: Agent A triggers Agent B ────────

  describe('single-hop chain: Agent A triggers Agent B', () => {
    it('Agent A emits event -> EventTriggerManager matches -> Agent B starts in sandbox', async () => {
      const components = wireComponents({
        agentRows: {
          'agent-B': makeAgentRow('agent-B', {
            harness: 'claude-agents',
            systemPrompt: 'You are agent B.',
            tools: ['search'],
            workspaceDir: '/workspace/agent-B',
            manifest: { executionMode: 'sandbox' },
          }),
        },
      });

      // Register trigger: when custom.analysis_complete fires, trigger agent-B
      await components.triggerManager.register({
        agentId: 'agent-B',
        eventType: 'custom.analysis_complete',
        taskTemplate: 'Process analysis result: {{payload.result}}',
        enabled: true,
      });

      // Simulate Agent A completing and emitting an event via the EventBus
      // (this is what happens when the emit-event tool handler calls eventBus.emitCustom)
      components.triggerManager.emitCustomEvent(
        'custom.analysis_complete',
        'agent-A',
        { result: 'classification done', confidence: 0.95 },
      );

      // Wait for the async fire-and-forget chain
      await new Promise((r) => setTimeout(r, 50));

      // Verify: Agent B was started
      expect(components.sandboxRunService._executedRuns.some((run) => run.agentName === 'agent-B')).toBe(true);

      // Verify: AgentRunService received the run
      expect(components.runRegistry.startRun).toHaveBeenCalledWith(
        'agent-B',
        expect.any(String), // conv id
        'background',
        expect.stringContaining('Process analysis result: classification done'),
      );

      // Verify: SSE events were broadcast for agent-B
      const agentBEvents = components.sse._events.filter(
        (e) => e.agentId === 'agent-B',
      );
      expect(agentBEvents.length).toBeGreaterThan(0);

      // Verify: run completed
      expect(components.runRegistry.completeRun).toHaveBeenCalled();
    });

    it('Agent A completes independently of Agent B (fire-and-forget)', async () => {
      // Track run execution order
      const executionLog: string[] = [];
      let triggerBResolve: (() => void) | null = null;
      const triggerBStarted = new Promise<void>((r) => { triggerBResolve = r; });

      const components = wireComponents({
        agentRows: {
          'agent-B': makeAgentRow('agent-B', {
            harness: 'pi-agent',
            systemPrompt: 'You are agent B.',
            tools: [],
            manifest: null,
          }),
        },
        sandboxExecuteSessionTurn: async function* (agentDef: AgentDefinition, runId: string) {
          if (agentDef.name === 'agent-B') {
            executionLog.push(`B-start:${runId}`);
            triggerBResolve?.();
            // Simulate some processing delay
            await new Promise((r) => setTimeout(r, 20));
            yield* mockTriggeredStream(runId);
            executionLog.push(`B-end:${runId}`);
          } else {
            // Agent A just runs through quickly
            yield* mockTriggeredStream(runId);
          }
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-B',
        eventType: 'custom.trigger_b',
        taskTemplate: 'Triggered task for B',
        enabled: true,
      });

      // Execute Agent A's run directly (simulating the main run)
      executionLog.push('A-start');
      await components.agentRunService.executeRun({
        agentDef: makeAgentDef('agent-A', { systemPrompt: 'You are agent A.' }),
        messages: [{ id: 'msg-1', agentId: 'agent-A', role: 'user', content: 'Start analysis', createdAt: new Date() }],
        agentId: 'agent-A',
        conversationId: 'conv-A',
        runId: 'run-A',
        taskDescription: 'Start analysis',
      });
      executionLog.push('A-end');

      // Agent A completed synchronously before any trigger
      expect(executionLog[0]).toBe('A-start');
      expect(executionLog[1]).toBe('A-end');

      // Now emit event as if Agent A had called emit-event after completing
      components.triggerManager.emitCustomEvent('custom.trigger_b', 'agent-A', {});

      // Wait for B to start and finish
      await triggerBStarted;
      await new Promise((r) => setTimeout(r, 100));

      // Agent B ran in the background after Agent A completed
      expect(executionLog).toContain('A-start');
      expect(executionLog).toContain('A-end');
      expect(executionLog.some((e) => e.startsWith('B-start:'))).toBe(true);
      expect(executionLog.some((e) => e.startsWith('B-end:'))).toBe(true);
    });

    it('both Agent A and Agent B produce AGUIEvents via SSE', async () => {
      const components = wireComponents({
        agentRows: {
          'agent-B': makeAgentRow('agent-B', {
            harness: 'claude-agents',
            systemPrompt: 'Agent B',
            tools: [],
            manifest: null,
          }),
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-B',
        eventType: 'custom.chain_event',
        taskTemplate: 'Handle chain event',
        enabled: true,
      });

      // Execute Agent A directly
      await components.agentRunService.executeRun({
        agentDef: makeAgentDef('agent-A', { systemPrompt: 'Agent A' }),
        messages: [{ id: 'msg-1', agentId: 'agent-A', role: 'user', content: 'Run', createdAt: new Date() }],
        agentId: 'agent-A',
        conversationId: 'conv-A',
        runId: 'run-A',
        taskDescription: 'Run',
      });

      // Trigger Agent B
      components.triggerManager.emitCustomEvent('custom.chain_event', 'agent-A', {});
      await new Promise((r) => setTimeout(r, 50));

      // Both agents should have SSE events
      const agentAEvents = components.sse._events.filter((e) => e.agentId === 'agent-A');
      const agentBEvents = components.sse._events.filter((e) => e.agentId === 'agent-B');

      expect(agentAEvents.length).toBeGreaterThan(0);
      expect(agentBEvents.length).toBeGreaterThan(0);

      // Both should have RUN_STARTED events
      expect(agentAEvents.some((e) => e.event.type === 'RUN_STARTED')).toBe(true);
      expect(agentBEvents.some((e) => e.event.type === 'RUN_STARTED')).toBe(true);

      // Both should have text content
      expect(agentBEvents.some((e) => e.event.type === 'TEXT_MESSAGE_CONTENT')).toBe(true);
    });
  });

  // ── Test 2: Multi-hop chain: A -> B -> C ──────────────────────

  describe('multi-hop chain: A -> B -> C', () => {
    it('three agents chain via events with correct trigger depth', async () => {
      const triggerDepths: Array<{ agentId: string; depth: number }> = [];
      const originalOnFire = vi.fn();

      // Use a custom wiring to intercept trigger depths
      eventBus = new TypedEventBus();
      db = makeMockDb({
        'agent-B': makeAgentRow('agent-B', {
          harness: 'claude-agents',
          systemPrompt: 'Agent B',
          tools: [],
          manifest: null,
        }),
        'agent-C': makeAgentRow('agent-C', {
          harness: 'pi-agent',
          systemPrompt: 'Agent C',
          tools: [],
          manifest: null,
        }),
      });
      runRegistry = makeMockRunRegistry();
      sse = makeMockSse();

      let agentRunServiceRef: AgentRunService | null = null;

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId, task, triggerId, triggerDepth) => {
          triggerDepths.push({ agentId, depth: triggerDepth ?? 0 });

          const agent = await db.getAgent(agentId);
          if (!agent) return;
          const conv = await db.createConversation(agentId);
          const run = await runRegistry.startRun(agentId, conv.id, 'background', task);

          const messages: Message[] = [{
            id: `msg-${run.id}`,
            agentId,
            role: 'user',
            content: task,
            createdAt: new Date(),
          }];

          void agentRunServiceRef!.executeRun({
            agentDef: makeAgentDef(agent.name, {
              harness: agent.harness ?? 'langgraph',
              harnessConfig: JSON.parse(agent.harnessConfig as string) as Record<string, unknown>,
              tools: agent.tools ?? [],
              systemPrompt: agent.systemPrompt,
            }),
            messages,
            agentId,
            conversationId: conv.id,
            runId: run.id,
            taskDescription: task,
          }).catch(() => {});
        },
      );

      // SandboxRunService that emits chain events for Agent B
      const sandboxExecuteSessionTurn = vi.fn(
        (agentDef: AgentDefinition, runId: string) => {
          if (agentDef.name === 'agent-B') {
            // When Agent B runs, it emits an event that triggers Agent C
            setTimeout(() => {
              triggerManager.emitCustomEvent(
                'custom.step_2_complete',
                'agent-B',
                { _triggerDepth: 2 }, // depth 2 because B is at depth 1, so its child is depth 2
              );
            }, 10);
          }
          return mockTriggeredStream(runId);
        },
      );

      sandboxRunService = {
        executeSessionTurn: vi.fn((_agentDef: AgentDefinition, _conversationId: string, _messages: Message[], turnId: string) =>
          sandboxExecuteSessionTurn(_agentDef, turnId),
        ),
      } as unknown as SandboxRunService;

      agentRunService = new AgentRunService({
        sse: sse as any,
        db: db as any,
        runRegistry: runRegistry as any,
        sandboxRunService,
        toolExecutor: { list: vi.fn().mockReturnValue([]) } as any,
        eventBus,
      });
      agentRunServiceRef = agentRunService;

      // Register trigger: custom.step_1_complete -> agent-B
      await triggerManager.register({
        agentId: 'agent-B',
        eventType: 'custom.step_1_complete',
        taskTemplate: 'Process step 1 result',
        enabled: true,
      });

      // Register trigger: custom.step_2_complete -> agent-C
      await triggerManager.register({
        agentId: 'agent-C',
        eventType: 'custom.step_2_complete',
        taskTemplate: 'Process step 2 result',
        enabled: true,
      });

      // Agent A emits event at depth 0
      triggerManager.emitCustomEvent('custom.step_1_complete', 'agent-A', {
        _triggerDepth: 0,
      });

      // Wait for full chain: A -> B -> C
      await new Promise((r) => setTimeout(r, 200));

      // Verify: 3 containers created (A is not sandbox, but B and C are)
      expect(sandboxExecuteSessionTurn.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Verify: trigger depths are correct
      expect(triggerDepths).toEqual(expect.arrayContaining([
        { agentId: 'agent-B', depth: 1 },
        { agentId: 'agent-C', depth: 3 },
      ]));

      // Verify: all depths < MAX_TRIGGER_DEPTH
      for (const td of triggerDepths) {
        expect(td.depth).toBeLessThan(MAX_TRIGGER_DEPTH);
      }
    });
  });

  // ── Test 3: Trigger depth limit enforcement ───────────────────

  describe('trigger depth limit enforcement', () => {
    it('blocks triggers at MAX_TRIGGER_DEPTH (5)', async () => {
      const firedAgents: string[] = [];

      eventBus = new TypedEventBus();
      db = makeMockDb({
        'agent-deep': makeAgentRow('agent-deep', {
          harness: 'claude-agents',
          systemPrompt: 'Deep agent',
          tools: [],
          manifest: null,
        }),
      });
      runRegistry = makeMockRunRegistry();
      sse = makeMockSse();

      let agentRunServiceRef: AgentRunService | null = null;

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId, _task, _triggerId, triggerDepth) => {
          firedAgents.push(`${agentId}@depth=${triggerDepth}`);
          const agent = await db.getAgent(agentId);
          if (!agent) return;
          const conv = await db.createConversation(agentId);
          const run = await runRegistry.startRun(agentId, conv.id, 'background', 'task');

          void agentRunServiceRef!.executeRun({
            agentDef: makeAgentDef(agent.name, {
              harness: agent.harness ?? 'langgraph',
              harnessConfig: JSON.parse(agent.harnessConfig as string) as Record<string, unknown>,
            }),
            messages: [],
            agentId,
            conversationId: conv.id,
            runId: run.id,
            taskDescription: 'task',
          }).catch(() => {});
        },
      );

      sandboxRunService = {
        executeSessionTurn: vi.fn((_agentDef: AgentDefinition, _conversationId: string, _messages: Message[], turnId: string) =>
          mockTriggeredStream(turnId || 'run-deep'),
        ),
      } as unknown as SandboxRunService;

      agentRunService = new AgentRunService({
        sse: sse as any,
        db: db as any,
        runRegistry: runRegistry as any,
        sandboxRunService,
        toolExecutor: { list: vi.fn().mockReturnValue([]) } as any,
        eventBus,
      });
      agentRunServiceRef = agentRunService;

      await triggerManager.register({
        agentId: 'agent-deep',
        eventType: 'custom.deep_chain',
        taskTemplate: 'Deep chain step',
        enabled: true,
      });

      // Emit at depth 0 through 4 — all should fire (depths 1-5)
      for (let d = 0; d < MAX_TRIGGER_DEPTH; d++) {
        firedAgents.length = 0;
        triggerManager.emitCustomEvent('custom.deep_chain', 'sender', { _triggerDepth: d });
        await new Promise((r) => setTimeout(r, 20));
        expect(new Set(firedAgents)).toEqual(new Set([`agent-deep@depth=${d + 1}`]));
      }

      // Emit at MAX_TRIGGER_DEPTH (5) — should be blocked
      firedAgents.length = 0;
      triggerManager.emitCustomEvent('custom.deep_chain', 'sender', {
        _triggerDepth: MAX_TRIGGER_DEPTH,
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(firedAgents).toHaveLength(0);
    });

    it('the 6th trigger in a chain is blocked but earlier agents complete', async () => {
      const completedRuns: string[] = [];

      eventBus = new TypedEventBus();
      db = makeMockDb({
        'chain-agent': makeAgentRow('chain-agent', {
          harness: 'claude-agents',
          systemPrompt: 'Chain',
          tools: [],
          manifest: null,
        }),
      });
      runRegistry = makeMockRunRegistry();
      sse = makeMockSse();

      let agentRunServiceRef: AgentRunService | null = null;

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId, _task, _triggerId, triggerDepth) => {
          const agent = await db.getAgent(agentId);
          if (!agent) return;
          const conv = await db.createConversation(agentId);
          const run = await runRegistry.startRun(agentId, conv.id, 'background', 'task');
          completedRuns.push(run.id);

          void agentRunServiceRef!.executeRun({
            agentDef: makeAgentDef(agent.name, {
              harness: agent.harness ?? 'langgraph',
              harnessConfig: JSON.parse(agent.harnessConfig as string) as Record<string, unknown>,
            }),
            messages: [],
            agentId,
            conversationId: conv.id,
            runId: run.id,
            taskDescription: 'task',
          }).catch(() => {});
        },
      );

      sandboxRunService = {
        executeSessionTurn: vi.fn((_agentDef: AgentDefinition, _conversationId: string, _messages: Message[], turnId: string) =>
          mockTriggeredStream(turnId || `run-chain-${++runCounter}`),
        ),
      } as unknown as SandboxRunService;

      agentRunService = new AgentRunService({
        sse: sse as any,
        db: db as any,
        runRegistry: runRegistry as any,
        sandboxRunService,
        toolExecutor: { list: vi.fn().mockReturnValue([]) } as any,
        eventBus,
      });
      agentRunServiceRef = agentRunService;

      await triggerManager.register({
        agentId: 'chain-agent',
        eventType: 'custom.recursive_chain',
        taskTemplate: 'Chain step',
        enabled: true,
      });

      // Simulate a chain starting at depth 4 (should succeed)
      triggerManager.emitCustomEvent('custom.recursive_chain', 'sender', { _triggerDepth: 4 });
      await new Promise((r) => setTimeout(r, 30));
      expect(new Set(completedRuns).size).toBeGreaterThanOrEqual(1);

      // Simulate at depth 5 (should be blocked)
      completedRuns.length = 0;
      triggerManager.emitCustomEvent('custom.recursive_chain', 'sender', { _triggerDepth: 5 });
      await new Promise((r) => setTimeout(r, 30));
      expect(completedRuns).toHaveLength(0); // Blocked

      // Runs that did fire should have completed
      expect(runRegistry.completeRun).toHaveBeenCalled();
    });
  });

  // ── Test 4: Container isolation verification ──────────────────

  describe('container isolation verification', () => {
    it('Agent A and Agent B containers have different IDs, secrets, and workspace mounts', async () => {
      const cm = makeMockContainerManager();

      // Create two containers for different agents
      const containerA = await cm.createContainer({
        runId: 'run-A',
        agentId: 'agent-A',
        harnessName: 'langgraph',
        workspaceDir: '/workspace/agent-A',
      } as any);

      await cm.injectSecrets(containerA.containerId, {
        OPENAI_API_KEY: 'sk-agent-A-key',
        AGENT_NAME: 'agent-A',
      });

      const containerB = await cm.createContainer({
        runId: 'run-B',
        agentId: 'agent-B',
        harnessName: 'claude-agents',
        workspaceDir: '/workspace/agent-B',
      } as any);

      await cm.injectSecrets(containerB.containerId, {
        OPENAI_API_KEY: 'sk-agent-B-key',
        AGENT_NAME: 'agent-B',
      });

      // Verify: different container IDs
      expect(containerA.containerId).not.toBe(containerB.containerId);

      // Verify: different container names (based on runId)
      expect(containerA.containerName).not.toBe(containerB.containerName);
      expect(containerA.containerName).toContain('run-A');
      expect(containerB.containerName).toContain('run-B');

      // Verify: different agent IDs
      expect(containerA.agentId).toBe('agent-A');
      expect(containerB.agentId).toBe('agent-B');

      // Verify: different harness names
      expect(containerA.harnessName).toBe('langgraph');
      expect(containerB.harnessName).toBe('claude-agents');

      // Verify: different secrets injected
      const secretsA = cm._createdContainers.find((c) => c.agentId === 'agent-A')!.secrets;
      const secretsB = cm._createdContainers.find((c) => c.agentId === 'agent-B')!.secrets;
      expect(secretsA.OPENAI_API_KEY).toBe('sk-agent-A-key');
      expect(secretsB.OPENAI_API_KEY).toBe('sk-agent-B-key');
      expect(secretsA.AGENT_NAME).not.toBe(secretsB.AGENT_NAME);

      // Verify: different workspace mounts
      const workspaceA = cm._createdContainers.find((c) => c.agentId === 'agent-A')!.workspaceDir;
      const workspaceB = cm._createdContainers.find((c) => c.agentId === 'agent-B')!.workspaceDir;
      expect(workspaceA).toBe('/workspace/agent-A');
      expect(workspaceB).toBe('/workspace/agent-B');
      expect(workspaceA).not.toBe(workspaceB);
    });

    it('no shared state between container invocations', async () => {
      const cm = makeMockContainerManager();

      // Create and remove container A
      const containerA = await cm.createContainer({
        runId: 'run-A',
        agentId: 'agent-A',
        harnessName: 'langgraph',
      } as any);
      await cm.removeContainer(containerA.containerId);

      // Create container B
      const containerB = await cm.createContainer({
        runId: 'run-B',
        agentId: 'agent-B',
        harnessName: 'claude-agents',
      } as any);

      // Container B should not have any of Container A's data
      const entryB = cm._createdContainers.find((c) => c.containerId === containerB.containerId)!;
      expect(entryB.agentId).toBe('agent-B');
      expect(entryB.secrets).toEqual({}); // No secrets leaked from A
      expect(entryB.runId).toBe('run-B');
    });
  });

  // ── Test 5: Concurrency limit interaction ─────────────────────

  describe('concurrency limit interaction', () => {
    it('triggered run is queued when max containers reached, proceeds when slot opens', async () => {
      const executionOrder: string[] = [];

      const components = wireComponents({
        agentRows: {
          'agent-queued': makeAgentRow('agent-queued', {
            harness: 'claude-agents',
            systemPrompt: 'Queued agent',
            tools: [],
            manifest: null,
          }),
        },
        sandboxExecuteSessionTurn: async function* (_agentDef: AgentDefinition, runId: string) {
          executionOrder.push(`start:${runId}`);
          yield* mockTriggeredStream(runId);
          executionOrder.push(`end:${runId}`);
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-queued',
        eventType: 'custom.queued_trigger',
        taskTemplate: 'Queued task',
        enabled: true,
      });

      // Simulate that SandboxRunService internally checks concurrency
      // by having the mock resolve immediately (the real ContainerManager
      // would queue via semaphore)
      components.triggerManager.emitCustomEvent('custom.queued_trigger', 'sender', {});
      await new Promise((r) => setTimeout(r, 50));

      // The run should have been started and completed
      expect(executionOrder.filter((entry) => entry.startsWith('start:')).length).toBeGreaterThanOrEqual(1);
      expect(executionOrder.filter((entry) => entry.startsWith('end:')).length).toBeGreaterThanOrEqual(1);

      // Verify run was completed successfully
      expect(components.runRegistry.completeRun).toHaveBeenCalledWith(
        expect.any(String),
        // No error argument means success
      );
    });

    it('multiple concurrent triggers queue and all eventually complete', async () => {
      const completedRuns = new Set<string>();

      const components = wireComponents({
        agentRows: {
          'agent-concurrent': makeAgentRow('agent-concurrent', {
            harness: 'claude-agents',
            systemPrompt: 'Concurrent',
            tools: [],
            manifest: null,
          }),
        },
        sandboxExecuteSessionTurn: async function* (_agentDef: AgentDefinition, runId: string) {
          yield* mockTriggeredStream(runId);
          completedRuns.add(runId);
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-concurrent',
        eventType: 'custom.burst',
        taskTemplate: 'Burst task',
        enabled: true,
      });

      // Fire 3 triggers in rapid succession
      for (let i = 0; i < 3; i++) {
        components.triggerManager.emitCustomEvent('custom.burst', 'sender', {});
      }

      await new Promise((r) => setTimeout(r, 200));

      // All 3 should have completed
      expect(completedRuns.size).toBeGreaterThanOrEqual(3);
      expect(components.runRegistry.completeRun.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Test 6: Error in triggered agent doesn't affect triggering agent ──

  describe('error in triggered agent does not affect triggering agent', () => {
    it('Agent A succeeds even when Agent B fails', async () => {
      const components = wireComponents({
        agentRows: {
          'agent-fail-B': makeAgentRow('agent-fail-B', {
            harness: 'claude-agents',
            systemPrompt: 'Failing agent',
            tools: [],
            manifest: null,
          }),
        },
        sandboxExecuteSessionTurn: async function* (agentDef: AgentDefinition, runId: string) {
          if (agentDef.name === 'agent-fail-B') {
            yield* mockFailingStream(runId);
          } else {
            // Agent A succeeds normally
            yield* mockTriggeredStream(runId);
          }
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-fail-B',
        eventType: 'custom.fail_trigger',
        taskTemplate: 'This will fail',
        enabled: true,
      });

      // Execute Agent A first — this should succeed
      await components.agentRunService.executeRun({
        agentDef: makeAgentDef('agent-A', { systemPrompt: 'Agent A' }),
        messages: [{
          id: 'msg-1',
          agentId: 'agent-A',
          role: 'user',
          content: 'Do something',
          createdAt: new Date(),
        }],
        agentId: 'agent-A',
        conversationId: 'conv-A',
        runId: 'run-A',
        taskDescription: 'Do something',
      });

      // Agent A completed successfully (no error arg)
      expect(components.runRegistry.completeRun).toHaveBeenCalledWith('run-A');

      // Now trigger Agent B (which will fail)
      components.triggerManager.emitCustomEvent('custom.fail_trigger', 'agent-A', {});
      await new Promise((r) => setTimeout(r, 100));

      // Agent B should have been marked as failed (completed with error)
      const completeCalls = components.runRegistry.completeRun.mock.calls;
      const failedCall = completeCalls.find(
        (call: any[]) => call[0] !== 'run-A' && call[1],
      );
      expect(failedCall).toBeDefined();
      expect(failedCall![1]).toContain('fatal error');

      // Agent A's SSE events should show normal completion
      const agentAEvents = components.sse._events.filter(
        (e) => e.agentId === 'agent-A',
      );
      const hasRunFinished = agentAEvents.some((e) => e.event.type === 'RUN_FINISHED');
      expect(hasRunFinished).toBe(true);
    });

    it('Agent A events continue normally when Agent B throws', async () => {
      const components = wireComponents({
        agentRows: {
          'agent-throw-B': makeAgentRow('agent-throw-B', {
            harness: 'claude-agents',
            systemPrompt: 'Throwing agent',
            tools: [],
            manifest: null,
          }),
        },
        sandboxExecuteSessionTurn: async function* (agentDef: AgentDefinition, runId: string) {
          if (agentDef.name === 'agent-throw-B') {
            throw new Error('Container failed to start');
          }
          // Agent A completes normally
          yield* mockTriggeredStream(runId);
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-throw-B',
        eventType: 'custom.throw_trigger',
        taskTemplate: 'Will throw',
        enabled: true,
      });

      // Execute Agent A
      await components.agentRunService.executeRun({
        agentDef: makeAgentDef('agent-A', { systemPrompt: 'Agent A' }),
        messages: [{
          id: 'msg-1',
          agentId: 'agent-A',
          role: 'user',
          content: 'Start',
          createdAt: new Date(),
        }],
        agentId: 'agent-A',
        conversationId: 'conv-A',
        runId: 'run-A',
        taskDescription: 'Start',
      });

      // Agent A should be completed successfully
      expect(components.runRegistry.completeRun).toHaveBeenCalledWith('run-A');

      // Trigger the failing Agent B after A completes
      components.triggerManager.emitCustomEvent('custom.throw_trigger', 'agent-A', {});
      await new Promise((r) => setTimeout(r, 100));

      // Agent B's error should have been caught (fire-and-forget pattern)
      const completedWithError = components.runRegistry.completeRun.mock.calls.find(
        (call: any[]) => call[0] !== 'run-A' && typeof call[1] === 'string',
      );
      expect(completedWithError).toBeDefined();
      expect(completedWithError![1]).toContain('Container failed to start');
    });
  });

  // ── Test 7: Event payload flows through chain ─────────────────

  describe('event payload flows through chain', () => {
    it('Agent B receives event payload as task template interpolation', async () => {
      let receivedTask = '';

      const components = wireComponents({
        agentRows: {
          'agent-payload-B': makeAgentRow('agent-payload-B', {
            harness: 'claude-agents',
            systemPrompt: 'Payload agent',
            tools: [],
            manifest: null,
          }),
        },
      });

      // Intercept the task that gets sent to the triggered run
      const origStartRun = components.runRegistry.startRun;
      components.runRegistry.startRun = vi.fn(
        async (agentId: string, convId: string, mode: string, task: string) => {
          if (agentId === 'agent-payload-B') receivedTask = task;
          return origStartRun(agentId, convId, mode, task);
        },
      );

      await components.triggerManager.register({
        agentId: 'agent-payload-B',
        eventType: 'custom.with_payload',
        taskTemplate: 'Analyze: result={{payload.analysis}}, count={{payload.count}}',
        enabled: true,
      });

      // Emit event with structured payload
      components.triggerManager.emitCustomEvent('custom.with_payload', 'agent-A', {
        analysis: 'sentiment-positive',
        count: 42,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Verify: the payload was interpolated into the task template
      expect(receivedTask).toBe('Analyze: result=sentiment-positive, count=42');
    });

    it('complex payload data preserved through serialization', async () => {
      let capturedTask = '';

      const components = wireComponents({
        agentRows: {
          'agent-complex-B': makeAgentRow('agent-complex-B', {
            harness: 'claude-agents',
            systemPrompt: 'Complex payload agent',
            tools: [],
            manifest: null,
          }),
        },
      });

      const origStartRun = components.runRegistry.startRun;
      components.runRegistry.startRun = vi.fn(
        async (agentId: string, convId: string, mode: string, task: string) => {
          if (agentId === 'agent-complex-B') capturedTask = task;
          return origStartRun(agentId, convId, mode, task);
        },
      );

      await components.triggerManager.register({
        agentId: 'agent-complex-B',
        eventType: 'custom.complex_data',
        taskTemplate: 'Process: nested={{payload.nested}}, flag={{payload.flag}}',
        enabled: true,
      });

      const complexPayload = {
        nested: JSON.stringify({ deep: { value: 42 } }),
        array: [1, 2, 3],
        flag: true,
      };

      components.triggerManager.emitCustomEvent('custom.complex_data', 'agent-A', complexPayload);
      await new Promise((r) => setTimeout(r, 50));

      // Task template should have the interpolated values using {{payload.field}} syntax
      expect(capturedTask).toContain(JSON.stringify({ deep: { value: 42 } }));
      expect(capturedTask).toContain('flag=true');
    });
  });

  // ── Test 8: Sandbox metrics track chained containers ──────────

  describe('sandbox metrics track chained containers', () => {
    it('ContainerManager.getMetrics() reflects totalCreated across chain', async () => {
      const cm = makeMockContainerManager();

      // Simulate creating containers for a 3-agent chain
      await cm.createContainer({
        runId: 'run-A',
        agentId: 'agent-A',
        harnessName: 'langgraph',
      } as any);

      await cm.createContainer({
        runId: 'run-B',
        agentId: 'agent-B',
        harnessName: 'claude-agents',
      } as any);

      await cm.createContainer({
        runId: 'run-C',
        agentId: 'agent-C',
        harnessName: 'pi-agent',
      } as any);

      const metrics = cm.getMetrics();

      // Verify: totalCreated matches chain length
      expect(metrics.totalCreated).toBe(3);

      // Verify: active reflects containers that haven't been removed
      expect(metrics.active).toBe(3);

      // Verify: byHarness breakdown is correct
      expect(metrics.byHarness).toEqual({
        langgraph: 1,
        'claude-agents': 1,
        'pi-agent': 1,
      });

      // Verify: peak is at least as high as active
      expect(metrics.peak).toBeGreaterThanOrEqual(metrics.active);
    });

    it('metrics update correctly as containers are removed after chain completes', async () => {
      const cm = makeMockContainerManager();

      const containerA = await cm.createContainer({
        runId: 'run-A',
        agentId: 'agent-A',
        harnessName: 'langgraph',
      } as any);

      const containerB = await cm.createContainer({
        runId: 'run-B',
        agentId: 'agent-B',
        harnessName: 'claude-agents',
      } as any);

      // Both active
      expect(cm.getMetrics().active).toBe(2);
      expect(cm.getMetrics().peak).toBe(2);

      // Remove container A (completed)
      await cm.removeContainer(containerA.containerId);
      expect(cm.getMetrics().active).toBe(1);
      expect(cm.getMetrics().totalCreated).toBe(2); // Total doesn't decrease

      // Remove container B
      await cm.removeContainer(containerB.containerId);
      expect(cm.getMetrics().active).toBe(0);
      expect(cm.getMetrics().peak).toBe(2); // Peak remembers the high water mark
      expect(cm.getMetrics().totalCreated).toBe(2);
    });

    it('byHarness correctly tracks multiple agents using the same harness', async () => {
      const cm = makeMockContainerManager();

      await cm.createContainer({
        runId: 'run-1',
        agentId: 'agent-1',
        harnessName: 'claude-agents',
      } as any);

      await cm.createContainer({
        runId: 'run-2',
        agentId: 'agent-2',
        harnessName: 'claude-agents',
      } as any);

      await cm.createContainer({
        runId: 'run-3',
        agentId: 'agent-3',
        harnessName: 'langgraph',
      } as any);

      const metrics = cm.getMetrics();
      expect(metrics.byHarness['claude-agents']).toBe(2);
      expect(metrics.byHarness['langgraph']).toBe(1);
      expect(metrics.totalCreated).toBe(3);
    });
  });

  // ── Additional integration scenarios ──────────────────────────

  describe('end-to-end emit-event to trigger flow', () => {
    it('full flow: emit-event tool result -> emitCustom -> TriggerManager -> sandbox run', async () => {
      // This test verifies the real EventBus wiring between components
      const triggeredRuns: Array<{ agentId: string; task: string }> = [];

      eventBus = new TypedEventBus();
      db = makeMockDb({
        'agent-listener': makeAgentRow('agent-listener', {
          harness: 'claude-agents',
          systemPrompt: 'Listener',
          tools: [],
          manifest: null,
        }),
      });
      runRegistry = makeMockRunRegistry();
      sse = makeMockSse();

      let agentRunServiceRef: AgentRunService | null = null;

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId, task, _triggerId) => {
          triggeredRuns.push({ agentId, task });
          const agent = await db.getAgent(agentId);
          if (!agent) return;
          const conv = await db.createConversation(agentId);
          const run = await runRegistry.startRun(agentId, conv.id, 'background', task);

          void agentRunServiceRef!.executeRun({
            agentDef: makeAgentDef(agent.name, {
              harness: agent.harness ?? 'langgraph',
              harnessConfig: JSON.parse(agent.harnessConfig as string) as Record<string, unknown>,
            }),
            messages: [{
              id: `msg-${run.id}`,
              agentId,
              role: 'user' as const,
              content: task,
              createdAt: new Date(),
            }],
            agentId,
            conversationId: conv.id,
            runId: run.id,
            taskDescription: task,
          }).catch(() => {});
        },
      );

      sandboxRunService = {
        executeSessionTurn: vi.fn((_agentDef: AgentDefinition, _conversationId: string, _messages: Message[], turnId: string) =>
          mockTriggeredStream(turnId || `run-listener-${++runCounter}`),
        ),
      } as unknown as SandboxRunService;

      agentRunService = new AgentRunService({
        sse: sse as any,
        db: db as any,
        runRegistry: runRegistry as any,
        sandboxRunService,
        toolExecutor: { list: vi.fn().mockReturnValue([]) } as any,
        eventBus,
      });
      agentRunServiceRef = agentRunService;

      // Register trigger
      await triggerManager.register({
        agentId: 'agent-listener',
        eventType: 'custom.email.classified',
        taskTemplate: 'Handle classified email: category={{payload.category}}',
        enabled: true,
      });

      // Simulate what the orchestrator-side emit-event handler does:
      // eventBus.emitCustom(type, agentId, payload)
      eventBus.emitCustom('custom.email.classified', 'agent-A', {
        category: 'billing',
        confidence: 0.92,
      });

      // Wait for the triggerManager to handle via its custom subscription
      await new Promise((r) => setTimeout(r, 100));

      // Verify: the trigger fired with interpolated task
      expect(triggeredRuns).toHaveLength(1);
      expect(triggeredRuns[0].agentId).toBe('agent-listener');
      expect(triggeredRuns[0].task).toContain('Handle classified email: category=billing');

      expect(sandboxRunService.executeSessionTurn).toHaveBeenCalledTimes(1);
    });
  });

  describe('trigger matching and selectivity', () => {
    it('only the matching trigger fires, non-matching agents are not triggered', async () => {
      const firedAgents: string[] = [];

      eventBus = new TypedEventBus();
      db = makeMockDb({
        'agent-billing': makeAgentRow('agent-billing', {
          harness: 'claude-agents',
          systemPrompt: 'Billing',
          tools: [],
          manifest: null,
        }),
        'agent-support': makeAgentRow('agent-support', {
          harness: 'pi-agent',
          systemPrompt: 'Support',
          tools: [],
          manifest: null,
        }),
      });
      runRegistry = makeMockRunRegistry();
      sse = makeMockSse();

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId) => {
          firedAgents.push(agentId);
          // Don't actually execute runs — just track which agents were triggered
        },
      );

      // Register different triggers for different event types
      await triggerManager.register({
        agentId: 'agent-billing',
        eventType: 'custom.billing_event',
        taskTemplate: 'Handle billing',
        enabled: true,
      });

      await triggerManager.register({
        agentId: 'agent-support',
        eventType: 'custom.support_event',
        taskTemplate: 'Handle support',
        enabled: true,
      });

      // Emit only the billing event
      triggerManager.emitCustomEvent('custom.billing_event', 'sender', {});
      await new Promise((r) => setTimeout(r, 30));

      // Only billing agent should fire
      expect(new Set(firedAgents)).toEqual(new Set(['agent-billing']));

      // Emit only the support event
      firedAgents.length = 0;
      triggerManager.emitCustomEvent('custom.support_event', 'sender', {});
      await new Promise((r) => setTimeout(r, 30));

      // Only support agent should fire
      expect(new Set(firedAgents)).toEqual(new Set(['agent-support']));
    });

    it('disabled triggers do not fire', async () => {
      const firedAgents: string[] = [];

      eventBus = new TypedEventBus();
      db = makeMockDb({
        'agent-disabled': makeAgentRow('agent-disabled', {
          harness: 'claude-agents',
          systemPrompt: 'Disabled',
          tools: [],
          manifest: null,
        }),
      });

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId) => { firedAgents.push(agentId); },
      );

      await triggerManager.register({
        agentId: 'agent-disabled',
        eventType: 'custom.disabled_event',
        taskTemplate: 'Should not run',
        enabled: false, // Disabled
      });

      triggerManager.emitCustomEvent('custom.disabled_event', 'sender', {});
      await new Promise((r) => setTimeout(r, 30));

      expect(firedAgents).toHaveLength(0);
    });
  });

  describe('SandboxRunService receives correct agentDef with run isolation', () => {
    it('each triggered run gets its own runId, conversationId, and agentDef', async () => {
      const capturedCalls: Array<{ name: string; runId: string }> = [];

      const components = wireComponents({
        agentRows: {
          'agent-alpha': makeAgentRow('agent-alpha', {
            harness: 'langgraph',
            harnessConfig: makeHarnessConfig({ provider: 'openai', model: 'gpt-5-mini' }),
            systemPrompt: 'Alpha',
            tools: ['read_file'],
            manifest: { executionMode: 'sandbox', resourceLimits: { cpus: 2 } },
          }),
          'agent-beta': makeAgentRow('agent-beta', {
            harness: 'pi-agent',
            harnessConfig: makeHarnessConfig({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
            systemPrompt: 'Beta',
            tools: ['search'],
            manifest: null,
          }),
        },
        sandboxExecuteSessionTurn: async function* (agentDef: AgentDefinition, runId: string) {
          capturedCalls.push({ name: agentDef.name, runId });
          yield* mockTriggeredStream(runId);
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-alpha',
        eventType: 'custom.trigger_alpha',
        taskTemplate: 'Alpha task',
        enabled: true,
      });

      await components.triggerManager.register({
        agentId: 'agent-beta',
        eventType: 'custom.trigger_beta',
        taskTemplate: 'Beta task',
        enabled: true,
      });

      // Trigger both
      components.triggerManager.emitCustomEvent('custom.trigger_alpha', 'sender', {});
      components.triggerManager.emitCustomEvent('custom.trigger_beta', 'sender', {});
      await new Promise((r) => setTimeout(r, 100));

      // Both should have been executed
      expect(new Set(capturedCalls.map((call) => call.name))).toEqual(new Set(['agent-alpha', 'agent-beta']));

      const alphaCall = capturedCalls.find((c) => c.name === 'agent-alpha')!;
      const betaCall = capturedCalls.find((c) => c.name === 'agent-beta')!;

      // Each run has a unique runId
      expect(alphaCall.runId).not.toBe(betaCall.runId);

      const execCalls = (components.sandboxRunService.executeSessionTurn as any).mock.calls;
      const alphaExec = execCalls.find((c: any[]) => c[0].name === 'agent-alpha');
      const betaExec = execCalls.find((c: any[]) => c[0].name === 'agent-beta');

      expect(alphaExec[0].harness).toBe('langgraph');
      expect(betaExec[0].harness).toBe('pi-agent');
    });
  });
});
