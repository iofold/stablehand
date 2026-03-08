# CTX Factory -- Architecture Synthesis

## 1. System Purpose

CTX Factory is a self-hosted agentic infrastructure stack that decouples agent orchestration from untrusted code execution. It uses Firecracker microVMs for zero-compute suspension (snapshot/resume) and a unified adapter layer supporting multiple agent frameworks (LangGraph, Letta, Raw SDK). The system enables agents to pause mid-execution when waiting for external events (human feedback, async tool results), snapshot the VM to disk, and resume from exactly that state when the event arrives -- paying zero compute cost during the wait.

---

## 2. Architecture Overview

### Bounded Contexts (5)

| Context | Responsibility | Runs In |
|---------|---------------|---------|
| **Agent Lifecycle** | Agent CRUD, FSM status transitions, tool request lifecycle, idempotency keys | Orchestrator process |
| **Execution Infrastructure** | Firecracker VM lifecycle, snapshot/resume, resume health check, warm pool | Orchestrator process |
| **Knowledge** | Vector search (pgvector), graph search (AGE/Cypher), full-text search | Orchestrator process |
| **Policy** | RBAC, input validation, SQL injection detection -- pure function library, Fastify middleware | Orchestrator process |
| **Sandbox** | FastAPI server, framework adapters (LangGraph/Letta/Raw), tool call bridge (HTTP back to orchestrator) | Inside Firecracker microVM |

### Key Architectural Patterns

- **Modular monolith**: Single Orchestrator process with logical module separation; no microservices
- **In-process event bus**: Node.js EventEmitter (typed) for hot-path coordination (e.g., tool.completed -> resume agent)
- **Reconciliation loop**: setInterval (30s) scans for stuck states as a safety net (Kubernetes-inspired)
- **No central orchestration service**: Each bounded context handles its own step via events
- **202 + Snapshot + Resume**: Agent hits async tool -> 202 Accepted -> VM snapshot -> external processing -> webhook resume
- **Dependency injection**: Three execution modes (dry-run, integration, production) swap implementations at the executor layer

### Component Interaction Diagram

```
+-------------------------------------------------------------------+
|                   CTX FACTORY (Single Deploy)                     |
|                                                                   |
|  +---------------------+  events  +---------------------------+   |
|  | AGENT LIFECYCLE      |<-------->| EXECUTION INFRASTRUCTURE  |   |
|  |                      |          |                           |   |
|  | - Agent CRUD + FSM   |          | - VM lifecycle (FC API)   |   |
|  | - Tool Requests      |          | - Snapshot/resume         |   |
|  | - Idempotency keys   |          | - Resume health check     |   |
|  +---------------------+          | - Warm pool               |   |
|          |                         +---------------------------+   |
|          | events                              |                   |
|          v                                     | HTTP (retry+bkoff)|
|  +---------------------+          +---------------------------+   |
|  | KNOWLEDGE            |          | SANDBOX (Python, in-VM)   |   |
|  |                      |          |                           |   |
|  | - Vector search      |          | - FastAPI resume endpoint |   |
|  | - Graph search (AGE) |          | - Framework adapters      |   |
|  | - Full-text search   |          |   (LangGraph/Letta/Raw)   |   |
|  +---------------------+          | - Tool call bridge (HTTP)  |   |
|                                    +---------------------------+   |
|  [Policy Middleware] -- Fastify onRequest hooks, not a service     |
|  [Event Bus] -- Node.js EventEmitter (typed)                      |
|  [Reconciliation Loop] -- setInterval safety net (30s)            |
|  [API Gateway] -- Fastify routes (composition root, no logic)     |
+-------------------------------------------------------------------+
```

### Module Dependency Rules

1. **Agent Lifecycle** -> Postgres (direct), Event Bus (publish)
2. **Execution Infrastructure** -> Firecracker API (unix socket), Event Bus (listen + publish)
3. **Knowledge** -> Postgres with pgvector + AGE (direct)
4. **Policy** -> nothing (pure function library, injected config)
5. **Sandbox** -> Orchestrator HTTP API (outbound tool calls only)
6. No module imports from another module's internals -- communicate via events or API layer

---

## 3. Tech Stack

