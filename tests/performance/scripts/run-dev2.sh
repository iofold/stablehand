#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE_PATH="${1:-$ROOT_DIR/tests/performance/profiles/dev2-smoke.json}"
RUN_SLUG="$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$PROFILE_PATH" .json)"
OUTPUT_DIR="${2:-$ROOT_DIR/.tmp/performance/$RUN_SLUG}"
BUN="${BUN:-bun}"

export KUBECONFIG="${KUBECONFIG:-$HOME/workspace/infra/.k3s-kubeconfig.yaml}"
export STABLEHAND_PERF_NAMESPACE="$(
  jq -r '.target.kubernetesNamespace' "$PROFILE_PATH"
)"
export STABLEHAND_PERF_MAX_NODE_CPU_PERCENT="$(
  jq -r '.safety.maxNodeCpuPercent' "$PROFILE_PATH"
)"
export STABLEHAND_PERF_MAX_NODE_MEMORY_PERCENT="$(
  jq -r '.safety.maxNodeMemoryPercent' "$PROFILE_PATH"
)"
export STABLEHAND_PERF_ABORT_FILE="$OUTPUT_DIR/ABORT"
API_BASE="${STABLEHAND_PERF_API_BASE:-$(jq -r '.target.apiBase' "$PROFILE_PATH")}"
export STABLEHAND_PERF_API_BASE="$API_BASE"
MIN_GLOBAL_CONTAINERS="$(
  jq -r '.requirements.minGlobalContainers // 0' "$PROFILE_PATH"
)"
if [[ -n "${STABLEHAND_PERF_RAMP_PATH:-}" ]]; then
  export STABLEHAND_PERF_PENDING_POD_GRACE_SECONDS="$(
    jq -r '.pendingPodGraceSeconds' "$STABLEHAND_PERF_RAMP_PATH"
  )"
  export STABLEHAND_PERF_MAX_PENDING_SANDBOX_PODS=0
fi

umask 077
mkdir -p "$OUTPUT_DIR"
rm -f "$STABLEHAND_PERF_ABORT_FILE"

if [[ -z "${STABLEHAND_API_TOKEN:-}" ]]; then
  token_base64="$(
    kubectl -n "$STABLEHAND_PERF_NAMESPACE" get secret stablehand-core-secrets \
      -o jsonpath='{.data.STABLEHAND_API_TOKEN}'
  )"
  if [[ -z "$token_base64" ]]; then
    printf 'STABLEHAND_API_TOKEN is absent from stablehand-core-secrets\n' >&2
    exit 1
  fi
  export STABLEHAND_API_TOKEN="$(printf '%s' "$token_base64" | base64 -d)"
fi

RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
"$ROOT_DIR/tests/performance/scripts/capture-dev2-operations.sh" \
  before "$OUTPUT_DIR"

if (( MIN_GLOBAL_CONTAINERS > 0 )); then
  configured_global_containers="$(
    curl -fsS "$API_BASE/sandbox/metrics" \
      -H "Authorization: Bearer $STABLEHAND_API_TOKEN" \
      | jq -r '.limits.max_global_containers'
  )"
  if ! [[ "$configured_global_containers" =~ ^[0-9]+$ ]]; then
    printf 'Unable to read effective max_global_containers from %s\n' \
      "$API_BASE/sandbox/metrics" >&2
    exit 1
  fi
  if (( configured_global_containers < MIN_GLOBAL_CONTAINERS )); then
    printf 'Profile requires %d global sandboxes; dev2 currently allows %d\n' \
      "$MIN_GLOBAL_CONTAINERS" "$configured_global_containers" >&2
    exit 1
  fi
fi

sampler_pid=''
cleanup() {
  if [[ -n "$sampler_pid" ]] && kill -0 "$sampler_pid" 2>/dev/null; then
    kill "$sampler_pid" 2>/dev/null || true
    wait "$sampler_pid" 2>/dev/null || true
  fi
  unset STABLEHAND_API_TOKEN token_base64
}
trap cleanup EXIT INT TERM

"$ROOT_DIR/tests/performance/scripts/sample-dev2-kubernetes.sh" \
  "$OUTPUT_DIR/kubernetes.jsonl" &
sampler_pid=$!

set +e
if [[ -x /usr/bin/time ]]; then
  /usr/bin/time -v -o "$OUTPUT_DIR/load-generator-resource.txt" \
    "$BUN" "$ROOT_DIR/tests/performance/cli.ts" run \
    --profile "$PROFILE_PATH" \
    --output "$OUTPUT_DIR" \
    >"$OUTPUT_DIR/runner.stdout.jsonl" \
    2>"$OUTPUT_DIR/runner.stderr.log"
