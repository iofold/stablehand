import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseEgressRule } from '@stablehand/contracts';

import { resolveSandboxNoProxy } from '../sandbox/runtime/spec.js';

/**
 * Sandbox egress leases (ctx-3aef).
 *
 * Every sandbox session gets a lease when its container is created. The sandbox presents it to
 * the egress proxy as proxy credentials (`http://<sessionId>:<token>@egress:<port>`), and the
 * proxy asks `POST /api/egress/lease` which rules apply. The token is an HMAC over the session
 * and agent ids, like the gRPC callback token, so it survives orchestrator restarts and a restore
 * of the same session gets the same lease. The agent id travels inside the token because a fresh
 * session's database record is written only after its container is up, and the harness may go
 * through the proxy before that.
 */

const LEASE_CONTEXT = 'stablehand-egress-lease-v1';
/** How long the proxy may cache an answer before asking again. */
export const EGRESS_LEASE_TTL_SECONDS = 30;

type LeaseEnv = Readonly<Record<string, string | undefined>>;

let processLeaseSecret: string | undefined;
let warnedAboutProcessSecret = false;

/**
 * The lease signing secret: the callback token secret, else the API token. Without either
 * (authentication disabled outside production) a random per-process secret is used, so leases
 * stop working when the orchestrator restarts and those sandboxes lose egress until restored.
 */
export function resolveEgressLeaseSecret(
  env: LeaseEnv = process.env,
  logger: { warn: (message: string) => void } = console,
): string {
  const configured = env.STABLEHAND_CALLBACK_TOKEN_SECRET?.trim() || env.STABLEHAND_API_TOKEN?.trim();
  if (configured) return configured;
  if (!processLeaseSecret) {
    processLeaseSecret = randomBytes(32).toString('base64url');
  }
  if (!warnedAboutProcessSecret) {
    warnedAboutProcessSecret = true;
    logger.warn(
      'WARNING: STABLEHAND_CALLBACK_TOKEN_SECRET and STABLEHAND_API_TOKEN are not set; sandbox egress '
      + 'leases use a per-process secret and stop working when the orchestrator restarts.',
    );
  }
  return processLeaseSecret;
}

function leaseSignature(sessionId: string, agentId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${LEASE_CONTEXT}:${sessionId}:${agentId}`)
    .digest('base64url');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** The token half of a session's lease: `<base64url(agentId)>.<signature>`. URL-userinfo safe. */
export function mintEgressLeaseToken(
  sessionId: string,
  agentId: string,
  secret: string = resolveEgressLeaseSecret(),
): string {
  return `${Buffer.from(agentId, 'utf8').toString('base64url')}.${leaseSignature(sessionId, agentId, secret)}`;
}

/** The agent a lease token was minted for, or null when it was not minted for this session. */
export function verifyEgressLeaseToken(
  sessionId: string,
  token: string,
  secret: string = resolveEgressLeaseSecret(),
): { agentId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [encodedAgentId, signature] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(encodedAgentId)) return null;
  const agentId = Buffer.from(encodedAgentId, 'base64url').toString('utf8');
  if (!agentId || Buffer.from(agentId, 'utf8').toString('base64url') !== encodedAgentId) return null;
  const expected = leaseSignature(sessionId, agentId, secret);
  return timingSafeEqual(digest(signature), digest(expected)) ? { agentId } : null;
}

/** NO_PROXY semantics as curl and most clients read them: `*`, exact host, or a domain suffix. */
export function bypassesProxy(host: string, noProxy: string): boolean {
  const target = host.toLowerCase().replace(/^\[|\]$/g, '');
  return noProxy.split(',').some((rawEntry) => {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    if (entry === '*') return true;
    entry = entry.replace(/^\*?\./, '');
    if (!entry.startsWith('[')) entry = entry.replace(/:\d+$/, '');
    entry = entry.replace(/^\[|\]$/g, '');
    return target === entry || target.endsWith(`.${entry}`);
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Endpoints the runtime itself needs, as egress rules, for those a sandbox reaches through the
 * proxy (hosts on the sandbox's NO_PROXY list are reached directly and need no rule): the model
 * gateway, the artifact store, the deployment's OpenAI-compatible base URL and the agent's own
 * model endpoint. Every session gets these, including agents whose egress is set to deny.
 */
export function deriveRuntimeEgressRules(
  harnessConfig: Readonly<Record<string, unknown>>,
  env: LeaseEnv = process.env,
): string[] {
  const urls = [
    env.STABLEHAND_MODEL_GATEWAY_ENABLED?.trim().toLowerCase() === 'true'
      ? env.STABLEHAND_MODEL_GATEWAY_URL
      : undefined,
    env.S3_ENDPOINT,
    env.OPENAI_BASE_URL,
    stringValue(harnessConfig.baseUrl),
  ];
  const noProxy = resolveSandboxNoProxy(env);
  const rules = new Set<string>();
  for (const raw of urls) {
    const value = stringValue(raw);
    if (!value || !URL.canParse(value)) continue;
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (bypassesProxy(url.hostname, noProxy)) continue;
    const rule = `* ${url.hostname}${url.port ? `:${url.port}` : ''}/**`;
    // Hosts the proxy grammar cannot name (IPv6 literals) are left to the operator's rule files.
    if (parseEgressRule(rule).ok) rules.add(rule);
  }
  return [...rules];
}
