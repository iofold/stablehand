import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "addon"))

import policy  # noqa: E402


def rules(*lines):
    return policy.parse_rules(lines, "test")


class ParseTests(unittest.TestCase):
    def test_parses_method_host_port_path_and_flags(self):
        rule = policy.parse_rule("GET api.example.com:8443/v1/** !internal", "t")
        self.assertEqual((rule.method, rule.host, rule.port, rule.path, rule.internal),
                         ("GET", "api.example.com", 8443, "/v1/**", True))

    def test_skips_comments_and_blank_lines(self):
        self.assertEqual(rules("# comment", "", "  * a.example.com  # trailing"), [
            policy.Rule("*", "a.example.com", None, "/**", False, "test:3"),
        ])

    def test_rejects_garbage(self):
        with self.assertRaises(policy.RuleSyntaxError):
            policy.parse_rule("GET", "t")
        with self.assertRaises(policy.RuleSyntaxError):
            policy.parse_rule("GET a.example.com !bogus", "t")


class EvaluateTests(unittest.TestCase):
    def test_default_deny(self):
        decision = policy.evaluate(rules("* api.github.com/**"), "GET", "example.org", 443, "/")
        self.assertEqual((decision.allowed, decision.reason), (False, "no_matching_rule"))

    def test_exact_host_any_method(self):
        self.assertTrue(policy.evaluate(rules("* api.github.com/**"), "POST", "API.GITHUB.COM", 443, "/repos").allowed)

    def test_method_restriction(self):
        rs = rules("GET pypi.org/**")
        self.assertTrue(policy.evaluate(rs, "GET", "pypi.org", 443, "/simple/x/").allowed)
        self.assertFalse(policy.evaluate(rs, "POST", "pypi.org", 443, "/simple/x/").allowed)

    def test_wildcard_host_matches_subdomains_only(self):
        rs = rules("* *.githubusercontent.com/**")
        self.assertTrue(policy.evaluate(rs, "GET", "raw.githubusercontent.com", 443, "/a").allowed)
        self.assertFalse(policy.evaluate(rs, "GET", "githubusercontent.com", 443, "/a").allowed)

    def test_path_globs(self):
        rs = rules("GET api.example.com/v1/*/items/**")
        self.assertTrue(policy.evaluate(rs, "GET", "api.example.com", 443, "/v1/42/items").allowed)
        self.assertTrue(policy.evaluate(rs, "GET", "api.example.com", 443, "/v1/42/items/7/x?y=1").allowed)
        self.assertFalse(policy.evaluate(rs, "GET", "api.example.com", 443, "/v2/42/items").allowed)

    def test_port_restriction(self):
        rs = rules("* registry.example.com:5000/**")
        self.assertTrue(policy.evaluate(rs, "GET", "registry.example.com", 5000, "/v2/").allowed)
        self.assertFalse(policy.evaluate(rs, "GET", "registry.example.com", 443, "/v2/").allowed)

    def test_private_and_metadata_denied_even_when_allowed_by_rule(self):
        rs = rules("* 169.254.169.254/**", "* metadata.google.internal/**", "* 10.0.0.8/**", "* localhost/**")
        for host in ("169.254.169.254", "metadata.google.internal", "10.0.0.8", "localhost", "127.0.0.1", "[::1]"):
            decision = policy.evaluate(rs, "GET", host, 80, "/")
            self.assertEqual((host, decision.allowed, decision.reason), (host, False, "private_destination"))

    def test_internal_flag_opts_a_private_destination_in(self):
        rs = rules("* ollama:11434/** !internal")
        self.assertTrue(policy.evaluate(rs, "POST", "ollama", 11434, "/api/generate").allowed)
        self.assertFalse(policy.evaluate(rules("* ollama:11434/**"), "POST", "ollama", 11434, "/api/generate").allowed)

    def test_bare_star_matches_any_public_host_only(self):
        rs = rules("GET *", "* ollama:11434/** !internal")
        self.assertTrue(policy.evaluate(rs, "GET", "www.theverge.com", 443, "/tech").allowed)
        self.assertFalse(policy.evaluate(rs, "POST", "www.theverge.com", 443, "/tech").allowed)
        self.assertEqual(policy.evaluate(rs, "GET", "10.1.2.3", 443, "/").reason, "private_destination")
        self.assertTrue(policy.host_could_match(rs, "anything.example", 443))
        self.assertFalse(policy.host_could_match(rs, "169.254.169.254", 80))

    def test_first_match_wins(self):
        rs = rules("GET a.example.com/public/**", "* a.example.com/**")
        self.assertTrue(policy.evaluate(rs, "DELETE", "a.example.com", 443, "/private").allowed)


