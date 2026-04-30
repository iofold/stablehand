---
name: stress-test
description: Full stress-test suite for ctxmill — exercises tools, chaining, HITL, multi-model, code execution
---

# Full stress test plan

## Prerequisites

The full stack **must** be running before starting.

```bash
docker compose up --build -d
```

Verify readiness:

```bash
# API responds
curl -sf http://localhost:3002/api/agents > /dev/null && echo "API: OK" || echo "API: DOWN"

# Sandbox harness images exist
for img in langgraph claude-agents pi-agent; do
  docker image inspect "ctxmill/harness-${img}:latest" > /dev/null 2>&1 && echo "Image ${img}: OK" || echo "Image ${img}: MISSING — run: docker compose up --build"
done
```

All checks must pass before proceeding. Sandbox egress is controlled by the host or cluster network; CTXMill does not currently run a built-in outbound proxy.

## Shared setup

```bash
set -euo pipefail
API_BASE="http://localhost:3002"

agent_id() {
  local name="$1"
  curl -s "$API_BASE/api/agents" | jq -r --arg name "$name" 'first(.[] | select(.name == $name) | .id)'
}

post_message() {
  local agent_id="$1"
  local content="$2"
  curl -s -X POST "$API_BASE/api/agents/$agent_id/message" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg content "$content" '{content: $content}')" \
    | jq -r '.runId // .sessionId // .id'
}

wait_for_status() {
  local agent_id="$1"
  local session_id="$2"
  local ok_statuses="$3"

  while true; do
    status="$(curl -s "$API_BASE/api/agents/$agent_id/sessions" \
      | jq -r --arg session_id "$session_id" 'first(.sessions[]? | select(.id == $session_id or .sessionId == $session_id) | .status) // empty' \
      | tr '[:upper:]' '[:lower:]')"
    echo "session=$session_id status=${status:-missing}"
    [[ " $ok_statuses " == *" $status "* ]] && return 0
    [[ "$status" =~ ^(failed|cancelled|rejected|error)$ ]] && return 1
    sleep 2
  done
}

wait_for_interrupt() {
  local agent_id="$1"
  local session_id="$2"

  while true; do
    interrupt_session_id="$(curl -s "$API_BASE/api/agents/$agent_id/interrupts" \
      | jq -r --arg session_id "$session_id" 'first(.interrupts[]? | select(.sessionId == $session_id) | .sessionId) // empty')"
    [[ -n "$interrupt_session_id" ]] && return 0

    status="$(curl -s "$API_BASE/api/agents/$agent_id/sessions" \
      | jq -r --arg session_id "$session_id" 'first(.sessions[]? | select(.id == $session_id or .sessionId == $session_id) | .status) // empty' \
      | tr '[:upper:]' '[:lower:]')"
    echo "session=$session_id status=${status:-missing} waiting_for_interrupt"
    [[ "$status" =~ ^(completed|error|failed|cancelled|rejected)$ ]] && return 1
    sleep 2
  done
}

event_count() {
  local type="$1"
  local agent_id="$2"
  curl -s "$API_BASE/api/events?type=$type&agentId=$agent_id&limit=50" | jq '.events | length'
}

expect_event_after() {
  local type="$1"
  local agent_id="$2"
  local before="$3"
  local after

  after="$(event_count "$type" "$agent_id")"
  echo "event=$type agent=$agent_id before=$before after=$after"
  (( after > before ))
}
```

---

## Phase 1: Seed all agents

```bash
npx tsx tests/stress/seed.ts

LG_OPENAI_ID="$(agent_id stress-lg-openai)"
LG_GEMINI_ID="$(agent_id stress-lg-gemini)"
PI_OPENAI_ID="$(agent_id stress-pi-openai)"
PI_GEMINI_ID="$(agent_id stress-pi-gemini)"
CLAUDE_ID="$(agent_id stress-claude-sonnet)"
CHAIN_ID="$(agent_id stress-chain-responder)"
HITL_ID="$(agent_id stress-hitl)"
```