| Component | Technology | Version | Rationale |
|-----------|-----------|---------|-----------|
| Orchestrator runtime | Node.js | 22 LTS (22.18+) | Native TS type-stripping, ESM stable |
| Language | TypeScript | 5.8+ | `erasableSyntaxOnly` flag support |
| HTTP framework | Fastify | 5.x | 30-80k req/s, built-in Ajv validation, plugin ecosystem |
| DB driver | postgres.js | 3.x | Lightest driver (~7kb), zero binary deps |
| ORM | Drizzle ORM | latest | Native pgvector support, raw SQL escape hatch for AGE |
| Validation | Zod | 3.24+ | Runtime schema validation for API inputs |
| Logging | Pino | 9.6+ | High-performance structured logging |
| Database | PostgreSQL | 16.x | Best AGE + pgvector compatibility |
| Vector search | pgvector | 0.8.2 | Latest stable, HNSW index support |
| Graph DB | Apache AGE | 1.6.0 (PG16) | Cypher queries in Postgres, stable release |
| Hypervisor | Firecracker | 1.14.1 | Direct API (no Moru), snapshot/resume, sub-200ms boot |
| Networking | CNI + tc-redirect-tap | -- | Battle-tested (Kata/firecracker-containerd), no NAT-on-NAT |
| Sandbox runtime | Python | 3.12.x | Debian-slim base (not Alpine -- musl breaks wheels) |
| Sandbox framework | FastAPI + uvicorn | 0.115+ / 0.34+ | Async, Pydantic validation, low memory (~45MB RSS) |
| Sandbox HTTP client | httpx | 0.28+ | Async HTTP for tool call bridge |
| Sandbox rootfs | Debian-slim (bookworm) | -- | 1GB ext4, 512MB VM RAM |
| Agent framework 1 | LangGraph | 0.3+ | Checkpoint-based interrupt/resume |
| Agent framework 2 | Letta | 0.6+ | Background mode with run_id/seq_id resume |
| Unit tests (Node) | Vitest | 3.0+ | Native ESM + TS, fast |
| Unit tests (Python) | pytest + pytest-asyncio | 8.3+ / 0.25+ | Async test support |
| Contract tests | Pact | -- | Cross-language consumer-driven contracts (TS <-> Python) |
| Property testing | fast-check | -- | Policy engine fuzzing |
| YAML fixtures | yaml (npm) | -- | Tool simulation test data |
| Integration tests | TestContainers | -- | Docker-based integration |
| Policy/security | LLM Guard (Protect AI) | -- | SQL injection detection, PII masking |
| Overlay FS | overlayfs + devmapper | -- | Shared base rootfs + per-agent writable layer |
| Clock sync | chrony | -- | NTP sync on VM resume |

---

## 4. Key Architecture Decisions

| # | Decision |
|---|----------|
| D1 | **Drop Moru, use Firecracker API directly** -- Moru is abandoned (5 stars, 4 months stale) |
| D2 | **MCP inside sandbox only, plain REST for orchestrator-sandbox** -- MCP is LLM-to-tool, not service-to-service |
| D3 | **Reduce to 5 bounded contexts (from 10)** -- eliminates God Service anti-pattern in orchestration |
| D4 | **In-process event bus + reconciliation loop** -- no central coordinator, Kubernetes-style self-healing |
| D5 | **Debian-slim sandbox base (not Alpine)** -- musl breaks Python wheels, 50x slower builds |
| D6 | **AGE 1.6.0 + pgvector 0.8.2** -- 1.5.0-rc0 is a release candidate, not stable |
| D7 | **LLM Guard for PII/SQL validation** -- 2.5M+ downloads, battle-tested; NeMo Guardrails is wrong abstraction |
| D8 | **Mandatory resume health check** -- NTP sync, connection retry (3x/50ms), entropy reseed, daemon verify |
| D9 | **Idempotency keys on all tool calls** -- LangGraph re-executes entire nodes on resume |
| D10 | **Pact contract tests for orchestrator-sandbox** -- cross-language TS/Python boundary, no shared types |
| D11 | **CNI + tc-redirect-tap for VM networking** -- Kata/firecracker-containerd pattern, no Docker bridge |
| D12 | **Overlay filesystem for agent state** -- shared immutable base + per-agent writable upper dir |

---

## 5. Technology Exclusions

| # | Excluded Tech | Rationale |
|---|--------------|-----------|
| E1 | **Kata Containers** | No snapshot API access, no userfaultfd, no checkpoint/restore -- hard blockers for suspend-to-disk |
| E2 | **firecracker-containerd** | Self-described "very early state", no snapshot/restore API integration, must bypass containerd anyway |
| E3 | **Moru** | Abandoned -- 5 GitHub stars, single developer, 4+ months without commits, E2B fork with minimal divergence |

---

## 6. Known Pitfalls

