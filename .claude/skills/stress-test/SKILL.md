---
name: stress-test
description: Full stress-test suite for ctxmill — exercises tools, chaining, HITL, multi-model, code execution
---

# Full stress test plan

## API reference (quick)

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/api/health` | GET | `{ status: "ok", ... }` |
| `/api/agents` | GET | `[ { id, name, harness, ... }, ... ]` |
| `/api/agents/:id/message` | POST `{ content }` | `{ sessionId, messageId, conversationId }` |
| `/api/agents/:id/session` | POST `{ task }` | `{ sessionId }` (background run) |
| `/api/agents/:id/sessions` | GET | `{ sessions: [{ id, status, ... }] }` |
| `/api/agents/:id/conversations` | GET | `[ { id, agentId, ... } ]` (plain array) |
| `/api/agents/:id/conversations/:id/messages` | GET | `[ { id, role, content, ... } ]` |
| `/api/agents/:id/interrupts` | GET | `{ interrupts: [{ sessionId, toolName, ... }] }` |
| `/api/agents/:id/interrupt` | POST `{ action, sessionId }` | `{ resolved: true, ... }` |
| `/api/settings` | GET | `{ maxGlobalContainers, ... }` (14 keys, no wrapper) |
| `/api/settings` | PUT `{ key: value }` | Updated settings object |
| `/api/events` | GET `?type=...&limit=...` | `{ events: [...] }` |
| `/api/triggers/emit` | POST `{ type, payload }` | `{ ok: true }` |

**UI routes** (SPA):
- `/` — Dashboard (agents list)
- `/agents/:id` — Agent detail (tabs: Overview, Sessions, Tools, etc.)
- `/agents/:id/conversations/new` — New chat conversation
- `/agents/:id/conversations/:conversationId` — Existing conversation
- `/events`, `/tools`, `/flow`, `/knowledge`, `/triggers`, `/artifacts`, `/settings`

## Prerequisites

The full stack **must** be running with the sandbox profile before starting.

```bash
docker compose up --build -d
```

Verify readiness:

```bash
# API responds
curl -sf http://localhost:3002/api/agents > /dev/null && echo "API: OK" || echo "API: DOWN"

# Egress proxy is healthy (required for sandbox → LLM API connectivity)
docker compose ps egress-proxy --format '{{.Status}}' | grep -q healthy && echo "Proxy: OK" || echo "Proxy: DOWN"

# MinIO is running (required for artifact tests)
curl -sf http://localhost:9000/minio/health/live > /dev/null 2>&1 && echo "MinIO: OK" || echo "MinIO: DOWN — artifact tests will be skipped"

# Sandbox harness images exist
for img in langgraph claude-agents pi-agent; do
  docker image inspect "ctxmill/harness-${img}:latest" > /dev/null 2>&1 && echo "Image ${img}: OK" || echo "Image ${img}: MISSING — run: docker compose up --build"
done
```

All checks must pass before proceeding. Without the sandbox profile, agents cannot reach external LLM APIs and tool proxying (emit-event, request-approval) will fail silently.

## Known issues

> **HITL lifecycle conflict (BUG-1): RESOLVED (2026-04-07).** Sessions now complete after interrupt
> approval. The `stress.hitl.complete` event is reliably emitted. The original issue — lifecycle policy
> destroying the container during `request-approval` blocking — has been fixed.

> **Event chain agent compliance (BUG-2):** The trigger mechanism works correctly (trigger fires, chain-responder
> session spawns and completes). However, the chain-responder agent does not reliably call `emit-event` with
> `stress.chain.done`. This is an LLM instruction-following issue, not a system bug. The chain plumbing
> itself is verified working.

## Shared setup

```bash
set -euo pipefail
API_BASE="http://localhost:3002"

agent_id() {
  local name="$1"
  curl -s "$API_BASE/api/agents" | jq -r --arg name "$name" 'first(.[] | select(.name == $name) | .id)'
}

# POST /api/agents/:id/message returns { sessionId, messageId, conversationId }
send_message() {
  local agent_id="$1"
  local content="$2"
  curl -s -X POST "$API_BASE/api/agents/$agent_id/message" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg content "$content" '{content: $content}')" \
    | jq -r '.sessionId'
}

