# Overnight Analyst

A scheduled agent that opens your sources in a sandboxed browser, screenshots each one, and publishes a self-contained HTML brief as an artifact. The [artifact-gallery extension](../../../extensions/artifact-gallery) turns those briefs into a public page. We have run it every morning since August 2026.

## What the seed creates

Manifests cannot carry schedules or triggers, so `seed.ts` creates three objects through the API:

- The agent `overnight-analyst`, from [agents/overnight-analyst/agent.yaml](agents/overnight-analyst/agent.yaml): LangGraph with `gpt-5.4-mini` and the built-in `browse`, `screenshot` and `artifact_upload` tools, in `background` mode.
- The schedule `overnight-analyst-daily`, which emits `custom.overnight.brief` every day at 07:00 in the timezone you choose.
- A trigger that turns that event into a background turn and splices the sources into the task through `{{payload.sources}}`.

Each run uploads one PNG per source and `overnight-brief.html` (`kind: brief`) to the agent's artifacts.

## Run it

Start the stack as in the [root quickstart](../../../README.md#quickstart). Two settings matter for this example:

- `OPENAI_API_KEY` must be set in `.env`; the agent reads it as `$secret:OPENAI_API_KEY`.
- Sandboxes can only reach the hosts in [packages/egress-proxy/rules.default.txt](../../egress-proxy/rules.default.txt), which does not include news sites. Add `STABLEHAND_EGRESS_EXTRA_ALLOW="GET *;HEAD *"` to `.env` for read-only web access, or list only your sources, for example `STABLEHAND_EGRESS_EXTRA_ALLOW="GET news.ycombinator.com/**"`.

Seed from inside the orchestrator container, which already has the built packages:

```bash
docker compose exec -e API_URL=http://localhost:3001 \
  -e ANALYST_SOURCES="https://news.ycombinator.com and https://www.theverge.com" \
  -e ANALYST_CRON="0 7 * * *" \
  -e ANALYST_TZ="Europe/Berlin" \
  -w /app/packages/examples/overnight-analyst \
  orchestrator node --experimental-strip-types seed.ts
```

All three `ANALYST_*` variables are optional. The defaults are Hacker News and The Verge, `0 7 * * *`, and `Asia/Kolkata`. Re-running the seed is safe: anything that already exists by name is left alone.

To seed from your host instead, install the workspace and build the manifest package first (Node 22 and pnpm):

```bash
pnpm install
pnpm --filter "@stablehand/manifest..." build
cd packages/examples/overnight-analyst
STABLEHAND_API_TOKEN=... npx --yes tsx seed.ts
```

## Fire a run now

The trigger listens for the event, so you can emit it yourself instead of waiting for the schedule:

```bash
curl -X POST http://localhost:3002/api/triggers/emit \
  -H "Authorization: Bearer $STABLEHAND_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"custom.overnight.brief","payload":{"sources":"https://news.ycombinator.com"}}'
```

To change the cadence of the schedule itself:

```bash
curl -X PATCH http://localhost:3002/api/schedules/<schedule-id> \
  -H "Authorization: Bearer $STABLEHAND_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"cronExpression": "*/30 * * * *", "timezone": "UTC"}'
```

`GET /api/schedules` lists the schedule ids.

## Costs

The manifest calls OpenAI directly with your key, so these turns may show as unpriced in Analytics. To price every run and count it against a budget, start the [model gateway overlay](../../../deploy/compose/model-gateway/README.md) and remove `apiKeyRef` from the manifest so the agent's model calls go through the gateway.
