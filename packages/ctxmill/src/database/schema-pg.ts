import { pgTable, text, bigint, boolean, doublePrecision, serial, index, jsonb } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

export const agents = pgTable('agents', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  model: text('model').notNull(),
  harness: text('harness').default('langgraph'),
  modelConfig: text('model_config'),
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
  a2uiPayload: jsonb('a2ui_payload').$type<Record<string, unknown>>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  conversationCreatedIdx: index('idx_messages_conversation_created').on(table.conversationId, table.createdAt),
}));

export const knowledgeItems = pgTable('knowledge_items', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull(),
  content: text('content').notNull(),
  category: text('category').notNull(),
  source: text('source').notNull(),
  effectiveness: doublePrecision('effectiveness').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentCategoryIdx: index('idx_knowledge_items_agent_category').on(table.agentId, table.category),
}));

export const executionTraces = pgTable('execution_traces', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull(),
  runId: text('run_id').notNull(),
  taskDescription: text('task_description').notNull(),
  steps: jsonb('steps').notNull().$type<unknown[]>(),
  startedAt: bigint('started_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  completedAt: bigint('completed_at', { mode: 'number' }),
  outcome: text('outcome'),
}, (table) => ({
  agentStartedIdx: index('idx_execution_traces_agent_started').on(table.agentId, table.startedAt),
}));

export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id),
  conversationId: text('conversation_id').references(() => conversations.id),
  status: text('status').notNull().default('queued'),
  mode: text('mode').notNull().default('interactive'),
  taskDescription: text('task_description'),
  startedAt: bigint('started_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  completedAt: bigint('completed_at', { mode: 'number' }),
  error: text('error'),
  sessionDir: text('session_dir'),
}, (table) => ({
  agentStartedIdx: index('idx_agent_runs_agent_started').on(table.agentId, table.startedAt),
}));

export const eventStore = pgTable('event_store', {
  seq: serial('seq').primaryKey(),
  type: text('type').notNull(),
  agentId: text('agent_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentSeqIdx: index('idx_event_store_agent_seq').on(table.agentId, table.seq),
}));

export const suspendedRuns = pgTable('suspended_runs', {
  id: text('id').primaryKey(),
  agentRunId: text('agent_run_id').notNull(),
  agentId: text('agent_id').notNull(),
  waitEventType: text('wait_event_type').notNull(),
  waitSelector: text('wait_selector').notNull(),
  waitExpiresAt: bigint('wait_expires_at', { mode: 'number' }),
  snapshotState: text('snapshot_state').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  eventTypeIdx: index('idx_suspended_runs_event_type').on(table.waitEventType),
  agentIdx: index('idx_suspended_runs_agent').on(table.agentId),
  expiresIdx: index('idx_suspended_runs_expires').on(table.waitExpiresAt),
}));

export const scheduledEvents = pgTable('scheduled_events', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
  wakeAt: bigint('wake_at', { mode: 'number' }).notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  wakeIdx: index('idx_scheduled_events_wake').on(table.status, table.wakeAt),
}));

export const eventTriggers = pgTable('event_triggers', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  selector: jsonb('selector').$type<Record<string, unknown> | null>(),
  taskTemplate: text('task_template').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  agentIdx: index('idx_event_triggers_agent').on(table.agentId),
  eventTypeIdx: index('idx_event_triggers_event_type').on(table.eventType),
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
  agentVersionIdx: index('idx_agent_versions_agent_version').on(table.agentId, table.version),
}));

export const feedbackSignals = pgTable('feedback_signals', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  traceId: text('trace_id').notNull(),
  agentId: text('agent_id').notNull(),
  source: text('source').notNull(),
  type: text('type').notNull(),
  value: jsonb('value').notNull().$type<Record<string, unknown>>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentCreatedIdx: index('idx_feedback_signals_agent_created').on(table.agentId, table.createdAt),
}));
