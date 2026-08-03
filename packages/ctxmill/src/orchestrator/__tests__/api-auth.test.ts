import { createHash } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  redactAccessTokenInUrl,
  registerApiAuth,
  resolveApiAuthConfig,
  serializeRequestForLog,
  type ApiAuthConfig,
  type ApiKeyPrincipal,
  type ApiKeyStore,
} from '../auth.js';

async function withApp<T>(
  config: ApiAuthConfig,
  run: (app: ReturnType<typeof Fastify>) => Promise<T>,
  keyStore?: ApiKeyStore,
): Promise<T> {
  const app = Fastify({ logger: false });
  registerApiAuth(app, config, keyStore);
  app.get('/health', { config: { public: true } }, async () => ({ ok: true }));
  app.get('/api/health', { config: { public: true } }, async () => ({ ok: true }));
  app.get('/public-info', async () => ({ ok: true }));
  app.get('/api/private', async () => ({ ok: true }));
  app.get('/api/stream', { config: { allowTokenQuery: true } }, async () => ({ ok: true }));
  app.post('/api/private', async () => ({ ok: true }));
  app.get('/api/scoped-events', { config: { capability: 'events:read' } }, async (request) => ({
    ok: true,
    principal: request.apiPrincipal,
  }));
  app.post('/api/scoped-emit', { config: { capability: 'triggers:emit' } }, async () => ({ ok: true }));
  await app.ready();

  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

const SCOPED_TOKEN = `cmk_${'a'.repeat(43)}`;
const SCOPED_TOKEN_HASH = createHash('sha256').update(SCOPED_TOKEN).digest('hex');

function storeWith(principal: ApiKeyPrincipal | null): ApiKeyStore & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    findLiveKeyByTokenHash: async (hash) => (hash === SCOPED_TOKEN_HASH ? principal : null),
    touchLastUsed: async (keyId) => {
      touched.push(keyId);
    },
  };
}

describe('resolveApiAuthConfig', () => {
  it('enforces auth when CTXMILL_API_TOKEN is set', () => {
    expect(resolveApiAuthConfig({
      NODE_ENV: 'production',
      CTXMILL_API_TOKEN: ' token ',
    })).toEqual({ mode: 'enforce', token: 'token' });
  });

  it('allows an explicit disabled mode without a token', () => {
    const logger = { warn: vi.fn() };

    expect(resolveApiAuthConfig({
      NODE_ENV: 'production',
      CTXMILL_AUTH_DISABLED: 'true',
    }, logger)).toEqual({ mode: 'open' });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('fails closed in production without a token', () => {
    expect(() => resolveApiAuthConfig({ NODE_ENV: 'production' })).toThrow(/CTXMILL_API_TOKEN/);
    expect(() => resolveApiAuthConfig({ NODE_ENV: 'production' })).toThrow(/openssl rand/);
  });

  it('stays open outside production and warns', () => {
    const logger = { warn: vi.fn() };

    expect(resolveApiAuthConfig({ NODE_ENV: 'test' }, logger)).toEqual({ mode: 'open' });
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('registerApiAuth', () => {
  it('rejects missing and invalid bearer tokens with the documented response', async () => {
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const missing = await app.inject({ method: 'GET', url: '/api/private' });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers['www-authenticate']).toBe('Bearer realm="ctxmill"');
      expect(missing.json()).toEqual({ error: 'Unauthorized: missing or invalid API token' });

      const wrong = await app.inject({
        method: 'GET',
        url: '/api/private',
        headers: { Authorization: 'Bearer nope' },
      });
      expect(wrong.statusCode).toBe(401);
    });
  });

  it('accepts an exact bearer token', async () => {
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/private',
        headers: { Authorization: 'Bearer secret' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  it('allows query token auth only on routes that opt in', async () => {
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const stream = await app.inject({
        method: 'GET',
        url: '/api/stream?access_token=secret',
      });
      expect(stream.statusCode).toBe(200);

      const regular = await app.inject({
        method: 'GET',
        url: '/api/private?access_token=secret',
      });
      expect(regular.statusCode).toBe(401);
    });
  });

  it('skips public, non-api, and OPTIONS requests', async () => {
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/public-info' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'OPTIONS', url: '/api/private' })).statusCode).not.toBe(401);
    });
  });

  it('authenticates unmatched /api routes before Fastify returns 404', async () => {
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(res.statusCode).toBe(401);
    });
  });

  it('records route auth metadata for coverage tests', async () => {
    await withApp({ mode: 'open' }, async (app) => {
      expect(app.apiRouteTable).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'GET', url: '/api/health', public: true }),
        expect.objectContaining({ method: 'GET', url: '/api/stream', allowTokenQuery: true }),
        expect.objectContaining({ method: 'POST', url: '/api/private', public: false }),
      ]));
    });
  });
});

