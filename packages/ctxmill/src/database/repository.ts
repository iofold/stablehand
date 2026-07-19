import { eq, sql, gt, lt, lte, and, or, desc, asc, inArray, isNotNull, isNull, ilike, type SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DrizzleDb } from './connection.js';
import * as pgSchema from './schema-pg.js';
import { sanitizeDbJsonValue, sanitizeDbText, sanitizeDbValue } from '../util/sanitize.js';
import { isUniqueConstraintViolation } from './errors.js';
import {
  projectConversationStatus,
  type ApiSandboxSessionStatusCounts,
  type SandboxSessionStatus,
} from '@ctxmill/shared';

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
  InterruptResumeAttemptInsert,
  InterruptResumeAttemptRow,
  InterruptRow,
  MessageInsert,
  MessageSelect,
  SandboxSessionRow,
  SystemSettingRow,
  SpineCursorRow,
  TriggerFiringRow,
  TriggerInsert,
  TriggerSelect,
  TurnInsert,
  TurnReconciliationLeaseRow,
  TurnSelect,
  TurnStartRequestInsert,
  TurnStartRequestRow,
  TurnStatus,
  VersionSelect,
  WebhookInsert,
  WebhookRow,
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
  SandboxSessionRow,
  SpineCursorRow,
  SystemSettingRow,
  TurnStartRequestRow,
  TurnReconciliationLeaseRow,
  TriggerFiringRow,
  WebhookRow,
} from './types.js';

const sanitizeTypedDbValue = <T>(value: T, context: string): T => sanitizeDbValue(value, context) as T;
const DEFAULT_CLAIM_LEASE_MS = 60_000;
const CALLBACK_EVENT_SEQ_DEDUPE_INDEX = 'idx_outbox_callback_event_seq';
type InterruptResumeAttemptUpdate = Omit<Partial<InterruptResumeAttemptInsert>, 'attempts'> & {
  attempts?: number | SQL<unknown>;
};
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

const sanitizeOptionalDbText = <T extends string | null | undefined>(value: T, context: string): T => {
  if (value == null) return value;
  return sanitizeDbText(value, context) as T;
};

