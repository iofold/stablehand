# stablehand-egress

The sandbox egress broker: a mitmproxy-based L7 proxy that is the only route out of the
`stablehand-agents` network. Phase 1 (ctx-2ctd) enforces a default-deny allowlist by
method, host, port and path, refuses private and cloud-metadata destinations, streams
responses, and logs one JSON line per denial. Phase 2 (ctx-2yek) adds secretless
credential injection driven by the orchestrator.

- Rules: `rules.default.txt` (server defaults) plus `STABLEHAND_EGRESS_EXTRA_ALLOW`
  (`;`-separated rules). Per-agent `egress:` lists arrive with ctx-ljir.
- CA: generated once into the `egress-ca` volume; only the public certificate is copied to
  the `egress-ca-public` volume that sandboxes mount read-only at `/etc/stablehand/egress-ca`.
  TLS to every allowed host, provider hosts included, is intercepted.

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
- A denied CONNECT gets an empty `403` with the same header.
- A destination refused at connect time (DNS answer, or a host that is no longer allowed)
  gets mitmproxy's `502` whose message carries `egress denied: <reason>`.

## Tests

- `python3 -m unittest discover -s packages/egress-proxy/tests` runs the policy tests with any
  Python 3; tests that need mitmproxy skip themselves.
- `packages/egress-proxy/tests/run-in-docker.sh` builds the image as `stablehand/egress:test`
  and runs every suite inside it with no network: policy tests, addon hook tests, and live
  checks against a real mitmdump started through `entrypoint.sh`, with upstream servers that
  record every connection they receive. Set `STABLEHAND_EGRESS_TEST_IMAGE` to reuse an
  existing image instead of building one.
