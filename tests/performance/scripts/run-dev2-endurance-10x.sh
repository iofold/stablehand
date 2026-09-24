#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE_PATH="${1:-$ROOT_DIR/tests/performance/profiles/dev2-endurance-wave-c8.json}"
GATES_PATH="${STABLEHAND_PERF_GATES_PATH:-$ROOT_DIR/tests/performance/profiles/dev2-adaptive-capacity.json}"
RUN_SLUG="$(date -u +%Y%m%dT%H%M%SZ)-dev2-endurance-10x-c8"
OUTPUT_ROOT="${2:-$ROOT_DIR/.tmp/performance/$RUN_SLUG}"
BUN="${BUN:-bun}"
WAVES="${STABLEHAND_PERF_ENDURANCE_WAVES:-10}"
MAX_TOTAL_MODEL_CALLS="${STABLEHAND_PERF_MAX_TOTAL_MODEL_CALLS:-2630}"

if ! [[ "$WAVES" =~ ^[1-9][0-9]*$ ]]; then
  printf 'STABLEHAND_PERF_ENDURANCE_WAVES must be a positive integer\n' >&2
  exit 2
fi
if ! [[ "$MAX_TOTAL_MODEL_CALLS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'STABLEHAND_PERF_MAX_TOTAL_MODEL_CALLS must be a positive integer\n' >&2
  exit 2
fi

calls_per_wave="$($BUN "$ROOT_DIR/tests/performance/cli.ts" plan \
  --profile "$PROFILE_PATH" | jq -r '.plan.estimatedModelCalls')"
if ! [[ "$calls_per_wave" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Unable to determine the model-call envelope for %s\n' "$PROFILE_PATH" >&2
  exit 2
fi
theoretical_calls=$((calls_per_wave * WAVES))
if (( theoretical_calls > MAX_TOTAL_MODEL_CALLS )); then
  printf 'Endurance run can issue %d model calls, above STABLEHAND_PERF_MAX_TOTAL_MODEL_CALLS=%d\n' \
    "$theoretical_calls" "$MAX_TOTAL_MODEL_CALLS" >&2
  exit 2
fi

umask 077
mkdir -p "$OUTPUT_ROOT"
: >"$OUTPUT_ROOT/waves.jsonl"

write_summary() {
  local status="$1"
  jq -s \
    --arg profile "$(basename "$PROFILE_PATH")" \
    --arg status "$status" \
    --argjson requestedWaves "$WAVES" \
    --argjson callsPerWave "$calls_per_wave" \
    --argjson theoreticalModelCalls "$theoretical_calls" \
    '{
      profile: $profile,
      status: $status,
      requestedWaves: $requestedWaves,
      completedWaves: length,
      callsPerWave: $callsPerWave,
      theoreticalModelCalls: $theoreticalModelCalls,
      waves: .
    }' "$OUTPUT_ROOT/waves.jsonl" >"$OUTPUT_ROOT/endurance-summary.json"
}

printf 'Endurance waves: %d\n' "$WAVES"
printf 'Per-wave model-call ceiling: %d\n' "$calls_per_wave"
printf 'Total model-call ceiling: %d\n' "$theoretical_calls"

wave=1
while (( wave <= WAVES )); do
  wave_name="wave-$(printf '%02d' "$wave")"
  wave_dir="$OUTPUT_ROOT/$wave_name"
  mkdir -p "$wave_dir"
  cp "$PROFILE_PATH" "$wave_dir/profile.json"
  printf 'Running endurance %s of %d\n' "$wave_name" "$WAVES"

  set +e
  STABLEHAND_PERF_RAMP_PATH="$GATES_PATH" \
    "$ROOT_DIR/tests/performance/scripts/run-dev2.sh" \
      "$wave_dir/profile.json" "$wave_dir"
  wave_status=$?
  set -e

  decision="runner_failed"
  violations='[]'
  run_id=''
  if [[ -f "$wave_dir/capacity-decision.json" ]]; then
    decision="$(jq -r '.decision' "$wave_dir/capacity-decision.json")"
    violations="$(jq -c '.violations' "$wave_dir/capacity-decision.json")"
  fi
  if [[ -f "$wave_dir/run.json" ]]; then
    run_id="$(jq -r '.runId' "$wave_dir/run.json")"
  fi
  jq -nc \
    --arg wave "$wave_name" \
    --arg runId "$run_id" \
    --argjson exitStatus "$wave_status" \
    --arg decision "$decision" \
    --argjson violations "$violations" \
    --arg evidence "$wave_dir" \
    '$ARGS.named' >>"$OUTPUT_ROOT/waves.jsonl"

  if (( wave_status != 0 )) || [[ "$decision" != 'advance' ]]; then
    write_summary failed
    printf 'Endurance run stopped at %s; decision=%s violations=%s\n' \
      "$wave_name" "$decision" "$violations" >&2
    printf 'Endurance evidence: %s\n' "$OUTPUT_ROOT" >&2
    exit 1
  fi
  wave=$((wave + 1))
done

write_summary passed
printf 'Completed %d endurance waves within all correctness, telemetry, resource, and accounting gates\n' \
  "$WAVES"
printf 'Endurance evidence: %s\n' "$OUTPUT_ROOT"
