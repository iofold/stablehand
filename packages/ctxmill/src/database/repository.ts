import { eq, sql, gt, lt, and, desc, asc, inArray, isNotNull, isNull, ilike } from 'drizzle-orm';
import type { DrizzleDb } from './connection.js';
import * as pgSchema from './schema-pg.js';
import { sanitizeDbText, sanitizeDbValue } from '../util/sanitize.js';

type AgentInsert = typeof pgSchema.agents.$inferInsert;
type AgentSelect = typeof pgSchema.agents.$inferSelect;
type ConversationSelect = typeof pgSchema.conversations.$inferSelect;
type MessageInsert = typeof pgSchema.messages.$inferInsert;
type MessageSelect = typeof pgSchema.messages.$inferSelect;
type KnowledgeInsert = typeof pgSchema.knowledgeItems.$inferInsert;
type KnowledgeSelect = typeof pgSchema.knowledgeItems.$inferSelect;
type TraceInsert = typeof pgSchema.executionTraces.$inferInsert;
type TraceSelect = typeof pgSchema.executionTraces.$inferSelect;
type FeedbackInsert = typeof pgSchema.feedbackSignals.$inferInsert;
type FeedbackSelect = typeof pgSchema.feedbackSignals.$inferSelect;
type TurnInsert = typeof pgSchema.turns.$inferInsert;
type TurnSelect = typeof pgSchema.turns.$inferSelect;
type SuspendedSessionInsert = typeof pgSchema.suspendedSessions.$inferInsert;
export type SuspendedSessionRow = typeof pgSchema.suspendedSessions.$inferSelect;
export type ScheduledEventRow = typeof pgSchema.scheduledEvents.$inferSelect;
type TriggerInsert = typeof pgSchema.eventTriggers.$inferInsert;
type TriggerSelect = typeof pgSchema.eventTriggers.$inferSelect;
type VersionSelect = typeof pgSchema.agentVersions.$inferSelect;
type InterruptInsert = typeof pgSchema.pendingInterrupts.$inferInsert;
export type InterruptRow = typeof pgSchema.pendingInterrupts.$inferSelect;
type CallbackOutboxInsert = typeof pgSchema.callbackOutbox.$inferInsert;
export type CallbackOutboxRow = typeof pgSchema.callbackOutbox.$inferSelect;
type WebhookInsert = typeof pgSchema.webhooks.$inferInsert;
export type WebhookRow = typeof pgSchema.webhooks.$inferSelect;
export type SandboxSessionRow = Omit<typeof pgSchema.sandboxSessions.$inferSelect, 'pausedAt' | 'pausedReason'> & {
  pausedAt?: number | null;
  pausedReason?: string | null;
};
export type SystemSettingRow = typeof pgSchema.systemSettings.$inferSelect;
type ArtifactInsert = typeof pgSchema.artifacts.$inferInsert;
type ArtifactRow = typeof pgSchema.artifacts.$inferSelect;

const sanitizeTypedDbValue = <T>(value: T, context: string): T => sanitizeDbValue(value, context) as T;

const sanitizeOptionalDbText = <T extends string | null | undefined>(value: T, context: string): T => {
  if (value == null) return value;
  return sanitizeDbText(value, context) as T;
};

export interface Checkpoint {
  id: string;
  sessionId: string;
  agentId: string;
  version: number;
  checkpointData: Record<string, unknown>;
  workspaceRef: string | null;
  suspendReason: string | null;
  createdAt: Date;
}

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
  status: 'running' | 'paused' | 'suspended' | 'completed' | 'error' | 'idle';
  mode: string;
  turnCount: number;
  messageCount: number;
  taskDescription: string | null;
  startedAt: number;
  updatedAt: number;
  latestTurnId: string | null;
  sandboxSessionId: string | null;
  sandboxStatus: string | null;
}

