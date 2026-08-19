import { eq, sql, gt, gte, lt, lte, and, or, desc, asc, inArray, isNotNull, isNull, ilike, type SQL } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DrizzleDb } from './connection.js';
import * as pgSchema from './schema-pg.js';
import { sanitizeDbJsonValue, sanitizeDbText, sanitizeDbValue } from '../util/sanitize.js';
import { isUniqueConstraintViolation } from './errors.js';
import {
  SANDBOX_SESSION_STATUSES,
  projectConversationStatus,
  type ApiSandboxSessionStatusCounts,
  type SandboxSessionStatus,
} from '@ctxmill/shared';
import type {
  AnalyticsActivityBucket,
  AnalyticsMetrics,
  TurnUsage,
} from '@ctxmill/contracts';
import type {
  InvalidLiteLLMSpendRecord,
  LiteLLMSpendRecord,
} from '../cost-control/litellm-spend-client.js';
import { projectGatewayTurnUsage } from '../cost-control/gateway-usage-projection.js';

import type {
  AgentInsert,
  AgentSelect,
  AgentWorkspaceStateRow,
  ArtifactInsert,
  ArtifactRow,
  CallbackOutboxInsert,
  CallbackOutboxRow,
  CheckpointV2,
  ConversationSelect,
  ConversationSummaryRow,
  EventFrameInsert,
  EventFrameRow,
  InterruptInsert,
  InterruptResumeAttemptRow,
  InterruptRow,
  MessageInsert,
  MessageSelect,
  SandboxSessionLifecycleOperation,
  SandboxSessionLifecycleOperationRow,
  SandboxSessionRow,
  ScheduleInsert,
  ScheduleRow,
  SystemSettingRow,
  SpineCursorRow,
  TriggerFiringRow,
  TriggerInsert,
  TriggerSelect,
  TurnInsert,
  TurnSecretEnvelopeInsert,
  TurnSecretEnvelopeRow,
  TurnDeliveryLeaseRow,
  TurnSelect,
  TurnStartRequestInsert,
  TurnStartRequestRow,
  TurnStatus,
  WebhookInsert,
  WebhookRow,
  ApiKeyRow,
  BudgetPolicyRow,
} from './types.js';

export type {
  AgentWorkspaceStateRow,
  CallbackOutboxRow,
  CheckpointV2,
  ConversationSummaryRow,
  EventFrameInsert,
  EventFrameRow,
  InterruptResumeAttemptRow,
  InterruptRow,
  SandboxSessionLifecycleOperation,
  SandboxSessionLifecycleOperationRow,
  SandboxSessionRow,
  ScheduleRow,
  SpineCursorRow,
  SystemSettingRow,
  TurnStartRequestRow,
  TurnDeliveryLeaseRow,
  TurnSecretEnvelopeRow,
  TriggerFiringRow,
  WebhookRow,
} from './types.js';

export interface AnalyticsAgentRow extends AnalyticsMetrics {
  agentId: string;
  name: string;
  harness: string;
  harnessConfig: string;
  lastActivityAt: number | null;
}

export interface AnalyticsSnapshot {
  activity: AnalyticsActivityBucket[];
  agents: AnalyticsAgentRow[];
}

const sanitizeTypedDbValue = <T>(value: T, context: string): T => sanitizeDbValue(value, context) as T;
const DEFAULT_CLAIM_LEASE_MS = 60_000;
/** Quarantined gateway spend rows not re-seen for this long are dropped. */
const MODEL_GATEWAY_QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CALLBACK_EVENT_SEQ_DEDUPE_INDEX = 'idx_outbox_callback_event_seq';
const LIVE_SANDBOX_SESSION_INDEX = 'idx_sandbox_sessions_conversation_live';
const RUNNING_CONVERSATION_TURN_INDEX = 'idx_turns_conversation_running';
const STALE_SANDBOX_CALLBACK_DELIVERY = Symbol(
  'stale-sandbox-callback-delivery',
);
const SANDBOX_SESSION_STATUS_SET: ReadonlySet<string> = new Set(
  SANDBOX_SESSION_STATUSES,
);
export type ResolveInterruptWithResumeAttemptResult =
  | {
      kind: 'ready';
      interrupt: InterruptRow;
      resumeAttempt?: InterruptResumeAttemptRow;
    }
  | {
      kind: 'conflict';
      interrupt: InterruptRow;
    };

export interface ExpectedTurnDeliveryFence {
  ownerId: string;
  fenceToken: number;
}

export interface AdmittedTurnDeliveryCapabilityClaims {
  turnId: string;
  sandboxSessionId: string;
  agentId: string;
  conversationId: string;
  ownerId: string;
  fenceToken: number;
  leaseExpiresAtMs: number;
  restoreFenceToken: number;
  containerId: string | null;
}

export interface SandboxSessionLifecycleFence {
  ownerId: string;
  fenceToken: number;
}

export interface SandboxSessionActiveGeneration {
  restoreFenceToken: number;
  containerId: string | null;
}

export interface ExpectedSandboxCallbackGeneration {
  sandboxSessionId: string;
  expectedActiveGeneration: SandboxSessionActiveGeneration;
}

export interface ExpectedSandboxCallbackDelivery
  extends ExpectedSandboxCallbackGeneration {
  turnId: string;
  agentId: string;
  expectedDeliveryFence: ExpectedTurnDeliveryFence;
}

export interface SandboxSessionRestoreFence {
  ownerId: string;
  fenceToken: number;
}

export interface ReconciledSandboxSessionRestore {
  session: SandboxSessionRow;
  outcome: 'CHECKPOINTED' | 'TERMINATED';
}

type CanonicalMessageInsert = Omit<
  MessageInsert,
  'messageSeq' | 'messageRevision' | 'publishedRevision'
> & {
  turnId: string;
  role: 'assistant' | 'tool';
};

type RepositoryTransaction =
  Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export class SandboxSessionStatusConflictError extends Error {
  constructor(
    readonly sandboxSessionId: string,
    readonly expectedFrom: string,
    readonly toStatus: string,
  ) {
    super(`Sandbox session ${sandboxSessionId} status was not ${expectedFrom}; could not transition to ${toStatus}`);
    this.name = 'SandboxSessionStatusConflictError';
  }
}

/**
 * ctx-xrrc: xact-scoped advisory-lock key serializing the turn-queue cap
 * count+insert. Distinct from MIGRATION_ADVISORY_LOCK_ID (424242).
 */
export const TURN_QUEUE_ADMISSION_LOCK_ID = 424243;

/** ctx-eu6a: retry budget for interrupt resume attempts and its backoff step. */
export const MAX_INTERRUPT_RESUME_ATTEMPTS = 3;
export const INTERRUPT_RESUME_BACKOFF_STEP_MS = 15_000;

/**
 * Thrown by createTurnWithSecretEnvelope when the authoritative in-transaction
 * queue-cap check rejects a queued turn (the race the pre-insert admission
 * fast-path cannot catch). The orchestrator maps this to a 429 QueueFullError.
 */
export class QueueCapExceededError extends Error {
  constructor(
    readonly scope: 'global' | 'agent',
    readonly agentId: string,
    readonly queued: number,
    readonly limit: number,
  ) {
    super(`Turn queue ${scope} cap exceeded (${queued}/${limit} queued turns)`);
    this.name = 'QueueCapExceededError';
  }
}

export class LiveSandboxSessionConflictError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} already has an ACTIVE or RESTORING sandbox session`);
    this.name = 'LiveSandboxSessionConflictError';
  }
}

const sanitizeOptionalDbText = <T extends string | null | undefined>(value: T, context: string): T => {
  if (value == null) return value;
  return sanitizeDbText(value, context) as T;
};

function validateTurnDeliveryFenceToken(fenceToken: number, context: string): number {
  if (!Number.isSafeInteger(fenceToken) || fenceToken < 1) {
    throw new Error(`${context} must be a positive safe integer`);
  }
  return fenceToken;
}

function validatePositiveSafeInteger(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${context} must be a positive safe integer`);
  }
  return value;
}

function validateNonNegativeSafeInteger(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} must be a non-negative safe integer`);
  }
  return value;
}

function validateLeaseDurationMs(leaseDurationMs: number, context: string): number {
  return validatePositiveSafeInteger(leaseDurationMs, context);
}

const SANDBOX_SESSION_LIFECYCLE_OPERATIONS:
  ReadonlySet<SandboxSessionLifecycleOperation> = new Set([
    'checkpoint',
    'terminate',
    'reset',
    'adopt',
  ]);

function validateSandboxSessionLifecycleOperation(
  operation: string,
): SandboxSessionLifecycleOperation {
  if (!SANDBOX_SESSION_LIFECYCLE_OPERATIONS.has(
    operation as SandboxSessionLifecycleOperation,
  )) {
    throw new Error(`Unsupported sandbox session lifecycle operation: ${operation}`);
  }
  return operation as SandboxSessionLifecycleOperation;
}

function validateSandboxSessionStatus(
  status: string,
  context: string,
): SandboxSessionStatus {
  const sanitizedStatus = sanitizeDbText(status, context);
  if (!SANDBOX_SESSION_STATUS_SET.has(sanitizedStatus)) {
    throw new Error(`Unsupported sandbox session status: ${sanitizedStatus}`);
  }
  return sanitizedStatus as SandboxSessionStatus;
}

function databaseClockMs(): SQL<number> {
  return sql<number>`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`;
}

function parseDatabaseClockMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Database clock returned invalid epoch milliseconds: ${String(value)}`);
  }
  return parsed;
}

function eventBatchAgentId(frames: EventFrameInsert[]): string {
  const agentIds = new Set(frames.map((frame) => frame.agentId));
  if (agentIds.size !== 1) {
    throw new Error('Canonical event batches must contain exactly one agent');
  }
  return sanitizeDbText(frames[0]!.agentId, 'eventStore.agentId');
}

function eventBatchTurnId(frames: EventFrameInsert[]): string {
  const turnIds = new Set(frames.map((frame) => frame.turnId));
  if (turnIds.size !== 1 || frames[0]!.turnId == null) {
    throw new Error('Fenced canonical event batches must contain exactly one turn');
  }
  return sanitizeDbText(frames[0]!.turnId, 'eventStore.turnId');
}

function normalizeTriggerSelector(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeTriggerSelector(entry));
  }
  if (typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length === 0) return null;

  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    normalized[key] = normalizeTriggerSelector(record[key]);
  }
  return normalized;
}

function triggerSelectorHash(selector: Record<string, unknown> | null | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeTriggerSelector(selector)))
    .digest('hex');
}

export class DatabaseRepository {
  private db: DrizzleDb;
  private schema = pgSchema;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  private async insertOne<T>(query: PromiseLike<T[]>, context: string): Promise<T> {
    const [row] = await query;
    if (!row) {
      throw new Error(`Expected ${context} insert to return a row but got undefined`);
    }
    return row;
  }

  /**
   * A reserved reset may temporarily whitelist the one delivery it is
   * fencing so that worker can persist its terminal state. No delivery is
   * admitted once lifecycle execution begins.
   */
  private deliveryAdmittedByLifecycleOperation(): SQL<boolean> {
    return sql<boolean>`NOT EXISTS (
      SELECT 1
      FROM ${this.schema.sandboxSessionLifecycleOperations}
      WHERE ${this.schema.sandboxSessionLifecycleOperations.sandboxSessionId}
        = ${this.schema.turns.sandboxSessionId}
        AND ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'completed'
        AND (
          ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'reserved'
          OR ${this.schema.sandboxSessionLifecycleOperations.allowedTurnId}
            IS DISTINCT FROM ${this.schema.turns.id}
          OR ${this.schema.sandboxSessionLifecycleOperations.allowedDeliveryOwnerId}
            IS DISTINCT FROM ${this.schema.turns.deliveryOwnerId}
          OR ${this.schema.sandboxSessionLifecycleOperations.allowedDeliveryFenceToken}
            IS DISTINCT FROM ${this.schema.turns.deliveryFenceToken}
        )
    )`;
  }

  /**
   * Lock and verify a delivery owner inside its caller's transaction.
   *
   * Lock order is agent event head (when publishing) -> turn -> delivery
   * lease -> message. State-only mutations start at the turn. Claim,
   * activation, finalization, and delivery writes therefore share the same
   * turn-before-lease ordering and cannot deadlock one another.
   */
  private async lockCurrentDeliveryFence(
    tx: RepositoryTransaction,
    turnId: string,
    expectedDeliveryFence: ExpectedTurnDeliveryFence,
    context: string,
  ): Promise<boolean> {
    const sanitizedTurnId = sanitizeDbText(turnId, `${context}.turnId`);
    const ownerId = sanitizeDbText(
      expectedDeliveryFence.ownerId,
      `${context}.ownerId`,
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      expectedDeliveryFence.fenceToken,
      `${context}.fenceToken`,
    );
    const rowFenceCondition = and(
      eq(this.schema.turns.deliveryOwnerId, ownerId),
      eq(this.schema.turns.deliveryFenceToken, fenceToken),
    );
    const [turn] = await tx
      .select({ turnId: this.schema.turns.id })
      .from(this.schema.turns)
      .where(and(
        eq(this.schema.turns.id, sanitizedTurnId),
        isNull(this.schema.turns.completedAt),
        rowFenceCondition,
        this.deliveryAdmittedByLifecycleOperation(),
        or(
          isNull(this.schema.turns.sandboxSessionId),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM ${this.schema.sandboxSessions}
            WHERE ${this.schema.sandboxSessions.id} = ${this.schema.turns.sandboxSessionId}
              AND ${this.schema.sandboxSessions.status} = 'ACTIVE'
          )`,
        ),
      ))
      .for('update');
    if (!turn) {
      return false;
    }

    const [lease] = await tx
      .select({
        leaseExpiresAt: this.schema.turnDeliveryLeases.leaseExpiresAt,
      })
      .from(this.schema.turnDeliveryLeases)
      .where(and(
        eq(this.schema.turnDeliveryLeases.turnId, sanitizedTurnId),
        eq(this.schema.turnDeliveryLeases.ownerId, ownerId),
        eq(this.schema.turnDeliveryLeases.fenceToken, fenceToken),
        gt(this.schema.turnDeliveryLeases.leaseExpiresAt, databaseClockMs()),
      ))
      .for('update');
    return lease !== undefined;
  }

  private async lockExactSandboxCallbackDelivery(
    tx: RepositoryTransaction,
    input: ExpectedSandboxCallbackDelivery,
    context: string,
  ): Promise<{ conversationId: string } | undefined> {
    const turnId = sanitizeDbText(input.turnId, `${context}.turnId`);
    const sandboxSessionId = sanitizeDbText(
      input.sandboxSessionId,
      `${context}.sandboxSessionId`,
    );
    const agentId = sanitizeDbText(input.agentId, `${context}.agentId`);
    const ownerId = sanitizeDbText(
      input.expectedDeliveryFence.ownerId,
      `${context}.ownerId`,
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      input.expectedDeliveryFence.fenceToken,
      `${context}.fenceToken`,
    );
    if (!input.expectedActiveGeneration) {
      throw new Error(`${context}.expectedActiveGeneration is required`);
    }
    const restoreFenceToken = validateNonNegativeSafeInteger(
      input.expectedActiveGeneration.restoreFenceToken,
      `${context}.restoreFenceToken`,
    );
    if (
      input.expectedActiveGeneration.containerId !== null
      && typeof input.expectedActiveGeneration.containerId !== 'string'
    ) {
      throw new Error(`${context}.containerId must be a string or null`);
    }
    const containerId =
      input.expectedActiveGeneration.containerId === null
        ? null
        : sanitizeDbText(
            input.expectedActiveGeneration.containerId,
            `${context}.containerId`,
          );

    // Callback mutations use session -> turn -> lease. Lifecycle and restore
    // transitions lock the same session row first, so a generation change
    // either commits before admission (and is rejected) or waits until the
    // callback mutation has committed under the still-current generation.
    const [session] = await tx
      .select({
        conversationId: this.schema.sandboxSessions.conversationId,
      })
      .from(this.schema.sandboxSessions)
      .where(and(
        eq(this.schema.sandboxSessions.id, sandboxSessionId),
        eq(this.schema.sandboxSessions.agentId, agentId),
        eq(this.schema.sandboxSessions.status, 'ACTIVE'),
        eq(
          this.schema.sandboxSessions.restoreFenceToken,
          restoreFenceToken,
        ),
        containerId === null
          ? isNull(this.schema.sandboxSessions.containerId)
          : eq(this.schema.sandboxSessions.containerId, containerId),
      ))
      .for('update');
    if (!session) {
      return undefined;
    }

    const [turn] = await tx
      .select({
        conversationId: this.schema.turns.conversationId,
      })
      .from(this.schema.turns)
      .where(and(
        eq(this.schema.turns.id, turnId),
        eq(this.schema.turns.sandboxSessionId, sandboxSessionId),
        eq(this.schema.turns.agentId, agentId),
        eq(this.schema.turns.conversationId, session.conversationId),
        eq(this.schema.turns.status, 'running'),
        isNull(this.schema.turns.completedAt),
        isNotNull(this.schema.turns.conversationId),
        eq(this.schema.turns.deliveryOwnerId, ownerId),
        eq(this.schema.turns.deliveryFenceToken, fenceToken),
        this.deliveryAdmittedByLifecycleOperation(),
      ))
      .for('update');
    if (!turn?.conversationId) {
      return undefined;
    }

    const [lease] = await tx
      .select({ turnId: this.schema.turnDeliveryLeases.turnId })
      .from(this.schema.turnDeliveryLeases)
      .where(and(
        eq(this.schema.turnDeliveryLeases.turnId, turnId),
        eq(this.schema.turnDeliveryLeases.ownerId, ownerId),
        eq(this.schema.turnDeliveryLeases.fenceToken, fenceToken),
        gt(this.schema.turnDeliveryLeases.leaseExpiresAt, databaseClockMs()),
      ))
      .for('update');
    return lease
      ? { conversationId: turn.conversationId }
      : undefined;
  }

  // ── Agents ──────────────────────────────────────────────

  async createAgent(data: AgentInsert): Promise<AgentSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'agents.insert');
    return this.insertOne(
      this.db.insert(this.schema.agents).values(sanitizedData).returning(),
      'agent',
    );
  }

  async getAgent(id: string): Promise<AgentSelect | undefined> {
    return this.db.query.agents.findFirst({
      where: eq(this.schema.agents.id, id),
    });
  }

  async getAgentWorkspaceState(agentId: string): Promise<AgentWorkspaceStateRow | undefined> {
    return this.db.query.agentWorkspaceState.findFirst({
      where: eq(this.schema.agentWorkspaceState.agentId, agentId),
    });
  }

  async recordAgentWorkspaceRevision(
    agentId: string,
    state: {
      sha256: string;
      fileCount: number;
      totalBytes: number;
      appliedAt: number;
    },
  ): Promise<AgentWorkspaceStateRow> {
    const sanitizedAgentId = sanitizeDbText(agentId, 'agentWorkspaceState.agentId');
    const sanitizedState = sanitizeTypedDbValue(state, 'agentWorkspaceState.upsert');
    const [row] = await this.db
      .insert(this.schema.agentWorkspaceState)
      .values({
        agentId: sanitizedAgentId,
        revision: 1,
        ...sanitizedState,
      })
      .onConflictDoUpdate({
        target: this.schema.agentWorkspaceState.agentId,
        set: {
          revision: sql<number>`${this.schema.agentWorkspaceState.revision} + 1`,
          ...sanitizedState,
        },
      })
      .returning();
    if (!row) {
      throw new Error('Expected workspace revision upsert to return a row but got undefined');
    }
    return row;
  }

  async listAgents(): Promise<AgentSelect[]> {
    return this.db.query.agents.findMany();
  }

  /**
   * Bounded operational analytics for the dashboard. This deliberately
   * returns aggregate rows rather than exposing raw turn history to the UI.
   */
  async getAnalyticsSnapshot(input: {
    from: number;
    to: number;
    bucketSizeMs: number;
  }): Promise<AnalyticsSnapshot> {
    const { from, to, bucketSizeMs } = input;
    if (
      !Number.isSafeInteger(from)
      || from < 0
      || !Number.isSafeInteger(to)
      || to <= from
      || !Number.isSafeInteger(bucketSizeMs)
      || bucketSizeMs <= 0
    ) {
      throw new Error('Invalid analytics range');
    }
    const bucketCount = Math.ceil((to - from) / bucketSizeMs);
    if (bucketCount > 720) {
      throw new Error('Analytics range exceeds 720 buckets');
    }

    const costCoverage = this.turnCostCoverageSql();
    const knownCost = sql<number>`
      CASE
        WHEN ${this.schema.turns.usage} IS NOT NULL THEN
          COALESCE((${this.schema.turns.usage} #>> '{cost,knownUsd}')::float8, 0)
        ELSE COALESCE(${this.schema.turns.costUsd}, 0)
      END
    `;
    const joinedTurn = and(
      eq(this.schema.turns.agentId, this.schema.agents.id),
      sql`${this.schema.turns.startedAt} >= ${from}`,
      sql`${this.schema.turns.startedAt} < ${to}`,
    );

    const agentRows = await this.db
      .select({
        agentId: this.schema.agents.id,
        name: this.schema.agents.name,
        harness: this.schema.agents.harness,
        harnessConfig: this.schema.agents.harnessConfig,
        lastActivityAt: sql<number | null>`
          max(coalesce(${this.schema.turns.completedAt}, ${this.schema.turns.startedAt}))::float8
        `,
        turns: sql<number>`count(${this.schema.turns.id})::int`,
        completedTurns: sql<number>`
          count(${this.schema.turns.id}) FILTER (
            WHERE ${this.schema.turns.status} = 'completed'
          )::int
        `,
        errorTurns: sql<number>`
          count(${this.schema.turns.id}) FILTER (
            WHERE ${this.schema.turns.status} = 'error'
          )::int
        `,
        cancelledTurns: sql<number>`
          count(${this.schema.turns.id}) FILTER (
            WHERE ${this.schema.turns.status} = 'cancelled'
          )::int
        `,
        activeTurns: sql<number>`
          count(${this.schema.turns.id}) FILTER (
            WHERE ${this.schema.turns.status} IN ('queued', 'running')
          )::int
        `,
        inputTokens: sql<number>`
          coalesce(sum(${this.schema.turns.inputTokens}), 0)::float8
        `,
        outputTokens: sql<number>`
          coalesce(sum(${this.schema.turns.outputTokens}), 0)::float8
        `,
        totalTokens: sql<number>`
          coalesce(sum(${this.schema.turns.totalTokens}), 0)::float8
        `,
        tokenReportedTurns: sql<number>`
          count(${this.schema.turns.totalTokens})::int
        `,
        knownCostUsd: sql<number>`
          coalesce(sum(${knownCost}) FILTER (
            WHERE ${this.schema.turns.id} IS NOT NULL
          ), 0)::float8
        `,
        coverageComplete: sql<number>`
          count(${this.schema.turns.id}) FILTER (
            WHERE ${costCoverage} = 'complete'
          )::int
        `,
        coveragePartial: sql<number>`
          count(${this.schema.turns.id}) FILTER (
            WHERE ${costCoverage} = 'partial'
          )::int
        `,
        coveragePending: sql<number>`
          count(${this.schema.turns.id}) FILTER (
            WHERE ${costCoverage} = 'pending'
          )::int
        `,
        coverageUnpriced: sql<number>`
          count(${this.schema.turns.id}) FILTER (
            WHERE ${costCoverage} = 'unpriced'
          )::int
        `,
      })
      .from(this.schema.agents)
      .leftJoin(this.schema.turns, joinedTurn)
      .groupBy(
        this.schema.agents.id,
        this.schema.agents.name,
        this.schema.agents.harness,
        this.schema.agents.harnessConfig,
      );

    const bucketRows = await this.db
      .select({
        bucket: sql<number>`
          floor((${this.schema.turns.startedAt} - ${from})::float8 / ${bucketSizeMs})::int
        `.as('bucket'),
        turns: sql<number>`count(*)::int`,
        completedTurns: sql<number>`
          count(*) FILTER (WHERE ${this.schema.turns.status} = 'completed')::int
        `,
        errorTurns: sql<number>`
          count(*) FILTER (WHERE ${this.schema.turns.status} = 'error')::int
        `,
        cancelledTurns: sql<number>`
          count(*) FILTER (WHERE ${this.schema.turns.status} = 'cancelled')::int
        `,
        activeTurns: sql<number>`
          count(*) FILTER (
            WHERE ${this.schema.turns.status} IN ('queued', 'running')
          )::int
        `,
        inputTokens: sql<number>`
          coalesce(sum(${this.schema.turns.inputTokens}), 0)::float8
        `,
        outputTokens: sql<number>`
          coalesce(sum(${this.schema.turns.outputTokens}), 0)::float8
        `,
        totalTokens: sql<number>`
          coalesce(sum(${this.schema.turns.totalTokens}), 0)::float8
        `,
        tokenReportedTurns: sql<number>`
          count(${this.schema.turns.totalTokens})::int
        `,
        knownCostUsd: sql<number>`coalesce(sum(${knownCost}), 0)::float8`,
        coverageComplete: sql<number>`
          count(*) FILTER (WHERE ${costCoverage} = 'complete')::int
        `,
        coveragePartial: sql<number>`
          count(*) FILTER (WHERE ${costCoverage} = 'partial')::int
        `,
        coveragePending: sql<number>`
          count(*) FILTER (WHERE ${costCoverage} = 'pending')::int
        `,
        coverageUnpriced: sql<number>`
          count(*) FILTER (WHERE ${costCoverage} = 'unpriced')::int
        `,
      })
      .from(this.schema.turns)
      .where(and(
        sql`${this.schema.turns.startedAt} >= ${from}`,
        sql`${this.schema.turns.startedAt} < ${to}`,
      ))
      .groupBy(sql`bucket`)
      .orderBy(sql`bucket`);

    const emptyMetrics = (): AnalyticsMetrics => ({
      turns: 0,
      completedTurns: 0,
      errorTurns: 0,
      cancelledTurns: 0,
      activeTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      tokenReportedTurns: 0,
      knownCostUsd: 0,
      costCoverage: {
        complete: 0,
        partial: 0,
        pending: 0,
        unpriced: 0,
      },
    });
    const metricsFromRow = (row: {
      turns: number;
      completedTurns: number;
      errorTurns: number;
      cancelledTurns: number;
      activeTurns: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      tokenReportedTurns: number;
      knownCostUsd: number;
      coverageComplete: number;
      coveragePartial: number;
      coveragePending: number;
      coverageUnpriced: number;
    }): AnalyticsMetrics => ({
      turns: Number(row.turns),
      completedTurns: Number(row.completedTurns),
      errorTurns: Number(row.errorTurns),
      cancelledTurns: Number(row.cancelledTurns),
      activeTurns: Number(row.activeTurns),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      totalTokens: Number(row.totalTokens),
      tokenReportedTurns: Number(row.tokenReportedTurns),
      knownCostUsd: Number(row.knownCostUsd),
      costCoverage: {
        complete: Number(row.coverageComplete),
        partial: Number(row.coveragePartial),
        pending: Number(row.coveragePending),
        unpriced: Number(row.coverageUnpriced),
      },
    });

    const buckets = new Map(
      bucketRows.map((row) => [Number(row.bucket), metricsFromRow(row)]),
    );
    const activity = Array.from({ length: bucketCount }, (_, index) => ({
      from: from + index * bucketSizeMs,
      to: Math.min(to, from + (index + 1) * bucketSizeMs),
      ...(buckets.get(index) ?? emptyMetrics()),
    }));
    const agents = agentRows
      .map((row): AnalyticsAgentRow => ({
        agentId: row.agentId,
        name: row.name,
        harness: row.harness,
        harnessConfig: row.harnessConfig,
        lastActivityAt: row.lastActivityAt === null
          ? null
          : Number(row.lastActivityAt),
        ...metricsFromRow(row),
      }))
      .sort((left, right) => (
        right.totalTokens - left.totalTokens
        || right.turns - left.turns
        || left.name.localeCompare(right.name)
      ));

    return { activity, agents };
  }

  async updateAgent(id: string, data: Partial<Omit<AgentInsert, 'id'>>): Promise<AgentSelect | undefined> {
    const sanitizedData = sanitizeTypedDbValue(data, 'agents.update');
    const [updated] = await this.db
      .update(this.schema.agents)
      .set({ ...sanitizedData, updatedAt: Date.now() })
      .where(eq(this.schema.agents.id, id))
      .returning();
    return updated;
  }

  async deleteAgent(id: string): Promise<void> {
    await this.db.delete(this.schema.agents).where(eq(this.schema.agents.id, id));
  }

  /**
   * Delete an agent and all its related data in a single transaction.
   * Order: messages -> conversations -> runs -> events -> agent.
   *
   * The lifecycle-independent agent_event_heads row is retained as the writer
   * mutex for the durable agent.deleted tombstone emitted after this returns.
   */
  async deleteAgentCascade(agentId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const conversations = await tx
        .select({ id: this.schema.conversations.id })
        .from(this.schema.conversations)
        .where(eq(this.schema.conversations.agentId, agentId));
      const conversationIds = conversations.map((c) => c.id);
      const turns = await tx
        .select({ id: this.schema.turns.id })
        .from(this.schema.turns)
        .where(eq(this.schema.turns.agentId, agentId));
      const turnIds = turns.map((turn) => turn.id);
      if (conversationIds.length > 0) {
        await tx.delete(this.schema.messages).where(inArray(this.schema.messages.conversationId, conversationIds));
      }
      await tx.delete(this.schema.pendingInterrupts).where(eq(this.schema.pendingInterrupts.agentId, agentId));
      if (turnIds.length > 0) {
        await tx.delete(this.schema.toolRequestDedup).where(inArray(this.schema.toolRequestDedup.turnId, turnIds));
      }
      await tx.execute(sql`DELETE FROM secrets WHERE agent_id = ${agentId}`);
      await tx.delete(this.schema.agentCheckpoints).where(eq(this.schema.agentCheckpoints.agentId, agentId));
      await tx.delete(this.schema.callbackOutbox).where(eq(this.schema.callbackOutbox.agentId, agentId));
      await tx.delete(this.schema.turns).where(eq(this.schema.turns.agentId, agentId));
      await tx.delete(this.schema.sandboxSessions).where(eq(this.schema.sandboxSessions.agentId, agentId));
      await tx.delete(this.schema.conversations).where(eq(this.schema.conversations.agentId, agentId));
      await tx.delete(this.schema.eventStore).where(eq(this.schema.eventStore.agentId, agentId));
      await tx.delete(this.schema.eventTriggers).where(eq(this.schema.eventTriggers.agentId, agentId));
      await tx.delete(this.schema.agents).where(eq(this.schema.agents.id, agentId));
    });
  }

  // ── Conversations ───────────────────────────────────────

  async createConversation(agentId: string, id?: string, tags?: Record<string, string>): Promise<ConversationSelect> {
    const sanitizedAgentId = sanitizeDbText(agentId, 'conversations.agentId');
    const sanitizedId = id ? sanitizeDbText(id, 'conversations.id') : undefined;
    const sanitizedTags = tags ? sanitizeDbJsonValue(tags, 'conversations.tags') as Record<string, string> : undefined;
    return this.insertOne(
      this.db
        .insert(this.schema.conversations)
        .values({
          ...(sanitizedId ? { id: sanitizedId } : {}),
          agentId: sanitizedAgentId,
          ...(sanitizedTags ? { tags: sanitizedTags } : {}),
        })
        .returning(),
      'conversation',
    );
  }

  async getConversation(id: string): Promise<ConversationSelect | undefined> {
    return this.db.query.conversations.findFirst({
      where: eq(this.schema.conversations.id, id),
    });
  }

  async getConversationsForAgent(agentId: string): Promise<ConversationSelect[]> {
    return this.db.query.conversations.findMany({
      where: eq(this.schema.conversations.agentId, agentId),
      orderBy: (conversations) => [desc(conversations.updatedAt)],
    });
  }

  async addMessage(data: MessageInsert): Promise<MessageSelect> {
    const sanitizedData: MessageInsert = {
      ...data,
      content: sanitizeDbText(data.content, 'messages.content'),
      parts: sanitizeTypedDbValue(data.parts, 'messages.parts'),
      toolCalls: sanitizeTypedDbValue(data.toolCalls, 'messages.toolCalls'),
      toolCallId: sanitizeOptionalDbText(data.toolCallId, 'messages.toolCallId'),
    };

    return this.db.transaction(async (tx) => {
      const rows = await tx.insert(this.schema.messages).values(sanitizedData).returning();
      const message = rows[0];
      if (!message) throw new Error('Expected insert to return a row but got undefined');
      if (sanitizedData.conversationId) {
        await tx.update(this.schema.conversations)
          .set({ updatedAt: Date.now() })
          .where(eq(this.schema.conversations.id, sanitizedData.conversationId));
      }
      return message;
    });
  }

  /**
   * Persist a canonical assistant/tool message with a durable turn-local
   * sequence. The row starts unpublished (-1); CanonicalLog advances the
   * publication watermark in the same transaction as its committed frame.
   */
  async addCanonicalMessage(data: CanonicalMessageInsert): Promise<MessageSelect>;
  async addCanonicalMessage(
    data: CanonicalMessageInsert,
    expectedDeliveryFence: ExpectedTurnDeliveryFence,
  ): Promise<MessageSelect | undefined>;
  async addCanonicalMessage(
    data: CanonicalMessageInsert,
    expectedDeliveryFence: ExpectedTurnDeliveryFence | undefined,
  ): Promise<MessageSelect | undefined>;
  async addCanonicalMessage(
    data: CanonicalMessageInsert,
    expectedDeliveryFence?: ExpectedTurnDeliveryFence,
  ): Promise<MessageSelect | undefined> {
    const sanitizedData: MessageInsert = {
      ...data,
      content: sanitizeDbText(data.content, 'messages.content'),
      parts: sanitizeTypedDbValue(data.parts, 'messages.parts'),
      toolCalls: sanitizeTypedDbValue(data.toolCalls, 'messages.toolCalls'),
      toolCallId: sanitizeOptionalDbText(data.toolCallId, 'messages.toolCallId'),
      messageRevision: 0,
      publishedRevision: -1,
    };

    return this.db.transaction(async (tx) => {
      if (
        expectedDeliveryFence
        && !await this.lockCurrentDeliveryFence(
          tx,
          data.turnId,
          expectedDeliveryFence,
          'messages.canonical.deliveryFence',
        )
      ) {
        return undefined;
      }

      // Serialize allocation per turn. When a caller supplies a stable id,
      // checking for an existing row while holding this lock makes retries
      // idempotent without consuming another turn-local sequence.
      const [turn] = await tx
        .select({
          nextMessageSeq: this.schema.turns.nextMessageSeq,
          completedAt: this.schema.turns.completedAt,
        })
        .from(this.schema.turns)
        .where(eq(this.schema.turns.id, data.turnId))
        .for('update');
      if (!turn) {
        throw new Error(`Cannot allocate message sequence for missing turn ${data.turnId}`);
      }

      if (sanitizedData.id) {
        const [existing] = await tx
          .select()
          .from(this.schema.messages)
          .where(eq(this.schema.messages.id, sanitizedData.id));
        if (existing) {
          if (
            existing.turnId !== data.turnId
            || existing.conversationId !== data.conversationId
            || existing.agentId !== data.agentId
            || existing.role !== data.role
            || existing.content !== sanitizedData.content
            || existing.toolCallId !== (sanitizedData.toolCallId ?? null)
            || !isDeepStrictEqual(existing.toolCalls, sanitizedData.toolCalls ?? null)
            || !isDeepStrictEqual(existing.parts, sanitizedData.parts ?? null)
          ) {
            throw new Error(
              `Canonical message idempotency conflict for ${sanitizedData.id}`,
            );
          }
          return existing;
        }
      }
      if (turn.completedAt != null) {
        throw new Error(`Cannot add canonical message to terminal turn ${data.turnId}`);
      }

      const [message] = await tx
        .insert(this.schema.messages)
        .values({
          ...sanitizedData,
          messageSeq: turn.nextMessageSeq,
        })
        .returning();
      if (!message) {
        throw new Error('Expected canonical message insert to return a row but got undefined');
      }
      await tx
        .update(this.schema.turns)
        .set({
          nextMessageSeq: sql<number>`${this.schema.turns.nextMessageSeq} + 1`,
        })
        .where(eq(this.schema.turns.id, data.turnId));
      await tx.update(this.schema.conversations)
        .set({ updatedAt: Date.now() })
        .where(eq(this.schema.conversations.id, data.conversationId));
      return message;
    });
  }

  async getMessage(id: string): Promise<MessageSelect | undefined> {
    return this.db.query.messages.findFirst({
      where: eq(this.schema.messages.id, id),
    });
  }

  /**
   * Full assistant projection replacement. The public revision and row state
   * advance together while publishedRevision remains behind until CanonicalLog
   * durably records the matching message.updated frame.
   */
  async stageAssistantMessageUpdate(
    id: string,
    toolCalls: unknown[] | null,
    parts: unknown[] | null,
    expectedDeliveryFence?: ExpectedTurnDeliveryFence,
  ): Promise<MessageSelect | undefined> {
    return this.db.transaction(async (tx) => {
      const [message] = await tx
        .select({ turnId: this.schema.messages.turnId })
        .from(this.schema.messages)
        .where(and(
          eq(this.schema.messages.id, id),
          eq(this.schema.messages.role, 'assistant'),
        ));
      if (!message) {
        return undefined;
      }
      if (message.turnId) {
        if (
          expectedDeliveryFence
          && !await this.lockCurrentDeliveryFence(
            tx,
            message.turnId,
            expectedDeliveryFence,
            'messages.stage.deliveryFence',
          )
        ) {
          return undefined;
        }
        const [turn] = await tx
          .select({ completedAt: this.schema.turns.completedAt })
          .from(this.schema.turns)
          .where(eq(this.schema.turns.id, message.turnId))
          .for('update');
        if (!turn) {
          throw new Error(`Cannot update assistant message ${id}; turn ${message.turnId} is missing`);
        }
        if (turn.completedAt != null) {
          throw new Error(`Cannot update assistant message ${id} on terminal turn ${message.turnId}`);
        }
      } else if (expectedDeliveryFence) {
        return undefined;
      }

      const [updated] = await tx.update(this.schema.messages)
        .set({
          ...(toolCalls ? { toolCalls: sanitizeTypedDbValue(toolCalls, 'messages.toolCalls') } : {}),
          ...(parts ? { parts: sanitizeTypedDbValue(parts, 'messages.parts') } : {}),
          messageRevision: sql<number>`${this.schema.messages.messageRevision} + 1`,
        })
        .where(and(
          eq(this.schema.messages.id, id),
          eq(this.schema.messages.role, 'assistant'),
        ))
        .returning();
      return updated;
    });
  }

  /** Rows whose REST projection is newer than their durable canonical frame. */
  async getMessagesPendingCanonicalPublish(): Promise<MessageSelect[]> {
    return this.db
      .select()
      .from(this.schema.messages)
      .where(and(
        isNotNull(this.schema.messages.turnId),
        isNotNull(this.schema.messages.messageSeq),
        inArray(this.schema.messages.role, ['assistant', 'tool']),
        lt(this.schema.messages.publishedRevision, this.schema.messages.messageRevision),
      ))
      .orderBy(
        asc(this.schema.messages.turnId),
        asc(this.schema.messages.messageSeq),
        asc(this.schema.messages.createdAt),
        asc(this.schema.messages.id),
      );
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.delete(this.schema.messages).where(eq(this.schema.messages.id, id));
  }

  async getMessages(conversationId: string): Promise<MessageSelect[]> {
    return this.db.query.messages.findMany({
      where: eq(this.schema.messages.conversationId, conversationId),
      orderBy: (messages) => [asc(messages.createdAt), asc(messages.id)],
    });
  }

  /**
   * Read a replay-coherent conversation projection and cursor from one
   * repeatable snapshot. An idle conversation uses the agent's committed event
   * watermark. If a turn is open, the cursor rewinds before its first durable
   * run frame. Open-turn projections, plus projections for any later turn whose
   * full frame range will replay, are omitted so hydration and replay reconstruct
   * each lifecycle exactly once. Interactive user messages are linked through
   * turns.userMessageId rather than messages.turnId; background prompts remain
   * projected because background turns intentionally emit no user.message frame.
   */
  async getConversationSnapshot(
    conversationId: string,
    agentId: string,
  ): Promise<{ messages: MessageSelect[]; eventCursorSeq: number }> {
    return this.db.transaction(async (tx) => {
      const messages = await tx.query.messages.findMany({
        where: eq(this.schema.messages.conversationId, conversationId),
        orderBy: (table) => [asc(table.createdAt), asc(table.id)],
      });
      const [head] = await tx
        .select({ committedSeq: this.schema.agentEventHeads.committedSeq })
        .from(this.schema.agentEventHeads)
        .where(eq(this.schema.agentEventHeads.agentId, agentId));
      const turnBoundaries = await tx
        .select({
          turnId: this.schema.turns.id,
          userMessageId: this.schema.turns.userMessageId,
          mode: this.schema.turns.mode,
          completedAt: this.schema.turns.completedAt,
          firstSeq: sql<number | null>`min(${this.schema.eventStore.seq})`,
          lastSeq: sql<number | null>`max(${this.schema.eventStore.seq})`,
        })
        .from(this.schema.turns)
        .leftJoin(
          this.schema.eventStore,
          and(
            eq(this.schema.eventStore.turnId, this.schema.turns.id),
            eq(this.schema.eventStore.agentId, agentId),
            eq(this.schema.eventStore.channel, 'run'),
          ),
        )
        .where(and(
          eq(this.schema.turns.agentId, agentId),
          eq(this.schema.turns.conversationId, conversationId),
        ))
        .groupBy(
          this.schema.turns.id,
          this.schema.turns.userMessageId,
          this.schema.turns.mode,
          this.schema.turns.completedAt,
        );
      const firstOpenTurnSeq = turnBoundaries.reduce<number | null>(
        (earliest, { completedAt, firstSeq }) => {
          if (completedAt !== null) return earliest;
          if (firstSeq === null) return earliest;
          return earliest === null || firstSeq < earliest ? firstSeq : earliest;
        },
        null,
      );
      let replayStartSeq = firstOpenTurnSeq;
      if (replayStartSeq !== null) {
        // If a completed turn began before the tentative cut but emitted a
        // later frame after it, keeping that projection while replaying its
        // tail would duplicate or corrupt state. Rewind to that turn's start,
        // then repeat because the wider interval can overlap another turn.
        while (true) {
          const currentStartSeq: number = replayStartSeq;
          const expandedStartSeq: number = turnBoundaries.reduce<number>(
            (earliest, { firstSeq, lastSeq }) => {
              if (
                firstSeq === null
                || lastSeq === null
                || firstSeq >= earliest
                || lastSeq < earliest
              ) {
                return earliest;
              }
              return firstSeq;
            },
            currentStartSeq,
          );
          if (expandedStartSeq === replayStartSeq) {
            break;
          }
          replayStartSeq = expandedStartSeq;
        }
      }
      const eventCursorSeq = replayStartSeq === null
        ? head?.committedSeq ?? 0
        : Math.max(0, replayStartSeq - 1);
      const replayedTurnBoundaries = turnBoundaries.filter(({ completedAt, firstSeq }) =>
        completedAt === null
        || (
          replayStartSeq !== null
          && firstSeq !== null
          && firstSeq >= replayStartSeq
        ));
      const replayedTurnIds = new Set(
        replayedTurnBoundaries.map(({ turnId }) => turnId),
      );
      const replayedUserMessageIds = new Set(
        replayedTurnBoundaries.flatMap(({ userMessageId, mode }) =>
          userMessageId === null || mode === 'background' ? [] : [userMessageId]),
      );
      return {
        messages: replayedTurnIds.size === 0
          ? messages
          : messages.filter((message) =>
              !replayedUserMessageIds.has(message.id)
              && (message.turnId === null || !replayedTurnIds.has(message.turnId))),
        eventCursorSeq,
      };
    }, {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  async getConversationSummaries(agentId: string): Promise<ConversationSummaryRow[]> {
    return this.queryConversationSummaries({ agentId });
  }

  async getActiveConversationSummaries(): Promise<ConversationSummaryRow[]> {
    return this.queryConversationSummaries({ sandboxStatuses: ['ACTIVE', 'RESTORING'] });
  }

  /**
   * Cross-agent recent conversations, newest activity first, with an
   * updatedAt cursor for paging. One query for the dashboard instead of a
   * per-agent summary fan-out.
   */
  async getRecentConversationSummaries(options: {
    limit: number;
    beforeUpdatedAtMs?: number;
    agentId?: string;
  }): Promise<ConversationSummaryRow[]> {
    return this.queryConversationSummaries({
      ...(options.agentId ? { agentId: options.agentId } : {}),
      limit: Math.max(1, Math.min(Math.trunc(options.limit), 100)),
      ...(options.beforeUpdatedAtMs !== undefined
        ? { beforeUpdatedAtMs: options.beforeUpdatedAtMs }
        : {}),
    });
  }

  async createTurn(data: TurnInsert): Promise<TurnSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'turns.insert');
    return this.insertOne(
      this.db.insert(this.schema.turns).values(sanitizedData).returning(),
      'turn',
    );
  }

  async createTurnWithSecretEnvelope(
    data: TurnInsert,
    secretEnvelope: TurnSecretEnvelopeInsert,
    admissionLimits?: { maxQueuedTurnsGlobal: number; maxQueuedTurnsPerAgent: number },
  ): Promise<TurnSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'turns.insert');
    const sanitizedEnvelope = sanitizeTypedDbValue(
      secretEnvelope,
      'turnSecretEnvelopes.insert',
    );
    return this.db.transaction(async (tx) => {
      // ctx-xrrc: the pre-insert queueAdmission.check is a cheap fast path but
      // races under concurrent submission (read-then-insert). When limits are
      // supplied for a queued turn, make the cap authoritative by counting and
      // inserting under one xact-scoped advisory lock — sub-ms, auto-released
      // at commit/rollback, one global key covering the global + per-agent cap.
      if (admissionLimits && sanitizedData.status === 'queued') {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${TURN_QUEUE_ADMISSION_LOCK_ID})`);
        const [counts] = await tx
          .select({
            global: sql<number>`count(*)::int`,
            agent: sql<number>`count(*) filter (where ${this.schema.turns.agentId} = ${sanitizedData.agentId})::int`,
          })
          .from(this.schema.turns)
          .where(and(
            eq(this.schema.turns.status, 'queued'),
            isNull(this.schema.turns.completedAt),
          ));
        const globalQueued = counts?.global ?? 0;
        const agentQueued = counts?.agent ?? 0;
        if (globalQueued >= admissionLimits.maxQueuedTurnsGlobal) {
          throw new QueueCapExceededError('global', sanitizedData.agentId, globalQueued, admissionLimits.maxQueuedTurnsGlobal);
        }
        if (agentQueued >= admissionLimits.maxQueuedTurnsPerAgent) {
          throw new QueueCapExceededError('agent', sanitizedData.agentId, agentQueued, admissionLimits.maxQueuedTurnsPerAgent);
        }
      }
      const [turn] = await tx
        .insert(this.schema.turns)
        .values(sanitizedData)
        .returning();
      if (!turn) {
        throw new Error('Failed to insert turn');
      }
      await tx.insert(this.schema.turnSecretEnvelopes).values({
        turnId: turn.id,
        ...sanitizedEnvelope,
      });
      return turn;
    });
  }

