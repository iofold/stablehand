import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ModelGatewayCampaignKeyCreateInputSchema,
  ModelGatewayCampaignKeyCreatedSchema,
  ModelGatewayCampaignKeyListResponseSchema,
  ModelGatewayCampaignKeySchema,
  ModelGatewayQuarantineSchema,
  ModelGatewayStatusSchema,
} from '@stablehand/contracts';

import type { DatabaseRepository } from '../../database/repository.js';
import {
  CampaignKeyError,
  toPublicCampaignKey,
  type CampaignGatewayKeyService,
} from '../../cost-control/campaign-gateway-keys.js';

type ModelGatewayStatusStore = Pick<
  DatabaseRepository,
  | 'getModelGatewayReconciliationState'
  | 'getModelGatewayReconciliationMetrics'
  | 'getModelGatewayQuarantineSummary'
  | 'getGatewayTurnsAwaitingReconciliation'
>;

type CampaignKeyReadStore = Pick<
  DatabaseRepository,
  | 'listModelGatewayCampaignKeys'
  | 'getModelGatewayCampaignKey'
  | 'getModelGatewayCampaignKeySpend'
>;

export type ModelGatewayStatusConfig =
  | { enabled: false }
  | { enabled: true; profile: string; revision: string };

interface ModelGatewayRouteOptions {
  db: ModelGatewayStatusStore & CampaignKeyReadStore;
  config: ModelGatewayStatusConfig;
  /**
   * Mints and revokes campaign keys (ctx-hmm3). Absent when the gateway or
   * its admin key is not configured; listing still works from the database.
   */
  campaignKeys?: Pick<CampaignGatewayKeyService, 'create' | 'revoke'>;
  now?: () => number;
  degradedLagMs?: number;
  awaitingGraceMs?: number;
}

const DEFAULT_DEGRADED_LAG_MS = 2 * 60_000;
// A completed gateway turn should be priced within one settlement cycle;
// past this age an unreconciled turn means a lost spend row or dead ingestion.
const DEFAULT_AWAITING_GRACE_MS = 15 * 60_000;
const DEFAULT_QUARANTINE_RECENT_MS = 24 * 60 * 60_000;
const DEFAULT_QUARANTINE_LIMIT = 20;
const MAX_QUARANTINE_LIMIT = 100;

/**
 * Compact ingestion-health summary shared by /api/model-gateway/status and
 * the /health gateway arm (ctx-iou3): a stalled spend pipeline should show
 * up where operators already look, not only on a dedicated status page.
 */
export async function summarizeModelGatewayHealth(
  db: Pick<
    ModelGatewayStatusStore,
    'getModelGatewayReconciliationState' | 'getGatewayTurnsAwaitingReconciliation'
  >,
  config: ModelGatewayStatusConfig,
  options?: { now?: () => number; degradedLagMs?: number; awaitingGraceMs?: number },
): Promise<{
  enabled: boolean;
  state: 'disabled' | 'initializing' | 'healthy' | 'degraded';
  lagMs: number | null;
  awaitingTurns: number;
  lastError: string | null;
}> {
  const now = (options?.now ?? Date.now)();
  const awaitingGraceMs = options?.awaitingGraceMs ?? DEFAULT_AWAITING_GRACE_MS;
  if (!config.enabled) {
    const awaiting = await db.getGatewayTurnsAwaitingReconciliation();
    return {
      enabled: false,
      state: awaiting.count > 0 ? 'degraded' : 'disabled',
      lagMs: null,
      awaitingTurns: awaiting.count,
      lastError: awaiting.count > 0
        ? 'Spend ingestion is not configured, but completed gateway turns are awaiting prices'
        : null,
    };
  }
  const [reconciliation, awaiting] = await Promise.all([
    db.getModelGatewayReconciliationState(config.profile),
    db.getGatewayTurnsAwaitingReconciliation(),
  ]);
  const watermarkAt = reconciliation?.watermarkMs ? reconciliation.watermarkMs : null;
  const lagMs = watermarkAt === null ? null : Math.max(0, now - watermarkAt);
  const staleAwaiting = awaiting.count > 0
    && awaiting.oldestCompletedAt !== null
    && now - awaiting.oldestCompletedAt > awaitingGraceMs;
  const state = !reconciliation?.lastSuccessAt
    ? reconciliation?.lastError
      ? 'degraded'
      : 'initializing'
    : reconciliation.lastError
      || lagMs === null
      || lagMs > (options?.degradedLagMs ?? DEFAULT_DEGRADED_LAG_MS)
      || staleAwaiting
      ? 'degraded'
      : 'healthy';
  return {
    enabled: true,
    state,
    lagMs,
    awaitingTurns: awaiting.count,
    lastError: reconciliation?.lastError
      ?? (staleAwaiting
        ? 'Completed gateway turns have waited past the settlement grace period for prices'
        : null),
  };
}

