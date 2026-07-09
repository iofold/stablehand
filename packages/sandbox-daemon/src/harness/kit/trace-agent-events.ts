import type {
  AgentEvent,
  HarnessSession,
  HarnessTurnContext,
  HarnessTurnInput,
} from '../types.js';

export interface AgentEventTracer {
  onEvent(event: AgentEvent): void | Promise<void>;
  flush?(): void | Promise<void>;
}

export interface TraceAgentEventsOptions {
  createTracer(input: HarnessTurnInput, context: HarnessTurnContext): AgentEventTracer | null | Promise<AgentEventTracer | null>;
}

async function safeTraceEvent(tracer: AgentEventTracer, event: AgentEvent): Promise<void> {
  try {
    await tracer.onEvent(event);
  } catch (err) {
    console.warn('[harness-trace] Failed to trace AgentEvent:', err);
  }
}

async function safeFlush(tracer: AgentEventTracer | null): Promise<void> {
  if (!tracer?.flush) {
    return;
  }

  try {
    await tracer.flush();
  } catch (err) {
    console.warn('[harness-trace] Failed to flush AgentEvent tracer:', err);
  }
}

export function traceAgentEvents(
  session: HarnessSession,
  options: TraceAgentEventsOptions,
): HarnessSession {
  const tracedDeliverTurn = async function* (
    input: HarnessTurnInput,
    context: HarnessTurnContext,
  ): AsyncGenerator<AgentEvent> {
    const tracer = await options.createTracer(input, context);
    try {
      for await (const event of session.deliverTurn(input, context)) {
        if (tracer) {
          await safeTraceEvent(tracer, event);
        }
        yield event;
      }
    } finally {
      await safeFlush(tracer);
    }
  };

  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === 'deliverTurn') {
        return tracedDeliverTurn;
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value, receiver) {
      return Reflect.set(target, property, value, receiver);
    },
  });
}
