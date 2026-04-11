# Embedding ctxmill in Foreign Docker Compose Stacks

This guide provides operational instructions for embedding the ctxmill agent runtime into an existing Docker Compose environment. It addresses common networking, configuration, and deployment issues encountered when moving beyond the default standalone stack.

## Quick Start

For those already familiar with Docker Compose, follow these steps to integrate ctxmill:

1.  **Add Services**: Include `orchestrator`, `postgres`, and `minio` in your `docker-compose.yml`.
2.  **Network**: Connect the `orchestrator` to your application network and a new `ctxmill-agents` bridge network.
3.  **Callback URL**: Set `ORCHESTRATOR_CALLBACK_URL=http://<your-orchestrator-service-name>:3001`.
4.  **Docker Socket**: Mount `/var/run/docker.sock` into the `orchestrator` container.
5.  **Build Harnesses**: Sandbox images now build by default with `docker compose up --build`.

---

## Prerequisites

*   **Docker & Docker Compose**: Ensure you have a modern version of Docker (24+) and Docker Compose (2.20+).
*   **LLM API Keys**: You need API keys for the models your agents will use (OpenAI, Anthropic, or Google).
*   **Network Access**: The orchestrator needs outbound access to LLM providers and the ability to create Docker networks.

## Docker Compose Integration

To add ctxmill to an existing stack, you typically need the orchestrator and its dependencies. Below is a realistic snippet showing how to merge these services.

```yaml
services:
  # Your existing application service
  myapp:
    image: myapp:latest
    networks:
      - app-network

  # ctxmill Orchestrator
  orchestrator:
    image: ctxmill/orchestrator:latest
    build:
      context: .
      dockerfile: Dockerfile
      target: orchestrator
    environment:
      - DATABASE_URL=postgres://ctxmill:ctxmill@postgres:5432/ctxmill
      - ORCHESTRATOR_CALLBACK_URL=http://orchestrator:3001
      - CTXMILL_DATA_VOLUME=myapp_ctxmill-data
      - S3_ENDPOINT=http://minio:9000
      - S3_ACCESS_KEY=ctxmill
      - S3_SECRET_KEY=ctxmill-dev
      - CORS_ORIGINS=https://myapp.com,http://localhost:3200
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ctxmill-data:/app/project/.ctxmill
    networks:
      - app-network
      - ctxmill-agents
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy

  postgres:
    image: pgvector/pgvector:pg17
    environment:
      - POSTGRES_USER=ctxmill
      - POSTGRES_PASSWORD=ctxmill
      - POSTGRES_DB=ctxmill
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - app-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ctxmill"]
      interval: 5s

  minio:
    image: minio/minio:latest
    command: server /data
    environment:
      - MINIO_ROOT_USER=ctxmill
      - MINIO_ROOT_PASSWORD=ctxmill-dev
    volumes:
      - minio-data:/data
    networks:
      - app-network
      - ctxmill-agents
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 5s

networks:
  app-network:
    driver: bridge
  ctxmill-agents:
    name: ctxmill-agents
    driver: bridge

volumes:
  pgdata:
  ctxmill-data:
  minio-data:
```

## Network Configuration

### The `ctxmill-agents` Network
The orchestrator spawns sandbox containers dynamically. These containers must be on a network that the orchestrator can also reach. By default, ctxmill uses a bridge network named `ctxmill-agents`. 

If you rename this network, you must update the `networkName` in the orchestrator configuration (though it defaults to `ctxmill-agents` in the code).

### ORCHESTRATOR_CALLBACK_URL
This is the most critical setting for foreign stacks. When a sandbox container starts, it needs to call back to the orchestrator via gRPC to request tools or emit events. 

*   **Default**: `http://orchestrator:3001`
*   **Requirement**: If your orchestrator service is named `ctxmill-api` in your compose file, you **must** set `ORCHESTRATOR_CALLBACK_URL=http://ctxmill-api:3001`. Failure to do this results in agents hanging or timing out immediately.

### Sandbox DNS Isolation
Sandbox containers are isolated from your main application network by default. They can only see the orchestrator and other services explicitly added to the `ctxmill-agents` network (like MinIO). If your agents need to reach your internal API, you must add your API service to the `ctxmill-agents` network.

## Configuration & Timeouts

### CTXMILL_TURN_TIMEOUT_MS
By default, a single agent turn (one LLM call + tool executions) times out after 5 minutes (300,000ms). For long-running agents or complex tasks, this may be too short.

*   **How to configure**: This is a system setting stored in the database. You can update it via the UI (Settings page) or by sending a `PUT` request to `/api/settings`:
    ```json
    { "turnTimeoutMs": 600000 }
    ```
*   **SQL Override**: If the UI is unavailable, you can update it directly in the PostgreSQL `system_settings` table:
    ```sql
    INSERT INTO system_settings (key, value, updated_at) 
    VALUES ('turnTimeoutMs', '600000', NOW()) 
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
    ```
