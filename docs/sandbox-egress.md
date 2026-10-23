# Sandbox egress

Agents run in sandboxes that have no direct route to the internet. Everything they fetch, clone, install or browse goes through the egress proxy, which allows only what its rules allow. This page covers what a sandbox can reach, how to change that per agent, and what an operator sets up. How the proxy itself decides is in [packages/egress-proxy/README.md](../packages/egress-proxy/README.md).

## What a sandbox can reach

Out of the box, every sandbox can reach:

- the model providers (OpenAI, Anthropic, Google, Cloudflare AI Gateway, OpenRouter);
- package registries (npm, PyPI) and public git hosting (GitHub);
- whatever the operator added for everyone.

Private addresses, the host machine and cloud metadata endpoints are never reachable, whatever the rules say, unless the operator names them in the server's own rule files.

The model gateway, the artifact store and the orchestrator are reached directly on the internal network and never count against these rules.

## Per-agent egress

Each agent can narrow or widen that list with an `egress` setting:

| Mode | The agent's sandboxes can reach |
|---|---|
| `default` (or no setting) | The server allowlist above. |
| `deny` | Only what the runtime needs: the model provider and gateway, the artifact store. Add `rules` to open specific hosts and nothing else. |
| `allow` | The server allowlist plus the agent's `rules`. |

Use `deny` when an agent must not look things up: a benchmark solver that could otherwise find the published fix on GitHub, or an agent working on confidential data. Use `allow` for agents that browse the open web, for example `GET *` and `HEAD *` for read-only access to any public site.

In a manifest:

```yaml
spec:
  egress:
    mode: deny
    rules:                      # optional for deny, required for allow
      - "GET pypi.org/simple/**"
      - "GET files.pythonhosted.org/**"
```

Through the API, send the same object as `egress` on `POST /api/agents` or `PATCH /api/agents/:id`; send `null` to go back to the server allowlist. Agents created from a manifest change it through the manifest. A change reaches running sandboxes within about 30 seconds.

### Rules

One rule per string: `<METHOD|*> <host>[:<port>][/<path>]`.

- `METHOD` is an HTTP method such as `GET`, or `*` for any.
- `host` is a hostname, `*.example.com` for its subdomains, or `*` for any public host.
- `port` is optional; without it any port matches.
- `path` is optional and uses `*` for one segment and `**` for any depth; without it every path matches.

| Rule | Allows |
|---|---|
| `GET *` | Reading any public website |
| `* api.example.com/v1/**` | Any call under `/v1` on that API |
| `GET *.githubusercontent.com/**` | Downloads from GitHub's content hosts |
| `POST hooks.example.com:8443/notify` | One endpoint on one port |

Rules cannot open private or internal addresses, and the API refuses a rule the proxy would read differently. Up to 200 rules per agent.

### What a blocked request looks like

The agent gets `403`. When the host is reachable but the method or path is not (here, an `allow` agent with `GET *` trying to post), the answer carries a short JSON explanation, so the agent can tell a policy decision from a network failure:

```json
{
  "error": "egress_denied",
  "reason": "no_matching_rule",
  "source": "agent:allow",
  "method": "POST",
  "host": "news.example.com",
  "port": 443,
  "path": "/comments",
  "hint": "This sandbox may only reach hosts on the server's egress allowlist and the agent's own egress rules. Add a rule for this host to the agent's egress rules if it is required."
}
```

`source` says which rules decided: `server` for the server allowlist, or `agent:<mode>` for the agent's setting. An HTTPS request to a host the agent cannot reach at all is refused before the connection is set up, so most clients show only the status (`CONNECT tunnel failed, response 403`). Either way the proxy log has the full record, including the session and agent.

### Limits

- `deny` still lets the agent talk to its model provider. A provider-side tool, such as a hosted web search the model can call, is outside the proxy's reach; turn those off in the gateway or the agent's model settings for runs that must stay offline.
- The rules see hosts, methods and paths, not request bodies. An allowed host can still receive whatever the agent sends it.
- Kubernetes deployments do not route sandboxes through the proxy yet, so `egress` has no effect there (see below).

## For operators

### How sandboxes are told apart

Each sandbox gets its own credentials for the proxy when its session starts, built into its proxy URL. The proxy checks them with the orchestrator and applies that agent's setting. The credentials end with the session, come back unchanged when a suspended session is restored, and are never logged or sent on to the destination.

The proxy listens on two ports:

- `8081`, which every new sandbox uses: a request without the session's credentials is refused (`407`). Clients that only send credentials when asked, such as git and the browse tool's Chromium, do so automatically.
- `8080`, kept for sandboxes started before per-agent egress existed: a request without credentials gets the server allowlist while `STABLEHAND_EGRESS_UNLEASED=global`.

Leave `STABLEHAND_EGRESS_UNLEASED=global` only while sandboxes started before the upgrade are still running. In that window a sandbox that deliberately drops its credentials and talks to `8080` gets the server allowlist instead of its agent's setting. Set `STABLEHAND_EGRESS_UNLEASED=deny` once they are gone, and before relying on `deny` for anything that matters.

If the proxy cannot reach the orchestrator, it keeps a session's last known setting for a few minutes and then refuses that session's requests (`503`). It never falls back to a looser setting.

### Settings

On the `egress` service:

| Variable | Default | What it does |
|---|---|---|
| `STABLEHAND_EGRESS_EXTRA_ALLOW` | empty | Extra server-allowlist rules for every agent except `deny` ones, `;`-separated. |
| `STABLEHAND_EGRESS_RUNTIME_ALLOW` | empty | Extra rules every agent keeps, including `deny` ones. Use it for services the runtime needs, such as a tracing endpoint. |
| `STABLEHAND_EGRESS_UNLEASED` | `global` | What port 8080 does with requests that carry no credentials: `global` or `deny`. |
| `STABLEHAND_EGRESS_LEASE_URL` | `http://orchestrator:3001/api/egress/lease` | Where the proxy checks credentials. |
| `STABLEHAND_EGRESS_LOG_ALLOWED` | `0` | `1` logs allowed requests as well as blocked ones. |

The built-in lists are `rules.runtime.txt` (model providers) and `rules.default.txt` (registries and git hosting) in `packages/egress-proxy`; `STABLEHAND_EGRESS_RUNTIME_RULES` and `STABLEHAND_EGRESS_RULES` replace them with your own files. Only these server-side rules may use `!internal` to open a private address.

On the orchestrator, `STABLEHAND_SANDBOX_EGRESS_PROXY_URL` (compose default `http://egress:8081`) is the proxy every sandbox uses. Credentials are signed with `STABLEHAND_CALLBACK_TOKEN_SECRET`, or `STABLEHAND_API_TOKEN` when that is not set; changing that secret cuts running sandboxes off until they are restored.

### Kubernetes

Not done yet (ctx-2ctd): Kubernetes sandboxes get no egress proxy, NetworkPolicy or deployment CA, so their egress is whatever the cluster allows and the `egress` setting is not enforced. When the proxy is deployed there, the orchestrator already puts each sandbox's proxy credentials in the sandbox's per-Job Secret rather than in the Job definition.
