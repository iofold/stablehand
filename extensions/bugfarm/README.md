# Bugfarm

Good coding tasks take weeks to write. Bugfarm mines them from git history.

Bugfarm reads a repository's past bug fixes and turns each one into a coding task with a receipt. A task only counts if its tests fail before the fix and pass after it. It also needs a difficulty measured against several model families. The campaign runs unattended on your own machine, under one spend cap. It learns from each batch's rejects, so the next batch keeps more candidates for less money.

This directory holds the Bugfarm worker and its live board. The worker runs beside Stablehand as its own process, the same way the [artifact gallery](../artifact-gallery) does. The task pipeline it runs lives in `pipeline/`, the floor agents it drives are Stablehand agents defined in `agents/`, and the Harbor agent that benchmarks Stablehand's harnesses on those tasks lives in `harbor/`.

## How a campaign runs

A campaign is a repository, a number of batches, a candidate count per batch and a spend cap. The **foreman**, a loop inside the worker, runs each batch:

1. **Scout turn.** The Scout agent mines merged pull requests that change source and tests, ranks them and submits the best ones. Each becomes a card in **Mined**.
2. **Env builder turn**, once per repo and HEAD. The Env builder writes the repo's environment Dockerfile and builds it through the worker until the test suite collects. Cards move to **Env ready**. An environment that already exists for this HEAD is reused.
3. **Per card**, several at once:
   - a **check job**: the fix's tests must fail on the buggy state and pass on the fixed one, three times each, and a subset of related tests must keep passing (**Fails→Passes**);
   - a **Writer turn** drafts an issue-style instruction that describes the symptom, then a second **review turn** checks it for leaks of the fix and rewrites it if needed. A deterministic leak check runs on every submission and once more at the end;
   - a **package job** writes the Harbor task, and a **controls job** runs the reference fix (must score 1) and doing nothing (must score 0) (**Controls ✓**);
   - the card is handed to calibration with `calibrate(taskDir, panel, budget)` and waits in **Calibrating**. Calibration is a separate module; until it lands the hand-off records nothing.
