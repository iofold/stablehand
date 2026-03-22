# CTXMill Agent Capabilities Matrix

**Purpose**: Comprehensive reference for stress testing all agent capabilities across harnesses, tools, providers, and features.

---

## 1. TOOLS (12 Shared + Extensible)

### Local Tools (In-Process Execution)

| Tool | Category | Input | Output | Approval | Workspace | Notes |
|------|----------|-------|--------|----------|-----------|-------|
| **calculator** | Math | `{operation: enum, a: number, b: number}` | String result | No | N/A | add, subtract, multiply, divide; handles div-by-zero |
| **weather** | Data | `{city: string}` | String (mock) | No | N/A | Mock data for NYC, London, Tokyo, Sydney |
| **read-file** | I/O | `{path: string}` | File content (10KB max) | No | Yes | Path traversal protected; relative to workspace |
| **write-file** | I/O | `{path: string, content: string}` | Confirmation | **Yes** | Yes | Blocks .env, .git, credentials, .pem, .key, .secret, .token |
| **list-directory** | I/O | `{path: string}` | Dir listing (100 entries max) | No | Yes | Filters .* and node_modules; shows size/type |
| **search-files** | I/O | `{pattern: string, directory: string, fileExtensions?: string[]}` | Matches (50 max) | No | Yes | Regex search; depth limit 5; 50 result cap |
| **manage-files** | I/O | `{operation: enum, source: string, destination?: string, mode?: string}` | JSON result | **Yes** | Yes | copy, move, symlink, stat, chmod; path traversal protected |
| **exec-command** | Execution | `{command: string, timeout?: number}` | `{exitCode, stdout, stderr}` | **Yes** | Yes | 30s default timeout; 1MB stdout, 5KB stderr cap |
| **execute-trade** | Business | `{action: enum, symbol: string, shares: number, orderType?: enum, limitPrice?: number}` | JSON order | **Yes** | N/A | Simulated execution; buy/sell; market/limit orders |
| **process-image** | Media | `{filePath: string}` | JSON metadata | No | Yes | Size, format, base64 header; supports 8 formats |
| **write-note** | I/O | `{filename: string, content: string}` | Confirmation | **Yes** | Yes | Restricted to notes/ directory; session-scoped |
| **emit-event** | Events | `{type: string, payload: object}` | JSON confirmation | No | N/A | Emits custom event on EventBus; triggers chaining |

**Stress Test Coverage**:
- Path traversal attacks on all file tools
- Large file reads (>10KB truncation)
- Regex DoS on search-files
- Division by zero, negative numbers on calculator
- Command injection on exec-command
- Approval timeout scenarios
- Concurrent file operations (race conditions)
- Session-scoped note isolation

---

## 2. TOOL PROVIDERS (4 Types)

### Provider Types & Capabilities

| Provider | Transport | Discovery | Execution | Auth | Caching | Notes |
|----------|-----------|-----------|-----------|------|---------|-------|
| **Local** | In-process | Registry | Direct call | N/A | N/A | Wraps LocalFunctionExecutor; 12 kitchen-sink tools |
| **MCP** | stdio/HTTP | listTools() | callTool() | Optional | Yes (tools) | Model Context Protocol; JSON Schema → Zod conversion |
| **HTTP** | REST | Static config | fetch() | Bearer/API-Key | Yes (tools) | Custom headers; timeout 30s; X-Agent-Id injection |
| **Composio** | REST | Session-based | executeSessionTool() | API key | Yes (session) | 500+ SaaS integrations; session lifecycle |

**Stress Test Coverage**:
- MCP stdio transport failure (command not found)
- MCP HTTP transport timeout
- HTTP auth secret resolution (missing, invalid)
- Composio session creation failure
- Tool discovery caching invalidation
- Concurrent tool execution across providers
- Large JSON Schema → Zod conversion
- Provider fallback/retry logic

---

## 3. HARNESSES (5 Implementations)

### Harness Comparison