| # | Pitfall | Severity |
|---|---------|----------|
| 1 | **Connection reset after VM resume** -- mandatory retry loop (3x, 50ms backoff) on all orchestrator->sandbox calls | High |
| 2 | **Clock drift causing crypto/TLS failures** -- force NTP sync in resume health check before accepting requests | High |
| 3 | **UFFD handler crash = Firecracker infinite hang** -- watchdog process monitoring handler, kills FC on death | Critical |
| 4 | **LangGraph node re-execution on resume** -- idempotency keys on all tool calls, check-before-execute | High |
| 5 | **Memory bloat inflating snapshot size** -- trim page cache (madvise MADV_DONTNEED) before snapshotting | Medium |
| 6 | **Filesystem errors on cross-machine restore** -- identical disk paths across hosts, or overlayfs abstraction | Medium |
| 7 | **Snapshot invalidation on rootfs change** -- track rootfs version, discard snapshots when base image changes | Medium |
| 8 | **TCP connections don't survive resume** -- all in-VM services must handle reconnection gracefully | High |
| 9 | **AMD CPU TSC bug (nanosleep hangs)** -- verify Firecracker >= 1.14.1 (includes fix), test on AMD hardware | Low |
| 10 | **Multiple interrupts per LangGraph node** -- one interrupt per node, chain nodes for multi-interrupt flows | Medium |

---

## 7. Testing Architecture

### Three Execution Modes

| Mode | VMs | Tools | Policy | Time | LLM |
|------|-----|-------|--------|------|-----|
| **dry-run** | MockVMManager (in-memory) | Canned responses (YAML fixtures) | Real (always) | TestTimeProvider (skippable) | Fake (GenericFakeChatModel) |
| **integration** | Docker containers | Mock external APIs | Real | Real | Real (recorded/replayed via vcrpy) |
| **production** | Firecracker VMs | Real services | Real | Real | Real |

Swap happens at the **executor layer** (not API/controller layer) via DI container. Policy engine always runs real logic, even in dry-run.

### Key Testing Patterns

- **VMManager interface**: Swappable between FirecrackerVMManager and MockVMManager; mock simulates latency, connection reset, clock drift, packet loss
- **TestTimeProvider**: Inspired by Temporal's TestWorkflowEnvironment; `advanceBy(30 minutes)` fires all timers instantly; `sleep()` creates pending timers resolved by time advancement
- **MockToolRegistry**: Loads canned responses from YAML fixtures; records call trajectory for assertion (strict, unordered, subset, superset modes)
- **Pact contracts**: Consumer (Orchestrator/TS) defines expectations, provider (Sandbox/Python) verifies against contract JSON
- **Policy fuzzing**: fast-check generates adversarial tool arguments; YAML regression suites (FTW-inspired); shadow mode for new rules
- **Deterministic simulation** (future): FoundationDB/Antithesis-style single-process deterministic event loop with fault injection

### Testing Pyramid

| Layer | Runs When | Duration Target | What's Mocked |
|-------|-----------|-----------------|---------------|
| Unit | Every push | < 30s | Everything external |
| Component | Every push | < 2 min | VMs, tools, LLM, time |
| Contract (Pact) | Every push | < 1 min | No live services |
| Integration | PR merge | < 10 min | Real Docker sandbox, recorded LLM |
| E2E | Nightly | < 30 min | Nothing (or only external APIs) |
| Policy fuzzing | Nightly | < 15 min | Only tool execution |

---

## 8. Module Boundaries & Interfaces

### Agent Lifecycle

- **Exposes**: Agent CRUD, FSM transitions (created->booting->running->suspending->suspended->resuming->running), tool request create/resolve/fail/list, `findSuspendedWithCompletedTools()` query
- **Consumes**: Postgres (direct), Event Bus (publishes `tool.completed`, `tool.failed`)
- **Events emitted**: `agent.suspend_requested`, `agent.resume_ready`

### Execution Infrastructure

- **Exposes**: `VMManager` interface (create, start, stop, destroy, snapshot, resume, connect, status), resume health check sequence
- **Consumes**: Firecracker REST API (unix socket), Event Bus
- **Events emitted**: `vm.snapshot_completed`, `vm.resumed`, `vm.health_check_passed`

### Knowledge

- **Exposes**: Store chunks (with optional embedding), full-text search (`to_tsvector`), vector similarity search (`<=>`), graph entity CRUD (AGE Cypher)
- **Consumes**: Postgres with pgvector + AGE
- **Constraint**: All queries scoped to `agent_id` (no cross-agent data leakage)

### Policy

- **Exposes**: `PolicyEngine.evaluate(toolCall)` -> `{allowed, reason}`, Fastify `onRequest` middleware returning 403 on violation
- **Consumes**: Injectable config (policy rules), LLM Guard for SQL/PII checks
- **Constraint**: Pure function library, zero I/O, always runs real logic (never mocked)

