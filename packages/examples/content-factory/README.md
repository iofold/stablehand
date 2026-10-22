# Content factory

Six agents that keep you posting on LinkedIn, X and your blog without writing from a blank page. Every Monday a scout reads what is working in your niche, a notes miner pulls stories from this week's meetings, a writer drafts three posts in your voice, and you approve, edit or reject each draft from your phone. An optional publisher schedules the approved posts through Typefully. On Thursday a measure agent checks how your posts did and hands the numbers to next Monday's scout.

The agents chain through events, run on two schedules and share one campaign budget. Every run leaves a receipt in the dashboard (model, tokens, cost, approvals) and its output as an artifact.

## What runs each week

| Stage | When | What it does | Reads through | Leaves behind |
|---|---|---|---|---|
| Scout | Monday 07:00 | Pulls the week's top LinkedIn and X posts for your keywords and accounts, ranks them by engagement and writes a "what's working" brief | Apify's MCP server | `whats-working-<date>.md` |
| Notes miner | after the scout | Reads this week's meeting notes and picks stories, decisions, numbers and opinions worth a post, with names replaced by roles | Granola's MCP server, or the synthetic stand-in | `stories-<date>.md` |
| Writer | after the notes miner | Writes a LinkedIn post, an X thread and a blog outline in your voice, then runs each one through the deslop check until it passes | your voice samples, `deslop/` | `<channel>-draft-<week>.md` |
| Editor | once per draft | Puts the draft on a review card: approve, edit and approve, or reject with a note | the review card | `<channel>-<week>.md` (kind `approved-draft`) |
| Publisher (optional) | after each approval | Schedules LinkedIn and X posts into your next free Typefully slot. Each call asks you first | Typefully's API | a Typefully draft |
| Measure | Thursday 07:00 | Pulls engagement for your own posts from the last 7 days | Apify's MCP server | `engagement-<date>.md` |

```
schedule (Mon) -> scout -> notes miner -> writer -> editor x3 -> publisher (optional)
schedule (Thu) -> measure -> scout files the report for next Monday
```

## Run it

