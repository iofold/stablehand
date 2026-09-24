# Sandbox Harness Architecture

## Overview

Stablehand executes agents within isolated Docker sandbox containers, providing a secure and reproducible environment for tool-using agents. Each container runs a Bun-based daemon process that acts as the bridge between the central orchestrator and the specific agent harness.

The daemon serves two primary interfaces:
- **gRPC (ConnectRPC on port 50051)**: Used for high-performance, streaming communication with the orchestrator.
- **HTTP (Bun.serve on port 8080)**: Provides a local Programmatic Tool Calling (PTC) API for scripts running inside the sandbox.

Each container hosts exactly one harness adapter that wraps a specific agent SDK (e.g., Claude, LangGraph, or PI).

## Container Lifecycle

The lifecycle of a sandbox container is managed by the orchestrator's sandbox subsystem:

1. **Creation**: The orchestrator spawns a new Docker container from the appropriate harness image (e.g., `stablehand/harness-langgraph`).
2. **Startup**: The Bun daemon starts inside the container and begins listening for gRPC requests.
3. **OpenSession**: The orchestrator sends an `OpenSession` RPC to initialize the harness. This can be a "fresh" bootstrap or a "restore" from a previous checkpoint.
4. **DeliverTurn**: The orchestrator sends one or more `DeliverTurn` RPCs. This is a server-streaming call where the harness executes the agent logic and streams back events (text deltas, tool calls, etc.).
5. **Suspend/Kill**: When the run completes or needs to wait for human-in-the-loop (HITL) approval, the orchestrator may call `SuspendSession` to capture a checkpoint or `KillSession` to terminate the container.

For more details on the runtime implementation, see [docs/bun-sandbox-daemon.md](bun-sandbox-daemon.md).

## Daemon Architecture

The daemon is a single-process runtime designed for low latency and native TypeScript execution.

- **Dual Servers**: It runs a gRPC server for the orchestrator and a Bun-based HTTP server for local tool access.
- **Session State**: Each daemon process manages exactly one active session. This simplifies state management and ensures strict isolation between agent runs.
- **HarnessService RPCs**:
    - `OpenSession`: Initializes the harness adapter.
    - `DeliverTurn`: Streams agent execution events.
    - `SuspendSession`: Exports the harness state and workspace diff into a checkpoint.
    - `KillSession`: Cleanly shuts down the session.
- **Tool Dispatch**: The daemon routes tool calls based on their defined location:
    - `sandbox`: Handled directly by the harness SDK (e.g., local file operations).
    - `orchestrator`: Proxied back to the orchestrator via gRPC.
    - `daemon`: Handled by the daemon process itself (e.g., artifact uploads/downloads).

## Harness Adapters

### Shared Patterns

All harnesses implement a common `AgentHarness` interface. This interface abstracts the underlying SDK differences, providing a unified way to open sessions, deliver turns, and export state.

Harnesses are responsible for:
- Converting Stablehand `ToolDefinition` objects into the format expected by the specific SDK.
- Mapping SDK-specific streaming events into the standard `SessionEvent` proto format.
- Managing the conversation transcript and system prompts.

### Claude Agents Harness

- **SDK**: `@anthropic-ai/claude-agent-sdk`
- **Mechanism**: Uses `sdk.query()` to execute agent turns. It uses an internal MCP (Model Context Protocol) server to handle tool execution.
- **Tool Conversion**: `convertToolsWithSDK()` wraps Stablehand tools as MCP tools that the Claude SDK can invoke.
- **Streaming**: The SDK's internal streaming events are captured and mapped to `SessionEvent` deltas.
- **Design Decision**: The harness uses the official Agent SDK rather than the raw Messages API. This provides built-in support for complex tool execution, MCP integration, and session persistence.
- **Dockerfile**: Installs `@anthropic-ai/claude-code` globally. The SDK depends on this CLI as a runtime dependency, spawning it as a Node.js subprocess.
- **Signal Handling**: Uses `tini` as the entrypoint to ensure proper signal forwarding to the Claude SDK subprocesses.

