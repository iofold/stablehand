# ADR 023: Honest Settlement of Model-Gateway Spend

Date: 2026-08-14 (detector shipped 2026-08-12 ctx-fpi1; auto-settlement
2026-08-13 ctx-qqqp)
Status: Accepted

## Context

Turns routed through the model gateway carry a correlation id that the
reconciler matches against LiteLLM spend logs to price usage. Two real-world
failure classes leave a turn permanently unpriceable: (a) the turn errored
before any billable call, so no spend row will ever exist; (b) LiteLLM's
spend writer drops a row (~1 per thousand calls observed under c8 load).
Unpriced turns must not silently read as $0, and they must not pin the
gateway state degraded forever.

## Decisions

1. **Degradation is explicit, never silent** (ctx-fpi1). Stalled ingestion
   (watermark lag) and completed gateway turns awaiting prices past a grace
   period both surface as `state: degraded` on `/api/model-gateway/status`,
   and performance profiles that require a healthy gateway refuse to run
   against it.
2. **Permanently lost evidence settles as `coverage: unpriced`** — token
   telemetry preserved, `usage_reconciled_at` stamped — never as a fabricated
   $0-complete. This was applied manually four times before being automated.
3. **The reconciler auto-settles abandoned turns** inside its fenced pass:
   gateway-attributed turns still unreconciled past a 10-minute abandonment
   grace (strictly below the status route's 15-minute degraded threshold)
   settle as unpriced, each loss individually logged, `settledUnpriced`
   reported per pass. Bounded per-turn losses therefore self-heal while
   systemic ingestion failure still trips the watermark-lag arm.
4. **Spend queries price from reconciled usage envelopes** (ctx-vjdb), so an
   unpriced turn contributes a visible coverage gap, not a silent zero.

## Operational corollaries (learned during endurance certification)

- Workers AI routes must carry explicit per-token costs and skip the AI
  Gateway cache: LiteLLM's price map misses under the compat-route prefix,
  and cache hits replay the same response id, which LiteLLM dedupes in
  SpendLogs — a cache hit would otherwise produce no billing evidence at all.
  See the comment block in `deploy/compose/model-gateway/config.yaml`.
- Never provision short-lived `cfoat_` OAuth tokens as provider credentials.

## Consequences

- The gateway health gate is trustworthy: degraded means action needed now,
  not accumulated ghosts.
- Reconciler robustness debt is tracked separately (ctx-wpln: backoff,
  10k-row stall, poison-pill watermark, request timeouts).

Relevant code: `packages/stablehand/src/cost-control/model-gateway-reconciler.ts`,
`packages/stablehand/src/orchestrator/routes/model-gateway.ts`,
`packages/stablehand/src/database/repository.ts` (`settleAbandonedGatewayTurns`).