| Harness | Model Support | Native Tools | Subagents | State Export | Approval Flow | Notes |
|---------|---------------|--------------|-----------|--------------|---------------|-------|
| **LangGraph** | OpenAI, Anthropic | Blocklist | Yes | JSON payload | Via tool_call_start | Graph-based; supports deep agent params |
| **Claude Agents** | Anthropic | Allowlist | No | JSON payload | approval_needed event | Uses @anthropic-sdk; streaming text_delta |
| **PI Agent** | OpenAI | Allowlist | No | JSON payload | Via tool_call_start | TypeBox schema conversion; strict typing |
| **OpenAI Agents** | OpenAI | Blocklist | No | JSON payload | Via tool_call_start | (Mentioned in AGENTS.md, not in kitchen-sink) |
| **Vercel AI** | Multi-provider | Blocklist | No | JSON payload | Via tool_call_start | (Mentioned in AGENTS.md, not in kitchen-sink) |

**Session Lifecycle**:
1. `openSession(config, restore?)` → HarnessSession
2. `deliverTurn(input, context)` → AsyncGenerator<AgentEvent>
3. `exportState()` → HarnessExportedState (opaque payload)
4. `close()` → cleanup

**Agent Events Emitted**:
- `text_delta` — streaming text
- `tool_call_start` — tool invocation
- `tool_call_end` — tool result + duration
- `approval_needed` — HITL pause
- `approval_resolved` — HITL decision
- `message_committed` — turn finalized
- `error` — execution error
- `done` — run complete + token usage

**Stress Test Coverage**:
- Session restore with mismatched state version
- Concurrent turns on same session
- Abort signal during turn execution
- Tool timeout during execution
- Large token usage tracking
- State export size limits (5 MB checkpoint)
- Harness-specific model config validation
- Native tool allowlist/blocklist enforcement

---

## 4. A2UI BLOCK TYPES (Structured Output)

### Allowed Components (16 Total)

#### Charts (9)
- `TimeSeriesChart` — time-indexed data
- `BarChart` — categorical comparison
- `LineChart` — trend visualization
- `AreaChart` — cumulative trends
- `ScatterChart` — correlation
- `RadarChart` — multi-dimensional
- `PieChart` — composition
- `CandlestickChart` — OHLC data
- `FunnelChart` — conversion stages

#### Diagrams (3)
- `SankeyDiagram` — flow visualization (nodes + links)
- `NetworkGraph` — entity relationships
- `Treemap` — hierarchical data

#### HITL (3)
- `ApprovalCard` — tool approval UI
- `EditableDocument` — collaborative editing
- `FieldRequestForm` — structured input

#### Metrics (1)
- `MetricCard` — KPI display
- `TableView` — tabular data

**Prop Whitelisting**:
- Each component has allowed props (e.g., BarChart: data, xKey, yKey, title, color, width, height)
- Props not in whitelist are stripped
- String values sanitized: HTML tags removed, null bytes stripped, 10KB max
- Nested objects/arrays recursively sanitized

**Stress Test Coverage**:
- XSS injection in string props
- Oversized data arrays (memory exhaustion)
- Circular references in nested objects
- Invalid component names (prefix stripping: `ctxmill.charts:`, `charts:`)
- Missing required props
- Type mismatches (string vs number)
- Block size limit (50KB per block)
- Regex extraction edge cases

---

## 5. SUBAGENT CAPABILITY

### Subagent Support by Harness

| Harness | Supported | Mechanism | Notes |
|---------|-----------|-----------|-------|
| **LangGraph** | **Yes** | `harnessConfig.subagents` | Deep agent params passed to graph |
| **Claude Agents** | No | — | Single-agent only |
| **PI Agent** | No | — | Single-agent only |
| **OpenAI Agents** | Unknown | — | Not in kitchen-sink |
| **Vercel AI** | Unknown | — | Not in kitchen-sink |

**Subagent Flow**:
1. Parent agent calls tool (e.g., `emit-event`)
2. EventTriggerManager matches event type to trigger
3. Trigger spawns background run on child agent
4. Child agent inherits parent's workspace (via overlay)
5. Cascade protection: MAX_TRIGGER_DEPTH = 5

**Stress Test Coverage**:
- Circular trigger chains (depth > 5)
- Subagent workspace isolation (overlay correctness)
- Event payload size limits
- Concurrent subagent spawning (semaphore: max 20 containers)
- Subagent failure propagation
- Workspace merge on completion

---

## 6. EVENT EMISSION & CHAINING

### Event System (18 Built-in + Custom)