# GET /api/agents/:id/sessions returns { sessions: [...] }
wait_for_session() {
  local agent_id="$1"
  local session_id="$2"
  local ok_statuses="$3"
  local timeout="${4:-180}"
  local elapsed=0

  while true; do
    status="$(curl -s "$API_BASE/api/agents/$agent_id/sessions" \
      | jq -r --arg sid "$session_id" 'first(.sessions[]? | select(.id == $sid) | .status) // empty')"
    echo "session=$session_id status=${status:-missing} (${elapsed}s)"
    [[ " $ok_statuses " == *" $status "* ]] && return 0
    [[ "$status" =~ ^(failed|cancelled|rejected)$ ]] && return 1
    # HITL: session may error due to container lifecycle but interrupt is persisted
    if [[ "$status" == "error" ]]; then
      has_interrupt="$(curl -s "$API_BASE/api/agents/$agent_id/interrupts" \
        | jq --arg sid "$session_id" '[.interrupts[]? | select(.sessionId == $sid)] | length')"
      if [[ "$has_interrupt" -gt 0 ]]; then
        echo "  session errored but has pending interrupt (durable HITL)"
        return 0
      fi
      return 1
    fi
    ((elapsed+=3))
    [[ $elapsed -ge $timeout ]] && { echo "TIMEOUT after ${timeout}s"; return 1; }
    sleep 3
  done
}

# Wait for a pending interrupt to appear for a session
wait_for_interrupt() {
  local agent_id="$1"
  local session_id="$2"
  local timeout="${3:-120}"
  local elapsed=0

  while true; do
    interrupt="$(curl -s "$API_BASE/api/agents/$agent_id/interrupts" \
      | jq --arg sid "$session_id" 'first(.interrupts[]? | select(.sessionId == $sid))')"
    [[ "$interrupt" != "null" ]] && [[ -n "$interrupt" ]] && { echo "$interrupt"; return 0; }
    ((elapsed+=3))
    echo "  waiting for interrupt... (${elapsed}s)" >&2
    [[ $elapsed -ge $timeout ]] && { echo "TIMEOUT waiting for interrupt" >&2; return 1; }
    sleep 3
  done
}

# POST /api/agents/:id/interrupt accepts { action, sessionId }
resolve_interrupt() {
  local agent_id="$1"
  local session_id="$2"
  local action="$3"
  curl -s -X POST "$API_BASE/api/agents/$agent_id/interrupt" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg action "$action" --arg sessionId "$session_id" '{action: $action, sessionId: $sessionId}')"
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
LG_OPENAI_SID="$(send_message "$LG_OPENAI_ID" "Run the stress test now. Confirm you are operational and emit stress.tools.complete.")"

wait_for_session "$LG_OPENAI_ID" "$LG_OPENAI_SID" "completed error"

curl -s "$API_BASE/api/events?type=stress.tools.complete&agentId=$LG_OPENAI_ID&limit=20" \
  | jq '.events | length'
```

Expected:
- Session reaches `completed` after emitting the event
- `stress.tools.complete` event exists for this agent

Pass/fail:
- Pass if event count > 0
- Fail if no completion event is persisted

---

## Phase 3: Multi-model validation (`stress-lg-gemini`, `stress-pi-gemini`)

### LangGraph + Gemini

```bash
LG_GEMINI_SID="$(send_message "$LG_GEMINI_ID" "Verify Gemini LangGraph execution and emit stress.gemini.complete.")"

wait_for_session "$LG_GEMINI_ID" "$LG_GEMINI_SID" "completed"

curl -s "$API_BASE/api/events?type=stress.gemini.complete&limit=20" | jq '.events | length'
```

### PI Agent + Gemini

```bash
PI_GEMINI_SID="$(send_message "$PI_GEMINI_ID" "Verify Gemini PI-agent execution and emit stress.pi-gemini.complete.")"

wait_for_session "$PI_GEMINI_ID" "$PI_GEMINI_SID" "completed"

