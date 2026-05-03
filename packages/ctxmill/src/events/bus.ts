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

  /**
   * Fire-and-forget durable emit. Listener dispatch is deferred until persistence
   * succeeds. Persistence failure emits bus.error and prevents listener dispatch.
   * Use emitAsync() when caller rollback/cleanup depends on persistence success.
   */
  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    this.ensureTimestamp(payload);

    if (!this.persistEvent) {
      this.dispatchListeners(event, payload);
      return;
    }

    const agentId = 'agentId' in payload ? (payload as PayloadWithAgentId).agentId : '';
    try {
      const persisted = this.persistEvent(event, agentId, JSON.stringify(payload));
      if (persisted && typeof persisted.then === 'function') {
        persisted
          .then(() => this.dispatchListeners(event, payload))
          .catch((err: unknown) => {
            this.reportBusError('persist', event, err, `[EventBus] persist error for ${event}:`);
          });
        return;
      }
    } catch (err) {
      this.reportBusError('persist', event, err, `[EventBus] persist error for ${event}:`);
      return;
    }

    this.dispatchListeners(event, payload);
  }

  /**
   * Awaitable durable emit for boundaries that must roll back when persistence fails.
   */
  async emitAsync<K extends EventName>(event: K, payload: EventMap[K]): Promise<void> {
    await this.persistThenDispatch(event, payload, { rejectOnPersistFailure: true });
  }

  /**
   * Explicit post-persist dispatch hook. Use only when a repository/service already
   * durably persisted the event and wants normal listener dispatch without writing a
   * duplicate event_store row.
   */
  emitPersisted<K extends EventName>(event: K, payload: EventMap[K]): void {
    this.ensureTimestamp(payload);
    this.dispatchListeners(event, payload);
  }

  private ensureTimestamp(payload: EventPayloadBase): void {
    if (!payload.timestamp) {
      payload.timestamp = Date.now();
    }
  }

  private async persistThenDispatch<K extends EventName>(
    event: K,
    payload: EventMap[K],
    options: { rejectOnPersistFailure?: boolean } = {},
  ): Promise<void> {
    this.ensureTimestamp(payload);

    if (this.persistEvent) {
      const agentId = 'agentId' in payload ? (payload as PayloadWithAgentId).agentId : '';
      try {
        await this.persistEvent(event, agentId, JSON.stringify(payload));
      } catch (err) {
        this.reportBusError('persist', event, err, `[EventBus] persist error for ${event}:`);
        if (options.rejectOnPersistFailure) {
          throw err;
        }
        return;
      }
    }

    this.dispatchListeners(event, payload);
  }

  private dispatchListeners(event: string, payload: unknown): void {
    // Get all listeners; call each in a try/catch so one failure doesn't block others
    const listeners = this.emitter.rawListeners(event);
    for (const listener of listeners) {
      try {
        const result = listener(payload);
        // If the handler returns a promise, catch rejections
        if (result && typeof result.catch === 'function') {
          (result as Promise<unknown>).catch((err: unknown) => {
            this.reportBusError('handler', event, err, `[EventBus] handler error for ${event}:`);
          });
        }
      } catch (err) {
        this.reportBusError('handler', event, err, `[EventBus] handler error for ${event}:`);
      }
    }
  }

  private reportBusError(source: 'persist' | 'handler', event: string, err: unknown, message: string): void {
    console.error(message, err);
    try {
      this.emitter.emit('bus.error', {
        source,
        event,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    } catch { /* prevent infinite loop if bus.error handler itself fails */ }
  }

  /**
   * Emit a custom (user-defined) event type that isn't in EventMap.
   * Used by the emit-event built-in tool for agent-to-agent communication.
   * Persists and dispatches to subscribers just like typed events.
   */
  emitCustom(eventType: string, agentId: string, payload: Record<string, unknown>): void {
    const fullPayload = { ...payload, timestamp: payload.timestamp ?? Date.now() };

    if (!this.persistEvent) {
      this.dispatchListeners(eventType, fullPayload);
      return;
    }

    try {
      const persisted = this.persistEvent(eventType, agentId, JSON.stringify(fullPayload));
      if (persisted && typeof persisted.then === 'function') {
        persisted
          .then(() => this.dispatchListeners(eventType, fullPayload))
          .catch((err: unknown) => {
            this.reportBusError('persist', eventType, err, `[EventBus] persist error for custom ${eventType}:`);
          });
        return;
      }
    } catch (err) {
      this.reportBusError('persist', eventType, err, `[EventBus] persist error for custom ${eventType}:`);
      return;
    }

    this.dispatchListeners(eventType, fullPayload);
  }

  async emitCustomAsync(eventType: string, agentId: string, payload: Record<string, unknown>): Promise<void> {
    await this.persistThenDispatchCustom(eventType, agentId, payload, { rejectOnPersistFailure: true });
  }

  emitCustomPersisted(eventType: string, payload: Record<string, unknown>): void {
    const fullPayload = { ...payload, timestamp: payload.timestamp ?? Date.now() };
    this.dispatchListeners(eventType, fullPayload);
  }

  private async persistThenDispatchCustom(
    eventType: string,
    agentId: string,
    payload: Record<string, unknown>,
    options: { rejectOnPersistFailure?: boolean } = {},
  ): Promise<void> {
    const fullPayload = { ...payload, timestamp: payload.timestamp ?? Date.now() };

    if (this.persistEvent) {
      try {
        await this.persistEvent(eventType, agentId, JSON.stringify(fullPayload));
      } catch (err) {
        this.reportBusError('persist', eventType, err, `[EventBus] persist error for custom ${eventType}:`);
        if (options.rejectOnPersistFailure) {
          throw err;
        }
        return;
      }
    }

    // Dispatch to subscribers (trigger manager subscribes with raw event type strings)
    this.dispatchListeners(eventType, fullPayload);
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