#### Built-in Events (EventMap)
```
run.started, run.text_chunk, run.tool_started, run.tool_result,
run.interrupted, run.interrupt_resolved, run.completed,
learning.trace_captured, learning.insight_extracted, learning.knowledge_updated,
feedback.received,
agent.created, agent.deleted,
client.connected, client.disconnected,
run.resumed,
trigger.fired,
custom (type: string, payload: object)
```

#### Emit-Event Tool
- **Input**: `{type: string, payload: object}`
- **Output**: `{ok: boolean, eventType: string, runId: string}`
- **Mechanism**: Calls `eventBus.emitCustom(type, agentId, payload)`
- **Trigger Matching**: EventTriggerManager watches for event type + optional filter
- **Cascade Protection**: MAX_TRIGGER_DEPTH = 5 (prevents infinite loops)

#### Event Persistence
- Events stored in PostgreSQL `events` table
- Timestamp, agentId, runId, type, payload indexed
- Custom events support arbitrary JSON payloads

**Stress Test Coverage**:
- Event payload size limits (JSON serialization)
- Trigger filter matching (complex predicates)
- Event ordering guarantees (concurrent emissions)
- Cascade depth enforcement
- Event loss on container crash
- Trigger race conditions (multiple matches)
- Custom event type validation

---

## 7. KNOWLEDGE SYSTEM

### Knowledge Store Interface

```typescript
interface KnowledgeStore {
  // Agent-scoped
  add(item: Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<KnowledgeItem>
  get(id: string): Promise<KnowledgeItem | null>
  list(agentId: string): Promise<KnowledgeItem[]>
  search(agentId: string, options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult>
  stats(agentId: string): Promise<KnowledgeStats>
  update(id: string, updates: Partial<KnowledgeItem>): Promise<KnowledgeItem>
  remove(id: string): Promise<void>
  render(agentId: string): Promise<string>
  
  // Shared (cross-agent)
  listShared(): Promise<KnowledgeItem[]>
  addShared(item: Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt' | 'agentId'>): Promise<KnowledgeItem>
  searchShared(options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult>
  sharedStats(): Promise<KnowledgeStats>
  searchAll(options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult>
}
```

### Knowledge Item Structure
```typescript
interface KnowledgeItem {
  id: string
  agentId: string
  content: string
  category: 'strategy' | 'fact' | 'preference' | 'correction'
  source: 'reflector' | 'human' | 'seed'
  effectiveness: number  // -1 to 1
  createdAt: Date
  updatedAt: Date
}
```

### Implementations
- **InMemoryKnowledgeStore** — volatile, per-session
- **Mem0KnowledgeStore** — persistent, shared agent knowledge

**Stress Test Coverage**:
- Knowledge item CRUD operations
- Search with filters (category, source)
- Shared knowledge isolation (agent-scoped vs shared)
- Effectiveness scoring edge cases (-1, 0, 1)
- Large content serialization
- Concurrent updates (race conditions)
- Knowledge render output format

---

## 8. WORKSPACE & FILE SYSTEM

### Workspace Structure
```
agents/{agentId}/
  base/
    workspace/          ← workspaceDir (session-scoped overlay)
    skills/             ← auto-discovered SKILL.md files
    notes/              ← agent-written notes
  sessions/
    {sessionId}/        ← overlay mount point (FUSE or mock)
```

### Workspace Isolation
- **Base**: Shared, persistent agent workspace
- **Session Overlay**: FUSE overlayfs (Linux) or MockOverlay (fallback)
  - Copy-on-write semantics
  - Workspace tar.gz snapshot (100 MB max)
  - Promoted to base on session completion

### File Operations Available
- **read-file**: Read with 10KB truncation
- **write-file**: Write with approval; blocks sensitive patterns
- **list-directory**: List with 100 entry cap
- **search-files**: Regex search with depth limit
- **manage-files**: copy, move, symlink, stat, chmod
- **process-image**: Image metadata extraction
- **write-note**: Notes directory only

### Workspace Seeding
- README.md (starter)
- data/sample-portfolio.json (finance example)
- Idempotent (skips if files exist)

**Stress Test Coverage**:
- Overlay mount/unmount failures
- Workspace tar.gz size limits (100 MB)
- Concurrent file operations (race conditions)
- Symlink loops (infinite traversal)
- Permission denied scenarios
- Workspace promotion on session completion
- Base/session isolation enforcement
- Skill auto-discovery and loading

---

