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

The wrapper reads `CTXMILL_API_TOKEN` from the process environment or, when it
is absent, decodes it in memory from the dev2 `ctxmill-core-secrets` Secret.
The token is not printed or written to the evidence directory. The default
Kubeconfig is `/path/to/workspace/infra/.k3s-kubeconfig.yaml`.

Do not run `dev2-capacity.json` or `dev2-sse-fanout.json` casually. Dev2 is a
shared node. The sampler aborts the runner when node CPU or memory exceeds the
profile ceiling, and the runner stops a stage when its measured turn error rate
crosses the declared threshold.

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

Profiles are strict JSON. Every non-cold stage must declare at least one
`warmupTurns`; this prevents a mislabeled "warm" or "resume" result from
actually measuring a cold session.

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
- canonical token totals, known cost, total cost, and cost coverage from the
  final turn detail;
- unique canonical events per second and total SSE deliveries per second;
- per-turn event counts on every SSE consumer. Any count disagreement is an
  SSE fanout mismatch.

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
series. SigNoz traces are exported by `collect-dev2-traces.sh`, which selects
only operational correlation fields and does not dump request bodies, model
content, secrets, or arbitrary span attributes.

The Kubernetes sampler records every two seconds:

- node allocatable CPU/memory and metrics-server usage;
- CTXMILL pod CPU/memory, labels, and container breakdown;
- running sandbox jobs and pending sandbox pods.

The final report includes peak node, orchestrator, and sandbox usage.
`load-generator-resource.txt` separately captures CPU and maximum RSS for the
dev1-side runner.

## Evidence

Every run writes under `.tmp/performance/` by default:

```text
run.json                    complete profile and stage result
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

Repeat each candidate stage in at least three separate runs before calling it a
capacity result. Report the exact harness versions, model/provider routes,
profile, dev2 image tag, node allocatable resources, and background node load.
A smoke run proves wiring only; it is not a scalability claim. Provider API
latency and rate limits remain part of a real-harness result, so compare
orchestrator lifecycle spans with client timing before attributing a regression
to CTXMILL.
