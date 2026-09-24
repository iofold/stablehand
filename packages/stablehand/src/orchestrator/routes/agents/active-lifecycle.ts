import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ActiveConversationListResponseSchema,
  SandboxSessionListResponseSchema,
  SandboxSessionSchema,
} from '@stablehand/contracts';

import type { SandboxSessionRow } from '../../../database/repository.js';
import type { ActiveLifecycleRouteOptions } from './types.js';

function isActiveStatus(status: string | undefined): boolean {
  return status === undefined || status === 'active';
}

/**
 * ctx-sf2n: explicit contract projection. The previous strip-one-key filter
 * leaked every future DB column into the response (checkpointFailures /
 * lastCheckpointError broke the strict-parsing UI and SDK the moment a
 * session existed). Picking exactly the contract fields makes new columns
 * private by default; the parse at the reply site keeps the route honest.
 */
function toApiSandboxSession(session: SandboxSessionRow): z.input<typeof SandboxSessionSchema> {
  return {
    id: session.id,
    conversationId: session.conversationId,
    agentId: session.agentId,
    containerName: session.containerName,
    containerId: session.containerId,
    status: session.status,
    harnessName: session.harnessName,
    checkpointRef: session.checkpointRef,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    restoreAttempts: session.restoreAttempts,
    lastRestoreError: session.lastRestoreError,
    checkpointFailures: session.checkpointFailures,
    lastCheckpointError: session.lastCheckpointError,
    restoreOwnerId: session.restoreOwnerId,
    restoreFenceToken: session.restoreFenceToken,
    restoreLeaseExpiresAt: session.restoreLeaseExpiresAt,
  };
}

export async function activeConversationRoutes(
  app: FastifyInstance,
  opts: ActiveLifecycleRouteOptions,
): Promise<void> {
  const { db } = opts;

  app.get('/', { config: { capability: 'agents:read' } }, async (
    request: FastifyRequest<{ Querystring: { status?: string } }>,
    reply: FastifyReply,
  ) => {
    if (!isActiveStatus(request.query.status)) {
      return reply.status(400).send({ error: 'Only status=active is supported' });
    }
    const activeConversations = await db.getActiveConversationSummaries();
    // ctx-iqzy R4: parse at the reply site keeps the route on-contract.
    return reply.send(ActiveConversationListResponseSchema.parse(activeConversations));
  });

  // Cross-agent recent conversations, newest activity first. One request for
  // the dashboard instead of a per-agent summary fan-out; `before` (epoch ms
  // updatedAt cursor) pages older history.
  app.get('/recent', { config: { capability: 'agents:read' } }, async (
    request: FastifyRequest<{
      Querystring: { limit?: string; before?: string; agentId?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const limitRaw = request.query.limit;
    const limit = limitRaw === undefined ? 25 : Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return reply.status(400).send({ error: 'limit must be an integer between 1 and 100' });
    }
    const beforeRaw = request.query.before;
    const before = beforeRaw === undefined ? undefined : Number(beforeRaw);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
      return reply.status(400).send({ error: 'before must be a nonnegative epoch-milliseconds integer' });
    }
    const conversations = await db.getRecentConversationSummaries({
      limit,
      ...(before !== undefined ? { beforeUpdatedAtMs: before } : {}),
      ...(request.query.agentId ? { agentId: request.query.agentId } : {}),
    });
    return reply.send({ conversations });
  });
}

export async function activeSandboxSessionRoutes(
  app: FastifyInstance,
  opts: ActiveLifecycleRouteOptions,
): Promise<void> {
  const { db, lifecyclePolicy, sessionManager } = opts;

  app.get('/', { config: { capability: 'agents:read' } }, async (
    request: FastifyRequest<{ Querystring: { status?: string } }>,
    reply: FastifyReply,
  ) => {
    if (!isActiveStatus(request.query.status)) {
      return reply.status(400).send({ error: 'Only status=active is supported' });
    }
    const activeSandboxSessions = lifecyclePolicy
      ? await lifecyclePolicy.getActiveSandboxSessionsForReadback({
        shouldDefer: (session) => Boolean(sessionManager?.getActiveTurnId(session.id)),
      })
      : await db.getActiveSandboxSessions();
    return reply.send(
      SandboxSessionListResponseSchema.parse(
        activeSandboxSessions.map((session) => toApiSandboxSession(session)),
      ),
    );
  });
}
