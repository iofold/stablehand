---
name: smoke-test
description: Quick stress-test smoke validation for stablehand — verifies each harness and model works
---

# Stress smoke test

Run from the repo root with Docker/API already up.

## API reference (quick)

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/api/health` | GET | `{ status: "ok", ... }` |
| `/api/agents` | GET | `[ { id, name, harness, ... }, ... ]` |
| `/api/agents/:id/message` | POST `{ content }` | `{ sessionId, messageId, conversationId }` |
| `/api/agents/:id/sessions` | GET | `{ sessions: [{ id, status, ... }] }` |
| `/api/agents/:id/interrupts` | GET | `{ interrupts: [{ sessionId, toolName, ... }] }` |
| `/api/agents/:id/interrupt` | POST `{ action, sessionId }` | `{ resolved: true, ... }` |
| `/api/settings` | GET | `{ maxGlobalContainers, ... }` (17 keys, no wrapper) |

**UI routes** (SPA):
- `/` — Dashboard (agents list)
- `/agents/:id` — Agent detail (tabs: Overview, Sessions, Tools, etc.)
- `/agents/:id/conversations/new` — New chat conversation
- `/agents/:id/conversations/:conversationId` — Existing conversation

## 1) Health check

```bash
set -euo pipefail
API_BASE="http://localhost:3002"

curl -s "$API_BASE/api/health" | jq .
```

Pass if the response is HTTP 200 and shows a healthy service payload.

## 2) Seed stress agents

```bash
npx tsx tests/stress/seed.ts
```

Capture agent ids for later calls:

```bash
AGENTS_JSON="$(curl -s "$API_BASE/api/agents")"

agent_id() {
  local name="$1"
  jq -r --arg name "$name" 'first(.[] | select(.name == $name) | .id)' <<<"$AGENTS_JSON"
}

LG_OPENAI_ID="$(agent_id stress-lg-openai)"
LG_GEMINI_ID="$(agent_id stress-lg-gemini)"
PI_OPENAI_ID="$(agent_id stress-pi-openai)"
PI_GEMINI_ID="$(agent_id stress-pi-gemini)"
CLAUDE_ID="$(agent_id stress-claude-sonnet)"
CHAIN_ID="$(agent_id stress-chain-responder)"
HITL_ID="$(agent_id stress-hitl)"

printf '%s\n' \
  "stress-lg-openai=$LG_OPENAI_ID" \
  "stress-lg-gemini=$LG_GEMINI_ID" \
  "stress-pi-openai=$PI_OPENAI_ID" \
  "stress-pi-gemini=$PI_GEMINI_ID" \
  "stress-claude-sonnet=$CLAUDE_ID" \
  "stress-chain-responder=$CHAIN_ID" \
  "stress-hitl=$HITL_ID"
```

Pass if all 7 ids are non-empty.

## 3) Send one message to each agent and wait for completion

Reusable polling helper:

```bash
# POST /api/agents/:id/message returns { sessionId, messageId, conversationId }
# GET  /api/agents/:id/sessions returns { sessions: [{ id, status, ... }] }
wait_for_status() {
  local agent_id="$1"
  local session_id="$2"
  local wanted="$3"
  local timeout="${4:-120}"
  local elapsed=0

  while true; do
    status="$(curl -s "$API_BASE/api/agents/$agent_id/sessions" | jq -r --arg sid "$session_id" 'first(.sessions[]? | select(.id == $sid) | .status) // empty')"
    echo "session=$session_id status=${status:-missing} (${elapsed}s)"

    case "$status" in
      "$wanted") return 0 ;;
      error|failed|cancelled|rejected) return 1 ;;
    esac

    ((elapsed+=2))
    [[ $elapsed -ge $timeout ]] && { echo "TIMEOUT after ${timeout}s"; return 1; }
    sleep 2
  done
}
```

### stress-lg-openai

```bash
LG_OPENAI_SID="$(curl -s -X POST "$API_BASE/api/agents/$LG_OPENAI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: use a basic tool, finish cleanly, and emit stress.tools.complete."}' \
  | jq -r '.sessionId')"