export async function modelGatewayRoutes(
  app: FastifyInstance,
  opts: ModelGatewayRouteOptions,
): Promise<void> {
  app.get('/status', async () => {
    const summary = await summarizeModelGatewayHealth(opts.db, opts.config, {
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.degradedLagMs !== undefined ? { degradedLagMs: opts.degradedLagMs } : {}),
      ...(opts.awaitingGraceMs !== undefined ? { awaitingGraceMs: opts.awaitingGraceMs } : {}),
    });
    const awaiting = await opts.db.getGatewayTurnsAwaitingReconciliation();

    if (!opts.config.enabled) {
      // Ingestion being off is only benign while nothing waits on it. Any
      // gateway-attributed turn without reconciled usage means budgets and
      // analytics under-count — report degraded, not a quiet zero-state.
      return ModelGatewayStatusSchema.parse({
        enabled: false,
        profile: null,
        revision: null,
        state: summary.state,
        watermarkAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lagMs: null,
        lastError: summary.lastError,
        pendingCalls: 0,
        unpricedCalls: 0,
        quarantinedTransactions: 0,
        orphanTransactions: 0,
        awaitingTurns: awaiting.count,
        oldestAwaitingAt: awaiting.oldestCompletedAt,
      });
    }

    const [reconciliation, metrics] = await Promise.all([
      opts.db.getModelGatewayReconciliationState(opts.config.profile),
      opts.db.getModelGatewayReconciliationMetrics(opts.config.profile),
    ]);
    return ModelGatewayStatusSchema.parse({
      enabled: true,
      profile: opts.config.profile,
      revision: opts.config.revision,
      state: summary.state,
      watermarkAt: reconciliation?.watermarkMs ? reconciliation.watermarkMs : null,
      lastAttemptAt: reconciliation?.lastAttemptAt ?? null,
      lastSuccessAt: reconciliation?.lastSuccessAt ?? null,
      lagMs: summary.lagMs,
      lastError: summary.lastError,
      ...metrics,
      awaitingTurns: awaiting.count,
      oldestAwaitingAt: awaiting.oldestCompletedAt,
    });
  });

  app.get(
    '/quarantine',
    async (
      request: FastifyRequest<{ Querystring: { since?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      if (!opts.config.enabled) {
        return ModelGatewayQuarantineSchema.parse({
          enabled: false,
          profile: null,
          recentSince: null,
          total: 0,
          recentTotal: 0,
          reasons: [],
          recent: [],
        });
      }

      const now = (opts.now ?? Date.now)();
      const sinceRaw = request.query.since;
      const since = sinceRaw === undefined ? now - DEFAULT_QUARANTINE_RECENT_MS : Number(sinceRaw);
      if (!Number.isSafeInteger(since) || since < 0) {
        return reply.status(400).send({
          error: 'since must be a nonnegative epoch-milliseconds integer',
        });
      }
      const limitRaw = request.query.limit;
      const limit = limitRaw === undefined ? DEFAULT_QUARANTINE_LIMIT : Number(limitRaw);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUARANTINE_LIMIT) {
        return reply.status(400).send({
          error: `limit must be an integer between 1 and ${MAX_QUARANTINE_LIMIT}`,
        });
      }

      const summary = await opts.db.getModelGatewayQuarantineSummary(
        opts.config.profile,
        { recentSinceMs: since, limit },
      );

      return ModelGatewayQuarantineSchema.parse({
        enabled: true,
        profile: opts.config.profile,
        recentSince: since,
        total: summary.reasons.reduce((sum, row) => sum + row.total, 0),
        recentTotal: summary.reasons.reduce((sum, row) => sum + row.recentTotal, 0),
        reasons: summary.reasons,
        recent: summary.recent,
      });
    },
  );

  // ── Campaign keys (ctx-hmm3) ──────────────────────────────────────
  // No `capability` annotation: master-only under the fail-closed default
  // (ADR 022). A campaign key is spending authority over model providers,
  // like key administration and budgets, which are master-only too.

  const campaignKeysUnavailable = (reply: FastifyReply): FastifyReply => reply.status(503).send({
    error: 'Campaign keys are not available: this deployment has no model gateway admin key '
      + '(STABLEHAND_MODEL_GATEWAY_ADMIN_KEY), so it cannot create or delete gateway keys.',
    code: 'campaign_keys_unavailable',
  });

  const sendCampaignKeyError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof CampaignKeyError) {
      return reply.status(err.statusCode).send({ error: err.message, code: err.code, ...err.details });
    }
    throw err;
  };

  app.post('/campaign-keys', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const parsed = ModelGatewayCampaignKeyCreateInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return reply.status(400).send({
        error: `Invalid campaign key request: ${path}${issue?.message ?? 'invalid request'}`,
        code: 'invalid_campaign_key_request',
        issues: parsed.error.issues.map((entry) => ({
          path: entry.path.join('.'),
          message: entry.message,
        })),
      });
    }
    if (!opts.campaignKeys) return campaignKeysUnavailable(reply);
    try {
      const created = await opts.campaignKeys.create(parsed.data, 'master');
      return reply
        .header('Cache-Control', 'no-store')
        .status(201)
        .send(ModelGatewayCampaignKeyCreatedSchema.parse(created));
    } catch (err) {
      return sendCampaignKeyError(reply, err);
    }
  });

  app.get('/campaign-keys', async () => {
    const rows = await opts.db.listModelGatewayCampaignKeys();
    const spend = await opts.db.getModelGatewayCampaignKeySpend(rows.map((row) => row.id));
    const now = (opts.now ?? Date.now)();
    return ModelGatewayCampaignKeyListResponseSchema.parse({
      campaignKeys: rows.map((row) => toPublicCampaignKey(row, spend.get(row.id), now)),
    });
  });

  app.get(
    '/campaign-keys/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const row = await opts.db.getModelGatewayCampaignKey(request.params.id);
      if (!row) {
        return reply.status(404).send({ error: `Unknown campaign key: ${request.params.id}` });
      }
      const spend = await opts.db.getModelGatewayCampaignKeySpend([row.id]);
      return ModelGatewayCampaignKeySchema.parse(
        toPublicCampaignKey(row, spend.get(row.id), (opts.now ?? Date.now)()),
      );
    },
  );

  app.delete(
    '/campaign-keys/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      if (!opts.campaignKeys) return campaignKeysUnavailable(reply);
      try {
        const revoked = await opts.campaignKeys.revoke(request.params.id);
        if (!revoked) {
          return reply.status(404).send({ error: `Unknown campaign key: ${request.params.id}` });
        }
        return ModelGatewayCampaignKeySchema.parse(revoked);
      } catch (err) {
        return sendCampaignKeyError(reply, err);
      }
    },
  );
}
