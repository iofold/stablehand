import { sql } from 'drizzle-orm';
import { pgTable, text, bigint, boolean, serial, integer, index, jsonb, uniqueIndex, doublePrecision, check } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import type { SandboxSessionStatus } from '@stablehand/shared';
import type { TurnUsage } from '@stablehand/contracts';

export type TurnStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
export type ModelGatewayTurnMode = 'gateway_only' | 'mixed';
export type ModelGatewayCostState = 'priced' | 'explicit_free' | 'unpriced';
export type SandboxSessionLifecycleOperation =
  | 'checkpoint'
  | 'terminate'
  | 'reset'
  | 'adopt';
export type SandboxSessionLifecyclePhase =
  | 'reserved'
  | 'draining'
  | 'executing'
  | 'completed';

export const agents = pgTable('agents', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  harness: text('harness').notNull(),
  harnessConfig: text('harness_config').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  tools: jsonb('tools').notNull().$type<string[]>(),
  description: text('description'),
  workspaceDir: text('workspace_dir'),
  manifest: jsonb('manifest').$type<Record<string, unknown>>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  nameIdx: uniqueIndex('idx_agents_name').on(table.name),
}));

export const agentWorkspaceState = pgTable('agent_workspace_state', {
  agentId: text('agent_id').primaryKey().references(() => agents.id, { onDelete: 'cascade' }),
  revision: bigint('revision', { mode: 'number' }).notNull().default(1),
  sha256: text('sha256').notNull(),
  fileCount: integer('file_count').notNull(),
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
  appliedAt: bigint('applied_at', { mode: 'number' }).notNull(),
});

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id),
  // Budget-attribution tags, fixed at conversation creation (caller tags +
  // agent defaults). Immutable for the life of the conversation.
  tags: jsonb('tags').$type<Record<string, string>>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentUpdatedIdx: index('idx_conversations_agent_updated').on(table.agentId, table.updatedAt),
}));

export const messages = pgTable('messages', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  agentId: text('agent_id'),
  // Canonical assistant/tool identity. Legacy and user-authored rows may be
  // null; all newly emitted assistant/tool rows are turn-owned and sequenced.
  turnId: text('turn_id'),
  messageSeq: bigint('message_seq', { mode: 'number' }),
  // Public full-replacement revision. Revision 0 is the committed baseline.
  messageRevision: bigint('message_revision', { mode: 'number' }).notNull().default(0),
  // Internal durability watermark:
  // -1 = no message.committed frame, 0 = baseline published,
  // N > 0 = latest durably published message.updated revision.
  publishedRevision: bigint('published_revision', { mode: 'number' }).notNull().default(0),
  role: text('role').notNull(),
  content: text('content').notNull(),
  toolCallId: text('tool_call_id'),
  toolCalls: jsonb('tool_calls').$type<unknown[]>(),
  parts: jsonb('parts').$type<unknown[]>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  conversationCreatedIdx: index('idx_messages_conversation_created').on(table.conversationId, table.createdAt),
  turnSeqIdx: uniqueIndex('idx_messages_turn_seq')
    .on(table.turnId, table.messageSeq)
    .where(sql`${table.turnId} IS NOT NULL AND ${table.messageSeq} IS NOT NULL`),
}));

