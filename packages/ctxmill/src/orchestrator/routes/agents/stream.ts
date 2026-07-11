import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { formatSeqId, parseSeqId, writeSseHead } from '../../sse.js';
import type { AgentSubRouteOptions } from './types.js';

export async function streamRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, sse, loadAgent, canonicalLog } = opts;

  app.get(
    '/:id/stream',
    { preHandler: [loadAgent], config: { allowTokenQuery: true } },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      writeSseHead(reply);

      if (!canonicalLog) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'canonical event log not configured', timestamp: Date.now() })}\n\n`);
        reply.raw.end();
        return;
      }

      await serveDurableStream({ db, sse, canonicalLog, agentId: id, request, reply });
    },
  );
}

/**
 * A2 durable stream (ADR-015): snapshot from open turns (replacing the
 * all-turns activeTurn heuristic), replay from the durable log when the
 * client presents a seq-format Last-Event-ID (non-seq ids → fresh connect,
 * snapshot only — pilot's proxy forwards old-format ids across the cutover),
 * then attach to the live tail with the ring-buffer dedupe closing the
 * replay→live handoff race. Replay works past any in-memory cap and across
 * restarts (ctx-16s).
 */
async function serveDurableStream(input: {
  db: AgentSubRouteOptions['db'];
  sse: AgentSubRouteOptions['sse'];
  canonicalLog: NonNullable<AgentSubRouteOptions['canonicalLog']>;
  agentId: string;
  request: FastifyRequest;
  reply: FastifyReply;
}): Promise<void> {
  const { db, sse, canonicalLog, agentId, request, reply } = input;

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
    if (turn.sessionId && !activeTurnBySandboxSessionId.has(turn.sessionId)) {
      activeTurnBySandboxSessionId.set(turn.sessionId, turn.id);
    }
  }

  for (const session of sandboxSessions.filter((s) => s.status === 'ACTIVE' || s.status === 'RESTORING')) {
    reply.raw.write(
      `data: ${JSON.stringify({
        type: 'CUSTOM',
        subtype: 'state_snapshot',
        agentId,
        conversationId: session.conversationId,
        sessionId: session.id,
        activeTurnId: activeTurnBySandboxSessionId.get(session.id) ?? null,
        status: session.status,
        harnessName: session.harnessName,
        containerName: session.containerName,
        timestamp: Date.now(),
      })}\n\n`,
    );
  }

  const lastEventId = request.headers['last-event-id'] as string | undefined;
  const afterSeq = parseSeqId(lastEventId);
  const replayedSeqs = new Set<number>();

  if (afterSeq !== null) {
    const frames = await canonicalLog.replaySince(agentId, afterSeq, { channels: ['run'] });
    try {
      for (const frame of frames) {
        replayedSeqs.add(frame.seq);
        reply.raw.write(`id: ${formatSeqId(frame.seq)}\ndata: ${JSON.stringify(frame.body)}\n\n`);
      }
    } catch (writeErr) {
      request.log.debug({ err: writeErr }, 'durable replay write failed');
      return;
    }
  }

  sse.subscribeDurable(agentId, reply, afterSeq ?? latestSeq, replayedSeqs);
}
