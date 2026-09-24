import { EventEmitter } from 'node:events';
import type { TurnUsage } from '@stablehand/contracts';

export type EventMap = {
  'turn.started': {
    turnId: string;
    sandboxSessionId: string;
    agentId: string;
    conversationId: string;
    mode: 'interactive' | 'background';
    taskDescription: string;
    timestamp: number;
  };
  'message.delta': {
    turnId: string;
    agentId: string;
    conversationId: string;
    messageId: string;
    delta: string;
    timestamp: number;
  };
  'tool_call.started': {
    turnId: string;
    agentId: string;
    conversationId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    requiresApproval?: boolean;
    /**
     * Subagent annotation (ctx-5myn): the spawning Task tool call's id and
     * the subagent's display identity. Rides the bus because the UI's
     * TOOL_CALL_* frames are projector-synthesized from these payloads.
     */
    parentToolCallId?: string;
    agentName?: string;
    timestamp: number;
  };
  'tool_call.completed': {
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
  'interrupt.requested': {
    turnId: string;
    sandboxSessionId?: string;
    agentId: string;
    conversationId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    interruptId: string;
    timestamp: number;
  };
  'interrupt.resolved': {
    turnId: string;
    sandboxSessionId?: string;
    agentId: string;
    conversationId: string;
    interruptId: string;
    action: 'approve' | 'reject' | 'suspend' | 'timeout';
    timestamp: number;
  };
  'turn.completed': {
    turnId: string;
    sandboxSessionId?: string;
    agentId: string;
    conversationId: string;
    status: 'completed' | 'error' | 'cancelled';
    error?: string;
    durationMs: number;
    /** Canonical finish-time usage. Gateway cost may still be pending. */
    usage: TurnUsage | null;
    timestamp: number;
  };
  'budget.threshold': {
    policyId: string;
    policyName: string;
    /** e.g. "user=alice@acme.com" or "(untagged)"; absent for ungrouped policies. */
    bucket?: string;
    action: 'warn' | 'block';
    threshold: number;
    metric: 'totalTokens' | 'costUsd' | 'turns';
    spent: number;
    limit: number;
    agentId: string;
    timestamp: number;
  };
  'artifact.created': {
    artifactId: string;
    agentId: string;
    turnId?: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    kind?: string;
    sha256?: string;
    timestamp: number;
  };
  'feedback.received': {
    feedbackId: string;
    turnId: string;
    agentId: string;
    type: 'thumbs_up' | 'thumbs_down';
    messageId?: string;
    comment?: string;
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
  'turn.cancelled': {
    turnId: string;
    agentId: string;
    conversationId?: string | null;
    timestamp: number;
  };
  'artifact.deleted': {
    artifactId: string;
    agentId: string | null;
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
    messageId: string;
    messageSeq: number;
    role: 'assistant' | 'tool';
    content: string;
    parts?: Array<{ type: string; [key: string]: unknown }>;
    toolCalls?: Array<{ id: string; name: string; args: string; status: string }>;
    toolCallId?: string;
    timestamp: number;
  };
  'message.updated': {
    turnId: string;
    agentId: string;
    conversationId: string;
    messageId: string;
    messageSeq: number;
    messageRevision: number;
    role: 'assistant';
    content: string;
    parts?: Array<{ type: string; [key: string]: unknown }>;
    toolCalls?: Array<{ id: string; name: string; args: string; status: string }>;
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
  'ag_ui.event': {
    turnId: string;
    agentId: string;
    conversationId?: string;
    event: Record<string, unknown>;
    timestamp: number;
  };
  'user.message': {
    turnId: string;
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

interface EventDeliveryFence {
  ownerId: string;
  fenceToken: number;
}

interface EventActiveSandboxGeneration {
  restoreFenceToken: number;
  containerId: string | null;
}

export type EventPersistenceContext =
  | {
      deliveryFence?: EventDeliveryFence;
      sandboxSessionId?: never;
      activeGeneration?: never;
    }
  | {
      deliveryFence: EventDeliveryFence;
      sandboxSessionId: string;
      activeGeneration: EventActiveSandboxGeneration;
    };

export type PersistEventFn = (
  type: string,
  agentId: string,
  payload: string,
  /** The payload object that produced `payload` — lets persistence layers avoid a hot-path re-parse (ADR-015). */
  parsedPayload?: Record<string, unknown>,
  context?: EventPersistenceContext,
) => void | boolean | Promise<void | boolean>;

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
  emit<K extends EventName>(
    event: K,
    payload: EventMap[K],
    context?: EventPersistenceContext,
  ): void {
    this.ensureTimestamp(payload);

    if (!this.persistEvent) {
      this.dispatchListeners(event, payload);
      return;
    }

    const agentId = 'agentId' in payload ? (payload as PayloadWithAgentId).agentId : '';
    try {
      const persisted = this.persistEvent(
        event,
        agentId,
        JSON.stringify(payload),
        payload as Record<string, unknown>,
        context,
      );
      if (persisted && typeof persisted !== 'boolean') {
        persisted
          .then((didPersist) => {
            if (didPersist !== false) {
              this.dispatchListeners(event, payload);
            }
          })
          .catch((err: unknown) => {
            this.reportBusError('persist', event, err, `[EventBus] persist error for ${event}:`);
          });
        return;
      }
      if (persisted === false) {
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
  async emitAsync<K extends EventName>(
    event: K,
    payload: EventMap[K],
    context?: EventPersistenceContext,
  ): Promise<boolean> {
    return this.persistThenDispatch(event, payload, {
      rejectOnPersistFailure: true,
      ...(context ? { persistenceContext: context } : {}),
    });
  }

  private ensureTimestamp(payload: EventPayloadBase): void {
    if (!payload.timestamp) {
      payload.timestamp = Date.now();
    }
  }

  private async persistThenDispatch<K extends EventName>(
    event: K,
    payload: EventMap[K],
    options: {
      rejectOnPersistFailure?: boolean;
      persistenceContext?: EventPersistenceContext;
    } = {},
  ): Promise<boolean> {
    this.ensureTimestamp(payload);

    if (this.persistEvent) {
      const agentId = 'agentId' in payload ? (payload as PayloadWithAgentId).agentId : '';
      try {
        const didPersist = await this.persistEvent(
          event,
          agentId,
          JSON.stringify(payload),
          payload as Record<string, unknown>,
          options.persistenceContext,
        );
        if (didPersist === false) {
          return false;
        }
      } catch (err) {
        this.reportBusError('persist', event, err, `[EventBus] persist error for ${event}:`);
        if (options.rejectOnPersistFailure) {
          throw err;
        }
        return false;
      }
    }

    this.dispatchListeners(event, payload);
    return true;
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
  emitCustom(
    eventType: string,
    agentId: string,
    payload: Record<string, unknown>,
    context?: EventPersistenceContext,
  ): void {
    const fullPayload = { ...payload, timestamp: payload.timestamp ?? Date.now() };

    if (!this.persistEvent) {
      this.dispatchListeners(eventType, fullPayload);
      return;
    }

    try {
      const persisted = this.persistEvent(
        eventType,
        agentId,
        JSON.stringify(fullPayload),
        fullPayload,
        context,
      );
      if (persisted && typeof persisted !== 'boolean') {
        persisted
          .then((didPersist) => {
            if (didPersist !== false) {
              this.dispatchListeners(eventType, fullPayload);
            }
          })
          .catch((err: unknown) => {
            this.reportBusError('persist', eventType, err, `[EventBus] persist error for custom ${eventType}:`);
          });
        return;
      }
      if (persisted === false) {
        return;
      }
    } catch (err) {
      this.reportBusError('persist', eventType, err, `[EventBus] persist error for custom ${eventType}:`);
      return;
    }

    this.dispatchListeners(eventType, fullPayload);
  }

  async emitCustomAsync(
    eventType: string,
    agentId: string,
    payload: Record<string, unknown>,
    context?: EventPersistenceContext,
  ): Promise<boolean> {
    return this.persistThenDispatchCustom(eventType, agentId, payload, {
      rejectOnPersistFailure: true,
      ...(context ? { persistenceContext: context } : {}),
    });
  }

  private async persistThenDispatchCustom(
    eventType: string,
    agentId: string,
    payload: Record<string, unknown>,
    options: {
      rejectOnPersistFailure?: boolean;
      persistenceContext?: EventPersistenceContext;
    } = {},
  ): Promise<boolean> {
    const fullPayload = { ...payload, timestamp: payload.timestamp ?? Date.now() };

    if (this.persistEvent) {
      try {
        const didPersist = await this.persistEvent(
          eventType,
          agentId,
          JSON.stringify(fullPayload),
          fullPayload,
          options.persistenceContext,
        );
        if (didPersist === false) {
          return false;
        }
      } catch (err) {
        this.reportBusError('persist', eventType, err, `[EventBus] persist error for custom ${eventType}:`);
        if (options.rejectOnPersistFailure) {
          throw err;
        }
        return false;
      }
    }

    // Dispatch to subscribers (trigger manager subscribes with raw event type strings)
    this.dispatchListeners(eventType, fullPayload);
    return true;
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