export const turns = pgTable('turns', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  sandboxSessionId: text('sandbox_session_id').references(() => sandboxSessions.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  conversationId: text('conversation_id').references(() => conversations.id),
  mode: text('mode').notNull().default('interactive'),
  taskDescription: text('task_description'),
  status: text('status').$type<TurnStatus>().notNull().default('queued'),
  userMessageId: text('user_message_id'),
  // ctx-iqzy T2: queue-admission time (insert). startedAt is restamped at
  // activation and means execution start; until activation it equals queuedAt.
  queuedAt: bigint('queued_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  startedAt: bigint('started_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  completedAt: bigint('completed_at', { mode: 'number' }),
  error: text('error'),
  // Token usage reported by the harness at turn completion; null when the
  // harness did not report usage (distinct from a real zero).
  inputTokens: bigint('input_tokens', { mode: 'number' }),
  outputTokens: bigint('output_tokens', { mode: 'number' }),
  totalTokens: bigint('total_tokens', { mode: 'number' }),
  costUsd: doublePrecision('cost_usd'),
  // Canonical coverage-aware usage projection. The scalar columns above
  // remain indexed aggregate inputs for budget queries.
  usage: jsonb('usage').$type<TurnUsage>(),
  // Opaque gateway attribution. No policy, tag, provider key, or raw turn
  // identity is stored in this namespace.
  gatewayCorrelationId: text('gateway_correlation_id'),
  gatewayProfile: text('gateway_profile'),
  gatewayRevision: text('gateway_revision'),
  gatewayMode: text('gateway_mode').$type<ModelGatewayTurnMode>(),
  usageReconciledAt: bigint('usage_reconciled_at', { mode: 'number' }),
  // Durable allocator for canonical assistant/tool message ordering.
  nextMessageSeq: bigint('next_message_seq', { mode: 'number' }).notNull().default(0),
  // Highest seq of the atomically persisted terminal frame batch. Null means
  // the row is open or terminal publication still needs runtime/startup repair.
  terminalPublishedSeq: bigint('terminal_published_seq', { mode: 'number' }),
  // Cross-replica delivery ownership retained as a monotonic durable fence.
  deliveryOwnerId: text('delivery_owner_id'),
  deliveryFenceToken: bigint('delivery_fence_token', { mode: 'number' }),
  // Denormalized budget-attribution tags: conversation tags + system tags
  // (agent/harness/mode), stamped at turn creation for spend aggregation.
  tags: jsonb('tags').notNull().$type<Record<string, string>>().default({}),
}, (table) => ({
  agentStartedIdx: index('idx_turns_agent_started').on(table.agentId, table.startedAt),
  sandboxSessionIdx: index('idx_turns_sandbox_session').on(table.sandboxSessionId),
  statusOpenIdx: index('idx_turns_status_open').on(table.status).where(sql`${table.completedAt} IS NULL`),
  conversationRunningIdx: uniqueIndex('idx_turns_conversation_running')
    .on(table.conversationId)
    .where(sql`
      ${table.conversationId} IS NOT NULL
      AND ${table.status} = 'running'
      AND ${table.completedAt} IS NULL
    `),
  tagsGinIdx: index('idx_turns_tags_gin').using('gin', table.tags),
  gatewayCorrelationIdx: uniqueIndex('idx_turns_gateway_correlation')
    .on(table.gatewayProfile, table.gatewayCorrelationId)
    .where(sql`${table.gatewayCorrelationId} IS NOT NULL`),
}));

/**
 * One logical usage row per correlated turn. The initial adapters declare
 * turn-only granularity, so this row deliberately does not count fabricated
 * model calls.
 */
export const modelCallUsage = pgTable('model_call_usage', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  turnId: text('turn_id').notNull().references(() => turns.id, { onDelete: 'cascade' }),
  observationScope: text('observation_scope').notNull().default('turn_aggregate'),
  gatewayProfile: text('gateway_profile').notNull(),
  gatewayRevision: text('gateway_revision').notNull(),
  correlationId: text('correlation_id').notNull(),
  status: text('status').notNull().default('pending'),
  inputTokens: bigint('input_tokens', { mode: 'number' }),
  outputTokens: bigint('output_tokens', { mode: 'number' }),
  totalTokens: bigint('total_tokens', { mode: 'number' }),
  cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }),
  cacheCreateTokens: bigint('cache_create_tokens', { mode: 'number' }),
  reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }),
  knownCostUsd: doublePrecision('known_cost_usd').notNull().default(0),
  costState: text('cost_state').$type<ModelGatewayCostState>().notNull().default('unpriced'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  turnUniqueIdx: uniqueIndex('idx_model_call_usage_turn').on(table.turnId),
  correlationIdx: uniqueIndex('idx_model_call_usage_correlation')
    .on(table.gatewayProfile, table.correlationId),
}));

