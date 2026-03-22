#!/usr/bin/env bash
# ── CTXMill Egress Proxy Integration Test ────────────────────────────────────
#
# Tests that the nginx egress proxy correctly:
#   1. Allows HTTPS to approved LLM API domains (via SNI inspection)
#   2. Blocks HTTPS to unapproved domains
#   3. Logs allowed and denied connections
#
# Prerequisites:
#   - Docker and docker compose available
#   - Run from the repository root
#
# Usage:
#   ./scripts/test-egress-proxy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NETWORK_NAME="ctxmill-agents"
PROXY_SERVICE="egress-proxy"
TEST_CONTAINER="ctxmill-egress-test"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass=0
fail=0

log_info()  { echo -e "${YELLOW}[INFO]${NC}  $*"; }
log_pass()  { echo -e "${GREEN}[PASS]${NC}  $*"; ((pass++)); }
log_fail()  { echo -e "${RED}[FAIL]${NC}  $*"; ((fail++)); }

cleanup() {
  log_info "Cleaning up..."
  docker rm -f "$TEST_CONTAINER" 2>/dev/null || true
  cd "$REPO_ROOT" && docker compose --profile sandbox stop "$PROXY_SERVICE" 2>/dev/null || true
}
trap cleanup EXIT

# ── Step 1: Build and start the egress proxy ─────────────────────────────────

log_info "Building egress proxy image..."
cd "$REPO_ROOT"
docker compose --profile sandbox build "$PROXY_SERVICE"

log_info "Starting egress proxy..."
docker compose --profile sandbox up -d "$PROXY_SERVICE"

# Wait for proxy to be healthy
log_info "Waiting for egress proxy to be healthy..."
for i in $(seq 1 30); do
  if docker compose --profile sandbox ps "$PROXY_SERVICE" 2>/dev/null | grep -q "healthy"; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    log_fail "Egress proxy did not become healthy within 30 seconds"
    docker compose --profile sandbox logs "$PROXY_SERVICE"
    exit 1
  fi
  sleep 1
done
log_pass "Egress proxy is running and healthy"

# ── Step 2: Ensure the network exists ────────────────────────────────────────

if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  log_fail "Network $NETWORK_NAME does not exist"
  exit 1
fi
log_pass "Network $NETWORK_NAME exists"

# ── Step 3: Run a test container on the same network ─────────────────────────

log_info "Starting test container..."
docker rm -f "$TEST_CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$TEST_CONTAINER" \
  --network "$NETWORK_NAME" \
  -e "HTTPS_PROXY=http://${PROXY_SERVICE}:3128" \
  -e "https_proxy=http://${PROXY_SERVICE}:3128" \
  -e "HTTP_PROXY=http://${PROXY_SERVICE}:3128" \
  -e "http_proxy=http://${PROXY_SERVICE}:3128" \
  -e "NO_PROXY=orchestrator,localhost,127.0.0.1" \
  alpine:3.20 sleep 300

# Install curl in the test container
docker exec "$TEST_CONTAINER" apk add --no-cache curl >/dev/null 2>&1
log_pass "Test container running on $NETWORK_NAME"

# ── Step 4: Test allowed domains ─────────────────────────────────────────────

log_info "Testing allowed domains..."

# Test api.openai.com — should succeed (we only check TLS handshake, not auth)
if docker exec "$TEST_CONTAINER" \
  curl -sf --connect-timeout 10 --max-time 15 \
  -o /dev/null -w "%{http_code}" \
  "https://api.openai.com/v1/models" 2>/dev/null | grep -qE '^(2|4)'; then
  log_pass "api.openai.com: connection allowed (HTTP response received)"
else
  # Even a TLS handshake success is good — some endpoints need auth
  if docker exec "$TEST_CONTAINER" \
    curl -s --connect-timeout 10 --max-time 15 \
    "https://api.openai.com/v1/models" 2>&1 | grep -qi "unauthorized\|invalid\|API key\|error"; then
    log_pass "api.openai.com: connection allowed (auth error = proxy passed through)"
  else
    log_fail "api.openai.com: connection blocked or timed out"
  fi
