#!/usr/bin/env bash
set -euo pipefail

OUTPUT_PATH="${1:?usage: sample-dev2-kubernetes.sh <output.jsonl>}"
NAMESPACE="${STABLEHAND_PERF_NAMESPACE:-stablehand}"
INTERVAL_SECONDS="${STABLEHAND_PERF_SAMPLE_INTERVAL_SECONDS:-2}"
MAX_CPU_PERCENT="${STABLEHAND_PERF_MAX_NODE_CPU_PERCENT:-75}"
MAX_MEMORY_PERCENT="${STABLEHAND_PERF_MAX_NODE_MEMORY_PERCENT:-75}"
MAX_PENDING_SANDBOX_PODS="${STABLEHAND_PERF_MAX_PENDING_SANDBOX_PODS:-0}"
PENDING_GRACE_SECONDS="${STABLEHAND_PERF_PENDING_POD_GRACE_SECONDS:-30}"
ABORT_FILE="${STABLEHAND_PERF_ABORT_FILE:-}"
KUBECTL="${KUBECTL:-kubectl}"

mkdir -p "$(dirname "$OUTPUT_PATH")"
touch "$OUTPUT_PATH"

empty_items='{"items":[]}'
pending_started_epoch=0

while true; do
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  nodes="$($KUBECTL get nodes -o json 2>/dev/null || printf '%s' "$empty_items")"
  node_metrics="$($KUBECTL get --raw /apis/metrics.k8s.io/v1beta1/nodes 2>/dev/null || printf '%s' "$empty_items")"
  pods="$($KUBECTL -n "$NAMESPACE" get pods -o json 2>/dev/null || printf '%s' "$empty_items")"
  pod_metrics="$($KUBECTL get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/$NAMESPACE/pods" 2>/dev/null || printf '%s' "$empty_items")"
  jobs="$($KUBECTL -n "$NAMESPACE" get jobs -o json 2>/dev/null || printf '%s' "$empty_items")"

  node_allocatable="$(jq -c '[.items[] | {
    name: .metadata.name,
    cpu: .status.allocatable.cpu,
    memory: .status.allocatable.memory
  }]' <<<"$nodes")"
  normalized_node_metrics="$(jq -c '[.items[] | {
    name: .metadata.name,
    cpu: .usage.cpu,
    memory: .usage.memory
  }]' <<<"$node_metrics")"
  pod_inventory="$(jq -c '[.items[] | {
    name: .metadata.name,
    labels: (.metadata.labels // {}),
    phase: .status.phase
  }]' <<<"$pods")"
  metrics_server_pod_metrics="$(jq -c \
    --argjson inventory "$pod_inventory" \
    '[.items[] | . as $metric | {
      name: .metadata.name,
      labels: (
        [$inventory[] | select(.name == $metric.metadata.name) | .labels][0] // {}
      ),
      containers: [.containers[] | {
        name: .name,
        cpu: .usage.cpu,
        memory: .usage.memory
      }]
    }]' <<<"$pod_metrics")"
  pod_metrics_source='metrics-server'
  normalized_pod_metrics="$metrics_server_pod_metrics"
  node_name="$(jq -r '.items[0].metadata.name // empty' <<<"$nodes")"
  if [[ -n "$node_name" ]]; then
    kubelet_stats="$($KUBECTL get --raw "/api/v1/nodes/$node_name/proxy/stats/summary" 2>/dev/null || true)"
    if [[ -n "$kubelet_stats" ]] && jq -e '.pods | type == "array"' \
      >/dev/null 2>&1 <<<"$kubelet_stats"; then
      normalized_pod_metrics="$(jq -c \
        --arg namespace "$NAMESPACE" \
        --argjson inventory "$pod_inventory" \
        '[.pods[] | select(.podRef.namespace == $namespace) | . as $metric | {
          name: .podRef.name,
          labels: (
            [$inventory[] | select(.name == $metric.podRef.name) | .labels][0] // {}
          ),
          containers: [(.containers // [])[] | {
            name: .name,
            cpu: (((.cpu.usageNanoCores // 0) | tostring) + "n"),
            memory: ((.memory.workingSetBytes // 0) | tostring)
          }]
        }]' <<<"$kubelet_stats")"
      pod_metrics_source='kubelet-summary'
    fi
  fi
  if ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$normalized_pod_metrics"; then
    normalized_pod_metrics='[]'
    pod_metrics_source='unavailable'
  fi
  running_sandbox_pods="$(jq \
    '[.[] | select(
      .phase == "Running"
      and .labels["stablehand.sandbox-session-id"] != null
    )] | length' <<<"$pod_inventory")"
  pending_sandbox_pods="$(jq \
    '[.[] | select(
      .phase == "Pending"
      and .labels["stablehand.sandbox-session-id"] != null
    )] | length' <<<"$pod_inventory")"
  active_sandbox_jobs="$(jq \
    '[.items[] | select(
      .metadata.labels["stablehand.sandbox-session-id"] != null
      and ((.status.active // 0) > 0)
    )] | length' <<<"$jobs")"
  pending_sandbox_pods_after_grace=0
  now_epoch="$(date +%s)"
  if (( pending_sandbox_pods > 0 )); then
    if (( pending_started_epoch == 0 )); then
      pending_started_epoch="$now_epoch"
    fi
    if (( now_epoch - pending_started_epoch >= PENDING_GRACE_SECONDS )); then
      pending_sandbox_pods_after_grace="$pending_sandbox_pods"
    fi
  else
    pending_started_epoch=0
  fi

  jq -nc \
    --arg timestamp "$timestamp" \
    --argjson nodeAllocatable "$node_allocatable" \
    --argjson nodeMetrics "$normalized_node_metrics" \
    --argjson podMetrics "$normalized_pod_metrics" \
    --arg podMetricsSource "$pod_metrics_source" \
    --argjson runningSandboxPods "$running_sandbox_pods" \
    --argjson pendingSandboxPods "$pending_sandbox_pods" \
    --argjson pendingSandboxPodsAfterGrace "$pending_sandbox_pods_after_grace" \
    --argjson activeSandboxJobs "$active_sandbox_jobs" \
    '$ARGS.named' >>"$OUTPUT_PATH"

  if [[ -n "$ABORT_FILE" ]]; then
    if (( pending_sandbox_pods_after_grace > MAX_PENDING_SANDBOX_PODS )); then
      printf 'Pending sandbox pods %d exceeded safety ceiling %d after %ds grace\n' \
        "$pending_sandbox_pods_after_grace" "$MAX_PENDING_SANDBOX_PODS" \
        "$PENDING_GRACE_SECONDS" >"$ABORT_FILE"
    fi
    while read -r node _cpu cpu_percent _memory memory_percent; do
      cpu_percent="${cpu_percent%\%}"
      memory_percent="${memory_percent%\%}"
      if [[ "$cpu_percent" =~ ^[0-9]+$ ]] && (( cpu_percent > MAX_CPU_PERCENT )); then
        printf 'Node %s CPU %s%% exceeded safety ceiling %s%%\n' \
          "$node" "$cpu_percent" "$MAX_CPU_PERCENT" >"$ABORT_FILE"
      fi
      if [[ "$memory_percent" =~ ^[0-9]+$ ]] && (( memory_percent > MAX_MEMORY_PERCENT )); then
        printf 'Node %s memory %s%% exceeded safety ceiling %s%%\n' \
          "$node" "$memory_percent" "$MAX_MEMORY_PERCENT" >"$ABORT_FILE"
      fi
    done < <($KUBECTL top nodes --no-headers 2>/dev/null || true)
  fi

  sleep "$INTERVAL_SECONDS"
done
