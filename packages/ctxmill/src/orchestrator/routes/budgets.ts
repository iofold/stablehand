import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AgentBudgetStatusListResponseSchema,
  BudgetPolicyCreateInputSchema,
  BudgetPolicyListResponseSchema,
  BudgetPolicyPatchInputSchema,
  BudgetPolicySchema,
  BudgetSpendResponseSchema,
  type BudgetBucket,
  type BudgetPolicy,
  type BudgetUsageAggregate,
} from '@ctxmill/contracts';

import type { DatabaseRepository } from '../../database/repository.js';
import {
  metricStatuses,
  readBudgetDimensions,
  readDefaultTags,
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

interface BudgetSpendRow extends BudgetUsageAggregate {
  bucket?: string | null;
}

function invalidBody(reply: FastifyReply, issues: { path: PropertyKey[]; message: string }[]): FastifyReply {
  const issue = issues[0];
  const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return reply.status(400).send({
    error: `Invalid budget policy: ${path}${issue?.message ?? 'invalid request'}`,
  });
}

function canonicalPolicy(row: {
  id: string;
  name: string;
  enabled: boolean;
  doc: unknown;
  createdAt: number;
  updatedAt: number;
}): BudgetPolicy {
  return BudgetPolicySchema.parse(row);
}

function statusesFor(
  doc: BudgetPolicy,
  spend: BudgetUsageAggregate,
) {
  return metricStatuses(doc.doc.limits, spend, doc.doc.actions);
}

function ungroupedBucket(): BudgetBucket {
  return { kind: 'all' };
}

function groupedBucket(key: string, value: string | null): BudgetBucket {
  return value === null
    ? { kind: 'untagged', key }
    : { kind: 'tag', key, value };
}

function emptySpend(): BudgetUsageAggregate {
  return {
    totalTokens: 0,
    costUsd: 0,
    turns: 0,
    tokenReportedTurnCount: 0,
    costReportedTurnCount: 0,
  };
}

function statusRank(state: 'ok' | 'warning' | 'blocked'): number {
  return state === 'blocked' ? 2 : state === 'warning' ? 1 : 0;
}

export async function budgetRoutes(
  app: FastifyInstance,
  opts: BudgetRouteOptions,
): Promise<void> {
  const { db } = opts;

  app.get('/', async () => {
    return BudgetPolicyListResponseSchema.parse({
      policies: (await db.listBudgetPolicies()).map(canonicalPolicy),
    });
  });

  app.get('/agents/status', async () => {
    const now = Date.now();
    const policies = (await db.listBudgetPolicies())
      .map(canonicalPolicy)
      .filter((policy) => policy.enabled);
    const agents = await db.listAgents();
    const statuses = [];

    for (const agent of agents) {
      const metadata = agent.metadata as Record<string, unknown> | null;
      const knownTags: Record<string, string> = {
        ...readDefaultTags(metadata),
        agent: agent.id,
        harness: agent.harness,
      };
      const matches = [];
      let state: 'ok' | 'warning' | 'blocked' = 'ok';

      for (const policy of policies) {
        const conflictsKnownTag = Object.entries(policy.doc.selector)
          .some(([key, value]) => (
            knownTags[key] !== undefined && knownTags[key] !== value
          ));
        if (conflictsKnownTag) continue;
        const selector = {
          ...policy.doc.selector,
          agent: agent.id,
        };
        const since = windowStartMs(policy.doc.window, now);
        const buckets: Array<{
          bucket: BudgetBucket;
          spend: BudgetUsageAggregate;
        }> = [];

        if (!policy.doc.groupBy) {
          buckets.push({
            bucket: ungroupedBucket(),
            spend: await db.getBudgetSpend(selector, since) as BudgetUsageAggregate,
          });
        } else {
          const observed = await db.getBudgetSpendBuckets(
            selector,
            since,
            policy.doc.groupBy,
          ) as BudgetSpendRow[];
          const byValue = new Map<string, {
            bucket: BudgetBucket;
            spend: BudgetUsageAggregate;
          }>();
          for (const row of observed) {
            const key = row.bucket === null ? 'untagged' : `tag:${row.bucket}`;
            byValue.set(key, {
              bucket: groupedBucket(policy.doc.groupBy, row.bucket ?? null),
              spend: {
                totalTokens: row.totalTokens,
                costUsd: row.costUsd,
                turns: row.turns,
                tokenReportedTurnCount: row.tokenReportedTurnCount,
                costReportedTurnCount: row.costReportedTurnCount,
              },
            });
          }
          for (const value of readBudgetDimensions(metadata)[policy.doc.groupBy] ?? []) {
            const key = `tag:${value}`;
            if (!byValue.has(key)) {
              byValue.set(key, {
                bucket: groupedBucket(policy.doc.groupBy, value),
                spend: emptySpend(),
              });
            }
          }
          if (byValue.size === 0) {
            byValue.set('untagged', {
              bucket: groupedBucket(policy.doc.groupBy, null),
              spend: emptySpend(),
            });
          }
          buckets.push(...byValue.values());
        }

        for (const bucket of buckets) {
          const metricStatus = statusesFor(policy, bucket.spend);
          for (const metric of metricStatus) {
            if (statusRank(metric.state) > statusRank(state)) {
              state = metric.state;
            }
          }
          matches.push({
            policyId: policy.id,
            policyName: policy.name,
            bucket: bucket.bucket,
            statuses: metricStatus,
          });
        }
      }

      statuses.push({
        agentId: agent.id,
        state,
        evaluatedAt: now,
        matches,
      });
    }

    return AgentBudgetStatusListResponseSchema.parse({ statuses });
  });

  app.post('/', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const parsed = BudgetPolicyCreateInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error.issues);
    const input = parsed.data;
    const created = await db.createBudgetPolicy({
      name: input.name,
      enabled: input.enabled,
      doc: input.doc,
    });
    return reply.status(201).send(canonicalPolicy(created));
  });

  app.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const policy = await db.getBudgetPolicy(request.params.id);
    if (!policy) return reply.status(404).send({ error: 'Budget policy not found' });
    return canonicalPolicy(policy);
  });

  app.patch('/:id', async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply) => {
    const parsed = BudgetPolicyPatchInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error.issues);
    const updated = await db.updateBudgetPolicy(request.params.id, parsed.data);
    if (!updated) return reply.status(404).send({ error: 'Budget policy not found' });
    return canonicalPolicy(updated);
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

    const canonical = canonicalPolicy(policy);
    const doc = canonical.doc;
    const now = Date.now();
    const since = windowStartMs(doc.window, now);

    if (!doc.groupBy) {
      const spend = await db.getBudgetSpend(doc.selector, since) as BudgetUsageAggregate;
      return BudgetSpendResponseSchema.parse({
        policyId: policy.id,
        window: doc.window,
        windowStart: since,
        buckets: [{
          bucket: ungroupedBucket(),
          spend,
          statuses: statusesFor(canonical, spend),
        }],
      });
    }

    const observed = await db.getBudgetSpendBuckets(
      doc.selector,
      since,
      doc.groupBy,
    ) as BudgetSpendRow[];
    const buckets = new Map<string, { bucket: BudgetBucket; spend: BudgetUsageAggregate }>();
    for (const row of observed) {
      const identity = groupedBucket(doc.groupBy, row.bucket ?? null);
      const mapKey = row.bucket === null ? 'untagged' : `tag:${row.bucket}`;
      buckets.set(mapKey, {
        bucket: identity,
        spend: {
          totalTokens: row.totalTokens,
          costUsd: row.costUsd,
          turns: row.turns,
          tokenReportedTurnCount: row.tokenReportedTurnCount,
          costReportedTurnCount: row.costReportedTurnCount,
        },
      });
    }

    // Pre-provisioned values from every agent definition show up even at zero.
    const agents = await db.listAgents();
    for (const agent of agents) {
      const dimensions = readBudgetDimensions(agent.metadata as Record<string, unknown> | null);
      for (const value of dimensions[doc.groupBy] ?? []) {
        const mapKey = `tag:${value}`;
        if (!buckets.has(mapKey)) {
          buckets.set(mapKey, {
            bucket: groupedBucket(doc.groupBy, value),
            spend: {
              totalTokens: 0,
              costUsd: 0,
              turns: 0,
              tokenReportedTurnCount: 0,
              costReportedTurnCount: 0,
            },
          });
        }
      }
    }

    return BudgetSpendResponseSchema.parse({
      policyId: policy.id,
      window: doc.window,
      windowStart: since,
      buckets: [...buckets.values()]
        .sort((a, b) => (b.spend.totalTokens ?? -1) - (a.spend.totalTokens ?? -1))
        .map((entry) => ({
          ...entry,
          statuses: statusesFor(canonical, entry.spend),
        })),
    });
  });
}
