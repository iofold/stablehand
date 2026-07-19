# Script Output Contracts

## Shared flags

- `--base-url <url>`: ctxmill API root. May be root or `/api`-prefixed.
- `--api-token <token>`: bearer token for authenticated deployments. Defaults to `CTXMILL_API_TOKEN`.
- `--json`: emit stable JSON.
- `--pretty`: emit concise human-readable output. Default for most commands.
- `--raw`: print raw API JSON without summarization.
- `--out <dir>`: write full JSON response or bundle artifacts.
- `--redact` / `--no-redact`: redact secret-like keys by default.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | API/request error or unexpected runtime failure |
| 2 | Invalid CLI usage |
| 3 | Timeout / wait condition unmet |
| 4 | Unsafe operation blocked |
| 5 | Unexpected response shape |

## `ctxmill.ts --json`

```json
{
  "command": "agents list",
  "baseUrl": "http://localhost:3002",
  "endpoint": "GET /api/agents",
  "data": {},
  "warnings": []
}
```

If `--raw` is present, only the API payload is emitted.

## `ctxmill-toolcalls.ts --json`

```json
{
  "agentId": "agent-id",
  "turnId": "turn-id",
  "conversationId": "conversation-id",
  "toolCalls": [
    {
      "id": "tool-call-id",
      "name": "tool-name",
      "status": "complete",
      "args": "{}",
      "result": "truncated or full with --include-results",
      "messageId": "message-id",
      "events": []
    }
  ],
  "events": []
}
```

## `ctxmill-bundle.ts`

Writes files under the selected output directory:

```text
summary.md
manifest.json
health.json
config.json
agent.json
turns.json
turn.json
conversations.json
messages.json
toolcalls.json
interrupts.json
events.json
artifacts.json
sandbox-metrics.json
```

Missing optional resources are recorded in `manifest.json.warnings` instead of aborting the whole bundle.