/**
 * One immutable identity per LiteLLM spend transaction. Multiple transactions
 * may roll up into the turn aggregate without pretending they are distinct
 * logical model calls.
 */
export const modelCallAttemptUsage = pgTable('model_call_attempt_usage', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  modelCallUsageId: text('model_call_usage_id').notNull()
    .references(() => modelCallUsage.id, { onDelete: 'cascade' }),
  gatewayProfile: text('gateway_profile').notNull(),
  gatewayRevision: text('gateway_revision').notNull(),
  gatewayTransactionId: text('gateway_transaction_id').notNull(),
  requestedModel: text('requested_model'),
  resolvedModel: text('resolved_model'),
  provider: text('provider'),
  status: text('status').notNull(),
  inputTokens: bigint('input_tokens', { mode: 'number' }),
  outputTokens: bigint('output_tokens', { mode: 'number' }),
  totalTokens: bigint('total_tokens', { mode: 'number' }),
  cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }),
  cacheCreateTokens: bigint('cache_create_tokens', { mode: 'number' }),
  reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }),
  costUsd: doublePrecision('cost_usd'),
  costState: text('cost_state').$type<ModelGatewayCostState>().notNull(),
  startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  endedAt: bigint('ended_at', { mode: 'number' }).notNull(),
  ingestedAt: bigint('ingested_at', { mode: 'number' }).notNull(),
}, (table) => ({
  transactionUniqueIdx: uniqueIndex('idx_model_call_attempt_gateway_transaction')
    .on(table.gatewayProfile, table.gatewayTransactionId),
  aggregateIdx: index('idx_model_call_attempt_aggregate').on(table.modelCallUsageId),
}));

export const modelGatewayReconciliationState = pgTable('model_gateway_reconciliation_state', {
  gatewayProfile: text('gateway_profile').primaryKey(),
  gatewayRevision: text('gateway_revision').notNull(),
  watermarkMs: bigint('watermark_ms', { mode: 'number' }).notNull().default(0),
  leaseOwnerId: text('lease_owner_id'),
  leaseFenceToken: bigint('lease_fence_token', { mode: 'number' }).notNull().default(0),
  leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }),
  lastAttemptAt: bigint('last_attempt_at', { mode: 'number' }),
  lastSuccessAt: bigint('last_success_at', { mode: 'number' }),
  lastError: text('last_error'),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
});

export const modelGatewaySpendQuarantine = pgTable('model_gateway_spend_quarantine', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  gatewayProfile: text('gateway_profile').notNull(),
  gatewayTransactionId: text('gateway_transaction_id').notNull(),
  correlationId: text('correlation_id'),
  reason: text('reason').notNull(),
  sanitizedPayload: jsonb('sanitized_payload').notNull().$type<Record<string, unknown>>(),
  occurrences: integer('occurrences').notNull().default(1),
  firstSeenAt: bigint('first_seen_at', { mode: 'number' }).notNull(),
  lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
}, (table) => ({
  transactionUniqueIdx: uniqueIndex('idx_model_gateway_quarantine_transaction')
    .on(table.gatewayProfile, table.gatewayTransactionId),
  correlationIdx: index('idx_model_gateway_quarantine_correlation')
    .on(table.gatewayProfile, table.correlationId),
}));

/**
 * Encrypted, turn-bound credentials retained only while a turn is open.
 *
 * Plaintext never enters this table or a sandbox checkpoint. Terminal turn
 * finalization deletes the envelope in the same transaction as the status
 * change.
 */
export const turnSecretEnvelopes = pgTable('turn_secret_envelopes', {
  turnId: text('turn_id').primaryKey().references(() => turns.id, { onDelete: 'cascade' }),
  iv: text('iv').notNull(),
  ciphertext: text('ciphertext').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
});

export type TurnStartRequestStatus = 'preparing' | 'prepared';

