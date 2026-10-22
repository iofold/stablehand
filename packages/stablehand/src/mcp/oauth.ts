import { randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { SecretProvider } from '../secrets/types.js';
import { TOOL_SECRET_SCOPE_ID } from '../secrets/scopes.js';

/**
 * OAuth for remote MCP servers, bound to one (agent, server) pair: the
 * per-agent binding from the 2026-09-09 audit (B.3). One person connects the
 * account once; the orchestrator keeps and refreshes the tokens.
 *
 * Everything is stored as one encrypted JSON value in the agent's tools-scope
 * secrets (`MCP_OAUTH__<server>`), so tokens never reach the sandbox, never
 * appear in checkpoints, and do not change the runtime fingerprint when they
 * refresh.
 */
export interface McpOAuthPending {
  state: string;
  codeVerifier?: string;
  redirectUri: string;
  expiresAt: number;
}

export interface McpOAuthRecord {
  version: 1;
  /** The redirect URI the stored client registration was made with. */
  redirectUri?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
  pending?: McpOAuthPending;
  connectedAt?: number;
}

export interface McpOAuthStore {
  load(): Promise<McpOAuthRecord>;
  update(mutate: (record: McpOAuthRecord) => McpOAuthRecord | void): Promise<McpOAuthRecord>;
  clear(): Promise<void>;
}

export const MCP_OAUTH_PENDING_TTL_MS = 10 * 60_000;

export function mcpOAuthSecretKey(serverName: string): string {
  return `MCP_OAUTH__${serverName}`;
}

function emptyRecord(): McpOAuthRecord {
  return { version: 1 };
}

function parseRecord(raw: string | null): McpOAuthRecord {
  if (!raw) return emptyRecord();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === 1) {
      return parsed as McpOAuthRecord;
    }
    return emptyRecord();
  } catch (error) {
    console.warn('[mcp-oauth] stored OAuth record is not valid JSON; starting over', error instanceof Error ? error.message : error);
    return emptyRecord();
  }
}

/** Serializes read-modify-write per key so two refreshes cannot clobber each other. */
const recordLocks = new Map<string, Promise<unknown>>();

async function withRecordLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = recordLocks.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(() => undefined, () => undefined);
  recordLocks.set(key, settled);
  try {
    return await next;
  } finally {
    if (recordLocks.get(key) === settled) {
      recordLocks.delete(key);
    }
  }
}

export function secretBackedOAuthStore(
  secretProvider: SecretProvider,
  agentId: string,
  serverName: string,
): McpOAuthStore {
  const key = mcpOAuthSecretKey(serverName);
  const lockKey = `${agentId}\u0000${key}`;
  const read = async () => parseRecord(await secretProvider.get(agentId, key, TOOL_SECRET_SCOPE_ID));
  return {
    load: read,
    update: (mutate) => withRecordLock(lockKey, async () => {
      const current = await read();
      const next = mutate(current) ?? current;
      await secretProvider.set(agentId, key, JSON.stringify(next), TOOL_SECRET_SCOPE_ID);
      return next;
    }),
    clear: () => withRecordLock(lockKey, async () => {
      await secretProvider.delete(agentId, key, TOOL_SECRET_SCOPE_ID);
    }),
  };
}

/** In-memory store for tests and one-off scripts. */
export function memoryOAuthStore(initial: McpOAuthRecord = emptyRecord()): McpOAuthStore & { snapshot(): McpOAuthRecord } {
  let record = structuredClone(initial);
  return {
    load: async () => structuredClone(record),
    update: async (mutate) => {
      const draft = structuredClone(record);
      record = mutate(draft) ?? draft;
      return structuredClone(record);
    },
    clear: async () => {
      record = emptyRecord();
    },
    snapshot: () => structuredClone(record),
  };
}

// ── state parameter ────────────────────────────────────────────────────

/**
 * The OAuth `state` names the agent and server so the single redirect URI can
 * find the pending record, plus 32 random bytes. It is compared in constant
 * time against the stored pending state and is single use.
 */
export function encodeOAuthState(agentId: string, serverName: string): string {
  const nonce = randomBytes(32).toString('base64url');
  return Buffer.from(JSON.stringify({ a: agentId, s: serverName, n: nonce })).toString('base64url');
}

