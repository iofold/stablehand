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


if __name__ == "__main__":
    unittest.main()