/**
 * Durable API idempotency ledger for turn creation. Identifiers are allocated
 * before conversation/message/turn writes and the response is persisted before
 * sandbox execution is launched.
 */
export const turnStartRequests = pgTable('turn_start_requests', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  status: text('status').$type<TurnStartRequestStatus>().notNull().default('preparing'),
  turnId: text('turn_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  response: jsonb('response').$type<Record<string, unknown>>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentKeyUnique: uniqueIndex('idx_turn_start_requests_agent_key').on(
    table.agentId,
    table.idempotencyKey,
  ),
}));

/**
 * Cross-process ownership for every admitted turn delivery.
 *
 * A live owner protects normal work from another replica's startup scan.
 * Expiry admits one monotonic-token reconciliation owner after a crash.
 */
export const turnDeliveryLeases = pgTable('turn_delivery_leases', {
  turnId: text('turn_id').primaryKey().references(() => turns.id, { onDelete: 'cascade' }),
  ownerId: text('owner_id').notNull(),
  fenceToken: bigint('fence_token', { mode: 'number' }).notNull().default(0),
  leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  expiresIdx: index('idx_turn_delivery_leases_expires').on(table.leaseExpiresAt),
}));

export const eventStore = pgTable('event_store', {
  seq: serial('seq').primaryKey(),
  type: text('type').notNull(),
  agentId: text('agent_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  // Canonical event spine columns (ADR-015): frame provenance + replay keys.
  turnId: text('turn_id'),
  conversationId: text('conversation_id'),
  channel: text('channel').notNull().default('system'),
  // Raw bus provenance (ADR-016): set on exactly one row per ingested bus event.
  sourceType: text('source_type'),
  sourcePayload: text('source_payload'),
}, (table) => ({
  agentSeqIdx: index('idx_event_store_agent_seq').on(table.agentId, table.seq),
  turnSeqIdx: index('idx_event_store_turn_seq')
    .on(table.turnId, table.seq)
    .where(sql`${table.turnId} IS NOT NULL`),
  conversationSeqIdx: index('idx_event_store_conversation_seq')
    .on(table.conversationId, table.seq)
    .where(sql`${table.conversationId} IS NOT NULL`),
  agentChannelSeqIdx: index('idx_event_store_agent_channel_seq').on(table.agentId, table.channel, table.seq),
}));

/**
 * Per-agent committed event watermark and writer mutex.
 *
 * Event writers lock this row before allocating event_store sequences, then
 * advance committedSeq in the same transaction. Unlike PostgreSQL sequences,
 * this watermark is commit ordered and therefore safe as an SSE replay cursor.
 *
 * This is event-spine state, not an owned child of the live agent projection:
 * the row must outlive a hard-deleted agent long enough to serialize and retain
 * its final agent.deleted tombstone.
 */
export const agentEventHeads = pgTable('agent_event_heads', {
  agentId: text('agent_id').primaryKey(),
  committedSeq: bigint('committed_seq', { mode: 'number' }).notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
});

export const spineCursors = pgTable('spine_cursors', {
  consumer: text('consumer').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
});

export const suspendedSessions = pgTable('suspended_sessions', {
  id: text('id').primaryKey(),
  turnId: text('turn_id').notNull(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  waitEventType: text('wait_event_type').notNull(),
  waitSelector: text('wait_selector').notNull(),
  waitExpiresAt: bigint('wait_expires_at', { mode: 'number' }),
  snapshotState: text('snapshot_state').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  eventTypeIdx: index('idx_suspended_sessions_event_type').on(table.waitEventType),
  agentIdx: index('idx_suspended_sessions_agent').on(table.agentId),
  expiresIdx: index('idx_suspended_sessions_expires').on(table.waitExpiresAt),
}));

export const eventTriggers = pgTable('event_triggers', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  selector: jsonb('selector').$type<Record<string, unknown> | null>(),
  selectorHash: text('selector_hash').notNull(),
  taskTemplate: text('task_template').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentIdx: index('idx_event_triggers_agent').on(table.agentId),
  eventTypeIdx: index('idx_event_triggers_event_type').on(table.eventType),
  signatureIdx: uniqueIndex('idx_event_triggers_signature').on(table.agentId, table.eventType, table.selectorHash),
}));