You need a running Stablehand from the default install (which routes model calls through the LiteLLM gateway, so each run is priced and capped) and an [Apify](https://apify.com) API token. The demo reads synthetic meeting notes, so you do not need a Granola account to try it.

1. Start the synthetic notes server and let the orchestrator reach it. Add this line to `.env`, then restart the orchestrator:

   ```sh
   STABLEHAND_EGRESS_ALLOWLIST=notes-mcp
   ```

   ```sh
   docker compose --profile content-factory up -d notes-mcp
   docker compose up -d orchestrator
   ```

2. Edit `factory.config.json`: your niche keywords, a few accounts worth watching, your own X handle and LinkedIn URL (the measure agent needs them), the timezone and the weekly budget.

3. Replace `agents/writer/voice/samples.md` with 5 to 10 of your own posts. The writer copies how you write from them.

4. Seed the agents. `RUN_NOW=1` starts this week's run straight away instead of waiting for Monday.

   ```sh
   APIFY_TOKEN=apify_api_... \
   STABLEHAND_API_TOKEN=... \
   RUN_NOW=1 \
   node --experimental-strip-types packages/examples/content-factory/seed.ts
   ```

   The seed stores your Apify token as a tools-only secret: Stablehand sends it to Apify's MCP server for the agent, and it never enters the agent's sandbox. Re-run the seed whenever you change the config or the agents.

5. Review the drafts. On the dashboard, `factory-editor` shows "Approval needed" when a draft is waiting. Open it, open the waiting run, and the draft is on a card. Change the text if you want, add a note, then Approve or Reject. The card fits a phone screen.

6. Find approved drafts on the Artifacts page (kind `approved-draft`), or in the [artifact gallery](../../../extensions/artifact-gallery) if you run it.

## Use your real Granola notes

Granola's MCP server signs you in with OAuth; there is no API key for it. Stablehand runs the sign-in for the notes miner and keeps the tokens.

1. Re-seed with `USE_GRANOLA=1`. The notes miner now points at `https://mcp.granola.ai/mcp`.
2. Set `STABLEHAND_PUBLIC_URL` in `.env` to the address you open Stablehand at, for example `https://stablehand.example.com`, and restart the orchestrator. Granola sends your browser back to `<that address>/api/mcp/oauth/callback`. If you leave it unset, Stablehand uses the address in your browser.
3. Open `factory-notes-miner`, go to Tools, and press Connect on the `notes` server. The card shows where you will sign in (`mcp-auth.granola.ai`). Open the link, sign in to Granola and approve.
4. The card turns Ready and lists three tools: List meetings, Get meetings and Get meeting transcript.

Stablehand registers itself with Granola the first time (dynamic client registration), stores the tokens encrypted with the agent's tools-only secrets, and refreshes them. They never reach the sandbox or the model. Press Disconnect on the card to forget them, or revoke Stablehand in Granola's settings. On Granola's free plan the miner sees the last 30 days and no transcripts, which is enough: it works from summaries.

## Publish through Typefully (optional)

Set `TYPEFULLY_API_KEY` and `TYPEFULLY_SOCIAL_SET_ID` (find it with `GET https://api.typefully.com/v2/social-sets`) when you seed. The seed adds the publisher and gives it one HTTP tool, `typefully_create_draft`, marked to ask before every call. After you approve a draft, a second card shows the exact Typefully request; approve it and the post goes into your next free slot. Blog outlines are never posted. Without Typefully, approved drafts stay as artifacts.

## What it costs

Model spend: each agent has a per-run cap in its manifest (`limits.maxCostUsd`, $0.20 to $0.60), and the seed creates one budget for the campaign tag: $3 and 40 runs per rolling 7 days, a warning at 50%, new runs blocked at 100%. The per-run caps stop a run midway through the model gateway, which the default install runs; without it the budget still blocks new runs once spent. A live check of the notes miner's privacy step and one LinkedIn draft on gpt-5.4-mini used about 3,600 tokens, well under one cent.

Apify spend: the scout asks for at most 10 LinkedIn posts and 15 tweets per call and makes at most 6 calls; the measure agent makes at most 3. At the actors' prices (`harvestapi/linkedin-post-search` and `harvestapi/linkedin-profile-posts` at $2 per 1,000 posts, `apidojo/tweet-scraper` at $0.40 per 1,000 tweets) a week costs about $0.10. A test run of 3 LinkedIn posts and 5 tweets cost $0.008.

## Privacy

The notes miner replaces people's names with their roles and customer names with descriptions, and drops private notes, salaries, deal terms and anything marked private. It flags items that could still identify someone. Nothing from your notes leaves Stablehand until you approve a draft on the review card, and you can put a name back in at that point if you want it there.

## Files

| Path | What it is |
|---|---|
| `factory.config.json` | niche, accounts, schedules, timezone, budget |
| `agents/*/agent.yaml` | one manifest per stage: model, MCP servers, tools, instructions |
| `agents/writer/voice/samples.md` | your voice samples |
| `agents/writer/deslop/` | the writing rules and `check.mjs`, condensed from [skill-deslop](https://github.com/stephenturner/skill-deslop) by Stephen D. Turner (MIT, see `LICENSE` there) |
| `notes-mcp/` | the synthetic notes and the stand-in MCP server (no dependencies) |
| `seed.ts` | creates or updates everything above in a running Stablehand |
| `tests/` | manifest, deslop and stand-in server tests; the chain test is `tests/integration/content-factory-chain.test.ts` at the repo root |

## Change it

Change the niche, accounts or schedule in `factory.config.json` and re-seed. Swap the model in each `agent.yaml` (a stronger model for the writer is the change that matters most). To add a channel, add it to the writer's instructions and, if it should be posted, to the publisher's.
