"""mitmproxy addon: the Stablehand sandbox egress broker (phase 1: boundary + allowlist).

Every sandbox reaches the internet only through this proxy. The addon enforces a
default-deny allowlist (see policy.py), refuses private and metadata destinations,
streams responses so provider SSE token streams are not buffered, and emits one JSON
line per decision on stdout for the orchestrator to collect.

Decisions are made on the destination mitmproxy will actually connect to, never on the
Host header alone:

* ``http_connect``: the CONNECT authority is the tunnel's destination; a Host header that
  names anything else is denied.
* ``requestheaders``: the request's destination (CONNECT authority inside a tunnel, the
  request-target authority for plain HTTP) is judged by method, host, port and path, and
  every Host header, the HTTP/2 :authority and the TLS SNI must agree with it. This runs
  before any upstream connection is opened or any body byte is forwarded, including for
  bodies mitmproxy streams.
* ``server_connect``: the last gate before a socket is opened. The host must still be
  allowed, its DNS answers must not be private (unless ``!internal``), and the connection
  is pinned to the vetted address so a second DNS answer cannot redirect it.
* Raw TCP and DNS tunnels are refused: the allowlist is an HTTP allowlist.

Configuration (environment):
  STABLEHAND_EGRESS_RULES        path to the rules file (default: bundled server defaults)
  STABLEHAND_EGRESS_EXTRA_ALLOW  extra rules, ';'-separated, appended after the file
  STABLEHAND_EGRESS_LOG_ALLOWED  '1' to log allowed requests too (denials are always logged)
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
import sys
import time
from typing import Awaitable, Callable, Optional

from mitmproxy import ctx, dns, http, tcp
from mitmproxy.proxy import server_hooks

sys.path.insert(0, os.path.dirname(__file__))
import policy  # noqa: E402

DENIED_HEADER = "X-Stablehand-Egress"
DEFAULT_RULES = os.path.join(os.path.dirname(__file__), "..", "rules.default.txt")
# A denied request whose body may be larger than this (declared, chunked, or already marked
# for streaming) is killed instead of answered with a 403. Answering makes mitmproxy buffer
# the whole body first, and mitmproxy cannot both answer a request and stream its body. An
# HTTP/2 body without Content-Length that grows past stream_large_bodies anyway makes
# mitmproxy abort that stream before it opens any upstream connection, so it fails closed.
INLINE_DENY_MAX_BODY = 64 * 1024

Resolver = Callable[[str, int], Awaitable[list[str]]]


def _load_rules() -> list[policy.Rule]:
    path = os.environ.get("STABLEHAND_EGRESS_RULES") or DEFAULT_RULES
    with open(path, encoding="utf-8") as handle:
        rules = policy.parse_rules(handle, path)
    extra = os.environ.get("STABLEHAND_EGRESS_EXTRA_ALLOW", "")
    if extra.strip():
        rules += policy.parse_rules(extra.split(";"), "STABLEHAND_EGRESS_EXTRA_ALLOW")
    return rules


async def _system_resolve(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    addresses: list[str] = []
    for info in infos:
        address = str(info[4][0])
        if address not in addresses:
            addresses.append(address)
    return addresses


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


def _emit(record: dict) -> None:
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **record}
    print(json.dumps(record, separators=(",", ":")), flush=True)


def _rule_label(decision: policy.Decision) -> Optional[str]:
    rule = decision.rule
    return f"{rule.source} {rule.method} {rule.host}{rule.path}" if rule else None


def _log(event: str, flow: http.HTTPFlow, decision: policy.Decision, session: Optional[str]) -> None:
    record = {
        "event": event,
        "session": session,
        "client": flow.client_conn.peername[0] if flow.client_conn.peername else None,
        "method": flow.request.method,
        # The real destination. What the client claimed is logged separately when it differs.
        "host": flow.request.host,
        "port": flow.request.port,
        "path": flow.request.path.split("?", 1)[0],
        "reason": decision.reason,
        "rule": _rule_label(decision),
    }
    if decision.reason in ("host_mismatch", "sni_mismatch"):
        record["host_header"] = flow.request.headers.get_all("Host") or None
        record["authority"] = flow.request.authority or None
        record["sni"] = flow.client_conn.sni
    _emit(record)


def _deny(flow: http.HTTPFlow, decision: policy.Decision) -> None:
    body = json.dumps({
        "error": "egress_denied",
        "reason": decision.reason,
        "method": flow.request.method,
        "host": flow.request.host,
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


def _body_may_be_large(flow: http.HTTPFlow) -> bool:
    if flow.request.stream:
        return True
    if flow.request.headers.get("Transfer-Encoding"):
        return True
    length = flow.request.headers.get("Content-Length")
    if length is None:
        return False
    try:
        return int(length) > INLINE_DENY_MAX_BODY
    except ValueError:
        return True


class StablehandEgress:
    def __init__(self, resolver: Optional[Resolver] = None) -> None:
        self.rules: list[policy.Rule] = []
        self.log_allowed = os.environ.get("STABLEHAND_EGRESS_LOG_ALLOWED", "0") == "1"
        self.resolve: Resolver = resolver or _system_resolve

    def load(self, loader) -> None:  # noqa: ARG002 - mitmproxy hook signature
        self.rules = _load_rules()

    def running(self) -> None:
        ctx.log.info(f"stablehand-egress: {len(self.rules)} rule(s) loaded; default deny")

    def http_connect(self, flow: http.HTTPFlow) -> None:
        """Refuse the tunnel when its real destination (the CONNECT authority) is not allowed."""
        decision = policy.evaluate_connect(
            self.rules, flow.request.host, flow.request.port, flow.request.headers.get_all("Host"),
        )
        if decision.allowed:
            return
        _log("egress.denied", flow, decision, _session_identity(flow))
        flow.response = http.Response.make(403, b"", {DENIED_HEADER: "denied"})

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        """Judge every request before mitmproxy opens an upstream connection or forwards a byte."""
        session = _session_identity(flow)
        # Never forward the sandbox's proxy identity to the upstream host.
        flow.request.headers.pop("Proxy-Authorization", None)
        decision = policy.evaluate_request(
            self.rules,
            flow.request.method,
            flow.request.host,
            flow.request.port,
            flow.request.path,
            host_headers=flow.request.headers.get_all("Host"),
            authority=flow.request.authority or None,
            sni=flow.client_conn.sni,
        )
        if decision.allowed:
            if self.log_allowed:
                _log("egress.allowed", flow, decision, session)
            return
        _log("egress.denied", flow, decision, session)
        if _body_may_be_large(flow):
            flow.kill()
        else:
            _deny(flow, decision)

    async def server_connect(self, data: server_hooks.ServerConnectionHookData) -> None:
        """Last gate before a socket opens: re-check the host, vet its DNS answers, pin the address."""
        server = data.server
        if server.address is None or server.via is not None:
            return
        host, port = server.address
        decision = policy.evaluate_destination(self.rules, host, port)
        pinned: Optional[str] = None
        if decision.allowed and policy.parse_ip_literal(host) is None:
            try:
                addresses = await self.resolve(host, port)
            except OSError:
                decision = policy.Decision(False, "unresolvable")
            else:
                decision = policy.evaluate_resolved(self.rules, host, port, addresses)
                if decision.allowed:
                    pinned = policy.pick_address(addresses)
        if not decision.allowed:
            server.error = f"egress denied: {decision.reason}"
            _emit({
                "event": "egress.denied",
                "session": None,
                "client": data.client.peername[0] if data.client.peername else None,
                "method": None,
                "host": host,
                "port": port,
                "path": None,
                "reason": decision.reason,
                "rule": _rule_label(decision),
            })
            return
        if pinned is not None:
            # Keep TLS SNI and certificate verification on the hostname while the socket goes
            # to the address that was just vetted.
            if server.sni is None:
                server.sni = host
            server.address = (pinned, port)

    def tcp_start(self, flow: tcp.TCPFlow) -> None:
        """Raw TCP inside an allowed tunnel would skip method and path checks entirely."""
        self._refuse_non_http(flow, "non_http_protocol")

    def dns_request(self, flow: dns.DNSFlow) -> None:
        """DNS over a tunnel to port 53 is a covert channel to any host a rule admits."""
        self._refuse_non_http(flow, "dns_tunnel")

    def _refuse_non_http(self, flow: tcp.TCPFlow | dns.DNSFlow, reason: str) -> None:
        server = flow.server_conn
        _emit({
            "event": "egress.denied",
            "session": None,
            "client": flow.client_conn.peername[0] if flow.client_conn.peername else None,
            "method": None,
            "host": server.address[0] if server.address else None,
            "port": server.address[1] if server.address else None,
            "path": None,
            "reason": reason,
            "rule": None,
        })
        if server.timestamp_start is None:
            # Not yet connected: an error on the server makes mitmproxy refuse to open it.
            server.error = f"egress denied: {reason}"
        if flow.killable:
            flow.kill()

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        # Stream every upstream body; buffering would stall provider SSE token streams.
        if flow.response is not None:
            flow.response.stream = True


addons = [StablehandEgress()]
