import { z } from 'zod';

import { DurationMsSchema, EpochMillisSchema } from './time.js';

/**
 * Operational/uncontracted-surface schemas (ctx-iqzy S11/U6, "contract or it
 * doesn't ship"): queue status, system settings, event stats, tool catalog,
 * feedback ack, and the typed throttle (429/503) error bodies. Routes parse
 * their responses through these at the reply site; the UI imports them
 * instead of keeping mirror types.
 */

// ── GET /api/queue/status ─────────────────────────────────────────────
export const QueueStatusResponseSchema = z.strictObject({
  queuedTurns: z.number().int().nonnegative(),
  oldestQueuedAgeMs: DurationMsSchema.nullable(),
  /** ctx-4p34: permanently failed webhook deliveries (dead letters). */
  deadLetteredCallbacks: z.number().int().nonnegative(),
  dispatcher: z.strictObject({
    stalled: z.boolean().nullable(),
    lastPassCompletedAt: EpochMillisSchema.nullable(),
  }),
  state: z.enum(['healthy', 'degraded']),
});
export type QueueStatusResponse = z.infer<typeof QueueStatusResponseSchema>;

// ── GET/PUT /api/settings ─────────────────────────────────────────────
// Field list must match @stablehand/shared SYSTEM_SETTING_BOUNDS; a drift test
// in the orchestrator asserts the two key sets are identical.
export const SystemSettingsSchema = z.strictObject({
  maxWorkspaceTarBytes: z.number().int().positive(),
  maxTarUploadBytes: z.number().int().positive(),
  idleTimeoutMs: DurationMsSchema,
  turnTimeoutMs: DurationMsSchema,
  reconciliationIntervalMs: DurationMsSchema,
  maxGlobalContainers: z.number().int().positive(),
  queueTimeoutMs: DurationMsSchema,
  maxQueuedTurnsGlobal: z.number().int().positive(),
  maxQueuedTurnsPerAgent: z.number().int().positive(),
  maxIngestQueueDepth: z.number().int().positive(),
  queuedTurnTimeoutMs: DurationMsSchema,
  maxConcurrentSessionsPerAgent: z.number().int().positive(),
  maxTriggerDepth: z.number().int().positive(),
  defaultCpus: z.number().positive(),
  /** MiB, despite the Mb spelling (documented unit exception). */
  defaultMemoryMb: z.number().int().positive(),
  defaultPidsLimit: z.number().int().positive(),
  defaultTimeoutSec: z.number().int().positive(),
});
export type SystemSettings = z.infer<typeof SystemSettingsSchema>;

// ── GET /api/events/stats + /api/events/types ─────────────────────────
export const EventStatsResponseSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  byType: z.record(z.string(), z.number().int().nonnegative()),
  topAgents: z.array(z.strictObject({
    agentId: z.string().nullable(),
    count: z.number().int().nonnegative(),
  })),
  /** Events per minute over the trailing five minutes. */
  recentRate: z.number().nonnegative(),
});
export type EventStatsResponse = z.infer<typeof EventStatsResponseSchema>;

export const EventTypesResponseSchema = z.strictObject({
  types: z.array(z.string()),
});
export type EventTypesResponse = z.infer<typeof EventTypesResponseSchema>;

// ── GET /api/catalogs/tools + POST /api/catalogs/tools/test ──────────
/**
 * Where a catalog tool comes from, as its provider reports it (ctx-z08z):
 * `local` (built into this deployment), `http` (an agent's HTTP endpoint) or
 * `mcp` (a tool listed by an agent's MCP server).
 */
export const CatalogToolSourceSchema = z.enum(['local', 'http', 'mcp']);
export type CatalogToolSource = z.infer<typeof CatalogToolSourceSchema>;

export const CatalogToolSchema = z.strictObject({
  name: z.string(),
  /** Plain label for people, e.g. "List meetings". */
  displayName: z.string().optional(),
  description: z.string().optional(),
  source: CatalogToolSourceSchema,
  /** The MCP server (or other grouping) the tool belongs to, e.g. "granola". */
  server: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  requiresApproval: z.boolean().optional(),
  secrets: z.array(z.string()).optional(),
  /** True when the tool is implicitly attached to every agent. */
  builtin: z.boolean().optional(),
  /** Where the tool actually executes at runtime. */
  location: z.enum(['sandbox', 'orchestrator', 'daemon']).optional(),
});
export type CatalogTool = z.infer<typeof CatalogToolSchema>;
export const CatalogToolListResponseSchema = z.array(CatalogToolSchema);

