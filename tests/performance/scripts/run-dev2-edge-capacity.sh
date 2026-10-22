#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RAMP_PATH="${1:-$ROOT_DIR/tests/performance/profiles/dev2-edge-capacity-mixed.json}"
RUN_SLUG="$(date -u +%Y%m%dT%H%M%SZ)-$(basename "$RAMP_PATH" .json)"
OUTPUT_ROOT="${2:-$ROOT_DIR/.tmp/performance/$RUN_SLUG}"
BUN="${BUN:-bun}"
MAX_TOTAL_MODEL_CALLS="${STABLEHAND_PERF_MAX_TOTAL_MODEL_CALLS:-500}"
BOUNDARY_TIMEOUT_SECONDS="${STABLEHAND_PERF_BOUNDARY_TIMEOUT_SECONDS:-360}"

export KUBECONFIG="${KUBECONFIG:-$HOME/workspace/infra/.k3s-kubeconfig.yaml}"
namespace="$(jq -r '.target.kubernetesNamespace' "$RAMP_PATH")"
api_base="${STABLEHAND_PERF_API_BASE:-$(jq -r '.target.apiBase' "$RAMP_PATH")}"
temporary_limit="$(jq -r '.maxGlobalContainers' "$RAMP_PATH")"
harness_count="$(jq '.harnesses | length' "$RAMP_PATH")"
sum_levels="$(jq '[.levels[]] | add' "$RAMP_PATH")"
theoretical_calls=$((harness_count * sum_levels))

if (( theoretical_calls > MAX_TOTAL_MODEL_CALLS )); then
  printf 'Ramp can issue %d model calls, above STABLEHAND_PERF_MAX_TOTAL_MODEL_CALLS=%d\n' \
    "$theoretical_calls" "$MAX_TOTAL_MODEL_CALLS" >&2
  exit 2
fi

umask 077
mkdir -p "$OUTPUT_ROOT"
: >"$OUTPUT_ROOT/waves.jsonl"

if [[ -z "${STABLEHAND_API_TOKEN:-}" ]]; then
  token_base64="$(
    kubectl -n "$namespace" get secret stablehand-core-secrets \
      -o jsonpath='{.data.STABLEHAND_API_TOKEN}'
  )"
  export STABLEHAND_API_TOKEN="$(printf '%s' "$token_base64" | base64 -d)"
fi

curl -fsS "$api_base/settings" \
  -H "Authorization: Bearer $STABLEHAND_API_TOKEN" \
  >"$OUTPUT_ROOT/settings-before.json"
previous_limit="$(jq -r '.maxGlobalContainers' "$OUTPUT_ROOT/settings-before.json")"
limit_restored=0

set_limit() {
  local value="$1"
  jq -nc --argjson value "$value" '{maxGlobalContainers:$value}' \
    | curl -fsS -X PUT "$api_base/settings" \
      -H "Authorization: Bearer $STABLEHAND_API_TOKEN" \
      -H 'Content-Type: application/json' \
      --data-binary @- >/dev/null
}

restore_limit() {
  local status=$?
  trap - EXIT INT TERM
  if (( limit_restored == 0 )); then
    set_limit "$previous_limit" || true
  fi
  unset STABLEHAND_API_TOKEN token_base64 || true
  return "$status"
}
trap restore_limit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ensure_clean_boundary() {
  local evidence_dir="$1"
  local phase="$2"
  local deadline=$((SECONDS + BOUNDARY_TIMEOUT_SECONDS))
  mkdir -p "$evidence_dir"
  : >"$evidence_dir/cleanup-$phase.jsonl"
  while (( SECONDS < deadline )); do
    local cleanup_result
    cleanup_result="$(
      "$BUN" "$ROOT_DIR/tests/performance/cli.ts" cleanup \
        --api-base "$api_base" --timeout-ms 60000
    )" || return 1
    local active_jobs
    active_jobs="$(
      kubectl -n "$namespace" get jobs -o json \
        | jq '[.items[] | select(
          .metadata.labels["stablehand.sandbox-session-id"] != null
          and ((.status.active // 0) > 0)
        )] | length'
    )"
    local sandbox_metrics
    sandbox_metrics="$(
      curl -fsS "$api_base/sandbox/metrics" \
        -H "Authorization: Bearer $STABLEHAND_API_TOKEN"
    )" || return 1
    local active_containers queued_containers killed_sessions
    active_containers="$(jq -r '.containers.active // -1' <<<"$sandbox_metrics")"
    queued_containers="$(jq -r '.containers.queued // -1' <<<"$sandbox_metrics")"
    killed_sessions="$(jq -r '.killedSessions // -1' <<<"$cleanup_result")"
    jq -nc \
      --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
      --argjson activeJobs "$active_jobs" \
      --argjson activeContainers "$active_containers" \
      --argjson queuedContainers "$queued_containers" \
      --argjson killedSessions "$killed_sessions" \
      '$ARGS.named' >>"$evidence_dir/cleanup-$phase.jsonl"
    if (( active_jobs == 0 \
      && active_containers == 0 \
      && queued_containers == 0 \
      && killed_sessions == 0 )); then
      return 0
    fi
    sleep 2
  done
  printf 'Sandbox boundary did not become clean within %ds (%s)\n' \
    "$BOUNDARY_TIMEOUT_SECONDS" "$phase" >&2
  return 1
}

