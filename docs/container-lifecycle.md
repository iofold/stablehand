# Container Lifecycle Reference

This document describes the current lifecycle of sandbox containers in CTXMill, including the active state machine, timeout thresholds, resource limits, and reconciliation logic.

## Container State Machine

Sandbox containers are managed jointly by `SandboxSessionManager` (request path) and `ContainerLifecyclePolicy` (idle timeout + reconciliation).

```text
       [ Start ]
           |
           v
      +---------+      open/ready      +---------+
      | Created | -------------------> | Active  |
      +---------+                      +---------+
                                           |   \
                                           |    \
                                manual     |     \ idle timeout / suspend
                                pause      |      \
                                           v       v
                                      +---------+ +--------------+
                                      | Paused  | | Checkpointed |
                                      +---------+ +--------------+
                                           |   \         |
                                           |    \        | restore
                                     resume |     \      v
                                           |      +--> +-----------+
                                           +---------- | Restoring |
                                                      +-----------+
                                                           |
                                                           v
                                                       +---------+
                                                       | Active  |
                                                       +---------+

Any live container can also be terminated and removed.
```

Key points:
- There is no persisted `FROZEN` state in the current runtime.
- Automatic idle handling checkpoints sessions directly.
- `PAUSED` is a compatibility/manual pause state reached via `pauseSession()` or the `/freeze` API alias.
- HITL is modeled through durable interrupt records plus `run.interrupted` / `run.interrupt_resolved`, not through a distinct sandbox-session status.

### Transitions
1. **Start**: Container created and started via `ContainerManager`.
2. **Activate**: The orchestrator opens the sandbox session and begins delivering turns.
3. **Manual Pause**: A live container is paused via `docker pause` through `pauseSession()` / `/freeze`.
4. **Resume**: A paused container is unpaused via `resumeSession()` / `/unfreeze`.
5. **Checkpoint**: The harness exports checkpoint state, workspace diff is captured, and the container is removed.
6. **Restore**: A checkpointed session provisions a fresh container and restores harness/workspace state.
7. **Cleanup**: Explicit kill, reconciliation, or timeout removes the container and marks the session terminal.

## Lifecycle Phases

### 1. Creation
Containers are created using the `ctxmill/harness-{harness}:latest` images.
- **Network**: Attached to the `ctxmill-agents` bridge network.
- **Labels**:
  - `ctxmill.managed`: `true`
  - `ctxmill.session-id`: UUID of the sandbox session
  - `ctxmill.agent-id`: ID of the agent
  - `ctxmill.harness`: Harness type (for example `langgraph`)
  - `ctxmill.started-at`: ISO timestamp
  - `ctxmill.timeout`: Maximum run duration in seconds
- **Secrets**: Injected via a `tmpfs` mount at `/run/secrets/config.json`.

### 2. Startup
- **Health Check**: The orchestrator polls the container gRPC endpoint on port `50051` until it responds.
- **OpenSession**: A gRPC `OpenSession` call initializes the harness with agent configuration, prompts, and tool metadata.

### 3. Active
- **DeliverTurn**: Messages are streamed to the harness via gRPC.
- **Tool Execution**: Tools run either inside the sandbox or proxied back to the orchestrator.
- **Event Streaming**: Turn, tool, and message events are rebroadcast to SSE clients through `SSEBroadcaster`.

### 4. Paused
- **Trigger**: Manual compatibility pause via `pauseSession()` / `/freeze`.
- **Action**: `docker pause` freezes processes while keeping container memory intact.
- **Note**: Automatic idle lifecycle does not pass through `PAUSED`; it checkpoints directly.

### 5. Checkpointed
- **Trigger**: Idle timeout, explicit suspend, or recovery flow.
- **Action**:
  1. Harness state is exported to checkpoint payloads.
  2. Workspace diff is captured as `workspace.tar.gz`.
  3. Container is stopped and removed.
  4. Session status in DB becomes `CHECKPOINTED`.

### 6. Restoring
- **Trigger**: A new turn or interrupt resolution targets a checkpointed session.
- **Action**: A new container is provisioned, secrets are re-injected, checkpoint state is restored, and the session returns to `ACTIVE`.

