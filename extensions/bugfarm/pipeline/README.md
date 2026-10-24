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
where the budget gate stopped it. It writes stage changes to the board only with `writeStage`
(the standalone CLI); when a foreman owns the item it writes the difficulty and attempts and leaves
the stage to the foreman.

**In the foreman.** The worker calibrates every card that passes its controls, through
`calibrate-foreman.ts` (`calibrationFromEnv`, then `foremanCalibrate`), which wraps `calibrate()`
in the `Calibrate` contract from `src/calibrate.ts`:

- `accept` moves the card to **Accepted**. Every other decision moves it to **Rejected**, with the
  decision as its reason (`held` becomes `held_errors`) and the pass counts per family as the
  detail.
- The task must carry the final, leak-checked instruction. Attempts never pool across
  instructions (the instruction is part of every attempt's cell), so a Writer rewrite would mean
  recalibrating. The foreman checks that the packaged `instruction.md` is the instruction the
  review passed, rejects the card as `instruction_mismatch` if it is not, and records its sha on
  the card.
- Budgets: the card's `calibration_usd` covers every attempt the card has had, so a resumed card
  only gets what it has left. Across cards there is one pool per campaign: the campaign's cap,
  minus what its floor turns spent, minus calibration so far. Every card calibrating at once draws
  on it, and a stage the pool cannot cover does not launch. The campaign key's gateway cap is the
  hard stop behind both.
- The frozen panel wins over the foreman's panel entries; a mismatch is logged once. The campaign
  key's `campaign` tag must match the campaign's budget tag, or the card is rejected as
  `calibration_error` instead of spending outside the cap.
- Without a frozen panel or a campaign key the worker logs why and leaves cards waiting in
  Calibrating.

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
- **Early decisions (cal-v2 on).** Waiting for certainty made every accept cost at least 8
  frontier attempts (0/8 is the first count that makes the 50% ceiling certain at the 16 cap), and
  on cal-v1 that was $4–6 a task. From cal-v2 the ladder decides on what it has seen:
  - **Accept** as soon as the frontier has at least 4 finished attempts, has passed at most half of
    them, and some family has at least one pass.
  - **`unsolved_review`** when nobody has passed with the frontier at 4 attempts and every other
    family at 8. The other families stop at 8.
  - **Too easy** stays as it was: 2/2, 3/4 or 4/8 frontier passes.
  - The other families run only while nobody has passed: in selection their job is to show that
    the task can be solved. Once anyone passes, only the frontier's next stage is needed. While
    nobody has, they still follow the frontier's last finished stage, and once the frontier stops
    at 0/4 they grow freely to 8.
  - Errors count as attempts, and the `held` rule still applies: a decision that would change if
    the errors were passes waits for a person.

  Why this is enough for selection: at 4 frontier attempts every count is decided. 3 or 4 passes is
  too easy, 0 to 2 passes is at or under the ceiling, so the frontier never needs a fifth attempt
  unless nobody has passed at all. The cost is precision: a task whose true frontier rate is 55%
  passes 2 of 4 often enough to be accepted now and then, and the Wilson interval on 1/4 runs from
  5% to 70%. That is the right trade, because calibration only selects. The benchmark measures
  accepted tasks on attempts of its own and never reads these, so a borderline task shows up there
  with its real rate. On cal-v1's numbers, the one accept (fastapi@f90d0369: sonnet 0/8, luna 1/2)
  would have been decided after 4 frontier attempts instead of 8, and three of the seven
  over-budget tasks would have been accepted with the attempts they already had
  (fastapi@d1fd422f: sonnet 1/8, luna 2/2; fastapi@eb75fd07: sonnet 2/4; fastapi@5e6a1eec: sonnet
  1/4).
- **Band** (configurable): at least one pass in at least one family, and a frontier pass rate of at
  most 50%. Decisions:

  | Decision | When |
  |---|---|
  | `accept` | someone passes sometimes, and the frontier stays at or under the ceiling (from cal-v2: after 4 frontier attempts) |
  | `too_easy` | the frontier stopped early as too easy |
  | `out_of_band` | the frontier pass rate is above the ceiling |
  | `unsolved_review` | every ladder finished with no passes (from cal-v2: frontier at 4, the others at 8); "unsolved" can mean broken, so a reviewer looks |
  | `over_budget` | the budget gate refused every stage still needed; call again with more budget to resume |
  | `held` | errored attempts could change the decision (it differs if they are read as passes) |

- **Budget gate.** A stage of k attempts launches only if the remaining budget covers
  k × (estimated attempt cost + reserve). The estimate is the panel's prior until the run has seen
  two attempts of that model, then their mean; the reserve is half the estimate. Another family's
  stage also has to leave room for the frontier's next stage while that stage is still affordable.
  Spend is tracked per call and across a campaign, and the campaign key's gateway cap is the hard
  stop.
- **Trial slots.** Every task calibrating at once shares one set of trial slots. A free slot goes
  to the highest try waiting, so a card's deciding stage does not queue behind every newer card's
  screen. An attempt that finishes without Harbor's cost estimate (an agent timeout often has
  none) keeps its reserved estimate as its cost until the spend log prices it, so the gate never
  treats it as free.
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
# Once per VM: a probe key, a frozen panel, and a campaign key per budget tag.
node --experimental-strip-types calibrate.ts mint-key --campaign my-probe --max-budget 3 --key-file probe-key.json --models claude-sonnet-5-5,claude-sonnet-5-5-autocache
node --experimental-strip-types calibrate.ts probe .work/tasks/fastapi/fastapi-f90d036938 --models claude-sonnet-5-5,claude-sonnet-5-5-autocache --tries 2
node --experimental-strip-types calibrate.ts freeze --panel-id cal-v2 --key-file probe-key.json
node --experimental-strip-types calibrate.ts mint-key --campaign bugfarm-dev-cal2 --max-budget 12.5

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

