# Stablehand Canonical E2E Testing Journey

_Last updated: 2026-05-02_

This is the canonical operational document for deep end-to-end Stablehand
testing. It defines the full feature journey, the parallel execution tracks,
the expected evidence, and the known coverage gaps. Use this when the goal is
to prove product functionality in depth, not only to run the required release
gate.

Related documents:

- `docs/release-gates.md` is the short source of truth for what blocks a
  release.

## Local target and CLI

The default local browser target is the Docker stack's UI port. Point these at
your own deployment's URL if you front the stack with a proxy:

```bash
export STABLEHAND_BROWSER_URL="http://localhost:3200"
export STABLEHAND_API_URL="http://localhost:3002"
export STABLEHAND_CLI="$(git rev-parse --show-toplevel)/.codex/skills/stablehand-cli/scripts/stablehand.ts"
```

Use `agent-browser` for all browser E2E certification and manual stress
testing.

The browser loop is `open` -> `snapshot -i` -> interact by `@eN` refs ->
re-snapshot after every page change. Capture screenshots, console output,
runtime errors, and network requests as evidence. Do not use scripted browser
test runners as a substitute for this journey.

Use the stablehand CLI before raw `curl` for API evidence:

```bash
bun "$STABLEHAND_CLI" health --base-url "$STABLEHAND_API_URL" --json
bun "$STABLEHAND_CLI" config --base-url "$STABLEHAND_API_URL" --json
bun "$STABLEHAND_CLI" sandbox metrics --base-url "$STABLEHAND_API_URL" --json
bun "$STABLEHAND_CLI" settings get --base-url "$STABLEHAND_API_URL" --json
bun "$STABLEHAND_CLI" agents list --base-url "$STABLEHAND_API_URL" --json
curl -fsS "$STABLEHAND_API_URL/api/conversations?status=active"
curl -fsS "$STABLEHAND_API_URL/api/sandbox-sessions?status=active"
bun "$STABLEHAND_CLI" tools list --base-url "$STABLEHAND_API_URL" --json
bun "$STABLEHAND_CLI" events types --base-url "$STABLEHAND_API_URL" --json
```

Use raw HTTP only for surfaces the CLI does not cover, such as byte download
assertions and direct presigned upload object writes.

## Evidence contract

Every deep run must write all generated evidence under `.tmp/`:

```bash
export STABLEHAND_E2E_TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
export STABLEHAND_E2E_DIR=".tmp/e2e-journey-${STABLEHAND_E2E_TS}"
mkdir -p \
  "$STABLEHAND_E2E_DIR"/{cli,api,docker,agent-browser,stress,visual,webhooks,logs,bundles}
git rev-parse HEAD > "$STABLEHAND_E2E_DIR/git-head.txt"
git status --short --untracked-files=all > "$STABLEHAND_E2E_DIR/git-status.txt"
```

Required evidence files:

| Path | Contents |
| --- | --- |
| `git-head.txt` | Commit under test. |
| `git-status.txt` | Clean or intentionally dirty tree state. |
| `cli/*.json` | stablehand CLI JSON evidence. |
| `api/*.json` | Raw API probes not covered by the CLI. |
| `docker/docker-ps.txt` | Container status after stack start and after test cleanup. |
| `logs/orchestrator.log` | Post-run orchestrator logs. |
| `logs/orchestrator-error-scan.txt` | Scan for critical server errors. |
| `agent-browser/*` | agent-browser snapshots, console output, errors, network requests, traces, videos, and command transcripts. |
| `stress/events.json` | Required stress event rows and schema checks. |
| `stress/turns.json` | Terminal turn rows. |
| `visual/screenshots/*.png` | Manual and visual QA screenshots. |
| `webhooks/requests.json` | Captured webhook receiver requests. |
| `summary.md` | Final pass/fail/gap summary. |

Test-owned objects should use an `E2E Journey <timestamp>` name prefix and must
be deleted before completion unless the test is intentionally proving orphan or
global ownership behavior.

