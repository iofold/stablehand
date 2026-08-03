import * as pgSchema from './schema-pg.js';
import type { ApiConversationStatus } from '@ctxmill/shared';

export type AgentInsert = typeof pgSchema.agents.$inferInsert;
export type AgentSelect = typeof pgSchema.agents.$inferSelect;
export type AgentWorkspaceStateRow = typeof pgSchema.agentWorkspaceState.$inferSelect;
export type ConversationSelect = typeof pgSchema.conversations.$inferSelect;
export type MessageInsert = typeof pgSchema.messages.$inferInsert;
export type MessageSelect = typeof pgSchema.messages.$inferSelect;
export type TurnStatus = pgSchema.TurnStatus;
export type SandboxSessionLifecycleOperation =
  pgSchema.SandboxSessionLifecycleOperation;
export type SandboxSessionLifecyclePhase =
  pgSchema.SandboxSessionLifecyclePhase;
export type TurnInsert = typeof pgSchema.turns.$inferInsert;
export type TurnSelect = typeof pgSchema.turns.$inferSelect;
export type ModelCallUsageRow = typeof pgSchema.modelCallUsage.$inferSelect;
export type ModelCallAttemptUsageRow =
  typeof pgSchema.modelCallAttemptUsage.$inferSelect;
export type ModelGatewayReconciliationStateRow =
  typeof pgSchema.modelGatewayReconciliationState.$inferSelect;
export type ModelGatewaySpendQuarantineRow =
  typeof pgSchema.modelGatewaySpendQuarantine.$inferSelect;
export type TurnSecretEnvelopeInsert =
  Omit<typeof pgSchema.turnSecretEnvelopes.$inferInsert, 'turnId' | 'createdAt'>;
export type TurnSecretEnvelopeRow = typeof pgSchema.turnSecretEnvelopes.$inferSelect;
export type TurnStartRequestInsert = typeof pgSchema.turnStartRequests.$inferInsert;
export type TurnStartRequestRow = typeof pgSchema.turnStartRequests.$inferSelect;
export type TurnDeliveryLeaseRow = typeof pgSchema.turnDeliveryLeases.$inferSelect;
export type SandboxSessionLifecycleOperationRow =
  typeof pgSchema.sandboxSessionLifecycleOperations.$inferSelect;
type TriggerInsertBase = typeof pgSchema.eventTriggers.$inferInsert;
export type TriggerInsert = Omit<TriggerInsertBase, 'selectorHash'> & { selectorHash?: string };
export type TriggerSelect = typeof pgSchema.eventTriggers.$inferSelect;
export type SpineCursorRow = typeof pgSchema.spineCursors.$inferSelect;
export type TriggerFiringRow = typeof pgSchema.triggerFirings.$inferSelect;
export type ScheduleInsert = typeof pgSchema.schedules.$inferInsert;
export type ScheduleRow = typeof pgSchema.schedules.$inferSelect;
export type InterruptInsert = typeof pgSchema.pendingInterrupts.$inferInsert;
export type InterruptRow = typeof pgSchema.pendingInterrupts.$inferSelect;
export type InterruptResumeAttemptInsert = typeof pgSchema.interruptResumeAttempts.$inferInsert;
export type InterruptResumeAttemptRow = typeof pgSchema.interruptResumeAttempts.$inferSelect;
export type CallbackOutboxInsert = typeof pgSchema.callbackOutbox.$inferInsert;
export type CallbackOutboxRow = typeof pgSchema.callbackOutbox.$inferSelect;
export type WebhookInsert = typeof pgSchema.webhooks.$inferInsert;
export type WebhookRow = typeof pgSchema.webhooks.$inferSelect;
export type ApiKeyInsert = typeof pgSchema.apiKeys.$inferInsert;
export type ApiKeyRow = typeof pgSchema.apiKeys.$inferSelect;
export type BudgetPolicyInsert = typeof pgSchema.budgetPolicies.$inferInsert;
export type BudgetPolicyRow = typeof pgSchema.budgetPolicies.$inferSelect;
export type SandboxSessionRow = Omit<
  typeof pgSchema.sandboxSessions.$inferSelect,
  'restoreAttempts' | 'lastRestoreError' | 'runtimeDefinitionHash'
> & {
  restoreAttempts?: number | null;
  lastRestoreError?: string | null;
  runtimeDefinitionHash?: string | null;
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
  sourceType?: string | null;
  sourcePayload?: string | null;
}
export type ArtifactInsert = typeof pgSchema.artifacts.$inferInsert;
export type ArtifactRow = typeof pgSchema.artifacts.$inferSelect;

export type CheckpointV2 = typeof pgSchema.agentCheckpoints.$inferSelect;

export interface ConversationSummaryRow {
  id: string;
  agentId: string;
  status: ApiConversationStatus;
  mode: string;
  turnCount: number;
  messageCount: number;
  taskDescription: string | null;
  startedAt: number;
  completedAt: number | null;
  updatedAt: number;
  latestTurnId: string | null;
  sandboxSessionId: string | null;
  /** Sum of harness-reported tokens across the conversation's turns; null when none reported. */
  totalTokens: number | null;
  /** Sum of known cost across turns; null when no turn carries any cost data. */
  knownCostUsd: number | null;
  /** Turns whose cost coverage is not yet complete (pending, partial, or unpriced). */
  incompleteCostTurnCount: number;
  /** Budget-attribution tags fixed at conversation creation (caller + agent defaults). */
  tags: Record<string, string>;
}
