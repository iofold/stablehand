# Scoped API keys

Scoped API keys are the credential boundary for out-of-process extensions and
other non-operator integrations. They let an operator grant a named principal
only the API capabilities it needs while retaining the master
`STABLEHAND_API_TOKEN` for the dashboard and administrative work.

The authorization boundary is intentionally coarse and deployment-wide. A key
can be restricted by capability, but not by agent, artifact, conversation, or
tenant. Review the effective permission receipt before creating one.

## Master token and scoped keys

| Credential | Intended holder | Access |
|---|---|---|
| Master `STABLEHAND_API_TOKEN` | Deployment operator and dashboard | Every authenticated API route, including key administration |
| Scoped `cmk_...` key | One extension or integration | Only routes mapped to one of its capabilities |

Routes without a declared scoped capability are master-only. This fail-closed
rule means a new or forgotten route annotation narrows access rather than
accidentally granting it. A scoped key can never list, create, or revoke keys.

When `STABLEHAND_AUTH_DISABLED=true` is active and no `STABLEHAND_API_TOKEN` is
configured, HTTP authentication is open and scoped keys provide no isolation.
A separate callback secret can still protect sandbox callbacks, but does not
close the HTTP API. The Access keys UI disables creation in open mode.

## Create a key

The recommended operator workflow is **Settings → Access keys**. The creation
dialog provides presets, an exact permission receipt, expiration choices, and a
one-time secret dialog. The secret exists only in component memory and is
removed from the page when the dialog closes.

The bundled CLI provides the same lifecycle operations. It requires the master
token:

```bash
stablehand ops keys create \
  --name artifact-gallery-prod \
  --cap artifacts:read \
  --cap webhooks:manage \
  --note "Production artifact gallery"

stablehand ops keys list
stablehand ops keys revoke key_123 --yes
```

`--cap` is repeatable and also accepts comma-separated values. `--expires-at`
accepts an epoch-millisecond timestamp. A live `keys create` command rejects
`--out` because the response contains a one-time secret; `--dry-run --out` is
still safe because no token is minted. Treat `--json` output as secret-bearing.

The HTTP API is also master-only:

```bash
curl -sS -X POST "$STABLEHAND_API_URL/api/keys" \
  -H "Authorization: Bearer $STABLEHAND_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "artifact-gallery-prod",
    "capabilities": ["artifacts:read", "webhooks:manage"],
    "note": "Production artifact gallery",
    "expiresAt": null
  }'
```

`POST /api/keys` returns `Cache-Control: no-store`. Its `token` field is shown
once and cannot be retrieved later. Stablehand stores only its SHA-256 hash.

## Capability map

The shipped inventory contains 93 explicit HTTP routes: 3 public routes (two
health checks and the MCP OAuth redirect), 44 capability-scoped routes, and 46
master-only routes.

| Capability | Scoped routes | Important consequence |
|---|---|---|
| `agents:read` | Agent list/detail, conversations and snapshots, turn detail/list, turns across agents by tag (`GET /api/turns`, `GET /api/turns/:turnId`), recent/active conversations, active sandbox-session summaries, agent SSE stream | Reads prompts, harness configuration, transcripts, status, and live output across the deployment |
| `agents:write` | Create, update, and delete agents | Agent deletion can cascade through agent-owned runtime data |
| `conversations:write` | Interactive/background turn start, turn cancellation, AG-UI run stream | Runs may invoke the agent's configured tools and secrets and incur model cost |
| `events:read` | Event list, stats, and type list | Reads persisted event payloads across the deployment |
| `interrupts:read` | Global and per-agent interrupt lists | Reads tool names, arguments, and resolution state |
| `interrupts:resolve` | Resolve an agent interrupt | Can approve side effects and resume agent execution |
| `feedback:write` | Submit agent-message feedback | Can attach ratings and comments to messages |
| `artifacts:read` | Artifact list/metadata, direct download, signed download URL | Signed URLs remain usable until their own expiry |
| `artifacts:write` | Signed upload request and multipart upload | Creates artifacts; deletion remains master-only |
| `webhooks:manage` | Agent webhook list/create/update/delete | Can send future event payloads to configured destinations |
| `schedules:manage` | Schedule list/create/read/update/delete | Schedules continue running after the creating key is revoked |
| `triggers:emit` | Emit a custom event | Events may activate operator-configured triggers and start agent work |

