import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bypassesProxy,
  deriveRuntimeEgressRules,
  mintEgressLeaseToken,
  resolveEgressLeaseSecret,
  verifyEgressLeaseToken,
} from '../egress-lease.js';
import { egressRoutes, type EgressRouteOptions } from '../routes/egress.js';

const SECRET = 'lease-secret';
const SESSION = '3e98a63a-5c88-4f1d-80bd-a1d636545c4b';

describe('egress lease tokens', () => {
  it('round-trips the agent id and is bound to the session and secret', () => {
    const token = mintEgressLeaseToken(SESSION, 'agent-1', SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyEgressLeaseToken(SESSION, token, SECRET)).toEqual({ agentId: 'agent-1' });
    expect(verifyEgressLeaseToken('other-session', token, SECRET)).toBeNull();
    expect(verifyEgressLeaseToken(SESSION, token, 'other-secret')).toBeNull();
    // Deterministic, so a restored session presents the same lease.
    expect(mintEgressLeaseToken(SESSION, 'agent-1', SECRET)).toBe(token);
  });

  it('refuses tokens whose agent id was swapped or mangled', () => {
    const token = mintEgressLeaseToken(SESSION, 'agent-1', SECRET);
    const signature = token.split('.')[1];
    const swapped = `${Buffer.from('agent-2').toString('base64url')}.${signature}`;
    for (const candidate of [swapped, `${token}.extra`, `.${signature}`, `${token.split('.')[0]}.`, 'garbage', `a+b.${signature}`]) {
      expect(verifyEgressLeaseToken(SESSION, candidate, SECRET), candidate).toBeNull();
    }
  });

  it('signs with the callback secret, then the API token, then a per-process secret', () => {
    const warn = vi.fn();
    expect(resolveEgressLeaseSecret({ STABLEHAND_CALLBACK_TOKEN_SECRET: ' cb ', STABLEHAND_API_TOKEN: 'api' }, { warn })).toBe('cb');
    expect(resolveEgressLeaseSecret({ STABLEHAND_API_TOKEN: 'api' }, { warn })).toBe('api');
    const fallback = resolveEgressLeaseSecret({}, { warn });
    expect(fallback.length).toBeGreaterThan(20);
    expect(resolveEgressLeaseSecret({}, { warn })).toBe(fallback);
  });
});

describe('runtime egress rules', () => {
  it('reads NO_PROXY like curl does', () => {
    const noProxy = 'localhost,127.0.0.1,.internal.example,minio:9000,*.svc';
    expect(bypassesProxy('localhost', noProxy)).toBe(true);
    expect(bypassesProxy('minio', noProxy)).toBe(true);
    expect(bypassesProxy('s3.internal.example', noProxy)).toBe(true);
    expect(bypassesProxy('litellm.svc', noProxy)).toBe(true);
    expect(bypassesProxy('api.openai.com', noProxy)).toBe(false);
    expect(bypassesProxy('notminio', noProxy)).toBe(false);
    expect(bypassesProxy('anything', '*')).toBe(true);
  });

  it('adds only the runtime endpoints a sandbox reaches through the proxy', () => {
    const env = {
      STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
      STABLEHAND_MODEL_GATEWAY_URL: 'https://gateway.example.com',
      S3_ENDPOINT: 'http://minio:9000',
      OPENAI_BASE_URL: 'https://llm.example.org:8443/v1',
    };
    expect(deriveRuntimeEgressRules({ baseUrl: 'https://models.example.net/v1' }, env)).toEqual([
      '* gateway.example.com/**',
      '* llm.example.org:8443/**',
      '* models.example.net/**',
    ]);
  });

  it('adds nothing in the compose layout, where every runtime service is reached directly', () => {
    expect(deriveRuntimeEgressRules({}, {
      STABLEHAND_MODEL_GATEWAY_ENABLED: 'true',
      STABLEHAND_MODEL_GATEWAY_URL: 'http://litellm:4000',
      S3_ENDPOINT: 'http://minio:9000',
    })).toEqual([]);
    expect(deriveRuntimeEgressRules({}, {
      STABLEHAND_MODEL_GATEWAY_URL: 'https://gateway.example.com',
    }), 'gateway URL ignored while the gateway is disabled').toEqual([]);
    expect(deriveRuntimeEgressRules({ baseUrl: 'ftp://files.example.com' }, {})).toEqual([]);
    expect(deriveRuntimeEgressRules({ baseUrl: 'http://[2001:db8::1]:8080' }, {})).toEqual([]);
  });

  it('honours an operator NO_PROXY list', () => {
    expect(deriveRuntimeEgressRules({ baseUrl: 'https://models.example.net' }, {
      STABLEHAND_SANDBOX_NO_PROXY: 'models.example.net',
    })).toEqual([]);
  });
});

