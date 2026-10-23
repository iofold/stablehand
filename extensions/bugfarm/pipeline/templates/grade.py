"""Bugfarm grader: reward 1 iff every fail-to-pass and pass-to-pass test passed.

Usage: python grade.py <pytest.log> <expected.json> <report.json>  (prints the reward)

Parses pytest's short test summary (run with -rfEXxp), the same format the pipeline used to pick the
tests, so node ids match exactly. If the interpreter died before the summary (a segfault, say), the
verbose per-test lines are used instead. A test missing from the log counts as not passed.
Keep in sync with parseOutput() in pipeline/lib/pytest.ts.
"""

import json
import re
import sys

SUMMARY = re.compile(r"^(PASSED|FAILED|ERROR|XFAIL|XPASS) (.+)$")
VERBOSE = re.compile(r"^(\S.*?::.*?) (PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)(?: \(.*\))?\s*$")
OUTCOME = {"PASSED": "passed", "FAILED": "failed", "ERROR": "error", "XFAIL": "xfailed", "XPASS": "xpassed"}


def _worse(prev, new):
    return new if prev is None or prev == "passed" else prev


def parse(text):
    summary, verbose, has_summary = {}, {}, False
    for raw in text.splitlines():
        line = raw.rstrip()
        m = SUMMARY.match(line)
        if m:
            has_summary = True
            kind, rest = m.group(1), m.group(2)
            if kind not in ("PASSED", "XPASS"):
                sep = rest.find(" - ")
                if sep > 0:
                    rest = rest[:sep]
            test_id = rest.strip()
            if kind == "ERROR" and "::" not in test_id:
                continue  # module collection error; its tests are simply missing
            summary[test_id] = _worse(summary.get(test_id), OUTCOME[kind])
            continue
        v = VERBOSE.match(line)
        if v and v.group(2) != "SKIPPED":
            verbose[v.group(1)] = _worse(verbose.get(v.group(1)), OUTCOME[v.group(2)])
    if not has_summary:
        return verbose
    for test_id, outcome in verbose.items():
        summary.setdefault(test_id, outcome)
    return summary


def main():
    log_path, expected_path, report_path = sys.argv[1:4]
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            outcomes = parse(f.read())
    except OSError:
        outcomes = {}
    with open(expected_path, encoding="utf-8") as f:
        expected = json.load(f)
    f2p = expected["fail_to_pass"]
    p2p = expected["pass_to_pass"]
    f2p_bad = [t for t in f2p if outcomes.get(t) != "passed"]
    p2p_bad = [t for t in p2p if outcomes.get(t) != "passed"]
    reward = 1 if (f2p and not f2p_bad and not p2p_bad) else 0
    report = {
        "reward": reward,
        "fail_to_pass": {"total": len(f2p), "not_passed": len(f2p_bad), "examples": f2p_bad[:20]},
        "pass_to_pass": {"total": len(p2p), "not_passed": len(p2p_bad), "examples": p2p_bad[:20]},
        "outcomes_parsed": len(outcomes),
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(reward)


if __name__ == "__main__":
    main()
