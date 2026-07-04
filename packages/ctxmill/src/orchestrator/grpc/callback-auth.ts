import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';

export const CALLBACK_SESSION_HEADER = 'x-ctxmill-callback-session-id';
export const CALLBACK_AGENT_HEADER = 'x-ctxmill-callback-agent-id';
export const CALLBACK_TOKEN_HEADER = 'x-ctxmill-callback-token';

export const CALLBACK_SESSION_ENV = 'CTXMILL_CALLBACK_SESSION_ID';
export const CALLBACK_AGENT_ENV = 'CTXMILL_CALLBACK_AGENT_ID';
export const CALLBACK_TOKEN_ENV = 'CTXMILL_CALLBACK_TOKEN';

const CALLBACK_TOKEN_CONTEXT = 'ctxmill-callback-v1';

export type GrpcCallbackAuthConfig =
  | { mode: 'enforce'; secret: string }
  | { mode: 'open' };

type CallbackAuthEnv = Readonly<Record<string, string | undefined>>;

interface CallbackAuthLogger {
  warn: (message: string) => void;
}

interface MessageIdentity {
  agentIds: string[];
}

function nonEmptyTrimmed(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokensEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(digestToken(presented), digestToken(expected));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? nonEmptyTrimmed(value) : undefined;
}

function readPayloadAgentId(payloadJson: string): string | undefined {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (!isRecord(payload)) return undefined;
    return readString(payload, 'agentId');
  } catch {
    return undefined;
  }
}

function readMessageIdentity(message: unknown): MessageIdentity {
  const agentIds = new Set<string>();

  if (!isRecord(message)) {
    return { agentIds: [] };
  }

  const directAgentId = readString(message, 'agentId');
  if (directAgentId) agentIds.add(directAgentId);

  const artifact = message.artifact;
  if (isRecord(artifact)) {
    const artifactAgentId = readString(artifact, 'agentId');
    if (artifactAgentId) agentIds.add(artifactAgentId);
  }

  const payloadJson = readString(message, 'payloadJson');
  if (payloadJson) {
    const payloadAgentId = readPayloadAgentId(payloadJson);
    if (payloadAgentId) agentIds.add(payloadAgentId);
  }

  return {
    agentIds: Array.from(agentIds),
  };
}

function unauthorized(): never {
  throw new ConnectError('Unauthorized sandbox callback', Code.Unauthenticated);
}

function denied(message: string): never {
  throw new ConnectError(message, Code.PermissionDenied);
}

export function resolveGrpcCallbackAuthConfig(
  env: CallbackAuthEnv = process.env,
  logger: CallbackAuthLogger = console,
): GrpcCallbackAuthConfig {
  const callbackSecret = nonEmptyTrimmed(env.CTXMILL_CALLBACK_TOKEN_SECRET);
  const apiToken = nonEmptyTrimmed(env.CTXMILL_API_TOKEN);
  const secret = callbackSecret ?? apiToken;
  if (secret) {
    return { mode: 'enforce', secret };
  }

  if (env.CTXMILL_AUTH_DISABLED === 'true') {
    logger.warn(
      'WARNING: CTXMILL_AUTH_DISABLED=true; sandbox callback authentication is disabled.',
    );
    return { mode: 'open' };
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL: CTXMILL_CALLBACK_TOKEN_SECRET or CTXMILL_API_TOKEN is required when NODE_ENV=production. '
      + 'Generate one with: openssl rand -hex 32',
    );
  }

  logger.warn(
    'WARNING: CTXMILL_CALLBACK_TOKEN_SECRET and CTXMILL_API_TOKEN are not set; '
    + 'sandbox callback authentication is disabled outside production.',
  );
  return { mode: 'open' };
}

export function mintGrpcCallbackToken(sessionId: string, agentId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${CALLBACK_TOKEN_CONTEXT}:${sessionId}:${agentId}`)
    .digest('base64url');
}

export function getGrpcCallbackSandboxSecrets(
  sessionId: string,
  agentId: string,
  config: GrpcCallbackAuthConfig = resolveGrpcCallbackAuthConfig(process.env, { warn: () => undefined }),
): Record<string, string> {
  if (config.mode === 'open') {
    return {};
  }

  return {
    [CALLBACK_SESSION_ENV]: sessionId,
    [CALLBACK_AGENT_ENV]: agentId,
    [CALLBACK_TOKEN_ENV]: mintGrpcCallbackToken(sessionId, agentId, config.secret),
  };
}

export function validateGrpcCallbackAuth(
  config: GrpcCallbackAuthConfig,
  headers: Headers,
  message?: unknown,
): void {
  if (config.mode === 'open') {
    return;
  }

  const sessionId = nonEmptyTrimmed(headers.get(CALLBACK_SESSION_HEADER));
  const agentId = nonEmptyTrimmed(headers.get(CALLBACK_AGENT_HEADER));
  const token = nonEmptyTrimmed(headers.get(CALLBACK_TOKEN_HEADER));
  if (!sessionId || !agentId || !token) {
    unauthorized();
  }

  const expectedToken = mintGrpcCallbackToken(sessionId, agentId, config.secret);
  if (!tokensEqual(token, expectedToken)) {
    unauthorized();
  }

  const identity = readMessageIdentity(message);
  for (const messageAgentId of identity.agentIds) {
    if (messageAgentId !== agentId) {
      denied('Sandbox callback agent mismatch');
    }
  }
}

export function createGrpcCallbackAuthInterceptor(config: GrpcCallbackAuthConfig): Interceptor | undefined {
  if (config.mode === 'open') {
    return undefined;
  }

  return (next) => async (req) => {
    validateGrpcCallbackAuth(
      config,
      req.header,
      req.stream ? undefined : req.message,
    );
    return await next(req);
  };
}
