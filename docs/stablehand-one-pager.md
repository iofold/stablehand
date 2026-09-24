# Stablehand — The Harness-Agnostic Agent Runtime

**The execution layer between your agents and production.**

---

## The Problem

Every company building with AI agents hits the same wall: the agent *framework* (LangGraph, Claude Agents SDK, OpenAI Agents SDK) defines *what* your agent does — but nothing runs it safely, persists its state, streams its output to users, or lets you swap frameworks when a better one ships next quarter.

Today's options force you to choose:

| Approach | What You Get | What You Lose |
|----------|-------------|---------------|
| **Framework SDKs** (OpenAI, Anthropic, LangGraph) | Agent logic | Sandbox, persistence, UI, portability |
| **Sandbox providers** (E2B, Modal) | Code execution isolation | Orchestration, tools, state, UI |
| **Observability** (LangSmith, AgentOps) | Tracing & debugging | Runtime, execution, control |
| **Tool platforms** (Composio, MCP servers) | 1000+ integrations | No runtime, no isolation, no state |

**No single product gives you the full stack.** You end up gluing 4-5 services together — and you're still locked to one harness.

---

## Stablehand: One Runtime, Any Harness

Stablehand is a **self-hosted agent runtime** that treats agent frameworks as swappable harnesses. You define agents in YAML. Stablehand handles everything else.

```yaml
apiVersion: stablehand.io/v1
kind: Agent
metadata:
  name: deal-analyzer
spec:
  harness: claude-agents          # ← Swap to langgraph or pi-agent anytime
  harnessConfig:
    model: claude-sonnet-4-6
    apiKeyRef: "$secret:ANTHROPIC_API_KEY"
  instructions: |
    You are a deal analysis agent. Use the CRM and filing tools for current client context.
  tools:
    - ref: crm-lookup              # Local tool
    - mcp: salesforce-mcp           # MCP server
    - composio: slack/send-message  # Composio (500+ SaaS tools)
  mode: interactive
```

**One YAML. Any framework. Full production runtime.**

---

## What Ships

### Sandboxed Execution
Every agent run gets its own isolated sandbox with gRPC IPC. The default local runtime uses Docker containers; the dev2 Kubernetes target uses one Job/Pod per sandbox session. Resource limits, non-root execution, and secret isolation are built in. Outbound egress control is intentionally left to the host, cluster, firewall, service mesh, or gateway layer for now.

### 5 Tool Providers
| Provider | What It Does |
|----------|-------------|
| **Local** | In-process TypeScript tools with Zod validation |
| **MCP** | Model Context Protocol servers (stdio + HTTP) |
| **HTTP** | Any REST endpoint with auth + schema |
| **Composio** | 500+ SaaS integrations out of the box |
| **Artifact** | S3/MinIO file storage with signed URLs |

### Durable Human-in-the-Loop
Agents request approval → interrupt is persisted → human approves/rejects in the dashboard → the orchestrator resumes or restores the matching session. **State survives server restarts** (DB-persisted interrupts, not in-memory).

### Event-Driven Agent Chaining
Agents emit events. Triggers match events and spawn background runs on other agents. Build multi-agent workflows declaratively — analyst → writer → auditor — with cascade protection (depth limit = 5).

```
Agent A emits "analysis.complete"
  → Trigger fires Agent B with {{payload.analysis}}
    → Agent B emits "report.ready"
      → Trigger fires Agent C for audit
```

### AG-UI Streaming Dashboard
Real-time SSE streaming from harness execution to a React dashboard. Agents can render rich visual blocks — charts, tables, metric cards, network graphs — directly into the conversation, and subagent activity nests under its spawning Task card. Full management UI: activity dashboard with a live session table and spend/run analytics, chat, agent detail, run timelines, event log, trigger builder, tool registry, artifacts, access keys, and system settings.

### Durable Turn Queue
Bursts beyond sandbox capacity queue durably instead of failing: typed `429 queue_full` backpressure before any write, a leased single-flight dispatcher with warm/cold lanes and per-agent fairness, honest queue expiry, and restart-safe backlog drain. Certified with a ten-wave endurance run (2,430 turns, 0 failures).

### Scoped Access Keys
Revocable, capability-scoped API keys (`cmk_` tokens, 12-verb vocabulary, fail-closed on unclassified routes) so extensions and integrations run least-privilege instead of holding the master token. Managed via API, CLI, and the dashboard.

### Cost Control
Per-agent and per-tag budget policies, model-gateway routing via LiteLLM, and spend reconciliation with watermarked ingestion, quarantine, and honest settlement — lost spend evidence settles as visibly unpriced, never as a silent $0.

### Checkpoint / Resume
Sessions suspend cooperatively at safe execution phases. Full run state — messages, tool results, workspace files — captured and restored on resume. **Secrets never in checkpoints** — injected fresh into the sandbox environment. Long-running agents survive interruptions, restarts, and scaling events without losing progress.

### External Learning Hooks
Stablehand emits run, message, tool, and feedback events that an external learning service can consume. Domain retrieval should be exposed through explicit tools, MCP servers, HTTP providers, or webhook-connected services.

---

## The Harness-Agnostic Bet

The best agent framework changes every quarter. Six months ago it was LangGraph. Then Claude Agents SDK shipped hooks and code execution. Then PI Agent brought native coding tools. OpenAI Agents SDK replaced Swarm.

**Stablehand decouples your agent infrastructure from the framework of the month.**

