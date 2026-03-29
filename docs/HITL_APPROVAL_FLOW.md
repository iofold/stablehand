# HITL Approval Flow Analysis

## Complete Flow Map

### 1. TYPE DEFINITIONS (Source of Truth)

**File**: `/path/to/stablehand/packages/ctxmill/src/harness/types.ts`

```typescript
// Lines 7-19
export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ApprovalResponse {
  action: 'approve' | 'reject';
  data?: unknown;
}

export type ApprovalCallback = (req: ApprovalRequest) => Promise<ApprovalResponse>;
```

**Where it's used**:
- Line 83: `onApprovalNeeded?: ApprovalCallback;` in `HarnessSessionConfig`
- Line 108: `onApprovalNeeded?: ApprovalCallback;` in `HarnessTurnContext`

---

### 2. TOOL DEFINITION

**File**: `/path/to/stablehand/packages/ctxmill/src/tool/types.ts`

```typescript
// Line 5
export interface ToolDefinition {
  name: string;
  description: string;
  input: unknown;
  requiresApproval?: boolean;  // <-- KEY FLAG
  secrets?: string[];
  timeout?: number;
  handler: (input: unknown, ctx: ToolContext) => Promise<string>;
}
```

---

### 3. HARNESS IMPLEMENTATIONS

#### A. Claude Agents Harness
**File**: `/path/to/stablehand/packages/ctxmill/src/harness/claude-agents.ts`

**Session Setup** (Lines 123-140):
```typescript
constructor(...) {
  const approvalDelegate = this.makeApprovalDelegate();
  const mcpTools = harness.convertToolsWithSDK(
    { tool: sdk.tool },
    config.tools,
    config.conversationId,
    config,
    approvalDelegate,  // <-- PASSED HERE
    this.queuedEvents,
  );
  this.mcpServer = sdk.createSdkMcpServer({ name: 'ctxmill', tools: mcpTools });
}
```

**Turn Delivery** (Lines 146-148):
```typescript
async *deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<AgentEvent> {
  this.transcript.push(...input.messages);
  this.activeApprovalHandler = context.onApprovalNeeded ?? this.config.onApprovalNeeded;
  // <-- UPDATES HANDLER FROM CONTEXT (turn-level takes precedence)
```

**Approval Delegate** (Lines 239-246):
```typescript
private makeApprovalDelegate(): ApprovalCallback {
  return async (req: ApprovalRequest) => {
    const handler = this.activeApprovalHandler;
    if (!handler) {
      return { action: 'approve' };  // <-- DEFAULT: AUTO-APPROVE IF NO HANDLER
    }
    return handler(req);
  };
}
```

**Tool Conversion** (Lines 388-454):
```typescript
convertToolsWithSDK(..., onApprovalNeeded?: ApprovalCallback, ...): ConvertedMcpTool[] {
  return toolDefs.map((definition) => {
    return sdk.tool(
      definition.name,
      definition.description,
      inputSchema,
      async (rawArgs: unknown) => {
        const args = this.toArgsRecord(rawArgs);
        const approvalId = randomUUID();

        if (definition.requiresApproval && onApprovalNeeded) {  // <-- CHECK FLAG
          queuedEvents?.push({
            type: 'approval_needed',
            id: approvalId,
            tool: definition.name,
            args,
          });

          const approvalRequest: ApprovalRequest = {
            id: approvalId,
            runId,
            toolName: definition.name,
            args,
          };
          const approvalResponse = await onApprovalNeeded(approvalRequest);  // <-- CALL HANDLER

          queuedEvents?.push({
            type: 'approval_resolved',
            id: approvalId,
            action: approvalResponse.action,
          });

          if (approvalResponse.action !== 'approve') {
            return {
              content: [{ type: 'text', text: 'Tool call was rejected by the user.' }],
              isError: true,
            };
          }
        }
        // ... execute tool
      },
    );
  });
}
```

#### B. LangGraph Harness
**File**: `/path/to/stablehand/packages/ctxmill/src/harness/langgraph.ts`

**Turn Delivery** (Lines 102-106):
```typescript
const onApprovalNeeded = context.onApprovalNeeded ?? this.config.onApprovalNeeded;
// <-- SAME PATTERN: turn-level takes precedence

const lcTools = this.buildLangChainTools(ctx, input.turnId, tools, onApprovalNeeded);
```

