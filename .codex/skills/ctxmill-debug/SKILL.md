---
name: ctxmill-debug
description: Use when debugging, inspecting, or operating a ctxmill app via its HTTP API; fetch agents, runs, sessions, session state, conversation history, tool calls, HITL interrupts, events, artifacts, files, and debug bundles with bundled Bun TypeScript CLIs.
---

# ctxmill Debug

Use this skill when a developer or agent needs to inspect a running ctxmill app without hand-writing `curl`/`jq` probes.

## First move

Use the bundled self-contained Bun TypeScript scripts before raw HTTP:

```bash
bun <skill-dir>/scripts/ctxmill-debug.ts health
bun <skill-dir>/scripts/ctxmill-debug.ts agents list
bun <skill-dir>/scripts/ctxmill-debug.ts sessions active
```

Base URL resolution:

1. `--base-url <url>`
2. `CTXMILL_API_URL`
3. `API_BASE`
4. `http://localhost:3002`

Both orchestrator roots (`http://localhost:3002`) and API-prefixed roots (`https://host/api`) are supported.

## Debug loop

1. Check service: `ctxmill-debug.ts health`, `config`, `sandbox metrics`.
2. Identify the agent: `agents list`, then `agents get <agentId>`.
3. Identify runs/sessions: `sessions list <agentId>`, `sessions get <agentId> <sessionId>`, or `sessions active`.
4. Pull history: `conversations summary <agentId>` and `conversations messages <agentId> <conversationId>`.
5. Extract tool behavior: `ctxmill-toolcalls.ts --agent <agentId> --session <sessionId>`.
6. Inspect interrupts/events/artifacts: `interrupts list`, `events list`, `artifacts list`.
7. If still unclear, create a bundle: `ctxmill-bundle.ts --agent <agentId> --session <sessionId>`.

## Bundled scripts

- `scripts/ctxmill-debug.ts` — main agent-friendly API CLI.
- `scripts/ctxmill-toolcalls.ts` — extracts tool-call timeline from messages and events.
- `scripts/ctxmill-bundle.ts` — writes a redacted debug bundle under `.ctxmill/debug/<timestamp>/`.
- `scripts/ctxmill-tail.ts` — tails SSE/event logs and waits for sessions/events.

Run any script with `--help` for exact commands.

## Output rules

- Default output is concise and human-readable.
- Add `--json` for stable machine-readable JSON.
- Add `--out <dir>` on `ctxmill-debug.ts` to save the full response JSON.
- Scripts redact secret-like keys by default; use `--no-redact` only when explicitly needed and safe.
- Prefer read-only commands. Mutation commands (`sessions cancel`, `interrupts resolve`, `tools test`) must be explicit in the user's task.

## References

Load only when needed:

- `references/api-map.md` — ctxmill HTTP endpoint map and response fields.
- `references/debugging-playbook.md` — focused playbooks for common failures.
- `references/output-contracts.md` — script output schemas and exit codes.
