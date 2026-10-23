# Overnight Analyst

A scheduled agent that opens your sources in a sandboxed browser, screenshots each one, and publishes a self-contained HTML brief as an artifact. The [artifact-gallery extension](../../../extensions/artifact-gallery) turns those briefs into a public page. We have run it every morning since August 2026.

The [root installer](../../../README.md#quickstart) sets all of this up and runs it once. This page covers what it creates and how to drive it by hand.

## What the seed creates

Manifests cannot carry schedules or triggers, so `seed.ts` creates them through the API:

- The agent `overnight-analyst`, from [agents/overnight-analyst/agent.yaml](agents/overnight-analyst/agent.yaml): LangGraph with `gpt-5.4-mini` and the built-in `browse`, `screenshot` and `artifact_upload` tools, in `background` mode, with a per-run spend cap of $0.50 (`limits.maxCostUsd`).
- The schedule `overnight-analyst-daily`, which emits `custom.overnight.brief` every day at 07:00 in the timezone you choose (UTC by default).
- A trigger that turns that event into a background run and splices the sources into the task through `{{payload.sources}}`.
- A scoped key for the gallery, `artifact-gallery`, with `artifacts:read` and `webhooks:manage` and bound to this agent, so the gallery can read this agent's files and nothing else. The seed prints it once as a `GALLERY_API_KEY=...` line for `.env`.

Each run uploads one PNG per source and `overnight-brief.html` (`kind: brief`) to the agent's artifacts.

## Costs and the spend cap

The manifest has no `apiKeyRef`. With the model gateway on (the default stack), every model call goes through LiteLLM: each run is priced on its receipt, and the gateway refuses calls past $0.50, which stops the run with a `budget_reached` receipt. In our tests a run over Hacker News alone took about 35 seconds, 100k input tokens and $0.02. Without the gateway the agent calls OpenAI directly with `OPENAI_API_KEY`; the run then shows as unpriced and the cap does not apply.

## Web access

Sandboxes can only reach the hosts in [packages/egress-proxy/rules.default.txt](../../egress-proxy/rules.default.txt), which does not include news sites. The analyst's manifest opens read-only access to any public host for this agent alone (`egress: { mode: allow, rules: ["GET *", "HEAD *"] }`), because pages load images and styles from many CDNs; other agents keep the default list. To allow only your sources, list them instead, for example `"GET news.ycombinator.com/**"`, and seed the agent again. See [docs/sandbox-egress.md](../../../docs/sandbox-egress.md).

## Seed it

From the repo root, inside the orchestrator container, which already has the built packages:

```bash
docker compose exec -e API_URL=http://localhost:3001 \
  -e ANALYST_SOURCES="https://news.ycombinator.com and https://www.theverge.com" \
  -e ANALYST_CRON="0 7 * * *" \
  -e ANALYST_TZ="Europe/Berlin" \
  -w /app/packages/examples/overnight-analyst \
  orchestrator node --experimental-strip-types seed.ts
```

All `ANALYST_*` variables are optional. The defaults are Hacker News and The Verge, `0 7 * * *`, `UTC`, and no approval step. Re-running the seed is safe: anything that already exists by name is left alone. A key's secret is shown only once, so on a re-run the seed keeps the existing gallery key; pass `-e GALLERY_API_KEY` to check that the one in your environment still works (a refused key is replaced), or `-e ANALYST_GALLERY=rotate` to mint a new one and revoke the old. `ANALYST_GALLERY=off` skips the key.

To seed from your host instead, install the workspace and build the manifest package first (Node 22 and pnpm):

```bash
pnpm install
pnpm --filter "@stablehand/manifest..." build
cd packages/examples/overnight-analyst
STABLEHAND_API_TOKEN=... npx --yes tsx seed.ts
```

## Ask before publishing

Pass `-e ANALYST_APPROVE_BEFORE_PUBLISH=1` to the seed and the agent gets the `request-approval` tool and one more step: after it writes the brief and before it uploads it, it asks a person, with the headline, the sources and the file name. The run waits until someone presses Approve or Reject on the approval card, in any open tab of the UI or on a phone. Rejected, the brief is not uploaded and the summary says so. `run-once.ts` prints a `waiting for approval:` line while the run waits. The screenshots still upload without asking; only the brief reaches the gallery.

It is off by default because a run that waits for a person cannot finish unattended: the installer's first run and an unwatched schedule would sit at the approval card. Run the seed again with `=1` or `=0` to turn the step on or off for an existing agent; leaving it unset changes nothing.

## Run it now

`run-once.ts` emits the event the schedule would, follows the run the trigger starts, and prints a receipt once the gateway has priced it:

```bash
docker compose exec -e API_URL=http://localhost:3001 -e GALLERY_URL=http://gallery:8090 \
  -w /app/packages/examples/overnight-analyst \
  orchestrator node --experimental-strip-types run-once.ts
```

```text
Receipt
  status   COMPLETED
  model    gpt-5.4-mini via the model gateway
  tokens   103764 in, 2168 out, 9 model calls
  cost     $0.0217
  time     35s running, 48s since the event
  brief    <artifact id>
  gallery  showing the brief
```

`ANALYST_SOURCES` changes what this one run reads. The script exits non-zero when the run fails or stops at its cap.

To change the cadence of the schedule itself:

```bash
curl -X PATCH http://localhost:3002/api/schedules/<schedule-id> \
  -H "Authorization: Bearer $STABLEHAND_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"cronExpression": "*/30 * * * *", "timezone": "UTC"}'
```

`GET /api/schedules` lists the schedule ids.

## As your own project

`create-stablehand my-briefs --template overnight-analyst` scaffolds a project with this agent, a compose file on the prebuilt images and npm scripts for the seed and run-once. It works once the npm packages are published.
