# ADR 007: Workspace File Upload Contract

**Date:** 2026-04-30  
**Status:** Accepted

## Context

`AgentFilesTab` exposes an upload button, but workspace files and run artifacts have different ownership and customer semantics.

## Decision

Files-tab upload means workspace file upload, not artifact upload. Workspace file routes own listing, editing, upload, and delete behavior. Artifact service remains the owner for persisted run artifacts. Binary or multifile upload requires an explicit workspace upload API rather than reusing artifact upload semantics.

## Consequences

- Stage 4 owns `ctx-h99`, `ctx-wrx`, `ctx-bfi`, `ctx-u4p`, and `ctx-ssm` after this ADR is accepted.
- UI must keep artifact and workspace file behavior visibly separate.
- Workspace upload tests must target the workspace-file contract.
