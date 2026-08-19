import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import {
  API_KEY_TOKEN_PREFIX,
  CAPABILITY_VERBS,
  capabilitySatisfies,
  type CapabilityVerb,
} from '@ctxmill/contracts';

export type ApiAuthConfig =
  | { mode: 'enforce'; token: string }
  | { mode: 'open' };

/** Attached to the request when a scoped key (WO-5) authenticated it. */
export interface ApiKeyPrincipal {
  keyId: string;
  name: string;
  capabilities: readonly string[];
  /** ctx-k6ad: agent this key is scoped to, or null for an all-agents key. */
  agentId: string | null;
}

/** Storage seam for scoped keys; implemented by the database repository. */
export interface ApiKeyStore {
  findLiveKeyByTokenHash(tokenHash: string): Promise<ApiKeyPrincipal | null>;
  /** Cheap database-backed liveness check for already-authenticated streams. */
  isLiveKey(keyId: string): Promise<boolean>;
  /** Fire-and-forget audit stamp; the middleware debounces calls per key. */
  touchLastUsed(keyId: string): Promise<void>;
}

const LAST_USED_DEBOUNCE_MS = 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    /** Scoped-key principal (WO-5); null for master-token and open-mode requests. */
    apiPrincipal: ApiKeyPrincipal | null;
    /** Rechecks expiry/revocation for a scoped principal; null for master/open requests. */
    revalidateApiPrincipal: (() => Promise<boolean>) | null;
  }

  interface FastifyContextConfig {
    /** Capability required for scoped keys (WO-5); undeclared = master-only, fail-closed. */
    capability?: CapabilityVerb;
  }
}

export interface ApiRouteRecord {
  method: string;
  url: string;
  public: boolean;
  allowTokenQuery: boolean;
  capability?: CapabilityVerb;
}

interface ApiAuthLogger {
  warn: (message: string) => void;
}

type ApiAuthEnv = Readonly<Record<string, string | undefined>>;

const BEARER_REALM = 'Bearer realm="ctxmill"';
const UNAUTHORIZED_BODY = { error: 'Unauthorized: missing or invalid API token' };
const REDACTED_QUERY_VALUE = 'REDACTED';
const ROUTE_CAPABILITIES: ReadonlySet<string> = new Set(CAPABILITY_VERBS);

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokensEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(hashToken(presented), hashToken(expected));
}

function readBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function readHost(record: Record<string, unknown>): string | undefined {
  const hostname = readStringField(record, 'hostname');
  if (hostname) return hostname;

  const headers = record.headers;
  if (!isRecord(headers)) return undefined;
  const host = headers.host;
  if (typeof host === 'string') return host;
  if (Array.isArray(host) && typeof host[0] === 'string') return host[0];
  return undefined;
}

function readSocketRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const socket = record.socket;
  if (isRecord(socket)) return socket;

  const raw = record.raw;
  if (!isRecord(raw)) return undefined;
  const rawSocket = raw.socket;
  return isRecord(rawSocket) ? rawSocket : undefined;
}