### Sandbox (in-VM)

- **Exposes**: `GET /health`, `POST /resume` (accepts `ResumePayload`, delegates to active adapter)
- **Consumes**: Orchestrator HTTP API (`POST /tools/call` via tool bridge)
- **Adapters**: LangGraph (`Command(resume=...)` with `thread_id`), Letta (REST API to agent inbox), Raw SDK (JSON state serialize/restore)
- **Constraint**: No imports from orchestrator codebase; physically separate

### Coordination (Event Wiring)

- **Listeners**: `tool.completed` -> check if agent suspended -> emit `agent.resume_ready`; `agent.resume_ready` -> find snapshot -> resume VM -> emit `vm.resumed`; `vm.resumed` -> transition agent to running -> POST /resume to sandbox
- **Reconciliation**: `setInterval(30s)` calls `findSuspendedWithCompletedTools()`, emits `agent.resume_ready` for each stuck agent

### Testability Interfaces (Ports)

- `VMManager` -- create/start/stop/destroy/snapshot/resume/connect/status
- `TimeProvider` -- now()/sleep()/registerTimer()/advanceBy()
- `ToolExecutorRegistry` -- register/execute/has/list
- `EventBus` -- on()/emit() with typed events
- `AppContainer` -- DI container resolving implementations per execution mode

---

## 9. E2E Scenarios

| # | Scenario |
|---|----------|
| 1 | **Tool Call Flow**: Create agent -> POST /tools/call -> 202 -> resolve -> verify `tool.completed` event |
| 2 | **Full Agent Lifecycle**: created -> booting -> running -> suspending -> suspended -> (tool completes) -> resuming -> running -> terminated |
| 3 | **Policy Enforcement**: Allowed tool -> 202; denied tool -> 403; SQL injection -> 403; constraint violation -> 403; unknown tool -> 403 |
| 4 | **Idempotency**: Same idempotency key returns same request_id; different key creates new request |
| 5 | **Reconciliation Safety Net**: Suspended agent + completed tool -> manual reconcile -> `agent.resume_ready` emitted |
| 6 | **Resume Health Check** (privileged): Boot VM -> snapshot -> resume -> first health check fails (connection reset) -> retry succeeds -> clock within 2s of host |
| 7 | **Dry-Run Full Lifecycle**: MockVMManager + MockToolRegistry + TestTimeProvider; zero Firecracker processes; full event bus trace captured |
| 8 | **Time-Skipping Wait-for-Event**: Agent waits 24h -> advance 12h (instant) -> still suspended -> signal event -> resumes -> wall-clock < 500ms |

---

## 10. Task Overview

| # | Task Name | Bounded Context |
|---|-----------|----------------|
| 1 | Project Scaffolding & Docker Compose | Infrastructure |
| 2 | Postgres Image (pgvector 0.8.2 + AGE 1.6.0) | Infrastructure |
| 3 | Orchestrator Skeleton + Event Bus | Cross-cutting |
| 4 | Database Client | Cross-cutting |
| 5 | Agent Service (CRUD + FSM) | Agent Lifecycle |
| 6 | Tool Request Service (idempotency) | Agent Lifecycle |
| 7 | Policy Middleware (RBAC + injection detection) | Policy |
| 8 | VM Manager (Firecracker API wrapper) | Execution Infrastructure |
| 9 | Event-Driven Coordination Wiring | Cross-cutting (Coordination) |
| 10 | API Routes (composition root) | API Gateway |
| 11 | Sandbox FastAPI Server | Sandbox |
| 12 | Framework Adapters (LangGraph, Letta, Raw SDK) | Sandbox |
| 13 | Tool Call Bridge (Sandbox -> Orchestrator) | Sandbox |
| 14 | Sandbox Rootfs Build Pipeline | Execution Infrastructure |
| 15 | CNI Network Configuration | Execution Infrastructure |
| 16 | Knowledge Context -- Context Service | Knowledge |
| 17 | Contract Tests (Pact, Orchestrator <-> Sandbox) | Testing |
| 18 | End-to-End Integration Tests (8 scenarios) | Testing |
| 19 | Testability Interfaces & Execution Modes | Cross-cutting (Ports) |
| 20 | MockVMManager & VM Simulation | Testing |
| 21 | TestTimeProvider & Time-Skipping | Testing |
| 22 | MockToolRegistry & YAML Test Fixtures | Testing |
| 23 | Policy Fuzzing & Regression Suite | Testing |