export class DatabaseRepository {
  private db: any;
  private schema = pgSchema;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  private getTurnStatusWhere(status: string, agentId?: string) {
    const activeStatuses = new Set(['queued', 'running', 'paused', 'suspended', 'active']);
    const condition = activeStatuses.has(status)
      ? isNull(this.schema.turns.completedAt)
      : status === 'completed'
        ? and(isNotNull(this.schema.turns.completedAt), isNull(this.schema.turns.error))
        : status === 'error' || status === 'failed'
          ? isNotNull(this.schema.turns.error)
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
   * Order: messages -> conversations -> runs -> traces -> feedback -> knowledge -> events -> agent
   */
  async deleteAgentCascade(agentId: string): Promise<void> {
    await this.db.transaction(async (tx: any) => {
      const conversations = await tx
        .select({ id: this.schema.conversations.id })
        .from(this.schema.conversations)
        .where(eq(this.schema.conversations.agentId, agentId));
      const conversationIds = conversations.map((c: any) => c.id);
      if (conversationIds.length > 0) {
        await tx.delete(this.schema.messages).where(inArray(this.schema.messages.conversationId, conversationIds));
      }
      await tx.delete(this.schema.agentCheckpoints).where(eq(this.schema.agentCheckpoints.agentId, agentId));
      await tx.delete(this.schema.callbackOutbox).where(eq(this.schema.callbackOutbox.agentId, agentId));
      await tx.delete(this.schema.turns).where(eq(this.schema.turns.agentId, agentId));
      await tx.delete(this.schema.sandboxSessions).where(eq(this.schema.sandboxSessions.agentId, agentId));
      await tx.delete(this.schema.conversations).where(eq(this.schema.conversations.agentId, agentId));
      await tx.delete(this.schema.executionTraces).where(eq(this.schema.executionTraces.agentId, agentId));
      await tx.delete(this.schema.feedbackSignals).where(eq(this.schema.feedbackSignals.agentId, agentId));
      await tx.delete(this.schema.knowledgeItems).where(eq(this.schema.knowledgeItems.agentId, agentId));
      await tx.delete(this.schema.eventStore).where(eq(this.schema.eventStore.agentId, agentId));
      await tx.delete(this.schema.eventTriggers).where(eq(this.schema.eventTriggers.agentId, agentId));
      await tx.delete(this.schema.agents).where(eq(this.schema.agents.id, agentId));
    });
  }

  async updateAgentStatus(id: string, status: string): Promise<AgentSelect | undefined> {
    return this.updateAgent(id, { status });
  }

  // ── Conversations ───────────────────────────────────────

  async createConversation(agentId: string): Promise<ConversationSelect> {
    const sanitizedAgentId = sanitizeDbText(agentId, 'conversations.agentId');
    const [conversation] = await this.db
      .insert(this.schema.conversations)
      .values({ agentId: sanitizedAgentId })
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
      orderBy: (conversations: any) => [desc(conversations.updatedAt)],
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

    return this.db.transaction(async (tx: any) => {
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

  async deleteMessage(id: string): Promise<void> {
    await this.db.delete(this.schema.messages).where(eq(this.schema.messages.id, id));
  }

  async getMessages(conversationId: string): Promise<MessageSelect[]> {
    return this.db.query.messages.findMany({
      where: eq(this.schema.messages.conversationId, conversationId),
      orderBy: (messages: any) => [asc(messages.createdAt), asc(messages.id)],
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
    return this.queryConversationSummaries({ sandboxStatuses: ['ACTIVE', 'PAUSED'] });
  }

  // ── Knowledge Items ─────────────────────────────────────

  async addKnowledgeItem(data: KnowledgeInsert): Promise<KnowledgeSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'knowledgeItems.insert');
    const [item] = await this.db.insert(this.schema.knowledgeItems).values(sanitizedData).returning();
    if (!item) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return item;
  }

  async getKnowledgeItems(agentId: string, category?: string): Promise<KnowledgeSelect[]> {
    if (category) {
      return this.db.query.knowledgeItems.findMany({
        where: (ki: any, { and }: any) =>
          and(eq(ki.agentId, agentId), eq(ki.category, category)),
      });
    }
    return this.db.query.knowledgeItems.findMany({
      where: eq(this.schema.knowledgeItems.agentId, agentId),
    });
  }

  async updateKnowledgeItem(
    id: string,
    data: Partial<Omit<KnowledgeInsert, 'id'>>,
  ): Promise<KnowledgeSelect | undefined> {
    const sanitizedData = sanitizeTypedDbValue(data, 'knowledgeItems.update');
    const [updated] = await this.db
      .update(this.schema.knowledgeItems)
      .set({ ...sanitizedData, updatedAt: Date.now() })
      .where(eq(this.schema.knowledgeItems.id, id))
      .returning();
    return updated;
  }

  async removeKnowledgeItem(id: string): Promise<void> {
    await this.db.delete(this.schema.knowledgeItems).where(eq(this.schema.knowledgeItems.id, id));
  }

  async getKnowledgeForAgent(agentId: string): Promise<KnowledgeSelect[]> {
    return this.db.query.knowledgeItems.findMany({
      where: eq(this.schema.knowledgeItems.agentId, agentId),
    });
  }

  // ── Execution Traces ────────────────────────────────────

  async saveTrace(data: TraceInsert): Promise<TraceSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'executionTraces.upsert');
    const [trace] = await this.db
      .insert(this.schema.executionTraces)
      .values(sanitizedData)
      .onConflictDoUpdate({
        target: [this.schema.executionTraces.sessionId, this.schema.executionTraces.agentId],
        set: {
          steps: sanitizedData.steps,
          completedAt: sanitizedData.completedAt,
          outcome: sanitizedData.outcome,
        },
      })
      .returning();
    if (!trace) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return trace;
  }

  async getTraces(agentId: string): Promise<TraceSelect[]> {
    return this.db.query.executionTraces.findMany({
      where: eq(this.schema.executionTraces.agentId, agentId),
    });
  }

  async getRecentTraces(agentId: string, limit = 20): Promise<TraceSelect[]> {
    return this.db
      .select()
      .from(this.schema.executionTraces)
      .where(eq(this.schema.executionTraces.agentId, agentId))
      .orderBy(sql`${this.schema.executionTraces.startedAt} DESC`)
      .limit(limit);
  }

  // ── Feedback Signals ────────────────────────────────────

  async saveFeedback(data: FeedbackInsert): Promise<FeedbackSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'feedbackSignals.insert');
    const [feedback] = await this.db.insert(this.schema.feedbackSignals).values(sanitizedData).returning();
    if (!feedback) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return feedback;
  }

