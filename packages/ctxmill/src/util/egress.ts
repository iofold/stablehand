import net from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Egress guard for orchestrator-originated HTTP calls (agent HTTP tools and
 * webhook/callback delivery). Agent- and user-supplied URLs are fetched from
 * the trusted orchestrator process, so without controls they enable SSRF /
 * confused-deputy calls into private networks, cloud metadata, and other
 * control-plane services. This blocks those destinations by default, allows an
 * explicit host allowlist, and re-validates across redirects.
 *
 * Residual risk: destinations are validated by resolving DNS and checking the
 * resolved addresses; a hostname that re-resolves to a private address between
 * this check and the socket connect (DNS rebinding) is not fully prevented
 * here. Deployments that need that guarantee should also enforce network-level
 * egress policy (NetworkPolicy / firewall / egress proxy).
 */

export interface EgressPolicy {
  /** When false, only the scheme check applies (private ranges are allowed). */
  enforce: boolean;
  /** Hostnames (and `*.suffix` / bare-suffix patterns) permitted to bypass the block. */
  allowlist: string[];
  /** When true, only allowlisted hosts are reachable (deny public by default). */
  allowlistOnly: boolean;
  /** Maximum redirects to follow while re-validating each hop. */
  maxRedirects: number;
}

export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.localhost'];

function buildBlockList(): net.BlockList {
  const blockList = new net.BlockList();
  // RFC1918 private, loopback, link-local (incl. 169.254.169.254 metadata),
  // shared CGNAT, benchmarking, documentation, multicast, and reserved ranges.
  const ipv4Subnets: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [addr, prefix] of ipv4Subnets) {
    blockList.addSubnet(addr, prefix, 'ipv4');
  }
  const ipv6Subnets: Array<[string, number]> = [
    ['::', 128], // unspecified
    ['::1', 128], // loopback
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['fec0::', 10], // deprecated site-local
    ['ff00::', 8], // multicast
  ];
  for (const [addr, prefix] of ipv6Subnets) {
    blockList.addSubnet(addr, prefix, 'ipv6');
  }
  return blockList;
}

const BLOCK_LIST = buildBlockList();

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  return fallback;
}

export function resolveEgressPolicy(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  const allowlist = (env.CTXMILL_EGRESS_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const maxRedirectsRaw = Number.parseInt(env.CTXMILL_EGRESS_MAX_REDIRECTS ?? '', 10);
  return {
    enforce: parseBool(env.CTXMILL_EGRESS_ENFORCE, true),
    allowlist,
    allowlistOnly: parseBool(env.CTXMILL_EGRESS_ALLOWLIST_ONLY, false),
    maxRedirects: Number.isFinite(maxRedirectsRaw) && maxRedirectsRaw >= 0 ? maxRedirectsRaw : 5,
  };
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  return allowlist.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.com"
      return host === pattern.slice(2) || host.endsWith(suffix);
    }
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}

function isBlockedHostname(host: string): boolean {
  if (host === 'localhost') return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Normalize an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) to its IPv4 form. */
function normalizeMappedIpv4(address: string): { address: string; family: 4 | 6 } {
  const lower = address.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && net.isIPv4(mapped[1])) {
    return { address: mapped[1], family: 4 };
  }
  const family = net.isIPv6(address) ? 6 : 4;
  return { address, family };
}

function assertAddressAllowed(rawAddress: string, host: string): void {
  const { address, family } = normalizeMappedIpv4(rawAddress);
  if (BLOCK_LIST.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new EgressBlockedError(
      `Egress to "${host}" (${rawAddress}) is blocked: destination is a private, loopback, link-local, or reserved address`,
    );
  }
}

async function assertUrlAllowed(url: URL, policy: EgressPolicy): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressBlockedError(`Egress scheme "${url.protocol}" is not allowed (only http/https)`);
  }
  if (!policy.enforce) {
    return;
  }

  const host = stripBrackets(url.hostname).toLowerCase();
  if (hostMatchesAllowlist(host, policy.allowlist)) {
    return;
  }
  if (policy.allowlistOnly) {
    throw new EgressBlockedError(`Egress to "${host}" is blocked: host is not in the egress allowlist`);
  }

  const literalFamily = net.isIP(host);
  if (literalFamily) {
    assertAddressAllowed(host, host);
    return;
  }

  if (isBlockedHostname(host)) {
    throw new EgressBlockedError(`Egress to "${host}" is blocked: internal hostname`);
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new EgressBlockedError(`Egress to "${host}" is blocked: host could not be resolved`);
  }
  if (resolved.length === 0) {
    throw new EgressBlockedError(`Egress to "${host}" is blocked: host resolved to no addresses`);
  }
  for (const { address } of resolved) {
    assertAddressAllowed(address, host);
  }
}

function nextRedirectInit(init: RequestInit | undefined, status: number): RequestInit {
  const base: RequestInit = { ...(init ?? {}) };
  const method = (base.method ?? 'GET').toUpperCase();
  // Per fetch semantics: 303 always becomes GET; 301/302 downgrade non-idempotent
  // methods to GET. 307/308 preserve method and body.
  if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
    base.method = 'GET';
    delete base.body;
  }
  return base;
}

/**
 * Wraps a fetch implementation so every request destination — including each
 * redirect hop — is validated against the egress policy before the network
 * call is made.
 */
export function createGuardedFetch(
  policy: EgressPolicy = resolveEgressPolicy(),
  baseFetch?: typeof fetch,
): typeof fetch {
  // Resolve globalThis.fetch dynamically when no explicit base is injected so a
  // later reassignment (or test stub) of the global fetch is honored. Call it as
  // a method on globalThis to preserve its `this` binding.
  const invokeFetch: typeof fetch = (input, init) =>
    baseFetch ? baseFetch(input, init) : globalThis.fetch(input, init);
  const guarded = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    let currentUrl = new URL(input instanceof Request ? input.url : String(input));
    let currentInput: Parameters<typeof fetch>[0] = input;
    let currentInit: RequestInit | undefined = init;

    for (let hop = 0; ; hop++) {
      await assertUrlAllowed(currentUrl, policy);
      const response = await invokeFetch(currentInput, { ...(currentInit ?? {}), redirect: 'manual' });

      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return response;
      }
      if (hop >= policy.maxRedirects) {
        throw new EgressBlockedError(`Egress blocked: exceeded ${policy.maxRedirects} redirects`);
      }
      currentUrl = new URL(location, currentUrl);
      currentInit = nextRedirectInit(currentInit, response.status);
      currentInput = currentUrl.toString();
    }
  };
  return guarded as typeof fetch;
}
