# Container Lifecycle Reference

This document describes the lifecycle of sandbox containers in ctxmill, including the state machine, timeout thresholds, resource limits, and reconciliation logic.

## Container State Machine

Sandbox containers follow a multi-stage state machine managed by the `SandboxSessionManager` and `ContainerLifecyclePolicy`.

```text
       [ Start ]
           |
           v
      +---------+      (1)       +---------+
      | Created | -------------> | Running | <------------------+
      +---------+                +---------+                    |
           |                          |                         |
           | (6)                      | (2)                     | (5)
           |                          v                         |
           |                    +---------+      (3)       +---------+
           +------------------> | Paused  | -------------> | Frozen  |
           |                    +---------+                +---------+
           |                          |                         |
           | (6)                      | (4)                     | (4)
           |                          v                         |
           |                   +--------------+                 |
           +-----------------> | Checkpointed | <---------------+
                               +--------------+
                                      |
                                      | (7)
                                      v
                                 +---------+
                                 | Removed |
                                 +---------+
```

### Transitions
1.  **Start**: Container created and started via `ContainerManager`.
2.  **Idle/HITL Pause**: Container is paused via `docker pause` after a period of inactivity or when waiting for human approval.
3.  **Freeze Promotion**: Paused container is promoted to "Frozen" (app-level checkpoint) if it remains idle.
4.  **Checkpoint Promotion**: Frozen or Paused container is fully suspended. Workspace diff is captured, harness state is persisted to DB, and the container is removed.
5.  **Resume**: Paused or Frozen container is unpaused via `docker unpause` when a new turn is delivered.
6.  **Direct Checkpoint**: Idle containers may be checkpointed directly if they were never paused.
7.  **Cleanup**: Container is stopped and removed from Docker.

## Lifecycle Phases

### 1. Creation
Containers are created using the `ctxmill/harness-{harness}:latest` images.
- **Network**: Attached to the `ctxmill-agents` bridge network.
- **Labels**:
  - `ctxmill.managed`: `true`
  - `ctxmill.session-id`: UUID of the session
  - `ctxmill.agent-id`: ID of the agent
  - `ctxmill.harness`: Harness type (e.g., `langgraph`)
  - `ctxmill.started-at`: ISO timestamp
  - `ctxmill.timeout`: Maximum run duration in seconds
- **Secrets**: Injected via a `tmpfs` mount at `/run/secrets/config.json`.

### 2. Startup
- **Health Check**: The orchestrator polls the container's gRPC endpoint (port 50051) until it responds.
- **OpenSession**: A gRPC `OpenSession` call initializes the harness with agent configuration, system prompts, and tool metadata.

### 3. Active
- **DeliverTurn**: Messages are sent to the harness via gRPC streaming.
- **Tool Execution**: Tools are executed either locally in the container or proxied back to the orchestrator.
- **Event Streaming**: Agent events (text deltas, tool calls, etc.) are streamed back to the UI via SSE.

### 4. Idle
When a turn completes, an idle timer starts. If no new turn is delivered within the timeout, the container enters the **Paused** state.

### 5. Paused
- **Trigger**: 5 minutes of inactivity (default).
- **Action**: `docker pause` is called on the container. This freezes all processes and stops CPU usage while keeping memory intact.

### 6. Frozen
- **Trigger**: Continued inactivity while paused.
- **Action**: The harness performs a cooperative suspend, saving its internal state to the database.

### 7. Checkpointed
- **Trigger**: Final escalation of the idle/HITL timer.
- **Action**:
  1.  Workspace diff is captured (tarball of changed files).
  2.  Harness state is saved to the `sandbox_session_checkpoints_v2` table.
  3.  Container is stopped and removed.
  4.  Session status in DB becomes `CHECKPOINTED`.

### 8. Cleanup
Containers are removed when:
- The session is explicitly killed.
- The container exceeds its `ctxmill.timeout` label.
- The orchestrator detects an "orphan" container (no matching active session in DB).

