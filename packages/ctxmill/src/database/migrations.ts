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

    -- Performance indexes
    CREATE INDEX IF NOT EXISTS idx_execution_traces_agent_started ON execution_traces(agent_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_signals_agent_created ON feedback_signals(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated ON conversations(agent_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_items_agent_category ON knowledge_items(agent_id, category);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started ON agent_runs(agent_id, started_at);
  `);
}