class ConnectPrecheckTests(unittest.TestCase):
    def test_host_could_match(self):
        rs = rules("GET api.github.com/**", "* ollama:11434/** !internal")
        self.assertTrue(policy.host_could_match(rs, "api.github.com", 443))
        self.assertFalse(policy.host_could_match(rs, "example.org", 443))
        self.assertTrue(policy.host_could_match(rs, "ollama", 11434))
        self.assertFalse(policy.host_could_match(rules("* 10.0.0.5/**"), "10.0.0.5", 443))


DEFAULTS = ("* api.github.com/**", "* *.githubusercontent.com/**", "GET *")


class RealDestinationTests(unittest.TestCase):
    """The decision follows where the proxy connects, not what the client's headers claim."""

    def test_allowed_host_with_agreeing_names(self):
        decision = policy.evaluate_request(
            rules(*DEFAULTS), "POST", "api.github.com", 443, "/graphql",
            host_headers=["api.github.com"], sni="api.github.com",
        )
        self.assertEqual((decision.allowed, decision.reason), (True, "allowed"))
        connect = policy.evaluate_connect(rules(*DEFAULTS), "api.github.com", 443, ["api.github.com:443"])
        self.assertTrue(connect.allowed)

    def test_connect_with_spoofed_host_header_is_denied(self):
        rs = rules("* api.github.com/**")
        spoofed = policy.evaluate_connect(rs, "evil.example", 443, ["api.github.com:443"])
        self.assertEqual((spoofed.allowed, spoofed.reason), (False, "host_mismatch"))
        # Without the spoofed header the tunnel is judged on its real target and still refused.
        plain = policy.evaluate_connect(rs, "evil.example", 443, [])
        self.assertEqual((plain.allowed, plain.reason), (False, "no_matching_rule"))
        # A CONNECT to an internal service dressed up as an allowed host.
        internal = policy.evaluate_connect(rs, "postgres", 5432, ["api.github.com"])
        self.assertFalse(internal.allowed)

    def test_connect_host_header_port_must_agree(self):
        rs = rules("* api.github.com/**")
        self.assertEqual(policy.evaluate_connect(rs, "api.github.com", 443, ["api.github.com:22"]).reason,
                         "host_mismatch")
        self.assertTrue(policy.evaluate_connect(rs, "API.GitHub.com.", 443, ["api.github.com"]).allowed)

    def test_sni_that_disagrees_with_the_tunnel_is_denied(self):
        decision = policy.evaluate_request(
            rules(*DEFAULTS), "GET", "api.github.com", 443, "/",
            host_headers=["api.github.com"], sni="evil.example",
        )
        self.assertEqual((decision.allowed, decision.reason), (False, "sni_mismatch"))

    def test_host_header_that_disagrees_with_the_destination_is_denied(self):
        rs = rules(*DEFAULTS)
        # Inside a tunnel to an allowed host, a Host header naming another vhost (domain fronting).
        fronted = policy.evaluate_request(rs, "GET", "api.github.com", 443, "/",
                                          host_headers=["evil.example"], sni="api.github.com")
        self.assertEqual(fronted.reason, "host_mismatch")
        # Plain HTTP: the absolute-form target is the destination, not the Host header.
        plain = policy.evaluate_request(rs, "POST", "evil.example", 80, "/",
                                        host_headers=["api.github.com"])
        self.assertEqual((plain.allowed, plain.reason), (False, "host_mismatch"))
        # Duplicate Host headers must all agree.
        duplicated = policy.evaluate_request(rs, "GET", "api.github.com", 443, "/",
                                             host_headers=["api.github.com", "evil.example"])
        self.assertEqual(duplicated.reason, "host_mismatch")
        # An absolute-form target or HTTP/2 :authority inside a tunnel must agree too.
        authority = policy.evaluate_request(rs, "GET", "api.github.com", 443, "/",
                                            authority="evil.example:443", sni="api.github.com")
        self.assertEqual(authority.reason, "host_mismatch")

    def test_ip_literals_need_an_exact_rule(self):
        rs = rules(*DEFAULTS)
        for host in ("140.82.112.5", "[2606:50c0:8000::153]", "2606:50c0:8000::153"):
            decision = policy.evaluate(rs, "GET", host, 443, "/")
            self.assertEqual((host, decision.allowed, decision.reason), (host, False, "ip_literal"))
        self.assertFalse(policy.host_could_match(rs, "140.82.112.5", 443))
        explicit = rules("* 140.82.112.5:443/**")
        self.assertTrue(policy.evaluate(explicit, "GET", "140.82.112.5", 443, "/").allowed)
        self.assertFalse(policy.evaluate(explicit, "GET", "140.82.112.6", 443, "/").allowed)

    def test_legacy_ipv4_spellings_are_ip_literals(self):
        rs = rules(*DEFAULTS)
        for host in ("127.1", "0x7f.0.0.1", "0177.0.0.1", "2130706433", "0x7f000001", "10.1"):
            self.assertIsNotNone(policy.parse_ip_literal(host), host)
            decision = policy.evaluate(rs, "GET", host, 80, "/")
            self.assertEqual((host, decision.allowed, decision.reason), (host, False, "private_destination"))
        for host in ("1e100.net", "deadbeef.cafe", "123.example", "api.github.com"):
            self.assertIsNone(policy.parse_ip_literal(host), host)

    def test_metadata_and_internal_addresses_are_denied(self):
        rs = rules(*DEFAULTS)
        for host in ("169.254.169.254", "169.254.170.2", "168.63.129.16", "100.100.100.200",
                     "fd00:ec2::254", "[::ffff:169.254.169.254]", "64:ff9b::a9fe:a9fe",
                     "metadata.google.internal", "metadata", "100.64.0.10", "0.0.0.0", "[::]"):
            decision = policy.evaluate(rs, "GET", host, 80, "/latest/meta-data/")
            self.assertEqual((host, decision.allowed, decision.reason), (host, False, "private_destination"))
        # A spoofed Host header cannot make a metadata request look like an allowed one.
        spoofed = policy.evaluate_request(rs, "GET", "169.254.169.254", 80, "/latest/meta-data/",
                                          host_headers=["api.github.com"])
        self.assertFalse(spoofed.allowed)


