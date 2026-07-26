#!/usr/bin/env bash
set -euo pipefail

PHASE="${1:?usage: capture-dev2-operations.sh <before|after> <output-directory> [since-time]}"
OUTPUT_DIR="${2:?usage: capture-dev2-operations.sh <before|after> <output-directory> [since-time]}"
SINCE_TIME="${3:-}"
NAMESPACE="${CTXMILL_PERF_NAMESPACE:-ctxmill}"
API_BASE="${CTXMILL_PERF_API_BASE:-https://stablehand.staging.example.com/api}"
KUBECTL="${KUBECTL:-kubectl}"

if [[ "$PHASE" != "before" && "$PHASE" != "after" ]]; then
  printf 'phase must be before or after\n' >&2
  exit 2
fi

umask 077
mkdir -p "$OUTPUT_DIR"

"$KUBECTL" -n "$NAMESPACE" get pods -o json >"$OUTPUT_DIR/$PHASE-pods.json"
"$KUBECTL" -n "$NAMESPACE" get jobs -o json >"$OUTPUT_DIR/$PHASE-jobs.json"
"$KUBECTL" -n "$NAMESPACE" get deployments -o json >"$OUTPUT_DIR/$PHASE-deployments.json"
"$KUBECTL" -n "$NAMESPACE" get events -o json >"$OUTPUT_DIR/$PHASE-events.json"
"$KUBECTL" get nodes -o json >"$OUTPUT_DIR/$PHASE-nodes.json"
"$KUBECTL" top nodes >"$OUTPUT_DIR/$PHASE-node-top.txt" 2>&1 || true
"$KUBECTL" -n "$NAMESPACE" top pods --containers \
  >"$OUTPUT_DIR/$PHASE-pod-top.txt" 2>&1 || true
if "$KUBECTL" -n "$NAMESPACE" exec deployment/litellm -- \
  python -c '
import os
import urllib.request

master_key = os.environ["LITELLM_MASTER_KEY"]
request = urllib.request.Request(
    "http://127.0.0.1:4000/metrics",
    headers={"Authorization": "Bearer " + master_key},
)
response = urllib.request.urlopen(request, timeout=10)
print(response.read().decode(), end="")
' >"$OUTPUT_DIR/$PHASE-litellm-metrics.prom" 2>/dev/null; then
  printf '{"available":true,"endpoint":"/metrics"}\n' \
    >"$OUTPUT_DIR/$PHASE-litellm-metrics-status.json"
else
  rm -f "$OUTPUT_DIR/$PHASE-litellm-metrics.prom"
  printf '{"available":false,"endpoint":"/metrics","reason":"endpoint_unavailable"}\n' \
    >"$OUTPUT_DIR/$PHASE-litellm-metrics-status.json"
fi

if [[ -n "${CTXMILL_API_TOKEN:-}" ]]; then
  curl -fsS "$API_BASE/model-gateway/status" \
    -H "Authorization: Bearer $CTXMILL_API_TOKEN" \
    >"$OUTPUT_DIR/gateway-$PHASE.json" || \
    printf '{"state":"unavailable"}\n' >"$OUTPUT_DIR/gateway-$PHASE.json"
else
  printf '{"state":"unavailable"}\n' >"$OUTPUT_DIR/gateway-$PHASE.json"
fi

if [[ "$PHASE" == "before" ]]; then
  exit 0
fi
if [[ -z "$SINCE_TIME" ]]; then
  printf 'after capture requires an RFC3339 since-time\n' >&2
  exit 2
fi

for component in orchestrator litellm litellm-db postgres minio; do
  "$KUBECTL" -n "$NAMESPACE" logs \
    -l "app.kubernetes.io/name=$component" \
    --all-containers=true \
    --prefix=true \
    --since-time="$SINCE_TIME" \
    --max-log-requests=20 \
    >"$OUTPUT_DIR/$component.log" 2>&1 || true
done
"$KUBECTL" -n "$NAMESPACE" logs \
  -l 'app.kubernetes.io/name=ctxmill-sandbox' \
  --all-containers=true \
  --prefix=true \
  --since-time="$SINCE_TIME" \
  --max-log-requests=100 \
  >"$OUTPUT_DIR/sandbox.log" 2>&1 || true

if [[ -n "${CTXMILL_API_TOKEN:-}" ]]; then
  curl -fsS "$API_BASE/sandbox/metrics" \
    -H "Authorization: Bearer $CTXMILL_API_TOKEN" \
    >"$OUTPUT_DIR/sandbox-metrics-after.json" || \
    printf '{}\n' >"$OUTPUT_DIR/sandbox-metrics-after.json"
else
  printf '{}\n' >"$OUTPUT_DIR/sandbox-metrics-after.json"
fi

"$KUBECTL" -n "$NAMESPACE" exec deployment/litellm -- \
  python -c '
import json
import urllib.request

response = urllib.request.urlopen(
    "http://127.0.0.1:4000/health/liveliness",
    timeout=10,
)
print(json.dumps({"httpStatus": response.status}))
' >"$OUTPUT_DIR/litellm-health-after.json" 2>/dev/null || \
  printf '{"httpStatus":null}\n' >"$OUTPUT_DIR/litellm-health-after.json"