4. **Learning**, when the batch is done and before the next batch's Scout turn: the batch's numbers go on the curve, the rules that were on trial in it are kept or reverted on measurement, and the **Teacher** proposes rules from its rejects for the next batch. See [How it learns](#how-it-learns).

Every turn starts through the Stablehand API with the tags `{campaign, batch, stage, item}`, so spend lands on the campaign's budget and `GET /api/turns?tag=` finds it. The foreman waits with `waitForTurn` and adds each turn's `usage.cost` to its card, its batch and the campaign.

**Crash-safe.** All foreman state is in the board store. A turn's idempotency key and task text are written before the turn is requested, and its id right after; a job's id is fixed by what it does. Kill the worker mid-batch and start it again: it finds the campaign still running, adds one to the board's **Recovered from crash** counter, logs `RECOVERED campaign … resuming batch N where it left off`, waits on the turns Stablehand kept running, re-sends any turn that never left, and resumes jobs in flight. Nothing that finished runs twice.

### Floor agents

| Agent | Harness and model | Egress | Tools |
|---|---|---|---|
| `bugfarm-scout` | pi-agent, gpt-5.4-mini, $0.50 per turn | GitHub only (`api.github.com`, `github.com`, `codeload.github.com`) | `submit_candidates`, plus `agents/scout/mine_prs.py` in its workspace |
| `bugfarm-env-builder` | claude-agents, claude-sonnet-5, $2 per turn | none | `start_job`, `job_status` |
| `bugfarm-writer` | claude-agents, claude-sonnet-5, $0.60 per turn | none | `submit_instruction` |
| `bugfarm-teacher` | claude-agents, claude-sonnet-5, $0.60 per turn | none | `propose_rules` |

The manifests are in `agents/*.yaml`. Each turn's spend cap is the manifest's `limits.maxCostUsd`; the campaign's cap is a budget policy on its `campaign` tag.

### The playbook

`rule` rows in the board store, rendered as `rules.json` into every floor turn's task: `scout_filter` rules for the Scout, `writer_rule` rules for the Writer and `env_recipe` rules for the Env builder. `bugfarm seed` adds a few starter rules (`--no-starter-rules` skips them); add more by hand with `bugfarm rule add`; the Teacher adds the rest. A rule whose status is `reverted` is kept but no longer served.

A Scout filter can carry `skip_if`, a predicate over the candidate's features. That makes it code rather than advice: `submit_candidates` drops every candidate it matches before the candidate becomes a card, and tells the Scout which, so it can send replacements.

```json
{ "all": [ { "field": "age_days", "op": ">", "value": 300 }, { "field": "title", "op": "matches", "value": "\\bv1\\b" } ] }
```

A condition is `{field, op, value}`; `all`, `any` and `not` combine them, up to 8 conditions. Features (`src/shared/predicate.ts`): `age_days` (fix to HEAD), `fix_date`, `files`, `source_file_count`, `test_file_count`, `source_files`, `test_files`, `other_files`, `new_test_files`, `new_source_files` (files the fix adds), `non_test_lines`, `lines_added`, `lines_deleted`, `test_lines`, `title`, `title_prefix` (a leading emoji or `:code:`), `labels`, `has_issue`, `pr_body_chars`, `issue_body_chars` and `scout_rank`. Numbers take `< <= > >= == !=`, strings `== != matches contains`, lists `contains any_matches all_match none_match`; regexes are case-insensitive. A condition on a feature that is missing is unknown, and a filter only drops a candidate when its predicate is certainly true. The worker computes the git features from its own clone, so they come out the same every time.

## How it learns

After each batch the foreman hands the batch to the learning loop (`src/learning/`), before the next batch's Scout turn:

1. **Features.** Every card gets its `features` (as above).
2. **The curve.** The batch row gets `learning`: candidates, decided, accepted, accepted share (accepted ÷ decided), spend and dollars per accepted task, the rejection reasons with counts, what the filters dropped, and the rules the batch ran with.
   - *Accepted* is measured at the campaign's gate. At `calibration`, a candidate counts when calibration accepts it, and calibration's spend counts. At `controls`, it counts when it passes every check before calibration: fail→pass, the leak review, packaging, and the oracle and nop controls. `--learn-gate auto` (the default) picks `calibration` when the first batch has calibration verdicts and `controls` otherwise, and keeps that choice for the campaign.
   - Spend is the floor agents' turns, including the Teacher turn that wrote the batch's rules. The one-off environment build is recorded but left out, since it lands on whichever batch first needs the environment.
3. **Measurement.** Each rule that was on trial in this batch is compared with the batch before its trial. It is **kept** when the reason it targets falls (as a share of decided candidates) and the accepted share rises or the dollars per accepted task fall. Otherwise it is **reverted**: it stays in the store, marked, and is no longer served. A trial batch with fewer than 5 decided candidates is too small to judge (one card makes a 100% batch): the rule stays on trial, the next batch is pooled with it, and a rule still unmeasurable when the campaign ends is reverted. The rule row records the verdict and the evidence: both deltas, the target's count before and after, both batches' numbers, and how many candidates a filter dropped. Rules on trial together share one measurement; their targets tell them apart.
4. **The Teacher**, unless this was the last batch or nothing was rejected. Its task holds the batch's cards as data (outcome, reason, detail, features, the Writer's leak-check results), the curve so far, and the playbook with what earlier rules did. It calls `propose_rules` with at most three rules. Each has a kind, its text, a `skip_if` for a Scout filter, the reason it `targets` and its `expected_effect`. The tool checks every rule against the batch and dry-runs each filter on its cards. It refuses a rule whose target did not occur, a filter that would not have dropped any of the rejects it targets, a filter that would drop more accepted cards than rejects, and a repeat of an existing or reverted rule. What passes goes on trial in the next batch. The Teacher's turn is tagged with that next batch, so its cost counts against the rules it wrote.

Reflections are hypotheses: a prior factory's reflections blamed the same cause six times out of six, and an A/B test showed no effect. So a rule earns its place only by measurement, and batches of about ten are noisy. One card moves the share by ten points, so the Learning tab shows counts next to every percentage. `--no-learning` turns the loop off for a campaign.

