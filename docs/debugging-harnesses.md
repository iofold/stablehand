# Harness Debugging Guide

This guide provides a systematic approach to diagnosing and fixing issues within CTXMill agent harnesses. Harnesses execute inside isolated Docker sandbox containers, which requires specific observability techniques.

## Error Visibility Chain

Errors in CTXMill travel through several layers. Understanding this chain helps you identify where an error might be swallowed or transformed.

1.  **Harness SDK**: The underlying agent SDK (e.g., Claude, LangGraph) throws an error.
2.  **Harness Adapter**: The adapter (e.g., `LangGraphHarness`) catches the error in a `try/catch` block.
3.  **Harness Event**: The adapter yields an event: `{ type: 'error', error: string }`.
4.  **Sandbox Daemon**: The Bun-based daemon converts this to a `SessionEvent` proto message.
5.  **gRPC**: The event is streamed over gRPC (ConnectRPC) to the orchestrator.
6.  **Orchestrator**: The `SandboxRunService` receives the event and broadcasts it via the `TypedEventBus`.
7.  **SSE**: The `RunRegistry` picks up the event and streams it to the UI via Server-Sent Events.
8.  **UI**: The React dashboard displays the error message in the run log.

**Crucial Note**: By default, only the error *string* survives this chain. Stack traces are lost unless they are explicitly logged to the container's `stderr`.

## Accessing Harness Logs

Since harnesses run in separate containers, you cannot see their logs in the main `docker compose logs` output (unless you are using the `sandbox` profile and even then, individual run logs are separate).

### 1. Find the Container ID
Managed containers are labeled with `ctxmill.managed=true`. Use the Docker CLI to find the container for a specific session or run:

```bash
# List all active managed containers
docker ps --filter "label=ctxmill.managed=true"

# Find a container by session ID
docker ps --filter "label=ctxmill.session-id=<sessionId>"
```

Container names follow these patterns:
- **Runs**: `ctxmill-run-<sessionId>`
- **Sessions**: `ctxmill-session-<conversationIdHash>`

### 2. Inspect Logs
Once you have the container ID or name, check its `stdout` and `stderr`:

```bash
# View all logs
docker logs <container-id>

# Tail logs for an active run
docker logs -f <container-id>
```

Check `stderr` specifically for stack traces from harness-level crashes.

## Per-Harness Debugging

### LangGraph (deepagents)
The LangGraph harness uses the `deepagents` SDK, which is a pure TypeScript wrapper around LangChain.

-   **Common Errors**:
    -   **Model Not Found**: Check `provider` and `model` in the agent YAML. Ensure the corresponding API key is provided.
    -   **Tool Schema Invalid**: LangChain requires valid Zod schemas for tools. If a tool definition has an invalid `input` schema, the agent will fail to initialize.
    -   **Skill Load Failure**: If the `.ctxmill/skills` directory exists but contains invalid files, the harness might fail during setup.
-   **Debug Output**: The harness logs `[langgraph] deliverTurn error:` to `stderr` on failure.
-   **Middleware Errors**: If `nativeTools` blocklisting is used, check for `ctxmill-tool-blocklist` logs if tools are unexpectedly denied.

### Claude Agents (@anthropic-ai/claude-agent-sdk)
The Claude harness is unique because the SDK spawns a Node.js subprocess (`node cli.js`) to execute the agent.

-   **Subprocess Behavior**: If the child process crashes, the harness might report a generic "Claude agent query failed" error. Check container logs for subprocess `stderr`.
-   **MCP Server Issues**: Claude uses an internal MCP server to communicate with CTXMill tools. If tool calls fail with "connection lost," it usually indicates the MCP bridge has crashed.
-   **LangSmith Tracing**: If `LANGSMITH_TRACING=true` is set, the harness uses `wrapClaudeAgentSDK()`. If tracing fails to initialize, it logs a warning but continues.
-   **`canUseTool` Errors**: Approval logic is handled via a `canUseTool` callback. If this callback throws, the entire turn will fail.