describe('scoped api keys (WO-5)', () => {
  const principal: ApiKeyPrincipal = {
    keyId: 'key_1',
    name: 'ext-test',
    capabilities: ['events:read'],
  };

  it('keeps the master token on full access, bypassing the key store', async () => {
    const store = storeWith(principal);
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/private',
        headers: { Authorization: 'Bearer secret' },
      });
      expect(res.statusCode).toBe(200);
      expect(store.touched).toEqual([]);
    }, store);
  });

  it('rejects a scoped key on an undeclared route — fail-closed master-only', async () => {
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/private',
        headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: 'Forbidden: this route requires the master API token',
        required_capability: null,
      });
    }, storeWith(principal));
  });

  it('grants a declared route when the capability is held, attaching the principal', async () => {
    const store = storeWith(principal);
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/scoped-events',
        headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().principal).toEqual(principal);
      expect(store.touched).toEqual(['key_1']);
    }, store);
  });

  it('returns a typed 403 naming the missing capability', async () => {
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/scoped-emit',
        headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: "Forbidden: this route requires the 'triggers:emit' capability",
        required_capability: 'triggers:emit',
      });
    }, storeWith(principal));
  });

  it('lets a parameterized emit grant unlock the flat emit route', async () => {
    const emitPrincipal: ApiKeyPrincipal = {
      keyId: 'key_2',
      name: 'ext-emit',
      capabilities: ['triggers:emit:custom.eval.*'],
    };
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/scoped-emit',
        headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    }, storeWith(emitPrincipal));
  });

  it('rejects revoked/expired/unknown keys with 401', async () => {
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/scoped-events',
        headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    }, storeWith(null)); // store returns no live key — covers revoked, expired, and unknown alike
  });

  it('rejects cmk_ tokens outright when no key store is wired', async () => {
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/scoped-events',
        headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  it('debounces last_used_at stamping within the window', async () => {
    const store = storeWith(principal);
    await withApp({ mode: 'enforce', token: 'secret' }, async (app) => {
      for (let i = 0; i < 3; i += 1) {
        await app.inject({
          method: 'GET',
          url: '/api/scoped-events',
          headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
        });
      }
      expect(store.touched).toEqual(['key_1']);
    }, store);
  });
});

describe('request log redaction', () => {
  it('redacts SSE query tokens without dropping other query params', () => {
    expect(
      redactAccessTokenInUrl('/api/agents/a1/stream?access_token=secret-token&cursor=5'),
    ).toBe('/api/agents/a1/stream?access_token=REDACTED&cursor=5');
  });

  it('serializes request logs with access_token removed', () => {
    expect(serializeRequestForLog({
      method: 'GET',
      url: '/api/agents/a1/stream?access_token=secret-token',
      headers: { host: 'localhost:3002' },
      socket: { remoteAddress: '127.0.0.1', remotePort: 1234 },
    })).toEqual({
      method: 'GET',
      url: '/api/agents/a1/stream?access_token=REDACTED',
      host: 'localhost:3002',
      remoteAddress: '127.0.0.1',
      remotePort: 1234,
    });
  });
});
