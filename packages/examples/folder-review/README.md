# Folder review

Give the agent a folder of documents. It reads every file and returns findings that cite the document and the page or section each one came from, as a table in the run and a report you can download. Ask follow-up questions in the same conversation and the answers cite their sources too. Every run has a spend cap.

The demo folder is the vendor binder of Fernway, a fictional e-bike subscription company: ten invented documents, five of them PDFs. A vendor policy sets the rules, and the agent checks a courier contract, its data processing addendum, an insurance certificate, an amendment, a supply agreement, a price notice, a hosting order form, payment terms and an NDA against it.

## What one review does

| Step | What happens |
|---|---|
| Read | `agent/tools/read_folder.py` splits each PDF by page and each markdown or Word file by heading, and writes them to one file under headers such as `quaywise-msa.pdf \| page 4`. It also lists clauses that a later document replaced ("Clause 10.1 is replaced by ..."). |
| Worksheet | The agent goes through the policy clause by clause against every document, applies the amendments, and compares every date with today. |
| Findings | Each finding has a severity, a document, a page or section, the shortest quote that shows it, and the policy clause it breaks. |
| Check | `agent/tools/check_findings.mjs` checks every quote is on the page or in the section cited. It says which page a misplaced quote is on, and it refuses a finding about a clause that an amendment replaced unless the finding deals with the amendment. The agent fixes what it lists and runs it again. |
| Report | The checker writes `report.md`: what to act on first (copied from the checked findings), a findings table, the quote behind each finding and the list of documents read. The agent draws the table in the run and uploads the report as an artifact (kind `review-report`). |
| Follow-ups | `review.ts ask` sends a question with the same review id, so it runs in the same conversation. You can also type questions in that conversation on the dashboard. |

```
review.ts start -> custom.review.start  -> trigger, one conversation per review id -> review run
review.ts ask   -> custom.review.question -> same conversation -> cited answer
```

## Run it

You need a Stablehand from the default install, which prices every model call through the LiteLLM gateway and stops a run at its cap. The commands run from the repo root on the Docker stack, inside the orchestrator container, which already has the built packages.

1. Seed the agent and start the first review:

   ```sh
   docker compose exec -e API_URL=http://localhost:3001 -e RUN_NOW=1 \
     -w /app/packages/examples/folder-review orchestrator \
     node --experimental-strip-types seed.ts
   ```

   The seed creates `folder-review` with the ten documents and the two tools in its workspace, a trigger for starting a review and one for questions (both keep one review in one conversation), and a weekly budget. `RUN_NOW=1` starts the review `fernway-vendor-binder`. Re-run the seed after you change the agent or the folder; it updates what exists.

2. Watch the run. On the dashboard, open `folder-review` and the review's conversation. The agent reads the folder, writes its worksheet, checks its findings, then draws the table. The report is on the Artifacts page as `folder-review-fernway-vendor-binder.md`.

3. Ask a follow-up question:

   ```sh
   docker compose exec -e API_URL=http://localhost:3001 \
     -w /app/packages/examples/folder-review orchestrator \
     node --experimental-strip-types review.ts ask "Which contracts renew on their own, and when do we have to give notice?"
   ```

   The answer appears in the same conversation, with a source in brackets after each claim. You can also type the question there yourself.

4. Start another review in its own conversation: `review.ts start --review q4-binder "Only the courier documents."`

On the sample folder, expect findings such as: the courier's insurance certificate expired on 30 September 2026; the courier can end the contract on 30 days' notice where the policy asks for 90; the hosting order form renews for 36 months where the policy allows 12, and must be signed by 31 October 2026; the supplier's 9% price rise from 1 January 2027 needs CFO approval; the NDA has a residuals clause. The amendment that raised the courier's liability cap shows up as fixed, not as an open issue.

To run the scripts from your host instead, install the workspace and build the manifest package first (Node 22 and pnpm), then use `API_URL=http://localhost:3002` and `STABLEHAND_API_TOKEN=...`:

```sh
pnpm install
pnpm --filter "@stablehand/manifest..." build
```

## Use your own folder

1. Replace the files in `agent/folder/` with your own: PDFs with a text layer, markdown, plain text or Word (`.docx`). Scanned PDFs without a text layer come out empty, and the reader says so.
2. Put the rules to check against in the folder too, or change the request in `review.config.json` ("check every contract against our vendor policy") to what you want found. The instructions in `agent/agent.yaml` name `vendor-policy.md`; change that line to your rules file.
3. Re-seed. The seed uploads the folder into the agent's workspace.
4. Start a review with a new id: `review.ts start --review my-folder`.

The documents travel inside the agent's workspace, so every run of that agent sees the same folder. For one folder per review, seed one agent per folder, each with its own name in `agent/agent.yaml`.

## What it costs

Each run has a cap of $0.75 (`limits.maxCostUsd` in `agent/agent.yaml`). The model gateway stops a run that reaches it, so a large folder can stop midway; raise the cap for bigger folders. The seed also creates one budget for the `folder-review` campaign tag: $3 and 30 runs per rolling 7 days, a warning at 50%, new runs blocked at 100%. Without the gateway the budget still blocks new runs once spent, but nothing stops a run midway.

We checked the agent's prompts locally with gpt-5.4-mini on the sample folder. A review took 10 to 15 model calls, 60,000 to 160,000 input tokens (most of them cached) and 4,500 to 6,500 output tokens: at most 15 cents at list prices before caching. A follow-up question took one or two calls and at most 2 cents. The real harness adds its own system prompt, so expect a little more.

gpt-5.4-mini keeps the cost low, and the checker keeps every quote honest, but the model can still miss an issue, rank one too high or too low, or slip in a follow-up answer (in one check it named a contract as renewing on its own, then said it does not). Every claim carries its source so you can check it. A stronger model in `agent/agent.yaml` is the change that matters most.

## Privacy

- The sample documents are invented. Every page says so in its footer, and the people and companies in them do not exist.
- Your documents stay in the agent's workspace and in its sandbox. Their text reaches the model through your model gateway, and nothing else leaves Stablehand.
- The agent treats documents as data, not instructions.
- Reports are artifacts on your own S3-compatible storage, readable through Stablehand's API with a token.

## Files

| Path | What it is |
|---|---|
| `agent/agent.yaml` | the agent: model, per-run cap, tools, instructions |
| `agent/folder/` | the ten synthetic documents |
| `agent/tools/read_folder.py` | splits every document into pages and sections, and lists replaced clauses |
| `agent/tools/check_findings.mjs` | checks every quote against its page or section and writes the report |
| `documents-src/` | typst sources for the five PDFs; `documents-src/build.sh` rebuilds them |
| `review.ts` | starts a review or asks a follow-up question |
| `seed.ts` | creates or updates the agent, its workspace, the two triggers and the budget |
| `review.config.json` | campaign, default review id and request, event names, budget |
| `tests/` | manifest, folder, reader and checker tests; the chain test is `tests/integration/folder-review-chain.test.ts` at the repo root |