export const ToolTestResponseSchema = z.strictObject({
  success: z.boolean(),
  result: z.string().optional(),
  error: z.string().optional(),
  durationMs: DurationMsSchema,
});
export type ToolTestResponse = z.infer<typeof ToolTestResponseSchema>;

// ── POST /api/agents/:id/feedback ─────────────────────────────────────
export const FeedbackAckSchema = z.strictObject({
  feedbackId: z.string(),
  type: z.string(),
  turnId: z.string().nullable(),
});
export type FeedbackAck = z.infer<typeof FeedbackAckSchema>;

// ── /api/triggers CRUD (T5) ───────────────────────────────────────────
export const TriggerSchema = z.strictObject({
  id: z.string(),
  agentId: z.string(),
  eventType: z.string(),
  selector: z.record(z.string(), z.unknown()).optional(),
  taskTemplate: z.string(),
  /** Thread key template: firings that render the same key share a conversation. */
  conversationKey: z.string().optional(),
  enabled: z.boolean(),
  createdAt: EpochMillisSchema,
});
export type Trigger = z.infer<typeof TriggerSchema>;
export const TriggerListResponseSchema = z.array(TriggerSchema);

// ── GET /api/triggers/failures (ctx-v6ef) ─────────────────────────────
/**
 * A dead-lettered trigger firing: the matching event did not start a run,
 * either because the target refused it (non-retryable, attempts = 1) or
 * because retries ran out. The event spine has moved past it.
 */
export const TriggerFiringFailureSchema = z.strictObject({
  id: z.string(),
  triggerId: z.string(),
  agentId: z.string(),
  /** Type of the source event that matched; null on rows from before ctx-v6ef. */
  eventType: z.string().nullable(),
  eventSeq: z.number().int().nonnegative(),
  /** Machine token, e.g. `agent_mode_not_allowed`, `queue_full`, `trigger_fire_failed`. */
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int().positive(),
  createdAt: EpochMillisSchema,
});
export type TriggerFiringFailure = z.infer<typeof TriggerFiringFailureSchema>;
export const TriggerFiringFailureListResponseSchema = z.strictObject({
  failures: z.array(TriggerFiringFailureSchema),
});
export type TriggerFiringFailureListResponse = z.infer<typeof TriggerFiringFailureListResponseSchema>;

// ── Typed throttle bodies (U6) ────────────────────────────────────────
// Convention (S12/R3): `error` is the human sentence, `code` the machine
// token; every throttle mirrors its Retry-After header as `retryAfterSec`.
const throttleBase = {
  error: z.string(),
  retryAfterSec: z.number().int().positive(),
};

export const QueueFullErrorBodySchema = z.strictObject({
  ...throttleBase,
  code: z.literal('queue_full'),
  scope: z.enum(['global', 'agent']),
  agentId: z.string(),
  queued: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
});
export const DispatchStalledErrorBodySchema = z.strictObject({
  ...throttleBase,
  code: z.literal('dispatch_stalled'),
});
export const IngestQueueFullErrorBodySchema = z.strictObject({
  ...throttleBase,
  code: z.literal('ingest_queue_full'),
  depth: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
});
export const ConcurrencyLimitErrorBodySchema = z.strictObject({
  ...throttleBase,
  code: z.literal('concurrency_limit_reached'),
  agentId: z.string(),
  maxConcurrent: z.number().int().positive(),
});
export const ThrottleErrorBodySchema = z.discriminatedUnion('code', [
  QueueFullErrorBodySchema,
  DispatchStalledErrorBodySchema,
  IngestQueueFullErrorBodySchema,
  ConcurrencyLimitErrorBodySchema,
]);
export type ThrottleErrorBody = z.infer<typeof ThrottleErrorBodySchema>;
