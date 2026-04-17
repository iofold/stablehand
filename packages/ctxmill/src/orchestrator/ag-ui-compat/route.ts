import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseRepository } from '../../database/repository.js';
import type { EventMap, EventName, TypedEventBus } from '../../events/bus.js';
import type { AgentDefinition } from '../../types.js';
import type { AgentSessionService } from '../agent-session-service.js';
import type { RunStartupService } from '../run-startup-service.js';
import { mapMessagesToInternal } from '../routes/agent-helpers.js';
import { AGUIEventNormalizer } from './event-normalizer.js';
import type { AGUIMessage, AGUIMessageRole, AGUIRunAgentInput } from './types.js';

export interface AGUICompatRouteOptions {
  db: DatabaseRepository;
  eventBus: TypedEventBus;
  agentSessionService: AgentSessionService;
  sessionManager?: { checkConcurrencyLimit(agentId: string): void } | null;
  runStartupService?: RunStartupService;
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

  if (typeof body.threadId !== 'string' || body.threadId.trim() === '') {
    return null;
  }
  if (typeof body.runId !== 'string' || body.runId.trim() === '') {
    return null;
  }
  if (!Array.isArray(body.messages) || !body.messages.every(isAGUIMessage)) {
    return null;
  }

  return {
    threadId: body.threadId,
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
  const { db, eventBus, agentSessionService, sessionManager, runStartupService } = opts;

  app.post(
    '/:id/run',
    async (request: AGUIRunRequest, reply: FastifyReply) => {
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

      if (turn && turn.conversationId !== body.threadId) {
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
      let conversationId = turn?.conversationId;
      let executionParams: {
        agentDef: AgentDefinition;
        messages: ReturnType<typeof mapMessagesToInternal>;
        conversationId: string;
        turnId: string;
        taskDescription: string;
      } | null = null;

      if (!isReconnect) {
        const lastUserMessage = [...body.messages].reverse().find((message) => message.role === 'user');
        const userContent = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content.trim() : '';

        if (!userContent) {
          return reply.status(400).send({ error: 'A non-empty user message is required' });
        }

        try {
          if (runStartupService) {
            const start = await runStartupService.prepareRunStart({
              agent,
              agentId: id,
              content: userContent,
              mode: 'interactive',
              conversationId: body.threadId,
              requestedTurnId: body.runId,
              requireExistingConversation: true,
              emitUserMessageEvent: true,
            });
            conversationId = start.conversationId;
            turn = await db.getTurn(start.turnId);
            executionParams = {
              agentDef: start.agentDef,
              messages: start.messages,
              conversationId: start.conversationId,
              turnId: start.turnId,
              taskDescription: userContent,
            };
          } else {
            const existingConversation = await db.getConversation(body.threadId);
            if (!existingConversation || existingConversation.agentId !== id) {
              return reply.status(404).send({ error: 'Conversation not found for agent', threadId: body.threadId });
            }

            conversationId = existingConversation.id;
            const message = await db.addMessage({
              agentId: id,
              conversationId,
              role: 'user',
              content: userContent,
            });

            try {
              sessionManager?.checkConcurrencyLimit(id);
              turn = await db.createTurn({
                id: body.runId,
                agentId: id,
                conversationId,
                mode: 'interactive',
              });
            } catch (err) {
              await db.deleteMessage(message.id).catch((deleteErr) => {
                console.error(`[ag-ui] failed to rollback user message ${message.id}:`, deleteErr);
              });
              throw err;
            }

            eventBus.emit('user.message', {
              agentId: id,
              conversationId,
              messageId: message.id,
              content: userContent,
              timestamp: Date.now(),
            });
            eventBus.emit('turn.pending', {
              turnId: turn.id,
              agentId: id,
              conversationId,
              mode: 'interactive',
              timestamp: Date.now(),
            });

            if (!agent.harness) {
              return reply.status(500).send({ error: 'Agent harness is not set' });
            }

            const agentDef: AgentDefinition = {
              name: agent.name,
              harness: agent.harness,
              harnessConfig: {},
              tools: agent.tools,
              systemPrompt: agent.systemPrompt,
            };
            const allMessages = await db.getMessages(conversationId);
            const messages = mapMessagesToInternal(allMessages, id);

            executionParams = {
              agentDef,
              messages,
              conversationId,
              turnId: turn.id,
              taskDescription: userContent,
            };
          }
        } catch (err) {
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
        runId: turn.id,
        threadId: conversationId,
        messages: allMessages.map(toAGUIMessage),
      });

      const normalizer = new AGUIEventNormalizer(turn.id, conversationId);
      const unsubscribers: Array<() => void> = [];
      let cleanedUp = false;

      const cleanup = (): void => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        clearInterval(heartbeat);
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
      };

      const subscribe = <K extends EventName>(eventName: K): void => {
        const handler = (payload: EventMap[K]): void => {
          if (!matchesRun(id, turn.id, payload)) {
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
      subscribe('message.committed');
      subscribe('session.paused');

      const heartbeat = setInterval(() => {
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
        if (runStartupService) {
          void runStartupService.launchPreparedRun({
            agentDef: executionParams.agentDef,
            messages: executionParams.messages,
            conversationId: executionParams.conversationId,
            turnId: executionParams.turnId,
            messageId: '',
            mode: 'interactive',
            taskDescription: executionParams.taskDescription,
          }, id).catch((err) => {
            console.error(`[ag-ui] executeSession failed for agent ${id}, turn ${executionParams?.turnId}:`, err);
          });
        } else {
          void agentSessionService.executeSession({
            agentDef: executionParams.agentDef,
            messages: executionParams.messages,
            agentId: id,
            conversationId: executionParams.conversationId,
            sessionId: executionParams.turnId,
            mode: 'interactive',
            taskDescription: executionParams.taskDescription,
          }).catch(async (err) => {
            console.error(`[ag-ui] executeSession failed for agent ${id}, turn ${executionParams?.turnId}:`, err);
            await db.updateTurn(executionParams.turnId, {
              completedAt: Date.now(),
              error: err instanceof Error ? err.message : String(err),
            }).catch((dbErr) => {
              console.error(`[ag-ui] failed to update turn ${executionParams?.turnId} after session error:`, dbErr);
            });
          });
        }
      }

      return reply;
    },
  );
}
