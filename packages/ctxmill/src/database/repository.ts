import { eq, sql, gt, lt, lte, and, or, desc, asc, inArray, isNotNull, isNull, ilike } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DrizzleDb } from './connection.js';
import * as pgSchema from './schema-pg.js';
import { sanitizeDbJsonValue, sanitizeDbText, sanitizeDbValue } from '../util/sanitize.js';
import { projectSessionStatus, type ApiSessionStatusCounts, type SandboxSessionStatus } from '@ctxmill/shared';

import type {
  AgentInsert,
  AgentSelect,
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
  ScheduledEventRow,
  SuspendedSessionInsert,
  SuspendedSessionRow,
  SystemSettingRow,
  TriggerInsert,
  TriggerSelect,
  TurnInsert,
  TurnSelect,
  TurnStatus,
  VersionSelect,
  WebhookInsert,
  WebhookRow,
} from './types.js';

export type {
  CallbackOutboxRow,
  CheckpointV2,
  ConversationSummaryRow,
  EventFrameInsert,
  EventFrameRow,
  InterruptResumeAttemptRow,
  InterruptRow,
  SandboxSessionRow,
  ScheduledEventRow,
  SuspendedSessionRow,
  SystemSettingRow,
  WebhookRow,
} from './types.js';

const sanitizeTypedDbValue = <T>(value: T, context: string): T => sanitizeDbValue(value, context) as T;
const DEFAULT_CLAIM_LEASE_MS = 60_000;

