import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { SandboxSecretsSchema } from '@ctxmill/contracts';

import {
  ActiveTurnSuspendError,
  RestoreConflictError,
  SandboxSessionNotFoundError,
} from '../../session-manager/session-lifecycle-service.js';
import { classifyRestoreFailure } from '../../session-manager/restore-retry-policy.js';
import { SessionRestoreBudgetExhaustedError } from '../../session-manager/session-recovery-coordinator.js';
import type { TurnSecrets } from '../../session-manager/turn-secrets.js';
import { TURN_CANCELLED_MESSAGE, isTurnCancelled } from '../../turn-cancellation.js';
import { TurnFinalizer } from '../../turn-finalizer.js';
import { buildAgentDefinition } from '../../agent-definition.js';
import { sendTurnStartError } from '../../turn-start-errors.js';
import { toApiMessage } from '../agent-helpers.js';
import { getRequestAgent, safeError, toApiAgentTurn } from './helpers.js';
import type { AgentSubRouteOptions } from './types.js';
import type { SandboxSessionRow } from '../../../database/repository.js';

const TURN_COST_COVERAGE_FILTER_VALUES: ReadonlySet<string> = new Set([
  'complete',
  'partial',
  'pending',
  'unpriced',
]);

type TurnStartApiResponse = {
  turnId: string;
  conversationId: string;
  messageId?: string;
  sandboxSessionId?: null;
};

class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used for a different request`);
    this.name = 'IdempotencyConflictError';
  }
}

class IdempotencyInProgressError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} is still preparing its original request`);
    this.name = 'IdempotencyInProgressError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hashTurnStartRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function readIdempotencyKey(
  request: FastifyRequest,
  requestedTurnId: unknown,
): string | undefined {
  const raw = request.headers['idempotency-key'];
  if (Array.isArray(raw)) {
    throw new Error('Idempotency-Key must be provided once');
  }
  if (raw !== undefined && (typeof raw !== 'string' || raw.trim().length === 0)) {
    throw new Error('Idempotency-Key must be a non-empty string');
  }
  const key = raw?.trim() ?? (
    typeof requestedTurnId === 'string' && requestedTurnId.trim().length > 0
      ? `turn:${requestedTurnId.trim()}`
      : undefined
  );
  if (key && key.length > 255) {
    throw new Error('Idempotency-Key must be at most 255 characters');
  }
  return key;
}

function parseRequestedId(
  value: unknown,
  field: 'requestedTurnId' | 'conversationId',
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 255) {
    throw new Error(`${field} must be a non-empty string (max 255 chars)`);
  }
  return value.trim();
}

async function loadOwnedSandboxSession(
  db: Pick<AgentSubRouteOptions['db'], 'getSandboxSession'>,
  agentId: string,
  sandboxSessionId: string,
): Promise<SandboxSessionRow | null> {
  const session = await db.getSandboxSession(sandboxSessionId);
  return session?.agentId === agentId ? session : null;
}

