import { sql } from 'drizzle-orm';
import { pgTable, text, bigint, boolean, serial, integer, index, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

export type TurnStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';

export const agents = pgTable('agents', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  harness: text('harness').notNull(),
  harnessConfig: text('harness_config').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  tools: jsonb('tools').notNull().$type<string[]>(),
  description: text('description'),
  workspaceDir: text('workspace_dir'),
  status: text('status').notNull().default('created'),
  manifest: jsonb('manifest').$type<Record<string, unknown>>(),
  version: bigint('version', { mode: 'number' }).default(1),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
});

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentUpdatedIdx: index('idx_conversations_agent_updated').on(table.agentId, table.updatedAt),
}));

export const messages = pgTable('messages', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  agentId: text('agent_id'),
  role: text('role').notNull(),
  content: text('content').notNull(),
  toolCallId: text('tool_call_id'),
  toolCalls: jsonb('tool_calls').$type<unknown[]>(),
  parts: jsonb('parts').$type<unknown[]>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  conversationCreatedIdx: index('idx_messages_conversation_created').on(table.conversationId, table.createdAt),
}));

export const turns = pgTable('turns', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  sessionId: text('session_id').references(() => sandboxSessions.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  conversationId: text('conversation_id').references(() => conversations.id),
  mode: text('mode').notNull().default('interactive'),
  taskDescription: text('task_description'),
  status: text('status').$type<TurnStatus>().notNull().default('queued'),
  userMessageId: text('user_message_id'),
  startedAt: bigint('started_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  completedAt: bigint('completed_at', { mode: 'number' }),
  error: text('error'),
}, (table) => ({
  agentStartedIdx: index('idx_turns_agent_started').on(table.agentId, table.startedAt),
  sessionIdx: index('idx_turns_session').on(table.sessionId),
  statusOpenIdx: index('idx_turns_status_open').on(table.status).where(sql`${table.completedAt} IS NULL`),
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
  agentChannelSeqIdx: index('idx_event_store_agent_channel_seq').on(table.agentId, table.channel, table.seq),
}));

export const spineCursors = pgTable('spine_cursors', {
  consumer: text('consumer').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
});

export const suspendedSessions = pgTable('suspended_sessions', {
  id: text('id').primaryKey(),
  agentSessionId: text('agent_session_id').notNull(),
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
  createdAt: text('created_at').notNull(),
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

export const agentVersions = pgTable('agent_versions', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  version: bigint('version', { mode: 'number' }).notNull(),
  manifest: jsonb('manifest').notNull().$type<Record<string, unknown>>(),
  changedBy: text('changed_by'),
  changeNote: text('change_note'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentVersionIdx: uniqueIndex('idx_agent_versions_agent_version').on(table.agentId, table.version),
}));

export const pendingInterrupts = pgTable('pending_interrupts', {
  id: text('id').primaryKey(),
  agentSessionId: text('agent_session_id').notNull().references(() => turns.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id),
  sessionId: text('session_id'),
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
  agentSessionIdx: index('idx_interrupts_agent_session').on(table.agentSessionId),
  agentIdx: index('idx_interrupts_agent').on(table.agentId),
  statusExpiresIdx: index('idx_interrupts_status').on(table.status, table.expiresAt),
}));

export const interruptResumeAttempts = pgTable('interrupt_resume_attempts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  interruptId: text('interrupt_id').notNull().references(() => pendingInterrupts.id, { onDelete: 'cascade' }),
  agentSessionId: text('agent_session_id').notNull().references(() => turns.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'),
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
  sessionIdx: index('idx_interrupt_resume_attempts_session').on(table.sessionId),
}));

export const sandboxSessions = pgTable('sandbox_sessions', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  containerName: text('container_name'),
  containerId: text('container_id'),
  status: text('status').notNull().default('ACTIVE'),
  harnessName: text('harness_name').notNull(),
  checkpointRef: text('checkpoint_ref'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  lastActivityAt: bigint('last_activity_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  restoreAttempts: integer('restore_attempts').notNull().default(0),
  lastRestoreError: text('last_restore_error'),
}, (table) => ({
  conversationIdx: index('idx_sandbox_sessions_conversation').on(table.conversationId),
  agentIdx: index('idx_sandbox_sessions_agent').on(table.agentId),
  statusIdx: index('idx_sandbox_sessions_status').on(table.status),
  lastActivityIdx: index('idx_sandbox_sessions_last_activity').on(table.lastActivityAt),
}));

export const agentCheckpoints = pgTable('agent_checkpoints', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  sessionId: text('session_id').notNull().references(() => sandboxSessions.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  checkpointVersion: integer('checkpoint_version').notNull().default(2),
  checkpointData: jsonb('checkpoint_data').notNull().$type<Record<string, unknown>>(),
  harnessState: jsonb('harness_state').$type<Record<string, unknown>>(),
  workspaceRef: text('workspace_ref'),
  suspendReason: text('suspend_reason'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  sessionIdx: index('idx_checkpoints_session_id').on(table.sessionId),
  agentIdx: index('idx_checkpoints_agent_id').on(table.agentId),
}));

export const callbackOutbox = pgTable('callback_outbox', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id),
  sessionId: text('session_id').references(() => turns.id),
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

export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  sessionId: text('session_id').references(() => turns.id, { onDelete: 'set null' }),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storageKey: text('storage_key').notNull(),
  bucket: text('bucket').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('active'),
  expiresAt: bigint('expires_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentCreatedIdx: index('idx_artifacts_agent_created').on(table.agentId, table.createdAt),
  sessionIdx: index('idx_artifacts_session').on(table.sessionId),
  statusIdx: index('idx_artifacts_status').on(table.status),
}));

export const toolRequestDedup = pgTable('tool_request_dedup', {
  requestId: text('request_id').primaryKey(),
  sessionId: text('session_id').notNull(),
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
