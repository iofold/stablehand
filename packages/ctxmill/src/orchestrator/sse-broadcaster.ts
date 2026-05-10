import type { SSEManager } from './sse.js';
import type { TypedEventBus, EventName, EventMap } from '../events/bus.js';
import type { AGUIEventType } from '@ctxmill/shared';

/** Maps internal session/run event names to AG-UI SSE event types. */
const EVENT_TYPE_MAP: Partial<Record<EventName, AGUIEventType>> = {
  'turn.started': 'RUN_STARTED',
  'turn.pending': 'TURN_PENDING',
  'run.text_chunk': 'TEXT_MESSAGE_CONTENT',
  'run.tool_started': 'TOOL_CALL_START',
  'run.tool_result': 'TOOL_CALL_RESULT',
  'run.interrupted': 'HITL_PAUSE',
  'run.interrupt_resolved': 'CUSTOM',
  'turn.completed': 'RUN_FINISHED',
  'message.committed': 'MESSAGE_COMMITTED',
};

const RUN_EVENTS: EventName[] = [
  'turn.started',
  'turn.pending',
  'run.text_chunk',
  'run.tool_started',
  'run.tool_result',
  'run.interrupted',
  'run.interrupt_resolved',
  'run.ag_ui_event',
  'turn.completed',
  'user.message',
  'message.committed',
];

type AnyHandler = (payload: EventMap[EventName]) => void;
type EventPayload = EventMap[EventName];
type EventPayloadRecord = Record<string, unknown>;

/**
 * Bridges the internal TypedEventBus to SSE clients via SSEManager.
 * Subscribes to session and run events and broadcasts them as AG-UI events.
 *
 * Identity contract note: CTXMILL maps AG-UI `threadId` to the persisted
 * `conversationId`, not to a turn/run id or sandbox session id. See
 * docs/contracts/session-identity.md.
 */
export class SSEBroadcaster {
  private sseManager: SSEManager;
  private eventBus: TypedEventBus;
  private handlers = new Map<EventName, AnyHandler>();

  constructor(sseManager: SSEManager, eventBus: TypedEventBus) {
    this.sseManager = sseManager;
    this.eventBus = eventBus;
    this.subscribe();
  }

  private subscribe(): void {
    for (const event of RUN_EVENTS) {
      const handler = (payload: EventMap[typeof event]) => this.handleEvent(event, payload);

      this.handlers.set(event, handler as AnyHandler);
      this.eventBus.on(event, handler as AnyHandler);
    }
  }

  private handleEvent<K extends EventName>(event: K, payload: EventMap[K]): void {
    const agentId = this.getAgentId(payload);
    if (!agentId) {
      return;
    }

    if (event === 'turn.completed') {
      this.broadcastTurnCompleted(agentId, payload as EventMap['turn.completed']);
      return;
    }

    if (event === 'run.ag_ui_event') {
      this.broadcastAgUiEvent(agentId, payload as EventMap['run.ag_ui_event']);
      return;
    }

    if (event === 'user.message') {
      this.broadcastUserMessage(agentId, payload as EventMap['user.message']);
      return;
    }

    const broadcastPayload = this.buildBroadcastPayload(event, payload, EVENT_TYPE_MAP[event] ?? 'CUSTOM');
    this.broadcastSafely(agentId, broadcastPayload);

    if (event === 'run.tool_started') {
      this.broadcastToolCallArgs(agentId, payload as EventMap['run.tool_started']);
    }
  }

  private broadcastTurnCompleted(agentId: string, payload: EventMap['turn.completed']): void {
    const { error, ...rest } = payload;
    const commonFields = {
      ...rest,
      runId: payload.turnId,
      conversationId: payload.conversationId,
      threadId: payload.conversationId,
      timestamp: payload.timestamp,
      internalType: 'turn.completed',
    };

    if (payload.status === 'error' || payload.status === 'cancelled') {
      this.broadcastSafely(agentId, {
        ...commonFields,
        type: 'RUN_ERROR',
        message: error,
      });
    }

    this.broadcastSafely(agentId, {
      ...payload,
      type: 'RUN_FINISHED',
      runId: payload.turnId,
      conversationId: payload.conversationId,
      threadId: payload.conversationId,
      internalType: 'turn.completed',
    });
  }