export async function turnRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, interrupts, sessionManager, eventBus, turnStartupService, loadAgent } = opts;
  const turnFinalizer = eventBus
    ? new TurnFinalizer({ db, eventBus, logger: console })
    : null;

  const parseSandboxSecrets = (value: unknown): TurnSecrets | undefined => {
    if (value === undefined) return undefined;
    const parsed = SandboxSecretsSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `sandboxSecrets${issue?.path.length ? `.${issue.path.join('.')}` : ''}: `
        + (issue?.message ?? 'validation failed'),
      );
    }
    return Object.freeze({ ...parsed.data });
  };

  const RESERVED_TAG_KEYS = new Set(['agent', 'harness', 'mode']);
  const parseTags = (value: unknown): Record<string, string> | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('tags must be an object of string values');
    }
    const tags: Record<string, string> = {};
    for (const [key, tagValue] of Object.entries(value)) {
      if (RESERVED_TAG_KEYS.has(key)) {
        throw new Error(`tags.${key} is reserved (stamped by the system)`);
      }
      if (typeof tagValue !== 'string' || tagValue.length === 0 || tagValue.length > 256) {
        throw new Error(`tags.${key} must be a non-empty string (max 256 chars)`);
      }
      tags[key] = tagValue;
    }
    return Object.keys(tags).length > 0 ? tags : undefined;
  };

  const claimIdempotentStart = async (params: {
    agentId: string;
    idempotencyKey?: string;
    requestHash: string;
    requestedTurnId?: string;
    requestedConversationId?: string;
  }): Promise<{
    ledgerId?: string;
    turnId?: string;
    conversationId?: string;
    replay?: Record<string, unknown>;
  }> => {
    if (!params.idempotencyKey) {
      return {
        ...(params.requestedTurnId ? { turnId: params.requestedTurnId } : {}),
        ...(params.requestedConversationId ? { conversationId: params.requestedConversationId } : {}),
      };
    }

    const claim = await db.claimTurnStartRequest({
      agentId: params.agentId,
      idempotencyKey: params.idempotencyKey,
      requestHash: params.requestHash,
      turnId: params.requestedTurnId ?? randomUUID(),
      conversationId: params.requestedConversationId ?? randomUUID(),
    });
    if (claim.request.requestHash !== params.requestHash) {
      throw new IdempotencyConflictError(params.idempotencyKey);
    }
    if (claim.claimed) {
      return {
        ledgerId: claim.request.id,
        turnId: claim.request.turnId,
        conversationId: claim.request.conversationId,
      };
    }

    let current = claim.request;
    for (let attempt = 0; attempt < 40 && current.status === 'preparing'; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      current = await db.getTurnStartRequest(params.agentId, params.idempotencyKey) ?? current;
    }
    if (current.status === 'prepared' && current.response) {
      return { replay: current.response };
    }
    throw new IdempotencyInProgressError(params.idempotencyKey);
  };

  const sendIdempotencyError = (
    reply: FastifyReply,
    err: unknown,
  ): FastifyReply | undefined => {
    if (err instanceof IdempotencyConflictError) {
      return reply.status(409).send({
        error: err.message,
        code: 'idempotency_conflict',
        idempotencyKey: err.idempotencyKey,
      });
    }
    if (err instanceof IdempotencyInProgressError) {
      return reply.status(409).send({
        error: err.message,
        code: 'idempotency_in_progress',
        idempotencyKey: err.idempotencyKey,
      });
    }
    return undefined;
  };

  app.post(
    '/:id/message',
    { preHandler: [loadAgent], config: { capability: 'conversations:write' } },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          content: string;
          conversationId?: string;
          requestedTurnId?: string;
          sandboxSecrets?: Record<string, string>;
          tags?: Record<string, string>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as {
        content: string;
        conversationId?: unknown;
        requestedTurnId?: unknown;
        sandboxSecrets?: unknown;
        tags?: unknown;
      };

      if (!body || typeof body.content !== 'string' || body.content.trim() === '') {
        return reply.status(400).send({ error: 'content is required and must be a non-empty string' });
      }

      const agent = getRequestAgent(request);
      let ledger: { id: string; requestHash: string; turnId: string } | undefined;

      try {
        const turnSecrets = parseSandboxSecrets(body.sandboxSecrets);
        const tags = parseTags(body.tags);
        const requestedTurnId = parseRequestedId(body.requestedTurnId, 'requestedTurnId');
        const requestedConversationId = parseRequestedId(body.conversationId, 'conversationId');
        const idempotencyKey = readIdempotencyKey(request, requestedTurnId);
        const requestHash = hashTurnStartRequest({
          route: 'message',
          content: body.content,
          conversationId: requestedConversationId ?? null,
          requestedTurnId: requestedTurnId ?? null,
          sandboxSecrets: turnSecrets ?? null,
          tags: tags ?? null,
        });
        const claimed = await claimIdempotentStart({
          agentId: id,
          idempotencyKey,
          requestHash,
          requestedTurnId,
          requestedConversationId,
        });
        if (claimed.replay) {
          return reply.status(201).send(claimed.replay);
        }
        if (claimed.ledgerId && claimed.turnId) {
          ledger = { id: claimed.ledgerId, requestHash, turnId: claimed.turnId };
        }

        const start = await turnStartupService.prepareTurnStart({
          agent,
          agentId: id,
          content: body.content,
          mode: 'interactive',
          conversationId: claimed.conversationId ?? requestedConversationId,
          requestedTurnId: claimed.turnId ?? requestedTurnId,
          createMissingConversationWithRequestedId: Boolean(
            idempotencyKey && !requestedConversationId,
          ),
          emitUserMessageEvent: true,
          turnSecrets,
          ...(tags ? { tags } : {}),
        });
        const response: TurnStartApiResponse = {
          messageId: start.messageId,
          conversationId: start.conversationId,
          turnId: start.turnId,
        };
        if (ledger) {
          await db.completeTurnStartRequest(ledger.id, ledger.requestHash, response);
        }
        turnStartupService.requestDispatch(start, id);
        return reply.status(201).send(response);
      } catch (err) {
        if (ledger && !await db.getTurn(ledger.turnId)) {
          await db.abandonTurnStartRequest(ledger.id, ledger.requestHash);
        }
        const idempotencyReply = sendIdempotencyError(reply, err);
        if (idempotencyReply) return idempotencyReply;
        if (sendTurnStartError(reply, err)) return reply;
        if (err instanceof Error && err.message.startsWith('Conversation ')) {
          return reply.status(404).send({ error: err.message });
        }
        if (
          err instanceof Error
          && /sandbox secret|sandboxSecrets|tags|Idempotency-Key|turnId|conversationId/i.test(err.message)
        ) {
          return reply.status(400).send({ error: err.message });
        }
        return reply.status(500).send(safeError('Failed to start turn', err));
      }
    },
  );

  app.post(
    '/:id/turns',
    { preHandler: [loadAgent], config: { capability: 'conversations:write' } },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          task: string;
          mode?: string;
          conversationId?: string;
          requestedTurnId?: string;
          sandboxSecrets?: Record<string, string>;
          tags?: Record<string, string>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as {
        task?: string;
        mode?: string;
        conversationId?: unknown;
        requestedTurnId?: unknown;
        sandboxSecrets?: unknown;
        tags?: unknown;
      } | undefined;

      if (!body || typeof body.task !== 'string' || body.task.trim() === '') {
        return reply.status(400).send({ error: 'task is required and must be a non-empty string' });
      }

      const agent = getRequestAgent(request);
      let ledger: { id: string; requestHash: string; turnId: string } | undefined;
      try {
        const turnSecrets = parseSandboxSecrets(body.sandboxSecrets);
        const tags = parseTags(body.tags);
        const requestedTurnId = parseRequestedId(body.requestedTurnId, 'requestedTurnId');
        const requestedConversationId = parseRequestedId(body.conversationId, 'conversationId');
        const idempotencyKey = readIdempotencyKey(request, requestedTurnId);
        const requestHash = hashTurnStartRequest({
          route: 'turns',
          task: body.task,
          mode: 'background',
          conversationId: requestedConversationId ?? null,
          requestedTurnId: requestedTurnId ?? null,
          sandboxSecrets: turnSecrets ?? null,
          tags: tags ?? null,
        });
        const claimed = await claimIdempotentStart({
          agentId: id,
          idempotencyKey,
          requestHash,
          requestedTurnId,
          requestedConversationId,
        });
        if (claimed.replay) {
          return reply.status(201).send(claimed.replay);
        }
        if (claimed.ledgerId && claimed.turnId) {
          ledger = { id: claimed.ledgerId, requestHash, turnId: claimed.turnId };
        }

        const start = await turnStartupService.prepareTurnStart({
          agent,
          agentId: id,
          content: body.task,
          mode: 'background',
          conversationId: claimed.conversationId ?? requestedConversationId,
          requestedTurnId: claimed.turnId ?? requestedTurnId,
          createMissingConversationWithRequestedId: Boolean(
            idempotencyKey && !requestedConversationId,
          ),
          emitUserMessageEvent: false,
          turnSecrets,
          ...(tags ? { tags } : {}),
        });
        const response: TurnStartApiResponse = {
          turnId: start.turnId,
          conversationId: start.conversationId,
          sandboxSessionId: null,
        };
        if (ledger) {
          await db.completeTurnStartRequest(ledger.id, ledger.requestHash, response);
        }
        turnStartupService.requestDispatch(start, id);
        return reply.status(201).send(response);
      } catch (err) {
        if (ledger && !await db.getTurn(ledger.turnId)) {
          await db.abandonTurnStartRequest(ledger.id, ledger.requestHash);
        }
        const idempotencyReply = sendIdempotencyError(reply, err);
        if (idempotencyReply) return idempotencyReply;
        if (sendTurnStartError(reply, err)) return reply;
        if (
          err instanceof Error
          && /sandbox secret|sandboxSecrets|tags|Idempotency-Key|turnId|conversationId/i.test(err.message)
        ) {
          return reply.status(400).send({ error: err.message });
        }
        return reply.status(500).send(safeError('Failed to start turn', err));
      }
    },
  );

  app.post(
    '/:id/turns/:turnId/cancel',
    { preHandler: [loadAgent], config: { capability: 'conversations:write' } },
    async (
      request: FastifyRequest<{ Params: { id: string; turnId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, turnId } = request.params;
      const turn = await db.getTurn(turnId);

      if (!turn || turn.agentId !== id) {
        return reply.status(404).send({ error: 'Turn not found', turnId });
      }

      if (turn.completedAt != null) {
        return reply.send({
          cancelled: isTurnCancelled(turn.error),
          turnId,
          alreadyTerminal: true,
        });
      }

      const cancelled = turn.sandboxSessionId
        ? sessionManager?.cancelCurrentTurn(turn.sandboxSessionId, turnId)
        : false;
      if (!cancelled) {
        if (!turnFinalizer) {
          throw new Error('Canonical event bus is required to finalize a turn');
        }
        await turnFinalizer.finalize({
          turnId,
          agentId: id,
          conversationId: turn.conversationId ?? '',
          ...(turn.sandboxSessionId ? { sandboxSessionId: turn.sandboxSessionId } : {}),
          status: 'cancelled',
          error: TURN_CANCELLED_MESSAGE,
          durationMs: Date.now() - turn.startedAt,
        });
      }

      const inMemoryInterruptResolved = await interrupts.resolveForTurn(
        turnId,
        'reject',
        TURN_CANCELLED_MESSAGE,
        id,
        turn.conversationId ?? undefined,
      );
      if (!inMemoryInterruptResolved) {
        const dbInterrupt = await db.getPendingInterruptForTurn(turnId);
        if (dbInterrupt?.agentId === id && dbInterrupt.status === 'pending') {
          await db.resolveInterrupt(dbInterrupt.id, 'reject', TURN_CANCELLED_MESSAGE);
        }
      }

      if (eventBus) {
        eventBus.emitCustom('turn.cancelled', id, {
          turnId,
          agentId: id,
          timestamp: Date.now(),
        });
      }

      return reply.send({ cancelled: true, turnId });
    },
  );

  app.get(
    '/:id/turns/:turnId',
    { preHandler: [loadAgent], config: { capability: 'agents:read' } },
    async (
      request: FastifyRequest<{ Params: { id: string; turnId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, turnId } = request.params;

      const turn = await db.getTurn(turnId);

      if (!turn || turn.agentId !== id) {
        return reply.status(404).send({ error: 'Turn not found', turnId });
      }

      const conversationId = turn.conversationId;
      const [messages, sandboxSession] = await Promise.all([
        typeof conversationId === 'string' ? db.getMessages(conversationId) : [],
        turn.sandboxSessionId ? db.getSandboxSession(turn.sandboxSessionId) : Promise.resolve(null),
      ]);

      return reply.send({
        turn: toApiAgentTurn(turn, sandboxSession, messages.length),
        messages: messages.map(toApiMessage),
      });
    },
  );

  app.get(
    '/:id/turns',
    { preHandler: [loadAgent], config: { capability: 'agents:read' } },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { coverage?: string | string[] };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const rawCoverage = request.query.coverage;
      const coverageValues = (Array.isArray(rawCoverage) ? rawCoverage : rawCoverage ? [rawCoverage] : [])
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const invalidCoverage = coverageValues.filter(
        (value) => !TURN_COST_COVERAGE_FILTER_VALUES.has(value),
      );
      if (invalidCoverage.length > 0) {
        return reply.status(400).send({
          error: `Invalid coverage filter: ${invalidCoverage.join(', ')}. `
            + 'Valid values: complete, partial, pending, unpriced',
        });
      }
      const coverageFilter = coverageValues.length > 0 ? new Set(coverageValues) : null;

      const [turns, sandboxSessions, conversationSummaries] = await Promise.all([
        db.getTurnsByAgent(id),
        db.getSandboxSessionsByAgent(id),
        db.getConversationSummaries(id),
      ]);
      const sandboxById = new Map(sandboxSessions.map((session) => [session.id, session]));
      const messageCountByConversationId = new Map(
        conversationSummaries.map((conversation) => [conversation.id, conversation.messageCount]),
      );

      const apiTurns = turns
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((turn) => toApiAgentTurn(
          turn,
          turn.sandboxSessionId ? sandboxById.get(turn.sandboxSessionId) : null,
          turn.conversationId ? messageCountByConversationId.get(turn.conversationId) ?? 0 : 0,
        ))
        // Filter on the serialized projection so the result always agrees with
        // the coverage each turn reports to clients.
        .filter((turn) => !coverageFilter
          || (turn.usage != null && coverageFilter.has(turn.usage.cost.coverage)));

      return reply.send({ turns: apiTurns });
    },
  );

  app.post(
    '/:id/sandbox-sessions/:sandboxSessionId/suspend',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sandboxSessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sandboxSessionId } = request.params;

      if (!sessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      try {
        const session = await loadOwnedSandboxSession(db, agent.id, sandboxSessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Sandbox session not found', sandboxSessionId });
        }

        // Gate on the sandbox row, not the latest turn (ctx-jgb5): an idle
        // ACTIVE sandbox after a completed turn is suspendable. A mid-turn
        // suspend is rejected below via ActiveTurnSuspendError.
        if (session.status !== 'ACTIVE') {
          return reply.status(409).send({
            error: 'Sandbox session not active',
            status: session.status,
            sandboxSessionId,
          });
        }

        try {
          await sessionManager.suspendSession(sandboxSessionId, 'api_request');
        } catch (err) {
          if (err instanceof ActiveTurnSuspendError) {
            return reply.status(409).send({
              error: 'Sandbox session has active turn',
              status: 'ACTIVE',
              sandboxSessionId,
              turnId: err.turnId,
            });
          }
          const current = await db.getSandboxSession(sandboxSessionId);
          return reply.status(409).send({
            error: 'Sandbox session no longer active',
            status: current?.status ?? 'TERMINATED',
            sandboxSessionId,
          });
        }
        return reply.status(200).send({ sandboxSessionId, status: 'CHECKPOINTED' });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to suspend sandbox session', err));
      }
    },
  );

  app.post(
    '/:id/sandbox-sessions/:sandboxSessionId/restore',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string; sandboxSessionId: string };
        Querystring: { async?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sandboxSessionId } = request.params;
      const startAsync = request.query.async === 'true' || request.query.async === '1';

      if (!sessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      const session = await loadOwnedSandboxSession(db, agent.id, sandboxSessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Sandbox session not found', sandboxSessionId });
      }

      if (session.status !== 'CHECKPOINTED') {
        return reply.status(409).send({
          error: 'Sandbox session not checkpointed',
          status: session.status,
          sandboxSessionId,
        });
      }

      try {
        if (startAsync) {
          const restore = await sessionManager.restoreSession(
            sandboxSessionId,
            buildAgentDefinition(agent),
            agent.id,
            { background: true },
          );
          return reply.status(202).send(restore);
        }

        const restored = await sessionManager.restoreSession(sandboxSessionId, buildAgentDefinition(agent), agent.id);
        return reply.status(200).send({
          sandboxSessionId: restored.sessionId,
          status: restored.status,
          restoreAttempts: 0,
        });
      } catch (err) {
        if (err instanceof SandboxSessionNotFoundError) {
          return reply.status(404).send({ error: 'Sandbox session not found', sandboxSessionId });
        }
        if (err instanceof RestoreConflictError) {
          return reply.status(409).send({
            error: 'Sandbox session not checkpointed',
            status: err.status,
            sandboxSessionId,
          });
        }

        // ctx-2mm8: budget exhaustion is not a generic retryable failure — the
        // common cause is a full host, so surface it as 503 capacity, not a 502
        // that implies the checkpoint is broken.
        if (err instanceof SessionRestoreBudgetExhaustedError) {
          const current = await db.getSandboxSession(sandboxSessionId);
          return reply.status(503).send({
            error: 'Restore budget exhausted',
            code: 'restore_budget_exhausted',
            detail: err.message,
            status: current?.status ?? 'CHECKPOINTED',
            restoreAttempts: current?.restoreAttempts ?? null,
            sandboxSessionId,
          });
        }

        const classification = classifyRestoreFailure(err);
        const current = await db.getSandboxSession(sandboxSessionId);
        return reply.status(502).send({
          error: 'Restore failed',
          code: 'restore_failed',
          category: classification.category,
          detail: classification.message,
          status: current?.status ?? 'TERMINATED',
          restoreAttempts: current?.restoreAttempts ?? null,
          sandboxSessionId,
        });
      }
    },
  );

  app.post(
    '/:id/sandbox-sessions/:sandboxSessionId/kill',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sandboxSessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sandboxSessionId } = request.params;

      if (!sessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      try {
        const session = await loadOwnedSandboxSession(db, agent.id, sandboxSessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Sandbox session not found', sandboxSessionId });
        }

        await sessionManager.killSession(sandboxSessionId);
        return reply.status(204).send();
      } catch (err) {
        return reply.status(500).send(safeError('Failed to kill sandbox session', err));
      }
    },
  );
}