## Parallel tracks

Use isolated stacks, ports, databases, or feature environments before running
mutating tracks in parallel. On the shared local Docker stack, run mutating
tracks sequentially and parallelize only read-only inspections.

| Track | Depends on | Parallelizable | Evidence | Blocking level |
| --- | --- | --- | --- | --- |
| Static/package gates | Installed dependencies | Yes | command logs | Required |
| Local stack rebuild and health | Static gates preferred | No, owns Docker volumes | health JSON, `docker ps` | Required |
| Required browser smoke | Local stack healthy | No on shared stack | agent-browser snapshots, screenshots, console/errors/network output | Required |
| API and CLI contract sweep | Local stack healthy | Partially, if using unique fixtures | CLI/API JSON | Certification |
| UI manual journey | Local stack healthy | No on shared stack | agent-browser screenshots, console log | Certification |
| Full browser journey | Required smoke green | Isolated stack preferred | agent-browser dogfood report, traces, videos | Extended |
| Harness/stress matrix | Provider keys, harness images | Isolated stack preferred | stress events/turns | Required for smoke, extended for non-required rows |
| Lifecycle/failure injection | Local stack healthy | No | turn and sandbox-session rows, Docker state | Extended/certification |
| Visual QA | Provider keys where needed | Isolated stack preferred | screenshots/audit | Extended |
| Staging deploy smoke | Release candidate, cluster credentials | Yes vs local extended | deploy logs, staging smoke | Optional, per deployment |

## Command matrix

| Stage | Command | Notes |
| --- | --- | --- |
| Install | `pnpm install` | Use the pinned package manager. |
| Static | `pnpm typecheck` | Required. |
| Static | `pnpm -r build` | Required. |
| Static | `pnpm lint` | Required; warnings are acceptable if existing and understood. |
| Static | `pnpm test` | Backend/unit/integration/compliance via Vitest. |
| Static | `pnpm test:ui` | UI Vitest with strict console setup. |
| Stack | `docker compose down -v && docker compose up --build -d` | Required for fresh local certification. |
| CLI/API preflight | Health/config/settings/agents/turns/conversations/sandbox sessions/tools/events | Required for deep certification evidence. |
| Required browser smoke | `agent-browser --session stablehand-smoke --ignore-https-errors open "$STABLEHAND_BROWSER_URL"` then snapshot/click the smoke path below | Required release gate. |
| Stabilization | `pnpm verify:stabilization` | Certification support. |
| Fresh deploy | `pnpm verify:fresh-deploy` | Supporting helper; verify current script behavior before treating as authoritative. |
| Full browser | agent-browser dogfood journey using this document | Extended full product journey. |
| Harness matrix | stablehand CLI live runs plus agent-browser UI verification | Cover each harness/model row with strict terminal-state and event evidence. |
| Staging | Your deploy script, then agent-browser smoke against the staging URL | Optional, per deployment. |

Minimum agent-browser smoke path:

```bash
agent-browser --session stablehand-smoke --ignore-https-errors --args "--no-sandbox,--disable-dev-shm-usage" open "$STABLEHAND_BROWSER_URL"
agent-browser --session stablehand-smoke wait --load domcontentloaded
agent-browser --session stablehand-smoke screenshot --annotate "$STABLEHAND_E2E_DIR/agent-browser/00-dashboard.png"
agent-browser --session stablehand-smoke snapshot -i > "$STABLEHAND_E2E_DIR/agent-browser/00-dashboard.snapshot.txt"
agent-browser --session stablehand-smoke console > "$STABLEHAND_E2E_DIR/agent-browser/00-dashboard.console.txt"
agent-browser --session stablehand-smoke errors > "$STABLEHAND_E2E_DIR/agent-browser/00-dashboard.errors.txt"
agent-browser --session stablehand-smoke network requests > "$STABLEHAND_E2E_DIR/agent-browser/00-dashboard.network.txt"
```

