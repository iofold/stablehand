# Overnight Analyst

The flagship Stablehand example: a scheduled agent that browses your sources
while you sleep, screenshots each one, and publishes a self-contained
interactive HTML brief as an artifact — which the
[artifact-gallery extension](../../../extensions/artifact-gallery) turns into
a public morning-brief page.

## What it wires up

One agent, one schedule, one trigger — the pair Stablehand uses for cron work:

- **Agent** `overnight-analyst` (from `agents/overnight-analyst/agent.yaml`):
  langgraph + the built-in `browse`, `screenshot`, and `artifact_upload`
  tools.
- **Schedule** `overnight-analyst-daily`: fires `custom.overnight.brief`
  daily at 07:00 in your timezone (croner, timezone-aware, recurring-only).
- **Trigger**: turns that event into a background briefing turn, splicing the
  configured sources into the task via `{{payload.sources}}`.

## Run

Against a running Stablehand stack (the main repo `docker compose up`):

```bash
export STABLEHAND_API_TOKEN=...            # or leave unset if auth is disabled
export ANALYST_SOURCES="https://news.ycombinator.com and https://www.theverge.com"
export ANALYST_CRON="0 7 * * *"         # optional
export ANALYST_TZ="Asia/Kolkata"        # optional, any IANA zone
npx tsx seed.ts
```

Re-running is safe: anything that already exists by name is left alone.

To watch a run without waiting for 07:00, temporarily switch the cadence:

```bash
curl -X PATCH -H "Authorization: Bearer $STABLEHAND_API_TOKEN" \
  -H 'Content-Type: application/json' \
  "$API_URL/api/schedules/<schedule-id>" -d '{"cronExpression": "*/4 * * * *", "timezone": "UTC"}'
```

Each fire produces per-source screenshots and `overnight-brief.html`
(`kind: brief`) in the agent's artifacts.
