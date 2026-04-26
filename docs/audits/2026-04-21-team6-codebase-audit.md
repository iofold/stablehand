# 2026-04-21 Team6 Codebase Audit Tracking

This document tracks the read-only six-agent audit requested on 2026-04-21. The audit focused on hidden bugs, anti-patterns, random fallbacks, fail-open behavior, lifecycle drift, security boundaries, and test/build gaps.

The raw per-agent reports and evidence pack were generated under `.tmp/audit-2026-04-21-team6/`. That directory is intentionally ignored and should be treated as local supporting evidence, not the durable source of truth. Durable follow-up work is tracked by the beads below.

## Summary

- New beads created: 34
- Existing beads reused instead of duplicated: 2 direct, several partial overlaps noted
- Code changes made by this tracking pass: none
- Product/source behavior changed by this tracking pass: none

## New Beads

| ID | Priority | Type | Title |
| --- | --- | --- | --- |
| `ctx-v9d` | P0 | bug | Require authentication for published control-plane APIs |
| `ctx-g2l` | P0 | bug | Move sandbox secrets out of Docker environment variables |
| `ctx-kr4` | P1 | bug | Add SSRF and egress controls for orchestrator HTTP tools and webhooks |
| `ctx-pp9` | P1 | bug | Enforce artifact ownership on REST and daemon artifact reads |
| `ctx-yjx` | P1 | bug | Prevent cross-agent HTTP tool name collisions in the global registry |
| `ctx-tla` | P1 | bug | Fail closed when production SECRET_MASTER_KEY is missing |
| `ctx-epb` | P1 | bug | Remediate production dependency audit vulnerabilities |
| `ctx-aac` | P1 | bug | Enforce agent ownership before resolving live interrupts |
| `ctx-5ea` | P1 | bug | Keep timed-out HITL requests resumable for later human decisions |
| `ctx-vnk` | P1 | bug | Preserve per-turn cancellation ownership under concurrent messages |
| `ctx-7fz` | P1 | bug | Recover sessions stranded in RESTORING after orchestrator crash |
| `ctx-6nu` | P1 | bug | Suspend sandbox sessions only at safe execution phases |
| `ctx-xum` | P1 | bug | Validate daemon RPC session_id before turn, suspend, and kill actions |
| `ctx-660` | P1 | bug | Make event persistence ordered and durable before listener dispatch |
| `ctx-tn8` | P1 | bug | Roll back run-startup messages and turns after preparation failure |
| `ctx-d1o` | P1 | bug | Restore pending HITL cards from wrapped interrupts API responses |
| `ctx-9tk` | P1 | bug | Treat SSE ACTIVE snapshots as streaming only when an active turn exists |
| `ctx-nh2` | P1 | bug | Include proto JavaScript compilation in the package build |
| `ctx-0j2` | P1 | test | Put orchestrator-scenarios coverage under an active test runner |
| `ctx-60i` | P2 | bug | Clean up fresh session containers after startup partial failure |
| `ctx-yn5` | P2 | bug | Add durable retry or failure state for interrupt resume after approval |
| `ctx-jlg` | P2 | bug | Harden PTC tool API binding, auth, schema validation, and context |
| `ctx-62l` | P2 | bug | Make sandbox Playwright package installation fail closed |
| `ctx-330` | P2 | bug | Make trigger mutations durable and enforce logical uniqueness |
| `ctx-b2y` | P2 | bug | Preserve scheduled event ownership through queue emission and replay |
| `ctx-v5f` | P2 | bug | Add artifact object-store and DB metadata compensation |
| `ctx-u4p` | P2 | bug | Normalize session filters against API status values |
| `ctx-bfi` | P2 | bug | Render Agent Detail session load failures instead of empty state |
| `ctx-wrx` | P2 | bug | Render dashboard agent-list load failures instead of onboarding empty state |
| `ctx-gg6` | P2 | test | Make E2E and stress tests fail on unexpected error terminal states |
| `ctx-9wl` | P2 | test | Remove absolute pnpm store path mocks from LangGraph tests |
| `ctx-0zk` | P2 | test | Add strict console-error gating to UI Vitest |
| `ctx-ssm` | P3 | bug | Surface trigger row action failures in the UI |
| `ctx-rdb` | P3 | chore | Remove unseeded randomness from graph layout and concurrency tests |

## Existing Beads Reused

| Existing ID | Reason |
| --- | --- |
| `ctx-yci` | Already tracks the agent manifest version uniqueness/race issue found by the database audit. |
| `ctx-bfj` | Already tracks HTTP tool fail-closed config and ambient env-secret fallback. The new SSRF bead `ctx-kr4` is separate. |

## Partial Overlaps To Watch

These existing beads overlap adjacent areas but do not fully cover the new audit findings:

- `ctx-ark` and `ctx-pxm`: scheduled event queue reliability; `ctx-b2y` specifically tracks scheduled event ownership/replay drift.
- `ctx-bl4`: session status projection; `ctx-9tk` specifically tracks SSE snapshot false streaming state.
- `ctx-kga` and `ctx-x6b`: stress/harness coverage; `ctx-gg6` specifically tracks tests accepting `error` as success.
- `ctx-o6s`: daemon tool API logging; `ctx-jlg` specifically tracks PTC API auth/binding/schema/context hardening.
- `ctx-3ha` and `ctx-p5r`: sandbox Bun/runtime validation; `ctx-62l` specifically tracks masked Playwright package install failures.
- `ctx-1s5`: Playwright suite organization; `ctx-0j2` specifically tracks the orphaned `orchestrator-scenarios.test.ts` suite.

## Suggested Prioritization

1. Security boundary cluster: `ctx-v9d`, `ctx-g2l`, `ctx-kr4`, `ctx-pp9`, `ctx-yjx`, `ctx-tla`, `ctx-epb`, `ctx-aac`.
2. Lifecycle and durability cluster: `ctx-5ea`, `ctx-vnk`, `ctx-7fz`, `ctx-6nu`, `ctx-xum`, `ctx-660`, `ctx-tn8`, `ctx-d1o`, `ctx-9tk`.
3. Build and test gates: `ctx-nh2`, `ctx-0j2`, `ctx-gg6`, `ctx-9wl`, `ctx-0zk`.
4. P2 reliability and UI correctness: remaining P2 beads.
5. P3 polish/determinism: `ctx-ssm`, `ctx-rdb`.

