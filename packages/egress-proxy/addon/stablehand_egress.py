"""mitmproxy addon: the Stablehand sandbox egress broker (phase 1: boundary + allowlist).

Every sandbox reaches the internet only through this proxy. The addon enforces a
default-deny allowlist (see policy.py), refuses private and metadata destinations,
streams responses so provider SSE token streams are not buffered, and emits one JSON
line per decision on stdout for the orchestrator to collect.

Configuration (environment):
  STABLEHAND_EGRESS_RULES        path to the rules file (default: bundled server defaults)
  STABLEHAND_EGRESS_EXTRA_ALLOW  extra rules, ';'-separated, appended after the file
  STABLEHAND_EGRESS_LOG_ALLOWED  '1' to log allowed requests too (denials are always logged)
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
from typing import Optional

from mitmproxy import ctx, http

sys.path.insert(0, os.path.dirname(__file__))
import policy  # noqa: E402

DENIED_HEADER = "X-Stablehand-Egress"
DEFAULT_RULES = os.path.join(os.path.dirname(__file__), "..", "rules.default.txt")


def _load_rules() -> list[policy.Rule]:
    path = os.environ.get("STABLEHAND_EGRESS_RULES") or DEFAULT_RULES
    with open(path, encoding="utf-8") as handle:
        rules = policy.parse_rules(handle, path)
    extra = os.environ.get("STABLEHAND_EGRESS_EXTRA_ALLOW", "")
    if extra.strip():
        rules += policy.parse_rules(extra.split(";"), "STABLEHAND_EGRESS_EXTRA_ALLOW")
    return rules


def _session_identity(flow: http.HTTPFlow) -> Optional[str]:
    """Phase 1 records the session id a sandbox presents; phase 2 validates the lease."""
    header = flow.request.headers.get("Proxy-Authorization")
    if not header or not header.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
    except Exception:  # noqa: BLE001 - malformed header is just "unknown"
        return None
    return decoded.split(":", 1)[0] or None


def _log(event: str, flow: http.HTTPFlow, decision: policy.Decision, session: Optional[str]) -> None:
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event": event,
        "session": session,
        "client": flow.client_conn.peername[0] if flow.client_conn.peername else None,
        "method": flow.request.method,
        "host": flow.request.pretty_host,
        "port": flow.request.port,
        "path": flow.request.path.split("?", 1)[0],
        "reason": decision.reason,
        "rule": f"{decision.rule.source} {decision.rule.method} {decision.rule.host}{decision.rule.path}" if decision.rule else None,
    }
    print(json.dumps(record, separators=(",", ":")), flush=True)


def _deny(flow: http.HTTPFlow, decision: policy.Decision) -> None:
    body = json.dumps({
        "error": "egress_denied",
        "reason": decision.reason,
        "method": flow.request.method,
        "host": flow.request.pretty_host,
        "port": flow.request.port,
        "path": flow.request.path.split("?", 1)[0],
        "hint": "This sandbox may only reach hosts on its egress allowlist. "
                "Add a rule for this host to the agent's egress list if it is required.",
    })
    flow.response = http.Response.make(
        403,
        body.encode("utf-8"),
        {"Content-Type": "application/json", DENIED_HEADER: "denied"},
    )


class StablehandEgress:
    def __init__(self) -> None:
        self.rules: list[policy.Rule] = []
        self.log_allowed = os.environ.get("STABLEHAND_EGRESS_LOG_ALLOWED", "0") == "1"

    def load(self, loader) -> None:  # noqa: ARG002 - mitmproxy hook signature
        self.rules = _load_rules()

    def running(self) -> None:
        ctx.log.info(f"stablehand-egress: {len(self.rules)} rule(s) loaded; default deny")

    def http_connect(self, flow: http.HTTPFlow) -> None:
        """Refuse the tunnel outright when no rule could ever admit the host."""
        host, port = flow.request.pretty_host, flow.request.port
        if policy.host_could_match(self.rules, host, port):
            return
        decision = policy.Decision(False, "private_destination" if policy.is_private_destination(host) else "no_matching_rule")
        _log("egress.denied", flow, decision, _session_identity(flow))
        flow.response = http.Response.make(403, b"", {DENIED_HEADER: "denied"})

    def request(self, flow: http.HTTPFlow) -> None:
        session = _session_identity(flow)
        # Never forward the sandbox's proxy identity to the upstream host.
        flow.request.headers.pop("Proxy-Authorization", None)
        decision = policy.evaluate(
            self.rules, flow.request.method, flow.request.pretty_host, flow.request.port, flow.request.path,
        )
        if not decision.allowed:
            _log("egress.denied", flow, decision, session)
            _deny(flow, decision)
            return
        if self.log_allowed:
            _log("egress.allowed", flow, decision, session)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        # Stream every upstream body; buffering would stall provider SSE token streams.
        if flow.response is not None:
            flow.response.stream = True


addons = [StablehandEgress()]
