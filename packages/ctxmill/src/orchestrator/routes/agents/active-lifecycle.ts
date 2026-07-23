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
    return reply.send(
      activeSandboxSessions.map((session) =>
        publicSandboxSession(session),
      ),
    );
  });
}
