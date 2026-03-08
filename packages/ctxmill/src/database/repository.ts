import { eq, sql, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

type DB = BetterSQLite3Database<typeof schema>;

type AgentInsert = typeof schema.agents.$inferInsert;
type AgentSelect = typeof schema.agents.$inferSelect;
type ConversationSelect = typeof schema.conversations.$inferSelect;
type MessageInsert = typeof schema.messages.$inferInsert;
type MessageSelect = typeof schema.messages.$inferSelect;
type KnowledgeInsert = typeof schema.knowledgeItems.$inferInsert;
type KnowledgeSelect = typeof schema.knowledgeItems.$inferSelect;
type TraceInsert = typeof schema.executionTraces.$inferInsert;
type TraceSelect = typeof schema.executionTraces.$inferSelect;
type FeedbackInsert = typeof schema.feedbackSignals.$inferInsert;
type FeedbackSelect = typeof schema.feedbackSignals.$inferSelect;
type RunInsert = typeof schema.agentRuns.$inferInsert;
type RunSelect = typeof schema.agentRuns.$inferSelect;

export class DatabaseRepository {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  // ── Agents ──────────────────────────────────────────────

  async createAgent(data: AgentInsert): Promise<AgentSelect> {
    const [agent] = await this.db.insert(schema.agents).values(data).returning();
    return agent!;
  }

  async getAgent(id: string): Promise<AgentSelect | undefined> {
    return this.db.query.agents.findFirst({
      where: eq(schema.agents.id, id),
    });
  }

  async listAgents(): Promise<AgentSelect[]> {
    return this.db.query.agents.findMany();
  }

  async updateAgent(id: string, data: Partial<Omit<AgentInsert, 'id'>>): Promise<AgentSelect | undefined> {
    const [updated] = await this.db
      .update(schema.agents)
      .set({ ...data, updatedAt: Date.now() })
      .where(eq(schema.agents.id, id))
      .returning();
    return updated;
  }

  async deleteAgent(id: string): Promise<void> {
    await this.db.delete(schema.agents).where(eq(schema.agents.id, id));
  }

  async updateAgentStatus(id: string, status: string): Promise<AgentSelect | undefined> {
    return this.updateAgent(id, { status });
  }

  // ── Conversations ───────────────────────────────────────

  async createConversation(agentId: string): Promise<ConversationSelect> {
    const [conversation] = await this.db
      .insert(schema.conversations)
      .values({ agentId })
      .returning();
    return conversation!;
  }

  async getConversation(id: string): Promise<ConversationSelect | undefined> {
    return this.db.query.conversations.findFirst({
      where: eq(schema.conversations.id, id),
    });
  }

  async getConversationsForAgent(agentId: string): Promise<ConversationSelect[]> {
    return this.db.query.conversations.findMany({
      where: eq(schema.conversations.agentId, agentId),
    });
  }

  async addMessage(data: MessageInsert): Promise<MessageSelect> {
    const [message] = await this.db.insert(schema.messages).values(data).returning();
    // Update conversation's updatedAt
    if (data.conversationId) {
      await this.db
        .update(schema.conversations)
        .set({ updatedAt: Date.now() })
        .where(eq(schema.conversations.id, data.conversationId));
    }
    return message!;
  }

  async getMessages(conversationId: string): Promise<MessageSelect[]> {
    return this.db.query.messages.findMany({
      where: eq(schema.messages.conversationId, conversationId),
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
        conversationId: schema.conversations.id,
        startedAt: schema.conversations.createdAt,
        messageCount: sql<number>`count(${schema.messages.id})`.as('message_count'),
        lastMessageAt: sql<number | null>`max(${schema.messages.createdAt})`.as('last_message_at'),
      })
      .from(schema.conversations)
      .leftJoin(
        schema.messages,
        eq(schema.conversations.id, schema.messages.conversationId),
      )
      .where(eq(schema.conversations.agentId, agentId))
      .groupBy(schema.conversations.id);

    return rows;
  }

  // ── Knowledge Items ─────────────────────────────────────

  async addKnowledgeItem(data: KnowledgeInsert): Promise<KnowledgeSelect> {
    const [item] = await this.db.insert(schema.knowledgeItems).values(data).returning();
    return item!;
  }

  async getKnowledgeItems(agentId: string, category?: string): Promise<KnowledgeSelect[]> {
    if (category) {
      return this.db.query.knowledgeItems.findMany({
        where: (ki, { and }) =>
          and(eq(ki.agentId, agentId), eq(ki.category, category)),
      });
    }
    return this.db.query.knowledgeItems.findMany({
      where: eq(schema.knowledgeItems.agentId, agentId),
    });
  }

  async updateKnowledgeItem(
    id: string,
    data: Partial<Omit<KnowledgeInsert, 'id'>>,
  ): Promise<KnowledgeSelect | undefined> {
    const [updated] = await this.db
      .update(schema.knowledgeItems)
      .set({ ...data, updatedAt: Date.now() })
      .where(eq(schema.knowledgeItems.id, id))
      .returning();
    return updated;
  }

  async removeKnowledgeItem(id: string): Promise<void> {
    await this.db.delete(schema.knowledgeItems).where(eq(schema.knowledgeItems.id, id));
  }

  async getKnowledgeForAgent(agentId: string): Promise<KnowledgeSelect[]> {
    return this.db.query.knowledgeItems.findMany({
      where: eq(schema.knowledgeItems.agentId, agentId),
    });
  }

  // ── Execution Traces ────────────────────────────────────

  async saveTrace(data: TraceInsert): Promise<TraceSelect> {
    const [trace] = await this.db.insert(schema.executionTraces).values(data).returning();
    return trace!;
  }

  async getTraces(agentId: string): Promise<TraceSelect[]> {
    return this.db.query.executionTraces.findMany({
      where: eq(schema.executionTraces.agentId, agentId),
    });
  }

  async getRecentTraces(agentId: string, limit = 20): Promise<TraceSelect[]> {
    return this.db
      .select()
      .from(schema.executionTraces)
      .where(eq(schema.executionTraces.agentId, agentId))
      .orderBy(sql`${schema.executionTraces.startedAt} DESC`)
      .limit(limit);
  }

  // ── Feedback Signals ────────────────────────────────────

  async saveFeedback(data: FeedbackInsert): Promise<FeedbackSelect> {
    const [feedback] = await this.db.insert(schema.feedbackSignals).values(data).returning();
    return feedback!;
  }

  async getFeedbackForTrace(traceId: string): Promise<FeedbackSelect[]> {
    return this.db.query.feedbackSignals.findMany({
      where: eq(schema.feedbackSignals.traceId, traceId),
    });
  }

  // ── Agent Runs ────────────────────────────────────────

  async createRun(data: RunInsert): Promise<RunSelect> {
    const [run] = await this.db.insert(schema.agentRuns).values(data).returning();
    return run!;
  }

  async updateRun(
    id: string,
    updates: Partial<Omit<RunInsert, 'id'>>,
  ): Promise<RunSelect | undefined> {
    const [updated] = await this.db
      .update(schema.agentRuns)
      .set(updates)
      .where(eq(schema.agentRuns.id, id))
      .returning();
    return updated;
  }

  async getRunsForAgent(agentId: string): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.agentId, agentId),
    });
  }

  async getActiveRuns(): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany({
      where: inArray(schema.agentRuns.status, ['queued', 'running']),
    });
  }

  async getAllRuns(): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany();
  }

  async getRun(id: string): Promise<RunSelect | undefined> {
    return this.db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, id),
    });
  }

  async getRunsByStatus(
    agentId: string,
    status: string,
  ): Promise<RunSelect[]> {
    return this.db.query.agentRuns.findMany({
      where: (runs, { and }) =>
        and(eq(runs.agentId, agentId), eq(runs.status, status)),
    });
  }

  async getRunsCount(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agentId, agentId));
    return rows[0]?.count ?? 0;
  }

  // ── Knowledge Stats ────────────────────────────────────

  async getKnowledgeCount(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.agentId, agentId));
    return rows[0]?.count ?? 0;
  }

  async getKnowledgeItem(id: string): Promise<KnowledgeSelect | undefined> {
    return this.db.query.knowledgeItems.findFirst({
      where: eq(schema.knowledgeItems.id, id),
    });
  }

  async getKnowledgeCategories(agentId: string): Promise<{ category: string; count: number }[]> {
    return this.db
      .select({
        category: schema.knowledgeItems.category,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.agentId, agentId))
      .groupBy(schema.knowledgeItems.category);
  }

  // ── Trace Analysis ─────────────────────────────────────

  async getTraceWithFeedback(traceId: string): Promise<{
    trace: TraceSelect | undefined;
    feedback: FeedbackSelect[];
  }> {
    const trace = await this.db.query.executionTraces.findFirst({
      where: eq(schema.executionTraces.id, traceId),
    });
    const feedback = await this.db.query.feedbackSignals.findMany({
      where: eq(schema.feedbackSignals.traceId, traceId),
    });
    return { trace, feedback };
  }

  async getTracesForAgent(
    agentId: string,
    options: { limit?: number; offset?: number; outcome?: string } = {},
  ): Promise<{ traces: TraceSelect[]; total: number }> {
    const { limit = 20, offset = 0, outcome } = options;

    const whereClause = outcome
      ? sql`${schema.executionTraces.agentId} = ${agentId} AND ${schema.executionTraces.outcome} = ${outcome}`
      : eq(schema.executionTraces.agentId, agentId);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.executionTraces)
      .where(whereClause);

    const traces = await this.db
      .select()
      .from(schema.executionTraces)
      .where(whereClause)
      .orderBy(sql`${schema.executionTraces.startedAt} DESC`)
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
        outcome: sql<string>`coalesce(${schema.executionTraces.outcome}, 'unknown')`.as('outcome'),
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.executionTraces)
      .where(eq(schema.executionTraces.agentId, agentId))
      .groupBy(sql`coalesce(${schema.executionTraces.outcome}, 'unknown')`);

    const byOutcome: Record<string, number> = {};
    let total = 0;
    for (const row of outcomeRows) {
      byOutcome[row.outcome] = row.count;
      total += row.count;
    }

    // Avg steps via JSON array length + recent count in a single query
    const [statsRow] = await this.db
      .select({
        avgSteps: sql<number>`coalesce(avg(json_array_length(${schema.executionTraces.steps})), 0)`.as('avg_steps'),
        recentCount: sql<number>`sum(case when ${schema.executionTraces.startedAt} >= ${oneDayAgo} then 1 else 0 end)`.as('recent_count'),
      })
      .from(schema.executionTraces)
      .where(eq(schema.executionTraces.agentId, agentId));

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
      where: eq(schema.feedbackSignals.agentId, agentId),
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
        type: schema.feedbackSignals.type,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.feedbackSignals)
      .where(eq(schema.feedbackSignals.agentId, agentId))
      .groupBy(schema.feedbackSignals.type);

    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of typeRows) {
      byType[row.type] = row.count;
      total += row.count;
    }

    // Recent count in SQL
    const [recentRow] = await this.db
      .select({
        recentCount: sql<number>`count(*)`.as('recent_count'),
      })
      .from(schema.feedbackSignals)
      .where(sql`${schema.feedbackSignals.agentId} = ${agentId} AND ${schema.feedbackSignals.createdAt} >= ${oneDayAgo}`);

    return { total, byType, recentCount: recentRow?.recentCount ?? 0 };
  }

  // ── Conversation Analysis ──────────────────────────────

  async getConversationCount(agentId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.conversations)
      .where(eq(schema.conversations.agentId, agentId));
    return rows[0]?.count ?? 0;
  }

  async getMessageCount(conversationId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
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
        completedRuns: sql<number>`sum(case when ${schema.agentRuns.status} = 'completed' then 1 else 0 end)`.as('completed_runs'),
        failedRuns: sql<number>`sum(case when ${schema.agentRuns.status} = 'error' then 1 else 0 end)`.as('failed_runs'),
        avgRunDuration: sql<number>`coalesce(avg(case when ${schema.agentRuns.completedAt} is not null and ${schema.agentRuns.startedAt} is not null then ${schema.agentRuns.completedAt} - ${schema.agentRuns.startedAt} end), 0)`.as('avg_run_duration'),
      })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agentId, agentId));

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
}