Expected:
- 7 stress agents imported
- trigger registered: `stress.tools.complete -> stress-chain-responder`

Pass/fail:
- Pass if every id above is non-empty
- Fail if seed exits non-zero or any id is missing

---

## Phase 2: Tool execution (`stress-lg-openai`)

Run the LangGraph agent with GPT-5.4 and verify it can call emit-event.

```bash
LG_OPENAI_EVENTS_BEFORE="$(event_count stress.tools.complete "$LG_OPENAI_ID")"
LG_OPENAI_RUN="$(post_message "$LG_OPENAI_ID" "Run the stress test now. Confirm you are operational and emit stress.tools.complete.")"

wait_for_status "$LG_OPENAI_ID" "$LG_OPENAI_RUN" "completed"
expect_event_after stress.tools.complete "$LG_OPENAI_ID" "$LG_OPENAI_EVENTS_BEFORE"
```

Expected:
- Run reaches `completed` after emitting the event
- The persisted `stress.tools.complete` count for this agent increases

Pass/fail:
- Pass if event is persisted
- Fail if no completion event is persisted

---

## Phase 3: Multi-model validation (`stress-lg-gemini`, `stress-pi-openai`, `stress-pi-gemini`)

### LangGraph + Gemini

```bash
LG_GEMINI_EVENTS_BEFORE="$(event_count stress.gemini.complete "$LG_GEMINI_ID")"
LG_GEMINI_RUN="$(post_message "$LG_GEMINI_ID" "Verify Gemini LangGraph execution and emit stress.gemini.complete.")"

wait_for_status "$LG_GEMINI_ID" "$LG_GEMINI_RUN" "completed"
expect_event_after stress.gemini.complete "$LG_GEMINI_ID" "$LG_GEMINI_EVENTS_BEFORE"
```

### PI Agent + OpenAI

```bash
PI_OPENAI_EVENTS_BEFORE="$(event_count stress.pi.complete "$PI_OPENAI_ID")"
PI_OPENAI_RUN="$(post_message "$PI_OPENAI_ID" "Verify PI-agent OpenAI execution and emit stress.pi.complete.")"

wait_for_status "$PI_OPENAI_ID" "$PI_OPENAI_RUN" "completed"
expect_event_after stress.pi.complete "$PI_OPENAI_ID" "$PI_OPENAI_EVENTS_BEFORE"
```

### PI Agent + Gemini

```bash
PI_GEMINI_EVENTS_BEFORE="$(event_count stress.pi-gemini.complete "$PI_GEMINI_ID")"
PI_GEMINI_RUN="$(post_message "$PI_GEMINI_ID" "Verify Gemini PI-agent execution and emit stress.pi-gemini.complete.")"

wait_for_status "$PI_GEMINI_ID" "$PI_GEMINI_RUN" "completed"
expect_event_after stress.pi-gemini.complete "$PI_GEMINI_ID" "$PI_GEMINI_EVENTS_BEFORE"
```

Expected:
- LangGraph Gemini, PI OpenAI, and PI Gemini complete successfully
- Each increases its model-specific persisted event count

Pass/fail:
- Pass if all three sessions are `completed` and all event counts increase
- Fail if any session errors or any event is missing

---

## Phase 4: Event chain (`stress-lg-openai` -> `stress-chain-responder`)

Emit the trigger event externally, then verify the responder runs.

```bash
CHAIN_BEFORE="$(curl -s "$API_BASE/api/agents/$CHAIN_ID/sessions" | jq '.sessions | length')"

curl -s -X POST "$API_BASE/api/triggers/emit" \
  -H 'Content-Type: application/json' \
  -d '{"type":"stress.tools.complete","payload":{"source":"stress-test-skill","ts":0}}' \
  | jq .

while true; do
  CHAIN_RUN_ID="$(curl -s "$API_BASE/api/agents/$CHAIN_ID/sessions" \
    | jq -r --argjson before "$CHAIN_BEFORE" 'if (.sessions | length) > $before then first(.sessions[] | .id) else empty end')"
  [[ -n "$CHAIN_RUN_ID" ]] && break
  sleep 2
done

wait_for_status "$CHAIN_ID" "$CHAIN_RUN_ID" "completed"
```

