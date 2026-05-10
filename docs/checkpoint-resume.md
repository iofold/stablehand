# Checkpoint and Resume Operational Guide

CTXMill uses application-level checkpoint/restore for sandbox sessions. Session status values are uppercase (`ACTIVE`, `CHECKPOINTED`, `RESTORING`, `TERMINATED`). The current runtime has no separate persisted pause or frozen state.

## How Checkpoint and Resume Works

The runtime uses checkpoint / restore: the harness exports structured state, the orchestrator captures workspace changes, the container is removed, and a later restore provisions a fresh container and rehydrates the session.

Automatic idle handling checkpoints sessions directly rather than promoting them through an intermediate container-idle state.

## Session State Machine

Sessions move through these states:

- **ACTIVE**: The agent is running or ready to run in a live container.
- **CHECKPOINTED**: The container is removed. Harness state and workspace diff are stored for later restore.
- **RESTORING**: A new container is being provisioned and restored from checkpoint data.
- **TERMINATED**: The session is closed and resources are cleaned up.

## Timing Thresholds

The current defaults are:

| Event | Default | Action |
| :--- | :--- | :--- |
| **Idle Timeout** | 5 minutes | Idle `ACTIVE` session is checkpointed directly. |
| **Interrupt Wait** | 5 minutes | `request-approval` waits for user resolution before timing out. |
| **Turn Timeout** | 30 minutes | Single-turn execution timeout. |

There is no longer a documented `freezePromotionMs` / `pauseDelayMs` automatic ladder in the settings surface.

## Checkpoint Contents

A checkpoint consists of two main parts:

### 1. Session State
- **Message History**: Conversation messages known to the harness/session.
- **Pending Tool Calls**: Outstanding tool requests and approval requests.
- **Harness State**: Harness-specific exported state (for example LangGraph thread state).
- **Metadata**: Session ID, conversation ID, cursor state, and runner status.

### 2. Workspace Diff
- **Changed Files**: Files created, modified, or deleted under `/workspace`.
- **Compression**: Stored as a Gzip-compressed tarball at `data/checkpoints/{sessionId}/workspace.tar.gz`.

### What is NOT Saved
- **Secrets**: API keys and credentials are never stored in checkpoints.
- **Raw Docker State**: Network namespaces, mounts outside `/workspace`, and live process memory are discarded.

## Size Limits

The current runtime behavior is:

- **Checkpoint JSON**: The sandbox-daemon validator warns at `1 MB` and rejects payloads over `5 MB` by default.
- **Workspace Tar**: `100 MB` maximum.

## Secret Handling

Secrets are handled separately from checkpoints:

1. **Resolve**: On restore, the orchestrator re-resolves required secrets from the secret provider.
2. **Inject**: Secrets are passed into the new sandbox container as environment variables.
3. **Destroy**: When the container is removed, those runtime environment values disappear with it.

## HITL Flow

When an agent requests human approval:

1. The orchestrator persists a pending interrupt and emits `run.interrupted` / `HITL_PAUSE`.
2. The session may remain live or later be checkpointed through normal lifecycle rules.
3. When the user approves or rejects, the orchestrator resumes the session or restores it from checkpoint.
4. A continuation turn delivers the resolution back to the harness.

## Manual Operations

Operators can trigger these actions via the API:

### Suspend a Session
Immediately checkpoints and removes the live container.

`POST /api/agents/{agentId}/sessions/{sessionId}/suspend`

### Kill a Session
Stops and removes the live container, terminating the sandbox session.

`POST /api/agents/{agentId}/sessions/{sessionId}/kill`

## Workspace Tar Restore

The workspace diff process is:

1. **Extract**: CTXMill identifies changed files in the container writable layer.
2. **Compress**: Files are bundled into a `.tar.gz`.
3. **Store**: The archive is written under `data/checkpoints/{sessionId}/`.
4. **Restore**: On session restore, the archive is unpacked into the new container before execution continues.

## Debugging

### Common Failures

- **Workspace diff too large**: The agent wrote too much data under `/workspace`.
- **Checkpoint too large**: The harness export exceeded the daemon validator limit.
- **Restore failure (`ENOENT`)**: The workspace tarball or checkpoint metadata is missing.
- **Stale container**: Docker no longer has the container, but the session row still looks live. Reconciliation should move it to `CHECKPOINTED` or `TERMINATED`.

### Inspection

- **Check checkpoint files**: Inspect `data/checkpoints/{sessionId}` for JSON/tar presence and size.
- **Check logs**: Look for `[WorkspaceDiff]`, `[SandboxSessionManager]`, and daemon checkpoint log lines.
- **Check container status**: Use `docker ps -a --filter "label=ctxmill.session-id=<session-id>"`.
