import type Database from 'better-sqlite3';

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      tools TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      agent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls TEXT,
      a2ui_payload TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      source TEXT NOT NULL,
      effectiveness REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_traces (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_description TEXT NOT NULL,
      steps TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      outcome TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      conversation_id TEXT REFERENCES conversations(id),
      status TEXT NOT NULL DEFAULT 'queued',
      mode TEXT NOT NULL DEFAULT 'interactive',
      task_description TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS feedback_signals (
      id TEXT PRIMARY KEY NOT NULL,
      trace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_store (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suspended_runs (
      id TEXT PRIMARY KEY NOT NULL,
      agent_run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      wait_event_type TEXT NOT NULL,
      wait_selector TEXT NOT NULL,
      wait_expires_at INTEGER,
      snapshot_state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_events (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      wake_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    -- Performance indexes
    CREATE INDEX IF NOT EXISTS idx_execution_traces_agent_started ON execution_traces(agent_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_signals_agent_created ON feedback_signals(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated ON conversations(agent_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_items_agent_category ON knowledge_items(agent_id, category);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started ON agent_runs(agent_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_event_store_agent_seq ON event_store(agent_id, seq);
    CREATE INDEX IF NOT EXISTS idx_suspended_runs_event_type ON suspended_runs(wait_event_type);
    CREATE INDEX IF NOT EXISTS idx_suspended_runs_agent ON suspended_runs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_suspended_runs_expires ON suspended_runs(wait_expires_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_events_wake ON scheduled_events(status, wake_at);
  `);

  // Incremental migrations for schema evolution
  // Add workspace_dir column to agents table if missing
  const agentCols = sqlite.pragma('table_info(agents)') as Array<{ name: string }>;
  if (!agentCols.some(c => c.name === 'workspace_dir')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN workspace_dir TEXT');
  }

  // Add harness and model_config columns to agents table if missing
  const agentColsRefresh = sqlite.pragma('table_info(agents)') as Array<{ name: string }>;
  if (!agentColsRefresh.some(c => c.name === 'harness')) {
    sqlite.exec(`ALTER TABLE agents ADD COLUMN harness TEXT DEFAULT 'langgraph'`);
  }
  if (!agentColsRefresh.some(c => c.name === 'model_config')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN model_config TEXT');
  }

  // Add session_dir column to agent_runs table if missing
  const runCols = sqlite.pragma('table_info(agent_runs)') as Array<{ name: string }>;
  if (!runCols.some(c => c.name === 'session_dir')) {
    sqlite.exec('ALTER TABLE agent_runs ADD COLUMN session_dir TEXT');
  }

  // Create event_triggers table if missing
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS event_triggers (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      selector TEXT,
      task_template TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_triggers_agent ON event_triggers(agent_id);
    CREATE INDEX IF NOT EXISTS idx_event_triggers_event_type ON event_triggers(event_type);
  `);

  // Add manifest and version columns to agents table if missing
  const agentColsManifest = sqlite.pragma('table_info(agents)') as Array<{ name: string }>;
  if (!agentColsManifest.some(c => c.name === 'manifest')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN manifest TEXT');
  }
  if (!agentColsManifest.some(c => c.name === 'version')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN version INTEGER DEFAULT 1');
  }

  // Create agent_versions table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      manifest TEXT NOT NULL,
      changed_by TEXT,
      change_note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_versions_agent_version ON agent_versions(agent_id, version);
  `);
}