export const triggerFirings = pgTable('trigger_firings', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  triggerId: text('trigger_id').notNull().references(() => eventTriggers.id, { onDelete: 'cascade' }),
  eventSeq: bigint('event_seq', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  triggerEventSeqIdx: uniqueIndex('idx_trigger_firings_trigger_event_seq').on(table.triggerId, table.eventSeq),
  eventSeqIdx: index('idx_trigger_firings_event_seq').on(table.eventSeq),
}));

export const schedules = pgTable('schedules', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  cronExpression: text('cron_expression').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  lastFiredAt: bigint('last_fired_at', { mode: 'number' }),
  missedFireCount: bigint('missed_fire_count', { mode: 'number' }).notNull().default(0),
}, (table) => ({
  nameIdx: uniqueIndex('idx_schedules_name').on(table.name),
  agentIdx: index('idx_schedules_agent').on(table.agentId),
  enabledIdx: index('idx_schedules_enabled').on(table.enabled),
}));

export const pendingInterrupts = pgTable('pending_interrupts', {
  id: text('id').primaryKey(),
  turnId: text('turn_id').notNull().references(() => turns.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id),
  sandboxSessionId: text('sandbox_session_id'),
  toolCallId: text('tool_call_id').notNull(),
  toolName: text('tool_name').notNull(),
  args: jsonb('args').notNull().$type<Record<string, unknown>>().default({}),
  timeoutMs: integer('timeout_ms').notNull().default(300000),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  resolvedAt: bigint('resolved_at', { mode: 'number' }),
  resolvedAction: text('resolved_action'),
  resolvedData: jsonb('resolved_data').$type<unknown>(),
  status: text('status').notNull().default('pending'),
}, (table) => ({
  turnIdx: index('idx_interrupts_turn').on(table.turnId),
  agentIdx: index('idx_interrupts_agent').on(table.agentId),
  statusExpiresIdx: index('idx_interrupts_status').on(table.status, table.expiresAt),
}));

export const interruptResumeAttempts = pgTable('interrupt_resume_attempts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  interruptId: text('interrupt_id').notNull().references(() => pendingInterrupts.id, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull().references(() => turns.id, { onDelete: 'cascade' }),
  sandboxSessionId: text('sandbox_session_id'),
  agentId: text('agent_id').notNull().references(() => agents.id),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  completedAt: bigint('completed_at', { mode: 'number' }),
}, (table) => ({
  interruptUniqueIdx: uniqueIndex('idx_interrupt_resume_attempts_interrupt').on(table.interruptId),
  agentStatusIdx: index('idx_interrupt_resume_attempts_agent_status').on(table.agentId, table.status),
  sandboxSessionIdx: index('idx_interrupt_resume_attempts_sandbox_session').on(table.sandboxSessionId),
}));