curl -s "$API_BASE/api/events?type=stress.pi-gemini.complete&limit=20" | jq '.events | length'
```

Expected:
- Both Gemini-backed agents complete successfully
- Each emits its model-specific event

Pass/fail:
- Pass if both sessions are `completed` and both event counts are > 0
- Fail if either session errors or either event is missing

---

## Phase 4: Event chain (`stress-lg-openai` -> `stress-chain-responder`)

Emit the trigger event externally, then verify the responder runs.

```bash
CHAIN_BEFORE="$(curl -s "$API_BASE/api/agents/$CHAIN_ID/sessions" | jq '.sessions | length')"

curl -s -X POST "$API_BASE/api/triggers/emit" \
  -H 'Content-Type: application/json' \
  -d '{"type":"stress.tools.complete","payload":{"source":"stress-test-skill","ts":0}}' \
  | jq .

# Wait for a new session to appear
timeout=60 elapsed=0
while true; do
  CHAIN_SID="$(curl -s "$API_BASE/api/agents/$CHAIN_ID/sessions" \
    | jq -r --argjson before "$CHAIN_BEFORE" 'if (.sessions | length) > $before then .sessions[0].id else empty end')"
  [[ -n "$CHAIN_SID" ]] && break
  ((elapsed+=2))
  [[ $elapsed -ge $timeout ]] && { echo "TIMEOUT"; break; }
  sleep 2
done

wait_for_session "$CHAIN_ID" "$CHAIN_SID" "completed"

curl -s "$API_BASE/api/events?type=stress.chain.done&limit=20" | jq '.events | length'
```

Expected:
- Trigger emission returns 200
- `stress-chain-responder` receives a new session
- `stress.chain.done` is persisted

Pass/fail:
- Pass if a new responder session appears and completes
- Fail if the trigger emits but no responder session starts

---

## Phase 5: Code execution (`stress-claude-sonnet`)

```bash
CLAUDE_SID="$(send_message "$CLAUDE_ID" "Write the stress test file now, verify it exists, and emit stress.claude.complete.")"

wait_for_session "$CLAUDE_ID" "$CLAUDE_SID" "completed"

curl -s "$API_BASE/api/events?type=stress.claude.complete&limit=20" | jq '.events | length'
```

Expected:
- Claude agent completes
- event proves the write/verify workflow finished

Pass/fail:
- Pass if session is `completed` and event count > 0
- Fail otherwise

---

## Phase 6: HITL (`stress-hitl`) — approve, then reject

> HITL lifecycle is fully functional. Sessions survive the interrupt and complete after approval/rejection.

### Approve path

```bash
HITL_APPROVE_SID="$(send_message "$HITL_ID" "Request approval for writing stress test results, then emit stress.hitl.complete.")"

# Wait for interrupt to appear (session may show running or error)
INTERRUPT="$(wait_for_interrupt "$HITL_ID" "$HITL_APPROVE_SID")"
echo "$INTERRUPT" | jq '{id, toolName, status}'

# Approve
resolve_interrupt "$HITL_ID" "$HITL_APPROVE_SID" "approve" | jq .

# Check resolution
curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" \
  | jq --arg sid "$HITL_APPROVE_SID" '[.interrupts[]? | select(.sessionId == $sid)] | length'
```

### Reject path

```bash
HITL_REJECT_SID="$(send_message "$HITL_ID" "Request approval again — this one will be rejected.")"

INTERRUPT="$(wait_for_interrupt "$HITL_ID" "$HITL_REJECT_SID")"
echo "$INTERRUPT" | jq '{id, toolName, status}'

resolve_interrupt "$HITL_ID" "$HITL_REJECT_SID" "reject" | jq .

curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" \
  | jq --arg sid "$HITL_REJECT_SID" '[.interrupts[]? | select(.sessionId == $sid)] | length'
