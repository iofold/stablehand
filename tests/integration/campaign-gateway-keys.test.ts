/**
 * Campaign gateway keys end to end (ctx-hmm3, ctx-gfp8) against a fake
 * LiteLLM: mint a key over HTTP, simulate gateway spend from it, from
 * Stablehand's own runtime key, and from another workload sharing the
 * gateway, then reconcile and check that:
 *
 * - the campaign's budget spend includes the campaign key's calls;
 * - the 50% and 85% warn thresholds each raise one budget.threshold event,
 *   and the key's notify agent gets a webhook;
 * - once the cap is reached, a new turn tagged for the campaign is refused
 *   at admission;
 * - rows from keys Stablehand did not issue are never fetched or stored,
 *   while Stablehand's own uncorrelated rows are still quarantined;
 * - revoking deletes the gateway key, and spend that arrives later still
 *   counts.
 *
 * The fake implements the LiteLLM 1.93 surface the feature relies on, as
 * read from the 1.93.0 source on dev1 (2026-10-23): `/spend/logs/v2` filters
 * `api_key` by exact token hash and `key_alias` by substring of
 * `metadata.user_api_key_alias`, sorted by startTime and paged.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EventMap } from '../../packages/stablehand/src/events/bus.js';
import { allowConsoleErrors } from '../setup-strict.js';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

const ADMIN_KEY = 'sk-admin-int';
const METERING_KEY = 'sk-metering-int';
const RUNTIME_KEY = 'sk-runtime-int';
const CAMPAIGN = `bf-int-${randomUUID().slice(0, 8)}`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface FakeKey {
  token: string;
  alias: string | null;
  models: string[];
  maxBudget: number | null;
}

interface FakeSpendRow {
  request_id: string;
  api_key: string;
  spend: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  startTime: string;
  endTime: string;
  model: string;
  model_group: string;
  custom_llm_provider: string;
  session_id?: string;
  status: string;
  metadata: { user_api_key_alias?: string };
}

class FakeLiteLLM {
  readonly keys = new Map<string, FakeKey>();
  readonly secrets = new Map<string, string>();
  readonly spendLogs: FakeSpendRow[] = [];
  readonly spendQueries: URLSearchParams[] = [];
  private server: Server | undefined;

  constructor() {
    this.keys.set(sha256(RUNTIME_KEY), {
      token: sha256(RUNTIME_KEY),
      alias: 'ops-runtime',
      models: ['gpt-5.4-mini', 'claude-haiku-4-5'],
      maxBudget: null,
    });
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => this.handle(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  keyByAlias(alias: string): FakeKey | undefined {
    return [...this.keys.values()].find((key) => key.alias === alias);
  }

  /** A finished model call as LiteLLM logs it, ending 15 s ago (inside the settled window). */
  recordCall(input: { keyHash: string; alias?: string; spend: number; correlationId?: string }): string {
    const requestId = `req-${randomUUID()}`;
    const endMs = Date.now() - 15_000;
    this.spendLogs.push({
      request_id: requestId,
      api_key: input.keyHash,
      spend: input.spend,
      prompt_tokens: 900,
      completion_tokens: 100,
      total_tokens: 1_000,
      startTime: new Date(endMs - 1_000).toISOString(),
      endTime: new Date(endMs).toISOString(),
      model: 'openai/gpt-5.4-mini',
      model_group: 'gpt-5.4-mini',
      custom_llm_provider: 'openai',
      ...(input.correlationId ? { session_id: input.correlationId } : {}),
      status: 'success',
      metadata: input.alias ? { user_api_key_alias: input.alias } : {},
    });
    return requestId;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (url.pathname === '/spend/logs/v2') {
      if (bearer !== METERING_KEY) return this.json(res, 401, { error: { message: 'not the metering key' } });
      return this.handleSpendLogs(url, res);
    }
    if (bearer !== ADMIN_KEY) return this.json(res, 401, { error: { message: 'not an admin' } });
    switch (url.pathname) {
      case '/key/generate': {
        const alias = typeof body.key_alias === 'string' ? body.key_alias : null;
        if (alias && this.keyByAlias(alias)) {
          return this.json(res, 400, { error: { message: `Key with alias '${alias}' already exists.` } });
        }
        const secret = `sk-${randomUUID()}`;
        const key: FakeKey = {
          token: sha256(secret),
          alias,
          models: Array.isArray(body.models) ? body.models as string[] : [],
          maxBudget: typeof body.max_budget === 'number' ? body.max_budget : null,
        };
        this.keys.set(key.token, key);
        this.secrets.set(key.token, secret);
        return this.json(res, 200, { key: secret, token: key.token, key_alias: alias });
      }
      case '/key/info': {
        const key = this.keys.get(url.searchParams.get('key') ?? '');
        if (!key) return this.json(res, 404, { error: { message: 'Key not found' } });
        return this.json(res, 200, { key: key.token, info: { models: key.models, key_alias: key.alias } });
      }
      case '/key/delete': {
        const aliases = Array.isArray(body.key_aliases) ? body.key_aliases as string[] : [];
        const deleted = aliases.filter((alias) => {
          const key = this.keyByAlias(alias);
          if (key) this.keys.delete(key.token);
          return Boolean(key);
        });
        if (deleted.length === 0) return this.json(res, 404, { error: { message: 'Key not found' } });
        return this.json(res, 200, { deleted_keys: deleted });
      }
      default:
        return this.json(res, 404, { error: { message: 'no route' } });
    }
  }

  private handleSpendLogs(url: URL, res: ServerResponse): void {
    this.spendQueries.push(url.searchParams);
    const apiKey = url.searchParams.get('api_key');
    const keyAlias = url.searchParams.get('key_alias');
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('page_size') ?? '50');
    const matched = this.spendLogs
      .filter((row) => apiKey === null || row.api_key === apiKey)
      .filter((row) => keyAlias === null || (row.metadata.user_api_key_alias ?? '').includes(keyAlias))
      .sort((left, right) => left.startTime.localeCompare(right.startTime));
    return this.json(res, 200, {
      data: matched.slice((page - 1) * pageSize, page * pageSize),
      page,
      page_size: pageSize,
      total: matched.length,
      total_pages: Math.ceil(matched.length / pageSize),
    });
  }
}