else
  "$BUN" "$ROOT_DIR/tests/performance/cli.ts" run \
    --profile "$PROFILE_PATH" \
    --output "$OUTPUT_DIR" \
    >"$OUTPUT_DIR/runner.stdout.jsonl" \
    2>"$OUTPUT_DIR/runner.stderr.log"
fi
runner_status=$?
set -e

kill "$sampler_pid" 2>/dev/null || true
wait "$sampler_pid" 2>/dev/null || true
sampler_pid=''

if (( runner_status != 0 )); then
  "$BUN" "$ROOT_DIR/tests/performance/cli.ts" resources \
    --kubernetes "$OUTPUT_DIR/kubernetes.jsonl" \
    --output "$OUTPUT_DIR"
else
  "$BUN" "$ROOT_DIR/tests/performance/cli.ts" finalize \
    --result "$OUTPUT_DIR/run.json" \
    --kubernetes "$OUTPUT_DIR/kubernetes.jsonl" \
    --output "$OUTPUT_DIR"
fi

settle_deadline=$((SECONDS + 45))
while (( SECONDS < settle_deadline )); do
  active_jobs="$(
    kubectl -n "$STABLEHAND_PERF_NAMESPACE" get jobs -o json \
      | jq '[.items[] | select(
        .metadata.labels["stablehand.sandbox-session-id"] != null
        and ((.status.active // 0) > 0)
      )] | length'
  )"
  if (( active_jobs == 0 )); then
    break
  fi
  sleep 2
done

sleep 12
gateway_deadline=$((SECONDS + 45))
if [[ -f "$OUTPUT_DIR/run.json" ]]; then
  wave_completed_at="$(jq -r '.completedAt' "$OUTPUT_DIR/run.json")"
else
  wave_completed_at="$(jq -r '.failedAt' "$OUTPUT_DIR/failure.json")"
fi
wave_completed_at_ms="$(date -u -d "$wave_completed_at" +%s%3N)"
: >"$OUTPUT_DIR/gateway-settlement.jsonl"
while (( SECONDS < gateway_deadline )); do
  gateway_status="$(
    curl -fsS "$API_BASE/model-gateway/status" \
      -H "Authorization: Bearer $STABLEHAND_API_TOKEN" || \
      printf '{"state":"unavailable","pendingCalls":-1}'
  )"
  jq -c --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
    '. + {observedAt:$observedAt}' <<<"$gateway_status" \
    >>"$OUTPUT_DIR/gateway-settlement.jsonl"
  if [[ "$(jq -r '.state' <<<"$gateway_status")" == "healthy" ]] \
    && (( $(jq -r '.pendingCalls // -1' <<<"$gateway_status") == 0 )) \
    && (( $(jq -r '.watermarkAt // 0' <<<"$gateway_status") >= wave_completed_at_ms )) \
    && (( $(jq -r '.lastSuccessAt // 0' <<<"$gateway_status") >= wave_completed_at_ms )); then
    break
  fi
  sleep 3
done
"$ROOT_DIR/tests/performance/scripts/capture-dev2-operations.sh" \
  after "$OUTPUT_DIR" "$RUN_STARTED_AT"

if (( runner_status == 0 )); then
  "$BUN" "$ROOT_DIR/tests/performance/cli.ts" refresh \
    --result "$OUTPUT_DIR/run.json" \
    --output "$OUTPUT_DIR"
  "$BUN" "$ROOT_DIR/tests/performance/cli.ts" finalize \
    --result "$OUTPUT_DIR/run.json" \
    --kubernetes "$OUTPUT_DIR/kubernetes.jsonl" \
    --output "$OUTPUT_DIR"
fi

trace_window="$OUTPUT_DIR/run.json"
if [[ ! -f "$trace_window" ]]; then
  trace_window="$OUTPUT_DIR/trace-window.json"
fi
"$ROOT_DIR/tests/performance/scripts/collect-dev2-traces.sh" \
  "$trace_window" \
  "$OUTPUT_DIR/turn-ids.txt" \
  "$OUTPUT_DIR/traces.jsonl"

evaluation_status=0
if [[ -n "${STABLEHAND_PERF_RAMP_PATH:-}" ]]; then
  set +e
  "$BUN" "$ROOT_DIR/tests/performance/cli.ts" evaluate \
    --ramp "$STABLEHAND_PERF_RAMP_PATH" \
    --output "$OUTPUT_DIR"
  evaluation_status=$?
  set -e
fi

if (( runner_status != 0 )); then
  printf 'Performance run failed; evidence is in %s\n' "$OUTPUT_DIR" >&2
  exit "$runner_status"
fi
if (( evaluation_status != 0 )); then
  printf 'Capacity gate stopped the ramp; evidence is in %s\n' "$OUTPUT_DIR" >&2
  exit "$evaluation_status"
fi

printf 'Performance evidence: %s\n' "$OUTPUT_DIR"