wait_for_status "$LG_OPENAI_ID" "$LG_OPENAI_SID" completed
```

### stress-lg-gemini

```bash
LG_GEMINI_SID="$(curl -s -X POST "$API_BASE/api/agents/$LG_GEMINI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: verify Gemini tool execution and emit stress.gemini.complete."}' \
  | jq -r '.sessionId')"

wait_for_status "$LG_GEMINI_ID" "$LG_GEMINI_SID" completed
```

### stress-pi-openai

```bash
PI_OPENAI_SID="$(curl -s -X POST "$API_BASE/api/agents/$PI_OPENAI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: run once and emit stress.pi.complete."}' \
  | jq -r '.sessionId')"

wait_for_status "$PI_OPENAI_ID" "$PI_OPENAI_SID" completed
```

### stress-pi-gemini

```bash
PI_GEMINI_SID="$(curl -s -X POST "$API_BASE/api/agents/$PI_GEMINI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: run once and emit stress.pi-gemini.complete."}' \
  | jq -r '.sessionId')"

wait_for_status "$PI_GEMINI_ID" "$PI_GEMINI_SID" completed
```

### stress-claude-sonnet

```bash
CLAUDE_SID="$(curl -s -X POST "$API_BASE/api/agents/$CLAUDE_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: write and verify a tiny file, then emit stress.claude.complete."}' \
  | jq -r '.sessionId')"

wait_for_status "$CLAUDE_ID" "$CLAUDE_SID" completed
```

### stress-chain-responder

```bash
CHAIN_SID="$(curl -s -X POST "$API_BASE/api/agents/$CHAIN_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: acknowledge the request and emit stress.chain.done."}' \
  | jq -r '.sessionId')"

wait_for_status "$CHAIN_ID" "$CHAIN_SID" completed
```

### stress-hitl

```bash
HITL_SID="$(curl -s -X POST "$API_BASE/api/agents/$HITL_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Create the approval smoke file now."}' \
  | jq -r '.sessionId')"

# Wait for interrupt (session may show running or error due to BUG-1)
timeout=120 elapsed=0
while true; do
  HITL_STATUS="$(curl -s "$API_BASE/api/agents/$HITL_ID/sessions" | jq -r --arg sid "$HITL_SID" 'first(.sessions[]? | select(.id == $sid) | .status) // empty')"
  echo "session=$HITL_SID status=${HITL_STATUS:-missing} (${elapsed}s)"

  # Check for pending interrupt regardless of session status
  HAS_INTERRUPT="$(curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" \
    | jq --arg sid "$HITL_SID" '[.interrupts[]? | select(.sessionId == $sid)] | length')"
  [[ "$HAS_INTERRUPT" -gt 0 ]] && break

  [[ "$HITL_STATUS" =~ ^(cancelled|rejected)$ ]] && exit 1
  ((elapsed+=2))
  [[ $elapsed -ge $timeout ]] && { echo "TIMEOUT"; exit 1; }
  sleep 2
done
```

## 4) Approve HITL interrupt

```bash
# GET /api/agents/:id/interrupts returns { interrupts: [{ sessionId, ... }] }
# POST /api/agents/:id/interrupt accepts { action, sessionId }
curl -s -X POST "$API_BASE/api/agents/$HITL_ID/interrupt" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg action approve --arg sessionId "$HITL_SID" '{action: $action, sessionId: $sessionId}')" \
  | jq .

# Verify the interrupt was cleared
sleep 3
REMAINING="$(curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" \
  | jq --arg sid "$HITL_SID" '[.interrupts[]? | select(.sessionId == $sid)] | length')"
echo "Remaining interrupts for session: $REMAINING"
```

Pass if the interrupt resolves successfully and pending count drops to 0.

## 5) Check completion events

```bash
curl -s "$API_BASE/api/events?type=stress.tools.complete&limit=20" | jq '.events'
```

Pass if at least one `stress.tools.complete` event exists from this run.

## Post-run cleanup (manual, after human verification)

Do NOT run cleanup as part of the test. Cleanup cascade-deletes events/sessions/messages.

Run only after the human has reviewed all results:

```bash
npx tsx tests/stress/seed.ts --clean
```
