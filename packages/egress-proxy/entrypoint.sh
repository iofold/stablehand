#!/bin/sh
# Generate the per-deployment CA on first boot, publish only the public certificate to the
# read-only volume sandboxes mount, then run the proxy on two listeners: the open one, where a
# session lease is optional, and the lease one, where it is required (see the addon docstring).
set -eu
CONFDIR="${MITMPROXY_CONFDIR:-/home/mitmproxy/.mitmproxy}"
PUBLIC_DIR="${STABLEHAND_EGRESS_CA_PUBLIC_DIR:-/srv/egress-ca}"
mkdir -p "$CONFDIR" "$PUBLIC_DIR"
if [ ! -f "$CONFDIR/mitmproxy-ca-cert.pem" ]; then
  python3 - "$CONFDIR" <<'PY'
import sys
from pathlib import Path
from mitmproxy import certs
certs.CertStore.from_store(Path(sys.argv[1]), "mitmproxy", 2048)
PY
fi
cp "$CONFDIR/mitmproxy-ca-cert.pem" "$PUBLIC_DIR/egress-ca.pem"
chmod 0644 "$PUBLIC_DIR/egress-ca.pem"
exec mitmdump \
  --quiet \
  --set confdir="$CONFDIR" \
  --listen-host 0.0.0.0 \
  --mode "regular@${STABLEHAND_EGRESS_PORT:-8080}" \
  --mode "regular@${STABLEHAND_EGRESS_LEASE_PORT:-8081}" \
  --set block_global=false \
  --set connection_strategy=lazy \
  --set stream_large_bodies=1m \
  -s /opt/stablehand/addon/stablehand_egress.py \
  "$@"
