# Dev2 performance certification

This suite drives the real Kubernetes CTXMILL deployment at
`https://stablehand.staging.example.com`, while sampling the dev2 node and CTXMILL
namespace. It uses the public `@ctxmill/client` control and durable SSE
contracts; it never calls a harness adapter directly.

## Run it

The smoke profile is the default and is intentionally bounded to concurrency
one:

```bash
pnpm perf:dev2
```

Choose a profile and output directory explicitly:

```bash
tests/performance/scripts/run-dev2.sh \
  tests/performance/profiles/dev2-capacity.json \
  .tmp/performance/dev2-capacity-manual
```

Run the gated edge search (the global limit is restored on interruption and is
changed permanently only after three passes at the candidate capacity):

```bash
tests/performance/scripts/run-dev2-adaptive-capacity.sh
```

Inspect the exact load without a token or network call:

```bash
pnpm exec bun tests/performance/cli.ts plan \
  --profile tests/performance/profiles/dev2-model-matrix.json
```

The wrapper reads `CTXMILL_API_TOKEN` from the process environment or, when it
is absent, decodes it in memory from the dev2 `ctxmill-core-secrets` Secret.
The token is not printed or written to the evidence directory. The default
Kubeconfig is `/path/to/workspace/infra/.k3s-kubeconfig.yaml`.

Do not run `dev2-capacity.json`, `dev2-scale-10.json`, or
`dev2-sse-fanout.json` casually. Dev2 is a shared node. The sampler aborts the
runner when node CPU or memory exceeds the profile ceiling, and the runner
stops a stage when its measured turn error rate crosses the declared threshold.

## Profiles

- `dev2-smoke.json`: one cold turn through LangGraph, PI Agent, and Claude
  Agents, plus one LangGraph checkpoint/restore turn. Two SSE consumers per
  agent verify fanout.
- `dev2-capacity.json`: an explicit 1, 3, 5 cold-concurrency ramp, harness
  comparison, warm-session load, and checkpoint/restore load. This is the
  profile used to find the safe capacity knee, not a cron job.
- `dev2-sse-fanout.json`: three hot-agent conversations with 10 and then 50
  durable SSE consumers. It isolates server-side stream fanout more than the
  ordinary capacity profile.
- `dev2-model-matrix.json`: 17 bounded turns across Deep Agents and PI Agent.
  It covers native OpenAI, Anthropic, and Google gateway protocols; all five
  curated Workers AI aliases; and one heterogeneous Deep Agents turn with GLM
  and Gemini subagents. The plan estimates 21 model calls.
- `dev2-scale-10.json`: a 1, 3, 5, 8, 10 concurrency ramp for both Deep Agents
  and PI Agent, then warm and checkpoint/restore lanes at concurrency 5. Its
  exact ceiling is 262 CTXMILL turns/model calls and 20 simultaneous SSE
  connections. Run it only after dev2 is configured for at least ten global
  sandboxes and a quiet test window is reserved.
- `dev2-adaptive-capacity.json`: the controller contract for separate Deep
  Agents and PI Agent cold waves at 1 through 100 concurrency. It is expanded
  into one ordinary strict performance profile per wave so every result and
  safety decision remains independently reproducible. Each harness wave is
  homogeneous and the controller runs them sequentially against the shared
  global sandbox pool; this does not certify mixed-harness or Claude Agents
  concurrency.

Profiles are strict JSON. Every non-cold stage must declare at least one
`warmupTurns`; this prevents a mislabeled "warm" or "resume" result from
actually measuring a cold session. `safety.maxTurns` and
`safety.maxEstimatedModelCalls` reject accidental load expansion before the
first API call. `requirements.modelGateway: "required"` fails before agent
reconciliation unless CTXMILL reports a healthy LiteLLM reconciliation path;
this prevents aliases from silently falling back to direct provider traffic.
The dev2 wrapper also checks `requirements.minGlobalContainers` against the
effective `/api/sandbox/metrics` value, so the scale-10 ramp cannot be mistaken
for ten-way execution while the orchestrator is still queuing above five.
The model matrix and adaptive ramp also declare `expectedOutput`. A terminal
`COMPLETED` status is not a pass unless the final persisted assistant message
matches that value exactly; this catches models that consume their output
allowance in hidden reasoning and never produce a user-visible answer.

## Harness and model coverage

The `langgraph` harness is CTXMILL's Deep Agents implementation. It constructs
`deepagents.createDeepAgent()` with provider-native LangChain clients, supports
cross-provider subagents, and aggregates usage by LangChain model-run ID. The
matrix runs `deepagents` 1.11.1, the current npm release on 2026-07-26.