| Harness | Framework | Strength | Swap Cost |
|---------|-----------|----------|-----------|
| `langgraph` | LangGraph (Python/JS) | Graph-based workflows, state machines | Change 1 line in YAML |
| `claude-agents` | Anthropic Claude SDK | Hooks, native tools, code execution | Change 1 line in YAML |
| `pi-agent` | PI Coding Agent | Native Read/Write/Bash/Edit/Grep | Change 1 line in YAML |

Your tools, events, triggers, secrets, artifacts, and UI all stay the same. Only the execution harness changes.

**This is how you avoid rewriting your agent infrastructure every time a new SDK ships.**

---

## Security Model — 10 Layers Deep

| Layer | Mechanism |
|-------|-----------|
| **Container isolation** | Dedicated Docker container per run, non-root, no-new-privileges |
| **Network control** | External host or cluster policy; no built-in Stablehand egress proxy |
| **Secret encryption** | AES-256-GCM at rest, env injection at runtime, never in checkpoints |
| **Resource limits** | CPU, memory, PID caps per container + global concurrency semaphore |
| **HITL gating** | Dangerous tools require human approval before execution |
| **Checkpoint security** | Secrets excluded, size-limited, safe-phase-only suspend |
| **Workspace isolation** | Per-session workspace with diff capture/restore |
| **Lifecycle policy** | Idle checkpoint scheduling + compatibility pause/resume + reconciliation |
| **Ownership checks** | DB-enforced per-agent resource scoping |
| **gRPC isolation** | Internal network only, authorization context per RPC |

---

## Case Studies

### Accounting Automation — mid-market accounting firm
**Problem**: An accounting firm needed agents that understand client-specific tax rules, automate document processing, and require human approval for filings.

**How Stablehand helps**: Domain agents defined in YAML with explicit client-context tools. HITL approval cards for high-stakes filings. Event chaining: document-ingestion agent → analysis agent → filing agent. Durable state — interrupted sessions resume exactly where they left off.

**Key value**: The accounting domain logic lives in agent definitions and tools. Stablehand provides the runtime, sandbox, approval flow, and streaming UI. When they needed to switch from LangGraph to Claude Agents for better reasoning, they changed one line per agent.

### Deep Customer Discovery Agents — B2B research platform
**Problem**: Building autonomous agents for customer context discovery, site map construction, and competitive analysis — long-running, multi-step workflows that need to survive interruptions.

**How Stablehand helps**: Deep agents orchestrated via event chaining — discovery agent finds pages → sitemap builder constructs structure → analysis agent extracts insights. Checkpoint/resume keeps multi-hour crawls alive through pauses. Sandboxed execution prevents runaway agents from consuming unbounded resources. Artifact storage persists discovered assets.

**Key value**: Stablehand handles the hard runtime problems (isolation, state, coordination) so the client's team focuses purely on agent intelligence.

---

## Competitive Position

|  | Stablehand | LangGraph Platform | CrewAI | E2B | OpenAI SDK |
|--|---------|-------------------|--------|-----|-----------|
| **Docker sandbox** | ✅ Native | ⚠️ Preview | ❌ | ✅ VM | ❌ |
| **Multi-harness** | ✅ 3+ | ❌ LangChain only | ❌ CrewAI only | ❌ N/A | ❌ OpenAI only |
| **Event chaining** | ✅ Triggers | ❌ | ❌ | ❌ | ❌ |
| **Durable HITL** | ✅ DB-first | ⚠️ Basic | ❌ | ❌ | ❌ |
| **Checkpoint/Resume** | ✅ Full | ⚠️ Graph-level | ❌ | ❌ | ❌ |
| **Streaming UI** | ✅ AG-UI + React | ⚠️ LangSmith | ⚠️ Enterprise | ⚠️ Basic | ❌ |
| **MCP tools** | ✅ + 4 others | ✅ | ⚠️ | ❌ | ✅ |
| **Self-hosted** | ✅ Docker Compose | ⚠️ Cloud-first | ⚠️ Cloud-first | ❌ Cloud-only | ❌ Cloud-only |
| **Durable persistence** | ✅ Full state (runs, messages, events, secrets, checkpoints) | ✅ Cloud-only | ❌ | ❌ | ❌ |
| **Egress control** | ⚠️ SSRF guard + optional host allowlist on orchestrator HTTP/webhooks; sandbox egress delegated to host/cluster | ❌ | ❌ | ⚠️ | ❌ |

---

## Architecture at a Glance

```
┌─────────────────┐     SSE      ┌──────────────────┐
│  React Dashboard │◄────────────│   Orchestrator    │
│  (AG-UI events)  │             │   (Fastify API)   │
└─────────────────┘             └────────┬─────────┘
                                         │ gRPC
                               ┌─────────┴──────────┐
                               │  Sandbox Containers  │
                               │  ┌────────────────┐  │
                               │  │ LangGraph Agent │  │
                               │  │ Claude Agent    │  │
                               │  │ PI Agent        │  │
                               │  └────────────────┘  │
                               └──────────────────────┘
                                         │
                    ┌────────────┬────────┴────────┬──────────┐
                    │            │                 │          │
              ┌─────┴─────┐ ┌───┴───┐ ┌──────────┴┐ ┌───────┴──┐
              │ PostgreSQL │ │  S3   │ │ MCP/HTTP  │ │ Composio │
              │            │ │MinIO  │ │  Tools    │ │ (500+)   │
              └───────────┘ └───────┘ └───────────┘ └──────────┘
```

---

## Get Started

```bash
git clone <repo> && cd stablehand
cp .env.example .env    # Add your API keys
docker compose up --build -d
# → Dashboard at http://localhost:3200
```

**One command. Full agent runtime. Any harness.**

---

*Stablehand is MIT-licensed and self-hosted. Your agents, your data, your infrastructure.*
