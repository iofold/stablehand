import { randomUUID } from 'node:crypto';
import type { Message } from '../../types.js';
import type {
  AgentEvent,
  HarnessSession,
  HarnessSessionConfig,
} from '../types.js';
import { createAgentEventLangSmithTracer } from './agent-event-langsmith-tracer.js';
import { traceAgentEvents } from './trace-agent-events.js';
import type { TurnAccumulator } from './turn-accumulator.js';

export function withTurnTracing(
  session: HarnessSession,
  config: HarnessSessionConfig,
  harnessName: string,
): HarnessSession {
  return traceAgentEvents(session, {
    createTracer: (input) => createAgentEventLangSmithTracer({
      agentId: config.agentId,
      conversationId: config.conversationId,
      harnessName,
      turnId: input.turnId,
    }),
  });
}

export function* finalizeTurn(
  accumulator: TurnAccumulator,
  transcript: Message[],
  agentId: string,
): Generator<AgentEvent> {
  const committed = accumulator.createMessageCommitted(transcript.length);
  if (committed) {
    transcript.push({
      id: randomUUID(),
      agentId,
      role: 'assistant',
      content: committed.content,
      ...(committed.toolCalls ? { toolCalls: committed.toolCalls } : {}),
      createdAt: new Date(),
    });
    yield committed;
  }

  const done = accumulator.doneEvent();
  if (done) {
    yield done;
  }
}
