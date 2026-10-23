"""Stub upstream for the egress integration test. Serves files from /srv/www (a bare git repository
the client prepares) and otherwise answers ``upstream:<host><path>:pa=<0|1>``, where ``pa`` says
whether a Proxy-Authorization header reached it (it never should). Plain HTTP on 8080, TLS on 8443."""
import datetime
import os
import ssl
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

ROOT = "/srv/www"
NAMES = ["model.example.test", "git.example.test", "other.example.test"]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        target = os.path.realpath(os.path.join(ROOT, path.lstrip("/")))
        if target.startswith(ROOT + "/") and os.path.isfile(target):
            with open(target, "rb") as handle:
                body = handle.read()
            content_type = "application/octet-stream"
        else:
            proxied = 1 if self.headers.get("Proxy-Authorization") else 0
            body = f"upstream:{self.headers.get('Host')}{path}:pa={proxied}".encode()
            content_type = "text/plain"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_GET

    def log_message(self, *_args):
        pass


def tls_context() -> ssl.SSLContext:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, NAMES[0])])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in NAMES]), critical=False)
        .sign(key, hashes.SHA256())
    )
    directory = tempfile.mkdtemp()
    cert_path, key_path = os.path.join(directory, "cert.pem"), os.path.join(directory, "key.pem")
    with open(cert_path, "wb") as handle:
        handle.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_path, "wb") as handle:
        handle.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    return context


plain = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
secure = ThreadingHTTPServer(("0.0.0.0", 8443), Handler)
secure.socket = tls_context().wrap_socket(secure.socket, server_side=True)
threading.Thread(target=plain.serve_forever, daemon=True).start()
print("upstream ready", flush=True)
secure.serve_forever()
