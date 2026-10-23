import { createHash } from 'node:crypto';

import { CAPABILITY_VERBS, type CapabilityVerb } from '@stablehand/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

const TEST_TOKEN = 'coverage-token';
const SCOPED_TOKEN = `cmk_${'z'.repeat(43)}`;

type ExpectedRouteAccess = 'public' | 'master' | CapabilityVerb;

const EXPECTED_ROUTE_ACCESS: Readonly<Record<string, ExpectedRouteAccess>> = {
  'GET /health': 'public',
  'GET /api/health': 'public',
  // The OAuth redirect target: authorized by its single-use state, not a token.
  'GET /api/mcp/oauth/callback': 'public',
  // The egress proxy's lease check: the session lease in the body is the credential.
  'POST /api/egress/lease': 'public',

  'GET /api/agents': 'agents:read',
  'GET /api/agents/:id': 'agents:read',
  'GET /api/agents/:id/conversations': 'agents:read',
  'GET /api/agents/:id/conversations/summary': 'agents:read',
  'GET /api/agents/:id/conversations/:convId/snapshot': 'agents:read',
  'GET /api/agents/:id/turns': 'agents:read',
  'GET /api/agents/:id/turns/:turnId': 'agents:read',
  'GET /api/agents/:id/stream': 'agents:read',
  'GET /api/agents/:id/mcp-servers': 'agents:read',
  'GET /api/turns': 'agents:read',
  'GET /api/turns/:turnId': 'agents:read',
  'GET /api/conversations': 'agents:read',
  'GET /api/conversations/recent': 'agents:read',
  'GET /api/sandbox-sessions': 'agents:read',

  'POST /api/agents': 'agents:write',
  'PATCH /api/agents/:id': 'agents:write',
  'DELETE /api/agents/:id': 'agents:write',
  'POST /api/agents/:id/mcp-servers/:server/refresh': 'agents:write',

  'POST /api/agents/:id/message': 'conversations:write',
  'POST /api/agents/:id/turns': 'conversations:write',
  'POST /api/agents/:id/turns/:turnId/cancel': 'conversations:write',
  'POST /api/ag-ui/:id/run': 'conversations:write',

  'GET /api/events': 'events:read',
  'GET /api/events/stats': 'events:read',
  'GET /api/events/types': 'events:read',

  'GET /api/interrupts': 'interrupts:read',
  'GET /api/interrupts/:id': 'interrupts:read',
  'GET /api/agents/:id/interrupts': 'interrupts:read',
  'POST /api/agents/:id/interrupt': 'interrupts:resolve',
  'POST /api/agents/:id/feedback': 'feedback:write',

  'GET /api/artifacts': 'artifacts:read',
  'GET /api/artifacts/:id': 'artifacts:read',
  'GET /api/artifacts/:id/download': 'artifacts:read',
  'GET /api/artifacts/:id/download-url': 'artifacts:read',
  'POST /api/artifacts/upload-url': 'artifacts:write',
  'POST /api/artifacts/upload': 'artifacts:write',

  'GET /api/agents/:id/webhooks': 'webhooks:manage',
  'POST /api/agents/:id/webhooks': 'webhooks:manage',
  'PATCH /api/agents/:id/webhooks/:webhookId': 'webhooks:manage',
  'DELETE /api/agents/:id/webhooks/:webhookId': 'webhooks:manage',

  'GET /api/schedules': 'schedules:manage',
  'POST /api/schedules': 'schedules:manage',
  'GET /api/schedules/:id': 'schedules:manage',
  'PATCH /api/schedules/:id': 'schedules:manage',
  'DELETE /api/schedules/:id': 'schedules:manage',
  'POST /api/schedules/:id/fire': 'schedules:manage',

  'POST /api/triggers/emit': 'triggers:emit',

  'GET /api/config': 'master',
  'GET /api/agents/:id/files': 'master',
  'GET /api/agents/:id/files/read': 'master',
  'POST /api/agents/:id/files': 'master',
  'PUT /api/agents/:id/files': 'master',
  'DELETE /api/agents/:id/files': 'master',
  'GET /api/agents/:id/workspace': 'master',
  'POST /api/agents/:id/workspace': 'master',
  'GET /api/agents/:id/secrets': 'master',
  'POST /api/agents/:id/secrets': 'master',
  'DELETE /api/agents/:id/secrets/:key': 'master',
  'POST /api/agents/:id/mcp-servers/:server/connect': 'master',
  'DELETE /api/agents/:id/mcp-servers/:server/connection': 'master',
  'POST /api/agents/:id/sandbox-sessions/:sandboxSessionId/suspend': 'master',
  'POST /api/agents/:id/sandbox-sessions/:sandboxSessionId/restore': 'master',
  'POST /api/agents/:id/sandbox-sessions/:sandboxSessionId/kill': 'master',
  'DELETE /api/artifacts/:id': 'master',
  'GET /api/budgets': 'master',
  'POST /api/budgets': 'master',
  'GET /api/budgets/agents/status': 'master',
  'GET /api/budgets/:id': 'master',
  'PATCH /api/budgets/:id': 'master',
  'DELETE /api/budgets/:id': 'master',
  'GET /api/budgets/:id/spend': 'master',
  'GET /api/catalogs/tools': 'master',
  'POST /api/catalogs/tools/test': 'master',
  'GET /api/analytics/overview': 'master',
  'GET /api/keys': 'master',
  'POST /api/keys': 'master',
  'DELETE /api/keys/:id': 'master',
  'GET /api/model-gateway/status': 'master',
  'GET /api/model-gateway/quarantine': 'master',
  // Campaign keys are spending authority over model providers (ctx-hmm3).
  'POST /api/model-gateway/campaign-keys': 'master',
  'GET /api/model-gateway/campaign-keys': 'master',
  'GET /api/model-gateway/campaign-keys/:id': 'master',
  'DELETE /api/model-gateway/campaign-keys/:id': 'master',
  'GET /api/queue/status': 'master',
  'GET /api/sandbox/metrics': 'master',
  'GET /api/settings': 'master',
  'PUT /api/settings': 'master',
  'GET /api/triggers': 'master',
  'GET /api/triggers/failures': 'master',
  'POST /api/triggers': 'master',
  'GET /api/triggers/:id': 'master',
  'PUT /api/triggers/:id': 'master',
  'DELETE /api/triggers/:id': 'master',
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('API auth route coverage', () => {
  let app: TestAppHandle['app'];
  let testApp: TestAppHandle | undefined;
  let oldToken: string | undefined;
  let oldDisabled: string | undefined;

  beforeAll(async () => {
    oldToken = process.env.STABLEHAND_API_TOKEN;
    oldDisabled = process.env.STABLEHAND_AUTH_DISABLED;
    process.env.STABLEHAND_API_TOKEN = TEST_TOKEN;
    delete process.env.STABLEHAND_AUTH_DISABLED;

    testApp = await createTestApp({
      dirPrefix: 'stablehand-api-auth-',
      serverOptions: {
        artifactStore: {} as never,
        artifactBucket: 'auth-coverage',
      },
    });
    app = testApp.app;
    await testApp.container.db.createApiKey({
      name: 'coverage-all-capabilities',
      tokenHash: createHash('sha256').update(SCOPED_TOKEN).digest('hex'),
      capabilities: [...CAPABILITY_VERBS],
      createdBy: 'master',
    });
  });

  afterAll(async () => {
    await testApp?.close();
    restoreEnv('STABLEHAND_API_TOKEN', oldToken);
    restoreEnv('STABLEHAND_AUTH_DISABLED', oldDisabled);
  });

  it('marks exactly the health endpoints, the MCP OAuth redirect and the egress lease check public', () => {
    const publicUrls = [...new Set(
      app.apiRouteTable
        .filter((route) => route.public)
        .map((route) => route.url),
    )].sort();

    expect(publicUrls).toEqual(['/api/egress/lease', '/api/health', '/api/mcp/oauth/callback', '/health']);
  });

  it('records only API, health, and ConnectRPC routes', () => {
    for (const route of app.apiRouteTable) {
      expect(
        route.url.startsWith('/api/')
        || route.url === '/health'
        || route.url.startsWith('/stablehand.sandbox.v1.'),
      ).toBe(true);
    }
  });

  it('classifies every explicit HTTP route exactly once', () => {
    const routes = app.apiRouteTable.filter((route) =>
      route.method !== 'HEAD'
      && (route.url === '/health' || route.url.startsWith('/api/')),
    );
    const actual = Object.fromEntries(routes.map((route) => [
      `${route.method} ${route.url}`,
      route.public
        ? 'public'
        : ((route as typeof route & { capability?: CapabilityVerb }).capability ?? 'master'),
    ]));

    expect(routes).toHaveLength(97);
    expect(Object.keys(actual)).toHaveLength(routes.length);
    expect(actual).toEqual(EXPECTED_ROUTE_ACCESS);
  });

  it('keeps every master-only route closed to a fully granted scoped key', async () => {
    const masterOnlyRoutes = Object.entries(EXPECTED_ROUTE_ACCESS)
      .filter(([, access]) => access === 'master')
      .map(([route]) => {
        const separator = route.indexOf(' ');
        return { method: route.slice(0, separator), url: route.slice(separator + 1) };
      });

    expect(masterOnlyRoutes).toHaveLength(46);
    for (const route of masterOnlyRoutes) {
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(res.json(), `${route.method} ${route.url}`).toMatchObject({
        requiredCapability: null,
      });
    }
  });

  it('rejects every non-public /api route without a bearer token', async () => {
    const apiRoutes = app.apiRouteTable.filter((route) =>
      route.url.startsWith('/api/')
      && !route.public
      && route.method !== 'HEAD',
    );

    expect(apiRoutes.length).toBeGreaterThan(10);

    for (const route of apiRoutes) {
      const res = await app.inject({ method: route.method, url: route.url });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it('keeps health open and allows token-authenticated API requests', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);

    const agents = await app.inject({
      method: 'GET',
      url: '/api/agents',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(agents.statusCode).toBe(200);

    const config = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(config.statusCode).toBe(200);
  });
});
