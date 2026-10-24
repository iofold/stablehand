"""Hook-level tests for the mitmproxy addon. They need mitmproxy, so they run inside the proxy
image (tests/run-in-docker.sh) and are skipped elsewhere."""
import asyncio
import base64
import contextlib
import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "addon"))

try:
    from mitmproxy import connection, http
    from mitmproxy.proxy import server_hooks
    from mitmproxy.test import tflow, tutils

    import lease  # noqa: E402
    import policy  # noqa: E402
    import stablehand_egress  # noqa: E402
except ImportError:  # pragma: no cover - exercised only outside the proxy image
    stablehand_egress = None

RULES = (
    "* api.github.com/**",
    "GET pypi.org/**",
    "* ollama:11434/** !internal",
)


def make_addon(answers=None):
    calls = []

    async def resolve(host, port):
        calls.append((host, port))
        if answers is None or host not in answers:
            raise OSError(f"no answer for {host}")
        return list(answers[host])

    addon = stablehand_egress.StablehandEgress(resolver=resolve)
    addon.rules = policy.parse_rules(RULES, "test")
    return addon, calls


class FakeVerifier:
    """Stands in for the orchestrator: (session, token) -> (mode, rules), "unavailable" or absent."""

    url = "http://orchestrator.test/api/egress/lease"

    def __init__(self, leases):
        self.leases = leases
        self.calls = []

    async def verify(self, credentials):
        self.calls.append(credentials.session_id)
        entry = self.leases.get((credentials.session_id, credentials.token))
        if entry is None:
            return lease.LeaseOutcome("invalid", detail="invalid_lease")
        if entry == "unavailable":
            return lease.LeaseOutcome("unavailable", detail="http_503")
        mode, rules = entry
        egress = {"mode": mode, **({"rules": rules} if rules is not None else {})}
        return lease.LeaseOutcome("valid", payload={
            "sessionId": credentials.session_id, "agentId": f"agent-{credentials.session_id}", "egress": egress,
        })


LEASES = {
    ("sess-deny", "tok"): ("deny", None),
    ("sess-allow", "tok"): ("allow", ["GET docs.example.com/**"]),
    ("sess-default", "tok"): ("default", None),
    ("sess-bad-policy", "tok"): ("allow", ["* * !internal"]),
    ("sess-down", "tok"): "unavailable",
}


def make_lease_addon(answers=None, unleased="global"):
    """Runtime rules: the model provider. Server defaults: GitHub and PyPI GETs."""
    addon, calls = make_addon(answers)
    addon.set_rule_sets(lease.RuleSets(
        runtime=tuple(policy.parse_rules(["* api.openai.com/**"], "runtime")),
        defaults=tuple(policy.parse_rules(["* api.github.com/**", "GET pypi.org/**"], "defaults")),
    ))
    addon.verifier = FakeVerifier(LEASES)
    addon.unleased = unleased
    return addon, calls


def proxy_auth(session, token="tok"):
    return (b"Proxy-Authorization", b"Basic " + base64.b64encode(f"{session}:{token}".encode()))


def on_port(flow, port):
    flow.client_conn.sockname = ("172.18.0.2", port)
    return flow


def _request(method, host, port, path, headers, body=b"", authority=b""):
    return tutils.treq(
        method=method.encode(), host=host, port=port, path=path.encode(), authority=authority,
        headers=http.Headers([(name, value) for name, value in headers]), content=body,
    )


def connect_flow(target_host, target_port, host_header=None, extra_headers=()):
    headers = ([(b"Host", host_header.encode())] if host_header else []) + list(extra_headers)
    authority = f"{target_host}:{target_port}".encode()
    return tflow.tflow(req=_request("CONNECT", target_host, target_port, "", headers, authority=authority))


