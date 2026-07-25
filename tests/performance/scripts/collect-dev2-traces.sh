#!/usr/bin/env bash
set -euo pipefail

RUN_JSON="${1:?usage: collect-dev2-traces.sh <run.json> <turn-ids.txt> <output.jsonl>}"
TURN_IDS_PATH="${2:?usage: collect-dev2-traces.sh <run.json> <turn-ids.txt> <output.jsonl>}"
OUTPUT_PATH="${3:?usage: collect-dev2-traces.sh <run.json> <turn-ids.txt> <output.jsonl>}"
KUBECTL="${KUBECTL:-kubectl}"
OBSERVABILITY_NAMESPACE="${CTXMILL_PERF_OBSERVABILITY_NAMESPACE:-observability}"

mapfile -t turn_ids < <(sed '/^[[:space:]]*$/d' "$TURN_IDS_PATH")
if (( ${#turn_ids[@]} == 0 )); then
  : >"$OUTPUT_PATH"
  exit 0
fi
for turn_id in "${turn_ids[@]}"; do
  if [[ ! "$turn_id" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    printf 'Invalid turn id in %s\n' "$TURN_IDS_PATH" >&2
    exit 2
  fi
done

turn_id_literals="$(
  printf '%s\n' "${turn_ids[@]}" \
    | jq -Rsc 'split("\n") | map(select(length > 0) | "'"'"'" + . + "'"'"'") | join(",")'
)"
started_at="$(jq -r '.startedAt' "$RUN_JSON")"
completed_at="$(jq -r '.completedAt' "$RUN_JSON")"
clickhouse_pod="$(
  $KUBECTL -n "$OBSERVABILITY_NAMESPACE" get pods \
    -l 'app.kubernetes.io/component=clickhouse,clickhouse.altinity.com/ready=yes' \
    -o jsonpath='{.items[0].metadata.name}'
)"
if [[ -z "$clickhouse_pod" ]]; then
  printf 'No ready SigNoz ClickHouse pod found\n' >&2
  exit 1
fi

read -r -d '' query <<SQL || true
SELECT
  timestamp,
  trace_id,
  span_id,
  parent_span_id,
  name,
  kind_string,
  duration_nano,
  status_code_string,
  attributes_string['ctxmill.turn.id'] AS turn_id,
  attributes_string['ctxmill.agent.id'] AS agent_id,
  attributes_string['ctxmill.conversation.id'] AS conversation_id,
  attributes_string['ctxmill.session.id'] AS sandbox_session_id,
  attributes_string['ctxmill.phase'] AS phase,
  attributes_string['ctxmill.harness'] AS harness,
  attributes_string['ctxmill.mode'] AS mode,
  attributes_string['ctxmill.outcome'] AS outcome,
  attributes_string['ctxmill.runtime'] AS runtime,
  attributes_string['ctxmill.session.state'] AS session_state,
  attributes_string['http.route'] AS http_route,
  attributes_string['http.request.method'] AS http_method,
  attributes_string['rpc.service'] AS rpc_service,
  attributes_string['rpc.method'] AS rpc_method,
  resources_string['service.name'] AS service_name
FROM signoz_traces.signoz_index_v3
WHERE timestamp >= parseDateTime64BestEffort('$started_at') - INTERVAL 1 MINUTE
  AND timestamp <= parseDateTime64BestEffort('$completed_at') + INTERVAL 5 MINUTE
  AND trace_id IN (
    SELECT DISTINCT trace_id
    FROM signoz_traces.signoz_index_v3
    WHERE timestamp >= parseDateTime64BestEffort('$started_at') - INTERVAL 1 MINUTE
      AND timestamp <= parseDateTime64BestEffort('$completed_at') + INTERVAL 5 MINUTE
      AND attributes_string['ctxmill.turn.id'] IN ($turn_id_literals)
  )
ORDER BY timestamp, trace_id, span_id
FORMAT JSONEachRow
SQL

mkdir -p "$(dirname "$OUTPUT_PATH")"
$KUBECTL -n "$OBSERVABILITY_NAMESPACE" exec "$clickhouse_pod" \
  -- clickhouse-client --query "$query" >"$OUTPUT_PATH"
