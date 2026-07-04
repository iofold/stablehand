/**
 * Event Bus Test Helpers
 *
 * Reusable test utilities for event bus testing:
 * - createTestBus() factory
 * - collectEvents() / waitForEmit() collectors
 * - Mock factories for SSEManager and DatabaseRepository
 * - Event data builders for all EventMap event types
 */

import { vi } from 'vitest';
import {
  TypedEventBus,
  type EventMap,
  type EventName,
  type PersistEventFn,
} from '../../packages/ctxmill/src/events/bus.js';
import { CanonicalLog } from '../../packages/ctxmill/src/orchestrator/canonical/canonical-log.js';

// ── Test Bus Factory ────────────────────────────────────────────

export function createTestBus(options?: { persistEvent?: PersistEventFn }): TypedEventBus {
  return new TypedEventBus(options);
}

// ── Event Collectors ────────────────────────────────────────────

/**
 * Accumulate all events of a type into an array for assertions.
 */
export function collectEvents<K extends EventName>(
  bus: TypedEventBus,
  eventType: K,
): { events: EventMap[K][]; unsubscribe: () => void } {
  const events: EventMap[K][] = [];
  const handler = (payload: EventMap[K]) => {
    events.push(payload);
  };
  bus.on(eventType, handler);
  return {
    events,
    unsubscribe: () => bus.off(eventType, handler),
  };
}

/**
 * Promise that resolves on next matching emit.
 */
