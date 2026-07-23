# Workspace Middleware: Analysis & Unified Pattern

> Sources: distilled from the retired survey `middleware-patterns-research.md` (see git history).

**Status:** Analysis (pre-implementation)  
**Date:** 2026-04-07  
**Input:** a client workspace-middleware spec (external)  
**Scope:** All 3 harnesses (LangGraph, Claude Agents, PI Agent)  
**Shipping status (2026-07):** Only a narrow subset shipped — `harnessConfig.middleware` (a list of middleware paths) for LangGraph and the `wrapToolCall` extension hook for PI Agent. The unified `WorkspaceMiddleware` / `defineMiddleware` design described here never shipped.

---

## Executive Summary

The client spec proposes workspace-based middleware for LangGraph with harness-specific hooks. After deep analysis of all three harness implementations and external middleware patterns, **we recommend a two-tier design**: a **unified ctxmill middleware contract** as the portable default, plus explicit **harness extension escape hatches** for SDK-specific power features.

The client spec's approach ("paths are universal, hooks are harness-specific") gives shared config with non-shared semantics — the worst DX long-term. Instead: one write-once middleware surface at the ctxmill abstraction level, with native SDK hooks available as opt-in extensions.

---

## Part 1: Current State of Each Harness

### Shared Interface (all 3 harnesses implement this)

```
runner.ts openSession()
  → harness.openSession(config, restore?)
  → returns HarnessSession

runner.ts deliverTurn()
  → session.deliverTurn(input, context)    ← AsyncGenerator<AgentEvent>
  → for each event:
      phaseTracker.setPhase(event)
      stateCollector.processTurnEvent(event)
      yield agentEventToSessionEvent(event)   ← proto conversion
  → yield TurnCompleted | TurnFailed

runner.ts suspendSession()
  → session.exportState()

runner.ts killSession()
  → session.close()
```

**Key insight:** `runner.ts:461` — `for await (const event of ctx.session.deliverTurn(input, context))` — is the universal convergence point. ALL harness events, regardless of SDK, flow through this single loop.

### LangGraph (has middleware)

| Aspect | Detail |
|--------|--------|
| **File** | `packages/sandbox-daemon/src/harness/langgraph.ts` (583 lines) |
| **SDK** | `@langchain/langgraph` + deepagents `createDeepAgent` |
| **Middleware system** | Array of `AgentMiddleware` objects passed to `createDeepAgent()` |
| **Existing middleware** | `ToolErrorBoundaryMiddleware`, `ToolBlocklistMiddleware` |
| **Hooks** | `wrapModelCall(request, handler)`, `wrapToolCall(request, handler)`, lifecycle: `beforeAgent`, `afterAgent`, `beforeModel`, `afterModel` |
| **Model interception** | ✅ via `wrapModelCall` — can modify messages, tools, system prompt before LLM call, and modify/truncate response after |
| **Tool interception** | ✅ via `wrapToolCall` — intercept individual tool execution |
| **Config schema** | Has `setup.symlinks` defined but **NOT IMPLEMENTED** |

### Claude Agents (no middleware)

| Aspect | Detail |
|--------|--------|
| **File** | `packages/sandbox-daemon/src/harness/claude-agents.ts` (1025 lines) |
| **SDK** | `@anthropic-ai/claude-agent-sdk` |
| **Middleware system** | ❌ None |
| **Extension points** | `ApprovalCallback` for tool approval, Claude Code filesystem hooks (`.claude/hooks/`) at SDK level |
| **Tool interception** | Via wrapper in `convertToolsWithSDK()` (line 573-587) — wraps each tool's execute fn |
| **Model interception** | ❌ Not exposed by SDK |
| **Config schema** | Has `setup.symlinks` defined but **NOT IMPLEMENTED** |

### PI Agent (event-driven extensions)

