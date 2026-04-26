import type postgres from 'postgres';

export const MIGRATION_ADVISORY_LOCK_ID = 424242;
export const CURRENT_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION_TABLE = 'ctxmill_schema_version';

async function assertSchemaBaseline(sql: postgres.Sql): Promise<void> {
  const [versionTable] = await sql`
    SELECT to_regclass('public.ctxmill_schema_version') AS table_name
  `;

  if (versionTable?.table_name) {
    const [versionRow] = await sql`
      SELECT version FROM ctxmill_schema_version WHERE id = 'baseline'
    `;
    const version = Number(versionRow?.version);
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported ctxmill schema version ${Number.isFinite(version) ? version : 'unknown'}; expected ${CURRENT_SCHEMA_VERSION}. ` +
        'Pre-release schema migrations only support the current baseline.',
      );
    }
    return;
  }

  const existingTables = await sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> ${SCHEMA_VERSION_TABLE}
    ORDER BY tablename
  `;

  if (existingTables.length > 0) {
    const names = existingTables.map((row) => row.tablename).join(', ');
    throw new Error(
      `Refusing to initialize ctxmill schema: found existing unversioned public tables (${names}). ` +
      'Start with an empty database or restore from a versioned ctxmill baseline.',
    );
  }
}

async function initializeSchemaBaseline(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ctxmill_schema_version (
      id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL,
      baseline TEXT NOT NULL,
      initialized_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    INSERT INTO ctxmill_schema_version (id, version, baseline)
    VALUES ('baseline', ${CURRENT_SCHEMA_VERSION}, 'pre-release')
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Single-pass schema creation for a fresh database.
 *
 * Tables are ordered by foreign-key dependency (parents before children).
 * No incremental migration logic — this file assumes a clean database.
 *
 * Source of truth: schema-pg.ts (Drizzle ORM definitions) plus the
 * `secrets` table used via raw SQL in secrets/postgres-provider.ts.
 */
export async function runMigrations(sql: postgres.Sql): Promise<void> {
  await sql`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
  try {
    await assertSchemaBaseline(sql);
    await initializeSchemaBaseline(sql);

    // ── Extensions ──────────────────────────────────────────────────────
    await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;

    // ── 1. agents (root table) ─────────────────────────────────────────
    await sql`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      harness TEXT NOT NULL,
      harness_config TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      tools JSONB NOT NULL,
      description TEXT,
      workspace_dir TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      manifest JSONB,
      version BIGINT DEFAULT 1,
      metadata JSONB,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  // ── 2. conversations (→ agents) ────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  // ── 3. messages (→ conversations) ──────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      agent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls JSONB,
      parts JSONB,
      created_at BIGINT NOT NULL
    )
  `;

  // ── 4. knowledge_items ─────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      source TEXT NOT NULL,
      effectiveness DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  // ── 5. execution_traces ────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS execution_traces (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_description TEXT NOT NULL,
      steps JSONB NOT NULL,
      started_at BIGINT NOT NULL,
      completed_at BIGINT,
      outcome TEXT
    )
  `;

  // ── 6. sandbox_sessions (→ conversations, agents) ──────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS sandbox_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      container_name TEXT,
      container_id TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      harness_name TEXT NOT NULL,
      checkpoint_ref TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_activity_at BIGINT NOT NULL,
      paused_at BIGINT,
      paused_reason TEXT
    )
  `;

  // ── 7. turns (→ sandbox_sessions, agents, conversations) ───────────
  await sql`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT REFERENCES sandbox_sessions(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      conversation_id TEXT REFERENCES conversations(id),
      mode TEXT NOT NULL DEFAULT 'interactive',
      task_description TEXT,
      started_at BIGINT NOT NULL,
      completed_at BIGINT,
      error TEXT
    )
  `;

  // ── 8. event_store ─────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS event_store (
      seq SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `;

  // ── 9. suspended_sessions ──────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS suspended_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      agent_session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      wait_event_type TEXT NOT NULL,
      wait_selector TEXT NOT NULL,
      wait_expires_at BIGINT,
      snapshot_state TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `;

  // ── 10. scheduled_events ───────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS scheduled_events (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      wake_at BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at BIGINT,
      claim_expires_at BIGINT,
      last_error TEXT,
      created_at BIGINT NOT NULL
    )
  `;

  // ── 11. event_triggers (→ agents) ──────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS event_triggers (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      selector JSONB,
      task_template TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TEXT NOT NULL
    )
  `;

  // ── 12. agent_versions (→ agents) ──────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version BIGINT NOT NULL,
      manifest JSONB NOT NULL,
      changed_by TEXT,
      change_note TEXT,
      created_at BIGINT NOT NULL
    )
  `;

  // ── 13. pending_interrupts (→ turns, agents) ───────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS pending_interrupts (
      id TEXT PRIMARY KEY,
      agent_session_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      session_id TEXT,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args JSONB NOT NULL DEFAULT '{}',
      timeout_ms INTEGER NOT NULL DEFAULT 300000,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      resolved_at BIGINT,
      resolved_action TEXT,
      resolved_data JSONB,
      status TEXT NOT NULL DEFAULT 'pending'
    )
  `;

  // ── 14. interrupt_resume_attempts (→ pending_interrupts, turns, agents) ──
  await sql`
    CREATE TABLE IF NOT EXISTS interrupt_resume_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      interrupt_id TEXT NOT NULL REFERENCES pending_interrupts(id) ON DELETE CASCADE,
      agent_session_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      session_id TEXT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      completed_at BIGINT
    )
  `;

  // ── 15. feedback_signals ───────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS feedback_signals (
      id TEXT PRIMARY KEY NOT NULL,
      trace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      value JSONB NOT NULL,
      created_at BIGINT NOT NULL
    )
  `;

  // ── 15. agent_checkpoints (→ sandbox_sessions) ─────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS agent_checkpoints (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES sandbox_sessions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      checkpoint_version INTEGER NOT NULL DEFAULT 2,
      checkpoint_data JSONB NOT NULL,
      harness_state JSONB,
      workspace_ref TEXT,
      suspend_reason TEXT,
      created_at BIGINT NOT NULL
    )
  `;

  // ── 16. callback_outbox (→ agents, turns) ──────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS callback_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      session_id TEXT REFERENCES turns(id),
      callback_url TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at BIGINT NOT NULL,
      claimed_at BIGINT,
      claim_expires_at BIGINT,
      last_attempt_at BIGINT,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      delivered_at BIGINT
    )
  `;

  // ── 17. webhooks (→ agents) ────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      events JSONB NOT NULL DEFAULT '[]',
      secret TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  // ── 18. system_settings ────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // ── 19. artifacts (→ agents, turns, conversations) ─────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      storage_key TEXT NOT NULL,
      bucket TEXT NOT NULL,
      metadata JSONB,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  // ── 20. secrets (raw SQL usage — not in Drizzle schema) ────────────
  // Used by secrets/postgres-provider.ts via raw postgres.js queries
  await sql`
    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      tool_id TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      iv TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(agent_id, tool_id, key)
    )
  `;

  // ── 21. tool_request_dedup ──────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS tool_request_dedup (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      result TEXT,
      error TEXT,
      created_at BIGINT NOT NULL,
      completed_at BIGINT
    )
  `;

  // ── Indexes ────────────────────────────────────────────────────────

  // conversations
  await sql`CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated ON conversations(agent_id, updated_at)`;

  // messages
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`;

  // knowledge_items
  await sql`CREATE INDEX IF NOT EXISTS idx_knowledge_items_agent_category ON knowledge_items(agent_id, category)`;

  // execution_traces
  await sql`CREATE INDEX IF NOT EXISTS idx_execution_traces_agent_started ON execution_traces(agent_id, started_at)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_traces_session_agent ON execution_traces(session_id, agent_id)`;

  // sandbox_sessions
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_conversation ON sandbox_sessions(conversation_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_agent ON sandbox_sessions(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_status ON sandbox_sessions(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_last_activity ON sandbox_sessions(last_activity_at)`;

  // turns
  await sql`CREATE INDEX IF NOT EXISTS idx_turns_agent_started ON turns(agent_id, started_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)`;

  // event_store
  await sql`CREATE INDEX IF NOT EXISTS idx_event_store_agent_seq ON event_store(agent_id, seq)`;

  // suspended_sessions
  await sql`CREATE INDEX IF NOT EXISTS idx_suspended_sessions_event_type ON suspended_sessions(wait_event_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_suspended_sessions_agent ON suspended_sessions(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_suspended_sessions_expires ON suspended_sessions(wait_expires_at)`;

  // scheduled_events
  await sql`CREATE INDEX IF NOT EXISTS idx_scheduled_events_wake ON scheduled_events(status, wake_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_scheduled_events_claim_expires ON scheduled_events(status, claim_expires_at)`;

  // event_triggers
  await sql`CREATE INDEX IF NOT EXISTS idx_event_triggers_agent ON event_triggers(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_triggers_event_type ON event_triggers(event_type)`;

  // agent_versions
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_version ON agent_versions(agent_id, version)`;

  // pending_interrupts
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupts_agent_session ON pending_interrupts(agent_session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupts_agent ON pending_interrupts(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupts_status ON pending_interrupts(status, expires_at)`;

  // interrupt_resume_attempts
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_interrupt_resume_attempts_interrupt ON interrupt_resume_attempts(interrupt_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupt_resume_attempts_agent_status ON interrupt_resume_attempts(agent_id, status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupt_resume_attempts_session ON interrupt_resume_attempts(session_id)`;

  // feedback_signals
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_signals_agent_created ON feedback_signals(agent_id, created_at)`;

  // agent_checkpoints
  await sql`CREATE INDEX IF NOT EXISTS idx_checkpoints_session_id ON agent_checkpoints(session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_id ON agent_checkpoints(agent_id)`;

  // callback_outbox
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_status ON callback_outbox(status, next_attempt_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_claim_expires ON callback_outbox(status, claim_expires_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_agent ON callback_outbox(agent_id)`;

  // webhooks
  await sql`CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id)`;

  // artifacts
  await sql`CREATE INDEX IF NOT EXISTS idx_artifacts_agent_created ON artifacts(agent_id, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status)`;

  // tool_request_dedup
  await sql`CREATE INDEX IF NOT EXISTS idx_tool_dedup_created ON tool_request_dedup(created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tool_dedup_status ON tool_request_dedup(status)`;
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
  }
}