const sanitizeOptionalDbText = <T extends string | null | undefined>(value: T, context: string): T => {
  if (value == null) return value;
  return sanitizeDbText(value, context) as T;
};

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

  private getTurnStatusWhere(status: string, agentId?: string) {
    const normalized = status === 'failed' ? 'error' : status;
    const concreteStatuses = new Set(['queued', 'running', 'completed', 'error', 'cancelled']);
    const condition = concreteStatuses.has(normalized)
      ? eq(this.schema.turns.status, normalized as TurnStatus)
      : normalized === 'active' || normalized === 'paused' || normalized === 'suspended'
        ? isNull(this.schema.turns.completedAt)
        : sql`1 = 0`;

    if (!agentId) {
      return condition;
    }

    return and(eq(this.schema.turns.agentId, agentId), condition);
  }

  // ── Agents ──────────────────────────────────────────────

  async createAgent(data: AgentInsert): Promise<AgentSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'agents.insert');
    const [agent] = await this.db.insert(this.schema.agents).values(sanitizedData).returning();
    if (!agent) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return agent;
  }

  async getAgent(id: string): Promise<AgentSelect | undefined> {
    return this.db.query.agents.findFirst({
      where: eq(this.schema.agents.id, id),
    });
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
      const sandboxSessions = await tx
        .select({ id: this.schema.sandboxSessions.id })
        .from(this.schema.sandboxSessions)
        .where(eq(this.schema.sandboxSessions.agentId, agentId));
      const sandboxSessionIds = sandboxSessions.map((session) => session.id);
      if (conversationIds.length > 0) {
        await tx.delete(this.schema.messages).where(inArray(this.schema.messages.conversationId, conversationIds));
      }
      await tx.delete(this.schema.suspendedSessions).where(eq(this.schema.suspendedSessions.agentId, agentId));
      await tx.delete(this.schema.scheduledEvents).where(eq(this.schema.scheduledEvents.agentId, agentId));
      await tx.delete(this.schema.pendingInterrupts).where(eq(this.schema.pendingInterrupts.agentId, agentId));
      if (sandboxSessionIds.length > 0) {
        await tx.delete(this.schema.toolRequestDedup).where(inArray(this.schema.toolRequestDedup.sessionId, sandboxSessionIds));
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

  async createConversation(agentId: string, id?: string): Promise<ConversationSelect> {
    const sanitizedAgentId = sanitizeDbText(agentId, 'conversations.agentId');
    const sanitizedId = id ? sanitizeDbText(id, 'conversations.id') : undefined;
    const [conversation] = await this.db
      .insert(this.schema.conversations)
      .values({
        ...(sanitizedId ? { id: sanitizedId } : {}),
        agentId: sanitizedAgentId,
      })
      .returning();
    if (!conversation) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return conversation;
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

  async updateMessageToolCalls(id: string, toolCalls: unknown[]): Promise<void> {
    const sanitizedToolCalls = sanitizeTypedDbValue(toolCalls, 'messages.toolCalls');
    await this.db.update(this.schema.messages)
      .set({ toolCalls: sanitizedToolCalls })
      .where(eq(this.schema.messages.id, id));
  }

  /** Repair both persisted tool-call projections of a message in one write (ctx-nm3o). */
  async updateMessageToolCallsAndParts(
    id: string,
    toolCalls: unknown[] | null,
    parts: unknown[] | null,
  ): Promise<void> {
    await this.db.update(this.schema.messages)
      .set({
        ...(toolCalls ? { toolCalls: sanitizeTypedDbValue(toolCalls, 'messages.toolCalls') } : {}),
        ...(parts ? { parts: sanitizeTypedDbValue(parts, 'messages.parts') } : {}),
      })
      .where(eq(this.schema.messages.id, id));
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
   * Get session summaries for an agent's conversations, including
   * message count and last message timestamp per conversation.
   */
  async getSessionsForAgent(
    agentId: string,
  ): Promise<
    {
      conversationId: string;
      startedAt: number;
      messageCount: number;
      lastMessageAt: number | null;
    }[]
  > {
    const rows = await this.db
      .select({
        conversationId: this.schema.conversations.id,
        startedAt: this.schema.conversations.createdAt,
        messageCount: sql<number>`count(${this.schema.messages.id})`.as('message_count'),
        lastMessageAt: sql<number | null>`max(${this.schema.messages.createdAt})`.as('last_message_at'),
      })
      .from(this.schema.conversations)
      .leftJoin(
        this.schema.messages,
        eq(this.schema.conversations.id, this.schema.messages.conversationId),
      )
      .where(eq(this.schema.conversations.agentId, agentId))
      .groupBy(this.schema.conversations.id);

    return rows;
  }

  async getConversationSummaries(agentId: string): Promise<ConversationSummaryRow[]> {
    return this.queryConversationSummaries({ agentId });
  }

  async getActiveConversationSummaries(): Promise<ConversationSummaryRow[]> {
    return this.queryConversationSummaries({ sandboxStatuses: ['ACTIVE', 'RESTORING'] });
  }

  async createTurn(data: TurnInsert): Promise<TurnSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'turns.insert');
    const [turn] = await this.db.insert(this.schema.turns).values(sanitizedData).returning();
    if (!turn) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return turn;
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

  async getActiveTurns(): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany({
      where: isNull(this.schema.turns.completedAt),
    });
  }

  /** Open turns started before the cutoff — stranded by construction after a restart (ADR-014). */
  async getOpenTurnsStartedBefore(cutoffMs: number): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany({
      where: and(isNull(this.schema.turns.completedAt), lt(this.schema.turns.startedAt, cutoffMs)),
    });
  }

  /**
   * Terminal-state write guarded at the database: only an open turn is
   * updated. Returns false when the turn was already terminal or missing —
   * the primitive TurnFinalizer builds on (ADR-014).
   */
  async finalizeTurnIfOpen(
    id: string,
    updates: { sessionId?: string; completedAt: number; error: string | null; status: Exclude<TurnStatus, 'queued' | 'running'> },
  ): Promise<boolean> {
    const sanitizedUpdates = sanitizeTypedDbValue(updates, 'turns.finalize');
    const updated = await this.db
      .update(this.schema.turns)
      .set(sanitizedUpdates)
      .where(and(eq(this.schema.turns.id, id), isNull(this.schema.turns.completedAt)))
      .returning({ id: this.schema.turns.id });
    return updated.length > 0;
  }

  async getAllTurns(): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany();
  }

  async getTurn(id: string): Promise<TurnSelect | undefined> {
    return this.db.query.turns.findFirst({
      where: eq(this.schema.turns.id, id),
    });
  }

  async getLatestTurnForConversation(conversationId: string): Promise<TurnSelect | undefined> {
    return this.db.query.turns.findFirst({
      where: eq(this.schema.turns.conversationId, conversationId),
      orderBy: [desc(this.schema.turns.startedAt), desc(this.schema.turns.id)],
    });
  }

  async getTurnsByStatus(
    agentId: string,
    status: string,
  ): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany({
      where: this.getTurnStatusWhere(status, agentId),
    });
  }

  async getTurnsByStatusGlobal(status: string): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany({
      where: this.getTurnStatusWhere(status),
    });
  }

  async getActiveTurnsForAgent(agentId: string): Promise<TurnSelect[]> {
    return this.db.query.turns.findMany({
      where: and(eq(this.schema.turns.agentId, agentId), isNull(this.schema.turns.completedAt)),
    });
  }

  async getTurnsCount(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.schema.turns)
      .where(eq(this.schema.turns.agentId, agentId));
    return rows[0]?.count ?? 0;
  }

  // ── Conversation Analysis ──────────────────────────────

  async getConversationCount(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.schema.conversations)
      .where(eq(this.schema.conversations.agentId, agentId));
    return rows[0]?.count ?? 0;
  }

  async getMessageCount(conversationId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.schema.messages)
      .where(eq(this.schema.messages.conversationId, conversationId));
    return rows[0]?.count ?? 0;
  }

  async getAgentAnalytics(agentId: string): Promise<{
    totalSessions: number;
    completedSessions: number;
    failedSessions: number;
    totalConversations: number;
    avgSessionDuration: number;
  }> {
    const [sessionStats] = await this.db
      .select({
        totalSessions: sql<number>`count(*)`.as('total_sessions'),
        completedSessions: sql<number>`sum(case when ${this.schema.turns.completedAt} is not null and ${this.schema.turns.error} is null then 1 else 0 end)`.as('completed_sessions'),
        failedSessions: sql<number>`sum(case when ${this.schema.turns.error} is not null then 1 else 0 end)`.as('failed_sessions'),
        avgSessionDuration: sql<number>`coalesce(avg(case when ${this.schema.turns.completedAt} is not null and ${this.schema.turns.startedAt} is not null then ${this.schema.turns.completedAt} - ${this.schema.turns.startedAt} end), 0)`.as('avg_session_duration'),
      })
      .from(this.schema.turns)
      .where(eq(this.schema.turns.agentId, agentId));

    const conversationCount = await this.getConversationCount(agentId);

    return {
      totalSessions: sessionStats?.totalSessions ?? 0,
      completedSessions: sessionStats?.completedSessions ?? 0,
      failedSessions: sessionStats?.failedSessions ?? 0,
      totalConversations: conversationCount,
      avgSessionDuration: Math.round(sessionStats?.avgSessionDuration ?? 0),
    };
  }

  // ── Event Store ──────────────────────────────────────────

  async saveEvent(type: string, agentId: string, payload: string): Promise<number> {
    const sanitizedType = sanitizeDbText(type, 'eventStore.type');
    const sanitizedPayload = sanitizeDbText(payload, 'eventStore.payload');
    const [row] = await this.db
      .insert(this.schema.eventStore)
      .values({ type: sanitizedType, agentId, payload: sanitizedPayload, createdAt: Date.now() })
      .returning({ seq: this.schema.eventStore.seq });
    if (!row) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return row.seq;
  }

  /**
   * Batch-persist canonical frames in one round trip (ADR-015). Returns the
   * assigned global seqs in input order.
   */
  async saveEventBatch(frames: EventFrameInsert[]): Promise<number[]> {
    if (frames.length === 0) {
      return [];
    }
    const now = Date.now();
    const rows = await this.db
      .insert(this.schema.eventStore)
      .values(frames.map((frame) => ({
        type: sanitizeDbText(frame.type, 'eventStore.type'),
        agentId: frame.agentId,
        payload: sanitizeDbText(frame.payload, 'eventStore.payload'),
        createdAt: now,
        turnId: frame.turnId ?? null,
        conversationId: frame.conversationId ?? null,
        channel: frame.channel ?? 'system',
      })))
      .returning({ seq: this.schema.eventStore.seq });
    return rows.map((row) => row.seq);
  }

  /** Latest assigned frame seq for an agent (0 when none) — CONNECTED.latestSeq. */
  async getLatestEventSeq(agentId: string): Promise<number> {
    const [row] = await this.db
      .select({ seq: sql<number>`coalesce(max(${this.schema.eventStore.seq}), 0)` })
      .from(this.schema.eventStore)
      .where(eq(this.schema.eventStore.agentId, agentId));
    return row?.seq ?? 0;
  }

  /** Durable replay: frames for an agent after a seq, optionally per channel (ADR-015). */
  async getFramesSince(
    agentId: string,
    afterSeq: number,
    options: { channels?: string[]; limit?: number } = {},
  ): Promise<EventFrameRow[]> {
    const conditions = [
      eq(this.schema.eventStore.agentId, agentId),
      gt(this.schema.eventStore.seq, afterSeq),
    ];
    if (options.channels && options.channels.length > 0) {
      conditions.push(inArray(this.schema.eventStore.channel, options.channels));
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

  async createSuspendedSession(data: SuspendedSessionInsert): Promise<void> {
    const sanitizedData = sanitizeTypedDbValue(data, 'suspendedSessions.insert');
    await this.db.insert(this.schema.suspendedSessions).values(sanitizedData);
  }

  async getSuspendedSessionsByEventType(eventType: string): Promise<SuspendedSessionRow[]> {
    return this.db.query.suspendedSessions.findMany({
      where: eq(this.schema.suspendedSessions.waitEventType, eventType),
    });
  }

  async deleteSuspendedSession(id: string): Promise<void> {
    await this.db.delete(this.schema.suspendedSessions).where(eq(this.schema.suspendedSessions.id, id));
  }

  async expireOldSuspendedSessions(beforeTime: number): Promise<number> {
    const deleted = await this.db
      .delete(this.schema.suspendedSessions)
      .where(
        and(
          isNotNull(this.schema.suspendedSessions.waitExpiresAt),
          lt(this.schema.suspendedSessions.waitExpiresAt, beforeTime),
        ),
      )
      .returning({ id: this.schema.suspendedSessions.id });
    return deleted.length;
  }

  async getEventsSince(
    agentId: string,
    afterSeq: number,
    limit = 100,
  ): Promise<Array<{ seq: number; type: string; agentId: string; payload: string; createdAt: number }>> {
    return this.db
      .select({
        seq: this.schema.eventStore.seq,
        type: this.schema.eventStore.type,
        agentId: this.schema.eventStore.agentId,
        payload: this.schema.eventStore.payload,
        createdAt: this.schema.eventStore.createdAt,
      })
      .from(this.schema.eventStore)
      .where(
        and(
          eq(this.schema.eventStore.agentId, agentId),
          gt(this.schema.eventStore.seq, afterSeq),
        ),
      )
      .orderBy(this.schema.eventStore.seq)
      .limit(limit);
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

  // ── Scheduled Events ──────────────────────────────────────

  async createScheduledEvent(data: { id: string; agentId: string; type: string; payload: string; wakeAt: number }): Promise<void> {
    const sanitizedData = sanitizeTypedDbValue(data, 'scheduledEvents.insert');
    await this.db.insert(this.schema.scheduledEvents).values({
      id: sanitizedData.id,
      agentId: sanitizedData.agentId,
      type: sanitizedData.type,
      payload: sanitizedData.payload,
      wakeAt: sanitizedData.wakeAt,
      status: 'pending',
      createdAt: Date.now(),
    });
  }

  async getScheduledEventsDue(beforeTime: number, limit = 100): Promise<ScheduledEventRow[]> {
    return this.claimScheduledEventsDue(limit, beforeTime);
  }

  async claimScheduledEventsDue(
    limit: number,
    beforeTime: number,
    leaseMs = DEFAULT_CLAIM_LEASE_MS,
  ): Promise<ScheduledEventRow[]> {
    const now = Date.now();
    const claimExpiresAt = now + leaseMs;
    const rows = await this.db
      .update(this.schema.scheduledEvents)
      .set({
        status: 'in_progress',
        claimedAt: now,
        claimExpiresAt,
        attempts: sql`${this.schema.scheduledEvents.attempts} + 1`,
      })
      .where(
        inArray(
          this.schema.scheduledEvents.id,
          this.db
            .select({ id: this.schema.scheduledEvents.id })
            .from(this.schema.scheduledEvents)
            .where(
              and(
                lte(this.schema.scheduledEvents.wakeAt, beforeTime),
                or(
                  eq(this.schema.scheduledEvents.status, 'pending'),
                  and(
                    eq(this.schema.scheduledEvents.status, 'in_progress'),
                    lt(this.schema.scheduledEvents.claimExpiresAt, now),
                  ),
                ),
              ),
            )
            .orderBy(this.schema.scheduledEvents.wakeAt)
            .limit(limit)
            .for('update', { skipLocked: true }),
        ),
      )
      .returning();
    return rows;
  }

  async markScheduledEventCompleted(id: string, claimedAt?: number | null): Promise<void> {
    const conditions = [
      eq(this.schema.scheduledEvents.id, id),
      eq(this.schema.scheduledEvents.status, 'in_progress'),
    ];
    if (claimedAt != null) {
      conditions.push(eq(this.schema.scheduledEvents.claimedAt, claimedAt));
    }

    await this.db
      .update(this.schema.scheduledEvents)
      .set({
        status: 'completed',
        claimedAt: null,
        claimExpiresAt: null,
      })
      .where(and(...conditions));
  }

  async releaseScheduledEventClaim(id: string, error: string, claimedAt?: number | null): Promise<void> {
    const sanitizedError = sanitizeDbText(error, 'scheduledEvents.lastError');
    const conditions = [
      eq(this.schema.scheduledEvents.id, id),
      eq(this.schema.scheduledEvents.status, 'in_progress'),
    ];
    if (claimedAt != null) {
      conditions.push(eq(this.schema.scheduledEvents.claimedAt, claimedAt));
    }

    await this.db
      .update(this.schema.scheduledEvents)
      .set({
        status: 'pending',
        claimedAt: null,
        claimExpiresAt: null,
        lastError: sanitizedError,
      })
      .where(and(...conditions));
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

  async getTrigger(id: string): Promise<TriggerSelect | undefined> {
    return this.db.query.eventTriggers.findFirst({
      where: eq(this.schema.eventTriggers.id, id),
    });
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

  async getTriggersForEvent(eventType: string): Promise<TriggerSelect[]> {
    return this.db.query.eventTriggers.findMany({
      where: eq(this.schema.eventTriggers.eventType, eventType),
    });
  }

  async deleteTrigger(id: string): Promise<void> {
    await this.db.delete(this.schema.eventTriggers).where(eq(this.schema.eventTriggers.id, id));
  }

  // ── Agent Manifest ─────────────────────────────────────

  async saveAgentManifest(
    agentId: string,
    manifest: Record<string, unknown>,
    changedBy?: string,
    changeNote?: string,
  ): Promise<void> {
    const sanitizedManifest = sanitizeTypedDbValue(manifest, 'agents.manifest');
    await this.db.transaction(async (tx) => {
      const lockedAgents = await tx.execute(sql`
        SELECT version
        FROM agents
        WHERE id = ${agentId}
        FOR UPDATE
      `);
      const lockedAgent = Array.isArray(lockedAgents) ? lockedAgents[0] : lockedAgents?.[0];
      if (!lockedAgent) throw new Error(`Agent ${agentId} not found`);

      const currentVersion = Number(lockedAgent.version ?? 0);
      const newVersion = currentVersion + 1;
      const versionData = sanitizeTypedDbValue({
        agentId,
        version: newVersion,
        manifest: sanitizedManifest,
        changedBy: changedBy ?? null,
        changeNote: changeNote ?? null,
        createdAt: Date.now(),
      }, 'agentVersions.insert');

      await tx.update(this.schema.agents).set({ manifest: sanitizedManifest, version: newVersion, updatedAt: Date.now() }).where(eq(this.schema.agents.id, agentId));
      await tx.insert(this.schema.agentVersions).values(versionData);
    });
  }

  async getAgentManifest(agentId: string): Promise<Record<string, unknown> | null> {
    const agent = await this.getAgent(agentId);
    return agent?.manifest ?? null;
  }

  async getAgentVersions(agentId: string): Promise<VersionSelect[]> {
    return this.db.query.agentVersions.findMany({
      where: eq(this.schema.agentVersions.agentId, agentId),
      orderBy: (v, { desc }) => [desc(v.version)],
    });
  }

  async getAgentVersion(agentId: string, version: number): Promise<VersionSelect | undefined> {
    return this.db.query.agentVersions.findFirst({
      where: and(
        eq(this.schema.agentVersions.agentId, agentId),
        eq(this.schema.agentVersions.version, version),
      ),
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
          agentSessionId: sanitizedData.agentSessionId,
          agentId: sanitizedData.agentId,
          sessionId: sanitizedData.sessionId ?? null,
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

  async getPendingInterruptsForAgent(agentId: string): Promise<InterruptRow[]> {
    return this.db.query.pendingInterrupts.findMany({
      where: and(
        eq(this.schema.pendingInterrupts.agentId, agentId),
        eq(this.schema.pendingInterrupts.status, 'pending'),
      ),
      orderBy: (row, { asc }) => [asc(row.createdAt)],
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

  async getPendingInterruptsForSession(sessionId: string): Promise<InterruptRow[]> {
    return this.db
      .select()
      .from(this.schema.pendingInterrupts)
      .where(
        and(
          eq(this.schema.pendingInterrupts.sessionId, sessionId),
          eq(this.schema.pendingInterrupts.status, 'pending'),
        ),
      );
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

  async getResolvedInterruptsForSession(sessionId: string): Promise<InterruptRow[]> {
    return this.db.query.pendingInterrupts.findMany({
      where: and(
        eq(this.schema.pendingInterrupts.sessionId, sessionId),
        eq(this.schema.pendingInterrupts.status, 'resolved'),
      ),
    });
  }

  async upsertInterruptResumeAttempt(
    data: InterruptResumeAttemptInsert,
  ): Promise<InterruptResumeAttemptRow> {
    const now = Date.now();
    const sanitizedData = sanitizeTypedDbValue(data, 'interruptResumeAttempts.upsert');
    const [row] = await this.db
      .insert(this.schema.interruptResumeAttempts)
      .values({
        ...sanitizedData,
        createdAt: sanitizedData.createdAt ?? now,
        updatedAt: sanitizedData.updatedAt ?? now,
      })
      .onConflictDoUpdate({
        target: this.schema.interruptResumeAttempts.interruptId,
        set: {
          status: 'pending',
          sessionId: sanitizedData.sessionId ?? null,
          agentSessionId: sanitizedData.agentSessionId,
          agentId: sanitizedData.agentId,
          updatedAt: now,
          lastError: null,
          completedAt: null,
        },
      })
      .returning();
    if (!row) {
      throw new Error('Expected interrupt resume attempt upsert to return a row but got undefined');
    }
    return row;
  }

  async getInterruptResumeAttemptForInterrupt(interruptId: string): Promise<InterruptResumeAttemptRow | undefined> {
    return this.db.query.interruptResumeAttempts.findFirst({
      where: eq(this.schema.interruptResumeAttempts.interruptId, interruptId),
    });
  }

  async markInterruptResumeAttemptInProgress(id: string): Promise<InterruptResumeAttemptRow | undefined> {
    const [row] = await this.db
      .update(this.schema.interruptResumeAttempts)
      .set({
        status: 'in_progress',
        attempts: sql`${this.schema.interruptResumeAttempts.attempts} + 1`,
        updatedAt: Date.now(),
        lastError: null,
      })
      .where(eq(this.schema.interruptResumeAttempts.id, id))
      .returning();
    return row;
  }

  async markInterruptResumeAttemptCompleted(id: string): Promise<InterruptResumeAttemptRow | undefined> {
    const now = Date.now();
    const [row] = await this.db
      .update(this.schema.interruptResumeAttempts)
      .set({
        status: 'completed',
        updatedAt: now,
        completedAt: now,
        lastError: null,
      })
      .where(eq(this.schema.interruptResumeAttempts.id, id))
      .returning();
    return row;
  }

  async markInterruptResumeAttemptFailed(id: string, error: string): Promise<InterruptResumeAttemptRow | undefined> {
    const [row] = await this.db
      .update(this.schema.interruptResumeAttempts)
      .set({
        status: 'failed',
        updatedAt: Date.now(),
        lastError: sanitizeDbText(error, 'interruptResumeAttempts.lastError'),
      })
      .where(eq(this.schema.interruptResumeAttempts.id, id))
      .returning();
    return row;
  }

  // ── Callback Outbox ──────────────────────────────────────

  async enqueueCallback(data: CallbackOutboxInsert): Promise<CallbackOutboxRow> {
    const sanitizedData = sanitizeTypedDbValue(data, 'callbackOutbox.insert');
    const [row] = await this.db
      .insert(this.schema.callbackOutbox)
      .values(sanitizedData)
      .returning();
    if (!row) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return row;
  }

  async getPendingCallbacks(limit: number, beforeTime: number): Promise<CallbackOutboxRow[]> {
    return this.claimPendingCallbacks(limit, beforeTime);
  }

  async claimPendingCallbacks(
    limit: number,
    beforeTime: number,
    leaseMs = DEFAULT_CLAIM_LEASE_MS,
  ): Promise<CallbackOutboxRow[]> {
    const now = Date.now();
    const claimExpiresAt = now + leaseMs;
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
    const [row] = await this.db.insert(this.schema.webhooks).values(sanitizedData).returning();
    if (!row) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return row;
  }

  async listWebhooks(agentId: string): Promise<WebhookRow[]> {
    return this.db
      .select()
      .from(this.schema.webhooks)
      .where(and(eq(this.schema.webhooks.agentId, agentId), eq(this.schema.webhooks.active, true)));
  }

  async deleteWebhook(id: string): Promise<boolean> {
    return this.deleteWebhookForAgent(id);
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

  async getWebhooksForAgent(agentId: string): Promise<WebhookRow[]> {
    return this.db
      .select()
      .from(this.schema.webhooks)
      .where(and(eq(this.schema.webhooks.agentId, agentId), eq(this.schema.webhooks.active, true)));
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
    checkpointRef?: string;
  }): Promise<SandboxSessionRow> {
    const sanitizedSession = sanitizeTypedDbValue(session, 'sandboxSessions.insert');
    const [row] = await this.db
      .insert(this.schema.sandboxSessions)
      .values({
        ...(sanitizedSession.id !== undefined ? { id: sanitizedSession.id } : {}),
        conversationId: sanitizedSession.conversationId,
        agentId: sanitizedSession.agentId,
        containerName: sanitizedSession.containerName ?? null,
        containerId: sanitizedSession.containerId ?? null,
        status: sanitizedSession.status ?? 'ACTIVE',
        harnessName: sanitizedSession.harnessName,
        checkpointRef: sanitizedSession.checkpointRef ?? null,
      })
      .returning();
    if (!row) throw new Error('Expected insert to return a row but got undefined');
    return row;
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
      checkpointRef?: string | null;
      restoreAttempts?: number | null;
      lastRestoreError?: string | null;
    },
  ): Promise<void> {
    const sanitizedStatus = sanitizeDbText(status, 'sandboxSessions.status');
    const sanitizedExtra = extra ? sanitizeTypedDbValue(extra, 'sandboxSessions.update') : undefined;

    const [updated] = await this.db
      .update(this.schema.sandboxSessions)
      .set({
        status: sanitizedStatus,
        updatedAt: Date.now(),
        lastActivityAt: Date.now(),
        ...(sanitizedExtra?.containerName !== undefined ? { containerName: sanitizedExtra.containerName } : {}),
        ...(sanitizedExtra?.containerId !== undefined ? { containerId: sanitizedExtra.containerId } : {}),
        ...(sanitizedExtra?.checkpointRef !== undefined ? { checkpointRef: sanitizedExtra.checkpointRef } : {}),
        ...(sanitizedExtra?.restoreAttempts !== undefined && sanitizedExtra.restoreAttempts !== null
          ? { restoreAttempts: sanitizedExtra.restoreAttempts }
          : {}),
        ...(sanitizedExtra?.lastRestoreError !== undefined
          ? { lastRestoreError: sanitizedExtra.lastRestoreError }
          : {}),
      })
      .where(eq(this.schema.sandboxSessions.id, id))
      .returning({ id: this.schema.sandboxSessions.id });

    if (!updated) {
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
    if (updatedBeforeMs === undefined) {
      return this.db
        .select()
        .from(this.schema.sandboxSessions)
        .where(eq(this.schema.sandboxSessions.status, 'RESTORING'));
    }

    return this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(
        and(
          eq(this.schema.sandboxSessions.status, 'RESTORING'),
          lt(this.schema.sandboxSessions.updatedAt, updatedBeforeMs),
        ),
      );
  }

  async getSandboxSessionsByAgent(agentId: string): Promise<SandboxSessionRow[]> {
    return this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(eq(this.schema.sandboxSessions.agentId, agentId));
  }

  async getSessionStatusCountsByAgent(): Promise<Map<string, ApiSessionStatusCounts>> {
    const rows = await this.db
      .select({
        agentId: this.schema.sandboxSessions.agentId,
        status: this.schema.sandboxSessions.status,
        count: sql<number>`count(*)::int`,
      })
      .from(this.schema.sandboxSessions)
      .groupBy(this.schema.sandboxSessions.agentId, this.schema.sandboxSessions.status);

    const emptyCounts = (): ApiSessionStatusCounts => ({
      ACTIVE: 0,
      CHECKPOINTED: 0,
      RESTORING: 0,
      TERMINATED: 0,
    });

    const result = new Map<string, ApiSessionStatusCounts>();
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
        startedAt: sql<number | null>`min(${this.schema.turns.startedAt})`.as('started_at'),
        turnCount: sql<number>`count(*)::int`.as('turn_count'),
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
    }> = await this.db
      .select({
        id: this.schema.conversations.id,
        agentId: this.schema.conversations.agentId,
        updatedAt: this.schema.conversations.updatedAt,
        conversationCreatedAt: this.schema.conversations.createdAt,
        startedAt: turnStats.startedAt,
        turnCount: turnStats.turnCount,
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
      const status = projectSessionStatus(
        { completedAt: row.completedAt, error: row.error },
        row.sandboxStatus,
        'IDLE',
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
        updatedAt: row.updatedAt,
        latestTurnId: row.latestTurnId ?? null,
        sandboxSessionId: row.sandboxSessionId ?? null,
      };
    });
  }

  // ── Checkpoints v2 (Session-based) ────────────────────────

  async createCheckpointV2(checkpoint: {
    sessionId: string;
    agentId: string;
    checkpointVersion?: number;
    checkpointData: Record<string, unknown>;
    harnessState?: Record<string, unknown>;
    workspaceRef?: string;
    suspendReason?: string;
  }): Promise<{ id: string }> {
    const sanitizedCheckpoint = sanitizeTypedDbValue({
      sessionId: checkpoint.sessionId,
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
        sessionId: sanitizedCheckpoint.sessionId,
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

  async getCheckpointV2(sessionId: string): Promise<CheckpointV2 | null> {
    const rows = await this.db
      .select()
      .from(this.schema.agentCheckpoints)
      .where(eq(this.schema.agentCheckpoints.sessionId, sessionId))
      .orderBy(desc(this.schema.agentCheckpoints.createdAt))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      checkpointVersion: row.checkpointVersion,
      checkpointData: row.checkpointData,
      harnessState: row.harnessState,
      workspaceRef: row.workspaceRef,
      suspendReason: row.suspendReason,
      createdAt: row.createdAt,
    };
  }

  async deleteCheckpointsForSession(sessionId: string): Promise<number> {
    const deleted = await this.db
      .delete(this.schema.agentCheckpoints)
      .where(eq(this.schema.agentCheckpoints.sessionId, sessionId))
      .returning({ id: this.schema.agentCheckpoints.id });
    return deleted.length;
  }

  async getSystemSetting(key: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(this.schema.systemSettings)
      .where(eq(this.schema.systemSettings.key, key))
      .limit(1);
    return rows[0]?.value ?? null;
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

  async tryInsertToolDedup(requestId: string, sessionId: string, toolName: string): Promise<boolean> {
    try {
      await this.db.insert(this.schema.toolRequestDedup).values(
        sanitizeTypedDbValue({ requestId, sessionId, toolName, status: 'in_progress' }, 'toolRequestDedup.insert'),
      );
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate') || msg.includes('23505')) {
        return false;
      }
      throw err;
    }
  }

  async getToolDedup(requestId: string): Promise<{
    requestId: string;
    sessionId: string;
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
    const [row] = await this.db.insert(this.schema.artifacts).values(sanitizedData).returning();
    if (!row) throw new Error('Expected insert to return a row but got undefined');
    return row;
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
    const [row] = await this.db
      .update(this.schema.artifacts)
      .set({ status: 'upload_failed', updatedAt: Date.now() })
      .where(eq(this.schema.artifacts.id, id))
      .returning();
    return row;
  }

  async markArtifactDeleting(id: string): Promise<ArtifactRow | undefined> {
    const [row] = await this.db
      .update(this.schema.artifacts)
      .set({ status: 'deleting', updatedAt: Date.now() })
      .where(eq(this.schema.artifacts.id, id))
      .returning();
    return row;
  }

  async markArtifactDeleteFailed(id: string): Promise<ArtifactRow | undefined> {
    const [row] = await this.db
      .update(this.schema.artifacts)
      .set({ status: 'delete_failed', updatedAt: Date.now() })
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

  async listArtifactsForSession(sessionId: string): Promise<ArtifactRow[]> {
    return this.db.query.artifacts.findMany({
      where: and(
        eq(this.schema.artifacts.sessionId, sessionId),
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
