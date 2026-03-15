import { eq, sql, gt, lt, and, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleDb, DbDialect } from './connection.js';
import * as sqliteSchema from './schema-sqlite.js';
import * as pgSchema from './schema-pg.js';

// Use SQLite schema for type inference (both schemas have identical shapes)
type schema = typeof sqliteSchema;
type AgentInsert = typeof sqliteSchema.agents.$inferInsert;
type AgentSelect = typeof sqliteSchema.agents.$inferSelect;
type ConversationSelect = typeof sqliteSchema.conversations.$inferSelect;
type MessageInsert = typeof sqliteSchema.messages.$inferInsert;
type MessageSelect = typeof sqliteSchema.messages.$inferSelect;
type KnowledgeInsert = typeof sqliteSchema.knowledgeItems.$inferInsert;
type KnowledgeSelect = typeof sqliteSchema.knowledgeItems.$inferSelect;
type TraceInsert = typeof sqliteSchema.executionTraces.$inferInsert;
type TraceSelect = typeof sqliteSchema.executionTraces.$inferSelect;
type FeedbackInsert = typeof sqliteSchema.feedbackSignals.$inferInsert;
type FeedbackSelect = typeof sqliteSchema.feedbackSignals.$inferSelect;
type RunInsert = typeof sqliteSchema.agentRuns.$inferInsert;
type RunSelect = typeof sqliteSchema.agentRuns.$inferSelect;
type SuspendedRunInsert = typeof sqliteSchema.suspendedRuns.$inferInsert;
export type SuspendedRunRow = typeof sqliteSchema.suspendedRuns.$inferSelect;
type ScheduledEventInsert = typeof sqliteSchema.scheduledEvents.$inferInsert;
export type ScheduledEventRow = typeof sqliteSchema.scheduledEvents.$inferSelect;
type TriggerInsert = typeof sqliteSchema.eventTriggers.$inferInsert;
type TriggerSelect = typeof sqliteSchema.eventTriggers.$inferSelect;
type VersionInsert = typeof sqliteSchema.agentVersions.$inferInsert;
type VersionSelect = typeof sqliteSchema.agentVersions.$inferSelect;

export class DatabaseRepository {
  // Typed as `any` internally because DrizzleDb is a union of SQLite | PG
  // and TypeScript cannot call methods whose signatures differ across union members.
  // All public methods are fully typed via their return signatures.
  private db: any;
  private dialect: DbDialect;
  private schema: any;

  constructor(db: DrizzleDb, dialect: DbDialect = 'sqlite') {
    this.db = db;
    this.dialect = dialect;
    // Use the schema matching the dialect so Drizzle maps columns correctly
    this.schema = dialect === 'postgres' ? pgSchema : sqliteSchema;
  }

  /**
   * Run a transaction that works with both SQLite (sync) and PostgreSQL (async).
   * SQLite's better-sqlite3 adapter rejects async callbacks, so we use a sync
   * wrapper for SQLite and an async one for PG.
   */
  private async runTransaction<T>(fn: (tx: any) => T | Promise<T>): Promise<T> {
    if (this.dialect === 'postgres') {
      return this.db.transaction(async (tx: any) => fn(tx));
    }
    // SQLite: callback must be synchronous
    return this.db.transaction((tx: any) => fn(tx));
  }

