#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE_PATH="${1:-$ROOT_DIR/tests/performance/profiles/dev2-smoke.json}"
RUN_SLUG="$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$PROFILE_PATH" .json)"
OUTPUT_DIR="${2:-$ROOT_DIR/.tmp/performance/$RUN_SLUG}"
BUN="${BUN:-bun}"

export KUBECONFIG="${KUBECONFIG:-/path/to/workspace/infra/.k3s-kubeconfig.yaml}"
export CTXMILL_PERF_NAMESPACE="$(
  jq -r '.target.kubernetesNamespace' "$PROFILE_PATH"
)"
export CTXMILL_PERF_MAX_NODE_CPU_PERCENT="$(
  jq -r '.safety.maxNodeCpuPercent' "$PROFILE_PATH"
)"
export CTXMILL_PERF_MAX_NODE_MEMORY_PERCENT="$(
  jq -r '.safety.maxNodeMemoryPercent' "$PROFILE_PATH"
)"
export CTXMILL_PERF_ABORT_FILE="$OUTPUT_DIR/ABORT"
API_BASE="$(jq -r '.target.apiBase' "$PROFILE_PATH")"
MIN_GLOBAL_CONTAINERS="$(
  jq -r '.requirements.minGlobalContainers // 0' "$PROFILE_PATH"
)"

umask 077
mkdir -p "$OUTPUT_DIR"
rm -f "$CTXMILL_PERF_ABORT_FILE"

if [[ -z "${CTXMILL_API_TOKEN:-}" ]]; then
  token_base64="$(
    kubectl -n "$CTXMILL_PERF_NAMESPACE" get secret ctxmill-core-secrets \
      -o jsonpath='{.data.CTXMILL_API_TOKEN}'
  )"
  if [[ -z "$token_base64" ]]; then
    printf 'CTXMILL_API_TOKEN is absent from ctxmill-core-secrets\n' >&2
    exit 1
  fi
  export CTXMILL_API_TOKEN="$(printf '%s' "$token_base64" | base64 -d)"
fi

if (( MIN_GLOBAL_CONTAINERS > 0 )); then
  configured_global_containers="$(
    curl -fsS "$API_BASE/sandbox/metrics" \
      -H "Authorization: Bearer $CTXMILL_API_TOKEN" \
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
  unset CTXMILL_API_TOKEN token_base64
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
  printf 'Performance run failed; evidence is in %s\n' "$OUTPUT_DIR" >&2
  exit "$runner_status"
fi

"$BUN" "$ROOT_DIR/tests/performance/cli.ts" finalize \
  --result "$OUTPUT_DIR/run.json" \
  --kubernetes "$OUTPUT_DIR/kubernetes.jsonl" \
  --output "$OUTPUT_DIR"

sleep 10
"$ROOT_DIR/tests/performance/scripts/collect-dev2-traces.sh" \
  "$OUTPUT_DIR/run.json" \
  "$OUTPUT_DIR/turn-ids.txt" \
  "$OUTPUT_DIR/traces.jsonl"

printf 'Performance evidence: %s\n' "$OUTPUT_DIR"