**Tool Building** (Lines 353-383):
```typescript
private buildLangChainTools(
  ctx: ToolContext,
  turnId: string,
  tools: ToolDefinition[],
  onApprovalNeeded: import('./types.js').ApprovalCallback | undefined,
): LangChainTool[] {
  return tools.map((def) => ({
    // ...
    func: async (args: unknown) => {
      // HITL: if the tool requires approval, delegate to onApprovalNeeded callback
      if (def.requiresApproval && onApprovalNeeded) {  // <-- CHECK FLAG
        const res = await onApprovalNeeded(req);  // <-- CALL HANDLER
        if (res.action !== 'approve') {
          return 'Tool call was rejected by the user.';
        }
      }
      // ... execute tool
    },
  }));
}
```

#### C. PI Agent Harness
**File**: `/path/to/stablehand/packages/ctxmill/src/harness/pi-agent.ts`

**Turn Delivery** (Line 482):
```typescript
this.turnRef.onApprovalNeeded = context.onApprovalNeeded ?? this.config.onApprovalNeeded;
```

**Tool Execution** (Lines 171-178):
```typescript
if (def.requiresApproval && config.onApprovalNeeded) {  // <-- CHECK FLAG
  // ... emit approval_needed event
  const res = await config.onApprovalNeeded(req);  // <-- CALL HANDLER
  // ... handle response
}
```

---

### 4. SANDBOX RUNNER (Inside Container)

**File**: `/path/to/stablehand/packages/ctxmill/src/sandbox/runner.ts`

**deliverTurn Function** (Lines 293-367):
```typescript
export async function* deliverTurn(
  req: DeliverTurnRequest,
  opts?: {
    signal?: AbortSignal;
    onApprovalNeeded?: ApprovalCallback;  // <-- PASSED FROM ORCHESTRATOR
  },
): AsyncGenerator<SessionEvent> {
  // ...
  const context = {
    signal: opts?.signal,
    onApprovalNeeded: opts?.onApprovalNeeded,  // <-- PASSED TO HARNESS
  };

  for await (const event of activeSession.deliverTurn(input, context)) {
    // ... process events
    if (event.type === 'approval_needed') {
      yield agentEventToSessionEvent(event, seq, turnId);
    }
  }
}
```

**Phase Tracking** (Lines 164-182):
```typescript
function phaseForEvent(event: AgentEvent): ExecutionPhase | null {
  switch (event.type) {
    case 'approval_needed':
      return 'hitl_wait';  // <-- PHASE TRANSITION
    case 'approval_resolved':
      return 'before_tool';
    // ...
  }
}
```

---

### 5. PROTO CONVERSION (gRPC Bridge)

**File**: `/path/to/stablehand/packages/ctxmill/src/sandbox/proto-convert.ts`

**Internal → Proto** (Lines 400-421):
```typescript
case 'approval_needed':
  return create(AgentEventSchema, {
    event: {
      case: 'approvalNeeded',
      value: create(ApprovalNeededSchema, {
        id: event.id,
        toolName: event.tool,
        argsJson: typeof event.args === 'string' ? event.args : JSON.stringify(event.args),
      }),
    },
  });

case 'approval_resolved':
  return create(AgentEventSchema, {
    event: {
      case: 'approvalResolved',
      value: create(ApprovalResolvedSchema, {
        id: event.id,
        action: event.action,
      }),
    },
  });
```

**Proto → AG-UI** (Lines 549-571):
```typescript
case 'approvalNeeded': {
  const v = proto.event.value;
  return {
    type: 'HITL_PAUSE',  // <-- CONVERTED TO HITL_PAUSE EVENT
    timestamp: ts,
    runId,
    id: v.id,
    tool: v.toolName,
    args: v.argsJson ? JSON.parse(v.argsJson) : {},
  };
}

case 'approvalResolved': {
  const v = proto.event.value;
  return {
    type: 'CUSTOM',
    timestamp: ts,
    runId,
    subtype: 'approval_resolved',
    id: v.id,
    action: v.action,
  };
}
```

---

### 6. ORCHESTRATOR HANDLING

**File**: `/path/to/stablehand/packages/ctxmill/src/orchestrator/agent-run-service.ts`

