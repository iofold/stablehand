import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionEvent } from '@stablehand/shared';

import type { DatabaseRepository } from '../../database/repository.js';
import { TypedEventBus, type EventMap } from '../../events/bus.js';
import {
  AgentTurnService,
  type AgentTurnServiceDeps,
  type ExecuteTurnParams,
} from '../agent-turn-service.js';
import { stampDelivery } from '../delivery-stamp.js';
import type { SessionTurnExecutor } from '../session-turn-service.js';
import { TurnAttachUnavailableError } from '../turn-attach-error.js';

/**
 * ADR 025: a successor orchestrator replays the sandbox delivery journal.
 * Events whose effects the dead owner already made durable only rebuild
 * local state; later events are applied once, tagged with their journal
 * position.
 */

const FENCE = { ownerId: 'instance/boot-2/owner', fenceToken: 2 };
const DELIVERY = 'delivery-1';

function stamped(seq: number, event: Record<string, unknown>): AgentSessionEvent {
  return stampDelivery(
    { timestamp: seq, runId: 'turn-1', ...event } as AgentSessionEvent,
    { id: DELIVERY, seq },
  );
}

const JOURNAL: AgentSessionEvent[] = [
  stamped(1, { type: 'TEXT_MESSAGE_CONTENT', delta: 'Let me ' }),
  stamped(2, { type: 'TEXT_MESSAGE_CONTENT', delta: 'check.' }),
  stamped(3, { type: 'TOOL_CALL_START', toolCallId: 'tc-1', toolCallName: 'search', args: { q: 'x' } }),
  stamped(4, { type: 'TOOL_CALL_RESULT', toolCallId: 'tc-1', toolCallName: 'search', result: 'found' }),
  stamped(5, { type: 'TEXT_MESSAGE_CONTENT', delta: 'Done.' }),
  stamped(6, { type: 'MESSAGE_COMMITTED', role: 'assistant', content: 'Done.', turnId: 'turn-1', messageSeq: 3 }),
  stamped(7, { type: 'RUN_FINISHED', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
];

function message(id: string, fields: Record<string, unknown>) {
  return {
    id,
    agentId: 'agent-1',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    messageRevision: 0,
    publishedRevision: 0,
    toolCalls: null,
    parts: null,
    toolCallId: null,
    createdAt: 1,
    ...fields,
  };
}

function setup(options: {
  watermark?: { deliveryId: string; deliverySeq: number };
  events?: AgentSessionEvent[];
  executeSessionTurn?: SessionTurnExecutor['executeSessionTurn'];
}) {
  // Rows the dead owner persisted while processing journal events 1-4.
  const rows = new Map<string, Record<string, unknown>>([
    ['canonical-turn-1-0', message('canonical-turn-1-0', { role: 'assistant', content: 'Let me check.', messageSeq: 0 })],
    ['canonical-turn-1-1', message('canonical-turn-1-1', { role: 'tool', content: 'found', messageSeq: 1, toolCallId: 'tc-1' })],
  ]);
  let nextSeq = 2;
  const db = {
    getTurnDeliveryWatermark: vi.fn().mockResolvedValue(options.watermark),
    getMessage: vi.fn(async (id: string) => rows.get(id)),
    addCanonicalMessage: vi.fn(async (data: Record<string, unknown>) => {
      const row = message(String(data.id), { ...data, messageSeq: nextSeq++, publishedRevision: -1 });
      rows.set(row.id, row);
      return row;
    }),
    stageAssistantMessageUpdate: vi.fn(),
    getMessagesPendingCanonicalPublish: vi.fn().mockResolvedValue([]),
    isTurnDeliveryFenceCurrent: vi.fn().mockResolvedValue(true),
    getTurn: vi.fn().mockResolvedValue({ id: 'turn-1', sandboxSessionId: 'sandbox-1', completedAt: null }),
    finalizeTurnIfOpen: vi.fn().mockResolvedValue(true),
    finalizeTurnAndMarkLifecycleDraining: vi.fn().mockResolvedValue(true),
  };
  const sessionManager = {
    findSessionById: vi.fn().mockReturnValue({
      sessionId: 'sandbox-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      status: 'ACTIVE',
    }),
    startTurn: vi.fn().mockReturnValue(new AbortController().signal),
    completeTurn: vi.fn().mockResolvedValue(undefined),
    abandonTurnDelivery: vi.fn().mockResolvedValue(undefined),
    getPendingSessionReset: vi.fn().mockReturnValue(undefined),
  };
  const executeSessionTurn = vi.fn(options.executeSessionTurn ?? (async function* () {
    for (const event of options.events ?? JOURNAL) yield event;
  }));
  const eventBus = new TypedEventBus();
  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
  for (const name of ['message.delta', 'tool_call.started', 'tool_call.completed', 'ag_ui.event', 'message.committed', 'message.updated'] as const) {
    eventBus.on(name, (payload: EventMap[typeof name]) => {
      emitted.push({ name, payload: payload as unknown as Record<string, unknown> });
    });
  }
  const rehydrateTurnProjection = vi.fn().mockResolvedValue(undefined);
  const deps: AgentTurnServiceDeps = {
    db: db as unknown as DatabaseRepository,
    sessionManager: sessionManager as unknown as AgentTurnServiceDeps['sessionManager'],
    eventBus,
    sessionTurnService: { executeSessionTurn } as unknown as SessionTurnExecutor,
    turnProjection: { rehydrateTurnProjection },
  };
  const params: ExecuteTurnParams = {
    agentDef: { name: 'agent', harness: 'langgraph', systemPrompt: '', tools: [] },
    messages: [],
    agentId: 'agent-1',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    mode: 'interactive',
    taskDescription: '',
    deliveryContext: { fence: FENCE },
    sandboxSessionId: 'sandbox-1',
    takeover: true,
  };
  return { db, sessionManager, executeSessionTurn, emitted, rehydrateTurnProjection, service: new AgentTurnService(deps), params };
}

describe('AgentTurnService crash takeover (ADR 025)', () => {
  it('rebuilds durable events without re-applying them and applies the rest once, tagged', async () => {
    const ctx = setup({ watermark: { deliveryId: DELIVERY, deliverySeq: 4 } });

    await ctx.service.executeTurn(ctx.params);

    expect(ctx.sessionManager.startTurn).toHaveBeenCalledWith(
      'sandbox-1', 'turn-1', 'agent-1', 'conv-1', 'interactive', '',
      { suppressEvent: true, deliveryContext: { fence: FENCE }, deliveryAdmission: 'continuation' },
    );
    expect(ctx.executeSessionTurn).toHaveBeenCalledWith(
      expect.anything(), 'conv-1', [], 'turn-1',
      expect.objectContaining({ existingSessionId: 'sandbox-1', attach: { afterDeliverySeq: 0 } }),
    );
    expect(ctx.rehydrateTurnProjection).toHaveBeenCalledWith('turn-1');

    // Journal events 1-4 were durable: no frames, no message writes.
    const live = ctx.emitted.filter(({ name }) => name !== 'message.committed');
    expect(live).toEqual([
      expect.objectContaining({
        name: 'message.delta',
        payload: expect.objectContaining({ delta: 'Done.', delivery: { id: DELIVERY, seq: 5 } }),
      }),
    ]);
    expect(ctx.db.addCanonicalMessage).toHaveBeenCalledTimes(1);
    expect(ctx.db.addCanonicalMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'canonical-turn-1-2', role: 'assistant', content: 'Done.' }),
      FENCE,
    );
    expect(ctx.db.stageAssistantMessageUpdate).not.toHaveBeenCalled();
    expect(ctx.db.finalizeTurnIfOpen).toHaveBeenCalledWith(
      'turn-1',
      expect.objectContaining({
        status: 'completed',
        usage: expect.objectContaining({ totalTokens: 15 }),
      }),
      FENCE,
    );
  });

  it('applies every event when nothing from this delivery is durable yet', async () => {
    const ctx = setup({ watermark: { deliveryId: 'an-older-delivery', deliverySeq: 40 } });

    await ctx.service.executeTurn(ctx.params);

    const deltas = ctx.emitted.filter(({ name }) => name === 'message.delta');
    expect(deltas.map(({ payload }) => (payload.delivery as { seq: number }).seq)).toEqual([1, 2, 5]);
    expect(ctx.emitted.filter(({ name }) => name === 'tool_call.started')).toHaveLength(1);
    expect(ctx.emitted.filter(({ name }) => name === 'tool_call.completed')).toHaveLength(1);
  });

  it('leaves the turn open and reports when the sandbox cannot be re-attached', async () => {
    const ctx = setup({
      // eslint-disable-next-line require-yield
      executeSessionTurn: async function* () {
        throw new TurnAttachUnavailableError('turn-1', 'sandbox-1', 'no delivery journal for turn turn-1');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(ctx.service.executeTurn(ctx.params)).rejects.toBeInstanceOf(TurnAttachUnavailableError);
    expect(ctx.db.finalizeTurnIfOpen).not.toHaveBeenCalled();
    expect(ctx.db.finalizeTurnAndMarkLifecycleDraining).not.toHaveBeenCalled();
    expect(ctx.sessionManager.abandonTurnDelivery).toHaveBeenCalledWith('sandbox-1', 'turn-1');
  });

  it('refuses a takeover without a successor fence and sandbox session', async () => {
    const ctx = setup({});
    await expect(ctx.service.executeTurn({ ...ctx.params, deliveryContext: undefined }))
      .rejects.toThrow(/takeover requires a delivery fence/);
  });
});
