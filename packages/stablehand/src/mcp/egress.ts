import {
  createGuardedFetch,
  EgressBlockedError,
  hostMatchesAllowlist,
  resolveEgressPolicy,
  type EgressPolicy,
} from '../util/egress.js';

/**
 * Egress for MCP clients. The client runs in the orchestrator, so every
 * request it makes passes the same guard as HTTP tools (private ranges and
 * metadata endpoints blocked unless STABLEHAND_EGRESS_ALLOWLIST names them;
 * STABLEHAND_EGRESS_ALLOWLIST_ONLY restricts to the list) and is also pinned
 * to the hosts the server declaration needs: the server itself, plus the
 * OAuth authorization server once a person has connected. A server cannot
 * point the client at a third host. The sandbox egress allowlist is not
 * touched: sandboxes never talk to MCP servers.
 */
export interface McpFetchOptions {
  /** Hosts this server's client may reach, read on every request. */
  allowedHosts: () => readonly string[];
  policy?: EgressPolicy;
  baseFetch?: typeof fetch;
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

export function createMcpFetch(options: McpFetchOptions): typeof fetch {
  const base: typeof fetch = (input, init) =>
    options.baseFetch ? options.baseFetch(input, init) : globalThis.fetch(input, init);
  // The pin runs inside the guard's redirect loop, so every hop is checked.
  const pinned: typeof fetch = async (input, init) => {
    const host = requestUrl(input).hostname.toLowerCase();
    const allowed = options.allowedHosts().map((entry) => entry.toLowerCase());
    if (!allowed.includes(host)) {
      throw new EgressBlockedError(
        `MCP egress to "${host}" is blocked: this server may only reach ${allowed.join(', ') || 'its own host'}`,
      );
    }
    return base(input, init);
  };
  return createGuardedFetch(options.policy ?? resolveEgressPolicy(), pinned);
}

/**
 * A declaration-time check with an actionable message, run when an agent is
 * saved. It does no DNS lookups; the guard repeats the full check on every
 * request.
 */
export function checkMcpServerUrl(
  rawUrl: string,
  policy: EgressPolicy = resolveEgressPolicy(),
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `MCP server URL is not a valid URL: ${rawUrl}`;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowlisted = hostMatchesAllowlist(host, policy.allowlist);
  if (url.protocol === 'http:' && policy.enforce && !allowlisted) {
    return `MCP server ${host} uses http. Use https, or add ${host} to STABLEHAND_EGRESS_ALLOWLIST if it is an internal service you trust.`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `MCP server URLs must use https: ${rawUrl}`;
  }
  if (policy.enforce && policy.allowlistOnly && !allowlisted) {
    return `MCP server ${host} is not in STABLEHAND_EGRESS_ALLOWLIST, and this deployment only reaches allowlisted hosts.`;
  }
  if (url.username || url.password) {
    return 'MCP server URLs must not carry credentials; use auth with a $secret: reference.';
  }
  return null;
}
