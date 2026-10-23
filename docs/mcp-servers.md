# MCP servers

An agent can call the tools of remote [MCP](https://modelcontextprotocol.io) servers. You declare the servers on the agent; Stablehand connects to each one from the orchestrator, lists its tools and offers them to the agent as `<server>__<tool>`, for example `granola__list_meetings`. Every harness (LangGraph, Claude Agent SDK, PI) sees them the same way.

## Where the client runs, and why

The MCP client runs in the orchestrator, next to HTTP tools, never inside the agent's sandbox. When the agent calls an MCP tool, the sandbox sends the call to the orchestrator over the same callback it uses for every orchestrator tool; the orchestrator calls the server and returns the result.

We chose this over each harness's own MCP support (the Claude Agent SDK's `mcpServers`, LangChain's MCP adapters) because of the tokens:

- Bearer tokens and OAuth tokens stay in the orchestrator. They are stored encrypted as the agent's tools-only secrets, read when the client connects, and never enter the sandbox env, a checkpoint, a tool definition or the model's context. The sandbox runs code the model writes, so anything placed there can leak.
- One approval gate covers every call. A tool marked to ask first pauses on a durable approval card in the orchestrator, where the sandbox cannot skip it.
- One egress policy covers every call. Sandboxes have no route to MCP servers at all; the orchestrator's egress guard and a per-server host pin decide what the client may reach.
- It works the same for all three harnesses, with one OAuth implementation instead of three.

The cost is one extra hop per call, which is small next to a remote tool call.

## Declare a server

In a manifest:

```yaml
spec:
  mcpServers:
    - name: apify                      # 1-24 lowercase letters, digits, - or _
      url: https://mcp.apify.com/?tools=harvestapi/linkedin-post-search
      auth:
        type: bearer
        token: "$secret:APIFY_TOKEN"   # a reference, never the token itself
      tools: [harvestapi--linkedin-post-search, get-dataset-items]   # optional allowlist, * wildcards
      requireApproval: false           # see below
      timeoutMs: 180000                # per call, default 120000
    - name: granola
      url: https://mcp.granola.ai/mcp
      auth:
        type: oauth
```

Through the API, send the same list as `mcpServers` on `POST /api/agents` or `PATCH /api/agents/:id` (send `null` to remove them all). In the dashboard, the agent form has an MCP servers section.

Only remote servers over Streamable HTTP are supported. Local `stdio` servers would run a command inside the orchestrator, which is the control plane, so they are left out until they can run in a sandbox image.

## Sign-in

| `auth.type` | What Stablehand sends | Where the value lives |
|---|---|---|
| `none` (default) | nothing | |
| `bearer` | `Authorization: Bearer <secret>` | the `$secret:NAME` you name, stored as a tools-only secret on the agent |
| `header` | a header you name, e.g. `x-api-key: <secret>` | same |
| `oauth` | an OAuth access token, refreshed by Stablehand | tokens stored encrypted as the tools-only secret `MCP_OAUTH__<server>` |

Store a tools-only secret with:

```sh
curl -X POST "$API/api/agents/$AGENT/secrets" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"key": "APIFY_TOKEN", "value": "apify_api_...", "scope": "tools"}'
```

or pick "Tools only" when you add the secret on the agent's Secrets tab. Tools-only secrets are left out of the sandbox env and out of the runtime fingerprint, so rotating one does not restart a warm sandbox. MCP servers read only this scope. HTTP tools read both scopes, with tools-only values winning.

### Connect an OAuth server

For `auth: { type: oauth }`, a person signs in once per agent:

1. Open the agent's Tools tab and press Connect on the server. Stablehand discovers the server's authorization server, registers itself if needed (dynamic client registration), and shows the sign-in page's host and full URL.
2. Open the link and sign in. The provider sends your browser to `<your Stablehand>/api/mcp/oauth/callback`, which checks the single-use `state` (and `iss` when the provider sends it), exchanges the code with PKCE and stores the tokens.
3. The card turns Ready and lists the tools.

`STABLEHAND_PUBLIC_URL` sets the address used in the redirect. Without it, Stablehand uses the address your browser reports. Through the API: `POST /api/agents/:id/mcp-servers/:server/connect` returns `{ authorizationUrl, host, expiresAt }`; `DELETE /api/agents/:id/mcp-servers/:server/connection` forgets the sign-in. Both need the master token, like secrets.

Tested against Granola's hosted server (`https://mcp.granola.ai/mcp`): discovery, registration and PKCE reach Granola's sign-in page at `mcp-auth.granola.ai`. The tokens are bound to the agent; per-user sign-in (each person who chats with the agent connecting their own account) needs a user identity Stablehand does not have yet.

## Approval

`requireApproval` decides which calls wait for a person:

- `true`: every call
- `false`: none
- a list of globs, such as `[call-actor, delete_*]`: those tools
- omitted: tools the server marks destructive (`destructiveHint: true`). Annotations come from the server, so they only set this default; your list always wins.

A gated call shows an approval card with its arguments. On approve the orchestrator makes the call; on reject the model gets the rejection and your note instead. The same gate applies to HTTP tools with `requiresApproval: true` and to project tools. The tool tester refuses gated tools, since it has no run to pause.

## Egress

The orchestrator calls MCP servers through the same guard as HTTP tools: private, loopback, link-local and metadata addresses are blocked unless `STABLEHAND_EGRESS_ALLOWLIST` names the host, and `STABLEHAND_EGRESS_ALLOWLIST_ONLY=true` limits it to the list. On top of that, each server's client may only reach that server's host (plus its OAuth authorization server once connected), so a server cannot point the client somewhere else. Saving an agent fails with a plain message when a declared URL would be refused: `http://` URLs need an allowlist entry, for example `STABLEHAND_EGRESS_ALLOWLIST=notes-mcp` for an internal stand-in. The sandbox egress proxy is not involved, because sandboxes never call MCP servers.

## Status and the catalog

`GET /api/agents/:id/mcp-servers` reports each server's state (`ready`, `needs_auth`, `error` or `connecting`), a plain-language message, and its tools with plain names and approval flags. `POST /api/agents/:id/mcp-servers/:server/refresh` lists the tools again. The Tool Registry shows MCP tools with source `mcp`, the server name and a plain display name.

Stablehand lists a server's tools when the agent is saved, when the orchestrator starts, after a connect and on refresh, and caches the list. A server that is down or not signed in leaves the agent's other tools working; its tools return when it is back and you refresh.

## Limits

- Results are capped at 100,000 characters, with a note telling the model to ask for less. Images and audio are described, not inlined.
- Up to 10 servers per agent and 100 tools per server. Use `tools:` to keep the list short; every tool costs context.
- Stablehand passes the model's arguments through and cannot pin any of them, so a tool that spends money per call is capped only if the server caps it. Apify's hosted server does not cap what an actor run can charge. To hold each call to a fixed amount, call Apify's API from an HTTP tool with `maxTotalChargeUsd` in the endpoint URL, as the content factory example does (`packages/examples/content-factory/apify-tools.ts`).
- The MCP SDK in use (1.32) speaks protocol versions up to 2025-11-25. Servers that only speak 2026-07-28 will not connect until the SDK moves to v2.

Still open: Composio as an MCP server, per-user grants, deployment-wide server registrations shared by many agents, and loading tool definitions on demand for servers with many tools.