  private jsonArrayLength(col: any) {
    return this.dialect === 'postgres'
      ? sql`jsonb_array_length(${col})`
      : sql`json_array_length(${col})`;
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
   * Order: messages → conversations → runs → traces → feedback → knowledge → events → agent
   */
  async deleteAgentCascade(agentId: string): Promise<void> {
    if (this.dialect === 'postgres') {
      await this.db.transaction(async (tx: any) => {
        const conversations = await tx
          .select({ id: this.schema.conversations.id })
          .from(this.schema.conversations)
          .where(eq(this.schema.conversations.agentId, agentId));
        const conversationIds = conversations.map((c: any) => c.id);
        if (conversationIds.length > 0) {
          await tx.delete(this.schema.messages).where(inArray(this.schema.messages.conversationId, conversationIds));
        }
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
    } else {
      this.db.transaction((tx: any) => {
        const conversations = tx
          .select({ id: this.schema.conversations.id })
          .from(this.schema.conversations)
          .where(eq(this.schema.conversations.agentId, agentId))
          .all();
        const conversationIds = conversations.map((c: any) => c.id);
        if (conversationIds.length > 0) {
          tx.delete(this.schema.messages).where(inArray(this.schema.messages.conversationId, conversationIds)).run();
        }
        // Delete agentRuns before conversations because agentRuns.conversationId references conversations.id
        tx.delete(this.schema.agentRuns).where(eq(this.schema.agentRuns.agentId, agentId)).run();
        tx.delete(this.schema.conversations).where(eq(this.schema.conversations.agentId, agentId)).run();
        tx.delete(this.schema.executionTraces).where(eq(this.schema.executionTraces.agentId, agentId)).run();
        tx.delete(this.schema.feedbackSignals).where(eq(this.schema.feedbackSignals.agentId, agentId)).run();
        tx.delete(this.schema.knowledgeItems).where(eq(this.schema.knowledgeItems.agentId, agentId)).run();
        tx.delete(this.schema.eventStore).where(eq(this.schema.eventStore.agentId, agentId)).run();
        tx.delete(this.schema.eventTriggers).where(eq(this.schema.eventTriggers.agentId, agentId)).run();
        tx.delete(this.schema.agents).where(eq(this.schema.agents.id, agentId)).run();
      });
    }
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
    if (this.dialect === 'postgres') {
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
    return this.db.transaction((tx: any) => {
      const rows = tx.insert(this.schema.messages).values(data).returning().all();
      const message = rows[0];
      if (!message) throw new Error('Expected insert to return a row but got undefined');
      if (data.conversationId) {
        tx.update(this.schema.conversations)
          .set({ updatedAt: Date.now() })
          .where(eq(this.schema.conversations.id, data.conversationId))
          .run();
      }
      return message;
    });
  }

  async getMessages(conversationId: string): Promise<MessageSelect[]> {
    return this.db.query.messages.findMany({
      where: eq(this.schema.messages.conversationId, conversationId),
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
      where: inArray(this.schema.agentRuns.status, ['queued', 'running']),
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
        avgSteps: sql<number>`coalesce(avg(${this.jsonArrayLength(this.schema.executionTraces.steps)}), 0)`.as('avg_steps'),
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
      byType[row.type] = row.count;
      total += row.count;
    }

    // Recent count in SQL
    const [recentRow] = await this.db
      .select({
        recentCount: sql<number>`count(*)`.as('recent_count'),
      })
      .from(this.schema.feedbackSignals)
      .where(sql`${this.schema.feedbackSignals.agentId} = ${agentId} AND ${this.schema.feedbackSignals.createdAt} >= ${oneDayAgo}`);

    return { total, byType, recentCount: recentRow?.recentCount ?? 0 };
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
      byType[row.type] = row.count;
      total += row.count;
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

    const recentRate = Math.round(((rateRow?.count ?? 0) / 5) * 10) / 10; // events per minute

    return {
      total,
      byType,
      topAgents: agentRows,
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
    if (this.dialect === 'postgres') {
      await this.db.transaction(async (tx: any) => {
        await tx.update(this.schema.agents).set({ manifest, version: newVersion, updatedAt: Date.now() }).where(eq(this.schema.agents.id, agentId));
        await tx.insert(this.schema.agentVersions).values(versionData);
      });
    } else {
      this.db.transaction((tx: any) => {
        tx.update(this.schema.agents).set({ manifest, version: newVersion, updatedAt: Date.now() }).where(eq(this.schema.agents.id, agentId)).run();
        tx.insert(this.schema.agentVersions).values(versionData).run();
      });
    }
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
}
