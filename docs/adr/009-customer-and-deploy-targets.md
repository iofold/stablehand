# ADR 009: Customer and Deploy Targets

**Date:** 2026-05-01
**Status:** Accepted

## Context

The customer-readiness plan names release gates against the dev1 docker-compose stack only. We have two operational targets: dev1 (local docker-compose under traefik on `*.dev.example.com`) and dev2 (k3s on a tailnet-only host, exposed at the shared demo domain, images via `imagePullPolicy: Never`).

The customer-shape question shapes whether dev2 must pass release gates and how much we invest in image-build automation.

## Decision

Stablehand targets two customer modes simultaneously:

1. **DIY self-hosted** — customer runs their own docker-compose stack from the repo. Required gate: dev1 docker-compose `@smoke`.
2. **Hosted demo on dev2** — we operate dev2 for design partners. Required gate: dev2 `kubectl apply` deploy + `@smoke` against the demo domain.

Both gates are required release evidence. ADR 008's required-gate command list expands to include a dev2 deploy-smoke step.

## Consequences

- A new beads issue is required for the dev2 image-build pipeline (build → import into k3s containerd → `kubectl rollout restart`). Track 5 owns it.
- Documentation (Track 4 / Stage 4) must include a customer-facing DIY runbook and a hosted-demo onboarding note for design partners.
- Required gate command list (extends ADR 008):

  ```bash
  # Existing required gates
  pnpm typecheck
  pnpm -r build
  pnpm lint
  pnpm test
  pnpm test:e2e -- --project=chromium --grep @smoke

  # Added by this ADR
  scripts/deploy-dev2.sh   # builds, imports to k3s, rolls out
  pnpm test:e2e:smoke -- --base-url "$DEV2_DEMO_URL"
  ```

  Exact script names will be settled during Stage 5 implementation; this ADR fixes the contract that both targets must pass.
