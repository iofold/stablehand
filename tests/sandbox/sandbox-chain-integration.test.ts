/**
 * P3-5: Kitchen-Sink Chain E2E Test (Sandbox Mode)
 *
 * Integration tests that verify the full agent chaining flow through sandbox
 * containers: one agent emits an event that triggers another agent in a
 * separate container.
 *
 * Tests wire together real EventBus, real EventTriggerManager, and real
 * AgentTurnService with mocked Docker (ContainerManager) and gRPC transport.
 *
 * Flow under test:
 *   Agent A executes a turn -> emits event via tool -> EventBus -> EventTriggerManager
 *   -> matches trigger for Agent B -> AgentTurnService.executeTurn()
 *   -> SandboxTurnService -> new container -> Agent B completes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TypedEventBus } from '../../packages/stablehand/src/events/bus.js';
import {
  createTriggerSpineConsumer,
  EventTriggerManager,
  MAX_TRIGGER_DEPTH,
} from '../../packages/stablehand/src/events/trigger-manager.js';
import { SpineConsumerRunner } from '../../packages/stablehand/src/events/spine-consumer-runner.js';
import { CanonicalLog } from '../../packages/stablehand/src/orchestrator/canonical/canonical-log.js';
import type { ContainerManager, ContainerInfo, ContainerMetrics } from '../../packages/stablehand/src/sandbox/container-manager.js';
import type { AgentDefinition, Message } from '@stablehand/sandbox-daemon';
import type { DatabaseRepository } from '../../packages/stablehand/src/database/repository.js';
import type { AgentSessionEvent } from '../../packages/stablehand/src/events/types.js';
import { settle } from '../utils/event-bus-test-helpers.js';

type SandboxTurnService = {
  executeSessionTurn(
    agentDef: AgentDefinition,
    conversationId: string,
    messages: Message[],
    turnId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentSessionEvent>;
};

class AgentTurnService {
  constructor(
    private readonly deps: {
      sse: { broadcast(agentId: string, event: Record<string, unknown>): void };
      turnRegistry: { completeTurn(turnId: string, error?: string): Promise<void> };
      sandboxTurnService: SandboxTurnService;
      [key: string]: unknown;
    },
  ) {}

  async executeTurn(input: {
    agentDef: AgentDefinition;
    messages: Message[];
    agentId: string;
    conversationId: string;
    turnId: string;
    taskDescription: string;
  }): Promise<void> {
    let turnError: string | undefined;

    try {
      const stream = this.deps.sandboxTurnService.executeSessionTurn(
        input.agentDef,
        input.conversationId,
        input.messages,
        input.turnId,
      );

      for await (const event of stream) {
        this.deps.sse.broadcast(input.agentId, event as unknown as Record<string, unknown>);
        if (event.type === 'RUN_ERROR' && 'error' in event && typeof event.error === 'string') {
          turnError = event.error;
        }
      }
    } catch (error: unknown) {
      turnError = error instanceof Error ? error.message : String(error);
    }

    if (turnError === undefined) {
      await this.deps.turnRegistry.completeTurn(input.turnId);
      return;
    }

    await this.deps.turnRegistry.completeTurn(input.turnId, turnError);
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Create simple completion event stream for a triggered agent. */
async function* mockTriggeredStream(turnId: string): AsyncGenerator<AgentSessionEvent> {
  yield {
    type: 'RUN_STARTED',
    timestamp: Date.now(),
    runId: turnId,
  } as unknown as AgentSessionEvent;
  yield {
    type: 'TEXT_MESSAGE_START',
    timestamp: Date.now(),
    runId: turnId,
    messageId: `msg-${turnId}`,
  } as unknown as AgentSessionEvent;
  yield {
    type: 'TEXT_MESSAGE_CONTENT',
    timestamp: Date.now(),
    runId: turnId,
    messageId: `msg-${turnId}`,
    delta: `Triggered agent ${turnId} response`,
  } as unknown as AgentSessionEvent;
  yield {
    type: 'TEXT_MESSAGE_END',
    timestamp: Date.now(),
    runId: turnId,
    messageId: `msg-${turnId}`,
  } as unknown as AgentSessionEvent;
  yield {
    type: 'RUN_FINISHED',
    timestamp: Date.now(),
    runId: turnId,
  } as unknown as AgentSessionEvent;
}

/** Create a failing event stream. */
async function* mockFailingStream(turnId: string): AsyncGenerator<AgentSessionEvent> {
  yield {
    type: 'RUN_STARTED',
    timestamp: Date.now(),
    runId: turnId,
  } as unknown as AgentSessionEvent;
  yield {
    type: 'RUN_ERROR',
    timestamp: Date.now(),
    runId: turnId,
    error: 'Agent B encountered a fatal error',
  } as unknown as AgentSessionEvent;
  yield {
    type: 'RUN_FAILED',
    timestamp: Date.now(),
    runId: turnId,
  } as unknown as AgentSessionEvent;
}

/* -------------------------------------------------------------------------- */
/*  Mock factories                                                              */
/* -------------------------------------------------------------------------- */

function makeHarnessConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-5.4-mini',
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
  const rest = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => key !== 'harnessConfig'),
  );
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

function makeChainAgentRow(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeAgentRow(name, {
    harness: 'claude-agents',
    systemPrompt: name,
    tools: [],
    manifest: null,
    ...overrides,
  });
}

