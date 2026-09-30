# SigNoz for Debugging

Use this runbook when you need OpenTelemetry traces for stablehand API,
orchestrator behavior, and sandbox run behavior in the centralized dev2 SigNoz
instance.

## What Is Instrumented

The Docker Compose orchestrator service preloads stablehand's OTEL register module
through `NODE_OPTIONS`. Sandbox harness images preload the same module through
Bun's `--preload` flag. The register module wraps OpenTelemetry's Node auto
instrumentations with stablehand defaults: a bounded instrumentation set, OpenAI
message-content capture disabled, OTLP self-call filtering, and sanitized
HTTP/Undici URL attributes. Base `docker-compose.yml` keeps
`OTEL_TRACES_EXPORTER=none` so developers who are not exporting traces do not
get noisy export failures.

For SigNoz debugging, use `docker-compose.signoz.yml`. It does not start a
local SigNoz collector, ClickHouse, or SigNoz UI. Instead it exports
orchestrator and sandbox traces to the centralized dev2 OTLP HTTP endpoint:

```text
https://otlp-signoz.staging.example.com
```

The dev2 SigNoz UI is:

```text
https://signoz.staging.example.com
```

The orchestrator service appears as `stablehand-orchestrator`. Sandbox run
containers appear as `stablehand-sandbox-<harness>`, for example
`stablehand-sandbox-langgraph`, `stablehand-sandbox-claude-agents`, and
`stablehand-sandbox-pi-agent`.

Keep source environment attributes accurate. A local Docker stack should keep
`deployment.environment=local`; the dev2 Kubernetes deployment uses
`deployment.environment=dev2`.

Harness-native model traces are still separate:

- LangSmith remains the detailed model/harness-level trace backend for
  LangGraph, Claude Agents, and PI Agent runs.
- SigNoz receives orchestrator-side HTTP, PostgreSQL, S3/AWS SDK, OpenAI, and
  related auto-instrumentation spans when those libraries are used.
- SigNoz also receives sandbox-daemon HTTP/Undici/gRPC/network/OpenAI spans from
  Bun-preloaded sandbox run containers when Bun compatibility lets those Node
  instrumentations patch the active library. These spans show sandbox daemon
  behavior and tool/orchestrator IPC, not every provider-specific model event.

## Dev2 Collector Endpoint

The in-cluster collector service is:

```text
http://signoz-otel-collector.observability.svc.cluster.local:4318
```

Local Docker cannot resolve that cluster DNS name, so infra exposes OTLP HTTP
through the tailnet-only ingress at:

```text
https://otlp-signoz.staging.example.com
```

Do not run a local SigNoz ClickHouse stack for stablehand telemetry. All stablehand
OpenTelemetry traces should land in dev2 SigNoz.

## Start stablehand With Dev2 Tracing

From the stablehand repo root:

```bash
docker compose -f docker-compose.yml -f docker-compose.signoz.yml up --build -d --remove-orphans
```

The default OTLP endpoint is `https://otlp-signoz.staging.example.com`. Override
it only when intentionally targeting another central collector:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-signoz.staging.example.com \
STABLEHAND_SANDBOX_OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-signoz.staging.example.com \
  docker compose -f docker-compose.yml -f docker-compose.signoz.yml up --build -d --remove-orphans
```

To run stablehand without tracing:

```bash
docker compose up --build -d
```

## Generate Trace Traffic

Basic API and UI traffic is enough to produce orchestrator spans (run from the
repo root):

```bash
bun .codex/skills/stablehand-cli/scripts/stablehand.ts health
bun .codex/skills/stablehand-cli/scripts/stablehand.ts agents list
bun .codex/skills/stablehand-cli/scripts/stablehand.ts sandbox metrics
```

For run/session traces, execute a short agent turn through the CLI or UI, then
wait 10-30 seconds for export and ingestion. A completed sandbox turn should
produce spans under both `stablehand-orchestrator` and the relevant
`stablehand-sandbox-<harness>` service.

## Verify In SigNoz

In the SigNoz UI:

1. Open `https://signoz.staging.example.com`.
2. Go to Services or Traces.
3. Filter for service names `stablehand-orchestrator` and `stablehand-sandbox-*`.
4. Confirm spans appear while generating `/health`, `/api/health`,
   `/api/agents`, `/api/sandbox/metrics`, and any run/session traffic used
   during the trial.
