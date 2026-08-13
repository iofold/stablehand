import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { parseSeqId, writeSseHead, type StreamAuthorizationCheck } from '../../sse.js';
import type { AgentSubRouteOptions } from './types.js';

export function resolveStreamCursor(
  lastEventId: string | undefined,
  eventCursor: string | undefined,
): { afterSeq: number | null } | { error: string } {
  const explicitSeq = parseSeqId(eventCursor);
  if (eventCursor !== undefined && explicitSeq === null) {
    return { error: 'Invalid event cursor' };
  }
  const resumedSeq = parseSeqId(lastEventId);
  return { afterSeq: resumedSeq ?? explicitSeq };
}

export async function streamRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, sse, loadAgent, canonicalLog } = opts;

  app.get(
    '/:id/stream',
    {
      preHandler: [loadAgent],
      config: { allowTokenQuery: true, capability: 'agents:read' },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { cursor?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const resolvedCursor = resolveStreamCursor(
        request.headers['last-event-id'] as string | undefined,
        request.query.cursor,
      );
      if ('error' in resolvedCursor) {
        return reply.status(400).send({ error: resolvedCursor.error });
      }

      writeSseHead(reply);

      if (!canonicalLog) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'canonical event log not configured', timestamp: Date.now() })}\n\n`);
        reply.raw.end();
        return;
      }

      await serveDurableStream({
        db,
        sse,
        canonicalLog,
        agentId: id,
        afterSeq: resolvedCursor.afterSeq,
        reply,
        authorizationCheck: request.revalidateApiPrincipal ?? undefined,
      });
    },
  );
}

/**
 * A2 durable stream (ADR-015): snapshot from open turns (replacing the
 * all-turns activeTurn heuristic), replay from the durable log when the
 * client presents a seq-format Last-Event-ID (non-seq ids → fresh connect,
 * snapshot only — pilot's proxy forwards old-format ids across the cutover),
 * then attach to the database-backed live tail. Replay is paginated, local
 * canonical broadcasts wake the tail, and periodic watermark checks observe
 * commits made by other orchestrator processes.
 */
async function serveDurableStream(input: {
  db: AgentSubRouteOptions['db'];
  sse: AgentSubRouteOptions['sse'];
  canonicalLog: NonNullable<AgentSubRouteOptions['canonicalLog']>;
  agentId: string;
  afterSeq: number | null;
  reply: FastifyReply;
  authorizationCheck?: StreamAuthorizationCheck;
}): Promise<void> {
  const { db, sse, canonicalLog, agentId, afterSeq, reply, authorizationCheck } = input;

  const [sandboxSessions, openTurns, latestSeq] = await Promise.all([
    db.getSandboxSessionsByAgent(agentId),
    db.getActiveTurnsForAgent(agentId),
    db.getLatestEventSeq(agentId),
  ]);

  reply.raw.write(
    `data: ${JSON.stringify({ type: 'CONNECTED', agentId, latestSeq, timestamp: Date.now() })}\n\n`,
  );

  const activeTurnBySandboxSessionId = new Map<string, string>();
  for (const turn of [...openTurns].sort((a, b) => b.startedAt - a.startedAt)) {
    if (turn.sandboxSessionId && !activeTurnBySandboxSessionId.has(turn.sandboxSessionId)) {
      activeTurnBySandboxSessionId.set(turn.sandboxSessionId, turn.id);
    }
  }

  for (const session of sandboxSessions.filter((s) => s.status === 'ACTIVE' || s.status === 'RESTORING')) {
    reply.raw.write(
      `data: ${JSON.stringify({
        type: 'CUSTOM',
        name: 'ctxmill.sandbox_session.snapshot',
        agentId,
        conversationId: session.conversationId,
        sandboxSessionId: session.id,
        activeTurnId: activeTurnBySandboxSessionId.get(session.id) ?? null,
        status: session.status,
        harnessName: session.harnessName,
        containerName: session.containerName,
        timestamp: Date.now(),
      })}\n\n`,
    );
  }

  await sse.subscribeDurable(
    agentId,
    reply,
    afterSeq ?? latestSeq,
    latestSeq,
    {
      getWatermark: () => db.getLatestEventSeq(agentId),
      getPage: async (pageAfterSeq, throughSeq, limit) => {
        const frames = await canonicalLog.replaySince(agentId, pageAfterSeq, {
          channels: ['run'],
          throughSeq,
          limit,
        });
        return frames.map((frame) => ({
          seq: frame.seq,
          event: frame.body,
        }));
      },
    },
    authorizationCheck,
  );
}