PI Agent uses `@earendil-works/pi-coding-agent` and `pi-ai` 0.82.1. It has one
configured model per session rather than Deep Agents-style subagents. Its
canonical config supports `maxTokens`, `reasoning`, and `thinkingLevel`, so a
benchmark can bound output and reasoning without provider-specific keys in the
agent manifest. Both harnesses attach opaque per-turn correlation headers when
the deployment gateway is selected.

The matrix intentionally exercises protocol separately from model identity:

| Lane | Canonical harness provider | LiteLLM alias/protocol |
| --- | --- | --- |
| GPT-5.4 mini | `openai` | `gpt-5.4-mini` over OpenAI-compatible `/v1` |
| Claude Haiku 4.5 | `anthropic` | `claude-haiku-4-5` over native Anthropic |
| Gemini 3.6 Flash | `google` | `gemini-3.6-flash` over native Google `v1beta` |
| GLM 5.2 | `openai` | `cf-glm-5.2` translated by LiteLLM to Workers AI |
| GPT-OSS, Kimi, Gemma, Qwen | `openai` | curated `cf-*` Workers AI aliases |

GLM 5.2 is `@cf/zai-org/glm-5.2` behind the gateway. A durable Workers AI
token with the correct account scope is a release prerequisite; a listed
LiteLLM alias is not proof that its provider credential works. The matrix
uses explicit output/reasoning bounds, and the runner still records actual
gateway-reconciled token and cost coverage.

## LLM budget envelope

The load planner counts calls; it does not duplicate the product pricing table
or pretend a dollar estimate is enforcement. For short fixed-response prompts,
use these operating envelopes:

| Profile | Planned turns | Estimated model calls | Expected spend | Reserve | Hard policy ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| `dev2-model-matrix` | 17 | 21 | $0.10-$0.30 | $1 | $1 |
| `dev2-scale-10` | 262 | 262 | $0.65-$1.10 | $2 | $3 |
| Both once | 279 | 283 | $0.75-$1.40 | $3 | $4 |

The range assumes roughly 3,000-5,000 input tokens and normally at most 64
output tokens per ordinary model call. The Gemini Deep Agents and Qwen matrix
lanes allow up to 256 tokens because those models can spend part of the bound
on reasoning. The mixed Deep Agents lane is budgeted as five calls. Provider
retries, model-side reasoning, tool loops, and pricing changes can move actual
spend, which is why the deployment gateway policy—not this estimate—must hold
the hard ceiling. Repeat capacity runs require multiplying the reserve by the
repeat count.

## Measurements

The load generator records:

- admission latency: message POST start to the accepted turn response;
- first event and `RUN_STARTED`: POST start to receipt on the primary SSE
  client;
- time to first token: POST start to the first non-empty
  `TEXT_MESSAGE_CONTENT`;
- completion: POST start to `RUN_FINISHED` or `RUN_ERROR`;
- server-to-client event lag, corrected with a five-probe health-endpoint clock
  estimate and reported with the clock uncertainty;
- checkpoint suspend and restore request duration;
- canonical token totals, known cost, total cost, and cost coverage refreshed
  from turn details after LiteLLM reconciliation settles;
- reconciled observed, priced, and expected model-call counts for every turn;
- unique canonical events per second and total SSE deliveries per second;
- per-turn event counts and ordered `event-id:event-type` sequences on every
  SSE consumer. Any count or sequence disagreement is an SSE fanout mismatch.

The orchestrator emits manual OpenTelemetry spans and low-cardinality
histograms for:

```text
turn.execute           session.ensure          session.create
session.restore        workspace.prepare       workspace.restore
sandbox.queue          sandbox.create          sandbox.start
sandbox.ready          harness.open            turn.first_event
turn.first_token       turn.delivery           event.persist
checkpoint.suspend
```

Turn, conversation, session, and agent IDs are trace attributes only. Metrics
contain bounded attributes such as harness, mode, runtime, session state,
topology, phase, and outcome. This avoids turning IDs into unbounded metric
series. SigNoz traces are exported by `collect-dev2-traces.sh`, which correlates
orchestrator spans by turn ID and sandbox `DeliverTurn` spans by the durable
session resource ID. It selects only operational correlation fields and does
not dump request bodies, model content, secrets, or arbitrary span attributes.

The Kubernetes sampler records every two seconds:

- node allocatable CPU/memory and metrics-server usage;
- CTXMILL pod CPU/memory, labels, and container breakdown from the immediate
  kubelet summary API, falling back to metrics-server when necessary;
