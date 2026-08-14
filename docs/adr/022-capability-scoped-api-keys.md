# ADR 022: Capability-Scoped API Keys, Fail-Closed by Default

Date: 2026-08-14 (decision 2026-08-03, shipped 2026-08-13, WO-5)
Status: Accepted

Full design rationale:
[docs/plans/shipped/2026-07-27-scoped-api-keys.md](../plans/shipped/2026-07-27-scoped-api-keys.md)
and the operator guide [docs/scoped-api-keys.md](../scoped-api-keys.md).
This ADR records the load-bearing decisions.

## Decisions

1. **Token format**: `cmk_` + base62 secret; only the sha256 hash is stored.
   The plaintext is shown exactly once at creation.
2. **Capability vocabulary v1 is 12 coarse verbs** (e.g. `agents:read`,
   `agents:write`, `turns:start`, `artifacts:write`, `events:read`,
   `webhooks:manage`, `triggers:emit`) with exactly one parameterized form:
   `triggers:emit:custom.<prefix>.*`. Coarseness is deliberate — per-route
   grants invite drift and review fatigue at this stage.
3. **Fail-closed with no escape hatch**: a route without a
   `config.capability` annotation is master-only for scoped keys; an unknown
   capability string crashes at route registration. A coverage test pins the
   complete route→capability map (every route classified exactly once,
   hardcoded counts as a tripwire) so new routes fail CI until classified.
4. **Key lifecycle is create / list / revoke** (soft revoke, optional expiry
   fixed at creation). No rotation or un-revoke in v1.
5. **keyId provenance** (D5): every scoped request logs `{keyId, keyName}`;
   custom events emitted via `POST /api/triggers/emit` stamp `keyId` at the
   top level of the persisted envelope — outside the caller payload, so
   callers cannot forge it.
6. Live streams (SSE, AG-UI compat) revalidate key liveness on the heartbeat
   and drop fail-closed.

## Boundaries

- The capability model covers `/api/*` only. The ConnectRPC sandbox callback
  surface uses session-scoped HMAC credentials (see codebase-map, "Sandbox
  callback auth") and is out of scope here.
- Open mode (`CTXMILL_AUTH_DISABLED`, or tokenless outside production)
  bypasses the model entirely by design; production without a token is a
  fatal startup error.
- `last_used_at` records presentation, not authorization — a key rejected
  with 403 still stamps it. Dormancy sweeps must account for this.

## Consequences

- Extensions integrate with least-privilege keys instead of the master token
  (see EXTENDING.md); revocation does not delete the resources a key created.
- Adding any route now requires a conscious classification decision, enforced
  by test.
