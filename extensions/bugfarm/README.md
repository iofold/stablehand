# Bugfarm

Good coding tasks take weeks to write. Bugfarm mines them from git history.

Bugfarm reads a repository's past bug fixes and turns each one into a coding task with a receipt. A task only counts if its tests fail before the fix and pass after it. It also needs a difficulty measured against several model families. The campaign runs unattended on your own machine, under one spend cap. It learns from each batch's rejects, so the next batch keeps more candidates for less money.

This directory holds the Bugfarm worker and its live board. The worker runs beside Stablehand as its own process, the same way the [artifact gallery](../artifact-gallery) does. The task pipeline that feeds it lives in `pipeline/`.

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
- **Learning:** accepted share and dollars per accepted task, batch by batch. Below the charts, each rule the reviewer added, with its measured effect and whether it was kept or reverted.
- **Ledger:** every attempt, with model, result, time and cost.

The board is dark by default and has a light theme. It is sized for a 1920×1080 screen capture and works on a phone, where the columns become a swipeable row. It honours the system's reduced-motion setting.

## Run it

### Next to the stack

[docker-compose.yml](docker-compose.yml) is a compose overlay. It runs the worker and a Postgres of its own, `bugfarm-db`, so the board never touches Stablehand's database.

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
| `STABLEHAND_API_KEY` | empty | Scoped key with `webhooks:manage`. Never the master token. |
| `BUGFARM_WEBHOOK_SECRET` | empty | Signing secret for the webhooks the worker registers. |
| `BUGFARM_PUBLIC_URL` | empty | The worker's address as Stablehand sees it. Webhooks go to `<url>/hooks/stablehand`. |
| `BUGFARM_AGENT_IDS` | empty | Floor agents to receive webhooks from, comma-separated. |
| `BUGFARM_CAMPAIGN` | `main` | Campaign key that webhook updates land on. |
| `BUGFARM_SIM` / `BUGFARM_SIM_SPEED` | `0` / `1` | Run the simulator in the worker (development only). |
| `BUGFARM_WEB_DIR` | `dist/web` | Where the built board page is. |

## Capabilities

```text
webhooks:manage
```

On startup the worker asks for a master-only route and logs a warning if the key can reach it. It then registers one signed webhook per floor agent and re-sends the secret each time, so a rotated secret takes effect on restart.

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
| `batch` | batch number | `n` (required), `candidates`, `accepted`, `rejected`, `cost_usd`, `accepted_share` (optional; otherwise computed), `started_at`, `finished_at`, `status` (`running`, `done`) |
| `item` | e.g. `repo@sha` | `stage` (required): `mined`, `env_ready`, `fail_pass`, `controls`, `calibrating`, `accepted`, `rejected`, `published`. Also `reject_reason`, `reject_detail`, `repo`, `sha`, `title`, `url`, `batch`, `diff` (unified diff), `diff_stats` (`files`, `additions`, `deletions`), `failing_tests` (ids), `failing_output`, `difficulty` (`{ family: { passes, attempts } }`), `cost_usd`, `stage_times` (`{ stage: ms }`) |
| `attempt` | e.g. `item:harness:model:try` | `item`, `harness`, `model`, `try`, `result` (`pass`, `fail`, `error`) are required. Also `family`, `cost_usd`, `seconds`, `phase` (`calibration`, `benchmark`), `at` |
| `rule` | rule id | `text` and `batch_introduced` are required. Also `kind` (`scout_filter`, `writer_rule`, `env_recipe`), `status` (`trial`, `kept`, `reverted`), `measured_batch`, `effect` (`accepted_share_pts`, `usd_per_accepted`, `summary`) |
| `cell` | `harness:model` | `harness`, `model`, `solved`, `attempts` and `pass_at_1` (0–1) are required. Also `family`, `tasks`, `ci_low`, `ci_high`, `usd_per_solve`, `cost_usd` |

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
