# Checkpoint and Resume Operational Guide

CTXMill uses a two-tier suspend system to manage long-running agent sessions. This system balances fast resume times for active sessions with resource efficiency for idle ones.

## How Checkpoint and Resume Works

The system operates in two tiers:

1.  **Docker Pause (Tier 1)**: Freezes the container processes using Linux cgroups. This preserves the entire memory state, open file descriptors, and network connections. Resuming from this state is nearly instantaneous.
2.  **Application Checkpoint (Tier 2)**: Serializes the agent's internal state (message history, pending tool calls, harness-specific data) into a JSON object and captures filesystem changes in a compressed tarball. The container is then removed. Resuming requires creating a new container and restoring the state.

## Session State Machine

Sessions move through these states:

*   **ACTIVE**: The agent is running or ready to run in a live container.
*   **PAUSED**: The container is frozen via `docker pause`. Memory is still allocated on the host.
*   **CHECKPOINTED**: The container is removed. State is persisted in the database and the workspace diff is stored on disk.
*   **RESTORING**: A transitional state while a new container is being provisioned and state is being restored.
*   **TERMINATED**: The session is closed and all resources are cleaned up.

## Timing Thresholds

The system automatically manages transitions based on these default thresholds:

| Event | Threshold | Action |
| :--- | :--- | :--- |
| **HITL Wait** | 5 seconds | Container is paused via `docker pause`. |
| **Idle Wait** | 5 minutes | Container is paused via `docker pause`. |
| **Pause Promotion** | 5 minutes | A paused container is promoted to a full checkpoint and removed. |
| **Idle Checkpoint** | 5 minutes | An idle session is checkpointed directly if it cannot be paused. |

These values are configurable via system settings: `pauseDelayMs`, `idleTimeoutMs`, and `maxPauseDurationMs`.

## Checkpoint Contents

A checkpoint consists of two main parts:

### 1. Session State (JSON)
*   **Message History**: All messages in the conversation.
*   **Pending Tool Calls**: Tools requested by the LLM but not yet executed.
*   **Harness State**: Internal state specific to the harness (e.g., LangGraph thread state).
*   **Metadata**: Turn ID, iteration count, and token usage.

### 2. Workspace Diff (tar.gz)
*   **Changed Files**: Any files created, modified, or deleted in the `/workspace` directory.
*   **Compression**: Stored as a Gzip-compressed tarball at `data/checkpoints/{sessionId}/workspace.tar.gz`.

### What is NOT Saved
*   **Secrets**: API keys and credentials are never stored in checkpoints.
*   **Raw Docker State**: Network namespaces, non-workspace mounts, and raw process memory are discarded.

## Size Limits

The system enforces strict limits to prevent resource exhaustion:

*   **Session State**: 5 MB maximum.
*   **Workspace Tar**: 100 MB maximum.

If a workspace diff exceeds the limit, the checkpoint operation fails. The system logs a warning when the diff reaches 50% of the limit.

## Secret Handling

Secrets are security-critical and are handled separately from checkpoints:

1.  **Injection**: On resume, the orchestrator re-resolves all required secrets from the secret provider.
2.  **Mounting**: Secrets are injected into the new container via a `tmpfs` mount at `/run/secrets/config.json`.
3.  **Isolation**: Because secrets are in RAM-backed storage, they never touch the host's disk and are destroyed when the container is removed.

## HITL Pause Flow

When an agent requests human approval:

1.  The agent emits a `HITL_PAUSE` event.
2.  The orchestrator waits for the `pauseDelayMs` (default 5s).
3.  The container is paused.
4.  If the user does not respond within 5 minutes, the session is promoted to a full checkpoint to free up host memory.
5.  When the user approves or rejects, the session is resumed (either by unpausing or restoring from checkpoint) and a continuation turn is delivered.

## Manual Operations

Operators can trigger these actions via the API:

### Suspend a Session
Triggers an immediate promotion to a full checkpoint.
`POST /api/agents/{agentId}/sessions/{sessionId}/suspend`

### Freeze a Session
Manually pauses the container.
`POST /api/agents/{agentId}/sessions/{sessionId}/freeze`

### Unfreeze a Session
Resumes a paused container.
`POST /api/agents/{agentId}/sessions/{sessionId}/unfreeze`

### Kill a Session
Immediately stops and removes the container, deleting all session state.
`POST /api/agents/{agentId}/sessions/{sessionId}/kill`

## Workspace Tar in Checkpoints

The workspace diff capture process:

1.  **Extraction**: The system identifies changed files in the container's writable layer.
2.  **Compression**: Files are bundled into a tarball and compressed with Gzip.
3.  **Storage**: The resulting `.tar.gz` is saved to the checkpoint directory.
4.  **Restoration**: On resume, the tarball is decompressed and injected into the new container's root directory before the agent starts.

## Debugging

### Common Failures

*   **Workspace diff too large**: The agent created too much data in `/workspace`. Increase the `maxWorkspaceTarBytes` setting or instruct the agent to clean up temporary files.
*   **Restore failure (ENOENT)**: The workspace tarball was deleted or moved from the `data/checkpoints` directory.
*   **Stale Container**: The orchestrator thinks a container is running, but Docker reports it as gone. The reconciliation loop usually fixes this by marking the session as `CHECKPOINTED` if a checkpoint exists.

### Inspection

*   **Check Sizes**: Inspect the `data/checkpoints/{sessionId}` directory to see the actual size of the workspace tarball.
*   **Logs**: Check the orchestrator logs for `[WorkspaceDiff]` or `[SandboxSessionManager]` tags.
*   **Container Status**: Use `docker ps -a` to see if containers are in a `paused` or `exited` state.