## 9. SECRET INJECTION

### Secret Provider Interface
```typescript
interface SecretProvider {
  get(agentId: string, key: string, toolId?: string): string | null
  set(agentId: string, key: string, value: string, toolId?: string): void
  delete(agentId: string, key: string, toolId?: string): void
  list(agentId: string, toolId?: string): string[]
}
```

### Secret Resolution
1. **Manifest Reference**: `$secret:ANTHROPIC_API_KEY` in agent YAML
2. **Provider Lookup**: CachedPostgresSecretProvider queries `secrets` table
3. **Encryption**: AES-256-GCM (same as former SQLite provider)
4. **Injection**: Secrets passed to harness via `HarnessSessionConfig.secrets`
5. **Tmpfs Mount**: On resume, secrets injected fresh via `/run/secrets/config.json`

### Secret Scoping
- **Agent-scoped**: Per-agent secrets (default)
- **Tool-scoped**: Per-tool secrets (optional toolId parameter)

### Anti-Pattern
- **NEVER store secrets in checkpoints** — Secrets are injected fresh on resume, never persisted

**Stress Test Coverage**:
- Secret resolution failure (missing key)
- Encryption/decryption errors
- Secret leakage in logs/errors
- Concurrent secret access
- Secret update during active run
- Tool-scoped vs agent-scoped precedence
- Tmpfs mount failure on resume
- Secret size limits

---

## 10. HITL APPROVAL FLOW (From Agent Perspective)

### Approval Request Lifecycle

```
Agent calls tool with requiresApproval: true
  ↓
Harness emits AgentEvent: { type: 'approval_needed', id, tool, args }
  ↓
Orchestrator receives event via gRPC
  ↓
Orchestrator pauses container (5s delay)
  ↓
UI displays ApprovalCard block
  ↓
User approves/rejects
  ↓
Orchestrator resumes container with decision
  ↓
Harness emits AgentEvent: { type: 'approval_resolved', id, action }
  ↓
Agent continues or fails based on action
```

### Approval Timeout Cascade
1. **Pause Phase** (5s): Container paused, awaiting approval
2. **Freeze Phase** (5 min): If no approval, container frozen (checkpoint eligible)
3. **Checkpoint Phase** (10 min): If still frozen, checkpoint created + session suspended

### Manifest Configuration
```yaml
hitl:
  approvals:
    - tool: write-file
      when: { path: { $contains: ".env" } }  # Optional filter
      timeout: 300  # seconds
      fallback: reject  # approve | reject
```

### Tools Requiring Approval (Kitchen-Sink)
- `write-file` — file creation/modification
- `manage-files` — copy, move, symlink, chmod
- `exec-command` — shell execution
- `execute-trade` — financial transactions
- `write-note` — note creation

### Agent Perspective
1. Agent calls tool → tool handler checks `requiresApproval: true`
2. Tool handler emits `approval_needed` event
3. Agent waits for `approval_resolved` event (via EventBus)
4. If approved: tool executes, result returned
5. If rejected: tool returns error, agent continues

**Stress Test Coverage**:
- Approval timeout enforcement (5s → 5min → 10min)
- Concurrent approval requests
- Approval filter matching (complex predicates)
- Fallback action (approve vs reject)
- Container pause/resume correctness
- Checkpoint creation during freeze
- Session suspension/resumption
- Approval race conditions (multiple decisions)
- Container crash during approval wait

---

## 11. NATIVE TOOLS (SDK-Level)

### Native Tool Types (Harness-Specific)

#### LangGraph Native Tools
- Blocklist mode: All tools available except listed
- Examples: execute, bash, etc.

#### Claude Agents Native Tools
- Allowlist mode: Only listed tools available
- Examples: Read, Write, Edit, Bash, Grep, Glob

#### PI Agent Native Tools
- Allowlist mode: Only listed tools available
- Examples: read, bash, edit, write (lowercase)

### Native Tool Configuration
```yaml
nativeTools:
  allowlist: [Read, Write, Edit, Bash]  # Whitelist mode
  # OR
  blocklist: [execute]  # Blacklist mode
```

### Native Tool Execution
- Executed in-process (not via gRPC)
- Harness-specific implementation
- Subject to workspace isolation
- No approval flow (unlike custom tools)

