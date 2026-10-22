"""Register the shared runtime key with LiteLLM before the orchestrator starts.

Runs once per `docker compose up` as the `gateway-init` service, inside the
gateway image (standard library only, plus PyYAML when present). Idempotent:
when LiteLLM already knows the key it exits without changing anything.

The runtime key's value comes from STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY, so it
can be generated into .env before LiteLLM exists. Per-session keys inherit its
model allowlist, which is every alias in the gateway config. No key material
is ever printed.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

RUNTIME_ALIAS_DEFAULT = "stablehand-runtime"

Transport = Callable[[str, str, "dict[str, Any] | None"], "tuple[int, Any]"]


def key_hash(key: str) -> str:
    """LiteLLM's token hash: SHA-256 hex of an `sk-` key."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest() if key.startswith("sk-") else key


def config_model_names(path: str) -> list[str]:
    """Every model alias in the gateway config, or [] (all models) if unreadable."""
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError:
        return []
    try:
        with open(path, encoding="utf-8") as handle:
            config = yaml.safe_load(handle) or {}
    except OSError:
        return []
    names = [entry.get("model_name") for entry in config.get("model_list") or []]
    return sorted({name for name in names if isinstance(name, str) and name})


def http_transport(base_url: str, master_key: str, timeout: float = 10.0) -> Transport:
    def call(method: str, path: str, body: "dict[str, Any] | None") -> "tuple[int, Any]":
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            f"{base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {master_key}",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
                status = response.status
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "replace")
            status = err.code
        try:
            parsed: Any = json.loads(raw) if raw else {}
        except ValueError:
            parsed = {"raw": raw[:200]}
        return status, parsed

    return call


def is_missing_key_response(status: int, body: Any) -> bool:
    if status == 404:
        return True
    text = json.dumps(body).lower()
    return status in (400, 401, 403) and ("not found" in text or "does not exist" in text)


def ensure_runtime_key(
    call: Transport,
    runtime_key: str,
    alias: str,
    models: list[str],
    log: Callable[[str], None] = print,
) -> str:
    """Make sure LiteLLM knows `runtime_key`. Returns "exists" or "created"."""
    if not runtime_key.startswith("sk-"):
        raise ValueError("STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY must start with sk- (a LiteLLM key format rule)")

    query = urllib.parse.urlencode({"key": key_hash(runtime_key)})
    status, body = call("GET", f"/key/info?{query}", None)
    if status == 200:
        log(f"runtime key already registered (alias {alias})")
        return "exists"
    if not is_missing_key_response(status, body):
        raise RuntimeError(f"key/info answered HTTP {status}; check LITELLM_MASTER_KEY")

    # Aliases are unique. A runtime key regenerated in .env over a kept
    # LiteLLM volume leaves the old key holding the alias: retire it.
    status, body = call("POST", "/key/delete", {"key_aliases": [alias]})
    if status not in (200, 404) and not is_missing_key_response(status, body):
        raise RuntimeError(f"key/delete answered HTTP {status}")

    status, body = call("POST", "/key/generate", {
        "key": runtime_key,
        "key_alias": alias,
        "models": models,
        "metadata": {"created_by": "stablehand-gateway-init"},
    })
    if status != 200:
        raise RuntimeError(f"key/generate answered HTTP {status}")
    scope = f"{len(models)} models" if models else "all models"
    log(f"registered runtime key (alias {alias}, {scope})")
    return "created"


def wait_for_gateway(base_url: str, deadline_s: float = 180.0) -> None:
    deadline = time.monotonic() + deadline_s
    while True:
        try:
            with urllib.request.urlopen(f"{base_url}/health/liveliness", timeout=3) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, OSError) as err:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"LiteLLM did not become live at {base_url}: {err}") from err
        time.sleep(2)


def main() -> int:
    base_url = os.environ.get("LITELLM_URL", "http://litellm:4000").rstrip("/")
    master_key = os.environ.get("LITELLM_MASTER_KEY", "")
    runtime_key = os.environ.get("STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY", "")
    alias = os.environ.get("STABLEHAND_MODEL_GATEWAY_RUNTIME_ALIAS", RUNTIME_ALIAS_DEFAULT)
    config_path = os.environ.get("LITELLM_CONFIG_PATH", "/app/config.yaml")
    if not master_key or not runtime_key:
        print("gateway-init: LITELLM_MASTER_KEY and STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY are required", file=sys.stderr)
        return 1
    try:
        wait_for_gateway(base_url)
        ensure_runtime_key(
            http_transport(base_url, master_key),
            runtime_key,
            alias,
            config_model_names(config_path),
            log=lambda message: print(f"gateway-init: {message}"),
        )
    except (RuntimeError, ValueError) as err:
        print(f"gateway-init: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