export function redactAccessTokenInUrl(rawUrl: string): string {
  if (!rawUrl.includes('access_token=')) return rawUrl;

  try {
    const url = new URL(rawUrl, 'http://ctxmill.local');
    if (!url.searchParams.has('access_token')) return rawUrl;
    url.searchParams.set('access_token', REDACTED_QUERY_VALUE);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return rawUrl.replace(/([?&]access_token=)[^&#]*/gi, `$1${REDACTED_QUERY_VALUE}`);
  }
}

export function serializeRequestForLog(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) return {};

  const socket = readSocketRecord(request);
  return {
    method: readStringField(request, 'method'),
    url: redactAccessTokenInUrl(readStringField(request, 'url') ?? ''),
    host: readHost(request),
    remoteAddress:
      readStringField(request, 'ip')
      ?? (socket ? readStringField(socket, 'remoteAddress') : undefined),
    remotePort: socket ? readNumberField(socket, 'remotePort') : undefined,
  };
}

function readQueryToken(request: FastifyRequest): string | undefined {
  const url = new URL(request.url, 'http://ctxmill.local');
  const token = url.searchParams.get('access_token');
  return token && token.length > 0 ? token : undefined;
}

function routeConfig(request: FastifyRequest): FastifyRequest['routeOptions']['config'] | undefined {
  return request.routeOptions?.config;
}

function pathnameFor(request: FastifyRequest): string {
  return new URL(request.url, 'http://ctxmill.local').pathname;
}

function unauthorized(reply: FastifyReply) {
  return reply
    .header('www-authenticate', BEARER_REALM)
    .code(401)
    .send(UNAUTHORIZED_BODY);
}

function forbiddenMissingCapability(reply: FastifyReply, required: string) {
  return reply.code(403).send({
    error: `Forbidden: this route requires the '${required}' capability`,
    requiredCapability: required,
  });
}

function forbiddenMasterOnly(reply: FastifyReply) {
  // Fail-closed (WO-5 D3): routes without a declared capability are
  // master-only forever; a forgotten annotation can only narrow access.
  return reply.code(403).send({
    error: 'Forbidden: this route requires the master API token',
    requiredCapability: null,
  });
}

function sha256Hex(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readRouteCapability(
  config: FastifyRequest['routeOptions']['config'] | undefined,
): CapabilityVerb | undefined {
  const capability = (config as Record<string, unknown> | undefined)?.capability;
  return typeof capability === 'string' && ROUTE_CAPABILITIES.has(capability)
    ? capability as CapabilityVerb
    : undefined;
}

function recordRoute(routeTable: ApiRouteRecord[], route: RouteOptions): void {
  const configuredCapability = (route.config as Record<string, unknown> | undefined)?.capability;
  if (configuredCapability !== undefined && (
    typeof configuredCapability !== 'string'
    || !ROUTE_CAPABILITIES.has(configuredCapability)
  )) {
    throw new Error(`Unknown API route capability '${String(configuredCapability)}'`);
  }
  const capability = configuredCapability as CapabilityVerb | undefined;
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  for (const method of methods) {
    routeTable.push({
      method: String(method).toUpperCase(),
      url: route.url,
      public: route.config?.public === true,
      allowTokenQuery: route.config?.allowTokenQuery === true,
      ...(capability ? { capability } : {}),
    });
  }
}

export function resolveApiAuthConfig(
  env: ApiAuthEnv = process.env,
  logger: ApiAuthLogger = console,
): ApiAuthConfig {
  const token = env.CTXMILL_API_TOKEN?.trim();
  if (token) {
    return { mode: 'enforce', token };
  }

  if (env.CTXMILL_AUTH_DISABLED === 'true') {
    logger.warn(
      'WARNING: CTXMILL_AUTH_DISABLED=true; /api control-plane authentication is disabled.',
    );
    return { mode: 'open' };
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL: CTXMILL_API_TOKEN is required when NODE_ENV=production. '
      + 'Generate one with: openssl rand -hex 32',
    );
  }

  logger.warn(
    'WARNING: CTXMILL_API_TOKEN is not set; /api control-plane authentication is disabled outside production.',
  );
  return { mode: 'open' };
}

export function registerApiAuth(
  app: FastifyInstance,
  config: ApiAuthConfig,
  keyStore?: ApiKeyStore,
): void {
  const routeTable: ApiRouteRecord[] = [];
  const lastUsedTouchedAt = new Map<string, number>();

  app.decorate<ApiAuthConfig>('apiAuth', config);
  app.decorate<ApiRouteRecord[]>('apiRouteTable', routeTable);
  app.decorateRequest<ApiKeyPrincipal | null>('apiPrincipal', null);
  app.decorateRequest<(() => Promise<boolean>) | null>('revalidateApiPrincipal', null);

  app.addHook('onRoute', (route) => {
    recordRoute(routeTable, route);
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;

    const pathname = pathnameFor(request);
    if (!isApiPath(pathname)) return;

    const configForRoute = routeConfig(request);
    if (configForRoute?.public === true) return;

    if (config.mode === 'open') return;

    const presented =
      readBearerToken(request)
      ?? (configForRoute?.allowTokenQuery === true ? readQueryToken(request) : undefined);

    if (!presented) {
      return unauthorized(reply);
    }

    if (tokensEqual(presented, config.token)) {
      return; // master token — full access, unchanged behavior
    }

    if (!keyStore || !presented.startsWith(API_KEY_TOKEN_PREFIX)) {
      return unauthorized(reply);
    }

    const principal = await keyStore.findLiveKeyByTokenHash(sha256Hex(presented));
    if (!principal) {
      return unauthorized(reply);
    }

    request.apiPrincipal = principal;
    request.revalidateApiPrincipal = () => keyStore.isLiveKey(principal.keyId);

    const now = Date.now();
    const touchedAt = lastUsedTouchedAt.get(principal.keyId) ?? 0;
    if (now - touchedAt >= LAST_USED_DEBOUNCE_MS) {
      lastUsedTouchedAt.set(principal.keyId, now);
      void keyStore.touchLastUsed(principal.keyId).catch((err) => {
        request.log.warn({ err, keyId: principal.keyId }, 'failed to stamp api key last_used_at');
      });
    }

    request.log.info({ keyId: principal.keyId, keyName: principal.name }, 'scoped api key request');

    const requiredCapability = readRouteCapability(configForRoute);
    if (requiredCapability === undefined) {
      return forbiddenMasterOnly(reply);
    }
    if (!capabilitySatisfies(principal.capabilities, requiredCapability)) {
      return forbiddenMissingCapability(reply, requiredCapability);
    }
  });
}