5. Use `deployment.environment` to distinguish local Docker telemetry from
   dev2 Kubernetes telemetry.

You can also query dev2 ClickHouse directly:

```bash
export KUBECONFIG="$HOME/workspace/infra/.k3s-kubeconfig.yaml"
kubectl -n observability exec chi-signoz-clickhouse-cluster-0-0-0 -- clickhouse-client --query '
SELECT
  `resource_string_service$$name` AS service_name,
  count() AS spans,
  max(timestamp) AS latest_span
FROM signoz_traces.distributed_signoz_index_v3
WHERE timestamp >= now() - INTERVAL 30 MINUTE
  AND `resource_string_service$$name` IN (
    '\''stablehand-orchestrator'\'',
    '\''stablehand-sandbox-langgraph'\'',
    '\''stablehand-sandbox-claude-agents'\'',
    '\''stablehand-sandbox-pi-agent'\''
  )
GROUP BY service_name
ORDER BY service_name
'
```

Top recent span names:

```bash
export KUBECONFIG="$HOME/workspace/infra/.k3s-kubeconfig.yaml"
kubectl -n observability exec chi-signoz-clickhouse-cluster-0-0-0 -- clickhouse-client --query '
SELECT
  name,
  kind_string,
  count() AS spans,
  round(quantile(0.95)(duration_nano) / 1000000, 2) AS p95_ms
FROM signoz_traces.distributed_signoz_index_v3
WHERE timestamp >= now() - INTERVAL 30 MINUTE
  AND `resource_string_service$$name` LIKE '\''stablehand-%'\''
GROUP BY name, kind_string
ORDER BY spans DESC
LIMIT 20
'
```

## Debugging Missing Traces

Check the dev2 endpoints first:

```bash
curl -fsS https://signoz.staging.example.com/api/v1/health
curl -ksS -o /dev/null -w '%{http_code}\n' https://otlp-signoz.staging.example.com/v1/traces
```

Then check the orchestrator and sandbox environments:

```bash
docker compose -f docker-compose.yml -f docker-compose.signoz.yml exec orchestrator \
  env | grep '^OTEL_\|^NODE_OPTIONS'
docker compose -f docker-compose.yml -f docker-compose.signoz.yml exec sandbox-langgraph \
  env | grep '^OTEL_\|^NODE_OPTIONS' || true
docker compose -f docker-compose.yml -f docker-compose.signoz.yml logs --since=10m orchestrator | \
  grep -i 'otel\|opentelemetry\|export' || true
docker logs $(docker ps -q --filter 'label=stablehand.managed=true' | head -1) 2>/dev/null | \
  grep -i 'otel\|opentelemetry\|export' || true
```

Common issues:

- No orchestrator spans after API traffic: confirm stablehand was started with
  `-f docker-compose.signoz.yml`, `OTEL_TRACES_EXPORTER=otlp`, and
  `NODE_OPTIONS` contains the stablehand OTEL register preload.
- No sandbox spans after run traffic: confirm harness images were rebuilt after
  the OTEL preload change and sandbox containers have
  `OTEL_TRACES_EXPORTER=otlp` plus
  `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-signoz.staging.example.com`.
- Missing expected auto-instrumentation spans: check whether
  `OTEL_NODE_ENABLED_INSTRUMENTATIONS` was overridden. The stablehand register
  defaults to `aws-sdk,dns,grpc,http,net,openai,pg,pino,runtime-node,undici`.
- `https://otlp-signoz.staging.example.com/v1/traces` is unreachable: check the
  infra-owned `signoz-otlp-tailnet` ingress in the infra repo (`~/workspace/infra`).
- Export errors: confirm the dev2 OTLP ingress is reachable from the Docker
  container network and that `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`.
- Spans are present but hard to find: filter by `service.name =
  stablehand-orchestrator` or `service.name LIKE stablehand-sandbox-%`, and include
  the correct `deployment.environment` filter.

## References

- SigNoz UI: https://signoz.staging.example.com
- Dev2 OTLP HTTP endpoint: https://otlp-signoz.staging.example.com
- SigNoz traces ClickHouse query schema: https://signoz.io/docs/userguide/writing-clickhouse-traces-query/
