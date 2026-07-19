import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DatabaseRepository } from '../../database/repository.js';
import {
  UNTAGGED_BUCKET,
  metricStatuses,
  parseBudgetPolicyDoc,
  readBudgetDimensions,
  windowStartMs,
} from '../budgets.js';

export interface BudgetRouteOptions {
  db: Pick<
    DatabaseRepository,
    | 'listBudgetPolicies'
    | 'getBudgetPolicy'
    | 'createBudgetPolicy'
    | 'updateBudgetPolicy'
    | 'deleteBudgetPolicy'
    | 'getBudgetSpend'
    | 'getBudgetSpendBuckets'
    | 'listAgents'
  >;
}

interface PolicyBody {
  name?: unknown;
  enabled?: unknown;
  doc?: unknown;
}

function validateBody(body: PolicyBody, reply: FastifyReply, requireAll: boolean): { name?: string; enabled?: boolean; doc?: Record<string, unknown> } | null {
  const result: { name?: string; enabled?: boolean; doc?: Record<string, unknown> } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      reply.status(400).send({ error: 'name must be a non-empty string' });
      return null;
    }
    result.name = body.name.trim();
  } else if (requireAll) {
    reply.status(400).send({ error: 'name is required' });
    return null;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      reply.status(400).send({ error: 'enabled must be a boolean' });
      return null;
    }
    result.enabled = body.enabled;
  }

  if (body.doc !== undefined) {
    const parsed = parseBudgetPolicyDoc(body.doc);
    if ('error' in parsed) {
      reply.status(400).send({ error: `Invalid policy doc: ${parsed.error}` });
      return null;
    }
    result.doc = body.doc as Record<string, unknown>;
  } else if (requireAll) {
    reply.status(400).send({ error: 'doc is required' });
    return null;
  }

  return result;
}

export async function budgetRoutes(
  app: FastifyInstance,
  opts: BudgetRouteOptions,
): Promise<void> {
  const { db } = opts;

  app.get('/', async () => {
    return { policies: await db.listBudgetPolicies() };
  });

  app.post('/', async (request: FastifyRequest<{ Body: PolicyBody }>, reply) => {
    const body = request.body ?? {};
    const validated = validateBody(body, reply, true);
    if (!validated) return reply;
    const created = await db.createBudgetPolicy({
      name: validated.name!,
      doc: validated.doc!,
      ...(validated.enabled !== undefined ? { enabled: validated.enabled } : {}),
    });
    return reply.status(201).send(created);
  });

  app.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const policy = await db.getBudgetPolicy(request.params.id);
    if (!policy) return reply.status(404).send({ error: 'Budget policy not found' });
    return policy;
  });

  app.put('/:id', async (request: FastifyRequest<{ Params: { id: string }; Body: PolicyBody }>, reply) => {
    const validated = validateBody(request.body ?? {}, reply, false);
    if (!validated) return reply;
    if (Object.keys(validated).length === 0) {
      return reply.status(400).send({ error: 'Provide at least one of: name, enabled, doc' });
    }
    const updated = await db.updateBudgetPolicy(request.params.id, validated);
    if (!updated) return reply.status(404).send({ error: 'Budget policy not found' });
    return updated;
  });

  app.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const deleted = await db.deleteBudgetPolicy(request.params.id);
    if (!deleted) return reply.status(404).send({ error: 'Budget policy not found' });
    return reply.status(204).send();
  });

  /**
   * Per-bucket spend for one policy. Buckets are the union of observed
   * spend buckets and the values pre-provisioned in agent definitions
   * (metadata.budgetDimensions), so a provisioned-but-unused user shows a
   * zero meter instead of being invisible.
   */
  app.get('/:id/spend', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const policy = await db.getBudgetPolicy(request.params.id);
    if (!policy) return reply.status(404).send({ error: 'Budget policy not found' });

    const parsed = parseBudgetPolicyDoc(policy.doc);
    if ('error' in parsed) {
      return reply.status(422).send({ error: `Policy doc is invalid: ${parsed.error}` });
    }
    const doc = parsed.doc;
    const now = Date.now();
    const since = windowStartMs(doc.window, now);

    if (!doc.groupBy) {
      const spend = await db.getBudgetSpend(doc.selector, since);
      return {
        policyId: policy.id,
        window: doc.window,
        windowStart: since,
        buckets: [{ bucket: null, spend, statuses: metricStatuses(doc.limits, spend) }],
      };
    }

    const observed = await db.getBudgetSpendBuckets(doc.selector, since, doc.groupBy);
    const buckets = new Map<string, { bucket: string; spend: { totalTokens: number; costUsd: number; turns: number } }>();
    for (const row of observed) {
      const label = row.bucket ?? UNTAGGED_BUCKET;
      buckets.set(label, {
        bucket: label,
        spend: { totalTokens: row.totalTokens, costUsd: row.costUsd, turns: row.turns },
      });
    }

    // Pre-provisioned values from every agent definition show up even at zero.
    const agents = await db.listAgents();
    for (const agent of agents) {
      const dimensions = readBudgetDimensions(agent.metadata as Record<string, unknown> | null);
      for (const value of dimensions[doc.groupBy] ?? []) {
        if (!buckets.has(value)) {
          buckets.set(value, { bucket: value, spend: { totalTokens: 0, costUsd: 0, turns: 0 } });
        }
      }
    }

    return {
      policyId: policy.id,
      window: doc.window,
      windowStart: since,
      buckets: [...buckets.values()]
        .sort((a, b) => b.spend.totalTokens - a.spend.totalTokens)
        .map((entry) => ({ ...entry, statuses: metricStatuses(doc.limits, entry.spend) })),
    };
  });
}
