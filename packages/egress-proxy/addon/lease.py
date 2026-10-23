"""Session leases for the Stablehand egress proxy (pure functions, no mitmproxy imports).

Every sandbox session gets a lease from the orchestrator when it opens. The sandbox presents it
as proxy credentials (``http://<sessionId>:<token>@egress:<port>`` in its ``HTTP(S)_PROXY``), so
the proxy can tell which session a request belongs to and apply that session's rules instead of
the server-wide ones.

The proxy does not hold the lease secret. It asks the orchestrator (``STABLEHAND_EGRESS_LEASE_URL``)
to check a lease and caches the answer briefly:

* a valid lease comes back with the agent's egress setting and any runtime endpoints the
  orchestrator knows about, and is cached for the TTL the orchestrator sends;
* an invalid lease (bad token, ended session, deleted agent) is cached for a few seconds;
* when the orchestrator cannot be reached, a lease that was valid within the last few minutes
  keeps its last answer; otherwise the request is refused. The proxy never falls back to looser
  rules because it could not check a lease.

Rule sets, from the operator's files:

* runtime rules (``rules.runtime.txt`` + ``STABLEHAND_EGRESS_RUNTIME_ALLOW``): what the runtime
  itself needs (model providers). Every session gets these, including ``deny`` agents.
* server defaults (``rules.default.txt`` + ``STABLEHAND_EGRESS_EXTRA_ALLOW``): package registries,
  git hosting and anything the operator adds for everyone.

What a session gets, by the agent's egress mode:

* ``default``: runtime + server defaults (what a request without a lease gets today).
* ``allow``: runtime + server defaults + the agent's rules.
* ``deny``: runtime + the agent's rules (usually none). Server defaults do not apply.

The orchestrator may add runtime rules of its own (the model gateway, the artifact store or the
agent's model endpoint when the sandbox reaches them through the proxy). Neither those nor the
agent's rules may carry ``!internal``.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import policy

EGRESS_MODES = frozenset({"default", "deny", "allow"})
SERVER_SOURCE = "server"

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~-]{1,512}$")
MAX_AGENT_RULES = 200


class InvalidLease(ValueError):
    """The client sent proxy credentials that cannot be a lease."""


class PolicyError(ValueError):
    """The orchestrator's answer for a lease cannot be turned into rules."""


@dataclass(frozen=True)
class LeaseCredentials:
    session_id: str
    token: str = field(repr=False)


