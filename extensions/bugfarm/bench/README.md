# Bugfarm benchmark and publish

The leaderboard answers one question: **which agent is best on this repo, and what does a solved bug cost?**

The benchmark is a fresh run on the accepted tasks. Calibration picks the tasks; its attempts are never reported as benchmark numbers, and the benchmark never reads them.

## Cells

A cell is a harness and a model. The cells live in [`cells.json`](cells.json):

| Cell | Agent | Notes |
|---|---|---|
| `claude-agents/claude-sonnet-5` | StablehandAgent | |
| `pi/gpt-6-luna` | StablehandAgent | |
| `pi/gpt-5.4-mini` | StablehandAgent | |
| `pi/cf-kimi-k2.7-code` | StablehandAgent | |
| `terminus-2/claude-sonnet-5` | Harbor terminus-2 | through the gateway on the campaign key |
| `terminus-2/gpt-6-luna` | Harbor terminus-2 | through the gateway on the campaign key |
| `langgraph/gpt-5.4-mini` | StablehandAgent | **off by default**, see below |

- **StablehandAgent cells** run a Stablehand harness through the Harbor agent in [`../harbor`](../harbor). Each trial gets its own solver agent:
  - its sandbox has no internet (`egress: deny`) and no Stablehand built-ins;
  - it reaches the task container only through the per-trial relay tools;
  - its turn carries the tags `{campaign, bench_cell, task, trial}`.
- **terminus-2 cells** run Harbor's own agent on the host. Every model call carries `x-litellm-spend-logs-metadata` with `{bugfarm_attempt, campaign, bench_cell, task, trial}`.
- **Same conditions for every cell.** Every cell gets the same agent timeout (`agent_timeout_sec`, 1,200 s by default) and the same verifier. Each cell's notes say how its tries stop:
  - a StablehandAgent try stops at a dollar cap per try (`max_cost_usd_per_trial`);
  - a terminus-2 try stops after 40 turns.
- **LangGraph is not a default cell.** With its native tools on (the project rule), LangGraph with gpt-5.4-mini explored and edited its own sandbox's `/app` instead of the task's. The `langgraph/gpt-5.4-mini` cell in `cells.json` is disabled. It runs with `native_tools: none`, so only the `task_*` tools are left, and the leaderboard says so in that cell's notes. Turn it on with `init --cells ...,langgraph/gpt-5.4-mini`.

A cell's identity is a hash of everything that decides how it runs: agent, harness, model, prices, timeout, per-try cap and kwargs. Notes are display text and are not hashed. A bench refuses to change a cell it has already measured; to change one, give it a new id or start a new bench.

## Method

1. **Freeze** (`init`): the task set, k and the cells.
   - Each task is copied into the bench (`.work/<bench>/tasks/`), so a later rewrite of the source task cannot change a bench in flight.
   - The task set is labelled `accepted`, or `dev_standin` when calibration has not accepted enough tasks. The label shows on the board and in the dataset card.
2. **Budget** (`setup`): two pieces under one cap.
   - A budget policy on the `campaign` tag: it warns at 50% and 85% and blocks at 100%. Stablehand applies it to every StablehandAgent turn, both when the turn is admitted and while it runs.
   - A campaign gateway key under that policy, for the terminus-2 cells. Its spend counts against the same policy. The key file is mode 0600 and the key is never printed.
3. **Run** (`run`):
   - k tries per task per cell, try by try and task by task, interleaving the cells, so a budget stop leaves the cells even.
   - 4 to 8 trials at a time (`--concurrency`, default 6).
   - Before each launch, a gate checks that settled spend, plus what running trials hold, plus this try's estimate × 1.5 still fits under the budget. The estimate starts from the cell's prior in `cells.json`; after two tries it is the cell's observed mean.
4. **Crash-safe.**
   - Each attempt is one Harbor job, started detached in its own process group with its output in a file.
   - Its record is written before Harbor starts and again when it finishes.
   - A killed runner leaves its trials running. The next `run` does one of three things with each:
     - **adopts** a live Harbor process by pid (its command line is checked) and waits for it;
     - **reads** the result of a trial that finished while no runner was watching;
     - **voids** a trial its own crash cut short. The execution is kept for the spend ledger, its orphaned Stablehand turn is cancelled, and the try runs again, because the agent never got a fair attempt.
   - Exactly one finished record counts per (cell, task, try), so nothing is counted twice.
   - **Provider failures run again.** Some tries never get a fair run. Either the agent stopped on a provider error, such as a 429 rate limit or a 5xx, or the verifier gave no reward. Such a try is voided the same way and runs again, up to three executions. The per-try spend cap and the agent timeout are the agent's own outcomes, so they count. The cell's notes say how many tries ran again.
   - **Per-cell concurrency.** A cell can cap its own trials in flight (`max_concurrent`), for a provider with a per-minute limit. The kimi cell runs two at a time. This is scheduling only, not part of the cell's identity.
