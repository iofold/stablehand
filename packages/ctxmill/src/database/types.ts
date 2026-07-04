import * as pgSchema from './schema-pg.js';
import type { ApiSessionStatus } from '@ctxmill/shared';

export type AgentInsert = typeof pgSchema.agents.$inferInsert;
export type AgentSelect = typeof pgSchema.agents.$inferSelect;
export type ConversationSelect = typeof pgSchema.conversations.$inferSelect;
export type MessageInsert = typeof pgSchema.messages.$inferInsert;
export type MessageSelect = typeof pgSchema.messages.$inferSelect;
export type TurnStatus = pgSchema.TurnStatus;
export type TurnInsert = typeof pgSchema.turns.$inferInsert;
export type TurnSelect = typeof pgSchema.turns.$inferSelect;
export type SuspendedSessionInsert = typeof pgSchema.suspendedSessions.$inferInsert;
export type SuspendedSessionRow = typeof pgSchema.suspendedSessions.$inferSelect;
export type ScheduledEventRow = typeof pgSchema.scheduledEvents.$inferSelect;
type TriggerInsertBase = typeof pgSchema.eventTriggers.$inferInsert;
export type TriggerInsert = Omit<TriggerInsertBase, 'selectorHash'> & { selectorHash?: string };
export type TriggerSelect = typeof pgSchema.eventTriggers.$inferSelect;
export type VersionSelect = typeof pgSchema.agentVersions.$inferSelect;
export type InterruptInsert = typeof pgSchema.pendingInterrupts.$inferInsert;
export type InterruptRow = typeof pgSchema.pendingInterrupts.$inferSelect;
export type InterruptResumeAttemptInsert = typeof pgSchema.interruptResumeAttempts.$inferInsert;
export type InterruptResumeAttemptRow = typeof pgSchema.interruptResumeAttempts.$inferSelect;
export type CallbackOutboxInsert = typeof pgSchema.callbackOutbox.$inferInsert;
export type CallbackOutboxRow = typeof pgSchema.callbackOutbox.$inferSelect;
export type WebhookInsert = typeof pgSchema.webhooks.$inferInsert;
export type WebhookRow = typeof pgSchema.webhooks.$inferSelect;
export type SandboxSessionRow = Omit<
  typeof pgSchema.sandboxSessions.$inferSelect,
  'restoreAttempts' | 'lastRestoreError'
> & {
  restoreAttempts?: number | null;
  lastRestoreError?: string | null;
};
export type SystemSettingRow = typeof pgSchema.systemSettings.$inferSelect;
export type EventFrameRow = typeof pgSchema.eventStore.$inferSelect;
/** Canonical frame batch-insert shape (ADR-015); payload is pre-serialized JSON. */
export interface EventFrameInsert {
  type: string;
  agentId: string;
  payload: string;
  turnId?: string | null;
  conversationId?: string | null;
  channel?: 'run' | 'custom' | 'system';
}
export type ArtifactInsert = typeof pgSchema.artifacts.$inferInsert;
export type ArtifactRow = typeof pgSchema.artifacts.$inferSelect;

export interface CheckpointV2 {
  id: string;
  sessionId: string;
  agentId: string;
  checkpointVersion: number;
  checkpointData: Record<string, unknown>;
  harnessState: Record<string, unknown> | null;
  workspaceRef: string | null;
  suspendReason: string | null;
  createdAt: number;
}

export interface ConversationSummaryRow {
  id: string;
  agentId: string;
  status: ApiSessionStatus;
  mode: string;
  turnCount: number;
  messageCount: number;
  taskDescription: string | null;
  startedAt: number;
  updatedAt: number;
  latestTurnId: string | null;
  sandboxSessionId: string | null;
}