export const sandboxSessions = pgTable('sandbox_sessions', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  containerName: text('container_name'),
  containerId: text('container_id'),
  status: text('status')
    .$type<SandboxSessionStatus>()
    .notNull()
    .default('ACTIVE'),
  harnessName: text('harness_name').notNull(),
  runtimeDefinitionHash: text('runtime_definition_hash'),
  checkpointRef: text('checkpoint_ref'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  lastActivityAt: bigint('last_activity_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  restoreAttempts: integer('restore_attempts').notNull().default(0),
  lastRestoreError: text('last_restore_error'),
  checkpointFailures: integer('checkpoint_failures').notNull().default(0),
  lastCheckpointError: text('last_checkpoint_error'),
  restoreOwnerId: text('restore_owner_id'),
  restoreFenceToken: bigint('restore_fence_token', { mode: 'number' })
    .notNull()
    .default(0),
  restoreLeaseExpiresAt: bigint('restore_lease_expires_at', {
    mode: 'number',
  }),
}, (table) => ({
  conversationIdx: index('idx_sandbox_sessions_conversation').on(table.conversationId),
  conversationLiveIdx: uniqueIndex('idx_sandbox_sessions_conversation_live')
    .on(table.conversationId)
    .where(sql`${table.status} IN ('ACTIVE', 'RESTORING')`),
  agentIdx: index('idx_sandbox_sessions_agent').on(table.agentId),
  statusIdx: index('idx_sandbox_sessions_status').on(table.status),
  lastActivityIdx: index('idx_sandbox_sessions_last_activity').on(table.lastActivityAt),
  statusCheck: check(
    'sandbox_sessions_status_check',
    sql`${table.status} IN ('ACTIVE', 'CHECKPOINTED', 'RESTORING', 'TERMINATED')`,
  ),
  restoreOwnershipCheck: check(
    'sandbox_sessions_restore_ownership_check',
    sql`(
      (
        ${table.status} = 'RESTORING'
        AND ${table.restoreOwnerId} IS NOT NULL
        AND ${table.restoreFenceToken} > 0
        AND ${table.restoreLeaseExpiresAt} IS NOT NULL
      )
      OR
      (
        ${table.status} <> 'RESTORING'
        AND ${table.restoreOwnerId} IS NULL
        AND ${table.restoreLeaseExpiresAt} IS NULL
      )
    )`,
  ),
}));

/**
 * Durable exclusion intent for sandbox lifecycle and runtime adoption work.
 *
 * An unfinished row blocks new turn admission even after its worker lease
 * expires. Expiry only permits a new lifecycle worker to take over and finish,
 * reconcile, or safely cancel the same operation.
 */
export const sandboxSessionLifecycleOperations = pgTable(
  'sandbox_session_lifecycle_operations',
  {
    sandboxSessionId: text('sandbox_session_id')
      .primaryKey()
      .references(() => sandboxSessions.id, { onDelete: 'cascade' }),
    operation: text('operation')
      .$type<SandboxSessionLifecycleOperation>()
      .notNull(),
    operationId: text('operation_id')
      .notNull()
      .$defaultFn(() => randomUUID()),
    phase: text('phase')
      .$type<SandboxSessionLifecyclePhase>()
      .notNull()
      .default('reserved'),
    ownerId: text('owner_id').notNull(),
    fenceToken: bigint('fence_token', { mode: 'number' }).notNull().default(0),
    allowedTurnId: text('allowed_turn_id').references(() => turns.id, {
      onDelete: 'set null',
    }),
    allowedDeliveryOwnerId: text('allowed_delivery_owner_id'),
    allowedDeliveryFenceToken: bigint('allowed_delivery_fence_token', {
      mode: 'number',
    }),
    allowedInterruptResumeAttemptId: text(
      'allowed_interrupt_resume_attempt_id',
    ).references(() => interruptResumeAttempts.id, {
      onDelete: 'set null',
    }),
    leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    phaseIdx: index('idx_sandbox_session_lifecycle_operations_phase').on(table.phase),
    expiresIdx: index('idx_sandbox_session_lifecycle_operations_expires').on(
      table.leaseExpiresAt,
    ),
  }),
);

export const agentCheckpoints = pgTable('agent_checkpoints', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  sandboxSessionId: text('sandbox_session_id').notNull().references(() => sandboxSessions.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  checkpointVersion: integer('checkpoint_version').notNull().default(2),
  checkpointData: jsonb('checkpoint_data').notNull().$type<Record<string, unknown>>(),
  harnessState: jsonb('harness_state').$type<Record<string, unknown>>(),
  workspaceRef: text('workspace_ref'),
  suspendReason: text('suspend_reason'),
  lifecycleOperationId: text('lifecycle_operation_id'),
  lifecycleOwnerId: text('lifecycle_owner_id'),
  lifecycleFenceToken: bigint('lifecycle_fence_token', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  sandboxSessionIdx: index('idx_checkpoints_sandbox_session_id').on(table.sandboxSessionId),
  agentIdx: index('idx_checkpoints_agent_id').on(table.agentId),
}));