For the deep run, keep the same session and drive every UI route and feature
case below with `snapshot -i` refs or semantic `find role/text/label`
commands. Re-snapshot after each navigation, click, form submit, modal open,
or dynamic rerender.

## Feature journey matrix

Each case should be executed through at least one user-facing path and one
machine-verifiable path. Prefer the stablehand CLI for machine-verifiable API
evidence.

### Service, Settings, and Runtime Health

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-SVC-01 health and config | `/health`, `/api/health`, config, and sandbox metrics return successful JSON; no active container leak before run. | CLI `health`, `config`, `sandbox metrics`; API `/api/health`. | `cli/health.json`, `cli/config.json`, `cli/sandbox-metrics-before.json`. |
| E2E-SVC-02 settings read/write | Settings render in UI and round-trip through API; invalid/out-of-range values fail clearly. | CLI `settings get/set`; UI `/settings`; API `/api/settings`. | `cli/settings-before.json`, screenshot, update response, `settings-after.json`. |
| E2E-SVC-03 post-run health | Health remains OK, active/queued containers are expected, and logs have no critical errors. | CLI `health`, `sandbox metrics`; Docker logs. | `cli/health-after.json`, `logs/orchestrator-error-scan.txt`. |

Known gaps: there is no route-level settings integration test and no
agent-browser SettingsPage journey. UI/backend numeric ranges should be verified
because explorers found possible range mismatches.

### Agents, Manifests, and Scaffold

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-AGT-01 CRUD | Create/list/get/update/delete agent; deleted agent returns 404. | CLI `agents create/list/get/update/delete`; UI dashboard create modal. | `cli/agent-create.json`, dashboard screenshot. |
| E2E-AGT-02 invalid definitions | Missing required fields, invalid harness config, unsupported top-level `model`, and empty update fail with 4xx. | CLI `agents create/update`; API negative probes. | `api/agent-invalid-*.json`. |
| E2E-AGT-03 manifest path | YAML/JSON manifest converts to stored agent definition and preserved manifest metadata. | Agent CRUD with manifest-shaped payload; example manifests. | `cli/manifest-agent.json`. |
| E2E-AGT-04 scaffold smoke | `create-stablehand` output has expected files and can be built or imported where supported. | `packages/create-stablehand`; generated fixture under `.tmp`. | command log and generated tree. |

Known gaps: kitchen-sink docs reference import behavior that is not clearly
exposed as a current route. The scaffold tests are mostly static and do not
prove a generated project in a live stack.

### Turns, Conversations, SSE, and AG-UI

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-SES-01 interactive message | Message returns `messageId`, `conversationId`, and `turnId`; UI displays the user message and terminal assistant state. | `POST /api/agents/:id/message`; UI conversation page. | `api/interactive-message.json`, screenshot. |
| E2E-SES-02 background turn | Background turn appears in turn list/detail, reaches a strict expected terminal state, and has message count. | `POST /api/agents/:id/turns`; `GET /api/agents/:id/turns/:turnId`; UI Turns tab. | `api/background-turn.json`, `api/turns-list.json`. |
| E2E-SES-03 SSE stream | Stream emits `CONNECTED`, run start, text/tool events where expected, committed messages, and terminal event; replay with `Last-Event-ID` works. | CLI `stream`; native EventSource script. | `cli/stream.json`, raw SSE transcript. |
| E2E-SES-04 AG-UI run | Existing conversation run returns AG-UI events with a consistent thread/run contract; wrong thread/run fails with 409. | CLI `run`; API `/api/ag-ui/:id/run`. | `cli/ag-ui-run.json`, negative probe JSON. |
| E2E-SES-05 conversation snapshot | Conversation summary and snapshot messages match the live run transcript, including `parts` and tool calls; streaming resumes strictly after `eventCursor`. | CLI `conversations summary/snapshot`; UI reload. | `cli/conversation-summary.json`, `cli/snapshot.json`. |
| E2E-SES-06 feedback | Submit thumbs up/down on a persisted message and verify `feedback.received`. | CLI `feedback submit`; API `/api/events`. | feedback response and event row. |

