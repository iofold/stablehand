# kitchen-sink — Reference Example

## OVERVIEW

3 agents (LangGraph, Claude, PI) chained via events, 12 shared tools, HITL approval patterns. Canonical example for building multi-agent workflows in ctxmill.

## STRUCTURE

```
agents/
  langgraph-agent/agent.yaml    Chain starter — analyst role (LangGraph, gpt-5.4-mini)
  claude-agent/agent.yaml       Chain middle — writer role (Claude, claude-sonnet-4-6)
  pi-agent/agent.yaml           Chain end — auditor role (PI Agent, gpt-5.4-mini)
tools/
  index.ts                      Barrel export (11 tools)
  calculator.ts                 Arithmetic (no approval)
  weather.ts                    Mock weather lookup (no approval)
  execute-trade.ts              Stock trading (approval required)
  list-directory.ts             Directory listing (no approval)
  search-files.ts               Regex file search (no approval)
  read-file.ts                  File reading (no approval, 10KB limit)
  write-file.ts                 File writing (approval required, blocks .env/.git/.pem/.key)
  write-note.ts                 Note writing to notes/ dir (approval required)
  process-image.ts              Image metadata (no approval)
  exec-command.ts               Shell execution (approval required, 30s timeout)
  manage-files.ts               FS ops: copy/move/symlink/stat/chmod (approval required)
tests/
  manifest-validation.test.ts   YAML parsing, harness type, resource limits
  harness-compat.test.ts        Cross-harness compatibility, unique names
  manifest-conversion.test.ts   YAML -> AgentDefinition conversion
seed.ts                         Agent import + trigger registration script
```

## EVENT CHAIN FLOW

```
langgraph-analyst  --[analysis.complete]--> claude-writer  --[report.ready]--> pi-auditor
                   \--[analysis.complete]------------------------------------> pi-auditor
```

1. **Analyst** (LangGraph) — Gathers data via calculator/weather/search, emits `analysis.complete`
2. **Writer** (Claude) — Triggered by `analysis.complete`, writes report, emits `report.ready`
3. **Auditor** (PI) — Monitors both events, logs audit trail, emits `audit.logged`

Cascade protection: `MAX_TRIGGER_DEPTH=5` prevents infinite loops.

## WHERE TO LOOK

| Task | File(s) | Notes |
|------|---------|-------|
| Add an agent | `agents/{name}/agent.yaml` | Copy existing, change harness/model/tools |
| Add a tool | `tools/{name}.ts` + `tools/index.ts` | `defineTool({ name, input: z.object(...), handler })` |
| Add a trigger | `seed.ts` | POST to `/api/triggers` with eventType + taskTemplate |
| Run the example | `docker compose up --build -d && npx tsx seed.ts` | Seeds agents + registers triggers |
| Run tests | `pnpm test` | Validates manifests and cross-harness compat |

## AGENT MANIFEST PATTERN

```yaml
apiVersion: ctxmill.io/v1
kind: Agent
metadata:
  name: agent-id
  displayName: Human Name
  labels:
    example: kitchen-sink
    harness: langgraph|claude-agents|pi-agent
    chain-role: analyst|writer|auditor
    chain-order: "1"|"2"|"3"
spec:
  harness: harness-type
  harnessConfig:
    provider: openai|anthropic
    model: model-id
    apiKeyRef: "$secret:KEY_NAME"
  instructions: |
    System prompt
  tools:
    - ref: tool-name
  nativeTools:
    allowlist: [Read, Write, Edit, Bash]   # OR
    blocklist: [execute]                    # mutually exclusive
  mode: interactive
  resources:
    maxSessionDurationSeconds: 60
    maxTokensPerSession: 4000
```

## TOOL DEFINITION PATTERN

```typescript
import { defineTool } from 'ctxmill';
import { z } from 'zod';

export default defineTool({
  name: 'tool-name',
  description: 'What it does',
  requiresApproval: true,      // Optional: triggers HITL approval card in UI
  input: z.object({
    param: z.string().describe('Description'),
  }),
  handler: async (rawInput, ctx) => {
    const input = rawInput as { param: string };
    // ctx.workspaceDir — session-scoped workspace
    // ctx.logger — structured logger
    return 'result string';
  },
});
```

## SEEDING

```bash
# Default: http://localhost:3002
npx tsx seed.ts

# Custom API URL
API_URL=http://api.example.com npx tsx seed.ts
```

Imports all agent manifests via `/api/agents/import`, then registers event triggers via `/api/triggers`.