| Aspect | Detail |
|--------|--------|
| **File** | `packages/sandbox-daemon/src/harness/pi-agent.ts` (695 lines) |
| **SDK** | `@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai` |
| **Middleware system** | ❌ No middleware chain |
| **Extension model** | Event subscriptions: `session.subscribe(listener)` — 20+ event types |
| **Tool interception** | Via `convertTools()` (lines 155-209) — wraps each tool's execute fn, mutable `ConvertToolsContext` |
| **Model interception** | ❌ Not exposed |
| **Event mapping** | `_piMapAgentEvent()` (lines 293-346) — transforms SDK events → ctxmill `AgentEvent` |
| **Key limitation** | No `getMessages()` on native session — harness maintains own transcript array |

### Comparison Matrix

| Capability | LangGraph | Claude | PI Agent | Universal? |
|-----------|-----------|--------|----------|------------|
| Session open/close | ✅ | ✅ | ✅ | ✅ |
| Turn start/end | ✅ | ✅ | ✅ | ✅ |
| Tool execution interception | ✅ middleware | ✅ wrapper | ✅ wrapper | ✅ |
| Event stream output | ✅ AgentEvent | ✅ AgentEvent | ✅ AgentEvent | ✅ |
| Model call interception | ✅ wrapModelCall | ❌ | ❌ | ❌ LangGraph only |
| State export/restore | ✅ | ✅ | ✅ | ✅ |
| Approval flow | ✅ | ✅ | ✅ | ✅ |
| Filesystem hooks | ❌ | ✅ Claude Code | ❌ | ❌ Claude only |
| Raw SDK events | ❌ | ❌ | ✅ subscribe() | ❌ PI only |

---

## Part 2: Why the client Spec Falls Short

The spec is well-designed for LangGraph but has three structural problems when applied cross-harness:

### Problem 1: Harness-Specific Hooks Break Portability

The spec says "hook contract is harness-specific" (§219-223). This means a middleware author exporting `wrapModelCall` writes dead code for Claude and PI agents. The `{ name: string }` minimum cross-harness shape is too thin to be useful.

### Problem 2: No Universal Injection Point Identified

The spec places middleware inside the LangGraph harness adapter. But `runner.ts:deliverTurn()` already provides a universal injection point where ALL events flow through, regardless of harness. Middleware at this level works for free across all 3 harnesses.

### Problem 3: Tool Interception Is Universal But Not Recognized

All 3 harnesses wrap tool execution through a converter function (`convertTools` for PI, `convertToolsWithSDK` for Claude, `buildLangChainTools` for LangGraph). This is a natural universal interception point, but the spec treats tool hooks as LangGraph-specific `wrapToolCall`.

---

## Part 3: Recommended Architecture — Two-Tier Middleware

### Tier 1: Portable Middleware Contract (runs at runner.ts level)

These hooks are **truly universal** — they work identically across all 3 harnesses because they operate at the ctxmill abstraction level, not the SDK level.