export function waitForEmit<K extends EventName>(
  bus: TypedEventBus,
  eventType: K,
  opts?: { timeoutMs?: number; selector?: (p: EventMap[K]) => boolean },
): Promise<EventMap[K]> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const selector = opts?.selector;

  return new Promise<EventMap[K]>((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        bus.off(eventType, handler);
        reject(new Error(`waitForEmit('${eventType}') timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    function handler(payload: EventMap[K]) {
      if (selector && !selector(payload)) return;
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      bus.off(eventType, handler);
      resolve(payload);
    }

    bus.on(eventType, handler);
  });
}

// ── Mock Factories ──────────────────────────────────────────────

/**
 * Canonical wire harness (ADR-015): a bus whose persist hook feeds a
 * CanonicalLog over an in-memory frame store; run-channel frame bodies are
 * captured as the wire. Persist is async — call flushWire() after emits
 * before asserting.
 */
export function createCanonicalWireHarness() {
  let seq = 0;
  const log = new CanonicalLog({
    db: {
      saveEventBatch: async (frames: unknown[]) => frames.map(() => ++seq),
      getFramesSince: async () => [],
      getTurnFrames: async () => [],
    } as never,
    logger: { info: () => {}, warn: () => {}, error: console.error },
  });
  const wire: Array<{ agentId: string; event: Record<string, unknown> }> = [];
  log.subscribe((frames) => {
    for (const frame of frames) {
      if (frame.channel !== 'run') continue;
      wire.push({ agentId: frame.agentId, event: frame.body });
    }
  });
  const bus = createTestBus({
    persistEvent: async (type, _agentId, _payload, parsed) => {
      await log.ingest(type, parsed ?? {});
    },
  });
  return { bus, log, wire };
}

export async function flushWire(): Promise<void> {
  await new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
}

export function createMockSSEManager() {
  return {
    broadcast: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    shutdown: vi.fn(),
  };
}

export function createMockDatabase() {
  return {
    createAgent: vi.fn(),
    getAgent: vi.fn(),
    listAgents: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    createConversation: vi.fn(),
    getConversation: vi.fn(),
    listConversations: vi.fn(),
    addMessage: vi.fn(),
    getMessages: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(),
    updateRun: vi.fn(),
    createTurn: vi.fn(),
    updateTurn: vi.fn(),
    listRuns: vi.fn(),
    persistEvent: vi.fn(),
    getEventsSince: vi.fn(),
  };
}

// ── Event Data Builders ─────────────────────────────────────────

export function makeRunStartedEvent(
  overrides?: Partial<EventMap['turn.started']>,
): EventMap['turn.started'] {
  return {
    turnId: 'run-test-1',
    sessionId: 'run-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    mode: 'interactive',
    taskDescription: 'Test task',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeRunCompletedEvent(
  overrides?: Partial<EventMap['turn.completed']>,
): EventMap['turn.completed'] {
  return {
    turnId: 'run-test-1',
    sessionId: 'run-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    status: 'completed',
    durationMs: 1000,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeTextChunkEvent(
  overrides?: Partial<EventMap['run.text_chunk']>,
): EventMap['run.text_chunk'] {
  return {
    turnId: 'run-test-1',
    agentId: 'agent-test-1',
    messageId: 'msg-test-1',
    content: 'Hello world',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeToolStartedEvent(
  overrides?: Partial<EventMap['run.tool_started']>,
): EventMap['run.tool_started'] {
  return {
    turnId: 'run-test-1',
    agentId: 'agent-test-1',
    toolCallId: 'tc-test-1',
    toolName: 'read_file',
    args: { path: './test.md' },
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeToolResultEvent(
  overrides?: Partial<EventMap['run.tool_result']>,
): EventMap['run.tool_result'] {
  return {
    turnId: 'run-test-1',
    agentId: 'agent-test-1',
    toolCallId: 'tc-test-1',
    toolName: 'read_file',
    result: 'file contents here',
    durationMs: 50,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeFeedbackReceivedEvent(
  overrides?: Partial<EventMap['feedback.received']>,
): EventMap['feedback.received'] {
  return {
    feedbackId: 'fb-test-1',
    turnId: 'run-test-1',
    agentId: 'agent-test-1',
    type: 'thumbs_up',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeAgentCreatedEvent(
  overrides?: Partial<EventMap['agent.created']>,
): EventMap['agent.created'] {
  return {
    agentId: 'agent-test-1',
    name: 'Test Agent',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeRunResumedEvent(
  overrides?: Partial<EventMap['run.resumed']>,
): EventMap['run.resumed'] {
  return {
    turnId: 'run-test-1',
    agentId: 'agent-test-1',
    triggeredBy: 'feedback.received',
    suspendedDurationMs: 5000,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeTurnPendingEvent(
  overrides?: Partial<EventMap['turn.pending']>,
): EventMap['turn.pending'] {
  return {
    turnId: 'run-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    mode: 'interactive',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeAgUiEventPayload(
  overrides?: Partial<EventMap['run.ag_ui_event']>,
): EventMap['run.ag_ui_event'] {
  return {
    turnId: 'run-test-1',
    agentId: 'agent-test-1',
    event: { type: 'CUSTOM', timestamp: Date.now(), runId: 'run-test-1' },
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeUserMessageEvent(
  overrides?: Partial<EventMap['user.message']>,
): EventMap['user.message'] {
  return {
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    messageId: 'msg-test-1',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Suspended Run Helpers ───────────────────────────────────────

export interface SuspendedRunRow {
  id: string;
  agentSessionId: string;
  agentId: string;
  waitEventType: string;
  waitSelector: string;
  waitExpiresAt: number | null;
  snapshotState: string;
  createdAt: number;
}

export function makeSuspendedRunRow(
  overrides?: Partial<SuspendedRunRow>,
): SuspendedRunRow {
  return {
    id: 'sr-1',
    agentSessionId: 'run-1',
    agentId: 'agent-1',
    waitEventType: 'feedback.received',
    waitSelector: JSON.stringify({ agentId: 'agent-1', type: 'thumbs_up' }),
    waitExpiresAt: null,
    snapshotState: JSON.stringify({ conversationId: 'conv-1' }),
    createdAt: Date.now() - 5000,
    ...overrides,
  };
}

export function createMockSuspendDb(
  rows: Record<string, SuspendedRunRow[]> = {},
) {
  const suspendedRuns = new Map<string, SuspendedRunRow>();

  for (const eventRows of Object.values(rows)) {
    for (const row of eventRows) {
      suspendedRuns.set(row.id, row);
    }
  }

  return {
    getSuspendedSessionsByEventType: vi.fn().mockImplementation((eventType: string) => {
      return Promise.resolve(rows[eventType] ?? []);
    }),
    deleteSuspendedSession: vi.fn().mockImplementation((id: string) => {
      suspendedRuns.delete(id);
      for (const arr of Object.values(rows)) {
        const idx = arr.findIndex((r) => r.id === id);
        if (idx !== -1) arr.splice(idx, 1);
      }
      return Promise.resolve(undefined);
    }),
    expireOldSuspendedSessions: vi.fn().mockResolvedValue(0),
    createSuspendedRun: vi.fn().mockImplementation((data: SuspendedRunRow) => {
      suspendedRuns.set(data.id, data);
      const eventType = data.waitEventType;
      if (!rows[eventType]) rows[eventType] = [];
      rows[eventType].push(data);
      return Promise.resolve(undefined);
    }),
    _store: suspendedRuns,
  };
}

// ── Timing Helpers ──────────────────────────────────────────────

export const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// ── Container Mock Factories ────────────────────────────────────

export function createMockContainer(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'sha256-abc123',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      State: { Status: 'running', ExitCode: 0 },
    }),
    putArchive: vi.fn().mockResolvedValue(undefined),
    getArchive: vi.fn().mockResolvedValue(
      (async function* () {
        yield Buffer.from('fake-tar-data');
      })(),
    ),
    logs: vi.fn().mockResolvedValue(Buffer.from('line1\nline2\nline3')),
    pause: vi.fn().mockResolvedValue(undefined),
    unpause: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function createMockNetwork(overrides: Record<string, unknown> = {}) {
  return {
    inspect: vi.fn().mockResolvedValue({ Name: 'ctxmill-agents' }),
    ...overrides,
  };
}

export function createMockDocker(overrides: Record<string, unknown> = {}) {
  const mockContainer = createMockContainer();
  return {
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    listContainers: vi.fn().mockResolvedValue([]),
    getNetwork: vi.fn().mockReturnValue(createMockNetwork()),
    createNetwork: vi.fn().mockResolvedValue({}),
    _mockContainer: mockContainer,
    ...overrides,
  };
}

// ── Tool Context Mock ───────────────────────────────────────────

export function createMockToolContext(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'test-agent',
    conversationId: 'test-conv',
    instanceId: 'run-123',
    workspaceDir: '/tmp/test',
    ...overrides,
  };
}

// ── Trigger DB Mock ─────────────────────────────────────────────

export function createMockTriggerDb(initialTriggers: Array<{
  id: string;
  agentId: string;
  eventType: string;
  selector?: Record<string, unknown> | null;
  taskTemplate: string;
  enabled: boolean;
  createdAt: string;
}> = []) {
  const triggers = new Map(initialTriggers.map((t) => [t.id, { ...t }]));

  return {
    getTriggers: vi.fn().mockImplementation(() => {
      return Promise.resolve(Array.from(triggers.values()));
    }),
    saveTrigger: vi.fn().mockImplementation((data: any) => {
      triggers.set(data.id, { ...data });
      return Promise.resolve(undefined);
    }),
    deleteTrigger: vi.fn().mockImplementation((id: string) => {
      triggers.delete(id);
      return Promise.resolve(undefined);
    }),
    _store: triggers,
  };
}
