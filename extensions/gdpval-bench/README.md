# gdpval-bench — harness benchmark extension

Runs the GDPval-CTX slice (and later the Terminal-Bench slice) against
Stablehand harnesses, grades the results locally, and reports per-cell scores
and costs. Everything lives in this extension; **core is never modified**:

- **Images**: `images/Dockerfile` derives tooling-extended harness images
  (`stablehand-bench/harness-*`) FROM the stock `stablehand/harness-*` images
  (adds headless LibreOffice, ffmpeg, fonts). Build with
  `./build-images.sh` after any stock image rebuild.
- **Activation**: the orchestrator's existing `STABLEHAND_IMAGE_PREFIX` env
  seam points sandboxes at the derived images —
  `STABLEHAND_IMAGE_PREFIX=stablehand-bench/harness` in the (uncommitted)
  `docker-compose.override.yml` during a benchmark window. Remove the
  var to return to stock images.
- **Slice**: `slice/slice.json` pins the 60-task GDPval-CTX slice
  (25 Finance and Insurance, 25 Health Care and Social Assistance,
  10 cross-sector presentation-deliverable tasks). Task *content* is
  fetched from `openai/gdpval` on Hugging Face at runtime and never
  committed (no explicit license on the dataset).
- **Runner** (`runner/`): per campaign cell (harness × model), seeds
  reference files via the workspace tar API, starts one background turn
  per task (tags `{bench, campaign, task}` → spend ledger), collects
  deliverables via the artifact API, validates (T0), packages results.
- **Grader** (`grader/`): self-run — evals.openai.com does not host
  grading. (1) pairwise vs the published human expert deliverables,
  judge k=3 with position swap → win-rate; (2) rubric scoring from
  `rubric_json` (deterministic checks + judge items, k=3 median).
  Judges call the in-stack LiteLLM gateway directly (temp 0, JSON out).
- **Audit** (`audit/`): transcript grep for gold-solution retrieval
  (`huggingface`/`gdpval`/dataset URLs in tool calls) and the
  deliverable injection sanitizer.

Campaign matrix and full design: `docs/plans/proposals/2026-08-20-harness-benchmark-suite.md`.

Results land in `results/` (gitignored); result datasets are optionally
published to HF (`your-hf-user/gdpval-results-*`) for archival.
