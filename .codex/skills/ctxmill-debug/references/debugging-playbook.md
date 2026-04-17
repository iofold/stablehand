# ctxmill Debugging Playbook

Use these as evidence-gathering flows. Do not guess before collecting the listed state.

## Agent did not respond

```bash
bun scripts/ctxmill-debug.ts health
bun scripts/ctxmill-debug.ts agents get <agentId>
bun scripts/ctxmill-debug.ts sessions list <agentId>
bun scripts/ctxmill-debug.ts events list --agent <agentId> --limit 100
bun scripts/ctxmill-debug.ts interrupts list <agentId> --include-resolved
bun scripts/ctxmill-toolcalls.ts --agent <agentId> --session <sessionId>
```

Look for: failed health, missing agent, session `ERROR`, pending interrupt, terminal event, or tool error.

## Tool call failed

```bash
bun scripts/ctxmill-debug.ts tools list
bun scripts/ctxmill-toolcalls.ts --agent <agentId> --session <sessionId> --include-results
bun scripts/ctxmill-debug.ts events list --agent <agentId> --type run.tool_result --limit 100
bun scripts/ctxmill-debug.ts interrupts list <agentId> --include-resolved
```

Only run `tools test` if safe; it executes the tool in a synthetic context.

## Session is stuck or paused

```bash
bun scripts/ctxmill-debug.ts sessions get <agentId> <sessionId>
bun scripts/ctxmill-debug.ts interrupts list <agentId> --include-resolved
bun scripts/ctxmill-debug.ts sandbox metrics
bun scripts/ctxmill-debug.ts events list --agent <agentId> --limit 100
```

Look for pending HITL, sandbox lifecycle state, queue pressure, or missing terminal turn event.

## Conversation history looks wrong

```bash
bun scripts/ctxmill-debug.ts conversations summary <agentId>
bun scripts/ctxmill-debug.ts conversations messages <agentId> <conversationId> --json
bun scripts/ctxmill-debug.ts events list --agent <agentId> --type MESSAGE_COMMITTED --limit 100
```

Check `parts` ordering against `toolCalls`, and compare committed message events to persisted messages.

## Event trigger did not fire

```bash
bun scripts/ctxmill-debug.ts triggers list --agent <agentId>
bun scripts/ctxmill-debug.ts events list --agent <agentId> --type <eventType> --limit 100
bun scripts/ctxmill-debug.ts sessions active
```

Verify `agentId`, event `type`, trigger selector, and downstream session creation.

## Artifact missing

```bash
bun scripts/ctxmill-debug.ts artifacts list --agent <agentId> --session <sessionId>
bun scripts/ctxmill-toolcalls.ts --agent <agentId> --session <sessionId> --include-results
bun scripts/ctxmill-debug.ts events list --agent <agentId> --limit 100
```

Look for daemon-location tool failures (`artifact_upload`, `artifact_download`) and upload status.

## Full bundle

```bash
bun scripts/ctxmill-bundle.ts --agent <agentId> --session <sessionId> --out .ctxmill/debug/current
```

Read `summary.md` first, then inspect JSON files only as needed.
