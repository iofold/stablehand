import type postgres from 'postgres';

export async function runMigrationsPg(sql: postgres.Sql): Promise<void> {
  // Enable extensions
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  // Core tables
  await sql`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      tools JSONB NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'created',
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

  // Add harness and model_config columns to agents table if missing
  if (!agentCols.includes('harness')) {
    await sql`ALTER TABLE agents ADD COLUMN harness TEXT DEFAULT 'langgraph'`;
  }
  if (!agentCols.includes('model_config')) {
    await sql`ALTER TABLE agents ADD COLUMN model_config JSONB`;
  }

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
}
