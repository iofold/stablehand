import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ActiveLifecycleRouteOptions } from './types.js';

function isActiveStatus(status: string | undefined): boolean {
  return status === undefined || status === 'active';
}

function publicSandboxSession<T extends Record<string, unknown>>(
  session: T,
): Omit<T, 'runtimeDefinitionHash'> {
  return Object.fromEntries(
    Object.entries(session).filter(
      ([key]) => key !== 'runtimeDefinitionHash',
    ),
  ) as Omit<T, 'runtimeDefinitionHash'>;
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
    return reply.send(activeConversations);
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
      activeSandboxSessions.map((session) =>
        publicSandboxSession(session),
      ),
    );
  });
}
