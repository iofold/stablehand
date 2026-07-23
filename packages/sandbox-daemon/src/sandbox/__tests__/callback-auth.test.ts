import { describe, expect, it } from 'vitest';

import {
  CALLBACK_AGENT_ENV,
  CALLBACK_AGENT_HEADER,
  CALLBACK_SESSION_ENV,
  CALLBACK_SESSION_HEADER,
  CALLBACK_TOKEN_ENV,
  CALLBACK_TOKEN_HEADER,
  applySandboxCallbackAuthHeaders,
  createSandboxCallbackAuthInterceptor,
  getSandboxCallbackAuthIdentity,
} from '../callback-auth.js';

describe('sandbox callback auth', () => {
  it('reads complete callback credentials from sandbox env', () => {
    expect(getSandboxCallbackAuthIdentity({
      [CALLBACK_SESSION_ENV]: ' session-1 ',
      [CALLBACK_AGENT_ENV]: ' agent-1 ',
      [CALLBACK_TOKEN_ENV]: ' token-1 ',
    })).toEqual({
      sandboxSessionId: 'session-1',
      agentId: 'agent-1',
      token: 'token-1',
    });
  });

  it('ignores partial callback credential env sets', () => {
    expect(getSandboxCallbackAuthIdentity({
      [CALLBACK_SESSION_ENV]: 'session-1',
      [CALLBACK_TOKEN_ENV]: 'token-1',
    })).toBeUndefined();
  });

  it('preserves session and agent identity without a token in open-auth mode', () => {
    expect(getSandboxCallbackAuthIdentity({
      [CALLBACK_SESSION_ENV]: 'session-1',
      [CALLBACK_AGENT_ENV]: 'agent-1',
    })).toEqual({
      sandboxSessionId: 'session-1',
      agentId: 'agent-1',
    });
  });

  it('applies callback credentials to ConnectRPC request headers', () => {
    const headers = new Headers();

    applySandboxCallbackAuthHeaders(headers, {
      sandboxSessionId: 'session-1',
      agentId: 'agent-1',
      token: 'token-1',
    });

    expect(headers.get(CALLBACK_SESSION_HEADER)).toBe('session-1');
    expect(headers.get(CALLBACK_AGENT_HEADER)).toBe('agent-1');
    expect(headers.get(CALLBACK_TOKEN_HEADER)).toBe('token-1');
  });

  it('applies non-secret callback identity without fabricating a token', async () => {
    const interceptor = createSandboxCallbackAuthInterceptor({
      [CALLBACK_SESSION_ENV]: 'session-1',
      [CALLBACK_AGENT_ENV]: 'agent-1',
    });
    let appliedHeaders: Headers | undefined;
    const next = async (request: { header: Headers }) => {
      appliedHeaders = request.header;
      return {};
    };
    const request = { header: new Headers() };

    await interceptor!(next as never)(request as never);

    expect(appliedHeaders?.get(CALLBACK_SESSION_HEADER)).toBe('session-1');
    expect(appliedHeaders?.get(CALLBACK_AGENT_HEADER)).toBe('agent-1');
    expect(appliedHeaders?.get(CALLBACK_TOKEN_HEADER)).toBeNull();
  });
});
