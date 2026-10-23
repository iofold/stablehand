# ADR 026: Campaign Gateway Keys and Spend From Keys Stablehand Did Not Issue

Date: 2026-10-23 (ctx-hmm3, ctx-gfp8)
Status: Accepted

## Context

Budgets counted only the spend of Stablehand runs (the `turns` table). Some
of a campaign's model calls come from tools that are not runs, such as an
evaluation runner on the host that calls models through the same LiteLLM
gateway. Their spend reached the reconciler without a run correlation and
was quarantined as `missing_correlation`, so no budget counted it, and "one
spend cap covers the whole campaign" was not true.

The same reconciler read every row in the gateway's spend log. When another
workload shares the gateway with its own virtual keys (one staging gateway
carries a workload making about 1.5k–10k calls a day), every one of its calls became a quarantine row
in Stablehand's database, and a busy neighbour could fill the reconciler's
10k-row fetch window.

## Decisions

1. **Spend rows are classified by the key that made the call.** LiteLLM 1.93
   records the caller's token hash (`api_key`) and alias
   (`metadata.user_api_key_alias`) on every row:
   - the shared runtime key (by hash) and per-session keys (alias prefix
     `stablehand-session-`) are turn keys: rows are attached to their run or
     quarantined, as before;
   - a campaign key (by hash, from Stablehand's own records) is attributed to
     its campaign;
   - any other key is foreign: counted, never stored.
   A row without a key hash keeps the old behaviour (treated as Stablehand's).
2. **Foreign rows are not fetched.** The reconciler pages `/spend/logs/v2`
   once per filter: `api_key=<runtime hash>`, `key_alias=stablehand-session-`
   and `key_alias=stablehand-campaign-` (LiteLLM matches the alias as a
   substring, so the client re-checks the prefix). Each stream has its own
   page limit; when any stream truncates, the watermark stops at the earliest
   boundary. Foreign rows that still arrive are counted and summarised in one
   log line at most every 10 minutes.
3. **Campaign keys are minted by Stablehand.** `POST
   /api/model-gateway/campaign-keys` takes tags (required), models (each must
   be allowed for the runtime key), an optional `maxBudgetUsd`, an optional
   expiry (default 30 days) and an optional notify agent. The key's LiteLLM
   `max_budget` is the lower of `maxBudgetUsd` and the remaining headroom of
   the tightest matching budget that blocks on cost; minting is refused when
   that budget is used up. Stablehand stores the key's hash and returns the
   key once. Revoking deletes the LiteLLM key and stamps the record; records
   are never deleted, so spend that arrives after revocation is attributed.
4. **Campaign spend is a ledger of its own.** Each campaign-key transaction is
   a row in `model_gateway_campaign_spend` with no run, carrying a copy of the
   key's tags. Budget spend (admission, mid-run caps, the spend views) adds
   rows whose tags match the selector and whose call started inside the
   window. Campaign spend adds tokens and cost; it never adds to run counts.
5. **Alerts at several levels.** A budget may now carry up to four warn
   actions with distinct thresholds below its block threshold (for example
   50% and 85%); existing one-warn budgets are unchanged. After each
   reconciliation commit, campaign spend changes are summed per budget bucket
   and judged with the same crossing rule as runs, emitting `budget.threshold`
   with `campaignKeyId`. Webhooks are per agent, so the event reaches the
   webhooks of the key's notify agent when it has one; otherwise it is only
   on the event log.
6. **Master-only.** A campaign key is spending authority over the model
   providers, like key administration and budgets, which are master-only. No
   capability verb was added to the signed-off vocabulary of twelve.
7. **A budget with nothing spent is at zero, not unknown.** Remaining headroom
   used to skip a budget whose window had no recorded cost. A window with no
   runs and no campaign spend now counts as zero spent, so a new campaign's
   key gets the full cap. This also gives runs under a new budget a mid-run
   cap from the first run (ADR 024).

## Consequences

- One budget covers a campaign's runs and its campaign keys. The gateway stops
  a campaign key at its cap; admission stops new runs once the budget is used.
- The key's cap is read once, at mint. Runs that spend under the same tags
  afterwards count toward the budget, block new runs and raise alerts, but do
  not lower the key's cap, so total spend can pass the budget by what those
  runs spent after the key was minted (plus the one call that crosses a cap).
  LiteLLM's per-key spend never resets, while a `month-to-date` budget does;
  mint a new key for a new window.
- Campaign spend reaches budgets after the reconciler reads it, usually
  within seconds.
- Runs and campaign keys are judged separately for alerts. A threshold crossed
  only by their combined spend inside one reconciliation commit is not
  announced; the block still applies at admission.
- Two Stablehand deployments sharing one gateway still see each other's
  per-session keys (matched by alias) as unknown runs, as before.
- Classification relies on LiteLLM recording `api_key` and
  `metadata.user_api_key_alias` (verified on LiteLLM 1.93.0).

## Open decision

- Whether to add a scoped capability (for example `campaigns:manage`) so an
  extension's worker can mint its own campaign keys without the master token.
  Today an operator mints the key and hands it to the tool.

Relevant code: `packages/stablehand/src/cost-control/issued-gateway-keys.ts`,
`packages/stablehand/src/cost-control/campaign-gateway-keys.ts`,
`packages/stablehand/src/cost-control/litellm-spend-client.ts`,
`packages/stablehand/src/orchestrator/budget-enforcer.ts`,
`packages/stablehand/src/orchestrator/routes/model-gateway.ts`.
