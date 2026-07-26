#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RAMP_PATH="${1:-$ROOT_DIR/tests/performance/profiles/dev2-adaptive-capacity.json}"
RUN_SLUG="$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$RAMP_PATH" .json)"
OUTPUT_ROOT="${2:-$ROOT_DIR/.tmp/performance/$RUN_SLUG}"
BUN="${BUN:-bun}"
MAX_TOTAL_MODEL_CALLS="${CTXMILL_PERF_MAX_TOTAL_MODEL_CALLS:-1200}"

export KUBECONFIG="${KUBECONFIG:-/path/to/workspace/infra/.k3s-kubeconfig.yaml}"
namespace="$(jq -r '.target.kubernetesNamespace' "$RAMP_PATH")"
api_base="$(jq -r '.target.apiBase' "$RAMP_PATH")"
temporary_limit="$(jq -r '.maxGlobalContainers' "$RAMP_PATH")"
confirmation_runs="$(jq -r '.confirmationRuns' "$RAMP_PATH")"
harness_count="$(jq '.harnesses | length' "$RAMP_PATH")"
sum_levels="$(jq '[.levels[]] | add' "$RAMP_PATH")"
max_level="$(jq '[.levels[]] | max' "$RAMP_PATH")"
theoretical_calls=$((harness_count * (sum_levels + (confirmation_runs - 1) * max_level)))

if (( theoretical_calls > MAX_TOTAL_MODEL_CALLS )); then
  printf 'Ramp can issue %d model calls, above CTXMILL_PERF_MAX_TOTAL_MODEL_CALLS=%d\n' \
    "$theoretical_calls" "$MAX_TOTAL_MODEL_CALLS" >&2
  exit 2
fi

umask 077
mkdir -p "$OUTPUT_ROOT"
: >"$OUTPUT_ROOT/waves.jsonl"

if [[ -z "${CTXMILL_API_TOKEN:-}" ]]; then
  token_base64="$(
    kubectl -n "$namespace" get secret ctxmill-core-secrets \
      -o jsonpath='{.data.CTXMILL_API_TOKEN}'
  )"
  export CTXMILL_API_TOKEN="$(printf '%s' "$token_base64" | base64 -d)"
fi

curl -fsS "$api_base/settings" \
  -H "Authorization: Bearer $CTXMILL_API_TOKEN" \
  >"$OUTPUT_ROOT/settings-before.json"
previous_limit="$(jq -r '.maxGlobalContainers' "$OUTPUT_ROOT/settings-before.json")"
limit_committed=0

set_limit() {
  local value="$1"
  jq -nc --argjson value "$value" '{maxGlobalContainers:$value}' \
    | curl -fsS -X PUT "$api_base/settings" \
      -H "Authorization: Bearer $CTXMILL_API_TOKEN" \
      -H 'Content-Type: application/json' \
      --data-binary @- >/dev/null
}

restore_limit() {
  if (( limit_committed == 0 )); then
    set_limit "$previous_limit" || true
  fi
  unset CTXMILL_API_TOKEN token_base64
}
trap restore_limit EXIT INT TERM

active_jobs="$(
  kubectl -n "$namespace" get jobs -o json \
    | jq '[.items[] | select(
      .metadata.labels["ctxmill.sandbox-session-id"] != null
      and ((.status.active // 0) > 0)
    )] | length'
)"
if (( active_jobs > 0 )); then
  printf 'Refusing to start with %d active sandbox jobs\n' "$active_jobs" >&2
  exit 1
fi

set_limit "$temporary_limit"
printf 'Temporary global sandbox ceiling: %d (previously %d)\n' \
  "$temporary_limit" "$previous_limit"
printf 'Worst-case model-call envelope: %d\n' "$theoretical_calls"

