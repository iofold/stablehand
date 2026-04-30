/**
 * Shared Postgres test database helper.
 *
 * Uses the docker-compose Postgres at localhost:5433.
 * Each call to createTestDb() creates a fresh schema (drops + recreates all tables)
 * to ensure test isolation.
 */

import { createDatabase, type DatabaseConnection } from '../../packages/ctxmill/src/database/connection.js';
import { MIGRATION_ADVISORY_LOCK_ID, SCHEMA_VERSION_TABLE, runMigrations } from '../../packages/ctxmill/src/database/migrations.js';
import { DatabaseRepository } from '../../packages/ctxmill/src/database/repository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill';

/** Tables to drop for test isolation (order matters for FK constraints) */
const ALL_TABLES = [
  SCHEMA_VERSION_TABLE,
  'secrets',
  'tool_request_dedup',
  'artifacts',
  'agent_checkpoints',
  'interrupt_resume_attempts',
  'pending_interrupts',
  'turns',
  'sandbox_sessions',
  'agent_versions',
  'event_triggers',
  'scheduled_events',
  'suspended_sessions',
  'event_store',
  // Legacy tables removed from the runtime schema; keep them in test cleanup so
  // old local databases do not block fresh migrations.
  'feedback_signals',
  'execution_traces',
  'messages',
  'conversations',
  'knowledge_items',
  'webhooks',
  'callback_outbox',
  'system_settings',
  'agents',
];

export interface TestDb {
  conn: DatabaseConnection;
  repo: DatabaseRepository;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  let conn: DatabaseConnection | undefined;

  try {
    conn = await createDatabase(TEST_DATABASE_URL);
    await conn.pgClient`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;

    // Drop all tables for isolation, then re-run migrations
    for (const table of ALL_TABLES) {
      await conn.pgClient`DROP TABLE IF EXISTS ${conn.pgClient(table)} CASCADE`;
    }
    await runMigrations(conn.pgClient);

    const activeConn = conn;
    const repo = new DatabaseRepository(conn.db);
    return {
      conn: activeConn,
      repo,
      close: async () => {
        try {
          await activeConn.pgClient`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
        } finally {
          await activeConn.close();
        }
      },
    };
  } catch (error) {
    if (conn) {
      try {
        await conn.pgClient`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
      } catch {
        // Ignore unlock failures during setup cleanup.
      } finally {
        await conn.close();
      }
    }
    throw error;
  }
}

export { TEST_DATABASE_URL };
