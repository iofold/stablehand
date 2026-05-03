# ADR 010: Workspace Upload Contract Specifics

**Date:** 2026-05-01
**Status:** Accepted
**Refines:** ADR 007 (Workspace File Upload Contract)

## Context

ADR 007 named the boundary (workspace files ≠ artifacts) but left the implementation surface open. `ctx-h99` requires concrete decisions on upload modes, size caps, mime policy, and session scoping.

Current state: `POST /api/agents/:id/files` accepts a gzipped tar via `validateAndExtractTarball` (`packages/ctxmill/src/workspace/tar-upload.ts`); UI button at `packages/ui/src/components/agent/AgentFilesTab.tsx:75` is disabled in session view.

## Decision

### Upload modes
**Tar.gz archive only.** Single-file drag-drop, multi-file drag-drop, and in-place edit/rename/delete are deferred to a v2 ADR. Customers needing finer-grained edits use the harness's filesystem tool inside an active session.

### Size limits
- **Per-file inside the archive:** 5 MB (post-decompression).
- **Total archive (compressed):** 100 MB.
- Both limits are configurable via Settings UI; the listed values are defaults. Reject archives that exceed either limit at validation time, before extraction.

### Mime / extension policy
**Deny-list:**
- Reject `.exe`, `.dll`, `.so`, `.dylib`, `.bat`, `.cmd`, `.app` files.
- Reject any path with a symlink pointing outside the workspace root (already enforced by `tar-upload.ts`; tests must assert this).
- Everything else is allowed (text, code, configs, small binaries, images).

### Session scoping
**Base workspace only.** Sessions inherit the base workspace; session-scoped uploads stay disabled. The UI must keep the "Base workspace uploads are disabled in session view" hint at `AgentFilesTab.tsx:84`.

## Consequences

- Stage 4 (`ctx-h99`) implements upload UX against the existing tar-only API; no new API routes required.
- Settings UI exposes the two size limits with sane defaults; validation must read from settings, not constants.
- Tests required:
  - Per-file size cap reject.
  - Total archive cap reject.
  - Deny-list extension reject.
  - Symlink-escape reject.
  - Session-view upload-button disabled.
- v2 (multifile drag-drop, in-place edit) is a follow-up plan, not a Stage 4 deliverable.