run_wave() {
  local concurrency="$1"
  local ordinal="$2"
  local phase="$3"
  local wave_name="c$(printf '%03d' "$concurrency")-r$(printf '%02d' "$ordinal")-$phase"
  local wave_dir="$OUTPUT_ROOT/$wave_name"
  local profile_path="$wave_dir/profile.json"
  mkdir -p "$wave_dir"
  "$BUN" "$ROOT_DIR/tests/performance/cli.ts" wave \
    --ramp "$RAMP_PATH" \
    --concurrency "$concurrency" \
    --ordinal "$ordinal" \
    --output "$profile_path"
  printf 'Running %s at concurrency %d\n' "$phase" "$concurrency"
  set +e
  CTXMILL_PERF_RAMP_PATH="$RAMP_PATH" \
    "$ROOT_DIR/tests/performance/scripts/run-dev2.sh" \
      "$profile_path" "$wave_dir"
  local status=$?
  set -e
  local decision="runner_failed"
  local violations='[]'
  if [[ -f "$wave_dir/capacity-decision.json" ]]; then
    decision="$(jq -r '.decision' "$wave_dir/capacity-decision.json")"
    violations="$(jq -c '.violations' "$wave_dir/capacity-decision.json")"
  fi
  jq -nc \
    --arg phase "$phase" \
    --argjson concurrency "$concurrency" \
    --argjson ordinal "$ordinal" \
    --argjson exitStatus "$status" \
    --arg decision "$decision" \
    --argjson violations "$violations" \
    --arg evidence "$wave_dir" \
    '$ARGS.named' >>"$OUTPUT_ROOT/waves.jsonl"
  return "$status"
}

highest_passed=0
stopped_at=0
while read -r concurrency; do
  if run_wave "$concurrency" 1 discovery; then
    highest_passed="$concurrency"
  else
    stopped_at="$concurrency"
    printf 'Discovery stopped at concurrency %d\n' "$concurrency"
    break
  fi
done < <(jq -r '.levels[]' "$RAMP_PATH")

if (( highest_passed == 0 )); then
  printf 'Concurrency one did not pass; preserving prior global limit %d\n' \
    "$previous_limit" >&2
  exit 1
fi

ordinal=2
while (( ordinal <= confirmation_runs )); do
  if ! run_wave "$highest_passed" "$ordinal" confirmation; then
    printf 'Confirmation failed at concurrency %d; preserving prior limit %d\n' \
      "$highest_passed" "$previous_limit" >&2
    exit 1
  fi
  ordinal=$((ordinal + 1))
done

set_limit "$highest_passed"
limit_committed=1
curl -fsS "$api_base/settings" \
  -H "Authorization: Bearer $CTXMILL_API_TOKEN" \
  >"$OUTPUT_ROOT/settings-after.json"

jq -s \
  --arg ramp "$(basename "$RAMP_PATH")" \
  --argjson previousGlobalContainers "$previous_limit" \
  --argjson temporaryGlobalContainers "$temporary_limit" \
  --argjson confirmedGlobalContainers "$highest_passed" \
  --argjson stoppedAt "$stopped_at" \
  --argjson theoreticalModelCalls "$theoretical_calls" \
  '{
    ramp: $ramp,
    previousGlobalContainers: $previousGlobalContainers,
    temporaryGlobalContainers: $temporaryGlobalContainers,
    confirmedGlobalContainers: $confirmedGlobalContainers,
    stoppedAt: (if $stoppedAt == 0 then null else $stoppedAt end),
    theoreticalModelCalls: $theoreticalModelCalls,
    waves: .
  }' "$OUTPUT_ROOT/waves.jsonl" >"$OUTPUT_ROOT/capacity-summary.json"

{
  printf '# CTXMILL dev2 adaptive capacity result\n\n'
  printf -- '- Previous global limit: %d\n' "$previous_limit"
  printf -- '- Temporary search ceiling: %d\n' "$temporary_limit"
  printf -- '- Confirmed and applied global limit: %d\n' "$highest_passed"
  if (( stopped_at > 0 )); then
    printf -- '- First rejected discovery wave: %d\n' "$stopped_at"
  else
    printf -- '- First rejected discovery wave: none (ceiling reached)\n'
  fi
  printf -- '- Worst-case planned model calls: %d\n' "$theoretical_calls"
  printf '\nSee waves.jsonl and each wave directory for raw turns, traces, '\
'Kubernetes samples, service logs, events, and gate decisions.\n'
} >"$OUTPUT_ROOT/capacity-summary.md"

unset CTXMILL_API_TOKEN token_base64
printf 'Confirmed dev2 global sandbox limit: %d\n' "$highest_passed"
printf 'Capacity evidence: %s\n' "$OUTPUT_ROOT"
