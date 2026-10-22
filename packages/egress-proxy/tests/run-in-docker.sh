#!/bin/sh
# Run every egress-proxy suite inside the proxy image, where mitmproxy is installed:
# policy unit tests, addon hook tests, and live checks against a real mitmdump started
# through the shipped entrypoint. No network: test hosts resolve through --add-host only.
#
#   packages/egress-proxy/tests/run-in-docker.sh
#   STABLEHAND_EGRESS_TEST_IMAGE=stablehand/egress:latest packages/egress-proxy/tests/run-in-docker.sh
set -eu
PACKAGE_DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE="${STABLEHAND_EGRESS_TEST_IMAGE:-stablehand/egress:test}"
if [ -z "${STABLEHAND_EGRESS_TEST_IMAGE:-}" ]; then
  docker build --quiet --tag "$IMAGE" "$PACKAGE_DIR" >/dev/null
fi
exec docker run --rm --network none \
  --add-host allowed.test:127.0.0.1 \
  --add-host denied.test:127.0.0.2 \
  --env STABLEHAND_EGRESS_LIVE=1 \
  --volume "$PACKAGE_DIR/tests:/opt/stablehand/tests:ro" \
  --entrypoint python3 \
  "$IMAGE" -m unittest discover --start-directory /opt/stablehand/tests --verbose
