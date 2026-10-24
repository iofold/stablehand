"""mitmproxy addon: the Stablehand sandbox egress broker (boundary, allowlist, per-session rules).

Every sandbox reaches the internet only through this proxy. The addon enforces a
default-deny allowlist (see policy.py), refuses private and metadata destinations,
streams responses so provider SSE token streams are not buffered, and emits one JSON
line per decision on stdout for the orchestrator to collect.

Which rules apply depends on who is asking (see lease.py). A sandbox presents its session
lease as proxy credentials; the proxy checks it with the orchestrator and judges the request
by that session's rules (the agent's egress setting). A tunnel is identified once, at CONNECT,
and every request inside it inherits that identity. Two listeners:

* the open listener (``STABLEHAND_EGRESS_PORT``, 8080): a lease is optional. Requests without
  one get the server rules while ``STABLEHAND_EGRESS_UNLEASED=global`` (the default, so
  sandboxes started before leases existed keep working) and ``407`` once it is ``deny``.
* the lease listener (``STABLEHAND_EGRESS_LEASE_PORT``, 8081): a lease is required. A request
  without one gets ``407 Proxy Authentication Required``, which is also what makes clients that
  only send credentials when challenged (git, Chromium) send them.

A lease that is malformed, unknown or for an ended session is refused (``403``); a lease the
orchestrator cannot currently confirm is refused with ``503``. Neither ever falls back to looser
rules.

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
  STABLEHAND_EGRESS_RULES          server defaults file (default: bundled rules.default.txt)
  STABLEHAND_EGRESS_EXTRA_ALLOW    extra server defaults, ';'-separated, appended after the file
  STABLEHAND_EGRESS_RUNTIME_RULES  runtime rules file, kept even for deny agents
                                   (default: bundled rules.runtime.txt)
  STABLEHAND_EGRESS_RUNTIME_ALLOW  extra runtime rules, ';'-separated
  STABLEHAND_EGRESS_LEASE_URL      orchestrator endpoint that checks leases
                                   (default: http://orchestrator:3001/api/egress/lease)
  STABLEHAND_EGRESS_PORT           open listener port (default 8080)
  STABLEHAND_EGRESS_LEASE_PORT     lease listener port (default 8081)
  STABLEHAND_EGRESS_UNLEASED       'global' (default) or 'deny': what the open listener does
                                   with requests that carry no lease
  STABLEHAND_EGRESS_LOG_ALLOWED    '1' to log allowed requests too (denials are always logged)
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import time
import weakref
from typing import Awaitable, Callable, MutableMapping, Optional

from mitmproxy import connection, ctx, dns, http, tcp
from mitmproxy.proxy import server_hooks

sys.path.insert(0, os.path.dirname(__file__))
import lease  # noqa: E402
import policy  # noqa: E402

DENIED_HEADER = "X-Stablehand-Egress"
PROXY_REALM = 'Basic realm="stablehand-egress"'
DEFAULT_RULES = os.path.join(os.path.dirname(__file__), "..", "rules.default.txt")
DEFAULT_RUNTIME_RULES = os.path.join(os.path.dirname(__file__), "..", "rules.runtime.txt")
DEFAULT_LEASE_URL = "http://orchestrator:3001/api/egress/lease"
DEFAULT_PORT = 8080
DEFAULT_LEASE_PORT = 8081
# A denied request whose body may be larger than this (declared, chunked, or already marked
# for streaming) is killed instead of answered with a 403. Answering makes mitmproxy buffer
# the whole body first, and mitmproxy cannot both answer a request and stream its body. An
# HTTP/2 body without Content-Length that grows past stream_large_bodies anyway makes
# mitmproxy abort that stream before it opens any upstream connection, so it fails closed.
INLINE_DENY_MAX_BODY = 64 * 1024

HINTS = {
    "server": "This sandbox may only reach hosts on the server's egress allowlist.",
    "agent:default": "This sandbox may only reach hosts on the server's egress allowlist. "
                     "Set the agent's egress to allow with a rule for this host if it is required.",
    "agent:allow": "This sandbox may only reach hosts on the server's egress allowlist and the "
                   "agent's own egress rules. Add a rule for this host to the agent's egress "
                   "rules if it is required.",
    "agent:deny": "This agent's egress is set to deny: only the model provider and the services "
                  "the runtime needs are reachable.",
}
REFUSAL_HINTS = {
    "lease_required": "This proxy only serves requests that carry the sandbox's session lease. "
                      "Use the proxy URL from the sandbox environment, credentials included.",
    "invalid_lease": "The session lease in the proxy credentials is not valid, or its session "
                     "has ended.",
    "invalid_policy": "The agent's egress setting could not be applied, so nothing is allowed.",
    "lease_unverifiable": "The proxy could not confirm this sandbox's session right now. "
                          "Retry shortly.",
}

Resolver = Callable[[str, int], Awaitable[list[str]]]


def _env_rules(name: str, source: str) -> list[policy.Rule]:
    extra = os.environ.get(name, "")
    return policy.parse_rules(extra.split(";"), source) if extra.strip() else []


def _file_rules(path: str) -> list[policy.Rule]:
    with open(path, encoding="utf-8") as handle:
        return policy.parse_rules(handle, path)


def _load_rule_sets() -> lease.RuleSets:
    runtime = _file_rules(os.environ.get("STABLEHAND_EGRESS_RUNTIME_RULES") or DEFAULT_RUNTIME_RULES)
    runtime += _env_rules("STABLEHAND_EGRESS_RUNTIME_ALLOW", "STABLEHAND_EGRESS_RUNTIME_ALLOW")
    defaults = _file_rules(os.environ.get("STABLEHAND_EGRESS_RULES") or DEFAULT_RULES)
    defaults += _env_rules("STABLEHAND_EGRESS_EXTRA_ALLOW", "STABLEHAND_EGRESS_EXTRA_ALLOW")
    return lease.RuleSets(tuple(runtime), tuple(defaults))


def _port_setting(name: str, default: int) -> int:
    value = os.environ.get(name, "").strip()
    return int(value) if value else default


async def _system_resolve(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    addresses: list[str] = []
    for info in infos:
        address = str(info[4][0])
        if address not in addresses:
            addresses.append(address)
    return addresses


def _emit(record: dict) -> None:
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **record}
    print(json.dumps(record, separators=(",", ":")), flush=True)


def _rule_label(decision: policy.Decision) -> Optional[str]:
    rule = decision.rule
    return f"{rule.source} {rule.method} {rule.host}{rule.path}" if rule else None


def _peer(client: connection.Client) -> Optional[str]:
    return client.peername[0] if client.peername else None


def _log(event: str, flow: http.HTTPFlow, decision: policy.Decision, who: lease.SessionPolicy) -> None:
    record = {
        "event": event,
        "session": who.session_id,
        "agent": who.agent_id,
        "source": who.source,
        "client": _peer(flow.client_conn),
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


def _log_refusal(flow: http.HTTPFlow, refusal: lease.Refusal) -> None:
    _emit({
        "event": "egress.denied",
        "session": refusal.session_id,
        "agent": None,
        "source": None,
        "client": _peer(flow.client_conn),
        "method": flow.request.method,
        "host": flow.request.host,
        "port": flow.request.port,
        "path": flow.request.path.split("?", 1)[0] if flow.request.method != "CONNECT" else None,
        "reason": refusal.reason,
        "detail": refusal.detail,
        "rule": None,
    })


def _denial_body(flow: http.HTTPFlow, reason: str, source: Optional[str], hint: str) -> bytes:
    return json.dumps({
        "error": "egress_denied",
        "reason": reason,
        # Which rules judged the request: "server" (no lease) or "agent:<mode>".
        "source": source,
        "method": flow.request.method,
        "host": flow.request.host,
        "port": flow.request.port,
        "path": flow.request.path.split("?", 1)[0],
        "hint": hint,
    }).encode("utf-8")


def _deny(flow: http.HTTPFlow, decision: policy.Decision, who: lease.SessionPolicy) -> None:
    hint = HINTS.get(who.source, HINTS["server"])
    flow.response = http.Response.make(
        403,
        _denial_body(flow, decision.reason, who.source, hint),
        {"Content-Type": "application/json", DENIED_HEADER: "denied"},
    )


# A refused CONNECT closes the client connection. Node's https module (NODE_USE_ENV_PROXY) otherwise
# waits on the open connection for minutes instead of failing the request.
CONNECT_REFUSAL_HEADERS = {DENIED_HEADER: "denied", "Connection": "close"}


def _refusal_headers(refusal: lease.Refusal) -> dict[str, str]:
    headers = {DENIED_HEADER: "denied"}
    if refusal.status == 407:
        headers["Proxy-Authenticate"] = PROXY_REALM
    return headers


def _refuse(flow: http.HTTPFlow, refusal: lease.Refusal) -> None:
    headers = {"Content-Type": "application/json", **_refusal_headers(refusal)}
    body = _denial_body(flow, refusal.reason, None, REFUSAL_HINTS[refusal.reason])
    flow.response = http.Response.make(refusal.status, body, headers)


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
    def __init__(
        self,
        resolver: Optional[Resolver] = None,
        verifier: Optional[lease.LeaseVerifier] = None,
    ) -> None:
        self.rule_sets = lease.RuleSets((), ())
        self.server = lease.server_policy(self.rule_sets)
        self.log_allowed = False
        self.resolve: Resolver = resolver or _system_resolve
        self.verifier = verifier
        self.port = DEFAULT_PORT
        self.lease_port = DEFAULT_LEASE_PORT
        self.unleased = "global"
        # Identity of a CONNECT tunnel, inherited by every request inside it. Keep the
        # credentials separately so each request can refresh the policy through the
        # lease verifier's bounded cache instead of keeping CONNECT-time rules forever.
        self.tunnels: MutableMapping[connection.Client, lease.SessionPolicy] = weakref.WeakKeyDictionary()
        self.tunnel_credentials: MutableMapping[connection.Client, lease.LeaseCredentials] = (
            weakref.WeakKeyDictionary()
        )
        # The policy of the latest request on a connection, for the server_connect gate.
        self.connection_policy: MutableMapping[connection.Client, lease.SessionPolicy] = (
            weakref.WeakKeyDictionary()
        )

    @property
    def rules(self) -> list[policy.Rule]:
        """The server rules (what a request without a lease gets on the open listener)."""
        return list(self.server.rules)

    @rules.setter
    def rules(self, rules: list[policy.Rule]) -> None:
        self.set_rule_sets(lease.RuleSets((), tuple(rules)))

    def set_rule_sets(self, rule_sets: lease.RuleSets) -> None:
        self.rule_sets = rule_sets
        self.server = lease.server_policy(rule_sets)

    def load(self, loader) -> None:  # noqa: ARG002 - mitmproxy hook signature
        self.set_rule_sets(_load_rule_sets())
        self.log_allowed = os.environ.get("STABLEHAND_EGRESS_LOG_ALLOWED", "0") == "1"
        self.port = _port_setting("STABLEHAND_EGRESS_PORT", DEFAULT_PORT)
        self.lease_port = _port_setting("STABLEHAND_EGRESS_LEASE_PORT", DEFAULT_LEASE_PORT)
        unleased = os.environ.get("STABLEHAND_EGRESS_UNLEASED", "global").strip().lower() or "global"
        if unleased not in ("global", "deny"):
            raise ValueError(f"STABLEHAND_EGRESS_UNLEASED must be 'global' or 'deny', got {unleased!r}")
        self.unleased = unleased
        if self.verifier is None:
            url = os.environ.get("STABLEHAND_EGRESS_LEASE_URL", DEFAULT_LEASE_URL).strip()
            self.verifier = lease.LeaseVerifier(url or None)

    def running(self) -> None:
        ctx.log.info(
            f"stablehand-egress: {len(self.rule_sets.runtime)} runtime rule(s), "
            f"{len(self.rule_sets.defaults)} server default(s); default deny; "
            f"lease required on :{self.lease_port}; requests without a lease on :{self.port} "
            + ("get the server rules" if self.unleased == "global" else "are refused")
        )
        _emit({
            "event": "egress.started",
            "runtime_rules": len(self.rule_sets.runtime),
            "server_defaults": len(self.rule_sets.defaults),
            "port": self.port,
            "lease_port": self.lease_port,
            "unleased": self.unleased,
            "lease_url": self.verifier.url if self.verifier else None,
            **({"warning": f"requests without a lease on :{self.port} get the server rules, so a "
                           "sandbox that drops its lease is not held to its agent's rules; set "
                           "STABLEHAND_EGRESS_UNLEASED=deny once every sandbox carries a lease"}
               if self.unleased == "global" else {}),
        })

    # ── identity ─────────────────────────────────────────────────────────────────────────

    def _lease_required(self, client: connection.Client) -> bool:
        if self.unleased == "deny":
            return True
        sockname = client.sockname
        return bool(sockname) and sockname[1] == self.lease_port

    async def _identify(
        self,
        flow: http.HTTPFlow,
        credentials: Optional[lease.LeaseCredentials] = None,
    ) -> tuple[Optional[lease.SessionPolicy], Optional[lease.Refusal]]:
        if credentials is None:
            try:
                credentials = lease.parse_proxy_authorization(flow.request.headers.get("Proxy-Authorization"))
            except lease.InvalidLease as error:
                return None, lease.Refusal(403, "invalid_lease", detail=str(error))
        if credentials is None:
            if self._lease_required(flow.client_conn):
                return None, lease.Refusal(407, "lease_required")
            return self.server, None
        verifier = self.verifier or lease.LeaseVerifier(None)
        outcome = await verifier.verify(credentials)
        if outcome.kind == "invalid":
            return None, lease.Refusal(403, "invalid_lease", credentials.session_id, outcome.detail)
        if outcome.kind != "valid":
            return None, lease.Refusal(503, "lease_unverifiable", credentials.session_id, outcome.detail)
        try:
            return lease.policy_from_lease(self.rule_sets, credentials, outcome.payload), None
        except lease.PolicyError as error:
            return None, lease.Refusal(403, "invalid_policy", credentials.session_id, str(error))

    # ── hooks ────────────────────────────────────────────────────────────────────────────

    async def http_connect(self, flow: http.HTTPFlow) -> None:
        """Identify the tunnel, then refuse it when its real destination (the CONNECT authority)
        is not allowed for that identity."""
        who, refusal = await self._identify(flow)
        credentials = None
        if refusal is None:
            credentials = lease.parse_proxy_authorization(flow.request.headers.get("Proxy-Authorization"))
        flow.request.headers.pop("Proxy-Authorization", None)
        if refusal is not None:
            _log_refusal(flow, refusal)
            flow.response = http.Response.make(
                refusal.status, b"", {**_refusal_headers(refusal), **CONNECT_REFUSAL_HEADERS},
            )
            return
        assert who is not None
        decision = policy.evaluate_connect(
            list(who.rules), flow.request.host, flow.request.port, flow.request.headers.get_all("Host"),
        )
        if decision.allowed:
            self.tunnels[flow.client_conn] = who
            if credentials is not None:
                self.tunnel_credentials[flow.client_conn] = credentials
            self.connection_policy[flow.client_conn] = who
            return
        _log("egress.denied", flow, decision, who)
        flow.response = http.Response.make(403, b"", CONNECT_REFUSAL_HEADERS)

    async def requestheaders(self, flow: http.HTTPFlow) -> None:
        """Judge every request before mitmproxy opens an upstream connection or forwards a byte."""
        who = self.tunnels.get(flow.client_conn)
        credentials = self.tunnel_credentials.get(flow.client_conn)
        refusal: Optional[lease.Refusal] = None
        if credentials is not None:
            # Never accept an inner request's credentials as a new tunnel identity.
            # LeaseVerifier handles TTL, outage grace and concurrent refreshes.
            who, refusal = await self._identify(flow, credentials)
            if who is not None:
                self.tunnels[flow.client_conn] = who
        elif who is None:
            # Plain HTTP through the proxy: every request carries its own credentials.
            who, refusal = await self._identify(flow)
        # Never forward the sandbox's proxy identity to the upstream host.
        flow.request.headers.pop("Proxy-Authorization", None)
        if refusal is not None:
            self.connection_policy.pop(flow.client_conn, None)
            _log_refusal(flow, refusal)
            if _body_may_be_large(flow):
                flow.kill()
            else:
                _refuse(flow, refusal)
            return
        assert who is not None
        self.connection_policy[flow.client_conn] = who
        decision = policy.evaluate_request(
            list(who.rules),
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
                _log("egress.allowed", flow, decision, who)
            return
        _log("egress.denied", flow, decision, who)
        if _body_may_be_large(flow):
            flow.kill()
        else:
            _deny(flow, decision, who)

    async def server_connect(self, data: server_hooks.ServerConnectionHookData) -> None:
        """Last gate before a socket opens: re-check the host, vet its DNS answers, pin the address."""
        server = data.server
        if server.address is None or server.via is not None:
            return
        host, port = server.address
        who = self.connection_policy.get(data.client)
        rules = list(who.rules) if who is not None else []
        if who is None:
            # Every request is identified before mitmproxy connects upstream; fail closed if not.
            decision = policy.Decision(False, "unidentified")
        else:
            decision = policy.evaluate_destination(rules, host, port)
        pinned: Optional[str] = None
        if decision.allowed and policy.parse_ip_literal(host) is None:
            try:
                addresses = await self.resolve(host, port)
            except OSError:
                decision = policy.Decision(False, "unresolvable")
            else:
                decision = policy.evaluate_resolved(rules, host, port, addresses)
                if decision.allowed:
                    pinned = policy.pick_address(addresses)
        if not decision.allowed:
            server.error = f"egress denied: {decision.reason}"
            _emit({
                "event": "egress.denied",
                "session": who.session_id if who else None,
                "agent": who.agent_id if who else None,
                "source": who.source if who else None,
                "client": _peer(data.client),
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
        who = self.tunnels.get(flow.client_conn)
        _emit({
            "event": "egress.denied",
            "session": who.session_id if who else None,
            "agent": who.agent_id if who else None,
            "source": who.source if who else None,
            "client": _peer(flow.client_conn),
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