export const callbackOutbox = pgTable('callback_outbox', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id),
  turnId: text('turn_id').references(() => turns.id),
  webhookId: text('webhook_id').references(() => webhooks.id, { onDelete: 'set null' }),
  callbackUrl: text('callback_url').notNull(),
  eventType: text('event_type').notNull(),
  eventSeq: bigint('event_seq', { mode: 'number' }),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  nextAttemptAt: bigint('next_attempt_at', { mode: 'number' }).notNull(),
  claimedAt: bigint('claimed_at', { mode: 'number' }),
  claimExpiresAt: bigint('claim_expires_at', { mode: 'number' }),
  lastAttemptAt: bigint('last_attempt_at', { mode: 'number' }),
  lastError: text('last_error'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  deliveredAt: bigint('delivered_at', { mode: 'number' }),
}, (table) => ({
  statusIdx: index('idx_outbox_status').on(table.status, table.nextAttemptAt),
  claimExpiresIdx: index('idx_outbox_claim_expires').on(table.status, table.claimExpiresAt),
  agentIdx: index('idx_outbox_agent').on(table.agentId),
  callbackEventSeqIdx: uniqueIndex('idx_outbox_callback_event_seq')
    .on(table.callbackUrl, table.eventType, table.eventSeq)
    .where(sql`${table.eventSeq} IS NOT NULL`),
}));

export const webhooks = pgTable('webhooks', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  events: jsonb('events').notNull().$type<string[]>(),
  secret: text('secret'),
  active: boolean('active').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentIdx: index('idx_webhooks_agent').on(table.agentId),
}));

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

/**
 * Declarative tag-based budget policies (2026-07-15 proposal). `doc` holds
 * the validated policy document: selector, groupBy, window, limits, actions.
 */
export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey().$defaultFn(() => `key_${randomUUID()}`),
  name: text('name').notNull().unique(),
  tokenHash: text('token_hash').notNull().unique(),
  capabilities: text('capabilities').array().notNull().$type<string[]>(),
  note: text('note'),
  // ctx-k6ad: NULL = operator/all-agents key; set = scoped to one agent.
  agentId: text('agent_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  createdBy: text('created_by'),
  expiresAt: bigint('expires_at', { mode: 'number' }),
  lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  revokedAt: bigint('revoked_at', { mode: 'number' }),
});

export const budgetPolicies = pgTable('budget_policies', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  doc: jsonb('doc').notNull().$type<Record<string, unknown>>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
});

export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  turnId: text('turn_id').references(() => turns.id, { onDelete: 'set null' }),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storageKey: text('storage_key').notNull(),
  bucket: text('bucket').notNull(),
  kind: text('kind'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  sha256: text('sha256'),
  status: text('status').notNull().default('active'),
  expiresAt: bigint('expires_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentCreatedIdx: index('idx_artifacts_agent_created').on(table.agentId, table.createdAt),
  turnIdx: index('idx_artifacts_turn').on(table.turnId),
  statusIdx: index('idx_artifacts_status').on(table.status),
}));

export const toolRequestDedup = pgTable('tool_request_dedup', {
  requestId: text('request_id').primaryKey(),
  turnId: text('turn_id').notNull(),
  toolName: text('tool_name').notNull(),
  status: text('status').notNull().default('in_progress'),
  result: text('result'),
  error: text('error'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  completedAt: bigint('completed_at', { mode: 'number' }),
}, (table) => ({
  createdIdx: index('idx_tool_dedup_created').on(table.createdAt),
  statusIdx: index('idx_tool_dedup_status').on(table.status),
}));

export type SandboxSessionRow = typeof sandboxSessions.$inferSelect;
export type SystemSettingRow = typeof systemSettings.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactInsert = typeof artifacts.$inferInsert;
