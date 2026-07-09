import { describe, it, expect, vi } from 'vitest';
import {
  createGuardedFetch,
  resolveEgressPolicy,
  EgressBlockedError,
  type EgressPolicy,
} from '../egress.js';

function policy(overrides: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    enforce: true,
    allowlist: [],
    allowlistOnly: false,
    maxRedirects: 5,
    ...overrides,
  };
}

function okResponse(): Response {
  return new Response('ok', { status: 200 });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('resolveEgressPolicy', () => {
  it('defaults to enforcing with no allowlist', () => {
    const p = resolveEgressPolicy({});
    expect(p.enforce).toBe(true);
    expect(p.allowlist).toEqual([]);
    expect(p.allowlistOnly).toBe(false);
    expect(p.maxRedirects).toBe(5);
  });

  it('parses env overrides', () => {
    const p = resolveEgressPolicy({
      CTXMILL_EGRESS_ENFORCE: 'false',
      CTXMILL_EGRESS_ALLOWLIST: 'internal.example.com, *.corp.example ',
      CTXMILL_EGRESS_ALLOWLIST_ONLY: 'true',
      CTXMILL_EGRESS_MAX_REDIRECTS: '2',
    } as NodeJS.ProcessEnv);
    expect(p.enforce).toBe(false);
    expect(p.allowlist).toEqual(['internal.example.com', '*.corp.example']);
    expect(p.allowlistOnly).toBe(true);
    expect(p.maxRedirects).toBe(2);
  });
});

describe('createGuardedFetch — blocked destinations', () => {
  it('blocks the cloud metadata endpoint (link-local)', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    await expect(guarded('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(EgressBlockedError);
    expect(base).not.toHaveBeenCalled();
  });

  it('blocks loopback', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    await expect(guarded('http://127.0.0.1:5432/')).rejects.toBeInstanceOf(EgressBlockedError);
    expect(base).not.toHaveBeenCalled();
  });

  it('blocks RFC1918 private ranges', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    for (const url of ['http://10.0.0.5/', 'http://172.16.0.1/', 'http://192.168.1.1/']) {
      await expect(guarded(url)).rejects.toBeInstanceOf(EgressBlockedError);
    }
    expect(base).not.toHaveBeenCalled();
  });

  it('blocks localhost and internal hostnames by name', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    for (const url of ['http://localhost/', 'http://postgres.internal/', 'http://db.local/']) {
      await expect(guarded(url)).rejects.toBeInstanceOf(EgressBlockedError);
    }
    expect(base).not.toHaveBeenCalled();
  });

  it('blocks IPv6 loopback and IPv4-mapped metadata', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    await expect(guarded('http://[::1]/')).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(guarded('http://[::ffff:169.254.169.254]/')).rejects.toBeInstanceOf(EgressBlockedError);
    expect(base).not.toHaveBeenCalled();
  });

  it('blocks non-http(s) schemes', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    await expect(guarded('file:///etc/passwd')).rejects.toBeInstanceOf(EgressBlockedError);
    expect(base).not.toHaveBeenCalled();
  });
});

describe('createGuardedFetch — allowed destinations', () => {
  it('allows public addresses', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    const resp = await guarded('http://93.184.216.34/');
    expect(resp.status).toBe(200);
    expect(base).toHaveBeenCalledOnce();
  });

  it('reaches a private host when allowlisted', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(
      policy({ allowlist: ['internal-api.svc'] }),
      base as unknown as typeof fetch,
    );
    // Would otherwise require DNS; allowlist short-circuits the address check.
    const resp = await guarded('http://internal-api.svc/hook');
    expect(resp.status).toBe(200);
  });

  it('supports wildcard allowlist patterns', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(
      policy({ allowlist: ['*.corp.example'] }),
      base as unknown as typeof fetch,
    );
    expect((await guarded('http://a.corp.example/')).status).toBe(200);
    expect((await guarded('http://corp.example/')).status).toBe(200);
  });

  it('denies everything except the allowlist when allowlistOnly is set', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(
      policy({ allowlist: ['trusted.example.com'], allowlistOnly: true }),
      base as unknown as typeof fetch,
    );
    expect((await guarded('http://trusted.example.com/')).status).toBe(200);
    await expect(guarded('http://93.184.216.34/')).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('does not block private ranges when enforcement is off', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(policy({ enforce: false }), base as unknown as typeof fetch);
    const resp = await guarded('http://10.0.0.5/');
    expect(resp.status).toBe(200);
  });
});

describe('createGuardedFetch — redirects', () => {
  it('re-validates redirect targets and blocks a redirect to a private address', async () => {
    const base = vi.fn(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('http://93.184.216.34')) {
        return redirectResponse('http://169.254.169.254/latest/meta-data/');
      }
      return okResponse();
    });
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    await expect(guarded('http://93.184.216.34/')).rejects.toBeInstanceOf(EgressBlockedError);
    // First hop (public) was fetched, but the redirect target was never fetched.
    expect(base).toHaveBeenCalledOnce();
  });

  it('follows a redirect to another public host', async () => {
    const base = vi.fn(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('http://93.184.216.34')) {
        return redirectResponse('http://93.184.216.35/next');
      }
      return okResponse();
    });
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    const resp = await guarded('http://93.184.216.34/');
    expect(resp.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('caps redirect chains', async () => {
    const base = vi.fn(async () => redirectResponse('http://93.184.216.34/loop'));
    const guarded = createGuardedFetch(policy({ maxRedirects: 2 }), base as unknown as typeof fetch);
    await expect(guarded('http://93.184.216.34/')).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('forces requests through redirect: manual so the wrapper controls hops', async () => {
    const base = vi.fn(async () => okResponse());
    const guarded = createGuardedFetch(policy(), base as unknown as typeof fetch);
    await guarded('http://93.184.216.34/', { method: 'POST', body: 'x' });
    expect(base).toHaveBeenCalledWith(
      'http://93.184.216.34/',
      expect.objectContaining({ redirect: 'manual', method: 'POST' }),
    );
  });
});
