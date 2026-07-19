import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ActiveLifecycleRouteOptions } from './types.js';

function isActiveStatus(status: string | undefined): boolean {
  return status === undefined || status === 'active';
}

export async function activeConversationRoutes(
  app: FastifyInstance,
  opts: ActiveLifecycleRouteOptions,
): Promise<void> {
  const { db } = opts;

  app.get('/', async (
    request: FastifyRequest<{ Querystring: { status?: string } }>,
    reply: FastifyReply,
  ) => {
    if (!isActiveStatus(request.query.status)) {
      return reply.status(400).send({ error: 'Only status=active is supported' });
    }
    const activeConversations = await db.getActiveConversationSummaries();
    return reply.send(activeConversations);
  });
}

export async function activeSandboxSessionRoutes(
  app: FastifyInstance,
  opts: ActiveLifecycleRouteOptions,
): Promise<void> {
  const { db, lifecyclePolicy, sessionManager } = opts;

  app.get('/', async (
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
    return reply.send(activeSandboxSessions);
  });
}
