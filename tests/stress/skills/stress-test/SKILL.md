---
name: stress-test
description: Full stress-test suite for ctxmill — exercises tools, chaining, HITL, multi-model, code execution
---

# Full stress test plan

## Prerequisites

The full stack **must** be running with the sandbox profile before starting.

```bash
docker compose --profile sandbox up --build -d
```

Verify readiness:

```bash
# API responds
curl -sf http://localhost:3002/api/agents > /dev/null && echo "API: OK" || echo "API: DOWN"

# Egress proxy is healthy (required for sandbox → LLM API connectivity)
docker compose ps egress-proxy --format '{{.Status}}' | grep -q healthy && echo "Proxy: OK" || echo "Proxy: DOWN"

# Sandbox harness images exist
for img in langgraph claude-agents pi-agent; do
  docker image inspect "ctxmill/harness-${img}:latest" > /dev/null 2>&1 && echo "Image ${img}: OK" || echo "Image ${img}: MISSING — run: docker compose --profile sandbox-build build"
done
```

All checks must pass before proceeding. Without the sandbox profile, agents cannot reach external LLM APIs and tool proxying (emit-event, request-approval) will fail silently.

## Shared setup

```bash
set -euo pipefail
API_BASE="http://localhost:3002"

agent_id() {
  local name="$1"
  curl -s "$API_BASE/api/agents" | jq -r --arg name "$name" 'first(.[] | select(.name == $name) | .id)'
}

wait_for_status() {
  local agent_id="$1"
  local run_id="$2"
  local ok_statuses="$3"

  while true; do
    status="$(curl -s "$API_BASE/api/agents/$agent_id/runs" | jq -r --arg run_id "$run_id" 'first(.[] | select(.id == $run_id) | .status) // empty')"
    echo "run=$run_id status=${status:-missing}"
    [[ " $ok_statuses " == *" $status "* ]] && return 0
    [[ "$status" =~ ^(failed|cancelled|rejected)$ ]] && return 1
    sleep 2
  done
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
LG_OPENAI_RUN="$(curl -s -X POST "$API_BASE/api/agents/$LG_OPENAI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Run the stress test now. Confirm you are operational and emit stress.tools.complete."}' \
  | jq -r '.runId')"

wait_for_status "$LG_OPENAI_ID" "$LG_OPENAI_RUN" "completed error"

curl -s "$API_BASE/api/events?type=stress.tools.complete&agentId=$LG_OPENAI_ID&limit=20" \
  | jq --arg run_id "$LG_OPENAI_RUN" '.events | map(select((.payload // "") | contains($run_id)))'
```

Expected:
- Run reaches `completed` after emitting the event
- `stress.tools.complete` event exists for this run

Pass/fail:
- Pass if event is persisted
- Fail if no completion event is persisted

---

## Phase 3: Multi-model validation (`stress-lg-gemini`, `stress-pi-gemini`)

### LangGraph + Gemini

```bash
LG_GEMINI_RUN="$(curl -s -X POST "$API_BASE/api/agents/$LG_GEMINI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Verify Gemini LangGraph execution and emit stress.gemini.complete."}' \
  | jq -r '.runId')"

wait_for_status "$LG_GEMINI_ID" "$LG_GEMINI_RUN" "completed"

curl -s "$API_BASE/api/events?type=stress.gemini.complete&agentId=$LG_GEMINI_ID&limit=20" \
  | jq --arg run_id "$LG_GEMINI_RUN" '.events | map(select((.payload // "") | contains($run_id)))'
```

### PI Agent + Gemini

```bash
PI_GEMINI_RUN="$(curl -s -X POST "$API_BASE/api/agents/$PI_GEMINI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Verify Gemini PI-agent execution and emit stress.pi-gemini.complete."}' \
  | jq -r '.runId')"

wait_for_status "$PI_GEMINI_ID" "$PI_GEMINI_RUN" "completed"

curl -s "$API_BASE/api/events?type=stress.pi-gemini.complete&agentId=$PI_GEMINI_ID&limit=20" \
  | jq --arg run_id "$PI_GEMINI_RUN" '.events | map(select((.payload // "") | contains($run_id)))'
```

