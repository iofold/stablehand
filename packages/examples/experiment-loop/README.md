# Experiment loop

A loop that improves an agent's configuration against graded tasks and stops when the campaign budget or the iteration cap runs out. It works the way autoresearch-style hill climbing does: run the tasks, read the grades, let a proposer agent write one change from the failures, run the tasks again, and keep the change only if the score rose by more than run-to-run noise. When the loop ends, a reviewer agent draws the results and puts the promotion on an approval card. The production agent changes only after you approve.

Every iteration leaves a receipt (runs, tokens, cost, score) and two artifacts: a Markdown report with the diff and per-task results, and the same record as JSON. Every run carries the campaign tag, so one tag budget covers the whole campaign, and every agent has its own per-run spend cap.

```text
seed:      ops-assistant (production)   ops-assistant-candidate   loop-proposer   loop-reviewer
           tag budget campaign=experiment-loop   scoped key for the loop

iteration 0   baseline config x 2 runs of the slice      -> noise margin
iteration n   loop-proposer reads the failures -> change -> candidate runs the slice
              paired comparison with the best config      -> keep or discard
              report + receipt artifacts, custom.experiment.iteration event
stop          iteration cap, budget, solved slice, or a failing proposer
then          baseline and winner on held-out tasks       -> results page artifact
              loop-reviewer: chart, table, approval card  -> you approve -> production updated
```

## Run it

You need a running Stablehand from the default install, which routes model calls through the LiteLLM gateway, so every run is priced and stops at its cap. The tasks are in the prompt, so the agents need no web access.

1. Build the example and its workspace dependencies once (Node 22 and pnpm, from the repo root):

   ```sh
   pnpm install
   pnpm --filter "@stablehand/example-experiment-loop..." build
   ```

2. Seed it with the master token. The seed creates the four agents, a tag budget for `campaign=experiment-loop` ($3 and 400 runs per rolling 24 hours, a warning at 50%, new runs blocked at 100%) and a scoped key for the loop. It saves the key to `packages/examples/experiment-loop/.loop-key` (mode 600, gitignored) and does not print it.

   ```sh
   STABLEHAND_API_TOKEN=... API_URL=http://localhost:3002 \
     pnpm -C packages/examples/experiment-loop seed
   ```

   Re-running the seed updates the loop's agents and budget. It never resets `ops-assistant`, because a promotion lives there; `RESET_PRODUCTION=1` puts it back to its manifest.

3. Start a campaign. It runs with the scoped key, not the master token.

   ```sh
   API_URL=http://localhost:3002 pnpm -C packages/examples/experiment-loop loop -- --iterations 3
   ```

   Options: `--iterations N`, `--budget USD` (campaign budget, default $1), `--slice id,id,...`, `--no-holdout`, `--no-review`. Each iteration prints one line with its decision, score and cost.

4. Approve or reject. When the loop finds a winner, `loop-reviewer` shows "Approval needed" on the dashboard. Open its waiting run: a chart of the score per iteration, a table of the iterations, and the approval card with the slice and held-out scores, the cost and the diff. The loop waits 30 minutes (`approvalWaitMinutes`). If you decide later, finish the promotion with:

   ```sh
   API_URL=http://localhost:3002 pnpm -C packages/examples/experiment-loop loop -- --await <campaign id>
   ```

5. Find the record on the Artifacts page under `ops-assistant-candidate`: `<campaign>-results.html` (kind `experiment-results`) draws the score per iteration with kept and discarded marks, and each iteration has `<campaign>-iteration-NN.md` and `.json`. The Events page shows `custom.experiment.iteration`, `custom.experiment.finished` and `custom.experiment.promoted`.

## How it decides

The loop compares the candidate and the best configuration so far on the same tasks, task by task. It keeps a change when both hold:

- the mean per-task gain is larger than the keep margin;
- more tasks got better than got worse.