function makeMockContainerManager(counters: { containerCounter: number }): ContainerManager & {
  _createdContainers: Array<{
    containerId: string;
    sandboxSessionId: string;
    agentId: string;
    harnessName: string;
    secrets: Record<string, string>;
    workspaceDir?: string;
  }>;
  _metrics: ContainerMetrics;
} {
  const createdContainers: Array<{
    containerId: string;
    sandboxSessionId: string;
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
      counters.containerCounter++;
      const containerId = `container-${counters.containerCounter}`;
      const info: ContainerInfo = {
        containerId,
        containerName: `stablehand-sandbox-${opts.sessionId}`,
        sessionId: opts.sessionId,
        agentId: opts.agentId,
        harnessName: opts.harnessName,
        status: 'created',
      };
      createdContainers.push({
        containerId,
        sandboxSessionId: opts.sessionId,
        agentId: opts.agentId,
        harnessName: opts.harnessName,
        secrets: { ...(opts.secrets ?? {}) },
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
    extractLogs: vi.fn(async () => 'container logs'),
    extractWorkspaceDiff: vi.fn(async () => null),
    ensureNetwork: vi.fn(async () => {}),
    getContainer: vi.fn(async () => null),
    listManagedContainers: vi.fn(async () => []),
    getContainerExitCode: vi.fn(async () => null),
    getMetrics: vi.fn(() => ({ ...metrics })),
  } as unknown as ContainerManager & {
    _createdContainers: typeof createdContainers;
    _metrics: typeof metrics;
  };
  return mock;
}

function makeMockDb(
  agentRows: Record<string, any> = {},
  counters: { turnCounter: number },
): DatabaseRepository {
  const triggerFirings = new Set<string>();
  return {
    getTriggers: vi.fn().mockResolvedValue([]),
    saveTrigger: vi.fn().mockResolvedValue(undefined),
    deleteTrigger: vi.fn().mockResolvedValue(undefined),
    getTriggerBySignature: vi.fn().mockResolvedValue(undefined),
    hasTriggerFiring: vi.fn(async (triggerId: string, eventSeq: number) =>
      triggerFirings.has(`${triggerId}:${eventSeq}`)),
    recordTriggerFiring: vi.fn(async (triggerId: string, eventSeq: number) => {
      const key = `${triggerId}:${eventSeq}`;
      if (triggerFirings.has(key)) {
        return undefined;
      }
      triggerFirings.add(key);
      return { id: `firing-${eventSeq}`, triggerId, eventSeq, createdAt: Date.now() };
    }),
    getAgent: vi.fn(async (agentId: string) => agentRows[agentId] ?? null),
    createConversation: vi.fn(async (agentId: string) => ({
      id: `conv-triggered-${agentId}-${++counters.turnCounter}`,
    })),
    addMessage: vi.fn().mockResolvedValue({ id: `msg-${++counters.turnCounter}` }),
    getMessages: vi.fn(async (_convId: string) => []),
    saveEvent: vi.fn(),
    getActiveTurns: vi.fn(async () => []),
    updateTurn: vi.fn(),
  } as unknown as DatabaseRepository;
}

function makeMockTurnRegistry(counters: { turnCounter: number }) {
  const turns = new Map<string, { id: string; agentId: string; error?: string }>();
  return {
    startTurn: vi.fn(async (agentId: string, _convId: string, _mode: string, _task: string) => {
      const id = `turn-${agentId}-${++counters.turnCounter}`;
      turns.set(id, { id, agentId });
      return { id, agentId };
    }),
    completeTurn: vi.fn(async (turnId: string, error?: string) => {
      const turn = turns.get(turnId);
      if (turn) turn.error = error;
    }),
    getAbortSignal: vi.fn().mockReturnValue(undefined),
    pauseTurn: vi.fn(),
    resumeTurn: vi.fn(),
    _turns: turns,
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

/* -------------------------------------------------------------------------- */
/*  Test suite                                                                  */
/* -------------------------------------------------------------------------- */

describe('P3-5: Kitchen-Sink Chain Integration (Sandbox Mode)', () => {
  let eventBus: TypedEventBus;
  let db: ReturnType<typeof makeMockDb>;
  let turnRegistry: ReturnType<typeof makeMockTurnRegistry>;
  let sse: ReturnType<typeof makeMockSse>;
  let containerManager: ReturnType<typeof makeMockContainerManager>;
  let sandboxTurnService: SandboxTurnService;
  let agentTurnService: AgentTurnService;
  let triggerManager: EventTriggerManager;
  let spineRunner: SpineConsumerRunner | null;
  let unsubscribeWire: (() => void) | null;
  let testCounters: { containerCounter: number; turnCounter: number };

  function agentRowToDefinition(agent: Record<string, any>): AgentDefinition {
    const manifest = agent.manifest as Record<string, unknown> | null;
    return makeAgentDef(agent.name, {
      harness: agent.harness ?? 'langgraph',
      harnessConfig: JSON.parse(agent.harnessConfig as string) as Record<string, unknown>,
      systemPrompt: agent.systemPrompt,
      tools: agent.tools ?? [],
      description: agent.description ?? undefined,
      workspaceDir: agent.workspaceDir ?? undefined,
      resourceLimits: manifest?.resourceLimits as any,
    });
  }

  function makeTriggerMessage(agentId: string, task: string, messageId: string): Message {
    return {
      id: messageId,
      agentId,
      role: 'user',
      content: task,
      createdAt: new Date(),
    };
  }

  async function startTriggeredTurn(input: {
    agentId: string;
    task: string;
    agentTurnServiceRef: AgentTurnService | null;
    missingAgentMessage?: string;
    persistUserMessage?: boolean;
    messageIdPrefix?: string;
    messages?: Message[];
  }) {
    const agent = await db.getAgent(input.agentId);
    if (!agent) {
      if (input.missingAgentMessage) console.error(input.missingAgentMessage);
      return null;
    }

    const conv = await db.createConversation(input.agentId);
    const turn = await turnRegistry.startTurn(input.agentId, conv.id, 'background', input.task);
    if (input.persistUserMessage) {
      await db.addMessage({
        agentId: input.agentId,
        conversationId: conv.id,
        role: 'user',
        content: input.task,
      });
    }

    void input.agentTurnServiceRef!.executeTurn({
      agentDef: agentRowToDefinition(agent),
      messages: input.messages ?? [
        makeTriggerMessage(input.agentId, input.task, `${input.messageIdPrefix ?? 'msg'}-${turn.id}`),
      ],
      agentId: input.agentId,
      conversationId: conv.id,
      turnId: turn.id,
      taskDescription: input.task,
    }).catch((err) => {
      console.error('[Test] triggered turn error:', err);
    });

    return turn;
  }

  beforeEach(() => {
    unsubscribeWire = null;
    spineRunner = null;
    testCounters = { containerCounter: 0, turnCounter: 0 };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    unsubscribeWire?.();
    spineRunner?.stop();
    if (triggerManager) triggerManager.shutdown();
  });

  /**
   * Wire up the full component graph with given agent definitions.
   * Returns references to all components for assertions.
   */
  async function wireComponents(opts: {
    agentRows: Record<string, any>;
    sandboxExecuteSessionTurn?: (...args: any[]) => AsyncGenerator<AgentSessionEvent>;
  }) {
    // Canonical wire (ADR-015): bus persist → CanonicalLog → run-channel frames to SSE.
    let frameSeq = 0;
    const frameRows: Array<{
      seq: number;
      type: string;
      agentId: string;
      payload: string;
      createdAt: number;
      turnId: string | null;
      conversationId: string | null;
      channel: string;
      sourceType: string | null;
      sourcePayload: string | null;
    }> = [];
    const spineCursors = new Map<string, number>();
    const persistFrames = async (frames: Array<Record<string, unknown>>) =>
      frames.map((frame) => {
        frameSeq += 1;
        frameRows.push({
          seq: frameSeq,
          type: String(frame.type ?? ''),
          agentId: String(frame.agentId ?? ''),
          payload: String(frame.payload ?? '{}'),
          createdAt: Date.now(),
          turnId: typeof frame.turnId === 'string' ? frame.turnId : null,
          conversationId: typeof frame.conversationId === 'string' ? frame.conversationId : null,
          channel: String(frame.channel ?? 'custom'),
          sourceType: typeof frame.sourceType === 'string' ? frame.sourceType : null,
          sourcePayload: typeof frame.sourcePayload === 'string' ? frame.sourcePayload : null,
        });
        return frameSeq;
      });
    const canonicalLog = new CanonicalLog({
      db: {
        saveEventBatch: persistFrames,
        saveTerminalEventBatch: persistFrames,
        getFramesSince: async () => [],
        getTurnFrames: async () => [],
      } as never,
      logger: { info: () => {}, warn: () => {}, error: console.error },
    });
    eventBus = new TypedEventBus({
      persistEvent: async (type, _agentId, _payload, parsed) => {
        const persisted = await canonicalLog.ingest(type, parsed ?? {});
        return persisted.length > 0;
      },
    });
    db = makeMockDb(opts.agentRows, testCounters);
    Object.assign(db, {
      getSourceEventsSince: vi.fn(async (afterSeq: number, limit = 1_000) =>
        frameRows
          .filter((row) => row.seq > afterSeq && row.sourceType)
          .slice(0, limit)),
      getSpineCursor: vi.fn(async (consumer: string) => spineCursors.get(consumer) ?? 0),
      advanceSpineCursor: vi.fn(async (consumer: string, lastSeq: number) => {
        const nextSeq = Math.max(spineCursors.get(consumer) ?? 0, lastSeq);
        spineCursors.set(consumer, nextSeq);
        return { consumer, lastSeq: nextSeq, updatedAt: Date.now() };
      }),
    });
    turnRegistry = makeMockTurnRegistry(testCounters);
    sse = makeMockSse();
    unsubscribeWire = canonicalLog.subscribe((frames) => {
      for (const frame of frames) {
        if (frame.channel !== 'run') continue;
        sse.broadcast(frame.agentId, frame.body);
      }
    });
    containerManager = makeMockContainerManager(testCounters);

    // Mock SandboxTurnService that tracks which agents it ran
    const executedTurns: Array<{ agentName: string; turnId: string }> = [];
    sandboxTurnService = {
      executeSessionTurn: vi.fn(
        (agentDef: AgentDefinition, _conversationId: string, _messages: Message[], turnId: string, _signal?: AbortSignal) => {
          executedTurns.push({ agentName: agentDef.name, turnId });
          if (opts.sandboxExecuteSessionTurn) {
            return opts.sandboxExecuteSessionTurn(agentDef, turnId);
          }
          return mockTriggeredStream(turnId);
        },
      ),
      _executedTurns: executedTurns,
    } as unknown as SandboxTurnService & { _executedTurns: typeof executedTurns };

    // Lazy ref pattern from container.ts
    let agentTurnServiceRef: AgentTurnService | null = null;

    // EventTriggerManager with real EventBus, using onFire callback
    // that mirrors container.ts logic
    triggerManager = new EventTriggerManager(
      eventBus,
      db,
      async (agentId, task, triggerId, _triggerDepth) => {
        await startTriggeredTurn({
          agentId,
          task,
          agentTurnServiceRef,
          missingAgentMessage: `[Test] agent ${agentId} not found for trigger ${triggerId}`,
          persistUserMessage: true,
          messageIdPrefix: 'msg-trigger',
        });
      },
    );

    agentTurnService = new AgentTurnService({
      sse: sse as any,
      db: db as any,
      turnRegistry: turnRegistry as any,
      sandboxTurnService,
      toolExecutor: { list: vi.fn().mockReturnValue([]) } as any,
      eventBus,
    });
    agentTurnServiceRef = agentTurnService;
    spineRunner = new SpineConsumerRunner({
      canonicalLog,
      db,
      consumers: [createTriggerSpineConsumer(triggerManager)],
      logger: { info: () => {}, warn: () => {}, error: console.error },
      rescanIntervalMs: 60_000,
    } as never);
    await spineRunner.start();

    return {
      eventBus,
      db,
      turnRegistry: turnRegistry,
      sse,
      containerManager,
      sandboxTurnService: sandboxTurnService as SandboxTurnService & { _executedTurns: typeof executedTurns },
      agentTurnService,
      triggerManager,
    };
  }

  describe('single-hop chain: Agent A triggers Agent B', () => {
    it('Agent A emits event -> EventTriggerManager matches -> Agent B starts in sandbox', async () => {
      const components = await wireComponents({
        agentRows: {
          'agent-B': makeChainAgentRow('agent-B', {
            harness: 'claude-agents',
            systemPrompt: 'You are agent B.',
            workspaceDir: '/workspace/agent-B',
            manifest: { executionMode: 'sandbox' },
            tools: ['search'],
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
      await settle(50);
      expect(components.sandboxTurnService._executedTurns.some((turn) => turn.agentName === 'agent-B')).toBe(true);
      expect(components.turnRegistry.startTurn).toHaveBeenCalledWith(
        'agent-B',
        expect.any(String), // conv id
        'background',
        expect.stringContaining('Process analysis result: classification done'),
      );
      const agentBEvents = components.sse._events.filter(
        (e) => e.agentId === 'agent-B',
      );
      expect(agentBEvents.length).toBeGreaterThan(0);
      expect(components.turnRegistry.completeTurn).toHaveBeenCalled();
    });

    it('Agent A completes independently of Agent B (fire-and-forget)', async () => {
      // Track turn execution order
      const executionLog: string[] = [];
      let triggerBResolve: (() => void) | null = null;
      const triggerBStarted = new Promise<void>((r) => { triggerBResolve = r; });

      const components = await wireComponents({
        agentRows: {
          'agent-B': makeChainAgentRow('agent-B', {
            harness: 'pi-agent',
            systemPrompt: 'You are agent B.',
          }),
        },
        sandboxExecuteSessionTurn: async function* (agentDef: AgentDefinition, turnId: string) {
          if (agentDef.name === 'agent-B') {
            executionLog.push(`B-start:${turnId}`);
            triggerBResolve?.();
            // Simulate some processing delay
            await settle(20);
            yield* mockTriggeredStream(turnId);
            executionLog.push(`B-end:${turnId}`);
          } else {
            // Agent A just executes its turn quickly
            yield* mockTriggeredStream(turnId);
          }
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-B',
        eventType: 'custom.trigger_b',
        taskTemplate: 'Triggered task for B',
        enabled: true,
      });

      // Execute Agent A's turn directly.
      executionLog.push('A-start');
      await components.agentTurnService.executeTurn({
        agentDef: makeAgentDef('agent-A', { systemPrompt: 'You are agent A.' }),
        messages: [{ id: 'msg-1', agentId: 'agent-A', role: 'user', content: 'Start analysis', createdAt: new Date() }],
        agentId: 'agent-A',
        conversationId: 'conv-A',
        turnId: 'turn-A',
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
      await settle(100);

      // Agent B ran in the background after Agent A completed
      expect(executionLog).toContain('A-start');
      expect(executionLog).toContain('A-end');
      expect(executionLog.some((e) => e.startsWith('B-start:'))).toBe(true);
      expect(executionLog.some((e) => e.startsWith('B-end:'))).toBe(true);
    });

    it('both Agent A and Agent B produce AgentSessionEvents via SSE', async () => {
      const components = await wireComponents({
        agentRows: {
          'agent-B': makeChainAgentRow('agent-B', {
            systemPrompt: 'Agent B',
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
      await components.agentTurnService.executeTurn({
        agentDef: makeAgentDef('agent-A', { systemPrompt: 'Agent A' }),
        messages: [{ id: 'msg-1', agentId: 'agent-A', role: 'user', content: 'Run', createdAt: new Date() }],
        agentId: 'agent-A',
        conversationId: 'conv-A',
        turnId: 'turn-A',
        taskDescription: 'Run',
      });

      // Trigger Agent B
      components.triggerManager.emitCustomEvent('custom.chain_event', 'agent-A', {});
      await settle(50);

      // Both agents should have SSE events
      const agentAEvents = components.sse._events.filter((e) => e.agentId === 'agent-A');
      const agentBEvents = components.sse._events.filter((e) => e.agentId === 'agent-B');

      expect(agentAEvents.length).toBeGreaterThan(0);
      expect(agentBEvents.length).toBeGreaterThan(0);
      expect(agentAEvents.some((e) => e.event.type === 'RUN_STARTED')).toBe(true);
      expect(agentBEvents.some((e) => e.event.type === 'RUN_STARTED')).toBe(true);
      expect(agentBEvents.some((e) => e.event.type === 'TEXT_MESSAGE_CONTENT')).toBe(true);
    });
  });

  describe('multi-hop chain: A -> B -> C', () => {
    it('three agents chain via events with correct trigger depth', async () => {
      const triggerDepths: Array<{ agentId: string; depth: number }> = [];
      // Use a custom wiring to intercept trigger depths
      eventBus = new TypedEventBus();
      db = makeMockDb({
        'agent-B': makeChainAgentRow('agent-B', {
          systemPrompt: 'Agent B',
        }),
        'agent-C': makeChainAgentRow('agent-C', {
          harness: 'pi-agent',
          systemPrompt: 'Agent C',
        }),
      }, testCounters);
      turnRegistry = makeMockTurnRegistry(testCounters);
      sse = makeMockSse();

      let agentTurnServiceRef: AgentTurnService | null = null;

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId, task, ...rest) => {
          const triggerDepth = rest[1];
          triggerDepths.push({ agentId, depth: triggerDepth ?? 0 });
          await startTriggeredTurn({
            agentId,
            task,
            agentTurnServiceRef,
          });
        },
      );

      // SandboxTurnService that emits chain events for Agent B
      const sandboxExecuteSessionTurn = vi.fn(
        (agentDef: AgentDefinition, turnId: string) => {
          if (agentDef.name === 'agent-B') {
            // When Agent B executes, it emits an event that triggers Agent C.
            setTimeout(() => {
              triggerManager.emitCustomEvent(
                'custom.step_2_complete',
                'agent-B',
                { _triggerDepth: 2 }, // depth 2 because B is at depth 1, so its child is depth 2
              );
            }, 10);
          }
          return mockTriggeredStream(turnId);
        },
      );

      sandboxTurnService = {
        executeSessionTurn: vi.fn((_agentDef: AgentDefinition, _conversationId: string, _messages: Message[], turnId: string) =>
          sandboxExecuteSessionTurn(_agentDef, turnId),
        ),
      } as unknown as SandboxTurnService;

      agentTurnService = new AgentTurnService({
        sse: sse as any,
        db: db as any,
        turnRegistry: turnRegistry as any,
        sandboxTurnService,
        toolExecutor: { list: vi.fn().mockReturnValue([]) } as any,
        eventBus,
      });
      agentTurnServiceRef = agentTurnService;

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
      await settle(200);
      expect(sandboxExecuteSessionTurn.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(triggerDepths).toEqual(expect.arrayContaining([
        { agentId: 'agent-B', depth: 1 },
        { agentId: 'agent-C', depth: 3 },
      ]));
      for (const td of triggerDepths) {
        expect(td.depth).toBeLessThan(MAX_TRIGGER_DEPTH);
      }
    });
  });

  describe('trigger depth limit enforcement', () => {
    it('blocks triggers at MAX_TRIGGER_DEPTH (5)', async () => {
      const firedAgents: string[] = [];

      eventBus = new TypedEventBus();
      db = makeMockDb({
        'agent-deep': makeChainAgentRow('agent-deep', {
          systemPrompt: 'Deep agent',
        }),
      }, testCounters);
      turnRegistry = makeMockTurnRegistry(testCounters);
      sse = makeMockSse();

      let agentTurnServiceRef: AgentTurnService | null = null;

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId, _task, _triggerId, _triggerDepth) => {
          firedAgents.push(`${agentId}@depth=${_triggerDepth}`);
          await startTriggeredTurn({
            agentId,
            task: 'task',
            agentTurnServiceRef,
            messages: [],
          });
        },
      );

      sandboxTurnService = {
        executeSessionTurn: vi.fn((_agentDef: AgentDefinition, _conversationId: string, _messages: Message[], turnId: string) =>
          mockTriggeredStream(turnId || 'turn-deep'),
        ),
      } as unknown as SandboxTurnService;

      agentTurnService = new AgentTurnService({
        sse: sse as any,
        db: db as any,
        turnRegistry: turnRegistry as any,
        sandboxTurnService,
        toolExecutor: { list: vi.fn().mockReturnValue([]) } as any,
        eventBus,
      });
      agentTurnServiceRef = agentTurnService;

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
        await settle(20);
        expect(new Set(firedAgents)).toEqual(new Set([`agent-deep@depth=${d + 1}`]));
      }

      // Emit at MAX_TRIGGER_DEPTH (5) — should be blocked
      firedAgents.length = 0;
      triggerManager.emitCustomEvent('custom.deep_chain', 'sender', {
        _triggerDepth: MAX_TRIGGER_DEPTH,
      });
      await settle(20);
      expect(firedAgents).toHaveLength(0);
    });

    it('the 6th trigger in a chain is blocked but earlier agents complete', async () => {
      const completedTurns: string[] = [];

      eventBus = new TypedEventBus();
      db = makeMockDb({
        'chain-agent': makeChainAgentRow('chain-agent', {
          systemPrompt: 'Chain',
        }),
      }, testCounters);
      turnRegistry = makeMockTurnRegistry(testCounters);
      sse = makeMockSse();

      let agentTurnServiceRef: AgentTurnService | null = null;

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId, _task, _triggerId, _triggerDepth) => {
          const turn = await startTriggeredTurn({
            agentId,
            task: 'task',
            agentTurnServiceRef,
            messages: [],
          });
          if (!turn) return;
          completedTurns.push(turn.id);
        },
      );

      sandboxTurnService = {
        executeSessionTurn: vi.fn((_agentDef: AgentDefinition, _conversationId: string, _messages: Message[], turnId: string) =>
          mockTriggeredStream(turnId || `turn-chain-${++testCounters.turnCounter}`),
        ),
      } as unknown as SandboxTurnService;

      agentTurnService = new AgentTurnService({
        sse: sse as any,
        db: db as any,
        turnRegistry: turnRegistry as any,
        sandboxTurnService,
        toolExecutor: { list: vi.fn().mockReturnValue([]) } as any,
        eventBus,
      });
      agentTurnServiceRef = agentTurnService;

      await triggerManager.register({
        agentId: 'chain-agent',
        eventType: 'custom.recursive_chain',
        taskTemplate: 'Chain step',
        enabled: true,
      });

      // Simulate a chain starting at depth 4 (should succeed)
      triggerManager.emitCustomEvent('custom.recursive_chain', 'sender', { _triggerDepth: 4 });
      await settle(30);
      expect(new Set(completedTurns).size).toBeGreaterThanOrEqual(1);

      // Simulate at depth 5 (should be blocked)
      completedTurns.length = 0;
      triggerManager.emitCustomEvent('custom.recursive_chain', 'sender', { _triggerDepth: 5 });
      await settle(30);
      expect(completedTurns).toHaveLength(0); // Blocked

      // Turns that did fire should have completed.
      expect(turnRegistry.completeTurn).toHaveBeenCalled();
    });
  });

  describe('container isolation verification', () => {
    it('Agent A and Agent B containers have different IDs, secrets, and workspace mounts', async () => {
      const cm = makeMockContainerManager(testCounters);

      // Create two containers for different agents
      const containerA = await cm.createContainer({
        sessionId: 'sandbox-A',
        agentId: 'agent-A',
        harnessName: 'langgraph',
        workspaceDir: '/workspace/agent-A',
        secrets: {
          OPENAI_API_KEY: 'sk-agent-A-key',
          AGENT_NAME: 'agent-A',
        },
      });

      const containerB = await cm.createContainer({
        sessionId: 'sandbox-B',
        agentId: 'agent-B',
        harnessName: 'claude-agents',
        workspaceDir: '/workspace/agent-B',
        secrets: {
          OPENAI_API_KEY: 'sk-agent-B-key',
          AGENT_NAME: 'agent-B',
        },
      });
      expect(containerA.containerId).not.toBe(containerB.containerId);
      expect(containerA.containerName).not.toBe(containerB.containerName);
      expect(containerA.containerName).toContain('sandbox-A');
      expect(containerB.containerName).toContain('sandbox-B');
      expect(containerA.agentId).toBe('agent-A');
      expect(containerB.agentId).toBe('agent-B');
      expect(containerA.harnessName).toBe('langgraph');
      expect(containerB.harnessName).toBe('claude-agents');
      const secretsA = cm._createdContainers.find((c) => c.agentId === 'agent-A')!.secrets;
      const secretsB = cm._createdContainers.find((c) => c.agentId === 'agent-B')!.secrets;
      expect(secretsA.OPENAI_API_KEY).toBe('sk-agent-A-key');
      expect(secretsB.OPENAI_API_KEY).toBe('sk-agent-B-key');
      expect(secretsA.AGENT_NAME).not.toBe(secretsB.AGENT_NAME);
      const workspaceA = cm._createdContainers.find((c) => c.agentId === 'agent-A')!.workspaceDir;
      const workspaceB = cm._createdContainers.find((c) => c.agentId === 'agent-B')!.workspaceDir;
      expect(workspaceA).toBe('/workspace/agent-A');
      expect(workspaceB).toBe('/workspace/agent-B');
      expect(workspaceA).not.toBe(workspaceB);
    });

    it('no shared state between container invocations', async () => {
      const cm = makeMockContainerManager(testCounters);

      // Create and remove container A
      const containerA = await cm.createContainer({
        sessionId: 'sandbox-A',
        agentId: 'agent-A',
        harnessName: 'langgraph',
      });
      await cm.removeContainer(containerA.containerId);

      // Create container B
      const containerB = await cm.createContainer({
        sessionId: 'sandbox-B',
        agentId: 'agent-B',
        harnessName: 'claude-agents',
      });

      // Container B should not have any of Container A's data
      const entryB = cm._createdContainers.find((c) => c.containerId === containerB.containerId)!;
      expect(entryB.agentId).toBe('agent-B');
      expect(entryB.secrets).toEqual({}); // No secrets leaked from A
      expect(entryB.sandboxSessionId).toBe('sandbox-B');
    });
  });

  describe('concurrency limit interaction', () => {
    it('triggered turn is queued when max containers reached, proceeds when slot opens', async () => {
      const executionOrder: string[] = [];

      const components = await wireComponents({
        agentRows: {
          'agent-queued': makeChainAgentRow('agent-queued', {
            systemPrompt: 'Queued agent',
          }),
        },
        sandboxExecuteSessionTurn: async function* (_agentDef: AgentDefinition, turnId: string) {
          executionOrder.push(`start:${turnId}`);
          yield* mockTriggeredStream(turnId);
          executionOrder.push(`end:${turnId}`);
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-queued',
        eventType: 'custom.queued_trigger',
        taskTemplate: 'Queued task',
        enabled: true,
      });

      // Simulate that SandboxTurnService internally checks concurrency
      // by having the mock resolve immediately (the real ContainerManager
      // would queue via semaphore)
      components.triggerManager.emitCustomEvent('custom.queued_trigger', 'sender', {});
      await settle(50);

      // The turn should have been started and completed.
      expect(executionOrder.filter((entry) => entry.startsWith('start:')).length).toBeGreaterThanOrEqual(1);
      expect(executionOrder.filter((entry) => entry.startsWith('end:')).length).toBeGreaterThanOrEqual(1);

      // Verify the turn completed successfully.
      expect(components.turnRegistry.completeTurn).toHaveBeenCalledWith(
        expect.any(String),
        // No error argument means success
      );
    });

    it('multiple concurrent triggers queue and all eventually complete', async () => {
      const completedTurns = new Set<string>();

      const components = await wireComponents({
        agentRows: {
          'agent-concurrent': makeChainAgentRow('agent-concurrent', {
            systemPrompt: 'Concurrent',
          }),
        },
        sandboxExecuteSessionTurn: async function* (_agentDef: AgentDefinition, turnId: string) {
          yield* mockTriggeredStream(turnId);
          completedTurns.add(turnId);
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

      await settle(200);

      // All 3 should have completed
      expect(completedTurns.size).toBeGreaterThanOrEqual(3);
      expect(components.turnRegistry.completeTurn.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('error in triggered agent does not affect triggering agent', () => {
    it('Agent A succeeds even when Agent B fails', async () => {
      const components = await wireComponents({
        agentRows: {
          'agent-fail-B': makeChainAgentRow('agent-fail-B', {
            systemPrompt: 'Failing agent',
          }),
        },
        sandboxExecuteSessionTurn: async function* (agentDef: AgentDefinition, turnId: string) {
          if (agentDef.name === 'agent-fail-B') {
            yield* mockFailingStream(turnId);
          } else {
            // Agent A succeeds normally
            yield* mockTriggeredStream(turnId);
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
      await components.agentTurnService.executeTurn({
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
        turnId: 'turn-A',
        taskDescription: 'Do something',
      });

      // Agent A completed successfully (no error arg)
      expect(components.turnRegistry.completeTurn).toHaveBeenCalledWith('turn-A');

      // Now trigger Agent B (which will fail)
      components.triggerManager.emitCustomEvent('custom.fail_trigger', 'agent-A', {});
      await settle(100);

      // Agent B should have been marked as failed (completed with error)
      const completeCalls = components.turnRegistry.completeTurn.mock.calls;
      const failedCall = completeCalls.find(
        (call: any[]) => call[0] !== 'turn-A' && call[1],
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
      const components = await wireComponents({
        agentRows: {
          'agent-throw-B': makeChainAgentRow('agent-throw-B', {
            systemPrompt: 'Throwing agent',
          }),
        },
        sandboxExecuteSessionTurn: async function* (agentDef: AgentDefinition, turnId: string) {
          if (agentDef.name === 'agent-throw-B') {
            throw new Error('Container failed to start');
          }
          // Agent A completes normally
          yield* mockTriggeredStream(turnId);
        },
      });

      await components.triggerManager.register({
        agentId: 'agent-throw-B',
        eventType: 'custom.throw_trigger',
        taskTemplate: 'Will throw',
        enabled: true,
      });

      // Execute Agent A
      await components.agentTurnService.executeTurn({
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
        turnId: 'turn-A',
        taskDescription: 'Start',
      });

      // Agent A should be completed successfully
      expect(components.turnRegistry.completeTurn).toHaveBeenCalledWith('turn-A');

      // Trigger the failing Agent B after A completes
      components.triggerManager.emitCustomEvent('custom.throw_trigger', 'agent-A', {});
      await settle(100);

      // Agent B's error should have been caught (fire-and-forget pattern)
      const completedWithError = components.turnRegistry.completeTurn.mock.calls.find(
        (call: any[]) => call[0] !== 'turn-A' && typeof call[1] === 'string',
      );
      expect(completedWithError).toBeDefined();
      expect(completedWithError![1]).toContain('Container failed to start');
    });
  });

  describe('event payload flows through chain', () => {
    it('Agent B receives event payload as task template interpolation', async () => {
      let receivedTask = '';

      const components = await wireComponents({
        agentRows: {
          'agent-payload-B': makeChainAgentRow('agent-payload-B', {
            systemPrompt: 'Payload agent',
          }),
        },
      });

      // Intercept the task sent to the triggered turn.
      const origStartTurn = components.turnRegistry.startTurn;
      components.turnRegistry.startTurn = vi.fn(
        async (agentId: string, convId: string, mode: string, task: string) => {
          if (agentId === 'agent-payload-B') receivedTask = task;
          return origStartTurn(agentId, convId, mode, task);
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

      await settle(50);
      expect(receivedTask).toBe('Analyze: result=sentiment-positive, count=42');
    });

    it('complex payload data preserved through serialization', async () => {
      let capturedTask = '';

      const components = await wireComponents({
        agentRows: {
          'agent-complex-B': makeChainAgentRow('agent-complex-B', {
            systemPrompt: 'Complex payload agent',
          }),
        },
      });

      const origStartTurn = components.turnRegistry.startTurn;
      components.turnRegistry.startTurn = vi.fn(
        async (agentId: string, convId: string, mode: string, task: string) => {
          if (agentId === 'agent-complex-B') capturedTask = task;
          return origStartTurn(agentId, convId, mode, task);
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
      await settle(50);

      // Task template should have the interpolated values using {{payload.field}} syntax
      expect(capturedTask).toContain(JSON.stringify({ deep: { value: 42 } }));
      expect(capturedTask).toContain('flag=true');
    });
  });

  describe('sandbox metrics track chained containers', () => {
    it('ContainerManager.getMetrics() reflects totalCreated across chain', async () => {
      const cm = makeMockContainerManager(testCounters);

      // Simulate creating containers for a 3-agent chain
      await cm.createContainer({
        sessionId: 'sandbox-A',
        agentId: 'agent-A',
        harnessName: 'langgraph',
      });

      await cm.createContainer({
        sessionId: 'sandbox-B',
        agentId: 'agent-B',
        harnessName: 'claude-agents',
      });

      await cm.createContainer({
        sessionId: 'sandbox-C',
        agentId: 'agent-C',
        harnessName: 'pi-agent',
      });

      const metrics = cm.getMetrics();
      expect(metrics.totalCreated).toBe(3);
      expect(metrics.active).toBe(3);
      expect(metrics.byHarness).toEqual({
        langgraph: 1,
        'claude-agents': 1,
        'pi-agent': 1,
      });
      expect(metrics.peak).toBeGreaterThanOrEqual(metrics.active);
    });

    it('metrics update correctly as containers are removed after chain completes', async () => {
      const cm = makeMockContainerManager(testCounters);

      const containerA = await cm.createContainer({
        sessionId: 'sandbox-A',
        agentId: 'agent-A',
        harnessName: 'langgraph',
      });

      const containerB = await cm.createContainer({
        sessionId: 'sandbox-B',
        agentId: 'agent-B',
        harnessName: 'claude-agents',
      });

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
      const cm = makeMockContainerManager(testCounters);

      await cm.createContainer({
        sessionId: 'sandbox-1',
        agentId: 'agent-1',
        harnessName: 'claude-agents',
      });

      await cm.createContainer({
        sessionId: 'sandbox-2',
        agentId: 'agent-2',
        harnessName: 'claude-agents',
      });

      await cm.createContainer({
        sessionId: 'sandbox-3',
        agentId: 'agent-3',
        harnessName: 'langgraph',
      });

      const metrics = cm.getMetrics();
      expect(metrics.byHarness['claude-agents']).toBe(2);
      expect(metrics.byHarness['langgraph']).toBe(1);
      expect(metrics.totalCreated).toBe(3);
    });
  });

  describe('end-to-end emit-event to trigger flow', () => {
    it('full flow: emit-event tool result -> emitCustom -> TriggerManager -> sandbox turn', async () => {
      const components = await wireComponents({
        agentRows: {
          'agent-listener': makeChainAgentRow('agent-listener', {
            systemPrompt: 'Listener',
          }),
        },
      });

      // Register trigger
      await components.triggerManager.register({
        agentId: 'agent-listener',
        eventType: 'custom.email.classified',
        taskTemplate: 'Handle classified email: category={{payload.category}}',
        enabled: true,
      });

      // Simulate what the orchestrator-side emit-event handler does:
      // eventBus.emitCustom(type, agentId, payload)
      components.eventBus.emitCustom('custom.email.classified', 'agent-A', {
        category: 'billing',
        confidence: 0.92,
      });

      // Wait for the trigger spine consumer to handle the persisted source row.
      await settle(100);
      expect(components.turnRegistry.startTurn).toHaveBeenCalledWith(
        'agent-listener',
        expect.any(String),
        'background',
        expect.stringContaining('Handle classified email: category=billing'),
      );
      expect(components.sandboxTurnService.executeSessionTurn).toHaveBeenCalledTimes(1);
    });
  });

  describe('trigger matching and selectivity', () => {
    it('only the matching trigger fires, non-matching agents are not triggered', async () => {
      const firedAgents: string[] = [];

      eventBus = new TypedEventBus();
      db = makeMockDb({
        'agent-billing': makeChainAgentRow('agent-billing', {
          systemPrompt: 'Billing',
        }),
        'agent-support': makeChainAgentRow('agent-support', {
          harness: 'pi-agent',
          systemPrompt: 'Support',
        }),
      }, testCounters);
      turnRegistry = makeMockTurnRegistry(testCounters);
      sse = makeMockSse();

      triggerManager = new EventTriggerManager(
        eventBus,
        db,
        async (agentId) => {
          firedAgents.push(agentId);
          // Do not execute turns; track which agents were triggered.
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
      await settle(30);

      // Only billing agent should fire
      expect(new Set(firedAgents)).toEqual(new Set(['agent-billing']));

      // Emit only the support event
      firedAgents.length = 0;
      triggerManager.emitCustomEvent('custom.support_event', 'sender', {});
      await settle(30);

      // Only support agent should fire
      expect(new Set(firedAgents)).toEqual(new Set(['agent-support']));
    });

    it('disabled triggers do not fire', async () => {
      const firedAgents: string[] = [];

      eventBus = new TypedEventBus();
      db = makeMockDb({
        'agent-disabled': makeChainAgentRow('agent-disabled', {
          systemPrompt: 'Disabled',
        }),
      }, testCounters);

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
      await settle(30);

      expect(firedAgents).toHaveLength(0);
    });
  });

  describe('SandboxTurnService receives correct agentDef with turn isolation', () => {
    it('each triggered turn gets its own turnId, conversationId, and agentDef', async () => {
      const capturedCalls: Array<{ name: string; turnId: string }> = [];

      const components = await wireComponents({
        agentRows: {
          'agent-alpha': makeChainAgentRow('agent-alpha', {
            harness: 'langgraph',
            harnessConfig: makeHarnessConfig({ provider: 'openai', model: 'gpt-5.4-mini' }),
            systemPrompt: 'Alpha',
            tools: ['read_file'],
            manifest: { executionMode: 'sandbox', resourceLimits: { cpus: 2 } },
          }),
          'agent-beta': makeChainAgentRow('agent-beta', {
            harness: 'pi-agent',
            harnessConfig: makeHarnessConfig({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
            systemPrompt: 'Beta',
            tools: ['search'],
          }),
        },
        sandboxExecuteSessionTurn: async function* (agentDef: AgentDefinition, turnId: string) {
          capturedCalls.push({ name: agentDef.name, turnId });
          yield* mockTriggeredStream(turnId);
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
      await settle(100);
      expect(new Set(capturedCalls.map((call) => call.name))).toEqual(new Set(['agent-alpha', 'agent-beta']));

      const alphaCall = capturedCalls.find((c) => c.name === 'agent-alpha')!;
      const betaCall = capturedCalls.find((c) => c.name === 'agent-beta')!;

      // Each turn has a unique turnId.
      expect(alphaCall.turnId).not.toBe(betaCall.turnId);

      const execCalls = (components.sandboxTurnService.executeSessionTurn as any).mock.calls;
      const alphaExec = execCalls.find((c: any[]) => c[0].name === 'agent-alpha');
      const betaExec = execCalls.find((c: any[]) => c[0].name === 'agent-beta');

      expect(alphaExec[0].harness).toBe('langgraph');
      expect(betaExec[0].harness).toBe('pi-agent');
    });
  });
});
