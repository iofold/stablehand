# packages/ui - React Dashboard

## Overview

Vite + React 18 + Zustand + Tailwind dashboard for Stablehand operations. It talks to authenticated `/api/*` routes through `lib/api.ts`, stores the API token in localStorage via `TokenGate`, and streams canonical SSE frames through `lib/useSSE.ts` into Zustand stores.

## Structure

```text
src/
  pages/        Dashboard, agent detail, session, events, tools, flow, artifacts, triggers, settings
  components/
    a2ui/       A2UI block renderer and catalog registry
    agent/      Agent detail tabs and session/file/tool views
    agents/     Agent list and create/edit modals
    artifacts/  Artifact browsing
    dashboard/  Dashboard widgets
    explorer/   File browser/code viewer
    hitl/       Approval/editable-document/field-request UI
    session/    Chat/session thread, input, message bubble, tool-call cards
    tools/      Tool registry/test-run UI
    ui/         Layout, sidebar, token gate, shared primitives
  stores/       agents, artifacts, conversation, interrupt
  lib/          API client, auth helpers, SSE hook, routes, A2UI/session utilities
  hooks/        Data-fetching hooks
```

## Where To Look

| Task | File(s) | Notes |
|---|---|---|
| Add a page | `pages/*.tsx`, `App.tsx`, `components/ui/Sidebar.tsx` | Keep routes in `lib/routes.ts` where applicable. |
| Change auth | `lib/auth.ts`, `components/ui/TokenGate.tsx`, `lib/api.ts` | Fetches use bearer headers; EventSource uses `access_token`. |
| Change SSE handling | `lib/useSSE.ts`, `stores/conversation.ts` | Default stream wire is canonical; selected `stablehand.*` custom names map to UI behavior. |
| Change session UI | `pages/SessionPage.tsx`, `components/session/*` | Tool call cards and message bubbles must fit mobile. |
| Change Events page | `pages/EventsPage.tsx` | `/api/events` is operational log data, not just AG-UI run frames. |
| Add A2UI component | `components/a2ui/CatalogRegistry.tsx`, `components/a2ui/A2UIBlock.tsx` | Keep unknown-component fallback safe. |

## Gotchas

- Do not assume the dashboard can set EventSource headers; token auth goes through `?access_token=`.
- The React embed package is separate from this dashboard and does not imply full dashboard feature parity.
- Keep text and JSON responsive on mobile; several release audits have caught clipping in Events and tool-call cards.
- UI setting ranges should match backend validators in `packages/stablehand/src/orchestrator/routes/settings.ts`; verify before changing either side.

## Verification

- Run `pnpm -C packages/ui test` for UI logic.
- Run `pnpm -C packages/ui typecheck` or root `pnpm -r typecheck` for type changes.
- For visible UI/API-shape changes, rebuild Docker and capture agent-browser screenshots/console/errors under `.tmp/`.