def request_flow(method, dest_host, dest_port, host_headers, *, sni=None, body=b"", headers=()):
    all_headers = [(b"Host", value.encode()) for value in host_headers] + list(headers)
    flow = tflow.tflow(req=_request(method, dest_host, dest_port, "/v1/x", all_headers, body))
    flow.client_conn.sni = sni
    return flow


def run_quiet(fn, *args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        result = fn(*args)
        if asyncio.iscoroutine(result):
            result = asyncio.run(result)
    return [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]


@unittest.skipIf(stablehand_egress is None, "mitmproxy is not installed (run tests/run-in-docker.sh)")
class ConnectHookTests(unittest.TestCase):
    def test_allowed_connect_passes(self):
        addon, _ = make_addon()
        flow = connect_flow("api.github.com", 443, "api.github.com:443")
        self.assertEqual(run_quiet(addon.http_connect, flow), [])
        self.assertIsNone(flow.response)

    def test_connect_with_spoofed_host_header_is_denied(self):
        addon, _ = make_addon()
        flow = connect_flow("evil.example", 443, "api.github.com:443")
        logs = run_quiet(addon.http_connect, flow)
        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(logs[0]["reason"], "host_mismatch")
        self.assertEqual(logs[0]["host"], "evil.example")

    def test_connect_to_ip_literal_and_metadata_is_denied(self):
        addon, _ = make_addon()
        for host, reason in (("140.82.112.5", "ip_literal"), ("169.254.169.254", "private_destination")):
            flow = connect_flow(host, 443)
            logs = run_quiet(addon.http_connect, flow)
            self.assertEqual((host, flow.response.status_code, logs[0]["reason"]), (host, 403, reason))


@unittest.skipIf(stablehand_egress is None, "mitmproxy is not installed (run tests/run-in-docker.sh)")
class RequestHookTests(unittest.TestCase):
    def test_allowed_request_passes_and_drops_proxy_identity(self):
        addon, _ = make_addon()
        addon.verifier = FakeVerifier({("sess-1", "x"): ("default", None)})
        flow = request_flow("POST", "api.github.com", 443, ["api.github.com"], sni="api.github.com",
                            headers=[(b"Proxy-Authorization", b"Basic c2Vzcy0xOng=")])
        self.assertEqual(run_quiet(addon.requestheaders, flow), [])
        self.assertIsNone(flow.response)
        self.assertNotIn("Proxy-Authorization", flow.request.headers)

    def test_sni_mismatch_is_denied(self):
        addon, _ = make_addon()
        flow = request_flow("GET", "api.github.com", 443, ["api.github.com"], sni="evil.example")
        logs = run_quiet(addon.requestheaders, flow)
        self.assertEqual(flow.response.status_code, 403)
        self.assertEqual(flow.response.headers[stablehand_egress.DENIED_HEADER], "denied")
        self.assertEqual(json.loads(flow.response.content)["reason"], "sni_mismatch")
        self.assertEqual(logs[0]["sni"], "evil.example")

    def test_host_header_spoof_is_judged_on_the_real_destination(self):
        addon, _ = make_addon()
        flow = request_flow("GET", "169.254.169.254", 80, ["api.github.com"])
        run_quiet(addon.requestheaders, flow)
        self.assertEqual(json.loads(flow.response.content)["host"], "169.254.169.254")
        self.assertEqual(json.loads(flow.response.content)["reason"], "host_mismatch")

    def test_large_denied_body_is_killed_not_forwarded(self):
        addon, _ = make_addon()
        flow = request_flow("POST", "evil.example", 80, ["evil.example"],
                            headers=[(b"Content-Length", b"2097152")])
        flow.request.stream = True  # what mitmproxy sets for bodies over stream_large_bodies
        run_quiet(addon.requestheaders, flow)
        self.assertIsNone(flow.response)
        self.assertTrue(flow.error and flow.error.msg == flow.error.KILLED_MESSAGE)
        chunked = request_flow("POST", "evil.example", 80, ["evil.example"],
                               headers=[(b"Transfer-Encoding", b"chunked")])
        run_quiet(addon.requestheaders, chunked)
        self.assertIsNone(chunked.response)
        self.assertFalse(chunked.live)

    def test_method_restriction_still_applies(self):
        addon, _ = make_addon()
        flow = request_flow("POST", "pypi.org", 443, ["pypi.org"], sni="pypi.org")
        run_quiet(addon.requestheaders, flow)
        self.assertEqual(json.loads(flow.response.content)["reason"], "no_matching_rule")


def server_data(host, port, sni=None, client=None, addon=None):
    server = connection.Server(address=(host, port))
    server.sni = sni
    if client is None:
        client = tflow.tclient_conn()
        if addon is not None:
            # A plain request identified this connection before it connects upstream.
            addon.connection_policy[client] = addon.server
    return server_hooks.ServerConnectionHookData(server=server, client=client)


@unittest.skipIf(stablehand_egress is None, "mitmproxy is not installed (run tests/run-in-docker.sh)")
class ServerConnectHookTests(unittest.TestCase):
    def test_public_answer_is_pinned_and_keeps_hostname_sni(self):
        addon, calls = make_addon({"api.github.com": ["2606:50c0::1", "140.82.112.5"]})
        data = server_data("api.github.com", 443, addon=addon)
        self.assertEqual(run_quiet(addon.server_connect, data), [])
        self.assertIsNone(data.server.error)
        self.assertEqual(data.server.address, ("140.82.112.5", 443))
        self.assertEqual(data.server.sni, "api.github.com")
        self.assertEqual(calls, [("api.github.com", 443)])

    def test_private_answer_is_refused(self):
        addon, _ = make_addon({"api.github.com": ["10.0.0.5"]})
        data = server_data("api.github.com", 443, sni="api.github.com", addon=addon)
        logs = run_quiet(addon.server_connect, data)
        self.assertEqual(data.server.error, "egress denied: resolves_to_private")
        self.assertEqual(data.server.address, ("api.github.com", 443))
        self.assertEqual(logs[0]["reason"], "resolves_to_private")

    def test_internal_rule_admits_private_answer(self):
        addon, _ = make_addon({"ollama": ["172.18.0.9"]})
        data = server_data("ollama", 11434, addon=addon)
        run_quiet(addon.server_connect, data)
        self.assertIsNone(data.server.error)
        self.assertEqual(data.server.address, ("172.18.0.9", 11434))

    def test_disallowed_or_unresolvable_destination_is_refused(self):
        addon, calls = make_addon({})
        for host, reason in (("evil.example", "no_matching_rule"), ("169.254.169.254", "private_destination"),
                             ("api.github.com", "unresolvable")):
            data = server_data(host, 443, addon=addon)
            run_quiet(addon.server_connect, data)
            self.assertEqual((host, data.server.error), (host, f"egress denied: {reason}"))
        self.assertEqual(calls, [("api.github.com", 443)])


@unittest.skipIf(stablehand_egress is None, "mitmproxy is not installed (run tests/run-in-docker.sh)")
class NonHttpTunnelTests(unittest.TestCase):
    def test_raw_tcp_is_refused_before_connecting(self):
        addon, _ = make_addon()
        flow = tflow.ttcpflow()
        flow.server_conn.timestamp_start = None
        logs = run_quiet(addon.tcp_start, flow)
        self.assertEqual(flow.server_conn.error, "egress denied: non_http_protocol")
        self.assertEqual(logs[0]["reason"], "non_http_protocol")

    def test_dns_tunnel_is_refused(self):
        addon, _ = make_addon()
        flow = tflow.tdnsflow()
        run_quiet(addon.dns_request, flow)
        self.assertEqual(flow.error.msg, flow.error.KILLED_MESSAGE)


@unittest.skipIf(stablehand_egress is None, "mitmproxy is not installed (run tests/run-in-docker.sh)")
class LeaseIdentityTests(unittest.TestCase):
    def test_open_listener_without_a_lease_gets_the_server_rules(self):
        addon, _ = make_lease_addon()
        flow = on_port(request_flow("GET", "pypi.org", 443, ["pypi.org"], sni="pypi.org"), 8080)
        self.assertEqual(run_quiet(addon.requestheaders, flow), [])
        self.assertIsNone(flow.response)
        self.assertEqual(addon.verifier.calls, [])

    def test_lease_listener_challenges_requests_without_a_lease(self):
        addon, _ = make_lease_addon()
        tunnel = on_port(connect_flow("api.github.com", 443, "api.github.com:443"), 8081)
        logs = run_quiet(addon.http_connect, tunnel)
        self.assertEqual(tunnel.response.status_code, 407)
        self.assertEqual(tunnel.response.headers["Proxy-Authenticate"], stablehand_egress.PROXY_REALM)
        self.assertEqual(tunnel.response.headers["Connection"], "close")
        self.assertEqual(logs[0]["reason"], "lease_required")
        plain = on_port(request_flow("GET", "pypi.org", 80, ["pypi.org"]), 8081)
        run_quiet(addon.requestheaders, plain)
        self.assertEqual(plain.response.status_code, 407)
        self.assertEqual(json.loads(plain.response.content)["reason"], "lease_required")

    def test_unleased_deny_challenges_the_open_listener_too(self):
        addon, _ = make_lease_addon(unleased="deny")
        flow = on_port(request_flow("GET", "pypi.org", 80, ["pypi.org"]), 8080)
        run_quiet(addon.requestheaders, flow)
        self.assertEqual(flow.response.status_code, 407)

    def test_deny_lease_keeps_the_model_provider_and_nothing_else(self):
        addon, _ = make_lease_addon()
        for port in (8080, 8081):
            github = on_port(connect_flow("api.github.com", 443, "api.github.com:443",
                                          [proxy_auth("sess-deny")]), port)
            logs = run_quiet(addon.http_connect, github)
            self.assertEqual(github.response.status_code, 403)
            self.assertEqual(github.response.headers["Connection"], "close")
            self.assertEqual((logs[0]["session"], logs[0]["agent"], logs[0]["source"], logs[0]["reason"]),
                             ("sess-deny", "agent-sess-deny", "agent:deny", "no_matching_rule"))
            model = on_port(connect_flow("api.openai.com", 443, "api.openai.com:443",
                                         [proxy_auth("sess-deny")]), port)
            self.assertEqual(run_quiet(addon.http_connect, model), [])
            self.assertIsNone(model.response)

    def test_requests_inside_a_tunnel_inherit_its_identity(self):
        addon, _ = make_lease_addon({"api.openai.com": ["162.159.140.245"]})
        tunnel = on_port(connect_flow("api.openai.com", 443, "api.openai.com:443", [proxy_auth("sess-deny")]), 8081)
        tunnel.client_conn.sni = "api.openai.com"
        run_quiet(addon.http_connect, tunnel)
        self.assertNotIn("Proxy-Authorization", tunnel.request.headers)
        for _ in range(2):
            inner = request_flow("POST", "api.openai.com", 443, ["api.openai.com"])
            inner.client_conn = tunnel.client_conn  # no credentials inside the tunnel
            self.assertEqual(run_quiet(addon.requestheaders, inner), [])
            self.assertIsNone(inner.response)
        self.assertEqual(addon.verifier.calls, ["sess-deny"] * 3)
        # The same request on a connection that never presented a lease is challenged.
        stranger = on_port(request_flow("POST", "api.openai.com", 443, ["api.openai.com"], sni="api.openai.com"), 8081)
        run_quiet(addon.requestheaders, stranger)
        self.assertEqual(stranger.response.status_code, 407)
        data = server_data("api.openai.com", 443, client=tunnel.client_conn)
        run_quiet(addon.server_connect, data)
        self.assertIsNone(data.server.error)

    def test_tunnel_rechecks_a_revoked_lease(self):
        addon, _ = make_lease_addon(unleased="deny")
        addon.verifier.leases = dict(LEASES)
        tunnel = on_port(connect_flow("docs.example.com", 443, "docs.example.com:443",
                                      [proxy_auth("sess-allow")]), 8081)
        tunnel.client_conn.sni = "docs.example.com"
        run_quiet(addon.http_connect, tunnel)
        self.assertIsNone(tunnel.response)
        del addon.verifier.leases[("sess-allow", "tok")]

        inner = request_flow("GET", "docs.example.com", 443, ["docs.example.com"])
        inner.client_conn = tunnel.client_conn
        logs = run_quiet(addon.requestheaders, inner)

        self.assertIsNotNone(inner.response)
        self.assertEqual(inner.response.status_code, 403)
        self.assertEqual(logs[0]["reason"], "invalid_lease")
        self.assertNotIn(inner.client_conn, addon.connection_policy)

    def test_tunnel_applies_an_agents_changed_egress_policy(self):
        addon, _ = make_lease_addon()
        addon.verifier.leases = dict(LEASES)
        tunnel = on_port(connect_flow("docs.example.com", 443, "docs.example.com:443",
                                      [proxy_auth("sess-allow")]), 8081)
        tunnel.client_conn.sni = "docs.example.com"
        run_quiet(addon.http_connect, tunnel)
        addon.verifier.leases[("sess-allow", "tok")] = ("deny", None)

        inner = request_flow("GET", "docs.example.com", 443, ["docs.example.com"])
        inner.client_conn = tunnel.client_conn
        run_quiet(addon.requestheaders, inner)

        self.assertIsNotNone(inner.response)
        self.assertEqual(inner.response.status_code, 403)
        self.assertEqual(json.loads(inner.response.content)["source"], "agent:deny")

    def test_tunnel_refuses_a_lease_that_can_no_longer_be_confirmed(self):
        addon, _ = make_lease_addon()
        addon.verifier.leases = dict(LEASES)
        tunnel = on_port(connect_flow("docs.example.com", 443, "docs.example.com:443",
                                      [proxy_auth("sess-allow")]), 8081)
        tunnel.client_conn.sni = "docs.example.com"
        run_quiet(addon.http_connect, tunnel)
        addon.verifier.leases[("sess-allow", "tok")] = "unavailable"

        inner = request_flow("GET", "docs.example.com", 443, ["docs.example.com"])
        inner.client_conn = tunnel.client_conn
        logs = run_quiet(addon.requestheaders, inner)

        self.assertIsNotNone(inner.response)
        self.assertEqual(inner.response.status_code, 503)
        self.assertEqual(logs[0]["reason"], "lease_unverifiable")

    def test_tunnel_uses_the_lease_cache_only_until_its_ttl(self):
        addon, _ = make_lease_addon()
        now = [0.0]
        calls = []

        async def fetch(_url, _body):
            calls.append(now[0])
            if now[0] >= 30:
                return 410, {"code": "session_ended"}
            return 200, {
                "sessionId": "sess-allow", "agentId": "agent-sess-allow",
                "egress": {"mode": "allow", "rules": ["GET docs.example.com/**"]},
                "ttlSeconds": 30,
            }

        addon.verifier = lease.LeaseVerifier("http://orchestrator.test/lease", fetch, clock=lambda: now[0])
        tunnel = on_port(connect_flow("docs.example.com", 443, "docs.example.com:443",
                                      [proxy_auth("sess-allow")]), 8081)
        tunnel.client_conn.sni = "docs.example.com"
        run_quiet(addon.http_connect, tunnel)
        now[0] = 29
        cached = request_flow("GET", "docs.example.com", 443, ["docs.example.com"])
        cached.client_conn = tunnel.client_conn
        run_quiet(addon.requestheaders, cached)
        self.assertIsNone(cached.response)
        self.assertEqual(calls, [0.0])

        now[0] = 31
        expired = request_flow("GET", "docs.example.com", 443, ["docs.example.com"])
        expired.client_conn = tunnel.client_conn
        run_quiet(addon.requestheaders, expired)

        self.assertIsNotNone(expired.response)
        self.assertEqual(expired.response.status_code, 403)
        self.assertEqual(calls, [0.0, 31])

    def test_deny_denial_names_its_rule_source(self):
        addon, _ = make_lease_addon()
        flow = on_port(request_flow("GET", "pypi.org", 80, ["pypi.org"], headers=[proxy_auth("sess-deny")]), 8081)
        run_quiet(addon.requestheaders, flow)
        body = json.loads(flow.response.content)
        self.assertEqual((flow.response.status_code, body["reason"], body["source"]),
                         (403, "no_matching_rule", "agent:deny"))
        self.assertIn("deny", body["hint"])
        self.assertNotIn("Proxy-Authorization", flow.request.headers)

    def test_allow_lease_adds_agent_rules_to_the_server_defaults(self):
        addon, _ = make_lease_addon()
        for host, method, expected in (("docs.example.com", "GET", None), ("docs.example.com", "POST", 403),
                                       ("pypi.org", "GET", None), ("api.openai.com", "POST", None)):
            flow = on_port(request_flow(method, host, 80, [host], headers=[proxy_auth("sess-allow")]), 8081)
            run_quiet(addon.requestheaders, flow)
            status = flow.response.status_code if flow.response else None
            self.assertEqual((host, method, status), (host, method, expected))

    def test_default_lease_behaves_like_the_server_rules(self):
        addon, _ = make_lease_addon()
        flow = on_port(request_flow("GET", "pypi.org", 80, ["pypi.org"], headers=[proxy_auth("sess-default")]), 8081)
        run_quiet(addon.requestheaders, flow)
        self.assertIsNone(flow.response)

    def test_bad_unverifiable_or_unusable_leases_are_refused(self):
        addon, _ = make_lease_addon()
        cases = (
            (proxy_auth("sess-deny", "forged"), 403, "invalid_lease"),
            ((b"Proxy-Authorization", b"Basic !!!"), 403, "invalid_lease"),
            (proxy_auth("sess-down"), 503, "lease_unverifiable"),
            (proxy_auth("sess-bad-policy"), 403, "invalid_policy"),
        )
        for header, status, reason in cases:
            for port in (8080, 8081):
                flow = on_port(request_flow("GET", "pypi.org", 80, ["pypi.org"], headers=[header]), port)
                logs = run_quiet(addon.requestheaders, flow)
                self.assertEqual((port, flow.response.status_code, json.loads(flow.response.content)["reason"]),
                                 (port, status, reason))
                self.assertEqual(logs[0]["reason"], reason)
                self.assertNotIn("forged", json.dumps(logs))
                tunnel = on_port(connect_flow("pypi.org", 443, "pypi.org:443", [header]), port)
                run_quiet(addon.http_connect, tunnel)
                self.assertEqual(tunnel.response.status_code, status)

    def test_server_connect_uses_the_connection_identity(self):
        addon, _ = make_lease_addon({"api.github.com": ["140.82.112.5"]})
        flow = on_port(request_flow("GET", "pypi.org", 80, ["pypi.org"], headers=[proxy_auth("sess-deny")]), 8081)
        run_quiet(addon.requestheaders, flow)
        data = server_data("api.github.com", 443, client=flow.client_conn)
        logs = run_quiet(addon.server_connect, data)
        self.assertEqual(data.server.error, "egress denied: no_matching_rule")
        self.assertEqual(logs[0]["source"], "agent:deny")
        unknown = server_data("api.github.com", 443)
        run_quiet(addon.server_connect, unknown)
        self.assertEqual(unknown.server.error, "egress denied: unidentified")


if __name__ == "__main__":
    unittest.main()
