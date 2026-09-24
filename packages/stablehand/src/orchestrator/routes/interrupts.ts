import type { FastifyInstance, FastifyReply } from 'fastify';

import type { DatabaseRepository } from '../../database/repository.js';

export interface InterruptRouteOptions {
  db: DatabaseRepository;
}

const INTERRUPT_FILTER_STATUSES = new Set(['pending', 'resolved', 'all']);

function badRequest(reply: FastifyReply, error: string) {
  return reply.status(400).send({ error });
}

/** Durable cross-agent HITL inbox. In-memory interrupts are intentionally excluded. */
export async function interruptRoutes(
  app: FastifyInstance,
  options: InterruptRouteOptions,
): Promise<void> {
  app.get('/', { config: { capability: 'interrupts:read' } }, async (request, reply) => {
    const query = request.query as {
      status?: string;
      agentId?: string;
      limit?: string;
      before?: string;
    };
    const status = query.status ?? 'pending';
    if (!INTERRUPT_FILTER_STATUSES.has(status)) {
      return badRequest(reply, 'status must be pending, resolved, or all');
    }

    const requestedLimit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
      return badRequest(reply, 'limit must be a positive integer');
    }
    const limit = Math.min(requestedLimit, 200);

    const before = query.before === undefined ? undefined : Number(query.before);
    if (before !== undefined && (!Number.isInteger(before) || before < 0)) {
      return badRequest(reply, 'before must be a non-negative epoch millisecond value');
    }
    if (query.agentId !== undefined && query.agentId.trim().length === 0) {
      return badRequest(reply, 'agentId must be a non-empty string');
    }
    const agentId = query.agentId?.trim();

    const page = await options.db.listInterrupts({
      status: status as 'pending' | 'resolved' | 'all',
      agentId,
      limit,
      before,
    });

    return {
      interrupts: page.interrupts.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        turnId: row.turnId,
        sandboxSessionId: row.sandboxSessionId,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        args: row.args,
        status: row.status,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        resolvedAt: row.resolvedAt,
        resolvedAction: row.resolvedAction,
      })),
      ...(page.hasMore && page.interrupts.length > 0
        ? { nextBefore: page.interrupts[page.interrupts.length - 1]!.createdAt }
        : {}),
    };
  });
}