`probe` runs one task on several models with the panel's solver settings and no ladder, then
prices each attempt from the spend log with its prompt, cache-read, cache-write and output tokens.
A model written `<gateway model>@<effort>` sends `reasoning_effort` in every request body (the
gateway maps it to Claude's adaptive thinking and `output_config.effort`); a panel entry can use
the same form.

### Panel `cal-v2`

Frozen 2026-10-24 01:30 UTC, sha `4706e664510f2243`, after the probes below. All five routes
answered.

| Family | Cheap | Strong | Measured (ladder) model | Price in / out per M tokens | Cost prior per attempt |
|---|---|---|---|---|---|
| Claude (frontier) | claude-haiku-5-5 | claude-sonnet-5-5-autocache | claude-sonnet-5-5-autocache, default effort | $2 / $10 (cache read $0.10, write $2.50) | $0.29 |
| GPT | gpt-6-luna | gpt-5.4-mini | gpt-6-luna | $0.10 / $0.50 (cache read $0.01) | $0.015 |
| Open weights | cf-kimi-k2.7-code | — | cf-kimi-k2.7-code | $0.95 / $4 (no caching) | $0.12 |
| Gemini | — | — | — | slot held: the gateway's Gemini key is invalid | — |

Screen: gpt-6-luna and claude-sonnet-5-5-autocache. Ladder: 2/4/8/16 with the early decisions
above. terminus-2 settings as in cal-v1 (JSON parser, at most 40 turns, 900 s agent timeout).

#### What the probes showed (fastapi-f90d036938, 2026-10-24)

The plan was to cut the frontier's cost with prompt caching: autocache aliases on the gateway
that mark the system message and the newest message. On the same task, two attempts each:

| Model | Passes | Calls | Prompt tokens | Cache reads | Output tokens | $ per attempt | $ per call |
|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 2/2 | 66 | 1,407,215 | 95% | 37,911 | $0.352 | $0.0107 |
| claude-sonnet-5-5-autocache | 1/2 | 50 | 807,619 | 94% | 24,655 | $0.226 | $0.0091 |
| claude-sonnet-5-5-autocache@medium | 1/2 | 53 | 981,495 | 94% | 27,204 | $0.257 | $0.0097 |
| claude-sonnet-5-5-autocache@low | 0/2 | 47 | 615,805 | 93% | 14,387 | $0.155 | $0.0066 |
| claude-haiku-5-5-autocache | 0/2 | 52 | 1,249,422 | 93% | 54,361 | $0.025 | $0.0010 |

- **The plain alias already caches.** Harbor 0.24's LiteLLM wrapper marks the newest 4 content
  blocks of every request whose model name contains "claude" (`harbor/llms/utils.py`,
  `add_anthropic_caching`), so terminus-2 read 95% of its prompt tokens from the cache on
  `openai/claude-sonnet-5-5`. cal-v1 did too: its 31 priced Sonnet 5 attempts read 95% of 21.8M
  prompt tokens from the cache. With Harbor's 4 cache points in place, LiteLLM's hook adds none
  (it never goes past Anthropic's limit of 4), so the autocache alias changes nothing for
  terminus-2. The cost differences in the table come from conversation length (25 against 33
  calls per attempt), not from caching. The aliases stay for agent loops that set no cache points
  of their own.
- **What did cut the cost is Sonnet 5.5 itself.** Its cache reads cost $0.10 per M tokens against
  Sonnet 5's $0.20, and on this task it wrote about 16k output tokens per attempt. That gives
  $0.29 per attempt over the four default-effort attempts, against cal-v1's $0.47 for Sonnet 5.
  Output is now about half of the bill: it carries adaptive thinking, and caching cannot touch it.
- **Effort:** medium cost about the same as the default ($0.26 against $0.29); low saved 45% and
  passed 0 of 2. Neither is a clean lever, so cal-v2 measures at the default effort.
- **Haiku 5.5 costs a tenth of a cent per call**, $0.025 an attempt, and passed 0 of 2 here. As a
  frontier it would make calibration about 12 times cheaper, but "too hard for the frontier"
  would then mean too hard for Haiku.

#### Results: the foreman on fastapi, cal-v2 (2026-10-24, Azure VM)

Campaign `cal2-fastapi-1`: one batch of 12 candidates, a $15 cap on budget tag `bugfarm-dev-cal2`,
$2 of calibration per card, 6 trial slots. It ran from 01:32 to 03:35 UTC (2 h 3 min).

- **5 accepted, 7 rejected:** 5 `too_easy`, 1 `unsolved_review`, 1 `import_error_only`.
- **Accepted cards** (frontier, GPT, open):
  - fastapi@89317c70: 0/4, 1/1, –; $0.88
  - fastapi@0890e2a3: 1/4, 1/1, –; $2.19
  - fastapi@d1fd422f: 0/4, 1/1, –; $2.02
  - fastapi@f5a439d5: 0/4, 0/4, 1/2; $2.10
  - fastapi@5ef18bfe: 0/4, 0/8, 1/5; about $1.4
- **Cost:** calibration $12.06 over 82 attempts, $2.41 per accepted task. Floor turns cost $2.48
  (Scout $0.07, Env builder $0.16, Writer $2.25). All in, $14.54, or $2.91 per accepted task.
- **Per model:** Sonnet 5.5 cost $0.26 an attempt over 36 attempts and passed 12. luna cost $0.011
  over 28 and passed 7. kimi cost $0.13 over 15 and passed 2.
- **Reconciliation:** the attempts total $12.062614, the gateway spend log has $12.062614 for the
  campaign key (1,853 calls, all tagged with an attempt), and Stablehand's campaign-key spend is
  $12.062614. Stablehand's budget policy for the tag shows $14.542, the turns plus the key.
- **Where the money went.** A too-easy card cost $0.10–0.42. An accept cost $0.88–2.19. The
  unsolved card cost $1.93, mostly 8 kimi attempts. Waiting for a pass from the cheap families
  (luna to 8, kimi to 8) is the costly path, and it is what three of the accepts took.

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
  session". The profile Dockerfiles install tmux. The Env builder's own Dockerfiles did not, so
  every attempt on an agent-built env failed this way; `buildEnv` now appends a tmux layer to a
  custom Dockerfile that lacks one.
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