export function decodeOAuthState(state: string): { agentId: string; serverName: string } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { a, s, n } = parsed as Record<string, unknown>;
    if (typeof a !== 'string' || typeof s !== 'string' || typeof n !== 'string' || !a || !s || !n) {
      return undefined;
    }
    return { agentId: a, serverName: s };
  } catch {
    return undefined;
  }
}

export function oauthStatesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hosts the token-refresh path must reach, taken from discovery. */
export function authorizationHosts(record: McpOAuthRecord): string[] {
  const urls = [
    record.discoveryState?.authorizationServerUrl,
    record.discoveryState?.authorizationServerMetadata?.token_endpoint,
    record.discoveryState?.authorizationServerMetadata?.registration_endpoint,
  ];
  const hosts = new Set<string>();
  for (const value of urls) {
    if (!value) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      // Discovery stored a value that is not a URL; it adds no host.
      continue;
    }
  }
  return [...hosts];
}

// ── the SDK provider ───────────────────────────────────────────────────

export interface StoredOAuthClientProviderOptions {
  store: McpOAuthStore;
  /** Redirect URI for the connect flow; tool calls reuse the stored one. */
  redirectUri?: string;
  scopes?: readonly string[];
  /** Agent and server, for the state parameter of a new authorization. */
  agentId: string;
  serverName: string;
}

/**
 * The MCP SDK's OAuthClientProvider over a stored record. It never opens a
 * browser: `redirectToAuthorization` records the URL so the API can hand it
 * to a person.
 */
export class StoredOAuthClientProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private record: McpOAuthRecord;

  constructor(
    private readonly options: StoredOAuthClientProviderOptions,
    initialRecord: McpOAuthRecord,
  ) {
    this.record = initialRecord;
  }

  static async load(options: StoredOAuthClientProviderOptions): Promise<StoredOAuthClientProvider> {
    return new StoredOAuthClientProvider(options, await options.store.load());
  }

  private get effectiveRedirectUri(): string | undefined {
    return this.options.redirectUri ?? this.record.redirectUri;
  }

  get redirectUrl(): string | undefined {
    return this.effectiveRedirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUri = this.effectiveRedirectUri;
    return {
      client_name: 'Stablehand',
      redirect_uris: redirectUri ? [redirectUri] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.options.scopes && this.options.scopes.length > 0 ? { scope: this.options.scopes.join(' ') } : {}),
    };
  }

  private async persist(mutate: (record: McpOAuthRecord) => void): Promise<void> {
    this.record = await this.options.store.update((record) => {
      mutate(record);
      return record;
    });
  }

  async state(): Promise<string> {
    const state = encodeOAuthState(this.options.agentId, this.options.serverName);
    const redirectUri = this.effectiveRedirectUri;
    if (!redirectUri) {
      throw new Error('An OAuth redirect URI is required to start a connection');
    }
    await this.persist((record) => {
      record.pending = { state, redirectUri, expiresAt: Date.now() + MCP_OAUTH_PENDING_TTL_MS };
    });
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // A registration made for another redirect URI would be refused by the
    // authorization server, so register again instead.
    if (this.record.redirectUri && this.record.redirectUri !== this.effectiveRedirectUri) {
      return undefined;
    }
    return this.record.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const redirectUri = this.effectiveRedirectUri;
    await this.persist((record) => {
      record.clientInformation = clientInformation;
      if (redirectUri) record.redirectUri = redirectUri;
    });
  }

  tokens(): OAuthTokens | undefined {
    return this.record.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.persist((record) => {
      record.tokens = tokens;
      record.connectedAt ??= Date.now();
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.persist((record) => {
      if (record.pending) {
        record.pending.codeVerifier = codeVerifier;
      }
    });
  }

  codeVerifier(): string {
    const verifier = this.record.pending?.codeVerifier;
    if (!verifier) {
      throw new Error('No OAuth connection is in progress for this server; start again from Connect');
    }
    return verifier;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.record.discoveryState;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.persist((record) => {
      record.discoveryState = state;
    });
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await this.persist((record) => {
      if (scope === 'all' || scope === 'tokens') {
        delete record.tokens;
        delete record.connectedAt;
      }
      if (scope === 'all' || scope === 'client') {
        delete record.clientInformation;
        delete record.redirectUri;
      }
      if (scope === 'all' || scope === 'discovery') {
        delete record.discoveryState;
      }
      if (scope === 'all' || scope === 'verifier') {
        if (record.pending) delete record.pending.codeVerifier;
      }
    });
  }

  get currentRecord(): McpOAuthRecord {
    return this.record;
  }
}