Known gaps: AG-UI docs contain stale paths; the CLI `run --task` creates a new
thread while the server path may require an existing conversation. Browser
console strictness must be enforced directly with `agent-browser console`,
`agent-browser errors`, and `agent-browser network requests`.

### Harnesses and Sandbox Execution

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-HRN-01 LangGraph required run | LangGraph starts in Docker, streams, completes, emits exactly one required stress event. | `tests/e2e/stress-smoke.spec.ts`; turn/event APIs. | stress event row, turn row, logs. |
| E2E-HRN-02 Claude Agents required run | Claude harness runs native file/tool sequence, completes, and emits exactly one required stress event. | `tests/e2e/stress-smoke.spec.ts`; turn/event APIs. | stress event row, turn row, logs. |
| E2E-HRN-03 PI Agent required run | PI harness completes and emits exactly one required stress event. | `tests/e2e/stress-smoke.spec.ts`; turn/event APIs. | stress event row, turn row, logs. |
| E2E-HRN-04 provider preflight | Required provider keys are loaded without printing secrets; missing keys are classified as environment failures, not product passes. | env checks, harness config. | redacted env preflight. |
| E2E-HRN-05 harness image freshness | Harness Docker images were rebuilt after sandbox-daemon changes. | `docker compose up --build -d`; image IDs. | `docker/docker-images.txt`. |

Required terminal-state checks should reject unexpected `error`, `failed`, or
`cancelled` states. Intentional cancellation tests must document the exception.

### Lifecycle: Cancellation, Suspend, Resume, Recovery, Cleanup

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-LFC-01 cancellation | Long-running active turn cancels to `cancelled`; SSE emits terminal error/finish semantics; no active runtime leaks. | `POST /api/agents/:id/turns/:turnId/cancel`; UI cancel control where available. | turn detail before/after, SSE transcript, sandbox metrics. |
| E2E-LFC-02 suspend/checkpoint/restore | Live sandbox session can be checkpointed at a safe point, restored to active, and continued; workspace diff/tombstones are correct. | Sandbox-session lifecycle API; turn detail; follow-up message. | checkpoint response, restored sandbox-session row, file diff evidence. |
| E2E-LFC-03 kill | Kill terminates sandbox session and further operations fail clearly or recreate safely where intended. | CLI `sandbox-sessions kill`; API detail. | kill response, metrics after. |
| E2E-LFC-04 recovery | Harness container failure is reconciled into checkpointed/terminated policy and subsequent turns recover. | Docker failure injection on isolated stack. | Docker events, recovery coordinator logs, sandbox-session and turn rows. |
| E2E-LFC-05 cleanup invariant | No test-owned active sandbox sessions, active slots, managed containers, or leaked test agents remain. | Agents API, active conversation/sandbox-session APIs, sandbox metrics; Docker filters. | cleanup JSON and `docker-ps-after.txt`. |

Known gaps: there is no canonical Docker-stack E2E for live
suspend/checkpoint/resume, live recovery, or strict cancellation terminal
state. Much of this is currently covered below browser level.

### Tools, Tool Providers, PTC, and Tool Calls

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-TOL-01 catalog and tester | Tool catalog lists built-in/local/HTTP/artifact tools with schemas, location, and approval flags; direct tool test succeeds and validation failures are explicit. | CLI `tools list/test`; UI `/tools`; API `/api/catalogs/tools`. | `cli/tools-list.json`, `cli/tool-test.json`, `/tools` screenshot. |
| E2E-TOL-02 provider scoping | Two agents can declare same HTTP tool name without cross-routing; auth, timeout, 500, and schema errors are explicit. | Agent CRUD, catalog, CLI `tools test`, live run. | per-agent tool responses. |
| E2E-TOL-03 gRPC tool proxy | Sandbox tool call goes daemon to orchestrator to provider and back; UI tool card and event log agree. | Live harness run, CLI `events list`, `stablehand-toolcalls.ts`. | toolcall timeline and screenshot. |
| E2E-TOL-04 PTC live path | Programmatic tool creates generated `.tools` scripts, script calls daemon API, large payload is summarized, raw payload is not leaked. | Live agent prompt, workspace files, `stablehand-toolcalls.ts`. | generated script listing, transcript, event row. |
| E2E-TOL-05 daemon artifact tools | Agent invokes `artifact_upload` and `artifact_download` through daemon location. | Live run, artifacts API, UI artifacts tab. | artifact metadata and downloaded byte hash. |