### LangGraph Harness

- **SDK**: `deepagents` (a pure TypeScript SDK built on `@langchain/langgraph`)
- **Mechanism**: Uses `createDeepAgent()` and `agent.streamEvents()` to process turns.
- **Tool Conversion**: Maps tools to the LangChain tool format via `@langchain/core`.
- **Model Support**: Supports dynamic loading of `@langchain/openai`, `@langchain/anthropic`, and `@langchain/google-genai` based on configuration.
- **Design Decision**: Migrated from a Python-based implementation to pure JavaScript using `deepagents`. This allowed for the removal of Python from the Docker image, saving ~200-300MB and simplifying the build.
- **Design Decision**: Creates a fresh agent instance per turn. The turns are stateless from the SDK's perspective; conversation state is managed by Stablehand's checkpoint system.

### PI Agent Harness

- **SDK**: `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai`
- **Mechanism**: Uses `createAgentSession` to manage the agent lifecycle. It interacts with a `NativePiSession` that supports asynchronous prompting and event subscription.
- **Tool Conversion**: `convertTools` maps Stablehand tools to PI's internal tool format.
- **Native Tools**: Supports a set of "native tools" (read, bash, edit, etc.) provided by the PI SDK, which are optimized for coding tasks.
- **Design Decision**: Uses a `ConvertToolsContext` to share mutable state (like HITL approval handlers) with tool closures. This avoids the need to rebuild the entire tool list for every turn.
- **Design Decision**: Utilizes in-memory implementations for session, settings, and auth management within the container to maintain isolation.

## Tool Flow Through the Sandbox

Tools are defined in the orchestrator and injected into the sandbox during the bootstrap phase.

```text
+--------------+          +-----------------------------------+
| Orchestrator |          | Sandbox Container (Daemon)        |
+--------------+          +-----------------------------------+
       |                          |
       | 1. FreshBootstrap        |
       |    (ToolMetadata[])      |
       +------------------------> |
                                  | 2. runner.ts calls
                                  |    protoToToolDefs()
                                  |
                                  | 3. Handlers created by location:
                                  |    - sandbox      -> stub (SDK handles)
                                  |    - orchestrator -> gRPC proxy
                                  |    - daemon       -> artifact handler
                                  |
                                  | 4. Tools passed to Harness
                                  |
                                  | 5. Harness SDK executes turn
                                  |
                                  | 6. Tool Call Intercepted:
                                  |    - If sandbox: SDK runs it
                                  |    - If other: Handler invoked
                                  v
```

1. The orchestrator sends `ToolMetadata` via the `FreshBootstrap` RPC.
2. `runner.ts` converts these into `ToolDefinition` objects.
3. Handlers are assigned based on the `location` field:
    - **sandbox**: The harness SDK is expected to handle these (e.g., the Claude SDK running a local command).
    - **orchestrator**: The call is proxied back to the orchestrator via the `OrchestratorService` gRPC client.
    - **daemon**: Handled locally by the daemon (e.g., `artifact_upload`).
4. The harness adapter receives the tool list and initializes the agent SDK.

## Design Decisions

### One container per session
Each agent session gets its own dedicated Docker container. This ensures strict security isolation, prevents workspace contamination between runs, and provides a clean environment for checkpoint/resume operations.

### Bun over Node
The daemon uses Bun for its fast startup times and native TypeScript support. Bun's `Bun.serve` is also used to provide a high-performance HTTP API for Programmatic Tool Calling (PTC). Node.js is retained in the image only to support SDKs that require it (like Claude).

### No Python in LangGraph
By using the `deepagents` JS SDK, the LangGraph harness avoids any dependency on Python. This significantly reduces the image size and eliminates the complexity of managing a Python environment alongside the Node/Bun runtime.

### Harness SDK wrapping over raw API calls
Instead of calling LLM provider APIs directly, Stablehand wraps official or high-level agent SDKs. This allows the system to benefit from SDK-level features like built-in tool execution loops, MCP support, and reliable error handling, while maintaining a consistent interface for the orchestrator.
