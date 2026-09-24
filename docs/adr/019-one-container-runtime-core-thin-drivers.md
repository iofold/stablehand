# ADR 019: One Container Runtime Core, Thin Drivers

**Date:** 2026-07-08
**Status:** Accepted

## Context

The Docker and Kubernetes sandbox managers duplicated container specification
assembly, status normalization, workspace path safety, restore validation, slot
accounting, and lifecycle delegation. This duplication was especially risky for
workspace archive filtering and restore tombstone validation because security
policy could diverge between runtimes.

## Decision

Container runtime policy is centralized under
`packages/stablehand/src/sandbox/runtime/`:

- `spec.ts` builds Docker create payloads and Kubernetes Job manifests from the
  same labels, environment, resource limits, memory floors, and startup-grace
  rules.
- `status.ts` owns Docker/Kubernetes status normalization and alive checks.
- `workspace-policy.ts` owns workspace path filtering, exclusion segments,
  archive entry validation, and deletion tombstone validation.
- `core.ts` owns slot accounting, rehydration, metrics, and the public
  `SandboxContainerManager` delegation surface.

Docker and Kubernetes drivers own only transport-specific operations: create,
start, stop, remove, list, inspect, logs, and archive movement.

## Enforcement

- `ContainerManager` and `KubernetesContainerManager` are compatibility
  wrappers around `SandboxContainerCore`.
- Docker and Kubernetes drivers both call shared spec/status/workspace-policy
  helpers.
- Focused runtime tests cover spec assembly, status mapping, workspace policy,
  container accounting, metrics, concurrency, and lifecycle reconciliation.

## Consequences

- Runtime behavior changes can be tested once at the shared-policy layer and
  then validated through both drivers.
- Driver files may remain transport-heavy; the accepted closeout scores the
  original aggregate LOC target as partial because policy centralization matters
  more than compressing backend-specific API plumbing.
- New runtime backends must implement the driver surface and reuse the shared
  policy modules.
