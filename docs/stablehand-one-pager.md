# Stablehand

Run agents on a schedule on your own servers. They ask before risky actions, stop at a spend cap, and leave a receipt and a finished file.

Stablehand is an MIT-licensed runtime for agents that do recurring work without someone watching: morning research briefs, inbox triage, document review, evaluation campaigns. It runs on Docker Compose on a machine you control.

## A run, start to finish

1. A schedule fires, or another system emits an event. A trigger turns it into a background run for one agent.
2. The agent starts in its own Docker container. Its only way out to the internet is an egress proxy that allows the hosts you list.
3. When the agent reaches a tool you marked as risky, the run pauses and an approval card appears in every open tab and on your phone. The pending approval is stored in PostgreSQL, so it survives a restart.
4. The turn ends with its model, token counts, cost and approvals recorded next to the files it produced. A signed webhook tells your other services that a new file exists.

## What ships today

Schedules and triggers. Cron schedules are timezone-aware and record missed fires. Triggers match events and start background turns, and agents can chain to each other through events up to five levels deep.

Sandboxes and egress. Each agent session runs in a non-root container with `no-new-privileges`, CPU, memory and PID limits, on an internal Docker network. The egress proxy (mitmproxy with a policy addon) allows by method, host and path, blocks private and cloud-metadata addresses, and denies everything else.

Approvals. Approval cards, editable documents and structured field requests. Interrupts are written to the database first, so a pending approval survives an orchestrator restart and the session resumes or restores from its checkpoint after you answer.

Budgets and cost. Budget policies per agent and per tag are checked before each turn, with threshold webhooks. An optional LiteLLM gateway prices every model call. When spend evidence is lost, the turn shows as unpriced instead of $0.

Streaming and replay. Every event is written to PostgreSQL before any client receives it, so a reload, a second tab or a phone replays the same log and then follows it live. A certification run with up to 50 clients per agent made 11,700 deliveries with no ordering mismatches.

Durable queue. Bursts beyond sandbox capacity wait in a database-backed queue; callers get a typed `429 queue_full` before anything is written. A ten-wave endurance run completed 2,430 turns with 0 failures.

Checkpoints. Idle sessions checkpoint after five minutes: harness state plus a workspace archive of up to 100 MB. Secrets are never written to a checkpoint; they are injected again on restore.

Scoped keys. Extensions get revocable `cmk_` keys with a 12-verb capability vocabulary, and unclassified routes are master-only.

Agent loops. Each agent chooses LangGraph, the Claude Agent SDK or Pi in its YAML manifest. Tools, events, approvals, artifacts and the UI stay the same whichever loop runs.

Front ends. Runs stream as AG-UI events, so AG-UI renderers such as CopilotKit can display them, and `@stablehand/react` embeds the chat in your own app. A built-in render tool lets agents draw 15 kinds of chart, table and metric card in the reply.

Tools. Local TypeScript tools with Zod schemas, per-agent HTTP tools, artifact upload and download, and a browser tool. MCP and Composio provider classes exist in the code but are not registered yet.

## An agent manifest

```yaml
apiVersion: stablehand.io/v1
kind: Agent
metadata:
  name: overnight-analyst
spec:
  harness: langgraph            # or claude-agents, or pi-agent
  harnessConfig:
    provider: openai
    model: gpt-5.4-mini
    apiKeyRef: "$secret:OPENAI_API_KEY"
  instructions: |
    Browse and screenshot each source, then write and upload a one-page HTML brief.
  tools:
    - ref: browse
    - ref: screenshot
    - ref: artifact_upload
  mode: background
```

The full example, with its schedule and trigger, is in [packages/examples/overnight-analyst](../packages/examples/overnight-analyst).

## Security model

| Layer | Mechanism |
|---|---|
| Container | One container per agent session, non-root, `no-new-privileges`, CPU, memory and PID limits, a global concurrency cap |
| Network | Internal Docker network; the egress proxy is the only route out and denies unlisted hosts, private ranges and metadata addresses |
| Secrets | AES-256-GCM at rest; injected into the sandbox environment at start and never stored in checkpoints |
| Approvals | Tools you mark wait for a person; pending approvals are durable |
| API | Master token for operators, scoped capability keys for extensions, fail-closed route classification |
| Sandbox callbacks | Session-scoped HMAC credentials on the gRPC callback surface |

Known gaps are listed in [SECURITY.md](../SECURITY.md). The largest: sandboxes receive the provider keys and S3 credentials they use until the planned credential broker ships, and containers are not microVMs.

## Get started

Clone the repository and follow the [quickstart](../README.md#quickstart). Three steps end with the Overnight Analyst running on your machine.
