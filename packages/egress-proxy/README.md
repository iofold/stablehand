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
- Tests: `python3 -m unittest discover -s packages/egress-proxy/tests`.
- Denied requests get `403` with `X-Stablehand-Egress: denied` and a JSON body naming the
  host, method, path and reason.
