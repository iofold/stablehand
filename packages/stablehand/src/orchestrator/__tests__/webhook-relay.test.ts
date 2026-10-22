import { describe, expect, it, vi } from 'vitest';
import type { BuiltinWebhookEventName } from '@stablehand/contracts';

import type { DatabaseRepository, EventFrameRow, WebhookRow } from '../../database/repository.js';
import type { CallbackDispatcher } from '../callback-dispatcher.js';
import { SpineConsumerRunner } from '../../events/spine-consumer-runner.js';
import type { SpineRawEvent } from '../../events/spine-consumer-runner.js';
import type { CanonicalLog } from '../canonical/canonical-log.js';
import type { ValidWebhookEvent } from '../webhook-events.js';
import { buildWebhookPayload, createWebhookRelaySpineConsumer } from '../webhook-relay.js';

type EnqueueCallbackArgs = Parameters<CallbackDispatcher['enqueue']>[0];

function webhook(id: string, eventType: ValidWebhookEvent): WebhookRow {
  return {
    id,
    agentId: 'agent-1',
    url: `https://hooks.example/${eventType}`,
    events: [eventType],
    secret: null,
    active: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function rawEvent(
  seq: number,
  sourceType: ValidWebhookEvent,
  payload: Record<string, unknown>,
): SpineRawEvent {
  return {
    seq,
    sourceType,
    sourcePayload: JSON.stringify(payload),
    payload,
    agentId: typeof payload.agentId === 'string' ? payload.agentId : 'agent-1',
    turnId: typeof payload.turnId === 'string' ? payload.turnId : null,
    conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : null,
    createdAt: 1_000 + seq,
  };
}

function sourceRow(
  seq: number,
  sourceType: ValidWebhookEvent,
  payload: Record<string, unknown>,
): EventFrameRow {
  return {
    seq,
    type: sourceType,
    agentId: typeof payload.agentId === 'string' ? payload.agentId : 'agent-1',
    payload: '{}',
    createdAt: 1_000 + seq,
    turnId: typeof payload.turnId === 'string' ? payload.turnId : null,
    conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : null,
    channel: 'run',
    sourceType,
    sourcePayload: JSON.stringify(payload),
  };
}

function createDispatcher() {
  return {
    enqueue: vi.fn(async (_opts: EnqueueCallbackArgs) => 'delivery-id'),
  };
}

function createRelayDb(webhooks: WebhookRow[], rows: EventFrameRow[] = []) {
  const cursors = new Map<string, number>();
  const db = {
    listWebhooks: vi.fn(async (agentId: string) =>
      webhooks.filter((hook) => hook.agentId === agentId && hook.active)),
    getSpineCursor: vi.fn(async (consumer: string) => cursors.get(consumer) ?? 0),
    getSourceEventsSince: vi.fn(async (afterSeq: number, limit = 1_000) =>
      rows.filter((row) => row.seq > afterSeq).slice(0, limit)),
    advanceSpineCursor: vi.fn(async (consumer: string, lastSeq: number) => {
      const nextSeq = Math.max(cursors.get(consumer) ?? 0, lastSeq);
      cursors.set(consumer, nextSeq);
      return { consumer, lastSeq: nextSeq, updatedAt: Date.now() };
    }),
  };
  return { db: db as unknown as DatabaseRepository & typeof db, cursors };
}

const goldenFixtures = [
  {
    eventType: 'turn.started',
    payload: {
      turnId: 'turn-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      mode: 'background',
      taskDescription: 'Run Pilot sync',
      timestamp: 100,
    },
    expected: {
      turnId: 'turn-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      mode: 'background',
      taskDescription: 'Run Pilot sync',
      timestamp: 100,
    },
    expectedJson: '{"turnId":"turn-1","sandboxSessionId":"sandbox-1","agentId":"agent-1","conversationId":"conv-1","mode":"background","taskDescription":"Run Pilot sync","timestamp":100}',
  },
  {
    eventType: 'artifact.created',
    payload: {
      artifactId: 'artifact-1',
      agentId: 'agent-1',
      turnId: 'turn-1',
      name: 'report.json',
      mimeType: 'application/json',
      sizeBytes: 42,
      kind: 'eval_report',
      sha256: 'a'.repeat(64),
      timestamp: 50,
      metadata: { must: 'not leak into event' },
    },
    expected: {
      artifactId: 'artifact-1',
      agentId: 'agent-1',
      turnId: 'turn-1',
      name: 'report.json',
      mimeType: 'application/json',
      sizeBytes: 42,
      kind: 'eval_report',
      sha256: 'a'.repeat(64),
      timestamp: 50,
    },
    expectedJson: `{"artifactId":"artifact-1","agentId":"agent-1","turnId":"turn-1","name":"report.json","mimeType":"application/json","sizeBytes":42,"kind":"eval_report","sha256":"${'a'.repeat(64)}","timestamp":50}`,
  },
  {
    eventType: 'turn.completed',
    payload: {
      turnId: 'turn-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'completed',
      durationMs: 400,
      timestamp: 200,
    },
    expected: {
      turnId: 'turn-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'COMPLETED',
      error: undefined,
      durationMs: 400,
      usage: null,
      timestamp: 200,
    },
    expectedJson: '{"turnId":"turn-1","sandboxSessionId":"sandbox-1","agentId":"agent-1","conversationId":"conv-1","status":"COMPLETED","durationMs":400,"usage":null,"timestamp":200}',
  },
  {
    eventType: 'tool_call.started',
    payload: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: 'stablehand' },
      timestamp: 300,
    },
    expected: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: 'stablehand' },
      requiresApproval: undefined,
      timestamp: 300,
    },
    expectedJson: '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conv-1","toolCallId":"tool-1","toolName":"search","args":{"query":"stablehand"},"timestamp":300}',
  },
  {
    eventType: 'interrupt.requested',
    payload: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-2',
      toolName: 'approve',
      args: { amount: 5 },
      interruptId: 'interrupt-1',
      timestamp: 400,
    },
    expected: {
      turnId: 'turn-1',
      sandboxSessionId: undefined,
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-2',
      toolName: 'approve',
      args: { amount: 5 },
      interruptId: 'interrupt-1',
      timestamp: 400,
    },
    expectedJson: '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conv-1","toolCallId":"tool-2","toolName":"approve","args":{"amount":5},"interruptId":"interrupt-1","timestamp":400}',
  },
  {
    eventType: 'tool_call.completed',
    payload: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      result: '{"ok":true}',
      durationMs: 12,
      timestamp: 500,
    },
    expected: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      result: '{"ok":true}',
      durationMs: 12,
      error: undefined,
      timestamp: 500,
    },
    expectedJson: '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conv-1","toolCallId":"tool-1","toolName":"search","result":"{\\"ok\\":true}","durationMs":12,"timestamp":500}',
  },
  {
    eventType: 'interrupt.resolved',
    payload: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      interruptId: 'interrupt-1',
      action: 'approve',
      timestamp: 600,
    },
    expected: {
      turnId: 'turn-1',
      sandboxSessionId: undefined,
      agentId: 'agent-1',
      conversationId: 'conv-1',
      interruptId: 'interrupt-1',
      action: 'approve',
      timestamp: 600,
    },
    expectedJson: '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conv-1","interruptId":"interrupt-1","action":"approve","timestamp":600}',
  },
  {
    eventType: 'message.committed',
    payload: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      messageSeq: 2,
      role: 'assistant',
      content: 'done',
      parts: [{ type: 'text', text: 'done' }],
      toolCalls: [{ id: 'tool-1', name: 'search', args: '{}', status: 'done' }],
      toolCallId: 'tool-1',
      timestamp: 700,
    },
    expected: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      messageSeq: 2,
      role: 'assistant',
      content: 'done',
      parts: [{ type: 'text', text: 'done' }],
      toolCalls: [{ id: 'tool-1', name: 'search', args: '{}', status: 'done' }],
      toolCallId: 'tool-1',
      timestamp: 700,
    },
    expectedJson: '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conv-1","messageId":"msg-1","messageSeq":2,"role":"assistant","content":"done","parts":[{"type":"text","text":"done"}],"toolCalls":[{"id":"tool-1","name":"search","args":"{}","status":"done"}],"toolCallId":"tool-1","timestamp":700}',
  },
  {
    eventType: 'message.updated',
    payload: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      messageSeq: 2,
      messageRevision: 1,
      role: 'assistant',
      content: 'checking',
      parts: [
        { type: 'text', text: 'checking' },
        { type: 'tool_call', id: 'tool-1', name: 'search', args: '{}', result: 'done', status: 'complete' },
      ],
      toolCalls: [{ id: 'tool-1', name: 'search', args: '{}', status: 'complete' }],
      timestamp: 750,
    },
    expected: {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      messageSeq: 2,
      messageRevision: 1,
      role: 'assistant',
      content: 'checking',
      parts: [
        { type: 'text', text: 'checking' },
        { type: 'tool_call', id: 'tool-1', name: 'search', args: '{}', result: 'done', status: 'complete' },
      ],
      toolCalls: [{ id: 'tool-1', name: 'search', args: '{}', status: 'complete' }],
      timestamp: 750,
    },
    expectedJson: '{"turnId":"turn-1","agentId":"agent-1","conversationId":"conv-1","messageId":"msg-1","messageSeq":2,"messageRevision":1,"role":"assistant","content":"checking","parts":[{"type":"text","text":"checking"},{"type":"tool_call","id":"tool-1","name":"search","args":"{}","result":"done","status":"complete"}],"toolCalls":[{"id":"tool-1","name":"search","args":"{}","status":"complete"}],"timestamp":750}',
  },
  {
    eventType: 'feedback.received',
    payload: {
      feedbackId: 'feedback-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      type: 'thumbs_up',
      messageId: 'msg-1',
      timestamp: 800,
    },
    expected: {
      feedbackId: 'feedback-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      type: 'thumbs_up',
      messageId: 'msg-1',
      timestamp: 800,
    },
    expectedJson: '{"feedbackId":"feedback-1","turnId":"turn-1","agentId":"agent-1","type":"thumbs_up","messageId":"msg-1","timestamp":800}',
  },
] satisfies Array<{
  eventType: BuiltinWebhookEventName;
  payload: Record<string, unknown>;
  expected: Record<string, unknown>;
  expectedJson: string;
}>;