Expected:
- Trigger emission returns 200
- `stress-chain-responder` receives a new run
- `stress.chain.done` is persisted

Pass/fail:
- Pass if a new responder run appears and completes
- Fail if the trigger emits but no responder run starts

---

## Phase 5: Code execution (`stress-claude-sonnet`)

```bash
CLAUDE_EVENTS_BEFORE="$(event_count stress.claude.complete "$CLAUDE_ID")"
CLAUDE_RUN="$(post_message "$CLAUDE_ID" "Write the stress test file now, verify it exists, and emit stress.claude.complete.")"

wait_for_status "$CLAUDE_ID" "$CLAUDE_RUN" "completed"
expect_event_after stress.claude.complete "$CLAUDE_ID" "$CLAUDE_EVENTS_BEFORE"
```

Expected:
- Claude agent completes
- event proves the write/verify workflow finished

Pass/fail:
- Pass if run is `completed` and event array is non-empty
- Fail otherwise

---

## Phase 6: HITL (`stress-hitl`) — approve, then reject

### Approve path

```bash
HITL_EVENTS_BEFORE="$(event_count stress.hitl.complete "$HITL_ID")"
HITL_APPROVE_RUN="$(post_message "$HITL_ID" "Request approval for writing stress test results, then emit stress.hitl.complete.")"

wait_for_interrupt "$HITL_ID" "$HITL_APPROVE_RUN"

APPROVE_SESSION_ID="$(curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" \
  | jq -r --arg session_id "$HITL_APPROVE_RUN" 'first(.interrupts[]? | select(.sessionId == $session_id) | .sessionId)')"

curl -s -X POST "$API_BASE/api/agents/$HITL_ID/interrupt" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg action approve --arg sessionId "$APPROVE_SESSION_ID" '{action: $action, sessionId: $sessionId}')" \
  | jq .

wait_for_status "$HITL_ID" "$HITL_APPROVE_RUN" "completed"
expect_event_after stress.hitl.complete "$HITL_ID" "$HITL_EVENTS_BEFORE"
```

### Reject path

```bash
HITL_REJECT_RUN="$(post_message "$HITL_ID" "Request approval again — this one will be rejected.")"

wait_for_interrupt "$HITL_ID" "$HITL_REJECT_RUN"

REJECT_SESSION_ID="$(curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" \
  | jq -r --arg session_id "$HITL_REJECT_RUN" 'first(.interrupts[]? | select(.sessionId == $session_id) | .sessionId)')"

curl -s -X POST "$API_BASE/api/agents/$HITL_ID/interrupt" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg action reject --arg sessionId "$REJECT_SESSION_ID" '{action: $action, sessionId: $sessionId}')" \
  | jq .

wait_for_status "$HITL_ID" "$HITL_REJECT_RUN" "error rejected"
```

Expected:
- First session creates a pending interrupt, resumes after approval, completes, and emits `stress.hitl.complete`
- Second session creates a pending interrupt, then ends in `error` or `rejected` after rejection

Pass/fail:
- Pass if both interrupt actions resolve and produce the expected terminal states
- Fail if no pending interrupt appears or the interrupt endpoint does not resolve

---

## Phase 7: Verify events persisted in `/api/events`

```bash
curl -s "$API_BASE/api/events?limit=100" | jq '.events | map(.type)'
```

Confirm these event types exist:
- `stress.tools.complete`
- `stress.gemini.complete`
- `stress.pi.complete`
- `stress.pi-gemini.complete`
- `stress.claude.complete`
- `stress.chain.done`

Pass/fail:
- Pass if all expected types are present in persisted events
- Fail if any expected event type is missing

---

## Post-run cleanup (manual, after human verification)

Do NOT run cleanup as part of the test. Cleanup deletes agents and cascade-deletes
their events, sessions, and messages — making post-hoc verification impossible.

Run only after the human has reviewed all results:

```bash
npx tsx tests/stress/seed.ts --clean
```