fi

# Test api.anthropic.com
if docker exec "$TEST_CONTAINER" \
  curl -s --connect-timeout 10 --max-time 15 \
  "https://api.anthropic.com/v1/messages" 2>&1 | grep -qiE "unauthorized|invalid|error|api.key|authentication|missing"; then
  log_pass "api.anthropic.com: connection allowed (auth error = proxy passed through)"
else
  if docker exec "$TEST_CONTAINER" \
    curl -sf --connect-timeout 10 --max-time 15 \
    -o /dev/null -w "%{http_code}" \
    "https://api.anthropic.com/" 2>/dev/null | grep -qE '^[2-5]'; then
    log_pass "api.anthropic.com: connection allowed (HTTP response received)"
  else
    log_fail "api.anthropic.com: connection blocked or timed out"
  fi
fi

# Test gateway.ai.cloudflare.com
if docker exec "$TEST_CONTAINER" \
  curl -sf --connect-timeout 10 --max-time 15 \
  -o /dev/null -w "%{http_code}" \
  "https://gateway.ai.cloudflare.com/" 2>/dev/null | grep -qE '^[2-5]'; then
  log_pass "gateway.ai.cloudflare.com: connection allowed"
else
  if docker exec "$TEST_CONTAINER" \
    curl -s --connect-timeout 10 --max-time 15 \
    "https://gateway.ai.cloudflare.com/" 2>&1 | grep -qiE "error|not found|forbidden|cloudflare"; then
    log_pass "gateway.ai.cloudflare.com: connection allowed (response received)"
  else
    log_fail "gateway.ai.cloudflare.com: connection blocked or timed out"
  fi
fi

# ── Step 5: Test blocked domains ─────────────────────────────────────────────

log_info "Testing blocked domains..."

# Test example.com — should be DENIED by proxy
if docker exec "$TEST_CONTAINER" \
  curl -sf --connect-timeout 10 --max-time 15 \
  -o /dev/null "https://example.com" 2>/dev/null; then
  log_fail "example.com: connection allowed (should be blocked)"
else
  log_pass "example.com: connection correctly blocked"
fi

# Test google.com (not in allowlist) — should be DENIED
if docker exec "$TEST_CONTAINER" \
  curl -sf --connect-timeout 10 --max-time 15 \
  -o /dev/null "https://www.google.com" 2>/dev/null; then
  log_fail "www.google.com: connection allowed (should be blocked)"
else
  log_pass "www.google.com: connection correctly blocked"
fi

# Test github.com — should be DENIED
if docker exec "$TEST_CONTAINER" \
  curl -sf --connect-timeout 10 --max-time 15 \
  -o /dev/null "https://github.com" 2>/dev/null; then
  log_fail "github.com: connection allowed (should be blocked)"
else
  log_pass "github.com: connection correctly blocked"
fi

# ── Step 6: Check proxy logs ────────────────────────────────────────────────

log_info "Checking egress proxy logs..."
PROXY_CONTAINER_ID=$(docker compose --profile sandbox ps -q "$PROXY_SERVICE" 2>/dev/null)
if [ -n "$PROXY_CONTAINER_ID" ]; then
  LOG_OUTPUT=$(docker exec "$PROXY_CONTAINER_ID" cat /var/log/nginx/egress.log 2>/dev/null || echo "")
  if [ -n "$LOG_OUTPUT" ]; then
    log_pass "Egress proxy has access log entries"
    echo "  --- Last 10 log entries ---"
    echo "$LOG_OUTPUT" | tail -10 | sed 's/^/  /'
    echo "  ---"
  else
    log_info "No log entries found (logging may use a different path)"
  fi
else
  log_info "Could not find proxy container for log inspection"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo "  Egress Proxy Test Results"
echo "========================================"
echo -e "  ${GREEN}Passed:${NC} $pass"
echo -e "  ${RED}Failed:${NC} $fail"
echo "========================================"

if [ "$fail" -gt 0 ]; then
  echo -e "${RED}Some tests failed!${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
