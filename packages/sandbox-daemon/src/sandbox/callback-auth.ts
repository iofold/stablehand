import type { Interceptor } from '@connectrpc/connect';

export const CALLBACK_SESSION_HEADER = 'x-ctxmill-callback-session-id';
export const CALLBACK_AGENT_HEADER = 'x-ctxmill-callback-agent-id';
export const CALLBACK_TOKEN_HEADER = 'x-ctxmill-callback-token';

export const CALLBACK_SESSION_ENV = 'CTXMILL_CALLBACK_SESSION_ID';
export const CALLBACK_AGENT_ENV = 'CTXMILL_CALLBACK_AGENT_ID';
export const CALLBACK_TOKEN_ENV = 'CTXMILL_CALLBACK_TOKEN';

type CallbackAuthEnv = Readonly<Record<string, string | undefined>>;

export interface SandboxCallbackAuthIdentity {
  sessionId: string;
  agentId: string;
  token: string;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getSandboxCallbackAuthIdentity(
  env: CallbackAuthEnv = process.env,
): SandboxCallbackAuthIdentity | undefined {
  const sessionId = nonEmptyTrimmed(env[CALLBACK_SESSION_ENV]);
  const agentId = nonEmptyTrimmed(env[CALLBACK_AGENT_ENV]);
  const token = nonEmptyTrimmed(env[CALLBACK_TOKEN_ENV]);

  if (!sessionId || !agentId || !token) {
    return undefined;
  }

  return { sessionId, agentId, token };
}

export function applySandboxCallbackAuthHeaders(
  headers: Headers,
  identity: SandboxCallbackAuthIdentity,
): void {
  headers.set(CALLBACK_SESSION_HEADER, identity.sessionId);
  headers.set(CALLBACK_AGENT_HEADER, identity.agentId);
  headers.set(CALLBACK_TOKEN_HEADER, identity.token);
}

export function createSandboxCallbackAuthInterceptor(
  env: CallbackAuthEnv = process.env,
): Interceptor | undefined {
  const identity = getSandboxCallbackAuthIdentity(env);
  if (!identity) {
    return undefined;
  }

  return (next) => async (req) => {
    applySandboxCallbackAuthHeaders(req.header, identity);
    return await next(req);
  };
}
