# ADR 018: Harness Adapters Map, the Kit Runs the Lifecycle

**Date:** 2026-07-08
**Status:** Accepted

## Context

CTXMill supports multiple sandbox harness adapters. Before consolidation, each
adapter independently implemented turn accumulation, message commit boundaries,
approval events, abort wiring, model auth resolution, token usage normalization,
and LangSmith tracing. Those copies drifted: LangGraph had unstable turn IDs and
missing usage, PI and Claude had separate approval/abort behavior, and suspend
could checkpoint before a final assistant commit.

## Decision

Harness adapters own only SDK-specific mapping:

- open or restore the SDK session;
- translate SDK-native events into normalized `AgentEvent`s;
- shape tools and model config for that SDK.

Shared lifecycle behavior lives in `packages/sandbox-daemon/src/harness/kit/`:

- `TurnAccumulator` owns incremental assistant commit and final done shape;
- approval helpers emit canonical approval events and rejection text;
- abort helpers link signals and dispose listeners;
- model auth and usage helpers normalize provider-specific details;
- `traceAgentEvents` observes normalized event streams for one shared tracing path.

New adapters must use the kit instead of reimplementing lifecycle mechanics.

## Enforcement

- LangGraph, Claude Agents, and PI Agent all import kit helpers for turn
  accumulation, approval, abort, usage, and tracing.
- Harness tests assert stable `turnId`, usage presence, approval events, abort
  discipline, state version, and shared LangSmith span shape.
- The runner suspend tests prove checkpoint export waits for
  `message_committed`, so committed assistant text is present before suspend.

## Consequences

- Adapter code is easier to compare because SDK mapping is no longer mixed with
  generic turn lifecycle code.
- Future adapters such as OpenAI Agents or Vercel AI SDK should be mostly event
  mapping and tool shaping.
- Tracing consumes normalized `AgentEvent`s, so harnesses do not need separate
  tracing vocabularies.
