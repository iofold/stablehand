# packages/ui — React Dashboard

## OVERVIEW

Vite + React 18 + Zustand + Tailwind CSS. SSE streaming from orchestrator. 10 pages, 7 agent detail tabs, A2UI chart rendering (15 Recharts types), HITL approval cards. Dark mode, WCAG AA. 78 source files.

## STRUCTURE

```
src/
  pages/              10 route pages (Dashboard, Chat, AgentDetail, RunDetail, Events, Tools, Flow, Knowledge, Triggers, Settings)
  components/
    a2ui/             Agent-to-UI block renderer (5 files — 15 chart types via Recharts)
    agent/            Agent detail tabs: Overview, Knowledge, Runs, Tools, Files, Subagents, Secrets (8 files, has index.ts barrel)
    agents/           Agent list, create/edit modals — AgentFormModal (3 files)
    chat/             ChatThread, ChatInput, message streaming, tool call rendering (6 files)
    charts/           15 Recharts wrappers — bar, line, area, pie, radar, scatter, funnel, treemap, etc. (15 files)
    dashboard/        Dashboard widgets and stat cards (4 files)
    explorer/         File browser and code viewer
    hitl/             ApprovalCard, EditableDocument, FieldRequestForm (3 files)
    tools/            Tool execution UI and test interface
    ui/               Sidebar, layout, shared primitives (5 files)
  stores/             3 Zustand stores (agents, conversation, interrupt) + 2 colocated tests in __tests__/
  lib/                API client (api.ts), SSE hook (useSSE.ts), A2UI helpers, utils (6 files)
  hooks/              useAgentDetail, useAgentKnowledge, useAgentRuns — data fetching hooks (3 files)
```

## WHERE TO LOOK

| Task | File(s) | Notes |
|------|---------|-------|
| Add a page | `pages/*.tsx` + `App.tsx` route + `Sidebar.tsx` nav | React Router, lazy loaded |
| Add agent detail tab | `components/agent/*.tsx` + `AgentDetailPage.tsx` TABS array | TabId type union |
| Add a chart type | `components/charts/*.tsx` + `components/a2ui/A2UIBlock.tsx` registry | Recharts wrapper + registry entry |
| Modify API calls | `lib/api.ts` | `apiFetch<T>()` and `apiMutate<T>()` helpers |
| Add global state | `stores/*.ts` | Zustand with `create()`, selectors pattern |
| Modify SSE handling | `lib/useSSE.ts` + `stores/conversation.ts` | EventSource → Zustand updates |
| Add HITL interaction | `components/hitl/*.tsx` + `stores/interrupt.ts` | ApprovalCard → sendInterrupt API |

## CONVENTIONS (differs from backend)

- **Vite proxy** — `/api` proxied to `orchestrator:3001` in dev (vite.config.ts). Port configurable via `CTXMILL_UI_PORT` (default 3200)
- **Path alias** — `@/` maps to `src/` (Vite + vitest only, not in backend)
- **Tailwind theme** — Custom colors: `accent` (teal), `surface` (grayscale), `highlight` (amber), `status-*` (success/warning/error/info)
- **Fonts** — Inter (sans), JetBrains Mono (mono)
- **SSE auto-reconnect** — `useSSE` hook reconnects on error
- **No barrel exports** — Direct imports from component files (unlike backend barrel pattern)
- **Component files** — PascalCase `.tsx` files, one component per file
- **No CSS modules** — Tailwind utility classes only
- **jsdom test environment** — UI tests run in jsdom (packages/ui/vitest.config.ts), globals enabled
- **State selectors** — Zustand stores use selector pattern for optimal re-renders
