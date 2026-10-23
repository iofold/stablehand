#!/bin/sh
# Sandbox side of the egress integration test. Runs in a harness image on the internal network,
# where the egress proxy is the only way out. Each check prints PASS or FAIL; exit 1 on any FAIL.
set -u
OPEN=http://egress:8080
LEASE=http://egress:8081
DENY=http://sess-deny:tok-deny@egress:8081
DEFAULT=http://sess-default:tok-default@egress:8081
ALLOW=http://sess-allow:tok-allow@egress:8081
FORGED=http://sess-deny:forged@egress:8081
failures=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then
    echo "PASS $1 ($3)"
  else
    echo "FAIL $1: expected '$2', got '$3'"
    failures=$((failures + 1))
  fi
}

contains() { # name needle haystack
  case "$3" in
    *"$2"*) echo "PASS $1" ;;
    *) echo "FAIL $1: '$2' not in: $3"; failures=$((failures + 1)) ;;
  esac
}

# A bare repository the stub upstream serves over dumb HTTP for the git checks.
rm -rf /tmp/work /srv/www/repo.git
git init -q -b main /tmp/work
git -C /tmp/work -c user.email=it@example.test -c user.name=it commit -q --allow-empty -m init
git clone -q --bare /tmp/work /srv/www/repo.git
git -C /srv/www/repo.git update-server-info

# ── curl ─────────────────────────────────────────────────────────────────────────────────
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 -x "$1" "$2"; }
connect_code() { curl -s -o /dev/null -w '%{http_connect}' --max-time 20 -x "$1" "$2"; }
check "curl: no lease on the open listener gets the server rules" 200 "$(code "$OPEN" https://git.example.test:8443/x)"
check "curl: no lease on the lease listener is challenged" 407 "$(connect_code "$LEASE" https://git.example.test:8443/x)"
check "curl: deny lease cannot reach a server default" 403 "$(connect_code "$DENY" https://git.example.test:8443/x)"
check "curl: deny lease reaches the runtime host" 200 "$(code "$DENY" https://model.example.test:8443/x)"
check "curl: default lease reaches the server default" 200 "$(code "$DEFAULT" https://git.example.test:8443/x)"
check "curl: forged lease is refused" 403 "$(connect_code "$FORGED" https://model.example.test:8443/x)"
check "curl: an agent rule cannot open a private destination" 502 "$(code "$ALLOW" https://other.example.test:8443/x)"
body=$(curl -s --max-time 20 -x "$DEFAULT" https://model.example.test:8443/x)
check "curl: upstream never sees the lease" "upstream:model.example.test:8443/x:pa=0" "$body"
denial=$(curl -s --max-time 20 -x "$DENY" http://git.example.test:8080/x)
contains "curl: plain-HTTP denial names its rule source" '"source": "agent:deny"' "$denial"

# ── git (only sends credentials after a 407, like Chromium) ──────────────────────────────
rm -rf /tmp/clone-*
HTTPS_PROXY=$DEFAULT git clone -q https://git.example.test:8443/repo.git /tmp/clone-default 2>/tmp/git-default.err
check "git: default lease clones through the lease listener" 0 "$?"
HTTPS_PROXY=$DENY git clone -q https://git.example.test:8443/repo.git /tmp/clone-deny 2>/tmp/git-deny.err
check "git: deny lease cannot clone" 128 "$?"
contains "git: deny reason is the proxy's 403" "403" "$(cat /tmp/git-deny.err)"
HTTPS_PROXY=$LEASE git clone -q https://git.example.test:8443/repo.git /tmp/clone-none 2>/tmp/git-none.err
check "git: no lease on the lease listener cannot clone" 128 "$?"

# ── Node (fetch and https via NODE_USE_ENV_PROXY) ────────────────────────────────────────
# A client that hangs on a refusal prints "hang" (not "error:"), so the check fails.
node_fetch() {
  HTTPS_PROXY=$1 NODE_USE_ENV_PROXY=1 NODE_NO_WARNINGS=1 node -e "
    setTimeout(() => { console.log('hang'); process.exit(0); }, 30000).unref();
    fetch('$2').then((r) => console.log(r.status)).catch((e) => console.log('error:' + (e.cause?.code ?? e.message)));"
}
node_https() {
  HTTPS_PROXY=$1 NODE_USE_ENV_PROXY=1 NODE_NO_WARNINGS=1 node -e "
    setTimeout(() => { console.log('hang'); process.exit(0); }, 30000).unref();
    require('https').get('$2', (r) => { console.log(r.statusCode); r.resume(); })
      .on('error', (e) => console.log('error:' + (e.code ?? e.message)));"
}
check "node fetch: default lease" 200 "$(node_fetch "$DEFAULT" https://git.example.test:8443/x)"
contains "node fetch: deny lease is refused" "error:" "$(node_fetch "$DENY" https://git.example.test:8443/x)"
check "node fetch: deny lease reaches the runtime host" 200 "$(node_fetch "$DENY" https://model.example.test:8443/x)"
check "node https: default lease" 200 "$(node_https "$DEFAULT" https://git.example.test:8443/x)"
contains "node https: deny lease is refused" "error:" "$(node_https "$DENY" https://git.example.test:8443/x)"

# ── Python (requests and urllib) ─────────────────────────────────────────────────────────
python_result=$(python3 /it/client_python.py "$DEFAULT" "$DENY")
echo "$python_result" | sed 's/^/  /'
if [ -z "$python_result" ] || printf '%s\n' "$python_result" | grep -q '^FAIL'; then
  failures=$((failures + 1))
fi

# ── Chromium through Playwright, as the browse tool launches it ──────────────────────────
db=sql:$HOME/.pki/nssdb
mkdir -p "$HOME/.pki/nssdb"
certutil -d "$db" -N --empty-password 2>/dev/null || true
certutil -d "$db" -A -t C,, -n stablehand-egress -i "$STABLEHAND_EGRESS_CA"
browser_result=$(cd /app && node client_browser.mjs "$DEFAULT" "$DENY" 2>&1)
echo "$browser_result" | sed 's/^/  /'
# Match whole FAIL lines: Chromium's own errors (ERR_TUNNEL_CONNECTION_FAILED) contain "FAIL".
if [ -z "$browser_result" ] || printf '%s\n' "$browser_result" | grep -q '^FAIL'; then
  failures=$((failures + 1))
fi

echo "failures=$failures"
[ "$failures" -eq 0 ]