```typescript
// packages/sandbox-daemon/src/middleware/types.ts

type HarnessName = 'langgraph' | 'claude-agents' | 'pi-agent';

interface MiddlewareContext {
  readonly harness: HarnessName;
  readonly agentId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly workspaceDir: string;
  readonly runId: string;
  /** Per-middleware ephemeral state bag — survives across turns within a session */
  readonly state: Map<string, unknown>;
  readonly logger: MiddlewareLogger;
}

interface MiddlewareLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  args: unknown;               // mutable: middleware can transform
  metadata?: Record<string, unknown>;
}

interface ToolCallResult {
  result: string;              // mutable: middleware can transform
  error?: string;
  durationMs: number;
}

type NextToolCall = (req: ToolCallRequest) => Promise<ToolCallResult>;

/**
 * Portable workspace middleware contract.
 *
 * All hooks are optional. Middleware that only cares about tools
 * exports only `wrapToolCall`. Middleware that only observes events
 * exports only `mapEvent`. Etc.
 *
 * Ordering: safety middleware → user middleware[0..N] → harness adapter shims
 */
interface WorkspaceMiddleware {
  /** Unique identifier for logging and ordering */
  readonly name: string;

  /**
   * Optional harness filter. If set, this middleware only runs
   * when the session harness matches one of these names.
   * If omitted, runs on ALL harnesses.
   */
  readonly appliesTo?: HarnessName[];

  // ── Session lifecycle ──────────────────────────────────────────

  /** Called after harness.openSession() succeeds */
  onSessionOpen?(ctx: MiddlewareContext): Promise<void>;

  /** Called on restore — receives the middleware's own exported state (if any) */
  onSessionRestore?(snapshot: unknown, ctx: MiddlewareContext): Promise<void>;

  /** Export middleware state for checkpoint persistence */
  exportState?(ctx: MiddlewareContext): Promise<unknown>;

  /** Called before session.close() */
  onSessionClose?(ctx: MiddlewareContext): Promise<void>;

  // ── Turn lifecycle ─────────────────────────────────────────────

  /** Called before deliverTurn — can transform turn input (messages) */
  beforeTurn?(
    input: HarnessTurnInput,
    ctx: MiddlewareContext,
  ): Promise<HarnessTurnInput | void>;

  /** Called after deliverTurn completes (success or failure) */
  afterTurn?(ctx: MiddlewareContext): Promise<void>;

  // ── Tool execution ─────────────────────────────────────────────

  /**
   * Wraps individual tool calls. Classic middleware pattern:
   * call `next(req)` to proceed, or short-circuit by returning directly.
   *
   * This is universal: all 3 harnesses route tool execution through
   * a converter function that can be wrapped.
   */
  wrapToolCall?(
    req: ToolCallRequest,
    ctx: MiddlewareContext,
    next: NextToolCall,
  ): Promise<ToolCallResult>;

  // ── Event stream ───────────────────────────────────────────────

  /**
   * Transform or observe events as they flow out of the harness.
   *
   * Return the event (possibly modified) to pass it through.
   * Return null to suppress it.
   * Return an array to fan-out into multiple events.
   * Return void/undefined to pass through unchanged.
   *
   * CONSTRAINT: `done`, `error`, and `approval_*` events CANNOT be
   * suppressed — the runner will ignore null returns for these types.
   */
  mapEvent?(
    event: AgentEvent,
    ctx: MiddlewareContext,
  ): Promise<AgentEvent | AgentEvent[] | null | void>;
}

/**
 * Helper for type-safe middleware definition (enables autocomplete).
 */
export function defineMiddleware(mw: WorkspaceMiddleware): WorkspaceMiddleware {
  return mw;
}
```

### Tier 2: Harness-Specific Extensions (runs inside harness adapters)

For SDK-specific power features that **cannot** be expressed through the portable contract. These are opt-in and explicitly non-portable.

```typescript
// packages/sandbox-daemon/src/middleware/extension-types.ts

/** LangGraph-only: intercept the LLM call itself */
interface LangGraphExtension {
  wrapModelCall?(request: LangGraphModelRequest, handler: LangGraphModelHandler): Promise<AIMessage>;
  beforeModel?(state: AgentState, runtime: AgentRuntime): Promise<Partial<AgentState> | void>;
  afterModel?(state: AgentState, runtime: AgentRuntime): Promise<Partial<AgentState> | void>;
}

/** PI Agent-only: raw SDK event subscription */
interface PIAgentExtension {
  onRawEvent?(event: Record<string, unknown>): void;
  beforeAgentStart?(ctx: PIExtensionContext): Promise<{ systemPromptAddition?: string } | void>;
}

/** Claude-only: filesystem hook integration */
interface ClaudeExtension {
  hooks?: ClaudeHookDefinition[];
}
```

### Config Shape

