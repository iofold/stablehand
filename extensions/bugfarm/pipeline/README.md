# Bugfarm pipeline

Turns a GitHub repo's bug-fix history into [Harbor](https://harborframework.com) coding tasks with no
model calls. Each task has:

- the repo in its buggy state, without `.git`;
- an instruction (a placeholder until a Writer agent replaces it);
- hidden tests that fail before the fix and pass after it;
- the fix, as the reference solution.

This is the deterministic half of the Bugfarm worker (`docs/plans/proposals/2026-10-23-bugfarm.md`).
The worker runs these steps as jobs and swaps three seams for floor agents: which pull requests to
mine (the Scout, `candidateFromUnit`), the env Dockerfile (the Env builder, `buildEnvFromDockerfile`)
and the instruction text (the Writer, `packageTask(..., { instruction })`). The CLI below still runs
the whole pipeline by hand, with no model calls.

[Calibration](#calibration-calibratets) is the first stage that calls models: it measures each
packaged task's difficulty per model family and keeps the tasks in a useful band.

## Method

1. **`scout`.** Blobless clone (`--filter=blob:none`). Walk HEAD's **first-parent** history since
   2025-07-01 (`BUGFARM_SINCE`), so each squash commit or merged PR counts as one unit of change.
   Every task records its fix date, so decontamination can filter by a model's cutoff later. Keep a
   unit when:
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
3. **`check_candidate`** uses three states, following SWE-gen. The env is always the one built
   at HEAD. The buggy state comes from HEAD when the fix still reverts there, and from the fix's
   parent commit when it does not:

   | State | HEAD base (preferred) | Parent base (fallback) |
   |---|---|---|
   | fixed | HEAD | the fix commit's tree |
   | buggy | HEAD with the fix's source diff reverted; tests stay at HEAD, so the fix's tests are present | the fix's parent with the fix's test files overlaid |
   | agent | buggy with the fix's test diff also reverted: what the solver sees | the fix's parent |

   Reverting tries an exact `git apply -R` first. If that fails because later commits moved the
   context lines, it falls back to a per-file 3-way merge with `git merge-file` (HEAD, the fix, the
   fix's parent), which is what `git revert` does. If that conflicts too, or the fix is not in HEAD,
   the parent base takes over. The solution patch is regenerated as `diff(buggy → fixed)`, so
   `solve.sh` always applies. On the parent base the old tree runs on today's dependencies; when
   its own tests no longer even collect, the reject is `env_drift`.

   - Run the test modules the fix touched, 3 times on buggy and 3 times on fixed. Fail-to-pass
     tests are those that fail in every buggy run and pass in every fixed run. Anything that changes
     outcome between runs is `flaky`.
   - Pass-to-pass is a **time-boxed subset**, not the full suite: the fix's own test modules plus
     up to 4 related modules (beside a target, or named after a touched source module; ties break
     by a hash of the sha). It runs twice on fixed and once on buggy; pass-to-pass tests passed in
     all three. The verifier runs the same modules, so a trial takes seconds instead of the full
     suite's two minutes. Tests that crash the interpreter on fixed are deselected for both.
   - The FAILURES section of the first buggy run is kept as the failing output, for the Writer.
   - Every reject gets a reason: `reverse_patch_conflict`, `no_test_targets`, `no_fail_to_pass`,
     `import_error_only` (fail-to-pass only because the module can't import), `flaky`, `timeout`,
     `env_drift`, `env_build_failed`, `check_error`.
4. **`package_task`.** Writes a Harbor 0.24 task to `.work/tasks/<slug>/<slug>-<sha10>/` and one
   SWE-bench-style row to `.work/results/<slug>/swebench.jsonl`.
   - The instruction is the Writer's text when there is one; otherwise the commit or PR message
     becomes a placeholder. Either way it gets a canary comment and never the diff.
   - `task.toml` carries `[metadata.bugfarm]` provenance and sets `environment_mode = "separate"`
     and `network_mode = "no-network"`.
   - `environment/docker-compose.yaml` forces `network_mode: none`.
   - `tests/test.sh` overlays the hidden tests, runs the subset's modules and grades them with
     `tests/grade.py`, which writes `/logs/verifier/reward.txt`.
   - `solution/solve.sh` is executable and runs `git apply` on the fix.
5. **`controls`.** Runs `harbor run -a oracle` (must score 1) and `-a nop` (must score 0) on local
   Docker. Failures are `oracle_failed`, `nop_passed` or `control_error`.
6. **`run`.** Chains all of the above for N candidates, prints the funnel and writes
   `.work/results/<slug>/funnel.json`.

### Results with the M1 changes (2026-10-23, the Azure box)

A smoke run of `check` on six fastapi candidates accepted all six, four of them through the parent
base; each check took 22-43 s with the subset. Their controls (oracle 1, nop 0 on all six) took 93 s
and 97 s for the six tasks at `-n 4`, against 19 and 21 minutes for twelve tasks with the full suite
in the spike.

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

## Calibration (`calibrate.ts`)

Calibration measures how hard each packaged task is for each model family, keeps the tasks in a
useful band, and records the difficulty on the task. It runs real model calls, so everything it
does is priced, capped and receipted.

```ts
import { calibrate } from './calibrate.ts';
const r = await calibrate(taskDir, frozenPanel, budgetUsd, { gateway, board });
// r.perFamily.anthropic = { model, passes, attempts, errors, rate, ci95, state }
// r.decision: accept | too_easy | unsolved_review | out_of_band | over_budget | held
// r.cost: every attempt on this task under this panel, priced by the gateway
```

`calibrate()` is resumable: attempts are stored, so calling it again with more budget carries on
where the budget gate stopped it. For the foreman, `calibrate-foreman.ts` wraps it in the
`Calibrate` contract from `src/calibrate.ts`
(`foremanCalibrate({ panel: 'cal-v1', gateway })`): `accept` becomes `accepted`, `held` stays
`pending`, every other decision is `rejected` with the decision as its reason, and `budget.item`
is the board key. The frozen panel wins over the foreman's panel entries; a mismatch is logged
once. It writes stage changes to the board only with `writeStage`
(the standalone CLI); when a foreman owns the item it writes the difficulty and attempts and leaves
the stage to the foreman.

### Method

- **One model per family.** Each family's difficulty is measured on one ladder model. Results never
  pool across models, prompts or verifiers: every attempt carries a cell id that hashes the frozen
  panel, the model, the harness and Harbor version, `instruction.md`, `tests/` and the environment
  files. A rewritten instruction starts a new cell.
- **Screen first.** One attempt from a cheap model and one from the frontier model. A screen attempt
  on a ladder model counts as that ladder's first try.
- **Many tasks, one budget.** `calibrateMany` (the `run` command) screens every task, then ladders a
  few tasks at a time in priority order, each drawing on the whole remaining budget, and repeats
  while a pass still spends. Priority: the frontier has passed every attempt (one more pass may
  settle `too_easy`), then someone passed while the frontier only missed (likely `accept`; in the
  prior factory 81% of first misses repeated), then a mixed frontier, then tasks nobody has solved.
  An even split was tried first and left every task short of its next frontier stage.
- **Ladder.** Cumulative attempts of 2, 4, 8 and 16 per family. A family stops early as too easy at
  2/2, 3/4 or 4/8 passes. Errors count as attempts and are never replaced. Nothing is decided while
  any attempt runs.
- **Frontier first.** Another family may only grow to the last stage the frontier family finished
  without a verdict, so a task that is too easy for the frontier costs the others nothing beyond the
  screen. Once the frontier has finished, the others run freely.
- **Stop when the decision is certain.** Calibration is selection, not measurement, so it stops as
  soon as more attempts cannot change the decision: the frontier is too easy, the frontier already
  has more passes than the ceiling allows, or someone has passed and the frontier cannot end above
  the ceiling even if every remaining attempt passes.
- **Band** (configurable): at least one pass in at least one family, and a frontier pass rate of at
  most 50%. Decisions:

  | Decision | When |
  |---|---|
  | `accept` | someone passes sometimes, and the frontier stays at or under the ceiling |
  | `too_easy` | the frontier stopped early as too easy |
  | `out_of_band` | the frontier pass rate is above the ceiling |
  | `unsolved_review` | every ladder finished with no passes; "unsolved" can mean broken, so a reviewer looks |
  | `over_budget` | the budget gate refused every stage still needed; call again with more budget to resume |
  | `held` | errored attempts could change the decision (it differs if they are read as passes) |

- **Budget gate.** A stage of k attempts launches only if the remaining budget covers
  k × (estimated attempt cost + reserve). The estimate is the panel's prior until the run has seen
  two attempts of that model, then their mean; the reserve is half the estimate. Another family's
  stage also has to leave room for the frontier's next stage while that stage is still affordable.
  Spend is tracked per call and across a campaign, and the campaign key's gateway cap is the hard
  stop.
- **Frozen panel.** `freeze` checks every panel route, hashes the panel and writes
  `.work/calibration/panels/<id>.json`. A frozen id never changes; a new panel needs a new id.
- **Selection ≠ measurement.** These attempts live under `.work/calibration/<panel>/` and go to the
  board with `phase: "calibration"`. The benchmark measures on attempts of its own.

### How an attempt runs

Each attempt is one Harbor 0.24 job with `terminus-2`, which runs on the host and drives the task
container over tmux, so the container keeps `network_mode: none`.

- **Model calls** go through the Stablehand LiteLLM gateway on a campaign key minted with
  `POST /api/model-gateway/campaign-keys` (tags `{campaign: ...}`, `maxBudgetUsd`). terminus-2 uses
  LiteLLM's OpenAI-compatible client: the model is `openai/<gateway model>`, `api_base` is
  `<gateway>/v1`, and the key is `OPENAI_API_KEY` in Harbor's process environment, never in the job
  config Harbor writes to disk. `model_info` carries the gateway's prices, so Harbor's own cost
  estimate matches the gateway's bill.
- **Pricing.** Every call carries `x-litellm-spend-logs-metadata: {"bugfarm_attempt": <id>}`.
  The gateway's spend log (`/spend/logs/v2`, read with the metering key and filtered by the
  campaign key's alias) then prices each attempt exactly. `reconcile` compares the attempt total
  with the campaign's spend in Stablehand.
- **Result.** The verifier's reward decides: 1 is a pass, less is a fail (an agent timeout is a
  fail, the model ran out of time), no reward is an error.
- **Trajectories.** Harbor writes ATIF v1.8. The raw file is copied next to the attempt record, and
  a v1.7 copy is written beside it (v1.8 only adds audio parts; they become text notes).
- **Cleanup.** A per-attempt compose override (Harbor's `extra_docker_compose`) labels the trial's
  main container `bugfarm.run=<run id>` and `bugfarm.attempt=<job>`. After the trial, cleanup
  removes only the compose projects of this attempt's labelled containers and of the job's own
  trials (the egress sidecar and the verifier env carry no label), even when Harbor fails or is
  killed. It never touches another job's containers, and leaves task images to Harbor's
  `--rmi local` because other jobs may share them.
- **Records.** `.work/calibration/<panel>/tasks/<task>/attempts/*.json`, `trajectories/`, and
  `summary.json`. Each decided task also gets `[metadata.bugfarm.calibration]` and
  `[metadata.bugfarm.difficulty.<family>]` in its `task.toml`.

### Commands

```bash
# Once per VM: a board, a frozen panel and a campaign key.
node --experimental-strip-types calibrate.ts freeze --panel cal-v1 --key-file <probe key file>
node --experimental-strip-types calibrate.ts mint-key --campaign bugfarm-dev-cal --max-budget 19

# One task (what the foreman calls), or a whole dataset within one budget.
node --experimental-strip-types calibrate.ts one .work/tasks/fastapi/fastapi-0f3e7bd682 --budget 1.5
node --experimental-strip-types calibrate.ts run --tasks-dir .work/tasks/fastapi --budget 18.5 --concurrency 6 --stage

node --experimental-strip-types calibrate.ts reconcile     # attempts vs gateway spend log vs Stablehand
node --experimental-strip-types calibrate.ts report        # per-family table, cost, in-band count
node --experimental-strip-types calibrate.ts board-sync    # re-send all rows to a new or reset board
node --experimental-strip-types calibrate.ts task-toml     # re-write the task.toml receipts
node --experimental-strip-types calibrate.ts atif17 in.json out.json
```

Settings come from the environment: `BUGFARM_GATEWAY_URL` (default `http://localhost:4400`),
`BUGFARM_CAMPAIGN_KEY_FILE` (written 0600 by `mint-key`), `BUGFARM_STABLEHAND_ENV` (a Stablehand
`.env` to read `STABLEHAND_API_TOKEN` and `STABLEHAND_MODEL_GATEWAY_METERING_KEY` from),
`STABLEHAND_URL`, and `BUGFARM_URL` with `BUGFARM_INGEST_TOKEN` for the board. Secrets are read,
never printed.

### Panel `cal-v1`

| Family | Cheap | Strong | Ladder model | Price in / out per M tokens |
|---|---|---|---|---|
| Claude (frontier) | claude-haiku-4-5 | claude-sonnet-5 | claude-sonnet-5 | $2 / $10 (cache read $0.20) |
| GPT | gpt-6-luna | gpt-5.4-mini | gpt-6-luna | $0.10 / $0.50 (cache read $0.01) |
| Open weights | cf-kimi-k2.7-code | cf-glm-5.2 | cf-kimi-k2.7-code | $0.95 / $4 (no caching) |
| Gemini | — | — | — | slot held: the gateway's Gemini key is invalid |

Screen: gpt-6-luna (cheap) and claude-sonnet-5 (frontier). terminus-2 settings: JSON parser, at
most 40 turns, a 900 s agent timeout, no terminal recording. All six routes answered before the
freeze. Claude is measured on its strong model so the band's ceiling means something; GPT and open
weights are measured on their cheap models so a full ladder stays affordable under a $20 cap.

### Results: fastapi, 12 tasks (2026-10-23, Azure VM)

The 12 tasks that passed their controls, on panel `cal-v1` (sha `7197b4595e3a59b1`), campaign key
`bugfarm-dev-cal` capped at $19, gate budget $18.50, 6 trials at a time on the 16-CPU VM.

| Task | Decision | Claude (sonnet-5) | GPT (luna) | Open (kimi) | Attempts | Cost |
|---|---|---|---|---|---|---|
| fastapi@0f3e7bd6 | too_easy | 2/2 | 1/1 | – | 3 | $0.69 |
| fastapi@d0282a38 | too_easy | 2/2 | 1/1 | – | 3 | $0.23 |
| fastapi@e92a0dc3 | too_easy | 2/2 | 1/1 | – | 3 | $0.37 |
| fastapi@d6235443 | too_easy | 3/4 | 1/1 | – | 5 | $1.54 |
| fastapi@f90d0369 | **accept** | 0/8 | 1/2 | 0/2 | 12 | $5.87 |
| fastapi@d1fd422f | over_budget | 1/8 | 2/2 | 0/2 | 12 | $3.65 |
| fastapi@eb75fd07 | over_budget | 2/4 | 1/1 | – | 5 | $2.59 |
| fastapi@5e6a1eec | over_budget | 1/4 | 0/2 | 0/2 | 8 | $2.43 |
| fastapi@ac88f563 | over_budget | 0/1 | 0/1 | – | 2 | $0.55 |
| fastapi@89317c70 | over_budget | 0/1 (error) | 0/1 | – | 2 | $0.41 |
| fastapi@c7fb7851 | over_budget | 0/1 | 0/1 | – | 2 | $0.27 |
| fastapi@aadfcce7 | over_budget | 0/1 (error) | 0/1 (error) | – | 2 | $0.00 |
| **All 12** | 1 in band, 4 too easy, 7 undecided | 13/38 | 8/15 | 0/6 | 59 | **$18.60** |

| Model | Attempts (screen) | Passes | Errors | Cost | Per attempt | Minutes per attempt |
|---|---|---|---|---|---|---|
| claude-sonnet-5 | 38 (12) | 13 | 2 | $17.73 | $0.467 | 8.2 |
| gpt-6-luna | 15 (12) | 8 | 2 | $0.19 | $0.013 | 6.9 |
| cf-kimi-k2.7-code | 6 (0) | 0 | 0 | $0.68 | $0.113 | 12.6 |

- **Spend reconciles exactly.** The 59 attempts sum to $18.601842. The gateway's spend log for the
  campaign key has 1,891 calls for $18.601842, every one tagged with an attempt id. Stablehand's
  campaign spend (`GET /api/model-gateway/campaign-keys/:id`) is $18.601842 for 1,891 calls. The
  route checks, the two cost probes and the smoke run went through a separate $1 probe key
  ($0.47, revoked afterwards), so the total was $19.07 against the $20 cap.
- **In band: 1 of 12.** The frontier is expensive: claude-sonnet-5 costs $0.47 and 8 minutes per
  attempt, and an `accept` needs at least 8 frontier attempts (0/8 makes the 50% ceiling certain)
  or the full 16. Too-easy tasks settle for $0.23–1.54; the accepted task cost $5.87. The 7
  undecided tasks have their attempts stored and resume with more budget.
- **Difficulty depends on the family.** gpt-6-luna, the cheapest model on the panel, passed 8 of
  15 and solved tasks sonnet-5 mostly missed (d1fd: luna 2/2, sonnet 1/8; f90d: luna 1/2, sonnet
  0/8). Kimi passed none of 6 and timed out once.
- **Errors: 4 of 59, counted and never replaced.** Three came from the pipeline's end-of-run
  cleanup, which removed every `bugfarm=1` container on the host at 22:35, including live
  calibration trials (`service "main" is not running`). Calibration now labels its trials
  `bugfarm.run=<run id>` and cleans up only what each attempt started. The fourth was a tmux
  server that died inside the task container mid-run.
- **Time.** Screen 40 minutes (24 attempts), ladder 55 minutes, plus a 16-minute handover while the
  first process's in-flight trials finished. An attempt takes 4–17 minutes: about 1 minute of
  Harbor setup, the agent, and a 2-minute verifier (the full fastapi suite).

**What a decisive run needs.** At these prices, settling the 7 open tasks would take roughly
$25–50 more, almost all of it frontier attempts. Cheaper options: measure the frontier family on
claude-haiku-4-5 and keep sonnet-5 for the screen, or accept on a statistical ceiling (for
example, a Wilson upper bound under 50%) instead of a certain one.

### Calibration gotchas

- **terminus-2 needs tmux in the image.** Without it, terminus-2 tries `apt-get install tmux`
  inside a container that has no network, and the trial fails with "Failed to start tmux
  session". Env images now install tmux.
- **The spend log rejects big pages.** `/spend/logs/v2` answers 422 to `page_size` above 100.
- **Harbor's estimate matches the gateway** when `model_info` carries the gateway's prices,
  cache read and write included, so the budget gate runs on accurate numbers before the spend log
  catches up.
- **No max_tokens.** LiteLLM's OpenAI client sends no token limit unless asked, so models that
  refuse `max_tokens` (gpt-6-luna) work through terminus-2 unchanged; the route check sends
  `max_completion_tokens` for them.
- **Resuming a killed run.** Attempts still `running` are read from Harbor's result if the trial
  finished, and counted as errors if it did not. Attempts that were still queued for a trial slot
  never started, so they are dropped rather than counted.

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
