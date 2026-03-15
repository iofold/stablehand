/**
 * Event Bus Test Helpers
 *
 * Reusable test utilities for event bus testing:
 * - createTestBus() factory
 * - collectEvents() / waitForEmit() collectors
 * - Mock factories for SSEManager, DatabaseRepository, LearningPipeline
 * - Event data builders for all EventMap event types
 */

import { vi, type Mock } from 'vitest';
import {
  TypedEventBus,
  type EventMap,
  type EventName,
  type PersistEventFn,
} from '../../packages/ctxmill/src/events/bus.js';

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
    addKnowledgeItem: vi.fn(),
    listKnowledgeItems: vi.fn(),
    deleteKnowledgeItem: vi.fn(),
    saveTrace: vi.fn(),
    getTrace: vi.fn(),
    getTraceByRunId: vi.fn(),
    listTraces: vi.fn(),
    saveFeedback: vi.fn(),
    getFeedbackByTraceId: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(),
    updateRun: vi.fn(),
    listRuns: vi.fn(),
    persistEvent: vi.fn(),
    getEventsSince: vi.fn(),
    getRecentTraces: vi.fn().mockResolvedValue([]),
    getFeedbackForTrace: vi.fn().mockResolvedValue([]),
    getTraceStats: vi.fn().mockResolvedValue({}),
    getFeedbackStats: vi.fn().mockResolvedValue({}),
  };
}

export function createMockLearningPipeline() {
  return {
    process: vi.fn().mockResolvedValue({ insights: [], errors: [] }),
    getKnowledge: vi.fn().mockResolvedValue(''),
  };
}

// ── Event Data Builders ─────────────────────────────────────────

export function makeRunStartedEvent(
  overrides?: Partial<EventMap['run.started']>,
): EventMap['run.started'] {
  return {
    runId: 'run-test-1',
    agentId: 'agent-test-1',
    conversationId: 'conv-test-1',
    mode: 'interactive',
    taskDescription: 'Test task',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeRunCompletedEvent(
  overrides?: Partial<EventMap['run.completed']>,
): EventMap['run.completed'] {
  return {
    runId: 'run-test-1',
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
    runId: 'run-test-1',
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
    runId: 'run-test-1',
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
    runId: 'run-test-1',
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
    runId: 'run-test-1',
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