describe('WebhookRelay', () => {
  it('emits the canonical flat webhook payload shapes', () => {
    for (const fixture of goldenFixtures) {
      const actual = buildWebhookPayload(fixture.eventType, fixture.payload);
      expect(actual, fixture.eventType).toEqual(fixture.expected);
      expect(JSON.stringify(actual), fixture.eventType).toBe(fixture.expectedJson);
    }
  });

  it('enqueues only subscribed webhooks with the source event seq', async () => {
    const dispatcher = createDispatcher();
    const { db } = createRelayDb([
      webhook('hook-tool', 'tool_call.started'),
      webhook('hook-completed', 'turn.completed'),
    ]);
    const consumer = createWebhookRelaySpineConsumer({ db, callbackDispatcher: dispatcher });

    await consumer.handle(rawEvent(42, 'tool_call.started', {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: 'stablehand' },
      timestamp: 300,
    }));

    expect(db.listWebhooks).toHaveBeenCalledWith('agent-1');
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(dispatcher.enqueue).toHaveBeenCalledWith({
      agentId: 'agent-1',
      turnId: 'turn-1',
      webhookId: 'hook-tool',
      callbackUrl: 'https://hooks.example/tool_call.started',
      eventType: 'tool_call.started',
      eventSeq: 42,
      payload: {
        turnId: 'turn-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        toolCallId: 'tool-1',
        toolName: 'search',
        args: { query: 'stablehand' },
        requiresApproval: undefined,
        timestamp: 300,
      },
    });
  });

  it('passes a custom event envelope through without projecting caller payload fields', async () => {
    const eventType = 'custom.eval.verdict' as ValidWebhookEvent;
    const payload = {
      type: eventType,
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      payload: {
        verdict: 'pass',
        evidence: { suite: 'weekly', scores: [1, 2, 3] },
      },
      _triggerDepth: 1,
      timestamp: 800,
    };
    const dispatcher = createDispatcher();
    const { db } = createRelayDb([webhook('hook-custom', eventType)]);
    const consumer = createWebhookRelaySpineConsumer({ db, callbackDispatcher: dispatcher });

    await consumer.handle(rawEvent(43, eventType, payload));

    expect(dispatcher.enqueue).toHaveBeenCalledOnce();
    expect(dispatcher.enqueue).toHaveBeenCalledWith({
      agentId: 'agent-1',
      turnId: 'turn-1',
      webhookId: 'hook-custom',
      callbackUrl: 'https://hooks.example/custom.eval.verdict',
      eventType,
      eventSeq: 43,
      payload,
    });
  });

  it('does not enqueue custom webhook payloads outside the canonical 256 KiB contract', async () => {
    const eventType = 'custom.eval.oversized' as ValidWebhookEvent;
    const dispatcher = createDispatcher();
    const logger = { warn: vi.fn() };
    const { db } = createRelayDb([webhook('hook-custom', eventType)]);
    const consumer = createWebhookRelaySpineConsumer({
      db,
      callbackDispatcher: dispatcher,
      logger,
    });

    await consumer.handle(rawEvent(44, eventType, {
      type: eventType,
      agentId: 'agent-1',
      payload: { content: 'x'.repeat(256 * 1024) },
      timestamp: 800,
    }));

    expect(dispatcher.enqueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('custom.eval.oversized at seq 44'),
    );
  });

  it('catches up missed spine events and advances after enqueue succeeds', async () => {
    const payload = {
      turnId: 'turn-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'completed',
      durationMs: 400,
      timestamp: 456,
    };
    const dispatcher = createDispatcher();
    const { db, cursors } = createRelayDb(
      [webhook('hook-completed', 'turn.completed')],
      [sourceRow(7, 'turn.completed', payload)],
    );
    const consumer = createWebhookRelaySpineConsumer({ db, callbackDispatcher: dispatcher });
    const runner = new SpineConsumerRunner({
      canonicalLog: {
        subscribe: vi.fn(() => () => undefined),
      } satisfies Pick<CanonicalLog, 'subscribe'>,
      db,
      consumers: [consumer],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      rescanIntervalMs: 60_000,
      batchSize: 100,
    });

    await runner.start();

    expect(dispatcher.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'turn.completed',
      eventSeq: 7,
    }));
    expect(db.advanceSpineCursor).toHaveBeenCalledWith('webhook-relay', 7);
    expect(cursors.get('webhook-relay')).toBe(7);
    runner.stop();
  });

  it('keeps the cursor behind a missed spine event when enqueue fails', async () => {
    const payload = {
      turnId: 'turn-1',
      sandboxSessionId: 'sandbox-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'completed',
      durationMs: 400,
      timestamp: 456,
    };
    const dispatcher = {
      enqueue: vi.fn(async (_opts: EnqueueCallbackArgs) => {
        throw new Error('outbox unavailable');
      }),
    };
    const { db, cursors } = createRelayDb(
      [webhook('hook-completed', 'turn.completed')],
      [sourceRow(7, 'turn.completed', payload)],
    );
    const runner = new SpineConsumerRunner({
      canonicalLog: {
        subscribe: vi.fn(() => () => undefined),
      } satisfies Pick<CanonicalLog, 'subscribe'>,
      db,
      consumers: [createWebhookRelaySpineConsumer({ db, callbackDispatcher: dispatcher })],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      rescanIntervalMs: 60_000,
      batchSize: 100,
    });

    await runner.start();

    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(db.advanceSpineCursor).not.toHaveBeenCalled();
    expect(cursors.get('webhook-relay')).toBeUndefined();
    runner.stop();
  });
});