const GATEWAY_ENV = [
  'STABLEHAND_MODEL_GATEWAY_ENABLED',
  'STABLEHAND_MODEL_GATEWAY_URL',
  'STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY',
  'STABLEHAND_MODEL_GATEWAY_METERING_KEY',
  'STABLEHAND_MODEL_GATEWAY_REVISION',
  'STABLEHAND_MODEL_GATEWAY_ADMIN_KEY',
] as const;

describe('campaign gateway keys (ctx-hmm3, ctx-gfp8)', () => {
  let litellm: FakeLiteLLM;
  let testApp: TestAppHandle | undefined;
  let savedEnv: Record<string, string | undefined>;
  let notifyAgentId: string;
  let workerAgentId: string;
  let policyId: string;
  const thresholdEvents: Array<EventMap['budget.threshold']> = [];

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    litellm = new FakeLiteLLM();
    const litellmUrl = await litellm.start();
    savedEnv = Object.fromEntries(GATEWAY_ENV.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
      STABLEHAND_MODEL_GATEWAY_URL: litellmUrl,
      STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY: RUNTIME_KEY,
      STABLEHAND_MODEL_GATEWAY_METERING_KEY: METERING_KEY,
      STABLEHAND_MODEL_GATEWAY_REVISION: 'int-r1',
      STABLEHAND_MODEL_GATEWAY_ADMIN_KEY: ADMIN_KEY,
    });
    testApp = await createTestApp({ dirPrefix: 'stablehand-campaign-keys-test-' });
    // Drive reconciliation by hand: stop the background poll loop.
    await testApp.container.modelGatewayReconciler?.stop();
    testApp.container.eventBus.on('budget.threshold', (payload) => {
      thresholdEvents.push(payload as EventMap['budget.threshold']);
    });

    const createAgent = async (name: string) => {
      const res = await testApp!.app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: {
          name: `${name}-${randomUUID().slice(0, 8)}`,
          harness: 'langgraph',
          harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
          systemPrompt: 'test',
          tools: [],
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };
    notifyAgentId = await createAgent('campaign-publisher');
    workerAgentId = await createAgent('campaign-worker');
    const hook = await testApp.app.inject({
      method: 'POST',
      url: `/api/agents/${notifyAgentId}/webhooks`,
      payload: {
        url: 'https://alerts.example.com/stablehand',
        events: ['budget.threshold'],
        secret: 'webhook-secret',
      },
    });
    expect(hook.statusCode).toBe(201);

    const policy = await testApp.app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        name: 'campaign cap',
        doc: {
          selector: { campaign: CAMPAIGN },
          window: 'month-to-date',
          limits: { costUsd: 10 },
          actions: [
            { threshold: 0.5, action: 'warn' },
            { threshold: 0.85, action: 'warn' },
            { threshold: 1, action: 'block' },
          ],
        },
      },
    });
    expect(policy.statusCode).toBe(201);
    policyId = policy.json().id;
  });

  afterAll(async () => {
    await testApp?.close();
    await litellm?.stop();
    for (const name of GATEWAY_ENV) {
      if (savedEnv?.[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  async function reconcile() {
    const result = await testApp!.container.modelGatewayReconciler!.runOnce();
    expect(result.status).toBe('success');
    return result as Extract<typeof result, { status: 'success' }>;
  }

  async function policySpendUsd(): Promise<number | null> {
    const res = await testApp!.app.inject({ method: 'GET', url: `/api/budgets/${policyId}/spend` });
    expect(res.statusCode).toBe(200);
    return res.json().buckets[0].spend.costUsd;
  }

  it('mints, attributes, alerts, blocks, skips foreign keys, and revokes', async () => {
    const app = testApp!.app;

    // ── Mint ───────────────────────────────────────────────────────────
    const refused = await app.inject({
      method: 'POST',
      url: '/api/model-gateway/campaign-keys',
      payload: { name: 'too broad', tags: { campaign: CAMPAIGN }, models: ['claude-opus-5'] },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'model_not_allowed', models: ['claude-opus-5'] });

    const minted = await app.inject({
      method: 'POST',
      url: '/api/model-gateway/campaign-keys',
      payload: {
        name: 'terminus calibration',
        tags: { campaign: CAMPAIGN },
        models: ['gpt-5.4-mini'],
        maxBudgetUsd: 25,
        notifyAgentId,
      },
    });
    expect(minted.statusCode).toBe(201);
    expect(minted.headers['cache-control']).toBe('no-store');
    const campaignKey = minted.json();
    expect(campaignKey).toMatchObject({
      tags: { campaign: CAMPAIGN },
      status: 'active',
      // The policy's $10 headroom is lower than the requested $25.
      maxBudgetUsd: 10,
      capSource: 'budget_policy',
      capPolicyId: policyId,
      notifyAgentId,
    });
    const campaignHash = sha256(campaignKey.key);
    expect(litellm.keys.get(campaignHash)).toMatchObject({
      alias: campaignKey.keyAlias,
      models: ['gpt-5.4-mini'],
      maxBudget: 10,
    });
    // The secret is never readable again.
    const listed = await app.inject({ method: 'GET', url: '/api/model-gateway/campaign-keys' });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain(campaignKey.key);
    expect(JSON.stringify(listed.json())).not.toContain(campaignHash);

    // ── Spend from the campaign, from Stablehand, and from a neighbour ──
    const campaignCall = (spend: number) => litellm.recordCall({
      keyHash: campaignHash,
      alias: campaignKey.keyAlias,
      spend,
    });
    campaignCall(6);
    const ownUncorrelated = litellm.recordCall({ keyHash: sha256(RUNTIME_KEY), alias: 'ops-runtime', spend: 0.01 });
    const neighbourCalls = Array.from({ length: 25 }, () => litellm.recordCall({
      keyHash: sha256('sk-another-workload'),
      alias: 'research-lane',
      spend: 0.5,
    }));
    // An alias that merely contains an issued prefix is fetched but not ours.
    litellm.recordCall({ keyHash: sha256('sk-lookalike'), alias: 'copy-of-stablehand-session-x', spend: 3 });

    // This suite shares the database with earlier files; compare to a baseline.
    const quarantineBefore = (await app.inject({
      method: 'GET',
      url: '/api/model-gateway/quarantine?limit=100',
    })).json();

    const first = await reconcile();
    expect(first).toMatchObject({ campaignAttached: 1, quarantined: 1, skippedForeign: 1 });
    // Every spend query was filtered to an issued key.
    expect(litellm.spendQueries.length).toBeGreaterThan(0);
    for (const query of litellm.spendQueries) {
      expect(query.has('api_key') || query.has('key_alias')).toBe(true);
    }
    const quarantine = (await app.inject({
      method: 'GET',
      url: '/api/model-gateway/quarantine?limit=100',
    })).json();
    // Only Stablehand's own uncorrelated call is quarantined.
    expect(quarantine.total).toBe(quarantineBefore.total + 1);
    expect(quarantine.recent).toContainEqual(expect.objectContaining({
      transactionId: ownUncorrelated,
      reason: 'missing_correlation',
    }));
    for (const neighbourCall of neighbourCalls) {
      expect(JSON.stringify(quarantine)).not.toContain(neighbourCall);
    }

    // ── Budget spend includes the campaign key's calls; 50% alert ───────
    expect(await policySpendUsd()).toBe(6);
    // Bus listeners run once the event is durably persisted.
    await expect.poll(() => thresholdEvents.map((event) => event.threshold)).toEqual([0.5]);
    expect(thresholdEvents[0]).toMatchObject({
      policyId,
      action: 'warn',
      metric: 'costUsd',
      spent: 6,
      limit: 10,
      agentId: notifyAgentId,
      campaignKeyId: campaignKey.id,
    });
    // The canonical event is on /api/events for anyone reading the log.
    const events = (await app.inject({
      method: 'GET',
      url: '/api/events?type=budget.threshold&limit=200',
    })).json().events as Array<{ type: string; payload: string }>;
    expect(events.some((event) => event.payload.includes(campaignKey.id))).toBe(true);
    await expect.poll(async () => (await testApp!.container.db.getCallbacksForAgent(notifyAgentId))
      .filter((row) => row.eventType === 'budget.threshold')
      .map((row) => row.payload), { timeout: 10_000 }).toEqual([
      expect.objectContaining({ threshold: 0.5, campaignKeyId: campaignKey.id, agentId: notifyAgentId }),
    ]);

    // Re-reading the same window adds nothing (and so alerts nothing: the
    // exact event lists below would show a repeat).
    expect(await reconcile()).toMatchObject({ campaignAttached: 1 });
    expect(await policySpendUsd()).toBe(6);

    // ── 85% alert ───────────────────────────────────────────────────────
    campaignCall(3);
    await reconcile();
    expect(await policySpendUsd()).toBe(9);
    await expect.poll(() => thresholdEvents.map((event) => event.threshold)).toEqual([0.5, 0.85]);

    // ── Cap reached: a new tagged turn is refused at admission ──────────
    // Every dollar so far came from the campaign key, none from turns.
    campaignCall(1.5);
    await reconcile();
    expect(await policySpendUsd()).toBe(10.5);
    await expect.poll(() => thresholdEvents.map((event) => [event.action, event.threshold])).toEqual([
      ['warn', 0.5],
      ['warn', 0.85],
      ['block', 1],
    ]);
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/agents/${workerAgentId}/turns`,
      payload: { task: 'one more', tags: { campaign: CAMPAIGN } },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({
      code: 'budget_exceeded',
      policyId,
      metric: 'costUsd',
      spent: 10.5,
      limit: 10,
    });
    // Admission leaves nothing behind for the refused run.
    const turns = await app.inject({ method: 'GET', url: `/api/agents/${workerAgentId}/turns` });
    expect(turns.json().turns).toEqual([]);

    // A used-up budget refuses a new key for the same tags.
    const exhausted = await app.inject({
      method: 'POST',
      url: '/api/model-gateway/campaign-keys',
      payload: { name: 'second key', tags: { campaign: CAMPAIGN }, models: ['gpt-5.4-mini'] },
    });
    expect(exhausted.statusCode).toBe(409);
    expect(exhausted.json()).toMatchObject({ code: 'budget_exhausted', policyId });

    // ── Revoke: the gateway key goes; late spend still counts ───────────
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/model-gateway/campaign-keys/${campaignKey.id}`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: 'revoked', spend: { costUsd: 10.5, calls: 3 } });
    expect(litellm.keys.has(campaignHash)).toBe(false);

    campaignCall(0.25);
    await reconcile();
    const detail = await app.inject({
      method: 'GET',
      url: `/api/model-gateway/campaign-keys/${campaignKey.id}`,
    });
    expect(detail.json()).toMatchObject({ status: 'revoked', spend: { costUsd: 10.75, calls: 4 } });
  });
});
