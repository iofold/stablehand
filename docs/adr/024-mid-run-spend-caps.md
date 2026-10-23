# ADR 024: Mid-Run Spend Caps Through Per-Session Gateway Keys

Date: 2026-10-22 (ctx-ycek; implements phase D, ctx-p1ui, of the sandbox
credential-injection proposal)
Status: Accepted

## Context

Budget policies were enforced only when a run was admitted (ADR 023 and the
cost-control spec): a run that started under budget could loop and spend
without limit until it ended. Every sandbox shared one LiteLLM runtime key,
so the gateway had no per-run handle to refuse with. The launch demo needs
the opposite: a looping agent that reaches its spend cap mid-run and stops
cleanly, with a receipt.

## Decisions

1. **One LiteLLM virtual key per sandbox session**, minted on the slow path
   (session open and restore), never per call. Alias
   `stablehand-session-<sessionId>`, the shared runtime key's model
   allowlist (narrowing per agent is deferred: harness helpers such as the
   Claude CLI's background model would start failing with 403s), no budget at
   mint, 24-hour expiry as a backstop. The key replaces
   `STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY` in that sandbox only. The
   orchestrator keeps the key's hash, never the secret.
2. **The cap is set per run, at run start.** The key's spend counter is reset
   and its `max_budget` set to the lower of the agent's
   `harnessConfig.limits.maxCostUsd` and the remaining headroom of the
   tightest matching policy that blocks on `costUsd`. Policy headroom is an
   advisory snapshot: the ledger lags reconciliation, and token or turn
   limits are not converted to dollars. A continuation of a paused (HITL) run
   keeps its cap and spend.
3. **Revoked when the runtime goes away**: on the session's transition to
   CHECKPOINTED or TERMINATED (the single status writer, ADR 020), on a
   failed start, and on a failed restore. A restore deletes any stale key with
   the same alias before minting.
4. **Fail open to today's behaviour.** Without
   `STABLEHAND_MODEL_GATEWAY_ADMIN_KEY`, or when minting or capping fails,
   the sandbox uses the shared key and budgets apply at admission only; this
   is logged. Gateway mode off is unchanged.
5. **The refusal must end the run, not stall it.** LiteLLM 1.93 refuses an
   over-budget key with a headerless 429 (verified on dev1 for
   `/v1/chat/completions`, `/v1/messages` and `/v1/responses`, streaming or
   not). The Anthropic and OpenAI SDKs, the Claude Code CLI and PI all retry
   that as a rate limit. The sandbox daemon therefore runs a loopback relay
   in front of the gateway that passes all traffic through unchanged except
   this refusal, which it rewrites to a terminal 400 with
   `x-should-retry: false` and a digit-free message, and records with the
   gateway's spent and cap numbers by turn correlation.
6. **A distinct terminal outcome.** Each harness adapter ends the turn with a
   typed error (`model_gateway_budget_exceeded`, with `spentUsd` and
   `capUsd`). The orchestrator maps it to `turns.stop_reason`:
   `budget_reached` when Stablehand set a cap for the run (with its source,
   cap and spend), otherwise `model_gateway_budget_exceeded` for a ceiling it
   did not set, never attributed to a Stablehand policy. The turn status stays
   `error` (the webhook contract is frozen); a `budget.reached` event goes on
   the canonical spine and the `RUN_ERROR` frame carries `code` and
   `stopReason`. One call can overshoot the cap: the call that crossed it.

## Consequences

- The cap is enforced by the gateway, so it holds for every harness and for
  calls the harness makes on its own behalf, but only for gateway-routed
  calls. Explicitly direct model branches (`apiKeyRef`/`baseUrl`) are not
  capped.
- A run's key spend is reset at each run start, so LiteLLM's per-key spend is
  per run, not per session. Attribution is unaffected: it comes from spend
  logs.
- Sandbox images must include the relay for the stop to be immediate; an
  older image still produces the typed outcome after its SDK gives up
  retrying.
- Amended by [ADR 026](026-campaign-gateway-keys.md): policy headroom now
  includes campaign-key spend with matching tags, and a budget with nothing
  spent in its window counts as zero spent rather than unknown, so the first
  run under a new budget is capped too.

Relevant code: `packages/stablehand/src/cost-control/session-gateway-keys.ts`,
`packages/stablehand/src/cost-control/litellm-key-client.ts`,
`packages/sandbox-daemon/src/harness/model-gateway-relay.ts`,
`packages/stablehand/src/orchestrator/agent-turn-service.ts`.