  private broadcastAgUiEvent(agentId: string, payload: EventMap['run.ag_ui_event']): void {
    this.broadcastSafely(agentId, {
      ...payload.event,
      conversationId: payload.conversationId,
      threadId: payload.conversationId,
      internalType: 'run.ag_ui_event',
    });
  }

  private broadcastUserMessage(agentId: string, payload: EventMap['user.message']): void {
    const commonFields = {
      ...payload,
      runId: payload.conversationId,
      threadId: payload.conversationId,
      conversationId: payload.conversationId,
      internalType: 'user.message',
      timestamp: payload.timestamp,
    };

    this.broadcastSafely(agentId, {
      ...commonFields,
      type: 'TEXT_MESSAGE_START',
      role: 'user',
    });

    this.broadcastSafely(agentId, {
      ...commonFields,
      type: 'TEXT_MESSAGE_CONTENT',
      delta: payload.content,
    });

    this.broadcastSafely(agentId, {
      ...commonFields,
      type: 'TEXT_MESSAGE_END',
    });
  }

  private broadcastToolCallArgs(agentId: string, payload: EventMap['run.tool_started']): void {
    const serializedArgs = typeof payload.args === 'string'
      ? payload.args
      : JSON.stringify(payload.args);

    this.broadcastSafely(agentId, {
      ...payload,
      type: 'TOOL_CALL_ARGS',
      runId: payload.turnId,
      conversationId: this.getConversationId(payload),
      threadId: this.getConversationId(payload),
      args: serializedArgs,
      delta: serializedArgs,
      timestamp: payload.timestamp,
      internalType: 'run.tool_started',
    });
  }

  private buildBroadcastPayload<K extends EventName>(
    event: K,
    payload: EventMap[K],
    type: AGUIEventType,
  ): Record<string, unknown> {
    const payloadRecord = payload as EventPayloadRecord;
    const conversationId = this.getConversationId(payload);
    const broadcastPayload: Record<string, unknown> = {
      ...payloadRecord,
      type,
      runId: this.getRunId(payload),
      conversationId,
      threadId: conversationId,
      internalType: event,
    };

    if (event === 'run.text_chunk' && typeof payloadRecord.content === 'string') {
      broadcastPayload.delta = payloadRecord.content;
    }

    if (event === 'run.tool_started' && typeof payloadRecord.toolName === 'string') {
      broadcastPayload.toolCallName = payloadRecord.toolName;
    }

    if (event === 'run.tool_result' && typeof payloadRecord.result === 'string') {
      broadcastPayload.content = payloadRecord.result;
    }

    return broadcastPayload;
  }

  private getAgentId(payload: EventPayload): string | undefined {
    const payloadRecord = payload as EventPayloadRecord;
    return typeof payloadRecord.agentId === 'string' ? payloadRecord.agentId : undefined;
  }

  private getRunId(payload: EventPayload): string {
    const payloadRecord = payload as EventPayloadRecord;
    const runId = payloadRecord.turnId ?? payloadRecord.sessionId ?? payloadRecord.runId;
    return typeof runId === 'string' ? runId : '';
  }

  private getConversationId(payload: EventPayload): string | undefined {
    const payloadRecord = payload as EventPayloadRecord;
    return typeof payloadRecord.conversationId === 'string'
      ? payloadRecord.conversationId
      : undefined;
  }

  private broadcastSafely(agentId: string, payload: Record<string, unknown>): void {
    try {
      this.sseManager.broadcast(agentId, payload);
    } catch (error) {
      console.error('[SSEBroadcaster] broadcast failed:', error);
    }
  }

  shutdown(): void {
    for (const [event, handler] of this.handlers) {
      this.eventBus.off(event, handler);
    }
    this.handlers.clear();
  }
}
