"""Stub orchestrator for the egress integration test: answers POST /api/egress/lease the way the
real endpoint does (packages/stablehand/src/orchestrator/routes/egress.ts), for fixed leases."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LEASES = {
    ("sess-deny", "tok-deny"): {"mode": "deny"},
    ("sess-default", "tok-default"): {"mode": "default"},
    # Agent rules never open private destinations, so this one stays closed (the stub hosts are private).
    ("sess-allow", "tok-allow"): {"mode": "allow", "rules": ["GET other.example.test/**"]},
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        request = json.loads(self.rfile.read(length) or b"{}")
        session, token = request.get("sessionId"), request.get("token")
        egress = LEASES.get((session, token)) if self.path == "/api/egress/lease" else None
        if egress is None:
            status, payload = 401, {"error": "Invalid egress lease", "code": "invalid_lease"}
        else:
            status, payload = 200, {"sessionId": session, "agentId": f"agent-{session}", "egress": egress,
                                    "runtimeRules": [], "ttlSeconds": 30}
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        print(json.dumps({"lease_check": session, "status": status}), flush=True)

    def log_message(self, *_args):
        pass


ThreadingHTTPServer(("0.0.0.0", 3001), Handler).serve_forever()
