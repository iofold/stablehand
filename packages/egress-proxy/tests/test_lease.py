"""Session leases: header parsing, per-mode rule composition and the orchestrator check.
Pure Python; runs anywhere (python3 -m unittest discover -s packages/egress-proxy/tests)."""
import asyncio
import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "addon"))

import lease  # noqa: E402
import policy  # noqa: E402


def basic(value: str) -> str:
    return "Basic " + base64.b64encode(value.encode()).decode()


RULE_SETS = lease.RuleSets(
    runtime=tuple(policy.parse_rules(["* api.openai.com/**"], "runtime")),
    defaults=tuple(policy.parse_rules(["* github.com/**", "* pypi.org/**"], "defaults")),
)
CREDS = lease.LeaseCredentials("sess-1", "tok-1")


def answer(mode, rules=None, runtime=None, session="sess-1", agent="agent-1"):
    egress = {"mode": mode}
    if rules is not None:
        egress["rules"] = rules
    payload = {"sessionId": session, "agentId": agent, "egress": egress}
    if runtime is not None:
        payload["runtimeRules"] = runtime
    return payload


def allowed(session_policy, method, host, path="/"):
    return policy.evaluate(list(session_policy.rules), method, host, 443, path).allowed


class ParseProxyAuthorizationTests(unittest.TestCase):
    def test_no_header_is_no_lease(self):
        self.assertIsNone(lease.parse_proxy_authorization(None))
        self.assertIsNone(lease.parse_proxy_authorization("  "))

    def test_basic_session_and_token(self):
        creds = lease.parse_proxy_authorization(basic("3e98a63a-5c88-4f1d-80bd-a1d636545c4b:YWdlbnQ.c2ln-_x"))
        self.assertEqual(creds.session_id, "3e98a63a-5c88-4f1d-80bd-a1d636545c4b")
        self.assertEqual(creds.token, "YWdlbnQ.c2ln-_x")
        self.assertNotIn("YWdlbnQ", repr(creds))  # the token never reaches a log line via repr

    def test_malformed_credentials_are_invalid_not_absent(self):
        for value in ("Bearer abc", "Basic", "Basic !!!", basic("no-colon"), basic(":tok"),
                      basic("sess:"), basic("sess/../x:tok"), basic("sess:tok with space")):
            with self.subTest(value=value), self.assertRaises(lease.InvalidLease):
                lease.parse_proxy_authorization(value)