Known gaps: there is no live E2E proving a model actually uses generated PTC
scripts. The docs mention `executionMode: "ptc"`, but current code evidence
does not prove that event tag is implemented. MCP and Composio need explicit
live coverage or documented environment classifications.

### Events, Triggers, Webhooks, and HITL

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-EVT-01 event log | Event list, stats, types, filters, cursors, and agent scoping work. | CLI `events list/types/stats`; UI `/events`. | event JSON and screenshot. |
| E2E-EVT-02 trigger CRUD | Create/list/get/update/delete/toggle trigger; duplicate or invalid definitions fail clearly. | CLI `triggers create/list/get/update/delete`; UI `/triggers`. | trigger JSON and screenshot. |
| E2E-EVT-03 event chain | Emitted custom event matches selector/template, starts downstream background turn, records `trigger.fired`, and observes cascade-depth protection. | CLI `triggers emit`; event and turn APIs. | event sequence and downstream turn row. |
| E2E-WHK-01 webhook delivery | Webhook CRUD works; subscribed event sends expected headers/body to a live receiver; retry and terminal failure are covered. | CLI `webhooks add/list/update/delete`; local receiver. | `webhooks/requests.json`, callback logs. |
| E2E-HITL-01 approve/reject | `request-approval` creates an independent durable `interruptId`; UI approval card renders; approve resumes; reject returns rejected tool result. | Interrupt list/resolution API; UI conversation page. | interrupt rows, screenshots, events. |
| E2E-HITL-02 invalid resolution | Wrong agent/interrupt, malformed action, already resolved, and missing pending interrupt fail clearly. | API negative probes. | negative response JSON. |

Known gaps: `/events`, `/triggers`, live webhook receiver, and deterministic
HITL UI journeys are undercovered in browser E2E. Existing HITL visual tests
depend on provider configuration.

### Files and Workspace Upload

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-FIL-01 browse/read | Agent file tree and nested file viewer render; API list/read returns expected content. | CLI `files ls/cat`; UI files tab. | file JSON and screenshots. |
| E2E-FIL-02 write/update/delete | Create, edit, and delete files through API/CLI and verify UI refresh. | CLI `files write/update/delete`; UI files tab. | file operation JSON and screenshots. |
| E2E-FIL-03 blocked paths | Traversal, `.env`, `.git`, secret paths, directory reads, and oversized reads fail clearly. | CLI/API negative probes. | negative response JSON. |
| E2E-FIL-04 workspace tar | Valid `.tar.gz` upload extracts atomically; invalid archive, symlink/hardlink/special file, active-sandbox-session conflict, and force behavior are explicit. | CLI `workspace upload`; UI upload control. | upload response, file tree screenshot. |
| E2E-FIL-05 conversation scope | `conversationId` file access reads the intended durable conversation workspace and rejects a conversation owned by another agent. | File API probes with `conversationId`; UI conversation workspace. | before/after JSON. |

UI upload copy should be verified against server limits.

