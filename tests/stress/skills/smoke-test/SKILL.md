---
name: smoke-test
description: Quick stress-test smoke validation for ctxmill — verifies each harness and model works
---

# Stress smoke test

Run from the repo root with Docker/API already up.

## 1) Health check

```bash
set -euo pipefail
API_BASE="http://localhost:3002"

curl -s "$API_BASE/health" | jq .
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
  local wanted="$3"

  while true; do
    status="$(curl -s "$API_BASE/api/agents/$agent_id/sessions" \
      | jq -r --arg session_id "$session_id" 'first(.sessions[]? | select(.id == $session_id or .sessionId == $session_id) | .status) // empty' \
      | tr '[:upper:]' '[:lower:]')"
    echo "session=$session_id status=${status:-missing}"

    case "$status" in
      "$wanted") return 0 ;;
      error|failed|cancelled|rejected) return 1 ;;
    esac

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
```

### stress-lg-openai

```bash
LG_OPENAI_RUN="$(post_message "$LG_OPENAI_ID" "Quick smoke test: use a basic tool, finish cleanly, and emit stress.tools.complete.")"

wait_for_status "$LG_OPENAI_ID" "$LG_OPENAI_RUN" completed
```

### stress-lg-gemini

```bash
LG_GEMINI_RUN="$(post_message "$LG_GEMINI_ID" "Quick smoke test: verify Gemini tool execution and emit stress.gemini.complete.")"

wait_for_status "$LG_GEMINI_ID" "$LG_GEMINI_RUN" completed
```

### stress-pi-openai

```bash
PI_OPENAI_RUN="$(post_message "$PI_OPENAI_ID" "Quick smoke test: run once and emit stress.pi.complete.")"

wait_for_status "$PI_OPENAI_ID" "$PI_OPENAI_RUN" completed
```

### stress-pi-gemini

```bash
PI_GEMINI_RUN="$(post_message "$PI_GEMINI_ID" "Quick smoke test: run once and emit stress.pi-gemini.complete.")"

wait_for_status "$PI_GEMINI_ID" "$PI_GEMINI_RUN" completed
```

### stress-claude-sonnet

```bash
CLAUDE_RUN="$(post_message "$CLAUDE_ID" "Quick smoke test: write and verify a tiny file, then emit stress.claude.complete.")"

wait_for_status "$CLAUDE_ID" "$CLAUDE_RUN" completed
```

### stress-chain-responder

```bash
CHAIN_RUN="$(post_message "$CHAIN_ID" "Quick smoke test: acknowledge the request and emit stress.chain.done.")"

wait_for_status "$CHAIN_ID" "$CHAIN_RUN" completed
```

### stress-hitl

```bash
HITL_RUN="$(post_message "$HITL_ID" "Create the approval smoke file now.")"

wait_for_interrupt "$HITL_ID" "$HITL_RUN"
```

## 4) Approve HITL interrupt

```bash
INTERRUPT_SESSION_ID="$(curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" \
  | jq -r --arg session_id "$HITL_RUN" 'first(.interrupts[]? | select(.sessionId == $session_id) | .sessionId)')"

curl -s -X POST "$API_BASE/api/agents/$HITL_ID/interrupt" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg action approve --arg sessionId "$INTERRUPT_SESSION_ID" '{action: $action, sessionId: $sessionId}')" \
  | jq .

wait_for_status "$HITL_ID" "$HITL_RUN" completed
```

Pass if the interrupt resolves successfully and the HITL session ends in `completed`.

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
