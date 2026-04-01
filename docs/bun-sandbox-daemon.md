# Bun Sandbox Daemon

## Overview

The sandbox daemon runtime has migrated from Node.js to Bun. This change improves sandbox performance, enables native TypeScript execution without a container-side build step, and provides the foundation for Programmatic Tool Calling (PTC). Bun's fast startup and efficient HTTP server (`Bun.serve`) make it the ideal runtime for the high-frequency, low-latency operations required inside sandbox containers.

## Architecture

The project uses a dual-runtime model. The orchestrator process runs on Node.js for maximum compatibility with the broader ecosystem, while sandbox containers use Bun for execution.

A full migration to Bun was avoided because the Claude Agent SDK depends on spawning Node.js subprocesses for its internal CLI operations. By maintaining both runtimes in the sandbox image, we get the performance benefits of Bun for the daemon and PTC scripts while ensuring the harness SDKs remain stable.

The Dockerfile stages reflect this hybrid approach:
1. **build**: Uses Node.js and `tsc` to compile the shared packages and the orchestrator.
2. **harness-base**: Starts from `node:22-slim`, installs the Bun binary, and copies both the TypeScript source (`src/`) and compiled JavaScript (`dist/`).
3. **per-harness**: Final images for LangGraph, Claude, and PI agents, all inheriting the dual-runtime base.

## What Changed

### Entrypoints
The container entrypoints changed from `node dist/daemon.js` to `bun run src/daemon.ts`. Because Bun executes TypeScript natively, the daemon no longer relies on the compiled `dist/` folder for its own execution, though `dist/` remains in the image to support package exports consumed by the orchestrator.

### Runtime Image
The runtime image now carries the full `src/` directory of the `sandbox-daemon` package. This allows for rapid iteration and debugging inside the container without needing to rebuild the entire stack to see changes in the daemon logic.

### ConnectRPC
The gRPC communication layer still uses `@connectrpc/connect-node`. Compatibility testing confirmed that this adapter works correctly under Bun's `node:http2` implementation, supporting both unary and server-streaming RPCs.

## Compatibility

The following components have been validated to run correctly on Bun within the sandbox environment:
- **ConnectRPC**: Full HarnessService lifecycle (OpenSession, DeliverTurn, SuspendSession, KillSession).
- **Claude Agent SDK**: Successfully initializes and manages its Node.js subprocesses.
- **Protobuf**: Serialization and deserialization via `@bufbuild/protobuf`.
- **Zod**: Input validation and JSON Schema conversion.
- **child_process**: Standard Node.js subprocess spawning.

One known limitation is that Bun's native `fetch()` does not support cleartext HTTP/2 (h2c). This does not affect the project because gRPC clients use the ConnectRPC transport which handles the protocol negotiation correctly.

## Fallback

If Bun introduces stability issues in a specific environment, the system can be reverted to the Node.js runtime by changing the container entrypoint back to `node dist/sandbox/daemon.js`. The `dist/` folder is preserved in all harness images specifically to support this fallback path.

## Configuration

The Bun runtime migration does not require new environment variables for basic operation. However, the following variable controls the new tool API:

- `PTC_PORT`: The port where the local HTTP tool API listens (default: 8080). This is used by PTC scripts to communicate with the daemon.
