"""End-to-end checks against a real mitmdump started through the shipped entrypoint.

Runs only inside the proxy image with the hosts that tests/run-in-docker.sh sets up:
allowed.test -> 127.0.0.1 and denied.test -> 127.0.0.2, no network. Two upstream servers
(one per address, plain HTTP and TLS) count every connection they accept, so each test can
assert that a denied request never reached its target, not just that it got a 403.
"""
import datetime
import http.client
import ipaddress
import json
import os
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ENTRYPOINT = os.path.join(HERE, "..", "entrypoint.sh")
PROXY = ("127.0.0.1", 18888)
HTTP_PORT, TLS_PORT = 18080, 18443
RULES = """
* allowed.test/** !internal
GET *
"""


def _live_environment() -> bool:
    if os.environ.get("STABLEHAND_EGRESS_LIVE") != "1" or not os.path.exists(ENTRYPOINT):
        return False
    try:
        return (socket.gethostbyname("allowed.test"), socket.gethostbyname("denied.test")) == (
            "127.0.0.1", "127.0.0.2")
    except OSError:
        return False


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.server.requests.append((self.command, self.path, self.headers.get("Host")))
        body = f"upstream:{self.server.name}".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_GET

    def log_message(self, *_args):
        pass


class _Upstream(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, name, address, tls_context=None):
        super().__init__(address, _Handler)
        self.name, self.connections, self.requests = name, 0, []
        if tls_context is not None:
            self.socket = tls_context.wrap_socket(self.socket, server_side=True, do_handshake_on_connect=False)

    def verify_request(self, request, client_address):
        self.connections += 1
        return True


def _self_signed(tmp):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "upstream.test")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([
            x509.DNSName("allowed.test"), x509.DNSName("denied.test"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")), x509.IPAddress(ipaddress.ip_address("127.0.0.2")),
        ]), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = os.path.join(tmp, "upstream.pem"), os.path.join(tmp, "upstream.key")
    with open(cert_path, "wb") as handle:
        handle.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_path, "wb") as handle:
        handle.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    return context


