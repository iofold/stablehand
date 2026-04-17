import { EventEmitter } from 'node:events';

export type EventMap = {
  'turn.started': {
    turnId: string;
    sessionId: string;
    agentId: string;
    conversationId: string;
    mode: 'interactive' | 'background';
    taskDescription: string;
    timestamp: number;
  };
  'run.text_chunk': {
    turnId: string;
    agentId: string;
    conversationId: string;
    messageId: string;
    content: string;
    timestamp: number;
  };
  'run.tool_started': {
    turnId: string;
    agentId: string;
    conversationId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    requiresApproval?: boolean;
    timestamp: number;
  };
  'run.tool_result': {
    turnId: string;
    agentId: string;
    conversationId: string;
    toolCallId: string;
    toolName: string;
    result: string;
    durationMs: number;
    error?: string;
    timestamp: number;
  };
  'run.interrupted': {
    turnId: string;
    agentId: string;
    conversationId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    interruptId: string;
    timestamp: number;
  };
  'run.interrupt_resolved': {
    turnId: string;
    agentId: string;
    conversationId: string;
    interruptId: string;
    action: 'approve' | 'reject' | 'suspend' | 'timeout';
    timestamp: number;
  };
  'session.paused': {
    sessionId: string;
    agentId: string;
    conversationId: string;
    reason: string;
    timestamp: number;
  };
  'turn.completed': {
    turnId: string;
    sessionId: string;
    agentId: string;
    conversationId: string;
    status: 'completed' | 'error' | 'cancelled';
    error?: string;
    durationMs: number;
    timestamp: number;
  };
  'learning.trace_captured': {
    traceId: string;
    turnId: string;
    agentId: string;
    stepCount: number;
    outcome: 'success' | 'failure' | 'partial';
    timestamp: number;
  };
  'learning.insight_extracted': {
    traceId: string;
    agentId: string;
    insightCount: number;
    timestamp: number;
  };
  'learning.knowledge_updated': {
    agentId: string;
    itemId: string;
    category: string;
    timestamp: number;
  };
  'feedback.received': {
    feedbackId: string;
    turnId: string;
    agentId: string;
    type: 'thumbs_up' | 'thumbs_down';
    messageId?: string;
    timestamp: number;
  };
  'agent.created': {
    agentId: string;
    name: string;
    timestamp: number;
  };
  'agent.deleted': {
    agentId: string;
    timestamp: number;
  };
  'client.connected': {
    agentId: string;
    clientId: string;
    timestamp: number;
  };
  'client.disconnected': {
    agentId: string;
    clientId: string;
    timestamp: number;
  };
  'run.resumed': {
    turnId: string;
    agentId: string;
    triggeredBy: string;
    suspendedDurationMs: number;
    timestamp: number;
  };
  'trigger.fired': {
    triggerId: string;
    agentId: string;
    eventType: string;
    turnId: string;
    _triggerDepth?: number;
    timestamp: number;
  };
  'message.committed': {
    turnId: string;
    agentId: string;
    conversationId: string;
    messageId?: string;
    messageSeq: number;
    role: 'assistant' | 'tool';
    content: string;
    parts?: Array<{ type: string; [key: string]: unknown }>;
    toolCalls?: Array<{ id: string; name: string; args: string; status: string }>;
    toolCallId?: string;
    timestamp: number;
  };
  'turn.pending': {
    turnId: string;
    agentId: string;
    conversationId: string;
    mode: 'interactive' | 'background';
    taskDescription?: string;
    timestamp: number;
  };
  'run.ag_ui_event': {
    turnId: string;
    agentId: string;
    conversationId?: string;
    event: Record<string, unknown>;
    timestamp: number;
  };
  'user.message': {
    agentId: string;
    conversationId: string;
    messageId: string;
    content: string;
    timestamp: number;
  };
  'custom': {
    type: string;
    agentId: string;
    payload: Record<string, unknown>;
    timestamp: number;
  };
};

export type EventName = keyof EventMap;

/** Fields present on every event payload in the EventMap. */
export interface EventPayloadBase {
  timestamp: number;
}

/** Extract payloads that include an agentId field. */
type PayloadWithAgentId = { agentId: string; timestamp: number };

/** Bus error payload emitted on 'bus.error' pseudo-event. */
export interface BusErrorPayload {
  source: string;
  event: string;
  error: string;
  timestamp: number;
}

export type PersistEventFn = (
  type: string,
  agentId: string,
  payload: string,
) => void | Promise<void>;

export class TypedEventBus {
  private emitter = new EventEmitter();
  private persistEvent?: PersistEventFn;

