# Environment Variable Reference

This document provides a comprehensive reference for all environment variables used by CTXMill.

## Categories

- [Core](#core)
- [Sandbox](#sandbox)
- [AI / Model](#ai--model)
- [LangSmith / Tracing](#langsmith--tracing)
- [Storage (S3 / MinIO)](#storage-s3--minio)
- [Network](#network)
- [Security](#security)
- [Debug / Development](#debug--development)
- [System Settings (DB-Persisted)](#system-settings-db-persisted)

---

## Core

| Name | Default | Required? | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `DATABASE_URL` | `postgres://ctxmill:ctxmill@postgres:5432/ctxmill` | **Yes** | PostgreSQL connection string. | `postgres://user:pass@localhost:5432/db` |
| `NODE_ENV` | `production` | No | Environment mode. Set to `development` for detailed error messages. | `development` |
| `CTXMILL_PORT` | `3001` | No | Port the orchestrator API listens on. (Mapped to `3002` in default Docker stack). | `3001` |
| `CTXMILL_UI_PORT` | `3200` | No | Port the React UI listens on. | `3200` |
| `CTXMILL_PRESET` | `docker` | No | Inert. Present in some deploy manifests but not read by the application code. | `docker` |
| `CTXMILL_DATA_DIR` | `./.ctxmill` | No | Root directory for persisted agent workspace data. | `/data/ctxmill` |
| `CTXMILL_UI_MODE` | `disabled` | No | UI mode for `ctxmill dev`. Options: `disabled`, `embedded`, `vite`. | `vite` |
| `CTXMILL_API_URL` | `http://localhost:3002` | No | Base URL for the API (used by CLI chat). | `https://api.ctxmill.com` |
| `CTXMILL_API_ORIGIN` | `http://localhost:3001` | No | Origin for the API (used by Vite proxy). | `http://orchestrator:3001` |

## Sandbox

These variables control the behavior of agent sandbox containers or Kubernetes
sandbox Jobs.

| Name | Default | Required? | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `ORCHESTRATOR_CALLBACK_URL` | `http://orchestrator:3001` | **Yes*** | URL for sandboxes to call back to the orchestrator. *Required in foreign stacks. | `http://ctxmill-api:3001` |
| `ORCHESTRATOR_URL` | - | No | Injected by the orchestrator into each sandbox container's environment; the daemon uses it to proxy tool calls back to the orchestrator. Derived from the stack's orchestrator URL, not normally set by hand. | `http://orchestrator:3001` |
| `CTXMILL_SANDBOX_RUNTIME` | `docker` | No | Sandbox runtime. Use `kubernetes` or `k8s` to create sandbox sessions as Kubernetes Jobs. | `kubernetes` |
| `CTXMILL_IMAGE_PREFIX` | `ctxmill/harness` | No | Prefix for sandbox harness images. Runtime image = `<prefix>-<harness>:<tag>`. | `myregistry.com/ctxmill` |
| `CTXMILL_SANDBOX_IMAGE_TAG` | `latest` | No | Tag appended to sandbox harness images (`<prefix>-<harness>:<tag>`). Local stacks use `latest`; deploy pins a commit tag so sandbox Jobs run the deployed revision. | `75435dd` |
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | No | Directory the Claude Agents harness reads its Claude SDK config and session JSONL from. | `/home/ctxmill/.claude` |
| `CTXMILL_MAX_GLOBAL_CONTAINERS` | `20` | No | Maximum number of concurrent sandbox containers globally. | `50` |
| `CTXMILL_DATA_VOLUME` | - | No | Docker volume name for persistent agent data. Required for volume-based persistence. | `myapp_ctxmill-data` |
| `CTXMILL_K8S_NAMESPACE` | service account namespace or `default` | No | Kubernetes namespace where sandbox Jobs are created. Used only by the Kubernetes sandbox runtime. | `ctxmill` |
| `CTXMILL_K8S_DATA_HOST_PATH` | `CTXMILL_DATA_DIR` or `/var/lib/ctxmill/data` | No | Host path mounted into Kubernetes sandbox Jobs for workspace data. Use only on single-node/dev clusters unless the path is backed by cluster storage. | `/var/lib/ctxmill/dev2/data` |
| `CTXMILL_K8S_POD_READY_TIMEOUT_MS` | `60000` | No | How long the Kubernetes runtime waits for a sandbox Job Pod to become `Running` and get a Pod IP. | `120000` |
| `CTXMILL_CONTAINER_STARTUP_GRACE_MS` | Docker: `90000`; Kubernetes: pod-ready timeout + `30000` | No | Grace window before lifecycle reconciliation may treat a newly-created managed sandbox with no DB session row as an orphan. | `390000` |
| `SANDBOX_PORT` | `50051` | No | Port the sandbox gRPC daemon listens on. | `50051` |
| `PTC_PORT` | `8080` | No | Port for the Programmatic Tool Calling (PTC) API in sandboxes. | `8080` |
| `TOOL_PROXY_TIMEOUT_MS` | `300000` | No | Timeout for tool calls proxied from sandbox to orchestrator. | `600000` |
| `CTXMILL_SANDBOX_OTEL_TRACES_EXPORTER` | `OTEL_TRACES_EXPORTER` or `none` | No | Trace exporter for sandbox run containers. Set to `otlp` with `docker-compose.signoz.yml`. | `otlp` |
| `CTXMILL_SANDBOX_OTEL_EXPORTER_OTLP_ENDPOINT` | `OTEL_EXPORTER_OTLP_ENDPOINT` or `http://host.docker.internal:4318` | No | OTLP HTTP endpoint passed to sandbox run containers. Use the dev2 tailnet collector endpoint for centralized SigNoz telemetry. | `https://otlp-signoz.staging.example.com` |
| `CTXMILL_SANDBOX_OTEL_SERVICE_NAME_PREFIX` | `ctxmill-sandbox` | No | Prefix used for sandbox service names. The harness name is appended. | `ctxmill-sandbox` |
| `CTXMILL_SANDBOX_OTEL_RESOURCE_ATTRIBUTES` | `OTEL_RESOURCE_ATTRIBUTES` or local ctxmill attrs | No | Base sandbox resource attributes. `ctxmill.component=sandbox` and `ctxmill.harness=<harness>` are appended automatically. Keep `deployment.environment` accurate for the source environment even when exporting to dev2 SigNoz. | `deployment.environment=local,service.namespace=ctxmill` |
| `OTEL_NODE_ENABLED_INSTRUMENTATIONS` | `aws-sdk,dns,grpc,http,net,openai,pg,pino,runtime-node,undici` | No | Comma-separated auto-instrumentation list used by the ctxmill OTEL register when not explicitly overridden. | `http,undici,openai` |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `false` | No | Keep disabled unless intentionally exporting prompt/completion content to the configured OTEL backend. The ctxmill register also sets OpenAI auto-instrumentation content capture off by default. | `false` |

## AI / Model

| Name | Default | Required? | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `OPENAI_API_KEY` | - | No | API key for OpenAI. Also accepts OpenRouter or other provider keys when using a custom `baseUrl` in agent manifests. See [Custom Providers](custom-providers.md). | `sk-...` |
| `OPENAI_MODEL` | `gpt-5.4-mini` | No | Optional sandbox-visible model default for harnesses/tools that choose to read it. Agent manifests should prefer explicit harness config. | `gpt-5.4` |
| `OPENAI_BASE_URL` | - | No | Base URL for OpenAI-compatible APIs (e.g., Cloudflare AI Gateway, OpenRouter). | `https://openrouter.ai/api/v1` |
| `ANTHROPIC_API_KEY` | - | No | API key for Anthropic. Also accepts OpenRouter keys when using a custom `baseUrl`. See [Custom Providers](custom-providers.md). | `sk-ant-...` |
| `GOOGLE_API_KEY` | - | No | API key for Google Gemini. | `AIza...` |
| `GEMINI_API_KEY` | - | No | Alternative key name for Google/Gemini models. Recognized alongside `GOOGLE_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` by harness model auth. | `AIza...` |

## LangSmith / Tracing

| Name | Default | Required? | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `LANGSMITH_TRACING` | `false` | No | Enable LangSmith tracing (`true` to enable). | `true` |
| `LANGSMITH_API_KEY` | - | No | API key for LangSmith. | `lsv2_pt_...` |
| `LANGSMITH_PROJECT` | `ctxmill` | No | LangSmith project name. | `my-project` |
| `LANGSMITH_WORKSPACE_ID` | - | No | LangSmith workspace ID (required for service account keys). | `ws_...` |

## Storage (S3 / MinIO)

Used for persistent artifact storage (file uploads/downloads).

| Name | Default | Required? | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `S3_ENDPOINT` | `http://minio:9000` | No | S3-compatible endpoint URL. | `https://s3.amazonaws.com` |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | No | Publicly accessible S3 endpoint URL (for signed URLs). | `https://artifacts.ctxmill.com` |
| `S3_ACCESS_KEY` | `ctxmill` | No | S3 access key. | `AKIA...` |
| `S3_SECRET_KEY` | `ctxmill-dev` | No | S3 secret key. | `secret...` |
| `S3_BUCKET` | `ctxmill-artifacts` | No | S3 bucket name. | `my-artifacts` |
| `S3_REGION` | `us-east-1` | No | S3 region. | `us-west-2` |

## Network

| Name | Default | Required? | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `CORS_ORIGINS` | `http://localhost:3200` | No | Comma-separated list of allowed CORS origins. | `https://app.ctxmill.com` |

## Security

| Name | Default | Required? | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `SECRET_MASTER_KEY` | Development fallback outside production | **Yes in production** | Master key for per-agent secret encryption (AES-256-GCM). Production startup fails if this is unset, the development fallback, or shorter than 16 characters. | `openssl rand -hex 32` |
| `CTXMILL_API_TOKEN` | - | **Yes in production** | Static bearer token required for HTTP control-plane API routes. Production startup fails if this is unset unless `CTXMILL_AUTH_DISABLED=true`. | `openssl rand -hex 32` |
| `CTXMILL_CALLBACK_TOKEN_SECRET` | `CTXMILL_API_TOKEN` | No | Optional separate HMAC secret for session-scoped sandbox ConnectRPC callback tokens. Set this when you want callback auth independent from the HTTP API token. | `openssl rand -hex 32` |
| `CTXMILL_AUTH_DISABLED` | `false` | No | Allows open HTTP API and callback auth mode only when no token/secret is configured. If `CTXMILL_API_TOKEN` or `CTXMILL_CALLBACK_TOKEN_SECRET` is set, auth still enforces. Use only for isolated local development or trusted private test stacks. | `true` |
| `CTXMILL_EGRESS_ENFORCE` | `true` | No | Egress guard for orchestrator-originated HTTP tool and webhook/callback requests. When enabled, destinations resolving to private, loopback, link-local (incl. `169.254.169.254` metadata), or reserved ranges are blocked before the request is made, and each redirect hop is re-validated. Set `false` only for local development. | `false` |
| `CTXMILL_EGRESS_ALLOWLIST` | - | No | Comma-separated hosts allowed to bypass the egress block so agents can reach internal services on purpose. Matches exact host, parent domain, and `*.wildcard` patterns. | `hooks.internal.example.com,*.corp.example` |
| `CTXMILL_EGRESS_ALLOWLIST_ONLY` | `false` | No | When `true`, only allowlisted hosts are reachable (deny public destinations by default). | `true` |
| `CTXMILL_EGRESS_MAX_REDIRECTS` | `5` | No | Maximum redirects the egress guard follows while re-validating each hop. | `3` |

## Debug / Development

| Name | Default | Required? | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| `CTXMILL_STRICT_TESTS` | `0` | No | Enable strict test mode (`1` to enable). Fails tests on console errors. | `1` |
| `CTXMILL_LOG_SECRETS` | `0` | No | Log secrets for debugging (`1` to enable). **Use with caution!** | `1` |

---

## System Settings (DB-Persisted)

These settings are stored in the `system_settings` table in the database. They can be configured via the **Settings** page in the UI or via the `PUT /api/settings` API.

Each setting also supports an **environment variable override** that sets the default value when no DB value exists. Priority: **DB value > env var > hardcoded default.**

| Key | Env Var Override | Default | Description |
| :--- | :--- | :--- | :--- |
| `turnTimeoutMs` | `CTXMILL_TURN_TIMEOUT_MS` | `1,800,000` (30m) | Timeout for a single agent turn (LLM call + tools). |
| `idleTimeoutMs` | `CTXMILL_IDLE_TIMEOUT_MS` | `300,000` (5m) | Time before an idle session is checkpointed by lifecycle policy. |
| `maxGlobalContainers` | `CTXMILL_MAX_GLOBAL_CONTAINERS` | `20` | Maximum concurrent sandbox containers globally. |
| `maxConcurrentSessionsPerAgent` | `CTXMILL_MAX_CONCURRENT_SESSIONS_PER_AGENT` | `3` | Maximum concurrent live sandbox sessions for a single agent. |
| `maxTriggerDepth` | `CTXMILL_MAX_TRIGGER_DEPTH` | `5` | Maximum depth for event-triggered background runs. |
| `defaultCpus` | `CTXMILL_DEFAULT_CPUS` | `1.0` | Default CPU allocation for sandboxes. |
| `defaultMemoryMb` | `CTXMILL_DEFAULT_MEMORY_MB` | `1024` | Default memory limit for sandboxes. |
| `defaultPidsLimit` | `CTXMILL_DEFAULT_PIDS_LIMIT` | `256` | Default PID limit for sandboxes. |
| `defaultTimeoutSec` | `CTXMILL_DEFAULT_TIMEOUT_SEC` | `43,200` (12h) | Default hard timeout for sandbox containers. |
| `maxWorkspaceTarBytes` | `CTXMILL_MAX_WORKSPACE_TAR_BYTES` | `100MB` | Maximum size for workspace snapshots. |
| `maxTarUploadBytes` | `CTXMILL_MAX_TAR_UPLOAD_BYTES` | `100MB` | Maximum size for tar uploads. |
| `queueTimeoutMs` | `CTXMILL_QUEUE_TIMEOUT_MS` | `600,000` (10m) | Timeout for container queue wait. |
| `reconciliationIntervalMs` | `CTXMILL_RECONCILIATION_INTERVAL_MS` | `300,000` (5m) | Interval for session reconciliation checks. |

---

## .env.example Template

```bash
# ── Core ──────────────────────────────────────────────────
DATABASE_URL=postgres://ctxmill:ctxmill@postgres:5432/ctxmill
NODE_ENV=production
# API_PORT=3002
# UI_PORT=3200

# ── Sandbox ───────────────────────────────────────────────
# Required for foreign stacks (e.g. if orchestrator service is renamed)
# ORCHESTRATOR_CALLBACK_URL=http://orchestrator:3001
# CTXMILL_DATA_VOLUME=ctxmill_ctxmill-data

# ── LLM Provider Keys ────────────────────────────────────
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=

# ── Model Defaults ───────────────────────────────────────
OPENAI_MODEL=gpt-5.4-mini
# OPENAI_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/compat

# ── LangSmith Tracing (optional) ────────────────────────
LANGSMITH_TRACING=false
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=ctxmill
# LANGSMITH_WORKSPACE_ID=

# ── S3 / MinIO (Artifact Storage) ────────────────────────
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=ctxmill
S3_SECRET_KEY=ctxmill-dev
S3_BUCKET=ctxmill-artifacts
S3_REGION=us-east-1

# ── Network ──────────────────────────────────────────────
CORS_ORIGINS=http://localhost:3200,http://127.0.0.1:3200

# ── Security ─────────────────────────────────────────────
# Master key for per-agent secret encryption. Required in production.
# Generate with: openssl rand -hex 32
SECRET_MASTER_KEY=
# Static bearer token for HTTP control-plane API routes. Required in production.
# Generate with: openssl rand -hex 32
CTXMILL_API_TOKEN=
# Optional separate HMAC secret for sandbox callback tokens.
CTXMILL_CALLBACK_TOKEN_SECRET=
# Allows open auth only when CTXMILL_API_TOKEN/CTXMILL_CALLBACK_TOKEN_SECRET are absent.
# Set only for isolated local development or trusted private test stacks.
CTXMILL_AUTH_DISABLED=
```