5. **Clean up only what it started.** Each trial's main container is labelled `bugfarm.run=bench:<id>` and `bugfarm.attempt=<job>`. Cleanup removes the compose projects of that attempt's own trials and nothing else.
6. **Score.**
   - **Result:** a try passes when the verifier's reward is 1. Anything less is a fail, and no reward is an error. An error left after its retries counts as an unsolved try and is listed per cell.
   - **pass@1:** the mean over tasks of passing tries / tries.
   - **Interval:** a 95% percentile bootstrap that resamples tasks (10,000 draws, seeded by bench and cell). Tries on one task are correlated, so resampling tries would overstate certainty.
   - **$ per solve:** the cell's gateway-priced spend divided by its passing tries.
   - **Median time:** the median of the agent's own time per try.
7. **Price and reconcile** (`reconcile`). Three views of the same money:
   - the bench ledger: one cost per attempt and per voided execution;
   - the gateway spend log, read independently: the campaign key's rows by attempt id, plus the session-key rows whose `stablehand_turn_correlation` belongs to one of this bench's turns;
   - Stablehand's campaign budget.

   terminus-2 attempts are priced from the spend log, and StablehandAgent attempts from their turn, which Stablehand prices from the same gateway.

Rows go to the board as `cell` (key `<bench>:<cell>`) and `attempt` (`phase: "measurement"`, key `<item>:bench.<bench>:<cell>:<try>`).

## Commands

Run everything from `extensions/bugfarm`. You need Node 22.6 or later, Docker, `uv`, and `uv sync` in `harbor/`.

```bash
B="node --experimental-strip-types bench/cli.ts"
$B init --bench fastapi-b1 --campaign bugfarm-fastapi --tasks-dir <accepted tasks dir> --set accepted --k 3
$B setup --bench fastapi-b1 --cap 60
$B run --bench fastapi-b1 --concurrency 6           # --plan prints the queue; --cells, --tries narrow it
$B status --bench fastapi-b1
$B reconcile --bench fastapi-b1                     # also re-sends every row to the board
$B report --bench fastapi-b1                        # markdown table + .work/<bench>/report.json
$B publish --bench fastapi-b1 --hf-repo <org>/<name> --selection-campaign <calibration campaign>
```

Settings come from the environment. Secrets are read, never printed.

| Variable | Default | What it does |
|---|---|---|
| `BUGFARM_STABLEHAND_ENV` | `~/stablehand/.env` | The stack's `.env`, for `STABLEHAND_API_TOKEN` (the master token: StablehandAgent creates solver agents, and budgets and campaign keys are master-only) and the gateway's metering key |
| `STABLEHAND_URL` | `http://localhost:3002` | Stablehand API |
| `BUGFARM_GATEWAY_URL` | `http://localhost:4400` | Model gateway |
| `BUGFARM_URL`, `BUGFARM_INGEST_TOKEN` | unset | Board ingest. Without them, no rows are written |
| `BUGFARM_BOARD_URL` | unset | The board's address for people, used for the approval's link |
| `STABLEHAND_UI_URL` | unset | Dashboard address, printed next to the approval |
| `BUGFARM_BENCH_WORK` | `bench/.work` | Bench records, task snapshots, Harbor jobs |
| `BUGFARM_BENCH_HARBOR` | `harbor/.venv/bin/harbor` | Harbor binary (0.24.0, with `stablehand_harbor` installed) |
| `BUGFARM_HF_REPO` | unset | Target dataset repo on the Hugging Face Hub |
| `BUGFARM_HF_VISIBILITY` | `private` | `public` only when set explicitly |

The orchestrator must be allowed to reach the relay: `STABLEHAND_EGRESS_ALLOWLIST=host.docker.internal`. See [`../harbor/README.md`](../harbor/README.md).

## Publish

`publish` does four things, and is safe to run again at any point.

1. **Builds** the dataset folder (default `.work/<bench>/dataset`):
   - `tasks/`: the Harbor tasks as measured;
   - `data/swebench.jsonl`: one row per task. The rows start from the pipeline's `swebench.jsonl` when `--swebench` names it. The instruction is refreshed from the task, and a `test_patch` is computed when missing;
   - `leaderboard.json`;
   - `spend/ledger.json` and `spend/ledger.csv`;
   - `provenance/manifest.json`, with the sha256 of every file;
   - `README.md`: the dataset card. It covers provenance, method, per-family difficulty, the leaderboard, the spend ledger with its reconciliation, credits, and the license note that the upstream repo's license applies to the code snapshots.
2. **Asks a person.** The `bugfarm-publisher` agent (pi-agent, gpt-5.4-mini, no network, no native tools) calls `request-approval` with a short summary: the number of tasks, total spend and a link to the board.
   - The request shows on the Stablehand dashboard and on a phone, and nothing moves until a person resolves it.
   - The decision, the resolver and the reason are read from the interrupt record (`GET /api/interrupts/:id`), never from the agent's reply. They go into `provenance/approval.json` and into the card.
   - The request is idempotent per dataset sha. Change a file and it has to be approved again.
