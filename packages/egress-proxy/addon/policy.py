"""Egress policy for the Stablehand sandbox proxy (pure functions, no mitmproxy imports).

Rule grammar, one rule per line, ``#`` starts a comment::

    <METHOD|*> <host-glob>[:<port>][/<path-glob>]

* ``METHOD`` is an HTTP method or ``*``.
* ``host-glob`` is a lowercase hostname; a leading ``*.`` matches subdomains only. A bare ``*``
  matches any public host (private destinations still need ``!internal``).
* ``port`` defaults to any port.
* ``path-glob`` uses ``*`` for one segment and ``**`` for any depth; omitted means ``/**``.

Private, loopback and cloud-metadata destinations are denied even when a rule would match,
unless the rule carries the ``!internal`` marker. Decisions are default-deny.
"""
from __future__ import annotations

import fnmatch
import ipaddress
import re
from dataclasses import dataclass
from typing import Iterable, Optional

METADATA_HOSTS = frozenset({
    "metadata.google.internal",
    "metadata",
    "instance-data",
    "instance-data.ec2.internal",
})

_RULE_RE = re.compile(
    r"^(?P<method>[A-Za-z*]+)\s+(?P<host>[A-Za-z0-9.*-]+)(?::(?P<port>\d+))?(?P<path>/\S*)?(?:\s+(?P<flags>!\S+(?:\s+!\S+)*))?$"
)


@dataclass(frozen=True)
class Rule:
    method: str
    host: str
    port: Optional[int]
    path: str
    internal: bool
    source: str

    def matches_host(self, host: str, port: Optional[int]) -> bool:
        host = host.lower().rstrip(".")
        if self.port is not None and port is not None and self.port != port:
            return False
        if self.host == "*":
            return True
        if self.host.startswith("*."):
            suffix = self.host[1:]
            return host.endswith(suffix) and host != suffix[1:]
        return host == self.host

    def matches(self, method: str, host: str, port: Optional[int], path: str) -> bool:
        if self.method != "*" and self.method != method.upper():
            return False
        if not self.matches_host(host, port):
            return False
        return _path_matches(self.path, path or "/")


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str
    rule: Optional[Rule] = None


class RuleSyntaxError(ValueError):
    pass


def parse_rule(line: str, source: str = "<inline>") -> Optional[Rule]:
    text = line.split("#", 1)[0].strip()
    if not text:
        return None
    match = _RULE_RE.match(text)
    if not match:
        raise RuleSyntaxError(f"{source}: cannot parse egress rule: {line.strip()!r}")
    flags = set((match.group("flags") or "").split())
    unknown = flags - {"!internal"}
    if unknown:
        raise RuleSyntaxError(f"{source}: unknown rule flag(s) {sorted(unknown)} in {line.strip()!r}")
    port = match.group("port")
    return Rule(
        method=match.group("method").upper(),
        host=match.group("host").lower().rstrip("."),
        port=int(port) if port else None,
        path=match.group("path") or "/**",
        internal="!internal" in flags,
        source=source,
    )


def parse_rules(lines: Iterable[str], source: str = "<inline>") -> list[Rule]:
    rules: list[Rule] = []
    for number, line in enumerate(lines, start=1):
        rule = parse_rule(line, f"{source}:{number}")
        if rule is not None:
            rules.append(rule)
    return rules


def is_private_destination(host: str) -> bool:
    """True for loopback, link-local, RFC1918/ULA addresses, metadata names and bare names."""
    host = host.lower().rstrip(".")
    if host in METADATA_HOSTS or host == "localhost" or host.endswith(".localhost"):
        return True
    literal = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        address = ipaddress.ip_address(literal)
    except ValueError:
        # Single-label names resolve inside the container network, never on the internet.
        return "." not in host
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def evaluate(rules: list[Rule], method: str, host: str, port: Optional[int], path: str) -> Decision:
    """Default-deny evaluation; the first matching rule wins."""
    private = is_private_destination(host)
    for rule in rules:
        if not rule.matches(method, host, port, path):
            continue
        if private and not rule.internal:
            return Decision(False, "private_destination", rule)
        return Decision(True, "allowed", rule)
    if private:
        return Decision(False, "private_destination")
    return Decision(False, "no_matching_rule")


def host_could_match(rules: list[Rule], host: str, port: Optional[int]) -> bool:
    """Cheap pre-check used at CONNECT time before any path or method is known."""
    private = is_private_destination(host)
    for rule in rules:
        if rule.matches_host(host, port) and (rule.internal or not private):
            return True
    return False


def _path_matches(pattern: str, path: str) -> bool:
    path = path.split("?", 1)[0] or "/"
    if pattern in ("/**", "/"):
        return True
    pattern_parts = [part for part in pattern.split("/") if part != ""]
    path_parts = [part for part in path.split("/") if part != ""]
    return _match_parts(pattern_parts, path_parts)


def _match_parts(pattern: list[str], parts: list[str]) -> bool:
    if not pattern:
        return not parts
    head, rest = pattern[0], pattern[1:]
    if head == "**":
        # '**' matches zero or more segments.
        return any(_match_parts(rest, parts[index:]) for index in range(len(parts) + 1))
    if not parts:
        return False
    return fnmatch.fnmatchcase(parts[0], head) and _match_parts(rest, parts[1:])