### Artifacts

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-ART-01 multipart upload | Upload artifact, list globally/by agent/by turn, inspect metadata, download bytes, then delete. | Artifact API with `turnId`; UI `/artifacts` and agent artifacts tab. | metadata JSON, byte hash, screenshots. |
| E2E-ART-02 signed upload | Signed upload URL creates `pending_upload`; download before object upload returns 409; uploaded object confirms to active. | CLI `artifacts upload-url`; raw object PUT; API download. | pending/active responses. |
| E2E-ART-03 ownership | Deleting an agent preserves artifact rows as global/unowned where intended. | Agent delete, artifacts list. | before/after artifact JSON. |
| E2E-ART-04 storage failures | Object upload/delete/store failures are compensated or surfaced without silent success. | Isolated mocked/integration path or failure-injection stack. | route/test output. |

Known gaps: there is no agent-browser artifact UI journey and no full live
sandbox-run proof for daemon `artifact_upload` and `artifact_download`.

### Secrets

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-SEC-01 secret CRUD | Add/list/delete secret key; responses never echo secret values; UI masks values. | CLI `secrets set/list/delete`; UI secrets tab. | key-only JSON and screenshot. |
| E2E-SEC-02 runtime injection | Saved `$secret:KEY` and runtime `sandboxSecrets` resolve inside sandbox without checkpoint persistence. | Live harness run with redacted proof. | transcript with non-secret proof and checkpoint scan. |
| E2E-SEC-03 invalid inputs | Bad key names, non-string values, missing provider, and missing agent fail clearly. | CLI/API negative probes. | negative response JSON. |

Known gaps: there is no route/UI E2E for the Secrets tab and no canonical live
proof that a UI-created saved secret reaches sandbox `$secret` resolution.

### UI Pages, Mobile, Visual QA, and A2UI

| Case | Assertions | Paths | Evidence |
| --- | --- | --- | --- |
| E2E-UI-01 dashboard | Agent cards, stats, search/filter, recent conversations, loading/error/retry states render. | UI `/`; agent and active-conversation APIs. | desktop/mobile screenshots. |
| E2E-UI-02 agent detail tabs | Overview, turns, tools, files, artifacts, secrets tabs render and controls are clickable. | UI `/agents/:id`. | one screenshot per tab. |
| E2E-UI-03 conversation page | Composer, starter cards, streamed messages, markdown, tool cards, errors, and persisted reload render. | UI conversation routes and detail. | screenshots and console log. |
| E2E-UI-04 events/triggers/settings/tools/artifacts | Top-level pages render real data, filters/actions work, and errors are recoverable. | UI routes `/events`, `/triggers`, `/settings`, `/tools`, `/artifacts`. | screenshots and API evidence. |
| E2E-UI-05 mobile nav | Mobile sidebar opens/closes, route changes work, overlay/Escape behavior works, text does not overlap. | Browser viewport <= 767px. | mobile screenshots. |
| E2E-VQA-01 visual QA | Live streaming transitions, replay, error states, HITL cards, A2UI charts, markdown, and tool cards are captured and audited. | `tests/e2e/visual-qa-*`; manual screenshots. | captures and audit notes. |

Known gaps: Events UI, Triggers UI, Settings UI, Artifacts UI, Secrets UI, and
mobile navigation have little or no current agent-browser coverage. Visual QA
currently writes some captures outside `.tmp`; deep runs should copy or direct
evidence into the run directory.

## Existing scripted coverage inventory

These scripted browser specs are regression fixtures. They can provide
supporting evidence, but they are not the canonical deep E2E journey and do
not replace agent-browser certification:

- `tests/e2e/background-run.spec.ts`
- `tests/e2e/chat.spec.ts`
- `tests/e2e/conversation-continuity.spec.ts`
- `tests/e2e/customer-readiness-stage4-ui.spec.ts`
- `tests/e2e/dashboard.spec.ts`
- `tests/e2e/files-tab.spec.ts`
- `tests/e2e/five-minute-journey.spec.ts`
- `tests/e2e/fresh-deploy-smoke.spec.ts`
- `tests/e2e/harness-matrix.slice1.spec.ts`
- `tests/e2e/kitchen-sink.spec.ts`
- `tests/e2e/release-gate-smoke.spec.ts`
- `tests/e2e/session-lifecycle.spec.ts`
- `tests/e2e/streaming-fixes.spec.ts`
- `tests/e2e/stress-smoke.spec.ts`
- `tests/e2e/visual.spec.ts`
- `tests/e2e/visual-qa-*.spec.ts`