### 7. Cleanup
Containers are removed when:
- The session is explicitly killed.
- Reconciliation determines the container is orphaned or expired.
- Recovery decides the session must be terminated instead of restored.

## Timeout Thresholds

These values are defined in `ContainerLifecyclePolicy`, `SandboxSessionManager`, `InterruptManager`, and the settings service.

| Threshold | Default | Description |
|-----------|---------|-------------|
| **Idle Timeout** | 5 minutes | Time before an idle `ACTIVE` session is checkpointed directly. |
| **Interrupt Wait** | 5 minutes | Default `request-approval` wait before an interrupt times out. |
| **Turn Timeout** | 30 minutes | Default max time for a single turn execution. |
| **Health Check** | 10 seconds | Max time to wait for a new container to become ready. |
| **Reconciliation** | 5 minutes | Interval for orphan/session reconciliation. |
| **Queue Timeout** | 10 minutes | Max time a request waits in the container semaphore queue. |

## Resource Limits

Default limits are applied by `ContainerManager` unless overridden in the agent manifest.

- **CPU**: `1.0` fractional cores.
- **Memory**: `1024 MiB` by default.
  - `claude-agents` has a hard floor of `2048 MiB`.
- **PIDs**: `256`.
- **Workspace Tar**: `100 MB` cap for checkpoint workspace snapshots.

### Configuration
Limits can be set in the agent YAML under `resourceLimits`:

```yaml
resourceLimits:
  cpus: 2.0
  memoryMb: 4096
  pidsLimit: 512
  timeoutSec: 3600
```

## Concurrency & Semaphore

To prevent resource exhaustion, the orchestrator uses a global `ContainerSemaphore`.

- **Max Concurrent Containers**: `20` by default (`CTXMILL_MAX_GLOBAL_CONTAINERS`).
- **Queueing**: Requests wait in FIFO order when capacity is exhausted.
- **Timeout**: If a request exceeds `queueTimeoutMs` (default `10 minutes`), it fails with `503 Service Unavailable` / `ContainerLimitError`.

## Manual Operations

Operators can inspect or remove managed containers with standard Docker commands.

### List Managed Containers
```bash
docker ps --filter "label=ctxmill.managed=true"
```

### Inspect a Session
```bash
docker inspect "$(docker ps -aq --filter "label=ctxmill.session-id=<session-id>")"
```

### View Logs
```bash
docker logs "$(docker ps -aq --filter "label=ctxmill.session-id=<session-id>")"
```

### Manually Kill a Container
```bash
docker rm -f "$(docker ps -aq --filter "label=ctxmill.session-id=<session-id>")"
```

The orchestrator will reconcile the missing container on the next lifecycle pass and mark the session `TERMINATED` or `CHECKPOINTED`, depending on checkpoint availability.

## Orphan Reconciliation

`ContainerLifecyclePolicy` runs a reconciliation loop every 5 minutes to keep Docker state aligned with the database.

1. **Dead sessions**: If a DB session is live but its container is gone, reconciliation marks it `CHECKPOINTED` when checkpoint data exists, otherwise `TERMINATED`.
2. **Orphan containers**: Managed containers with no corresponding live DB session are removed.
3. **Expired containers**: Containers exceeding their timeout labels are stopped and removed.

## HITL Integration

Human-in-the-loop approvals are durable, but they are not modeled as a separate lifecycle state.

1. An approval request persists a pending interrupt and emits `run.interrupted`.
2. The session may stay live, be manually paused, or later be checkpointed through normal lifecycle rules.
3. When the user resolves the interrupt, the orchestrator resumes the matching session or restores it from checkpoint and delivers a continuation turn.

## Troubleshooting

### Resource Exhaustion
If you see `ContainerLimitError` (`503`) in the UI:
- Increase `CTXMILL_MAX_GLOBAL_CONTAINERS` or `queueTimeoutMs`.
- Check for orphan containers that reconciliation might have missed.

### Health Check Failures
If containers are created but fail to start:
- Ensure the `ctxmill-agents` network exists with `docker network ls`.
- Check container logs for gRPC startup errors.
- Verify the harness image was rebuilt after sandbox-daemon changes.
