import { EventEmitter } from 'node:events';

type EventMap = {
  'agent.created': { agentId: string };
  'agent.status_changed': { agentId: string; from: string; to: string };
  'agent.message_received': { agentId: string; messageId: string };
  'tool.call_started': { agentId: string; toolName: string; callId: string };
  'tool.call_completed': { agentId: string; callId: string; durationMs: number };
  'tool.call_failed': { agentId: string; callId: string; error: string };
  'trace.captured': { traceId: string; agentId: string };
  'feedback.received': { feedbackId: string; agentId: string };
  'knowledge.updated': { agentId: string; itemId: string };
};

export class TypedEventBus {
  private emitter = new EventEmitter();

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.emitter.on(event, handler);
  }

  off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.emitter.off(event, handler);
  }

  once<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.emitter.once(event, handler);
  }

  removeAllListeners<K extends keyof EventMap>(event?: K): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }
}