```yaml
# agent.yaml
spec:
  # Tier 1: Portable middleware — works on ALL harnesses
  middleware:
    - middleware/block-dangerous-tools.ts
    - middleware/budget-tracker.ts
    - middleware/redact-pii-output.ts

  harnessConfig:
    # LangGraph-specific config + extensions
    langgraph:
      provider: openai
      model: gpt-5.4-mini
      extensions:
        - extensions/langgraph/model-routing.ts

    # PI Agent-specific config + extensions
    pi-agent:
      provider: anthropic
      model: claude-sonnet-4-6
      extensions:
        - extensions/pi/raw-event-logger.ts

    # Claude-specific config (no extensions needed here)
    claude-agents:
      model: claude-sonnet-4-6
```

---

## Part 4: Where Middleware Loads & Executes

### Loading: Central, in runner.ts

```
runner.ts openSession()
  1. Resolve harness
  2. Read harnessConfig.middleware paths from agent manifest
  3. Dynamic import each middleware .ts file
  4. Validate: must have `name: string`, warn on load failure
  5. Filter by `appliesTo` (if set) against current harness
  6. Store ordered middleware array in SessionContext
  7. Call onSessionOpen() for each middleware
  8. THEN call harness.openSession()
  9. For extensions: pass to harness adapter via harnessConfigJson
```

### Execution: Hybrid

**Universal hooks (runner.ts level):**
- `onSessionOpen` / `onSessionRestore` / `exportState` / `onSessionClose`
- `beforeTurn` / `afterTurn`
- `mapEvent` — wraps the event loop at line 461