function eventBatchAgentId(frames: EventFrameInsert[]): string {
  const agentIds = new Set(frames.map((frame) => frame.agentId));
  if (agentIds.size !== 1) {
    throw new Error('Canonical event batches must contain exactly one agent');
  }
  return sanitizeDbText(frames[0]!.agentId, 'eventStore.agentId');
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
   * Order: messages -> conversations -> runs -> events -> agent
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
  async addCanonicalMessage(
    data: Omit<MessageInsert, 'messageSeq' | 'messageRevision' | 'publishedRevision'> & {
      turnId: string;
      role: 'assistant' | 'tool';
    },
  ): Promise<MessageSelect> {
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

  async createTurn(data: TurnInsert): Promise<TurnSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'turns.insert');
    return this.insertOne(
      this.db.insert(this.schema.turns).values(sanitizedData).returning(),
      'turn',
    );
  }

  async updateTurn(
    id: string,
    updates: Partial<Omit<TurnInsert, 'id'>>,
  ): Promise<TurnSelect | undefined> {
    const sanitizedUpdates = sanitizeTypedDbValue(updates, 'turns.update');
    const [updated] = await this.db
      .update(this.schema.turns)
      .set(sanitizedUpdates)
      .where(eq(this.schema.turns.id, id))
      .returning();
    return updated;
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
   * Atomically claim startup reconciliation ownership for one open turn.
   *
   * Pending/timed-out approvals and durable resume attempts retain ownership of
   * HITL turns. A competing reconciler may take over only after lease expiry.
   */
  async claimTurnReconciliationLease(input: {
    turnId: string;
    ownerId: string;
    claimedAt: number;
    leaseExpiresAt: number;
  }): Promise<TurnReconciliationLeaseRow | undefined> {
    const turnId = sanitizeDbText(input.turnId, 'turnReconciliationLeases.turnId');
    const ownerId = sanitizeDbText(input.ownerId, 'turnReconciliationLeases.ownerId');
    if (input.leaseExpiresAt <= input.claimedAt) {
      throw new Error('Turn reconciliation lease expiry must be after its claim time');
    }

    const eligibleTurn = this.db
      .select({
        turnId: this.schema.turns.id,
        ownerId: sql<string>`${ownerId}`.as('owner_id'),
        leaseExpiresAt: sql<number>`${input.leaseExpiresAt}::bigint`.as('lease_expires_at'),
        updatedAt: sql<number>`${input.claimedAt}::bigint`.as('updated_at'),
      })
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
      ));
    const [claimed] = await this.db
      .insert(this.schema.turnReconciliationLeases)
      .select(eligibleTurn)
      .onConflictDoUpdate({
        target: this.schema.turnReconciliationLeases.turnId,
        set: {
          ownerId,
          leaseExpiresAt: input.leaseExpiresAt,
          updatedAt: input.claimedAt,
        },
        setWhere: or(
          lte(this.schema.turnReconciliationLeases.leaseExpiresAt, input.claimedAt),
          eq(this.schema.turnReconciliationLeases.ownerId, ownerId),
        ),
      })
      .returning();
    return claimed;
  }

  async renewTurnReconciliationLease(
    turnId: string,
    ownerId: string,
    renewedAt: number,
    leaseExpiresAt: number,
  ): Promise<TurnReconciliationLeaseRow | undefined> {
    if (leaseExpiresAt <= renewedAt) {
      throw new Error('Renewed turn reconciliation lease expiry must be after its renewal time');
    }
    const [renewed] = await this.db
      .update(this.schema.turnReconciliationLeases)
      .set({ leaseExpiresAt, updatedAt: renewedAt })
      .where(and(
        eq(
          this.schema.turnReconciliationLeases.turnId,
          sanitizeDbText(turnId, 'turnReconciliationLeases.renew.turnId'),
        ),
        eq(
          this.schema.turnReconciliationLeases.ownerId,
          sanitizeDbText(ownerId, 'turnReconciliationLeases.renew.ownerId'),
        ),
        gt(this.schema.turnReconciliationLeases.leaseExpiresAt, renewedAt),
      ))
      .returning();
    return renewed;
  }

  /**
   * Authorize recovery dispatch while preserving queued crash-retry state.
   *
   * Only the owner of a still-live reconciliation lease may pass this fence,
   * and a HITL resume workflow that appeared after the original claim wins.
   * The normal delivery boundary changes the turn to running; if this owner
   * dies before then, the queued turn remains eligible for lease takeover.
   */
  async authorizeQueuedTurnRedispatch(
    turnId: string,
    ownerId: string,
    checkedAt: number,
  ): Promise<boolean> {
    const sanitizedTurnId = sanitizeDbText(
      turnId,
      'turnReconciliationLeases.authorize.turnId',
    );
    const sanitizedOwnerId = sanitizeDbText(
      ownerId,
      'turnReconciliationLeases.authorize.ownerId',
    );
    const [authorized] = await this.db
      .select({ turnId: this.schema.turns.id })
      .from(this.schema.turns)
      .where(and(
        eq(this.schema.turns.id, sanitizedTurnId),
        eq(this.schema.turns.status, 'queued'),
        isNull(this.schema.turns.completedAt),
        sql<boolean>`EXISTS (
          SELECT 1
          FROM ${this.schema.turnReconciliationLeases}
          WHERE ${this.schema.turnReconciliationLeases.turnId} = ${this.schema.turns.id}
            AND ${this.schema.turnReconciliationLeases.ownerId} = ${sanitizedOwnerId}
            AND ${this.schema.turnReconciliationLeases.leaseExpiresAt} > ${checkedAt}
        )`,
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
      .limit(1);
    return authorized !== undefined;
  }

  async releaseTurnReconciliationLease(
    turnId: string,
    ownerId: string,
  ): Promise<boolean> {
    const released = await this.db
      .delete(this.schema.turnReconciliationLeases)
      .where(and(
        eq(
          this.schema.turnReconciliationLeases.turnId,
          sanitizeDbText(turnId, 'turnReconciliationLeases.release.turnId'),
        ),
        eq(
          this.schema.turnReconciliationLeases.ownerId,
          sanitizeDbText(ownerId, 'turnReconciliationLeases.release.ownerId'),
        ),
      ))
      .returning({ turnId: this.schema.turnReconciliationLeases.turnId });
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
    },
  ): Promise<boolean> {
    const sanitizedUpdates = sanitizeTypedDbValue(updates, 'turns.finalize');
    const updated = await this.db
      .update(this.schema.turns)
      .set(sanitizedUpdates)
      .where(and(eq(this.schema.turns.id, id), isNull(this.schema.turns.completedAt)))
      .returning({ id: this.schema.turns.id });
    return updated.length > 0;
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
   * Atomically persist a canonical message frame and its publication
   * watermark. A frame insert failure leaves the row pending for startup
   * recovery; the watermark can never get ahead of event_store.
   */
  async saveMessageEventBatch(
    frames: EventFrameInsert[],
    publication: { messageId: string; targetRevision: number },
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
   * Query events with optional filtering by type, agentId, time range,
   * and cursor-based pagination.
   */
  async getEvents(options: {
    cursor?: number;
    limit?: number;
    type?: string;
    agentId?: string;
    since?: number;
  } = {}): Promise<Array<{ seq: number; type: string; agentId: string; payload: string; createdAt: number }>> {
    const { cursor, limit: lim = 50, type: eventType, agentId, since } = options;

    const conditions = [];
    if (cursor) conditions.push(lt(this.schema.eventStore.seq, cursor));
    if (eventType) conditions.push(eq(this.schema.eventStore.type, eventType));
    if (agentId) conditions.push(eq(this.schema.eventStore.agentId, agentId));
    if (since) conditions.push(gt(this.schema.eventStore.createdAt, since));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select({
        seq: this.schema.eventStore.seq,
        type: this.schema.eventStore.type,
        agentId: this.schema.eventStore.agentId,
        payload: this.schema.eventStore.payload,
        createdAt: this.schema.eventStore.createdAt,
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

  async getAgentVersions(agentId: string): Promise<VersionSelect[]> {
    return this.db.query.agentVersions.findMany({
      where: eq(this.schema.agentVersions.agentId, agentId),
      orderBy: (v, { desc }) => [desc(v.version)],
    });
  }

  // ── Pending Interrupts (Durable HITL) ──────────────────

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

  async getPendingInterrupt(id: string): Promise<InterruptRow | undefined> {
    return this.db.query.pendingInterrupts.findFirst({
      where: eq(this.schema.pendingInterrupts.id, id),
    });
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

  async getResolvedInterruptsForSandboxSession(sandboxSessionId: string): Promise<InterruptRow[]> {
    return this.db.query.pendingInterrupts.findMany({
      where: and(
        eq(this.schema.pendingInterrupts.sandboxSessionId, sandboxSessionId),
        eq(this.schema.pendingInterrupts.status, 'resolved'),
      ),
    });
  }

  async getInterruptResumeAttemptForInterrupt(interruptId: string): Promise<InterruptResumeAttemptRow | undefined> {
    return this.db.query.interruptResumeAttempts.findFirst({
      where: eq(this.schema.interruptResumeAttempts.interruptId, interruptId),
    });
  }

  async getRecoverableInterruptResumeAttempts(
    staleBefore: number,
    limit = 50,
  ): Promise<InterruptResumeAttemptRow[]> {
    return this.db.query.interruptResumeAttempts.findMany({
      where: or(
        eq(this.schema.interruptResumeAttempts.status, 'pending'),
        and(
          eq(this.schema.interruptResumeAttempts.status, 'in_progress'),
          lte(this.schema.interruptResumeAttempts.updatedAt, staleBefore),
        ),
      ),
      orderBy: (attempts) => [asc(attempts.updatedAt), asc(attempts.id)],
      limit: Math.max(1, Math.min(Math.trunc(limit), 500)),
    });
  }

  async claimInterruptResumeAttempt(input: {
    id: string;
    expectedUpdatedAt: number;
    staleBefore: number;
    claimedAt: number;
  }): Promise<InterruptResumeAttemptRow | undefined> {
    const id = sanitizeDbText(input.id, 'interruptResumeAttempts.claim.id');
    const [claimed] = await this.db
      .update(this.schema.interruptResumeAttempts)
      .set({
        status: 'in_progress',
        attempts: sql`${this.schema.interruptResumeAttempts.attempts} + 1`,
        updatedAt: input.claimedAt,
        lastError: null,
        completedAt: null,
      })
      .where(and(
        eq(this.schema.interruptResumeAttempts.id, id),
        eq(this.schema.interruptResumeAttempts.updatedAt, input.expectedUpdatedAt),
        or(
          eq(this.schema.interruptResumeAttempts.status, 'pending'),
          and(
            eq(this.schema.interruptResumeAttempts.status, 'in_progress'),
            lte(this.schema.interruptResumeAttempts.updatedAt, input.staleBefore),
          ),
        ),
      ))
      .returning();
    return claimed;
  }

  async renewInterruptResumeAttemptLease(
    id: string,
    expectedUpdatedAt: number,
    renewedAt: number,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    return this.updateOwnedInterruptResumeAttempt(
      id,
      expectedUpdatedAt,
      { updatedAt: renewedAt },
    );
  }

  async retryFailedInterruptResumeAttempt(
    id: string,
    expectedUpdatedAt: number,
    retriedAt: number,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    const sanitizedId = sanitizeDbText(id, 'interruptResumeAttempts.retry.id');
    const [row] = await this.db
      .update(this.schema.interruptResumeAttempts)
      .set({
        status: 'pending',
        updatedAt: retriedAt,
        completedAt: null,
        lastError: null,
      })
      .where(and(
        eq(this.schema.interruptResumeAttempts.id, sanitizedId),
        eq(this.schema.interruptResumeAttempts.status, 'failed'),
        eq(this.schema.interruptResumeAttempts.updatedAt, expectedUpdatedAt),
      ))
      .returning();
    return row;
  }

  async completeInterruptResumeAttempt(
    id: string,
    expectedUpdatedAt: number,
    completedAt: number,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    return this.updateOwnedInterruptResumeAttempt(
      id,
      expectedUpdatedAt,
      {
        status: 'completed',
        updatedAt: completedAt,
        completedAt,
        lastError: null,
      },
    );
  }

  async failInterruptResumeAttempt(
    id: string,
    expectedUpdatedAt: number,
    failedAt: number,
    error: string,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    return this.updateOwnedInterruptResumeAttempt(
      id,
      expectedUpdatedAt,
      {
        status: 'failed',
        updatedAt: failedAt,
        completedAt: null,
        lastError: sanitizeDbText(error, 'interruptResumeAttempts.lastError'),
      },
    );
  }

  async failPendingInterruptResumeAttempt(
    id: string,
    expectedUpdatedAt: number,
    failedAt: number,
    error: string,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    const sanitizedId = sanitizeDbText(id, 'interruptResumeAttempts.pendingFailure.id');
    const [row] = await this.db
      .update(this.schema.interruptResumeAttempts)
      .set({
        status: 'failed',
        updatedAt: failedAt,
        completedAt: null,
        lastError: sanitizeDbText(error, 'interruptResumeAttempts.lastError'),
      })
      .where(and(
        eq(this.schema.interruptResumeAttempts.id, sanitizedId),
        eq(this.schema.interruptResumeAttempts.status, 'pending'),
        eq(this.schema.interruptResumeAttempts.updatedAt, expectedUpdatedAt),
      ))
      .returning();
    return row;
  }

  private async updateOwnedInterruptResumeAttempt(
    id: string,
    expectedUpdatedAt: number,
    set: InterruptResumeAttemptUpdate,
  ): Promise<InterruptResumeAttemptRow | undefined> {
    const sanitizedId = sanitizeDbText(id, 'interruptResumeAttempts.ownedUpdate.id');
    const [row] = await this.db
      .update(this.schema.interruptResumeAttempts)
      .set(set)
      .where(and(
        eq(this.schema.interruptResumeAttempts.id, sanitizedId),
        eq(this.schema.interruptResumeAttempts.status, 'in_progress'),
        eq(this.schema.interruptResumeAttempts.updatedAt, expectedUpdatedAt),
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
    data: { url: string; events: string[]; secret?: string | null },
  ): Promise<WebhookRow | undefined> {
    const sanitizedData = sanitizeTypedDbValue(data, 'webhooks.update');
    const [row] = await this.db
      .update(this.schema.webhooks)
      .set({
        url: sanitizedData.url,
        events: sanitizedData.events,
        secret: sanitizedData.secret ?? null,
        updatedAt: Date.now(),
      })
      .where(and(eq(this.schema.webhooks.id, id), eq(this.schema.webhooks.agentId, agentId)))
      .returning();
    return row;
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
  ): Promise<{ totalTokens: number; costUsd: number; turns: number }> {
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
        totalTokens: sql<number>`coalesce(sum(${this.schema.turns.totalTokens}), 0)::float8`,
        costUsd: sql<number>`coalesce(sum(${this.schema.turns.costUsd}), 0)::float8`,
        turns: sql<number>`count(*)::int`,
      })
      .from(this.schema.turns)
      .where(and(...conditions));
    return row ?? { totalTokens: 0, costUsd: 0, turns: 0 };
  }

  /** Spend grouped by a tag key; bucket is null for turns missing the key. */
  async getBudgetSpendBuckets(
    selector: Record<string, string>,
    sinceMs: number,
    groupByKey: string,
  ): Promise<Array<{ bucket: string | null; totalTokens: number; costUsd: number; turns: number }>> {
    const conditions: SQL[] = [
      sql`${this.schema.turns.startedAt} >= ${sinceMs}`,
    ];
    if (Object.keys(selector).length > 0) {
      conditions.push(sql`${this.schema.turns.tags} @> ${JSON.stringify(selector)}::jsonb`);
    }

    return this.db
      .select({
        bucket: sql<string | null>`${this.schema.turns.tags} ->> ${groupByKey}`.as('bucket'),
        totalTokens: sql<number>`coalesce(sum(${this.schema.turns.totalTokens}), 0)::float8`,
        costUsd: sql<number>`coalesce(sum(${this.schema.turns.costUsd}), 0)::float8`,
        turns: sql<number>`count(*)::int`,
      })
      .from(this.schema.turns)
      .where(and(...conditions))
      // Group by the output alias: repeating the `tags ->> key` fragment
      // would bind the key as two distinct parameters, which Postgres then
      // rejects as select-expression-not-in-GROUP-BY.
      .groupBy(sql`bucket`);
  }

  // ── Sandbox Sessions ───────────────────────────────────────

  async createSandboxSession(session: {
    id?: string;
    conversationId: string;
    agentId: string;
    containerName?: string;
    containerId?: string;
    status?: string;
    harnessName: string;
  }): Promise<SandboxSessionRow> {
    const sanitizedSession = sanitizeTypedDbValue(session, 'sandboxSessions.insert');
    return this.insertOne(
      this.db
        .insert(this.schema.sandboxSessions)
        .values({
          ...(sanitizedSession.id !== undefined ? { id: sanitizedSession.id } : {}),
          conversationId: sanitizedSession.conversationId,
          agentId: sanitizedSession.agentId,
          containerName: sanitizedSession.containerName ?? null,
          containerId: sanitizedSession.containerId ?? null,
          status: sanitizedSession.status ?? 'ACTIVE',
          harnessName: sanitizedSession.harnessName,
        })
        .returning(),
      'sandbox session',
    );
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
      .orderBy(desc(this.schema.sandboxSessions.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateSandboxSessionStatus(
    id: string,
    status: string,
    extra?: {
      containerName?: string | null;
      containerId?: string | null;
      restoreAttempts?: number | null;
      lastRestoreError?: string | null;
    },
    options?: {
      expectedFrom?: string;
    },
  ): Promise<void> {
    const sanitizedStatus = sanitizeDbText(status, 'sandboxSessions.status');
    const sanitizedExtra = extra ? sanitizeTypedDbValue(extra, 'sandboxSessions.update') : undefined;
    const expectedFrom = options?.expectedFrom
      ? sanitizeDbText(options.expectedFrom, 'sandboxSessions.expectedFrom')
      : undefined;

    const [updated] = await this.db
      .update(this.schema.sandboxSessions)
      .set({
        status: sanitizedStatus,
        updatedAt: Date.now(),
        lastActivityAt: Date.now(),
        ...(sanitizedExtra?.containerName !== undefined ? { containerName: sanitizedExtra.containerName } : {}),
        ...(sanitizedExtra?.containerId !== undefined ? { containerId: sanitizedExtra.containerId } : {}),
        ...(sanitizedExtra?.restoreAttempts !== undefined && sanitizedExtra.restoreAttempts !== null
          ? { restoreAttempts: sanitizedExtra.restoreAttempts }
          : {}),
        ...(sanitizedExtra?.lastRestoreError !== undefined
          ? { lastRestoreError: sanitizedExtra.lastRestoreError }
          : {}),
      })
      .where(expectedFrom
        ? and(eq(this.schema.sandboxSessions.id, id), eq(this.schema.sandboxSessions.status, expectedFrom))
        : eq(this.schema.sandboxSessions.id, id))
      .returning({ id: this.schema.sandboxSessions.id });

    if (!updated) {
      if (expectedFrom) {
        throw new SandboxSessionStatusConflictError(id, expectedFrom, sanitizedStatus);
      }
      throw new Error(`Sandbox session ${id} not found for status update`);
    }
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

  /**
   * Sessions that may be stranded mid-restore. The orchestrator's startup
   * reconciler uses this to detect rows left in RESTORING after a crash.
   * Optionally filtered by an updated_at cutoff so callers can require the
   * row to be older than `updatedBeforeMs` (e.g. exclude in-flight restores
   * from a process that just started).
   */
  async getStrandedRestoringSessions(updatedBeforeMs?: number): Promise<SandboxSessionRow[]> {
    return this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(
        and(
          eq(this.schema.sandboxSessions.status, 'RESTORING'),
          updatedBeforeMs === undefined
            ? undefined
            : lt(this.schema.sandboxSessions.updatedAt, updatedBeforeMs),
        ),
      );
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

  private async queryConversationSummaries(options: {
    agentId?: string;
    sandboxStatuses?: string[];
  }): Promise<ConversationSummaryRow[]> {
    const turnStats = this.db
      .select({
        conversationId: this.schema.turns.conversationId,
        // ::float8 so postgres.js decodes the bigint aggregate as a number (exact below 2^53).
        startedAt: sql<number | null>`min(${this.schema.turns.startedAt})::float8`.as('started_at'),
        turnCount: sql<number>`count(*)::int`.as('turn_count'),
        totalTokens: sql<number | null>`sum(${this.schema.turns.totalTokens})::float8`.as('total_tokens'),
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
    }> = await this.db
      .select({
        id: this.schema.conversations.id,
        agentId: this.schema.conversations.agentId,
        updatedAt: this.schema.conversations.updatedAt,
        conversationCreatedAt: this.schema.conversations.createdAt,
        startedAt: turnStats.startedAt,
        turnCount: turnStats.turnCount,
        totalTokens: turnStats.totalTokens,
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
      .orderBy(desc(this.schema.conversations.updatedAt));

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
      };
    });
  }

  // ── Checkpoints v2 (sandbox-session based) ────────────────

  async createCheckpointV2(checkpoint: {
    sandboxSessionId: string;
    agentId: string;
    checkpointVersion?: number;
    checkpointData: Record<string, unknown>;
    harnessState?: Record<string, unknown>;
    workspaceRef?: string;
    suspendReason?: string;
  }): Promise<{ id: string }> {
    const sanitizedCheckpoint = sanitizeTypedDbValue({
      sandboxSessionId: checkpoint.sandboxSessionId,
      agentId: checkpoint.agentId,
      checkpointVersion: checkpoint.checkpointVersion,
      workspaceRef: checkpoint.workspaceRef,
      suspendReason: checkpoint.suspendReason,
    }, 'agentCheckpoints.insert');
    const checkpointData = sanitizeDbJsonValue(
      checkpoint.checkpointData,
      'agentCheckpoints.checkpointData',
    ) as Record<string, unknown>;
    const harnessState = checkpoint.harnessState
      ? sanitizeDbJsonValue(checkpoint.harnessState, 'agentCheckpoints.harnessState') as Record<string, unknown>
      : null;
    const [row] = await this.db
      .insert(this.schema.agentCheckpoints)
      .values({
        sandboxSessionId: sanitizedCheckpoint.sandboxSessionId,
        agentId: sanitizedCheckpoint.agentId,
        checkpointVersion: sanitizedCheckpoint.checkpointVersion ?? 2,
        checkpointData,
        harnessState,
        workspaceRef: sanitizedCheckpoint.workspaceRef ?? null,
        suspendReason: sanitizedCheckpoint.suspendReason ?? null,
      })
      .returning({ id: this.schema.agentCheckpoints.id });
    if (!row) throw new Error('Expected insert to return a row but got undefined');
    return row;
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

  async tryInsertToolDedup(requestId: string, turnId: string, toolName: string): Promise<boolean> {
    try {
      await this.db.insert(this.schema.toolRequestDedup).values(
        sanitizeTypedDbValue({ requestId, turnId, toolName, status: 'in_progress' }, 'toolRequestDedup.insert'),
      );
      return true;
    } catch (err: unknown) {
      if (isUniqueConstraintViolation(err)) {
        return false;
      }
      throw err;
    }
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

  async completeToolDedup(requestId: string, result: string | null, error: string | null): Promise<void> {
    const status = error ? 'failed' : 'completed';
    await this.db.update(this.schema.toolRequestDedup)
      .set(sanitizeTypedDbValue({
        status,
        result,
        error,
        completedAt: Date.now(),
      }, 'toolRequestDedup.complete'))
      .where(eq(this.schema.toolRequestDedup.requestId, requestId));
  }

  async cleanupToolDedup(maxAgeMs: number = 10 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const deleted = await this.db.delete(this.schema.toolRequestDedup)
      .where(lt(this.schema.toolRequestDedup.createdAt, cutoff))
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
