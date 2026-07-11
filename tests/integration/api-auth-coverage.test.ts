import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

const TEST_TOKEN = 'coverage-token';

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
    oldToken = process.env.CTXMILL_API_TOKEN;
    oldDisabled = process.env.CTXMILL_AUTH_DISABLED;
    process.env.CTXMILL_API_TOKEN = TEST_TOKEN;
    delete process.env.CTXMILL_AUTH_DISABLED;

    testApp = await createTestApp({
      dirPrefix: 'ctxmill-api-auth-',
    });
    app = testApp.app;
  });

  afterAll(async () => {
    await testApp?.close();
    restoreEnv('CTXMILL_API_TOKEN', oldToken);
    restoreEnv('CTXMILL_AUTH_DISABLED', oldDisabled);
  });

  it('marks exactly the health endpoints public', () => {
    const publicUrls = [...new Set(
      app.apiRouteTable
        .filter((route) => route.public)
        .map((route) => route.url),
    )].sort();

    expect(publicUrls).toEqual(['/api/health', '/health']);
  });

  it('records only API, health, and ConnectRPC routes', () => {
    for (const route of app.apiRouteTable) {
      expect(
        route.url.startsWith('/api/')
        || route.url === '/health'
        || route.url.startsWith('/ctxmill.sandbox.v1.'),
      ).toBe(true);
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