## Timeout Thresholds

These values are defined in `ContainerLifecyclePolicy` and `SandboxSessionManager`.

| Threshold | Value | Description |
|-----------|-------|-------------|
| **Idle Timeout** | 5 minutes | Time before an active container is paused or checkpointed. |
| **HITL Grace** | 5 minutes | Time allowed for human approval before the container is checkpointed. |
| **Turn Timeout** | 5 minutes | Maximum time for a single gRPC `deliverTurn` stream. |
| **Health Check** | 10 seconds | Max time to wait for a new container to become ready. |
| **Reconciliation** | 5 minutes | Interval for the background orphan cleanup process. |
| **Queue Timeout** | 60 seconds | Max time a request waits in the concurrency semaphore queue. |

## Resource Limits

Default limits are applied by `ContainerManager` unless overridden in the agent manifest.

- **CPU**: 1.0 (fractional cores).
- **Memory**: 1024 MiB (default).
  - *Note*: `claude-agents` harness has a hard floor of **2048 MiB**.
- **PIDs**: 256 (prevents fork bombs).
- **Storage**: Workspace changes are capped at 100 MB for tarballs.

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

To prevent resource exhaustion, the orchestrator uses a global semaphore (`ContainerSemaphore`).

- **Max Concurrent Containers**: 20 (configurable via `CTXMILL_MAX_CONTAINERS`).
- **Queueing**: If the limit is reached, new container requests enter a FIFO queue.
- **Timeout**: If a request stays in the queue for more than 60 seconds, it fails with a `503 Service Unavailable` (`ContainerLimitError`).

## Manual Operations

Operators can interact with sandbox containers using standard Docker commands.

### List Managed Containers
```bash
docker ps --filter "label=ctxmill.managed=true"
```

### Inspect a Session
```bash
docker inspect ctxmill-run-<session-id>
```

### View Logs
```bash
docker logs ctxmill-run-<session-id>
```

### Manually Kill a Container
```bash
docker rm -f ctxmill-run-<session-id>
```
*Note: The orchestrator will detect the missing container during the next reconciliation cycle and mark the session as `TERMINATED` or `CHECKPOINTED`.*

## Orphan Reconciliation

The `ContainerLifecyclePolicy` runs a reconciliation loop every 5 minutes to ensure the Docker state matches the database.

1.  **Dead Sessions**: If a session is `ACTIVE` in the DB but its container is gone, it is marked `CHECKPOINTED` (if a checkpoint exists) or `TERMINATED`.
2.  **Orphan Containers**: If a container has the `ctxmill.managed` label but no corresponding `ACTIVE` session in the DB, it is forcefully removed.
3.  **Expired Containers**: Containers exceeding their `ctxmill.timeout` are stopped and removed.

## HITL Integration

Human-in-the-loop (HITL) approvals interact with the lifecycle to save resources:

1.  **Pause**: When an agent requests approval, the container is immediately paused (`docker pause`) after a 5-second grace period.
2.  **Escalation**: If no approval is received within 5 minutes, the container is promoted to a full **Checkpoint** and removed.
3.  **Resume**: When the user submits the approval, the orchestrator unpauses the container (or restores it from checkpoint) and delivers the resolution as a new turn.

## Troubleshooting

### Stuck Containers
If a container is stuck in `paused` state and won't resume:
- Check orchestrator logs for `unpauseContainer` failures.
- Manually unpause: `docker unpause <container-id>`.

### Resource Exhaustion
If you see `ContainerLimitError` (503) in the UI:
- Increase `CTXMILL_MAX_CONTAINERS` in your `.env` file.
- Check for orphan containers that reconciliation might have missed.

### Health Check Failures
If containers are created but fail to start:
- Ensure the `ctxmill-agents` network exists: `docker network ls`.
- Check container logs for gRPC server startup errors.
- Verify that the harness image is built correctly.
