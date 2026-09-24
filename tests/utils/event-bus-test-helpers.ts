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
} from '../../packages/stablehand/src/events/bus.js';
import { CanonicalLog } from '../../packages/stablehand/src/orchestrator/canonical/canonical-log.js';
import type { DatabaseRepository } from '../../packages/stablehand/src/database/repository.js';

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
export function createCanonicalWireHarness(options?: {
  db?: DatabaseRepository;
  messageEventsOnly?: boolean;
}) {
  let seq = 0;
  const log = new CanonicalLog({
    db: options?.db ?? {
      saveEventBatch: async (frames: unknown[]) => frames.map(() => ++seq),
      saveMessageEventBatch: async (frames: unknown[]) => frames.map(() => ++seq),
      saveTerminalEventBatch: async (frames: unknown[]) => frames.map(() => ++seq),
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
      if (
        options?.messageEventsOnly
        && type !== 'message.committed'
        && type !== 'message.updated'
      ) {
        return;
      }
      const persisted = await log.ingest(type, parsed ?? {});
      return persisted.length > 0;
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
  let nextMessageSeq = 0;
  let nextDeliveryFenceToken = 0;
  const canonicalMessages = new Map<string, Record<string, unknown>>();
  const addCanonicalMessage = vi.fn().mockImplementation(async (
    data: Record<string, unknown>,
  ) => {
    const id = typeof data.id === 'string'
      ? data.id
      : `canonical-message-${nextMessageSeq}`;
    const existing = canonicalMessages.get(id);
    if (existing) return existing;
    const message = {
      ...data,
      id,
      messageSeq: nextMessageSeq++,
      messageRevision: 0,
      publishedRevision: -1,
      createdAt: Date.now(),
    };
    canonicalMessages.set(id, message);
    return message;
  });

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
    addCanonicalMessage,
    getMessage: vi.fn().mockImplementation(
      async (id: string) => canonicalMessages.get(id),
    ),
    getMessages: vi.fn(),
    getMessagesPendingCanonicalPublish: vi.fn().mockResolvedValue([]),
    stageAssistantMessageUpdate: vi.fn().mockImplementation(async (
      id: string,
      toolCalls: unknown[],
      parts: unknown[],
    ) => {
      const previous = canonicalMessages.get(id);
      if (!previous) return undefined;
      const updated = {
        ...previous,
        toolCalls,
        parts,
        messageRevision: Number(previous.messageRevision) + 1,
      };
      canonicalMessages.set(id, updated);
      return updated;
    }),
    createTurn: vi.fn(),
    getTurn: vi.fn(),
    updateTurn: vi.fn(),
    finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
    listTurns: vi.fn(),
    claimTurnDeliveryLease: vi.fn().mockImplementation(async (input: {
      turnId: string;
      ownerId: string;
      leaseDurationMs: number;
    }) => {
      const now = Date.now();
      return {
        turnId: input.turnId,
        ownerId: input.ownerId,
        fenceToken: ++nextDeliveryFenceToken,
        leaseExpiresAt: now + input.leaseDurationMs,
        updatedAt: now,
      };
    }),
    renewTurnDeliveryLease: vi.fn().mockImplementation(async (
      turnId: string,
      ownerId: string,
      fenceToken: number,
      leaseDurationMs: number,
    ) => {
      const now = Date.now();
      return {
        turnId,
        ownerId,
        fenceToken,
        leaseExpiresAt: now + leaseDurationMs,
        updatedAt: now,
      };
    }),
    releaseTurnDeliveryLease: vi.fn().mockResolvedValue(true),
    isTurnDeliveryFenceCurrent: vi.fn().mockResolvedValue(true),
    persistEvent: vi.fn(),
  };
}

// ── Event Data Builders ─────────────────────────────────────────

export function makeTurnStartedEvent(
  overrides?: Partial<EventMap['turn.started']>,
): EventMap['turn.started'] {
  return {
    turnId: 'turn-test-1',
    sandboxSessionId: 'sandbox-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    mode: 'interactive',
    taskDescription: 'Test task',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeTurnCompletedEvent(
  overrides?: Partial<EventMap['turn.completed']>,
): EventMap['turn.completed'] {
  return {
    turnId: 'turn-test-1',
    sandboxSessionId: 'sandbox-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    status: 'completed',
    durationMs: 1000,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeMessageDeltaEvent(
  overrides?: Partial<EventMap['message.delta']>,
): EventMap['message.delta'] {
  return {
    turnId: 'turn-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    messageId: 'msg-test-1',
    delta: 'Hello world',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeToolCallStartedEvent(
  overrides?: Partial<EventMap['tool_call.started']>,
): EventMap['tool_call.started'] {
  return {
    turnId: 'turn-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    toolCallId: 'tc-test-1',
    toolCallName: 'read_file',
    args: { path: './test.md' },
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeToolCallCompletedEvent(
  overrides?: Partial<EventMap['tool_call.completed']>,
): EventMap['tool_call.completed'] {
  return {
    turnId: 'turn-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    toolCallId: 'tc-test-1',
    toolCallName: 'read_file',
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
    turnId: 'turn-test-1',
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
    turnId: 'turn-test-1',
    agentId: 'agent-test-1',
    name: 'Test Agent',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeTurnPendingEvent(
  overrides?: Partial<EventMap['turn.pending']>,
): EventMap['turn.pending'] {
  return {
    turnId: 'turn-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    mode: 'interactive',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeAgUiEventPayload(
  overrides?: Partial<EventMap['ag_ui.event']>,
): EventMap['ag_ui.event'] {
  return {
    turnId: 'turn-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    event: { type: 'CUSTOM', timestamp: Date.now(), runId: 'turn-test-1' },
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeUserMessageEvent(
  overrides?: Partial<EventMap['user.message']>,
): EventMap['user.message'] {
  return {
    turnId: 'turn-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    messageId: 'msg-test-1',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
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
    inspect: vi.fn().mockResolvedValue({ Name: 'stablehand-agents' }),
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