def _read_head(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(1)
        if not chunk:
            break
        data += chunk
    return data


def _status(head):
    return int(head.split(b" ", 2)[1]) if head.startswith(b"HTTP/") else None


def _response(sock):
    response = http.client.HTTPResponse(sock)
    response.begin()
    return response.status, dict(response.getheaders()), response.read()


@unittest.skipUnless(_live_environment(), "live proxy checks run via tests/run-in-docker.sh")
class LiveProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="egress-live-")
        tls = _self_signed(cls.tmp)
        cls.allowed = _Upstream("allowed", ("127.0.0.1", HTTP_PORT))
        cls.denied = _Upstream("denied", ("127.0.0.2", HTTP_PORT))
        cls.allowed_tls = _Upstream("allowed-tls", ("127.0.0.1", TLS_PORT), tls)
        cls.denied_tls = _Upstream("denied-tls", ("127.0.0.2", TLS_PORT), tls)
        cls.upstreams = (cls.allowed, cls.denied, cls.allowed_tls, cls.denied_tls)
        for server in cls.upstreams:
            threading.Thread(target=server.serve_forever, daemon=True).start()

        rules = os.path.join(cls.tmp, "rules.txt")
        with open(rules, "w", encoding="utf-8") as handle:
            handle.write(RULES)
        cls.log_path = os.path.join(cls.tmp, "proxy.log")
        env = dict(
            os.environ,
            MITMPROXY_CONFDIR=os.path.join(cls.tmp, "conf"),
            STABLEHAND_EGRESS_CA_PUBLIC_DIR=os.path.join(cls.tmp, "ca"),
            STABLEHAND_EGRESS_PORT=str(PROXY[1]),
            STABLEHAND_EGRESS_RULES=rules,
            STABLEHAND_EGRESS_EXTRA_ALLOW="",
        )
        cls.log = open(cls.log_path, "w", encoding="utf-8")
        # The shipped entrypoint and options; upstream TLS here is self-signed, hence ssl_insecure.
        cls.proxy = subprocess.Popen(
            ["sh", ENTRYPOINT, "--listen-host", PROXY[0], "--set", "ssl_insecure=true"],
            env=env, stdout=cls.log, stderr=subprocess.STDOUT,
        )
        deadline = time.time() + 30
        while True:
            try:
                socket.create_connection(PROXY, timeout=1).close()
                break
            except OSError:
                if time.time() > deadline or cls.proxy.poll() is not None:
                    cls.tearDownClass()
                    raise RuntimeError(f"proxy did not start:\n{open(cls.log_path).read()}")
                time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.proxy.terminate()
        cls.proxy.wait(timeout=10)
        cls.log.close()
        for server in cls.upstreams:
            server.shutdown()
            server.server_close()

    def setUp(self):
        self.before = {server.name: server.connections for server in self.upstreams}

    def assertNotContacted(self, *servers):
        time.sleep(0.3)
        for server in servers:
            self.assertEqual(server.connections, self.before[server.name], f"{server.name} was contacted")

    def denial_reasons(self):
        reasons = []
        with open(self.log_path, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("{"):
                    record = json.loads(line)
                    if record.get("event") == "egress.denied":
                        reasons.append(record["reason"])
        return reasons

    # ── helpers ──────────────────────────────────────────────────────────────────────────

    def plain(self, raw):
        with socket.create_connection(PROXY, timeout=10) as sock:
            sock.sendall(raw)
            return _response(sock)

    def tunnel(self, target, host_header=None):
        sock = socket.create_connection(PROXY, timeout=10)
        header = f"Host: {host_header}\r\n" if host_header else ""
        sock.sendall(f"CONNECT {target} HTTP/1.1\r\n{header}\r\n".encode())
        return sock, _status(_read_head(sock))

    def tls_request(self, target, sni, host_header):
        sock, status = self.tunnel(target, target)
        self.assertEqual(status, 200)
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE  # the proxy's per-deployment CA is not under test here
        with context.wrap_socket(sock, server_hostname=sni) as tls:
            tls.sendall(f"GET /x HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n".encode())
            return _response(tls)

    # ── allowed traffic keeps working ────────────────────────────────────────────────────

    def test_allowed_host_plain_http(self):
        status, _, body = self.plain(
            b"GET http://allowed.test:18080/ok HTTP/1.1\r\nHost: allowed.test:18080\r\nConnection: close\r\n\r\n")
        self.assertEqual((status, body), (200, b"upstream:allowed"))

    def test_allowed_host_through_tls_tunnel(self):
        status, _, body = self.tls_request("allowed.test:18443", "allowed.test", "allowed.test:18443")
        self.assertEqual((status, body), (200, b"upstream:allowed-tls"))

    # ── header spoofing ──────────────────────────────────────────────────────────────────

    def test_connect_with_spoofed_host_header_is_denied(self):
        sock, status = self.tunnel("denied.test:18443", host_header="allowed.test:18443")
        sock.close()
        self.assertEqual(status, 403)
        self.assertIn("host_mismatch", self.denial_reasons())
        self.assertNotContacted(self.denied_tls)

    def test_plain_http_with_spoofed_host_header_is_denied(self):
        status, headers, body = self.plain(
            b"POST http://denied.test:18080/ HTTP/1.1\r\nHost: allowed.test:18080\r\n"
            b"Content-Length: 2\r\nConnection: close\r\n\r\nhi")
        self.assertEqual((status, json.loads(body)["reason"]), (403, "host_mismatch"))
        self.assertEqual(headers.get("X-Stablehand-Egress"), "denied")
        self.assertNotContacted(self.denied, self.allowed)

    def test_sni_that_disagrees_with_the_tunnel_is_denied(self):
        status, _, body = self.tls_request("allowed.test:18443", "denied.test", "allowed.test:18443")
        self.assertEqual((status, json.loads(body)["reason"]), (403, "sni_mismatch"))
        self.assertNotContacted(self.allowed_tls, self.denied_tls)

    def test_host_header_that_disagrees_with_the_tunnel_is_denied(self):
        status, _, body = self.tls_request("allowed.test:18443", "allowed.test", "denied.test:18443")
        self.assertEqual((status, json.loads(body)["reason"]), (403, "host_mismatch"))
        self.assertNotContacted(self.allowed_tls, self.denied_tls)

    # ── IP literals and metadata ─────────────────────────────────────────────────────────

    def test_ip_literals_are_denied(self):
        for target, reason in (("8.8.8.8", "ip_literal"), ("127.0.0.2:18080", "private_destination"),
                               ("127.1:18080", "private_destination")):
            status, _, body = self.plain(
                f"GET http://{target}/ HTTP/1.1\r\nHost: {target}\r\nConnection: close\r\n\r\n".encode())
            self.assertEqual((target, status, json.loads(body)["reason"]), (target, 403, reason))
        sock, status = self.tunnel("127.0.0.2:18443", "127.0.0.2:18443")
        sock.close()
        self.assertEqual(status, 403)
        self.assertNotContacted(self.allowed, self.denied, self.denied_tls)

    def test_metadata_ip_is_denied(self):
        for host_header, reason in (("169.254.169.254", "private_destination"),
                                    ("allowed.test:18080", "host_mismatch")):
            status, _, body = self.plain(
                b"GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: "
                + host_header.encode() + b"\r\nConnection: close\r\n\r\n")
            self.assertEqual((host_header, status, json.loads(body)["reason"]), (host_header, 403, reason))
        self.assertNotContacted(self.allowed)

    # ── resolution, streaming and non-HTTP tunnels ───────────────────────────────────────

    def test_name_that_resolves_to_a_private_address_is_refused(self):
        # 'GET *' admits any public name; denied.test resolves to 127.0.0.2, so the connect gate refuses it.
        status, _, body = self.plain(
            b"GET http://denied.test:18080/ HTTP/1.1\r\nHost: denied.test:18080\r\nConnection: close\r\n\r\n")
        self.assertEqual(status, 502)
        self.assertIn(b"resolves_to_private", body)
        self.assertIn("resolves_to_private", self.denial_reasons())
        self.assertNotContacted(self.denied)

    def test_large_body_to_denied_host_is_never_streamed_upstream(self):
        body = b"x" * (2 * 1024 * 1024)
        head = (b"POST http://denied.test:18080/upload HTTP/1.1\r\nHost: denied.test:18080\r\n"
                b"Content-Length: " + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n")
        with socket.create_connection(PROXY, timeout=10) as sock:
            try:
                sock.sendall(head + body)
                reply = sock.recv(65536)
            except OSError:
                reply = b""
        self.assertNotIn(b"upstream:denied", reply)
        self.assertNotContacted(self.denied)

    def test_raw_tcp_inside_an_allowed_tunnel_is_refused(self):
        sock, status = self.tunnel("allowed.test:18080", "allowed.test:18080")
        self.assertEqual(status, 200)
        try:
            sock.sendall(b"\x00\x01\x02\x03 not http\n")
            reply = sock.recv(1024)
        except OSError:
            reply = b""
        finally:
            sock.close()
        self.assertEqual(reply, b"")
        self.assertIn("non_http_protocol", self.denial_reasons())
        self.assertNotContacted(self.allowed)


if __name__ == "__main__":
    unittest.main()
