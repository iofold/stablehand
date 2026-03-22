import type postgres from 'postgres';

export async function runMigrations(sql: postgres.Sql): Promise<void> {
  // Enable extensions
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  // Core tables
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
      version INTEGER DEFAULT 1,
      callback_url TEXT,
      metadata JSONB,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      agent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls JSONB,
      a2ui_payload JSONB,
      created_at BIGINT NOT NULL
    )
  `;

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

  await sql`
    CREATE TABLE IF NOT EXISTS execution_traces (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_description TEXT NOT NULL,
      steps JSONB NOT NULL,
      started_at BIGINT NOT NULL,
      completed_at BIGINT,
      outcome TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      conversation_id TEXT REFERENCES conversations(id),
      status TEXT NOT NULL DEFAULT 'queued',
      mode TEXT NOT NULL DEFAULT 'interactive',
      task_description TEXT,
      started_at BIGINT NOT NULL,
      completed_at BIGINT,
      error TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS feedback_signals (
      id TEXT PRIMARY KEY NOT NULL,
      trace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS event_store (
      seq SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at BIGINT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS suspended_runs (
      id TEXT PRIMARY KEY NOT NULL,
      agent_run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      wait_event_type TEXT NOT NULL,
      wait_selector TEXT NOT NULL,
      wait_expires_at BIGINT,
      snapshot_state JSONB NOT NULL,
      created_at BIGINT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS scheduled_events (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      wake_at BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL
    )
  `;

  // Secrets table (AES-256-GCM encrypted at rest)
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

  // Performance indexes
  await sql`CREATE INDEX IF NOT EXISTS idx_execution_traces_agent_started ON execution_traces(agent_id, started_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_signals_agent_created ON feedback_signals(agent_id, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated ON conversations(agent_id, updated_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_knowledge_items_agent_category ON knowledge_items(agent_id, category)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started ON agent_runs(agent_id, started_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_store_agent_seq ON event_store(agent_id, seq)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_suspended_runs_event_type ON suspended_runs(wait_event_type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_suspended_runs_agent ON suspended_runs(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_suspended_runs_expires ON suspended_runs(wait_expires_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_scheduled_events_wake ON scheduled_events(status, wake_at)`;

  // --- Incremental migrations for schema evolution ---

  // Helper to get column names for a table
  async function getColumnNames(tableName: string): Promise<string[]> {
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName}
    `;
    return cols.map(c => c.column_name as string);
  }

  // Add workspace_dir column to agents table if missing
  const agentCols = await getColumnNames('agents');
  if (!agentCols.includes('workspace_dir')) {
    await sql`ALTER TABLE agents ADD COLUMN workspace_dir TEXT`;
  }

  if (!agentCols.includes('harness')) {
    await sql`ALTER TABLE agents ADD COLUMN harness TEXT`;
  }

  if (!agentCols.includes('harness_config')) {
    await sql`ALTER TABLE agents ADD COLUMN harness_config TEXT`;
  }

  if (agentCols.includes('model') && agentCols.includes('model_config')) {
    await sql`
      UPDATE agents
      SET harness_config = COALESCE(
        model_config::text,
        json_build_object('provider', 'openai', 'model', COALESCE(model, 'gpt-5-mini'))::text
      )
      WHERE harness_config IS NULL
    `;
  } else if (agentCols.includes('model')) {
    await sql`
      UPDATE agents
      SET harness_config = json_build_object('provider', 'openai', 'model', COALESCE(model, 'gpt-5-mini'))::text
      WHERE harness_config IS NULL
    `;
  }

  await sql`ALTER TABLE agents ALTER COLUMN harness_config SET NOT NULL`;
  await sql`UPDATE agents SET harness = 'langgraph' WHERE harness IS NULL`;
  await sql`ALTER TABLE agents ALTER COLUMN harness SET NOT NULL`;
  await sql`ALTER TABLE agents DROP COLUMN IF EXISTS model`;
  await sql`ALTER TABLE agents DROP COLUMN IF EXISTS model_config`;

  // Add session_dir column to agent_runs table if missing
  const runCols = await getColumnNames('agent_runs');
  if (!runCols.includes('session_dir')) {
    await sql`ALTER TABLE agent_runs ADD COLUMN session_dir TEXT`;
  }

  // Create event_triggers table if missing
  await sql`
    CREATE TABLE IF NOT EXISTS event_triggers (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      selector TEXT,
      task_template TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TEXT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_triggers_agent ON event_triggers(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_triggers_event_type ON event_triggers(event_type)`;

  // Add manifest and version columns to agents table if missing
  const agentColsRefresh = await getColumnNames('agents');
  if (!agentColsRefresh.includes('manifest')) {
    await sql`ALTER TABLE agents ADD COLUMN manifest JSONB`;
  }
  if (!agentColsRefresh.includes('version')) {
    await sql`ALTER TABLE agents ADD COLUMN version INTEGER DEFAULT 1`;
  }

  // Create agent_versions table
  await sql`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      manifest JSONB NOT NULL,
      changed_by TEXT,
      change_note TEXT,
      created_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_versions_agent_version ON agent_versions(agent_id, version)`;

  // Create pending_interrupts table for durable HITL
  await sql`
    CREATE TABLE IF NOT EXISTS pending_interrupts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
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
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupts_run ON pending_interrupts(run_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupts_agent ON pending_interrupts(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_interrupts_status ON pending_interrupts(status, expires_at)`;

  // Add callback_url column to agents table if missing
  const agentColsCallback = await getColumnNames('agents');
  if (!agentColsCallback.includes('callback_url')) {
    await sql`ALTER TABLE agents ADD COLUMN callback_url TEXT`;
  }

  // Create callback_outbox table for durable webhook delivery
  await sql`
    CREATE TABLE IF NOT EXISTS callback_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      run_id TEXT REFERENCES agent_runs(id),
      callback_url TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at BIGINT NOT NULL,
      last_attempt_at BIGINT,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      delivered_at BIGINT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_status ON callback_outbox(status, next_attempt_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_outbox_agent ON callback_outbox(agent_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      events JSONB NOT NULL DEFAULT '[]',
      secret TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id)`;

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
      last_activity_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_conversation ON sandbox_sessions(conversation_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_agent ON sandbox_sessions(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_status ON sandbox_sessions(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_last_activity ON sandbox_sessions(last_activity_at)`;

  const checkpointCols = await getColumnNames('agent_checkpoints');
  if (checkpointCols.includes('run_id') || checkpointCols.includes('version')) {
    await sql`DROP TABLE IF EXISTS agent_checkpoints CASCADE`;
  }

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
  await sql`CREATE INDEX IF NOT EXISTS idx_checkpoints_session_id ON agent_checkpoints(session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_id ON agent_checkpoints(agent_id)`;

  // Add durable run lifecycle columns to agent_runs table
  const runColsRefresh = await getColumnNames('agent_runs');
  if (!runColsRefresh.includes('paused_at')) {
    await sql`ALTER TABLE agent_runs ADD COLUMN paused_at BIGINT`;
  }
  if (!runColsRefresh.includes('paused_reason')) {
    await sql`ALTER TABLE agent_runs ADD COLUMN paused_reason TEXT`;
  }
  if (!runColsRefresh.includes('resumed_at')) {
    await sql`ALTER TABLE agent_runs ADD COLUMN resumed_at BIGINT`;
  }
  if (!runColsRefresh.includes('retry_count')) {
    await sql`ALTER TABLE agent_runs ADD COLUMN retry_count INTEGER DEFAULT 0`;
  }
  if (!runColsRefresh.includes('max_retries')) {
    await sql`ALTER TABLE agent_runs ADD COLUMN max_retries INTEGER DEFAULT 0`;
  }
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)`;
}
