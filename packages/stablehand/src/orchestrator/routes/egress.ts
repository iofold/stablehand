import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  EgressLeaseRequestSchema,
  EgressLeaseResponseSchema,
  type EgressLeaseResponse,
} from '@stablehand/contracts';

import type { DatabaseRepository } from '../../database/repository.js';
import { parseStoredHarnessConfig, resolveAgentEgress } from '../agent-definition.js';
import {
  EGRESS_LEASE_TTL_SECONDS,
  deriveRuntimeEgressRules,
  resolveEgressLeaseSecret,
  verifyEgressLeaseToken,
} from '../egress-lease.js';

export interface EgressRouteOptions {
  db: Pick<DatabaseRepository, 'getAgent' | 'getSandboxSession'>;
  /** Defaults to the process environment; tests pass their own. */
  env?: Readonly<Record<string, string | undefined>>;
}

const INVALID_LEASE = { error: 'Invalid egress lease', code: 'invalid_lease' } as const;

/**
 * Sandbox egress lease check (ctx-3aef), called by the egress proxy for every lease it has not
 * seen recently. Public in the API-token sense: the lease itself is the credential, and the
 * answer is only the session's own egress setting. A token that was not minted for the session
 * is refused before anything is looked up.
 */
export async function egressRoutes(app: FastifyInstance, opts: EgressRouteOptions): Promise<void> {
  const env = opts.env ?? process.env;

  // POST /api/egress/lease
  app.post(
    '/lease',
    { config: { public: true } },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const parsed = EgressLeaseRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid egress lease request', code: 'invalid_lease_request' });
      }
      const { sessionId, token } = parsed.data;
      const lease = verifyEgressLeaseToken(sessionId, token, resolveEgressLeaseSecret(env));
      if (!lease) {
        return reply.status(401).send(INVALID_LEASE);
      }

      // A fresh session has no record until its container is up; the signature is enough then.
      const session = await opts.db.getSandboxSession(sessionId);
      if (session && session.agentId !== lease.agentId) {
        return reply.status(401).send(INVALID_LEASE);
      }
      if (session?.status === 'TERMINATED') {
        return reply.status(410).send({ error: 'The sandbox session has ended', code: 'session_ended' });
      }

      const agent = await opts.db.getAgent(lease.agentId);
      if (!agent) {
        return reply.status(404).send({ error: 'The sandbox session\'s agent no longer exists', code: 'agent_not_found' });
      }

      const response: EgressLeaseResponse = {
        sessionId,
        agentId: lease.agentId,
        egress: resolveAgentEgress(agent) ?? { mode: 'default' },
        runtimeRules: deriveRuntimeEgressRules(parseStoredHarnessConfig(agent.harnessConfig), env),
        ttlSeconds: EGRESS_LEASE_TTL_SECONDS,
      };
      return reply.send(EgressLeaseResponseSchema.parse(response));
    },
  );
}
