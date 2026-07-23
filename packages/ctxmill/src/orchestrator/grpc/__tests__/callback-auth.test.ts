import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it, vi } from 'vitest';

import {
  CALLBACK_AGENT_ENV,
  CALLBACK_AGENT_HEADER,
  CALLBACK_SESSION_ENV,
  CALLBACK_SESSION_HEADER,
  CALLBACK_TOKEN_ENV,
  CALLBACK_TOKEN_HEADER,
  getGrpcCallbackSandboxSecrets,
  mintGrpcCallbackToken,
  resolveGrpcCallbackAuthConfig,
  validateGrpcCallbackAuth,
  type GrpcCallbackAuthConfig,
} from '../callback-auth.js';

const SERVER_SECRET = 'server-secret';

const ENFORCED_CONFIG: GrpcCallbackAuthConfig = {
  mode: 'enforce',
  secret: SERVER_SECRET,
};

function headersFor(
  sessionId = 'session-1',
  agentId = 'agent-1',
  secret = SERVER_SECRET,
): Headers {
  return new Headers({
    [CALLBACK_SESSION_HEADER]: sessionId,
    [CALLBACK_AGENT_HEADER]: agentId,
    [CALLBACK_TOKEN_HEADER]: mintGrpcCallbackToken(sessionId, agentId, secret),
  });
}

function expectConnectCode(fn: () => void, code: Code): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectError);
    if (!(err instanceof ConnectError)) {
      throw err;
    }
    expect(err.code).toBe(code);
    return;
  }

  throw new Error(`Expected ConnectError code ${code}`);
}

describe('resolveGrpcCallbackAuthConfig', () => {
  it('prefers a dedicated callback secret over the API token', () => {
    expect(resolveGrpcCallbackAuthConfig({
      NODE_ENV: 'production',
      CTXMILL_CALLBACK_TOKEN_SECRET: ' callback-secret ',
      CTXMILL_API_TOKEN: 'api-secret',
    })).toEqual({ mode: 'enforce', secret: 'callback-secret' });
  });

  it('falls back to the API token when no dedicated callback secret is set', () => {
    expect(resolveGrpcCallbackAuthConfig({
      NODE_ENV: 'production',
      CTXMILL_API_TOKEN: ' api-secret ',
    })).toEqual({ mode: 'enforce', secret: 'api-secret' });
  });

  it('fails closed in production without a callback or API token', () => {
    expect(() => resolveGrpcCallbackAuthConfig({ NODE_ENV: 'production' })).toThrow(/CTXMILL_CALLBACK_TOKEN_SECRET/);
    expect(() => resolveGrpcCallbackAuthConfig({ NODE_ENV: 'production' })).toThrow(/openssl rand/);
  });

  it('stays open outside production and warns', () => {
    const logger = { warn: vi.fn() };

    expect(resolveGrpcCallbackAuthConfig({ NODE_ENV: 'test' }, logger)).toEqual({ mode: 'open' });
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('getGrpcCallbackSandboxSecrets', () => {
  it('propagates non-secret callback identity when callback auth is open', () => {
    expect(getGrpcCallbackSandboxSecrets('session-1', 'agent-1', { mode: 'open' })).toEqual({
      [CALLBACK_SESSION_ENV]: 'session-1',
      [CALLBACK_AGENT_ENV]: 'agent-1',
    });
  });

  it('returns a session-scoped callback token env set when auth is enforced', () => {
    expect(getGrpcCallbackSandboxSecrets('session-1', 'agent-1', ENFORCED_CONFIG)).toEqual({
      [CALLBACK_SESSION_ENV]: 'session-1',
      [CALLBACK_AGENT_ENV]: 'agent-1',
      [CALLBACK_TOKEN_ENV]: mintGrpcCallbackToken('session-1', 'agent-1', SERVER_SECRET),
    });
  });
});

describe('validateGrpcCallbackAuth', () => {
  it('accepts a valid token whose identity matches the request message', () => {
    expect(() => validateGrpcCallbackAuth(ENFORCED_CONFIG, headersFor(), {
      sandboxSessionId: 'session-1',
      agentId: 'agent-1',
      toolName: 'emit-event',
    })).not.toThrow();
  });

  it('requires the canonical request sandbox session to match authenticated headers', () => {
    expectConnectCode(
      () => validateGrpcCallbackAuth(ENFORCED_CONFIG, headersFor('sandbox-session-1'), {
        sandboxSessionId: 'other-session',
        agentId: 'agent-1',
      }),
      Code.PermissionDenied,
    );
  });

  it('rejects delivery callbacks that omit the canonical sandbox session identity', () => {
    expectConnectCode(
      () => validateGrpcCallbackAuth(ENFORCED_CONFIG, headersFor(), {
        turnId: 'turn-1',
        agentId: 'agent-1',
      }),
      Code.PermissionDenied,
    );
  });

  it('does not confuse turn IDs with canonical sandbox session IDs', () => {
    expect(() => validateGrpcCallbackAuth(ENFORCED_CONFIG, headersFor('sandbox-session-1'), {
      sandboxSessionId: 'sandbox-session-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      artifact: {
        turnId: 'turn-1',
        agentId: 'agent-1',
      },
    })).not.toThrow();
  });

  it('rejects missing or invalid callback credentials', () => {
    expectConnectCode(
      () => validateGrpcCallbackAuth(ENFORCED_CONFIG, new Headers(), { sessionId: 'session-1' }),
      Code.Unauthenticated,
    );

    const headers = headersFor();
    headers.set(CALLBACK_TOKEN_HEADER, 'wrong-token');
    expectConnectCode(
      () => validateGrpcCallbackAuth(ENFORCED_CONFIG, headers, { sessionId: 'turn-1' }),
      Code.Unauthenticated,
    );
  });

  it('rejects direct, nested artifact, and event-payload agent mismatches', () => {
    expectConnectCode(
      () => validateGrpcCallbackAuth(ENFORCED_CONFIG, headersFor(), {
        sessionId: 'session-1',
        agentId: 'other-agent',
      }),
      Code.PermissionDenied,
    );

    expectConnectCode(
      () => validateGrpcCallbackAuth(ENFORCED_CONFIG, headersFor(), {
        sessionId: 'session-1',
        agentId: 'agent-1',
        artifact: {
          sessionId: 'session-1',
          agentId: 'other-agent',
        },
      }),
      Code.PermissionDenied,
    );

    expectConnectCode(
      () => validateGrpcCallbackAuth(ENFORCED_CONFIG, headersFor(), {
        sessionId: 'session-1',
        payloadJson: '{"agentId":"other-agent"}',
      }),
      Code.PermissionDenied,
    );
  });
});
