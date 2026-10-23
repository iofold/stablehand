# Bugfarm pipeline (deterministic spike)

Turns a GitHub repo's bug-fix history into [Harbor](https://harborframework.com) coding tasks with no
model calls. Each task has:

- the repo in its buggy state, without `.git`;
- an instruction (a placeholder until a Writer agent replaces it);
- hidden tests that fail before the fix and pass after it;
- the fix, as the reference solution.

This is the deterministic half of the Bugfarm worker (`docs/plans/proposals/2026-10-23-bugfarm.md`).
The agent-driven version swaps two seams for agents: the env Dockerfile (`buildEnvFromDockerfile`)
and the instruction text (`placeholderInstruction`).

## Method

1. **`scout`.** Blobless clone (`--filter=blob:none`). Walk HEAD's **first-parent** history since
   2026-01-01, so each squash commit or merged PR counts as one unit of change. Keep a unit when:
   - its message (the PR title, for merges) looks like a fix;
   - it touches package source and a test module;
   - it changes 5 files or fewer, ignoring docs and changelogs;
   - it changes 30 lines or fewer outside tests.

   The file filters read trees only. `numstat` then fetches blobs for the survivors alone. Scout
   also builds each repo's env and times the full suite at HEAD, then ranks repos by candidate count,
   discounting suites slower than 2 minutes.
2. **`build_env`.** One image per repo at HEAD, `bugfarm/env-<slug>:<sha12>`, labelled `bugfarm=1`.
   It installs the repo in editable mode plus its test dependencies, then confirms that
   `pytest --collect-only` works. The Dockerfiles are hand-written in `lib/repos.ts`.
   `buildEnvFromDockerfile` takes Dockerfile text and returns the logs and a pass/fail verdict.