3. **Shows or pushes.**
   - Without `--push`, it is a dry run (`--dry-run` is the default): it prints what would be uploaded and touches no network.
   - With `--push`, [`publish/hf_push.py`](publish/hf_push.py) runs through `uv run --with huggingface_hub`. It checks the folder against the approved sha, creates the dataset repo private unless the visibility is set to `public`, refuses to upload a private dataset into an existing public repo, and uploads the folder.
4. **Marks the board** after a real push: the tasks' items move to Published.

Other options:
- `--selection-campaign <tag>` adds the calibration campaign's spend (Stablehand's record and the gateway's) to the ledger;
- `--factory-campaign <tag>` adds the floor agents' authoring spend;
- `--board-campaign <key>` shows the approval on that campaign's board header;
- `--build-only` stops after the folder.

## Dev validation (2026-10-24, the Azure VM)

Calibration had accepted only one task (`fastapi@f90d0369`), fewer than the three a benchmark needs. So this run uses a **dev stand-in**, and the board, the card and `leaderboard.json` all say so. The stand-in is that task plus the two undecided tasks closest to the band (`fastapi@d1fd422f`, `fastapi@5e6a1eec`), all from the 12 tasks that passed their controls.

Settings:
- bench `dev-bench2`, campaign `bugfarm-dev-bench2`;
- a $12 cap, gated at $11.50;
- k = 2, six cells, 6 trials at a time;
- a 1,200 s agent timeout, and $1.50 per StablehandAgent try.

| # | Cell | pass@1 | 95% interval | Solved | $ per solve | Cell spend | Median agent time |
|---|---|---|---|---|---|---|---|
| 1 | terminus-2 / gpt-6-luna | 67% | 50–100% | 4 of 6 | $0.03 | $0.11 | 4m 58s |
| 2 | pi / gpt-6-luna | 50% | 0–100% | 3 of 6 | $0.02 | $0.07 | 3m 52s |
| 3 | claude-agents / claude-sonnet-5 | 17% | 0–50% | 1 of 5 | $4.99 | $4.99 | 8m 59s |
| 4 | pi / gpt-5.4-mini | 0% | – | 0 of 6 | – | $2.75 | 4m 17s |
| 5 | pi / cf-kimi-k2.7-code | 0% | – | 0 of 5 | – | $0.81 | 20m (timeouts) |
| 6 | terminus-2 / claude-sonnet-5 | 0% | – | 0 of 5 | – | $2.56 | 5m 41s |

- **The budget gate held.** 33 of the 36 planned tries ran. The gate held back three: one Claude try in each Claude cell, and one kimi re-run. Those cells say "of 6" on the board.
- **The provider failed two kimi tries.** Workers AI answered 429 ("inference request per min rate reached"). Both tries were voided and ran again. The kimi cell now runs at most two trials at a time.
- **Two Claude tries hit their caps.** Two claude-agents tries stopped at the $1.50 cap; one of them had already solved its task.
- **This is not a model ranking.** The instructions are still placeholders (the Writer has not rewritten them), and three tasks is a tiny sample: look at the interval widths. The run validates the machinery, not the models.
- **Spend reconciles.**

  | View | USD |
  |---|---|
  | Ledger: 33 tries + 2 voided executions | 11.515488 |
  | Gateway spend log: campaign key rows by attempt id ($2.6678) + 24 session-key turns by correlation id ($8.8477) | 11.515487 |
  | Stablehand campaign budget: the ledger + four publish-approval turns ($0.0077) | 11.523154 |

  The differences are ±$0.000001, and the total is under the $12 cap.
- **The runner resumed twice.** It was SIGKILLed twice mid-run. Each time, the next `run` adopted the 6 live Harbor processes by pid. There were no double counts: one record per (cell, task, try). No containers labelled `bugfarm.run=bench:dev-bench2` were left.
- **Publish dry run.**
  - The folder is 3 tasks, 9,738 files and 113 MB, with dataset sha256 `7e18b06a…`. The repo snapshots are most of it; packing them before a real push is a follow-up.
  - `bugfarm-publisher` raised `request-approval` with the summary: "Publish 3 Bugfarm fastapi/fastapi tasks (dev stand-in) to the Hugging Face Hub: dry run of bugfarm-dev/fastapi-standin. Spend $30.12 (calibration $18.60, benchmark $11.52). Board: …". It showed in `GET /api/interrupts?status=pending`, the list the dashboard reads.
  - It was approved through `POST /api/agents/:id/interrupt` with a reason, by a scoped key named `bugfarm-phone-approver`. The card names that key, the time and the reason, and `provenance/approval.json` holds the record.
  - Re-running `publish` reused the approval: the sha did not change.
  - `hf_push.py` printed its plan: `create_repo(..., private=True)` and `upload_large_folder`. Nothing was uploaded.
