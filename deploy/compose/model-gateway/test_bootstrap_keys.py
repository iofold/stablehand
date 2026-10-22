"""Offline tests for bootstrap_keys.py. Run: python3 -m unittest discover -s deploy/compose/model-gateway -p 'test_bootstrap_keys.py'"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bootstrap_keys  # noqa: E402

RUNTIME_KEY = "sk-" + "a" * 48


class FakeGateway:
    def __init__(self, known_hashes: "set[str] | None" = None, info_status: int = 404) -> None:
        self.known_hashes = set(known_hashes or ())
        self.info_status = info_status
        self.calls: list[tuple[str, str, Any]] = []

    def __call__(self, method: str, path: str, body: "dict[str, Any] | None") -> "tuple[int, Any]":
        self.calls.append((method, path, body))
        if path.startswith("/key/info"):
            requested = path.split("key=", 1)[1]
            if requested in self.known_hashes:
                return 200, {"info": {"models": []}}
            if self.info_status == 404:
                return 404, {"detail": "Key not found"}
            return self.info_status, {"error": {"message": "Authentication Error"}}
        if path == "/key/delete":
            return 404, {"detail": "no keys found"}
        if path == "/key/generate":
            assert body is not None
            self.known_hashes.add(hashlib.sha256(body["key"].encode()).hexdigest())
            return 200, {"key": body["key"], "token": "hash"}
        return 500, {}


class EnsureRuntimeKeyTests(unittest.TestCase):
    def test_registers_a_new_key_with_the_alias_and_models(self) -> None:
        gateway = FakeGateway()
        result = bootstrap_keys.ensure_runtime_key(gateway, RUNTIME_KEY, "stablehand-runtime", ["gpt-5.4-mini"], log=lambda _m: None)
        self.assertEqual(result, "created")
        generate = [call for call in gateway.calls if call[1] == "/key/generate"]
        self.assertEqual(len(generate), 1)
        self.assertEqual(generate[0][2]["key_alias"], "stablehand-runtime")
        self.assertEqual(generate[0][2]["models"], ["gpt-5.4-mini"])

    def test_is_a_no_op_when_the_key_exists(self) -> None:
        gateway = FakeGateway(known_hashes={bootstrap_keys.key_hash(RUNTIME_KEY)})
        result = bootstrap_keys.ensure_runtime_key(gateway, RUNTIME_KEY, "stablehand-runtime", [], log=lambda _m: None)
        self.assertEqual(result, "exists")
        self.assertEqual([call[1] for call in gateway.calls if not call[1].startswith("/key/info")], [])

    def test_never_puts_the_secret_in_a_url_or_a_log_line(self) -> None:
        gateway = FakeGateway()
        lines: list[str] = []
        bootstrap_keys.ensure_runtime_key(gateway, RUNTIME_KEY, "stablehand-runtime", [], log=lines.append)
        for _method, path, _body in gateway.calls:
            self.assertNotIn(RUNTIME_KEY, path)
        for line in lines:
            self.assertNotIn(RUNTIME_KEY, line)

    def test_refuses_a_key_litellm_would_reject(self) -> None:
        with self.assertRaises(ValueError):
            bootstrap_keys.ensure_runtime_key(FakeGateway(), "not-an-sk-key", "stablehand-runtime", [], log=lambda _m: None)

    def test_stops_on_a_wrong_master_key_instead_of_creating(self) -> None:
        gateway = FakeGateway(info_status=401)
        with self.assertRaises(RuntimeError):
            bootstrap_keys.ensure_runtime_key(gateway, RUNTIME_KEY, "stablehand-runtime", [], log=lambda _m: None)
        self.assertFalse(any(call[1] == "/key/generate" for call in gateway.calls))


class ConfigModelNamesTests(unittest.TestCase):
    def test_lists_every_alias_once(self) -> None:
        try:
            import yaml  # type: ignore[import-untyped]  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML not installed")
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as handle:
            handle.write("model_list:\n  - model_name: b\n  - model_name: a\n  - model_name: b\n")
            path = handle.name
        try:
            self.assertEqual(bootstrap_keys.config_model_names(path), ["a", "b"])
        finally:
            os.unlink(path)

    def test_falls_back_to_all_models_when_the_file_is_missing(self) -> None:
        self.assertEqual(bootstrap_keys.config_model_names("/nonexistent/config.yaml"), [])


if __name__ == "__main__":
    unittest.main()