```

Expected:
- Both runs produce a durable interrupt with `request-approval` tool
- Approve and reject both resolve the interrupt (pending count → 0)
- Sessions complete normally after approval; `stress.hitl.complete` event emitted on approve path

Pass/fail:
- Pass if both interrupts are persisted and both resolutions clear the pending list
- Fail if interrupts are not persisted or resolution fails

---

## Phase 7: Verify events persisted in `/api/events`

```bash
curl -s "$API_BASE/api/events?limit=200" | jq '[.events[].type] | unique'
```

Confirm these event types exist:
- `stress.tools.complete`
- `stress.gemini.complete`
- `stress.pi-gemini.complete`
- `stress.claude.complete`
- `stress.hitl.complete`
- `stress.chain.done` (unreliable — see BUG-2; chain mechanism works but agent may not emit)

Pass/fail:
- Pass if the first 5 types are present in persisted events
- `stress.chain.done` is best-effort due to BUG-2 (LLM compliance)
- Fail if any of the first 5 event types is missing

---

## Phase 8: System settings API

```bash
curl -s "$API_BASE/api/settings" | jq .

SETTINGS_COUNT="$(curl -s "$API_BASE/api/settings" | jq 'keys | length')"
ORIGINAL_MAX_CONCURRENT="$(curl -s "$API_BASE/api/settings" | jq -r '.maxConcurrentSessionsPerAgent')"

curl -s -X PUT "$API_BASE/api/settings" \
  -H 'Content-Type: application/json' \
  -d '{"maxConcurrentSessionsPerAgent":4}' \
  | jq .

INVALID_SETTINGS_RESPONSE="$(curl -s -w $'\n%{http_code}' -X PUT "$API_BASE/api/settings" \
  -H 'Content-Type: application/json' \
  -d '{"maxConcurrentSessionsPerAgent":-1}')"
INVALID_SETTINGS_STATUS="${INVALID_SETTINGS_RESPONSE##*$'\n'}"
INVALID_SETTINGS_BODY="${INVALID_SETTINGS_RESPONSE%$'\n'*}"

echo "$INVALID_SETTINGS_BODY" | jq .

CURRENT_MAX_CONCURRENT="$(curl -s "$API_BASE/api/settings" | jq -r '.maxConcurrentSessionsPerAgent')"

curl -s -X PUT "$API_BASE/api/settings" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --argjson value "$ORIGINAL_MAX_CONCURRENT" '{maxConcurrentSessionsPerAgent: $value}')" \
  | jq .
```

Expected:
- `GET /api/settings` returns all 14 settings
- `PUT /api/settings` persists a valid update to `maxConcurrentSessionsPerAgent`
- invalid update returns 400 and does not overwrite the valid value
- final restore returns the original value

Pass/fail:
- Pass if `SETTINGS_COUNT=14`, `INVALID_SETTINGS_STATUS=400`, and `CURRENT_MAX_CONCURRENT=4` before restore
- Fail if any settings key is missing, validation accepts the negative value, or the round-trip update does not persist

---

## Phase 9: Artifact storage

```bash
# MinIO must be running for artifact tests
if curl -sf http://localhost:9000/minio/health/live > /dev/null 2>&1; then
  echo "MinIO: OK"

  ARTIFACT_PAYLOAD="stress-test-artifact-payload"

  ARTIFACT_UPLOAD_RESPONSE="$(curl -s -X POST "$API_BASE/api/artifacts/upload-url" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg agentId "$LG_OPENAI_ID" --arg name "stress-test-artifact.txt" --arg mimeType "text/plain" --argjson sizeBytes 100 '{agentId: $agentId, name: $name, mimeType: $mimeType, sizeBytes: $sizeBytes}')")"

  echo "$ARTIFACT_UPLOAD_RESPONSE" | jq .

  ARTIFACT_ID="$(echo "$ARTIFACT_UPLOAD_RESPONSE" | jq -r '.artifactId')"
  ARTIFACT_UPLOAD_URL="$(echo "$ARTIFACT_UPLOAD_RESPONSE" | jq -r '.uploadUrl')"

  curl -s -X PUT "$ARTIFACT_UPLOAD_URL" \
    -H 'Content-Type: text/plain' \
    --data-binary "$ARTIFACT_PAYLOAD" \
    > /dev/null

  # List: GET /api/artifacts?agentId=... returns { artifacts: [...] }
  curl -s "$API_BASE/api/artifacts?agentId=$LG_OPENAI_ID" | jq '.artifacts | length'

  # Get single: GET /api/artifacts/:id returns the raw Artifact object (no wrapper)
  curl -s "$API_BASE/api/artifacts/$ARTIFACT_ID" | jq '{id, name, mimeType, sizeBytes}'

  ARTIFACT_DOWNLOAD_RESPONSE="$(curl -s "$API_BASE/api/artifacts/$ARTIFACT_ID/download-url")"
  ARTIFACT_DOWNLOAD_URL="$(echo "$ARTIFACT_DOWNLOAD_RESPONSE" | jq -r '.url')"
  DOWNLOADED_ARTIFACT_PAYLOAD="$(curl -s "$ARTIFACT_DOWNLOAD_URL")"

  curl -s -X DELETE "$API_BASE/api/artifacts/$ARTIFACT_ID" | jq .

  REMAINING_ARTIFACTS="$(curl -s "$API_BASE/api/artifacts?agentId=$LG_OPENAI_ID" | jq --arg artifact_id "$ARTIFACT_ID" '[.artifacts[]? | select(.id == $artifact_id)] | length')"