The keep margin is the larger of `minGain` (0.05) and the noise the loop measured at the start: it runs the baseline twice (`baselineRepeats`) and averages how far each task's score moved between the two runs. This is a paired comparison with a margin, not a significance test. Five tasks are too few for a test to say much, so treat a kept change as a candidate until the held-out check agrees.

The proposer only sees the slice. Before the approval card goes up, the loop runs the baseline and the winner on held-out tasks it never showed the proposer, and the card shows both scores. The loop also rejects any proposal whose instructions copy an expected answer from the tasks, and it records invalid proposals as iterations so their cost shows.

## The tasks and why they are synthetic

`tasks/tasks.json` holds 16 small back-office tasks written for this example and released under the repository's MIT licence:

- 8 field extractions from invoices, emails, receipts and transfer notices in English, German and French, graded field by field with exact matching;
- 8 spreadsheet formulas over small tables, graded by running the formula in a small Excel-style engine (`src/formula.ts`) and comparing the result, including one that is filled down six rows.

The grader accepts an answer wrapped in a code fence, inline code or JSON, and is strict about the values. The tasks follow output conventions that the starting prompt leaves out on purpose, so the loop has something to find: ISO dates, money in integer minor units (yen has none), ISO currency and country codes, E.164 phone numbers, IBANs without spaces, rates as fractions, null for missing fields, and formulas that run in Excel 2016 (no XLOOKUP, FILTER, UNIQUE or MAXIFS). The full list is at the top of `tasks.json`.

We did not use GDPval here. The `openai/gdpval` dataset on Hugging Face carries no licence (checked 2026-10-23), so its tasks and expert deliverables cannot ship in an MIT repository; [extensions/gdpval-bench](../../../extensions/gdpval-bench) fetches them at runtime for that reason. Its grading also needs model judges run three times per item, which costs far more per task than a programmatic check and adds judge noise to a keep-or-discard call made on five tasks. Programmatic grading keeps the noise in the agent, where the loop can measure it.

## What a run looks like

A 3-iteration campaign on the default slice with `gpt-5.4-mini`, on 2026-10-23:

| Iteration | Decision | Slice score | Runs | Tokens | Cost |
|---:|---|---:|---:|---:|---:|
| 0 | baseline (2 runs of 5 tasks) | 0.538 | 10 | 15,641 | $0.0083 |
| 1 | kept: ISO dates and codes, E.164 phones, numeric rates, Excel 2016 formulas | 0.940 | 6 | 12,825 | $0.0120 |
| 2 | discarded: +0.000 | 0.940 | 6 | 12,790 | $0.0121 |
| 3 | discarded: +0.042, inside the 0.081 noise margin | 0.982 | 6 | 12,710 | $0.0099 |

The held-out check scored the baseline 0.583 and the winner 0.717 on six tasks the proposer never saw, for $0.0174. The gap between 0.940 on the slice and 0.717 held out is the point of the check: after iteration 1 the remaining slice failures were money written as decimals, and the rule iteration 3 wrote for them gained too little on five tasks to clear the margin. More slice tasks or more baseline repeats give the margin more to work with.

## What it costs

On `gpt-5.4-mini` through the gateway:

- the baseline costs about $0.008 (10 runs);
- each iteration costs $0.010 to $0.012 (one proposer run and 5 task runs, about 13,000 tokens);
- the held-out check costs about $0.017 (12 runs) and the reviewer run about $0.009.

A 3-iteration campaign with the held-out check and the approval card costs about $0.07; the default 6 iterations about $0.10. The per-run caps are $0.05 for the agent under test and the reviewer and $0.10 for the proposer, the campaign stops before an iteration would cross `campaignBudgetUsd` ($1), and the tag budget blocks new runs at $3 a day. A stronger model for the proposer or the agent raises these numbers in line with its price.

## How long it takes

Each task run gets its own sandbox, and Stablehand keeps a finished sandbox warm for 5 minutes (`idleTimeoutMs`) with at most 20 per agent (`maxConcurrentSessionsPerAgent`). The baseline alone opens 10, so a campaign reaches that limit within a couple of iterations and then waits for sandboxes to free; it prints "waiting for a free sandbox session" while it does. The 3-iteration campaign above took about 15 minutes. The loop also rides out an orchestrator restart: it retries reads and turn starts for up to 3 minutes.

