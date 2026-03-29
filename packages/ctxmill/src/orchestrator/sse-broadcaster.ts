import type { SSEManager } from './sse.js';
import type { TypedEventBus, EventName, EventMap } from '../events/bus.js';
import type { AGUIEventType } from '@ctxmill/shared';

/** Maps internal run.* event names to AG-UI SSE event types. */
const EVENT_TYPE_MAP: Record<string, AGUIEventType> = {
  'run.started': 'RUN_STARTED',
  'run.paused': 'CUSTOM',
  'run.text_chunk': 'TEXT_MESSAGE_CONTENT',
  'run.tool_started': 'TOOL_CALL_START',
  'run.tool_result': 'TOOL_CALL_RESULT',
  'run.interrupted': 'CUSTOM',
  'run.interrupt_resolved': 'CUSTOM',
  'run.completed': 'RUN_FINISHED',
};

const RUN_EVENTS: EventName[] = [
  'run.started',
  'run.paused',
  'run.text_chunk',
  'run.tool_started',
  'run.tool_result',
  'run.interrupted',
  'run.interrupt_resolved',
  'run.completed',
];

type AnyHandler = (payload: EventMap[EventName]) => void;

/**
 * Bridges the internal TypedEventBus to SSE clients via SSEManager.
 * Subscribes to all run.* events and broadcasts them as AG-UI events.
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
      const handler = (payload: EventMap[typeof event]) => {
        const agentId = (payload as Record<string, unknown>).agentId as string;
        if (!agentId) return;

        const aguiType = EVENT_TYPE_MAP[event] ?? 'CUSTOM';
        const runId = (payload as Record<string, unknown>).runId as string;

        this.sseManager.broadcast(agentId, {
          ...payload,
          type: aguiType,
          runId: runId ?? '',
          internalType: event,
        });

        // AG-UI protocol: emit a separate TOOL_CALL_ARGS event after TOOL_CALL_START
        if (event === 'run.tool_started') {
          const toolPayload = payload as EventMap['run.tool_started'];
          this.sseManager.broadcast(agentId, {
            type: 'TOOL_CALL_ARGS' as AGUIEventType,
            runId: runId ?? '',
            toolCallId: toolPayload.toolCallId,
            args: JSON.stringify(toolPayload.args),
            timestamp: Date.now(),
            internalType: 'run.tool_started',
          });
        }
      };

      this.handlers.set(event, handler as AnyHandler);
      this.eventBus.on(event, handler as AnyHandler);
    }
  }

  shutdown(): void {
    for (const [event, handler] of this.handlers) {
      this.eventBus.off(event, handler);
    }
    this.handlers.clear();
  }
}
