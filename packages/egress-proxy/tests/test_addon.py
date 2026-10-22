"""Hook-level tests for the mitmproxy addon. They need mitmproxy, so they run inside the proxy
image (tests/run-in-docker.sh) and are skipped elsewhere."""
import asyncio
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


def _request(method, host, port, path, headers, body=b"", authority=b""):
    return tutils.treq(
        method=method.encode(), host=host, port=port, path=path.encode(), authority=authority,
        headers=http.Headers([(name, value) for name, value in headers]), content=body,
    )


def connect_flow(target_host, target_port, host_header=None):
    headers = [(b"Host", host_header.encode())] if host_header else []
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


def server_data(host, port, sni=None):
    server = connection.Server(address=(host, port))
    server.sni = sni
    return server_hooks.ServerConnectionHookData(server=server, client=tflow.tclient_conn())


@unittest.skipIf(stablehand_egress is None, "mitmproxy is not installed (run tests/run-in-docker.sh)")
class ServerConnectHookTests(unittest.TestCase):
    def test_public_answer_is_pinned_and_keeps_hostname_sni(self):
        addon, calls = make_addon({"api.github.com": ["2606:50c0::1", "140.82.112.5"]})
        data = server_data("api.github.com", 443)
        self.assertEqual(run_quiet(addon.server_connect, data), [])
        self.assertIsNone(data.server.error)
        self.assertEqual(data.server.address, ("140.82.112.5", 443))
        self.assertEqual(data.server.sni, "api.github.com")
        self.assertEqual(calls, [("api.github.com", 443)])

    def test_private_answer_is_refused(self):
        addon, _ = make_addon({"api.github.com": ["10.0.0.5"]})
        data = server_data("api.github.com", 443, sni="api.github.com")
        logs = run_quiet(addon.server_connect, data)
        self.assertEqual(data.server.error, "egress denied: resolves_to_private")
        self.assertEqual(data.server.address, ("api.github.com", 443))
        self.assertEqual(logs[0]["reason"], "resolves_to_private")

    def test_internal_rule_admits_private_answer(self):
        addon, _ = make_addon({"ollama": ["172.18.0.9"]})
        data = server_data("ollama", 11434)
        run_quiet(addon.server_connect, data)
        self.assertIsNone(data.server.error)
        self.assertEqual(data.server.address, ("172.18.0.9", 11434))

    def test_disallowed_or_unresolvable_destination_is_refused(self):
        addon, calls = make_addon({})
        for host, reason in (("evil.example", "no_matching_rule"), ("169.254.169.254", "private_destination"),
                             ("api.github.com", "unresolvable")):
            data = server_data(host, 443)
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


if __name__ == "__main__":
    unittest.main()
