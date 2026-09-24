#!/usr/bin/env bash
# Build the bench-derived harness images from the current stock images.
set -euo pipefail
cd "$(dirname "$0")"
for h in langgraph claude-agents pi-agent; do
  docker build \
    --build-arg "BASE=stablehand/harness-${h}:latest" \
    -t "stablehand-bench/harness-${h}:latest" \
    -f images/Dockerfile images/
done
docker images | grep stablehand-bench