def parse_proxy_authorization(value: Optional[str]) -> Optional[LeaseCredentials]:
    """The lease in a ``Proxy-Authorization`` header, None when there is none.

    Raises InvalidLease when the header is present but is not ``Basic <sessionId>:<token>``.
    """
    if value is None or not value.strip():
        return None
    parts = value.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "basic":
        raise InvalidLease("not basic credentials")
    try:
        decoded = base64.b64decode(parts[1].strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as error:
        raise InvalidLease("undecodable credentials") from error
    session_id, separator, token = decoded.partition(":")
    if not separator or not _SESSION_ID_RE.match(session_id) or not _TOKEN_RE.match(token):
        raise InvalidLease("malformed lease")
    return LeaseCredentials(session_id, token)


@dataclass(frozen=True)
class Refusal:
    """A request refused before any rule is looked at: missing, bad or unconfirmable lease.

    Lives here rather than in the addon script because mitmproxy loads scripts outside
    ``sys.modules``, where dataclasses cannot resolve their annotations."""

    status: int
    reason: str
    session_id: Optional[str] = None
    detail: Optional[str] = None


# ── Rule sets and per-session policies ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class RuleSets:
    runtime: tuple[policy.Rule, ...]
    defaults: tuple[policy.Rule, ...]

    def server_rules(self) -> tuple[policy.Rule, ...]:
        return (*self.runtime, *self.defaults)


@dataclass(frozen=True)
class SessionPolicy:
    """The rules one request is judged by, and where they came from."""

    rules: tuple[policy.Rule, ...]
    source: str  # "server" for requests without a lease, else "agent:<mode>"
    session_id: Optional[str] = None
    agent_id: Optional[str] = None

    @property
    def mode(self) -> Optional[str]:
        return self.source.split(":", 1)[1] if self.source.startswith("agent:") else None


def server_policy(rule_sets: RuleSets) -> SessionPolicy:
    return SessionPolicy(rule_sets.server_rules(), SERVER_SOURCE)


def _string_list(value: Any, what: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise PolicyError(f"{what} must be a list of strings")
    if len(value) > MAX_AGENT_RULES:
        raise PolicyError(f"{what} has more than {MAX_AGENT_RULES} rules")
    return value


def _parse_strict(lines: list[str], source: str) -> list[policy.Rule]:
    parsed: list[policy.Rule] = []
    for index, line in enumerate(lines, start=1):
        try:
            rule = policy.parse_rule(line, f"{source}:{index}", allow_internal=False)
        except policy.RuleSyntaxError as error:
            raise PolicyError(str(error)) from error
        if rule is None:
            raise PolicyError(f"{source}:{index}: empty rule")
        parsed.append(rule)
    return parsed


def policy_from_lease(rule_sets: RuleSets, credentials: LeaseCredentials, payload: Any) -> SessionPolicy:
    """Compose a session's rules from the orchestrator's answer for its lease."""
    if not isinstance(payload, dict):
        raise PolicyError("lease answer is not an object")
    if payload.get("sessionId") != credentials.session_id:
        raise PolicyError("lease answer names a different session")
    agent_id = payload.get("agentId")
    if not isinstance(agent_id, str) or not agent_id:
        raise PolicyError("lease answer has no agentId")
    egress = payload.get("egress")
    if not isinstance(egress, dict):
        raise PolicyError("lease answer has no egress setting")
    mode = egress.get("mode")
    if mode not in EGRESS_MODES:
        raise PolicyError(f"unknown egress mode {mode!r}")
    agent_lines = _string_list(egress.get("rules"), "egress.rules")
    if mode == "default" and agent_lines:
        raise PolicyError("egress mode default takes no rules")
    runtime_lines = _string_list(payload.get("runtimeRules"), "runtimeRules")

    extra_runtime = _parse_strict(runtime_lines, "orchestrator")
    agent_rules = _parse_strict(agent_lines, f"agent:{agent_id}")
    runtime = (*rule_sets.runtime, *extra_runtime)
    if mode == "deny":
        rules = (*runtime, *agent_rules)
    else:  # default and allow both start from the server defaults
        rules = (*runtime, *rule_sets.defaults, *agent_rules)
    return SessionPolicy(rules, f"agent:{mode}", credentials.session_id, agent_id)


# ── Checking leases with the orchestrator ───────────────────────────────────────────────────


@dataclass(frozen=True)
class LeaseOutcome:
    kind: str  # "valid" | "invalid" | "unavailable"
    payload: Any = None
    detail: Optional[str] = None


Fetch = Callable[[str, bytes], Awaitable[tuple[int, Any]]]


def _read_json(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _blocking_post(url: str, body: bytes, timeout: float) -> tuple[int, Any]:
    request = urllib.request.Request(
        url, data=body, method="POST", headers={"Content-Type": "application/json"},
    )
    # The proxy's own calls never go through a proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, _read_json(response.read(65536))
    except urllib.error.HTTPError as error:
        return error.code, _read_json(error.read(65536))


def http_fetch(timeout: float = 3.0) -> Fetch:
    async def fetch(url: str, body: bytes) -> tuple[int, Any]:
        return await asyncio.to_thread(_blocking_post, url, body, timeout)
    return fetch


@dataclass
class _Entry:
    outcome: LeaseOutcome
    expires: float
    checked: float


class LeaseVerifier:
    """Checks leases with the orchestrator, with a short cache and one in-flight call per lease."""

    def __init__(
        self,
        url: Optional[str],
        fetch: Optional[Fetch] = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        default_ttl: float = 30.0,
        max_ttl: float = 300.0,
        negative_ttl: float = 5.0,
        unavailable_ttl: float = 1.0,
        stale_grace: float = 300.0,
        max_entries: int = 4096,
    ) -> None:
        self.url = url or None
        self.fetch = fetch or http_fetch()
        self.clock = clock
        self.default_ttl = default_ttl
        self.max_ttl = max_ttl
        self.negative_ttl = negative_ttl
        self.unavailable_ttl = unavailable_ttl
        self.stale_grace = stale_grace
        self.max_entries = max_entries
        self._cache: dict[tuple[str, str], _Entry] = {}
        self._last_valid: dict[tuple[str, str], _Entry] = {}
        self._inflight: dict[tuple[str, str], asyncio.Task[LeaseOutcome]] = {}

    @staticmethod
    def _key(credentials: LeaseCredentials) -> tuple[str, str]:
        return credentials.session_id, hashlib.sha256(credentials.token.encode("utf-8")).hexdigest()

    async def verify(self, credentials: LeaseCredentials) -> LeaseOutcome:
        key = self._key(credentials)
        entry = self._cache.get(key)
        if entry is not None and entry.expires > self.clock():
            return entry.outcome
        task = self._inflight.get(key)
        if task is None:
            # Concurrent requests for the same lease share one call to the orchestrator.
            task = asyncio.ensure_future(self._check(key, credentials))
            self._inflight[key] = task

            def _done(finished: asyncio.Task[LeaseOutcome], key: tuple[str, str] = key) -> None:
                if self._inflight.get(key) is finished:
                    del self._inflight[key]

            task.add_done_callback(_done)
        return await asyncio.shield(task)

    async def _check(self, key: tuple[str, str], credentials: LeaseCredentials) -> LeaseOutcome:
        now = self.clock()
        outcome = await self._ask(credentials)
        if outcome.kind == "valid":
            ttl = self.default_ttl
            if isinstance(outcome.payload, dict):
                requested = outcome.payload.get("ttlSeconds")
                if isinstance(requested, (int, float)) and requested > 0:
                    ttl = min(float(requested), self.max_ttl)
            entry = _Entry(outcome, now + ttl, now)
            self._store(self._cache, key, entry)
            self._store(self._last_valid, key, entry)
            return outcome
        if outcome.kind == "invalid":
            self._last_valid.pop(key, None)
            self._store(self._cache, key, _Entry(outcome, now + self.negative_ttl, now))
            return outcome
        stale = self._last_valid.get(key)
        if stale is not None and now - stale.checked <= self.stale_grace:
            return stale.outcome
        self._store(self._cache, key, _Entry(outcome, now + self.unavailable_ttl, now))
        return outcome

    async def _ask(self, credentials: LeaseCredentials) -> LeaseOutcome:
        if self.url is None:
            return LeaseOutcome("unavailable", detail="no lease URL configured")
        body = json.dumps({"sessionId": credentials.session_id, "token": credentials.token}).encode("utf-8")
        try:
            status, payload = await self.fetch(self.url, body)
        except Exception as error:  # noqa: BLE001 - any transport failure means "cannot check"
            return LeaseOutcome("unavailable", detail=type(error).__name__)
        if status == 200:
            return LeaseOutcome("valid", payload=payload)
        if status in (400, 401, 403, 404, 410):
            detail = None
            if isinstance(payload, dict):
                code = payload.get("code") or payload.get("error")
                detail = code if isinstance(code, str) else None
            return LeaseOutcome("invalid", detail=detail or f"http_{status}")
        return LeaseOutcome("unavailable", detail=f"http_{status}")

    def _store(self, table: dict[tuple[str, str], _Entry], key: tuple[str, str], entry: _Entry) -> None:
        table.pop(key, None)
        table[key] = entry
        while len(table) > self.max_entries:
            table.pop(next(iter(table)))
