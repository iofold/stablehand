#!/usr/bin/env python3
"""Bugfarm Scout helper: find merged bug-fix pull requests. Standard library only.

  python3 mine_prs.py units   --repo fastapi/fastapi --since 2025-07-01 [--limit 80]
  python3 mine_prs.py details --repo fastapi/fastapi --prs 14512,14530 [--out picks.json]

`units` needs no API calls: it keeps a blobless clone under ~/.cache/bugfarm and lists each
first-parent unit of change (a squash commit or a merged PR) since the date that changes package
source and a test module, with its PR number, files and size. Rejected units are counted, not
listed.

`details` calls the GitHub REST API for the PRs you name: title, body, merge commit, labels and
the issue each one closes (body text truncated). Unauthenticated calls are limited to 60 an hour,
so ask only for your shortlist. Set GITHUB_TOKEN to lift the limit. It prints JSON, and with
--out also writes it to a file.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

CACHE = os.path.expanduser("~/.cache/bugfarm")
MAX_FILES = 5
MAX_NON_TEST_LINES = 30
BODY_CHARS = 1200

# Same rules as the worker's check (pipeline/lib/repos.ts), so what the Scout keeps, the check accepts.
DOC_RE = re.compile(r"(^|/)(docs?|changelog\.d|news|\.github)/|(^|/)(CHANGELOG|HISTORY|CHANGES|README|CONTRIBUTING)[^/]*$|\.(md|rst)$", re.I)
TEST_FILE_RE = re.compile(r"(^|/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$")
TEST_MODULE_RE = re.compile(r"(^|/)(test_[^/]*|[^/]*_test)\.py$")
PR_RE = re.compile(r"\(#(\d+)\)\s*$|^Merge pull request #(\d+)")
CLOSES_RE = re.compile(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:[\w.-]+/[\w.-]+)?#(\d+)", re.I)


def git(*args, cwd=None):
    out = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"git {' '.join(args[:3])} failed: {out.stderr.strip()[-600:]}")
    return out.stdout


def clone(repo):
    path = os.path.join(CACHE, repo.replace("/", "__"))
    if os.path.isdir(os.path.join(path, ".git")):
        git("fetch", "--quiet", "--filter=blob:none", "origin", cwd=path)
        git("reset", "--quiet", "--soft", "FETCH_HEAD", cwd=path)
    else:
        os.makedirs(CACHE, exist_ok=True)
        git("clone", "--quiet", "--filter=blob:none", "--no-checkout", f"https://github.com/{repo}.git", path)
    return path


SOURCE_DIRS = []
TEST_DIRS = ["tests"]


def under(path, dirs):
    return any(path == d or path.startswith(d.rstrip("/") + "/") for d in dirs)


def classify(path):
    if under(path, TEST_DIRS) or TEST_FILE_RE.search(path):
        return "test"
    if SOURCE_DIRS and under(path, SOURCE_DIRS):
        return "source"
    if DOC_RE.search(path):
        return "doc"
    if not SOURCE_DIRS and path.endswith((".py", ".pyi")):
        return "source"
    return "other"


def units(args):
    if args.source_dirs:
        SOURCE_DIRS[:] = [d for d in args.source_dirs.split(",") if d]
    if args.test_dirs:
        TEST_DIRS[:] = [d for d in args.test_dirs.split(",") if d]
    path = clone(args.repo)
    head = git("rev-parse", "HEAD", cwd=path).strip()
    log = git("log", "--first-parent", "--diff-merges=first-parent", "--no-renames", f"--since={args.since}",
              "--format=%x1e%H%x1f%P%x1f%cI%x1f%s%x1f%b%x1d", "--name-only", head, cwd=path)
    counts = {"units": 0, "no_pr_number": 0, "no_source_and_test": 0, "too_many_files": 0, "too_many_lines": 0, "kept": 0}
    keep = []
    for rec in log.split("\x1e"):
        if not rec.strip():
            continue
        head_part, _, files_part = rec.partition("\x1d")
        sha, parents, date, subject, body = (head_part.split("\x1f") + [""] * 5)[:5]
        counts["units"] += 1
        m = PR_RE.search(subject)
        title = subject
        if subject.startswith("Merge pull request"):
            title = next((line.strip() for line in body.splitlines() if line.strip()), subject)
        if not m:
            counts["no_pr_number"] += 1
            continue
        pr = int(m.group(1) or m.group(2))
        files = [f for f in files_part.split("\n") if f.strip()]
        kinds = {f: classify(f) for f in files}
        source = [f for f, k in kinds.items() if k == "source"]
        tests = [f for f, k in kinds.items() if k == "test"]
        other = [f for f, k in kinds.items() if k == "other"]
        if not any(f.endswith((".py", ".pyi")) for f in source) or not any(TEST_MODULE_RE.search(t) for t in tests):
            counts["no_source_and_test"] += 1
            continue
        if len(source) + len(tests) + len(other) > MAX_FILES:
            counts["too_many_files"] += 1
            continue
        keep.append({"sha": sha, "pr": pr, "date": date, "title": re.sub(r"\s*\(#\d+\)\s*$", "", title),
                     "source_files": source, "test_files": tests})
    # Line counts need blobs; fetch them only for the survivors, in one batch.
    if keep:
        out = git("log", "--no-walk=unsorted", "--diff-merges=first-parent", "--no-renames", "--numstat",
                  "--format=%x1e%H", *[u["sha"] for u in keep], cwd=path)
        lines = {}
        for rec in out.split("\x1e"):
            if not rec.strip():
                continue
            sha, *rows = rec.strip().split("\n")
            n = 0
            for row in rows:
                parts = row.split("\t")
                if len(parts) < 3 or classify(parts[2]) in ("test", "doc"):
                    continue
                n += (int(parts[0]) if parts[0].isdigit() else 0) + (int(parts[1]) if parts[1].isdigit() else 0)
            lines[sha.strip()] = n
        survivors = []
        for u in keep:
            u["non_test_lines"] = lines.get(u["sha"], 0)
            if u["non_test_lines"] > MAX_NON_TEST_LINES:
                counts["too_many_lines"] += 1
            else:
                survivors.append(u)
        keep = survivors
    counts["kept"] = len(keep)
    # One unit per line keeps the listing short enough to read in full.
    print(json.dumps({"repo": args.repo, "head": head, "since": args.since, "counts": counts}, ensure_ascii=False))
    for u in keep[: args.limit]:
        print(json.dumps(u, ensure_ascii=False))


def api(path):
    req = urllib.request.Request(f"https://api.github.com{path}", headers={
        "Accept": "application/vnd.github+json", "User-Agent": "bugfarm-scout", "X-GitHub-Api-Version": "2022-11-28"})
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode()), int(res.headers.get("X-RateLimit-Remaining", "60"))
    except urllib.error.HTTPError as err:
        remaining = int(err.headers.get("X-RateLimit-Remaining", "0") or 0)
        return {"error": f"HTTP {err.code}: {err.read().decode()[:300]}"}, remaining


def clip(text):
    text = (text or "").replace("\r", "").strip()
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S).strip()
    return text if len(text) <= BODY_CHARS else text[:BODY_CHARS] + " [...]"


def details(args):
    prs = [int(p) for p in re.split(r"[,\s]+", args.prs) if p.strip()]
    results, remaining = [], 60
    for pr in prs:
        if remaining <= 2:
            results.append({"pr": pr, "error": "stopped: GitHub API rate limit nearly used up"})
            continue
        data, remaining = api(f"/repos/{args.repo}/pulls/{pr}")
        if "error" in data:
            results.append({"pr": pr, "error": data["error"]})
            continue
        body = data.get("body") or ""
        entry = {
            "pr": pr,
            "title": data.get("title"),
            "url": data.get("html_url"),
            "merged_at": data.get("merged_at"),
            "merge_commit_sha": data.get("merge_commit_sha"),
            "labels": [label.get("name") for label in data.get("labels", [])],
            "additions": data.get("additions"),
            "deletions": data.get("deletions"),
            "pr_body": clip(body),
            "issue": None,
        }
        refs = [int(n) for n in CLOSES_RE.findall(body) if int(n) != pr]
        if refs and remaining > 2:
            issue, remaining = api(f"/repos/{args.repo}/issues/{refs[0]}")
            if "error" not in issue and "pull_request" not in issue:
                entry.update({"issue": refs[0], "issue_title": issue.get("title"), "issue_body": clip(issue.get("body"))})
        results.append(entry)
    out = {"repo": args.repo, "rate_limit_remaining": remaining, "prs": results}
    text = json.dumps(out, indent=1, ensure_ascii=False)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
    print(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("units")
    u.add_argument("--repo", required=True)
    u.add_argument("--since", required=True)
    u.add_argument("--limit", type=int, default=80)
    u.add_argument("--source-dirs", help="package source dirs, comma-separated (default: any .py outside tests and docs)")
    u.add_argument("--test-dirs", help="test dirs, comma-separated (default: tests)")
    d = sub.add_parser("details")
    d.add_argument("--repo", required=True)
    d.add_argument("--prs", required=True)
    d.add_argument("--out")
    args = parser.parse_args()
    {"units": units, "details": details}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
