# Dev2 performance certification

This suite drives the real Kubernetes STABLEHAND deployment at
`https://stablehand.staging.example.com`, while sampling the dev2 node and STABLEHAND
namespace. It uses the public `@stablehand/client` control and durable SSE
contracts; it never calls a harness adapter directly.

## Evergreen findings

The maintained conclusions, operating envelope, known bottlenecks, and open
correctness risks from accepted and rejected runs live in
[`docs/performance-findings.md`](../../docs/performance-findings.md). Use the
dated reports in `docs/verification/` as immutable evidence and update the
synthesis only when a later accepted run changes a conclusion.

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

Run the ten-wave endurance certification at the already-applied concurrency
limit of eight:

```bash
tests/performance/scripts/run-dev2-endurance-10x.sh
```

The endurance controller never changes runtime settings. It runs ten ordinary
strict waves sequentially, applies the adaptive suite's correctness, telemetry,
resource, cleanup, and accounting gates after every wave, and stops at the
first rejected wave. Its hard envelope is 2,630 model calls by default.

Inspect the exact load without a token or network call:

```bash
pnpm exec bun tests/performance/cli.ts plan \
  --profile tests/performance/profiles/dev2-model-matrix.json
```

The wrapper reads `STABLEHAND_API_TOKEN` from the process environment or, when it
is absent, decodes it in memory from the dev2 `stablehand-core-secrets` Secret.
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
- `dev2-harness-lifecycle.json`: bounded concurrency-one cold, warm, and
  checkpoint/restore parity lanes for Deep Agents, PI Agent, and Claude Agents.
  It measures ten turns per lane, with one additional warmup in each warm and
  resume lane, without claiming capacity.
- `dev2-model-matrix.json`: 27 bounded turns across Deep Agents and PI Agent.
  It covers GPT-5.6 Sol, Terra, and Luna; Claude Opus 5, Sonnet 5, and Haiku
  4.5; Gemini 3.6 Flash and 3.5 Flash-Lite; all five curated Workers AI
  aliases; and one heterogeneous Deep Agents turn with GLM and Gemini
  subagents. The plan estimates 31 model calls.
- `dev2-scale-10.json`: a 1, 3, 5, 8, 10 concurrency ramp for both Deep Agents
  and PI Agent, then warm and checkpoint/restore lanes at concurrency 5. Its
  exact ceiling is 262 STABLEHAND turns/model calls and 20 simultaneous SSE
  connections. Run it only after dev2 is configured for at least ten global
  sandboxes and a quiet test window is reserved.
- `dev2-endurance-wave-c8.json`: one reproducible 263-call endurance wave at
  the certified concurrency limit of eight. It contains 243 measured turns,
  20 warmups, a single Claude Sonnet 5 canary, Deep Agents and PI cold ramps,
  warm reuse, checkpoint/restore, and up to 16 simultaneous SSE consumers.
  The controller repeats this exact wave ten times without raising capacity.
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
reconciliation unless STABLEHAND reports a healthy LiteLLM reconciliation path;
this prevents aliases from silently falling back to direct provider traffic.
The dev2 wrapper also checks `requirements.minGlobalContainers` against the
effective `/api/sandbox/metrics` value, so the scale-10 ramp cannot be mistaken
for ten-way execution while the orchestrator is still queuing above five.
The model matrix and adaptive ramp also declare `expectedOutput`. A terminal
`COMPLETED` status is not a pass unless the final persisted assistant message
matches that value exactly; this catches models that consume their output
allowance in hidden reasoning and never produce a user-visible answer.

## Harness and model coverage

The `langgraph` harness is STABLEHAND's Deep Agents implementation. It constructs
`deepagents.createDeepAgent()` with provider-native LangChain clients, supports
cross-provider subagents, and aggregates usage by LangChain model-run ID. The
matrix runs `deepagents` 1.11.1, the current npm release on 2026-07-26.

PI Agent uses `@earendil-works/pi-coding-agent` and `pi-ai` 0.82.1. It has one
configured model per session rather than Deep Agents-style subagents. Its
canonical config supports `maxTokens`, `reasoning`, and `thinkingLevel`, so a
benchmark can bound output and reasoning without provider-specific keys in the
agent manifest. Both harnesses attach opaque per-turn correlation headers when
the deployment gateway is selected.