### PI Agent (@mariozechner/pi-coding-agent)
The PI Agent harness relies on a complex event-based SDK.

-   **SDK Event Logging**: The harness logs every SDK event: `[pi-agent] SDK event: <eventType> keys=[...]`. This is the best way to trace the internal state of the PI agent.
-   **TypeBox Conversion**: PI uses TypeBox for schemas. CTXMill converts Zod to TypeBox via `zodToTypeBox`. If you use complex Zod features (like `refine` or `transform`), the conversion might produce an invalid TypeBox schema, causing the SDK to throw.
-   **Native Tool Failures**: PI provides optimized "native tools" (read, bash, etc.). If these fail, check if the `workspaceDir` is correctly mounted and writable.

## Common Issues Across All Harnesses

### "1 events emitted" Pattern
This is the most common signal for a harness-level crash. A healthy turn typically emits dozens of events (text deltas, tool starts, etc.). If the orchestrator reports that a run finished with exactly **1 event**, that event is almost certainly an `error` event emitted immediately upon startup.
**Action**: Check `docker logs <container-id>` immediately. The harness likely crashed before it could even start the LLM loop.

### Container Fails to Start
-   **Image Not Found**: Ensure you have built the harness images: `docker build --target harness-<name> -t ctxmill/harness-<name> -f Dockerfile.sandbox .`.
-   **Resource Limits**: If the container is killed immediately (OOMKilled), check the `memoryMb` setting. Claude agents, in particular, require at least 2GiB of RAM.
-   **Network**: If the harness cannot reach the LLM provider (OpenAI/Anthropic), check the `egress-proxy` logs and ensure `CTXMILL_EGRESS_PROXY=1` is set if needed.

### gRPC Health Check Timeout
The orchestrator waits for the sandbox daemon to become ready. If you see a health check timeout:
-   The Bun daemon failed to start (check `docker logs`).
-   The container is stuck in a restart loop.
-   The `SANDBOX_PORT` (default 50051) is blocked or misconfigured.

### Secret Injection Failures
Secrets are injected into a `tmpfs` mount at `/run/secrets/config.json`.
-   If an agent fails with "Missing API key," check if the secret is defined in the orchestrator and allowlisted for the agent.
-   The daemon logs `loaded N secret(s) from env` on startup. If it says `no secrets found`, the injection failed.

### Workspace Not Found / Permission Denied
Harnesses expect to work in `/workspace`.
-   If a harness reports `ENOENT` for a file that should exist, check if `config.workspaceDir` was correctly passed and mounted.
-   Node's `spawn` often reports `ENOENT` if the `cwd` directory is missing, even if the executable exists.

## Harness Image Rebuilding

Changes to harness code (in `packages/sandbox-daemon/src/harness/`) or the daemon itself require rebuilding the harness images. `docker compose up --build` **does not** rebuild these images.

Run the specific build command for the harness you modified:

```bash
# LangGraph
docker build --target harness-langgraph -t ctxmill/harness-langgraph -f Dockerfile.sandbox .

# Claude
docker build --target harness-claude-agents -t ctxmill/harness-claude-agents -f Dockerfile.sandbox .

# PI Agent
docker build --target harness-pi-agent -t ctxmill/harness-pi-agent -f Dockerfile.sandbox .
```

## Debug Checklist

1.  **Check the UI**: What is the error message? If it's generic, move to step 2.
2.  **Check Event Count**: Did it emit only 1 event? If yes, it's a startup crash.
3.  **Find the Container**: `docker ps --filter "label=ctxmill.managed=true"`.
4.  **Check Container Logs**: `docker logs <container-id>`. Look for stack traces in `stderr`.
5.  **Verify Secrets**: Does the log show `loaded N secret(s)`? Are the expected API keys there?
6.  **Verify Workspace**: Is the `workspaceDir` correct? Does the agent have write permissions?
7.  **Check Orchestrator Logs**: `docker compose logs orchestrator`. Look for gRPC errors or container creation failures.
8.  **Rebuild**: If you changed harness code, did you rebuild the specific harness image?