  constructor(options?: { persistEvent?: PersistEventFn }) {
    this.persistEvent = options?.persistEvent;
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    // Auto-fill timestamp if not provided
    if (!payload.timestamp) {
      payload.timestamp = Date.now();
    }

    // Persist if configured
    if (this.persistEvent) {
      const agentId = 'agentId' in payload ? (payload as PayloadWithAgentId).agentId : '';
      try {
        const result = this.persistEvent(event, agentId, JSON.stringify(payload));
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            console.error(`[EventBus] persist error for ${event}:`, err);
            try {
              this.emitter.emit('bus.error', {
                source: 'persist',
                event,
                error: err instanceof Error ? err.message : String(err),
                timestamp: Date.now(),
              });
            } catch { /* prevent infinite loop if bus.error handler itself fails */ }
          });
        }
      } catch (err) {
        console.error(`[EventBus] persist error for ${event}:`, err);
        try {
          this.emitter.emit('bus.error', {
            source: 'persist',
            event,
            error: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
        } catch { /* prevent infinite loop if bus.error handler itself fails */ }
      }
    }

    // Get all listeners; call each in a try/catch so one failure doesn't block others
    const listeners = this.emitter.rawListeners(event);
    for (const listener of listeners) {
      try {
        const result = listener(payload);
        // If the handler returns a promise, catch rejections
        if (result && typeof result.catch === 'function') {
          (result as Promise<unknown>).catch((err: unknown) => {
            console.error(`[EventBus] handler error for ${event}:`, err);
            try {
              this.emitter.emit('bus.error', {
                source: 'handler',
                event,
                error: err instanceof Error ? err.message : String(err),
                timestamp: Date.now(),
              });
            } catch { /* prevent infinite loop if bus.error handler itself fails */ }
          });
        }
      } catch (err) {
        console.error(`[EventBus] handler error for ${event}:`, err);
        try {
          this.emitter.emit('bus.error', {
            source: 'handler',
            event,
            error: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
        } catch { /* prevent infinite loop if bus.error handler itself fails */ }
      }
    }
  }

  /**
   * Emit a custom (user-defined) event type that isn't in EventMap.
   * Used by the emit-event built-in tool for agent-to-agent communication.
   * Persists and dispatches to subscribers just like typed events.
   */
  emitCustom(eventType: string, agentId: string, payload: Record<string, unknown>): void {
    const fullPayload = { ...payload, timestamp: payload.timestamp ?? Date.now() };

    // Persist
    if (this.persistEvent) {
      try {
        const result = this.persistEvent(eventType, agentId, JSON.stringify(fullPayload));
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            console.error(`[EventBus] persist error for custom ${eventType}:`, err);
          });
        }
      } catch (err) {
        console.error(`[EventBus] persist error for custom ${eventType}:`, err);
      }
    }

    // Dispatch to subscribers (trigger manager subscribes with raw event type strings)
    const listeners = this.emitter.rawListeners(eventType);
    for (const listener of listeners) {
      try {
        const result = listener(fullPayload);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch((err: unknown) => {
            console.error(`[EventBus] handler error for custom ${eventType}:`, err);
          });
        }
      } catch (err) {
        console.error(`[EventBus] handler error for custom ${eventType}:`, err);
      }
    }
  }

  async emitCustomAsync(eventType: string, agentId: string, payload: Record<string, unknown>): Promise<void> {
    const fullPayload = { ...payload, timestamp: payload.timestamp ?? Date.now() };

    if (this.persistEvent) {
      const result = this.persistEvent(eventType, agentId, JSON.stringify(fullPayload));
      if (result && typeof (result as Promise<void>).then === 'function') {
        await (result as Promise<void>);
      }
    }

    const listeners = this.emitter.rawListeners(eventType);
    for (const listener of listeners) {
      try {
        const result = listener(fullPayload);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch((err: unknown) => {
            console.error(`[EventBus] handler error for custom ${eventType}:`, err);
          });
        }
      } catch (err) {
        console.error(`[EventBus] handler error for custom ${eventType}:`, err);
      }
    }
  }

  on<K extends EventName>(event: K, handler: (payload: EventMap[K]) => void | Promise<void>): void;
  on(event: 'bus.error', handler: (payload: BusErrorPayload) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overload implementation must be wide enough to cover all signatures
  on(event: string, handler: (...args: any[]) => void | Promise<void>): void {
    this.emitter.on(event, handler);
  }

  off<K extends EventName>(event: K, handler: (payload: EventMap[K]) => void | Promise<void>): void {
    // Type narrowed: EventEmitter.off expects a generic function signature; our handler is correctly typed at call sites
    this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  once<K extends EventName>(event: K, handler: (payload: EventMap[K]) => void | Promise<void>): void {
    // Type narrowed: EventEmitter.once expects a generic function signature; our handler is correctly typed at call sites
    this.emitter.once(event, handler as (...args: unknown[]) => void);
  }

  /**
   * Convenience: subscribe to an event filtered by agentId.
   */
  onAgent<K extends EventName>(
    event: K,
    agentId: string,
    handler: (payload: EventMap[K]) => void | Promise<void>,
  ): () => void {
    const wrapped = (payload: EventMap[K]) => {
      if ('agentId' in payload && (payload as PayloadWithAgentId).agentId === agentId) {
        handler(payload);
      }
    };
    this.on(event, wrapped);
    return () => this.off(event, wrapped);
  }

  removeAllListeners<K extends EventName>(event?: K): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }
}