  async getTurnSecretEnvelope(
    turnId: string,
  ): Promise<TurnSecretEnvelopeRow | undefined> {
    return this.db.query.turnSecretEnvelopes.findFirst({
      where: eq(
        this.schema.turnSecretEnvelopes.turnId,
        sanitizeDbText(turnId, 'turnSecretEnvelopes.get.turnId'),
      ),
    });
  }

  /**
   * Admit ordinary delivery only while the turn is still open.
   *
   * Keeping this as a database compare-and-set prevents a delayed delivery
   * callback from changing a concurrently cancelled/finalized turn back to
   * running.
   */
  async activateTurnIfOpen(
    turnId: string,
    sandboxSessionId: string,
    expectedActiveGeneration: SandboxSessionActiveGeneration,
  ): Promise<boolean> {
    const sanitizedTurnId = sanitizeDbText(turnId, 'turns.activate.turnId');
    const sanitizedSessionId = sanitizeDbText(
      sandboxSessionId,
      'turns.activate.sandboxSessionId',
    );
    const expectedRestoreFenceToken = validateNonNegativeSafeInteger(
      expectedActiveGeneration.restoreFenceToken,
      'turns.activate.restoreFenceToken',
    );
    const expectedContainerId = expectedActiveGeneration.containerId === null
      ? null
      : sanitizeDbText(
          expectedActiveGeneration.containerId,
          'turns.activate.containerId',
        );
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          id: this.schema.sandboxSessions.id,
          restoreFenceToken: this.schema.sandboxSessions.restoreFenceToken,
          containerId: this.schema.sandboxSessions.containerId,
        })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(this.schema.sandboxSessions.id, sanitizedSessionId),
          eq(this.schema.sandboxSessions.status, 'ACTIVE'),
        ))
        .for('update');
      if (
        !session
        || session.restoreFenceToken !== expectedRestoreFenceToken
        || session.containerId !== expectedContainerId
      ) {
        return false;
      }
      const [lifecycleOperation] = await tx
        .select({
          sandboxSessionId:
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
        })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sanitizedSessionId,
          ),
          inArray(
            this.schema.sandboxSessionLifecycleOperations.phase,
            ['reserved', 'draining', 'executing'],
          ),
        ))
        .limit(1);
      if (lifecycleOperation) {
        return false;
      }
      const [activated] = await tx
        .update(this.schema.turns)
        .set({
          status: 'running',
          sandboxSessionId: sanitizedSessionId,
        })
        .where(and(
          eq(this.schema.turns.id, sanitizedTurnId),
          isNull(this.schema.turns.completedAt),
          inArray(this.schema.turns.status, ['queued', 'running']),
        ))
        .returning({ turnId: this.schema.turns.id });
      return activated !== undefined;
    });
  }

  async isSandboxSessionActiveGenerationCurrent(
    sandboxSessionId: string,
    expectedActiveGeneration: SandboxSessionActiveGeneration,
  ): Promise<boolean> {
    const expectedRestoreFenceToken = validateNonNegativeSafeInteger(
      expectedActiveGeneration.restoreFenceToken,
      'sandboxSessions.activeGeneration.restoreFenceToken',
    );
    const expectedContainerId = expectedActiveGeneration.containerId === null
      ? null
      : sanitizeDbText(
          expectedActiveGeneration.containerId,
          'sandboxSessions.activeGeneration.containerId',
        );
    const [session] = await this.db
      .select({ id: this.schema.sandboxSessions.id })
      .from(this.schema.sandboxSessions)
      .where(and(
        eq(
          this.schema.sandboxSessions.id,
          sanitizeDbText(
            sandboxSessionId,
            'sandboxSessions.activeGeneration.id',
          ),
        ),
        eq(this.schema.sandboxSessions.status, 'ACTIVE'),
        eq(
          this.schema.sandboxSessions.restoreFenceToken,
          expectedRestoreFenceToken,
        ),
        expectedContainerId === null
          ? isNull(this.schema.sandboxSessions.containerId)
          : eq(this.schema.sandboxSessions.containerId, expectedContainerId),
        sql<boolean>`NOT EXISTS (
          SELECT 1
          FROM ${this.schema.sandboxSessionLifecycleOperations}
          WHERE ${this.schema.sandboxSessionLifecycleOperations.sandboxSessionId}
              = ${this.schema.sandboxSessions.id}
            AND ${this.schema.sandboxSessionLifecycleOperations.phase}
              IN ('reserved', 'draining', 'executing')
        )`,
      ))
      .limit(1);
    return session !== undefined;
  }

  async getTurnsByAgent(agentId: string): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany({
      where: eq(this.schema.turns.agentId, agentId),
    });
  }

  /** Open turns started before the cutoff — stranded by construction after a restart (ADR-014). */
  async getOpenTurnsStartedBefore(cutoffMs: number): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany({
      where: and(isNull(this.schema.turns.completedAt), lt(this.schema.turns.startedAt, cutoffMs)),
    });
  }

  /**
   * Resolve one immutable turn-delivery capability without substituting the
   * currently-owned fence or runtime generation.
   *
   * Session -> turn -> lease is the same lock order used by turn activation.
   * Holding the session row also serializes this admission point with restore
   * and lifecycle claims. This method is deliberately read-only: a rejected
   * tuple leaves every durable owner and lease field untouched.
   */
  async getTurnDeliveryCapabilityClaims(input: {
    turnId: string;
    sandboxSessionId: string;
    agentId: string;
    expectedDeliveryFence: ExpectedTurnDeliveryFence;
    expectedActiveGeneration: SandboxSessionActiveGeneration;
  }): Promise<AdmittedTurnDeliveryCapabilityClaims | undefined> {
    const turnId = sanitizeDbText(
      input.turnId,
      'turnDelivery.capability.turnId',
    );
    const sandboxSessionId = sanitizeDbText(
      input.sandboxSessionId,
      'turnDelivery.capability.sandboxSessionId',
    );
    const agentId = sanitizeDbText(
      input.agentId,
      'turnDelivery.capability.agentId',
    );
    const ownerId = sanitizeDbText(
      input.expectedDeliveryFence.ownerId,
      'turnDelivery.capability.ownerId',
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      input.expectedDeliveryFence.fenceToken,
      'turnDelivery.capability.fenceToken',
    );
    if (!input.expectedActiveGeneration) {
      throw new Error(
        'turnDelivery.capability.expectedActiveGeneration is required',
      );
    }
    const restoreFenceToken = validateNonNegativeSafeInteger(
      input.expectedActiveGeneration.restoreFenceToken,
      'turnDelivery.capability.restoreFenceToken',
    );
    if (
      input.expectedActiveGeneration.containerId !== null
      && typeof input.expectedActiveGeneration.containerId !== 'string'
    ) {
      throw new Error(
        'turnDelivery.capability.containerId must be a string or null',
      );
    }
    const containerId =
      input.expectedActiveGeneration.containerId === null
        ? null
        : sanitizeDbText(
            input.expectedActiveGeneration.containerId,
            'turnDelivery.capability.containerId',
          );

    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          conversationId: this.schema.sandboxSessions.conversationId,
          restoreFenceToken: this.schema.sandboxSessions.restoreFenceToken,
          containerId: this.schema.sandboxSessions.containerId,
        })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(this.schema.sandboxSessions.id, sandboxSessionId),
          eq(this.schema.sandboxSessions.agentId, agentId),
          eq(this.schema.sandboxSessions.status, 'ACTIVE'),
          eq(
            this.schema.sandboxSessions.restoreFenceToken,
            restoreFenceToken,
          ),
          containerId === null
            ? isNull(this.schema.sandboxSessions.containerId)
            : eq(this.schema.sandboxSessions.containerId, containerId),
        ))
        .for('update');
      if (!session) {
        return undefined;
      }

      const [turn] = await tx
        .select({ turnId: this.schema.turns.id })
        .from(this.schema.turns)
        .where(and(
          eq(this.schema.turns.id, turnId),
          eq(this.schema.turns.sandboxSessionId, sandboxSessionId),
          eq(this.schema.turns.agentId, agentId),
          eq(
            this.schema.turns.conversationId,
            session.conversationId,
          ),
          eq(this.schema.turns.status, 'running'),
          isNull(this.schema.turns.completedAt),
          eq(this.schema.turns.deliveryOwnerId, ownerId),
          eq(this.schema.turns.deliveryFenceToken, fenceToken),
          this.deliveryAdmittedByLifecycleOperation(),
        ))
        .for('update');
      if (!turn) {
        return undefined;
      }

      const [lease] = await tx
        .select({
          ownerId: this.schema.turnDeliveryLeases.ownerId,
          fenceToken: this.schema.turnDeliveryLeases.fenceToken,
          leaseExpiresAt: this.schema.turnDeliveryLeases.leaseExpiresAt,
        })
        .from(this.schema.turnDeliveryLeases)
        .where(and(
          eq(this.schema.turnDeliveryLeases.turnId, turnId),
          eq(this.schema.turnDeliveryLeases.ownerId, ownerId),
          eq(this.schema.turnDeliveryLeases.fenceToken, fenceToken),
          gt(
            this.schema.turnDeliveryLeases.leaseExpiresAt,
            databaseClockMs(),
          ),
        ))
        .for('update');
      if (!lease) {
        return undefined;
      }

      return {
        turnId,
        sandboxSessionId,
        agentId,
        conversationId: session.conversationId,
        ownerId: lease.ownerId,
        fenceToken: lease.fenceToken,
        leaseExpiresAtMs: lease.leaseExpiresAt,
        restoreFenceToken: session.restoreFenceToken,
        containerId: session.containerId,
      };
    });
  }

  /**
   * Conservatively protect a sandbox session while any exact turn delivery
   * still owns it. Lifecycle cleanup only needs existence; callback admission
   * uses getTurnDeliveryCapabilityClaims with the immutable caller tuple.
   */
  async hasLiveTurnDeliveryForSandboxSession(sessionId: string): Promise<boolean> {
    const [delivery] = await this.db
      .select({ turnId: this.schema.turns.id })
      .from(this.schema.turns)
      .innerJoin(
        this.schema.turnDeliveryLeases,
        and(
          eq(this.schema.turnDeliveryLeases.turnId, this.schema.turns.id),
          eq(this.schema.turnDeliveryLeases.ownerId, this.schema.turns.deliveryOwnerId),
          eq(this.schema.turnDeliveryLeases.fenceToken, this.schema.turns.deliveryFenceToken),
        ),
      )
      .where(and(
        eq(
          this.schema.turns.sandboxSessionId,
          sanitizeDbText(sessionId, 'turnDelivery.liveForSession.sandboxSessionId'),
        ),
        eq(this.schema.turns.status, 'running'),
        isNull(this.schema.turns.completedAt),
        gt(this.schema.turnDeliveryLeases.leaseExpiresAt, databaseClockMs()),
        this.deliveryAdmittedByLifecycleOperation(),
        sql<boolean>`EXISTS (
          SELECT 1
          FROM ${this.schema.sandboxSessions}
          WHERE ${this.schema.sandboxSessions.id} = ${this.schema.turns.sandboxSessionId}
            AND ${this.schema.sandboxSessions.status} = 'ACTIVE'
        )`,
      ))
      .limit(1);
    return delivery !== undefined;
  }

  async getRecoverableSandboxSessionLifecycleOperations(): Promise<
    SandboxSessionLifecycleOperationRow[]
  > {
    return this.db
      .select()
      .from(this.schema.sandboxSessionLifecycleOperations)
      .where(and(
        inArray(
          this.schema.sandboxSessionLifecycleOperations.phase,
          ['reserved', 'draining', 'executing'],
        ),
        lte(
          this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
          databaseClockMs(),
        ),
      ))
      .orderBy(
        asc(this.schema.sandboxSessionLifecycleOperations.updatedAt),
        asc(this.schema.sandboxSessionLifecycleOperations.sandboxSessionId),
      );
  }

  async hasUnfinishedSandboxSessionLifecycleOperation(
    sandboxSessionId: string,
  ): Promise<boolean> {
    const [operation] = await this.db
      .select({
        sandboxSessionId:
          this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
      })
      .from(this.schema.sandboxSessionLifecycleOperations)
      .where(and(
        eq(
          this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          sanitizeDbText(
            sandboxSessionId,
            'sandboxSessionLifecycleOperations.unfinished.sandboxSessionId',
          ),
        ),
        inArray(
          this.schema.sandboxSessionLifecycleOperations.phase,
          ['reserved', 'draining', 'executing'],
        ),
      ))
      .limit(1);
    return operation !== undefined;
  }

  /**
   * Reserve lifecycle or runtime-adoption work for one ACTIVE sandbox session.
   *
   * An unfinished operation is a durable admission barrier. Its worker lease
   * may expire for takeover, but activation remains blocked until the
   * operation is explicitly cancelled before execution or completed together
   * with a non-ACTIVE session transition.
   */
  async claimSandboxSessionLifecycleOperation(input: {
    sandboxSessionId: string;
    operation: SandboxSessionLifecycleOperation;
    ownerId: string;
    leaseDurationMs: number;
    expectedActiveGeneration: SandboxSessionActiveGeneration;
    allowedTurnDelivery?: {
      turnId: string;
      ownerId: string;
      fenceToken: number;
      interruptResumeAttemptId?: string;
    };
  }): Promise<SandboxSessionLifecycleOperationRow | undefined> {
    const sandboxSessionId = sanitizeDbText(
      input.sandboxSessionId,
      'sandboxSessionLifecycleOperations.sandboxSessionId',
    );
    const operation = validateSandboxSessionLifecycleOperation(input.operation);
    const ownerId = sanitizeDbText(
      input.ownerId,
      'sandboxSessionLifecycleOperations.ownerId',
    );
    const leaseDurationMs = validateLeaseDurationMs(
      input.leaseDurationMs,
      'sandboxSessionLifecycleOperations.leaseDurationMs',
    );
    if (!input.expectedActiveGeneration) {
      throw new Error(
        'sandboxSessionLifecycleOperations.expectedActiveGeneration is required',
      );
    }
    if (
      input.expectedActiveGeneration.containerId !== null
      && typeof input.expectedActiveGeneration.containerId !== 'string'
    ) {
      throw new Error(
        'sandboxSessionLifecycleOperations.expectedActiveGeneration.containerId ' +
        'must be a string or null',
      );
    }
    const expectedActiveGeneration: SandboxSessionActiveGeneration = {
      restoreFenceToken: validateNonNegativeSafeInteger(
        input.expectedActiveGeneration.restoreFenceToken,
        'sandboxSessionLifecycleOperations.expectedActiveGeneration.restoreFenceToken',
      ),
      containerId: input.expectedActiveGeneration.containerId === null
        ? null
        : sanitizeDbText(
            input.expectedActiveGeneration.containerId,
            'sandboxSessionLifecycleOperations.expectedActiveGeneration.containerId',
          ),
    };
    const operationId = randomUUID();
    const allowedTurnDelivery = input.allowedTurnDelivery
      ? {
          turnId: sanitizeDbText(
            input.allowedTurnDelivery.turnId,
            'sandboxSessionLifecycleOperations.allowedTurnDelivery.turnId',
          ),
          ownerId: sanitizeDbText(
            input.allowedTurnDelivery.ownerId,
            'sandboxSessionLifecycleOperations.allowedTurnDelivery.ownerId',
          ),
          fenceToken: validateTurnDeliveryFenceToken(
            input.allowedTurnDelivery.fenceToken,
            'sandboxSessionLifecycleOperations.allowedTurnDelivery.fenceToken',
          ),
          interruptResumeAttemptId:
            input.allowedTurnDelivery.interruptResumeAttemptId === undefined
              ? undefined
              : sanitizeDbText(
                  input.allowedTurnDelivery.interruptResumeAttemptId,
                  'sandboxSessionLifecycleOperations.allowedTurnDelivery.interruptResumeAttemptId',
                ),
        }
      : undefined;
    return this.db.transaction(async (tx) => {
      // Lifecycle always locks the session first. Its delivery check is
      // non-locking; turn activation also locks this session row before it may
      // cross the delivery boundary.
      const [session] = await tx
        .select({
          sandboxSessionId: this.schema.sandboxSessions.id,
          containerId: this.schema.sandboxSessions.containerId,
          restoreFenceToken: this.schema.sandboxSessions.restoreFenceToken,
        })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(this.schema.sandboxSessions.id, sandboxSessionId),
          eq(this.schema.sandboxSessions.status, 'ACTIVE'),
        ))
        .for('update');
      if (!session) {
        return undefined;
      }
      if (
        session.restoreFenceToken !== expectedActiveGeneration.restoreFenceToken
        || session.containerId !== expectedActiveGeneration.containerId
      ) {
        return undefined;
      }

      const [clock] = await tx
        .select({ nowMs: databaseClockMs() })
        .from(this.schema.sandboxSessions)
        .where(eq(this.schema.sandboxSessions.id, sandboxSessionId))
        .limit(1);
      if (!clock) {
        throw new Error('Database clock query returned no row');
      }
      const nowMs = parseDatabaseClockMs(clock.nowMs);
      const leaseExpiresAt = nowMs + leaseDurationMs;

      const [existingOperation] = await tx
        .select()
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(eq(
          this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          sandboxSessionId,
        ))
        .for('update');
      const isUnfinishedTakeover =
        existingOperation !== undefined
        && existingOperation.phase !== 'completed';
      if (
        isUnfinishedTakeover
        && (
          existingOperation.operation !== operation
          || (
            existingOperation.ownerId !== ownerId
            && existingOperation.leaseExpiresAt > nowMs
          )
        )
      ) {
        return undefined;
      }
      const persistedAllowedTurnDelivery = isUnfinishedTakeover
        && existingOperation.allowedTurnId
        && existingOperation.allowedDeliveryOwnerId
        && existingOperation.allowedDeliveryFenceToken !== null
        ? {
            turnId: existingOperation.allowedTurnId,
            ownerId: existingOperation.allowedDeliveryOwnerId,
            fenceToken: existingOperation.allowedDeliveryFenceToken,
            interruptResumeAttemptId:
              existingOperation.allowedInterruptResumeAttemptId ?? undefined,
          }
        : undefined;
      const effectiveAllowedTurnDelivery = isUnfinishedTakeover
        ? persistedAllowedTurnDelivery
        : allowedTurnDelivery;
      const allowedLeaseCondition = isUnfinishedTakeover
        ? sql<boolean>`TRUE`
        : effectiveAllowedTurnDelivery
          ? sql<boolean>`EXISTS (
              SELECT 1
              FROM ${this.schema.turnDeliveryLeases}
              WHERE ${this.schema.turnDeliveryLeases.turnId}
                  = ${this.schema.turns.id}
                AND ${this.schema.turnDeliveryLeases.ownerId}
                  = ${effectiveAllowedTurnDelivery.ownerId}
                AND ${this.schema.turnDeliveryLeases.fenceToken}
                  = ${effectiveAllowedTurnDelivery.fenceToken}
                AND ${this.schema.turnDeliveryLeases.leaseExpiresAt}
                  > ${databaseClockMs()}
            )`
          : sql<boolean>`FALSE`;
      const disallowedDelivery = effectiveAllowedTurnDelivery
        ? sql<boolean>`NOT (
            ${this.schema.turns.id} = ${effectiveAllowedTurnDelivery.turnId}
            AND ${this.schema.turns.deliveryOwnerId}
                = ${effectiveAllowedTurnDelivery.ownerId}
            AND ${this.schema.turns.deliveryFenceToken}
                = ${effectiveAllowedTurnDelivery.fenceToken}
            AND ${allowedLeaseCondition}
          )`
        : sql<boolean>`TRUE`;
      const [blockingDelivery] = await tx
        .select({ turnId: this.schema.turns.id })
        .from(this.schema.turns)
        .where(and(
          eq(this.schema.turns.sandboxSessionId, sandboxSessionId),
          eq(this.schema.turns.status, 'running'),
          isNull(this.schema.turns.completedAt),
          disallowedDelivery,
        ))
        .limit(1);
      if (blockingDelivery) {
        return undefined;
      }

      const activeResumes = await tx
        .select({
          id: this.schema.interruptResumeAttempts.id,
          interruptId: this.schema.interruptResumeAttempts.interruptId,
          turnId: this.schema.interruptResumeAttempts.turnId,
          sandboxSessionId:
            this.schema.interruptResumeAttempts.sandboxSessionId,
          interruptStatus: this.schema.pendingInterrupts.status,
        })
        .from(this.schema.interruptResumeAttempts)
        .innerJoin(
          this.schema.pendingInterrupts,
          eq(
            this.schema.pendingInterrupts.id,
            this.schema.interruptResumeAttempts.interruptId,
          ),
        )
        .where(and(
          eq(
            this.schema.interruptResumeAttempts.sandboxSessionId,
            sandboxSessionId,
          ),
          eq(this.schema.interruptResumeAttempts.status, 'in_progress'),
        ));
      const allowedResumeAttemptId =
        effectiveAllowedTurnDelivery?.interruptResumeAttemptId;
      const allowedResumeTurnId = effectiveAllowedTurnDelivery?.turnId;
      const matchingResolvedResume = allowedResumeAttemptId === undefined
        ? undefined
        : activeResumes.find((attempt) =>
            operation === 'reset'
            && attempt.id === allowedResumeAttemptId
            && attempt.turnId === allowedResumeTurnId
            && attempt.sandboxSessionId === sandboxSessionId
            && attempt.interruptStatus === 'resolved'
          );
      if (
        activeResumes.some((attempt) => attempt.id !== matchingResolvedResume?.id)
        || (allowedResumeAttemptId !== undefined && !matchingResolvedResume)
      ) {
        return undefined;
      }

      const [claimed] = await tx
        .insert(this.schema.sandboxSessionLifecycleOperations)
        .values({
          sandboxSessionId,
          operation,
          operationId,
          phase: 'reserved',
          ownerId,
          fenceToken: 1,
          allowedTurnId: allowedTurnDelivery?.turnId ?? null,
          allowedDeliveryOwnerId: allowedTurnDelivery?.ownerId ?? null,
          allowedDeliveryFenceToken: allowedTurnDelivery?.fenceToken ?? null,
          allowedInterruptResumeAttemptId:
            allowedTurnDelivery?.interruptResumeAttemptId ?? null,
          leaseExpiresAt,
          updatedAt: nowMs,
        })
        .onConflictDoUpdate({
          target: this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          set: {
            operation: sql<SandboxSessionLifecycleOperation>`
              CASE
                WHEN ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'completed'
                THEN ${this.schema.sandboxSessionLifecycleOperations.operation}
                ELSE ${operation}
              END
            `,
            operationId: sql<string>`
              CASE
                WHEN ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'completed'
                THEN ${this.schema.sandboxSessionLifecycleOperations.operationId}
                ELSE ${operationId}
              END
            `,
            phase: sql<SandboxSessionLifecycleOperationRow['phase']>`
              CASE
                WHEN ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'completed'
                THEN ${this.schema.sandboxSessionLifecycleOperations.phase}
                ELSE 'reserved'
              END
            `,
            ownerId,
            fenceToken: sql<number>`
              CASE
                WHEN ${this.schema.sandboxSessionLifecycleOperations.ownerId} = ${ownerId}
                  AND ${this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt} > ${nowMs}
                THEN ${this.schema.sandboxSessionLifecycleOperations.fenceToken}
                ELSE ${this.schema.sandboxSessionLifecycleOperations.fenceToken} + 1
              END
            `,
            allowedTurnId: sql<string | null>`
              CASE
                WHEN ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'completed'
                THEN ${this.schema.sandboxSessionLifecycleOperations.allowedTurnId}
                ELSE ${allowedTurnDelivery?.turnId ?? null}
              END
            `,
            allowedDeliveryOwnerId: sql<string | null>`
              CASE
                WHEN ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'completed'
                THEN ${this.schema.sandboxSessionLifecycleOperations.allowedDeliveryOwnerId}
                ELSE ${allowedTurnDelivery?.ownerId ?? null}
              END
            `,
            allowedDeliveryFenceToken: sql<number | null>`
              CASE
                WHEN ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'completed'
                THEN ${this.schema.sandboxSessionLifecycleOperations.allowedDeliveryFenceToken}
                ELSE ${allowedTurnDelivery?.fenceToken ?? null}
              END
            `,
            allowedInterruptResumeAttemptId: sql<string | null>`
              CASE
                WHEN ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'completed'
                THEN ${this.schema.sandboxSessionLifecycleOperations.allowedInterruptResumeAttemptId}
                ELSE ${allowedTurnDelivery?.interruptResumeAttemptId ?? null}
              END
            `,
            leaseExpiresAt,
            updatedAt: nowMs,
          },
          setWhere: or(
            eq(this.schema.sandboxSessionLifecycleOperations.phase, 'completed'),
            and(
              eq(
                this.schema.sandboxSessionLifecycleOperations.operation,
                operation,
              ),
              or(
                lte(
                  this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
                  nowMs,
                ),
                eq(
                  this.schema.sandboxSessionLifecycleOperations.ownerId,
                  ownerId,
                ),
              ),
            ),
          ),
        })
        .returning();
      return claimed;
    });
  }

  async renewSandboxSessionLifecycleOperation(
    sandboxSessionId: string,
    ownerId: string,
    fenceToken: number,
    leaseDurationMs: number,
  ): Promise<SandboxSessionLifecycleOperationRow | undefined> {
    const [renewed] = await this.db
      .update(this.schema.sandboxSessionLifecycleOperations)
      .set({
        leaseExpiresAt: sql`${databaseClockMs()} + ${validateLeaseDurationMs(
          leaseDurationMs,
          'sandboxSessionLifecycleOperations.renew.leaseDurationMs',
        )}`,
        updatedAt: databaseClockMs(),
      })
      .where(and(
        eq(
          this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          sanitizeDbText(
            sandboxSessionId,
            'sandboxSessionLifecycleOperations.renew.sandboxSessionId',
          ),
        ),
        eq(
          this.schema.sandboxSessionLifecycleOperations.ownerId,
          sanitizeDbText(
            ownerId,
            'sandboxSessionLifecycleOperations.renew.ownerId',
          ),
        ),
        eq(
          this.schema.sandboxSessionLifecycleOperations.fenceToken,
          validateTurnDeliveryFenceToken(
            fenceToken,
            'sandboxSessionLifecycleOperations.renew.fenceToken',
          ),
        ),
        inArray(
          this.schema.sandboxSessionLifecycleOperations.phase,
          ['reserved', 'draining', 'executing'],
        ),
        gt(
          this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
          databaseClockMs(),
        ),
      ))
      .returning();
    return renewed;
  }

  async markSandboxSessionLifecycleOperationExecuting(
    sandboxSessionId: string,
    ownerId: string,
    fenceToken: number,
  ): Promise<boolean> {
    const sanitizedSessionId = sanitizeDbText(
      sandboxSessionId,
      'sandboxSessionLifecycleOperations.execute.sandboxSessionId',
    );
    const sanitizedOwnerId = sanitizeDbText(
      ownerId,
      'sandboxSessionLifecycleOperations.execute.ownerId',
    );
    const validatedFenceToken = validateTurnDeliveryFenceToken(
      fenceToken,
      'sandboxSessionLifecycleOperations.execute.fenceToken',
    );
    return this.db.transaction(async (tx) => {
      const [operation] = await tx
        .select({
          sandboxSessionId: this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          operation: this.schema.sandboxSessionLifecycleOperations.operation,
          allowedTurnId: this.schema.sandboxSessionLifecycleOperations.allowedTurnId,
          allowedDeliveryOwnerId:
            this.schema.sandboxSessionLifecycleOperations.allowedDeliveryOwnerId,
          allowedDeliveryFenceToken:
            this.schema.sandboxSessionLifecycleOperations.allowedDeliveryFenceToken,
          allowedInterruptResumeAttemptId:
            this.schema.sandboxSessionLifecycleOperations
              .allowedInterruptResumeAttemptId,
          leaseExpiresAt: this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
        })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sanitizedSessionId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.ownerId,
            sanitizedOwnerId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.fenceToken,
            validatedFenceToken,
          ),
          inArray(
            this.schema.sandboxSessionLifecycleOperations.phase,
            ['reserved', 'draining', 'executing'],
          ),
        ))
        .for('update');
      if (!operation) {
        return false;
      }
      if (operation.operation === 'adopt') {
        // Runtime adoption is a read/connect/cache barrier only. It must stay
        // reserved so recovery can always cancel it without performing a
        // destructive session transition.
        return false;
      }

      // Drain every in-flight mutation admitted by the reserved whitelist.
      // Delivery writers lock turn -> lease, so this uses the same order.
      let shouldInvalidateAllowedDelivery = false;
      if (operation.allowedTurnId) {
        const [allowedTurn] = await tx
          .select({
            turnId: this.schema.turns.id,
            completedAt: this.schema.turns.completedAt,
            deliveryOwnerId: this.schema.turns.deliveryOwnerId,
            deliveryFenceToken: this.schema.turns.deliveryFenceToken,
          })
          .from(this.schema.turns)
          .where(eq(this.schema.turns.id, operation.allowedTurnId))
          .for('update');
        if (
          !allowedTurn
          || allowedTurn.deliveryOwnerId !== operation.allowedDeliveryOwnerId
          || allowedTurn.deliveryFenceToken !== operation.allowedDeliveryFenceToken
        ) {
          return false;
        }
        const [allowedLease] = await tx
          .select({ turnId: this.schema.turnDeliveryLeases.turnId })
          .from(this.schema.turnDeliveryLeases)
          .where(and(
            eq(this.schema.turnDeliveryLeases.turnId, operation.allowedTurnId),
            eq(
              this.schema.turnDeliveryLeases.ownerId,
              operation.allowedDeliveryOwnerId ?? '',
            ),
            eq(
              this.schema.turnDeliveryLeases.fenceToken,
              operation.allowedDeliveryFenceToken ?? -1,
            ),
          ))
          .for('update');
        if (!allowedLease) {
          return false;
        }
        if (allowedTurn.completedAt === null) {
          if (operation.operation === 'checkpoint') {
            const [parkedInterrupt] = await tx
              .select({ id: this.schema.pendingInterrupts.id })
              .from(this.schema.pendingInterrupts)
              .where(and(
                eq(this.schema.pendingInterrupts.turnId, operation.allowedTurnId),
                inArray(this.schema.pendingInterrupts.status, ['pending', 'timed_out']),
              ))
              .limit(1);
            if (!parkedInterrupt) {
              return false;
            }
          } else if (
            operation.operation === 'reset'
            && operation.allowedInterruptResumeAttemptId
          ) {
            const [resumeAttempt] = await tx
              .select({
                id: this.schema.interruptResumeAttempts.id,
                interruptId: this.schema.interruptResumeAttempts.interruptId,
              })
              .from(this.schema.interruptResumeAttempts)
              .where(and(
                eq(
                  this.schema.interruptResumeAttempts.id,
                  operation.allowedInterruptResumeAttemptId,
                ),
                eq(
                  this.schema.interruptResumeAttempts.turnId,
                  operation.allowedTurnId,
                ),
                eq(
                  this.schema.interruptResumeAttempts.sandboxSessionId,
                  sanitizedSessionId,
                ),
                eq(this.schema.interruptResumeAttempts.status, 'in_progress'),
              ))
              .for('update');
            if (!resumeAttempt) {
              return false;
            }
            const [resolvedInterrupt] = await tx
              .select({ id: this.schema.pendingInterrupts.id })
              .from(this.schema.pendingInterrupts)
              .where(and(
                eq(this.schema.pendingInterrupts.id, resumeAttempt.interruptId),
                eq(this.schema.pendingInterrupts.turnId, operation.allowedTurnId),
                eq(this.schema.pendingInterrupts.status, 'resolved'),
              ))
              .for('update');
            if (!resolvedInterrupt) {
              return false;
            }
          } else {
            return false;
          }
          shouldInvalidateAllowedDelivery = true;
        }
      }

      const [session] = await tx
        .select({ sandboxSessionId: this.schema.sandboxSessions.id })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(this.schema.sandboxSessions.id, sanitizedSessionId),
          eq(this.schema.sandboxSessions.status, 'ACTIVE'),
        ))
        .limit(1);
      if (!session) {
        return false;
      }

      const [clock] = await tx
        .select({ nowMs: databaseClockMs() })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(eq(
          this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          sanitizedSessionId,
        ))
        .limit(1);
      if (!clock) {
        throw new Error('Database clock query returned no row');
      }
      const nowMs = parseDatabaseClockMs(clock.nowMs);
      if (operation.leaseExpiresAt <= nowMs) {
        return false;
      }
      if (shouldInvalidateAllowedDelivery && operation.allowedTurnId) {
        await tx
          .update(this.schema.turnDeliveryLeases)
          .set({
            leaseExpiresAt: nowMs,
            updatedAt: nowMs,
          })
          .where(and(
            eq(this.schema.turnDeliveryLeases.turnId, operation.allowedTurnId),
            eq(
              this.schema.turnDeliveryLeases.ownerId,
              operation.allowedDeliveryOwnerId ?? '',
            ),
            eq(
              this.schema.turnDeliveryLeases.fenceToken,
              operation.allowedDeliveryFenceToken ?? -1,
            ),
          ));
      }

      const [liveDelivery] = await tx
        .select({ turnId: this.schema.turns.id })
        .from(this.schema.turns)
        .innerJoin(
          this.schema.turnDeliveryLeases,
          and(
            eq(this.schema.turnDeliveryLeases.turnId, this.schema.turns.id),
            eq(this.schema.turnDeliveryLeases.ownerId, this.schema.turns.deliveryOwnerId),
            eq(this.schema.turnDeliveryLeases.fenceToken, this.schema.turns.deliveryFenceToken),
          ),
        )
        .where(and(
          eq(this.schema.turns.sandboxSessionId, sanitizedSessionId),
          eq(this.schema.turns.status, 'running'),
          isNull(this.schema.turns.completedAt),
          gt(this.schema.turnDeliveryLeases.leaseExpiresAt, nowMs),
        ))
        .limit(1);
      if (liveDelivery) {
        return false;
      }

      const activeResumes = await tx
        .select({ id: this.schema.interruptResumeAttempts.id })
        .from(this.schema.interruptResumeAttempts)
        .where(and(
          eq(
            this.schema.interruptResumeAttempts.sandboxSessionId,
            sanitizedSessionId,
          ),
          eq(this.schema.interruptResumeAttempts.status, 'in_progress'),
        ));
      if (activeResumes.some(
        (attempt) =>
          attempt.id !== operation.allowedInterruptResumeAttemptId,
      )) {
        return false;
      }

      const [updated] = await tx
        .update(this.schema.sandboxSessionLifecycleOperations)
        .set({
          phase: 'executing',
          updatedAt: nowMs,
        })
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sanitizedSessionId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.ownerId,
            sanitizedOwnerId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.fenceToken,
            validatedFenceToken,
          ),
          inArray(
            this.schema.sandboxSessionLifecycleOperations.phase,
            ['reserved', 'draining', 'executing'],
          ),
          gt(
            this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
            nowMs,
          ),
        ))
        .returning({
          sandboxSessionId: this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
        });
      return updated !== undefined;
    });
  }

  async cancelSandboxSessionLifecycleOperation(
    sandboxSessionId: string,
    ownerId: string,
    fenceToken: number,
  ): Promise<boolean> {
    const [cancelled] = await this.db
      .update(this.schema.sandboxSessionLifecycleOperations)
      .set({
        phase: 'completed',
        updatedAt: databaseClockMs(),
      })
      .where(and(
        eq(
          this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          sanitizeDbText(
            sandboxSessionId,
            'sandboxSessionLifecycleOperations.cancel.sandboxSessionId',
          ),
        ),
        eq(
          this.schema.sandboxSessionLifecycleOperations.ownerId,
          sanitizeDbText(
            ownerId,
            'sandboxSessionLifecycleOperations.cancel.ownerId',
          ),
        ),
        eq(
          this.schema.sandboxSessionLifecycleOperations.fenceToken,
          validateTurnDeliveryFenceToken(
            fenceToken,
            'sandboxSessionLifecycleOperations.cancel.fenceToken',
          ),
        ),
        or(
          eq(this.schema.sandboxSessionLifecycleOperations.phase, 'reserved'),
          and(
            eq(
              this.schema.sandboxSessionLifecycleOperations.operation,
              'adopt',
            ),
            inArray(
              this.schema.sandboxSessionLifecycleOperations.phase,
              ['draining', 'executing'],
            ),
          ),
        ),
        gt(
          this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
          databaseClockMs(),
        ),
      ))
      .returning({ sandboxSessionId: this.schema.sandboxSessionLifecycleOperations.sandboxSessionId });
    return cancelled !== undefined;
  }

  async completeSandboxSessionLifecycleOperation(input: {
    sandboxSessionId: string;
    ownerId: string;
    fenceToken: number;
    fromStatus: string;
    toStatus: string;
    extra?: {
      containerName?: string | null;
      containerId?: string | null;
      restoreAttempts?: number | null;
      lastRestoreError?: string | null;
    };
  }): Promise<boolean> {
    const sandboxSessionId = sanitizeDbText(
      input.sandboxSessionId,
      'sandboxSessionLifecycleOperations.complete.sandboxSessionId',
    );
    const ownerId = sanitizeDbText(
      input.ownerId,
      'sandboxSessionLifecycleOperations.complete.ownerId',
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      input.fenceToken,
      'sandboxSessionLifecycleOperations.complete.fenceToken',
    );
    const fromStatus = sanitizeDbText(
      input.fromStatus,
      'sandboxSessionLifecycleOperations.complete.fromStatus',
    );
    const toStatus = sanitizeDbText(
      input.toStatus,
      'sandboxSessionLifecycleOperations.complete.toStatus',
    );
    if (fromStatus !== 'ACTIVE') {
      throw new Error(
        `Sandbox lifecycle completion must leave ACTIVE, received ${fromStatus} -> ${toStatus}`,
      );
    }
    if (toStatus !== 'CHECKPOINTED' && toStatus !== 'TERMINATED') {
      throw new Error(
        `Sandbox lifecycle completion cannot transition ACTIVE -> ${toStatus}`,
      );
    }
    const extra = input.extra
      ? sanitizeTypedDbValue(
          input.extra,
          'sandboxSessionLifecycleOperations.complete.extra',
        )
      : undefined;

    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select({ sandboxSessionId: this.schema.sandboxSessions.id })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(this.schema.sandboxSessions.id, sandboxSessionId),
          eq(this.schema.sandboxSessions.status, fromStatus),
        ))
        .for('update');
      if (!session) {
        return false;
      }

      const [operation] = await tx
        .select({
          sandboxSessionId: this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          operation: this.schema.sandboxSessionLifecycleOperations.operation,
        })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sandboxSessionId,
          ),
          eq(this.schema.sandboxSessionLifecycleOperations.ownerId, ownerId),
          eq(this.schema.sandboxSessionLifecycleOperations.fenceToken, fenceToken),
          eq(this.schema.sandboxSessionLifecycleOperations.phase, 'executing'),
          gt(
            this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
            databaseClockMs(),
          ),
        ))
        .for('update');
      if (!operation) {
        return false;
      }
      if (
        operation.operation === 'terminate' && toStatus !== 'TERMINATED'
      ) {
        throw new Error(
          `Sandbox lifecycle operation ${operation.operation} cannot complete as ${toStatus}`,
        );
      }

      const nowMs = databaseClockMs();
      const [updated] = await tx
        .update(this.schema.sandboxSessions)
        .set({
          status: toStatus,
          updatedAt: nowMs,
          lastActivityAt: nowMs,
          ...(extra?.containerName !== undefined
            ? { containerName: extra.containerName }
            : {}),
          ...(extra?.containerId !== undefined
            ? { containerId: extra.containerId }
            : {}),
          ...(extra?.restoreAttempts !== undefined && extra.restoreAttempts !== null
            ? { restoreAttempts: extra.restoreAttempts }
            : {}),
          ...(extra?.lastRestoreError !== undefined
            ? { lastRestoreError: extra.lastRestoreError }
            : {}),
        })
        .where(and(
          eq(this.schema.sandboxSessions.id, sandboxSessionId),
          eq(this.schema.sandboxSessions.status, fromStatus),
        ))
        .returning({ sandboxSessionId: this.schema.sandboxSessions.id });
      if (!updated) {
        return false;
      }

      await tx
        .update(this.schema.sandboxSessionLifecycleOperations)
        .set({
          phase: 'completed',
          updatedAt: nowMs,
        })
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sandboxSessionId,
          ),
          eq(this.schema.sandboxSessionLifecycleOperations.ownerId, ownerId),
          eq(this.schema.sandboxSessionLifecycleOperations.fenceToken, fenceToken),
          eq(this.schema.sandboxSessionLifecycleOperations.phase, 'executing'),
        ));
      return true;
    });
  }

  /**
   * Atomically claim delivery ownership for one open turn.
   *
   * The turn row adopts the returned monotonic token in the same transaction,
   * so every later state/event/message mutation can fence against it.
   */
  async claimTurnDeliveryLease(input: {
    turnId: string;
    ownerId: string;
    leaseDurationMs: number;
  }): Promise<TurnDeliveryLeaseRow | undefined> {
    const turnId = sanitizeDbText(input.turnId, 'turnDeliveryLeases.turnId');
    const ownerId = sanitizeDbText(input.ownerId, 'turnDeliveryLeases.ownerId');
    const leaseDurationMs = validateLeaseDurationMs(
      input.leaseDurationMs,
      'turnDeliveryLeases.leaseDurationMs',
    );

    return this.db.transaction(async (tx) => {
      // All fenced turn/lease mutations lock the turn before the lease. Besides
      // making claim-vs-finalize atomic, the shared order avoids deadlocks.
      const [eligibleTurn] = await tx
        .select({ turnId: this.schema.turns.id })
        .from(this.schema.turns)
        .where(and(
          eq(this.schema.turns.id, turnId),
          isNull(this.schema.turns.completedAt),
          sql<boolean>`NOT EXISTS (
            SELECT 1
            FROM ${this.schema.pendingInterrupts}
            LEFT JOIN ${this.schema.interruptResumeAttempts}
              ON ${this.schema.interruptResumeAttempts.interruptId} = ${this.schema.pendingInterrupts.id}
            WHERE ${this.schema.pendingInterrupts.turnId} = ${this.schema.turns.id}
              AND (
                ${this.schema.pendingInterrupts.status} IN ('pending', 'timed_out')
                OR ${this.schema.interruptResumeAttempts.status} IN ('pending', 'in_progress', 'failed')
              )
          )`,
          sql<boolean>`NOT EXISTS (
            SELECT 1
            FROM ${this.schema.sandboxSessionLifecycleOperations}
            WHERE ${this.schema.sandboxSessionLifecycleOperations.sandboxSessionId}
              = ${this.schema.turns.sandboxSessionId}
              AND ${this.schema.sandboxSessionLifecycleOperations.phase} <> 'completed'
          )`,
        ))
        .for('update');
      if (!eligibleTurn) {
        return undefined;
      }

      const [clock] = await tx
        .select({ nowMs: databaseClockMs() })
        .from(this.schema.turns)
        .where(eq(this.schema.turns.id, turnId))
        .limit(1);
      if (!clock) {
        throw new Error('Database clock query returned no row');
      }
      const nowMs = parseDatabaseClockMs(clock.nowMs);
      const leaseExpiresAt = nowMs + leaseDurationMs;
      const [claimed] = await tx
        .insert(this.schema.turnDeliveryLeases)
        .values({
          turnId,
          ownerId,
          fenceToken: 1,
          leaseExpiresAt,
          updatedAt: nowMs,
        })
        .onConflictDoUpdate({
          target: this.schema.turnDeliveryLeases.turnId,
          set: {
            ownerId,
            fenceToken: sql<number>`
              CASE
                WHEN ${this.schema.turnDeliveryLeases.fenceToken} > 0
                  AND ${this.schema.turnDeliveryLeases.ownerId} = ${ownerId}
                  AND ${this.schema.turnDeliveryLeases.leaseExpiresAt} > ${nowMs}
                THEN ${this.schema.turnDeliveryLeases.fenceToken}
                ELSE ${this.schema.turnDeliveryLeases.fenceToken} + 1
              END
            `,
            leaseExpiresAt,
            updatedAt: nowMs,
          },
          setWhere: or(
            lte(this.schema.turnDeliveryLeases.leaseExpiresAt, nowMs),
            eq(this.schema.turnDeliveryLeases.ownerId, ownerId),
          ),
        })
        .returning();
      if (claimed) {
        await tx
          .update(this.schema.turns)
          .set({
            deliveryOwnerId: claimed.ownerId,
            deliveryFenceToken: claimed.fenceToken,
          })
          .where(and(
            eq(this.schema.turns.id, turnId),
            isNull(this.schema.turns.completedAt),
          ));
      }
      return claimed;
    });
  }

  async renewTurnDeliveryLease(
    turnId: string,
    ownerId: string,
    fenceToken: number,
    leaseDurationMs: number,
  ): Promise<TurnDeliveryLeaseRow | undefined> {
    const durationMs = validateLeaseDurationMs(
      leaseDurationMs,
      'turnDeliveryLeases.renew.leaseDurationMs',
    );
    const [renewed] = await this.db
      .update(this.schema.turnDeliveryLeases)
      .set({
        leaseExpiresAt: sql`${databaseClockMs()} + ${durationMs}`,
        updatedAt: databaseClockMs(),
      })
      .where(and(
        eq(
          this.schema.turnDeliveryLeases.turnId,
          sanitizeDbText(turnId, 'turnDeliveryLeases.renew.turnId'),
        ),
        eq(
          this.schema.turnDeliveryLeases.ownerId,
          sanitizeDbText(ownerId, 'turnDeliveryLeases.renew.ownerId'),
        ),
        eq(
          this.schema.turnDeliveryLeases.fenceToken,
          validateTurnDeliveryFenceToken(
            fenceToken,
            'turnDeliveryLeases.renew.fenceToken',
          ),
        ),
        gt(this.schema.turnDeliveryLeases.leaseExpiresAt, databaseClockMs()),
        sql<boolean>`EXISTS (
          SELECT 1
          FROM ${this.schema.turns}
          WHERE ${this.schema.turns.id} = ${this.schema.turnDeliveryLeases.turnId}
            AND ${this.schema.turns.completedAt} IS NULL
            AND ${this.schema.turns.deliveryOwnerId} = ${sanitizeDbText(
              ownerId,
              'turnDeliveryLeases.renew.ownerId',
            )}
            AND ${this.schema.turns.deliveryFenceToken} = ${validateTurnDeliveryFenceToken(
              fenceToken,
              'turnDeliveryLeases.renew.fenceToken',
            )}
            AND ${this.deliveryAdmittedByLifecycleOperation()}
            AND (
              ${this.schema.turns.sandboxSessionId} IS NULL
              OR EXISTS (
                SELECT 1
                FROM ${this.schema.sandboxSessions}
                WHERE ${this.schema.sandboxSessions.id} = ${this.schema.turns.sandboxSessionId}
                  AND ${this.schema.sandboxSessions.status} = 'ACTIVE'
              )
            )
        )`,
      ))
      .returning();
    return renewed;
  }

  /**
   * Atomically admit one turn delivery.
   *
   * Only a genuinely queued turn may cross the delivery boundary. An expired
   * running turn is fenced-finalized for explicit retry, never re-executed.
   */
  async activateTurnDelivery(
    input: {
      turnId: string;
      sandboxSessionId: string;
      ownerId: string;
      fenceToken: number;
      expectedActiveGeneration: SandboxSessionActiveGeneration;
    },
  ): Promise<boolean> {
    const sanitizedTurnId = sanitizeDbText(
      input.turnId,
      'turnDeliveryLeases.activate.turnId',
    );
    const sanitizedOwnerId = sanitizeDbText(
      input.ownerId,
      'turnDeliveryLeases.activate.ownerId',
    );
    const sanitizedSandboxSessionId = sanitizeDbText(
      input.sandboxSessionId,
      'turnDeliveryLeases.activate.sandboxSessionId',
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      input.fenceToken,
      'turnDeliveryLeases.activate.fenceToken',
    );
    const expectedRestoreFenceToken = validateNonNegativeSafeInteger(
      input.expectedActiveGeneration.restoreFenceToken,
      'turnDeliveryLeases.activate.restoreFenceToken',
    );
    const expectedContainerId =
      input.expectedActiveGeneration.containerId === null
        ? null
        : sanitizeDbText(
            input.expectedActiveGeneration.containerId,
            'turnDeliveryLeases.activate.containerId',
          );
    try {
      return await this.db.transaction(async (tx) => {
      // A conversation row is the global ordered-stream admission boundary.
      // Read the immutable target first, then lock the conversation before the
      // sandbox row so replicas racing through different sessions serialize.
      const [candidateTurn] = await tx
        .select({
          conversationId: this.schema.turns.conversationId,
        })
        .from(this.schema.turns)
        .where(eq(this.schema.turns.id, sanitizedTurnId))
        .limit(1);
      if (!candidateTurn?.conversationId) {
        return false;
      }
      const [conversation] = await tx
        .select({
          conversationId: this.schema.conversations.id,
          agentId: this.schema.conversations.agentId,
        })
        .from(this.schema.conversations)
        .where(eq(
          this.schema.conversations.id,
          candidateTurn.conversationId,
        ))
        .for('update');
      if (!conversation) {
        return false;
      }

      // Session-row ownership is the common serialization boundary shared
      // with lifecycle intent claim. Check the intent in a second statement
      // after acquiring the row lock so READ COMMITTED cannot retain a stale
      // pre-wait subquery snapshot.
      const [session] = await tx
        .select({
          sandboxSessionId: this.schema.sandboxSessions.id,
          agentId: this.schema.sandboxSessions.agentId,
          conversationId: this.schema.sandboxSessions.conversationId,
          restoreFenceToken: this.schema.sandboxSessions.restoreFenceToken,
          containerId: this.schema.sandboxSessions.containerId,
        })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(this.schema.sandboxSessions.id, sanitizedSandboxSessionId),
          eq(this.schema.sandboxSessions.status, 'ACTIVE'),
        ))
        .for('update');
      if (!session) {
        return false;
      }
      if (
        session.restoreFenceToken !== expectedRestoreFenceToken
        || session.containerId !== expectedContainerId
        ||
        session.agentId !== conversation.agentId
        || session.conversationId !== conversation.conversationId
      ) {
        return false;
      }

      const [lifecycleOperation] = await tx
        .select({
          sandboxSessionId:
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
        })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sanitizedSandboxSessionId,
          ),
          inArray(
            this.schema.sandboxSessionLifecycleOperations.phase,
            ['reserved', 'draining', 'executing'],
          ),
        ))
        .limit(1);
      if (lifecycleOperation) {
        return false;
      }

      // A conversation is a single ordered harness stream. The conversation
      // lock serializes competing admissions; reject a second open running
      // turn even if it is bound to another session or its lease has expired.
      // Recovery must explicitly settle or rebind the stranded turn first.
      const [openRunningTurn] = await tx
        .select({ turnId: this.schema.turns.id })
        .from(this.schema.turns)
        .where(and(
          eq(this.schema.turns.conversationId, conversation.conversationId),
          eq(this.schema.turns.status, 'running'),
          isNull(this.schema.turns.completedAt),
          sql<boolean>`${this.schema.turns.id} <> ${sanitizedTurnId}`,
        ))
        .limit(1);
      if (openRunningTurn) {
        return false;
      }

      const [turn] = await tx
        .select({ turnId: this.schema.turns.id })
        .from(this.schema.turns)
        .where(and(
          eq(this.schema.turns.id, sanitizedTurnId),
          eq(this.schema.turns.agentId, session.agentId),
          eq(
            this.schema.turns.conversationId,
            conversation.conversationId,
          ),
          isNull(this.schema.turns.completedAt),
          eq(this.schema.turns.status, 'queued'),
          eq(this.schema.turns.deliveryOwnerId, sanitizedOwnerId),
          eq(this.schema.turns.deliveryFenceToken, fenceToken),
          sql<boolean>`NOT EXISTS (
            SELECT 1
            FROM ${this.schema.pendingInterrupts}
            LEFT JOIN ${this.schema.interruptResumeAttempts}
              ON ${this.schema.interruptResumeAttempts.interruptId} = ${this.schema.pendingInterrupts.id}
            WHERE ${this.schema.pendingInterrupts.turnId} = ${this.schema.turns.id}
              AND (
                ${this.schema.pendingInterrupts.status} IN ('pending', 'timed_out')
                OR ${this.schema.interruptResumeAttempts.status} IN ('pending', 'in_progress', 'failed')
              )
          )`,
        ))
        .for('update');
      if (!turn) {
        return false;
      }

      const [lease] = await tx
        .select({
          leaseExpiresAt: this.schema.turnDeliveryLeases.leaseExpiresAt,
        })
        .from(this.schema.turnDeliveryLeases)
        .where(and(
          eq(this.schema.turnDeliveryLeases.turnId, sanitizedTurnId),
          eq(this.schema.turnDeliveryLeases.ownerId, sanitizedOwnerId),
          eq(this.schema.turnDeliveryLeases.fenceToken, fenceToken),
          gt(this.schema.turnDeliveryLeases.leaseExpiresAt, databaseClockMs()),
        ))
        .for('update');
      if (!lease) {
        return false;
      }

      const activated = await tx
        .update(this.schema.turns)
        .set({
          status: 'running',
          sandboxSessionId: sanitizedSandboxSessionId,
          deliveryOwnerId: sanitizedOwnerId,
          deliveryFenceToken: fenceToken,
        })
        .where(and(
          eq(this.schema.turns.id, sanitizedTurnId),
          isNull(this.schema.turns.completedAt),
        ))
        .returning({ turnId: this.schema.turns.id });
      return activated.length > 0;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error, RUNNING_CONVERSATION_TURN_INDEX)) {
        return false;
      }
      throw error;
    }
  }

  async isTurnDeliveryFenceCurrent(
    turnId: string,
    fence: { ownerId: string; fenceToken: number },
  ): Promise<boolean> {
    const sanitizedTurnId = sanitizeDbText(
      turnId,
      'turnDeliveryLeases.current.turnId',
    );
    const sanitizedOwnerId = sanitizeDbText(
      fence.ownerId,
      'turnDeliveryLeases.current.ownerId',
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      fence.fenceToken,
      'turnDeliveryLeases.current.fenceToken',
    );
    const [current] = await this.db
      .select({ turnId: this.schema.turns.id })
      .from(this.schema.turns)
      .where(and(
        eq(this.schema.turns.id, sanitizedTurnId),
        isNull(this.schema.turns.completedAt),
        eq(this.schema.turns.deliveryOwnerId, sanitizedOwnerId),
        eq(this.schema.turns.deliveryFenceToken, fenceToken),
        this.deliveryAdmittedByLifecycleOperation(),
        or(
          isNull(this.schema.turns.sandboxSessionId),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM ${this.schema.sandboxSessions}
            WHERE ${this.schema.sandboxSessions.id} = ${this.schema.turns.sandboxSessionId}
              AND ${this.schema.sandboxSessions.status} = 'ACTIVE'
          )`,
        ),
        sql<boolean>`EXISTS (
          SELECT 1
          FROM ${this.schema.turnDeliveryLeases}
          WHERE ${this.schema.turnDeliveryLeases.turnId} = ${this.schema.turns.id}
            AND ${this.schema.turnDeliveryLeases.ownerId} = ${sanitizedOwnerId}
            AND ${this.schema.turnDeliveryLeases.fenceToken} = ${fenceToken}
            AND ${this.schema.turnDeliveryLeases.leaseExpiresAt} > ${databaseClockMs()}
        )`,
      ))
      .limit(1);
    return current !== undefined;
  }

  /**
   * Report whether this exact delivery generation durably finalized the turn.
   *
   * Successful finalization intentionally makes `isTurnDeliveryFenceCurrent`
   * false because the turn is no longer open. Recovery workers use this
   * predicate to distinguish that success from ownership loss after an
   * awaitable redispatch returns.
   */
  async wasTurnFinalizedByDeliveryFence(
    turnId: string,
    fence: { ownerId: string; fenceToken: number },
  ): Promise<boolean> {
    const [finalized] = await this.db
      .select({ turnId: this.schema.turns.id })
      .from(this.schema.turns)
      .where(and(
        eq(
          this.schema.turns.id,
          sanitizeDbText(
            turnId,
            'turnDeliveryLeases.finalized.turnId',
          ),
        ),
        isNotNull(this.schema.turns.completedAt),
        eq(
          this.schema.turns.deliveryOwnerId,
          sanitizeDbText(
            fence.ownerId,
            'turnDeliveryLeases.finalized.ownerId',
          ),
        ),
        eq(
          this.schema.turns.deliveryFenceToken,
          validateTurnDeliveryFenceToken(
            fence.fenceToken,
            'turnDeliveryLeases.finalized.fenceToken',
          ),
        ),
      ))
      .limit(1);
    return finalized !== undefined;
  }

  async updateTurnIfDeliveryOwned(
    turnId: string,
    fence: { ownerId: string; fenceToken: number },
    updates: Partial<Omit<
      TurnInsert,
      'id' | 'deliveryOwnerId' | 'deliveryFenceToken'
    >>,
  ): Promise<TurnSelect | undefined> {
    const sanitizedTurnId = sanitizeDbText(
      turnId,
      'turnDeliveryLeases.update.turnId',
    );
    const sanitizedOwnerId = sanitizeDbText(
      fence.ownerId,
      'turnDeliveryLeases.update.ownerId',
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      fence.fenceToken,
      'turnDeliveryLeases.update.fenceToken',
    );
    const sanitizedUpdates = sanitizeTypedDbValue(updates, 'turns.deliveryUpdate');
    return this.db.transaction(async (tx) => {
      if (!await this.lockCurrentDeliveryFence(
        tx,
        sanitizedTurnId,
        { ownerId: sanitizedOwnerId, fenceToken },
        'turnDeliveryLeases.update',
      )) {
        return undefined;
      }

      const [updated] = await tx
        .update(this.schema.turns)
        .set(sanitizedUpdates)
        .where(and(
          eq(this.schema.turns.id, sanitizedTurnId),
          isNull(this.schema.turns.completedAt),
          eq(this.schema.turns.deliveryOwnerId, sanitizedOwnerId),
          eq(this.schema.turns.deliveryFenceToken, fenceToken),
        ))
        .returning();
      return updated;
    });
  }

  async releaseTurnDeliveryLease(
    turnId: string,
    ownerId: string,
    fenceToken: number,
  ): Promise<boolean> {
    const released = await this.db
      .update(this.schema.turnDeliveryLeases)
      .set({
        leaseExpiresAt: databaseClockMs(),
        updatedAt: databaseClockMs(),
      })
      .where(and(
        eq(
          this.schema.turnDeliveryLeases.turnId,
          sanitizeDbText(turnId, 'turnDeliveryLeases.release.turnId'),
        ),
        eq(
          this.schema.turnDeliveryLeases.ownerId,
          sanitizeDbText(ownerId, 'turnDeliveryLeases.release.ownerId'),
        ),
        eq(
          this.schema.turnDeliveryLeases.fenceToken,
          validateTurnDeliveryFenceToken(
            fenceToken,
            'turnDeliveryLeases.release.fenceToken',
          ),
        ),
        gt(this.schema.turnDeliveryLeases.leaseExpiresAt, databaseClockMs()),
      ))
      .returning({ turnId: this.schema.turnDeliveryLeases.turnId });
    return released.length > 0;
  }

  /** Terminal rows whose canonical RUN_ERROR/RUN_FINISHED batch is not durable yet. */
  async getTurnsPendingCanonicalTerminalPublish(): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany({
      where: and(
        isNotNull(this.schema.turns.completedAt),
        isNull(this.schema.turns.terminalPublishedSeq),
      ),
      orderBy: (turns) => [asc(turns.completedAt), asc(turns.startedAt), asc(turns.id)],
    });
  }

  /**
   * Terminal-state write guarded at the database: only an open turn is
   * updated. Returns false when the turn was already terminal or missing —
   * the primitive TurnFinalizer builds on (ADR-014).
   */
  async finalizeTurnIfOpen(
    id: string,
    updates: {
      sandboxSessionId?: string;
      completedAt: number;
      error: string | null;
      status: Exclude<TurnStatus, 'queued' | 'running'>;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
      usage?: TurnUsage | null;
    },
    expectedFence?: {
      ownerId: string;
      fenceToken: number;
    },
  ): Promise<boolean> {
    const sanitizedUpdates = sanitizeTypedDbValue(updates, 'turns.finalize');
    const turnId = sanitizeDbText(id, 'turns.finalize.id');
    if (!expectedFence) {
      return this.db.transaction(async (tx) => {
        const updated = await tx
          .update(this.schema.turns)
          .set(sanitizedUpdates)
          .where(and(
            eq(this.schema.turns.id, turnId),
            isNull(this.schema.turns.completedAt),
          ))
          .returning({ id: this.schema.turns.id });
        if (updated.length === 0) {
          return false;
        }
        await tx
          .delete(this.schema.turnSecretEnvelopes)
          .where(eq(this.schema.turnSecretEnvelopes.turnId, turnId));
        return true;
      });
    }

    const ownerId = sanitizeDbText(
      expectedFence.ownerId,
      'turnDeliveryLeases.finalize.ownerId',
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      expectedFence.fenceToken,
      'turnDeliveryLeases.finalize.fenceToken',
    );
    return this.db.transaction(async (tx) => {
      if (!await this.lockCurrentDeliveryFence(
        tx,
        turnId,
        { ownerId, fenceToken },
        'turnDeliveryLeases.finalize',
      )) {
        return false;
      }

      const updated = await tx
        .update(this.schema.turns)
        .set(sanitizedUpdates)
        .where(and(
          eq(this.schema.turns.id, turnId),
          isNull(this.schema.turns.completedAt),
          eq(this.schema.turns.deliveryOwnerId, ownerId),
          eq(this.schema.turns.deliveryFenceToken, fenceToken),
        ))
        .returning({ id: this.schema.turns.id });
      if (updated.length === 0) {
        return false;
      }
      await tx
        .delete(this.schema.turnSecretEnvelopes)
        .where(eq(this.schema.turnSecretEnvelopes.turnId, turnId));
      return true;
    });
  }

  /**
   * Close an exactly-owned stranded turn and durably advance its pre-reserved
   * sandbox reset in the same transaction.
   *
   * Lock order is session -> lifecycle operation -> turn -> delivery lease.
   * Once this commits, lifecycle recovery must complete the reset even if the
   * worker crashes before it can contact the sandbox.
   */
  async finalizeTurnAndMarkLifecycleDraining(
    id: string,
    updates: {
      sandboxSessionId?: string;
      completedAt: number;
      error: string | null;
      status: Exclude<TurnStatus, 'queued' | 'running'>;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
      usage?: TurnUsage | null;
    },
    expectedFence: ExpectedTurnDeliveryFence,
    lifecycleOperation: {
      sandboxSessionId: string;
      ownerId: string;
      fenceToken: number;
    },
  ): Promise<boolean> {
    const turnId = sanitizeDbText(id, 'turns.lifecycleFinalize.id');
    const sanitizedUpdates = sanitizeTypedDbValue(
      updates,
      'turns.lifecycleFinalize',
    );
    const deliveryOwnerId = sanitizeDbText(
      expectedFence.ownerId,
      'turns.lifecycleFinalize.deliveryOwnerId',
    );
    const deliveryFenceToken = validateTurnDeliveryFenceToken(
      expectedFence.fenceToken,
      'turns.lifecycleFinalize.deliveryFenceToken',
    );
    const sandboxSessionId = sanitizeDbText(
      lifecycleOperation.sandboxSessionId,
      'turns.lifecycleFinalize.sandboxSessionId',
    );
    const lifecycleOwnerId = sanitizeDbText(
      lifecycleOperation.ownerId,
      'turns.lifecycleFinalize.lifecycleOwnerId',
    );
    const lifecycleFenceToken = validateTurnDeliveryFenceToken(
      lifecycleOperation.fenceToken,
      'turns.lifecycleFinalize.lifecycleFenceToken',
    );

    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select({ sandboxSessionId: this.schema.sandboxSessions.id })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(this.schema.sandboxSessions.id, sandboxSessionId),
          eq(this.schema.sandboxSessions.status, 'ACTIVE'),
        ))
        .for('update');
      if (!session) {
        return false;
      }

      const [operation] = await tx
        .select({
          sandboxSessionId:
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          leaseExpiresAt:
            this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
        })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sandboxSessionId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.operation,
            'reset',
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.phase,
            'reserved',
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.ownerId,
            lifecycleOwnerId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.fenceToken,
            lifecycleFenceToken,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.allowedTurnId,
            turnId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.allowedDeliveryOwnerId,
            deliveryOwnerId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.allowedDeliveryFenceToken,
            deliveryFenceToken,
          ),
        ))
        .for('update');
      if (!operation) {
        return false;
      }

      if (!await this.lockCurrentDeliveryFence(
        tx,
        turnId,
        {
          ownerId: deliveryOwnerId,
          fenceToken: deliveryFenceToken,
        },
        'turns.lifecycleFinalize.deliveryFence',
      )) {
        return false;
      }

      const [clock] = await tx
        .select({ nowMs: databaseClockMs() })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(eq(
          this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          sandboxSessionId,
        ))
        .limit(1);
      if (!clock) {
        throw new Error('Database clock query returned no row');
      }
      const nowMs = parseDatabaseClockMs(clock.nowMs);
      if (operation.leaseExpiresAt <= nowMs) {
        return false;
      }

      const [updatedTurn] = await tx
        .update(this.schema.turns)
        .set(sanitizedUpdates)
        .where(and(
          eq(this.schema.turns.id, turnId),
          eq(this.schema.turns.sandboxSessionId, sandboxSessionId),
          isNull(this.schema.turns.completedAt),
          eq(this.schema.turns.deliveryOwnerId, deliveryOwnerId),
          eq(this.schema.turns.deliveryFenceToken, deliveryFenceToken),
        ))
        .returning({ id: this.schema.turns.id });
      if (!updatedTurn) {
        return false;
      }
      await tx
        .delete(this.schema.turnSecretEnvelopes)
        .where(eq(this.schema.turnSecretEnvelopes.turnId, turnId));

      const [draining] = await tx
        .update(this.schema.sandboxSessionLifecycleOperations)
        .set({
          phase: 'draining',
          updatedAt: nowMs,
        })
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sandboxSessionId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.operation,
            'reset',
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.phase,
            'reserved',
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.ownerId,
            lifecycleOwnerId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.fenceToken,
            lifecycleFenceToken,
          ),
          gt(
            this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
            nowMs,
          ),
        ))
        .returning({
          sandboxSessionId:
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
        });
      if (!draining) {
        throw new Error(
          `Lifecycle reset ${sandboxSessionId} lost ownership during turn finalization`,
        );
      }
      return true;
    });
  }

  async getTurn(id: string): Promise<TurnSelect | undefined> {
    return this.db.query.turns.findFirst({
      where: eq(this.schema.turns.id, id),
    });
  }

  /**
   * Atomically claims an agent-scoped idempotency key. A conflict returns the
   * durable original row so the caller can replay it or reject a hash mismatch.
   */
  async claimTurnStartRequest(
    data: TurnStartRequestInsert,
  ): Promise<{ claimed: boolean; request: TurnStartRequestRow }> {
    const sanitizedData = sanitizeTypedDbValue(data, 'turnStartRequests.insert');
    const [inserted] = await this.db
      .insert(this.schema.turnStartRequests)
      .values(sanitizedData)
      .onConflictDoNothing({
        target: [
          this.schema.turnStartRequests.agentId,
          this.schema.turnStartRequests.idempotencyKey,
        ],
      })
      .returning();
    if (inserted) {
      return { claimed: true, request: inserted };
    }

    const existing = await this.db.query.turnStartRequests.findFirst({
      where: and(
        eq(this.schema.turnStartRequests.agentId, sanitizedData.agentId),
        eq(this.schema.turnStartRequests.idempotencyKey, sanitizedData.idempotencyKey),
      ),
    });
    if (!existing) {
      throw new Error('Idempotency key conflict did not resolve to a turn start request');
    }
    return { claimed: false, request: existing };
  }

  async getTurnStartRequest(
    agentId: string,
    idempotencyKey: string,
  ): Promise<TurnStartRequestRow | undefined> {
    return this.db.query.turnStartRequests.findFirst({
      where: and(
        eq(this.schema.turnStartRequests.agentId, agentId),
        eq(this.schema.turnStartRequests.idempotencyKey, idempotencyKey),
      ),
    });
  }

  async completeTurnStartRequest(
    id: string,
    requestHash: string,
    response: Record<string, unknown>,
  ): Promise<TurnStartRequestRow> {
    const [updated] = await this.db
      .update(this.schema.turnStartRequests)
      .set({
        status: 'prepared',
        response: sanitizeDbJsonValue(response, 'turnStartRequests.response') as Record<string, unknown>,
        updatedAt: Date.now(),
      })
      .where(and(
        eq(this.schema.turnStartRequests.id, id),
        eq(this.schema.turnStartRequests.requestHash, requestHash),
        eq(this.schema.turnStartRequests.status, 'preparing'),
      ))
      .returning();
    if (!updated) {
      throw new Error(`Turn start request ${id} could not transition to prepared`);
    }
    return updated;
  }

  async abandonTurnStartRequest(id: string, requestHash: string): Promise<void> {
    await this.db
      .delete(this.schema.turnStartRequests)
      .where(and(
        eq(this.schema.turnStartRequests.id, id),
        eq(this.schema.turnStartRequests.requestHash, requestHash),
        eq(this.schema.turnStartRequests.status, 'preparing'),
      ));
  }

  async getActiveTurnsForAgent(agentId: string): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany({
      where: and(eq(this.schema.turns.agentId, agentId), isNull(this.schema.turns.completedAt)),
    });
  }

  async getConversationCount(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(this.schema.conversations)
      .where(eq(this.schema.conversations.agentId, agentId));
    return rows[0]?.count ?? 0;
  }

  // ── Event Store ──────────────────────────────────────────

  /**
   * Batch-persist canonical frames in one round trip (ADR-015). Returns the
   * assigned global seqs in input order.
   */
  async saveEventBatch(frames: EventFrameInsert[]): Promise<number[]> {
    if (frames.length === 0) {
      return [];
    }
    const agentId = eventBatchAgentId(frames);
    return this.db.transaction(async (tx) => {
      const now = Date.now();
      await tx
        .insert(this.schema.agentEventHeads)
        .values({ agentId, committedSeq: 0, updatedAt: now })
        .onConflictDoNothing();
      const [lockedHead] = await tx
        .select({ agentId: this.schema.agentEventHeads.agentId })
        .from(this.schema.agentEventHeads)
        .where(eq(this.schema.agentEventHeads.agentId, agentId))
        .for('update');
      if (!lockedHead) {
        throw new Error(`Cannot lock canonical event head for agent ${agentId}`);
      }
      const rows = await tx
        .insert(this.schema.eventStore)
        .values(frames.map((frame) => ({
          type: sanitizeDbText(frame.type, 'eventStore.type'),
          agentId,
          payload: sanitizeDbText(frame.payload, 'eventStore.payload'),
          createdAt: now,
          turnId: frame.turnId ?? null,
          conversationId: frame.conversationId ?? null,
          channel: frame.channel ?? 'system',
          sourceType: sanitizeOptionalDbText(frame.sourceType ?? null, 'eventStore.sourceType'),
          sourcePayload: sanitizeOptionalDbText(frame.sourcePayload ?? null, 'eventStore.sourcePayload'),
        })))
        .returning({ seq: this.schema.eventStore.seq });
      const committedSeq = rows.at(-1)?.seq;
      if (committedSeq == null) {
        throw new Error(`Canonical event insert for agent ${agentId} returned no sequence`);
      }
      await tx
        .update(this.schema.agentEventHeads)
        .set({ committedSeq, updatedAt: Date.now() })
        .where(eq(this.schema.agentEventHeads.agentId, agentId));
      return rows.map((row) => row.seq);
    });
  }

  /**
   * Persist repeatable delivery frames only while their owner/token is live.
   *
   * Unlike the startup-publication primitive below, this intentionally does
   * not deduplicate provenance: tool/custom/text deltas may legitimately
   * repeat. The event head and delivery fence are locked in the same
   * transaction as frame insertion.
   */
  async saveFencedEventBatch(
    frames: EventFrameInsert[],
    expectedDeliveryFence: ExpectedTurnDeliveryFence,
    expectedSandboxDelivery?: ExpectedSandboxCallbackGeneration,
  ): Promise<number[]> {
    if (frames.length === 0) {
      return [];
    }
    const agentId = eventBatchAgentId(frames);
    const turnId = eventBatchTurnId(frames);
    try {
      return await this.db.transaction(async (tx) => {
        const lockTimestamp = Date.now();
        await tx
          .insert(this.schema.agentEventHeads)
          .values({ agentId, committedSeq: 0, updatedAt: lockTimestamp })
          .onConflictDoNothing();
        const [lockedHead] = await tx
          .select({ agentId: this.schema.agentEventHeads.agentId })
          .from(this.schema.agentEventHeads)
          .where(eq(this.schema.agentEventHeads.agentId, agentId))
          .for('update');
        if (!lockedHead) {
          throw new Error(`Cannot lock canonical event head for agent ${agentId}`);
        }
        const ownsDelivery = expectedSandboxDelivery
          ? await this.lockExactSandboxCallbackDelivery(
            tx,
            {
              turnId,
              sandboxSessionId: expectedSandboxDelivery.sandboxSessionId,
              agentId,
              expectedDeliveryFence,
              expectedActiveGeneration:
                expectedSandboxDelivery.expectedActiveGeneration,
            },
            'eventStore.sandboxCallback',
          )
          : await this.lockCurrentDeliveryFence(
            tx,
            turnId,
            expectedDeliveryFence,
            'eventStore.deliveryFence',
          );
        if (!ownsDelivery) {
          // Roll back the event-head bootstrap as well as the frame insert.
          // Returning from this transaction would leave a durable mutation
          // for a rejected callback when this agent has no prior events.
          if (expectedSandboxDelivery) {
            throw STALE_SANDBOX_CALLBACK_DELIVERY;
          }
          return [];
        }

        const now = Date.now();
        const rows = await tx
          .insert(this.schema.eventStore)
          .values(frames.map((frame) => ({
            type: sanitizeDbText(frame.type, 'eventStore.type'),
            agentId,
            payload: sanitizeDbText(frame.payload, 'eventStore.payload'),
            createdAt: now,
            turnId,
            conversationId: frame.conversationId ?? null,
            channel: frame.channel ?? 'system',
            sourceType: sanitizeOptionalDbText(frame.sourceType ?? null, 'eventStore.sourceType'),
            sourcePayload: sanitizeOptionalDbText(frame.sourcePayload ?? null, 'eventStore.sourcePayload'),
          })))
          .returning({ seq: this.schema.eventStore.seq });
        const committedSeq = rows.at(-1)?.seq;
        if (committedSeq == null) {
          throw new Error(`Fenced canonical event insert for agent ${agentId} returned no sequence`);
        }
        await tx
          .update(this.schema.agentEventHeads)
          .set({ committedSeq, updatedAt: Date.now() })
          .where(eq(this.schema.agentEventHeads.agentId, agentId));
        return rows.map((row) => row.seq);
      });
    } catch (err) {
      if (err === STALE_SANDBOX_CALLBACK_DELIVERY) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Persist one recovery-only startup publication exactly once.
   *
   * This deliberately does not change saveEventBatch semantics: arbitrary
   * custom and tool events remain repeatable even when their provenance is
   * identical.
   */
  async saveRecoveryEventBatch(
    frames: EventFrameInsert[],
    publication: {
      turnId: string;
      sourceType: 'user.message' | 'turn.started';
      ownerId: string;
      fenceToken: number;
    },
  ): Promise<number[]> {
    if (frames.length === 0) {
      throw new Error('Recovery startup publication requires at least one frame');
    }
    const turnId = sanitizeDbText(publication.turnId, 'eventStore.recovery.turnId');
    const { sourceType } = publication;
    if (sourceType !== 'user.message' && sourceType !== 'turn.started') {
      throw new Error(
        'Recovery startup publication only supports user.message and turn.started',
      );
    }
    const ownerId = sanitizeDbText(
      publication.ownerId,
      'eventStore.recovery.ownerId',
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      publication.fenceToken,
      'eventStore.recovery.fenceToken',
    );
    if (frames.some((frame) => frame.turnId !== turnId)) {
      throw new Error('Recovery startup publication frames must belong to its turn');
    }
    if (frames[0]!.sourceType !== sourceType) {
      throw new Error(
        `Recovery startup publication must begin with ${sourceType} provenance`,
      );
    }
    if (frames.slice(1).some((frame) => (
      frame.sourceType != null && frame.sourceType !== sourceType
    ))) {
      throw new Error('Recovery startup publication contains conflicting provenance');
    }

    const agentId = eventBatchAgentId(frames);
    return this.db.transaction(async (tx) => {
      const lockTimestamp = Date.now();
      await tx
        .insert(this.schema.agentEventHeads)
        .values({ agentId, committedSeq: 0, updatedAt: lockTimestamp })
        .onConflictDoNothing();
      const [lockedHead] = await tx
        .select({ agentId: this.schema.agentEventHeads.agentId })
        .from(this.schema.agentEventHeads)
        .where(eq(this.schema.agentEventHeads.agentId, agentId))
        .for('update');
      if (!lockedHead) {
        throw new Error(`Cannot lock canonical event head for agent ${agentId}`);
      }

      if (!await this.lockCurrentDeliveryFence(
        tx,
        turnId,
        { ownerId, fenceToken },
        'eventStore.recovery.deliveryFence',
      )) {
        return [];
      }

      const [existing] = await tx
        .select({ seq: this.schema.eventStore.seq })
        .from(this.schema.eventStore)
        .where(and(
          eq(this.schema.eventStore.turnId, turnId),
          eq(this.schema.eventStore.sourceType, sourceType),
        ))
        .limit(1);
      if (existing) {
        return [];
      }

      const now = Date.now();
      const rows = await tx
        .insert(this.schema.eventStore)
        .values(frames.map((frame) => ({
          type: sanitizeDbText(frame.type, 'eventStore.type'),
          agentId,
          payload: sanitizeDbText(frame.payload, 'eventStore.payload'),
          createdAt: now,
          turnId,
          conversationId: frame.conversationId ?? null,
          channel: frame.channel ?? 'system',
          sourceType: sanitizeOptionalDbText(
            frame.sourceType ?? null,
            'eventStore.sourceType',
          ),
          sourcePayload: sanitizeOptionalDbText(
            frame.sourcePayload ?? null,
            'eventStore.sourcePayload',
          ),
        })))
        .returning({ seq: this.schema.eventStore.seq });
      const committedSeq = rows.at(-1)?.seq;
      if (committedSeq == null) {
        throw new Error(`Canonical recovery insert for agent ${agentId} returned no sequence`);
      }
      await tx
        .update(this.schema.agentEventHeads)
        .set({ committedSeq, updatedAt: Date.now() })
        .where(eq(this.schema.agentEventHeads.agentId, agentId));
      return rows.map((row) => row.seq);
    });
  }

  /**
   * Atomically persist a canonical message frame and its publication
   * watermark. A frame insert failure leaves the row pending for startup
   * recovery; the watermark can never get ahead of event_store.
   */
  async saveMessageEventBatch(
    frames: EventFrameInsert[],
    publication: { messageId: string; targetRevision: number },
    expectedDeliveryFence?: ExpectedTurnDeliveryFence,
  ): Promise<number[]> {
    if (frames.length === 0) {
      throw new Error('Canonical message publication requires at least one frame');
    }
    const agentId = eventBatchAgentId(frames);

    return this.db.transaction(async (tx) => {
      const lockTimestamp = Date.now();
      await tx
        .insert(this.schema.agentEventHeads)
        .values({ agentId, committedSeq: 0, updatedAt: lockTimestamp })
        .onConflictDoNothing();
      const [lockedHead] = await tx
        .select({ agentId: this.schema.agentEventHeads.agentId })
        .from(this.schema.agentEventHeads)
        .where(eq(this.schema.agentEventHeads.agentId, agentId))
        .for('update');
      if (!lockedHead) {
        throw new Error(`Cannot lock canonical event head for agent ${agentId}`);
      }
      if (expectedDeliveryFence) {
        const [messageIdentity] = await tx
          .select({ turnId: this.schema.messages.turnId })
          .from(this.schema.messages)
          .where(eq(this.schema.messages.id, publication.messageId));
        if (!messageIdentity) {
          throw new Error(
            `Cannot publish canonical frame for missing message ${publication.messageId}`,
          );
        }
        if (
          !messageIdentity.turnId
          || !await this.lockCurrentDeliveryFence(
            tx,
            messageIdentity.turnId,
            expectedDeliveryFence,
            'eventStore.message.deliveryFence',
          )
        ) {
          return [];
        }
      }
      const [message] = await tx
        .select({
          messageRevision: this.schema.messages.messageRevision,
          publishedRevision: this.schema.messages.publishedRevision,
        })
        .from(this.schema.messages)
        .where(eq(this.schema.messages.id, publication.messageId))
        .for('update');
      if (!message) {
        throw new Error(`Cannot publish canonical frame for missing message ${publication.messageId}`);
      }
      if (publication.targetRevision > message.messageRevision) {
        throw new Error(
          `Cannot publish message ${publication.messageId} revision ${publication.targetRevision}; ` +
          `durable revision is ${message.messageRevision}`,
        );
      }
      if (publication.targetRevision <= message.publishedRevision) {
        throw new Error(
          `Message ${publication.messageId} revision ${publication.targetRevision} is already published`,
        );
      }

      const now = Date.now();
      const rows = await tx
        .insert(this.schema.eventStore)
        .values(frames.map((frame) => ({
          type: sanitizeDbText(frame.type, 'eventStore.type'),
          agentId,
          payload: sanitizeDbText(frame.payload, 'eventStore.payload'),
          createdAt: now,
          turnId: frame.turnId ?? null,
          conversationId: frame.conversationId ?? null,
          channel: frame.channel ?? 'system',
          sourceType: sanitizeOptionalDbText(frame.sourceType ?? null, 'eventStore.sourceType'),
          sourcePayload: sanitizeOptionalDbText(frame.sourcePayload ?? null, 'eventStore.sourcePayload'),
        })))
        .returning({ seq: this.schema.eventStore.seq });

      await tx
        .update(this.schema.messages)
        .set({ publishedRevision: publication.targetRevision })
        .where(eq(this.schema.messages.id, publication.messageId));
      const committedSeq = rows.at(-1)?.seq;
      if (committedSeq == null) {
        throw new Error(`Canonical message event insert for agent ${agentId} returned no sequence`);
      }
      await tx
        .update(this.schema.agentEventHeads)
        .set({ committedSeq, updatedAt: Date.now() })
        .where(eq(this.schema.agentEventHeads.agentId, agentId));
      return rows.map((row) => row.seq);
    });
  }

  /**
   * Atomically persist the terminal canonical frame batch and advance the
   * turn's terminal publication watermark. The turn lock serializes this
   * boundary with terminal retries; a concurrent/replayed publisher returns
   * an empty batch and therefore cannot duplicate frames or downstream emit.
   */
  async saveTerminalEventBatch(
    frames: EventFrameInsert[],
    publication: { turnId: string },
  ): Promise<number[]> {
    if (frames.length === 0) {
      throw new Error('Canonical terminal publication requires at least one frame');
    }
    if (frames.some((frame) => frame.turnId !== publication.turnId)) {
      throw new Error(
        `Canonical terminal publication for ${publication.turnId} contains a frame for another turn`,
      );
    }
    const agentId = eventBatchAgentId(frames);

    return this.db.transaction(async (tx) => {
      const lockTimestamp = Date.now();
      await tx
        .insert(this.schema.agentEventHeads)
        .values({ agentId, committedSeq: 0, updatedAt: lockTimestamp })
        .onConflictDoNothing();
      const [lockedHead] = await tx
        .select({ agentId: this.schema.agentEventHeads.agentId })
        .from(this.schema.agentEventHeads)
        .where(eq(this.schema.agentEventHeads.agentId, agentId))
        .for('update');
      if (!lockedHead) {
        throw new Error(`Cannot lock canonical event head for agent ${agentId}`);
      }
      const [turn] = await tx
        .select({
          completedAt: this.schema.turns.completedAt,
          status: this.schema.turns.status,
          terminalPublishedSeq: this.schema.turns.terminalPublishedSeq,
        })
        .from(this.schema.turns)
        .where(eq(this.schema.turns.id, publication.turnId))
        .for('update');
      if (!turn) {
        throw new Error(`Cannot publish canonical terminal for missing turn ${publication.turnId}`);
      }
      if (turn.completedAt == null || turn.status === 'queued' || turn.status === 'running') {
        throw new Error(`Cannot publish canonical terminal for open turn ${publication.turnId}`);
      }
      if (turn.terminalPublishedSeq != null) {
        return [];
      }

      const frameTypes = new Set(frames.map((frame) => frame.type));
      if (!frameTypes.has('RUN_FINISHED')) {
        throw new Error(
          `Canonical terminal publication for ${publication.turnId} requires RUN_FINISHED`,
        );
      }
      if (
        (turn.status === 'error' || turn.status === 'cancelled')
        && !frameTypes.has('RUN_ERROR')
      ) {
        throw new Error(
          `Canonical ${turn.status} terminal publication for ${publication.turnId} requires RUN_ERROR`,
        );
      }

      const [pendingMessage] = await tx
        .select({ id: this.schema.messages.id })
        .from(this.schema.messages)
        .where(and(
          eq(this.schema.messages.turnId, publication.turnId),
          inArray(this.schema.messages.role, ['assistant', 'tool']),
          lt(this.schema.messages.publishedRevision, this.schema.messages.messageRevision),
        ))
        .limit(1);
      if (pendingMessage) {
        throw new Error(
          `Cannot publish canonical terminal for ${publication.turnId}; ` +
          `pending canonical message ${pendingMessage.id} must publish first`,
        );
      }

      const now = Date.now();
      const rows = await tx
        .insert(this.schema.eventStore)
        .values(frames.map((frame) => ({
          type: sanitizeDbText(frame.type, 'eventStore.type'),
          agentId,
          payload: sanitizeDbText(frame.payload, 'eventStore.payload'),
          createdAt: now,
          turnId: frame.turnId ?? null,
          conversationId: frame.conversationId ?? null,
          channel: frame.channel ?? 'system',
          sourceType: sanitizeOptionalDbText(frame.sourceType ?? null, 'eventStore.sourceType'),
          sourcePayload: sanitizeOptionalDbText(frame.sourcePayload ?? null, 'eventStore.sourcePayload'),
        })))
        .returning({ seq: this.schema.eventStore.seq });
      const lastSeq = rows.at(-1)?.seq;
      if (lastSeq == null) {
        throw new Error(`Canonical terminal insert for ${publication.turnId} returned no sequence`);
      }

      await tx
        .update(this.schema.turns)
        .set({ terminalPublishedSeq: lastSeq })
        .where(eq(this.schema.turns.id, publication.turnId));
      await tx
        .update(this.schema.agentEventHeads)
        .set({ committedSeq: lastSeq, updatedAt: Date.now() })
        .where(eq(this.schema.agentEventHeads.agentId, agentId));
      return rows.map((row) => row.seq);
    });
  }

  /** Latest commit-ordered frame seq for an agent (0 when none). */
  async getLatestEventSeq(agentId: string): Promise<number> {
    const [row] = await this.db
      .select({ seq: this.schema.agentEventHeads.committedSeq })
      .from(this.schema.agentEventHeads)
      .where(eq(this.schema.agentEventHeads.agentId, agentId));
    return row?.seq ?? 0;
  }

  /** Durable replay: frames for an agent after a seq, optionally per channel (ADR-015). */
  async getFramesSince(
    agentId: string,
    afterSeq: number,
    options: { channels?: string[]; limit?: number; throughSeq?: number } = {},
  ): Promise<EventFrameRow[]> {
    const conditions = [
      eq(this.schema.eventStore.agentId, agentId),
      gt(this.schema.eventStore.seq, afterSeq),
    ];
    if (options.channels && options.channels.length > 0) {
      conditions.push(inArray(this.schema.eventStore.channel, options.channels));
    }
    if (options.throughSeq !== undefined) {
      conditions.push(lte(this.schema.eventStore.seq, options.throughSeq));
    }
    return this.db.query.eventStore.findMany({
      where: and(...conditions),
      orderBy: [asc(this.schema.eventStore.seq)],
      limit: options.limit ?? 1_000,
    });
  }

  /** All frames of a turn in seq order — reconnect tail replay for in-flight turns. */
  async getTurnFrames(turnId: string, afterSeq = 0): Promise<EventFrameRow[]> {
    return this.db.query.eventStore.findMany({
      where: and(
        eq(this.schema.eventStore.turnId, turnId),
        gt(this.schema.eventStore.seq, afterSeq),
      ),
      orderBy: [asc(this.schema.eventStore.seq)],
    });
  }

  /** Source-bearing rows in seq order — raw event input for durable spine consumers (ADR-016/017). */
  async getSourceEventsSince(afterSeq: number, limit = 1_000): Promise<EventFrameRow[]> {
    return this.db.query.eventStore.findMany({
      where: and(
        gt(this.schema.eventStore.seq, afterSeq),
        isNotNull(this.schema.eventStore.sourceType),
      ),
      orderBy: [asc(this.schema.eventStore.seq)],
      limit,
    });
  }

  async getSpineCursor(consumer: string): Promise<number> {
    const sanitizedConsumer = sanitizeDbText(consumer, 'spineCursors.consumer');
    const row = await this.db.query.spineCursors.findFirst({
      where: eq(this.schema.spineCursors.consumer, sanitizedConsumer),
    });
    return row?.lastSeq ?? 0;
  }

  async advanceSpineCursor(consumer: string, lastSeq: number): Promise<SpineCursorRow> {
    const sanitizedConsumer = sanitizeDbText(consumer, 'spineCursors.consumer');
    const now = Date.now();
    const [row] = await this.db
      .insert(this.schema.spineCursors)
      .values({ consumer: sanitizedConsumer, lastSeq, updatedAt: now })
      .onConflictDoUpdate({
        target: this.schema.spineCursors.consumer,
        set: {
          lastSeq: sql<number>`greatest(${this.schema.spineCursors.lastSeq}, ${lastSeq})`,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) {
      throw new Error('Expected spine cursor upsert to return a row but got undefined');
    }
    return row;
  }

  /**
   * Query events with optional filtering by type, agentId, durable
   * correlation identity, time range, and cursor-based pagination.
   */
  async getEvents(options: {
    cursor?: number;
    limit?: number;
    type?: string;
    agentId?: string;
    turnId?: string;
    conversationId?: string;
    since?: number;
  } = {}): Promise<Array<{
    seq: number;
    type: string;
    agentId: string;
    turnId: string | null;
    conversationId: string | null;
    payload: string;
    createdAt: number;
    channel: string;
    sourceType: string | null;
    sourcePayload: string | null;
  }>> {
    const {
      cursor,
      limit: lim = 50,
      type: eventType,
      agentId,
      turnId,
      conversationId,
      since,
    } = options;

    const conditions = [];
    if (cursor) conditions.push(lt(this.schema.eventStore.seq, cursor));
    if (eventType) conditions.push(eq(this.schema.eventStore.type, eventType));
    if (agentId) conditions.push(eq(this.schema.eventStore.agentId, agentId));
    if (turnId) conditions.push(eq(this.schema.eventStore.turnId, turnId));
    if (conversationId) conditions.push(eq(this.schema.eventStore.conversationId, conversationId));
    if (since) conditions.push(gt(this.schema.eventStore.createdAt, since));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select({
        seq: this.schema.eventStore.seq,
        type: this.schema.eventStore.type,
        agentId: this.schema.eventStore.agentId,
        turnId: this.schema.eventStore.turnId,
        conversationId: this.schema.eventStore.conversationId,
        payload: this.schema.eventStore.payload,
        createdAt: this.schema.eventStore.createdAt,
        channel: this.schema.eventStore.channel,
        sourceType: this.schema.eventStore.sourceType,
        sourcePayload: this.schema.eventStore.sourcePayload,
      })
      .from(this.schema.eventStore)
      .where(whereClause)
      .orderBy(sql`${this.schema.eventStore.seq} DESC`)
      .limit(lim);
  }

  /**
   * Get event statistics: counts by type, recent event rate, top agents.
   */
  async getEventStats(since?: number): Promise<{
    total: number;
    byType: Record<string, number>;
    topAgents: Array<{ agentId: string | null; count: number }>;
    recentRate: number;
  }> {
    const sinceTime = since ?? Date.now() - 24 * 60 * 60 * 1000;
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;

    // Count by type
    const typeRows = await this.db
      .select({
        type: this.schema.eventStore.type,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(this.schema.eventStore)
      .where(gt(this.schema.eventStore.createdAt, sinceTime))
      .groupBy(this.schema.eventStore.type);

    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of typeRows) {
      const count = Number(row.count);
      byType[row.type] = count;
      total += count;
    }

    // Top agents
    const agentRows = await this.db
      .select({
        agentId: this.schema.eventStore.agentId,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(this.schema.eventStore)
      .where(gt(this.schema.eventStore.createdAt, sinceTime))
      .groupBy(this.schema.eventStore.agentId)
      .orderBy(sql`count(*) DESC`)
      .limit(10);

    // Recent rate (events in last 5 minutes)
    const [rateRow] = await this.db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(this.schema.eventStore)
      .where(gt(this.schema.eventStore.createdAt, fiveMinAgo));

    const recentRate = Math.round((Number(rateRow?.count ?? 0) / 5) * 10) / 10; // events per minute

    return {
      total,
      byType,
      topAgents: agentRows.map((r) => ({ agentId: r.agentId, count: Number(r.count) })),
      recentRate,
    };
  }

  /**
   * Get distinct event types from the event store.
   */
  async getEventTypes(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ type: this.schema.eventStore.type })
      .from(this.schema.eventStore);
    return rows.map((r) => r.type);
  }

  // ── Event Triggers ──────────────────────────────────────

  async saveTrigger(data: TriggerInsert): Promise<TriggerSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'eventTriggers.upsert');
    const row = {
      ...sanitizedData,
      selectorHash: triggerSelectorHash(sanitizedData.selector),
    };
    const [trigger] = await this.db
      .insert(this.schema.eventTriggers)
      .values(row)
      .onConflictDoUpdate({
        target: this.schema.eventTriggers.id,
        set: {
          eventType: row.eventType,
          selector: row.selector,
          selectorHash: row.selectorHash,
          taskTemplate: row.taskTemplate,
          enabled: row.enabled,
        },
      })
      .returning();
    if (!trigger) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return trigger;
  }

  async getTriggerBySignature(
    agentId: string,
    eventType: string,
    selector?: Record<string, unknown> | null,
  ): Promise<TriggerSelect | undefined> {
    return this.db.query.eventTriggers.findFirst({
      where: and(
        eq(this.schema.eventTriggers.agentId, agentId),
        eq(this.schema.eventTriggers.eventType, eventType),
        eq(this.schema.eventTriggers.selectorHash, triggerSelectorHash(selector)),
      ),
    });
  }

  async getTriggers(agentId?: string): Promise<TriggerSelect[]> {
    if (agentId) {
      return this.db.query.eventTriggers.findMany({
        where: eq(this.schema.eventTriggers.agentId, agentId),
      });
    }
    return this.db.query.eventTriggers.findMany();
  }

  async deleteTrigger(id: string): Promise<void> {
    await this.db.delete(this.schema.eventTriggers).where(eq(this.schema.eventTriggers.id, id));
  }

  async recordTriggerFiring(triggerId: string, eventSeq: number): Promise<TriggerFiringRow | undefined> {
    const sanitizedTriggerId = sanitizeDbText(triggerId, 'triggerFirings.triggerId');
    const [row] = await this.db
      .insert(this.schema.triggerFirings)
      .values({
        triggerId: sanitizedTriggerId,
        eventSeq,
        createdAt: Date.now(),
      })
      .onConflictDoNothing({
        target: [
          this.schema.triggerFirings.triggerId,
          this.schema.triggerFirings.eventSeq,
        ],
      })
      .returning();
    return row;
  }

  async hasTriggerFiring(triggerId: string, eventSeq: number): Promise<boolean> {
    const sanitizedTriggerId = sanitizeDbText(triggerId, 'triggerFirings.triggerId');
    const row = await this.db.query.triggerFirings.findFirst({
      where: and(
        eq(this.schema.triggerFirings.triggerId, sanitizedTriggerId),
        eq(this.schema.triggerFirings.eventSeq, eventSeq),
      ),
    });
    return Boolean(row);
  }

  // ── Schedules ───────────────────────────────────────────

  async listSchedules(): Promise<ScheduleRow[]> {
    return this.db
      .select()
      .from(this.schema.schedules)
      .orderBy(asc(this.schema.schedules.createdAt), asc(this.schema.schedules.id));
  }

  async getSchedule(id: string): Promise<ScheduleRow | undefined> {
    const [row] = await this.db
      .select()
      .from(this.schema.schedules)
      .where(eq(this.schema.schedules.id, id));
    return row;
  }

  async createSchedule(data: ScheduleInsert): Promise<ScheduleRow> {
    const sanitized = sanitizeTypedDbValue(data, 'schedules.insert');
    return this.insertOne(
      this.db.insert(this.schema.schedules).values(sanitized).returning(),
      'schedule',
    );
  }

  async updateSchedule(
    id: string,
    updates: Partial<Omit<
      ScheduleInsert,
      'id' | 'agentId' | 'createdAt' | 'updatedAt' | 'lastFiredAt'
    >>,
  ): Promise<ScheduleRow | undefined> {
    const sanitized = sanitizeTypedDbValue(updates, 'schedules.update');
    const [row] = await this.db
      .update(this.schema.schedules)
      .set({ ...sanitized, updatedAt: Date.now() })
      .where(eq(this.schema.schedules.id, id))
      .returning();
    return row;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(this.schema.schedules)
      .where(eq(this.schema.schedules.id, id))
      .returning({ id: this.schema.schedules.id });
    return rows.length > 0;
  }

  /**
   * Atomically claim one cron window before emitting (ctx-hljx). The window
   * key is the fire's UTC second — cron's minimum slot width (croner accepts
   * 6-field expressions): a second process firing the same slot lands in the
   * same second and backs off, so two orchestrator replicas cannot
   * double-fire a schedule. Replicas skewed across a second boundary are not
   * covered; that is the accepted approximation of a per-fire lock. Returns
   * the prior last_fired_at so a failed emission can restore it.
   */
  async claimScheduleFire(id: string, nowMs: number): Promise<
    { claimed: true; previousLastFiredAt: number | null } | { claimed: false }
  > {
    const windowStartMs = Math.floor(nowMs / 1_000) * 1_000;
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          enabled: this.schema.schedules.enabled,
          lastFiredAt: this.schema.schedules.lastFiredAt,
        })
        .from(this.schema.schedules)
        .where(eq(this.schema.schedules.id, id))
        .for('update');
      if (!current || !current.enabled) {
        return { claimed: false };
      }
      if (current.lastFiredAt !== null && current.lastFiredAt >= windowStartMs) {
        return { claimed: false };
      }
      await tx
        .update(this.schema.schedules)
        .set({ lastFiredAt: nowMs, updatedAt: nowMs })
        .where(eq(this.schema.schedules.id, id));
      return { claimed: true, previousLastFiredAt: current.lastFiredAt };
    });
  }

  /**
   * Roll a claimed-but-unfired window back so a failed emission is not
   * recorded as fired. Guarded on the claim stamp: a newer successful fire
   * is never overwritten.
   */
  async restoreScheduleFireClaim(
    id: string,
    claimStampMs: number,
    previousLastFiredAt: number | null,
  ): Promise<void> {
    await this.db
      .update(this.schema.schedules)
      .set({ lastFiredAt: previousLastFiredAt })
      .where(and(
        eq(this.schema.schedules.id, id),
        eq(this.schema.schedules.lastFiredAt, claimStampMs),
      ));
  }

  /** Record windows that provably never fired (ctx-hljx); no backfill. */
  async recordScheduleMissedFires(id: string, count: number, nowMs: number): Promise<void> {
    await this.db
      .update(this.schema.schedules)
      .set({
        missedFireCount: sql<number>`${this.schema.schedules.missedFireCount} + ${count}`,
        updatedAt: nowMs,
      })
      .where(eq(this.schema.schedules.id, id));
  }

  // ── Pending Interrupts (Durable HITL) ──────────────────

  /**
   * Atomically install a callback-created approval interrupt while the exact
   * sandbox delivery still owns the turn. When replacing an in-process
   * waiter, its durable predecessor is superseded in the same transaction so
   * callers never observe a resolved predecessor without its replacement.
   */
  async installPendingInterruptIfSandboxCallbackCurrent(
    data: InterruptInsert,
    authority: ExpectedSandboxCallbackDelivery,
    supersededInterruptId?: string,
  ): Promise<InterruptRow | undefined> {
    const sanitizedData = sanitizeTypedDbValue(
      data,
      'pendingInterrupts.callbackInstall',
    );
    const expectedTurnId = sanitizeDbText(
      authority.turnId,
      'pendingInterrupts.callbackInstall.authority.turnId',
    );
    const expectedSandboxSessionId = sanitizeDbText(
      authority.sandboxSessionId,
      'pendingInterrupts.callbackInstall.authority.sandboxSessionId',
    );
    const expectedAgentId = sanitizeDbText(
      authority.agentId,
      'pendingInterrupts.callbackInstall.authority.agentId',
    );
    if (
      sanitizedData.turnId !== expectedTurnId
      || sanitizedData.sandboxSessionId !== expectedSandboxSessionId
      || sanitizedData.agentId !== expectedAgentId
    ) {
      return undefined;
    }
    const sanitizedSupersededInterruptId = supersededInterruptId === undefined
      ? undefined
      : sanitizeDbText(
          supersededInterruptId,
          'pendingInterrupts.callbackInstall.supersededInterruptId',
        );
    if (sanitizedSupersededInterruptId === sanitizedData.id) {
      throw new Error(
        'A pending interrupt replacement must use a new immutable id',
      );
    }

    return this.db.transaction(async (tx) => {
      const delivery = await this.lockExactSandboxCallbackDelivery(
        tx,
        authority,
        'pendingInterrupts.callbackInstall',
      );
      if (!delivery) {
        return undefined;
      }

      const actionableInterrupts = await tx
        .select({ id: this.schema.pendingInterrupts.id })
        .from(this.schema.pendingInterrupts)
        .where(and(
          eq(this.schema.pendingInterrupts.turnId, expectedTurnId),
          inArray(
            this.schema.pendingInterrupts.status,
            ['pending', 'timed_out'],
          ),
        ))
        .for('update');
      if (sanitizedSupersededInterruptId === undefined) {
        if (actionableInterrupts.length > 0) {
          return undefined;
        }
      } else if (
        actionableInterrupts.length !== 1
        || actionableInterrupts[0]?.id !== sanitizedSupersededInterruptId
      ) {
        return undefined;
      }

      if (sanitizedSupersededInterruptId !== undefined) {
        const [superseded] = await tx
          .update(this.schema.pendingInterrupts)
          .set({
            status: 'resolved',
            resolvedAt: databaseClockMs(),
            resolvedAction: 'reject',
            resolvedData: 'Superseded by new interrupt',
          })
          .where(and(
            eq(
              this.schema.pendingInterrupts.id,
              sanitizedSupersededInterruptId,
            ),
            eq(this.schema.pendingInterrupts.turnId, expectedTurnId),
            eq(this.schema.pendingInterrupts.agentId, expectedAgentId),
            inArray(
              this.schema.pendingInterrupts.status,
              ['pending', 'timed_out'],
            ),
          ))
          .returning({ id: this.schema.pendingInterrupts.id });
        if (!superseded) {
          return undefined;
        }
      }

      const [installed] = await tx
        .insert(this.schema.pendingInterrupts)
        .values({
          ...sanitizedData,
          status: 'pending',
          resolvedAt: null,
          resolvedAction: null,
          resolvedData: null,
        })
        .returning();
      if (!installed) {
        throw new Error(
          'Expected pending interrupt installation to return a row',
        );
      }
      return installed;
    });
  }

  /**
   * Compensate a callback installation whose canonical requested event could
   * not be persisted. The immutable identity and pending-state comparison
   * prevent delayed cleanup from deleting a later replacement.
   */
  async deletePendingInterruptInstallation(
    id: string,
    turnId: string,
    toolCallId: string,
  ): Promise<boolean> {
    const deleted = await this.db
      .delete(this.schema.pendingInterrupts)
      .where(and(
        eq(
          this.schema.pendingInterrupts.id,
          sanitizeDbText(id, 'pendingInterrupts.callbackInstall.delete.id'),
        ),
        eq(
          this.schema.pendingInterrupts.turnId,
          sanitizeDbText(
            turnId,
            'pendingInterrupts.callbackInstall.delete.turnId',
          ),
        ),
        eq(
          this.schema.pendingInterrupts.toolCallId,
          sanitizeDbText(
            toolCallId,
            'pendingInterrupts.callbackInstall.delete.toolCallId',
          ),
        ),
        eq(this.schema.pendingInterrupts.status, 'pending'),
      ))
      .returning({ id: this.schema.pendingInterrupts.id });
    return deleted.length > 0;
  }

  async savePendingInterrupt(data: InterruptInsert): Promise<InterruptRow> {
    const sanitizedData = sanitizeTypedDbValue(data, 'pendingInterrupts.upsert');
    const [row] = await this.db
      .insert(this.schema.pendingInterrupts)
      .values(sanitizedData)
      .onConflictDoUpdate({
        target: this.schema.pendingInterrupts.id,
        set: {
          turnId: sanitizedData.turnId,
          agentId: sanitizedData.agentId,
          sandboxSessionId: sanitizedData.sandboxSessionId ?? null,
          toolCallId: sanitizedData.toolCallId,
          toolName: sanitizedData.toolName,
          args: sanitizedData.args,
          timeoutMs: sanitizedData.timeoutMs,
          createdAt: sanitizedData.createdAt,
          expiresAt: sanitizedData.expiresAt,
          status: sanitizedData.status ?? 'pending',
          resolvedAt: null,
          resolvedAction: null,
          resolvedData: null,
        },
      })
      .returning();
    if (!row) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return row;
  }

  async getInterruptById(id: string): Promise<InterruptRow | undefined> {
    return this.db.query.pendingInterrupts.findFirst({
      where: eq(this.schema.pendingInterrupts.id, id),
    });
  }

  async listInterrupts(options: {
    status?: 'pending' | 'resolved' | 'all';
    agentId?: string;
    limit?: number;
    before?: number;
  } = {}): Promise<{ interrupts: InterruptRow[]; hasMore: boolean }> {
    const status = options.status ?? 'pending';
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 200));
    const filters: SQL[] = [];

    if (status === 'pending') {
      filters.push(inArray(this.schema.pendingInterrupts.status, ['pending', 'timed_out']));
    } else if (status === 'resolved') {
      filters.push(eq(this.schema.pendingInterrupts.status, 'resolved'));
    }
    if (options.agentId) {
      filters.push(eq(
        this.schema.pendingInterrupts.agentId,
        sanitizeDbText(options.agentId, 'pendingInterrupts.list.agentId'),
      ));
    }
    if (options.before !== undefined) {
      filters.push(lt(this.schema.pendingInterrupts.createdAt, options.before));
    }

    const rows = await this.db.query.pendingInterrupts.findMany({
      where: filters.length > 0 ? and(...filters) : undefined,
      orderBy: (row, { desc: descending }) => [
        descending(row.createdAt),
        descending(row.id),
      ],
      limit: limit + 1,
    });
    return {
      interrupts: rows.slice(0, limit),
      hasMore: rows.length > limit,
    };
  }

  async getPendingInterruptForTurn(turnId: string): Promise<InterruptRow | undefined> {
    return this.db.query.pendingInterrupts.findFirst({
      where: and(
        eq(this.schema.pendingInterrupts.turnId, turnId),
        inArray(this.schema.pendingInterrupts.status, ['pending', 'timed_out']),
      ),
      orderBy: (row, { desc }) => [desc(row.createdAt)],
    });
  }

  async getActionableInterruptsForAgent(
    agentId: string,
  ): Promise<Array<{ interrupt: InterruptRow; resumeAttempt?: InterruptResumeAttemptRow }>> {
    const interrupts = await this.db.query.pendingInterrupts.findMany({
      where: and(
        eq(this.schema.pendingInterrupts.agentId, agentId),
        inArray(this.schema.pendingInterrupts.status, ['pending', 'timed_out']),
      ),
      orderBy: (row, { asc }) => [asc(row.createdAt)],
    });

    const failedAttempts = await this.db.query.interruptResumeAttempts.findMany({
      where: and(
        eq(this.schema.interruptResumeAttempts.agentId, agentId),
        eq(this.schema.interruptResumeAttempts.status, 'failed'),
      ),
      orderBy: (row, { asc }) => [asc(row.updatedAt)],
    });

    const missingInterruptIds = failedAttempts
      .map((attempt: InterruptResumeAttemptRow) => attempt.interruptId)
      .filter((interruptId: string) => !interrupts.some((interrupt: InterruptRow) => interrupt.id === interruptId));

    const failedInterrupts = missingInterruptIds.length > 0
      ? await this.db.query.pendingInterrupts.findMany({
          where: inArray(this.schema.pendingInterrupts.id, missingInterruptIds),
        })
      : [];

    const attemptByInterruptId = new Map<string, InterruptResumeAttemptRow>(
      failedAttempts.map((attempt: InterruptResumeAttemptRow) => [attempt.interruptId, attempt]),
    );
    return [...interrupts, ...failedInterrupts]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((interrupt) => ({
        interrupt,
        resumeAttempt: attemptByInterruptId.get(interrupt.id),
      }));
  }

  async getAllPendingInterrupts(): Promise<InterruptRow[]> {
    return this.db.query.pendingInterrupts.findMany({
      where: eq(this.schema.pendingInterrupts.status, 'pending'),
    });
  }

  async resolveInterrupt(
    id: string,
    action: string,
    data?: unknown,
  ): Promise<InterruptRow | undefined> {
    const sanitizedAction = sanitizeDbText(action, 'pendingInterrupts.resolvedAction');
    const sanitizedData = sanitizeTypedDbValue(data ?? null, 'pendingInterrupts.resolvedData');
    const [updated] = await this.db
      .update(this.schema.pendingInterrupts)
      .set({
        status: 'resolved',
        resolvedAt: Date.now(),
        resolvedAction: sanitizedAction,
        resolvedData: sanitizedData,
      })
      .where(
        and(
          eq(this.schema.pendingInterrupts.id, id),
          inArray(this.schema.pendingInterrupts.status, ['pending', 'timed_out']),
        ),
      )
      .returning();
    return updated;
  }

  /**
   * Resolve a durable interrupt and create its continuation attempt in the
   * same transaction. Repeating the same decision repairs a historical
   * resolved-without-attempt row without changing the persisted resolution.
   */
  async resolveInterruptWithResumeAttempt(
    id: string,
    action: string,
    data?: unknown,
  ): Promise<ResolveInterruptWithResumeAttemptResult | undefined> {
    const sanitizedId = sanitizeDbText(id, 'pendingInterrupts.resumeResolution.id');
    const sanitizedAction = sanitizeDbText(action, 'pendingInterrupts.resolvedAction');
    const sanitizedData = sanitizeTypedDbValue(data ?? null, 'pendingInterrupts.resolvedData');

    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(this.schema.pendingInterrupts)
        .where(eq(this.schema.pendingInterrupts.id, sanitizedId))
        .for('update');
      if (!current) {
        return undefined;
      }

      let interrupt = current;
      if (current.status === 'resolved') {
        if (current.resolvedAction !== sanitizedAction) {
          return { kind: 'conflict', interrupt: current };
        }
      } else if (current.status === 'pending' || current.status === 'timed_out') {
        const [resolved] = await tx
          .update(this.schema.pendingInterrupts)
          .set({
            status: 'resolved',
            resolvedAt: Date.now(),
            resolvedAction: sanitizedAction,
            resolvedData: sanitizedData,
          })
          .where(and(
            eq(this.schema.pendingInterrupts.id, sanitizedId),
            inArray(this.schema.pendingInterrupts.status, ['pending', 'timed_out']),
          ))
          .returning();
        if (!resolved) {
          return undefined;
        }
        interrupt = resolved;
      } else {
        return undefined;
      }

      if (!interrupt.sandboxSessionId) {
        return { kind: 'ready', interrupt };
      }

      const now = Date.now();
      const [created] = await tx
        .insert(this.schema.interruptResumeAttempts)
        .values({
          interruptId: interrupt.id,
          turnId: interrupt.turnId,
          sandboxSessionId: interrupt.sandboxSessionId,
          agentId: interrupt.agentId,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: this.schema.interruptResumeAttempts.interruptId,
        })
        .returning();
      const resumeAttempt = created ?? (
        await tx
          .select()
          .from(this.schema.interruptResumeAttempts)
          .where(eq(this.schema.interruptResumeAttempts.interruptId, interrupt.id))
      )[0];
      if (!resumeAttempt) {
        throw new Error(
          `Expected interrupt resume attempt for resolved interrupt ${interrupt.id}`,
        );
      }
      return { kind: 'ready', interrupt, resumeAttempt };
    });
  }

  async markInterruptTimedOut(id: string, data?: unknown): Promise<InterruptRow | undefined> {
    const sanitizedData = sanitizeTypedDbValue(data ?? 'Approval expired', 'pendingInterrupts.resolvedData');
    const [updated] = await this.db
      .update(this.schema.pendingInterrupts)
      .set({
        status: 'timed_out',
        resolvedAt: Date.now(),
        resolvedAction: sanitizeDbText('timeout', 'pendingInterrupts.resolvedAction'),
        resolvedData: sanitizedData,
      })
      .where(
        and(
          eq(this.schema.pendingInterrupts.id, id),
          eq(this.schema.pendingInterrupts.status, 'pending'),
        ),
      )
      .returning();
    return updated;
  }

  async cleanupExpiredInterrupts(beforeTime: number): Promise<number> {
    const updated = await this.db
      .update(this.schema.pendingInterrupts)
      .set({
        status: 'timed_out',
        resolvedAt: Date.now(),
        resolvedAction: sanitizeDbText('timeout', 'pendingInterrupts.resolvedAction'),
        resolvedData: sanitizeDbText('Approval expired', 'pendingInterrupts.resolvedData'),
      })
      .where(
        and(
          eq(this.schema.pendingInterrupts.status, 'pending'),
          lt(this.schema.pendingInterrupts.expiresAt, beforeTime),
        ),
      )
      .returning({ id: this.schema.pendingInterrupts.id });
    return updated.length;
  }

  async getInterruptResumeAttemptForInterrupt(interruptId: string): Promise<InterruptResumeAttemptRow | undefined> {
    return this.db.query.interruptResumeAttempts.findFirst({
      where: eq(this.schema.interruptResumeAttempts.interruptId, interruptId),
    });
  }

  async claimInterruptResumeDelivery(input: {
    attemptId: string;
    sandboxSessionId: string;
    ownerId: string;
    leaseDurationMs: number;
  }): Promise<{
    attempt: InterruptResumeAttemptRow;
    lease: TurnDeliveryLeaseRow;
  } | undefined> {
    const attemptId = sanitizeDbText(
      input.attemptId,
      'interruptResumeDelivery.claim.attemptId',
    );
    const sandboxSessionId = sanitizeDbText(
      input.sandboxSessionId,
      'interruptResumeDelivery.claim.sandboxSessionId',
    );
    const ownerId = sanitizeDbText(
      input.ownerId,
      'interruptResumeDelivery.claim.ownerId',
    );
    const leaseDurationMs = validateLeaseDurationMs(
      input.leaseDurationMs,
      'interruptResumeDelivery.claim.leaseDurationMs',
    );

    return this.db.transaction(async (tx) => {
      const [attemptPreview] = await tx
        .select({
          turnId: this.schema.interruptResumeAttempts.turnId,
          interruptId: this.schema.interruptResumeAttempts.interruptId,
        })
        .from(this.schema.interruptResumeAttempts)
        .where(eq(this.schema.interruptResumeAttempts.id, attemptId))
        .limit(1);
      const [sessionPreview] = await tx
        .select({
          conversationId: this.schema.sandboxSessions.conversationId,
        })
        .from(this.schema.sandboxSessions)
        .where(eq(this.schema.sandboxSessions.id, sandboxSessionId))
        .limit(1);
      if (!attemptPreview || !sessionPreview) {
        return undefined;
      }

      // Match ordinary delivery admission's global lock prefix so a
      // continuation cannot deadlock or race a fresh turn on the same ordered
      // conversation stream.
      const [conversation] = await tx
        .select({
          id: this.schema.conversations.id,
          agentId: this.schema.conversations.agentId,
        })
        .from(this.schema.conversations)
        .where(eq(
          this.schema.conversations.id,
          sessionPreview.conversationId,
        ))
        .for('update');
      if (!conversation) {
        return undefined;
      }

      const [session] = await tx
        .select({
          id: this.schema.sandboxSessions.id,
          conversationId: this.schema.sandboxSessions.conversationId,
          agentId: this.schema.sandboxSessions.agentId,
        })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(this.schema.sandboxSessions.id, sandboxSessionId),
          eq(this.schema.sandboxSessions.status, 'ACTIVE'),
          eq(
            this.schema.sandboxSessions.conversationId,
            conversation.id,
          ),
          eq(this.schema.sandboxSessions.agentId, conversation.agentId),
        ))
        .for('update');
      if (!session) {
        return undefined;
      }

      const [lifecycleOperation] = await tx
        .select({
          sandboxSessionId:
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
        })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sandboxSessionId,
          ),
          inArray(
            this.schema.sandboxSessionLifecycleOperations.phase,
            ['reserved', 'draining', 'executing'],
          ),
        ))
        .limit(1);
      if (lifecycleOperation) {
        return undefined;
      }

      const [turn] = await tx
        .select({
          id: this.schema.turns.id,
          sandboxSessionId: this.schema.turns.sandboxSessionId,
          agentId: this.schema.turns.agentId,
          conversationId: this.schema.turns.conversationId,
          deliveryOwnerId: this.schema.turns.deliveryOwnerId,
          deliveryFenceToken: this.schema.turns.deliveryFenceToken,
        })
        .from(this.schema.turns)
        .where(and(
          eq(this.schema.turns.id, attemptPreview.turnId),
          eq(this.schema.turns.status, 'running'),
          isNull(this.schema.turns.completedAt),
          eq(this.schema.turns.agentId, session.agentId),
          eq(this.schema.turns.conversationId, session.conversationId),
        ))
        .for('update');
      if (!turn) {
        return undefined;
      }

      const [otherRunningTurn] = await tx
        .select({ id: this.schema.turns.id })
        .from(this.schema.turns)
        .where(and(
          eq(this.schema.turns.conversationId, session.conversationId),
          eq(this.schema.turns.status, 'running'),
          isNull(this.schema.turns.completedAt),
          sql<boolean>`${this.schema.turns.id} <> ${turn.id}`,
        ))
        .limit(1);
      if (otherRunningTurn) {
        return undefined;
      }

      const [existingLease] = await tx
        .select()
        .from(this.schema.turnDeliveryLeases)
        .where(eq(this.schema.turnDeliveryLeases.turnId, turn.id))
        .for('update');
      const [interrupt] = await tx
        .select({
          id: this.schema.pendingInterrupts.id,
        })
        .from(this.schema.pendingInterrupts)
        .where(and(
          eq(
            this.schema.pendingInterrupts.id,
            attemptPreview.interruptId,
          ),
          eq(this.schema.pendingInterrupts.turnId, turn.id),
          eq(this.schema.pendingInterrupts.agentId, session.agentId),
          eq(this.schema.pendingInterrupts.status, 'resolved'),
        ))
        .for('update');
      if (!interrupt) {
        return undefined;
      }
      const [attempt] = await tx
        .select()
        .from(this.schema.interruptResumeAttempts)
        .where(and(
          eq(this.schema.interruptResumeAttempts.id, attemptId),
          eq(this.schema.interruptResumeAttempts.interruptId, interrupt.id),
          eq(this.schema.interruptResumeAttempts.turnId, turn.id),
          inArray(
            this.schema.interruptResumeAttempts.status,
            ['pending', 'in_progress'],
          ),
        ))
        .for('update');
      if (!attempt) {
        return undefined;
      }

      const [clock] = await tx
        .select({ nowMs: databaseClockMs() })
        .from(this.schema.sandboxSessions)
        .where(eq(this.schema.sandboxSessions.id, sandboxSessionId))
        .limit(1);
      if (!clock) {
        throw new Error('Database clock query returned no row');
      }
      const nowMs = parseDatabaseClockMs(clock.nowMs);
      const leaseIsCurrent = existingLease !== undefined
        && existingLease.ownerId === turn.deliveryOwnerId
        && existingLease.fenceToken === turn.deliveryFenceToken
        && existingLease.leaseExpiresAt > nowMs;
      if (leaseIsCurrent) {
        if (
          attempt.status !== 'in_progress'
          || existingLease.ownerId !== ownerId
          || turn.sandboxSessionId !== sandboxSessionId
          || attempt.sandboxSessionId !== sandboxSessionId
        ) {
          return undefined;
        }
        const [renewedLease] = await tx
          .update(this.schema.turnDeliveryLeases)
          .set({
            leaseExpiresAt: nowMs + leaseDurationMs,
            updatedAt: nowMs,
          })
          .where(and(
            eq(this.schema.turnDeliveryLeases.turnId, turn.id),
            eq(this.schema.turnDeliveryLeases.ownerId, ownerId),
            eq(
              this.schema.turnDeliveryLeases.fenceToken,
              existingLease.fenceToken,
            ),
          ))
          .returning();
        return renewedLease ? { attempt, lease: renewedLease } : undefined;
      }

      const nextFenceToken = (existingLease?.fenceToken ?? 0) + 1;
      const [lease] = await tx
        .insert(this.schema.turnDeliveryLeases)
        .values({
          turnId: turn.id,
          ownerId,
          fenceToken: nextFenceToken,
          leaseExpiresAt: nowMs + leaseDurationMs,
          updatedAt: nowMs,
        })
        .onConflictDoUpdate({
          target: this.schema.turnDeliveryLeases.turnId,
          set: {
            ownerId,
            fenceToken: nextFenceToken,
            leaseExpiresAt: nowMs + leaseDurationMs,
            updatedAt: nowMs,
          },
        })
        .returning();
      if (!lease) {
        throw new Error(
          `Expected interrupt resume delivery lease for turn ${turn.id}`,
        );
      }

      await tx
        .update(this.schema.turns)
        .set({
          sandboxSessionId,
          deliveryOwnerId: ownerId,
          deliveryFenceToken: nextFenceToken,
        })
        .where(eq(this.schema.turns.id, turn.id));
      const [claimedAttempt] = await tx
        .update(this.schema.interruptResumeAttempts)
        .set({
          sandboxSessionId,
          status: 'in_progress',
          attempts: sql`${this.schema.interruptResumeAttempts.attempts} + 1`,
          lastError: null,
          completedAt: null,
          updatedAt: nowMs,
        })
        .where(eq(this.schema.interruptResumeAttempts.id, attempt.id))
        .returning();
      if (!claimedAttempt) {
        throw new Error(
          `Expected interrupt resume attempt ${attempt.id} claim to return a row`,
        );
      }
      return { attempt: claimedAttempt, lease };
    });
  }

  async completeInterruptResumeDelivery(
    attemptId: string,
    fence: ExpectedTurnDeliveryFence,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    return this.finishInterruptResumeDelivery(
      attemptId,
      fence,
      'completed',
    );
  }

  async failInterruptResumeDelivery(
    attemptId: string,
    fence: ExpectedTurnDeliveryFence,
    error: string,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    return this.finishInterruptResumeDelivery(
      attemptId,
      fence,
      'failed',
      sanitizeDbText(error, 'interruptResumeDelivery.failure.error'),
    );
  }

  private async finishInterruptResumeDelivery(
    attemptIdInput: string,
    fence: ExpectedTurnDeliveryFence,
    status: 'completed' | 'failed',
    error?: string,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    const attemptId = sanitizeDbText(
      attemptIdInput,
      'interruptResumeDelivery.finish.attemptId',
    );
    const ownerId = sanitizeDbText(
      fence.ownerId,
      'interruptResumeDelivery.finish.ownerId',
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      fence.fenceToken,
      'interruptResumeDelivery.finish.fenceToken',
    );
    return this.db.transaction(async (tx) => {
      const [preview] = await tx
        .select({
          turnId: this.schema.interruptResumeAttempts.turnId,
          sandboxSessionId:
            this.schema.interruptResumeAttempts.sandboxSessionId,
        })
        .from(this.schema.interruptResumeAttempts)
        .where(eq(this.schema.interruptResumeAttempts.id, attemptId))
        .limit(1);
      if (!preview?.sandboxSessionId) {
        return undefined;
      }
      const [session] = await tx
        .select({ id: this.schema.sandboxSessions.id })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(
            this.schema.sandboxSessions.id,
            preview.sandboxSessionId,
          ),
          eq(this.schema.sandboxSessions.status, 'ACTIVE'),
        ))
        .for('update');
      if (!session) {
        return undefined;
      }
      const [turn] = await tx
        .select({
          id: this.schema.turns.id,
          sandboxSessionId: this.schema.turns.sandboxSessionId,
        })
        .from(this.schema.turns)
        .where(and(
          eq(this.schema.turns.id, preview.turnId),
          eq(
            this.schema.turns.sandboxSessionId,
            preview.sandboxSessionId,
          ),
          eq(this.schema.turns.deliveryOwnerId, ownerId),
          eq(this.schema.turns.deliveryFenceToken, fenceToken),
        ))
        .for('update');
      if (!turn) {
        return undefined;
      }
      const [lease] = await tx
        .select({ turnId: this.schema.turnDeliveryLeases.turnId })
        .from(this.schema.turnDeliveryLeases)
        .where(and(
          eq(this.schema.turnDeliveryLeases.turnId, turn.id),
          eq(this.schema.turnDeliveryLeases.ownerId, ownerId),
          eq(this.schema.turnDeliveryLeases.fenceToken, fenceToken),
          gt(this.schema.turnDeliveryLeases.leaseExpiresAt, databaseClockMs()),
        ))
        .for('update');
      if (!lease) {
        return undefined;
      }
      const [attempt] = await tx
        .select({ id: this.schema.interruptResumeAttempts.id })
        .from(this.schema.interruptResumeAttempts)
        .where(and(
          eq(this.schema.interruptResumeAttempts.id, attemptId),
          eq(this.schema.interruptResumeAttempts.turnId, turn.id),
          eq(
            this.schema.interruptResumeAttempts.sandboxSessionId,
            preview.sandboxSessionId,
          ),
          eq(this.schema.interruptResumeAttempts.status, 'in_progress'),
        ))
        .for('update');
      if (!attempt) {
        return undefined;
      }
      const nowMs = databaseClockMs();
      const [finished] = await tx
        .update(this.schema.interruptResumeAttempts)
        .set({
          status,
          updatedAt: nowMs,
          completedAt: status === 'completed' ? nowMs : null,
          lastError: status === 'failed' ? error ?? 'Resume failed' : null,
        })
        .where(eq(this.schema.interruptResumeAttempts.id, attemptId))
        .returning();
      return finished;
    });
  }

  async completeTerminalInterruptResumeAttempt(
    attemptId: string,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    const sanitizedId = sanitizeDbText(
      attemptId,
      'interruptResumeAttempts.terminalRepair.id',
    );
    return this.db.transaction(async (tx) => {
      const [preview] = await tx
        .select({
          id: this.schema.interruptResumeAttempts.id,
          turnId: this.schema.interruptResumeAttempts.turnId,
        })
        .from(this.schema.interruptResumeAttempts)
        .where(and(
          eq(this.schema.interruptResumeAttempts.id, sanitizedId),
          inArray(
            this.schema.interruptResumeAttempts.status,
            ['pending', 'in_progress'],
          ),
        ))
        .limit(1);
      if (!preview) {
        return undefined;
      }
      const [terminalTurn] = await tx
        .select({ id: this.schema.turns.id })
        .from(this.schema.turns)
        .where(and(
          eq(this.schema.turns.id, preview.turnId),
          isNotNull(this.schema.turns.completedAt),
          inArray(
            this.schema.turns.status,
            ['completed', 'error', 'cancelled'],
          ),
        ))
        .for('update');
      if (!terminalTurn) {
        return undefined;
      }
      const [attempt] = await tx
        .select({ id: this.schema.interruptResumeAttempts.id })
        .from(this.schema.interruptResumeAttempts)
        .where(and(
          eq(this.schema.interruptResumeAttempts.id, sanitizedId),
          eq(this.schema.interruptResumeAttempts.turnId, terminalTurn.id),
          inArray(
            this.schema.interruptResumeAttempts.status,
            ['pending', 'in_progress'],
          ),
        ))
        .for('update');
      if (!attempt) {
        return undefined;
      }
      const nowMs = databaseClockMs();
      const [completed] = await tx
        .update(this.schema.interruptResumeAttempts)
        .set({
          status: 'completed',
          updatedAt: nowMs,
          completedAt: nowMs,
          lastError: null,
        })
        .where(eq(this.schema.interruptResumeAttempts.id, sanitizedId))
        .returning();
      return completed;
    });
  }

  async failUnclaimedInterruptResumeAttempt(
    attemptId: string,
    error: string,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    const sanitizedId = sanitizeDbText(
      attemptId,
      'interruptResumeAttempts.unclaimedFailure.id',
    );
    const [failed] = await this.db
      .update(this.schema.interruptResumeAttempts)
      .set({
        status: 'failed',
        updatedAt: databaseClockMs(),
        completedAt: null,
        lastError: sanitizeDbText(
          error,
          'interruptResumeAttempts.unclaimedFailure.error',
        ),
      })
      .where(and(
        eq(this.schema.interruptResumeAttempts.id, sanitizedId),
        eq(this.schema.interruptResumeAttempts.status, 'pending'),
      ))
      .returning();
    return failed;
  }

  async getRecoverableInterruptResumeAttempts(
    limit = 50,
  ): Promise<InterruptResumeAttemptRow[]> {
    // ctx-eu6a: pending AND failed rows are recoverable (a transient delivery
    // failure should self-heal, not wait for a human), but only under a retry
    // budget and a per-attempt backoff — previously pending rows were re-driven
    // by every 15s scan forever and failed rows were never re-driven at all.
    return this.db
      .select()
      .from(this.schema.interruptResumeAttempts)
      .where(or(
        and(
          inArray(this.schema.interruptResumeAttempts.status, ['pending', 'failed']),
          lt(this.schema.interruptResumeAttempts.attempts, MAX_INTERRUPT_RESUME_ATTEMPTS),
          sql`${this.schema.interruptResumeAttempts.updatedAt} < ${databaseClockMs()} - LEAST(${this.schema.interruptResumeAttempts.attempts}, 3) * ${INTERRUPT_RESUME_BACKOFF_STEP_MS}`,
        ),
        and(
          eq(this.schema.interruptResumeAttempts.status, 'in_progress'),
          sql<boolean>`NOT EXISTS (
            SELECT 1
            FROM ${this.schema.turnDeliveryLeases}
            INNER JOIN ${this.schema.turns}
              ON ${this.schema.turns.id}
                = ${this.schema.turnDeliveryLeases.turnId}
            WHERE ${this.schema.turnDeliveryLeases.turnId}
                = ${this.schema.interruptResumeAttempts.turnId}
              AND ${this.schema.turns.deliveryOwnerId}
                = ${this.schema.turnDeliveryLeases.ownerId}
              AND ${this.schema.turns.deliveryFenceToken}
                = ${this.schema.turnDeliveryLeases.fenceToken}
              AND ${this.schema.turnDeliveryLeases.leaseExpiresAt}
                > ${databaseClockMs()}
          )`,
        ),
      ))
      .orderBy(
        asc(this.schema.interruptResumeAttempts.updatedAt),
        asc(this.schema.interruptResumeAttempts.id),
      )
      .limit(Math.max(1, Math.min(Math.trunc(limit), 500)));
  }

  /**
   * ctx-eu6a: pending/failed attempts that have exhausted the retry budget.
   * These are excluded from the recovery scan; the worker sweeps them to a
   * terminal 'failed' state so they surface to operators instead of sitting
   * invisibly stuck at the head of the pending queue.
   */
  async getExhaustedInterruptResumeAttempts(
    limit = 50,
  ): Promise<InterruptResumeAttemptRow[]> {
    return this.db
      .select()
      .from(this.schema.interruptResumeAttempts)
      .where(and(
        eq(this.schema.interruptResumeAttempts.status, 'pending'),
        gte(this.schema.interruptResumeAttempts.attempts, MAX_INTERRUPT_RESUME_ATTEMPTS),
      ))
      .orderBy(asc(this.schema.interruptResumeAttempts.updatedAt))
      .limit(Math.max(1, Math.min(Math.trunc(limit), 500)));
  }

  async retryFailedInterruptResumeAttempt(
    id: string,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    const sanitizedId = sanitizeDbText(id, 'interruptResumeAttempts.retry.id');
    const [row] = await this.db
      .update(this.schema.interruptResumeAttempts)
      .set({
        status: 'pending',
        updatedAt: databaseClockMs(),
        completedAt: null,
        lastError: null,
      })
      .where(and(
        eq(this.schema.interruptResumeAttempts.id, sanitizedId),
        eq(this.schema.interruptResumeAttempts.status, 'failed'),
      ))
      .returning();
    return row;
  }

  // ── Callback Outbox ──────────────────────────────────────

  async enqueueCallback(data: CallbackOutboxInsert): Promise<CallbackOutboxRow> {
    const sanitizedData = sanitizeTypedDbValue(data, 'callbackOutbox.insert');
    let row: CallbackOutboxRow | undefined;
    try {
      [row] = await this.db
        .insert(this.schema.callbackOutbox)
        .values(sanitizedData)
        .returning();
    } catch (err) {
      if (sanitizedData.eventSeq == null || !isUniqueConstraintViolation(err, CALLBACK_EVENT_SEQ_DEDUPE_INDEX)) {
        throw err;
      }
      row = await this.db.query.callbackOutbox.findFirst({
        where: and(
          eq(this.schema.callbackOutbox.callbackUrl, sanitizedData.callbackUrl),
          eq(this.schema.callbackOutbox.eventType, sanitizedData.eventType),
          eq(this.schema.callbackOutbox.eventSeq, sanitizedData.eventSeq),
        ),
      });
    }
    if (!row) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return row;
  }

  async claimPendingCallbacks(
    limit: number,
    beforeTime: number,
  ): Promise<CallbackOutboxRow[]> {
    const now = Date.now();
    const claimExpiresAt = now + DEFAULT_CLAIM_LEASE_MS;
    const rows = await this.db
      .update(this.schema.callbackOutbox)
      .set({
        status: 'in_progress',
        claimedAt: now,
        claimExpiresAt,
      })
      .where(
        inArray(
          this.schema.callbackOutbox.id,
          this.db
            .select({ id: this.schema.callbackOutbox.id })
            .from(this.schema.callbackOutbox)
            .where(
              and(
                lte(this.schema.callbackOutbox.nextAttemptAt, beforeTime),
                or(
                  eq(this.schema.callbackOutbox.status, 'pending'),
                  and(
                    eq(this.schema.callbackOutbox.status, 'in_progress'),
                    lt(this.schema.callbackOutbox.claimExpiresAt, now),
                  ),
                ),
              ),
            )
            .orderBy(this.schema.callbackOutbox.nextAttemptAt)
            .limit(limit)
            .for('update', { skipLocked: true }),
        ),
      )
      .returning();
    return rows;
  }

  async markCallbackDelivered(id: string, claimedAt?: number | null): Promise<void> {
    const conditions = [
      eq(this.schema.callbackOutbox.id, id),
      eq(this.schema.callbackOutbox.status, 'in_progress'),
    ];
    if (claimedAt != null) {
      conditions.push(eq(this.schema.callbackOutbox.claimedAt, claimedAt));
    }

    await this.db
      .update(this.schema.callbackOutbox)
      .set({
        status: 'delivered',
        deliveredAt: Date.now(),
        claimedAt: null,
        claimExpiresAt: null,
      })
      .where(and(...conditions));
  }

  async markCallbackFailed(id: string, error: string, nextAttemptAt?: number, claimedAt?: number | null): Promise<void> {
    // Get current row to check attempts
    const currentConditions = [eq(this.schema.callbackOutbox.id, id)];
    if (claimedAt != null) {
      currentConditions.push(eq(this.schema.callbackOutbox.claimedAt, claimedAt));
    }
    const [current] = await this.db
      .select()
      .from(this.schema.callbackOutbox)
      .where(and(...currentConditions));
    if (!current) return;

    const newAttempts = current.attempts + 1;
    const isFinal = newAttempts >= current.maxAttempts;

    const sanitizedError = sanitizeDbText(error, 'callbackOutbox.lastError');

    await this.db
      .update(this.schema.callbackOutbox)
      .set({
        attempts: newAttempts,
        lastAttemptAt: Date.now(),
        lastError: sanitizedError,
        status: isFinal ? 'failed' : 'pending',
        nextAttemptAt: isFinal ? current.nextAttemptAt : (nextAttemptAt ?? Date.now()),
        claimedAt: null,
        claimExpiresAt: null,
      })
      .where(and(...currentConditions));
  }

  async getCallbacksForAgent(agentId: string): Promise<CallbackOutboxRow[]> {
    return this.db.query.callbackOutbox.findMany({
      where: eq(this.schema.callbackOutbox.agentId, agentId),
    });
  }

  /**
   * ctx-4p34: renew the per-row delivery claim (shaped like
   * renewTurnDeliveryLease). Extends the lease only while this dispatcher still
   * owns the row (claimedAt unchanged, still in_progress); returns false if a
   * re-claimer has taken it, so the caller skips the row without re-POSTing.
   */
  async renewCallbackClaim(id: string, claimedAt: number, leaseMs: number): Promise<boolean> {
    const [row] = await this.db
      .update(this.schema.callbackOutbox)
      .set({ claimExpiresAt: Date.now() + leaseMs })
      .where(and(
        eq(this.schema.callbackOutbox.id, id),
        eq(this.schema.callbackOutbox.status, 'in_progress'),
        eq(this.schema.callbackOutbox.claimedAt, claimedAt),
      ))
      .returning({ id: this.schema.callbackOutbox.id });
    return row != null;
  }

  /** ctx-4p34: count dead-lettered (permanently failed) callbacks for /status. */
  async countFailedCallbacks(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(this.schema.callbackOutbox)
      .where(eq(this.schema.callbackOutbox.status, 'failed'));
    return row?.count ?? 0;
  }

  async createWebhook(data: WebhookInsert): Promise<WebhookRow> {
    const sanitizedData = sanitizeTypedDbValue(data, 'webhooks.insert');
    return this.insertOne(
      this.db.insert(this.schema.webhooks).values(sanitizedData).returning(),
      'webhook',
    );
  }

  async listWebhooks(agentId: string): Promise<WebhookRow[]> {
    return this.db
      .select()
      .from(this.schema.webhooks)
      .where(and(eq(this.schema.webhooks.agentId, agentId), eq(this.schema.webhooks.active, true)));
  }

  async getWebhookForAgent(id: string, agentId: string): Promise<WebhookRow | undefined> {
    const [row] = await this.db
      .select()
      .from(this.schema.webhooks)
      .where(and(
        eq(this.schema.webhooks.id, id),
        eq(this.schema.webhooks.agentId, agentId),
        eq(this.schema.webhooks.active, true),
      ));
    return row;
  }

  async deleteWebhookForAgent(id: string, agentId?: string): Promise<boolean> {
    const conditions = [eq(this.schema.webhooks.id, id)];
    if (agentId) {
      conditions.push(eq(this.schema.webhooks.agentId, agentId));
    }
    const deleted = await this.db
      .delete(this.schema.webhooks)
      .where(and(...conditions))
      .returning({ id: this.schema.webhooks.id });
    return deleted.length > 0;
  }

  async updateWebhookForAgent(
    id: string,
    agentId: string,
    data: { url?: string; events?: string[]; secret?: string },
  ): Promise<WebhookRow | undefined> {
    const sanitizedData = sanitizeTypedDbValue(data, 'webhooks.update');
    const updates: {
      url?: string;
      events?: string[];
      secret?: string;
      updatedAt: number;
    } = { updatedAt: Date.now() };
    if (sanitizedData.url !== undefined) updates.url = sanitizedData.url;
    if (sanitizedData.events !== undefined) updates.events = sanitizedData.events;
    if (sanitizedData.secret !== undefined) updates.secret = sanitizedData.secret;
    const [row] = await this.db
      .update(this.schema.webhooks)
      .set(updates)
      .where(and(eq(this.schema.webhooks.id, id), eq(this.schema.webhooks.agentId, agentId)))
      .returning();
    return row;
  }

  // ── Turn queue (ctx-z5k0) ──────────────────────────────────

  /** Global and per-agent queued-turn depth in one round trip. */
  async countQueuedTurns(agentId: string): Promise<{ global: number; agent: number }> {
    const [row] = await this.db
      .select({
        global: sql<number>`count(*)::int`,
        agent: sql<number>`count(*) filter (where ${this.schema.turns.agentId} = ${agentId})::int`,
      })
      .from(this.schema.turns)
      .where(and(
        eq(this.schema.turns.status, 'queued'),
        isNull(this.schema.turns.completedAt),
      ));
    return { global: row?.global ?? 0, agent: row?.agent ?? 0 };
  }

  /**
   * Dispatch candidates (ctx-z5k0): per-conversation head-of-line queued
   * turns with no running sibling, oldest first, annotated with the live
   * session status so the dispatcher can lane them (warm vs slot) at claim
   * time. Plain SELECT — claimTurnDeliveryLease is the authoritative,
   * fenced claim; a stale candidate simply fails its claim and is skipped.
   */
  async getDispatchableQueuedTurns(limit: number): Promise<Array<{
    turnId: string;
    agentId: string;
    conversationId: string | null;
    startedAt: number;
    sessionStatus: string | null;
  }>> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 200));
    const result = await this.db.execute(sql`
      SELECT t.id AS turn_id, t.agent_id, t.conversation_id, t.started_at,
             s.status AS session_status
      FROM turns t
      LEFT JOIN sandbox_sessions s
        ON s.conversation_id = t.conversation_id
       AND s.status IN ('ACTIVE', 'RESTORING')
      WHERE t.status = 'queued' AND t.completed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM turns r
          WHERE r.conversation_id = t.conversation_id
            AND r.completed_at IS NULL
            AND (r.status = 'running' OR r.started_at < t.started_at)
        )
      ORDER BY t.started_at ASC, t.id ASC
      LIMIT ${bounded}
    `);
    return Array.from(result as Iterable<Record<string, unknown>>).map((row) => ({
      turnId: String(row.turn_id),
      agentId: String(row.agent_id),
      conversationId: row.conversation_id === null ? null : String(row.conversation_id),
      startedAt: Number(row.started_at),
      sessionStatus: row.session_status === null ? null : String(row.session_status),
    }));
  }

  /** Queued turns older than the cutoff, for honest expiry (queue_expired). */
  async getExpiredQueuedTurns(cutoffMs: number, limit = 100): Promise<Array<{ turnId: string; agentId: string; conversationId: string | null }>> {
    const rows = await this.db
      .select({
        turnId: this.schema.turns.id,
        agentId: this.schema.turns.agentId,
        conversationId: this.schema.turns.conversationId,
      })
      .from(this.schema.turns)
      .where(and(
        eq(this.schema.turns.status, 'queued'),
        isNull(this.schema.turns.completedAt),
        lt(this.schema.turns.startedAt, cutoffMs),
      ))
      .orderBy(asc(this.schema.turns.startedAt))
      .limit(Math.max(1, Math.min(Math.trunc(limit), 500)));
    return rows;
  }

  /**
   * Idle veto (ctx-z5k0, full-veto sign-off): a session whose conversation
   * has queued turns is not idle — suspending it would only be whiplash
   * (release the slot, restore seconds later when the dispatcher arrives).
   */
  async hasQueuedTurnsForSandboxSession(sandboxSessionId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM turns t
      JOIN sandbox_sessions s ON s.conversation_id = t.conversation_id
      WHERE s.id = ${sandboxSessionId}
        AND t.status = 'queued' AND t.completed_at IS NULL
      LIMIT 1
    `);
    return Array.from(result as Iterable<unknown>).length > 0;
  }

  /** Oldest queued turn age in ms (null when the queue is empty). */
  async getOldestQueuedTurnAgeMs(): Promise<number | null> {
    const [row] = await this.db
      .select({ oldest: sql<number | null>`min(${this.schema.turns.startedAt})` })
      .from(this.schema.turns)
      .where(and(
        eq(this.schema.turns.status, 'queued'),
        isNull(this.schema.turns.completedAt),
      ));
    const oldest = row?.oldest;
    return oldest === null || oldest === undefined ? null : Date.now() - Number(oldest);
  }

  // ── API Keys (WO-5 scoped extension keys) ──────────────────

  async createApiKey(data: {
    name: string;
    tokenHash: string;
    capabilities: string[];
    note?: string | null;
    createdBy?: string | null;
    expiresAt?: number | null;
    agentId?: string | null;
  }): Promise<ApiKeyRow> {
    return this.insertOne(
      this.db.insert(this.schema.apiKeys).values(data).returning(),
      'api key',
    );
  }

  async listApiKeys(): Promise<ApiKeyRow[]> {
    return this.db.select().from(this.schema.apiKeys).orderBy(asc(this.schema.apiKeys.createdAt));
  }

  async getApiKey(id: string): Promise<ApiKeyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(this.schema.apiKeys)
      .where(eq(this.schema.apiKeys.id, id));
    return row;
  }

  /** Soft revoke; the row is kept for audit. Idempotent — re-revoking keeps the first timestamp. */
  async revokeApiKey(id: string): Promise<ApiKeyRow | undefined> {
    const [row] = await this.db
      .update(this.schema.apiKeys)
      .set({ revokedAt: Date.now() })
      .where(and(eq(this.schema.apiKeys.id, id), isNull(this.schema.apiKeys.revokedAt)))
      .returning();
    if (row) return row;
    return this.getApiKey(id);
  }

  /** Live = not revoked and not expired at `now`. Lookup is by sha256 hash only. */
  async findLiveApiKeyByTokenHash(tokenHash: string, now = Date.now()): Promise<ApiKeyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(this.schema.apiKeys)
      .where(and(
        eq(this.schema.apiKeys.tokenHash, tokenHash),
        isNull(this.schema.apiKeys.revokedAt),
        or(isNull(this.schema.apiKeys.expiresAt), gt(this.schema.apiKeys.expiresAt, now)),
      ));
    return row;
  }

  /** Revalidate an already-authenticated key without retaining or rehashing its token. */
  async isLiveApiKey(id: string, now = Date.now()): Promise<boolean> {
    const [row] = await this.db
      .select({ id: this.schema.apiKeys.id })
      .from(this.schema.apiKeys)
      .where(and(
        eq(this.schema.apiKeys.id, id),
        isNull(this.schema.apiKeys.revokedAt),
        or(isNull(this.schema.apiKeys.expiresAt), gt(this.schema.apiKeys.expiresAt, now)),
      ));
    return row !== undefined;
  }

  async touchApiKeyLastUsed(id: string, at = Date.now()): Promise<void> {
    await this.db
      .update(this.schema.apiKeys)
      .set({ lastUsedAt: at })
      .where(eq(this.schema.apiKeys.id, id));
  }

  // ── Budget Policies ────────────────────────────────────────

  async listBudgetPolicies(): Promise<BudgetPolicyRow[]> {
    return this.db.select().from(this.schema.budgetPolicies).orderBy(asc(this.schema.budgetPolicies.createdAt));
  }

  async getBudgetPolicy(id: string): Promise<BudgetPolicyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(this.schema.budgetPolicies)
      .where(eq(this.schema.budgetPolicies.id, id));
    return row;
  }

  async createBudgetPolicy(data: { name: string; enabled?: boolean; doc: Record<string, unknown> }): Promise<BudgetPolicyRow> {
    const sanitized = sanitizeTypedDbValue(data, 'budget_policies.insert');
    return this.insertOne(
      this.db.insert(this.schema.budgetPolicies).values(sanitized).returning(),
      'budget policy',
    );
  }

  async updateBudgetPolicy(
    id: string,
    updates: Partial<{ name: string; enabled: boolean; doc: Record<string, unknown> }>,
  ): Promise<BudgetPolicyRow | undefined> {
    const sanitized = sanitizeTypedDbValue(updates, 'budget_policies.update');
    const [row] = await this.db
      .update(this.schema.budgetPolicies)
      .set({ ...sanitized, updatedAt: Date.now() })
      .where(eq(this.schema.budgetPolicies.id, id))
      .returning();
    return row;
  }

  async deleteBudgetPolicy(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(this.schema.budgetPolicies)
      .where(eq(this.schema.budgetPolicies.id, id))
      .returning({ id: this.schema.budgetPolicies.id });
    return deleted.length > 0;
  }

  /**
   * Spend for one budget bucket: turns whose tags contain `selector` (plus
   * the groupBy pair when `bucket.value` is set; tag-key-absent when
   * `bucket.value` is null), started at/after `sinceMs`. Open turns count
   * toward `turns` with zero tokens until they finalize.
   */
  async getBudgetSpend(
    selector: Record<string, string>,
    sinceMs: number,
    bucket?: { key: string; value: string | null },
  ): Promise<{
    totalTokens: number | null;
    costUsd: number | null;
    turns: number;
    tokenReportedTurnCount: number;
    costReportedTurnCount: number;
  }> {
    const containment: Record<string, string> = { ...selector };
    const conditions: SQL[] = [
      sql`${this.schema.turns.startedAt} >= ${sinceMs}`,
    ];
    if (bucket) {
      if (bucket.value !== null) {
        containment[bucket.key] = bucket.value;
      } else {
        conditions.push(sql`NOT (${this.schema.turns.tags} ? ${bucket.key})`);
      }
    }
    if (Object.keys(containment).length > 0) {
      conditions.push(sql`${this.schema.turns.tags} @> ${JSON.stringify(containment)}::jsonb`);
    }

    const [row] = await this.db
      .select({
        totalTokens: sql<number | null>`sum(${this.schema.turns.totalTokens})::float8`,
        costUsd: sql<number | null>`sum(${this.turnKnownCostSql()})::float8`,
        turns: sql<number>`count(*)::int`,
        tokenReportedTurnCount: sql<number>`count(${this.schema.turns.totalTokens})::int`,
        costReportedTurnCount: sql<number>`count(${this.turnKnownCostSql()})::int`,
      })
      .from(this.schema.turns)
      .where(and(...conditions));
    return row ?? {
      totalTokens: null,
      costUsd: null,
      turns: 0,
      tokenReportedTurnCount: 0,
      costReportedTurnCount: 0,
    };
  }

  /** Spend grouped by a tag key; bucket is null for turns missing the key. */
  async getBudgetSpendBuckets(
    selector: Record<string, string>,
    sinceMs: number,
    groupByKey: string,
  ): Promise<Array<{
    bucket: string | null;
    totalTokens: number | null;
    costUsd: number | null;
    turns: number;
    tokenReportedTurnCount: number;
    costReportedTurnCount: number;
  }>> {
    const conditions: SQL[] = [
      sql`${this.schema.turns.startedAt} >= ${sinceMs}`,
    ];
    if (Object.keys(selector).length > 0) {
      conditions.push(sql`${this.schema.turns.tags} @> ${JSON.stringify(selector)}::jsonb`);
    }

    return this.db
      .select({
        bucket: sql<string | null>`${this.schema.turns.tags} ->> ${groupByKey}`.as('bucket'),
        totalTokens: sql<number | null>`sum(${this.schema.turns.totalTokens})::float8`,
        costUsd: sql<number | null>`sum(${this.turnKnownCostSql()})::float8`,
        turns: sql<number>`count(*)::int`,
        tokenReportedTurnCount: sql<number>`count(${this.schema.turns.totalTokens})::int`,
        costReportedTurnCount: sql<number>`count(${this.turnKnownCostSql()})::int`,
      })
      .from(this.schema.turns)
      .where(and(...conditions))
      // Group by the output alias: repeating the `tags ->> key` fragment
      // would bind the key as two distinct parameters, which Postgres then
      // rejects as select-expression-not-in-GROUP-BY.
      .groupBy(sql`bucket`);
  }

  // ── Model gateway spend reconciliation ─────────────────

  async claimModelGatewayReconciliationLease(input: {
    gatewayProfile: string;
    gatewayRevision: string;
    ownerId: string;
    nowMs: number;
    leaseMs: number;
  }): Promise<{ fenceToken: number; watermarkMs: number } | undefined> {
    const gatewayProfile = sanitizeDbText(
      input.gatewayProfile,
      'modelGatewayReconciliation.claim.gatewayProfile',
    );
    const gatewayRevision = sanitizeDbText(
      input.gatewayRevision,
      'modelGatewayReconciliation.claim.gatewayRevision',
    );
    const ownerId = sanitizeDbText(
      input.ownerId,
      'modelGatewayReconciliation.claim.ownerId',
    );
    const nowMs = sanitizeTypedDbValue(
      input.nowMs,
      'modelGatewayReconciliation.claim.nowMs',
    );
    const leaseExpiresAt = nowMs + sanitizeTypedDbValue(
      input.leaseMs,
      'modelGatewayReconciliation.claim.leaseMs',
    );

    return this.db.transaction(async (tx) => {
      await tx
        .insert(this.schema.modelGatewayReconciliationState)
        .values({
          gatewayProfile,
          gatewayRevision,
          watermarkMs: 0,
          leaseFenceToken: 0,
          updatedAt: nowMs,
        })
        .onConflictDoNothing();
      const [current] = await tx
        .select()
        .from(this.schema.modelGatewayReconciliationState)
        .where(eq(
          this.schema.modelGatewayReconciliationState.gatewayProfile,
          gatewayProfile,
        ))
        .for('update');
      if (!current) {
        throw new Error(
          `Model gateway reconciliation state ${gatewayProfile} disappeared during claim`,
        );
      }
      if (
        current.leaseOwnerId !== null
        && current.leaseOwnerId !== ownerId
        && current.leaseExpiresAt !== null
        && current.leaseExpiresAt > nowMs
      ) {
        return undefined;
      }

      const fenceToken = current.leaseFenceToken + 1;
      const [claimed] = await tx
        .update(this.schema.modelGatewayReconciliationState)
        .set({
          gatewayRevision,
          leaseOwnerId: ownerId,
          leaseFenceToken: fenceToken,
          leaseExpiresAt,
          lastAttemptAt: nowMs,
          updatedAt: nowMs,
        })
        .where(and(
          eq(
            this.schema.modelGatewayReconciliationState.gatewayProfile,
            gatewayProfile,
          ),
          eq(
            this.schema.modelGatewayReconciliationState.leaseFenceToken,
            current.leaseFenceToken,
          ),
        ))
        .returning({
          fenceToken:
            this.schema.modelGatewayReconciliationState.leaseFenceToken,
          watermarkMs:
            this.schema.modelGatewayReconciliationState.watermarkMs,
        });
      return claimed;
    });
  }

  async recordModelGatewayReconciliationFailure(input: {
    gatewayProfile: string;
    ownerId: string;
    fenceToken: number;
    nowMs: number;
    error: string;
  }): Promise<boolean> {
    const updated = await this.db
      .update(this.schema.modelGatewayReconciliationState)
      .set({
        leaseOwnerId: null,
        leaseExpiresAt: null,
        lastError: sanitizeDbText(
          input.error.slice(0, 2_000),
          'modelGatewayReconciliation.failure.error',
        ),
        updatedAt: input.nowMs,
      })
      .where(and(
        eq(
          this.schema.modelGatewayReconciliationState.gatewayProfile,
          sanitizeDbText(
            input.gatewayProfile,
            'modelGatewayReconciliation.failure.gatewayProfile',
          ),
        ),
        eq(
          this.schema.modelGatewayReconciliationState.leaseOwnerId,
          sanitizeDbText(
            input.ownerId,
            'modelGatewayReconciliation.failure.ownerId',
          ),
        ),
        eq(
          this.schema.modelGatewayReconciliationState.leaseFenceToken,
          input.fenceToken,
        ),
      ))
      .returning({
        gatewayProfile:
          this.schema.modelGatewayReconciliationState.gatewayProfile,
      });
    return updated.length > 0;
  }

  async reconcileModelGatewaySpend(input: {
    gatewayProfile: string;
    gatewayRevision: string;
    ownerId: string;
    fenceToken: number;
    nowMs: number;
    processedThroughMs: number;
    settleBeforeMs: number;
    records: readonly LiteLLMSpendRecord[];
    invalid: readonly InvalidLiteLLMSpendRecord[];
  }): Promise<{
    attached: number;
    quarantined: number;
    affectedTurnIds: string[];
    usageChanges: Array<{
      turnId: string;
      agentId: string;
      previousUsage: TurnUsage | null;
      usage: TurnUsage;
    }>;
    /** Turns skipped mid-batch instead of aborting it (e.g. lost attribution). */
    anomalies: Array<{ turnId: string; reason: string }>;
    watermarkMs: number;
  }> {
    const gatewayProfile = sanitizeDbText(
      input.gatewayProfile,
      'modelGatewayReconciliation.commit.gatewayProfile',
    );
    const gatewayRevision = sanitizeDbText(
      input.gatewayRevision,
      'modelGatewayReconciliation.commit.gatewayRevision',
    );
    const ownerId = sanitizeDbText(
      input.ownerId,
      'modelGatewayReconciliation.commit.ownerId',
    );

    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(this.schema.modelGatewayReconciliationState)
        .where(eq(
          this.schema.modelGatewayReconciliationState.gatewayProfile,
          gatewayProfile,
        ))
        .for('update');
      if (
        !state
        || state.leaseOwnerId !== ownerId
        || state.leaseFenceToken !== input.fenceToken
        || state.leaseExpiresAt === null
        || state.leaseExpiresAt <= input.nowMs
      ) {
        throw new Error(
          `Model gateway reconciliation lease ${gatewayProfile}/${input.fenceToken} is no longer owned`,
        );
      }

      const quarantine = async (entry: {
        transactionId: string;
        correlationId?: string;
        reason: string;
        safeFields: Record<string, unknown>;
      }): Promise<void> => {
        const sanitizedPayload = sanitizeDbJsonValue(
          entry.safeFields,
          'modelGatewaySpendQuarantine.sanitizedPayload',
        ) as Record<string, unknown>;
        await tx
          .insert(this.schema.modelGatewaySpendQuarantine)
          .values({
            gatewayProfile,
            gatewayTransactionId: entry.transactionId,
            correlationId: entry.correlationId ?? null,
            reason: entry.reason,
            sanitizedPayload,
            firstSeenAt: input.nowMs,
            lastSeenAt: input.nowMs,
          })
          .onConflictDoUpdate({
            target: [
              this.schema.modelGatewaySpendQuarantine.gatewayProfile,
              this.schema.modelGatewaySpendQuarantine.gatewayTransactionId,
            ],
            set: {
              correlationId: entry.correlationId ?? null,
              reason: entry.reason,
              sanitizedPayload,
              occurrences: sql<number>`
                ${this.schema.modelGatewaySpendQuarantine.occurrences} + 1
              `,
              lastSeenAt: input.nowMs,
            },
          });
      };

      for (const invalid of input.invalid) {
        await quarantine({
          transactionId: invalid.transactionId,
          ...(invalid.correlationId
            ? { correlationId: invalid.correlationId }
            : {}),
          reason: invalid.reason,
          safeFields: invalid.safeFields,
        });
      }

      const affectedTurnIds = new Set<string>();
      let attached = 0;
      let quarantined = input.invalid.length;
      for (const record of input.records) {
        const [turn] = await tx
          .select()
          .from(this.schema.turns)
          .where(and(
            eq(this.schema.turns.gatewayProfile, gatewayProfile),
            eq(
              this.schema.turns.gatewayCorrelationId,
              record.correlationId,
            ),
          ))
          .limit(1);
        if (!turn) {
          await quarantine({
            transactionId: record.transactionId,
            correlationId: record.correlationId,
            reason: 'unknown_turn',
            safeFields: {
              ...(record.requestedModel
                ? { modelGroup: record.requestedModel }
                : {}),
              ...(record.resolvedModel ? { model: record.resolvedModel } : {}),
              ...(record.provider ? { provider: record.provider } : {}),
              status: record.status,
            },
          });
          quarantined++;
          continue;
        }

        let [aggregate] = await tx
          .select()
          .from(this.schema.modelCallUsage)
          .where(eq(this.schema.modelCallUsage.turnId, turn.id))
          .limit(1);
        if (!aggregate) {
          [aggregate] = await tx
            .insert(this.schema.modelCallUsage)
            .values({
              turnId: turn.id,
              observationScope: 'turn_aggregate',
              gatewayProfile,
              gatewayRevision,
              correlationId: record.correlationId,
              status: 'pending',
              updatedAt: input.nowMs,
            })
            .returning();
        }
        if (!aggregate) {
          throw new Error(`Failed to create model usage aggregate for turn ${turn.id}`);
        }

        const [existingAttempt] = await tx
          .select({
            modelCallUsageId:
              this.schema.modelCallAttemptUsage.modelCallUsageId,
          })
          .from(this.schema.modelCallAttemptUsage)
          .where(and(
            eq(
              this.schema.modelCallAttemptUsage.gatewayProfile,
              gatewayProfile,
            ),
            eq(
              this.schema.modelCallAttemptUsage.gatewayTransactionId,
              record.transactionId,
            ),
          ))
          .limit(1);
        if (
          existingAttempt
          && existingAttempt.modelCallUsageId !== aggregate.id
        ) {
          // Poison pill: throwing here aborted the whole batch with the
          // offending record pinned inside the read window, stalling the
          // watermark forever (ctx-wpln c). Quarantine it and move on.
          await quarantine({
            transactionId: record.transactionId,
            correlationId: record.correlationId,
            reason: 'attached_elsewhere',
            safeFields: {
              ...(record.requestedModel
                ? { modelGroup: record.requestedModel }
                : {}),
              ...(record.resolvedModel ? { model: record.resolvedModel } : {}),
              ...(record.provider ? { provider: record.provider } : {}),
              status: record.status,
            },
          });
          quarantined++;
          continue;
        }
        await tx
          .insert(this.schema.modelCallAttemptUsage)
          .values({
            modelCallUsageId: aggregate.id,
            gatewayProfile,
            gatewayRevision,
            gatewayTransactionId: record.transactionId,
            requestedModel: record.requestedModel ?? null,
            resolvedModel: record.resolvedModel ?? null,
            provider: record.provider ?? null,
            status: record.status,
            inputTokens: record.inputTokens ?? null,
            outputTokens: record.outputTokens ?? null,
            totalTokens: record.totalTokens ?? null,
            cacheReadTokens: record.cacheReadTokens ?? null,
            cacheCreateTokens: record.cacheCreateTokens ?? null,
            reasoningTokens: record.reasoningTokens ?? null,
            costUsd: record.costUsd ?? null,
            costState: record.costState,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            ingestedAt: input.nowMs,
          })
          .onConflictDoUpdate({
            target: [
              this.schema.modelCallAttemptUsage.gatewayProfile,
              this.schema.modelCallAttemptUsage.gatewayTransactionId,
            ],
            set: {
              gatewayRevision,
              requestedModel: record.requestedModel ?? null,
              resolvedModel: record.resolvedModel ?? null,
              provider: record.provider ?? null,
              status: record.status,
              inputTokens: record.inputTokens ?? null,
              outputTokens: record.outputTokens ?? null,
              totalTokens: record.totalTokens ?? null,
              cacheReadTokens: record.cacheReadTokens ?? null,
              cacheCreateTokens: record.cacheCreateTokens ?? null,
              reasoningTokens: record.reasoningTokens ?? null,
              costUsd: record.costUsd ?? null,
              costState: record.costState,
              startedAt: record.startedAt,
              endedAt: record.endedAt,
              ingestedAt: input.nowMs,
            },
          });
        await tx
          .delete(this.schema.modelGatewaySpendQuarantine)
          .where(and(
            eq(
              this.schema.modelGatewaySpendQuarantine.gatewayProfile,
              gatewayProfile,
            ),
            eq(
              this.schema.modelGatewaySpendQuarantine.gatewayTransactionId,
              record.transactionId,
            ),
          ));
        attached++;
        affectedTurnIds.add(turn.id);
      }

      const usageChanges: Array<{
        turnId: string;
        agentId: string;
        previousUsage: TurnUsage | null;
        usage: TurnUsage;
      }> = [];
      const anomalies: Array<{ turnId: string; reason: string }> = [];
      for (const turnId of affectedTurnIds) {
        const [turn] = await tx
          .select()
          .from(this.schema.turns)
          .where(eq(this.schema.turns.id, turnId))
          .limit(1);
        const [aggregate] = await tx
          .select()
          .from(this.schema.modelCallUsage)
          .where(eq(this.schema.modelCallUsage.turnId, turnId))
          .limit(1);
        if (!turn || !aggregate || !turn.gatewayMode) {
          // Poison pill: aborting here re-pinned the whole batch on one
          // inconsistent turn (ctx-wpln c). Skip it and let the caller log.
          anomalies.push({ turnId, reason: 'lost_attribution_row' });
          continue;
        }
        const attempts = await tx
          .select()
          .from(this.schema.modelCallAttemptUsage)
          .where(eq(
            this.schema.modelCallAttemptUsage.modelCallUsageId,
            aggregate.id,
          ));
        const settled = turn.completedAt !== null
          && turn.completedAt <= input.settleBeforeMs;
        const harnessUsage = (
          turn.inputTokens !== null
          && turn.outputTokens !== null
          && turn.totalTokens !== null
        )
          ? {
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
            totalTokens: turn.totalTokens,
          }
          : null;
        const usage = projectGatewayTurnUsage({
          turnMode: turn.gatewayMode,
          harnessUsage,
          attempts,
          settled,
        });
        const knownCostUsd = attempts.reduce(
          (sum, attempt) => sum + (
            attempt.costState === 'unpriced'
              ? 0
              : attempt.costUsd ?? 0
          ),
          0,
        );
        const aggregateCostState = attempts.some(
          (attempt) => attempt.costState === 'unpriced',
        )
          ? 'unpriced'
          : attempts.some((attempt) => attempt.costState === 'priced')
            ? 'priced'
            : 'explicit_free';
        const aggregateTokens = attempts.reduce<{
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          cacheReadTokens: number;
          cacheCreateTokens: number;
          reasoningTokens: number;
        }>((sum, attempt) => ({
          inputTokens: sum.inputTokens + (attempt.inputTokens ?? 0),
          outputTokens: sum.outputTokens + (attempt.outputTokens ?? 0),
          totalTokens: sum.totalTokens + (attempt.totalTokens ?? 0),
          cacheReadTokens: sum.cacheReadTokens + (attempt.cacheReadTokens ?? 0),
          cacheCreateTokens:
            sum.cacheCreateTokens + (attempt.cacheCreateTokens ?? 0),
          reasoningTokens:
            sum.reasoningTokens + (attempt.reasoningTokens ?? 0),
        }), {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          reasoningTokens: 0,
        });

        await tx
          .update(this.schema.modelCallUsage)
          .set({
            gatewayRevision,
            status: settled ? 'settled' : 'pending',
            inputTokens: aggregateTokens.inputTokens,
            outputTokens: aggregateTokens.outputTokens,
            totalTokens: aggregateTokens.totalTokens,
            cacheReadTokens: aggregateTokens.cacheReadTokens,
            cacheCreateTokens: aggregateTokens.cacheCreateTokens,
            reasoningTokens: aggregateTokens.reasoningTokens,
            knownCostUsd,
            costState: aggregateCostState,
            updatedAt: input.nowMs,
          })
          .where(eq(this.schema.modelCallUsage.id, aggregate.id));
        if (usage) {
          await tx
            .update(this.schema.turns)
            .set({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              costUsd: usage.cost.totalUsd,
              usage,
              usageReconciledAt: input.nowMs,
            })
            .where(eq(this.schema.turns.id, turnId));
          const previousUsage = turn.usage ?? null;
          if (!isDeepStrictEqual(previousUsage, usage)) {
            usageChanges.push({
              turnId,
              agentId: turn.agentId,
              previousUsage,
              usage,
            });
          }
        }
      }

      const watermarkMs = Math.max(
        state.watermarkMs,
        input.processedThroughMs,
      );
      const [committed] = await tx
        .update(this.schema.modelGatewayReconciliationState)
        .set({
          gatewayRevision,
          watermarkMs,
          leaseOwnerId: null,
          leaseExpiresAt: null,
          lastSuccessAt: input.nowMs,
          lastError: null,
          updatedAt: input.nowMs,
        })
        .where(and(
          eq(
            this.schema.modelGatewayReconciliationState.gatewayProfile,
            gatewayProfile,
          ),
          eq(
            this.schema.modelGatewayReconciliationState.leaseOwnerId,
            ownerId,
          ),
          eq(
            this.schema.modelGatewayReconciliationState.leaseFenceToken,
            input.fenceToken,
          ),
        ))
        .returning({
          watermarkMs:
            this.schema.modelGatewayReconciliationState.watermarkMs,
        });
      if (!committed) {
        throw new Error(
          `Model gateway reconciliation lease ${gatewayProfile}/${input.fenceToken} was lost before commit`,
        );
      }
      // Quarantine rows either resolve (deleted on successful attach) or go
      // stale; without a TTL the table grows without bound (ctx-wpln).
      await tx
        .delete(this.schema.modelGatewaySpendQuarantine)
        .where(and(
          eq(
            this.schema.modelGatewaySpendQuarantine.gatewayProfile,
            gatewayProfile,
          ),
          lt(
            this.schema.modelGatewaySpendQuarantine.lastSeenAt,
            input.nowMs - MODEL_GATEWAY_QUARANTINE_TTL_MS,
          ),
        ));

      return {
        attached,
        quarantined,
        affectedTurnIds: [...affectedTurnIds],
        usageChanges,
        anomalies,
        watermarkMs: committed.watermarkMs,
      };
    });
  }

  /**
   * Extend the reconciliation lease mid-run so long fetch/commit cycles do
   * not expire underneath their own work (ctx-wpln e). Returns false when the
   * lease is no longer this owner's — the caller must abandon the run.
   */
  async extendModelGatewayReconciliationLease(input: {
    gatewayProfile: string;
    ownerId: string;
    fenceToken: number;
    nowMs: number;
    leaseMs: number;
  }): Promise<boolean> {
    const gatewayProfile = sanitizeDbText(
      input.gatewayProfile,
      'modelGatewayReconciliation.extend.gatewayProfile',
    );
    const ownerId = sanitizeDbText(
      input.ownerId,
      'modelGatewayReconciliation.extend.ownerId',
    );
    const nowMs = sanitizeTypedDbValue(
      input.nowMs,
      'modelGatewayReconciliation.extend.nowMs',
    );
    const updated = await this.db
      .update(this.schema.modelGatewayReconciliationState)
      .set({
        leaseExpiresAt: nowMs + sanitizeTypedDbValue(
          input.leaseMs,
          'modelGatewayReconciliation.extend.leaseMs',
        ),
        updatedAt: nowMs,
      })
      .where(and(
        eq(
          this.schema.modelGatewayReconciliationState.gatewayProfile,
          gatewayProfile,
        ),
        eq(
          this.schema.modelGatewayReconciliationState.leaseOwnerId,
          ownerId,
        ),
        eq(
          this.schema.modelGatewayReconciliationState.leaseFenceToken,
          input.fenceToken,
        ),
        gt(
          this.schema.modelGatewayReconciliationState.leaseExpiresAt,
          nowMs,
        ),
      ))
      .returning({
        gatewayProfile:
          this.schema.modelGatewayReconciliationState.gatewayProfile,
      });
    return updated.length > 0;
  }

  async getModelGatewayReconciliationState(
    gatewayProfile: string,
  ): Promise<
    typeof this.schema.modelGatewayReconciliationState.$inferSelect | undefined
  > {
    return this.db.query.modelGatewayReconciliationState.findFirst({
      where: eq(
        this.schema.modelGatewayReconciliationState.gatewayProfile,
        gatewayProfile,
      ),
    });
  }

  async getModelGatewayReconciliationMetrics(
    gatewayProfile: string,
  ): Promise<{
    pendingCalls: number;
    unpricedCalls: number;
    quarantinedTransactions: number;
    orphanTransactions: number;
  }> {
    const profile = sanitizeDbText(
      gatewayProfile,
      'modelGatewayReconciliation.metrics.gatewayProfile',
    );
    const [callMetrics] = await this.db
      .select({
        pendingCalls: sql<number>`
          count(*) filter (
            where ${this.schema.modelCallUsage.status} = 'pending'
          )::int
        `,
        unpricedCalls: sql<number>`
          count(*) filter (
            where ${this.schema.modelCallUsage.costState} = 'unpriced'
          )::int
        `,
      })
      .from(this.schema.modelCallUsage)
      .where(eq(this.schema.modelCallUsage.gatewayProfile, profile));
    const [quarantineMetrics] = await this.db
      .select({
        quarantinedTransactions: sql<number>`count(*)::int`,
        orphanTransactions: sql<number>`
          count(*) filter (
            where ${this.schema.modelGatewaySpendQuarantine.reason} = 'unknown_turn'
          )::int
        `,
      })
      .from(this.schema.modelGatewaySpendQuarantine)
      .where(eq(
        this.schema.modelGatewaySpendQuarantine.gatewayProfile,
        profile,
      ));
    return {
      pendingCalls: callMetrics?.pendingCalls ?? 0,
      unpricedCalls: callMetrics?.unpricedCalls ?? 0,
      quarantinedTransactions:
        quarantineMetrics?.quarantinedTransactions ?? 0,
      orphanTransactions: quarantineMetrics?.orphanTransactions ?? 0,
    };
  }

  /**
   * Completed gateway-attributed turns whose usage was never reconciled.
   * Deliberately independent of the reconciliation-state tables so the
   * backlog is visible even when ingestion is disabled or misconfigured
   * (ctx-fpi1: degradation must be explicit, never silent).
   */
  async getGatewayTurnsAwaitingReconciliation(): Promise<{
    count: number;
    oldestCompletedAt: number | null;
  }> {
    const [row] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        oldestCompletedAt: sql<number | null>`min(${this.schema.turns.completedAt})::float8`,
      })
      .from(this.schema.turns)
      .where(and(
        isNotNull(this.schema.turns.gatewayMode),
        isNotNull(this.schema.turns.completedAt),
        isNull(this.schema.turns.usageReconciledAt),
      ));
    return {
      count: row?.count ?? 0,
      oldestCompletedAt: row?.oldestCompletedAt ?? null,
    };
  }

  /**
   * Settle gateway-attributed turns whose spend evidence never arrived
   * (ctx-qqqp). Past the abandonment grace a missing spend row is permanently
   * missing — the reconciler's read window has long advanced beyond the call's
   * time range — so the envelope is stamped coverage=unpriced with token
   * telemetry preserved: the same honest correction previously applied by
   * hand, and the per-turn coverage value keeps every loss queryable. Covers
   * both completed turns (lost spend row) and error turns that never made a
   * billable call.
   */
  async settleAbandonedGatewayTurns(input: {
    nowMs: number;
    abandonedBeforeMs: number;
    limit?: number;
  }): Promise<Array<{ turnId: string; correlationId: string | null }>> {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 500));
    const unpricedCost = JSON.stringify({ coverage: 'unpriced', knownUsd: 0, totalUsd: null });
    const emptyEnvelope = JSON.stringify({
      cost: { coverage: 'unpriced', knownUsd: 0, totalUsd: null },
      modelCalls: { expected: null, observed: 0, costKnown: 0 },
      inputTokens: 0,
      totalTokens: 0,
      outputTokens: 0,
    });
    const result = await this.db.execute(sql`
      UPDATE turns SET
        usage = CASE
          WHEN usage IS NULL THEN ${emptyEnvelope}::jsonb
          ELSE jsonb_set(usage, '{cost}', ${unpricedCost}::jsonb)
        END,
        usage_reconciled_at = ${input.nowMs}
      WHERE id IN (
        SELECT id FROM turns
        WHERE gateway_mode IS NOT NULL
          AND completed_at IS NOT NULL
          AND completed_at < ${input.abandonedBeforeMs}
          AND usage_reconciled_at IS NULL
        ORDER BY completed_at ASC
        LIMIT ${limit}
      )
      RETURNING id AS turn_id, gateway_correlation_id
    `);
    return Array.from(result as Iterable<Record<string, unknown>>).map((row) => ({
      turnId: String(row.turn_id),
      correlationId: row.gateway_correlation_id === null
        ? null
        : String(row.gateway_correlation_id),
    }));
  }

  async getModelGatewayQuarantineSummary(
    gatewayProfile: string,
    options: { recentSinceMs: number; limit: number },
  ): Promise<{
    reasons: Array<{
      reason: string;
      total: number;
      recentTotal: number;
      lastSeenAt: number | null;
    }>;
    recent: Array<{
      transactionId: string;
      correlationId: string | null;
      reason: string;
      occurrences: number;
      firstSeenAt: number;
      lastSeenAt: number;
      sanitizedPayload: Record<string, unknown>;
    }>;
  }> {
    const profile = sanitizeDbText(
      gatewayProfile,
      'modelGatewayQuarantine.summary.gatewayProfile',
    );
    const quarantine = this.schema.modelGatewaySpendQuarantine;
    const [reasons, recentRows] = await Promise.all([
      this.db
        .select({
          reason: quarantine.reason,
          total: sql<number>`count(*)::int`,
          recentTotal: sql<number>`
            count(*) FILTER (
              where ${quarantine.lastSeenAt} >= ${options.recentSinceMs}
            )::int
          `,
          lastSeenAt: sql<number | null>`max(${quarantine.lastSeenAt})::float8`,
        })
        .from(quarantine)
        .where(eq(quarantine.gatewayProfile, profile))
        .groupBy(quarantine.reason)
        .orderBy(sql`count(*) desc`),
      this.db
        .select({
          transactionId: quarantine.gatewayTransactionId,
          correlationId: quarantine.correlationId,
          reason: quarantine.reason,
          occurrences: quarantine.occurrences,
          firstSeenAt: quarantine.firstSeenAt,
          lastSeenAt: quarantine.lastSeenAt,
          sanitizedPayload: quarantine.sanitizedPayload,
        })
        .from(quarantine)
        .where(eq(quarantine.gatewayProfile, profile))
        .orderBy(desc(quarantine.lastSeenAt))
        .limit(options.limit),
    ]);
    return { reasons, recent: recentRows };
  }

  // ── Sandbox Sessions ───────────────────────────────────────

  async createSandboxSession(session: {
    id?: string;
    conversationId: string;
    agentId: string;
    containerName?: string;
    containerId?: string;
    status?: SandboxSessionStatus;
    harnessName: string;
    runtimeDefinitionHash?: string;
  }): Promise<SandboxSessionRow> {
    const sanitizedSession = sanitizeTypedDbValue(session, 'sandboxSessions.insert');
    if (sanitizedSession.status === 'RESTORING') {
      throw new Error(
        'RESTORING sandbox sessions must be entered through claimSandboxSessionRestore',
      );
    }
    try {
      return await this.insertOne(
        this.db
          .insert(this.schema.sandboxSessions)
          .values({
            ...(sanitizedSession.id !== undefined ? { id: sanitizedSession.id } : {}),
            conversationId: sanitizedSession.conversationId,
            agentId: sanitizedSession.agentId,
            containerName: sanitizedSession.containerName ?? null,
            containerId: sanitizedSession.containerId ?? null,
            status: validateSandboxSessionStatus(
              sanitizedSession.status ?? 'ACTIVE',
              'sandboxSessions.insert.status',
            ),
            harnessName: sanitizedSession.harnessName,
            runtimeDefinitionHash:
              sanitizedSession.runtimeDefinitionHash ?? null,
          })
          .returning(),
        'sandbox session',
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error, LIVE_SANDBOX_SESSION_INDEX)) {
        throw new LiveSandboxSessionConflictError(
          sanitizedSession.conversationId,
        );
      }
      throw error;
    }
  }

  async getSandboxSession(id: string): Promise<SandboxSessionRow | null> {
    const rows = await this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(eq(this.schema.sandboxSessions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getSandboxSessionByConversation(conversationId: string): Promise<SandboxSessionRow | null> {
    const rows = await this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(eq(this.schema.sandboxSessions.conversationId, conversationId))
      .orderBy(
        sql`CASE
          WHEN ${this.schema.sandboxSessions.status} IN ('ACTIVE', 'RESTORING')
            THEN 0
          ELSE 1
        END`,
        desc(this.schema.sandboxSessions.createdAt),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getLiveSandboxSessionByConversation(
    conversationId: string,
  ): Promise<SandboxSessionRow | null> {
    const rows = await this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(and(
        eq(
          this.schema.sandboxSessions.conversationId,
          sanitizeDbText(
            conversationId,
            'sandboxSessions.liveByConversation.conversationId',
          ),
        ),
        inArray(this.schema.sandboxSessions.status, ['ACTIVE', 'RESTORING']),
      ))
      .orderBy(desc(this.schema.sandboxSessions.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Atomically admits one checkpoint restore generation and consumes one
   * global retry attempt.
   */
  async claimSandboxSessionRestore(input: {
    sandboxSessionId: string;
    ownerId: string;
    leaseDurationMs: number;
    maxAttempts: number;
  }): Promise<SandboxSessionRow | undefined> {
    const sandboxSessionId = sanitizeDbText(
      input.sandboxSessionId,
      'sandboxSessionRestore.claim.sandboxSessionId',
    );
    const ownerId = sanitizeDbText(
      input.ownerId,
      'sandboxSessionRestore.claim.ownerId',
    );
    const leaseDurationMs = validateLeaseDurationMs(
      input.leaseDurationMs,
      'sandboxSessionRestore.claim.leaseDurationMs',
    );
    const maxAttempts = validatePositiveSafeInteger(
      input.maxAttempts,
      'sandboxSessionRestore.claim.maxAttempts',
    );
    try {
      const [claimed] = await this.db
        .update(this.schema.sandboxSessions)
        .set({
          status: 'RESTORING',
          restoreOwnerId: ownerId,
          restoreFenceToken:
            sql`${this.schema.sandboxSessions.restoreFenceToken} + 1`,
          restoreLeaseExpiresAt:
            sql`${databaseClockMs()} + ${leaseDurationMs}`,
          restoreAttempts:
            sql`${this.schema.sandboxSessions.restoreAttempts} + 1`,
          updatedAt: databaseClockMs(),
          lastActivityAt: databaseClockMs(),
        })
        .where(and(
          eq(this.schema.sandboxSessions.id, sandboxSessionId),
          eq(this.schema.sandboxSessions.status, 'CHECKPOINTED'),
          lt(this.schema.sandboxSessions.restoreAttempts, maxAttempts),
        ))
        .returning();
      return claimed;
    } catch (error) {
      if (isUniqueConstraintViolation(error, LIVE_SANDBOX_SESSION_INDEX)) {
        const session = await this.getSandboxSession(sandboxSessionId);
        if (session) {
          throw new LiveSandboxSessionConflictError(session.conversationId);
        }
      }
      throw error;
    }
  }

  async renewSandboxSessionRestoreLease(
    sandboxSessionId: string,
    fence: SandboxSessionRestoreFence,
    leaseDurationMs: number,
  ): Promise<SandboxSessionRow | undefined> {
    const [renewed] = await this.db
      .update(this.schema.sandboxSessions)
      .set({
        restoreLeaseExpiresAt: sql`${databaseClockMs()} + ${validateLeaseDurationMs(
          leaseDurationMs,
          'sandboxSessionRestore.renew.leaseDurationMs',
        )}`,
        updatedAt: databaseClockMs(),
      })
      .where(and(
        eq(
          this.schema.sandboxSessions.id,
          sanitizeDbText(
            sandboxSessionId,
            'sandboxSessionRestore.renew.sandboxSessionId',
          ),
        ),
        eq(this.schema.sandboxSessions.status, 'RESTORING'),
        eq(
          this.schema.sandboxSessions.restoreOwnerId,
          sanitizeDbText(fence.ownerId, 'sandboxSessionRestore.renew.ownerId'),
        ),
        eq(
          this.schema.sandboxSessions.restoreFenceToken,
          validateTurnDeliveryFenceToken(
            fence.fenceToken,
            'sandboxSessionRestore.renew.fenceToken',
          ),
        ),
        gt(
          this.schema.sandboxSessions.restoreLeaseExpiresAt,
          databaseClockMs(),
        ),
      ))
      .returning();
    return renewed;
  }

  async completeSandboxSessionRestore(
    sandboxSessionId: string,
    fence: SandboxSessionRestoreFence,
    runtime: {
      containerName: string;
      containerId: string;
    },
  ): Promise<SandboxSessionRow | undefined> {
    const sanitizedRuntime = sanitizeTypedDbValue(
      runtime,
      'sandboxSessionRestore.complete.runtime',
    );
    try {
      const [completed] = await this.db
        .update(this.schema.sandboxSessions)
        .set({
          status: 'ACTIVE',
          containerName: sanitizedRuntime.containerName,
          containerId: sanitizedRuntime.containerId,
          restoreAttempts: 0,
          lastRestoreError: null,
          restoreOwnerId: null,
          restoreLeaseExpiresAt: null,
          updatedAt: databaseClockMs(),
          lastActivityAt: databaseClockMs(),
        })
        .where(and(
          eq(
            this.schema.sandboxSessions.id,
            sanitizeDbText(
              sandboxSessionId,
              'sandboxSessionRestore.complete.sandboxSessionId',
            ),
          ),
          eq(this.schema.sandboxSessions.status, 'RESTORING'),
          eq(
            this.schema.sandboxSessions.restoreOwnerId,
            sanitizeDbText(
              fence.ownerId,
              'sandboxSessionRestore.complete.ownerId',
            ),
          ),
          eq(
            this.schema.sandboxSessions.restoreFenceToken,
            validateTurnDeliveryFenceToken(
              fence.fenceToken,
              'sandboxSessionRestore.complete.fenceToken',
            ),
          ),
          gt(
            this.schema.sandboxSessions.restoreLeaseExpiresAt,
            databaseClockMs(),
          ),
        ))
        .returning();
      return completed;
    } catch (error) {
      if (isUniqueConstraintViolation(error, LIVE_SANDBOX_SESSION_INDEX)) {
        const session = await this.getSandboxSession(sandboxSessionId);
        if (session) {
          throw new LiveSandboxSessionConflictError(session.conversationId);
        }
      }
      throw error;
    }
  }

  async failSandboxSessionRestore(
    sandboxSessionId: string,
    fence: SandboxSessionRestoreFence,
    failure: {
      toStatus: 'CHECKPOINTED' | 'TERMINATED';
      error: string;
    },
  ): Promise<SandboxSessionRow | undefined> {
    const [failed] = await this.db
      .update(this.schema.sandboxSessions)
      .set({
        status: failure.toStatus,
        containerName: null,
        containerId: null,
        lastRestoreError: sanitizeDbText(
          failure.error,
          'sandboxSessionRestore.fail.error',
        ),
        restoreOwnerId: null,
        restoreLeaseExpiresAt: null,
        updatedAt: databaseClockMs(),
        lastActivityAt: databaseClockMs(),
      })
      .where(and(
        eq(
          this.schema.sandboxSessions.id,
          sanitizeDbText(
            sandboxSessionId,
            'sandboxSessionRestore.fail.sandboxSessionId',
          ),
        ),
        eq(this.schema.sandboxSessions.status, 'RESTORING'),
        eq(
          this.schema.sandboxSessions.restoreOwnerId,
          sanitizeDbText(fence.ownerId, 'sandboxSessionRestore.fail.ownerId'),
        ),
        eq(
          this.schema.sandboxSessions.restoreFenceToken,
          validateTurnDeliveryFenceToken(
            fence.fenceToken,
            'sandboxSessionRestore.fail.fenceToken',
          ),
        ),
        gt(
          this.schema.sandboxSessions.restoreLeaseExpiresAt,
          databaseClockMs(),
        ),
      ))
      .returning();
    return failed;
  }

  /**
   * Fence and reconcile exactly one expired restore generation. A stale owner
   * can no longer complete or record failure after this transaction commits.
   */
  async reconcileExpiredSandboxSessionRestore(
    sandboxSessionId: string,
    expectedFenceToken?: number,
  ): Promise<ReconciledSandboxSessionRestore | undefined> {
    const sanitizedSessionId = sanitizeDbText(
      sandboxSessionId,
      'sandboxSessionRestore.reconcile.sandboxSessionId',
    );
    const validatedFenceToken = expectedFenceToken === undefined
      ? undefined
      : validateTurnDeliveryFenceToken(
          expectedFenceToken,
          'sandboxSessionRestore.reconcile.fenceToken',
        );
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(this.schema.sandboxSessions.id, sanitizedSessionId),
          eq(this.schema.sandboxSessions.status, 'RESTORING'),
          ...(validatedFenceToken === undefined
            ? []
            : [
                eq(
                  this.schema.sandboxSessions.restoreFenceToken,
                  validatedFenceToken,
                ),
              ]),
        ))
        .for('update');
      const [clock] = await tx
        .select({ nowMs: databaseClockMs() })
        .from(this.schema.sandboxSessions)
        .where(eq(this.schema.sandboxSessions.id, sanitizedSessionId))
        .limit(1);
      if (
        !session
        || session.restoreLeaseExpiresAt === null
        || !clock
        || session.restoreLeaseExpiresAt > parseDatabaseClockMs(clock.nowMs)
      ) {
        return undefined;
      }

      const [checkpoint] = await tx
        .select({ id: this.schema.agentCheckpoints.id })
        .from(this.schema.agentCheckpoints)
        .where(eq(
          this.schema.agentCheckpoints.sandboxSessionId,
          sanitizedSessionId,
        ))
        .limit(1);
      const outcome = checkpoint ? 'CHECKPOINTED' : 'TERMINATED';
      const [reconciled] = await tx
        .update(this.schema.sandboxSessions)
        .set({
          status: outcome,
          containerName: null,
          containerId: null,
          restoreOwnerId: null,
          restoreFenceToken:
            sql`${this.schema.sandboxSessions.restoreFenceToken} + 1`,
          restoreLeaseExpiresAt: null,
          lastRestoreError:
            session.lastRestoreError ?? 'restore lease expired before completion',
          updatedAt: databaseClockMs(),
          lastActivityAt: databaseClockMs(),
        })
        .where(and(
          eq(this.schema.sandboxSessions.id, sanitizedSessionId),
          eq(this.schema.sandboxSessions.status, 'RESTORING'),
          eq(
            this.schema.sandboxSessions.restoreFenceToken,
            session.restoreFenceToken,
          ),
        ))
        .returning();
      return reconciled ? { session: reconciled, outcome } : undefined;
    });
  }

  /**
   * Durable evidence of an idle-checkpoint failure (ctx-vsf8): the in-memory
   * retry counter dies with the process, but the operator question "why is
   * this session still holding a slot" needs a persisted answer. Returns the
   * new failure count.
   */
  async recordSandboxSessionCheckpointFailure(
    sessionId: string,
    error: string,
    nowMs: number,
  ): Promise<number> {
    const rows = await this.db
      .update(this.schema.sandboxSessions)
      .set({
        checkpointFailures: sql<number>`${this.schema.sandboxSessions.checkpointFailures} + 1`,
        lastCheckpointError: sanitizeDbText(
          error.slice(0, 2_000),
          'sandboxSession.lastCheckpointError',
        ),
        updatedAt: nowMs,
      })
      .where(eq(this.schema.sandboxSessions.id, sessionId))
      .returning({ checkpointFailures: this.schema.sandboxSessions.checkpointFailures });
    return rows[0]?.checkpointFailures ?? 0;
  }

  /** A successful checkpoint clears the failure evidence. */
  async clearSandboxSessionCheckpointFailures(sessionId: string, nowMs: number): Promise<void> {
    await this.db
      .update(this.schema.sandboxSessions)
      .set({ checkpointFailures: 0, lastCheckpointError: null, updatedAt: nowMs })
      .where(and(
        eq(this.schema.sandboxSessions.id, sessionId),
        gt(this.schema.sandboxSessions.checkpointFailures, 0),
      ));
  }

  async updateSandboxSessionMetadata(
    id: string,
    status: SandboxSessionStatus,
    extra: {
      containerName?: string | null;
      containerId?: string | null;
      restoreAttempts?: number | null;
      lastRestoreError?: string | null;
    },
    expectedActiveGeneration: SandboxSessionActiveGeneration | undefined,
  ): Promise<void> {
    const sanitizedSessionId = sanitizeDbText(
      id,
      'sandboxSessions.metadata.id',
    );
    const expectedStatus = validateSandboxSessionStatus(
      status,
      'sandboxSessions.metadata.status',
    );
    const sanitizedExtra = sanitizeTypedDbValue(
      extra,
      'sandboxSessions.metadata',
    );
    if (expectedStatus === 'RESTORING') {
      throw new Error(
        'RESTORING sandbox session metadata requires a restore-fenced method',
      );
    }
    if (expectedStatus === 'ACTIVE' && !expectedActiveGeneration) {
      throw new Error(
        'ACTIVE sandbox session metadata requires its expected active generation',
      );
    }
    if (expectedStatus !== 'ACTIVE' && expectedActiveGeneration) {
      throw new Error(
        `${expectedStatus} sandbox session metadata cannot use an active generation`,
      );
    }
    const validatedActiveGeneration = expectedActiveGeneration
      ? {
          restoreFenceToken: validateNonNegativeSafeInteger(
            expectedActiveGeneration.restoreFenceToken,
            'sandboxSessions.metadata.restoreFenceToken',
          ),
          containerId: expectedActiveGeneration.containerId === null
            ? null
            : sanitizeDbText(
                expectedActiveGeneration.containerId,
                'sandboxSessions.metadata.containerId',
              ),
        }
      : undefined;

    await this.db.transaction(async (tx) => {
      // Serialize with lifecycle claim on the session row first. The lifecycle
      // query must be a second READ COMMITTED statement after acquiring that
      // lock; embedding NOT EXISTS in a waiting UPDATE can retain a stale
      // pre-wait snapshot and cross a just-admitted lifecycle operation.
      const [session] = await tx
        .select({
          id: this.schema.sandboxSessions.id,
          status: this.schema.sandboxSessions.status,
          restoreFenceToken: this.schema.sandboxSessions.restoreFenceToken,
          containerId: this.schema.sandboxSessions.containerId,
        })
        .from(this.schema.sandboxSessions)
        .where(eq(this.schema.sandboxSessions.id, sanitizedSessionId))
        .for('update');
      if (
        !session
        || session.status !== expectedStatus
        || (
          expectedStatus === 'ACTIVE'
          && (
            session.restoreFenceToken
              !== validatedActiveGeneration!.restoreFenceToken
            || session.containerId !== validatedActiveGeneration!.containerId
          )
        )
      ) {
        throw new SandboxSessionStatusConflictError(
          sanitizedSessionId,
          expectedStatus,
          expectedStatus,
        );
      }

      if (expectedStatus === 'ACTIVE') {
        const [lifecycleOperation] = await tx
          .select({
            sandboxSessionId:
              this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          })
          .from(this.schema.sandboxSessionLifecycleOperations)
          .where(and(
            eq(
              this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
              sanitizedSessionId,
            ),
            inArray(
              this.schema.sandboxSessionLifecycleOperations.phase,
              ['reserved', 'draining', 'executing'],
            ),
          ))
          .limit(1);
        if (lifecycleOperation) {
          throw new SandboxSessionStatusConflictError(
            sanitizedSessionId,
            expectedStatus,
            expectedStatus,
          );
        }
      }

      const [updated] = await tx
        .update(this.schema.sandboxSessions)
        .set({
          updatedAt: databaseClockMs(),
          lastActivityAt: databaseClockMs(),
          ...(sanitizedExtra.containerName !== undefined
            ? { containerName: sanitizedExtra.containerName }
            : {}),
          ...(sanitizedExtra.containerId !== undefined
            ? { containerId: sanitizedExtra.containerId }
            : {}),
          ...(sanitizedExtra.restoreAttempts !== undefined
            && sanitizedExtra.restoreAttempts !== null
            ? { restoreAttempts: sanitizedExtra.restoreAttempts }
            : {}),
          ...(sanitizedExtra.lastRestoreError !== undefined
            ? { lastRestoreError: sanitizedExtra.lastRestoreError }
            : {}),
        })
        .where(and(
          eq(this.schema.sandboxSessions.id, sanitizedSessionId),
          eq(this.schema.sandboxSessions.status, expectedStatus),
        ))
        .returning({ id: this.schema.sandboxSessions.id });
      if (!updated) {
        throw new SandboxSessionStatusConflictError(
          sanitizedSessionId,
          expectedStatus,
          expectedStatus,
        );
      }
    });
  }

  async deleteSandboxSession(id: string): Promise<void> {
    await this.db
      .delete(this.schema.sandboxSessions)
      .where(eq(this.schema.sandboxSessions.id, id));
  }

  async getActiveSandboxSessions(): Promise<SandboxSessionRow[]> {
    return this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(eq(this.schema.sandboxSessions.status, 'ACTIVE'));
  }

  /** All sessions currently inside the cross-replica restore admission state. */
  async getRestoringSandboxSessions(): Promise<SandboxSessionRow[]> {
    return this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(eq(this.schema.sandboxSessions.status, 'RESTORING'));
  }

  /** Restore generations whose durable owner lease has expired. */
  async getExpiredSandboxSessionRestores(): Promise<SandboxSessionRow[]> {
    return this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(and(
        eq(this.schema.sandboxSessions.status, 'RESTORING'),
        lte(
          this.schema.sandboxSessions.restoreLeaseExpiresAt,
          databaseClockMs(),
        ),
      ));
  }

  async getSandboxSessionsByAgent(agentId: string): Promise<SandboxSessionRow[]> {
    return this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(eq(this.schema.sandboxSessions.agentId, agentId));
  }

  async getSandboxSessionStatusCountsByAgent(): Promise<Map<string, ApiSandboxSessionStatusCounts>> {
    const rows = await this.db
      .select({
        agentId: this.schema.sandboxSessions.agentId,
        status: this.schema.sandboxSessions.status,
        count: sql<number>`count(*)::int`,
      })
      .from(this.schema.sandboxSessions)
      .groupBy(this.schema.sandboxSessions.agentId, this.schema.sandboxSessions.status);

    const emptyCounts = (): ApiSandboxSessionStatusCounts => ({
      ACTIVE: 0,
      CHECKPOINTED: 0,
      RESTORING: 0,
      TERMINATED: 0,
    });

    const result = new Map<string, ApiSandboxSessionStatusCounts>();
    for (const row of rows) {
      if (!result.has(row.agentId)) {
        result.set(row.agentId, emptyCounts());
      }
      const counts = result.get(row.agentId)!;
      const key = row.status as SandboxSessionStatus;
      if (key in counts) {
        counts[key] += row.count;
      }
    }
    return result;
  }

  /**
   * Canonical per-turn cost-coverage classification, shared by analytics and
   * conversation summaries and mirrored by materializeTurnUsage for the turns
   * API: a reconciled envelope wins, gateway-attributed and still-open turns
   * are pending, and a terminal direct turn without cost stays unpriced.
   */
  private turnCostCoverageSql() {
    return sql<string>`
      CASE
        WHEN ${this.schema.turns.usage} #>> '{cost,coverage}'
          IN ('complete', 'partial', 'pending', 'unpriced')
          THEN ${this.schema.turns.usage} #>> '{cost,coverage}'
        WHEN ${this.schema.turns.costUsd} IS NOT NULL THEN 'complete'
        WHEN ${this.schema.turns.gatewayMode} IN ('gateway_only', 'mixed')
          THEN 'pending'
        WHEN ${this.schema.turns.completedAt} IS NULL
          AND ${this.schema.turns.error} IS NULL
          AND ${this.schema.turns.status} NOT IN ('completed', 'failed')
          THEN 'pending'
        ELSE 'unpriced'
      END
    `;
  }

  /**
   * Known cost for one turn: a reconciled usage envelope wins, then the
   * legacy scalar column, and NULL when the turn carries no cost data at all
   * (so aggregates can distinguish "no data" from a real $0). Budget
   * enforcement must price turns exactly the way analytics and conversation
   * summaries do — the gateway reconciler writes cost into the envelope
   * without backfilling the scalar (ctx-vjdb).
   */
  private turnKnownCostSql() {
    return sql<number | null>`
      CASE
        WHEN ${this.schema.turns.usage} IS NOT NULL
          THEN COALESCE((${this.schema.turns.usage} #>> '{cost,knownUsd}')::float8, 0)
        WHEN ${this.schema.turns.costUsd} IS NOT NULL THEN ${this.schema.turns.costUsd}
        ELSE NULL
      END
    `;
  }

  private async queryConversationSummaries(options: {
    agentId?: string;
    sandboxStatuses?: SandboxSessionStatus[];
    limit?: number;
    beforeUpdatedAtMs?: number;
  }): Promise<ConversationSummaryRow[]> {
    const turnStats = this.db
      .select({
        conversationId: this.schema.turns.conversationId,
        // ::float8 so postgres.js decodes the bigint aggregate as a number (exact below 2^53).
        startedAt: sql<number | null>`min(${this.schema.turns.startedAt})::float8`.as('started_at'),
        turnCount: sql<number>`count(*)::int`.as('turn_count'),
        totalTokens: sql<number | null>`sum(${this.schema.turns.totalTokens})::float8`.as('total_tokens'),
        knownCostUsd: sql<number | null>`sum(${this.turnKnownCostSql()})::float8`.as('known_cost_usd'),
        incompleteCostTurnCount: sql<number>`
          count(*) FILTER (WHERE ${this.turnCostCoverageSql()} <> 'complete')::int
        `.as('incomplete_cost_turn_count'),
      })
      .from(this.schema.turns)
      .where(isNotNull(this.schema.turns.conversationId))
      .groupBy(this.schema.turns.conversationId)
      .as('turn_stats');

    const latestTurnCandidates = this.db
      .select({
        conversationId: this.schema.turns.conversationId,
        latestTurnId: this.schema.turns.id,
        mode: this.schema.turns.mode,
        taskDescription: this.schema.turns.taskDescription,
        completedAt: this.schema.turns.completedAt,
        error: this.schema.turns.error,
        turnRowNumber: sql<number>`row_number() over (
          partition by ${this.schema.turns.conversationId}
          order by ${this.schema.turns.startedAt} desc, ${this.schema.turns.id} desc
        )`.as('turn_rn'),
      })
      .from(this.schema.turns)
      .where(isNotNull(this.schema.turns.conversationId))
      .as('latest_turn_candidates');

    const messageCounts = this.db
      .select({
        conversationId: this.schema.messages.conversationId,
        messageCount: sql<number>`count(*)::int`.as('message_count'),
      })
      .from(this.schema.messages)
      .groupBy(this.schema.messages.conversationId)
      .as('message_counts');

    const latestSandboxCandidates = this.db
      .select({
        conversationId: this.schema.sandboxSessions.conversationId,
        sandboxSessionId: this.schema.sandboxSessions.id,
        sandboxStatus: this.schema.sandboxSessions.status,
        sbxRowNumber: sql<number>`row_number() over (
          partition by ${this.schema.sandboxSessions.conversationId}
          order by ${this.schema.sandboxSessions.createdAt} desc, ${this.schema.sandboxSessions.id} desc
        )`.as('sbx_rn'),
      })
      .from(this.schema.sandboxSessions)
      .as('latest_sandbox_candidates');

    const filters = [isNotNull(this.schema.conversations.id)];
    if (options.agentId) {
      filters.push(eq(this.schema.conversations.agentId, options.agentId));
    }
    if (options.sandboxStatuses?.length) {
      filters.push(inArray(latestSandboxCandidates.sandboxStatus, options.sandboxStatuses));
    }
    if (options.beforeUpdatedAtMs !== undefined) {
      filters.push(lt(this.schema.conversations.updatedAt, options.beforeUpdatedAtMs));
    }

    const rows: Array<{
      id: string;
      agentId: string;
      updatedAt: number;
      conversationCreatedAt: number;
      startedAt: number | null;
      turnCount: number | null;
      messageCount: number | null;
      latestTurnId: string | null;
      mode: string | null;
      taskDescription: string | null;
      completedAt: number | null;
      error: string | null;
      sandboxSessionId: string | null;
      sandboxStatus: string | null;
      totalTokens: number | null;
      knownCostUsd: number | null;
      incompleteCostTurnCount: number | null;
      tags: Record<string, string> | null;
    }> = await this.db
      .select({
        id: this.schema.conversations.id,
        agentId: this.schema.conversations.agentId,
        tags: this.schema.conversations.tags,
        updatedAt: this.schema.conversations.updatedAt,
        conversationCreatedAt: this.schema.conversations.createdAt,
        startedAt: turnStats.startedAt,
        turnCount: turnStats.turnCount,
        totalTokens: turnStats.totalTokens,
        knownCostUsd: turnStats.knownCostUsd,
        incompleteCostTurnCount: turnStats.incompleteCostTurnCount,
        messageCount: messageCounts.messageCount,
        latestTurnId: latestTurnCandidates.latestTurnId,
        mode: latestTurnCandidates.mode,
        taskDescription: latestTurnCandidates.taskDescription,
        completedAt: latestTurnCandidates.completedAt,
        error: latestTurnCandidates.error,
        sandboxSessionId: latestSandboxCandidates.sandboxSessionId,
        sandboxStatus: latestSandboxCandidates.sandboxStatus,
      })
      .from(this.schema.conversations)
      .leftJoin(
        turnStats,
        eq(this.schema.conversations.id, turnStats.conversationId),
      )
      .leftJoin(
        latestTurnCandidates,
        and(
          eq(this.schema.conversations.id, latestTurnCandidates.conversationId),
          eq(latestTurnCandidates.turnRowNumber, 1),
        ),
      )
      .leftJoin(
        messageCounts,
        eq(this.schema.conversations.id, messageCounts.conversationId),
      )
      .leftJoin(
        latestSandboxCandidates,
        and(
          eq(this.schema.conversations.id, latestSandboxCandidates.conversationId),
          eq(latestSandboxCandidates.sbxRowNumber, 1),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(this.schema.conversations.updatedAt))
      // Unlimited callers get a generous guard rather than an unbounded scan.
      .limit(options.limit ?? 10_000);

    return rows.map((row): ConversationSummaryRow => {
      const status = projectConversationStatus(
        { completedAt: row.completedAt, error: row.error },
        row.sandboxStatus,
      );

      return {
        id: row.id,
        agentId: row.agentId,
        status,
        mode: row.mode ?? 'interactive',
        turnCount: row.turnCount ?? 0,
        messageCount: row.messageCount ?? 0,
        taskDescription: row.taskDescription ?? null,
        startedAt: row.startedAt ?? row.conversationCreatedAt,
        completedAt: row.completedAt ?? null,
        updatedAt: row.updatedAt,
        latestTurnId: row.latestTurnId ?? null,
        sandboxSessionId: row.sandboxSessionId ?? null,
        totalTokens: row.totalTokens ?? null,
        knownCostUsd: row.knownCostUsd ?? null,
        incompleteCostTurnCount: row.incompleteCostTurnCount ?? 0,
        tags: row.tags ?? {},
      };
    });
  }

  // ── Checkpoints v2 (sandbox-session based) ────────────────

  /**
   * Persist a checkpoint only while the exact executing lifecycle worker still
   * owns the session. The checkpoint generation and its lifecycle provenance
   * are committed together under the database clock, so a stale worker cannot
   * publish a checkpoint after another replica has taken over.
   */
  async createCheckpointV2(
    checkpoint: {
      sandboxSessionId: string;
      agentId: string;
      checkpointVersion?: number;
      checkpointData: Record<string, unknown>;
      harnessState?: Record<string, unknown>;
      workspaceRef?: string;
      suspendReason?: string;
    },
    lifecycleOperation: SandboxSessionLifecycleFence,
  ): Promise<{ id: string } | undefined> {
    const sanitizedCheckpoint = sanitizeTypedDbValue({
      sandboxSessionId: checkpoint.sandboxSessionId,
      agentId: checkpoint.agentId,
      checkpointVersion: checkpoint.checkpointVersion,
      workspaceRef: checkpoint.workspaceRef,
      suspendReason: checkpoint.suspendReason,
    }, 'agentCheckpoints.lifecycleInsert');
    const ownerId = sanitizeDbText(
      lifecycleOperation.ownerId,
      'agentCheckpoints.lifecycleInsert.ownerId',
    );
    const fenceToken = validateTurnDeliveryFenceToken(
      lifecycleOperation.fenceToken,
      'agentCheckpoints.lifecycleInsert.fenceToken',
    );
    const checkpointData = sanitizeDbJsonValue(
      checkpoint.checkpointData,
      'agentCheckpoints.lifecycleInsert.checkpointData',
    ) as Record<string, unknown>;
    const harnessState = checkpoint.harnessState
      ? sanitizeDbJsonValue(
          checkpoint.harnessState,
          'agentCheckpoints.lifecycleInsert.harnessState',
        ) as Record<string, unknown>
      : null;

    return this.db.transaction(async (tx) => {
      // Use the same session -> lifecycle lock order as claim and completion.
      // Materialize the clock only after both ownership rows are locked.
      const [session] = await tx
        .select({ sandboxSessionId: this.schema.sandboxSessions.id })
        .from(this.schema.sandboxSessions)
        .where(and(
          eq(
            this.schema.sandboxSessions.id,
            sanitizedCheckpoint.sandboxSessionId,
          ),
          eq(
            this.schema.sandboxSessions.agentId,
            sanitizedCheckpoint.agentId,
          ),
          eq(this.schema.sandboxSessions.status, 'ACTIVE'),
        ))
        .for('update');
      if (!session) {
        return undefined;
      }

      const [operation] = await tx
        .select({
          sandboxSessionId:
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          operationId:
            this.schema.sandboxSessionLifecycleOperations.operationId,
          leaseExpiresAt:
            this.schema.sandboxSessionLifecycleOperations.leaseExpiresAt,
        })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(and(
          eq(
            this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
            sanitizedCheckpoint.sandboxSessionId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.operation,
            'checkpoint',
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.phase,
            'executing',
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.ownerId,
            ownerId,
          ),
          eq(
            this.schema.sandboxSessionLifecycleOperations.fenceToken,
            fenceToken,
          ),
        ))
        .for('update');
      if (!operation) {
        return undefined;
      }

      const [clock] = await tx
        .select({ nowMs: databaseClockMs() })
        .from(this.schema.sandboxSessionLifecycleOperations)
        .where(eq(
          this.schema.sandboxSessionLifecycleOperations.sandboxSessionId,
          sanitizedCheckpoint.sandboxSessionId,
        ))
        .limit(1);
      if (!clock) {
        throw new Error('Database clock query returned no row');
      }
      const nowMs = parseDatabaseClockMs(clock.nowMs);
      if (operation.leaseExpiresAt <= nowMs) {
        return undefined;
      }

      const [row] = await tx
        .insert(this.schema.agentCheckpoints)
        .values({
          sandboxSessionId: sanitizedCheckpoint.sandboxSessionId,
          agentId: sanitizedCheckpoint.agentId,
          checkpointVersion: sanitizedCheckpoint.checkpointVersion ?? 2,
          checkpointData,
          harnessState,
          workspaceRef: sanitizedCheckpoint.workspaceRef ?? null,
          suspendReason: sanitizedCheckpoint.suspendReason ?? null,
          lifecycleOperationId: operation.operationId,
          lifecycleOwnerId: ownerId,
          lifecycleFenceToken: fenceToken,
          createdAt: nowMs,
        })
        .returning({ id: this.schema.agentCheckpoints.id });
      if (!row) {
        throw new Error('Expected insert to return a row but got undefined');
      }
      return row;
    });
  }

  async getCheckpointV2(sandboxSessionId: string): Promise<CheckpointV2 | null> {
    const rows = await this.db
      .select()
      .from(this.schema.agentCheckpoints)
      .where(eq(this.schema.agentCheckpoints.sandboxSessionId, sandboxSessionId))
      .orderBy(desc(this.schema.agentCheckpoints.createdAt))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return row;
  }

  async getCheckpointV2ForLifecycleOperation(
    sandboxSessionId: string,
    lifecycleOperationId: string,
  ): Promise<CheckpointV2 | null> {
    const rows = await this.db
      .select()
      .from(this.schema.agentCheckpoints)
      .where(and(
        eq(
          this.schema.agentCheckpoints.sandboxSessionId,
          sanitizeDbText(
            sandboxSessionId,
            'agentCheckpoints.lifecycleOperation.sandboxSessionId',
          ),
        ),
        eq(
          this.schema.agentCheckpoints.lifecycleOperationId,
          sanitizeDbText(
            lifecycleOperationId,
            'agentCheckpoints.lifecycleOperation.operationId',
          ),
        ),
      ))
      .orderBy(desc(this.schema.agentCheckpoints.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async deleteCheckpointsForSandboxSession(sandboxSessionId: string): Promise<number> {
    const deleted = await this.db
      .delete(this.schema.agentCheckpoints)
      .where(eq(this.schema.agentCheckpoints.sandboxSessionId, sandboxSessionId))
      .returning({ id: this.schema.agentCheckpoints.id });
    return deleted.length;
  }

  async setSystemSetting(key: string, value: string): Promise<void> {
    const sanitizedKey = sanitizeDbText(key, 'systemSettings.key');
    const sanitizedValue = sanitizeDbText(value, 'systemSettings.value');
    await this.db
      .insert(this.schema.systemSettings)
      .values({ key: sanitizedKey, value: sanitizedValue })
      .onConflictDoUpdate({
        target: this.schema.systemSettings.key,
        set: { value: sanitizedValue, updatedAt: new Date().toISOString() },
      });
  }

  async getAllSystemSettings(): Promise<Record<string, string>> {
    const rows = await this.db.select().from(this.schema.systemSettings);
    return Object.fromEntries(rows.map((r: SystemSettingRow) => [r.key, r.value]));
  }

  async tryAdmitToolRequest(
    input: ExpectedSandboxCallbackDelivery & {
      requestId: string;
      toolName: string;
    },
  ): Promise<'inserted' | 'duplicate' | 'stale'> {
    const requestId = sanitizeDbText(
      input.requestId,
      'toolRequestDedup.admit.requestId',
    );
    const turnId = sanitizeDbText(
      input.turnId,
      'toolRequestDedup.admit.turnId',
    );
    const toolName = sanitizeDbText(
      input.toolName,
      'toolRequestDedup.admit.toolName',
    );
    return this.db.transaction(async (tx) => {
      const delivery = await this.lockExactSandboxCallbackDelivery(
        tx,
        input,
        'toolRequestDedup.admit',
      );
      if (!delivery) {
        return 'stale';
      }

      const inserted = await tx
        .insert(this.schema.toolRequestDedup)
        .values({
          requestId,
          turnId,
          toolName,
          status: 'in_progress',
        })
        .onConflictDoNothing({
          target: this.schema.toolRequestDedup.requestId,
        })
        .returning({ requestId: this.schema.toolRequestDedup.requestId });
      return inserted.length > 0 ? 'inserted' : 'duplicate';
    });
  }

  async getToolDedup(requestId: string): Promise<{
    requestId: string;
    turnId: string;
    toolName: string;
    status: string;
    result: string | null;
    error: string | null;
  } | undefined> {
    return this.db.query.toolRequestDedup.findFirst({
      where: eq(this.schema.toolRequestDedup.requestId, requestId),
    });
  }

  async completeToolDedup(
    requestId: string,
    result: string | null,
    error: string | null,
    input: ExpectedSandboxCallbackDelivery,
  ): Promise<boolean> {
    const status = error ? 'failed' : 'completed';
    const sanitizedRequestId = sanitizeDbText(
      requestId,
      'toolRequestDedup.complete.requestId',
    );
    const turnId = sanitizeDbText(
      input.turnId,
      'toolRequestDedup.complete.turnId',
    );
    return this.db.transaction(async (tx) => {
      const delivery = await this.lockExactSandboxCallbackDelivery(
        tx,
        {
          ...input,
          turnId,
        },
        'toolRequestDedup.complete',
      );
      if (!delivery) {
        return false;
      }
      const [completed] = await tx
        .update(this.schema.toolRequestDedup)
        .set(sanitizeTypedDbValue({
          status,
          result,
          error,
          completedAt: Date.now(),
        }, 'toolRequestDedup.complete'))
        .where(and(
          eq(this.schema.toolRequestDedup.requestId, sanitizedRequestId),
          eq(this.schema.toolRequestDedup.turnId, turnId),
          eq(this.schema.toolRequestDedup.status, 'in_progress'),
        ))
        .returning({ requestId: this.schema.toolRequestDedup.requestId });
      return completed !== undefined;
    });
  }

  /**
   * Dedup retention (ctx-jnnn): terminal rows age out fast, but in_progress
   * rows must outlive the longest legitimate tool execution — sweeping a
   * live row lets a replay of the same request_id re-execute the tool. The
   * in-progress ceiling sits above the 30-minute turn timeout so only rows
   * from genuinely dead deliveries are reaped.
   */
  async cleanupToolDedup(
    maxAgeMs: number = 10 * 60 * 1000,
    inProgressMaxAgeMs: number = 45 * 60 * 1000,
  ): Promise<number> {
    const now = Date.now();
    const deleted = await this.db.delete(this.schema.toolRequestDedup)
      .where(or(
        and(
          inArray(this.schema.toolRequestDedup.status, ['completed', 'failed']),
          lt(this.schema.toolRequestDedup.createdAt, now - maxAgeMs),
        ),
        lt(this.schema.toolRequestDedup.createdAt, now - inProgressMaxAgeMs),
      ))
      .returning();
    return deleted.length;
  }

  // ── Artifacts ──────────────────────────────────────────────

  async saveArtifact(data: ArtifactInsert): Promise<ArtifactRow> {
    const sanitizedData = sanitizeTypedDbValue(data, 'artifacts.insert');
    return this.insertOne(
      this.db.insert(this.schema.artifacts).values(sanitizedData).returning(),
      'artifact',
    );
  }

  async saveArtifactIfDeliveryOwned(
    data: ArtifactInsert,
    input: ExpectedSandboxCallbackDelivery,
  ): Promise<ArtifactRow | undefined> {
    const sanitizedData = sanitizeTypedDbValue(data, 'artifacts.fencedInsert');
    const turnId = sanitizeDbText(
      input.turnId,
      'artifacts.fencedInsert.turnId',
    );
    const agentId = sanitizeDbText(
      input.agentId,
      'artifacts.fencedInsert.agentId',
    );
    return this.db.transaction(async (tx) => {
      const delivery = await this.lockExactSandboxCallbackDelivery(
        tx,
        {
          ...input,
          turnId,
          agentId,
        },
        'artifacts.fencedInsert',
      );
      if (!delivery) {
        return undefined;
      }
      if (
        sanitizedData.turnId != null
        && sanitizedData.turnId !== turnId
      ) {
        throw new Error(
          `Artifact turn ${sanitizedData.turnId} does not match callback turn ${turnId}`,
        );
      }
      if (
        sanitizedData.agentId != null
        && sanitizedData.agentId !== agentId
      ) {
        throw new Error(
          `Artifact agent ${sanitizedData.agentId} does not match callback agent ${agentId}`,
        );
      }
      if (
        sanitizedData.conversationId != null
        && sanitizedData.conversationId !== delivery.conversationId
      ) {
        throw new Error(
          `Artifact conversation ${sanitizedData.conversationId} does not match callback conversation ${delivery.conversationId}`,
        );
      }

      const [artifact] = await tx
        .insert(this.schema.artifacts)
        .values({
          ...sanitizedData,
          turnId,
          agentId,
          conversationId: delivery.conversationId,
        })
        .returning();
      if (!artifact) {
        throw new Error('Expected fenced artifact insert to return a row');
      }
      return artifact;
    });
  }

  async getArtifact(id: string): Promise<ArtifactRow | undefined> {
    const [row] = await this.db
      .select()
      .from(this.schema.artifacts)
      .where(eq(this.schema.artifacts.id, id));
    return row;
  }


  async markArtifactUploadConfirmed(
    id: string,
    data: { sizeBytes: number; mimeType?: string },
  ): Promise<ArtifactRow | undefined> {
    const [row] = await this.db
      .update(this.schema.artifacts)
      .set({
        status: 'active',
        sizeBytes: data.sizeBytes,
        ...(data.mimeType ? { mimeType: sanitizeDbText(data.mimeType, 'artifacts.mimeType') } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(this.schema.artifacts.id, id))
      .returning();
    return row;
  }

  async markArtifactUploadFailed(id: string): Promise<ArtifactRow | undefined> {
    return this.setArtifactStatus(id, 'upload_failed');
  }

  async markArtifactDeleting(id: string): Promise<ArtifactRow | undefined> {
    return this.setArtifactStatus(id, 'deleting');
  }

  async markArtifactDeleteFailed(id: string): Promise<ArtifactRow | undefined> {
    return this.setArtifactStatus(id, 'delete_failed');
  }

  private async setArtifactStatus(
    id: string,
    status: NonNullable<ArtifactInsert['status']>,
  ): Promise<ArtifactRow | undefined> {
    const [row] = await this.db
      .update(this.schema.artifacts)
      .set({ status, updatedAt: Date.now() })
      .where(eq(this.schema.artifacts.id, id))
      .returning();
    return row;
  }

  async listAllArtifacts(
    limit = 100,
    offset = 0,
    search?: string,
  ): Promise<{ artifacts: ArtifactRow[]; total: number }> {
    const conditions = [eq(this.schema.artifacts.status, 'active')];
    if (search) {
      conditions.push(ilike(this.schema.artifacts.name, `%${search}%`));
    }

    const where = and(...conditions);

    const [artifacts, countResult] = await Promise.all([
      this.db.query.artifacts.findMany({
        where,
        orderBy: [desc(this.schema.artifacts.createdAt)],
        limit,
        offset,
      }),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(this.schema.artifacts)
        .where(where),
    ]);

    return { artifacts, total: countResult[0]?.count ?? 0 };
  }

  async listArtifactsForAgent(agentId: string, limit = 100, offset = 0): Promise<ArtifactRow[]> {
    return this.db.query.artifacts.findMany({
      where: and(
        eq(this.schema.artifacts.agentId, agentId),
        eq(this.schema.artifacts.status, 'active'),
      ),
      orderBy: [desc(this.schema.artifacts.createdAt)],
      limit,
      offset,
    });
  }

  async listArtifactsForTurn(turnId: string): Promise<ArtifactRow[]> {
    return this.db.query.artifacts.findMany({
      where: and(
        eq(this.schema.artifacts.turnId, turnId),
        eq(this.schema.artifacts.status, 'active'),
      ),
      orderBy: [desc(this.schema.artifacts.createdAt)],
    });
  }

  async deleteArtifact(id: string): Promise<ArtifactRow | undefined> {
    const [row] = await this.db
      .update(this.schema.artifacts)
      .set({ status: 'deleted', updatedAt: Date.now() })
      .where(eq(this.schema.artifacts.id, id))
      .returning();
    return row;
  }
}
