"""Egress policy for the Stablehand sandbox proxy (pure functions, no mitmproxy imports).

Rule grammar, one rule per line, ``#`` starts a comment::

    <METHOD|*> <host-glob>[:<port>][/<path-glob>]

* ``METHOD`` is an HTTP method or ``*``.
* ``host-glob`` is a lowercase hostname; a leading ``*.`` matches subdomains only. A bare ``*``
  matches any public host (private destinations still need ``!internal``).
* ``port`` defaults to any port.
* ``path-glob`` uses ``*`` for one segment and ``**`` for any depth; omitted means ``/**``.

Private, loopback, link-local, shared (CGNAT) and cloud-metadata destinations are denied even
when a rule would match, unless the rule carries the ``!internal`` marker. Decisions are
default-deny.

Every decision is made on the destination the proxy really connects to, never on what a header
claims:

* The destination is the CONNECT authority for tunnels and the request-target authority for
  plain HTTP. Every ``Host`` header, the HTTP/2 ``:authority`` and the TLS SNI must name that same
  host (and port, when they carry one); a disagreement is denied (``host_mismatch``,
  ``sni_mismatch``).
* IP literals, including legacy spellings such as ``127.1`` or ``2130706433``, only match a rule
  that names that exact address. Host globs, the bare ``*`` included, never match them.
* A hostname is resolved before the proxy connects. If any address it resolves to is private,
  the connection is refused unless a rule for that host carries ``!internal``, and the proxy
  connects to the address it vetted, so a second DNS answer cannot redirect it (DNS rebinding).
"""
from __future__ import annotations

import fnmatch
import ipaddress
import re
import socket
from dataclasses import dataclass
from typing import Iterable, Optional, Sequence, Union

IPAddress = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]

METADATA_HOSTS = frozenset({
    "metadata.google.internal",
    "metadata",
    "instance-data",
    "instance-data.ec2.internal",
})

# Cloud metadata endpoints. Most are link-local and private anyway; Azure's WireServer is not.
METADATA_ADDRESSES = frozenset(ipaddress.ip_address(address) for address in (
    "169.254.169.254",  # AWS, GCP, Azure IMDS, OpenStack, DigitalOcean
    "169.254.170.2",    # AWS ECS task metadata
    "168.63.129.16",    # Azure WireServer (a public address)
    "100.100.100.200",  # Alibaba Cloud
    "fd00:ec2::254",    # AWS IMDS over IPv6
))

_NAT64_PREFIX = ipaddress.ip_network("64:ff9b::/96")

# Dotted (or undotted) decimal, octal and hex IPv4 spellings that inet_aton(3) accepts and the
# system resolver therefore connects to as an address, e.g. 127.1, 0x7f.0.0.1, 2130706433.
_LEGACY_IPV4_RE = re.compile(r"^(?:0x[0-9a-f]*|[0-9]+)(?:\.(?:0x[0-9a-f]*|[0-9]+)){0,3}$")

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
        host = normalize_host(host)
        if self.port is not None and port is not None and self.port != port:
            return False
        literal = parse_ip_literal(host)
        if literal is not None:
            # An IP literal is reachable only through a rule that names that exact address.
            return parse_ip_literal(self.host) == literal
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


# ── Hosts and addresses ──────────────────────────────────────────────────────────────────────


def normalize_host(host: Optional[str]) -> str:
    """Lowercase, strip a trailing dot and IPv6 brackets, and fold IDNs to their ASCII form."""
    host = (host or "").strip().lower().rstrip(".")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if not host.isascii():
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            pass  # left as-is: it can never equal an ASCII destination, so comparisons fail closed
    return host


def parse_ip_literal(host: Optional[str]) -> Optional[IPAddress]:
    """The address an IP-literal host names, or None for a hostname."""
    text = normalize_host(host)
    if not text:
        return None
    try:
        return ipaddress.ip_address(text)
    except ValueError:
        pass
    if _LEGACY_IPV4_RE.match(text):
        try:
            return ipaddress.IPv4Address(socket.inet_aton(text))
        except OSError:
            return None
    return None


def _embedded_ipv4(address: ipaddress.IPv6Address) -> Optional[ipaddress.IPv4Address]:
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped
    if address.sixtofour is not None:
        return address.sixtofour
    if address in _NAT64_PREFIX or (int(address) >> 32 == 0 and int(address) > 1):
        # NAT64 well-known prefix, or a deprecated IPv4-compatible address (::a.b.c.d).
        return ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
    return None


