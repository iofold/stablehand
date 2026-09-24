# packages/sandbox-daemon - Sandbox Daemon Process

## Overview

Daemon process deployed inside harness containers. It exposes `HarnessService` to the orchestrator, runs one of the harness adapters, proxies orchestrator-location tools back over ConnectRPC, handles daemon-location tools such as artifacts, exports/restores harness checkpoint state, and emits session events back to the orchestrator.

## Structure

```text
src/
  artifact/      S3/MinIO artifact access from daemon-side tools
  harness/       LangGraph, Claude Agents, PI Agent adapters and shared helpers
  observability/ Optional tracing auto-registration
  sandbox/       gRPC daemon, runner, callback auth, checkpoint, proto conversion, PTC codegen, tool proxy
  tool/          Tool schema/types used inside the daemon
  util/          Retry helpers
```

## Where To Look

| Task | File(s) | Notes |
|---|---|---|
| Modify gRPC server | `sandbox/daemon.ts` | HarnessService plus local daemon API used by PTC scripts. |
| Fix harness behavior | `harness/{langgraph,claude-agents,pi-agent}.ts` | This code runs inside containers. |
| Change turn lifecycle | `sandbox/runner.ts` | Terminal-frame discipline, suspend/kill, checkpoint export. |
| Change proto mapping | `sandbox/proto-convert.ts` | AgentEvent <-> SessionEvent conversion. |
| Change callback auth | `sandbox/callback-auth.ts`, `sandbox/tool-proxy.ts` | Session-scoped HMAC headers are sent on sandbox callbacks. |
| Change artifact tools | `artifact/artifact-store.ts`, `sandbox/artifact-handler.ts` | Upload/download bytes from daemon location. |
| Change PTC | `sandbox/ptc-codegen.ts`, `sandbox/daemon.ts` | Programmatic tools are generated in `/workspace/.tools` for eligible tools. |

## Invariants

- Never import orchestrator modules; the daemon has no runtime access to them.
- Never serialize resolved secrets into checkpoints.
- A normal completed/failed turn must emit a terminal frame. Suspend is non-terminal. Abnormal stream end should fail the turn.
- Always log harness catch blocks to stderr; otherwise only the error string reaches the orchestrator.
- Workspace `ENOENT` often means the `cwd` does not exist, not that the executable is missing.

## Rebuilding

Changes here require rebuilding harness images, not just the orchestrator:

```bash
docker build --target harness-langgraph -t stablehand/harness-langgraph -f Dockerfile.sandbox .
docker build --target harness-claude-agents -t stablehand/harness-claude-agents -f Dockerfile.sandbox .
docker build --target harness-pi-agent -t stablehand/harness-pi-agent -f Dockerfile.sandbox .
```