else
  echo "MinIO: DOWN (skip artifact tests)"
fi
```

Expected:
- Full artifact lifecycle works end-to-end: upload URL, direct upload, list, get, download URL, download, and delete
- downloaded artifact content matches the original payload
- deleted artifact no longer appears in the agent artifact list

Pass/fail:
- Pass if upload succeeds, `DOWNLOADED_ARTIFACT_PAYLOAD` matches `ARTIFACT_PAYLOAD`, and `REMAINING_ARTIFACTS=0`
- Fail if any artifact step returns non-200, MinIO is up but the lifecycle breaks, or downloaded content mismatches

---

## Phase 10: Durable HITL interrupt persistence

```bash
HITL_PERSIST_SID="$(send_message "$HITL_ID" "Request approval for the durable interrupt persistence stress test, then emit stress.hitl.complete.")"

# Wait for interrupt to appear
PERSISTED_INTERRUPT="$(wait_for_interrupt "$HITL_ID" "$HITL_PERSIST_SID")"

echo "$PERSISTED_INTERRUPT" | jq .

PERSISTED_INTERRUPT_ID="$(echo "$PERSISTED_INTERRUPT" | jq -r '.id // empty')"
PERSISTED_SESSION_ID="$(echo "$PERSISTED_INTERRUPT" | jq -r '.sessionId // empty')"
PERSISTED_TOOL_NAME="$(echo "$PERSISTED_INTERRUPT" | jq -r '.toolName // empty')"
PERSISTED_ARGS="$(echo "$PERSISTED_INTERRUPT" | jq -c '.args // empty')"

resolve_interrupt "$HITL_ID" "$HITL_PERSIST_SID" "approve" | jq .

sleep 3

PENDING_AFTER_RESOLUTION="$(curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" \
  | jq --arg sid "$HITL_PERSIST_SID" '[.interrupts[]? | select(.sessionId == $sid)] | length')"
```

Expected:
- interrupt appears in `GET /api/agents/$HITL_ID/interrupts` with durable fields
- pending interrupt response includes id, sessionId, toolName, and args
- `POST /api/agents/$HITL_ID/interrupt` resolves the interrupt
- resolved interrupt no longer appears in the pending interrupts list

Pass/fail:
- Pass if `PERSISTED_INTERRUPT_ID`, `PERSISTED_SESSION_ID`, `PERSISTED_TOOL_NAME`, and `PERSISTED_ARGS` are present before resolution and `PENDING_AFTER_RESOLUTION=0`
- Fail if the interrupt is not persisted, the resolve call fails, or the interrupt remains pending after resolution

---

## Post-run cleanup (manual, after human verification)

Do NOT run cleanup as part of the test. Cleanup deletes agents and cascade-deletes
their events, sessions, and messages — making post-hoc verification impossible.

Run only after the human has reviewed all results:

```bash
npx tsx tests/stress/seed.ts --clean
```
