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
wait_for_status() {
  local agent_id="$1"
  local run_id="$2"
  local wanted="$3"

  while true; do
    status="$(curl -s "$API_BASE/api/agents/$agent_id/runs" | jq -r --arg run_id "$run_id" 'first(.[] | select(.id == $run_id) | .status) // empty')"
    echo "run=$run_id status=${status:-missing}"

    case "$status" in
      "$wanted") return 0 ;;
      error|failed|cancelled|rejected) return 1 ;;
    esac

    sleep 2
  done
}
```

### stress-lg-openai

```bash
LG_OPENAI_RUN="$(curl -s -X POST "$API_BASE/api/agents/$LG_OPENAI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: use a basic tool, finish cleanly, and emit stress.tools.complete."}' \
  | jq -r '.runId')"

wait_for_status "$LG_OPENAI_ID" "$LG_OPENAI_RUN" completed
```

### stress-lg-gemini

```bash
LG_GEMINI_RUN="$(curl -s -X POST "$API_BASE/api/agents/$LG_GEMINI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: verify Gemini tool execution and emit stress.gemini.complete."}' \
  | jq -r '.runId')"

wait_for_status "$LG_GEMINI_ID" "$LG_GEMINI_RUN" completed
```

### stress-pi-openai

```bash
PI_OPENAI_RUN="$(curl -s -X POST "$API_BASE/api/agents/$PI_OPENAI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: run once and emit stress.pi.complete."}' \
  | jq -r '.runId')"

wait_for_status "$PI_OPENAI_ID" "$PI_OPENAI_RUN" completed
```

### stress-pi-gemini

```bash
PI_GEMINI_RUN="$(curl -s -X POST "$API_BASE/api/agents/$PI_GEMINI_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: run once and emit stress.pi-gemini.complete."}' \
  | jq -r '.runId')"

wait_for_status "$PI_GEMINI_ID" "$PI_GEMINI_RUN" completed
```

### stress-claude-sonnet

```bash
CLAUDE_RUN="$(curl -s -X POST "$API_BASE/api/agents/$CLAUDE_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: write and verify a tiny file, then emit stress.claude.complete."}' \
  | jq -r '.runId')"

wait_for_status "$CLAUDE_ID" "$CLAUDE_RUN" completed
```

### stress-chain-responder

```bash
CHAIN_RUN="$(curl -s -X POST "$API_BASE/api/agents/$CHAIN_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Quick smoke test: acknowledge the request and emit stress.chain.done."}' \
  | jq -r '.runId')"

wait_for_status "$CHAIN_ID" "$CHAIN_RUN" completed
```

### stress-hitl

```bash
HITL_RUN="$(curl -s -X POST "$API_BASE/api/agents/$HITL_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Create the approval smoke file now."}' \
  | jq -r '.runId')"

while true; do
  HITL_STATUS="$(curl -s "$API_BASE/api/agents/$HITL_ID/runs" | jq -r --arg run_id "$HITL_RUN" 'first(.[] | select(.id == $run_id) | .status) // empty')"
  echo "run=$HITL_RUN status=${HITL_STATUS:-missing}"
  [[ "$HITL_STATUS" == "paused" ]] && break
  [[ "$HITL_STATUS" =~ ^(error|failed|cancelled|rejected)$ ]] && exit 1
  sleep 2
done
```

## 4) Approve HITL interrupt

```bash
INTERRUPT_RUN_ID="$(curl -s "$API_BASE/api/agents/$HITL_ID/interrupts" \
  | jq -r 'first(.interrupts[]? | .runId)')"

curl -s -X POST "$API_BASE/api/agents/$HITL_ID/interrupt" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg action approve --arg runId "$INTERRUPT_RUN_ID" '{action: $action, runId: $runId}')" \
  | jq .

wait_for_status "$HITL_ID" "$HITL_RUN" completed
```

Pass if the interrupt resolves successfully and the HITL run ends in `completed`.

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
