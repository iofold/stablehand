import { eq, sql, gt, lt, and, desc, asc, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleDb } from './connection.js';
import * as pgSchema from './schema-pg.js';

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
type RunInsert = typeof pgSchema.agentRuns.$inferInsert;
type RunSelect = typeof pgSchema.agentRuns.$inferSelect;
type SuspendedRunInsert = typeof pgSchema.suspendedRuns.$inferInsert;
export type SuspendedRunRow = typeof pgSchema.suspendedRuns.$inferSelect;
type ScheduledEventInsert = typeof pgSchema.scheduledEvents.$inferInsert;
export type ScheduledEventRow = typeof pgSchema.scheduledEvents.$inferSelect;
type TriggerInsert = typeof pgSchema.eventTriggers.$inferInsert;
type TriggerSelect = typeof pgSchema.eventTriggers.$inferSelect;
type VersionInsert = typeof pgSchema.agentVersions.$inferInsert;
type VersionSelect = typeof pgSchema.agentVersions.$inferSelect;
type InterruptInsert = typeof pgSchema.pendingInterrupts.$inferInsert;
export type InterruptRow = typeof pgSchema.pendingInterrupts.$inferSelect;
type CallbackOutboxInsert = typeof pgSchema.callbackOutbox.$inferInsert;
export type CallbackOutboxRow = typeof pgSchema.callbackOutbox.$inferSelect;
type WebhookInsert = typeof pgSchema.webhooks.$inferInsert;
export type WebhookRow = typeof pgSchema.webhooks.$inferSelect;
export type SandboxSessionRow = typeof pgSchema.sandboxSessions.$inferSelect;

export interface Checkpoint {
  id: string;
  runId: string;
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

export class DatabaseRepository {
  private db: any;
  private schema = pgSchema;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  // ── Agents ──────────────────────────────────────────────