Expected:
- Both Gemini-backed agents complete successfully
- Each emits its model-specific event

Pass/fail:
- Pass if both runs are `completed` and both event arrays are non-empty
- Fail if either run errors or either event is missing

---

## Phase 4: Event chain (`stress-lg-openai` -> `stress-chain-responder`)

Emit the trigger event externally, then verify the responder runs.

```bash
CHAIN_BEFORE="$(curl -s "$API_BASE/api/agents/$CHAIN_ID/runs" | jq 'length')"

curl -s -X POST "$API_BASE/api/triggers/emit" \
  -H 'Content-Type: application/json' \
  -d '{"type":"stress.tools.complete","payload":{"source":"stress-test-skill","ts":0}}' \
  | jq .

while true; do
  CHAIN_RUN_ID="$(curl -s "$API_BASE/api/agents/$CHAIN_ID/runs" \
    | jq -r --argjson before "$CHAIN_BEFORE" 'if length > $before then first(.[] | .id) else empty end')"
  [[ -n "$CHAIN_RUN_ID" ]] && break
  sleep 2
done

wait_for_status "$CHAIN_ID" "$CHAIN_RUN_ID" "completed"

curl -s "$API_BASE/api/events?type=stress.chain.done&agentId=$CHAIN_ID&limit=20" \
  | jq --arg run_id "$CHAIN_RUN_ID" '.events | map(select((.payload // "") | contains($run_id)))'
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
CLAUDE_RUN="$(curl -s -X POST "$API_BASE/api/agents/$CLAUDE_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Write the stress test file now, verify it exists, and emit stress.claude.complete."}' \
  | jq -r '.runId')"

wait_for_status "$CLAUDE_ID" "$CLAUDE_RUN" "completed"

curl -s "$API_BASE/api/events?type=stress.claude.complete&agentId=$CLAUDE_ID&limit=20" \
  | jq --arg run_id "$CLAUDE_RUN" '.events | map(select((.payload // "") | contains($run_id)))'
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
HITL_APPROVE_RUN="$(curl -s -X POST "$API_BASE/api/agents/$HITL_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Request approval for writing stress test results, then emit stress.hitl.complete."}' \
  | jq -r '.runId')"

wait_for_status "$HITL_ID" "$HITL_APPROVE_RUN" "paused"

APPROVE_RUN_ID="$(curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" | jq -r 'first(.interrupts[]? | .runId)')"

curl -s -X POST "$API_BASE/api/agents/$HITL_ID/interrupt" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg action approve --arg runId "$APPROVE_RUN_ID" '{action: $action, runId: $runId}')" \
  | jq .

wait_for_status "$HITL_ID" "$HITL_APPROVE_RUN" "completed"
```

### Reject path

```bash
HITL_REJECT_RUN="$(curl -s -X POST "$API_BASE/api/agents/$HITL_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Request approval again — this one will be rejected."}' \
  | jq -r '.runId')"

wait_for_status "$HITL_ID" "$HITL_REJECT_RUN" "paused"

REJECT_RUN_ID="$(curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" | jq -r 'first(.interrupts[]? | .runId)')"

curl -s -X POST "$API_BASE/api/agents/$HITL_ID/interrupt" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg action reject --arg runId "$REJECT_RUN_ID" '{action: $action, runId: $runId}')" \
  | jq .

wait_for_status "$HITL_ID" "$HITL_REJECT_RUN" "error rejected"
```

Expected:
- First run pauses, resumes after approval, and completes
- Second run pauses, then ends in `error` or `rejected` after rejection

Pass/fail:
- Pass if both interrupt actions resolve and produce the expected terminal states
- Fail if the run never pauses or the interrupt endpoint does not resolve

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

## Phase 8: Cleanup

```bash
npx tsx tests/stress/seed.ts --clean
```

Expected:
- All `stress-*` agents deleted cleanly

Pass/fail:
- Pass if cleanup exits 0
- Fail if any stress agent remains undeleted