- running sandbox jobs and pending sandbox pods.

The final report includes peak node, orchestrator, and sandbox usage plus the
fraction of observed running sandbox pods that had a resource sample. This
prevents short-lived pods missing from metrics-server from appearing as false
zero CPU and memory.
`load-generator-resource.txt` separately captures CPU and maximum RSS for the
dev1-side runner.

## Evidence

Every run writes under `.tmp/performance/` by default:

```text
plan.json                   preflight load and model-call accounting
run.json                    v2 result with plan, requirements, and gateway preflight
turns.jsonl                 one external sample per measured turn
turn-ids.txt                trace-correlation keys
kubernetes.jsonl            raw two-second resource samples
kubernetes-summary.json     normalized resource peaks
traces.jsonl                correlated SigNoz spans
report.md                   readable result table and limitations
load-generator-resource.txt dev1 runner process resource use
runner.stdout.jsonl         machine-readable runner completion
runner.stderr.log           runner diagnostics
failure.json                present only when the runner failed
ABORT                       present only when a safety ceiling tripped
before/after-pods.json      restart and OOM comparison boundary
before/after-events.json    namespace event delta boundary
*-litellm-metrics.prom      gateway counters before and after the wave
*-litellm-metrics-status.json explicit availability of the optional endpoint
orchestrator.log            bounded service logs since wave start
litellm.log                 bounded gateway logs since wave start
sandbox.log                 bounded surviving sandbox logs since wave start
gateway-before/after.json   reconciliation health and monotonic-counter boundary
sandbox-metrics-after.json  post-settle active and queued container counts
gateway-settlement.jsonl    reconciliation watermark observations
cleanup-before/after.jsonl  controller-owned clean-boundary observations
capacity-observation.json   normalized correctness/resource/telemetry facts
capacity-decision.json      advance or stop plus exact violations
```

Benchmark agents use stable names and carry
`metadata["ctxmill.performance.managed"] = true`. The seeder updates only those
owned agents and refuses to overwrite a same-named ordinary agent.

## Capacity protocol

Capacity is the highest completed ramp stage before any of these gates fails:

- turn error rate exceeds the profile ceiling;
- a sandbox waits in the orchestrator queue long enough to breach the latency
  objective;
- Kubernetes pods remain Pending;
- node CPU or memory crosses the safety ceiling;
- TTFT or completion p95 crosses the product SLO;
- any SSE consumer misses or duplicates a terminal turn sequence.
- fewer than 95% of measured turns have both `ctxmill.turn.execute` and
  `ctxmill.turn.delivery` traces;
- fewer than 95% of measured sessions have a sandbox `DeliverTurn` span, or
  fewer than 80% of running sandbox-pod observations have resource metrics;
- Kubernetes never observes the requested number of active sandbox Jobs;
- any turn lacks fully settled model-call and cost coverage;
- any active or queued sandbox container remains after settlement;
- any service restart, OOM kill, critical namespace event, or critical bounded
  log signature occurs during the wave;
- the LiteLLM reconciler is unhealthy, its watermark is older than the wave,
  it leaves pending calls, or the wave increases unpriced, quarantined, or
  orphan spend counters.

Pending calls are an instantaneous post-settlement gauge and must be zero.
Unpriced, quarantined, and orphan values are monotonic operational counters,
so capacity decisions use the `gateway-before.json` to `gateway-after.json`
delta. Historical diagnostic residue therefore remains visible without
poisoning unrelated later waves.

Pending pods are recorded immediately for diagnosis, but trip the gate only
after the configured 30-second grace window. This separates ordinary
scheduling latency from an unschedulable wave. The controller uses 100 only as
the temporary search ceiling and stops at the first gate failure. On this
single-node cluster, the Kubernetes pod ceiling is expected to become relevant
before 100 concurrent sandbox pods.

Before and after every discovery or confirmation wave, the controller kills
only benchmark-owned sessions and waits for Kubernetes active Jobs plus the
canonical sandbox active/queued counters to reach zero. A dirty boundary fails
the wave instead of allowing leftover work to contaminate the next result.

Repeat each candidate stage in at least three separate runs before calling it a
capacity result. Report the exact harness versions, model/provider routes,
profile, dev2 image tag, node allocatable resources, and background node load.
A smoke run proves wiring only; it is not a scalability claim. Provider API
latency and rate limits remain part of a real-harness result, so compare
orchestrator lifecycle spans with client timing before attributing a regression
to CTXMILL.