3. **`check_candidate`** uses three states, following SWE-gen. The env is built once at HEAD, so
   there is no dependency drift.

   | State | Contents |
   |---|---|
   | fixed | HEAD |
   | buggy | HEAD with the fix's source diff reverse-applied. Tests stay at HEAD, so the fix's tests are present. |
   | agent | buggy with the fix's test diff also reverse-applied. This is what the solver sees: the new tests are hidden. |

   Reverting tries an exact `git apply -R` first. If that fails because later commits moved the
   context lines, it falls back to a per-file 3-way merge with `git merge-file` (HEAD, the fix, the
   fix's parent), which is what `git revert` does. The solution patch is then regenerated as
   `diff(buggy → HEAD)`, so `solve.sh` always applies.

   - Run the test modules the fix touched, 3 times on buggy and 3 times on fixed. Fail-to-pass
     tests are those that fail in every buggy run and pass in every fixed run. Anything that changes
     outcome between runs is `flaky`.
   - Run the full suite once on buggy. Pass-to-pass tests are those that also passed in both cached
     HEAD runs.
   - Every reject gets a reason: `reverse_patch_conflict`, `no_test_targets`, `no_fail_to_pass`,
     `import_error_only` (fail-to-pass only because the module can't import), `flaky`, `timeout`,
     `env_build_failed`, `check_error`.
4. **`package_task`.** Writes a Harbor 0.24 task to `.work/tasks/<slug>/<slug>-<sha10>/` and one
   SWE-bench-style row to `.work/results/<slug>/swebench.jsonl`.
   - The instruction comes from the commit or PR message, with a canary comment and never the diff.
   - `task.toml` carries `[metadata.bugfarm]` provenance and sets `environment_mode = "separate"`
     and `network_mode = "no-network"`.
   - `environment/docker-compose.yaml` forces `network_mode: none`.
   - `tests/test.sh` overlays the hidden tests, runs the suite and grades it with `tests/grade.py`,
     which writes `/logs/verifier/reward.txt`.
   - `solution/solve.sh` is executable and runs `git apply` on the fix.
5. **`controls`.** Runs `harbor run -a oracle` (must score 1) and `-a nop` (must score 0) on local
   Docker. Failures are `oracle_failed`, `nop_passed` or `control_error`.
6. **`run`.** Chains all of the above for N candidates, prints the funnel and writes
   `.work/results/<slug>/funnel.json`.

## Commands

Requirements: Node 22.6 or later (tested on 24.13), git, Docker and `uv`. Harbor comes from
`uvx --from harbor==0.24.0`. Run everything from this directory:

```bash
node --experimental-strip-types cli.ts scout                      # all six shortlist repos -> .work/results/scout.json
node --experimental-strip-types cli.ts scout --repos fastapi/fastapi --no-suite
node --experimental-strip-types cli.ts build-env fastapi/fastapi [--dockerfile path] [--force]
node --experimental-strip-types cli.ts check fastapi/fastapi --limit 30 --concurrency 3
node --experimental-strip-types cli.ts package fastapi/fastapi
node --experimental-strip-types cli.ts controls fastapi/fastapi [--tasks fastapi-abc123,fastapi-def456]
node --experimental-strip-types cli.ts run fastapi/fastapi --limit 30   # scout -> ... -> controls + funnel
node --experimental-strip-types cli.ts clean                      # remove leftover bugfarm=1 containers
node --experimental-strip-types cli.ts prune-cache [--all] [--dry-run]   # drop this pipeline's build-cache records
```

`npx tsx cli.ts ...` also works. Imports use `.ts` extensions, and the code uses only erasable
TypeScript syntax: no enums and no parameter properties. Set `BUGFARM_WORK_DIR` to move `.work/`,
and `BUGFARM_SINCE` to change the mining cutoff.

Outputs, all under `.work/` (gitignored):

| Path | Contents |
|---|---|
| `clones/` | blobless clones |
| `trees/<slug>/HEAD` | exported HEAD tree: the fixed state and the build context |
| `trees/<slug>/<sha12>/` | patches, plus the agent tree for accepted candidates |
| `results/<slug>/` | `candidates.json`, `env.json`, `env-build.log`, `head-suite.json`, `checks/*.json`, `controls.json`, `swebench.jsonl`, `funnel.json` |
| `tasks/<slug>/` | the Harbor dataset |
| `jobs/` | Harbor job dirs (always passed as an absolute `--jobs-dir`) |

## Pilot results (2026-10-23, dev1)

**Scout.** Window: 2026-01-01 to HEAD. Suite times are one HEAD run in the env image; dev1's load
average was about 25 on 8 cores at the time.

| Repo | Units since 2026-01 | Candidates | Suite at HEAD |
|---|---|---|---|
| fastapi/fastapi | 1442 | 26 | 116 s, 4713 passed, 0 failed |
| pydantic/pydantic | 518 | 23 | 79 s including 3 segfault retries; 15 fail at HEAD |
| Textualize/rich | 48 | 5 | 9 s |
| python-attrs/attrs | 113 | 3 | 15 s |
| Textualize/textual | 70 | 2 | 369 s |
| encode/httpx | 1 | 0 | 8 s |

fastapi is the pilot: the most candidates, a suite under 2 minutes, and a clean HEAD.

**fastapi funnel**, at concurrency 3 for checks and `-n 2` for Harbor:

| Stage | Count |
|---|---|
| Commits | 1442 |
| Fix-like messages | 73 |
| Touch source and tests | 32 |
| 5 files or fewer | 30 |
| 30 non-test lines or fewer | 26 |
| Checked | 26 |
| Fail-to-pass | 12 |
| Packaged | 12 |
| Controls passed | 12 (oracle 1, nop 0) |

Rejections: `reverse_patch_conflict` 11, `no_fail_to_pass` 2, `import_error_only` 1.

**Time.**

| Stage | Time |
|---|---|
| Env build (reused) and collect | 21 s |
| HEAD baseline | 116 s + 134 s |
| `check_candidate` | 129 s mean (190–340 s accepted, about 1 s for patch rejects) |
| Check stage wall | 18.7 min |
| Package 12 tasks | 23 s |
| Oracle controls | 19.1 min |
| Nop controls | 21.2 min |
| Total wall | 60 min |

A Harbor trial costs about 60 s of overhead (build, sidecar, a second env for the verifier) plus
the full suite.

**Disk.**

| Item | Size |
|---|---|
| `.work/` at peak | 1.33 GB (clones 0.24, trees 0.57, tasks 0.46) |
| fastapi env image | 780 MB |
| Build cache per task build | about 62 MB, now pruned automatically |

## Gotchas hit in the spike

- **Reverting at HEAD loses fixes in churned files.** On fastapi, 11 of 26 candidates conflict even
  with the 3-way fallback, mostly in `fastapi/dependencies/utils.py` and `routing.py`, because later
  commits rewrote the same lines. The 3-way fallback rescued only 1 extra candidate. The next step
  is a per-candidate fallback: buggy = the fix's parent tree, fixed = the fix tree, run on the HEAD
  env. That costs one extra suite run per candidate and risks dependency drift; whether it pays
  needs measuring.
- **Merge-based repos (rich, textual).** With `--no-merges` over all history, most "fix" commits
  are work in progress on PR branches, and their diffs were superseded before the merge. 5 of 6 rich
  candidates hit `reverse_patch_conflict`. Mining PR-level units (`--first-parent
  --diff-merges=first-parent`, titled by the PR title) fixes this.
- **`git apply` inside the Stablehand checkout.** `.work/` sits inside a git repo, so `git apply`
  would discover it, resolve paths against the wrong root and silently skip files. We set
  `GIT_CEILING_DIRECTORIES` to the tree's parent.
- **pytest's defaults hide outcomes.**
  - One collection error aborts the whole run, so we pass `--continue-on-collection-errors`.
  - One segfaulting test kills the summary. In pydantic, a recursion test segfaults against the
    released core wheel. We run with `-v` and fall back to the per-test lines, detect the test that
    crashed, deselect it and rerun. HEAD crashers are stored in `head-suite.json` and deselected by
    the verifier too.
  - `pytest-sugar` and `pytest-pretty` rewrite the output, so they are blocked with
    `-p no:sugar -p no:pretty` and uninstalled from env images.
- **Check runs mimic Harbor's verifier.** The tree is mounted read-only at `/src` and copied to a
  writable `/app`, and tests run as root. Tests that depend on root or on a writable tree then
  behave the same in the check as in the controls, and nothing root-owned lands in `.work/`.
- **Harbor networking.**
  - `network_mode = "no-network"` starts an nftables egress sidecar per environment. A probe shows
    that main with `network_mode: none` has only `lo`, no DNS and no route.
  - The sidecar still starts, and on its own compose network, even though main never joins it. So
    each trial runs 2 containers, and controls use `-n 2` to stay within 4 containers.
  - The compose override is what actually guarantees no network on local Docker. `task.toml` still
    declares no-network so that other runners enforce it.
- **Separate verifier.** Only the dirs listed in `task.toml` `artifacts` (the package source) cross
  from the agent's container to the fresh verifier container. Anything else the agent changes,
  including tests, conftest, `pyproject` and site-packages, is dropped. That is the point, but it
  also means fixes outside the source dirs are invisible.
- **Harbor leaves build cache.** `--delete` runs `compose down --rmi local`, which removes task images but keeps their build-cache records: a tree-sized COPY layer per task. Task Dockerfiles copy from `environment/bugfarm-repo/`, so `pruneOwnBuildCache` (run after controls, or `cli.ts prune-cache [--all]`) can match records by steps that only this pipeline uses.
- **Harbor housekeeping.**
  - Harbor names compose projects `<trial>__env` and `<trial>__verifier__trial`. Its sidecar does
    not carry our label, so cleanup matches on the compose project of every trial in the job dir and
    runs even when Harbor fails or is killed.
  - Set `HARBOR_TELEMETRY=0`: Harbor sends PostHog events by default.
  - `--jobs-dir` must be absolute.
- **The env image contains the fixed source in a lower layer.** The task Dockerfile runs
  `rm -rf /app`, so the solver can't see it in the container. But don't publish task images built
  this way; publish the Dockerfiles. Installs use `PIP_NO_CACHE_DIR`, and the editable install
  replaces any released copy of the package that a test dependency pulled in.
- **pydantic** now vendors its Rust core in the repo. The env installs the released
  `pydantic-core` wheel, so commits touching `pydantic-core/` are skipped.
- **Version metadata.** attrs needs `SETUPTOOLS_SCM_PRETEND_VERSION` because the tree has no `.git`.