def is_private_address(address: IPAddress) -> bool:
    """True for anything that is not a globally routable unicast address, and for metadata IPs."""
    if address in METADATA_ADDRESSES:
        return True
    if isinstance(address, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(address)
        if embedded is not None and is_private_address(embedded):
            return True
    return not address.is_global or address.is_multicast


def is_private_destination(host: str) -> bool:
    """True for private addresses, metadata names, localhost and bare (single-label) names."""
    host = normalize_host(host)
    if not host:
        return True
    if host in METADATA_HOSTS or host == "localhost" or host.endswith(".localhost"):
        return True
    address = parse_ip_literal(host)
    if address is None:
        # Single-label names resolve inside the container network, never on the internet.
        return "." not in host
    return is_private_address(address)


def same_host(left: Optional[str], right: Optional[str]) -> bool:
    a, b = normalize_host(left), normalize_host(right)
    if a == b:
        return bool(a)
    literal = parse_ip_literal(a)
    return literal is not None and literal == parse_ip_literal(b)


def split_authority(value: str) -> tuple[str, Optional[int]]:
    """Split ``host[:port]`` / ``[v6]:port``. A malformed port comes back as -1 so it never matches."""
    value = (value or "").strip()
    if value.startswith("["):
        end = value.find("]")
        if end == -1:
            return value, -1
        host, rest = value[1:end], value[end + 1:]
        if not rest:
            return host, None
        if not rest.startswith(":"):
            return host, -1
        port_text: Optional[str] = rest[1:]
    elif value.count(":") == 1:
        host, port_text = value.split(":", 1)
    else:
        host, port_text = value, None
    if port_text is None:
        return host, None
    return host, int(port_text) if port_text.isdigit() else -1


def authority_matches(dest_host: str, dest_port: Optional[int], claimed: str) -> bool:
    """Does a Host header / :authority / CONNECT authority name this destination?"""
    host, port = split_authority(claimed)
    if not same_host(host, dest_host):
        return False
    return port is None or dest_port is None or port == dest_port


# ── Decisions ────────────────────────────────────────────────────────────────────────────────


def _denial_reason(host: str) -> str:
    if is_private_destination(host):
        return "private_destination"
    if parse_ip_literal(host) is not None:
        return "ip_literal"
    return "no_matching_rule"


def evaluate(rules: list[Rule], method: str, host: str, port: Optional[int], path: str) -> Decision:
    """Default-deny evaluation of a request to ``host``; the first matching rule wins."""
    host = normalize_host(host)
    private = is_private_destination(host)
    for rule in rules:
        if not rule.matches(method, host, port, path):
            continue
        if private and not rule.internal:
            return Decision(False, "private_destination", rule)
        return Decision(True, "allowed", rule)
    return Decision(False, _denial_reason(host))


def evaluate_destination(rules: list[Rule], host: str, port: Optional[int]) -> Decision:
    """Host-level decision, used before any method or path is known (CONNECT, server connect)."""
    host = normalize_host(host)
    private = is_private_destination(host)
    for rule in rules:
        if rule.matches_host(host, port) and (rule.internal or not private):
            return Decision(True, "allowed", rule)
    return Decision(False, _denial_reason(host))


def host_could_match(rules: list[Rule], host: str, port: Optional[int]) -> bool:
    """Cheap pre-check used at CONNECT time before any path or method is known."""
    return evaluate_destination(rules, host, port).allowed


def evaluate_connect(
    rules: list[Rule],
    dest_host: str,
    dest_port: Optional[int],
    host_headers: Sequence[str] = (),
) -> Decision:
    """A CONNECT request: the tunnel goes to the CONNECT authority, so that is what is judged.

    A Host header on the CONNECT request must name the same authority; a request that names an
    allowed host in its Host header while tunnelling elsewhere is denied outright.
    """
    for value in host_headers:
        if not authority_matches(dest_host, dest_port, value):
            return Decision(False, "host_mismatch")
    return evaluate_destination(rules, dest_host, dest_port)


def check_request_identity(
    dest_host: str,
    dest_port: Optional[int],
    host_headers: Sequence[str] = (),
    authority: Optional[str] = None,
    sni: Optional[str] = None,
) -> Optional[str]:
    """None when every name the client presented agrees with the destination, else the reason."""
    for value in host_headers:
        if not authority_matches(dest_host, dest_port, value):
            return "host_mismatch"
    if authority and not authority_matches(dest_host, dest_port, authority):
        return "host_mismatch"
    if sni and not same_host(sni, dest_host):
        return "sni_mismatch"
    return None


def evaluate_request(
    rules: list[Rule],
    method: str,
    dest_host: str,
    dest_port: Optional[int],
    path: str,
    *,
    host_headers: Sequence[str] = (),
    authority: Optional[str] = None,
    sni: Optional[str] = None,
) -> Decision:
    """An HTTP request bound for ``dest_host:dest_port`` (the real upstream, not the Host header)."""
    mismatch = check_request_identity(dest_host, dest_port, host_headers, authority, sni)
    if mismatch is not None:
        return Decision(False, mismatch)
    return evaluate(rules, method, dest_host, dest_port, path)


def internal_allowed(rules: list[Rule], host: str, port: Optional[int]) -> bool:
    return any(rule.internal and rule.matches_host(host, port) for rule in rules)


def evaluate_resolved(
    rules: list[Rule], host: str, port: Optional[int], addresses: Iterable[str],
) -> Decision:
    """Every address ``host`` resolved to must be public unless a rule for it is ``!internal``."""
    parsed: list[IPAddress] = []
    for address in addresses:
        literal = parse_ip_literal(address)
        if literal is None:
            return Decision(False, "unresolvable")
        parsed.append(literal)
    if not parsed:
        return Decision(False, "unresolvable")
    if any(is_private_address(address) for address in parsed) and not internal_allowed(rules, host, port):
        return Decision(False, "resolves_to_private")
    return Decision(True, "allowed")


def pick_address(addresses: Sequence[str]) -> str:
    """The resolved address to pin the connection to: the first IPv4 one, else the first."""
    for address in addresses:
        if isinstance(parse_ip_literal(address), ipaddress.IPv4Address):
            return address
    return addresses[0]


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