  async getFeedbackForTrace(traceId: string): Promise<FeedbackSelect[]> {
    return this.db.query.feedbackSignals.findMany({
      where: eq(this.schema.feedbackSignals.traceId, traceId),
    });
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
      orderBy: (turns: typeof this.schema.turns) => [desc(turns.startedAt), desc(turns.id)],
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

  // ── Knowledge Stats ────────────────────────────────────

  async getKnowledgeCount(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.schema.knowledgeItems)
      .where(eq(this.schema.knowledgeItems.agentId, agentId));
    return rows[0]?.count ?? 0;
  }

  async getKnowledgeItem(id: string): Promise<KnowledgeSelect | undefined> {
    return this.db.query.knowledgeItems.findFirst({
      where: eq(this.schema.knowledgeItems.id, id),
    });
  }

  async getKnowledgeCategories(agentId: string): Promise<{ category: string; count: number }[]> {
    return this.db
      .select({
        category: this.schema.knowledgeItems.category,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(this.schema.knowledgeItems)
      .where(eq(this.schema.knowledgeItems.agentId, agentId))
      .groupBy(this.schema.knowledgeItems.category);
  }

  // ── Trace Analysis ─────────────────────────────────────

  async getTraceWithFeedback(traceId: string): Promise<{
    trace: TraceSelect | undefined;
    feedback: FeedbackSelect[];
  }> {
    const trace = await this.db.query.executionTraces.findFirst({
      where: eq(this.schema.executionTraces.id, traceId),
    });
    const feedback = await this.db.query.feedbackSignals.findMany({
      where: eq(this.schema.feedbackSignals.traceId, traceId),
    });
    return { trace, feedback };
  }

  async getTracesForAgent(
    agentId: string,
    options: { limit?: number; offset?: number; outcome?: string } = {},
  ): Promise<{ traces: TraceSelect[]; total: number }> {
    const { limit = 20, offset = 0, outcome } = options;

    const whereClause = outcome
      ? sql`${this.schema.executionTraces.agentId} = ${agentId} AND ${this.schema.executionTraces.outcome} = ${outcome}`
      : eq(this.schema.executionTraces.agentId, agentId);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.schema.executionTraces)
      .where(whereClause);

    const traces = await this.db
      .select()
      .from(this.schema.executionTraces)
      .where(whereClause)
      .orderBy(sql`${this.schema.executionTraces.startedAt} DESC`)
      .limit(limit)
      .offset(offset);

    return { traces, total: countRows[0]?.count ?? 0 };
  }

  async getTraceStats(agentId: string): Promise<{
    total: number;
    byOutcome: Record<string, number>;
    avgSteps: number;
    recentCount: number;
  }> {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    // Aggregate by outcome in SQL
    const outcomeRows = await this.db
      .select({
        outcome: sql<string>`coalesce(${this.schema.executionTraces.outcome}, 'unknown')`.as('outcome'),
        count: sql<number>`count(*)`.as('count'),
      })
      .from(this.schema.executionTraces)
      .where(eq(this.schema.executionTraces.agentId, agentId))
      .groupBy(sql`coalesce(${this.schema.executionTraces.outcome}, 'unknown')`);

    const byOutcome: Record<string, number> = {};
    let total = 0;
    for (const row of outcomeRows) {
      byOutcome[row.outcome] = row.count;
      total += row.count;
    }

    // Avg steps via JSON array length + recent count in a single query
    const [statsRow] = await this.db
      .select({
        avgSteps: sql<number>`coalesce(avg(jsonb_array_length(${this.schema.executionTraces.steps})), 0)`.as('avg_steps'),
        recentCount: sql<number>`sum(case when ${this.schema.executionTraces.startedAt} >= ${oneDayAgo} then 1 else 0 end)`.as('recent_count'),
      })
      .from(this.schema.executionTraces)
      .where(eq(this.schema.executionTraces.agentId, agentId));

    return {
      total,
      byOutcome,
      avgSteps: Math.round(statsRow?.avgSteps ?? 0),
      recentCount: statsRow?.recentCount ?? 0,
    };
  }

  // ── Feedback Analysis ──────────────────────────────────

  async getFeedbackForAgent(agentId: string): Promise<FeedbackSelect[]> {
    return this.db.query.feedbackSignals.findMany({
      where: eq(this.schema.feedbackSignals.agentId, agentId),
    });
  }

  async getFeedbackStats(agentId: string): Promise<{
    total: number;
    byType: Record<string, number>;
    recentCount: number;
  }> {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    // Aggregate by type in SQL
    const typeRows = await this.db
      .select({
        type: this.schema.feedbackSignals.type,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(this.schema.feedbackSignals)
      .where(eq(this.schema.feedbackSignals.agentId, agentId))
      .groupBy(this.schema.feedbackSignals.type);

    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of typeRows) {
      const count = Number(row.count);
      byType[row.type] = count;
      total += count;
    }

    // Recent count in SQL
    const [recentRow] = await this.db
      .select({
        recentCount: sql<number>`count(*)`.as('recent_count'),
      })
      .from(this.schema.feedbackSignals)
      .where(sql`${this.schema.feedbackSignals.agentId} = ${agentId} AND ${this.schema.feedbackSignals.createdAt} >= ${oneDayAgo}`);

    return { total, byType, recentCount: Number(recentRow?.recentCount ?? 0) };
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
    totalKnowledge: number;
    totalTraces: number;
    totalFeedback: number;
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

    const [conversationCount, knowledgeCount, traceStats, feedbackStats] = await Promise.all([
      this.getConversationCount(agentId),
      this.getKnowledgeCount(agentId),
      this.getTraceStats(agentId),
      this.getFeedbackStats(agentId),
    ]);

    return {
      totalSessions: sessionStats?.totalSessions ?? 0,
      completedSessions: sessionStats?.completedSessions ?? 0,
      failedSessions: sessionStats?.failedSessions ?? 0,
      totalConversations: conversationCount,
      totalKnowledge: knowledgeCount,
      totalTraces: traceStats.total,
      totalFeedback: feedbackStats.total,
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
    topAgents: Array<{ agentId: string; count: number }>;
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
      topAgents: agentRows.map((r: { agentId: string | null; count: number }) => ({ agentId: r.agentId, count: Number(r.count) })),
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
    return rows.map((r: any) => r.type);
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

  async getScheduledEventsDue(beforeTime: number): Promise<ScheduledEventRow[]> {
    return this.db
      .select()
      .from(this.schema.scheduledEvents)
      .where(
        and(
          eq(this.schema.scheduledEvents.status, 'pending'),
          lt(this.schema.scheduledEvents.wakeAt, beforeTime),
        ),
      );
  }

  async markScheduledEventCompleted(id: string): Promise<void> {
    await this.db
      .update(this.schema.scheduledEvents)
      .set({ status: 'completed' })
      .where(eq(this.schema.scheduledEvents.id, id));
  }

  // ── Event Triggers ──────────────────────────────────────

  async saveTrigger(data: TriggerInsert): Promise<TriggerSelect> {
    const sanitizedData = sanitizeTypedDbValue(data, 'eventTriggers.upsert');
    const [trigger] = await this.db
      .insert(this.schema.eventTriggers)
      .values(sanitizedData)
      .onConflictDoUpdate({
        target: this.schema.eventTriggers.id,
        set: {
          eventType: sanitizedData.eventType,
          selector: sanitizedData.selector,
          taskTemplate: sanitizedData.taskTemplate,
          enabled: sanitizedData.enabled,
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
    // 1. Get current agent to find current version
    const agent = await this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const newVersion = (agent.version ?? 0) + 1;

    const sanitizedManifest = sanitizeTypedDbValue(manifest, 'agents.manifest');
    const versionData = sanitizeTypedDbValue({
      agentId,
      version: newVersion,
      manifest: sanitizedManifest,
      changedBy: changedBy ?? null,
      changeNote: changeNote ?? null,
      createdAt: Date.now(),
    }, 'agentVersions.insert');
    await this.db.transaction(async (tx: any) => {
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
      orderBy: (v: any, { desc }: any) => [desc(v.version)],
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
          toolCallId: sanitizedData.toolCallId,
          toolName: sanitizedData.toolName,
          args: sanitizedData.args,
          timeoutMs: sanitizedData.timeoutMs,
          expiresAt: sanitizedData.expiresAt,
          status: sanitizedData.status ?? 'pending',
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
    });
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
      .where(eq(this.schema.pendingInterrupts.id, id))
      .returning();
    return updated;
  }

  async cleanupExpiredInterrupts(beforeTime: number): Promise<number> {
    const updated = await this.db
      .update(this.schema.pendingInterrupts)
      .set({
        status: 'resolved',
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
    return this.db
      .select()
      .from(this.schema.callbackOutbox)
      .where(
        and(
          eq(this.schema.callbackOutbox.status, 'pending'),
          lt(this.schema.callbackOutbox.nextAttemptAt, beforeTime),
        ),
      )
      .orderBy(this.schema.callbackOutbox.nextAttemptAt)
      .limit(limit);
  }

  async markCallbackDelivered(id: string): Promise<void> {
    await this.db
      .update(this.schema.callbackOutbox)
      .set({
        status: 'delivered',
        deliveredAt: Date.now(),
      })
      .where(eq(this.schema.callbackOutbox.id, id));
  }

  async markCallbackFailed(id: string, error: string, nextAttemptAt?: number): Promise<void> {
    // Get current row to check attempts
    const [current] = await this.db
      .select()
      .from(this.schema.callbackOutbox)
      .where(eq(this.schema.callbackOutbox.id, id));
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
      })
      .where(eq(this.schema.callbackOutbox.id, id));
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
    const deleted = await this.db
      .delete(this.schema.webhooks)
      .where(eq(this.schema.webhooks.id, id))
      .returning({ id: this.schema.webhooks.id });
    return deleted.length > 0;
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
    pausedReason?: string;
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
        pausedReason: sanitizedSession.pausedReason ?? null,
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
      containerName?: string;
      containerId?: string;
      checkpointRef?: string;
      pausedAt?: number | null;
      pausedReason?: string | null;
    },
  ): Promise<void> {
    const sanitizedStatus = sanitizeDbText(status, 'sandboxSessions.status');
    const sanitizedExtra = extra ? sanitizeTypedDbValue(extra, 'sandboxSessions.update') : undefined;
    const pauseMetadata = status === 'ACTIVE'
      ? { pausedAt: null, pausedReason: null }
      : {
          ...(sanitizedExtra?.pausedAt !== undefined ? { pausedAt: sanitizedExtra.pausedAt } : {}),
          ...(sanitizedExtra?.pausedReason !== undefined ? { pausedReason: sanitizedExtra.pausedReason } : {}),
        };

    await this.db
      .update(this.schema.sandboxSessions)
      .set({
        status: sanitizedStatus,
        updatedAt: Date.now(),
        lastActivityAt: Date.now(),
        ...(sanitizedExtra?.containerName !== undefined ? { containerName: sanitizedExtra.containerName } : {}),
        ...(sanitizedExtra?.containerId !== undefined ? { containerId: sanitizedExtra.containerId } : {}),
        ...(sanitizedExtra?.checkpointRef !== undefined ? { checkpointRef: sanitizedExtra.checkpointRef } : {}),
        ...pauseMetadata,
      })
      .where(eq(this.schema.sandboxSessions.id, id));
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
      .where(inArray(this.schema.sandboxSessions.status, ['ACTIVE', 'PAUSED']));
  }

  async getSandboxSessionsByAgent(agentId: string): Promise<SandboxSessionRow[]> {
    return this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(eq(this.schema.sandboxSessions.agentId, agentId));
  }

  async getSessionStatusCountsByAgent(): Promise<Map<string, { active: number; paused: number; checkpointed: number; terminated: number }>> {
    const rows = await this.db
      .select({
        agentId: this.schema.sandboxSessions.agentId,
        status: this.schema.sandboxSessions.status,
        count: sql<number>`count(*)::int`,
      })
      .from(this.schema.sandboxSessions)
      .groupBy(this.schema.sandboxSessions.agentId, this.schema.sandboxSessions.status);

    const result = new Map<string, { active: number; paused: number; checkpointed: number; terminated: number }>();
    for (const row of rows) {
      if (!result.has(row.agentId)) {
        result.set(row.agentId, { active: 0, paused: 0, checkpointed: 0, terminated: 0 });
      }
      const counts = result.get(row.agentId)!;
      const key = row.status.toLowerCase() as 'active' | 'paused' | 'checkpointed' | 'terminated';
      if (key in counts) {
        counts[key as keyof typeof counts] += row.count;
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
      let status: ConversationSummaryRow['status'] = 'idle';
      if (row.error) {
        status = 'error';
      } else if (row.completedAt != null) {
        status = 'completed';
      } else if (row.sandboxStatus === 'PAUSED') {
        status = 'paused';
      } else if (row.sandboxStatus === 'CHECKPOINTED') {
        status = 'suspended';
      } else if (row.sandboxStatus === 'ACTIVE') {
        status = 'running';
      }

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
        sandboxStatus: row.sandboxStatus ?? null,
      };
    });
  }

  async createCheckpoint(checkpoint: {
    sessionId: string;
    agentId: string;
    version?: number;
    checkpointData: Record<string, unknown>;
    workspaceRef?: string;
    suspendReason?: string;
  }): Promise<{ id: string }> {
      const existingSession = await this.getSandboxSession(checkpoint.sessionId);
      if (!existingSession) {
      const turn = await this.db.query.turns.findFirst({
        where: eq(this.schema.turns.id, checkpoint.sessionId),
      });
      if (!turn?.conversationId) {
        throw new Error(`Cannot create checkpoint without sandbox session or session conversation for ${checkpoint.sessionId}`);
      }

      const harnessName = typeof checkpoint.checkpointData.harnessName === 'string'
        ? checkpoint.checkpointData.harnessName
        : 'unknown';

      await this.createSandboxSession({
        id: checkpoint.sessionId,
        conversationId: turn.conversationId,
        agentId: checkpoint.agentId,
        harnessName,
        status: 'PAUSED',
        pausedReason: 'idle',
      });
    }

    return this.createCheckpointV2({
      sessionId: checkpoint.sessionId,
      agentId: checkpoint.agentId,
      checkpointVersion: checkpoint.version,
      checkpointData: checkpoint.checkpointData,
      workspaceRef: checkpoint.workspaceRef,
      suspendReason: checkpoint.suspendReason,
    });
  }

  async getCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const row = await this.getCheckpointV2(sessionId);
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      version: row.checkpointVersion,
      checkpointData: row.checkpointData,
      workspaceRef: row.workspaceRef,
      suspendReason: row.suspendReason,
      createdAt: new Date(row.createdAt),
    };
  }

  async deleteCheckpoints(sessionId: string): Promise<number> {
    return this.deleteCheckpointsForSession(sessionId);
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
    const sanitizedCheckpoint = sanitizeTypedDbValue(checkpoint, 'agentCheckpoints.insert');
    const [row] = await this.db
      .insert(this.schema.agentCheckpoints)
      .values({
        sessionId: sanitizedCheckpoint.sessionId,
        agentId: sanitizedCheckpoint.agentId,
        checkpointVersion: sanitizedCheckpoint.checkpointVersion ?? 2,
        checkpointData: sanitizedCheckpoint.checkpointData,
        harnessState: sanitizedCheckpoint.harnessState ?? null,
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

  async getCheckpointSize(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({
        totalSize: sql<number>`coalesce(sum(pg_column_size(${this.schema.agentCheckpoints.checkpointData})), 0)`.as('total_size'),
      })
      .from(this.schema.agentCheckpoints)
      .where(eq(this.schema.agentCheckpoints.sessionId, sessionId));
    return Number(row?.totalSize ?? 0);
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
