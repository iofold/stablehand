import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseRepository } from '../../database/repository.js';
import type { EventMap, EventName, TypedEventBus } from '../../events/bus.js';
import type { PreparedRunStart, RunStartupService } from '../run-startup-service.js';
import { ConcurrencyLimitError } from '../session-manager/concurrency-limit-error.js';
import { AGUIEventNormalizer } from './event-normalizer.js';
import type { AGUIMessage, AGUIMessageRole, AGUIRunAgentInput } from './types.js';

export interface AGUICompatRouteOptions {
  db: DatabaseRepository;
  eventBus: TypedEventBus;
  runStartupService: RunStartupService;
}

type AGUIRunRequest = FastifyRequest<{
  Params: { id: string };
  Body: AGUIRunAgentInput;
}>;

const AGUI_MESSAGE_ROLES = new Set<AGUIMessageRole>(['developer', 'system', 'assistant', 'user', 'tool']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isAGUIMessageRole(value: unknown): value is AGUIMessageRole {
  return typeof value === 'string' && AGUI_MESSAGE_ROLES.has(value as AGUIMessageRole);
}

function isAGUIMessage(value: unknown): value is AGUIRunAgentInput['messages'][number] {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.id === 'string'
    && isAGUIMessageRole(value.role)
    && (value.content === undefined || typeof value.content === 'string')
    && (value.name === undefined || typeof value.name === 'string')
    && (value.toolCallId === undefined || typeof value.toolCallId === 'string');
}

function parseRunInput(body: unknown): AGUIRunAgentInput | null {
  if (!isRecord(body)) {
    return null;
  }

  if (typeof body.runId !== 'string' || body.runId.trim() === '') {
    return null;
  }
  if (!Array.isArray(body.messages) || !body.messages.every(isAGUIMessage)) {
    return null;
  }
  const threadId = typeof body.threadId === 'string' && body.threadId.trim() !== ''
    ? body.threadId
    : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    runId: body.runId,
    state: body.state,
    messages: body.messages,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    context: Array.isArray(body.context) ? body.context : undefined,
    forwardedProps: body.forwardedProps,
  };
}

function toAGUIMessage(message: {
  id: string;
  role: string;
  content: string;
  toolCallId?: string | null;
}): AGUIMessage {
  const role = isAGUIMessageRole(message.role) ? message.role : 'assistant';
  return {
    id: message.id,
    role,
    content: message.content,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  };
}

function matchesRun<K extends EventName>(agentId: string, turnId: string, payload: EventMap[K]): boolean {
  if ('turnId' in payload) {
    return payload.turnId === turnId;
  }
  if ('agentId' in payload) {
    return payload.agentId === agentId;
  }
  return false;
}

export async function agUiCompatRoutes(
  app: FastifyInstance,
  opts: AGUICompatRouteOptions,
): Promise<void> {
  const { db, eventBus, runStartupService } = opts;

  const runHandler = async (
    request: AGUIRunRequest,
    reply: FastifyReply,
  ) => {
    const { id } = request.params;
    const body = parseRunInput(request.body);

    if (!body) {
      return reply.status(400).send({ error: 'Invalid AG-UI RunAgentInput body' });
    }

    const agent = await db.getAgent(id);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found', agentId: id });
    }

    let turn = await db.getTurn(body.runId);
    if (turn && turn.agentId !== id) {
      return reply.status(404).send({ error: 'Run not found for agent', runId: body.runId });
    }

    if (turn && body.threadId && turn.conversationId !== body.threadId) {
      return reply.status(409).send({
        error: 'Run does not belong to the supplied threadId',
        runId: body.runId,
        threadId: body.threadId,
      });
    }

    if (turn?.completedAt) {
      return reply.status(409).send({ error: 'Run already completed', runId: body.runId });
    }

    const isReconnect = Boolean(turn && !turn.completedAt);
    let conversationId = turn?.conversationId ?? body.threadId;
    let executionParams: PreparedRunStart | null = null;

    if (!isReconnect) {
      const lastUserMessage = [...body.messages].reverse().find((message) => message.role === 'user');
      const userContent = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content.trim() : '';

      if (!userContent) {
        return reply.status(400).send({ error: 'A non-empty user message is required' });
      }

      try {
        const start = await runStartupService.prepareRunStart({
          agent,
          agentId: id,
          content: userContent,
          mode: 'interactive',
          conversationId: body.threadId,
          requestedTurnId: body.runId,
          requireExistingConversation: false,
          createMissingConversationWithRequestedId: Boolean(body.threadId),
          emitUserMessageEvent: true,
        });
        conversationId = start.conversationId;
        turn = await db.getTurn(start.turnId);
        executionParams = start;
      } catch (err) {
        if (err instanceof ConcurrencyLimitError) {
          return reply
            .status(err.statusCode)
            .header('Retry-After', String(err.retryAfterSec))
            .send({
              error: err.message,
              code: 'concurrency_limit_reached',
              agentId: err.agentId,
              maxConcurrent: err.maxConcurrent,
              retryAfterSec: err.retryAfterSec,
            });
        }
        const message = err instanceof Error ? err.message : 'Failed to start session';
        if (message.startsWith('Conversation ')) {
          return reply.status(404).send({ error: message, threadId: body.threadId });
        }
        if (message.startsWith('Turn already exists')) {
          return reply.status(409).send({ error: message, runId: body.runId });
        }
        return reply.status(500).send({ error: message });
      }
    }

    if (!turn || !conversationId) {
      return reply.status(500).send({ error: 'Failed to resolve run state' });
    }
    const activeTurn = turn;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const writeEvent = (event: Record<string, unknown>): void => {
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        return;
      }
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const allMessages = await db.getMessages(conversationId);
    writeEvent({
      type: 'MESSAGES_SNAPSHOT',
      runId: activeTurn.id,
      threadId: conversationId,
      messages: allMessages.map(toAGUIMessage),
    });

    const normalizer = new AGUIEventNormalizer(activeTurn.id, conversationId);
    const unsubscribers: Array<() => void> = [];
    let cleanedUp = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };

    const subscribe = <K extends EventName>(eventName: K): void => {
      const handler = (payload: EventMap[K]): void => {
        if (!matchesRun(id, activeTurn.id, payload)) {
          return;
        }

        for (const event of normalizer.normalize(eventName, payload)) {
          writeEvent(event);
        }

        if (eventName === 'turn.completed') {
          cleanup();
          if (!reply.raw.writableEnded && !reply.raw.destroyed) {
            reply.raw.end();
          }
        }
      };

      eventBus.on(eventName, handler);
      unsubscribers.push(() => eventBus.off(eventName, handler));
    };

    subscribe('turn.started');
    subscribe('run.text_chunk');
    subscribe('run.tool_started');
    subscribe('run.tool_result');
    subscribe('run.interrupted');
    subscribe('run.interrupt_resolved');
    subscribe('run.ag_ui_event');
    subscribe('turn.completed');

    heartbeat = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        cleanup();
        return;
      }
      reply.raw.write(': heartbeat\n\n');
    }, 15000);

    request.raw.on('close', () => {
      cleanup();
    });

    if (executionParams) {
      void runStartupService.launchPreparedRun(executionParams, id).catch((err) => {
        console.error(`[ag-ui] executeSession failed for agent ${id}, turn ${executionParams?.turnId}:`, err);
      });
    }

    return reply;
  };

  app.post('/:id/run', runHandler);
  app.post('/agents/:id/run', runHandler);
}