**Tool wrapping (in each harness's tool converter):**
- `wrapToolCall` — injected into `convertTools()` (PI), `convertToolsWithSDK()` (Claude), `buildLangChainTools()` (LangGraph)

**Harness extensions (inside harness adapters):**
- LangGraph: extensions loaded alongside existing middleware array
- PI: extensions wired into `session.subscribe()` and `ConvertToolsContext`
- Claude: extensions placed in workspace filesystem hook locations

### Execution Order

```
1. Platform guardrails              (hardcoded, non-configurable)
   └─ ToolErrorBoundaryMiddleware   (LangGraph)
   └─ ToolBlocklistMiddleware       (all harnesses, if configured)

2. User workspace middleware[0..N]  (from spec.middleware, ordered)
   └─ e.g., block-dangerous-tools.ts
   └─ e.g., budget-tracker.ts

3. Harness adapter shims            (internal, harness-specific)
   └─ LangGraph: SkillsMiddleware, SubAgentMiddleware, etc.
   └─ Claude: SDK-internal hooks
   └─ PI: native tool execution
```

---

## Part 5: PI Agent — Specific Implementation Strategy

The PI agent's event-subscription model is fundamentally different from LangGraph's middleware chain. Here's how each portable hook maps:

| Portable Hook | PI Agent Implementation |
|--------------|----------------------|
| `onSessionOpen` | Called after `createAgentSession()` in `PiAgentSession` constructor |
| `onSessionRestore` | Called during restore path in `openSession()` |
| `beforeTurn` | Called before `nativeSession.prompt()` in `deliverTurn()` |
| `afterTurn` | Called after the event subscription completes |
| `wrapToolCall` | **Injected into `convertTools()` execute wrapper** — wrap the `def.handler(params, ctx)` call at line 188 |
| `mapEvent` | **Wrap `_piMapAgentEvent()` output** — after SDK event → ctxmill event conversion, before yielding |
| `exportState` | Called during `exportState()` — middleware state serialized alongside harness state |
| `onSessionClose` | Called before `nativeSession.dispose()` |

### Key: Do NOT expose `session.subscribe()` as the public API

The raw PI SDK events are an implementation detail. The `_piMapAgentEvent()` function already normalizes them to `AgentEvent`. Middleware should intercept AFTER this normalization, not before. Raw event access is a Tier 2 extension, not the default.

### wrapToolCall injection in convertTools()

Current `convertTools()` (line 165-208):
```typescript
execute: async (toolCallId, params, _signal, _onUpdate) => {
  // approval check
  // handler execution
  // result serialization
}
```

With middleware:
```typescript
execute: async (toolCallId, params, _signal, _onUpdate) => {
  // approval check (unchanged)

  const req: ToolCallRequest = { id: toolCallId, name: def.name, args: params };
  const next: NextToolCall = async (r) => {
    const result = await def.handler(r.args, toolContext);
    return { result: serialize(result), durationMs: 0 };
  };

  // Chain through middleware wrapToolCall hooks
  let chain = next;
  for (const mw of middlewares.reverse()) {
    if (mw.wrapToolCall) {
      const prev = chain;
      chain = (r) => mw.wrapToolCall!(r, ctx, prev);
    }
  }
  return chain(req);
}
```

---

## Part 6: Migration from client Spec

The client spec's 3 changes map cleanly into this architecture:

| client Spec Change | New Architecture Equivalent |
|-----------------|---------------------------|
| Dynamic import loop in `langgraph.ts` | Central loader in `runner.ts` (portable) + extension loader in `langgraph.ts` (LangGraph-only) |
| Runtime metadata injection (`configurable`) | `MiddlewareContext` object passed to all hooks |
| Schema validation (`middleware` field) | Top-level `spec.middleware` in agent manifest schema |

### What migrates from LangGraph-specific to portable:
- `ToolBlocklistMiddleware` → portable `wrapToolCall` middleware (works on all harnesses)
- `ToolErrorBoundaryMiddleware` → portable `wrapToolCall` middleware (works on all harnesses)
- Budget tracking → portable `mapEvent` + `wrapToolCall` (works on all harnesses)
- Tool call limiting → portable `wrapToolCall` (works on all harnesses)

### What stays LangGraph-specific (Tier 2 extension):
- `wrapModelCall` — only LangGraph exposes the LLM call
- `beforeModel` / `afterModel` — LangChain lifecycle
- `SkillsMiddleware`, `SubAgentMiddleware` — deepagents built-ins

---

## Part 7: Examples

### Example 1: Portable Tool Blocklist (works on all 3 harnesses)

```typescript
// middleware/block-dangerous-tools.ts
import { defineMiddleware } from '@ctxmill/sandbox-daemon/middleware';

const BLOCKED = new Set(['rm_rf', 'drop_database', 'exec_raw_sql']);

export default defineMiddleware({
  name: 'block-dangerous-tools',

  wrapToolCall: async (req, ctx, next) => {
    if (BLOCKED.has(req.name)) {
      ctx.logger.warn(`Blocked tool call: ${req.name}`, { args: req.args });
      return {
        result: `Tool "${req.name}" is blocked by workspace policy.`,
        error: 'blocked_by_policy',
        durationMs: 0,
      };
    }
    return next(req);
  },
});
```

### Example 2: Portable Budget Tracker (works on all 3 harnesses)

```typescript
// middleware/budget-tracker.ts
import { defineMiddleware } from '@ctxmill/sandbox-daemon/middleware';

const MAX_BUDGET_USD = 13.50;

export default defineMiddleware({
  name: 'budget-tracker',

  onSessionOpen: async (ctx) => {
    ctx.state.set('spent_usd', 0);
  },

  onSessionRestore: async (snapshot, ctx) => {
    ctx.state.set('spent_usd', (snapshot as { spent_usd?: number })?.spent_usd ?? 0);
  },

  exportState: async (ctx) => {
    return { spent_usd: ctx.state.get('spent_usd') ?? 0 };
  },

  mapEvent: async (event, ctx) => {
    if (event.type === 'done' && event.usage?.cost) {
      const spent = (ctx.state.get('spent_usd') as number) + event.usage.cost;
      ctx.state.set('spent_usd', spent);

      if (spent > MAX_BUDGET_USD) {
        ctx.logger.warn(`Budget exceeded: $${spent.toFixed(2)} / $${MAX_BUDGET_USD}`);
        // Event passes through but is observed — budget enforcement
        // would happen in beforeTurn on the NEXT turn
      }
    }
    return event; // pass through
  },

  beforeTurn: async (input, ctx) => {
    const spent = ctx.state.get('spent_usd') as number;
    if (spent > MAX_BUDGET_USD) {
      // Inject a system message telling the agent to stop
      return {
        ...input,
        messages: [
          ...input.messages,
          {
            role: 'system' as const,
            content: `⚠️ Budget exceeded ($${spent.toFixed(2)} / $${MAX_BUDGET_USD}). Wrap up immediately.`,
          },
        ],
      };
    }
  },
});
```

### Example 3: LangGraph Extension — Model Routing (non-portable)

```typescript
// extensions/langgraph/model-routing.ts
// This ONLY works with LangGraph — it's a Tier 2 extension

export default {
  name: 'model-routing',
  wrapModelCall: async (request: any, handler: (r: any) => Promise<any>) => {
    // Route complex tool-use turns to a stronger model
    const hasToolCalls = request.messages.some(
      (m: any) => m.tool_calls?.length > 0
    );
    if (hasToolCalls) {
      request.model = 'gpt-5.4'; // upgrade from mini
    }
    return handler(request);
  },
};
```

### Example 4: PI Extension — Raw Event Logger (non-portable)

```typescript
// extensions/pi/raw-event-logger.ts
// This ONLY works with PI Agent — it's a Tier 2 extension

export default {
  name: 'raw-event-logger',
  onRawEvent: (event: Record<string, unknown>) => {
    if (event.type === 'context') {
      console.error(`[pi-debug] Context event: ${JSON.stringify(event).slice(0, 200)}`);
    }
  },
};
```

---

## Part 8: Effort Estimate

| Component | Lines | Effort |
|-----------|-------|--------|
| Middleware type definitions | ~80 | Small |
| Central loader in runner.ts | ~60 | Small |
| Runner-level hook execution (lifecycle + event mapEvent) | ~100 | Medium |
| Tool wrapper injection (PI convertTools) | ~30 | Small |
| Tool wrapper injection (Claude convertToolsWithSDK) | ~30 | Small |
| Tool wrapper injection (LangGraph buildLangChainTools) | ~30 | Small |
| Agent manifest schema addition | ~5 | Trivial |
| Extension loader per harness | ~40 each (×3) | Medium |
| State persistence (export/restore) | ~50 | Medium |
| Tests | ~200 | Medium |
| Documentation | ~150 | Medium |
| **Total** | ~800 | **Large (3-5 days)** |

---

## Part 9: Open Questions

1. **Should `mapEvent` be able to suppress non-control events?** Current design allows it (return `null`), but suppressing `text_delta` could break UI state. Consider: only allow suppression of `tool_call_start`/`tool_call_end`, not text or control events.

2. **Hot reload?** The client spec says no. Agreed for v1 — middleware loads once at session start. But the PI agent SDK supports `/reload` natively, so this could be a future PI extension.

3. **Middleware ordering conflicts?** If two middleware both `wrapToolCall`, they compose as a chain (outermost runs first). Document this explicitly. Consider adding a `priority` field for advanced use cases.

4. **Cross-middleware communication?** The `MiddlewareContext.state` bag is per-middleware. If middleware A needs to share data with middleware B, they'd need a convention (e.g., namespaced keys in a shared map). Keep this out of v1 scope.

5. **Existing LangGraph middleware migration timeline?** `ToolErrorBoundaryMiddleware` and `ToolBlocklistMiddleware` could become portable middleware immediately. Deepagents built-ins (`SkillsMiddleware`, etc.) stay LangGraph-internal.
