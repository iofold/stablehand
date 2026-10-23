#!/bin/sh
# End-to-end check of per-session egress rules with real clients (ctx-3aef).
#
# Builds the egress image from this repo and starts it in a throwaway compose project with its
# own internal network, a stub orchestrator that answers lease checks, a stub upstream, and a
# client in a harness image that tries curl, git, Node fetch/https, Python requests/urllib and
# Chromium (Playwright) with deny, default and missing leases. Nothing is shared with a running
# Stablehand stack, and the project is removed on exit.
#
#   packages/egress-proxy/tests/integration/run.sh
#   STABLEHAND_EGRESS_IT_CLIENT_IMAGE=ghcr.io/iofold/stablehand-harness-langgraph:latest packages/egress-proxy/tests/integration/run.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PROJECT="${STABLEHAND_EGRESS_IT_PROJECT:-stablehand-egress-it-$$}"
COMPOSE="docker compose -p $PROJECT -f $HERE/docker-compose.yml"
PYLIB=$(mktemp -d)
LOGS=$(mktemp)

cleanup() {
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$PYLIB" "$LOGS"
}
trap cleanup EXIT INT TERM

# Python requests is not in the harness images; lend the client this host's pure-Python copy.
python3 - "$PYLIB" <<'PY'
import importlib.util, os, shutil, sys
for name in ("requests", "urllib3", "idna", "certifi", "charset_normalizer"):
    spec = importlib.util.find_spec(name)
    if spec is None or not spec.submodule_search_locations:
        print(f"note: {name} not found on this host; the requests checks will fail")
        continue
    source = list(spec.submodule_search_locations)[0]
    shutil.copytree(source, os.path.join(sys.argv[1], name), ignore=shutil.ignore_patterns("__pycache__", "*.so"))
PY
chmod -R a+rX "$PYLIB"
export STABLEHAND_EGRESS_IT_PYLIB="$PYLIB"

$COMPOSE build --quiet egress
set +e
$COMPOSE up --pull never --abort-on-container-exit --exit-code-from client > "$LOGS" 2>&1
status=$?
set -e
grep -E '^client-1 +\| (PASS|FAIL|failures=|  )' "$LOGS" | sed -E 's/^client-1 +\| //' || true

# The proxy's own record: denials carry the session, the agent and the rule source.
$COMPOSE logs --no-color --no-log-prefix egress > "$LOGS.egress" 2>&1 || true
if grep -q '"session":"sess-deny".*"source":"agent:deny".*"reason":"no_matching_rule"' "$LOGS.egress"; then
  echo "PASS proxy log: deny-mode denials name the session, agent and rule source"
else
  echo "FAIL proxy log: no deny-mode denial with session and source"
  status=1
fi
if grep -q '"reason":"lease_required"' "$LOGS.egress" && grep -q '"reason":"invalid_lease"' "$LOGS.egress"; then
  echo "PASS proxy log: missing and forged leases are logged"
else
  echo "FAIL proxy log: lease refusals missing"
  status=1
fi
if grep -q 'tok-deny\|tok-default\|forged' "$LOGS.egress"; then
  echo "FAIL proxy log: a lease token was logged"
  status=1
else
  echo "PASS proxy log: no lease token in the logs"
fi
if [ "$status" -ne 0 ]; then
  echo "--- compose output ---"
  cat "$LOGS"
  echo "--- egress log ---"
  cat "$LOGS.egress"
fi
rm -f "$LOGS.egress"
exit "$status"
