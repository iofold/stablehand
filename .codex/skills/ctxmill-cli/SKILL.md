---
name: ctxmill-cli
description: Use when operating, debugging, or inspecting a ctxmill app via its HTTP API. Wraps full agent/session/conversation/event/artifact/file/secret/setting/trigger/webhook/knowledge/feedback CRUD plus SSE streaming, AG-UI runs, multipart and gzip uploads with bundled Bun TypeScript CLIs.
---

# ctxmill CLI

Use this skill when a developer or agent needs to operate or inspect a running ctxmill app without hand-writing `curl`/`jq` probes. Covers ~95% of the orchestrator HTTP API.

## First move

Use the bundled self-contained Bun TypeScript scripts before raw HTTP:

```bash
bun <skill-dir>/scripts/ctxmill.ts health
bun <skill-dir>/scripts/ctxmill.ts agents list
bun <skill-dir>/scripts/ctxmill.ts sessions active
```

Base URL resolution:

1. `--base-url <url>`
2. `CTXMILL_API_URL`
3. `API_BASE`
4. `http://localhost:3002`

Both orchestrator roots (`http://localhost:3002`) and API-prefixed roots (`https://host/api`) are supported.

## Operate loop

1. Check service: `ctxmill.ts health`, `config`, `sandbox metrics`, `settings get`.
2. Identify the agent: `agents list`, then `agents get <agentId>`.
3. Define or update agents: `agents create --from-file <path>` / `agents update <id> --from-file <path>`.
4. Drive a turn: `sessions message <agentId> --content "..."` or `sessions start <agentId> --task "..."` (add `--wait-for terminal --timeout <ms>` to block until done).
5. Stream live activity: `stream <agentId>` (SSE) or `run <agentId> --task "..."` (AG-UI run).
6. Identify runs/sessions: `sessions list <agentId>`, `sessions get <agentId> <sessionId>`, or `sessions active`.
7. Pull history: `conversations summary <agentId>` and `conversations messages <agentId> <conversationId>`.
8. Extract tool behavior: `ctxmill-toolcalls.ts --agent <agentId> --session <sessionId>`.
9. Inspect interrupts/events/artifacts: `interrupts list`, `events list`, `artifacts list`.
10. If still unclear, create a bundle: `ctxmill-bundle.ts --agent <agentId> --session <sessionId>`.

## Bundled scripts

- `scripts/ctxmill.ts` — main agent-friendly API CLI (operate + debug, ~95% API coverage).
- `scripts/ctxmill-toolcalls.ts` — extracts tool-call timeline from messages and events.
- `scripts/ctxmill-bundle.ts` — writes a redacted debug bundle under `.ctxmill/debug/<timestamp>/`.
- `scripts/ctxmill-tail.ts` — tails SSE/event logs and waits for sessions/events.

Run any script with `--help` for exact commands.

## Output rules

- Default output is concise and human-readable.
- Add `--json` for stable machine-readable JSON envelopes.
- Add `--out <dir>` on `ctxmill.ts` to save the full response JSON.
- Scripts redact secret-like keys by default; use `--no-redact` only when explicitly needed and safe.

## Mutation safety

- Destructive commands (`agents delete`, `secrets delete`, `webhooks delete`, `triggers delete`, `artifacts delete`, `files delete`, `knowledge shared delete`) refuse to run without `--yes` (or `CTXMILL_YES=1`). They exit code 4 (unsafe-blocked) when the guard fires.
- Mutation commands (`sessions cancel|message|start`, `interrupts resolve`, `tools test`, `triggers create|update|emit`, `artifacts upload`, `workspace upload`, anything that writes secrets/settings/webhooks/feedback) must be explicit in the user's task — do not invoke speculatively.
- Body input flags: `--data '<json>'` (inline) or `--from-file <path|->` (file or stdin).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | API/runtime error |
| 2 | Invalid CLI usage |
| 3 | Timeout / wait condition unmet |
| 4 | Unsafe operation blocked (missing `--yes`) |
| 5 | Unexpected response shape |

## References

Load only when needed:

- `references/api-map.md` — ctxmill HTTP endpoint map and response fields.
- `references/debugging-playbook.md` — focused playbooks for common failures.
- `references/output-contracts.md` — script output schemas and exit codes.
