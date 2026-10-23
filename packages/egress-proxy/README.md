# stablehand-egress

The sandbox egress broker: a mitmproxy-based L7 proxy that is the only route out of the
`stablehand-agents` network. It enforces a default-deny allowlist by method, host, port and
path, applies each agent's own egress setting per sandbox session (ctx-3aef), refuses private
and cloud-metadata destinations, streams responses, and logs one JSON line per denial.
Secretless credential injection driven by the orchestrator comes next (ctx-2yek).

What agents can reach and how to change it per agent: [docs/sandbox-egress.md](../../docs/sandbox-egress.md).

- Rule sets:
  - runtime rules, kept by every session including agents set to `deny`: `rules.runtime.txt`
    (model providers) plus `STABLEHAND_EGRESS_RUNTIME_ALLOW`;
  - server defaults, for agents set to `default` or `allow` and for requests without a lease:
    `rules.default.txt` (registries, git hosting) plus `STABLEHAND_EGRESS_EXTRA_ALLOW`;
  - the agent's own rules and the runtime endpoints the orchestrator reports (model gateway,
    artifact store, the agent's model base URL), from the lease check. These can never carry
    `!internal`.
- CA: generated once into the `egress-ca` volume; only the public certificate is copied to
  the `egress-ca-public` volume that sandboxes mount read-only at `/etc/stablehand/egress-ca`.
  TLS to every allowed host, provider hosts included, is intercepted.

## Session leases

The orchestrator gives every sandbox session a lease and puts it in the sandbox's proxy URL as
credentials: `http://<sessionId>:<token>@egress:8081`. The token is an HMAC over the session and
agent ids, so it survives orchestrator restarts and a restored session keeps it; it stops working
when the session ends.

- The proxy sends each lease it has not seen recently to the orchestrator
  (`POST /api/egress/lease`, `STABLEHAND_EGRESS_LEASE_URL`) and gets back the agent's egress
  setting. It caches valid answers for the TTL the orchestrator names (30 s) and rejections for
  5 s, and makes one call per lease no matter how many requests are waiting.
- A tunnel is identified once, at CONNECT; every request inside it inherits that identity. Plain
  HTTP requests carry their own credentials. The credentials are removed before anything is
  forwarded and never logged.
- If the orchestrator cannot be reached, a lease that was valid in the last 5 minutes keeps its
  last answer; otherwise the request gets `503` (`lease_unverifiable`). There is no fallback to
  looser rules.

Why the orchestrator answers rather than a file the orchestrator writes: any orchestrator
replica can answer, nothing has to be shared between the two containers (or, on Kubernetes,
between pods), an agent's new setting reaches running sandboxes within the cache TTL, and a
crashed orchestrator cannot leave stale rules behind.

Two listeners:

| Port | No lease | Valid lease | Bad lease |
|---|---|---|---|
| `8081` (lease listener, what sandboxes are given) | `407` with `Proxy-Authenticate` | the session's rules | `403` `invalid_lease` |
| `8080` (open listener, for sandboxes started before leases) | server rules while `STABLEHAND_EGRESS_UNLEASED=global`, `407` once `deny` | the session's rules | `403` `invalid_lease` |

The `407` matters: git and Chromium send proxy credentials only after a challenge. curl, Python,
Node and grpc-js send them up front. `STABLEHAND_EGRESS_UNLEASED=global` exists only for the
rollout: while it is set, a sandbox that drops its lease and talks to `8080` gets the server
rules instead of its agent's. Set it to `deny` once every running sandbox was started with a
lease.

## What a decision is based on

The proxy judges the destination it will actually connect to, never a header on its own:

- **Tunnels (HTTPS).** The CONNECT authority is the destination. A Host header on the
  CONNECT must name the same host and port, and inside the tunnel every Host header, the
  HTTP/2 `:authority` and the TLS SNI must name it too. Anything else is `host_mismatch` or
  `sni_mismatch`.
- **Plain HTTP.** The request-target authority is the destination; Host headers that
  disagree with it are `host_mismatch`.
- **IP literals** (including spellings such as `127.1` or `2130706433`) match only a rule
  that names that exact address; host globs and the bare `*` never match them (`ip_literal`).
- **Private, loopback, link-local, shared (CGNAT) and metadata destinations** are refused
  (`private_destination`) unless the matching rule carries `!internal`.
- **DNS.** Right before connecting, the proxy resolves the hostname. If any answer is private,
  the connection is refused (`resolves_to_private`) unless a rule for the host carries
  `!internal`. The socket then goes to the vetted address, so a second DNS answer cannot
  redirect it (DNS rebinding). Because pinned connections are keyed by address, an upstream
  connection is not reused across requests in the same tunnel.
- **Non-HTTP tunnels.** Raw TCP and DNS inside a CONNECT tunnel are refused
  (`non_http_protocol`, `dns_tunnel`): the allowlist is an HTTP allowlist.
- Every request is judged at `requestheaders`, before mitmproxy opens an upstream connection
  or forwards a body byte, so bodies that mitmproxy streams cannot slip past the policy.

## Responses to denied requests

- Requests get `403` with `X-Stablehand-Egress: denied` and a JSON body naming the
  destination host, method, path and reason. A denied request whose body may exceed 64 KiB
  (or is chunked) is dropped without a response instead, so it is never buffered.
- Every denial body names the rules that decided in `source`: `server`, or `agent:<mode>`.
- A denied CONNECT gets an empty `403` with the same header and closes the connection. Missing,
  bad or unconfirmable leases get `407`, `403` or `503` the same way (a JSON body for plain HTTP).
- A destination refused at connect time (DNS answer, or a host that is no longer allowed)
  gets mitmproxy's `502` whose message carries `egress denied: <reason>`.

## Tests

- `python3 -m unittest discover -s packages/egress-proxy/tests` runs the policy tests with any
  Python 3; tests that need mitmproxy skip themselves.
- `packages/egress-proxy/tests/run-in-docker.sh` builds the image as `stablehand/egress:test`
  and runs every suite inside it with no network: policy tests, addon hook tests, and live
  checks against a real mitmdump started through `entrypoint.sh`, with upstream servers that
  record every connection they receive, and a stub orchestrator for the lease checks. Set
  `STABLEHAND_EGRESS_TEST_IMAGE` to reuse an existing image instead of building one.
- `packages/egress-proxy/tests/integration/run.sh` runs the image in a throwaway compose project
  (its own internal network, a stub orchestrator and a stub upstream) and checks real clients
  from a harness image against deny, default, missing and forged leases: curl, `git clone`,
  Node `fetch` and `https`, Python `requests` and `urllib`, and Chromium through Playwright.
  It never touches a running stack and removes the project on exit.
