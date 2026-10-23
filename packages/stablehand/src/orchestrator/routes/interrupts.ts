import type { FastifyInstance, FastifyReply } from 'fastify';
import { InterruptRecordDetailSchema } from '@stablehand/contracts';

import type { DatabaseRepository, InterruptRow } from '../../database/repository.js';

export interface InterruptRouteOptions {
  db: DatabaseRepository;
}

const INTERRUPT_FILTER_STATUSES = new Set(['pending', 'resolved', 'all']);

function badRequest(reply: FastifyReply, error: string) {
  return reply.status(400).send({ error });
}

/** Durable interrupt record; `resolvedBy`/`resolvedReason` say who resolved it and why (ctx-lhr0). */
function toInterruptRecord(row: InterruptRow) {
  return {
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
    resolvedBy: row.resolvedBy ?? null,
    resolvedReason: row.resolvedReason ?? null,
  };
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
      interrupts: page.interrupts.map(toInterruptRecord),
      ...(page.hasMore && page.interrupts.length > 0
        ? { nextBefore: page.interrupts[page.interrupts.length - 1]!.createdAt }
        : {}),
    };
  });

  // GET /api/interrupts/:id — one interrupt, including the `data` sent with
  // its resolution, which lists leave out because it can be large.
  app.get('/:id', { config: { capability: 'interrupts:read' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await options.db.getInterruptById(id);
    // A key bound to one agent cannot see other agents' approvals (no oracle).
    const boundAgentId = request.apiPrincipal?.agentId ?? null;
    if (!row || (boundAgentId && row.agentId !== boundAgentId)) {
      return reply.status(404).send({ error: 'Interrupt not found', interruptId: id });
    }
    return InterruptRecordDetailSchema.parse({
      ...toInterruptRecord(row),
      resolvedData: row.resolvedData ?? null,
    });
  });
}