*   **Symptom of failure**: The agent run stops abruptly with a "Turn timed out" error in the logs.

### Concurrency Limits
The system limits global concurrent containers (default 20) and per-agent concurrent runs (default 3). These are also configurable via the Settings API or UI.

## Sandbox Image Building

Harness images (e.g., `ctxmill/harness-langgraph`) are **not** built by a standard `docker compose up`. They are multi-stage builds that must be triggered manually before agents can run.

Run these commands from the project root:
```bash
docker build --target harness-langgraph -t ctxmill/harness-langgraph -f Dockerfile.sandbox .
docker build --target harness-claude-agents -t ctxmill/harness-claude-agents -f Dockerfile.sandbox .
docker build --target harness-pi-agent -t ctxmill/harness-pi-agent -f Dockerfile.sandbox .
```

Alternatively, build all services including sandbox images via compose:
```bash
docker compose build
```

## Secret Injection

Secrets are injected into sandbox containers using a `tmpfs` mount at `/run/secrets/config.json`. 

### SANDBOX_SECRET_ALLOWLIST
The orchestrator only passes specific environment variables to the sandbox. The current allowlist includes:
*   `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`
*   `OPENAI_BASE_URL`, `OPENAI_MODEL`
*   `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`
*   `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_WORKSPACE_ID`

If you need to pass custom secrets to your tools, you should store them in the ctxmill Secret Store (via the API/UI) rather than relying on environment variable passthrough.

## Egress Proxy

If your environment requires all outbound traffic to go through a proxy, you can enable the egress proxy feature.

1.  Set `CTXMILL_EGRESS_PROXY=1` in the orchestrator environment.
2.  The orchestrator will automatically set `HTTP_PROXY` and `HTTPS_PROXY` in sandbox containers to point to `http://egress-proxy:3128`.
3.  Ensure a service named `egress-proxy` is running on the `ctxmill-agents` network.

## Volume Mounting

### Docker Socket
The orchestrator **must** have access to `/var/run/docker.sock`. This allows it to use the Docker API to create, start, and monitor sandbox containers.

### Data Volume
The `CTXMILL_DATA_VOLUME` environment variable tells the orchestrator which volume to use for persistent agent data (workspaces, checkpoints). In a foreign stack, ensure this matches the volume name defined in your `volumes` section.

## CORS Configuration

If you are hosting the ctxmill UI on a different domain than the API, you must configure `CORS_ORIGINS`.

*   **Example**: `CORS_ORIGINS=https://agents.mycompany.com,https://app.mycompany.com`
*   **Default**: `http://localhost:3200`

## Known Gotchas

*   **Agent Name Uniqueness**: The system does not currently deduplicate agents by name during manifest loading. If you have multiple agents with the same name in different directories, they will both be imported.
*   **Trigger Template Failures**: If an event trigger template is invalid (e.g., references a non-existent agent), it will fail silently in the background. Check orchestrator logs for `[EventTriggerManager]` errors.
*   **Session Immutability**: Once a session is created, its configuration (harness, resource limits) is immutable. To change these, you must start a new conversation.
*   **Disk Sizing**: Sandbox builds and agent workspaces can consume significant disk space. Ensure your Docker host has at least 10GB of free space.
*   **iptables vs nftables**: On some modern Linux distributions (like Ubuntu 24.04), Docker may struggle with `nftables`. If containers fail to start or have no network access, try switching to `iptables-legacy`.

## Using AG-UI Renderers

If you want to use a third-party AG-UI renderer (CopilotKit, agui-hooks, @assistant-ui/react, etc.) instead of ctxmill's built-in React UI, the orchestrator exposes an AG-UI compatible endpoint:

```
POST http://<orchestrator>:3002/api/ag-ui/agents/:agentId/run
```

Point any `@ag-ui/client` HttpAgent at this URL and it works out of the box. See [AG-UI Compatibility](ag-ui-compat.md) for full details and quick start examples.

## Troubleshooting Checklist

| Issue | Likely Cause | Fix |
| :--- | :--- | :--- |
| **"1 events emitted"** | Harness crashed immediately. | Check `docker logs <container-id>` for the sandbox. |
| **Agent hangs on start** | `ORCHESTRATOR_CALLBACK_URL` is wrong. | Ensure it points to the orchestrator's service name. |
| **"No space left on device"** | Docker root partition is full. | Prune unused images or increase disk size. |
| **"network web not found"** | External network missing. | Create it manually: `docker network create web`. |
| **CORS errors in browser** | `CORS_ORIGINS` missing your domain. | Add your UI domain to the environment variable. |
| **Secrets not found in agent** | Secret not in allowlist. | Use the built-in Secret Store for custom keys. |