type FakeSession = { agentId: string; status: string };
type FakeAgent = { id: string; harnessConfig: string; metadata: Record<string, unknown> | null; manifest: Record<string, unknown> | null };

async function leaseApp(agents: Record<string, FakeAgent>, sessions: Record<string, FakeSession> = {}) {
  const app = Fastify();
  const db = {
    getAgent: async (id: string) => agents[id],
    getSandboxSession: async (id: string) => sessions[id] ?? null,
  } as unknown as EgressRouteOptions['db'];
  await app.register(egressRoutes, {
    prefix: '/api/egress',
    db,
    env: { STABLEHAND_API_TOKEN: SECRET, S3_ENDPOINT: 'https://s3.example.com' },
  });
  return app;
}

function agent(id: string, metadata: Record<string, unknown> | null = null, manifest: Record<string, unknown> | null = null): FakeAgent {
  return { id, harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }), metadata, manifest };
}

describe('POST /api/egress/lease', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function check(app: Awaited<ReturnType<typeof leaseApp>>, sessionId: string, token: string) {
    return app.inject({ method: 'POST', url: '/api/egress/lease', payload: { sessionId, token } });
  }

  it('answers a valid lease with the agent egress setting and runtime rules', async () => {
    const app = await leaseApp({ 'agent-1': agent('agent-1', { egress: { mode: 'deny' } }) });
    const res = await check(app, SESSION, mintEgressLeaseToken(SESSION, 'agent-1', SECRET));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      sessionId: SESSION,
      agentId: 'agent-1',
      egress: { mode: 'deny' },
      runtimeRules: ['* s3.example.com/**'],
      ttlSeconds: 30,
    });
  });

  it('falls back to the manifest, then to the server allowlist', async () => {
    const app = await leaseApp({
      manifested: agent('manifested', null, { spec: { egress: { mode: 'allow', rules: ['GET *'] } } }),
      plain: agent('plain'),
    });
    const fromManifest = await check(app, SESSION, mintEgressLeaseToken(SESSION, 'manifested', SECRET));
    expect(fromManifest.json().egress).toEqual({ mode: 'allow', rules: ['GET *'] });
    const plain = await check(app, SESSION, mintEgressLeaseToken(SESSION, 'plain', SECRET));
    expect(plain.json().egress).toEqual({ mode: 'default' });
  });

  it('refuses forged, foreign, ended and orphaned leases without saying why to forgers', async () => {
    const app = await leaseApp(
      { 'agent-1': agent('agent-1'), 'agent-2': agent('agent-2') },
      { [SESSION]: { agentId: 'agent-1', status: 'TERMINATED' }, 'live-session': { agentId: 'agent-1', status: 'ACTIVE' } },
    );
    const forged = await check(app, SESSION, mintEgressLeaseToken(SESSION, 'agent-1', 'wrong-secret'));
    expect([forged.statusCode, forged.json().code]).toEqual([401, 'invalid_lease']);
    const foreign = await check(app, 'live-session', mintEgressLeaseToken('live-session', 'agent-2', SECRET));
    expect([foreign.statusCode, foreign.json().code]).toEqual([401, 'invalid_lease']);
    const ended = await check(app, SESSION, mintEgressLeaseToken(SESSION, 'agent-1', SECRET));
    expect([ended.statusCode, ended.json().code]).toEqual([410, 'session_ended']);
    const orphan = await check(app, 'new-session', mintEgressLeaseToken('new-session', 'deleted-agent', SECRET));
    expect([orphan.statusCode, orphan.json().code]).toEqual([404, 'agent_not_found']);
    const malformed = await app.inject({ method: 'POST', url: '/api/egress/lease', payload: { sessionId: SESSION } });
    expect(malformed.statusCode).toBe(400);
  });
});
