import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  model: text('model').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  tools: text('tools', { mode: 'json' }).notNull().$type<string[]>(),
  description: text('description'),
  status: text('status').notNull().default('created'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Date.now()),
});

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentUpdatedIdx: index('idx_conversations_agent_updated').on(table.agentId, table.updatedAt),
}));

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  agentId: text('agent_id'),
  role: text('role').notNull(),
  content: text('content').notNull(),
  toolCallId: text('tool_call_id'),
  toolCalls: text('tool_calls', { mode: 'json' }).$type<unknown[]>(),
  a2uiPayload: text('a2ui_payload', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  conversationCreatedIdx: index('idx_messages_conversation_created').on(table.conversationId, table.createdAt),
}));

export const knowledgeItems = sqliteTable('knowledge_items', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull(),
  content: text('content').notNull(),
  category: text('category').notNull(),
  source: text('source').notNull(),
  effectiveness: real('effectiveness').notNull().default(0),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentCategoryIdx: index('idx_knowledge_items_agent_category').on(table.agentId, table.category),
}));

export const executionTraces = sqliteTable('execution_traces', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull(),
  runId: text('run_id').notNull(),
  taskDescription: text('task_description').notNull(),
  steps: text('steps', { mode: 'json' }).notNull().$type<unknown[]>(),
  startedAt: integer('started_at').notNull().$defaultFn(() => Date.now()),
  completedAt: integer('completed_at'),
  outcome: text('outcome'),
}, (table) => ({
  agentStartedIdx: index('idx_execution_traces_agent_started').on(table.agentId, table.startedAt),
}));

export const agentRuns = sqliteTable('agent_runs', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  agentId: text('agent_id').notNull().references(() => agents.id),
  conversationId: text('conversation_id').references(() => conversations.id),
  status: text('status').notNull().default('queued'),
  mode: text('mode').notNull().default('interactive'),
  taskDescription: text('task_description'),
  startedAt: integer('started_at').notNull().$defaultFn(() => Date.now()),
  completedAt: integer('completed_at'),
  error: text('error'),
}, (table) => ({
  agentStartedIdx: index('idx_agent_runs_agent_started').on(table.agentId, table.startedAt),
}));

export const feedbackSignals = sqliteTable('feedback_signals', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  traceId: text('trace_id').notNull(),
  agentId: text('agent_id').notNull(),
  source: text('source').notNull(),
  type: text('type').notNull(),
  value: text('value', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => ({
  agentCreatedIdx: index('idx_feedback_signals_agent_created').on(table.agentId, table.createdAt),
}));
