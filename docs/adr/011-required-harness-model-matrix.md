# ADR 011: Required Harness × Model Matrix

**Date:** 2026-05-01
**Status:** Accepted
**Refines:** ADR 008 (Customer Readiness Release Gates)

## Context

ADR 008 names the smoke command but not which harness × model × scenario combos are release-required. Three harnesses are shipped (LangGraph, Claude Agents, PI Agent); five stress combos exist (`stress.tools.complete`, `stress.gemini.complete`, `stress.pi.complete`, `stress.pi-gemini.complete`, `stress.claude.complete`). Without a fixed required set, gate scope drifts and false-confidence/false-flake states both appear.

## Decision

**Required matrix — one combo per shipped harness:**

| Harness | Model | Stress event | Agent fixture |
| --- | --- | --- | --- |
| LangGraph | OpenAI (gpt-5.4) | `stress.tools.complete` | `stress-lg-openai` |
| PI Agent | OpenAI (gpt-5.4) | `stress.pi.complete` | `stress-pi-openai` |
| Claude Agents | Sonnet (claude-sonnet-4-6) | `stress.claude.complete` | `stress-claude-sonnet` |

**Extended matrix (must run, must not silently weaken required):**

- `stress.gemini.complete` (LangGraph + Gemini)
- `stress.pi-gemini.complete` (PI Agent + Gemini)
- HITL approve/reject (`stress-hitl`)
- Cancel-active-session
- Parallel multi-harness (T9 from `.tmp/ultraqa-test-plan.md`)
- Full Playwright visual suite

## Consequences

- Stage 5 (`ctx-x6b`, `ctx-1s5`) splits Playwright into `@smoke` (required, 3 stress combos + dashboard + files-tab) and `@extended` (everything else).
- Required gate runs without Gemini API access; Gemini failures don't block customer release.
- Cross-provider combinations stay in extended; their flakes don't gate merges.
- Test fixtures (`stress-lg-openai`, `stress-pi-openai`, `stress-claude-sonnet`) must be auto-seeded on a clean Docker stack — no manual setup before the smoke gate.
- OpenAI Agents and Vercel AI SDK harnesses (planned, not shipped per `docs/harness-ag-ui-inventory.md`) join the matrix when shipped; their addition is a follow-up ADR, not a Stage 5 deliverable.