When current scripted coverage does not hit a feature in this matrix, the
deep run must drive that feature manually with agent-browser and include the
resulting screenshots, snapshots, console/error/network output, and API
evidence in the run summary.

## Known gap ledger

These are current findings from the 2026-05-02 source audit. Treat them as
targets for new tests or documentation fixes.

1. `tests/contract` is empty; a shipped API contract sweep is still needed.
2. The removed `knowledge`, `traces`, and `feedback stats` surfaces are not
   available through `stablehand-cli`; contract coverage should reject attempts
   to use those command names without issuing an HTTP request.
3. `fresh-deploy-smoke.spec.ts` is tagged `@extended`, so running it with the
   smoke config grep does not prove the intended cases.
4. `customer-readiness-stage4-ui.spec.ts` is untagged despite the tag contract.
5. The scripted harness-matrix command currently maps to one slice,
   not the whole theoretical harness matrix.
6. A staging deploy smoke is not part of CI; run it per deployment.
7. `tests/AGENTS.md` reports an old E2E file count.
8. Harness rebuild docs disagree with current Docker Compose build services.
9. Manual stress docs are weaker than ADR 012 because they allow "at least
    one" event while the automated stress helper requires exactly one.
10. There is no canonical live E2E for PTC generated-script execution,
    webhook receiver delivery, artifact daemon tool round-trip, secrets
    sandbox resolution, live suspend/resume, or recovery failure injection.

## Fresh-rebuild and visual-audit procedures

Absorbed from the retired phase runbook (`e2e-certification-runbook.md`, see
git history); use these when a run needs a from-scratch stack or an AI visual
pass.

**Fresh full-stack rebuild** — reset all Docker state before certification so
evidence exercises the actual images, not stale containers:

```bash
docker compose down -v
docker compose up --build -d
for i in {1..60}; do
  curl -fsS http://localhost:3002/health > "$STABLEHAND_E2E_DIR/health.json" && break
  sleep 1
done
curl -fsS http://localhost:3200 >/dev/null
docker compose ps > "$STABLEHAND_E2E_DIR/docker-ps.txt"
```

**Gemini visual audit** — run Gemini over the captured screenshots and demand a
structured verdict (pass/fail, screenshot-by-screenshot notes, blocking issues,
non-blocking polish, release-stability opinion). If ignore rules block `.tmp`
image reads, copy screenshots to an allowed directory (e.g.
`/tmp/stablehand-gemini-audit-screens`) and pass `--include-directories`. Treat
the audit as secondary evidence: manual inspection, console/error logs, and
public API assertions remain authoritative. Blocking findings must be fixed or
tracked before a release verdict.

**Log/error scan** — after all tests:

```bash
docker compose logs --tail=500 orchestrator > "$STABLEHAND_E2E_DIR/orchestrator.log"
rg -n "CRITICAL|FOREIGN KEY|foreign key|statusCode.:500|Unhandled|panic|uncaught" \
  "$STABLEHAND_E2E_DIR/orchestrator.log" > "$STABLEHAND_E2E_DIR/orchestrator-error-scan.txt" || true
```

## Completion criteria

A deep E2E run is complete only when:

1. Required gates either pass or have explicit, reproducible blockers.
2. Every feature case above has pass/fail/skipped-with-reason evidence.
3. Skips distinguish product bugs, stale tests, and environment/provider
   prerequisites.
4. All test-owned data is cleaned up, except data intentionally preserved to
   prove global/unowned behavior.
5. Docker state has no leaked managed containers or active slots.
6. Logs have no unexplained critical errors.
7. `summary.md` links to evidence files and lists new or existing beads for
   every unresolved failure.
