# kitchen-sink — Reference Example

## OVERVIEW

3 agents (LangGraph, Claude, PI) chained via events, 11 shared tools (10 registered by default; `exec-command` is opt-in), HITL approval patterns. Canonical example for building multi-agent workflows in stablehand.

## STRUCTURE

```
agents/
  langgraph-agent/agent.yaml    Chain starter — analyst role (LangGraph, gpt-5.4-mini)
  claude-agent/agent.yaml       Chain middle — writer role (Claude, claude-sonnet-4-6)
  pi-agent/agent.yaml           Chain end — auditor role (PI Agent, gpt-5.4-mini)
  test-*/agent.yaml             Feature-test agents (skills, subagents); seeded only with KITCHEN_SINK_TEST_AGENTS=1
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
  exec-command.ts               Host shell execution (OFF unless STABLEHAND_ENABLE_EXEC_COMMAND=1; approval required)
  manage-files.ts               FS ops: copy/move/symlink/stat/chmod (approval required)
tests/
  manifest-validation.test.ts   YAML parsing, harness type, resource limits
  harness-compat.test.ts        Cross-harness compatibility, unique names
  manifest-conversion.test.ts   YAML -> AgentDefinition conversion
seed.ts                         Agent import + trigger registration script
```

## HOST SHELL TOOL (`exec-command`) IS OPT-IN

Project tools run inside the orchestrator process, not in the agent's sandbox. The orchestrator
image ships this directory as its default project (`/app/project/tools`), and the stock compose
orchestrator runs as root with the Docker socket mounted, so a shell tool there is a root shell
on the host. `exec-command` therefore:

- is not registered unless the orchestrator's environment sets `STABLEHAND_ENABLE_EXEC_COMMAND=1`
  (exactly `1`; the module's default export is `undefined` otherwise, so tool discovery skips
  it, and the handler refuses to run if called anyway);
- when enabled, runs each command as an unprivileged user (`nobody`, 65534, when the
  orchestrator is root; override with `STABLEHAND_EXEC_COMMAND_UID` / `_GID`, never `0`) with
  only `PATH`, `HOME` and `LANG` in its environment;
- still requires approval for every call.

Enable it only on a disposable local stack, for example with a compose override that adds
`STABLEHAND_ENABLE_EXEC_COMMAND: "1"` to the `orchestrator` service. `docker-compose.yml` does
not pass the variable through. For shell access inside an agent's own sandbox, use the
harness's native tools (Claude `Bash`, PI `bash`) instead.

## EVENT CHAIN FLOW

```
langgraph-analyst  --[analysis.complete]--> claude-writer  --[report.ready]--> pi-auditor
                   \--[analysis.complete]------------------------------------> pi-auditor
```

1. **Analyst** (LangGraph, `mode: interactive`) — You start the chain by chatting with it. Gathers data via calculator/weather/search, emits `analysis.complete`
2. **Writer** (Claude, `mode: both`) — Triggered by `analysis.complete`, writes report, emits `report.ready`
3. **Auditor** (PI, `mode: both`) — Triggered by both events, logs audit trail, emits `audit.logged`

Triggers start **background** runs, so every trigger target must declare `mode: background` or
`mode: both`. An `interactive`-only target refuses the run (`agent_mode_not_allowed`); the firing
is recorded as failed and listed by `GET /api/triggers/failures` and on the Triggers page. `both`
keeps the writer and auditor available for direct chat too.
`tests/integration/kitchen-sink-chain.test.ts` seeds this directory with `seed.ts` against a real
orchestrator and checks that every trigger-started run is admitted.

Cascade protection: `MAX_TRIGGER_DEPTH=5` prevents infinite loops.

## WHERE TO LOOK

| Task | File(s) | Notes |
|------|---------|-------|
| Add an agent | `agents/{name}/agent.yaml` | Copy existing, change harness/model/tools |
| Add a tool | `tools/{name}.ts` + `tools/index.ts` | `defineTool({ name, input: z.object(...), handler })` |
| Add a trigger | `seed.ts` | POST to `/api/triggers` with eventType + taskTemplate |
| Run the example | `docker compose up --build -d && npx tsx seed.ts` | Seeds the three chain agents + registers triggers; the orchestrator image does not seed them on its own |
| Run tests | `pnpm test` | Validates manifests and cross-harness compat |

## AGENT MANIFEST PATTERN

```yaml
apiVersion: stablehand.io/v1
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
    provider: openai|anthropic|google
    model: model-id
    apiKeyRef: "$secret:KEY_NAME"
  instructions: |
    System prompt
  tools:
    - ref: tool-name
  nativeToolPolicy:
    policy: allow # all | allow | deny | none
    names: [Read, Write, Edit, Bash] # required only for allow or deny
  mode: interactive # interactive (chat only) | background (trigger/API runs only) | both
  egress: # optional; omit for the server allowlist (docs/sandbox-egress.md)
    mode: allow # default | deny | allow
    rules: ["GET docs.example.com/**"] # <METHOD|*> <host>[:<port>][/<path>]
```

## TOOL DEFINITION PATTERN

```typescript
import { defineTool } from 'stablehand';
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

Creates each agent manifest with `POST /api/agents` (or updates an already-seeded agent of the same
name with `PATCH /api/agents/:id`), then registers or reconciles the event triggers via `/api/triggers`.
Re-run it after pulling manifest changes.
