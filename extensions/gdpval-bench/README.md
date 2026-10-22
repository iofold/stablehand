# gdpval-bench

Runs a 60-task slice of OpenAI's GDPval tasks against each Stablehand agent loop and model you choose, grades the deliverables locally, and reports a score and a cost per cell. It changes nothing in core: everything below lives in this directory.

## Pieces

- Images. `images/Dockerfile` builds `stablehand-bench/harness-*` from the stock `stablehand/harness-*` images and adds headless LibreOffice, ffmpeg and fonts. Run `./build-images.sh` after every rebuild of the stock images.
- Activation. Set `STABLEHAND_IMAGE_PREFIX=stablehand-bench/harness` in an uncommitted `docker-compose.override.yml` for the length of a benchmark window, so new sandboxes start from the derived images. Remove it to return to the stock images.
- Slice. `slice/slice.json` pins 60 tasks: 25 from Finance and Insurance, 25 from Health Care and Social Assistance, and 10 cross-sector tasks whose deliverable is a presentation. The runner fetches task content from `openai/gdpval` on Hugging Face at run time and never commits it, because the dataset has no explicit license.
- Runner (`runner/`). For each cell (agent loop and model), it seeds reference files through the workspace tar API, starts one background turn per task tagged `{bench, campaign, task}` so spend lands in the ledger, collects deliverables through the artifact API, validates them, and packages the results.
- Grader (`grader/`). evals.openai.com does not host grading, so grading runs here in two ways: pairwise against the published expert deliverables (judge k=3 with position swap, reported as a win rate), and rubric scoring from `rubric_json` (deterministic checks plus judge items, median of k=3). Judges call the stack's LiteLLM gateway at temperature 0 with JSON output.
- Audit (`audit/`). Greps transcripts for attempts to fetch the gold answers (`huggingface`, `gdpval` or dataset URLs in tool calls) and sanitizes injected deliverables.

Results land in `results/`, which is gitignored. You can publish them to a Hugging Face dataset for archival.