The matrix intentionally exercises protocol separately from model identity.
Frontier models receive one bounded compatibility turn per harness; they are
not used for the volumetric waves:

| Lane | Canonical harness provider | LiteLLM alias/protocol |
| --- | --- | --- |
| GPT-5.6 Sol, Terra, Luna | `openai` | current `gpt-5.6-*` aliases over OpenAI-compatible `/v1` |
| Claude Opus 5, Sonnet 5, Haiku 4.5 | `anthropic` | current Claude aliases over native Anthropic |
| Gemini 3.6 Flash, 3.5 Flash-Lite | `google` | current Gemini aliases over native Google `v1beta` |
| GLM 5.2 | `openai` | `cf-glm-5.2` translated by LiteLLM to Workers AI |
| GPT-OSS, Kimi, Gemma, Qwen | `openai` | curated `cf-*` Workers AI aliases |

GLM 5.2 is `@cf/zai-org/glm-5.2` behind the gateway. A durable Workers AI
token with the correct account scope is a release prerequisite; a listed
LiteLLM alias is not proof that its provider credential works. The matrix
uses explicit output/reasoning bounds, and the runner still records actual
gateway-reconciled token and cost coverage.

All capacity, scale, and SSE-fanout stages use the same
`cf-gpt-oss-120b` route for Deep Agents and PI Agent. It passed the bounded
matrix with materially lower latency and spend than GLM 5.2, while keeping
harness comparisons like-for-like and repetitive load off frontier-priced
models. GLM 5.2 remains in the compatibility matrix. The bounded smoke profile
uses GPT-5.6 Luna and Claude Sonnet 5 to retain current-provider coverage.

The lifecycle profile is a separate like-for-like comparison. It runs cold,
warm, and checkpoint/restore lanes for Deep Agents, PI Agent, and Claude Agents
against the same `cf-glm-5.2-no-thinking` LiteLLM alias. That alias preserves
the reasoning-enabled `cf-glm-5.2` route and opts this bounded latency workload
into Workers AI's `chat_template_kwargs.enable_thinking: false` control. The
Claude harness reaches the alias through LiteLLM's Anthropic Messages
translation; every lifecycle stage omits `apiKeyRef` and `baseUrl`, so an
explicit direct provider route cannot bypass the configured deployment gateway.

## LLM budget envelope

The load planner counts calls; it does not duplicate the product pricing table
or pretend a dollar estimate is enforcement. For short fixed-response prompts,
use these operating envelopes:

| Profile | Planned turns | Estimated model calls | Expected spend | Reserve | Hard policy ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| `dev2-model-matrix` | 27 | 31 | $0.20-$0.60 | $1 | $1 |
| `dev2-harness-lifecycle` | 96 | 96 minimum | $1-$4 | $5 | $6 |
| `dev2-scale-10` | 262 | 262 | $0.50-$1.50 | $5 | $6 |
| Ten-wave c8 endurance | 2,630 | 2,630 | $12-$20 | $25 | $50 |
| Matrix + scale once | 289 | 293 | $0.70-$2.10 | $6 | $7 |
| Full adaptive worst case | 1,182 | 1,182 | $2-$6 | $10 | $15 |

The range assumes roughly 3,000-10,000 input tokens and short fixed responses.
The current Claude models allow a larger output ceiling because adaptive
thinking shares the output budget; the test still requires exactly one visible
token string. The mixed Deep Agents lane is budgeted as five calls. The
lifecycle call estimate is a minimum because Claude SDK protocol retries or
auxiliary requests can make more than one model call per STABLEHAND turn. Provider
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
- completion: POST start to the authoritative `RUN_FINISHED` boundary; failed
  turns include `RUN_ERROR` immediately before it;
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
- STABLEHAND pod CPU/memory, labels, and container breakdown from the immediate
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
`metadata["stablehand.performance.managed"] = true`. The seeder updates only those
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
- fewer than 95% of measured turns have both `stablehand.turn.execute` and
  `stablehand.turn.delivery` traces;
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
to STABLEHAND.