## Point it at your own agent

The loop tunes one agent described by a manifest. Put yours in `agents/<name>/agent.yaml` and set `agents.production` in `loop.config.json` to that path. The seed creates `<name>-candidate` from the same manifest, with the campaign tag and background mode, and the loop changes only these settings on it:

| Setting | Where it lives | Search space key |
|---|---|---|
| instructions | `spec.instructions` | `maxInstructionChars` |
| model | `spec.harnessConfig.model` | `models` |
| reasoning effort (LangGraph only) | `spec.harnessConfig.reasoning` | `reasoning` |
| output token limit (LangGraph only) | `spec.harnessConfig.maxTokens` | `maxTokens` |
| sandbox shell and files | `spec.nativeToolPolicy` | `nativeTools` |

List more models in `searchSpace.models` to let the proposer try them, for example `["gpt-5.4-mini", "gpt-5.6-luna"]`; `reasoning: ["low", "medium"]` lets it change the effort. Everything else in your manifest, such as tools, MCP servers and caps, carries over to the candidate unchanged. A promotion writes the winning settings into the production agent's stored manifest and leaves the rest of it alone. Agents with workspace files are not supported yet.

## Point it at your own tasks

Add tasks to `tasks/tasks.json` and list their ids in `slice` and `holdout`. Two kinds work out of the box:

- `extraction`: `fields` (name to description), `document`, and `expected` (name to value). Strings compare without case or extra spaces; numbers compare exactly.
- `formula`: `table` (header row first), `question` naming the target cell, `reference` (a formula that produces the answer; the tests check it does), `expected`, and `fillDownRows` if the formula is filled down.

For another kind of task, add it to `src/tasks.ts` (how the prompt renders) and `src/grader.ts` (how an answer scores, from 0 to 1, with one check per thing that can go wrong). The proposer learns from the checks' expected and actual values, so make them specific. Keep graders programmatic where you can; a model judge works too but adds noise the margin then has to absorb.

## Access and what the gate covers

The loop's scoped key has `agents:read`, `agents:write`, `conversations:write`, `events:read`, `artifacts:read`, `artifacts:write` and `triggers:emit:custom.experiment.*`. It cannot resolve approvals, create keys or edit budgets. Key capabilities apply to every agent, though, so the same key could edit `ops-assistant` directly. The approval gate is the loop's own rule: it promotes only after Stablehand records your answer on the reviewer's card, either as the resolved-interrupt event or as the `APPROVED` tool result the orchestrator writes when it resumes a parked run. It never reads the reviewer model's reply.

The card parks the reviewer run after 5 minutes without an answer and stays open. If you answer after that, the loop still sees the answer and promotes; the reviewer run itself can stay open afterwards, and you can cancel it from the dashboard.

## Files

| Path | What it is |
|---|---|
| `loop.config.json` | campaign tag, slice and held-out tasks, iterations, budgets, margin, search space |
| `agents/ops-assistant/agent.yaml` | the agent being improved, with its starting instructions |
| `agents/proposer/agent.yaml` | writes the next change from the graded failures |
| `agents/reviewer/agent.yaml` | draws the results and opens the approval card |
| `tasks/tasks.json` | the 16 synthetic tasks and their conventions |
| `seed.ts` | creates the agents, the tag budget and the scoped key |
| `run.ts` | runs a campaign, publishes the results and waits for the approval |
| `src/loop.ts`, `src/decide.ts` | the loop and the keep-or-discard rule |
| `src/grader.ts`, `src/formula.ts` | the graders and the spreadsheet engine |
| `src/stablehand.ts` | turns, receipts, artifacts, events and promotion through the API |
| `tests/` | the loop with a fake harness and fake grader, the seed and adapter against a fake API, the graders |