class PolicyCompositionTests(unittest.TestCase):
    def test_server_policy_is_runtime_plus_defaults(self):
        server = lease.server_policy(RULE_SETS)
        self.assertEqual(server.source, "server")
        self.assertTrue(allowed(server, "GET", "github.com"))
        self.assertTrue(allowed(server, "POST", "api.openai.com"))

    def test_default_mode_matches_the_server_rules(self):
        session = lease.policy_from_lease(RULE_SETS, CREDS, answer("default"))
        self.assertEqual((session.source, session.mode, session.agent_id), ("agent:default", "default", "agent-1"))
        self.assertEqual(session.rules, RULE_SETS.server_rules())

    def test_deny_mode_keeps_only_runtime_rules(self):
        session = lease.policy_from_lease(RULE_SETS, CREDS, answer("deny"))
        self.assertEqual(session.source, "agent:deny")
        self.assertTrue(allowed(session, "POST", "api.openai.com", "/v1/responses"))
        self.assertFalse(allowed(session, "GET", "github.com"))
        self.assertFalse(allowed(session, "GET", "pypi.org"))

    def test_deny_mode_with_rules_is_a_strict_allowlist(self):
        session = lease.policy_from_lease(RULE_SETS, CREDS, answer("deny", ["GET pypi.org/simple/**"]))
        self.assertTrue(allowed(session, "GET", "pypi.org", "/simple/requests/"))
        self.assertFalse(allowed(session, "GET", "github.com"))

    def test_allow_mode_adds_agent_rules_on_top_of_defaults(self):
        session = lease.policy_from_lease(RULE_SETS, CREDS, answer("allow", ["GET *", "HEAD *"]))
        self.assertTrue(allowed(session, "GET", "news.example.org", "/a"))
        self.assertFalse(allowed(session, "POST", "news.example.org", "/a"))
        self.assertTrue(allowed(session, "POST", "github.com"))
        agent_rule = policy.evaluate(list(session.rules), "GET", "news.example.org", 443, "/").rule
        self.assertEqual(agent_rule.source, "agent:agent-1:1")

    def test_orchestrator_runtime_rules_apply_in_every_mode(self):
        for mode, rules in (("default", None), ("deny", None), ("allow", ["GET *"])):
            session = lease.policy_from_lease(
                RULE_SETS, CREDS, answer(mode, rules, runtime=["* s3.example.com/**"]))
            self.assertTrue(allowed(session, "PUT", "s3.example.com", "/bucket/key"), mode)

    def test_agent_and_orchestrator_rules_never_open_private_destinations(self):
        for payload in (answer("allow", ["* * !internal"]), answer("deny", runtime=["* minio:9000/** !internal"])):
            with self.subTest(payload=payload), self.assertRaises(lease.PolicyError):
                lease.policy_from_lease(RULE_SETS, CREDS, payload)
        # A plain rule naming a private host stays refused by the private-destination guard.
        session = lease.policy_from_lease(RULE_SETS, CREDS, answer("allow", ["* 10.0.0.5/**"]))
        decision = policy.evaluate(list(session.rules), "GET", "10.0.0.5", 80, "/")
        self.assertEqual((decision.allowed, decision.reason), (False, "private_destination"))

    def test_bad_answers_fail_closed(self):
        bad = (
            None,
            [],
            answer("default", ["GET *"]),
            answer("open"),
            answer("deny", session="sess-2"),
            {**answer("deny"), "agentId": ""},
            {**answer("deny"), "egress": None},
            answer("allow", "GET *"),
            answer("allow", ["not a rule"]),
            answer("allow", [""]),
            answer("allow", ["GET *"] * (lease.MAX_AGENT_RULES + 1)),
        )
        for payload in bad:
            with self.subTest(payload=payload), self.assertRaises(lease.PolicyError):
                lease.policy_from_lease(RULE_SETS, CREDS, payload)


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class ScriptedFetch:
    """Answers each orchestrator call from a script; records every call."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    async def __call__(self, url, body):
        self.calls.append((url, body))
        response = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(response, Exception):
            raise response
        return response


def verifier(fetch, clock=None, url="http://orchestrator:3001/api/egress/lease"):
    return lease.LeaseVerifier(url, fetch, clock=clock or FakeClock())


def run(coroutine):
    return asyncio.run(coroutine)


class LeaseVerifierTests(unittest.TestCase):
    def test_valid_answer_is_cached_for_the_ttl_it_names(self):
        clock = FakeClock()
        fetch = ScriptedFetch((200, {**answer("deny"), "ttlSeconds": 10}))
        check = verifier(fetch, clock)
        self.assertEqual(run(check.verify(CREDS)).kind, "valid")
        clock.now += 9
        self.assertEqual(run(check.verify(CREDS)).kind, "valid")
        self.assertEqual(len(fetch.calls), 1)
        clock.now += 2
        run(check.verify(CREDS))
        self.assertEqual(len(fetch.calls), 2)
        self.assertIn(b'"token": "tok-1"', fetch.calls[0][1])

    def test_ttl_is_capped(self):
        clock = FakeClock()
        fetch = ScriptedFetch((200, {**answer("deny"), "ttlSeconds": 86400}))
        check = verifier(fetch, clock)
        run(check.verify(CREDS))
        clock.now += check.max_ttl + 1
        run(check.verify(CREDS))
        self.assertEqual(len(fetch.calls), 2)

    def test_rejections_are_invalid_and_cached_briefly(self):
        clock = FakeClock()
        fetch = ScriptedFetch((410, {"error": "Session ended", "code": "session_ended"}))
        check = verifier(fetch, clock)
        outcome = run(check.verify(CREDS))
        self.assertEqual((outcome.kind, outcome.detail), ("invalid", "session_ended"))
        run(check.verify(CREDS))
        self.assertEqual(len(fetch.calls), 1)
        clock.now += check.negative_ttl + 1
        run(check.verify(CREDS))
        self.assertEqual(len(fetch.calls), 2)
        for status in (400, 401, 403, 404):
            self.assertEqual(run(verifier(ScriptedFetch((status, None))).verify(CREDS)).kind, "invalid")

    def test_outage_keeps_a_recent_valid_answer_then_fails_closed(self):
        clock = FakeClock()
        fetch = ScriptedFetch((200, answer("deny")), (503, None), ConnectionRefusedError())
        check = verifier(fetch, clock)
        self.assertEqual(run(check.verify(CREDS)).kind, "valid")
        clock.now += check.default_ttl + 1
        self.assertEqual(run(check.verify(CREDS)).kind, "valid")  # 503: last answer still good
        clock.now += check.stale_grace
        outcome = run(check.verify(CREDS))  # refused connection, and the last answer is too old
        self.assertEqual((outcome.kind, outcome.detail), ("unavailable", "ConnectionRefusedError"))

    def test_outage_without_a_previous_answer_is_unavailable(self):
        for response in ((500, None), (429, None), TimeoutError()):
            with self.subTest(response=response):
                self.assertEqual(run(verifier(ScriptedFetch(response)).verify(CREDS)).kind, "unavailable")
        self.assertEqual(run(verifier(ScriptedFetch((200, {})), url="").verify(CREDS)).kind, "unavailable")

    def test_a_rejection_forgets_the_previous_valid_answer(self):
        clock = FakeClock()
        fetch = ScriptedFetch((200, answer("deny")), (410, None), (500, None))
        check = verifier(fetch, clock)
        run(check.verify(CREDS))
        clock.now += check.default_ttl + 1
        self.assertEqual(run(check.verify(CREDS)).kind, "invalid")
        clock.now += check.negative_ttl + 1
        self.assertEqual(run(check.verify(CREDS)).kind, "unavailable")

    def test_different_tokens_for_one_session_are_checked_separately(self):
        fetch = ScriptedFetch((200, answer("deny")), (401, None))
        check = verifier(fetch)
        self.assertEqual(run(check.verify(CREDS)).kind, "valid")
        self.assertEqual(run(check.verify(lease.LeaseCredentials("sess-1", "forged"))).kind, "invalid")

    def test_concurrent_checks_share_one_call(self):
        class SlowFetch(ScriptedFetch):
            async def __call__(self, url, body):
                await asyncio.sleep(0.05)
                return await super().__call__(url, body)

        fetch = SlowFetch((200, answer("deny")))
        check = verifier(fetch)

        async def many():
            return await asyncio.gather(*(check.verify(CREDS) for _ in range(20)))

        outcomes = run(many())
        self.assertEqual({outcome.kind for outcome in outcomes}, {"valid"})
        self.assertEqual(len(fetch.calls), 1)

    def test_cache_is_bounded(self):
        fetch = ScriptedFetch((200, answer("deny")))
        check = lease.LeaseVerifier("http://x", fetch, clock=FakeClock(), max_entries=3)
        for index in range(10):
            run(check.verify(lease.LeaseCredentials(f"s{index}", "t")))
        self.assertLessEqual(len(check._cache), 3)
        self.assertLessEqual(len(check._last_valid), 3)


if __name__ == "__main__":
    unittest.main()