The following surfaces remain master-only even if a key holds all twelve
capability verbs:

- API config, settings, analytics, budgets, model-gateway status, model-gateway
  campaign keys, queue status, sandbox metrics, tool catalog/testing, and key
  administration.
- Workspace files and replacement, agent secrets, and manual sandbox
  suspend/restore/kill operations.
- Trigger definition CRUD and artifact deletion.

The executable source of truth is the exhaustive route inventory in
`tests/integration/api-auth-coverage.test.ts`. It classifies every explicit
HTTP route and asserts that every master-only route rejects a fully granted
scoped key.

## Namespace-limited custom events

`triggers:emit` is the only parameterized capability. A flat grant can emit any
valid `custom.*` event. A prefix grant narrows it:

```text
triggers:emit:custom.gallery.*
```

That grant permits `custom.gallery.published` and
`custom.gallery.validation.completed`, but rejects `custom.eval.verdict` before
the event is persisted or any trigger can fire. The wildcard is trailing only.

Events emitted with a scoped key carry the key ID as top-level persisted event
provenance. Stablehand does not inject that provenance into the caller's nested
payload.

## Extension runtime use

Pass the scoped token exactly as a bearer token. The official client accepts a
string or token provider:

```ts
import { StablehandControlClient } from '@stablehand/client/control';

const stablehand = new StablehandControlClient({
  apiBase: process.env.STABLEHAND_API_URL,
  token: () => process.env.STABLEHAND_EXTENSION_TOKEN!,
});
```

There is no OAuth exchange, install callback, runtime extension registry, or
self-service delegation today. The operator deploys the Git-pinned extension,
creates its key with the master credential, and injects the key into the
extension's own secret store. The extension should probe one endpoint it
actually requires; `/api/config` is master-only and is not a scoped-key
introspection endpoint.

Authorization failures are designed for startup diagnostics:

- `401` means the token is missing, unknown, expired, or revoked.
- `403` with `requiredCapability: "events:read"` names a missing grant.
- `403` with `requiredCapability: null` means the route is master-only.

`StablehandApiError.requiredCapability` exposes the same value to client users.
Do not fall back to the master token when a capability is missing; ask the
operator to review and rotate the scoped key.

## Expiration, use, rotation, and revocation

Key list responses calculate one of three states: `active`, `expired`, or
`revoked`. `lastUsedAt` records the last successful authentication, debounced to
at most one database write per minute. It can update even when the subsequent
route authorization returns `403`, so the UI labels it **Last authenticated**.

Rotate without downtime:

1. Create a second key with the same reviewed capabilities and an unambiguous
   name.
2. Update the extension's secret store and restart or reload it.
3. Verify one allowed operation and one deliberately denied operation with the
   new key.
4. Revoke the old key and verify it now receives `401`.

Revocation and expiry block new requests immediately. Long-lived agent SSE and
AG-UI streams revalidate scoped-key liveness on their 15-second heartbeat and
then close. They do **not** cancel an already-running turn or undo prior side
effects. In particular, revocation does not remove webhooks, schedules,
artifacts, agents, or already-issued signed URLs. Clean those up explicitly as
part of extension uninstall.

## Upgrade and verification checklist

Scoped keys created by an earlier Phase A build existed but could not reach any
business route. Upgrading to the fully annotated authorization matrix activates
their stored grants. Before rollout, list existing keys and revoke or rotate any
whose owner and purpose cannot be confirmed.

For each extension key, verify all of the following:

1. The key appears in **Settings → Access keys** with the intended name,
   capabilities, expiration, and `Active` status.
2. One representative request for every requested capability succeeds.
3. A request requiring an omitted capability returns `403` and the expected
   `requiredCapability`.
4. A master-only request such as `GET /api/config` returns `403` with
   `requiredCapability: null`.
5. If event emission is prefix-limited, an in-prefix event persists with
   `keyId` provenance and an out-of-prefix event has no side effect.
6. After revocation, normal requests return `401` and open streams close within
   approximately 15 seconds.
7. Extension-owned webhooks, schedules, artifacts, and other resources have an
   explicit uninstall or retention decision.

Keep the master token out of third-party extension environments. Continue to
use TLS, network policy, egress controls, rate limits, and a dedicated secret
store; a scoped key narrows API authority but is not a tenant boundary.
