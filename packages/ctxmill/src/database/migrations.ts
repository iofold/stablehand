import type postgres from 'postgres';
import {
  CANONICAL_EVENT_CONTRACTS_MIGRATION_ID,
  CANONICAL_EVENT_CONTRACTS_MIGRATION_VERSION,
  canonicalizeInterruptToolName,
  canonicalizePersistedEventContracts,
  INTERRUPT_TOOL_NAME_MIGRATION_ID,
  TEXT_MESSAGE_END_CONTRACT_MIGRATION_ID,
  TEXT_MESSAGE_END_CONTRACT_MIGRATION_VERSION,
} from './canonical-event-data-migration.js';
import { canonicalizePersistedToolPolicies } from './tool-policy-data-migration.js';

export {
  CANONICAL_EVENT_CONTRACTS_MIGRATION_ID,
  CANONICAL_EVENT_CONTRACTS_MIGRATION_VERSION,
  INTERRUPT_TOOL_NAME_MIGRATION_ID,
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
        manifest JSONB,
        metadata JSONB,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `;
    // Agent names are deployment identities. Keep the oldest row on its
    // declared name and deterministically rename historical duplicates before
    // establishing the invariant. The canonical manifest snapshot follows the
    // renamed row so API and declarative identity cannot drift.
    await sql.unsafe(`
    DO $$
    DECLARE
      duplicate_agent RECORD;
      candidate_name TEXT;
      collision_suffix INTEGER;
    BEGIN
      FOR duplicate_agent IN
        SELECT id, name
        FROM (
          SELECT
            id,
            name,
            row_number() OVER (PARTITION BY name ORDER BY created_at, id) AS duplicate_rank
          FROM agents
        ) AS ranked
        WHERE duplicate_rank > 1
        ORDER BY name, duplicate_rank
      LOOP
        candidate_name := duplicate_agent.name || '-duplicate-' || duplicate_agent.id;
        collision_suffix := 0;
        WHILE EXISTS (
          SELECT 1
          FROM agents
          WHERE name = candidate_name
            AND id <> duplicate_agent.id
        ) LOOP
          collision_suffix := collision_suffix + 1;
          candidate_name := duplicate_agent.name || '-duplicate-' || duplicate_agent.id
            || '-' || collision_suffix;
        END LOOP;

        UPDATE agents
        SET
          name = candidate_name,
          manifest = CASE
            WHEN jsonb_typeof(manifest) = 'object'
              THEN jsonb_set(
                manifest,
                '{metadata}',
                coalesce(manifest->'metadata', '{}'::jsonb)
                  || jsonb_build_object('name', candidate_name),
                true
              )
            ELSE manifest
          END
        WHERE id = duplicate_agent.id;
      END LOOP;
    END
    $$
    `);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents(name)`;
    await sql`DROP TABLE IF EXISTS agent_versions`;
    await sql`ALTER TABLE agents DROP COLUMN IF EXISTS version`;
    await sql`ALTER TABLE agents DROP COLUMN IF EXISTS status`;

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
      runtime_definition_hash TEXT,
      checkpoint_ref TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_activity_at BIGINT NOT NULL,
      restore_attempts INTEGER NOT NULL DEFAULT 0,
      last_restore_error TEXT,
      restore_owner_id TEXT,
      restore_fence_token BIGINT NOT NULL DEFAULT 0,
      restore_lease_expires_at BIGINT
    )
  `;

  // Idempotent column additions for pre-existing schemas (ADR 013 retry policy).
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS restore_attempts INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS last_restore_error TEXT`;
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS restore_owner_id TEXT`;
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS restore_fence_token BIGINT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS restore_lease_expires_at BIGINT`;
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS runtime_definition_hash TEXT`;
  // ctx-vsf8: durable evidence of repeated checkpoint failures.
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS checkpoint_failures INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE sandbox_sessions ADD COLUMN IF NOT EXISTS last_checkpoint_error TEXT`;
  // Durable lifecycle intent blocks new turn admission while a sandbox is
  // being checkpointed, terminated, reset, or adopted by a startup worker.
  // A lease may expire for worker takeover, but the unfinished intent remains
  // an admission barrier.
  await sql`
    CREATE TABLE IF NOT EXISTS sandbox_session_lifecycle_operations (
      sandbox_session_id TEXT PRIMARY KEY NOT NULL
        REFERENCES sandbox_sessions(id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'reserved',
      owner_id TEXT NOT NULL,
      fence_token BIGINT NOT NULL DEFAULT 0,
      allowed_turn_id TEXT,
      allowed_delivery_owner_id TEXT,
      allowed_delivery_fence_token BIGINT,
      allowed_interrupt_resume_attempt_id TEXT,
      lease_expires_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`
    ALTER TABLE sandbox_session_lifecycle_operations
    ADD COLUMN IF NOT EXISTS operation_id TEXT
  `;
  await sql`
    UPDATE sandbox_session_lifecycle_operations
    SET operation_id = uuid_generate_v4()::text
    WHERE operation_id IS NULL
  `;
  await sql`
    ALTER TABLE sandbox_session_lifecycle_operations
    ALTER COLUMN operation_id SET NOT NULL
  `;
  await sql`
    ALTER TABLE sandbox_session_lifecycle_operations
    ADD COLUMN IF NOT EXISTS allowed_turn_id TEXT
  `;
  await sql`
    ALTER TABLE sandbox_session_lifecycle_operations
    ADD COLUMN IF NOT EXISTS allowed_delivery_owner_id TEXT
  `;
  await sql`
    ALTER TABLE sandbox_session_lifecycle_operations
    ADD COLUMN IF NOT EXISTS allowed_delivery_fence_token BIGINT
  `;
  await sql`
    ALTER TABLE sandbox_session_lifecycle_operations
    ADD COLUMN IF NOT EXISTS allowed_interrupt_resume_attempt_id TEXT
  `;

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
      usage JSONB,
      gateway_correlation_id TEXT,
      gateway_profile TEXT,
      gateway_revision TEXT,
      gateway_mode TEXT,
      usage_reconciled_at BIGINT,
      next_message_seq BIGINT NOT NULL DEFAULT 0,
      terminal_published_seq BIGINT,
      delivery_owner_id TEXT,
      delivery_fence_token BIGINT,
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
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS usage JSONB`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS gateway_correlation_id TEXT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS gateway_profile TEXT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS gateway_revision TEXT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS gateway_mode TEXT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS usage_reconciled_at BIGINT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS next_message_seq BIGINT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS terminal_published_seq BIGINT`;
  // ctx-iqzy T2: queued_at = queue-admission time; started_at is restamped at
  // activation and means execution start. Backfill legacy rows from the old
  // startedAt (which WAS admission time before this change).
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS queued_at BIGINT`;
  await sql`UPDATE turns SET queued_at = started_at WHERE queued_at IS NULL`;
  await sql`ALTER TABLE turns ALTER COLUMN queued_at SET NOT NULL`;
  // Hard-cut the former recovery-only names to general delivery ownership.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'turns' AND column_name = 'reconciliation_owner_id'
      ) THEN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'turns' AND column_name = 'delivery_owner_id'
        ) THEN
          ALTER TABLE turns RENAME COLUMN reconciliation_owner_id TO delivery_owner_id;
        ELSE
          UPDATE turns
          SET delivery_owner_id = COALESCE(delivery_owner_id, reconciliation_owner_id);
          ALTER TABLE turns DROP COLUMN reconciliation_owner_id;
        END IF;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'turns' AND column_name = 'reconciliation_fence_token'
      ) THEN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'turns' AND column_name = 'delivery_fence_token'
        ) THEN
          ALTER TABLE turns RENAME COLUMN reconciliation_fence_token TO delivery_fence_token;
        ELSE
          UPDATE turns
          SET delivery_fence_token = COALESCE(delivery_fence_token, reconciliation_fence_token);
          ALTER TABLE turns DROP COLUMN reconciliation_fence_token;
        END IF;
      END IF;
    END
    $$
  `;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS delivery_owner_id TEXT`;
  await sql`ALTER TABLE turns ADD COLUMN IF NOT EXISTS delivery_fence_token BIGINT`;
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

  // Gateway spend is recorded separately from turn execution. The first
  // implementation has turn-only observation granularity: every LiteLLM
  // transaction is retained as an attempt beneath one aggregate row, so
  // retries/fallbacks cannot inflate logical model-call counts.
  await sql`
    CREATE TABLE IF NOT EXISTS model_call_usage (
      id TEXT PRIMARY KEY NOT NULL,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      observation_scope TEXT NOT NULL DEFAULT 'turn_aggregate',
      gateway_profile TEXT NOT NULL,
      gateway_revision TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      input_tokens BIGINT,
      output_tokens BIGINT,
      total_tokens BIGINT,
      cache_read_tokens BIGINT,
      cache_create_tokens BIGINT,
      reasoning_tokens BIGINT,
      known_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      cost_state TEXT NOT NULL DEFAULT 'unpriced',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS model_call_attempt_usage (
      id TEXT PRIMARY KEY NOT NULL,
      model_call_usage_id TEXT NOT NULL
        REFERENCES model_call_usage(id) ON DELETE CASCADE,
      gateway_profile TEXT NOT NULL,
      gateway_revision TEXT NOT NULL,
      gateway_transaction_id TEXT NOT NULL,
      requested_model TEXT,
      resolved_model TEXT,
      provider TEXT,
      status TEXT NOT NULL,
      input_tokens BIGINT,
      output_tokens BIGINT,
      total_tokens BIGINT,
      cache_read_tokens BIGINT,
      cache_create_tokens BIGINT,
      reasoning_tokens BIGINT,
      cost_usd DOUBLE PRECISION,
      cost_state TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      ended_at BIGINT NOT NULL,
      ingested_at BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS model_gateway_reconciliation_state (
      gateway_profile TEXT PRIMARY KEY NOT NULL,
      gateway_revision TEXT NOT NULL,
      watermark_ms BIGINT NOT NULL DEFAULT 0,
      lease_owner_id TEXT,
      lease_fence_token BIGINT NOT NULL DEFAULT 0,
      lease_expires_at BIGINT,
      last_attempt_at BIGINT,
      last_success_at BIGINT,
      last_error TEXT,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS model_gateway_spend_quarantine (
      id TEXT PRIMARY KEY NOT NULL,
      gateway_profile TEXT NOT NULL,
      gateway_transaction_id TEXT NOT NULL,
      correlation_id TEXT,
      reason TEXT NOT NULL,
      sanitized_payload JSONB NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      first_seen_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL
    )
  `;

  // Encrypted per-turn credentials survive queued restart and HITL recovery,
  // but are deleted atomically when their turn reaches a terminal state.
  await sql`
    CREATE TABLE IF NOT EXISTS turn_secret_envelopes (
      turn_id TEXT PRIMARY KEY NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      iv TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `;

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sandbox_session_lifecycle_operations_allowed_turn_id_fkey'
          AND conrelid = 'sandbox_session_lifecycle_operations'::regclass
      ) THEN
        ALTER TABLE sandbox_session_lifecycle_operations
        ADD CONSTRAINT sandbox_session_lifecycle_operations_allowed_turn_id_fkey
        FOREIGN KEY (allowed_turn_id) REFERENCES turns(id) ON DELETE SET NULL;
      END IF;
    END
    $$
  `;

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

  // One renewable lease owns normal delivery and crash takeover alike.
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.turn_reconciliation_leases') IS NOT NULL
        AND to_regclass('public.turn_delivery_leases') IS NULL THEN
        ALTER TABLE turn_reconciliation_leases RENAME TO turn_delivery_leases;
      END IF;
    END
    $$
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS turn_delivery_leases (
      turn_id TEXT PRIMARY KEY NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      fence_token BIGINT NOT NULL DEFAULT 0,
      lease_expires_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`
    ALTER TABLE turn_delivery_leases
    ADD COLUMN IF NOT EXISTS fence_token BIGINT NOT NULL DEFAULT 0
  `;
  await sql`
    DO $$
    BEGIN
      IF to_regclass('public.turn_reconciliation_leases') IS NOT NULL THEN
        EXECUTE '
          INSERT INTO turn_delivery_leases (
            turn_id, owner_id, fence_token, lease_expires_at, updated_at
          )
          SELECT turn_id, owner_id, fence_token, lease_expires_at, updated_at
          FROM turn_reconciliation_leases
          ON CONFLICT (turn_id) DO UPDATE
          SET owner_id = EXCLUDED.owner_id,
              fence_token = EXCLUDED.fence_token,
              lease_expires_at = EXCLUDED.lease_expires_at,
              updated_at = EXCLUDED.updated_at
          WHERE EXCLUDED.fence_token > turn_delivery_leases.fence_token
        ';
        DROP TABLE turn_reconciliation_leases;
      END IF;
    END
    $$
  `;
  await sql`DROP INDEX IF EXISTS idx_turn_reconciliation_leases_expires`;
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'turn_delivery_leases'::regclass
          AND conname = 'turn_reconciliation_leases_pkey'
      ) THEN
        ALTER TABLE turn_delivery_leases
        RENAME CONSTRAINT turn_reconciliation_leases_pkey
        TO turn_delivery_leases_pkey;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'turn_delivery_leases'::regclass
          AND conname = 'turn_reconciliation_leases_turn_id_fkey'
      ) THEN
        ALTER TABLE turn_delivery_leases
        RENAME CONSTRAINT turn_reconciliation_leases_turn_id_fkey
        TO turn_delivery_leases_turn_id_fkey;
      END IF;
    END
    $$
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_turn_delivery_leases_expires
    ON turn_delivery_leases(lease_expires_at)
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
  // This event-spine state deliberately has no agents FK: agent.deleted is
  // persisted after the live agent projection and its prior history are hard
  // deleted, leaving one durable lifecycle tombstone.
  await sql`
    CREATE TABLE IF NOT EXISTS agent_event_heads (
      agent_id TEXT PRIMARY KEY NOT NULL,
      committed_seq BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`
    ALTER TABLE agent_event_heads
    DROP CONSTRAINT IF EXISTS agent_event_heads_agent_id_fkey
  `;
  await sql`
    INSERT INTO agent_event_heads (agent_id, committed_seq, updated_at)
    SELECT
      event_store.agent_id,
      max(event_store.seq)::bigint,
      (extract(epoch FROM clock_timestamp()) * 1000)::bigint
    FROM event_store
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
      created_at BIGINT NOT NULL
    )
  `;
  // ctx-iqzy T5: created_at was an ISO-8601 string in a TEXT column — the only
  // ISO timestamp in the persisted schema. Convert in place to epoch-ms.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'event_triggers'
          AND column_name = 'created_at'
          AND data_type = 'text'
      ) THEN
        ALTER TABLE event_triggers
          ALTER COLUMN created_at TYPE BIGINT
          USING (extract(epoch FROM created_at::timestamptz) * 1000)::bigint;
      END IF;
    END $$;
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

  // ── 10c. schedules (optionally → agents) ──────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_fired_at BIGINT
    )
  `;
  await sql`ALTER TABLE schedules ALTER COLUMN agent_id DROP NOT NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_name ON schedules(name)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_schedules_agent ON schedules(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled)`;
  await sql`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS missed_fire_count BIGINT NOT NULL DEFAULT 0`;

  // ── 11. pending_interrupts (→ turns, agents) ───────────────────────
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
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sandbox_lifecycle_allowed_resume_attempt_fkey'
          AND conrelid = 'sandbox_session_lifecycle_operations'::regclass
      ) THEN
        ALTER TABLE sandbox_session_lifecycle_operations
        ADD CONSTRAINT sandbox_lifecycle_allowed_resume_attempt_fkey
        FOREIGN KEY (allowed_interrupt_resume_attempt_id)
        REFERENCES interrupt_resume_attempts(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `;

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
      lifecycle_operation_id TEXT,
      lifecycle_owner_id TEXT,
      lifecycle_fence_token BIGINT,
      created_at BIGINT NOT NULL
    )
  `;
  await renameColumn(sql, 'agent_checkpoints', 'session_id', 'sandbox_session_id');
  await sql`ALTER TABLE agent_checkpoints ADD COLUMN IF NOT EXISTS lifecycle_operation_id TEXT`;
  await sql`ALTER TABLE agent_checkpoints ADD COLUMN IF NOT EXISTS lifecycle_owner_id TEXT`;
  await sql`ALTER TABLE agent_checkpoints ADD COLUMN IF NOT EXISTS lifecycle_fence_token BIGINT`;

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
  // Existing RESTORING rows predate durable restore ownership. Mark them with
  // an already-expired synthetic generation so reconciliation can fence and
  // recover them immediately.
  await sql`
    UPDATE sandbox_sessions
    SET
      restore_owner_id = COALESCE(
        restore_owner_id,
        'migration-expired-restore'
      ),
      restore_fence_token = GREATEST(restore_fence_token, 1),
      restore_lease_expires_at = COALESCE(restore_lease_expires_at, 0)
    WHERE status = 'RESTORING'
  `;
  await sql`
    UPDATE sandbox_sessions
    SET
      restore_owner_id = NULL,
      restore_lease_expires_at = NULL
    WHERE status <> 'RESTORING'
  `;
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sandbox_sessions_status_check'
          AND conrelid = 'sandbox_sessions'::regclass
      ) THEN
        ALTER TABLE sandbox_sessions
        ADD CONSTRAINT sandbox_sessions_status_check
        CHECK (
          status IN ('ACTIVE', 'CHECKPOINTED', 'RESTORING', 'TERMINATED')
        );
      END IF;
    END $$;
  `;
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sandbox_sessions_restore_ownership_check'
          AND conrelid = 'sandbox_sessions'::regclass
      ) THEN
        ALTER TABLE sandbox_sessions
        ADD CONSTRAINT sandbox_sessions_restore_ownership_check
        CHECK (
          (
            status = 'RESTORING'
            AND restore_owner_id IS NOT NULL
            AND restore_fence_token > 0
            AND restore_lease_expires_at IS NOT NULL
          )
          OR
          (
            status <> 'RESTORING'
            AND restore_owner_id IS NULL
            AND restore_lease_expires_at IS NULL
          )
        );
      END IF;
    END $$;
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

  // ── 18a2. api_keys (WO-5 scoped extension keys; sha256-only storage) ─
  await sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      capabilities TEXT[] NOT NULL,
      note TEXT,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      created_by TEXT,
      expires_at BIGINT,
      last_used_at BIGINT,
      revoked_at BIGINT
    )
  `;
  // ctx-k6ad: bind a key to one agent (NULL = operator/all-agents key).
  await sql`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE`;

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
      kind TEXT,
      metadata JSONB,
      sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS kind TEXT`;
  await sql`ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS sha256 TEXT`;
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

  // turns queue (ctx-z5k0): serves cap counts and dispatcher claim ordering
  await sql`
    CREATE INDEX IF NOT EXISTS idx_turns_queued_dispatch
    ON turns(agent_id, started_at)
    WHERE status = 'queued' AND completed_at IS NULL
  `;

  // conversations
  await sql`CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated ON conversations(agent_id, updated_at)`;

  // messages
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`;

  // sandbox_sessions
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_conversation ON sandbox_sessions(conversation_id)`;
  // One conversation owns one live harness stream. This intentionally fails
  // migration when legacy data contains multiple live rows so operators must
  // reconcile the corresponding containers instead of silently orphaning one.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_sessions_conversation_live
    ON sandbox_sessions(conversation_id)
    WHERE status IN ('ACTIVE', 'RESTORING')
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_agent ON sandbox_sessions(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_status ON sandbox_sessions(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_last_activity ON sandbox_sessions(last_activity_at)`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_sandbox_session_lifecycle_operations_phase
    ON sandbox_session_lifecycle_operations(phase)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_sandbox_session_lifecycle_operations_expires
    ON sandbox_session_lifecycle_operations(lease_expires_at)
  `;

  // turns
  await sql`CREATE INDEX IF NOT EXISTS idx_turns_agent_started ON turns(agent_id, started_at)`;
  await sql`DROP INDEX IF EXISTS idx_turns_session`;
  await sql`CREATE INDEX IF NOT EXISTS idx_turns_sandbox_session ON turns(sandbox_session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_turns_status_open ON turns(status) WHERE completed_at IS NULL`;
  // Admission leaves losers queued. The partial unique index is the final
  // cross-replica guard even when two replicas race on different turn rows.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_conversation_running
    ON turns(conversation_id)
    WHERE conversation_id IS NOT NULL
      AND status = 'running'
      AND completed_at IS NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_turns_terminal_publish_pending
    ON turns(completed_at)
    WHERE completed_at IS NOT NULL AND terminal_published_seq IS NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_gateway_correlation
    ON turns(gateway_profile, gateway_correlation_id)
    WHERE gateway_correlation_id IS NOT NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_call_usage_turn
    ON model_call_usage(turn_id)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_call_usage_correlation
    ON model_call_usage(gateway_profile, correlation_id)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_call_attempt_gateway_transaction
    ON model_call_attempt_usage(gateway_profile, gateway_transaction_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_model_call_attempt_aggregate
    ON model_call_attempt_usage(model_call_usage_id)
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_gateway_quarantine_transaction
    ON model_gateway_spend_quarantine(gateway_profile, gateway_transaction_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_model_gateway_quarantine_correlation
    ON model_gateway_spend_quarantine(gateway_profile, correlation_id)
  `;

  // turn_start_requests
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_start_requests_agent_key
    ON turn_start_requests(agent_id, idempotency_key)
  `;

  // event_store
  await sql`CREATE INDEX IF NOT EXISTS idx_event_store_agent_seq ON event_store(agent_id, seq)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_store_turn_seq ON event_store(turn_id, seq) WHERE turn_id IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_store_conversation_seq ON event_store(conversation_id, seq) WHERE conversation_id IS NOT NULL`;
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
  await canonicalizePersistedToolPolicies(sql);

  // ctx-iqzy U3: stored http-tool definitions rename timeout -> timeoutMs
  // (value was always milliseconds). Idempotent; runs before any agent
  // definition is read.
  await sql`
    UPDATE agents
    SET metadata = jsonb_set(
      metadata,
      '{httpTools}',
      (
        SELECT jsonb_agg(
          CASE
            WHEN tool ? 'timeout'
              THEN (tool - 'timeout') || jsonb_build_object('timeoutMs', tool->'timeout')
            ELSE tool
          END
        )
        FROM jsonb_array_elements(metadata->'httpTools') AS tool
      )
    )
    WHERE jsonb_typeof(metadata->'httpTools') = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(metadata->'httpTools') AS t
        WHERE t ? 'timeout'
      )
  `;
  await canonicalizePersistedEventContracts(sql);
  await canonicalizeInterruptToolName(sql);

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