class ResolutionTests(unittest.TestCase):
    def test_public_answers_are_allowed(self):
        decision = policy.evaluate_resolved(rules(*DEFAULTS), "api.github.com", 443, ["140.82.112.5"])
        self.assertTrue(decision.allowed)

    def test_private_answer_for_a_public_name_is_denied(self):
        rs = rules(*DEFAULTS)
        for answers in (["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["140.82.112.5", "172.18.0.2"],
                        ["::1"], ["::ffff:10.0.0.5"]):
            decision = policy.evaluate_resolved(rs, "rebind.example", 443, answers)
            self.assertEqual((answers, decision.allowed, decision.reason),
                             (answers, False, "resolves_to_private"))

    def test_internal_rule_admits_private_answers(self):
        rs = rules("* ollama:11434/** !internal", "* *.svc.cluster.local/** !internal")
        self.assertTrue(policy.evaluate_resolved(rs, "ollama", 11434, ["172.18.0.9"]).allowed)
        self.assertTrue(policy.evaluate_resolved(rs, "api.default.svc.cluster.local", 80, ["10.43.0.10"]).allowed)
        self.assertFalse(policy.evaluate_resolved(rs, "ollama", 80, ["172.18.0.9"]).allowed)

    def test_unresolvable(self):
        self.assertEqual(policy.evaluate_resolved(rules(*DEFAULTS), "x.example", 443, []).reason, "unresolvable")

    def test_pins_to_first_ipv4_answer(self):
        self.assertEqual(policy.pick_address(["2606:50c0::1", "140.82.112.5", "140.82.112.6"]), "140.82.112.5")
        self.assertEqual(policy.pick_address(["2606:50c0::1"]), "2606:50c0::1")


class AuthorityParsingTests(unittest.TestCase):
    def test_split_authority(self):
        self.assertEqual(policy.split_authority("api.github.com:443"), ("api.github.com", 443))
        self.assertEqual(policy.split_authority("api.github.com"), ("api.github.com", None))
        self.assertEqual(policy.split_authority("[::1]:8080"), ("::1", 8080))
        self.assertEqual(policy.split_authority("[::1]"), ("::1", None))
        self.assertEqual(policy.split_authority("a.example:http"), ("a.example", -1))

    def test_authority_matches(self):
        self.assertTrue(policy.authority_matches("api.github.com", 443, "API.github.com.:443"))
        self.assertFalse(policy.authority_matches("api.github.com", 443, "api.github.com:8443"))
        self.assertFalse(policy.authority_matches("api.github.com", 443, ""))
        self.assertTrue(policy.authority_matches("127.0.0.1", 80, "127.1:80"))


if __name__ == "__main__":
    unittest.main()