**HITL_PAUSE Event Handler** (Lines 250-257):
```typescript
// Handle HITL pause events — pause the run instead of keeping it in running state
if (event.type === 'HITL_PAUSE') {
  const pauseEvent = event as unknown as HITLPauseEvent;
  const reason = pauseEvent.reason ?? 'hitl_approval';
  await this.runRegistry.pauseRun(runId, reason);
  // Sessions handle restore transparently — no partial content to persist
  return;
}
```

---

### 7. INTERRUPT MANAGER (Approval Handling)

**File**: `/path/to/stablehand/packages/ctxmill/src/orchestrator/interrupt.ts`

**waitForApproval** (Lines 66-157):
```typescript
waitForApproval(
  runId: string,
  agentId: string,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = 300_000,
): Promise<InterruptResolution> {
  // ... creates a pending interrupt
  // ... emits 'run.interrupted' event
  // ... returns a Promise that resolves when user responds
}
```

**resolve** (Lines 163-188):
```typescript
resolve(runId: string, action: 'approve' | 'reject' | 'timeout', data?: unknown, agentId?: string): boolean {
  const entry = this.pending.get(runId);
  if (!entry) return false;
  if (entry.timeoutId) clearTimeout(entry.timeoutId);
  entry.resolve({ action, data });
  this.pending.delete(runId);
  // ... persists to DB
  // ... emits 'run.interrupt_resolved' event
  return true;
}
```

---

## THE BREAK POINT: Where Approval Callback is NOT Created

### Current State:
1. ✅ Harnesses define `onApprovalNeeded` in `HarnessSessionConfig` and `HarnessTurnContext`
2. ✅ Harnesses check `requiresApproval` flag and call the callback
3. ✅ Sandbox runner accepts `onApprovalNeeded` in `deliverTurn` opts
4. ✅ Proto conversion maps `approval_needed` → `HITL_PAUSE`
5. ✅ Orchestrator handles `HITL_PAUSE` and pauses the run
6. ✅ InterruptManager exists to manage approvals

### Missing Link:
**The approval callback is NEVER created or passed from the orchestrator to the sandbox!**

**File**: `/path/to/stablehand/packages/ctxmill/src/orchestrator/sandbox-session-manager.ts`

**executeDeliverTurn** (Lines 858-894):
```typescript
private async *executeDeliverTurn(
  sessionId: string,
  messages: Message[],
  turnId: string,
): AsyncGenerator<CustomSessionEvent> {
  // ...
  const request = create(DeliverTurnRequestSchema, {
    sessionId,
    turnId,
    messages: toProtoMessages(messages),
  });

  // Stream events from the container via gRPC
  const stream: AsyncIterable<ProtoSessionEvent> = record.grpcClient.deliverTurn(request);
  // <-- NO onApprovalNeeded CALLBACK PASSED!
}
```

**SandboxRunService** (Lines 88-128):
```typescript
async *executeSessionTurn(
  agentDef: AgentDefinition,
  conversationId: string,
  messages: Message[],
  turnId: string,
  signal?: AbortSignal,
  agentId?: string,
): AsyncGenerator<AGUIEvent> {
  // ...
  const stream = sessionManager.deliverTurn(sessionId, messages, turnId);
  // <-- NO onApprovalNeeded CALLBACK PASSED!
}
```

---

## Why stress-hitl Agent Never Pauses

The approval callback is never created or passed through the chain:

1. **SandboxRunService.executeSessionTurn()** doesn't accept or pass an approval callback
2. **SandboxSessionManager.deliverTurn()** doesn't accept or pass an approval callback
3. **sandbox/runner.ts deliverTurn()** receives `undefined` for `onApprovalNeeded`
4. **Harnesses** receive `undefined` for `context.onApprovalNeeded`
5. **Tool handlers** check `if (definition.requiresApproval && onApprovalNeeded)` — the second condition is always false
6. **approval_needed events are never emitted** because the condition fails
7. **HITL_PAUSE events never reach the orchestrator**
8. **Run never pauses**

---

## The Fix Required

The approval callback needs to be:

1. **Created in the orchestrator** (likely in `AgentRunService` or a new service)
2. **Passed through SandboxRunService** to `SandboxSessionManager`
3. **Passed through SandboxSessionManager** to `sandbox/runner.ts`
4. **Passed to harness sessions** via `HarnessTurnContext`
5. **Called by harnesses** when tools with `requiresApproval: true` are invoked

The callback should:
- Create a pending interrupt via `InterruptManager.waitForApproval()`
- Return the user's approval/rejection decision
- Emit events to the event bus for UI updates

