# stablehand Debugging Playbook

Use these as evidence-gathering flows. Do not guess before collecting the listed state.

## Agent did not respond

```bash
bun scripts/stablehand.ts health
bun scripts/stablehand.ts agents get <agentId>
bun scripts/stablehand.ts turns list <agentId>
bun scripts/stablehand.ts events list --agent <agentId> --limit 100
bun scripts/stablehand.ts interrupts list <agentId> --include-resolved
bun scripts/stablehand-toolcalls.ts --agent <agentId> --turn <turnId>
```

Look for: failed health, missing agent, turn `ERROR`, pending interrupt, terminal event, or tool error.

## Tool call failed

```bash
bun scripts/stablehand.ts tools list
bun scripts/stablehand-toolcalls.ts --agent <agentId> --turn <turnId> --include-results
bun scripts/stablehand.ts events list --agent <agentId> --type tool_call.completed --limit 100
bun scripts/stablehand.ts interrupts list <agentId> --include-resolved
```

Only execute `tools test` if safe; it invokes the tool in a synthetic context.

## Turn is stuck or its sandbox is paused

```bash
bun scripts/stablehand.ts turns get <agentId> <turnId>
bun scripts/stablehand.ts interrupts list <agentId> --include-resolved
bun scripts/stablehand.ts sandbox-sessions active
bun scripts/stablehand.ts sandbox metrics
bun scripts/stablehand.ts events list --agent <agentId> --limit 100
```

Look for pending HITL, the turn status, the distinct sandbox lifecycle status, queue pressure, or a missing terminal turn event. Use `sandbox-sessions restore <agentId> <sandboxSessionId>` only when the sandbox is checkpointed and restoration is explicitly requested.

## Conversation history looks wrong

```bash
bun scripts/stablehand.ts conversations summary <agentId>
bun scripts/stablehand.ts conversations snapshot <agentId> <conversationId> --json
bun scripts/stablehand.ts events list --agent <agentId> --type message.committed --limit 100
```

Check `parts` ordering against `toolCalls`, and compare committed message events to persisted messages.

## Event trigger did not fire

```bash
bun scripts/stablehand.ts triggers list --agent <agentId>
bun scripts/stablehand.ts events list --agent <agentId> --type <eventType> --limit 100
bun scripts/stablehand.ts conversations active
bun scripts/stablehand.ts turns list <agentId>
```

Verify `agentId`, event `type`, trigger selector, and downstream turn creation.

## Artifact missing

```bash
bun scripts/stablehand.ts artifacts list --turn <turnId>
bun scripts/stablehand-toolcalls.ts --agent <agentId> --turn <turnId> --include-results
bun scripts/stablehand.ts events list --agent <agentId> --limit 100
```

Look for daemon-location tool failures (`artifact_upload`, `artifact_download`) and upload status.

## Full bundle

```bash
bun scripts/stablehand-bundle.ts --agent <agentId> --turn <turnId> --out .stablehand/debug/current
```

Read `summary.md` first, then inspect JSON files only as needed.