  async createAgent(data: AgentInsert): Promise<AgentSelect> {
    const [agent] = await this.db.insert(this.schema.agents).values(data).returning();
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
    const [updated] = await this.db
      .update(this.schema.agents)
      .set({ ...data, updatedAt: Date.now() })
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
    await tx.delete(this.schema.sandboxSessions).where(eq(this.schema.sandboxSessions.agentId, agentId));
      // Delete callback_outbox before agentRuns because callback_outbox.run_id references agent_runs.id
      await tx.delete(this.schema.callbackOutbox).where(eq(this.schema.callbackOutbox.agentId, agentId));
      // Delete agentRuns before conversations because agentRuns.conversationId references conversations.id
      await tx.delete(this.schema.agentRuns).where(eq(this.schema.agentRuns.agentId, agentId));
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
    const [conversation] = await this.db
      .insert(this.schema.conversations)
      .values({ agentId })
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
    });
  }

  async addMessage(data: MessageInsert): Promise<MessageSelect> {
    return this.db.transaction(async (tx: any) => {
      const rows = await tx.insert(this.schema.messages).values(data).returning();
      const message = rows[0];
      if (!message) throw new Error('Expected insert to return a row but got undefined');
      if (data.conversationId) {
        await tx.update(this.schema.conversations)
          .set({ updatedAt: Date.now() })
          .where(eq(this.schema.conversations.id, data.conversationId));
      }
      return message;
    });
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

  // ── Knowledge Items ─────────────────────────────────────

  async addKnowledgeItem(data: KnowledgeInsert): Promise<KnowledgeSelect> {
    const [item] = await this.db.insert(this.schema.knowledgeItems).values(data).returning();
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
    const [updated] = await this.db
      .update(this.schema.knowledgeItems)
      .set({ ...data, updatedAt: Date.now() })
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
    const [trace] = await this.db.insert(this.schema.executionTraces).values(data).returning();
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
    const [feedback] = await this.db.insert(this.schema.feedbackSignals).values(data).returning();
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

  // ── Agent Runs ────────────────────────────────────────

  async createRun(data: RunInsert): Promise<RunSelect> {
    const [run] = await this.db.insert(this.schema.agentRuns).values(data).returning();
    if (!run) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return run;
  }

  async updateRun(
    id: string,
    updates: Partial<Omit<RunInsert, 'id'>>,
  ): Promise<RunSelect | undefined> {
    const [updated] = await this.db
      .update(this.schema.agentRuns)
      .set(updates)
      .where(eq(this.schema.agentRuns.id, id))
      .returning();
    return updated;
  }

  async getRunsForAgent(agentId: string): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany({
      where: eq(this.schema.agentRuns.agentId, agentId),
    });
  }

  async getActiveRuns(): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany({
      where: inArray(this.schema.agentRuns.status, ['queued', 'running', 'paused', 'suspended']),
    });
  }

  async getAllRuns(): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany();
  }

  async getRun(id: string): Promise<RunSelect | undefined> {
    return this.db.query.agentRuns.findFirst({
      where: eq(this.schema.agentRuns.id, id),
    });
  }

  async getRunsByStatus(
    agentId: string,
    status: string,
  ): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany({
      where: (runs: any, { and }: any) =>
        and(eq(runs.agentId, agentId), eq(runs.status, status)),
    });
  }

  /**
   * Get all runs with a given status (across all agents).
   */
  async getRunsByStatusGlobal(status: string): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany({
      where: eq(this.schema.agentRuns.status, status),
    });
  }

  /**
   * Get active (non-terminal) runs for a specific agent.
   * Includes queued, running, and paused.
   */
  async getActiveRunsForAgent(agentId: string): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany({
      where: (runs: any, { and: a, inArray: ia }: any) =>
        a(eq(runs.agentId, agentId), ia(runs.status, ['queued', 'running', 'paused'])),
    });
  }

  async getRunsCount(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.schema.agentRuns)
      .where(eq(this.schema.agentRuns.agentId, agentId));
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
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    totalConversations: number;
    totalKnowledge: number;
    totalTraces: number;
    totalFeedback: number;
    avgRunDuration: number;
  }> {
    // Aggregate run stats in SQL instead of loading all rows
    const [runStats] = await this.db
      .select({
        totalRuns: sql<number>`count(*)`.as('total_runs'),
        completedRuns: sql<number>`sum(case when ${this.schema.agentRuns.status} = 'completed' then 1 else 0 end)`.as('completed_runs'),
        failedRuns: sql<number>`sum(case when ${this.schema.agentRuns.status} = 'error' then 1 else 0 end)`.as('failed_runs'),
        avgRunDuration: sql<number>`coalesce(avg(case when ${this.schema.agentRuns.completedAt} is not null and ${this.schema.agentRuns.startedAt} is not null then ${this.schema.agentRuns.completedAt} - ${this.schema.agentRuns.startedAt} end), 0)`.as('avg_run_duration'),
      })
      .from(this.schema.agentRuns)
      .where(eq(this.schema.agentRuns.agentId, agentId));

    const [conversationCount, knowledgeCount, traceStats, feedbackStats] = await Promise.all([
      this.getConversationCount(agentId),
      this.getKnowledgeCount(agentId),
      this.getTraceStats(agentId),
      this.getFeedbackStats(agentId),
    ]);

    return {
      totalRuns: runStats?.totalRuns ?? 0,
      completedRuns: runStats?.completedRuns ?? 0,
      failedRuns: runStats?.failedRuns ?? 0,
      totalConversations: conversationCount,
      totalKnowledge: knowledgeCount,
      totalTraces: traceStats.total,
      totalFeedback: feedbackStats.total,
      avgRunDuration: Math.round(runStats?.avgRunDuration ?? 0),
    };
  }

  // ── Event Store ──────────────────────────────────────────

  async saveEvent(type: string, agentId: string, payload: string): Promise<number> {
    const [row] = await this.db
      .insert(this.schema.eventStore)
      .values({ type, agentId, payload, createdAt: Date.now() })
      .returning({ seq: this.schema.eventStore.seq });
    if (!row) {
      throw new Error('Expected insert to return a row but got undefined');
    }
    return row.seq;
  }

  // ── Suspended Runs ──────────────────────────────────────

  async createSuspendedRun(data: SuspendedRunInsert): Promise<void> {
    await this.db.insert(this.schema.suspendedRuns).values(data);
  }

  async getSuspendedRunsByEventType(eventType: string): Promise<SuspendedRunRow[]> {
    return this.db.query.suspendedRuns.findMany({
      where: eq(this.schema.suspendedRuns.waitEventType, eventType),
    });
  }

  async deleteSuspendedRun(id: string): Promise<void> {
    await this.db.delete(this.schema.suspendedRuns).where(eq(this.schema.suspendedRuns.id, id));
  }

  async expireOldSuspendedRuns(beforeTime: number): Promise<number> {
    const deleted = await this.db
      .delete(this.schema.suspendedRuns)
      .where(
        and(
          isNotNull(this.schema.suspendedRuns.waitExpiresAt),
          lt(this.schema.suspendedRuns.waitExpiresAt, beforeTime),
        ),
      )
      .returning({ id: this.schema.suspendedRuns.id });
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
    await this.db.insert(this.schema.scheduledEvents).values({
      id: data.id,
      agentId: data.agentId,
      type: data.type,
      payload: data.payload,
      wakeAt: data.wakeAt,
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
    const [trigger] = await this.db
      .insert(this.schema.eventTriggers)
      .values(data)
      .onConflictDoUpdate({
        target: this.schema.eventTriggers.id,
        set: {
          eventType: data.eventType,
          selector: data.selector,
          taskTemplate: data.taskTemplate,
          enabled: data.enabled,
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

    const versionData = { agentId, version: newVersion, manifest, changedBy: changedBy ?? null, changeNote: changeNote ?? null, createdAt: Date.now() };
    await this.db.transaction(async (tx: any) => {
      await tx.update(this.schema.agents).set({ manifest, version: newVersion, updatedAt: Date.now() }).where(eq(this.schema.agents.id, agentId));
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
    const [row] = await this.db
      .insert(this.schema.pendingInterrupts)
      .values(data)
      .onConflictDoUpdate({
        target: this.schema.pendingInterrupts.id,
        set: {
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          args: data.args,
          timeoutMs: data.timeoutMs,
          expiresAt: data.expiresAt,
          status: data.status ?? 'pending',
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

  async resolveInterrupt(
    id: string,
    action: string,
    data?: unknown,
  ): Promise<InterruptRow | undefined> {
    const [updated] = await this.db
      .update(this.schema.pendingInterrupts)
      .set({
        status: 'resolved',
        resolvedAt: Date.now(),
        resolvedAction: action,
        resolvedData: data ?? null,
      })
      .where(eq(this.schema.pendingInterrupts.id, id))
      .returning();
    return updated;
  }

  async cleanupExpiredInterrupts(beforeTime: number): Promise<number> {
    const deleted = await this.db
      .delete(this.schema.pendingInterrupts)
      .where(
        and(
          eq(this.schema.pendingInterrupts.status, 'pending'),
          lt(this.schema.pendingInterrupts.expiresAt, beforeTime),
        ),
      )
      .returning({ id: this.schema.pendingInterrupts.id });
    return deleted.length;
  }

  // ── Callback Outbox ──────────────────────────────────────

  async enqueueCallback(data: CallbackOutboxInsert): Promise<CallbackOutboxRow> {
    const [row] = await this.db
      .insert(this.schema.callbackOutbox)
      .values(data)
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

    await this.db
      .update(this.schema.callbackOutbox)
      .set({
        attempts: newAttempts,
        lastAttemptAt: Date.now(),
        lastError: error,
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
    const [row] = await this.db.insert(this.schema.webhooks).values(data).returning();
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
  }): Promise<SandboxSessionRow> {
    const [row] = await this.db
      .insert(this.schema.sandboxSessions)
      .values({
        ...(session.id !== undefined ? { id: session.id } : {}),
        conversationId: session.conversationId,
        agentId: session.agentId,
        containerName: session.containerName ?? null,
        containerId: session.containerId ?? null,
        status: session.status ?? 'ACTIVE',
        harnessName: session.harnessName,
        checkpointRef: session.checkpointRef ?? null,
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
    extra?: { containerName?: string; containerId?: string; checkpointRef?: string },
  ): Promise<void> {
    await this.db
      .update(this.schema.sandboxSessions)
      .set({
        status,
        updatedAt: Date.now(),
        lastActivityAt: Date.now(),
        ...(extra?.containerName !== undefined ? { containerName: extra.containerName } : {}),
        ...(extra?.containerId !== undefined ? { containerId: extra.containerId } : {}),
        ...(extra?.checkpointRef !== undefined ? { checkpointRef: extra.checkpointRef } : {}),
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
      .where(inArray(this.schema.sandboxSessions.status, ['ACTIVE', 'FROZEN']));
  }

  async getSandboxSessionsByAgent(agentId: string): Promise<SandboxSessionRow[]> {
    return this.db
      .select()
      .from(this.schema.sandboxSessions)
      .where(eq(this.schema.sandboxSessions.agentId, agentId));
  }

  async createCheckpoint(checkpoint: {
    runId: string;
    agentId: string;
    version?: number;
    checkpointData: Record<string, unknown>;
    workspaceRef?: string;
    suspendReason?: string;
  }): Promise<{ id: string }> {
    const existingSession = await this.getSandboxSession(checkpoint.runId);
    if (!existingSession) {
      const run = await this.db.query.agentRuns.findFirst({
        where: eq(this.schema.agentRuns.id, checkpoint.runId),
      });
      if (!run?.conversationId) {
        throw new Error(`Cannot create checkpoint without sandbox session or run conversation for ${checkpoint.runId}`);
      }

      const harnessName = typeof checkpoint.checkpointData.harnessName === 'string'
        ? checkpoint.checkpointData.harnessName
        : 'unknown';

      await this.createSandboxSession({
        id: checkpoint.runId,
        conversationId: run.conversationId,
        agentId: checkpoint.agentId,
        harnessName,
        status: 'FROZEN',
      });
    }

    return this.createCheckpointV2({
      sessionId: checkpoint.runId,
      agentId: checkpoint.agentId,
      checkpointVersion: checkpoint.version,
      checkpointData: checkpoint.checkpointData,
      workspaceRef: checkpoint.workspaceRef,
      suspendReason: checkpoint.suspendReason,
    });
  }

  async getCheckpoint(runId: string): Promise<Checkpoint | null> {
    const row = await this.getCheckpointV2(runId);
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      runId: row.sessionId,
      agentId: row.agentId,
      version: row.checkpointVersion,
      checkpointData: row.checkpointData,
      workspaceRef: row.workspaceRef,
      suspendReason: row.suspendReason,
      createdAt: new Date(row.createdAt),
    };
  }

  async deleteCheckpoints(runId: string): Promise<number> {
    return this.deleteCheckpointsForSession(runId);
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
    const [row] = await this.db
      .insert(this.schema.agentCheckpoints)
      .values({
        sessionId: checkpoint.sessionId,
        agentId: checkpoint.agentId,
        checkpointVersion: checkpoint.checkpointVersion ?? 2,
        checkpointData: checkpoint.checkpointData,
        harnessState: checkpoint.harnessState ?? null,
        workspaceRef: checkpoint.workspaceRef ?? null,
        suspendReason: checkpoint.suspendReason ?? null,
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
}