### Worker tools

The floor agents reach the worker through Stablehand HTTP tools, which the orchestrator calls with the bearer secret the agent holds as a tools-scope secret (`BUGFARM_TOOLS_TOKEN`). Sandbox tool calls time out after five minutes, so long work is a job you start and then poll.

| Tool | Body | Answer |
|---|---|---|
| `POST /tools/v1/start_job` | `{kind, args}`; kinds `build_env` `{repo, dockerfile}`, `check_candidate` `{repo, sha}`, `package_task` `{repo, sha, instruction}`, `run_controls` `{repo, sha}` | `{job_id, status, progress}`. The same request twice is the same job. |
| `POST /tools/v1/job_status` | `{job_id, wait_seconds}` (up to 240) | Waits for the job, then `{status, progress, result \| error}` |
| `POST /tools/v1/submit_candidates` | `{candidates: [{pr, sha, title, labels, …}]}` | Records the Scout's list on its turn, minus what the playbook's `skip_if` filters drop; says which were dropped |
| `POST /tools/v1/submit_instruction` | `{instruction}` | Records the Writer's text and answers `{clean, leaks}` |
| `POST /tools/v1/propose_rules` | `{summary, rules: [{kind, text, skip_if?, targets, expected_effect}]}`, at most 3 | Teacher. Records the rules that pass and answers with a report per rule (errors, warnings, the filter's dry run) |

Jobs are `job` rows in the board store: their progress shows on the card they belong to, and a restarted worker resumes the ones that were queued or running.

## The board

Every candidate is a card that moves across the board as its checks finish:

**Mined → Env ready → Fails→Passes → Controls ✓ → Calibrating → Accepted / Rejected → Published**

- A card shows the repo and short commit, the fix's title, and one dot per model family. A dot fills with the share of tries that family solved. Each card also shows what the candidate has cost so far.
- Click a card for its receipt: the diff, the failing test, every attempt by model and try, the dollars, and when it reached each stage.
- A rejected card shakes, then drops into Rejected with its reason. An accepted card glows. Counters tick as numbers change.
- The header shows:
  - spend against the cap;
  - the share accepted this batch and dollars per accepted task, each against the previous batch;
  - the batch number;
  - how long the campaign has run unattended;
  - a badge when it recovered from a crash.

Three more tabs:

- **Leaderboard:** each agent and model pair, ranked by pass rate on the accepted tasks, with a 95% interval and dollars per solved task.
- **Learning:** accepted share and dollars per accepted task, batch by batch, with the counts under each bar. Below the charts, each rule the Teacher (or a person) added: its predicate, the reason it targets, whether it was kept, reverted or is on trial, and its measured effect. Then the rejection reasons by batch, so you can see which fell.
- **Ledger:** every attempt, with model, result, time and cost.

The board is dark by default and has a light theme. It is sized for a 1920×1080 screen capture and works on a phone, where the columns become a swipeable row. It honours the system's reduced-motion setting.

## Run it

### A campaign, on a dedicated box

The worker drives Docker and Harbor itself, so the simplest setup runs it on the host next to the Stablehand stack. It needs Node 22, git, Docker and `uv` (Harbor runs through `uvx`).

1. **A Postgres for the board**, for example `docker run -d --name bugfarm-db -e POSTGRES_USER=bugfarm -e POSTGRES_PASSWORD=... -e POSTGRES_DB=bugfarm -p 127.0.0.1:5434:5432 -v bugfarm-pgdata:/var/lib/postgresql/data postgres:17-alpine`.
2. **Let the orchestrator reach the worker.** Add [docker-compose.host.yml](docker-compose.host.yml) to `COMPOSE_FILE`, add `bugfarm` to `STABLEHAND_EGRESS_ALLOWLIST` in `.env`, and run `docker compose up -d orchestrator`. The worker is then `http://bugfarm:<BUGFARM_PORT>` from inside the stack. Any other host name the orchestrator resolves to the host works too, as long as it is in the allowlist.
3. **Build:** `pnpm install && pnpm --filter "@stablehand-ext/bugfarm..." build`.
4. **Write two env files** (mode 0600), with long random strings from `openssl rand -hex 24` for the tokens:
   - `~/.config/bugfarm/worker.env`: `BUGFARM_DATABASE_URL`, `BUGFARM_PORT`, `BUGFARM_INGEST_TOKEN`, `BUGFARM_TOOLS_TOKEN`, `BUGFARM_WEBHOOK_SECRET`, `BUGFARM_VIEW_TOKEN`, `BUGFARM_PUBLIC_URL=http://bugfarm:<port>`, `STABLEHAND_BASE_URL=http://localhost:3002`, `BUGFARM_WORK_DIR` (clones, trees and tasks; a few GB per repo);
   - `~/.config/bugfarm/cli.env`: `STABLEHAND_BASE_URL`, `STABLEHAND_ADMIN_TOKEN` (the master token, used only by `seed`), `BUGFARM_URL=http://localhost:<port>`, the same `BUGFARM_INGEST_TOKEN`, `BUGFARM_TOOLS_TOKEN` and `BUGFARM_VIEW_TOKEN`, `BUGFARM_TOOLS_URL=http://bugfarm:<port>`, and optionally `GITHUB_TOKEN` for the Scout.
5. **Seed** the floor agents, the budget policy and a scoped key for the worker, then start the worker:
   ```bash
   cd extensions/bugfarm
   set -a; . ~/.config/bugfarm/cli.env; set +a
   node dist/server/bugfarm.js seed --budget-tag my-campaign --cap 15 --worker-key-file /tmp/key.env
   cat /tmp/key.env >> ~/.config/bugfarm/worker.env && rm /tmp/key.env   # STABLEHAND_API_KEY, never printed
   scripts/host-worker.sh start
   ```
6. **Run a campaign**, one command; it seeds again (idempotent), starts the campaign and prints every card move until it stops:
   ```bash
   node dist/server/bugfarm.js run --repo fastapi/fastapi --candidates 15 --budget-tag my-campaign --cap 15
   ```
   The board is at `http://localhost:<port>/?key=<BUGFARM_VIEW_TOKEN>`.

`scripts/host-worker.sh kill` stops the worker with SIGKILL, as a crash would; `start` brings it back and the campaign resumes. `bugfarm status` prints the current campaign, and `bugfarm rule add --kind writer_rule --text "..."` adds a playbook rule. Repositories need a profile in `pipeline/lib/repos.ts` (source and test dirs, suite arguments).

### Next to the stack, board only

[docker-compose.yml](docker-compose.yml) is a compose overlay. It runs the worker and a Postgres of its own, `bugfarm-db`, so the board never touches Stablehand's database. The worker image has no Docker or Harbor tooling, so in this mode it serves the board and takes pipeline writes, but does not run campaigns.

1. Add the overlay to `COMPOSE_FILE` in `.env`, for example:
   `COMPOSE_FILE=docker-compose.yml:deploy/compose/model-gateway/docker-compose.yml:extensions/artifact-gallery/docker-compose.yml:extensions/bugfarm/docker-compose.yml`
2. Set the worker's secrets in `.env`:
   - `BUGFARM_INGEST_TOKEN`: any long random string (`openssl rand -hex 24`). The pipeline uses it to write to the board.
   - `BUGFARM_API_KEY`: a scoped key with `webhooks:manage`, from **Settings → Access keys**.
   - `BUGFARM_WEBHOOK_SECRET`: any long random string.
   - `BUGFARM_AGENT_IDS`: the floor agents' ids, comma-separated.
   - With the gallery overlay as well: `STABLEHAND_EGRESS_ALLOWLIST=gallery,bugfarm`, so Stablehand may deliver webhooks to both.
3. Start it: `docker compose up -d bugfarm`. The board is at http://localhost:8095 (`BUGFARM_PORT`).

### On its own

```bash
pnpm install
pnpm --filter @stablehand-ext/bugfarm build

export BUGFARM_DATABASE_URL=postgres://bugfarm:...@db.example:5432/bugfarm
export BUGFARM_INGEST_TOKEN=$(openssl rand -hex 24)
export STABLEHAND_BASE_URL=https://your-stablehand
export STABLEHAND_API_KEY=cmk_...                 # scoped key: webhooks:manage
export BUGFARM_WEBHOOK_SECRET=$(openssl rand -hex 24)
export BUGFARM_PUBLIC_URL=https://bugfarm.example  # must be reachable by Stablehand
export BUGFARM_AGENT_IDS=scout-id,env-builder-id,writer-id,reviewer-id,publisher-id

pnpm --filter @stablehand-ext/bugfarm start
```

Without the Stablehand settings, the worker still serves the board and takes pipeline writes. `GET /healthz` reports what is missing.

### Try the board with simulated data

```bash
BUGFARM_DATABASE_URL=postgres://... BUGFARM_SIM=1 pnpm --filter @stablehand-ext/bugfarm start
```

The simulator writes a made-up campaign through the same ingest API the pipeline uses. The campaign is on a fictional repository and has a $250 cap, and it produces about 20 accepted tasks over six batches. Cards flow through the stages with realistic rejects, rules are tried and measured, and the leaderboard fills in. When the campaign reaches its cap it stops, and a fresh one starts 30 seconds later. `BUGFARM_SIM_SPEED=2` doubles the pace. To feed a worker that is already running, use `BUGFARM_URL=... BUGFARM_INGEST_TOKEN=... pnpm --filter @stablehand-ext/bugfarm sim`.

Every simulated row is marked, and the board shows a **Simulated data** banner while any of them is on screen. The simulator refuses to write to a board that holds rows from a real run. When it starts, it clears only the simulated rows a previous run left.

For page work, `pnpm --filter @stablehand-ext/bugfarm dev:web` serves the page with hot reload and sends API calls to a worker on port 8095 (`BUGFARM_DEV_API`).

## Settings

| Variable | Default | What it does |
|---|---|---|
| `BUGFARM_DATABASE_URL` | required | Postgres the board is kept in. Use a database or role of its own. |
| `BUGFARM_DB_SCHEMA` | `bugfarm` | Schema the worker creates its tables in. |
| `BUGFARM_PORT` / `BUGFARM_HOST` | `8095` / `0.0.0.0` | Where the worker listens. |
| `BUGFARM_INGEST_TOKEN` | empty | Bearer token for the ingest API. Empty turns ingest off. |
| `BUGFARM_VIEW_TOKEN` | empty | Makes the board private. Open it once with `?key=<token>` and the browser remembers it. |
| `STABLEHAND_BASE_URL` | empty | Stablehand's API, for example `http://orchestrator:3001`. |
| `STABLEHAND_API_KEY` | empty | Scoped key with `agents:read`, `conversations:write` and `webhooks:manage` (`bugfarm seed --worker-key-file` mints one). Never the master token. |
| `BUGFARM_WEBHOOK_SECRET` | empty | Signing secret for the webhooks the worker registers. |
| `BUGFARM_PUBLIC_URL` | empty | The worker's address as Stablehand sees it. Webhooks go to `<url>/hooks/stablehand`. |
| `BUGFARM_AGENT_IDS` | the floor agents | Agents to receive webhooks from, comma-separated. Empty: the floor agents, found by name. |
| `BUGFARM_CAMPAIGN` | `main` | Campaign key that webhook updates land on when the foreman runs none. |
| `BUGFARM_SIM` / `BUGFARM_SIM_SPEED` | `0` / `1` | Run the simulator in the worker (development only). |
| `BUGFARM_WEB_DIR` | `dist/web` | Where the built board page is. |
| `BUGFARM_TOOLS_TOKEN` | empty | Bearer secret the floor agents' HTTP tools send. Empty turns the tools off. |
| `BUGFARM_FOREMAN` | `1` | `0` runs the board and tools without driving campaigns. The foreman also needs `STABLEHAND_BASE_URL` and `STABLEHAND_API_KEY`. |
| `BUGFARM_SCOUT_AGENT` / `BUGFARM_ENV_BUILDER_AGENT` / `BUGFARM_WRITER_AGENT` / `BUGFARM_TEACHER_AGENT` | `bugfarm-scout` / `bugfarm-env-builder` / `bugfarm-writer` / `bugfarm-teacher` | Floor agents, by name. |
| `BUGFARM_AGENT_SUFFIX` | empty | Appended to the default floor-agent names, for a second worker on the same Stablehand with its own agents (`bugfarm seed --agent-suffix` creates them). |
| `BUGFARM_CHECK_CONCURRENCY` / `BUGFARM_CONTROLS_CONCURRENCY` | `3` / `2` | Check and controls jobs at once. |
| `BUGFARM_WORK_DIR` | `pipeline/.work` | Clones, trees, results and Harbor tasks. |
| `BUGFARM_MAX_CONTAINERS` | `4` | Containers the checks may run at once. |
| `BUGFARM_UVX` | `uvx`, or `~/.local/bin/uvx` | How to run Harbor. |

## Capabilities

```text
agents:read
conversations:write
webhooks:manage
```

`agents:read` and `conversations:write` let the foreman start the floor agents' turns and read them back; `webhooks:manage` lets the worker subscribe to them. On startup the worker asks for a master-only route and logs a warning if the key can reach it. It then registers one signed webhook per floor agent and re-sends the secret each time, so a rotated secret takes effect on restart.

## Writing to the board: the ingest API

The pipeline writes with `Authorization: Bearer $BUGFARM_INGEST_TOKEN`. All payload fields are snake_case. Times are epoch milliseconds; ISO-8601 strings are accepted and converted.

### `POST /internal/v1/rows`

Writes up to 500 rows in one transaction:

```json
{
  "rows": [
    { "kind": "item", "key": "pyline@3f9a2c1d", "payload": { "stage": "mined", "repo": "orchard/pyline", "sha": "3f9a2c1d…", "title": "Fix wrap dropping the last wide glyph", "batch": 4 } },
    { "kind": "attempt", "key": "pyline@3f9a2c1d:terminus-2:claude-haiku-4-5:1", "payload": { "item": "pyline@3f9a2c1d", "harness": "terminus-2", "model": "claude-haiku-4-5", "try": 1, "result": "fail", "cost_usd": 0.042, "seconds": 131 } }
  ]
}
```

- **Merge by default.** A payload is merged into the latest one for its `(kind, key)`. Objects merge key by key at any depth; arrays and plain values replace. Send `"mode": "replace"` on a row to write it exactly as given.
- **Retries are free.** If the merged payload equals the latest one, nothing is written.
- **All or nothing.** If any row is invalid after merging, the call returns `422` with the row's index and reason, and writes nothing.
- **Stage times are stamped for you.** The first time an item reaches a stage, the worker records when, unless `stage_times` already has it.

The response is `{ "cursor": 1234, "results": [{ "kind", "key", "id", "changed" }] }`.

`PUT /internal/v1/rows/<kind>/<key>` writes a single row; the body is its payload, and `?mode=replace` works there too.

`POST /internal/v1/reset` with `{"confirm":"erase-board"}` clears the board. Add `"scope":"simulated"` to clear only simulated rows. Open boards reload on their own.

### Kinds and their fields

| Kind | Key | Fields |
|---|---|---|
| `campaign` | campaign id | `name`, `repo`, `cap_usd`, `spend_usd`, `started_at`, `unattended_since`, `recovered_from_crash`, `batch` (current), `status` (`running`, `paused`, `recovering`, `done`), `finished_at` |
| `batch` | batch number | `n` (required), `candidates`, `accepted`, `rejected`, `cost_usd`, `accepted_share` (optional; otherwise computed), `started_at`, `finished_at`, `status` (`running`, `done`). The learning loop adds `learning` (see [How it learns](#how-it-learns)): `gate`, `candidates`, `decided`, `accepted`, `share`, `cost_usd`, `usd_per_accepted`, `reasons`, `filtered`, `filtered_by`, `rules_served`, `setup_usd`, `teacher_usd`, `calibration_usd`, `teacher` |
| `item` | e.g. `repo@sha` | `stage` (required): `mined`, `env_ready`, `fail_pass`, `controls`, `calibrating`, `accepted`, `rejected`, `published`. Also `reject_reason`, `reject_detail`, `repo`, `sha`, `title`, `url`, `batch`, `diff` (unified diff), `diff_stats` (`files`, `additions`, `deletions`), `failing_tests` (ids), `failing_output`, `difficulty` (`{ family: { passes, attempts } }`), `cost_usd`, `stage_times` (`{ stage: ms }`) |
| `attempt` | e.g. `item:harness:model:try` | `item`, `harness`, `model`, `try`, `result` (`pass`, `fail`, `error`) are required. Also `family`, `cost_usd`, `seconds`, `phase` (`calibration`, `benchmark`), `at` |
| `rule` | rule id | `text` and `batch_introduced` are required. Also `kind` (`scout_filter`, `writer_rule`, `env_recipe`), `repo` (limits it to one repository), `status` (`trial`, `kept`, `reverted`), `measured_batch`, `effect` (`accepted_share_pts`, `usd_per_accepted`, `summary`; the learning loop adds `target_before`, `target_after`, `before`, `after`, `checks`, `filtered`, `measured_with`), `skip_if`, `targets`, `expected_effect`, `campaign`, `source` (`starter`, `hand`, `teacher`) |
| `cell` | `harness:model` | `harness`, `model`, `solved`, `attempts` and `pass_at_1` (0–1) are required. Also `family`, `tasks`, `ci_low`, `ci_high`, `usd_per_solve`, `cost_usd` |

The worker also keeps its own bookkeeping in the store: `job` (a pipeline job: `kind`, `status`, `args`, `progress`, `result`), `turn` (a floor agent's turn, keyed by turn id: role, tags, status, cost, last submission) and `env` (a repo's environment image, keyed by repo). Items the foreman writes also carry `campaign`, `activity` (what is happening to the card now), `instruction`, `pr`, `issue` and `fix_date`.

Reasons for rejection with a label on the board: `env_build_failed`, `no_fail_to_pass`, `flaky`, `reverse_patch_conflict`, `oracle_failed`, `nop_passed`, `instruction_leaks_fix`, `too_easy`, `unsolved_broken`, `out_of_band`, `over_budget`. Other reasons show as written. Model families are `anthropic`, `openai`, `google` and `open`. When `family` is missing, the board works it out from the model name.

Extra fields are kept. Every kind accepts `simulated: true`, which only the simulator should send.

Stablehand agents can write rows too, without the token: an agent that emits `custom.bugfarm.rows` with `{ "rows": [...] }` as its payload reaches the worker through its signed webhook.

## Reading the board

- `GET /api/state`: the latest row for every `(kind, key)`, plus the `cursor` and `epoch` they are current at.
- `GET /api/changes?since=<cursor>&limit=<n>`: rows written after a cursor, oldest first, with `more` when another page is waiting. The new cursor is the highest id returned.
- `GET /api/stream?since=<cursor>`: server-sent events. A `hello` event comes first. Then each row arrives as a `change` event whose `id` is the row id, the moment it is written, by any process that shares the schema. A `reset` event means the board was cleared and the client should reload. A reconnecting `EventSource` resumes from `Last-Event-ID`.
- `GET /healthz`: database, board counts, ingest, Stablehand connection and simulator status.

## How the board is stored

One append-only table, `rows(id, kind, key, content_sha, payload, created_at)`, lives in the worker's own schema. Nothing is updated in place. The current state of a thing is its latest row, and the full history stays for receipts. Writers take a short lock so ids become visible in order, so a reader following the cursor never skips a row. The lasting record of a task is the task directory the pipeline writes; the board is the live view of the campaign.

## Develop

```bash
pnpm --filter @stablehand-ext/bugfarm typecheck
TEST_DATABASE_URL=postgres://...@localhost:5433/<test db> pnpm vitest run extensions/bugfarm
```

The store tests create a schema of their own in the test database and drop only that schema.

## Uninstall

Stop the `bugfarm` and `bugfarm-db` services and revoke the scoped key under **Settings → Access keys**. Delete the webhooks the worker registered; each floor agent lists them at `GET /api/agents/:id/webhooks`. Then remove the `bugfarm-pgdata` volume if you no longer need the board's history.