core_services_healthy() {
  local node_failures deployment_failures
  node_failures="$(
    kubectl get nodes -o json \
      | jq '[.items[] | select(
        ([.status.conditions[] | select(.type == "Ready") | .status][0] // "False")
        != "True"
      )] | length'
  )" || return 1
  deployment_failures="$(
    kubectl -n "$namespace" get deployments -o json \
      | jq '[.items[] | select(
        (.spec.replicas // 0) > (.status.availableReplicas // 0)
      )] | length'
  )" || return 1
  (( node_failures == 0 && deployment_failures == 0 ))
}

ensure_clean_boundary "$OUTPUT_ROOT" preflight
if ! core_services_healthy; then
  printf 'Dev2 core services are not healthy at the preflight boundary\n' >&2
  exit 1
fi

set_limit "$temporary_limit"
printf 'Temporary exploratory sandbox ceiling: %d (previously %d)\n' \
  "$temporary_limit" "$previous_limit"
printf 'Exploratory model-call envelope: %d\n' "$theoretical_calls"

stopped_at=0
completed_levels=0
while read -r concurrency; do
  wave_name="c$(printf '%03d' "$concurrency")-r01-exploration"
  wave_dir="$OUTPUT_ROOT/$wave_name"
  profile_path="$wave_dir/profile.json"
  mkdir -p "$wave_dir"
  ensure_clean_boundary "$wave_dir" before
  "$BUN" "$ROOT_DIR/tests/performance/cli.ts" wave \
    --ramp "$RAMP_PATH" \
    --concurrency "$concurrency" \
    --ordinal 1 \
    --output "$profile_path"
  printf 'Exploring concurrency %d\n' "$concurrency"

  set +e
  STABLEHAND_PERF_RAMP_PATH="$RAMP_PATH" \
    "$ROOT_DIR/tests/performance/scripts/run-dev2.sh" \
      "$profile_path" "$wave_dir"
  runner_status=$?
  set -e

  hard_violations='[]'
  if ! ensure_clean_boundary "$wave_dir" after; then
    hard_violations="$(jq -nc '["sandbox cleanup boundary did not settle"]')"
  fi
  if ! core_services_healthy; then
    hard_violations="$(jq -c '. + ["node or core deployment became unhealthy"]' \
      <<<"$hard_violations")"
  fi
  if [[ -f "$wave_dir/capacity-observation.json" ]]; then
    if (( $(jq -r '.oomKilledContainers // 0' "$wave_dir/capacity-observation.json") > 0 )); then
      hard_violations="$(jq -c '. + ["sandbox or service container was OOM-killed"]' \
        <<<"$hard_violations")"
    fi
    if (( $(jq -r '.podRestartDelta // 0' "$wave_dir/capacity-observation.json") > 0 )); then
      hard_violations="$(jq -c '. + ["service pod restart count increased"]' \
        <<<"$hard_violations")"
    fi
  fi

  certification_decision="unavailable"
  soft_violations='[]'
  if [[ -f "$wave_dir/capacity-decision.json" ]]; then
    certification_decision="$(jq -r '.decision' "$wave_dir/capacity-decision.json")"
    soft_violations="$(jq -c '.violations' "$wave_dir/capacity-decision.json")"
  elif [[ -f "$wave_dir/failure.json" ]]; then
    soft_violations="$(jq -c '[.error]' "$wave_dir/failure.json")"
  fi

  exploration_decision=continue
  if (( $(jq 'length' <<<"$hard_violations") > 0 )); then
    exploration_decision=stop
    stopped_at="$concurrency"
  fi
  jq -nc \
    --argjson concurrency "$concurrency" \
    --argjson exitStatus "$runner_status" \
    --arg certificationDecision "$certification_decision" \
    --arg explorationDecision "$exploration_decision" \
    --argjson softViolations "$soft_violations" \
    --argjson hardViolations "$hard_violations" \
    --arg evidence "$wave_dir" \
    '$ARGS.named' >>"$OUTPUT_ROOT/waves.jsonl"
  completed_levels=$((completed_levels + 1))

  if [[ "$exploration_decision" == stop ]]; then
    printf 'Hard safety stop at concurrency %d\n' "$concurrency" >&2
    break
  fi
done < <(jq -r '.levels[]' "$RAMP_PATH")

set_limit "$previous_limit"
limit_restored=1
curl -fsS "$api_base/settings" \
  -H "Authorization: Bearer $STABLEHAND_API_TOKEN" \
  >"$OUTPUT_ROOT/settings-after.json"

jq -s \
  --arg ramp "$(basename "$RAMP_PATH")" \
  --argjson previousGlobalContainers "$previous_limit" \
  --argjson temporaryGlobalContainers "$temporary_limit" \
  --argjson completedLevels "$completed_levels" \
  --argjson stoppedAt "$stopped_at" \
  --argjson theoreticalModelCalls "$theoretical_calls" \
  '{
    ramp: $ramp,
    previousGlobalContainers: $previousGlobalContainers,
    temporaryGlobalContainers: $temporaryGlobalContainers,
    restoredGlobalContainers: $previousGlobalContainers,
    completedLevels: $completedLevels,
    stoppedAt: (if $stoppedAt == 0 then null else $stoppedAt end),
    theoreticalModelCalls: $theoreticalModelCalls,
    waves: .
  }' "$OUTPUT_ROOT/waves.jsonl" >"$OUTPUT_ROOT/edge-capacity-summary.json"

unset STABLEHAND_API_TOKEN token_base64
printf 'Restored dev2 global sandbox limit: %d\n' "$previous_limit"
printf 'Edge-capacity evidence: %s\n' "$OUTPUT_ROOT"

if (( stopped_at > 0 )); then
  exit 1
fi
