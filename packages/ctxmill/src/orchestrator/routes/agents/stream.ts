import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AgentSubRouteOptions } from './types.js';

export async function streamRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, sse, loadAgent } = opts;

  app.get(
    '/:id/stream',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.write(
        `data: ${JSON.stringify({ type: 'CONNECTED', agentId: id, timestamp: Date.now() })}\n\n`,
      );

      const [sandboxSessions, turns] = await Promise.all([
        db.getSandboxSessionsByAgent(id),
        db.getTurnsByAgent(id),
      ]);
      const activeSessions = sandboxSessions.filter(
        (s) => s.status === 'ACTIVE' || s.status === 'RESTORING',
      );
      const activeTurnBySandboxSessionId = new Map<string, string>();

      const candidateTurns = turns
        .filter((turn) => turn.completedAt == null && typeof turn.sessionId === 'string' && turn.sessionId.length > 0)
        .sort((a, b) => b.startedAt - a.startedAt);

      for (const turn of candidateTurns) {
        if (!turn.sessionId || activeTurnBySandboxSessionId.has(turn.sessionId)) {
          continue;
        }
        activeTurnBySandboxSessionId.set(turn.sessionId, turn.id);
      }

      for (const session of activeSessions) {
        reply.raw.write(
          `data: ${JSON.stringify({
            type: 'CUSTOM',
            subtype: 'state_snapshot',
            agentId: id,
            conversationId: session.conversationId,
            sessionId: session.id,
            turnId: activeTurnBySandboxSessionId.get(session.id),
            status: session.status,
            harnessName: session.harnessName,
            containerName: session.containerName,
            timestamp: Date.now(),
          })}\n\n`,
        );
      }

      const lastEventId = request.headers['last-event-id'] as string | undefined;
      sse.subscribe(id, reply, lastEventId);
    },
  );
}
