import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseRepository } from '../../database/repository.js';
import type { TypedEventBus } from '../../events/bus.js';
import type { PreparedTurnStart, TurnStartupService } from '../turn-startup-service.js';
import { sendTurnStartError } from '../turn-start-errors.js';
import { writeSseHead } from '../sse.js';
import type { AGUIMessage, AGUIMessageRole, AGUIRunAgentInput } from './types.js';
import type { CanonicalLog } from '../canonical/canonical-log.js';
import type { PersistedFrame } from '../canonical/frames.js';

export interface AGUICompatRouteOptions {
  db: DatabaseRepository;
  eventBus: TypedEventBus;
  turnStartupService: TurnStartupService;
  /** Durable canonical event spine (ADR-015). */
  canonicalLog?: CanonicalLog;
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
  toolCalls?: unknown[] | null;
  parts?: unknown[] | null;
}): AGUIMessage {
  const role = isAGUIMessageRole(message.role) ? message.role : 'assistant';
  return {
    id: message.id,
    role,
    content: message.content,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    // Structured transcript fidelity in the snapshot (ctx-4fs): reconnecting
    // clients get tool-call state and message parts, not just flattened text.
    ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0 ? { toolCalls: message.toolCalls } : {}),
    ...(Array.isArray(message.parts) && message.parts.length > 0 ? { parts: message.parts } : {}),
  } as AGUIMessage;
}

export async function agUiCompatRoutes(
  app: FastifyInstance,
  opts: AGUICompatRouteOptions,
): Promise<void> {
  const { db, turnStartupService, canonicalLog } = opts;

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
    let executionParams: PreparedTurnStart | null = null;

    if (!isReconnect) {
      const lastUserMessage = [...body.messages].reverse().find((message) => message.role === 'user');
      const userContent = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content.trim() : '';

      if (!userContent) {
        return reply.status(400).send({ error: 'A non-empty user message is required' });
      }

      // Budget-attribution tags ride on forwardedProps.tags (flat string map).
      const forwarded = body.forwardedProps as Record<string, unknown> | undefined;
      const forwardedTags = forwarded && typeof forwarded === 'object' && !Array.isArray(forwarded)
        && forwarded.tags && typeof forwarded.tags === 'object' && !Array.isArray(forwarded.tags)
        ? Object.fromEntries(
          Object.entries(forwarded.tags as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string') as Array<[string, string]>,
        )
        : undefined;

      try {
        const start = await turnStartupService.prepareTurnStart({
          agent,
          agentId: id,
          content: userContent,
          mode: 'interactive',
          conversationId: body.threadId,
          requestedTurnId: body.runId,
          requireExistingConversation: false,
          createMissingConversationWithRequestedId: Boolean(body.threadId),
          emitUserMessageEvent: true,
          ...(forwardedTags && Object.keys(forwardedTags).length > 0 ? { tags: forwardedTags } : {}),
        });
        conversationId = start.conversationId;
        turn = await db.getTurn(start.turnId);
        executionParams = start;
      } catch (err) {
        if (sendTurnStartError(reply, err)) return reply;
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

    writeSseHead(reply);

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

    if (!canonicalLog) {
      writeEvent({ type: 'RUN_ERROR', message: 'canonical event log not configured', timestamp: Date.now() });
      reply.raw.end();
      cleanup();
      return reply;
    }

    {
      // A2 (ADR-015): one canonical-log subscription serves this run's wire.
      // Frames already carry stable messageIds and the ctxmill.* CUSTOM vocabulary.
      const frameMatchesRun = (frame: PersistedFrame): boolean =>
        frame.turnId === activeTurn.id || (!frame.turnId && frame.agentId === id && frame.conversationId === conversationId);

      const writeFrame = (frame: PersistedFrame): void => {
        writeEvent(frame.body as Record<string, unknown>);
      };

      // Durable tail replay. Reconnects reproduce in-flight partials with
      // stable ids (ctx-4fs); fresh runs pick up the frames prepareTurnStart
      // persisted before this subscription existed (ctxmill.turn.pending,
      // user.message) so clients get provisioning feedback immediately —
      // launchPreparedTurn only fires below, so nothing can slip between
      // this replay and the live subscription.
      for (const frame of await canonicalLog.replayTurnTail(activeTurn.id)) {
        if (frame.channel === 'run') {
          writeFrame(frame);
        }
      }

      unsubscribers.push(canonicalLog.subscribe((frames) => {
        for (const frame of frames) {
          if (frame.channel !== 'run' || !frameMatchesRun(frame)) {
            continue;
          }
          writeFrame(frame);
          if (frame.type === 'RUN_FINISHED') {
            cleanup();
            if (!reply.raw.writableEnded && !reply.raw.destroyed) {
              reply.raw.end();
            }
          }
        }
      }));
    }

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
      void turnStartupService.launchPreparedTurn(executionParams, id);
    }

    return reply;
  };

  app.post('/:id/run', runHandler);
}