**Stress Test Coverage**:
- Allowlist/blocklist enforcement
- Native tool availability per harness
- Workspace path validation
- Concurrent native tool execution
- Native tool error handling
- Native tool timeout enforcement

---

## 12. CAPABILITY MATRIX BY HARNESS

### Feature Support Grid

| Feature | LangGraph | Claude | PI Agent | OpenAI | Vercel |
|---------|-----------|--------|----------|--------|--------|
| **Custom Tools** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Native Tools** | ✓ (blocklist) | ✓ (allowlist) | ✓ (allowlist) | ? | ? |
| **Subagents** | ✓ | ✗ | ✗ | ? | ? |
| **Approval Flow** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **State Export** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Streaming** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Token Tracking** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Abort Signal** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Knowledge Injection** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **A2UI Extraction** | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## STRESS TEST CHECKLIST

### Tool Execution
- [ ] Path traversal on all file tools
- [ ] Large file reads (truncation)
- [ ] Regex DoS on search-files
- [ ] Concurrent file operations
- [ ] Approval timeout scenarios
- [ ] Tool timeout enforcement
- [ ] Tool error handling
- [ ] Tool result size limits

### Tool Providers
- [ ] MCP stdio transport failure
- [ ] MCP HTTP timeout
- [ ] HTTP auth secret resolution
- [ ] Composio session creation failure
- [ ] Provider fallback/retry
- [ ] Concurrent tool execution across providers

### Harnesses
- [ ] Session restore with mismatched state
- [ ] Concurrent turns on same session
- [ ] Abort signal during execution
- [ ] Large token usage tracking
- [ ] State export size limits
- [ ] Native tool allowlist/blocklist enforcement

### A2UI Blocks
- [ ] XSS injection in props
- [ ] Oversized data arrays
- [ ] Circular references
- [ ] Invalid component names
- [ ] Block size limits

### Subagents
- [ ] Circular trigger chains (depth > 5)
- [ ] Workspace isolation
- [ ] Concurrent subagent spawning
- [ ] Subagent failure propagation

### Events & Chaining
- [ ] Event payload size limits
- [ ] Trigger filter matching
- [ ] Event ordering
- [ ] Cascade depth enforcement
- [ ] Trigger race conditions

### Knowledge
- [ ] CRUD operations
- [ ] Search with filters
- [ ] Shared knowledge isolation
- [ ] Concurrent updates

### Workspace
- [ ] Overlay mount/unmount failures
- [ ] Workspace tar.gz size limits
- [ ] Symlink loops
- [ ] Permission denied scenarios
- [ ] Base/session isolation

### Secrets
- [ ] Secret resolution failure
- [ ] Encryption/decryption errors
- [ ] Secret leakage in logs
- [ ] Concurrent secret access
- [ ] Tmpfs mount failure on resume

### HITL
- [ ] Approval timeout cascade (5s → 5min → 10min)
- [ ] Concurrent approval requests
- [ ] Approval filter matching
- [ ] Fallback action enforcement
- [ ] Container pause/resume correctness
- [ ] Checkpoint creation during freeze
- [ ] Session suspension/resumption

---

## REFERENCE: Kitchen-Sink Example

### Agents (3)
1. **langgraph-analyst** (LangGraph, OpenAI gpt-5-mini)
   - Tools: calculator, weather, list-directory, search-files, execute-trade, emit-event
   - Emits: analysis.complete
   - Triggers: None (chain starter)

2. **claude-writer** (Claude Agents, Anthropic claude-sonnet-4-6)
   - Tools: emit-event
   - Native Tools: Read, Write, Edit, Bash, Grep, Glob
   - Emits: report.ready
   - Triggers: analysis.complete → spawn writer

3. **pi-auditor** (PI Agent, OpenAI gpt-5-mini)
   - Tools: emit-event
   - Native Tools: read, bash, edit, write
   - Emits: audit.logged
   - Triggers: report.ready → spawn auditor

### Event Chain
```
langgraph-analyst emits analysis.complete
  ↓ (trigger matches)
claude-writer spawned (background run)
  ↓ (on completion)
claude-writer emits report.ready
  ↓ (trigger matches)
pi-auditor spawned (background run)
  ↓ (on completion)
pi-auditor emits audit.logged
  ↓ (end of chain)
```

---

**Generated**: 2026-03-21
**Branch**: feat/persistent-sandbox-sessions
