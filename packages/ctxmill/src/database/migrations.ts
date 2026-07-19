import type postgres from 'postgres';
import {
  canonicalizePersistedEventContracts,
  TEXT_MESSAGE_END_CONTRACT_MIGRATION_ID,
  TEXT_MESSAGE_END_CONTRACT_MIGRATION_VERSION,
} from './canonical-event-data-migration.js';

export {
  TEXT_MESSAGE_END_CONTRACT_MIGRATION_ID,
  TEXT_MESSAGE_END_CONTRACT_MIGRATION_VERSION,
};

export const MIGRATION_ADVISORY_LOCK_ID = 424242;
export const CURRENT_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION_TABLE = 'ctxmill_schema_version';

async function renameColumn(
  sql: postgres.Sql,
  tableName: string,
  previousName: string,
  canonicalName: string,
): Promise<void> {
  const identifiers = [tableName, previousName, canonicalName];
  if (identifiers.some((identifier) => !/^[a-z][a-z0-9_]*$/.test(identifier))) {
    throw new Error(`Invalid schema identifier in column rename: ${identifiers.join(', ')}`);
  }

  const [previous] = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND column_name = ${previousName}
  `;
  if (!previous) return;

  const [canonical] = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND column_name = ${canonicalName}
  `;
  if (canonical) {
    throw new Error(
      `Cannot canonicalize ${tableName}: both ${previousName} and ${canonicalName} exist`,
    );
  }

  await sql.unsafe(
    `ALTER TABLE "${tableName}" RENAME COLUMN "${previousName}" TO "${canonicalName}"`,
  );
}

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

  // ── 2. agent_workspace_state (→ agents) ────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS agent_workspace_state (
      agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      revision BIGINT NOT NULL DEFAULT 1,
      sha256 TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      total_bytes BIGINT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `;

  // ── 3. conversations (→ agents) ────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      tags JSONB,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  // Additive budget-attribution tags (tag-based budget policies proposal).
  await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tags JSONB`;

  // ── 3. messages (→ conversations) ──────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      agent_id TEXT,
      turn_id TEXT,
      message_seq BIGINT,
      message_revision BIGINT NOT NULL DEFAULT 0,
      published_revision BIGINT NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls JSONB,
      parts JSONB,
      created_at BIGINT NOT NULL
    )
  `;
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_id TEXT`;
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_seq BIGINT`;
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_revision BIGINT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS published_revision BIGINT NOT NULL DEFAULT 0`;

  // ── 4. sandbox_sessions (→ conversations, agents) ──────────────────
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
      restore_attempts INTEGER NOT NULL DEFAULT 0,
      last_restore_error TEXT
    )
  `;

  // Idempotent column additions for pre-existing schemas (ADR 013 retry policy).
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS restore_attempts INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS last_restore_error TEXT`;

  // ── 7. turns (→ sandbox_sessions, agents, conversations) ───────────
  await sql`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY NOT NULL,
      sandbox_session_id TEXT REFERENCES sandbox_sessions(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      conversation_id TEXT REFERENCES conversations(id),
      mode TEXT NOT NULL DEFAULT 'interactive',
      task_description TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      user_message_id TEXT,
      started_at BIGINT NOT NULL,
      completed_at BIGINT,
      error TEXT,
      input_tokens BIGINT,
      output_tokens BIGINT,
      total_tokens BIGINT,
      cost_usd DOUBLE PRECISION,
      next_message_seq BIGINT NOT NULL DEFAULT 0,
      terminal_published_seq BIGINT,
      tags JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `;
  await renameColumn(sql, 'turns', 'session_id', 'sandbox_session_id');
  await renameColumn(sql, 'turns', 'cost', 'cost_usd');

  // Additive durable turn queue columns for pre-existing schemas (ctx-7e3x).
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS status TEXT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS user_message_id TEXT`;
  // Additive token-usage columns; NULL means the harness reported no usage.
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS input_tokens BIGINT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS output_tokens BIGINT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS total_tokens BIGINT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS next_message_seq BIGINT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS terminal_published_seq BIGINT`;
  // Budget-attribution tags: jsonb containment drives spend aggregation.
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql`CREATE INDEX IF NOT EXISTS idx_turns_tags_gin ON turns USING gin(tags)`;
  await sql`
    UPDATE turns
    SET error = 'Turn cancelled'
    WHERE error = 'Session cancelled'
  `;
  await sql`
    UPDATE turns
    SET status = CASE
      WHEN completed_at IS NULL THEN 'running'
      WHEN error = 'Turn cancelled' THEN 'cancelled'
      WHEN error IS NOT NULL THEN 'error'
      ELSE 'completed'
    END
    WHERE status IS NULL
  `;
  await sql`ALTER TABLE turns ALTER COLUMN status SET DEFAULT 'queued'`;
  await sql`ALTER TABLE turns ALTER COLUMN status SET NOT NULL`;

  // ── 8. turn_start_requests (→ agents) ──────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS turn_start_requests (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'preparing',
      turn_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      response JSONB,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  // Renewable per-turn startup reconciliation lease. This is deliberately
  // separate from turn status: a crashed owner leaves a queued turn reclaimable
  // without falsely marking it as running.
  await sql`
    CREATE TABLE IF NOT EXISTS turn_reconciliation_leases (
      turn_id TEXT PRIMARY KEY NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      lease_expires_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_turn_reconciliation_leases_expires
    ON turn_reconciliation_leases(lease_expires_at)
  `;

  // ── 9. event_store ─────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS event_store (
      seq SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      turn_id TEXT,
      conversation_id TEXT,
      channel TEXT NOT NULL DEFAULT 'system',
      source_type TEXT,
      source_payload TEXT
    )
  `;
  // Additive canonical-spine columns for pre-existing databases (ADR-015).
  await sql`ALTER TABLE event_store ADD COLUMN IF NOT EXISTS turn_id TEXT`;
  await sql`ALTER TABLE event_store ADD COLUMN IF NOT EXISTS conversation_id TEXT`;
  await sql`ALTER TABLE event_store ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'system'`;
  // Additive raw bus provenance columns for spine consumers (ADR-016).
  await sql`ALTER TABLE event_store ADD COLUMN IF NOT EXISTS source_type TEXT`;
  await sql`ALTER TABLE event_store ADD COLUMN IF NOT EXISTS source_payload TEXT`;

  // Per-agent writer lock + committed watermark. Every canonical event writer
  // locks this row before allocating SERIAL values, so committed_seq is safe
  // for cursor replay even with multiple orchestrator/database connections.
  await sql`
    CREATE TABLE IF NOT EXISTS agent_event_heads (
      agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      committed_seq BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`
    INSERT INTO agent_event_heads (agent_id, committed_seq, updated_at)
    SELECT
      event_store.agent_id,
      max(event_store.seq)::bigint,
      (extract(epoch FROM clock_timestamp()) * 1000)::bigint
    FROM event_store
    INNER JOIN agents ON agents.id = event_store.agent_id
    GROUP BY event_store.agent_id
    ON CONFLICT (agent_id) DO UPDATE SET
      committed_seq = greatest(
        agent_event_heads.committed_seq,
        EXCLUDED.committed_seq
      ),
      updated_at = EXCLUDED.updated_at
  `;

  // ── 8b. spine_cursors ──────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS spine_cursors (
      consumer TEXT PRIMARY KEY NOT NULL,
      last_seq BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL
    )
  `;

  // ── 9. suspended_sessions ──────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS suspended_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      turn_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      wait_event_type TEXT NOT NULL,
      wait_selector TEXT NOT NULL,
      wait_expires_at BIGINT,
      snapshot_state TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `;
  await renameColumn(sql, 'suspended_sessions', 'agent_session_id', 'turn_id');

  // WS2.0: EventQueueImpl was never wired into runtime; remove its table from
  // existing pre-release databases as well as fresh schemas.
  await sql`DROP TABLE IF EXISTS scheduled_events`;

  // ── 10. event_triggers (→ agents) ──────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS event_triggers (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      selector JSONB,
      selector_hash TEXT NOT NULL,
      task_template TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TEXT NOT NULL
    )
  `;

  // ── 10b. trigger_firings (→ event_triggers) ────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS trigger_firings (
      id TEXT PRIMARY KEY NOT NULL,
      trigger_id TEXT NOT NULL REFERENCES event_triggers(id) ON DELETE CASCADE,
      event_seq BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(trigger_id, event_seq)
    )
  `;

  // ── 11. agent_versions (→ agents) ──────────────────────────────────
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

  // ── 12. pending_interrupts (→ turns, agents) ───────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS pending_interrupts (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      sandbox_session_id TEXT,
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
  await renameColumn(sql, 'pending_interrupts', 'agent_session_id', 'turn_id');
  await renameColumn(sql, 'pending_interrupts', 'session_id', 'sandbox_session_id');

  // ── 13. interrupt_resume_attempts (→ pending_interrupts, turns, agents) ──
  await sql`
    CREATE TABLE IF NOT EXISTS interrupt_resume_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      interrupt_id TEXT NOT NULL REFERENCES pending_interrupts(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      sandbox_session_id TEXT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      completed_at BIGINT
    )
  `;
  await renameColumn(sql, 'interrupt_resume_attempts', 'agent_session_id', 'turn_id');
  await renameColumn(sql, 'interrupt_resume_attempts', 'session_id', 'sandbox_session_id');

  // ── 15. agent_checkpoints (→ sandbox_sessions) ─────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS agent_checkpoints (
      id TEXT PRIMARY KEY NOT NULL,
      sandbox_session_id TEXT NOT NULL REFERENCES sandbox_sessions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      checkpoint_version INTEGER NOT NULL DEFAULT 2,
      checkpoint_data JSONB NOT NULL,
      harness_state JSONB,
      workspace_ref TEXT,
      suspend_reason TEXT,
      created_at BIGINT NOT NULL
    )
  `;
  await renameColumn(sql, 'agent_checkpoints', 'session_id', 'sandbox_session_id');

  // PAUSED sandbox-session status was removed. Normalize any old rows forward
  // before dropping the old pause metadata columns.
  await sql`
    UPDATE sandbox_sessions AS s
    SET
      status = CASE
        WHEN EXISTS (
          SELECT 1 FROM agent_checkpoints AS c WHERE c.sandbox_session_id = s.id
        ) THEN 'CHECKPOINTED'
        ELSE 'TERMINATED'
      END,
      container_name = NULL,
      container_id = NULL,
      updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
    WHERE s.status = 'PAUSED'
  `;
  await sql`ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS paused_at`;
  await sql`ALTER TABLE sandbox_sessions DROP COLUMN IF EXISTS paused_reason`;

  // ── 16. callback_outbox (→ agents, turns) ──────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS callback_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      turn_id TEXT REFERENCES turns(id),
      webhook_id TEXT,
      callback_url TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_seq BIGINT,
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
  await renameColumn(sql, 'callback_outbox', 'session_id', 'turn_id');
  await sql`ALTER TABLE callback_outbox ADD COLUMN IF NOT EXISTS event_seq BIGINT`;
  await sql`ALTER TABLE callback_outbox ADD COLUMN IF NOT EXISTS webhook_id TEXT`;

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
  await sql`
    DO $$
    BEGIN
      ALTER TABLE callback_outbox
        ADD CONSTRAINT callback_outbox_webhook_id_webhooks_id_fk
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$
  `;
  // ── 18. system_settings ────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // Drop retired keys (idempotent).
  await sql`DELETE FROM system_settings WHERE key = 'maxCheckpointBytes'`;

  // ── 18b. budget_policies (tag-based budget policies) ───────────────
  await sql`
    CREATE TABLE IF NOT EXISTS budget_policies (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      doc JSONB NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  // ── 19. artifacts (→ agents, turns, conversations) ─────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
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
  await renameColumn(sql, 'artifacts', 'session_id', 'turn_id');

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
      turn_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      result TEXT,
      error TEXT,
      created_at BIGINT NOT NULL,
      completed_at BIGINT
    )
  `;
  await renameColumn(sql, 'tool_request_dedup', 'session_id', 'turn_id');

  // ── Indexes ────────────────────────────────────────────────────────

  // conversations
  await sql`CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated ON conversations(agent_id, updated_at)`;

  // messages
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`;

  // sandbox_sessions
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_conversation ON sandbox_sessions(conversation_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_agent ON sandbox_sessions(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_status ON sandbox_sessions(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_last_activity ON sandbox_sessions(last_activity_at)`;

  // turns
  await sql`CREATE INDEX IF NOT EXISTS idx_turns_agent_started ON turns(agent_id, started_at)`;
  await sql`DROP INDEX IF EXISTS idx_turns_session`;
  await sql`CREATE INDEX IF NOT EXISTS idx_turns_sandbox_session ON turns(sandbox_session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_turns_status_open ON turns(status) WHERE completed_at IS NULL`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_turns_terminal_publish_pending
    ON turns(completed_at)
    WHERE completed_at IS NOT NULL AND terminal_published_seq IS NULL
  `;

  // turn_start_requests
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_start_requests_agent_key
    ON turn_start_requests(agent_id, idempotency_key)
  `;

  // event_store
  await sql`CREATE INDEX IF NOT EXISTS idx_event_store_agent_seq ON event_store(agent_id, seq)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_store_turn_seq ON event_store(turn_id, seq) WHERE turn_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_store_agent_channel_seq ON event_store(agent_id, channel, seq)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_store_source_seq ON event_store(seq) WHERE source_type IS NOT NULL`;

  // suspended_sessions
  await sql`CREATE INDEX IF NOT EXISTS idx_suspended_sessions_event_type ON suspended_sessions(wait_event_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_suspended_sessions_agent ON suspended_sessions(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_suspended_sessions_expires ON suspended_sessions(wait_expires_at)`;

  // event_triggers
  await sql`ALTER TABLE event_triggers ADD COLUMN IF NOT EXISTS selector_hash TEXT`;
  await sql`UPDATE event_triggers SET selector_hash = md5(COALESCE(selector::text, 'null')) WHERE selector_hash IS NULL`;
  await sql`ALTER TABLE event_triggers ALTER COLUMN selector_hash SET NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_triggers_agent ON event_triggers(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_triggers_event_type ON event_triggers(event_type)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_triggers_signature ON event_triggers(agent_id, event_type, selector_hash)`;

  // trigger_firings
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_firings_trigger_event_seq ON trigger_firings(trigger_id, event_seq)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_trigger_firings_event_seq ON trigger_firings(event_seq)`;

  // agent_versions
  await sql`DROP INDEX IF EXISTS idx_agent_versions_agent_version`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_versions_agent_version ON agent_versions(agent_id, version)`;

  // pending_interrupts
  await sql`DROP INDEX IF EXISTS idx_interrupts_agent_session`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupts_turn ON pending_interrupts(turn_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupts_agent ON pending_interrupts(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupts_status ON pending_interrupts(status, expires_at)`;

  // interrupt_resume_attempts
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_interrupt_resume_attempts_interrupt ON interrupt_resume_attempts(interrupt_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupt_resume_attempts_agent_status ON interrupt_resume_attempts(agent_id, status)`;
  await sql`DROP INDEX IF EXISTS idx_interrupt_resume_attempts_session`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupt_resume_attempts_sandbox_session ON interrupt_resume_attempts(sandbox_session_id)`;

  // agent_checkpoints
  await sql`DROP INDEX IF EXISTS idx_checkpoints_session_id`;
  await sql`CREATE INDEX IF NOT EXISTS idx_checkpoints_sandbox_session_id ON agent_checkpoints(sandbox_session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_id ON agent_checkpoints(agent_id)`;

  // callback_outbox
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_status ON callback_outbox(status, next_attempt_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_claim_expires ON callback_outbox(status, claim_expires_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_agent ON callback_outbox(agent_id)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_callback_event_seq
    ON callback_outbox(callback_url, event_type, event_seq)
    WHERE event_seq IS NOT NULL
  `;

  // webhooks
  await sql`CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id)`;

  // artifacts
  await sql`CREATE INDEX IF NOT EXISTS idx_artifacts_agent_created ON artifacts(agent_id, created_at)`;
  await sql`DROP INDEX IF EXISTS idx_artifacts_session`;
  await sql`CREATE INDEX IF NOT EXISTS idx_artifacts_turn ON artifacts(turn_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status)`;

  // tool_request_dedup
  await sql`CREATE INDEX IF NOT EXISTS idx_tool_dedup_created ON tool_request_dedup(created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tool_dedup_status ON tool_request_dedup(status)`;

  // Run persisted-data hard cuts only after every additive column/index step
  // above has normalized older baseline/v1 schemas.
  await canonicalizePersistedEventContracts(sql);

  // Adopt only terminal history that already contains the complete frame set
  // for the durable turn outcome. Rows without proof stay pending and are
  // rebuilt by terminal publication recovery before readers are admitted.
  await sql`
    UPDATE turns AS turn_row
    SET terminal_published_seq = (
      SELECT max(frame.seq)::bigint
      FROM event_store AS frame
      WHERE frame.turn_id = turn_row.id
        AND frame.channel = 'run'
        AND frame.type IN ('RUN_ERROR', 'RUN_FINISHED')
    )
    WHERE turn_row.completed_at IS NOT NULL
      AND turn_row.terminal_published_seq IS NULL
      AND EXISTS (
        SELECT 1
        FROM event_store AS finished
        WHERE finished.turn_id = turn_row.id
          AND finished.channel = 'run'
          AND finished.type = 'RUN_FINISHED'
      )
      AND (
        turn_row.status = 'completed'
        OR EXISTS (
          SELECT 1
          FROM event_store AS failed
          WHERE failed.turn_id = turn_row.id
            AND failed.channel = 'run'
            AND failed.type = 'RUN_ERROR'
        )
      )
  `;

  // A historical terminal frame is an ordering boundary: appending a newer
  // message snapshot after RUN_FINISHED/RUN_ERROR would make live/replay order
  // impossible to reconcile. Rebuild the latest owned pre-terminal message
  // frame in place from the authoritative message row instead. Open turns stay
  // on the normal revision/publisher path below.
  await sql`
    WITH message_sources AS (
      SELECT
        event.seq,
        event.source_type,
        event.turn_id,
        event.created_at,
        CASE
          WHEN event.source_payload IS NOT NULL THEN event.source_payload::jsonb
          WHEN jsonb_typeof(event.payload::jsonb->'value') = 'object'
            THEN event.payload::jsonb->'value'
          ELSE event.payload::jsonb
        END AS source
      FROM event_store AS event
      WHERE event.source_type IN ('message.committed', 'message.updated')
    ),
    canonical_messages AS (
      SELECT DISTINCT ON (source->>'messageId')
        seq,
        source_type,
        turn_id,
        created_at,
        source->>'messageId' AS message_id,
        (source->>'messageSeq')::bigint AS message_seq,
        CASE
          WHEN source_type = 'message.updated'
            THEN (source->>'messageRevision')::bigint
          ELSE 0
        END AS message_revision,
        source
      FROM message_sources
      WHERE source ? 'messageId'
        AND source ? 'messageSeq'
        AND source->>'messageSeq' ~ '^[0-9]+$'
        AND (
          source_type = 'message.committed'
          OR (
            source ? 'messageRevision'
            AND source->>'messageRevision' ~ '^[1-9][0-9]*$'
          )
        )
        AND turn_id IS NOT NULL
      ORDER BY
        source->>'messageId',
        CASE
          WHEN source_type = 'message.updated'
            THEN (source->>'messageRevision')::bigint
          ELSE 0
        END DESC,
        seq DESC
    ),
    terminal_snapshots AS (
      SELECT
        canonical.seq,
        canonical.source_type,
        (
          jsonb_build_object(
            'turnId', canonical.turn_id,
            'agentId', message.agent_id,
            'conversationId', message.conversation_id,
            'messageId', message.id,
            'messageSeq', canonical.message_seq,
            'role', message.role,
            'content', message.content,
            'timestamp', CASE
              WHEN jsonb_typeof(canonical.source->'timestamp') = 'number'
                THEN canonical.source->'timestamp'
              ELSE to_jsonb(canonical.created_at)
            END
          )
          || CASE
            WHEN canonical.source_type = 'message.updated'
              THEN jsonb_build_object('messageRevision', canonical.message_revision)
            ELSE '{}'::jsonb
          END
          || CASE
            WHEN message.parts IS NOT NULL
              THEN jsonb_build_object('parts', message.parts)
            ELSE '{}'::jsonb
          END
          || CASE
            WHEN message.tool_calls IS NOT NULL
              THEN jsonb_build_object('toolCalls', message.tool_calls)
            ELSE '{}'::jsonb
          END
          || CASE
            WHEN message.tool_call_id IS NOT NULL
              THEN jsonb_build_object('toolCallId', message.tool_call_id)
            ELSE '{}'::jsonb
          END
        ) AS source
      FROM canonical_messages AS canonical
      JOIN messages AS message ON message.id = canonical.message_id
      WHERE message.role IN ('assistant', 'tool')
        AND (
          canonical.source_type = 'message.committed'
          OR message.role = 'assistant'
        )
        AND EXISTS (
          SELECT 1
          FROM event_store AS terminal
          WHERE terminal.turn_id = canonical.turn_id
            AND terminal.channel = 'run'
            AND terminal.type IN ('RUN_ERROR', 'RUN_FINISHED')
            AND terminal.seq > canonical.seq
        )
    )
    UPDATE event_store AS event
    SET
      source_payload = snapshot.source::text,
      payload = (
        jsonb_build_object(
          'type', 'CUSTOM',
          'name', CASE snapshot.source_type
            WHEN 'message.updated' THEN 'ctxmill.message.updated'
            ELSE 'ctxmill.message.committed'
          END
        )
        || snapshot.source
      )::text
    FROM terminal_snapshots AS snapshot
    WHERE event.seq = snapshot.seq
  `;

  // If a crash left a rewritten source event queued for webhook delivery,
  // keep its outbox payload aligned with the repaired event at the same seq.
  await sql`
    WITH canonical_messages AS (
      SELECT DISTINCT ON (event.source_payload::jsonb->>'messageId')
        event.seq,
        event.turn_id,
        event.source_type,
        event.source_payload::jsonb AS source
      FROM event_store AS event
      WHERE event.source_type IN ('message.committed', 'message.updated')
        AND event.source_payload IS NOT NULL
        AND event.source_payload::jsonb ? 'messageId'
      ORDER BY
        event.source_payload::jsonb->>'messageId',
        CASE
          WHEN event.source_type = 'message.updated'
            AND event.source_payload::jsonb->>'messageRevision' ~ '^[0-9]+$'
            THEN (event.source_payload::jsonb->>'messageRevision')::bigint
          ELSE 0
        END DESC,
        event.seq DESC
    )
    UPDATE callback_outbox AS callback
    SET payload = canonical.source
    FROM canonical_messages AS canonical
    WHERE callback.event_seq = canonical.seq
      AND callback.event_type = canonical.source_type
      AND callback.status IN ('pending', 'in_progress')
      AND EXISTS (
        SELECT 1
        FROM event_store AS terminal
        WHERE terminal.turn_id = canonical.turn_id
          AND terminal.channel = 'run'
          AND terminal.type IN ('RUN_ERROR', 'RUN_FINISHED')
          AND terminal.seq > canonical.seq
      )
  `;

  // Backfill durable message identity only where the retained canonical spine
  // proves it. Ambiguous historical rows remain unowned and are treated as
  // already published (revision 0), so startup never fabricates duplicates.
  await sql`
    WITH message_sources AS (
      SELECT
        seq,
        source_type,
        turn_id,
        CASE
          WHEN source_payload IS NOT NULL THEN source_payload::jsonb
          WHEN jsonb_typeof(payload::jsonb->'value') = 'object' THEN payload::jsonb->'value'
          ELSE payload::jsonb
        END AS source
      FROM event_store
      WHERE source_type IN ('message.committed', 'message.updated')
    ),
    canonical_messages AS (
      SELECT DISTINCT ON (source->>'messageId')
        source->>'messageId' AS message_id,
        turn_id,
        (source->>'messageSeq')::bigint AS message_seq,
        CASE
          WHEN source_type = 'message.updated'
            THEN (source->>'messageRevision')::bigint
          ELSE 0
        END AS message_revision,
        source
      FROM message_sources
      WHERE source ? 'messageId'
        AND source ? 'messageSeq'
        AND source->>'messageSeq' ~ '^[0-9]+$'
        AND (
          source_type = 'message.committed'
          OR (
            source ? 'messageRevision'
            AND source->>'messageRevision' ~ '^[0-9]+$'
          )
        )
        AND turn_id IS NOT NULL
      ORDER BY
        source->>'messageId',
        CASE
          WHEN source_type = 'message.updated'
            THEN (source->>'messageRevision')::bigint
          ELSE 0
        END DESC,
        seq DESC
    )
    UPDATE messages AS message
    SET
      turn_id = canonical.turn_id,
      message_seq = canonical.message_seq,
      message_revision = CASE
        WHEN message.content IS DISTINCT FROM canonical.source->>'content'
          OR coalesce(message.parts, 'null'::jsonb)
            IS DISTINCT FROM coalesce(canonical.source->'parts', 'null'::jsonb)
          OR coalesce(message.tool_calls, 'null'::jsonb)
            IS DISTINCT FROM coalesce(canonical.source->'toolCalls', 'null'::jsonb)
        THEN greatest(message.message_revision, canonical.message_revision + 1)
        ELSE greatest(message.message_revision, canonical.message_revision)
      END,
      published_revision = canonical.message_revision
    FROM canonical_messages AS canonical
    WHERE message.id = canonical.message_id
  `;
  await sql`
    UPDATE turns AS turn_row
    SET next_message_seq = greatest(
      turn_row.next_message_seq,
      coalesce((
        SELECT max(message.message_seq) + 1
        FROM messages AS message
        WHERE message.turn_id = turn_row.id
      ), 0)
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_turn_seq
    ON messages(turn_id, message_seq)
    WHERE turn_id IS NOT NULL AND message_seq IS NOT NULL
  `;
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
  }
}
